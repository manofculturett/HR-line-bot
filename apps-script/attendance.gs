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
 *                           matching row in DATA!Q:V; a plain tap stays 'line' and is
 *                           unverified. Both are legal — a punch must never be lost
 *                           because the phone refused to give a location.
 * @returns {string} the reply text.
 */
function punchIn_(employee, cfg, geo) {
  var empId = employee.values[COLS.EMPLOYEES.ID];
  var tz = cfg.TZ;
  var g = geo || null;

  var punches = todaysPunches_(empId, tz);
  var openIn = findLast_(punches, 'in');
  var lastOut = findLast_(punches, 'out');

  // Already checked in and not yet checked out → duplicate tap.
  if (openIn && (!lastOut || lastOut.ts < openIn.ts)) {
    return fill_(MSG.IN_DUP, { time: hhmm_(openIn.ts, tz) });
  }

  var now = new Date();
  var lateMin = lateMinutes_(now, cfg);

  // The note column carries both facts HR greps for: lateness and the geo verdict.
  var notes = [];
  if (lateMin > 0) notes.push('late ' + lateMin + 'm');
  if (geoNote_(g)) notes.push(geoNote_(g));

  withLock_(function () {
    appendToBlock_('ATTENDANCE', [now, empId, 'in', g ? 'liff-geo' : 'line', notes.join(' ')]);
    logEvent_('', empId, 'ck:in', lateMin > 0 ? 'late' : 'ok');
    appendGeoUnlocked_(now, empId, 'in', g);
  });

  var text = lateMin > 0
    ? fill_(MSG.IN_LATE, { time: hhmm_(now, tz), late: lateMin })
    : fill_(MSG.IN_OK,   { time: hhmm_(now, tz) });
  return decorateGeo_(text, g);
}

/** Handle `ck:out` / the LIFF check-out. Refuses when there is no open check-in. */
function punchOut_(employee, cfg, geo) {
  var empId = employee.values[COLS.EMPLOYEES.ID];
  var tz = cfg.TZ;
  var g = geo || null;

  var punches = todaysPunches_(empId, tz);
  var openIn = findLast_(punches, 'in');
  var lastOut = findLast_(punches, 'out');

  if (!openIn) return MSG.OUT_NOIN;

  // Already closed out for that check-in.
  if (lastOut && lastOut.ts > openIn.ts) {
    return fill_(MSG.OUT_DUP, { time: hhmm_(lastOut.ts, tz) });
  }

  var now = new Date();
  var worked = minutesBetween_(openIn.ts, now);

  withLock_(function () {
    appendToBlock_('ATTENDANCE', [now, empId, 'out', g ? 'liff-geo' : 'line', geoNote_(g)]);
    logEvent_('', empId, 'ck:out', 'ok');
    appendGeoUnlocked_(now, empId, 'out', g);
  });

  return decorateGeo_(fill_(MSG.OUT_OK, {
    time: hhmm_(now, tz),
    hours: Math.floor(worked / 60),
    mins: worked % 60
  }), g);
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

function minutesBetween_(from, to) {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 60000));
}

function hhmm_(date, tz) {
  return Utilities.formatDate(date, tz || 'Asia/Bangkok', 'HH:mm');
}
