"use strict";
/* タイレシート経費台帳 (iPhone完結版)
   撮影 → Claudeで読み取り → 確認 → Googleドライブ(画像)とスプレッドシート(台帳)へ保存 */

const CATEGORIES = ["交通費", "食費", "宿泊費", "通信費", "消耗品", "接待交際費", "燃料費", "その他"];
const SCOPES = "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets";
const MODEL = "claude-sonnet-5-5";
const SUMMARY_TITLE = "年合計";
const HEADER = ["日付", "店名", "店名(原文)", "税ID", "レシート番号", "小計", "VAT", "合計", "通貨",
                "支払方法", "カテゴリ", "内容", "メモ", "画像リンク", "登録日時"];
const COL_TOTAL = "H", COL_CATEGORY = "K";
const FIELDS = ["date", "store_name", "store_name_original", "total", "currency", "subtotal", "vat", "tax_id",
                "receipt_no", "payment_method", "items_summary", "memo", "category"];
const NUMS = ["total", "subtotal", "vat"];

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
};

/* ---------- 画像 ---------- */
async function prepareImage(file, maxEdge = 1800) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const k = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(r => c.toBlob(r, "image/jpeg", 0.88));
}
const blobToB64 = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result.split(",")[1]); f.readAsDataURL(b); });

/* ---------- OCR (Claude) ---------- */
const TOOL = {
  name: "record_receipt", description: "レシートから読み取った内容を記録する",
  input_schema: { type: "object", properties: {
    date: { type: ["string", "null"], description: "購入日 YYYY-MM-DD (西暦。仏暦なら543を引く)。読めなければnull" },
    store_name: { type: "string", description: "店名。英語表記があれば英語、なければタイ語をそのまま" },
    store_name_original: { type: "string", description: "レシート記載の店名そのまま(タイ語など)" },
    tax_id: { type: "string", description: "税ID(13桁)。なければ空文字" },
    receipt_no: { type: "string", description: "レシート/伝票番号。なければ空文字" },
    subtotal: { type: ["number", "null"], description: "VAT抜き小計" },
    vat: { type: ["number", "null"], description: "VAT額" },
    total: { type: ["number", "null"], description: "支払合計額" },
    currency: { type: "string", description: "通貨コード。通常THB" },
    payment_method: { type: "string", description: "現金/カード/QR/その他。不明なら空文字" },
    category: { type: "string", enum: CATEGORIES },
    items_summary: { type: "string", description: "購入内容の短い日本語要約(30字程度)" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  }, required: ["date", "store_name", "total", "currency", "category", "confidence"] },
};
const PROMPT = "これはタイで発行されたレシート/領収書の写真です。表記はタイ語と英語です。" +
  "内容を読み取り、必ず record_receipt ツールを呼び出して返してください。\n" +
  "- 日付は西暦YYYY-MM-DDに変換。タイ仏暦(例: 2569年/25/10/69)は543を引いて西暦にする。\n" +
  "- 金額は数字のみ(カンマ・฿・บาท は除く)。\n" +
  "- 合計は支払総額(รวมทั้งสิ้น / Total / Grand Total)。\n" +
  "- 読めない項目は推測せず null か空文字にし、confidence を下げる。";

async function readReceipt(jpeg) {
  const key = ls.get("anthropic_key");
  if (!key) throw new Error("設定(右上の ⚙︎)で Anthropic API キーを入力してください");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01",
               "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, tools: [TOOL], tool_choice: { type: "auto" },
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

/* ---------- Google 認証 (リダイレクト方式) ---------- */
function redirectUri() { return location.origin + location.pathname; }
function token() {
  const t = ls.get("g_token"), exp = Number(ls.get("g_exp", "0"));
  return t && Date.now() < exp - 60000 ? t : "";
}
function login() {
  const cid = ls.get("client_id");
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
  if (!r.ok) throw new Error(j.error?.message || "Google API エラー " + r.status);
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

async function sendItem(item) {
  const d = item.data, [year, month] = d.date.split("-").map(Number);
  const folderId = await getFolderId();
  if (!item.imageLink) {   // 画像アップロード済みなら再実行時に重複させない
    const safe = (d.store_name || "receipt").replace(/\s+/g, "_").replace(/[^\w\-]+/g, "").slice(0, 30) || "receipt";
    item.imageLink = await uploadImage(folderId, `${d.date.replace(/-/g, "")}_${safe}_${d.total ?? 0}.jpg`, item.image);
    await db.put(item);
  }
  const book = await findOrCreateBook(folderId, year);
  const title = await ensureMonthSheet(book, year, month);
  const text = v => v ? `'${v}` : "", num = v => typeof v === "number" ? v : "";
  const row = [d.date, d.store_name || "", d.store_name_original || "", text(d.tax_id), text(d.receipt_no), num(d.subtotal), num(d.vat),
    num(d.total), d.currency || "THB", d.payment_method || "", d.category || "その他", d.items_summary || "", d.memo || "",
    item.imageLink, new Date().toLocaleString("sv-SE")];
  await g(`${SHEETS}/${book}/values/${encodeURIComponent(`'${title}'!A1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=OVERWRITE`,
    jsonOpt("POST", { values: [row] }));
  item.status = "done"; item.sheet = title; item.bookUrl = `https://docs.google.com/spreadsheets/d/${book}`;
  await db.put(item);
}

/* ---------- 送信キュー ---------- */
let syncing = false;
async function sync() {
  if (syncing) return; syncing = true;
  try {
    const pend = (await db.all()).filter(i => i.status === "pending").sort((a, b) => a.id - b.id);
    for (const it of pend) {
      msg(`送信中… (${pend.indexOf(it) + 1}/${pend.length})`, "info");
      await sendItem(it);
    }
    if (pend.length) msg(`${pend.length}件を台帳に保存しました`, "ok");
  } catch (e) {
    msg(e instanceof AuthError ? e.message : "送信できませんでした: " + e.message, "err");
  } finally { syncing = false; await render(); }
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
  for (const it of items.slice(0, 50)) {
    const row = document.createElement("div"); row.className = "item";
    const l = document.createElement("div");
    l.textContent = `${it.data.date}  ${it.data.store_name || "(店名なし)"}`;
    const sub = document.createElement("small"); sub.style.display = "block";
    sub.textContent = `${it.data.total ?? "-"} ${it.data.currency || ""} ・ ${it.data.category}`; l.append(sub);
    const tag = document.createElement("span"); tag.className = "tag " + it.status;
    tag.textContent = it.status === "done" ? "保存済み" : "未送信"; row.append(l, tag); list.append(row);
  }
  const done = items.find(i => i.bookUrl);
  $("sheetLink").classList.toggle("hidden", !done); if (done) $("sheetLink").href = done.bookUrl;
}

/* ---------- 撮影 → 確認 → 保存 ---------- */
let current = null; // { blob }
$("btnShoot").onclick = () => $("file").click();
$("file").onchange = async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  msg("読み取り中…(数秒かかります)", "info");
  try {
    const blob = await prepareImage(f);
    const data = await readReceipt(blob);
    current = { blob };
    $("preview").src = URL.createObjectURL(blob);
    for (const k of FIELDS) { $(k).value = data[k] ?? ""; $(k).classList.remove("low"); }
    if (!$("currency").value) $("currency").value = "THB";
    if (data.confidence !== "high") for (const k of ["date", "total", "store_name"]) $(k).classList.add("low");
    show("viewReview");
    msg(data.confidence === "high" ? "読み取り完了。内容を確認して保存してください" :
      "読み取りに自信がない項目があります(赤枠)。画像と見比べて修正してください", data.confidence === "high" ? "ok" : "err");
  } catch (err) { msg(err.message, "err"); }
};
$("btnCancel").onclick = () => { current = null; show("viewMain"); msg(""); };
$("btnSave").onclick = async () => {
  const data = {};
  for (const k of FIELDS) { const v = $(k).value.trim(); data[k] = NUMS.includes(k) ? (v === "" ? null : Number(v.replace(/,/g, ""))) : v; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) { msg("日付を YYYY-MM-DD 形式で入力してください", "err"); return; }
  if (NUMS.some(k => Number.isNaN(data[k]))) { msg("金額は数字で入力してください", "err"); return; }
  await db.put({ id: Date.now(), status: "pending", data, image: current.blob });
  current = null; show("viewMain"); msg("");
  await render();
  if (token()) await sync(); else msg("端末に保存しました。Googleにログインすると台帳へ送信されます", "info");
};
$("btnSync").onclick = sync;
$("btnLogin").onclick = login;

/* ---------- 設定 ---------- */
$("btnSettings").onclick = () => {
  $("setKey").value = ls.get("anthropic_key"); $("setClient").value = ls.get("client_id");
  $("setEmail").value = ls.get("email", "tomonori19720629@gmail.com"); $("setFolder").value = ls.get("folder_name", "タイレシート経費精算");
  $("redirectUri").textContent = redirectUri(); show("viewSettings"); msg("");
};
$("btnSettingsBack").onclick = () => show("viewMain");
$("btnSettingsSave").onclick = () => {
  ls.set("anthropic_key", $("setKey").value.trim()); ls.set("client_id", $("setClient").value.trim());
  ls.set("email", $("setEmail").value.trim()); ls.set("folder_name", $("setFolder").value.trim() || "タイレシート経費精算");
  show("viewMain"); msg("設定を保存しました", "ok"); render();
};

/* ---------- 起動 ---------- */
(async function init() {
  $("category").innerHTML = CATEGORIES.map(c => `<option>${c}</option>`).join("");
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  const back = takeTokenFromHash();
  await render();
  if (!ls.get("anthropic_key") || !ls.get("client_id")) { msg("はじめに右上の ⚙︎ で API キーとクライアント ID を設定してください", "info"); }
  if (back) { msg("Googleにログインしました", "ok"); await sync(); }
})();
