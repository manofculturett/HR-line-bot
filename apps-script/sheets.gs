/**
 * sheets.gs — the only file that touches the spreadsheet.
 *
 * Every read-modify-write goes through withLock_(), so concurrent punches cannot
 * interleave. Attendance is append-only: corrections are new rows.
 *
 * ⚠️ DATA holds four blocks side by side (A:E punches, H:L log, O:Q errors, S:Z geo), so a row
 * is "taken" only if that BLOCK is occupied. Sheet.appendRow() would append at the
 * bottom of the whole sheet and scatter the blocks — always use appendToBlock_.
 *
 * Performance rule: batch reads with getValues() on a range, never per-cell getValue()
 * inside a loop.
 */

/**
 * The HR spreadsheet, opened once per execution. A punch touches the sheet through
 * getTab_ ten-plus times (config, roster, ledger reads, appends, log rows), and every bare
 * openById is a round-trip to Sheets — on the path where an employee is waiting.
 * Globals live for one execution only, so this can never serve a stale handle.
 */
var BOOK_ = null;
function book_() {
  if (!BOOK_) BOOK_ = SpreadsheetApp.openById(sheetId_());
  return BOOK_;
}

/** Rows added at a time when a block reaches the bottom of the grid. */
var GROW_ROWS = 500;

function getTab_(name) {
  var sh = book_().getSheetByName(name);
  if (!sh) throw new Error('Missing sheet tab: ' + name);
  return sh;
}

/** Run fn while holding the script lock. Always released. */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);                 // punches queue rather than fail
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function padRow_(row, n) {
  var out = row.slice(0, n);
  while (out.length < n) out.push('');
  return out;
}

/* ---- block access ---- */

/** Every data row of one block (header excluded), blank rows dropped. */
function readBlock_(blockKey) {
  var b = BLOCKS[blockKey];
  var sh = getTab_(b.tab);
  var last = sh.getLastRow();
  if (last < 2) return [];

  var values = sh.getRange(2, b.col + 1, last - 1, b.width).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    if (isBlankRow_(values[i])) continue;      // rows belonging to another block
    out.push({ row: i + 2, values: values[i] });
  }
  return out;
}

function isBlankRow_(cells) {
  for (var i = 0; i < cells.length; i++) {
    if (String(cells[i] == null ? '' : cells[i]).trim() !== '') return false;
  }
  return true;
}

/**
 * Append one row to the END of its own block — the first empty row within that block's
 * columns, which is not the same as the sheet's last row.
 */
function appendToBlock_(blockKey, row) {
  var b = BLOCKS[blockKey];
  var sh = getTab_(b.tab);
  var target = firstFreeRowInBlock_(sh, b);
  ensureRows_(sh, target);
  sh.getRange(target, b.col + 1, 1, b.width).setValues([padRow_(row, b.width)]);
  return target;
}

/**
 * Grow the grid before writing past its last row.
 *
 * ⚠️ getRange() THROWS for a row beyond the sheet's grid ("coordinates of the range are
 *    outside the dimensions of the sheet") — it does not extend the sheet the way typing
 *    into the UI does. DATA ships with 1000 rows and the LOG block gains ~4 rows per employee
 *    per day, so without this every punch starts failing within weeks of real use, and the
 *    error block (also in DATA) cannot record why.
 */
function ensureRows_(sh, row) {
  var max = sh.getMaxRows();
  if (row > max) sh.insertRowsAfter(max, Math.max(GROW_ROWS, row - max));
}

/**
 * Overwrite one existing row of a block.
 *
 * The punch ledger is append-only for anything a PERSON observed. The one exception is the
 * `auto_close` placeholder the sweep writes (see fixes.gs): a machine row that stands in for
 * a missing punch is REPLACED when a human supplies the real time — appending a second `out`
 * would leave two, and every time-based reader (the dashboard's `MAX(...)`) would keep
 * trusting the later placeholder over the earlier truth.
 */
function replaceBlockRow_(blockKey, sheetRow, row) {
  var b = BLOCKS[blockKey];
  getTab_(b.tab).getRange(sheetRow, b.col + 1, 1, b.width).setValues([padRow_(row, b.width)]);
}

function firstFreeRowInBlock_(sh, b) {
  var last = sh.getLastRow();
  if (last < 2) return 2;

  var values = sh.getRange(2, b.col + 1, last - 1, b.width).getValues();
  for (var i = 0; i < values.length; i++) {
    if (isBlankRow_(values[i])) return i + 2;
  }
  return last + 1;
}

/* ---- Employees (EMPLOYEES_LOG!A:H) ---- */

function employeeById_(employeeId) {
  var want = String(employeeId == null ? '' : employeeId).trim().toUpperCase();
  if (!want) return null;
  var rows = readBlock_('EMPLOYEES');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].values[COLS.EMPLOYEES.ID]).trim().toUpperCase() === want) return rows[i];
  }
  return null;
}

/** The employee bound to this LINE user id, or null. */
function employeeByLineId_(lineUserId) {
  var want = String(lineUserId == null ? '' : lineUserId).trim();
  if (!want) return null;
  var rows = readBlock_('EMPLOYEES');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].values[COLS.EMPLOYEES.LINE_USER_ID]).trim() === want) return rows[i];
  }
  return null;
}

function isActive_(employeeRowValues) {
  var v = String(employeeRowValues[COLS.EMPLOYEES.ACTIVE]).trim().toLowerCase();
  return v === 'true' || v === 'yes' || v === '1' || v === 'y';
}

function writeEmployeeCell_(sheetRow, colIndex, value) {
  withLock_(function () {
    getTab_(TABS.EMPLOYEES_LOG).getRange(sheetRow, colIndex + 1).setValue(value);
  });
}

/** Bind a LINE user id to an employee row and burn the one-time code. */
function linkEmployee_(sheetRow, lineUserId) {
  withLock_(function () {
    var sh = getTab_(TABS.EMPLOYEES_LOG);
    sh.getRange(sheetRow, COLS.EMPLOYEES.LINE_USER_ID + 1).setValue(lineUserId);
    sh.getRange(sheetRow, COLS.EMPLOYEES.LINK_CODE + 1).setValue('');    // single use
    sh.getRange(sheetRow, COLS.EMPLOYEES.LINK_STATUS + 1).setValue('linked');
  });
}

function setLinkStatus_(sheetRow, status) {
  writeEmployeeCell_(sheetRow, COLS.EMPLOYEES.LINK_STATUS, status);
}

/* ---- Attendance (DATA!A:E) ---- */

/** Today's punches for one employee, oldest first. */
function todaysPunches_(employeeId, tz) {
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var out = [];
  var rows = readBlock_('ATTENDANCE');
  for (var i = 0; i < rows.length; i++) {
    var v = rows[i].values;
    if (String(v[COLS.ATTENDANCE.EMPLOYEE_ID]).trim() !== String(employeeId).trim()) continue;
    var ts = v[COLS.ATTENDANCE.TS];
    if (!(ts instanceof Date)) continue;
    if (Utilities.formatDate(ts, tz, 'yyyy-MM-dd') !== today) continue;
    out.push({ ts: ts, event: String(v[COLS.ATTENDANCE.EVENT]).trim() });
  }
  out.sort(function (a, b) { return a.ts - b.ts; });
  return out;
}

/* ---- Log / Error (DATA!H:L and DATA!O:Q) ---- */

function logEvent_(eventId, userId, action, status) {
  try {
    appendToBlock_('LOG', [eventId || '', new Date(), userId || '', action, status]);
  } catch (e) {
    console.error('logEvent_ failed: ' + e);
  }
}

function logError_(context, err) {
  try {
    appendToBlock_('ERROR', [new Date(), context, String(err && err.stack || err)]);
  } catch (e) {
    console.error('logError_ failed: ' + e);
  }
}
