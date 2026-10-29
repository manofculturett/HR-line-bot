/**
 * Runs the real apps-script/*.gs files against a stubbed Apps Script runtime, seeded with a
 * frozen, anonymized snapshot of the live sheet (scripts/fixtures/seed.json). Apps Script has
 * no local runtime, so this is the only place the server logic is executed before a deploy.
 *
 *   node scripts/harness.js        # exit 0 = all assertions pass
 *
 * The assertions are pinned to that snapshot and a fake clock (2026-10-27 00:40 Bangkok) —
 * do not re-export the fixture from the live sheet; add a scenario with setNow() instead.
 * The nested "21 passed, 1 failed" lines are selfTest's own log: sections 4/5 need the real
 * LINE channel and always fail here.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'apps-script');
const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'seed.json'), 'utf8'));

// Fixed "now" so every assertion is deterministic: 00:40 on 2026-10-27 Asia/Bangkok.
const REAL_NOW = Date.parse('2026-10-27T00:40:00+07:00');

const outbox = [];
const logs = [];
const triggers = [];
const fetchCalls = [];

function pad(row, n) {
  const o = (row || []).slice(0, n);
  while (o.length < n) o.push('');
  return o;
}
function colToNum(s) {
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
function parseA1(a1) {
  const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(String(a1).replace(/\s/g, ''));
  if (!m) throw new Error('harness: unsupported A1 "' + a1 + '"');
  const r1 = +m[2], c1 = colToNum(m[1]);
  const r2 = m[4] ? +m[4] : r1, c2 = m[3] ? colToNum(m[3]) : c1;
  return { row: r1, col: c1, nRows: r2 - r1 + 1, nCols: c2 - c1 + 1 };
}
function ensureCell(grid, r, c) {          // 1-based
  while (grid.length < r) grid.push([]);
  const row = grid[r - 1];
  while (row.length < c) row.push('');
  return row;
}

// ── the runtime ────────────────────────────────────────────────────────────────
const sandbox = {};
vm.createContext(sandbox);

sandbox.__NOW__ = REAL_NOW;          // movable: a test can walk the clock to Monday morning
vm.runInContext(`
class FakeDate extends Date {
  constructor(...a) { if (a.length === 0) super(globalThis.__NOW__); else super(...a); }
  static now() { return globalThis.__NOW__; }
}
globalThis.Date = FakeDate;
`, sandbox);
/** Move the fake clock. Tests that care about "a weekend passed" set it explicitly. */
function setNow(iso) { sandbox.__NOW__ = Date.parse(iso); }

sandbox.console = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')),
                    error: (...a) => logs.push(a.join(' ')) };
sandbox.MAXROWS = {};
sandbox.INSERTS = [];
// Apps Script returns SIGNED bytes from computeDigest — mirror that, so the hex code is tested
sandbox.SHA256_SIGNED = s => Array.from(require('crypto').createHash('sha256').update(String(s)).digest())
  .map(b => (b > 127 ? b - 256 : b));
sandbox.GRID = {};
sandbox.EMAIL_OUT = outbox;
sandbox.TRIGGERS = triggers;
sandbox.FETCH_CALLS = fetchCalls;
sandbox.PROPS = {
  SHEET_ID: 'fake', WEBHOOK_SECRET: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't',
  LINE_CHANNEL_ID: '123', LIFF_ID: '2012159701-NWz9NCHX', LIFF_CHANNEL_ID: '456'
};
// helpers + the live-sheet snapshot, visible to the sandbox's own prologue
sandbox.SEED = SEED;
sandbox.parseA1 = parseA1;
sandbox.colToNum = colToNum;
sandbox.ensureCell = ensureCell;

vm.runInContext(`
const GRID_META = { DATA: 12, EMPLOYEES_LOG: 8, HR_MAIN: 21 };

function sheetTab(name) {
  if (!GRID[name]) GRID[name] = [];
  const grid = GRID[name];
  if (!(name in MAXROWS)) MAXROWS[name] = 1000;
  return {
    getName: () => name,
    getMaxRows: () => MAXROWS[name],
    insertRowsAfter: (after, n) => { INSERTS.push([name, after, n]); MAXROWS[name] += n; },
    getLastRow: () => grid.length,
    getLastColumn: () => grid.reduce((m, r) => Math.max(m, r.length), 0),
    getSpreadsheetTimeZone: () => 'Asia/Bangkok',
    getRange: (a, b, c, d) => {
      let r, col, nr, nc;
      if (typeof a === 'string') { const p = parseA1(a); r = p.row; col = p.col; nr = p.nRows; nc = p.nCols; }
      else { r = a; col = b; nr = c === undefined ? 1 : c; nc = d === undefined ? 1 : d; }
      return {
        getValues: () => {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = grid[r - 1 + i] || [];
            const o = [];
            for (let j = 0; j < nc; j++) {
              const v = row[col - 1 + j];
              o.push(v === undefined || v === null ? '' : v);
            }
            out.push(o);
          }
          return out;
        },
        getValue: () => { const row = grid[r - 1] || []; const v = row[col - 1]; return v === undefined || v === null ? '' : v; },
        setValues: vals => {
          for (let i = 0; i < vals.length; i++) {
            const row = ensureCell(grid, r + i, col);
            for (let j = 0; j < vals[i].length; j++) row[col - 1 + j] = vals[i][j];
          }
        },
        setValue: v => { ensureCell(grid, r, col)[col - 1] = v; }
      };
    }
  };
}

globalThis.SpreadsheetApp = {
  openById: () => ({ getName: () => 'Customer', getSheetByName: sheetTab })
};
globalThis.Utilities = {
  formatDate: (d, tz, fmt) => {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'Asia/Bangkok', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(d.getTime()));
    const g = t => (p.find(x => x.type === t) || {}).value;
    const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return String(fmt).replace(/yyyy|MMM|MM|dd|HH|mm|ss|d/g, t => ({
      yyyy: g('year'), MMM: MON[Number(g('month')) - 1], MM: g('month'),
      dd: g('day'), d: String(Number(g('day'))),
      HH: g('hour'), mm: g('minute'), ss: g('second')
    })[t]);
  }
};
globalThis.LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
globalThis.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: k => (k in PROPS ? PROPS[k] : null),
    getProperties: () => Object.assign({}, PROPS),
    setProperty: (k, v) => { PROPS[k] = String(v); },
    deleteProperty: k => { delete PROPS[k]; }
  })
};
globalThis.GmailApp = { sendEmail: (to, subject, body) => EMAIL_OUT.push({ to, subject, body }) };
globalThis.Session = { getScriptTimeZone: () => 'Asia/Bangkok' };
globalThis.CACHE = {};
globalThis.CacheService = { getScriptCache: () => ({
  get: k => (k in CACHE ? CACHE[k].v : null),
  put: (k, v, ttl) => { CACHE[k] = { v: String(v), ttl: ttl }; },
  remove: k => { delete CACHE[k]; }
}) };
Utilities.DigestAlgorithm = { SHA_256: 'sha256' };
Utilities.Charset = { UTF_8: 'utf8' };
Utilities.computeDigest = (alg, s) => SHA256_SIGNED(s);
globalThis.UrlFetchApp = {
  fetch: (url, opts) => {
    FETCH_CALLS.push({ url, opts });
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ sub: 'U_test_sid_0000', displayName: 'Test' }) };
  }
};
globalThis.ContentService = {
  createTextOutput: b => ({ setMimeType: () => ({ body: b }) }),
  MimeType: { JSON: 'json', JAVASCRIPT: 'js' }
};
globalThis.ScriptApp = {
  getProjectTriggers: () => TRIGGERS.slice(),
  deleteTrigger: t => { const i = TRIGGERS.indexOf(t); if (i >= 0) TRIGGERS.splice(i, 1); },
  newTrigger: fn => {
    const chain = {
      timeBased: () => chain, atHour: () => chain, nearMinute: () => chain, everyDays: () => chain,
      create: () => { const t = { getHandlerFunction: () => fn }; TRIGGERS.push(t); return t; }
    };
    return chain;
  }
};
`, sandbox);

// load the project, in the order Apps Script concatenates it
for (const f of fs.readdirSync(SRC).filter(f => f.endsWith('.gs')).sort()) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sandbox, { filename: f });
}
const REAL_VERIFY = sandbox.verifyLiffIdToken_;      // attach() replaces it; v2.4 tests need it

// ── seed / reset ───────────────────────────────────────────────────────────────
// Runs inside the sandbox, so `Date` is the fake one and `instanceof` matches.
function seed() {
  sandbox.__NOW__ = REAL_NOW;            // every test starts from the same instant
  for (const k of Object.keys(sandbox.CACHE)) delete sandbox.CACHE[k];
  for (const k of Object.keys(sandbox.MAXROWS)) delete sandbox.MAXROWS[k];
  sandbox.INSERTS.length = 0;
  vm.runInContext(`
(function () {
  function d(s) {                       // 'yyyy-MM-dd HH:mm:ss' read as Asia/Bangkok
    if (!s) return '';
    const m = /^(\\d{4})-(\\d{2})-(\\d{2})(?: (\\d{2}):(\\d{2})(?::(\\d{2}))?)?$/.exec(String(s).trim());
    if (!m) return s;
    return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  }
  GRID.DATA = SEED.DATA.map(r => {
    const row = r.slice();
    if (row[0]) row[0] = d(row[0]);     // attendance ts (A)
    if (row[8]) row[8] = d(row[8]);     // log ts (I)
    return row;
  });
  GRID.EMPLOYEES_LOG = SEED.EMPLOYEES_LOG.map(r => r.slice());
  GRID.HR_MAIN = [];
  SEED.HR_MAIN_CONFIG.forEach((kv, i) => {
    const row = ensureCell(GRID.HR_MAIN, i + 4, 21);   // T4:U20
    row[19] = kv[0] || '';
    row[20] = kv[1] === undefined ? '' : kv[1];
  });
})();
`, sandbox);
}

// ── assertions ─────────────────────────────────────────────────────────────────
let pass = 0; const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { failures.push(name + ' → ' + e.message); console.log('  FAIL  ' + name + ' → ' + e.message); }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error((what || 'value') + ': expected ' + b + ', got ' + a);
}
function ok(cond, what) { if (!cond) throw new Error(what || 'assertion failed'); }
function has(hay, needle, what) {
  if (String(hay).indexOf(needle) === -1) {
    throw new Error((what || 'text') + ': missing "' + needle + '" in:\n' + hay);
  }
}
const G = sandbox;                                   // the .gs globals
const COLS = G.COLS;
const TZ = 'Asia/Bangkok';
const EMP = () => G.employeeById_('A0124');
const attach = () => { G.verifyLiffIdToken_ = () => 'U_test_sid_0000'; };
const cfgWith = patch => { const c = G.getConfig_(); return Object.assign(c, patch || {}); };
function setCfg(key, value) {
  const sh = G.getTab_('HR_MAIN');
  const rows = sh.getRange(G.HR_MAIN.CONFIG_RANGE).getValues();
  const i = rows.findIndex(r => String(r[0]).trim() === key);
  if (i < 0) {                                   // append inside T4:U20, as HR would
    const freeIdx = rows.findIndex(r => String(r[0] || '').trim() === '');
    if (freeIdx < 0) throw new Error('config block full: ' + key);
    const nextRow = 4 + freeIdx;
    sh.getRange(nextRow, 20).setValue(key);
    sh.getRange(nextRow, 21).setValue(value);
    return;
  }
  sh.getRange(4 + i, 21).setValue(value);        // column U holds the value
}

console.log('\n=== v2.2.0 forgotten-check-out harness ===\n');

// ── 1. the shared definition of a dangling day ─────────────────────────────────
seed();
t('openDaysByEmployee_ finds the one dangling day (26/10 12:58)', () => {
  const open = G.openDaysByEmployee_(TZ);
  eq(Object.keys(open), ['A0124'], 'employees with open days');
  eq(open.A0124.length, 1, 'open days for A0124');
  eq(G.Utilities.formatDate(open.A0124[0].ts, TZ, 'yyyy-MM-dd HH:mm'), '2026-10-26 12:58', 'dangling in');
});
t('staleOpenIn_ keeps returning only the newest dangling day', () => {
  const s = G.staleOpenIn_('A0124', TZ);
  eq(G.Utilities.formatDate(s.ts, TZ, 'yyyy-MM-dd HH:mm'), '2026-10-26 12:58', 'stale in');
  eq(G.staleOpenIn_('A0999', TZ), null, 'unknown employee');
});

// ── 2. the 05:00 report ────────────────────────────────────────────────────────
t('forgotOutReport sends one professional email listing the open day + the procedure', () => {
  setCfg('EMAIL_ENABLED', 'TRUE');              // the live sheet currently has it FALSE
  outbox.length = 0;
  G.forgotOutReport();
  eq(outbox.length, 1, 'emails sent');
  has(outbox[0].subject, '[ระบบลงเวลาทำงาน] รายการลงเวลาที่ต้องตรวจสอบ 1 รายการ', 'subject');
  has(outbox[0].subject, '27 ตุลาคม 2569', 'subject date (Buddhist era)');
  has(outbox[0].body, 'เรียน ฝ่ายทรัพยากรบุคคล', 'greeting');
  has(outbox[0].body, 'พนักงานทดสอบ (A0124) — เข้างานวันที่ 26 ตุลาคม 2569 เวลา 12:58 น.', 'body line');
  has(outbox[0].body, 'รายการที่ยังไม่ลงเวลาเลิกงาน (1 รายการ)', 'section head');
  has(outbox[0].body, 'แนวทางการดำเนินการ', 'actions head');
  has(outbox[0].body, 'FIX_EMP_ID', 'body hint (the runnable procedure, not an argument list)');
  has(outbox[0].body, 'ปิดเวลาออกให้อัตโนมัติเมื่อครบ 3 วัน', 'auto-close policy is stated');
  has(outbox[0].body, 'กรุณาอย่าตอบกลับ', 'footer');
  ok(outbox[0].body.indexOf('เดาเวลา') === -1, 'no informal "guessing" wording');
  eq(outbox[0].to, 'hr@example.com', 'recipient');
});
t('forgotOutReport respects EMAIL_ENABLED=FALSE', () => {
  seed();
  setCfg('EMAIL_ENABLED', 'FALSE');
  outbox.length = 0;
  logs.length = 0;
  G.forgotOutReport();
  eq(outbox.length, 0, 'emails sent while OFF');
  ok(logs.some(l => l.indexOf('forgotOutReport skipped') !== -1), 'skip logged: ' + logs.join('|'));
});
t('forgotOutReport is silent (and logs a run row) when nothing is outstanding', () => {
  seed();
  setCfg('EMAIL_ENABLED', 'TRUE');
  outbox.length = 0;
  G.hrFixDay('A0124', '2026-10-26', '19:30');
  outbox.length = 0;
  G.forgotOutReport();
  eq(outbox.length, 0, 'emails sent');
  const logRows = G.readBlock_('LOG').filter(r => String(r.values[COLS.LOG.ACTION]) === 'report:forgot_out');
  eq(logRows.length, 1, 'report rows in LOG');
  eq(String(logRows[0].values[COLS.LOG.STATUS]), '0 open, 0 auto-closed, 0 self-reported', 'run status');
});

// ── 3. hrFixDay guards ─────────────────────────────────────────────────────────
seed();
t('hrFixDay refuses TODAY (a row dated today would read as today\'s check-out)', () => {
  has(G.hrFixDay('A0124', '2026-10-27', '18:00'), 'เฉพาะวันก่อนหน้า', 'message');
});
t('hrFixDay refuses a time before the check-in', () => {
  has(G.hrFixDay('A0124', '2026-10-26', '12:00'), 'หลังเวลาเข้างาน (12:58)', 'message');
});
t('hrFixDay refuses an unknown employee id', () => {
  has(G.hrFixDay('A0999', '2026-10-26', '19:30'), 'ไม่พบรหัสพนักงาน', 'message');
});
// v2.5: a day that is already closed used to be untouchable — the accidental tap stayed on the
// record for ever. A LATER check-out is now appended (the sheet reads the day's last `out`, so
// the later row wins); an EARLIER one is refused, because it could not change what anyone sees.
t('hrFixDay corrects a closed day when the new check-out is later (accidental early tap)', () => {
  seed();
  const before = G.readBlock_('ATTENDANCE');
  const res = G.hrFixDay('A0124', '2026-10-24', '20:00');   // recorded out was 19:21
  has(res, 'แก้ไขเวลาเลิกงานของวันที่ 2026-10-24 เป็น 20:00', 'result');
  has(res, '7 ชม. 18 นาที', 'hours from the day\'s check-in 12:42');

  const after = G.readBlock_('ATTENDANCE');
  eq(after.length, before.length + 1, 'one row appended, nothing edited or deleted');
  const added = after[after.length - 1].values;
  eq(G.Utilities.formatDate(added[COLS.ATTENDANCE.TS], TZ, 'yyyy-MM-dd HH:mm'), '2026-10-24 20:00', 'ts');
  eq(String(added[COLS.ATTENDANCE.SOURCE]), 'hr_fix', 'source');
  eq(String(added[COLS.ATTENDANCE.NOTE]), 'corrected_out 2026-10-24 20:00 (was 19:21)', 'note names the old time');
  // the original punch is still there, untouched — the ledger stays reconstructable
  ok(before.some(r => String(r.values[COLS.ATTENDANCE.NOTE]) === 'geo:ok 12m' &&
                      G.Utilities.formatDate(r.values[COLS.ATTENDANCE.TS], TZ, 'HH:mm') === '19:21'),
     'the original 19:21 check-out is still in the ledger');
  // and the premise of the correction: the day's latest `out` (what the sheet's MAX() reads)
  let latest = null;
  after.forEach(r => {
    const v = r.values;
    if (String(v[COLS.ATTENDANCE.EVENT]) !== 'out') return;
    if (G.Utilities.formatDate(v[COLS.ATTENDANCE.TS], TZ, 'yyyy-MM-dd') !== '2026-10-24') return;
    if (!latest || v[COLS.ATTENDANCE.TS] > latest) latest = v[COLS.ATTENDANCE.TS];
  });
  eq(G.Utilities.formatDate(latest, TZ, 'HH:mm'), '20:00', 'latest out is the correction');
});
t('hrFixDay refuses a correction that is EARLIER — it could not change the sheet', () => {
  seed();
  const res = G.hrFixDay('A0124', '2026-10-24', '19:00');   // recorded out 19:21
  has(res, 'บันทึกเวลาเลิกงานของวันนั้นไว้ที่ 19:21', 'says what is recorded');
  has(res, 'เฉพาะเวลาเลิกงานที่หลังกว่านั้น', 'explains the rule');
  eq(G.readBlock_('ATTENDANCE').filter(r =>
    String(r.values[COLS.ATTENDANCE.SOURCE]) === 'hr_fix').length, 0, 'nothing written');
});
t('hrFixDay refuses an impossible date and a malformed time', () => {
  has(G.hrFixDay('A0124', '2026-02-31', '19:30'), 'รูปแบบวันที่', 'bad date');
  has(G.hrFixDay('A0124', '2026-10-26', '7pm'), 'รูปแบบวันที่', 'bad time');
});
t('hrFixDay accepts a valid fix, then B3-equivalent state is clean', () => {
  const rowsBefore = G.readBlock_('ATTENDANCE').length;
  const res = G.hrFixDay('A0124', '2026-10-26', '19:30');
  has(res, 'ปิดวัน 2026-10-26', 'result');
  has(res, '6 ชม. 32 นาที', 'hours');

  const rows = G.readBlock_('ATTENDANCE');
  eq(rows.length, rowsBefore + 1, 'rows appended');
  const added = rows[rows.length - 1].values;
  eq(G.Utilities.formatDate(added[COLS.ATTENDANCE.TS], TZ, 'yyyy-MM-dd HH:mm'), '2026-10-26 19:30', 'ts');
  eq(String(added[COLS.ATTENDANCE.EVENT]), 'out', 'event');
  eq(String(added[COLS.ATTENDANCE.SOURCE]), 'hr_fix', 'source');
  eq(String(added[COLS.ATTENDANCE.NOTE]), 'forgot_out 2026-10-26 closed by HR 19:30', 'note');

  eq(Object.keys(G.openDaysByEmployee_(TZ)).length, 0, 'open days left');
  eq(G.staleOpenIn_('A0124', TZ), null, 'stale in');
  const logRows = G.readBlock_('LOG').filter(r => String(r.values[COLS.LOG.ACTION]) === 'hr_fix');
  eq(logRows.length, 1, 'hr_fix rows in LOG');
});
// v2.5 replaces the old "twice is refused": a second call with a LATER time is a correction
// (HR closed 19:30, then remembered 20:00). The employee-facing punch rule is unchanged and is
// asserted separately — only HR can touch a past day, and every step is marked in the ledger.
t('a second correction is allowed and marked, and the punch rules are untouched', () => {
  const res = G.hrFixDay('A0124', '2026-10-26', '20:00');   // closed at 19:30 by the test above
  has(res, 'แก้ไขเวลาเลิกงานของวันที่ 2026-10-26 เป็น 20:00', 'corrects');
  has(res, '7 ชม. 2 นาที', 'hours from 12:58');
  eq(String(G.readBlock_('ATTENDANCE').pop().values[COLS.ATTENDANCE.NOTE]),
     'corrected_out 2026-10-26 20:00 (was 19:30)', 'note names the previous time');
  const fixes = G.readBlock_('LOG').filter(r => String(r.values[COLS.LOG.ACTION]) === 'hr_fix_out');
  eq(fixes.length, 1, 'one hr_fix_out LOG row');
  // the day still reads closed for the bot, so no dangling-day warning reappears
  eq(G.openDaysByEmployee_(TZ).A0124, undefined, 'no open day');
});

// ── 4. the employee's own path, through the LIFF route ─────────────────────────
seed(); attach();
t('hrFixDay() is runnable from the Run button: no args, request from Script Properties', () => {
  seed();
  has(G.hrFixDay(), 'ยังไม่ได้ระบุคำขอ', 'bare run with no request says what to set');
  G.PROPS.FIX_EMP_ID = 'A0124';
  G.PROPS.FIX_DATE = '2026-10-26';
  G.PROPS.FIX_TIME = '19:30';
  has(G.hrFixDay(), 'ปิดวัน 2026-10-26', 'result');
  eq('FIX_EMP_ID' in G.PROPS, false, 'FIX_EMP_ID cleared after success');
  eq('FIX_TIME' in G.PROPS, false, 'FIX_TIME cleared after success');
  eq(Object.keys(G.openDaysByEmployee_(TZ)).length, 0, 'open days left');
});
t('a failed property run keeps the request so one value can be corrected', () => {
  seed();
  G.PROPS.FIX_EMP_ID = 'A0124';
  G.PROPS.FIX_DATE = '2026-10-26';
  G.PROPS.FIX_TIME = '11:00';                    // before the 12:58 check-in
  has(G.hrFixDay(), 'หลังเวลาเข้างาน', 'refusal');
  eq(G.PROPS.FIX_TIME, '11:00', 'FIX_TIME kept');
  eq(G.PROPS.FIX_EMP_ID, 'A0124', 'FIX_EMP_ID kept');
  ['FIX_EMP_ID', 'FIX_DATE', 'FIX_TIME'].forEach(k => delete G.PROPS[k]);
});
t('LIFF action "open" lists the dangling day with a date for the picker', () => {
  const res = G.handleLiffPunch_({ idToken: 'tok', action: 'open' });
  ok(res.ok, 'ok flag: ' + JSON.stringify(res));
  eq(res.action, 'open', 'action');
  eq(res.days, [{ date: '2026-10-26', label: '26/10', inHHmm: '12:58' }], 'days');
  has(res.text, 'ยังไม่ได้ลงเวลาเลิกงาน', 'text head');
  has(res.text, 'ภายใน 7 วัน', 'text tail');
});
t('LIFF action "fix" writes source=self_report and never a geo row', () => {
  const geoBefore = G.readBlock_('GEO').length;
  const res = G.handleLiffPunch_({ idToken: 'tok', action: 'fix', date: '2026-10-26', hhmm: '20:00' });
  ok(res.ok, 'ok flag: ' + JSON.stringify(res));
  has(res.text, 'เป็นการแจ้งเอง', 'employee is told it was self-reported');

  const rows = G.readBlock_('ATTENDANCE');
  const added = rows[rows.length - 1].values;
  eq(String(added[COLS.ATTENDANCE.SOURCE]), 'self_report', 'source');
  eq(String(added[COLS.ATTENDANCE.EVENT]), 'out', 'event');
  eq(String(added[COLS.ATTENDANCE.NOTE]), 'forgot_out 2026-10-26 self-reported 20:00', 'note');
  eq(G.readBlock_('GEO').length, geoBefore, 'geo rows written');
  eq(Object.keys(G.openDaysByEmployee_(TZ)).length, 0, 'open days left');
});
t('a second identical "fix" is refused, not written twice', () => {
  const before = G.readBlock_('ATTENDANCE').length;
  const res = G.handleLiffPunch_({ idToken: 'tok', action: 'fix', date: '2026-10-26', hhmm: '20:00' });
  eq(res.ok, false, 'ok flag');
  eq(res.error, 'not_open', 'error');
  eq(G.readBlock_('ATTENDANCE').length, before, 'rows appended');
});
t('the report then shows the self-reported day once, for HR to check', () => {
  setCfg('EMAIL_ENABLED', 'TRUE');
  outbox.length = 0;
  G.forgotOutReport();
  eq(outbox.length, 1, 'emails sent');
  has(outbox[0].subject, 'รายการลงเวลาที่ต้องตรวจสอบ 1 รายการ', 'subject');
  has(outbox[0].body, 'รายการที่พนักงานแจ้งเวลาเลิกงานด้วยตนเอง (1 รายการ', 'section head');
  has(outbox[0].body, 'A0124 — เลิกงานวันที่ 26 ตุลาคม 2569 เวลา 20:00 น.', 'self-report line');
  has(outbox[0].body, 'ไม่ได้มาจากการลงเวลาหรือการสแกนจริง', 'HR is told it was not scanned');
});
t('self-report is refused beyond SELF_REPORT_DAYS', () => {
  seed();
  const res = G.handleLiffPunch_({ idToken: 'tok', action: 'fix', date: '2026-10-01', hhmm: '18:00' });
  eq(res.ok, false, 'ok flag');
  eq(res.error, 'expired', 'error');
});
t('SELF_REPORT_DAYS=0 turns the employee path off (HR stays the only closer)', () => {
  seed();
  setCfg('SELF_REPORT_DAYS', '0');               // new row T20:U20, as it will be live
  const cfg = G.getConfig_();
  eq(cfg.SELF_REPORT_DAYS, '0', 'config row read back');
  const list = G.fixList_(EMP(), cfg);
  eq(list.days.length, 1, 'the open day is still listed, not hidden');
  has(list.text, 'ติดต่อ HR', 'text');
  const res = G.handleLiffPunch_({ idToken: 'tok', action: 'fix', date: '2026-10-26', hhmm: '18:00' });
  eq(res.error, 'disabled', 'error');
});

// ── 5. the self-heal: a Friday nobody ever confirms ───────────────────────────
/**
 * Re-date the snapshot's dangling check-in (26/10 12:58) — e.g. to Friday 16/10 12:58, a date
 * with no other punches in the snapshot, so the day is genuinely unclosed.
 */
function moveOpenInTo(y, m, d, hh, mm) {
  const row = G.readBlock_('ATTENDANCE').find(r =>
    String(r.values[COLS.ATTENDANCE.EVENT]) === 'in' &&
    G.Utilities.formatDate(r.values[COLS.ATTENDANCE.TS], TZ, 'yyyy-MM-dd') === '2026-10-26');
  if (!row) throw new Error('no dangling in on 26/10 to move');
  vm.runInContext(`GRID.DATA[${row.row - 1}][0] = new Date(${y}, ${m - 1}, ${d}, ${hh}, ${mm})`, sandbox);
}
const outsOn = date => G.readBlock_('ATTENDANCE').filter(r =>
  String(r.values[COLS.ATTENDANCE.EVENT]) === 'out' &&
  G.Utilities.formatDate(r.values[COLS.ATTENDANCE.TS], TZ, 'yyyy-MM-dd') === date);
/** Append a punch row to the ledger (inside the sandbox, so the Date is the fake one). */
function addPunch(y, m, d, hh, mm, event, id) {
  vm.runInContext(`(function () {
    var r = GRID.DATA.length;
    GRID.DATA.push([]);
    GRID.DATA[r][0] = new Date(${y}, ${m - 1}, ${d}, ${hh}, ${mm});
    GRID.DATA[r][1] = '${id || 'A0124'}';
    GRID.DATA[r][2] = '${event}';
    GRID.DATA[r][3] = 'line';
    GRID.DATA[r][4] = '';
  })()`, sandbox);
}

seed();
t('a day forgotten only yesterday is left for a human (grace window)', () => {
  const healed = G.autoCloseStaleDays_(G.getConfig_());   // default AUTO_CLOSE_DAYS=3
  eq(healed.closed.length, 0, 'closed');
  ok(G.staleOpenIn_('A0124', TZ) !== null, 'still open for the employee/HR to confirm');
});
t('a Friday forgotten check-out survives the weekend, then heals on Monday 05:00', () => {
  seed();
  moveOpenInTo(2026, 10, 16, 12, 58);                   // Friday 16/10, never closed

  setNow('2026-10-17T05:00:00+07:00');                  // Saturday
  eq(G.autoCloseStaleDays_(G.getConfig_()).closed.length, 0, 'closed on Saturday');
  ok(G.staleOpenIn_('A0124', TZ) !== null, 'still open on Saturday');

  setNow('2026-10-18T05:00:00+07:00');                  // Sunday
  eq(G.autoCloseStaleDays_(G.getConfig_()).closed.length, 0, 'closed on Sunday');
  ok(G.staleOpenIn_('A0124', TZ) !== null, 'still open on Sunday');

  setNow('2026-10-19T05:00:00+07:00');                  // Monday: 3 days old → close
  const before = G.readBlock_('ATTENDANCE').length;
  const healed = G.autoCloseStaleDays_(G.getConfig_());
  eq(healed.closed.length, 1, 'closed on Monday');
  eq(healed.closed[0].date, '2026-10-16', 'closed day');
  eq(healed.closed[0].outTime, '18:00', 'closed at the declared shift end');
  eq(healed.closed[0].worked, 302, 'minutes credited (12:58 → 18:00)');

  const rows = G.readBlock_('ATTENDANCE');
  eq(rows.length, before + 1, 'rows appended');
  const added = rows[rows.length - 1].values;
  eq(G.Utilities.formatDate(added[COLS.ATTENDANCE.TS], TZ, 'yyyy-MM-dd HH:mm'),
     '2026-10-16 18:00', 'the row is dated to its own day');
  eq(String(added[COLS.ATTENDANCE.EVENT]), 'out', 'event');
  eq(String(added[COLS.ATTENDANCE.SOURCE]), 'auto_close', 'source is visibly not a punch');
  eq(String(added[COLS.ATTENDANCE.NOTE]), 'auto_close 2026-10-16 18:00 scheduled_end', 'note');
  eq(G.staleOpenIn_('A0124', TZ), null, 'stale check-in warning cleared');
  const logRows = G.readBlock_('LOG').filter(r => String(r.values[COLS.LOG.ACTION]) === 'auto_close');
  eq(logRows.length, 1, 'LOG row');
  eq(String(logRows[0].values[COLS.LOG.STATUS]), 'out 2026-10-16 18:00', 'LOG status');
});
t('the sweep is idempotent — a re-run writes nothing', () => {
  const before = G.readBlock_('ATTENDANCE').length;
  eq(G.autoCloseStaleDays_(G.getConfig_()).closed.length, 0, 'second run closed');
  eq(G.readBlock_('ATTENDANCE').length, before, 'rows appended by the second run');
});
t('a normal Monday does not swallow a forgotten Friday (the pairing window)', () => {
  seed();
  moveOpenInTo(2026, 10, 15, 12, 58);                   // Thursday 15/10, never closed
  addPunch(2026, 10, 19, 9, 0, 'in');                   // Monday: a normal, complete day
  addPunch(2026, 10, 19, 18, 5, 'out');
  setNow('2026-10-20T05:00:00+07:00');

  const open = G.openDaysByEmployee_(TZ);
  eq((open.A0124 || []).map(p => G.Utilities.formatDate(p.ts, TZ, 'yyyy-MM-dd')), ['2026-10-15'],
     'dangling days (Monday must not close Thursday)');
  eq(G.autoCloseStaleDays_(G.getConfig_()).closed.length, 1, 'healed the older day');
});
t('an overnight shift still pairs (in 22:00, out 02:00 next day)', () => {
  seed();
  addPunch(2026, 10, 15, 22, 0, 'in');
  addPunch(2026, 10, 16, 2, 0, 'out');
  eq(Object.keys(G.openDaysByEmployee_(TZ)).length, 1, 'open employees (only the 26/10 day)');
  eq(G.openDaysByEmployee_(TZ).A0124.length, 1, 'the overnight shift is paired, not dangling');
});
t('the 05:00 run heals first, then reports it once under its own heading', () => {
  seed();
  moveOpenInTo(2026, 10, 16, 12, 58);
  setNow('2026-10-19T05:00:00+07:00');
  setCfg('EMAIL_ENABLED', 'TRUE');
  outbox.length = 0;
  G.forgotOutReport();
  eq(outbox.length, 1, 'emails sent');
  has(outbox[0].subject, '1 รายการ', 'subject count');
  has(outbox[0].subject, '19 ตุลาคม 2569', 'subject date');
  has(outbox[0].body, 'รายการที่ระบบปิดเวลาออกให้อัตโนมัติ (1 รายการ)', 'auto section');
  has(outbox[0].body, 'พนักงานทดสอบ (A0124) — เข้างานวันที่ 16 ตุลาคม 2569 เวลา 12:58 น. ' +
                      'ระบบปิดเวลาออกให้ที่เวลา 18:00 น.', 'auto line');
  ok(outbox[0].body.indexOf('รายการที่ยังไม่ลงเวลาเลิกงาน') === -1,
     'a healed day is not also reported as still open');
  has(outbox[0].body, 'โปรดตรวจสอบกับพนักงานก่อนนำไปใช้คำนวณค่าจ้าง', 'HR is told to confirm');
  const logRows = G.readBlock_('LOG').filter(r => String(r.values[COLS.LOG.ACTION]) === 'report:forgot_out');
  eq(String(logRows[logRows.length - 1].values[COLS.LOG.STATUS]),
     '0 open, 1 auto-closed, 0 self-reported', 'run status');
});
t('healing is not gated by EMAIL_ENABLED (data hygiene, not a notification)', () => {
  seed();
  moveOpenInTo(2026, 10, 16, 12, 58);
  setNow('2026-10-19T05:00:00+07:00');
  setCfg('EMAIL_ENABLED', 'FALSE');
  outbox.length = 0;
  G.forgotOutReport();
  eq(outbox.length, 0, 'emails sent while OFF');
  eq(G.staleOpenIn_('A0124', TZ), null, 'day closed anyway');
});
t('a real time REPLACES the placeholder row — never a second out', () => {
  const before = G.readBlock_('ATTENDANCE').length;
  const res = G.hrFixDay('A0124', '2026-10-16', '17:20');
  has(res, 'ปิดวัน 2026-10-16', 'result');
  has(res, '4 ชม. 22 นาที', 'hours use the real time');

  const outs = outsOn('2026-10-16');
  eq(outs.length, 1, 'out rows for that day');
  eq(String(outs[0].values[COLS.ATTENDANCE.SOURCE]), 'hr_fix', 'source after the fix');
  eq(G.Utilities.formatDate(outs[0].values[COLS.ATTENDANCE.TS], TZ, 'yyyy-MM-dd HH:mm'),
     '2026-10-16 17:20', 'ts after the fix');
  has(String(outs[0].values[COLS.ATTENDANCE.NOTE]), 'replaced auto_close', 'note records the replacement');
  eq(G.readBlock_('ATTENDANCE').length, before, 'no row was appended');
  eq(G.readBlock_('ATTENDANCE').filter(r =>
       String(r.values[COLS.ATTENDANCE.SOURCE]) === 'auto_close').length, 0, 'placeholders left');
});
t('after a replacement the day is closed for good (an identical "fix" changes nothing)', () => {
  // v2.5: the refusal now comes from the correction rule (nothing later to add), not from
  // "no open day" — either way a second identical fix writes nothing.
  const rows = G.readBlock_('ATTENDANCE').length;
  // the same time the replacement wrote: nothing later to add, so nothing happens
  has(G.hrFixDay('A0124', '2026-10-16', '17:20'),
      'บันทึกเวลาเลิกงานของวันนั้นไว้ที่ 17:20', 'identical fix refused');
  eq(G.readBlock_('ATTENDANCE').length, rows, 'no row written');
});
t("the employee's own report also replaces a placeholder, and writes no geo row", () => {
  seed();
  attach();
  moveOpenInTo(2026, 10, 16, 12, 58);
  setNow('2026-10-19T05:00:00+07:00');
  eq(G.autoCloseStaleDays_(G.getConfig_()).closed.length, 1, 'auto-closed first');
  const geoBefore = G.readBlock_('GEO').length;
  const before = G.readBlock_('ATTENDANCE').length;

  const res = G.handleLiffPunch_({ idToken: 'tok', action: 'fix', date: '2026-10-16', hhmm: '19:05' });
  ok(res.ok, 'ok flag: ' + JSON.stringify(res));
  has(res.text, 'เป็นการแจ้งเอง', 'employee is told it was self-reported');
  eq(outsOn('2026-10-16').length, 1, 'out rows for that day');
  eq(String(outsOn('2026-10-16')[0].values[COLS.ATTENDANCE.SOURCE]), 'self_report', 'source');
  eq(G.readBlock_('ATTENDANCE').length, before, 'no row appended');
  eq(G.readBlock_('GEO').length, geoBefore, 'geo rows written');
});
t('an auto-closed day is still offered to the employee, labelled as auto-closed', () => {
  seed();
  attach();
  moveOpenInTo(2026, 10, 16, 12, 58);
  setNow('2026-10-19T05:00:00+07:00');
  eq(G.autoCloseStaleDays_(G.getConfig_()).closed.length, 1, 'auto-closed');

  const list = G.fixList_(EMP(), G.getConfig_());
  eq(list.days.length, 1, 'days offered');
  eq(list.days[0].date, '2026-10-16', 'date');
  has(list.days[0].label, 'ปิดอัตโนมัติ 18:00', 'label says it was closed for them');
  has(list.text, 'ระบบปิดเวลาออกให้อัตโนมัติ', 'text explains it');

  const res = G.handleLiffPunch_({ idToken: 'tok', action: 'fix', date: '2026-10-16', hhmm: '18:40' });
  ok(res.ok, 'ok: ' + JSON.stringify(res));
  eq(outsOn('2026-10-16').length, 1, 'one out row after the correction');
  eq(String(outsOn('2026-10-16')[0].values[COLS.ATTENDANCE.SOURCE]), 'self_report', 'source');
  eq(G.fixList_(EMP(), G.getConfig_()).days.length, 0, 'nothing left to correct');
});
t('a check-in after WORK_END is left open — no shift end to close it with', () => {
  seed();
  moveOpenInTo(2026, 10, 16, 19, 0);                     // arrived after 18:00
  setNow('2026-10-19T05:00:00+07:00');
  const healed = G.autoCloseStaleDays_(G.getConfig_());
  eq(healed.closed.length, 0, 'closed');
  eq(healed.skipped.length, 1, 'reported as skipped');
  ok(G.staleOpenIn_('A0124', TZ) !== null, 'still open for a human');
  setCfg('EMAIL_ENABLED', 'TRUE');
  outbox.length = 0;
  G.forgotOutReport();
  has(outbox[0].body, 'รายการที่ยังไม่ลงเวลาเลิกงาน (1 รายการ)', 'still-open section');
});
t('AUTO_CLOSE_DAYS=0 turns the sweep off completely', () => {
  seed();
  moveOpenInTo(2026, 10, 16, 12, 58);
  setNow('2026-10-19T05:00:00+07:00');
  eq(G.autoCloseStaleDays_(cfgWith({ AUTO_CLOSE_DAYS: '0' })).closed.length, 0, 'closed');
  ok(G.staleOpenIn_('A0124', TZ) !== null, 'still open');
});
t('an unparseable WORK_END closes nothing and logs an error', () => {
  seed();
  moveOpenInTo(2026, 10, 16, 12, 58);
  setNow('2026-10-19T05:00:00+07:00');
  const errsBefore = G.readBlock_('ERROR').length;
  eq(G.autoCloseStaleDays_(cfgWith({ WORK_END: 'sixish' })).closed.length, 0, 'closed');
  eq(G.readBlock_('ERROR').length, errsBefore + 1, 'error rows');
});
t('Thai date labels are Buddhist-era, not Gregorian or English', () => {
  const sandboxDate = vm.runInContext('new Date(2026, 0, 1, 12, 0)', sandbox);
  eq(G.thaiDateLabel_('2026-10-23', TZ), '23 ตุลาคม 2569', 'label');
  eq(G.thaiDateLabel_(sandboxDate, TZ), '1 มกราคม 2569', 'starts a new BE year');
  eq(G.thaiDateLabel_('not-a-date', TZ), 'not-a-date', 'unparseable is shown, never guessed');
});

// ── 6. nothing that worked before regressed ───────────────────────────────────
seed();
t('check-in still works and now reports the dangling day', () => {
  const res = G.punchIn_(EMP(), G.getConfig_(), null);
  has(res, 'เข้างาน 00:40', 'punch reply');
  has(res, 'ยังไม่ได้ลงเวลาเลิกงานของวันที่ 26/10', 'stale suffix');
  const rows = G.readBlock_('ATTENDANCE');
  const added = rows[rows.length - 1].values;
  eq(String(added[COLS.ATTENDANCE.EVENT]), 'in', 'event');
  has(String(added[COLS.ATTENDANCE.NOTE]), 'forgot_out 2026-10-26', 'note');
  const logRows = G.readBlock_('LOG').filter(r => String(r.values[COLS.LOG.ACTION]) === 'ck:in');
  has(String(logRows[logRows.length - 1].values[COLS.LOG.STATUS]), 'forgot_out', 'log status');
});
t('a second check-in today is still refused', () => {
  has(G.punchIn_(EMP(), G.getConfig_(), null), 'คุณเข้างานแล้วเมื่อ 00:40', 'dup reply');
});
t('check-out with no check-in today is still refused', () => {
  seed();
  has(G.punchOut_(EMP(), G.getConfig_(), null), 'ยังไม่พบการเข้างานของวันนี้', 'no-in reply');
});
t('"fix" typed in the chat is not understood — it can never become a punch', () => {
  seed();
  const res = G.actionOf_('fix');
  eq(res, null, 'actionOf_("fix")');
  eq(G.actionOf_('open'), null, 'actionOf_("open")');
});
t('LIFF still rejects an unknown action and keeps "today" read-only', () => {
  seed();
  eq(G.handleLiffPunch_({ idToken: 'tok', action: 'nonsense' }).error, 'bad_action', 'bad action');
  const today = G.handleLiffPunch_({ idToken: 'tok', action: 'me:today' });
  ok(today.ok && today.action === 'today', 'today panel');
});
t('installTriggers creates exactly dailyDigest + forgotOutReport, no duplicates', () => {
  triggers.length = 0;
  G.installTriggers();
  G.installTriggers();                                  // idempotent, as documented
  eq(triggers.map(t => t.getHandlerFunction()).sort(), ['dailyDigest', 'forgotOutReport'], 'triggers');
});
t('selfTest section [8] passes on this state', () => {
  seed();
  logs.length = 0;
  triggers.length = 0;
  G.installTriggers();
  G.selfTest();
  // Only section 8 is asserted here: sections 4/5 need the real LINE channel.
  const sec = logs.slice(Math.max(0, logs.findIndex(l => l.indexOf('[8]') !== -1)));
  ['open days', 'fix paths configured', 'auto-close (self-heal) policy', 'forgotOutReport trigger'].forEach(name => {
    ok(sec.some(l => l.indexOf('PASS  ' + name) !== -1),
       'PASS ' + name + ' → ' + sec.join(' | '));
  });
  console.log('        ' + sec.filter(l => l.trim()).join('\n        '));
});

// ══════════════════════════════ v2.4.0 ═══════════════════════════════════════════
console.log('\n=== v2.4.0 ===\n');
const lastReply = () => {
  const c = fetchCalls.filter(x => x.url.indexOf('/message/reply') !== -1).pop();
  return c ? JSON.parse(c.opts.payload).messages : null;
};
const LINE_UID = () => String(EMP().values[COLS.EMPLOYEES.LINE_USER_ID]);

t('appendToBlock_ grows DATA before writing past the last grid row (no out-of-bounds throw)', () => {
  seed();
  sandbox.MAXROWS.DATA = G.GRID.DATA.length;          // the sheet is exactly full
  const before = G.GRID.DATA.length;
  const row = G.appendToBlock_('LOG', ['', new Date(), 'A0124', 'probe', 'ok']);
  eq(sandbox.INSERTS.length, 1, 'inserts');
  eq(sandbox.INSERTS[0][2], 500, 'rows added');
  eq(row, before + 1, 'written just past the old end');
  eq(G.GRID.DATA[row - 1][G.BLOCKS.LOG.col + 3], 'probe', 'row landed in the LOG block');
});
t('appendToBlock_ inside the grid does not grow it', () => {
  seed();
  G.appendToBlock_('ATTENDANCE', [new Date(), 'A0124', 'in', 'line', '']);
  eq(sandbox.INSERTS.length, 0, 'inserts');
});
t('book_ opens the spreadsheet once per execution', () => {
  let opens = 0;
  const orig = sandbox.SpreadsheetApp.openById;
  sandbox.SpreadsheetApp.openById = id => { opens++; return orig(id); };
  sandbox.BOOK_ = null;
  G.getConfig_(); G.readBlock_('ATTENDANCE'); G.readBlock_('EMPLOYEES');
  sandbox.SpreadsheetApp.openById = orig;
  eq(opens, 1, 'openById calls');
});

function withVerify(response, fn) {
  const origFetch = sandbox.UrlFetchApp.fetch;
  sandbox.UrlFetchApp.fetch = (url, opts) => {
    fetchCalls.push({ url, opts });
    return { getResponseCode: () => response.code, getContentText: () => JSON.stringify(response.body) };
  };
  G.verifyLiffIdToken_ = REAL_VERIFY;
  try { return fn(); } finally { sandbox.UrlFetchApp.fetch = origFetch; }
}
const verifyCalls = () => fetchCalls.filter(c => c.url.indexOf('/oauth2/v2.1/verify') !== -1).length;

t('a verified ID token is cached by hash: the second call makes no LINE round-trip', () => {
  seed();
  const exp = Math.floor(sandbox.__NOW__ / 1000) + 3600;
  withVerify({ code: 200, body: { sub: 'U_cached', exp: exp } }, () => {
    const n0 = verifyCalls();
    eq(G.verifyLiffIdToken_('tokA'), 'U_cached', 'first');
    eq(G.verifyLiffIdToken_('tokA'), 'U_cached', 'second');
    eq(verifyCalls() - n0, 1, 'verify round-trips');
    const keys = Object.keys(sandbox.CACHE).filter(k => k.indexOf('idt:') === 0);
    eq(keys.length, 1, 'cache entries');
    ok(/^idt:[0-9a-f]{64}$/.test(keys[0]), 'key is a sha256 hex: ' + keys[0]);
    ok(keys[0].indexOf('tokA') === -1, 'token not stored');
    eq(sandbox.CACHE[keys[0]].ttl, 1800, 'ttl capped at 30 min');
    G.verifyLiffIdToken_('tokB');
    eq(verifyCalls() - n0, 2, 'a different token is verified separately');
  });
});
t('token cache: no exp / near-expiry / rejected tokens are never cached', () => {
  seed();
  withVerify({ code: 200, body: { sub: 'U_x' } }, () => { G.verifyLiffIdToken_('t1'); });
  withVerify({ code: 200, body: { sub: 'U_x', exp: Math.floor(sandbox.__NOW__ / 1000) + 30 } },
             () => { G.verifyLiffIdToken_('t2'); });
  withVerify({ code: 401, body: { error: 'invalid' } }, () => { eq(G.verifyLiffIdToken_('t3'), null, 'rejected'); });
  eq(Object.keys(sandbox.CACHE).filter(k => k.indexOf('idt:') === 0).length, 0, 'cache entries');
});
t('a cached token is still bound to its own user (no cross-token reuse)', () => {
  seed();
  const exp = Math.floor(sandbox.__NOW__ / 1000) + 3600;
  withVerify({ code: 200, body: { sub: 'U_one', exp } }, () => { G.verifyLiffIdToken_('tok1'); });
  withVerify({ code: 200, body: { sub: 'U_two', exp } }, () => {
    eq(G.verifyLiffIdToken_('tok2'), 'U_two', 'tok2');
    eq(G.verifyLiffIdToken_('tok1'), 'U_one', 'tok1 from cache');
  });
});

t('LIFF "today" carries name, structured state, open days and WORK_END in one response', () => {
  seed(); attach();
  const r = G.handleLiffPunch_({ idToken: 'tok', action: 'me:today' });
  ok(r.ok, 'ok');
  eq(r.name, String(EMP().values[COLS.EMPLOYEES.NAME]), 'name');
  eq(r.state.in, null, 'no check-in yet');
  eq(r.state.out, null, 'no check-out yet');
  eq(r.workEnd, G.getConfig_().WORK_END, 'workEnd');
  ok(r.days.some(d => d.date === '2026-10-26'), 'open day 26/10 listed: ' + JSON.stringify(r.days));
  has(r.text, 'วันนี้ยังไม่มีการเข้างาน', 'text unchanged');
});
t('LIFF state follows the day: in → in+elapsed text → out with worked minutes', () => {
  seed(); attach();
  setNow('2026-10-27T09:20:00+07:00');
  G.handleLiffPunch_({ idToken: 'tok', action: 'in', lat: 13.7135, lng: 100.421, acc: 8 });
  setNow('2026-10-27T12:05:00+07:00');
  let r = G.handleLiffPunch_({ idToken: 'tok', action: 'me:today' });
  eq(r.state.in, '09:20', 'in');
  eq(r.state.out, null, 'out');
  eq(r.state.lateMin, G.lateMinutes_(new Date(Date.parse('2026-10-27T09:20:00+07:00')), G.getConfig_()), 'late');
  has(r.text, 'ทำงานมาแล้ว 2 ชม. 45 นาที', 'elapsed in status');
  setNow('2026-10-27T18:30:00+07:00');
  G.handleLiffPunch_({ idToken: 'tok', action: 'out', lat: 13.7135, lng: 100.421, acc: 8 });
  r = G.handleLiffPunch_({ idToken: 'tok', action: 'me:today' });
  eq(r.state.out, '18:30', 'out');
  eq(r.state.workedMin, 9 * 60 + 10, 'worked');
  eq(r.state.earlyMin, 0, 'not early');
});

t('a chat punch while the page is required gets a one-button card, not a bare URL', () => {
  seed();
  const cfg = G.getConfig_();
  ok(G.requiresLiffPunch_(cfg), 'PUNCH_REQUIRE_GEO is on in the seed');
  const rowsBefore = G.readBlock_('ATTENDANCE').length;
  G.runAction_(LINE_UID(), 'in', 'rt1');
  const m = lastReply();
  eq(m.length, 1, 'one message');
  eq(m[0].type, 'template', 'type');
  eq(m[0].template.type, 'buttons', 'template type');
  eq(m[0].template.actions[0].type, 'uri', 'action');
  eq(m[0].template.actions[0].uri, 'https://liff.line.me/2012159701-NWz9NCHX', 'uri');
  ok(m[0].template.text.length <= 160, 'text within 160 chars');
  ok(m[0].template.actions[0].label.length <= 20, 'label within 20 chars');
  has(m[0].altText, 'https://liff.line.me/', 'altText keeps the link');
  ok(m[0].altText.length <= 400, 'altText within 400');
  eq(G.readBlock_('ATTENDANCE').length, rowsBefore, 'no punch written');
});
t('plain text replies are unchanged ([{type:text}])', () => {
  seed();
  G.runAction_(LINE_UID(), 'today', 'rt2');
  const m = lastReply();
  eq(m[0].type, 'text', 'type');
  has(m[0].text, 'วันนี้', 'status text');
});
t('typed text routing keeps its behaviour with the single roster read', () => {
  seed();
  G.onMessage_(LINE_UID(), { type: 'text', text: 'ลงทะเบียน' }, 'r1');
  eq(lastReply()[0].text, G.MSG.REG_TAKEN, 'registered user → already registered');
  G.onMessage_(LINE_UID(), { type: 'text', text: 'สวัสดี' }, 'r2');
  eq(lastReply()[0].text, G.MSG.NOT_UNDERSTOOD, 'registered user, random text');
  G.onMessage_('U_stranger', { type: 'text', text: 'สวัสดี' }, 'r3');
  eq(lastReply()[0].text, G.MSG.REG_NOT_LINKED, 'stranger, random text');
  G.onMessage_('U_stranger', { type: 'text', text: 'ลงทะเบียน' }, 'r4');
  eq(lastReply()[0].text, G.MSG.REG_ASK_ID, 'stranger → registration starts');
});

t('09:15 digest: formal Thai, Buddhist-era date, missing list', () => {
  seed();
  setCfg('EMAIL_ENABLED', 'TRUE'); setCfg('HR_EMAIL', 'hr@example.com');
  setNow('2026-10-27T09:15:00+07:00');                  // a Tuesday
  outbox.length = 0;
  G.dailyDigest();
  eq(outbox.length, 1, 'sent');
  has(outbox[0].subject, '[ระบบลงเวลาทำงาน] สรุปการเข้างาน 27 ตุลาคม 2569 — ยังไม่เข้างาน 1 คน', 'subject');
  has(outbox[0].body, 'เรียน ฝ่ายทรัพยากรบุคคล', 'greeting');
  has(outbox[0].body, 'เข้างานแล้ว 0 จาก 1 คน', 'count');
  has(outbox[0].body, '1. ' + String(EMP().values[COLS.EMPLOYEES.NAME]) + ' (A0124)', 'item');
  ok(!/Oct|2026/.test(outbox[0].subject + outbox[0].body), 'no English month / CE year');
});
t('09:15 digest: all-in subject plus the late list', () => {
  seed(); attach();
  setCfg('EMAIL_ENABLED', 'TRUE'); setCfg('HR_EMAIL', 'hr@example.com');
  setNow('2026-10-27T10:00:00+07:00');
  G.handleLiffPunch_({ idToken: 'tok', action: 'in', lat: 13.7135, lng: 100.421, acc: 8 });
  outbox.length = 0;
  G.dailyDigest();
  const late = G.lateMinutes_(new Date(Date.parse('2026-10-27T10:00:00+07:00')), G.getConfig_());
  has(outbox[0].subject, 'เข้างานครบทุกคน', 'subject');
  has(outbox[0].body, 'พนักงานทุกคนเข้างานแล้ว ✅', 'all in');
  has(outbox[0].body, 'เข้างานสาย (1 คน)', 'late head');
  has(outbox[0].body, 'เข้างาน 10:00 น. สาย ' + late + ' นาที', 'late item');
});
t('09:15 digest still reaches HR when WORK_START is unparseable (no late list)', () => {
  seed(); attach();
  setCfg('EMAIL_ENABLED', 'TRUE'); setCfg('HR_EMAIL', 'hr@example.com');
  setNow('2026-10-27T10:00:00+07:00');
  G.handleLiffPunch_({ idToken: 'tok', action: 'in', lat: 13.7135, lng: 100.421, acc: 8 });
  setCfg('WORK_START', 'nine');
  outbox.length = 0;
  G.dailyDigest();
  eq(outbox.length, 1, 'sent');
  ok(outbox[0].body.indexOf('เข้างานสาย') === -1, 'no late section');
});

// ══════════════════════════════ v2.4.1 ═══════════════════════════════════════════
console.log('\n=== v2.4.1 ===\n');
/** Mark the seeded employee a leaver (HR sets active=FALSE). */
function deactivate() {
  seed();
  const r = G.employeeById_('A0124');
  G.getTab_('EMPLOYEES_LOG').getRange(r.row, G.COLS.EMPLOYEES.ACTIVE + 1).setValue('FALSE');
  G.BOOK_ = null;
  return r;
}

t('a deactivated employee is told the account is closed, not "please register"', () => {
  deactivate();
  G.runAction_(LINE_UID(), 'in', 'r1');
  eq(lastReply()[0].text, G.MSG.ACCOUNT_INACTIVE, 'punch');
  G.runAction_(LINE_UID(), 'today', 'r2');
  eq(lastReply()[0].text, G.MSG.ACCOUNT_INACTIVE, 'status');
  G.onMessage_(LINE_UID(), { type: 'text', text: 'สวัสดี' }, 'r3');
  eq(lastReply()[0].text, G.MSG.ACCOUNT_INACTIVE, 'free text');
  G.onFollow_(LINE_UID(), 'r4');
  eq(lastReply()[0].text, G.MSG.ACCOUNT_INACTIVE, 'follow / re-add');
  G.onPostback_(LINE_UID(), 'ck:in', 'r5');
  eq(lastReply()[0].text, G.MSG.ACCOUNT_INACTIVE, 'stale postback');
});
t('registering a deactivated employee id says so, instead of "already bound"', () => {
  deactivate();
  G.onMessage_('U_newcomer', { type: 'text', text: 'ลงทะเบียน' }, 'r1');
  eq(lastReply()[0].text, G.MSG.REG_ASK_ID, 'asks for the id');
  G.onMessage_('U_newcomer', { type: 'text', text: 'A0124' }, 'r2');
  eq(lastReply()[0].text, G.MSG.ACCOUNT_INACTIVE, 'deactivated id');
  eq(G.regState_('U_newcomer'), null, 'registration state cleared');
});
t('a stranger is still told to register, and a live employee is unaffected', () => {
  seed();
  G.onMessage_('U_stranger', { type: 'text', text: 'สวัสดี' }, 'r1');
  eq(lastReply()[0].text, G.MSG.REG_NOT_LINKED, 'stranger');
  G.onMessage_(LINE_UID(), { type: 'text', text: 'สวัสดี' }, 'r2');
  eq(lastReply()[0].text, G.MSG.NOT_UNDERSTOOD, 'active employee unaffected');
});
t('LIFF reports a deactivated account as its own error code', () => {
  deactivate();
  attach();
  const r = G.handleLiffPunch_({ idToken: 'tok', action: 'me:today' });
  eq(r.error, 'inactive', 'error code');
  eq(r.text, G.MSG.ACCOUNT_INACTIVE, 'text');
  ok(!r.ok, 'not ok');
});
t('nothing is written to the ledger for a deactivated employee', () => {
  deactivate();
  attach();
  const before = G.readBlock_('ATTENDANCE').length;
  G.handleLiffPunch_({ idToken: 'tok', action: 'in', lat: 13.7135, lng: 100.421, acc: 8 });
  G.runAction_(LINE_UID(), 'in', 'r1');
  eq(G.readBlock_('ATTENDANCE').length, before, 'rows');
});

// ══════════════════════════════ v2.5.0 ═══════════════════════════════════════════
console.log('\n=== v2.5.0 corrections ===\n');

t('hrFixIn adds the check-in nobody made, and says the day still needs a check-out', () => {
  seed();                                            // 2026-10-20 has no punches at all
  const before = G.readBlock_('ATTENDANCE').length;
  const res = G.hrFixIn('A0124', '2026-10-20', '09:05');
  has(res, 'เพิ่มเวลาเข้างานของวันที่ 2026-10-20 เป็น 09:05', 'result');
  has(res, 'ยังไม่มีเวลาเลิกงาน', 'says the day is still open');
  eq(G.readBlock_('ATTENDANCE').length, before + 1, 'one row');
  const added = G.readBlock_('ATTENDANCE').pop().values;
  eq(String(added[COLS.ATTENDANCE.EVENT]), 'in', 'event');
  eq(String(added[COLS.ATTENDANCE.SOURCE]), 'hr_fix', 'source');
  eq(String(added[COLS.ATTENDANCE.NOTE]), 'forgot_in 2026-10-20 09:05 added by HR', 'note');
  // the day is now open, so the normal close path works on it
  ok(G.openDaysByEmployee_(TZ).A0124, 'the added check-in is an open day');
  has(G.hrFixDay('A0124', '2026-10-20', '18:10'), 'ปิดวัน 2026-10-20', 'closed afterwards');
  const stillOpen = (G.openDaysByEmployee_(TZ).A0124 || [])
    .filter(p => G.Utilities.formatDate(p.ts, TZ, 'yyyy-MM-dd') === '2026-10-20');
  eq(stillOpen.length, 0, 'the 20th is closed (other dangling days in the fixture are not ours)');
});
t('hrFixIn refuses a day that already has a check-in', () => {
  seed();
  const res = G.hrFixIn('A0124', '2026-10-26', '09:00');   // already checked in 12:58
  has(res, 'มีการเข้างานแล้วเมื่อ 12:58', 'message');
  eq(G.readBlock_('ATTENDANCE').filter(r =>
    String(r.values[COLS.ATTENDANCE.NOTE]).indexOf('forgot_in') === 0).length, 0, 'nothing written');
});
t('hrFixIn refuses a check-in after the recorded check-out', () => {
  seed();
  // a stray `out` with no `in` on that day: what the guard is for.
  // ⚠️ The Date must be built INSIDE the sandbox — a Date from Node's realm fails the
  //    code-under-test's `ts instanceof Date` and the row becomes invisible.
  G.appendToBlock_('ATTENDANCE',
    [vm.runInContext('new Date(2026, 9, 25, 17, 0, 0)', sandbox), 'A0124', 'out', 'line', '']);
  eq(String(G.dayOutPunch_('A0124', '2026-10-25', TZ) ? 'seen' : 'missed'), 'seen', 'row is readable');
  const res = G.hrFixIn('A0124', '2026-10-25', '18:00');
  has(res, 'ต้องก่อนเวลาเลิกงานของวันนั้น (17:00)', 'message');
});
t('hrFixIn refuses today and the future, like every other fix path', () => {
  seed();
  has(G.hrFixIn('A0124', '2026-10-27', '09:00'), 'เฉพาะวันก่อนหน้า', 'today');
  has(G.hrFixIn('A0124', '2026-11-02', '09:00'), 'เฉพาะวันก่อนหน้า', 'future');
});
t('hrFixDay says plainly when a day has no record at all', () => {
  seed();
  has(G.hrFixDay('A0124', '2026-10-20', '18:00'), 'ไม่พบการลงเวลาของวันนั้น', 'no record');
  has(G.hrFixDay('A0124', '2026-10-20', '18:00'), 'hrFixIn', 'points at the right command');
});
t('the employee cannot add a check-in from the LIFF page (a claim is not a punch)', () => {
  seed(); attach();
  // 'fix' only closes a day that already has an open check-in, so a day with none is refused
  const r = G.handleLiffPunch_({ idToken: 'tok', action: 'fix', date: '2026-10-20', hhmm: '18:00' });
  ok(!r.ok, 'refused');
  eq(r.error, 'not_open', 'reason');
  // and the punch actions have no date parameter at all — they always mean "now"
  const before = G.readBlock_('ATTENDANCE').length;
  G.handleLiffPunch_({ idToken: 'tok', action: 'in', date: '2026-10-20', hhmm: '09:00' });
  const added = G.readBlock_('ATTENDANCE').pop().values;
  eq(G.readBlock_('ATTENDANCE').length, before + 1, 'one punch');
  eq(G.Utilities.formatDate(added[COLS.ATTENDANCE.TS], TZ, 'yyyy-MM-dd'), '2026-10-27',
     'a past date in the payload is ignored — the punch is stamped now');
});
t('hrFixIn() is runnable from the Run button (properties, cleared on success)', () => {
  seed();
  sandbox.PROPS.FIX_EMP_ID = 'A0124';
  sandbox.PROPS.FIX_DATE = '2026-10-20';
  sandbox.PROPS.FIX_TIME = '08:45';
  has(G.hrFixIn(), 'เพิ่มเวลาเข้างานของวันที่ 2026-10-20', 'ran');
  eq(Object.keys(sandbox.PROPS).filter(k => k.indexOf('FIX_') === 0).length, 0, 'properties cleared');
  has(G.hrFixIn(), 'ยังไม่ได้ระบุคำขอ', 'a bare run with no request says what to set');
});

console.log('\n=== ' + pass + ' passed, ' + failures.length + ' failed ===');
if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1); }
