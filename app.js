"use strict";
/* タイレシート経費台帳 (iPhone完結版)
   撮影 → Claudeで読み取り → 確認 → Googleドライブ(画像)とスプレッドシート(台帳)へ保存 */

const CATEGORIES = ["交通費", "食費", "宿泊費", "通信費", "消耗品", "接待交際費", "燃料費", "その他"];
const SCOPES = "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets";
const MODEL = "claude-sonnet-5-5";
const DEFAULT_CLIENT_ID = "147145219163-c1fns1cd17raatbv3d27fv460j4bbn81.apps.googleusercontent.com";
const SUMMARY_TITLE = "年合計";
const HEADER = ["日付", "店名", "店名(原文)", "税ID", "レシート番号", "小計", "VAT", "合計", "通貨",
                "支払方法", "カテゴリ", "内容", "メモ", "画像リンク", "登録日時",
                "原通貨", "原通貨の金額", "レート(1THB=○原通貨)", "レート種別"];
const RATE_SHEET = "為替レート";
const COL_TOTAL = "H", COL_CATEGORY = "K";
const FIELDS = ["date", "store_name", "store_name_original", "total", "currency", "subtotal", "vat", "tax_id",
                "receipt_no", "payment_method", "items_summary", "memo", "category", "fx_rate"];
const NUMS = ["total", "subtotal", "vat", "fx_rate"];

const $ = id => document.getElementById(id);
const ls = {
  get: (k, d = "") => { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} },
  del: k => { try { localStorage.removeItem(k); } catch (e) {} },
};
class AuthError extends Error {}

function msg(text, kind) {
  const m = $("msg"); m.textContent = text || ""; m.className = text ? kind : "";
}
function show(view) {
  for (const v of ["viewMain", "viewReview", "viewSettings"]) $(v).classList.toggle("hidden", v !== view);
  window.scrollTo(0, 0);
}

/* ---------- 端末内DB(履歴と送信待ち) ---------- */
const db = {
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open("receipts", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("items", { keyPath: "id" });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  },
  async tx(mode, fn) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const t = d.transaction("items", mode); const out = fn(t.objectStore("items"));
      t.oncomplete = () => res(out.result); t.onerror = () => rej(t.error);
    });
  },
  put(item) { return this.tx("readwrite", s => s.put(item)); },
  all() { return this.tx("readonly", s => s.getAll()); },
  get(id) { return this.tx("readonly", s => s.get(id)); },
};

/* ---------- 画像 ---------- */
async function prepareImage(file, maxEdge = 1280) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const k = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(r => c.toBlob(r, "image/jpeg", 0.85));
}
const blobToB64 = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result.split(",")[1]); f.readAsDataURL(b); });

/* ---------- OCR (Claude) ---------- */
const TOOL = {
  name: "record_receipt", description: "レシートから読み取った内容を記録する",
  input_schema: { type: "object", properties: {
    date: { type: ["string", "null"], description: "購入日 YYYY-MM-DD (西暦。仏暦なら543を引く。和暦は西暦に直す)。読めなければnull" },
    store_name: { type: "string", description: "店名。英語表記があれば英語、なければ原文(タイ語・日本語)をそのまま" },
    store_name_original: { type: "string", description: "レシート記載の店名そのまま(タイ語・日本語など)" },
    tax_id: { type: "string", description: "タイは税ID(13桁)、日本は登録番号(T+13桁)。なければ空文字" },
    receipt_no: { type: "string", description: "レシート/伝票番号。なければ空文字" },
    subtotal: { type: ["number", "null"], description: "税抜小計" },
    vat: { type: ["number", "null"], description: "VAT額(日本は消費税額。10%と8%があれば合算)" },
    total: { type: ["number", "null"], description: "支払合計額(税込)" },
    currency: { type: "string", enum: ["THB", "JPY"], description: "通貨コード。タイはTHB、日本(円・¥)はJPY" },
    payment_method: { type: "string", description: "現金/カード/QR/その他。不明なら空文字" },
    category: { type: "string", enum: CATEGORIES },
    items_summary: { type: "string", description: "購入内容の短い日本語要約(30字程度)" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  }, required: ["date", "store_name", "total", "currency", "category", "confidence"] },
};
const PROMPT = "これはタイまたは日本で発行されたレシート/領収書の写真です。表記はタイ語・英語・日本語のいずれかです。" +
  "内容を読み取り、必ず record_receipt ツールを呼び出して返してください。\n" +
  "- 通貨: タイのレシートは THB、日本のレシート(円・¥)は JPY。\n" +
  "- 日付は西暦YYYY-MM-DDに変換。タイ仏暦(例: 2569年/25/10/69)は543を引いて西暦にする。" +
  "日本の和暦は令和N年=2018+N年、平成N年=1988+N年(例: R8.10.9 → 2026-10-09)。\n" +
  "- 金額は数字のみ(カンマ・฿・บาท・¥・円 は除く)。\n" +
  "- 合計は支払総額(รวมทั้งสิ้น / Total / Grand Total / 合計・税込合計)。お預り・お釣りではない。\n" +
  "- 日本の登録番号(T+13桁)があれば tax_id に入れる。\n" +
  "- 読めない項目は推測せず null か空文字にし、confidence を下げる。";

async function readReceipt(jpeg) {
  const key = ls.get("anthropic_key");
  if (!key) throw new Error("設定(右上の ⚙︎)で Anthropic API キーを入力してください");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01",
               "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({ model: MODEL, max_tokens: 800, tools: [TOOL], tool_choice: { type: "auto" },
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: await blobToB64(jpeg) } },
        { type: "text", text: PROMPT }] }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("読み取りに失敗: " + (j.error?.message || r.status));
  const t = j.content.find(b => b.type === "tool_use");
  if (!t) throw new Error("レシートを読み取れませんでした。もう一度撮影してください");
  return t.input;
}

/* ---------- 為替レート (社内レート: 月ごと。1バーツ = ○ 円 の形で持つ) ---------- */
const rates = {
  load() { try { return JSON.parse(ls.get("fx_rates", "{}")); } catch (e) { return {}; } },
  save(o) { ls.set("fx_rates", JSON.stringify(o)); },
};
const isForeign = cur => !!cur && cur !== "THB";
// 欧州中央銀行の参考レート(Frankfurter)。月初が休日なら直前の営業日のレートが返る
async function fetchRate(cur, month) {
  const r = await fetch(`https://api.frankfurter.dev/v1/${month}-01?base=THB&symbols=${cur}`);
  const j = await r.json().catch(() => ({}));
  const v = j.rates && j.rates[cur];
  if (!r.ok || !(v > 0)) throw new Error("為替レートを自動取得できませんでした。レートを手入力してください");
  return { rate: v, src: "自動", base: j.date };
}
async function monthRate(cur, month) {   // 保存済みの月次レートを使い、なければ取得して保存する
  const k = `${cur}:${month}`, saved = rates.load()[k];
  if (saved) return saved;
  const e = await fetchRate(cur, month);
  const all = rates.load(); all[k] = e; rates.save(all);
  return e;
}
const round2 = v => Math.round(v * 100) / 100;
// 台帳に入れるバーツ金額
const thbOf = (d, v = d.total) =>
  typeof v !== "number" ? null : !isForeign(d.currency) ? v : d.fx_rate > 0 ? round2(v / d.fx_rate) : null;

/* ---------- Google 認証 (リダイレクト方式) ---------- */
function redirectUri() { return location.origin + location.pathname; }
function token() {
  const t = ls.get("g_token"), exp = Number(ls.get("g_exp", "0"));
  return t && Date.now() < exp - 60000 ? t : "";
}
function login() {
  const cid = ls.get("client_id", DEFAULT_CLIENT_ID);
  if (!cid) { msg("設定(⚙︎)で Google クライアント ID を入力してください", "err"); return; }
  const p = new URLSearchParams({ client_id: cid, redirect_uri: redirectUri(), response_type: "token", scope: SCOPES,
    include_granted_scopes: "true", login_hint: ls.get("email"), prompt: "select_account" });
  location.href = "https://accounts.google.com/o/oauth2/v2/auth?" + p;
}
function takeTokenFromHash() {
  if (!location.hash.includes("access_token")) return false;
  const p = new URLSearchParams(location.hash.slice(1));
  ls.set("g_token", p.get("access_token"));
  ls.set("g_exp", String(Date.now() + Number(p.get("expires_in") || 3600) * 1000));
  history.replaceState(null, "", location.pathname);
  return true;
}

async function g(url, opt = {}) {
  const t = token(); if (!t) throw new AuthError("Googleにログインしてください");
  const r = await fetch(url, { ...opt, headers: { Authorization: "Bearer " + t, ...(opt.headers || {}) } });
  if (r.status === 401) { ls.del("g_token"); throw new AuthError("ログインの有効期限が切れました"); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error?.message || "Google API エラー " + r.status); e.status = r.status; throw e; }
  return j;
}
const jsonOpt = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const DRIVE = "https://www.googleapis.com/drive/v3/files";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const esc = s => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/* ---------- Drive / Sheets (Mac版 google_api.py と同じ構成) ---------- */
async function getFolderId() {
  const name = ls.get("folder_name", "タイレシート経費精算");
  const cached = ls.get("folder_id"); if (cached && ls.get("folder_id_name") === name) return cached;
  const q = `name = '${esc(name)}' and 'root' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`;
  const f = (await g(`${DRIVE}?q=${encodeURIComponent(q)}&fields=files(id)`)).files;
  const id = f.length ? f[0].id
    : (await g(`${DRIVE}?fields=id`, jsonOpt("POST", { name, mimeType: "application/vnd.google-apps.folder" }))).id;
  ls.set("folder_id", id); ls.set("folder_id_name", name);
  return id;
}

async function uploadImage(folderId, filename, blob) {
  const b = "rcpt" + Math.random().toString(36).slice(2);
  const meta = JSON.stringify({ name: filename, parents: [folderId] });
  const body = new Blob([`--${b}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--${b}\r\nContent-Type: image/jpeg\r\n\r\n`,
    blob, `\r\n--${b}--`]);
  const j = await g("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink",
    { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${b}` }, body });
  return j.webViewLink;
}

async function sheetProps(bookId) {
  return (await g(`${SHEETS}/${bookId}?fields=sheets.properties`)).sheets.map(s => s.properties);
}
const putValues = (book, range, values) =>
  g(`${SHEETS}/${book}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, jsonOpt("PUT", { values }));
const batch = (book, requests) => g(`${SHEETS}/${book}:batchUpdate`, jsonOpt("POST", { requests }));
const colName = n => String.fromCharCode(64 + n);
const headFmt = sheetId => ({ repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
  cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: .85, green: .92, blue: .98 } } },
  fields: "userEnteredFormat(textFormat,backgroundColor)" } });

async function findOrCreateBook(folderId, year) {
  const name = `経費精算台帳_${year}`;
  const q = `'${folderId}' in parents and name = '${name}' and trashed = false and mimeType = 'application/vnd.google-apps.spreadsheet'`;
  const f = (await g(`${DRIVE}?q=${encodeURIComponent(q)}&fields=files(id)`)).files;
  if (f.length) return f[0].id;
  const id = (await g(`${DRIVE}?fields=id`, jsonOpt("POST",
    { name, parents: [folderId], mimeType: "application/vnd.google-apps.spreadsheet" }))).id;
  const first = (await sheetProps(id))[0].sheetId;
  await batch(id, [{ updateSheetProperties: { properties: { sheetId: first, title: SUMMARY_TITLE }, fields: "title" } }]);
  const head = ["月", "件数", "合計(THB)", ...CATEGORIES];
  const rows = Array.from({ length: 12 }, (_, i) => [`'${year}-${String(i + 1).padStart(2, "0")}`, 0, 0, ...CATEGORIES.map(() => 0)]);
  const total = ["年合計", "=SUM(B2:B13)", ...Array.from({ length: head.length - 2 }, (_, i) => `=SUM(${colName(i + 3)}2:${colName(i + 3)}13)`)];
  await putValues(id, `'${SUMMARY_TITLE}'!A1`, [head, ...rows, total]);
  await batch(id, [headFmt(first),
    { repeatCell: { range: { sheetId: first, startRowIndex: 13, endRowIndex: 14 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat" } },
    { repeatCell: { range: { sheetId: first, startRowIndex: 1, endRowIndex: 14, startColumnIndex: 2 },
      cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "#,##0.00" } } }, fields: "userEnteredFormat.numberFormat" } }]);
  return id;
}

async function ensureMonthSheet(book, year, month) {
  const title = `${year}-${String(month).padStart(2, "0")}`;
  if ((await sheetProps(book)).some(p => p.title === title)) return title;
  const res = await batch(book, [{ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } }]);
  const sid = res.replies[0].addSheet.properties.sheetId;
  await putValues(book, `'${title}'!A1`, [HEADER]);
  await batch(book, [headFmt(sid), { autoResizeDimensions: { dimensions: { sheetId: sid, dimension: "COLUMNS", startIndex: 0, endIndex: HEADER.length } } }]);
  const cats = CATEGORIES.map((_, i) => `=SUMIF('${title}'!${COL_CATEGORY}:${COL_CATEGORY},${colName(4 + i)}$1,'${title}'!${COL_TOTAL}:${COL_TOTAL})`);
  await putValues(book, `'${SUMMARY_TITLE}'!B${month + 1}`, [[`=COUNTA('${title}'!A:A)-1`, `=SUM('${title}'!${COL_TOTAL}:${COL_TOTAL})`, ...cats]]);
  return title;
}

// 使ったレートを台帳の「為替レート」シートに記録する(月・レートの組み合わせごとに1回だけ)
async function logRate(book, d, title) {
  const k = `ratelog_${book}_${d.currency}_${title}_${d.fx_rate}`;
  if (ls.get(k)) return;
  if (!(await sheetProps(book)).some(p => p.title === RATE_SHEET)) {
    const res = await batch(book, [{ addSheet: { properties: { title: RATE_SHEET, gridProperties: { frozenRowCount: 1 } } } }]);
    await putValues(book, `'${RATE_SHEET}'!A1`, [["月", "通貨", "レート(1THB=○原通貨)", "種別", "記録日時"]]);
    await batch(book, [headFmt(res.replies[0].addSheet.properties.sheetId)]);
  }
  await g(`${SHEETS}/${book}/values/${encodeURIComponent(`'${RATE_SHEET}'!A1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    jsonOpt("POST", { values: [[`'${title}`, d.currency, d.fx_rate, d.fx_src || "", new Date().toLocaleString("sv-SE")]] }));
  ls.set(k, "1");
}

async function sendItem(item, retry = true) {
  const d = item.data, [year, month] = d.date.split("-").map(Number);
  const title = `${year}-${String(month).padStart(2, "0")}`;
  const folderId = await getFolderId();
  const bookKey = `book_${folderId}_${year}`;
  // 画像アップロードと台帳の準備を同時に進める。台帳ID・月シートの有無は端末に覚えておき、2回目以降は検索を省く
  const resumed = !!item.imageLink;   // 前回の送信が途中で止まった可能性がある
  const upload = item.imageLink ? Promise.resolve(item.imageLink) : (async () => {
    const safe = (d.store_name || "receipt").replace(/\s+/g, "_").replace(/[^\w\-]+/g, "").slice(0, 30) || "receipt";
    item.imageLink = await uploadImage(folderId, `${d.date.replace(/-/g, "")}_${safe}_${d.total ?? 0}.jpg`, item.image);
    await db.put(item);   // 再送しても画像を重複させない
    return item.imageLink;
  })();
  const prepare = (async () => {
    let book = ls.get(bookKey);
    if (!book) { book = await findOrCreateBook(folderId, year); ls.set(bookKey, book); }
    const monthsKey = `months_${book}`, months = JSON.parse(ls.get(monthsKey, "[]"));
    if (!months.includes(title)) { await ensureMonthSheet(book, year, month); months.push(title); ls.set(monthsKey, JSON.stringify(months)); }
    const hk = `hdr19_${book}_${title}`;   // 以前に作った月シートにも、為替の列の見出しを足す
    if (!ls.get(hk)) { await putValues(book, `'${title}'!P1:S1`, [HEADER.slice(15)]); ls.set(hk, "1"); }
    return book;
  })();
  let book, link;
  try { [book, link] = await Promise.all([prepare, upload]); }
  catch (e) { await upload.catch(() => {}); throw e; }
  const fx = isForeign(d.currency);
  if (fx && !(d.fx_rate > 0)) throw new Error("為替レートが未設定のレシートがあります(" + (d.store_name || d.date) + ")");
  const text = v => v ? `'${v}` : "", num = v => typeof v === "number" ? v : "", thb = v => typeof v === "number" ? thbOf(d, v) : "";
  // F〜H は常にバーツ。原通貨の金額とレートは右端(P〜S)に残す
  const row = [d.date, d.store_name || "", d.store_name_original || "", text(d.tax_id), text(d.receipt_no), thb(d.subtotal), thb(d.vat),
    thb(d.total), "THB", d.payment_method || "", d.category || "その他", d.items_summary || "", d.memo || "",
    link, new Date().toLocaleString("sv-SE"),
    fx ? d.currency : "THB", num(d.total), fx ? d.fx_rate : 1, fx ? d.fx_src || "" : ""];
  if (resumed) {   // 画像リンクは1件ごとに固有。台帳に既にあれば、送信済みなので追記しない
    const col = (await g(`${SHEETS}/${book}/values/${encodeURIComponent(`'${title}'!N:N`)}`)).values || [];
    if (col.some(c => c[0] === link)) {
      item.status = "done"; item.sheet = title; item.bookUrl = `https://docs.google.com/spreadsheets/d/${book}`;
      await db.put(item); return;
    }
  }
  try {
    const res = await g(`${SHEETS}/${book}/values/${encodeURIComponent(`'${title}'!A1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=OVERWRITE`,
      jsonOpt("POST", { values: [row] }));
    if (fx) {   // 外貨の行は、合計を「原通貨の金額 ÷ レート」の計算式にする(レート列を直せば合計も変わる)
      const n = /!A(\d+)/.exec(res.updates?.updatedRange || "");
      if (n) await putValues(book, `'${title}'!H${n[1]}`, [[`=ROUND(Q${n[1]}/R${n[1]},2)`]]).catch(() => {});
      await logRate(book, d, title).catch(() => {});
    }
  } catch (e) {
    // 台帳やシートが手動で削除された等でキャッシュが古い場合は、消して1回だけやり直す
    if (retry && (e.status === 400 || e.status === 404)) { ls.del(bookKey); ls.del(`months_${book}`); return sendItem(item, false); }
    throw e;
  }
  item.status = "done"; item.sheet = title; item.bookUrl = `https://docs.google.com/spreadsheets/d/${book}`;
  await db.put(item);
}

/* ---------- 送信キュー ---------- */
let syncing = false;
async function sync() {
  if (syncing) return;
  syncing = true; setBusy(true);
  try {
    // 複数のタブ/画面で同時に送信しないよう排他制御(対応していない環境では何もしない)
    if (navigator.locks) await navigator.locks.request("receipt-sync", { ifAvailable: true }, lock => lock ? doSync() : msg("別の画面で送信中です", "info"));
    else await doSync();
  } finally { syncing = false; setBusy(false); await render(); }
}
function setBusy(b) { $("btnSync").disabled = b; $("btnLogin").disabled = b; }
async function doSync() {
  try {
    const pend = (await db.all()).filter(i => i.status === "pending").sort((a, b) => a.id - b.id);
    const t0 = performance.now();
    for (const p of pend) {
      msg(`送信中… (${pend.indexOf(p) + 1}/${pend.length}) 画面を閉じずにお待ちください`, "info");
      const it = await db.get(p.id);          // 直前に最新の状態を確認(他で送信済みなら飛ばす)
      if (it && it.status === "pending") await sendItem(it);
    }
    if (pend.length) msg(`${pend.length}件を台帳に保存しました(${((performance.now() - t0) / 1000).toFixed(1)}秒)`, "ok");
  } catch (e) {
    msg(e instanceof AuthError ? e.message : "送信できませんでした: " + e.message, "err");
  }
}

async function render() {
  const items = (await db.all()).sort((a, b) => b.id - a.id);
  const pend = items.filter(i => i.status === "pending").length;
  $("syncCard").classList.toggle("hidden", pend === 0);
  $("syncText").textContent = `未送信が ${pend} 件あります` + (token() ? "" : "(Googleへのログインが必要です)");
  $("btnLogin").classList.toggle("hidden", !!token());
  $("btnSync").classList.toggle("hidden", !token());
  const list = $("list"); list.textContent = "";
  if (!items.length) list.innerHTML = "<small>まだありません</small>";
  const itemRow = it => {
    const row = document.createElement("div"); row.className = "item";
    const l = document.createElement("div");
    l.textContent = `${it.data.date.slice(5)}  ${it.data.store_name || "(店名なし)"}`;
    const sub = document.createElement("small"); sub.style.display = "block";
    const conv = isForeign(it.data.currency) && thbOf(it.data) != null ? `(≈ ${thbOf(it.data).toLocaleString()} THB)` : "";
    sub.textContent = `${it.data.total ?? "-"} ${it.data.currency || ""}${conv} ・ ${it.data.category}`; l.append(sub);
    const tag = document.createElement("span"); tag.className = "tag " + it.status;
    tag.textContent = it.status === "done" ? "保存済み" : "未送信"; row.append(l, tag); return row;
  };
  // 月ごとにまとめる(新しい月が上)。月の見出しをタップすると、その月の履歴が開く
  const months = {};
  for (const it of items) (months[it.data.date.slice(0, 7)] ||= []).push(it);
  const openSet = new Set(JSON.parse(ls.get("open_months", "[]")));
  const keys = Object.keys(months).sort().reverse();
  if (keys.length && !openSet.size && !ls.get("open_months")) openSet.add(keys[0]);   // 初回は最新の月だけ開く
  for (const k of keys) {
    const list2 = months[k].sort((a, b) => b.data.date.localeCompare(a.data.date) || b.id - a.id);
    const sum = list2.reduce((t, i) => t + (thbOf(i.data) || 0), 0);
    const det = document.createElement("details"); det.open = openSet.has(k);
    const sm = document.createElement("summary");
    sm.innerHTML = `<b></b><span></span>`;
    sm.firstChild.textContent = `${k.slice(0, 4)}年${Number(k.slice(5))}月`;
    sm.lastChild.textContent = `${list2.length}件 ・ ${sum.toLocaleString(undefined, { maximumFractionDigits: 2 })} THB`;
    det.append(sm); list2.forEach(it => det.append(itemRow(it)));
    det.addEventListener("toggle", () => {
      det.open ? openSet.add(k) : openSet.delete(k); ls.set("open_months", JSON.stringify([...openSet]));
    });
    list.append(det);
  }
  const done = items.find(i => i.bookUrl);
  $("sheetLink").classList.toggle("hidden", !done); if (done) $("sheetLink").href = done.bookUrl;
}

/* ---------- 撮影 → 確認 → 保存 ---------- */
let current = null; // { blob, fxKey, fxSrc }

// 外貨のレシートは、そのレシートの月の社内レートを入れ、換算後のバーツを見せる
async function refreshFx() {
  if (!current) return;
  const cur = $("currency").value.trim().toUpperCase(), month = $("date").value.slice(0, 7);
  $("fxBox").classList.toggle("hidden", !isForeign(cur));
  $("fxLabel").textContent = `レート(1バーツ = ○ ${cur})`;
  if (isForeign(cur) && /^\d{4}-\d{2}$/.test(month) && current.fxKey !== cur + month && current.fxSrc !== "個別手入力") {
    current.fxKey = cur + month;
    try {
      const e = await monthRate(cur, month);
      if (current && current.fxKey === cur + month) { $("fx_rate").value = e.rate; current.fxSrc = "月次(" + e.src + ")"; }
    } catch (err) { $("fx_rate").value = ""; current.fxSrc = ""; msg(err.message, "err"); }
  }
  showThb();
}
function showThb() {
  const rate = Number($("fx_rate").value), total = Number($("total").value.replace(/,/g, ""));
  $("fxThb").textContent = rate > 0 && total ? `換算後 ${round2(total / rate).toLocaleString(undefined, { minimumFractionDigits: 2 })} THB`
    + (current && current.fxSrc ? `(${current.fxSrc})` : "") : "レートを入力してください";
}
for (const id of ["date", "currency"]) $(id).addEventListener("change", refreshFx);
$("total").addEventListener("input", showThb);
$("fx_rate").addEventListener("input", () => { if (current) current.fxSrc = "個別手入力"; showThb(); });
$("btnShoot").onclick = () => $("file").click();
$("file").onchange = async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  msg("読み取り中…(数秒かかります)", "info");
  try {
    const t0 = performance.now();
    const blob = await prepareImage(f);
    const data = await readReceipt(blob);
    const sec = ((performance.now() - t0) / 1000).toFixed(1);
    current = { blob, fxKey: "", fxSrc: "" };
    $("preview").src = URL.createObjectURL(blob);
    for (const k of FIELDS) { $(k).value = data[k] ?? ""; $(k).classList.remove("low"); }
    if (!$("currency").value) $("currency").value = "THB";
    $("currency").value = $("currency").value.trim().toUpperCase();
    if (data.confidence !== "high") for (const k of ["date", "total", "store_name"]) $(k).classList.add("low");
    show("viewReview");
    refreshFx();
    msg(data.confidence === "high" ? `読み取り完了(${sec}秒)。内容を確認して保存してください` :
      "読み取りに自信がない項目があります(赤枠)。画像と見比べて修正してください", data.confidence === "high" ? "ok" : "err");
  } catch (err) { msg(err.message, "err"); }
};
$("btnCancel").onclick = () => { current = null; show("viewMain"); msg(""); };
$("btnSave").onclick = async () => {
  if ($("btnSave").disabled) return;
  $("btnSave").disabled = true;
  try { await saveReview(); } finally { $("btnSave").disabled = false; }
};
async function saveReview() {
  const data = {};
  for (const k of FIELDS) { const v = $(k).value.trim(); data[k] = NUMS.includes(k) ? (v === "" ? null : Number(v.replace(/,/g, ""))) : v; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) { msg("日付を YYYY-MM-DD 形式で入力してください", "err"); return; }
  if (NUMS.some(k => Number.isNaN(data[k]))) { msg("金額は数字で入力してください", "err"); return; }
  data.currency = (data.currency || "THB").toUpperCase();
  if (isForeign(data.currency)) {
    if (!(data.fx_rate > 0)) { msg("為替レート(1バーツ = ○ 円)を入力してください", "err"); return; }
    data.fx_src = current.fxSrc || "個別手入力";
  } else { data.fx_rate = null; }
  const dup = (await db.all()).find(i => i.data.date === data.date && i.data.total === data.total && data.total != null);
  if (dup && !confirm(`同じ日付・金額のレシートが既にあります(${dup.data.store_name})。\nもう一度保存しますか?`)) return;
  await db.put({ id: Date.now(), status: "pending", data, image: current.blob });
  current = null; show("viewMain"); msg("");
  await render();
  if (token()) await sync(); else msg("端末に保存しました。Googleにログインすると台帳へ送信されます", "info");
}
$("btnSync").onclick = sync;
$("btnLogin").onclick = login;

/* ---------- 設定 ---------- */
const monthKey = (y, m) => { const d = new Date(y, m, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
// 月ごとの社内レート(円)。今月と前の2か月に、保存済みの月を加えて表示する
async function renderRates() {
  const now = new Date(), box = $("rateList");
  const months = new Set([0, -1, -2].map(i => monthKey(now.getFullYear(), now.getMonth() + i)));
  for (const k of Object.keys(rates.load())) if (k.startsWith("JPY:")) months.add(k.slice(4));
  await Promise.all([...months].filter(m => !rates.load()["JPY:" + m]).map(m => monthRate("JPY", m).catch(() => {})));
  box.textContent = "";
  for (const m of [...months].sort().reverse().slice(0, 8)) {
    const e = rates.load()["JPY:" + m], row = document.createElement("div"); row.className = "item";
    const l = document.createElement("div"); l.textContent = `${m.slice(0, 4)}年${Number(m.slice(5))}月`;
    const s = document.createElement("small"); s.style.display = "block";
    s.textContent = e ? (e.src === "自動" ? `自動(欧州中央銀行 ${e.base})` : "手入力") : "未取得"; l.append(s);
    const inp = document.createElement("input"); inp.dataset.m = m; inp.inputMode = "decimal"; inp.style.width = "110px";
    inp.value = e ? e.rate : ""; inp.placeholder = "円"; row.append(l, inp); box.append(row);
  }
}
function saveRates() {
  const all = rates.load();
  for (const inp of $("rateList").querySelectorAll("input")) {
    const k = "JPY:" + inp.dataset.m, v = Number(inp.value.replace(/,/g, "")), prev = all[k];
    if (inp.value.trim() === "") { if (prev && prev.src === "手入力") delete all[k]; }   // 空欄 → 自動に戻す
    else if (v > 0 && (!prev || prev.rate !== v)) all[k] = { rate: v, src: "手入力", base: "" };
  }
  rates.save(all);
}
$("btnSettings").onclick = () => {
  renderRates();
  $("setKey").value = ls.get("anthropic_key"); $("setClient").value = ls.get("client_id", DEFAULT_CLIENT_ID);
  $("setEmail").value = ls.get("email", "tomonori19720629@gmail.com"); $("setFolder").value = ls.get("folder_name", "タイレシート経費精算");
  $("redirectUri").textContent = redirectUri(); show("viewSettings"); msg("");
};
$("btnSettingsBack").onclick = () => show("viewMain");
$("btnSettingsSave").onclick = () => {
  saveRates();
  ls.set("anthropic_key", $("setKey").value.trim()); ls.set("client_id", $("setClient").value.trim() || DEFAULT_CLIENT_ID);
  ls.set("email", $("setEmail").value.trim()); ls.set("folder_name", $("setFolder").value.trim() || "タイレシート経費精算");
  show("viewMain"); msg("設定を保存しました", "ok"); render();
};

/* ---------- 起動 ---------- */
(async function init() {
  $("category").innerHTML = CATEGORIES.map(c => `<option>${c}</option>`).join("");
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  const back = takeTokenFromHash();
  monthRate("JPY", monthKey(new Date().getFullYear(), new Date().getMonth())).catch(() => {});   // 新しい月の最初に開いたとき、今月の社内レートを自動で入れる
  await render();
  if (!ls.get("anthropic_key")) { msg("はじめに右上の ⚙︎ で Anthropic の API キーを入力してください", "info"); }
  if (back) { msg("Googleにログインしました", "ok"); await sync(); }
})();
