/**
 * config.gs — the real spreadsheet layout, Script Properties, and the CONFIG block.
 *
 * Spreadsheet: "Customer"   id 1Ek-vacbfgWq11I2WhLvz6yc5WAD7IFojXRnnGVd0i-4
 *
 *   HR_MAIN        HR's screen — dashboard in A:F, CONFIG block in T:U
 *   EMPLOYEES_LOG  the roster, A:H
 *   DATA           three independent append-only blocks, side by side:
 *                    A:E  punch ledger  (ts, employee_id, event, source, note)
 *                    H:L  machine log   (event_id, ts, user_id, action, status)
 *                    N:P  errors        (ts, context, message)
 *
 * Secrets live in Script Properties (Project Settings), never in the sheet and never in
 * git. HR-facing settings live in HR_MAIN!T:U so HR can change them without a deploy.
 */

/** Tab names — one place, so a typo cannot silently create a new tab. */
var TABS = {
  HR_MAIN: 'HR_MAIN',
  EMPLOYEES_LOG: 'EMPLOYEES_LOG',
  DATA: 'DATA'
};

/**
 * Append-only blocks. `DATA` deliberately holds three of them side by side, so every
 * append targets a BLOCK, never "the bottom of the sheet" — see sheets.appendToBlock_.
 */
var BLOCKS = {
  ATTENDANCE: { tab: 'DATA',          col: 0,  width: 5 },
  LOG:        { tab: 'DATA',          col: 7,  width: 5 },
  ERROR:      { tab: 'DATA',          col: 13, width: 3 },
  EMPLOYEES:  { tab: 'EMPLOYEES_LOG', col: 0,  width: 8 }
};

/** Column indexes (0-based), relative to the start of each block. */
var COLS = {
  EMPLOYEES:  { ID: 0, NAME: 1, DEPT: 2, LINK_CODE: 3, LINE_USER_ID: 4, LINK_STATUS: 5, ACTIVE: 6, NOTE: 7 },
  ATTENDANCE: { TS: 0, EMPLOYEE_ID: 1, EVENT: 2, SOURCE: 3, NOTE: 4 },
  LOG:        { EVENT_ID: 0, TS: 1, USER_ID: 2, ACTION: 3, STATUS: 4 },
  ERROR:      { TS: 0, CONTEXT: 1, MESSAGE: 2 }
};

/**
 * Where things live on HR_MAIN. The script writes NOTHING here any more: the dashboard
 * (A:F) is formulas-only, and B2 (last activity) is a formula too. HR edits the CONFIG
 * block (T:U); everything else is derived.
 */
var HR_MAIN = {
  MISSING_LIST_CELL: 'B1',     // HR reads this (formula)
  LAST_ACTIVITY_CELL: 'B2',    // formula: latest punch time today (was a script heartbeat)
  FIRST_DATA_ROW: 5,           // header is row 4
  LAST_DATA_ROW: 204,          // provisioned by scripts/setup_dashboard.py (200 rows)
  CONFIG_RANGE: 'T4:U20'       // key/value pairs, scanned rather than fixed rows
};

/** Defaults for anything missing from the CONFIG block. */
var CONFIG_DEFAULTS = {
  TZ: 'Asia/Bangkok',
  WORK_START: '09:00',
  LATE_GRACE_MIN: '0',
  WORK_END: '18:00',
  WORK_DAYS: 'MON,TUE,WED,THU,FRI',
  HR_EMAIL: '',
  DIGEST_TIME: '09:15',
  EMAIL_ENABLED: 'TRUE'
};

/** A required secret, or a loud failure at startup rather than a silent 401 later. */
function secret_(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error('Missing Script Property: ' + key);
  return v;
}

function sheetId_() { return secret_('SHEET_ID'); }

/**
 * Read the CONFIG block once per execution; falls back to CONFIG_DEFAULTS.
 *
 * The block is scanned rather than read from fixed cells, so HR can add or reorder rows.
 * A cell Sheets has typed as a Time comes back as a Date, so those are normalised to
 * "HH:MM" here — otherwise WORK_START would be silently unparseable.
 */
function getConfig_() {
  var cfg = {};
  for (var k in CONFIG_DEFAULTS) {
    if (CONFIG_DEFAULTS.hasOwnProperty(k)) cfg[k] = CONFIG_DEFAULTS[k];
  }

  var values = getTab_(TABS.HR_MAIN).getRange(HR_MAIN.CONFIG_RANGE).getValues();
  for (var i = 0; i < values.length; i++) {
    var key = String(values[i][0] == null ? '' : values[i][0]).trim();
    if (!key || key === 'key') continue;             // header row
    cfg[key] = (values[i][1] instanceof Date) ? dateToHhMm_(values[i][1])
                                             : String(values[i][1] == null ? '' : values[i][1]).trim();
  }
  return cfg;
}

/** A Date cell (Sheets parsed "09:00" as a time) → "09:00". */
function dateToHhMm_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'HH:mm');
}

/** A config value that must look like HH:MM, whatever the cell type turned out to be. */
function cfgTime_(v, fallback) {
  if (v instanceof Date) return dateToHhMm_(v);
  var s = String(v == null ? '' : v).trim();
  return s || fallback;
}

/** Truthy config value: TRUE / YES / 1 / Y / ON (case-insensitive). Anything else is off. */
function cfgBool_(v) {
  var s = String(v == null ? '' : v).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === '1' || s === 'y' || s === 'on';
}

/**
 * True if today is one of the WORK_DAYS codes, e.g. WORK_DAYS = "MON,TUE,WED,THU,FRI".
 * Used to silence the digest on non-working days.
 *
 * getDay() reads the SCRIPT timezone (set in appsscript.json), which the deploy contract
 * requires to match cfg.TZ (Asia/Bangkok) — see ../README.md. If those two ever
 * diverge, this returns the wrong day near midnight.
 */
function isWorkday_(cfg) {
  var DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  var today = DOW[new Date().getDay()];
  var days = String(cfg.WORK_DAYS || '').toUpperCase().split(',');
  for (var i = 0; i < days.length; i++) {
    if (days[i].trim() === today) return true;
  }
  return false;
}

/** Minutes past WORK_START that still counts as on time. */
function lateGraceMin_(cfg) {
  var n = parseInt(cfg.LATE_GRACE_MIN, 10);
  return isNaN(n) ? 0 : n;
}

/**
 * Parse "09:00" into minutes-from-midnight. Returns null if unparseable so callers can
 * decide rather than silently treating it as 00:00.
 */
function parseHhMm_(s) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}
