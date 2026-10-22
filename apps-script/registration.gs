/**
 * registration.gs — the link-code flow.
 *
 * Answers two different questions: *who do you claim to be* (employee id) and
 * *what proves you may claim it* (the one-time code HR handed out). The code decides;
 * no model is involved.
 *
 * State is kept in CacheService per LINE user id, so a half-finished registration
 * expires on its own and never leaks into the punch flow.
 */

var REG_TTL_SEC = 600;              // 10 minutes to finish typing two values
var REG_MAX_ATTEMPTS = 5;           // per user per hour
var REG_RATE_TTL_SEC = 3600;

/**
 * Registration state: { step: 'id' | 'code', employeeId: string } or null.
 */
function regState_(userId) {
  var raw = CacheService.getScriptCache().get('reg:' + userId);
  return raw ? JSON.parse(raw) : null;
}

function setRegState_(userId, state) {
  CacheService.getScriptCache().put('reg:' + userId, JSON.stringify(state), REG_TTL_SEC);
}

function clearRegState_(userId) {
  CacheService.getScriptCache().remove('reg:' + userId);
}

/** Begin registration (the ลงทะเบียน button, or a follow event). */
function startRegistration_(userId, replyToken) {
  setRegState_(userId, { step: 'id' });
  return reply_(replyToken, MSG.REG_ASK_ID);
}

/**
 * One registration turn. `text` is the employee's typed message.
 *
 * @returns {string} reply text.
 */
function registrationTurn_(userId, rawText, cfg) {
  var state = regState_(userId);
  if (!state) return MSG.REG_NOT_LINKED;

  // Two attempts to get a value right, then a reset — not a lockout.
  if (!state.attempts) state.attempts = 0;

  if (isRateLimited_(userId)) return MSG.REG_RATE_LIMIT;

  var text = String(rawText || '').trim();

  if (state.step === 'id') {
    var emp = employeeById_(text);
    if (!emp) {
      state.attempts++;
      setRegState_(userId, state);
      return MSG.REG_UNKNOWN;                       // identical text: no oracle
    }
    if (String(emp.values[COLS.EMPLOYEES.LINE_USER_ID]).trim()) {
      clearRegState_(userId);
      return MSG.REG_TAKEN;
    }
    if (!isActive_(emp.values)) {
      clearRegState_(userId);
      return MSG.REG_TAKEN;
    }
    setRegState_(userId, { step: 'code', employeeId: String(emp.values[COLS.EMPLOYEES.ID]) });
    return MSG.REG_ASK_CODE;
  }

  if (state.step === 'code') {
    var empRow = employeeById_(state.employeeId);
    if (!empRow) { clearRegState_(userId); return MSG.REG_UNKNOWN; }

    var expected = String(empRow.values[COLS.EMPLOYEES.LINK_CODE]).trim().toUpperCase();
    var given = text.toUpperCase();

    // One LINE account ↔ one employee: refuse a user id already bound elsewhere.
    if (employeeByLineId_(userId)) { clearRegState_(userId); return MSG.REG_TAKEN; }

    if (!expected || given !== expected) {
      state.attempts++;
      setRegState_(userId, state);
      bumpAttempts_(userId);
      return MSG.REG_UNKNOWN;                       // identical text: no oracle
    }

    linkEmployee_(empRow.row, userId);
    clearRegState_(userId);
    return fill_(MSG.REG_OK, {
      name: empRow.values[COLS.EMPLOYEES.NAME],
      dept: empRow.values[COLS.EMPLOYEES.DEPT]
    });
  }

  clearRegState_(userId);
  return MSG.NOT_UNDERSTOOD;
}

/* ---- abuse controls ---- */

function isRateLimited_(userId) {
  var n = parseInt(CacheService.getScriptCache().get('regn:' + userId) || '0', 10);
  return n >= REG_MAX_ATTEMPTS;
}

function bumpAttempts_(userId) {
  var cache = CacheService.getScriptCache();
  var n = parseInt(cache.get('regn:' + userId) || '0', 10) + 1;
  cache.put('regn:' + userId, String(n), REG_RATE_TTL_SEC);
}

/**
 * HR-only: generate a fresh link_code for one employee and clear the binding.
 * Run manually from the editor (HR clears the cell by hand as an alternative).
 */
function resetBinding(employeeId, newCode) {
  var emp = employeeById_(employeeId);
  if (!emp) throw new Error('No such employee: ' + employeeId);
  var sh = getTab_(TABS.EMPLOYEES_LOG);
  sh.getRange(emp.row, COLS.EMPLOYEES.LINE_USER_ID + 1).setValue('');
  sh.getRange(emp.row, COLS.EMPLOYEES.LINK_CODE + 1).setValue(newCode || newLinkCode_());
  sh.getRange(emp.row, COLS.EMPLOYEES.LINK_STATUS + 1).setValue('pending');
}

/** 6 chars, no confusable characters (no O/0, I/1/L). */
function newLinkCode_() {
  var alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var out = '';
  for (var i = 0; i < 6; i++) {
    out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return out;
}

/**
 * HR-only: give a fresh link_code to everyone still pending, so codes can be handed out
 * in bulk. Existing codes are left alone unless `overwrite` is true.
 *
 * Run from the editor. Prints what it did.
 */
function issueLinkCodes(overwrite) {
  var emp = readBlock_('EMPLOYEES');
  var issued = 0, kept = 0;
  var sh = getTab_(TABS.EMPLOYEES_LOG);
  emp.forEach(function (r) {
    var id = String(r.values[COLS.EMPLOYEES.ID]).trim();
    if (!id) return;
    var existing = String(r.values[COLS.EMPLOYEES.LINK_CODE]).trim();
    if (existing && !overwrite) { kept++; return; }
    sh.getRange(r.row, COLS.EMPLOYEES.LINK_CODE + 1).setValue(newLinkCode_());
    issued++;
  });
  console.log('issued/updated ' + issued + ' code(s), left ' + kept + ' untouched');
  return { issued: issued, kept: kept };
}

/**
 * HR-only: assign a rich menu to every already-linked employee.
 *
 * Needed only if you switch the OA's DEFAULT menu to the ลงทะเบียน menu — everyone who
 * registered before that change would otherwise keep seeing the register button.
 */
function attachMenuToAllLinked(menuKey) {
  var key = menuKey || 'RICHMENU_REGISTERED';
  if (!richMenuId_(key)) throw new Error(key + ' is not set in Script Properties');
  var emp = readBlock_('EMPLOYEES');
  var done = 0, skipped = 0;
  emp.forEach(function (r) {
    var uid = String(r.values[COLS.EMPLOYEES.LINE_USER_ID]).trim();
    if (!uid) { skipped++; return; }
    if (attachMenu_(uid, key)) done++;
    Utilities.sleep(120);                 // be gentle with the LINE API
  });
  console.log('attached ' + key + ' to ' + done + ' employee(s); ' + skipped + ' not linked');
  return { attached: done, skipped: skipped };
}
