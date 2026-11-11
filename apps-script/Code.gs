/**
 * 泰國新廠設備追蹤 — Google Apps Script 後端（API）
 * 網頁：GitHub Pages；本程式負責登入、資料、雲端硬碟上傳
 * 資料存放：Google 試算表「泰國建廠設備追蹤資料庫」
 * 附件存放：雲端硬碟「泰國建廠設備文件 / 部門 / 設備名稱」
 */
const CFG = {
  APP_TITLE: '泰國新廠設備追蹤',
  ROOT_FOLDER: '泰國建廠設備文件',
  SS_NAME: '泰國建廠設備追蹤資料庫',
  SHEET: '設備清單',
  TOKEN_DAYS: 30,
  MAX_FAILS: 5,
  LOCK_MINUTES: 10
};

const COLS = [
  ['id', '編號'], ['tagNo', '機台編號'], ['dept', '部門'], ['area', '製程/站別'],
  ['name', '設備名稱'], ['nameEn', '英文名稱'], ['spec', '規格/型號'], ['vendor', '設備廠商/品牌'],
  ['qty', '數量'], ['unit', '單位'], ['currency', '幣別'], ['unitPrice', '單價'], ['totalPrice', '總價'],
  ['source', '採購來源'], ['payment', '付款狀態'], ['owner', '負責人'],
  ['poDate', '下單日'], ['eta', '預計交機日'], ['arrivalDate', '實際交機日'], ['tuneStart', '調機開始日'], ['tuneEnd', '調機完成日'], ['leadTime', '交期說明'],
  ['boi', 'BOI狀態'], ['hsCode', 'HS Code'], ['origin', '原產國'], ['size', '尺寸'],
  ['utilities', '水電氣需求'], ['note', '備註'],
  ['progress', '待辦進度'], ['todos', '待辦清單(JSON)'], ['files', '附件(JSON)'],
  ['folderId', '雲端資料夾ID'], ['updatedAt', '最後更新']
];
const EDITABLE = COLS.map(c => c[0]).filter(k => ['id', 'progress', 'files', 'folderId', 'updatedAt'].indexOf(k) < 0);

/* ---------- API 入口（網頁放在 GitHub Pages，透過這裡讀寫資料） ---------- */
const API = { getAuthState, setupAccount, login, logout, listItems, saveItem, deleteItem, uploadFile, deleteFile, exportGantt };

function doPost(e) {
  let out;
  try {
    const req = JSON.parse(e.postData.contents);
    const fn = API[req.fn];
    if (!fn) throw new Error('未知的操作：' + req.fn);
    out = { ok: true, data: fn.apply(null, req.args || []) };
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, app: CFG.APP_TITLE, message: 'API 運作中，請從 GitHub Pages 網址開啟網頁。' }))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------- 帳號（第一次輸入即永久） ---------- */
function P_() { return PropertiesService.getScriptProperties(); }

function hash_(salt, pw) {
  let h = salt + '|' + pw;
  for (let i = 0; i < 300; i++) {
    h = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + salt, Utilities.Charset.UTF_8));
  }
  return h;
}

function getAuthState() {
  return { initialized: !!P_().getProperty('AUTH_USER') };
}

function setupAccount(user, pw) {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    if (P_().getProperty('AUTH_USER')) throw new Error('帳號已經建立過了，請直接登入。');
    user = String(user || '').trim(); pw = String(pw || '');
    if (user.length < 3) throw new Error('帳號至少 3 個字元。');
    if (pw.length < 6) throw new Error('密碼至少 6 個字元。');
    const salt = Utilities.getUuid();
    P_().setProperties({ AUTH_USER: user, AUTH_SALT: salt, AUTH_HASH: hash_(salt, pw) });
    return issueToken_();
  } finally { lock.releaseLock(); }
}

function login(user, pw) {
  const p = P_();
  if (!p.getProperty('AUTH_USER')) throw new Error('尚未建立帳號。');
  const until = Number(p.getProperty('FAIL_UNTIL') || 0);
  if (until > Date.now()) {
    throw new Error('密碼錯誤次數過多，請 ' + Math.ceil((until - Date.now()) / 60000) + ' 分鐘後再試。');
  }
  const ok = String(user || '').trim() === p.getProperty('AUTH_USER') &&
    hash_(p.getProperty('AUTH_SALT'), String(pw || '')) === p.getProperty('AUTH_HASH');
  if (!ok) {
    const n = Number(p.getProperty('FAIL_COUNT') || 0) + 1;
    if (n >= CFG.MAX_FAILS) {
      p.setProperties({ FAIL_COUNT: '0', FAIL_UNTIL: String(Date.now() + CFG.LOCK_MINUTES * 60000) });
    } else {
      p.setProperty('FAIL_COUNT', String(n));
    }
    throw new Error('帳號或密碼錯誤。');
  }
  p.setProperty('FAIL_COUNT', '0');
  return issueToken_();
}

function logout(token) { if (token) P_().deleteProperty('TOK_' + token); return true; }

function issueToken_() {
  const t = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const p = P_();
  const all = p.getProperties();
  Object.keys(all).forEach(k => { if (k.indexOf('TOK_') === 0 && Number(all[k]) < Date.now()) p.deleteProperty(k); });
  p.setProperty('TOK_' + t, String(Date.now() + CFG.TOKEN_DAYS * 86400000));
  return t;
}

function check_(token) {
  const v = token && P_().getProperty('TOK_' + token);
  if (!v || Number(v) < Date.now()) throw new Error('AUTH');
}

/* ---------- 雲端硬碟 / 試算表 ---------- */
function root_() {
  const id = P_().getProperty('ROOT_ID');
  if (id) { try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) {} }
  const it = DriveApp.getFoldersByName(CFG.ROOT_FOLDER);
  const f = it.hasNext() ? it.next() : DriveApp.createFolder(CFG.ROOT_FOLDER);
  P_().setProperty('ROOT_ID', f.getId());
  return f;
}

function sheet_() {
  const id = P_().getProperty('SS_ID');
  if (id) {
    try {
      const ss = SpreadsheetApp.openById(id);
      return ss.getSheetByName(CFG.SHEET) || ss.getSheets()[0];
    } catch (e) {}
  }
  // 第一次執行：建立試算表並匯入設備清單
  const ss = SpreadsheetApp.create(CFG.SS_NAME);
  DriveApp.getFileById(ss.getId()).moveTo(root_());
  const sh = ss.getSheets()[0];
  sh.setName(CFG.SHEET);
  const seed = typeof SEED_ITEMS !== 'undefined' ? SEED_ITEMS : [];
  const rows = seed.length + 1;
  sh.getRange(1, 1, Math.max(rows, 1000), COLS.length).setNumberFormat('@');
  const data = [COLS.map(c => c[1])].concat(seed.map(it => toRow_(it, COLS.map(c => c[0]))));
  sh.getRange(1, 1, data.length, COLS.length).setValues(data);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, COLS.length).setFontWeight('bold').setBackground('#E3EDF7');
  P_().setProperty('SS_ID', ss.getId());
  return sh;
}

function headerKeys_(sh) {
  const labels = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const byLabel = {}; COLS.forEach(c => { byLabel[c[1]] = c[0]; byLabel[c[0]] = c[0]; });
  return labels.map(l => byLabel[String(l).trim()] || null);
}

function toRow_(it, keys) {
  return keys.map(k => {
    if (!k) return '';
    if (k === 'todos' || k === 'files') return JSON.stringify(it[k] || []);
    if (k === 'progress') {
      const t = it.todos || []; return t.filter(x => x.done).length + '/' + t.length;
    }
    const v = it[k];
    return v === undefined || v === null ? '' : String(v);
  });
}

function cell_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return v === null || v === undefined ? '' : String(v);
}

function readAll_() {
  const sh = sheet_();
  const keys = headerKeys_(sh);
  const last = sh.getLastRow();
  const vals = last > 1 ? sh.getRange(2, 1, last - 1, keys.length).getValues() : [];
  const items = [];
  vals.forEach((r, i) => {
    const it = { _row: i + 2 };
    keys.forEach((k, j) => { if (k) it[k] = cell_(r[j]); });
    if (!it.id && !it.name) return;
    ['todos', 'files'].forEach(k => { try { it[k] = it[k] ? JSON.parse(it[k]) : []; } catch (e) { it[k] = []; } });
    ['qty', 'unitPrice', 'totalPrice'].forEach(k => { if (it[k] !== '' && !isNaN(Number(it[k]))) it[k] = Number(it[k]); });
    delete it.progress;
    items.push(it);
  });
  return { sh: sh, keys: keys, items: items };
}

function writeItem_(db, it) {
  const row = it._row || db.sh.getLastRow() + 1;
  db.sh.getRange(row, 1, 1, db.keys.length).setNumberFormat('@').setValues([toRow_(it, db.keys)]);
  it._row = row;
}

function clean_(it) { const o = {}; Object.keys(it).forEach(k => { if (k !== '_row') o[k] = it[k]; }); return o; }

function folderName_(it, items) {
  const base = String(it.name || '未命名設備').replace(/[\\/]/g, '-').trim();
  const dup = items.some(o => o.id !== it.id && o.dept === it.dept && String(o.name).trim() === String(it.name).trim());
  return dup ? base + '_' + it.id : base;
}

function childFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function ensureFolder_(it, items) {
  if (it.folderId) {
    try { const f = DriveApp.getFolderById(it.folderId); if (!f.isTrashed()) return f; } catch (e) {}
  }
  const deptFolder = childFolder_(root_(), it.dept || '未分類');
  const f = childFolder_(deptFolder, folderName_(it, items));
  it.folderId = f.getId();
  return f;
}

/* ---------- 對網頁提供的功能 ---------- */
function listItems(token) {
  check_(token);
  const db = readAll_();
  return {
    items: db.items.map(clean_),
    meta: {
      sheetUrl: SpreadsheetApp.openById(P_().getProperty('SS_ID')).getUrl(),
      rootUrl: root_().getUrl()
    }
  };
}

function saveItem(token, input) {
  check_(token);
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const db = readAll_();
    let it = input.id ? db.items.find(x => x.id === input.id) : null;
    if (input.id && !it) throw new Error('找不到這筆設備，可能已被刪除，請重新整理。');
    const before = it ? { name: it.name, dept: it.dept } : null;
    if (!it) {
      const max = db.items.reduce((m, x) => Math.max(m, Number(String(x.id).replace(/\D/g, '')) || 0), 0);
      it = { id: 'E' + ('00' + (max + 1)).slice(-3), files: [], folderId: '' };
      db.items.push(it);
    }
    EDITABLE.forEach(k => { if (k in input) it[k] = input[k]; });
    if (!String(it.name || '').trim()) throw new Error('請填寫設備名稱。');
    it.updatedAt = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
    // 設備改名或換部門時，同步更新雲端資料夾
    if (before && it.folderId && (before.name !== it.name || before.dept !== it.dept)) {
      try {
        const f = DriveApp.getFolderById(it.folderId);
        f.setName(folderName_(it, db.items));
        if (before.dept !== it.dept) f.moveTo(childFolder_(root_(), it.dept || '未分類'));
      } catch (e) {}
    }
    writeItem_(db, it);
    return clean_(it);
  } finally { lock.releaseLock(); }
}

function deleteItem(token, id) {
  check_(token);
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const db = readAll_();
    const it = db.items.find(x => x.id === id);
    if (it) db.sh.deleteRow(it._row);   // 雲端資料夾與檔案保留，不會刪除
    return true;
  } finally { lock.releaseLock(); }
}

function uploadFile(token, id, name, mime, b64, size) {
  check_(token);
  const lock = LockService.getScriptLock(); lock.waitLock(60000);
  try {
    const db = readAll_();
    const it = db.items.find(x => x.id === id);
    if (!it) throw new Error('找不到這筆設備，請先儲存。');
    const folder = ensureFolder_(it, db.items);
    const blob = Utilities.newBlob(Utilities.base64Decode(b64), mime || 'application/octet-stream', name);
    const f = folder.createFile(blob);
    it.files = (it.files || []).concat([{
      id: f.getId(), name: name, url: f.getUrl(), size: Number(size) || f.getSize(), mime: mime || '',
      date: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')
    }]);
    writeItem_(db, it);
    return { files: it.files, folderId: it.folderId };
  } finally { lock.releaseLock(); }
}

function deleteFile(token, id, fileId) {
  check_(token);
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const db = readAll_();
    const it = db.items.find(x => x.id === id);
    if (!it) throw new Error('找不到這筆設備。');
    try { DriveApp.getFileById(fileId).setTrashed(true); } catch (e) {}   // 移到垃圾桶，30 天內可還原
    it.files = (it.files || []).filter(f => f.id !== fileId);
    writeItem_(db, it);
    return { files: it.files, folderId: it.folderId };
  } finally { lock.releaseLock(); }
}

/* ---------- 甘特圖匯出（Excel + Google 試算表） ---------- */
function d_(s) { if (!s) return null; const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
function ymd_(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd'); }

function exportGantt(token, ids) {
  check_(token);
  const db = readAll_();
  const pick = ids && ids.length ? db.items.filter(x => ids.indexOf(x.id) >= 0) : db.items;
  const items = pick.filter(x => x.poDate || x.eta || x.arrivalDate || x.tuneStart || x.tuneEnd);
  if (!items.length) throw new Error('篩選結果裡沒有填日期的設備，先填寫下單日、交機日或調機日再匯出。');
  // 時間範圍（以週為單位，週一開始）
  let min = null, max = null;
  items.forEach(x => ['poDate', 'eta', 'arrivalDate', 'tuneStart', 'tuneEnd'].forEach(k => {
    const d = d_(x[k]); if (!d) return;
    if (!min || d < min) min = d; if (!max || d > max) max = d;
  }));
  const start = new Date(min); start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const weeks = [];
  for (let w = new Date(start); w <= max; w.setDate(w.getDate() + 7)) weeks.push(new Date(w));
  if (weeks.length > 150) weeks.length = 150;

  const head = ['編號', '部門', '製程/站別', '設備名稱', '規格/型號', '設備廠商', '數量', '下單日', '預計交機日', '實際交機日', '調機開始日', '調機完成日', '待辦進度', '狀態'];
  const F = head.length;
  const C = { po: '#9DBBDD', ship: '#1C5D99', arr: '#1F7A4D', tune: '#E3A34A', none: '#FFFFFF', today: '#FBE4E1' };
  const today = d_(ymd_(new Date()));
  const values = [], bgs = [];
  values.push(head.concat(weeks.map(w => Utilities.formatDate(w, Session.getScriptTimeZone(), 'M/d'))));
  bgs.push(head.map(() => '#E3EDF7').concat(weeks.map(w => (today >= w && today < new Date(w.getTime() + 7 * 864e5)) ? C.today : '#E3EDF7')));
  items.forEach(x => {
    const t = x.todos || [], done = t.filter(y => y.done).length;
    const st = t.length && done === t.length ? '已完成' : (done || x.poDate || x.arrivalDate) ? '進行中' : '未開始';
    values.push([x.id, x.dept, x.area, x.name, x.spec, x.vendor, x.qty, x.poDate, x.eta, x.arrivalDate, x.tuneStart, x.tuneEnd, done + '/' + t.length, st]
      .map(v => v === undefined || v === null ? '' : v).concat(weeks.map(() => '')));
    const po = d_(x.poDate), eta = d_(x.eta), arr = d_(x.arrivalDate), ts = d_(x.tuneStart), te = d_(x.tuneEnd) || ts;
    const shipEnd = arr || eta;
    bgs.push(head.map(() => C.none).concat(weeks.map(w => {
      const we = new Date(w.getTime() + 7 * 864e5);
      const hit = (a, b) => a && b && a < we && b >= w;
      if (hit(ts, te)) return C.tune;
      if (arr && arr >= w && arr < we) return C.arr;
      if (eta && eta >= w && eta < we) return C.ship;
      if (hit(po, shipEnd)) return C.po;
      return C.none;
    })));
  });

  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmm');
  const ss = SpreadsheetApp.create('設備甘特圖_' + stamp);
  const folder = childFolder_(root_(), '甘特圖匯出');
  DriveApp.getFileById(ss.getId()).moveTo(folder);
  const sh = ss.getSheets()[0]; sh.setName('甘特圖');
  sh.getRange(1, 1, values.length, values[0].length).setNumberFormat('@').setValues(values).setBackgrounds(bgs);
  sh.getRange(1, 1, 1, values[0].length).setFontWeight('bold');
  sh.setFrozenRows(1); sh.setFrozenColumns(4);
  sh.setColumnWidths(F + 1, weeks.length, 34);
  sh.setColumnWidth(4, 180);
  sh.getRange(1, F + 1, values.length, weeks.length).setHorizontalAlignment('center').setFontSize(8);
  const lg = sh.getRange(values.length + 2, 1, 1, 6);
  lg.setValues([['圖例', '下單→交機', '預計交機週', '實際交機週', '調機期間', '本週']]);
  sh.getRange(values.length + 2, 2, 1, 5).setBackgrounds([[C.po, C.ship, C.arr, C.tune, C.today]]);
  sh.getRange(values.length + 2, 3, 1, 2).setFontColor('#FFFFFF');
  SpreadsheetApp.flush();

  const resp = UrlFetchApp.fetch('https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=xlsx', {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true
  });
  let xlsxUrl = '', b64 = '';
  const name = '設備甘特圖_' + stamp + '.xlsx';
  if (resp.getResponseCode() === 200) {
    const blob = resp.getBlob().setName(name);
    xlsxUrl = folder.createFile(blob).getUrl();
    b64 = Utilities.base64Encode(blob.getBytes());
  }
  return { sheetUrl: ss.getUrl(), xlsxUrl: xlsxUrl, name: name, b64: b64, count: items.length };
}

/** 如需重設帳號密碼：在編輯器選這個函式按「執行」，再重新打開網頁設定新帳密。 */
function resetAccount() {
  const p = P_(); const all = p.getProperties();
  Object.keys(all).forEach(k => { if (k.indexOf('AUTH_') === 0 || k.indexOf('TOK_') === 0 || k.indexOf('FAIL_') === 0) p.deleteProperty(k); });
}
