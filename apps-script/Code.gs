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
  ['power', '用電規格'], ['water', '純水/自來水'], ['air', '壓縮空氣'], ['gas', '氮氣/特殊氣體'], ['drain', '排水/廢水'], ['exhaust', '廢氣/廢熱'], ['utilities', '水電氣需求'], ['note', '備註'],
  ['progress', '待辦進度'], ['todos', '待辦清單(JSON)'], ['files', '附件(JSON)'],
  ['folderId', '雲端資料夾ID'], ['updatedAt', '最後更新']
];
const EDITABLE = COLS.map(c => c[0]).filter(k => ['id', 'progress', 'files', 'folderId', 'updatedAt'].indexOf(k) < 0);

/* ---------- API 入口（網頁放在 GitHub Pages，透過這裡讀寫資料） ---------- */
const API = { getAuthState, setupAccount, login, logout, listItems, saveItem, deleteItem, uploadFile, deleteFile, exportGantt, exportList, saveVendor, bulkUpdate };

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
  const keys = labels.map(l => byLabel[String(l).trim()] || null);
  // 新版本多了欄位時，自動加到試算表最右邊
  const missing = COLS.filter(c => keys.indexOf(c[0]) < 0);
  if (missing.length) {
    const start = labels.length + 1;
    sh.getRange(1, start, Math.max(sh.getMaxRows(), 2), missing.length).setNumberFormat('@');
    sh.getRange(1, start, 1, missing.length).setValues([missing.map(c => c[1])]).setFontWeight('bold').setBackground('#E3EDF7');
    missing.forEach(c => keys.push(c[0]));
  }
  return keys;
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
    vendors: readVendors_().list,
    meta: {
      sheetUrl: SpreadsheetApp.openById(P_().getProperty('SS_ID')).getUrl(),
      rootUrl: root_().getUrl()
    }
  };
}

/* ---------- 廠商通訊錄（工作表「廠商聯絡」，同一家廠商所有設備共用） ---------- */
const VENDOR_SHEET = '廠商聯絡';
const VENDOR_HEAD = ['廠商', '聯絡窗口(JSON)', '聯絡窗口（方便閱讀）', '備註', '最後更新'];

function vendorSheet_() {
  sheet_(); // 確保試算表已建立
  const ss = SpreadsheetApp.openById(P_().getProperty('SS_ID'));
  let sh = ss.getSheetByName(VENDOR_SHEET);
  if (!sh) {
    sh = ss.insertSheet(VENDOR_SHEET);
    sh.getRange(1, 1, 500, VENDOR_HEAD.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, VENDOR_HEAD.length).setValues([VENDOR_HEAD]).setFontWeight('bold').setBackground('#E3EDF7');
    sh.setFrozenRows(1);
  }
  return sh;
}

function readVendors_() {
  const sh = vendorSheet_();
  const last = sh.getLastRow();
  const vals = last > 1 ? sh.getRange(2, 1, last - 1, VENDOR_HEAD.length).getValues() : [];
  const list = [];
  vals.forEach((r, i) => {
    const name = cell_(r[0]).trim(); if (!name) return;
    let contacts = []; try { contacts = r[1] ? JSON.parse(r[1]) : []; } catch (e) {}
    list.push({ _row: i + 2, name: name, contacts: contacts, note: cell_(r[3]), updatedAt: cell_(r[4]) });
  });
  return { sh: sh, list: list.map(v => ({ name: v.name, contacts: v.contacts, note: v.note, updatedAt: v.updatedAt })), rows: list };
}

function saveVendor(token, v) {
  check_(token);
  const name = String(v && v.name || '').trim();
  if (!name) throw new Error('請先填寫設備廠商名稱。');
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const db = readVendors_();
    const contacts = (v.contacts || []).map(c => ({
      name: String(c.name || '').trim(), role: String(c.role || '').trim(), phone: String(c.phone || '').trim(),
      chat: String(c.chat || '').trim(), email: String(c.email || '').trim()
    })).filter(c => c.name || c.role || c.phone || c.chat || c.email);
    const readable = contacts.map(c => [c.name, c.role, c.phone, c.chat, c.email].filter(Boolean).join(' / ')).join('\n');
    const now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
    const row = [name, JSON.stringify(contacts), readable, String(v.note || ''), now];
    const hit = db.rows.find(x => x.name === name);
    const r = hit ? hit._row : db.sh.getLastRow() + 1;
    db.sh.getRange(r, 1, 1, row.length).setNumberFormat('@').setValues([row]);
    return { name: name, contacts: contacts, note: String(v.note || ''), updatedAt: now };
  } finally { lock.releaseLock(); }
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

/** 同名設備同步：把 fields 套用到 ids 這些設備（不動待辦、附件） */
function bulkUpdate(token, ids, fields) {
  check_(token);
  const keys = Object.keys(fields || {}).filter(k => EDITABLE.indexOf(k) >= 0 && k !== 'todos');
  const ops = fields && fields.todoOps;
  if ((!keys.length && !ops) || !ids || !ids.length) return [];
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const db = readAll_();
    const now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
    const out = [];
    ids.forEach(id => {
      const it = db.items.find(x => x.id === id); if (!it) return;
      const before = { name: it.name, dept: it.dept };
      keys.forEach(k => { it[k] = fields[k]; });
      if (ops) it.todos = applyTodoOps_(it.todos || [], ops);
      it.updatedAt = now;
      if (it.folderId && (before.name !== it.name || before.dept !== it.dept)) {
        try {
          const f = DriveApp.getFolderById(it.folderId);
          f.setName(folderName_(it, db.items));
          if (before.dept !== it.dept) f.moveTo(childFolder_(root_(), it.dept || '未分類'));
        } catch (e) {}
      }
      writeItem_(db, it); out.push(clean_(it));
    });
    return out;
  } finally { lock.releaseLock(); }
}

/** 把一台設備的待辦變更（勾選、備註、新增、刪除、順序）套到另一台；以待辦名稱對應 */
function applyTodoOps_(todos, ops) {
  let ts = todos.map(t => Object.assign({}, t));
  const find = n => ts.find(t => t.t === n);
  (ops.remove || []).forEach(n => { ts = ts.filter(t => t.t !== n); });
  (ops.add || []).forEach(a => {
    if (find(a.t)) return;
    const i = a.after ? ts.findIndex(t => t.t === a.after) : -1;
    ts.splice(i + 1, 0, { t: a.t, done: !!a.done, at: a.at || '', note: a.note || '' });
  });
  (ops.set || []).forEach(o => { const t = find(o.t); if (t) { t.done = !!o.done; t.at = o.at || ''; } });
  (ops.note || []).forEach(o => { const t = find(o.t); if (t) t.note = o.note || ''; });
  if (ops.order && ops.order.length) {
    const pos = {}; ops.order.forEach((n, i) => pos[n] = i);
    ts = ts.map((t, i) => ({ t, i })).sort((a, b) => {
      const pa = a.t.t in pos ? pos[a.t.t] : 1e6 + a.i, pb = b.t.t in pos ? pos[b.t.t] : 1e6 + b.i; return pa - pb;
    }).map(x => x.t);
  }
  return ts;
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

  const head = ['編號', '部門', '製程/站別', '設備名稱', '規格/型號', '設備廠商', '數量', '下單日', '預計交機日', '實際交機日', '調機開始日', '調機完成日', '待辦進度', '狀態', '待辦備註'].concat(UTIL_HEAD, ['總功率(kW)', '總用氣(L/min)']);
  const F = head.length;
  const C = { po: '#9DBBDD', ship: '#1C5D99', arr: '#1F7A4D', tune: '#E3A34A', none: '#FFFFFF', today: '#FBE4E1' };
  const today = d_(ymd_(new Date()));
  const values = [], bgs = [];
  values.push(head.concat(weeks.map(w => Utilities.formatDate(w, Session.getScriptTimeZone(), 'M/d'))));
  bgs.push(head.map(() => '#E3EDF7').concat(weeks.map(w => (today >= w && today < new Date(w.getTime() + 7 * 864e5)) ? C.today : '#E3EDF7')));
  items.forEach(x => {
    const t = x.todos || [], done = t.filter(y => y.done).length;
    const st = t.length && done === t.length ? '已完成' : (done || x.poDate || x.arrivalDate) ? '進行中' : '未開始';
    const tnote = t.filter(y => y.note).map(y => (y.done ? '✓' : '') + y.t + '：' + y.note).join('；');
    const u = util_(x);
    values.push([x.id, x.dept, x.area, x.name, x.spec, x.vendor, x.qty, x.poDate, x.eta, x.arrivalDate, x.tuneStart, x.tuneEnd, done + '/' + t.length, st, tnote]
      .concat(UTIL_KEYS.map(k => x[k]), [u.totalKw, u.totalLpm])
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
  buildUtilStats_(ss.insertSheet('水電氣統計'), items);
  return finishExport_(ss, folder, '設備甘特圖_' + stamp + '.xlsx', items.length);
}

function finishExport_(ss, folder, name, count) {
  SpreadsheetApp.flush();
  const resp = UrlFetchApp.fetch('https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=xlsx', {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true
  });
  let xlsxUrl = '', b64 = '';
  if (resp.getResponseCode() === 200) {
    const blob = resp.getBlob().setName(name);
    xlsxUrl = folder.createFile(blob).getUrl();
    b64 = Utilities.base64Encode(blob.getBytes());
  }
  return { sheetUrl: ss.getUrl(), xlsxUrl: xlsxUrl, name: name, b64: b64, count: count };
}

/* ---------- 水電氣：解析與統計 ---------- */
const UTIL_KEYS = ['power', 'water', 'air', 'gas', 'drain', 'exhaust'];
const UTIL_HEAD = ['用電規格', '純水/自來水', '壓縮空氣', '氮氣/特殊氣體', '排水/廢水', '廢氣/廢熱'];
function none_(v) { v = String(v == null ? '' : v).trim(); return !v || /^(n\/?a|無|无|-|—|無需用電|无需用电|不需要|不用|none)$/i.test(v); }
function num_(s, re) { const m = String(s || '').match(re); return m ? Number(m[1]) : ''; }
function qty_(x) { const q = Number(x.qty); return q > 0 ? q : 1; }
function waterType_(s) {
  if (none_(s)) return '';
  if (/pure|純水|纯水|\bDI\b|RO/i.test(s)) return '純水';
  if (/municipal|自來水|自来水|tap/i.test(s)) return '自來水';
  if (/cool|chill|冷卻|冷却|冰水/i.test(s)) return '冷卻水 / 冰水';
  return '一般用水（未分類）';
}
function util_(x) {
  const q = qty_(x), p = String(x.power || '');
  // 一台有多組電源時（例：380V/3Ph/1.5kW + 220V/1Ph/1.5kW）功率相加
  const kws = (p.match(/\d+(?:\.\d+)?\s*kW/gi) || []).map(x => parseFloat(x));
  const kw = none_(p) ? 0 : (kws.length ? kws.reduce((a, b) => a + b, 0) : (num_(p, /(\d+(?:\.\d+)?)\s*W\b/i) !== '' ? num_(p, /(\d+(?:\.\d+)?)\s*W\b/i) / 1000 : ''));
  const v = num_(p, /(\d+)\s*V/i), ph = num_(p, /(\d)\s*Ph/i);
  const airLpm = none_(x.air) ? 0 : num_(x.air, /([\d.]+)\s*L\s*\/\s*min/i);
  const mpa = none_(x.air) ? '' : (String(x.air).match(/([\d.]+(?:\s*-\s*[\d.]+)?)\s*M(?:Pa|AP)/i) || [])[1] || '';
  const waterLpm = none_(x.water) ? 0 : num_(x.water, /([\d.]+)\s*L\s*\/\s*min/i);
  const round = n => n === '' ? '' : Math.round(n * 1000) / 1000;
  return {
    qty: q, v: v, ph: ph, kw: round(kw), totalKw: kw === '' ? '' : round(kw * q),
    mpa: String(mpa).replace(/\s/g, ''), lpm: airLpm, totalLpm: airLpm === '' ? '' : round(airLpm * q),
    waterType: waterType_(x.water), waterLpm: waterLpm, totalWaterLpm: waterLpm === '' ? '' : round(waterLpm * q)
  };
}
function buildUtilStats_(sh, items) {
  const rows = [], bold = [], add = (r, b) => { rows.push(r.concat(['', '', '', '']).slice(0, 4)); if (b) bold.push(rows.length); };
  const group = (title, cols, keyFn, valFns) => {
    add([title], true); add(cols, true);
    const g = {}, order = [];
    items.forEach(x => { const k = keyFn(x); if (k === null) return; if (!g[k]) { g[k] = []; order.push(k); } g[k].push(x); });
    order.sort();
    let tot = valFns.map(() => 0);
    order.forEach(k => { const vals = valFns.map(f => g[k].reduce((a, x) => a + (Number(f(x)) || 0), 0)); vals.forEach((v, i) => tot[i] += v); add([k].concat(vals.map(v => Math.round(v * 1000) / 1000))); });
    if (order.length > 1) add(['合計'].concat(tot.map(v => Math.round(v * 1000) / 1000)), true);
    add(['']);
  };
  const U = {}; items.forEach(x => U[x.id] = util_(x));
  add(['水電氣需求統計（依匯出的 ' + items.length + ' 項設備，數量已乘上台數）'], true); add(['']);
  group('用電（依電壓 / 相數）', ['電壓 / 相數', '台數', '總功率 (kW)'],
    x => none_(x.power) ? (String(x.power || '').trim() ? '無需用電' : '未填') : ((U[x.id].v ? U[x.id].v + 'V' : '電壓未標示') + (U[x.id].ph ? ' / ' + U[x.id].ph + 'Ph' : '')),
    [x => U[x.id].qty, x => U[x.id].totalKw]);
  group('用電（依部門）', ['部門', '台數', '總功率 (kW)'], x => none_(x.power) ? null : (x.dept || '未分類'), [x => U[x.id].qty, x => U[x.id].totalKw]);
  group('純水 / 自來水', ['用水類型', '台數', '有標示流量的合計 (L/min)'], x => U[x.id].waterType || null, [x => U[x.id].qty, x => U[x.id].totalWaterLpm]);
  group('壓縮空氣（依壓力）', ['壓力 (MPa)', '台數', '總用氣量 (L/min)'], x => none_(x.air) ? null : (U[x.id].mpa ? U[x.id].mpa + ' MPa' : '壓力未標示'), [x => U[x.id].qty, x => U[x.id].totalLpm]);
  group('氮氣 / 特殊氣體', ['類型', '台數'], x => none_(x.gas) ? null : String(x.gas).trim(), [x => U[x.id].qty]);
  group('排水 / 廢水', ['類型', '台數'], x => none_(x.drain) ? null : String(x.drain).trim(), [x => U[x.id].qty]);
  group('廢氣 / 廢熱', ['類型', '台數'], x => none_(x.exhaust) ? null : String(x.exhaust).trim(), [x => U[x.id].qty]);
  sh.getRange(1, 1, rows.length, 4).setValues(rows);
  bold.forEach(r => sh.getRange(r, 1, 1, 4).setFontWeight('bold'));
  sh.setColumnWidth(1, 260); sh.setColumnWidths(2, 3, 150);
}

/** 匯出設備清單（含水電氣需求與統計） */
function exportList(token, ids) {
  check_(token);
  const db = readAll_();
  const items = ids && ids.length ? db.items.filter(x => ids.indexOf(x.id) >= 0) : db.items;
  if (!items.length) throw new Error('沒有可以匯出的設備。');
  const head = ['編號', '部門', '製程/站別', '設備名稱', '規格/型號', '設備廠商', '數量', '單位', '採購來源', '預計交機日', '實際交機日', '調機開始日', '調機完成日', '待辦進度', '狀態', 'BOI狀態', '尺寸']
    .concat(UTIL_HEAD, ['電壓(V)', '相數(Ph)', '單台功率(kW)', '總功率(kW)', '壓縮空氣壓力(MPa)', '單台用氣(L/min)', '總用氣(L/min)', '用水類型', '總用水(L/min)', '其他廠務備註', '待辦備註']);
  const NUMS = ['數量', '電壓(V)', '相數(Ph)', '單台功率(kW)', '總功率(kW)', '單台用氣(L/min)', '總用氣(L/min)', '總用水(L/min)'];
  const values = [head];
  items.forEach(x => {
    const t = x.todos || [], done = t.filter(y => y.done).length, u = util_(x);
    const st = t.length && done === t.length ? '已完成' : (done || x.poDate || x.arrivalDate) ? '進行中' : '未開始';
    values.push([x.id, x.dept, x.area, x.name, x.spec, x.vendor, x.qty, x.unit, x.source, x.eta, x.arrivalDate, x.tuneStart, x.tuneEnd, done + '/' + t.length, st, x.boi, x.size]
      .concat(UTIL_KEYS.map(k => x[k]), [u.v, u.ph, u.kw, u.totalKw, u.mpa, u.lpm, u.totalLpm, u.waterType, u.totalWaterLpm, x.utilities,
        t.filter(y => y.note).map(y => (y.done ? '✓' : '') + y.t + '：' + y.note).join('；')])
      .map(v => v === undefined || v === null ? '' : v));
  });
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmm');
  const ss = SpreadsheetApp.create('設備清單_水電氣_' + stamp);
  const folder = childFolder_(root_(), '甘特圖匯出');
  DriveApp.getFileById(ss.getId()).moveTo(folder);
  const sh = ss.getSheets()[0]; sh.setName('設備清單');
  head.forEach((h, i) => { if (NUMS.indexOf(h) < 0) sh.getRange(1, i + 1, values.length, 1).setNumberFormat('@'); });
  sh.getRange(1, 1, values.length, head.length).setValues(values);
  sh.getRange(1, 1, 1, head.length).setFontWeight('bold').setBackground('#E3EDF7');
  sh.setFrozenRows(1); sh.setFrozenColumns(4); sh.setColumnWidth(4, 180);
  buildUtilStats_(ss.insertSheet('水電氣統計'), items);
  return finishExport_(ss, folder, '設備清單_水電氣_' + stamp + '.xlsx', items.length);
}

/**
 * 一次性：匯入「泰國設備清單_20261019」的水電氣資料（Import.gs 的 IMPORT_DATA），
 * 並把舊的「水電氣需求」文字拆到新欄位。用法：選 importUtilities → 執行。
 */
function importUtilities() {
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const db = readAll_();
    const now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
    const normN = s => String(s || '').replace(/[\s\-_/\\()（）]/g, '').toLowerCase();
    let upd = 0, added = 0, migrated = 0; const skipped = [];
    const data = Object.assign({ updates: [], newItems: [] }, (typeof IMPORT_DATA !== 'undefined' && IMPORT_DATA) || {});
    // 1) 舊的「電: …；水: …」文字拆到新欄位（只填空白的欄位）
    const MAP = { '電': 'power', '水': 'water', '氣': 'air', '特氣': 'gas', '排水': 'drain', '廢氣': 'exhaust' };
    db.items.forEach(it => {
      if (!it.utilities || UTIL_KEYS.some(k => it[k])) return;
      const rest = [];
      String(it.utilities).split('；').forEach(seg => {
        const m = seg.match(/^\s*(電|水|氣|特氣|排水|廢氣)\s*[:：]\s*(.*)$/);
        if (m && !it[MAP[m[1]]]) it[MAP[m[1]]] = m[2].trim(); else if (seg.trim()) rest.push(seg.trim());
      });
      it.utilities = rest.join('；'); it._dirty = true; migrated++;
    });
    // 2) 依名稱對應的設備：寫入新表的水電氣
    data.updates.forEach(u => {
      const it = db.items.find(x => x.id === u.id);
      if (!it || (u.name && normN(it.name) !== normN(u.name))) { skipped.push(u.id + ' ' + (u.name || '')); return; }
      UTIL_KEYS.forEach(k => { if (k in u.fields) it[k] = u.fields[k]; });
      Object.keys(u.extra || {}).forEach(k => { if (EDITABLE.indexOf(k) >= 0) it[k] = u.extra[k]; });
      it._dirty = true; upd++;
    });
    db.items.forEach(it => { if (it._dirty) { delete it._dirty; writeItem_(db, it); } });
    // 3) 新表有、網站沒有的設備：新增
    let max = db.items.reduce((m, x) => Math.max(m, Number(String(x.id).replace(/\D/g, '')) || 0), 0);
    data.newItems.forEach(n => {
      if (db.items.some(x => normN(x.name) === normN(n.name) && x.dept === n.dept && x.area === n.area && normN(x.spec) === normN(n.spec))) { skipped.push('（已存在）' + n.name); return; }
      const it = Object.assign({ files: [], folderId: '' }, n, { id: 'E' + ('00' + (++max)).slice(-3), updatedAt: now });
      db.items.push(it); writeItem_(db, it); added++;
    });
    Logger.log('舊資料拆欄位：' + migrated + ' 項；更新水電氣：' + upd + ' 項；新增設備：' + added + ' 項。' + (skipped.length ? '略過：' + skipped.join('、') : ''));
  } finally { lock.releaseLock(); }
}

/**
 * 一次性：把已匯入試算表的設備資料換成 Seed.gs 的繁體版本。
 * 只更新從沒在網頁上改過的設備（「最後更新」是空白的）；日期、待辦、附件都不動。
 * 用法：先把 Seed.gs 換成繁體版，在編輯器上方選這個函式，按「執行」。
 */
function convertToTraditional() {
  if (!P_().getProperty('SS_ID')) { Logger.log('試算表還沒建立，第一次打開網頁時會直接使用繁體資料。'); return; }
  const FIELDS = ['dept', 'area', 'name', 'nameEn', 'spec', 'vendor', 'unit', 'leadTime', 'note', 'utilities', 'size', 'origin', 'source', 'boi'];
  const seed = {}; SEED_ITEMS.forEach(x => { seed[x.id] = x; });
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const db = readAll_();
    let done = 0, skipped = [];
    db.items.forEach(it => {
      const s = seed[it.id];
      if (!s) return;
      if (it.updatedAt) { skipped.push(it.id + ' ' + it.name); return; }
      const before = { name: it.name, dept: it.dept };
      FIELDS.forEach(k => { if (k in s) it[k] = s[k]; });
      if (it.folderId && (before.name !== it.name || before.dept !== it.dept)) {
        try {
          const f = DriveApp.getFolderById(it.folderId);
          f.setName(folderName_(it, db.items));
          if (before.dept !== it.dept) f.moveTo(childFolder_(root_(), it.dept || '未分類'));
        } catch (e) {}
      }
      writeItem_(db, it); done++;
    });
    // 舊的簡體部門資料夾若已清空就移到垃圾桶
    const old = root_().getFoldersByName('制造部');
    while (old.hasNext()) { const f = old.next(); if (!f.getFolders().hasNext() && !f.getFiles().hasNext()) f.setTrashed(true); }
    Logger.log('已轉成繁體：' + done + ' 項。' + (skipped.length ? '網頁上改過、沒有覆蓋的 ' + skipped.length + ' 項：' + skipped.join('、') : ''));
  } finally { lock.releaseLock(); }
}

/** 如需重設帳號密碼：在編輯器選這個函式按「執行」，再重新打開網頁設定新帳密。 */
function resetAccount() {
  const p = P_(); const all = p.getProperties();
  Object.keys(all).forEach(k => { if (k.indexOf('AUTH_') === 0 || k.indexOf('TOK_') === 0 || k.indexOf('FAIL_') === 0) p.deleteProperty(k); });
}
