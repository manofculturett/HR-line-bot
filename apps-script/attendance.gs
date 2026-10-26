/**
 * attendance.gs — punch logic and classification.
 *
 * Deterministic and synchronous: no model call, no trigger. An employee is standing
 * there waiting, and the reply token lives 1 minute.
 *
 * The decision rules live here (not in the sheet, not in a prompt) so they are testable
 * and one place to change.
 */

/**
 * Handle `ck:in` / the LIFF check-in.
 *
 * @param {Object} employee  the roster row
 * @param {Object} cfg       the CONFIG block
 * @param {Object=} geo      geoCheck_() result, or undefined for a plain menu tap.
 *                           A geo punch is recorded with source 'liff-geo' and gets a
 *                           matching row in DATA!S:Z; a plain tap stays 'line' and is
 *                           unverified. Both are legal — a punch must never be lost
 *                           because the phone refused to give a location.
 * @returns {string} the reply text.
 */
function punchIn_(employee, cfg, geo) {
  var empId = employee.values[COLS.EMPLOYEES.ID];
  var tz = cfg.TZ;
  var g = geo || null;

  var punches = todaysPunches_(empId, tz);

  // ONE check-in per day — not "one *open* check-in". Allowing in → out → in lets someone
  // leave and re-appear later the same day, and the dashboard reads the FIRST in and the
  // LAST out, so a second pair silently extends the recorded shift.
  var anyIn = findLast_(punches, 'in');
  if (anyIn) return fill_(MSG.IN_DUP, { time: hhmm_(anyIn.ts, tz) });

  var now = new Date();
  var lateMin = lateMinutes_(now, cfg);

  // A forgotten check-out on an earlier day must not be silent. The day is already
  // unclosed; tell the employee now so they can raise it, and mark it so HR sees it
  // (HR_MAIN!B3 lists anyone with an unclosed day before today).
  var stale = staleOpenIn_(empId, tz);

  // The note column carries everything HR greps for: lateness, the geo verdict, and a
  // dangling day.
  var notes = [];
  if (lateMin > 0) notes.push('late ' + lateMin + 'm');
  if (geoNote_(g)) notes.push(geoNote_(g));
  if (stale) notes.push('forgot_out ' + Utilities.formatDate(stale.ts, tz, 'yyyy-MM-dd'));

  withLock_(function () {
    appendToBlock_('ATTENDANCE', [now, empId, 'in', g ? 'liff-geo' : 'line', notes.join(' ')]);
    logEvent_('', empId, 'ck:in', (lateMin > 0 ? 'late' : 'ok') + (stale ? ' forgot_out' : ''));
    appendGeoUnlocked_(now, empId, 'in', g);
  });

  var text = lateMin > 0
    ? fill_(MSG.IN_LATE, { time: hhmm_(now, tz), late: lateMin })
    : fill_(MSG.IN_OK,   { time: hhmm_(now, tz) });
  if (stale) text += fill_(MSG.STALE_OUT_SUFFIX, { date: Utilities.formatDate(stale.ts, tz, 'dd/MM') });
  return decorateGeo_(text, g);
}

/** Handle `ck:out` / the LIFF check-out. Refuses when there is no open check-in. */
function punchOut_(employee, cfg, geo) {
  var empId = employee.values[COLS.EMPLOYEES.ID];
  var tz = cfg.TZ;
  var g = geo || null;

  var punches = todaysPunches_(empId, tz);
  var openIn = findLast_(punches, 'in');
  var anyOut = findLast_(punches, 'out');

  if (!openIn) return MSG.OUT_NOIN;

  // ONE check-out per day. If an `out` already exists today the pair is complete — even
  // when a stray `in` sits after it (one-in-per-day no longer permits that, but historical
  // rows exist and refusing keeps the day's record as the honest first-in/last-out).
  if (anyOut) return fill_(MSG.OUT_DUP, { time: hhmm_(anyOut.ts, tz) });

  var now = new Date();
  var worked = minutesBetween_(openIn.ts, now);
  var earlyMin = earlyMinutes_(now, cfg);

  // Same shape as the 'in' note: say why the day is short. 'early 119m' is greppable and
  // symmetric with 'late 180m'.
  var notes = [];
  if (earlyMin > 0) notes.push('early ' + earlyMin + 'm');
  if (geoNote_(g)) notes.push(geoNote_(g));

  withLock_(function () {
    appendToBlock_('ATTENDANCE', [now, empId, 'out', g ? 'liff-geo' : 'line', notes.join(' ')]);
    logEvent_('', empId, 'ck:out', earlyMin > 0 ? 'early' : 'ok');
    appendGeoUnlocked_(now, empId, 'out', g);
  });

  var text = fill_(MSG.OUT_OK, {
    time: hhmm_(now, tz),
    hours: Math.floor(worked / 60),
    mins: worked % 60
  });
  // Leaving early is allowed — nothing here refuses it. It is recorded, shown to HR, and
  // told to the employee, so the flag can never be a surprise at review time.
  if (earlyMin > 0) text += fill_(MSG.OUT_EARLY_SUFFIX, { early: earlyMin, end: cfg.WORK_END });
  return decorateGeo_(text, g);
}

/** Handle `me:today` — read-only. */
function todayStatus_(employee, cfg) {
  var empId = employee.values[COLS.EMPLOYEES.ID];
  var tz = cfg.TZ;
  var punches = todaysPunches_(empId, tz);
  var openIn = findLast_(punches, 'in');
  var lastOut = findLast_(punches, 'out');
  var punchIns = punches.filter(function (p) { return p.event === 'in'; });

  if (!punchIns.length) return MSG.TODAY_NONE;

  var firstIn = punchIns[0];
  var lateMin = lateMinutes_(firstIn.ts, cfg);
  var status = lateMin > 0 ? fill_(MSG.STATUS_LATE, { late: lateMin }) : MSG.STATUS_ON_TIME;

  if (openIn && (!lastOut || lastOut.ts < openIn.ts)) {
    return fill_(MSG.TODAY_IN, { in: hhmm_(firstIn.ts, tz), status: status });
  }

  var worked = minutesBetween_(openIn.ts, lastOut.ts);
  return fill_(MSG.TODAY_DONE, {
    in: hhmm_(firstIn.ts, tz),
    out: hhmm_(lastOut.ts, tz),
    hours: Math.floor(worked / 60),
    mins: worked % 60
  });
}

/* ---- helpers ---- */

/** Latest punch with the given event name, or null. */
function findLast_(punches, event) {
  for (var i = punches.length - 1; i >= 0; i--) {
    if (punches[i].event === event) return punches[i];
  }
  return null;
}

/**
 * Every check-in from BEFORE today that was never closed, keyed by employee id.
 *
 * This is the case the same-day checks cannot see: `todaysPunches_` only looks at today, so
 * a forgotten check-out would otherwise vanish — the employee checks in again next morning
 * and the old day stays open forever, with no hours and no record of why.
 *
 * ⚠️ This is the ONE definition of "dangling day" in the codebase. The check-in warning
 * (`staleOpenIn_`), the 05:00 HR report and both fix paths all read it here, so they can
 * never disagree about who is stuck open. Do not add a second scan somewhere else.
 *
 * ⚠️ One block read for the whole roster (as `todaysPunches_` already does), so a check-in
 * costs two block reads. Fine at a few thousand rows; past that, cache the open state per
 * employee rather than rescanning on every punch.
 *
 * @returns {Object} map of employee id -> array of unclosed `in` punches, oldest first.
 */
function openDaysByEmployee_(tz) {
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var rows = readBlock_('ATTENDANCE');
  var byEmp = {};

  for (var i = 0; i < rows.length; i++) {
    var v = rows[i].values;
    var ts = v[COLS.ATTENDANCE.TS];
    if (!(ts instanceof Date)) continue;
    // 'yyyy-MM-dd' compares correctly as a plain string — cheaper than date maths.
    if (Utilities.formatDate(ts, tz, 'yyyy-MM-dd') >= today) continue;
    var id = String(v[COLS.ATTENDANCE.EMPLOYEE_ID]).trim();
    if (!id) continue;
    if (!byEmp[id]) byEmp[id] = [];
    byEmp[id].push({ ts: ts, event: String(v[COLS.ATTENDANCE.EVENT]).trim() });
  }

  var out = {};
  for (var empId in byEmp) {
    if (!byEmp.hasOwnProperty(empId)) continue;
    var seq = byEmp[empId].sort(function (a, b) { return a.ts - b.ts; });

    // Walk it: an `in` opens a day, a real `out` closes every open one before it. Whatever
    // is still open at the end is dangling. (Counting ins vs outs instead would flag a
    // legacy day that had two pairs — true, but not something anyone can act on today.)
    var open = [];
    for (var j = 0; j < seq.length; j++) {
      if (seq[j].event === 'in') open.push(seq[j]);
      else if (seq[j].event === 'out') open = [];
    }
    if (open.length) out[empId] = open;
  }
  return out;
}

/**
 * The most recent check-in from BEFORE today that was never closed, or null.
 *
 * The check-in warning only ever talks about one day: the newest dangling one. The 05:00
 * report lists all of them.
 */
function staleOpenIn_(empId, tz) {
  var open = openDaysByEmployee_(tz)[String(empId).trim()];
  return (open && open.length) ? open[open.length - 1] : null;
}

/** Minutes late relative to WORK_START + LATE_GRACE_MIN. Negative → early. */
function lateMinutes_(when, cfg) {
  var tz = cfg.TZ;
  var start = parseHhMm_(cfg.WORK_START);
  if (start === null) throw new Error('Config WORK_START is not HH:MM: ' + cfg.WORK_START);

  var hhmm = Utilities.formatDate(when, tz, 'HH:mm').split(':');
  var now = parseInt(hhmm[0], 10) * 60 + parseInt(hhmm[1], 10);
  var late = now - (start + lateGraceMin_(cfg));
  return late > 0 ? late : 0;
}

/**
 * Minutes short of WORK_END, past EARLY_GRACE_MIN. 0 → not early (or no flag).
 *
 * Deliberately softer than lateMinutes_: a missing or unparseable WORK_END returns 0 and
 * never throws. Lateness is a business rule and may fail loudly; "left early" is advisory,
 * and it must never be able to block a check-out.
 */
function earlyMinutes_(when, cfg) {
  var end = parseHhMm_(cfg.WORK_END);
  if (end === null) return 0;
  var hhmm = Utilities.formatDate(when, cfg.TZ, 'HH:mm').split(':');
  var now = parseInt(hhmm[0], 10) * 60 + parseInt(hhmm[1], 10);

  // The grace decides WHETHER to flag, never how many minutes to report: the number shown
  // must be the real gap to WORK_END, so the ledger note, the employee's message and the
  // HR_MAIN "ออกก่อน" column all say the same thing (18:00 − 16:01 = 119, not 114).
  var early = end - now;
  return early > earlyGraceMin_(cfg) ? early : 0;
}

function minutesBetween_(from, to) {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 60000));
}

function hhmm_(date, tz) {
  return Utilities.formatDate(date, tz || 'Asia/Bangkok', 'HH:mm');
}
