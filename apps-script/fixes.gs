/**
 * fixes.gs — closing a day the bot never closed, without inventing a punch.
 *
 * A forgotten check-out leaves an `in` with no `out`: no hours, and an open day that
 * HR_MAIN!B3 keeps listing. Two parties can know the real leaving time, and nobody else:
 *
 *   HR            → hrFixDay()       from the editor     source 'hr_fix'
 *   the employee  → selfReportFix_() from the LIFF page  source 'self_report'
 *
 * Neither of them guesses. "This day was still open at 05:00" is a FACT and belongs in the
 * LOG block; an attendance row means a person was there at a time, so it is never written
 * from a detection. That is why this file exists instead of a 05:00 job that appends a
 * synthetic check-out: a wrong time in the ledger is worse than a missing one — a hole is
 * visibly missing, a plausible wrong number is not, and it is indistinguishable from a real
 * punch a month later.
 *
 * ⚠️ The closing row is dated to the day it belongs to — that is the whole point. The
 *    corollary is that a fix for TODAY must be refused: a row dated today is "today's
 *    check-out" to D5/E5/G5, so the dashboard would read "เลิกงาน 05:00" and raise a 13-hour
 *    early-leave flag for someone who has not checked in yet. Today is closed by pressing
 *    เลิกงาน, as always.
 */

/** The unclosed `in` on one specific date, or null. */
function openDayIn_(empId, dateStr, tz) {
  var days = openDaysByEmployee_(tz)[String(empId).trim()] || [];
  for (var i = days.length - 1; i >= 0; i--) {
    if (Utilities.formatDate(days[i].ts, tz, 'yyyy-MM-dd') === dateStr) return days[i];
  }
  return null;
}

/** 'yyyy-MM-dd' + 'HH:mm' in the script timezone → Date, or null when unparseable. */
function parseLocalDate_(dateStr, hhmm) {
  var d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr == null ? '' : dateStr).trim());
  var mins = parseHhMm_(hhmm);
  if (!d || mins === null) return null;

  // Built from components rather than parsed from a string: `new Date('2026-10-26T18:00')`
  // depends on how the runtime reads a bare date-time, while this always means the script
  // timezone — which the deploy contract fixes to Asia/Bangkok.
  var y = parseInt(d[1], 10), m = parseInt(d[2], 10), day = parseInt(d[3], 10);
  var out = new Date(y, m - 1, day, Math.floor(mins / 60), mins % 60, 0, 0);

  // A date that does not exist (2026-02-31) rolls over silently in Date; refuse it instead.
  if (out.getFullYear() !== y || out.getMonth() !== m - 1 || out.getDate() !== day) return null;
  return out;
}

/**
 * Close one open day. Shared by both fix paths so their rules cannot diverge.
 *
 * @param {Object} employee  the roster row
 * @param {string} dateStr   'yyyy-MM-dd' of the day being closed
 * @param {string} hhmm      'HH:mm' the person actually left
 * @param {string} source    'hr_fix' | 'self_report' — who is claiming the time
 * @param {Object} cfg
 * @returns {{ok:boolean, error?:string, text:string, worked?:number}}
 */
function closeOpenDay_(employee, dateStr, hhmm, source, cfg) {
  // A typo must not invent a source value in the ledger: every consumer greps on these.
  if (source !== 'hr_fix' && source !== 'self_report') {
    throw new Error('closeOpenDay_: unknown source ' + source);
  }

  var empId = employee.values[COLS.EMPLOYEES.ID];
  var tz = cfg.TZ;
  var cleanDate = String(dateStr == null ? '' : dateStr).trim();
  var cleanTime = String(hhmm == null ? '' : hhmm).trim();

  var when = parseLocalDate_(cleanDate, cleanTime);
  if (!when) return { ok: false, error: 'bad_input', text: MSG.FIX_BAD_INPUT };

  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  if (cleanDate >= today) return { ok: false, error: 'not_past', text: MSG.FIX_NOT_PAST };

  var openIn = openDayIn_(empId, cleanDate, tz);
  if (!openIn) return { ok: false, error: 'not_open', text: MSG.FIX_NOT_OPEN };
  if (when.getTime() <= openIn.ts.getTime()) {
    return { ok: false, error: 'before_in',
             text: fill_(MSG.FIX_BEFORE_IN, { time: hhmm_(openIn.ts, tz) }) };
  }

  var worked = minutesBetween_(openIn.ts, when);
  var note = 'forgot_out ' + cleanDate + ' ' +
             (source === 'hr_fix' ? 'closed by HR' : 'self-reported') + ' ' + cleanTime;

  // The open state is checked again inside the lock: a double tap on the page (the button
  // disables itself, but a retry can slip through) must not write two `out` rows for one day.
  var closed = false;
  withLock_(function () {
    if (!openDayIn_(empId, cleanDate, tz)) return;
    appendToBlock_('ATTENDANCE', [when, empId, 'out', source, note]);
    logEvent_('', empId, source, 'out ' + cleanDate + ' ' + cleanTime);
    closed = true;
  });
  if (!closed) return { ok: false, error: 'not_open', text: MSG.FIX_NOT_OPEN };

  var vars = { date: cleanDate, time: cleanTime,
               hours: Math.floor(worked / 60), mins: worked % 60 };
  return { ok: true, worked: worked,
           text: fill_(source === 'hr_fix' ? MSG.FIX_OK_HR : MSG.FIX_OK_SELF, vars) };
}

/* ---- HR ---- */

/**
 * HR: close a forgotten check-out. Run from the Apps Script editor (function dropdown):
 *
 *     hrFixDay('A0124', '2026-10-26', '19:30')
 *
 * Appends one `out` row (source `hr_fix`) dated to that day, so B3 stops listing the
 * employee and the check-in warning stops. Never edit or delete the original `in` — the
 * ledger is append-only, and the `in` is not the row that is wrong.
 *
 * @returns {string} a one-line result, also written to the Executions log.
 */
function hrFixDay(employeeId, dateStr, hhmm) {
  var out;
  try {
    var cfg = getConfig_();
    var employee = employeeById_(employeeId);
    if (!employee) {
      out = 'ไม่พบรหัสพนักงาน "' + employeeId + '" ใน EMPLOYEES_LOG คอลัมน์ A';
    } else {
      var r = closeOpenDay_(employee, dateStr, hhmm, 'hr_fix', cfg);
      out = r.ok
        ? 'ปิดวัน ' + dateStr + ' ให้ ' + employee.values[COLS.EMPLOYEES.NAME] +
          ' แล้ว: เลิกงาน ' + hhmm + ' (' + Math.floor(r.worked / 60) + ' ชม. ' +
          (r.worked % 60) + ' นาที)'
        : 'ไม่สำเร็จ: ' + r.text;
    }
  } catch (err) {
    logError_('hrFixDay', err);
    out = 'ผิดพลาด: ' + (err && err.message || err);
  }
  console.log(out);
  return out;
}

/* ---- the employee, from the LIFF page ---- */

/**
 * Read-only: what the LIFF page shows for "ลืมลงเวลาเลิกงาน?".
 *
 * Every open day is listed, even one outside the window or with self-report switched off —
 * hiding a day the system knows about is how a person concludes the system is broken. The
 * window is enforced by `selfReportFix_`; the list only says what the rules are.
 *
 * Returns `text` for the message and `days` for the date picker (the page needs structure,
 * not a sentence it would have to parse).
 */
function fixList_(employee, cfg) {
  var tz = cfg.TZ;
  var empId = employee.values[COLS.EMPLOYEES.ID];
  var open = openDaysByEmployee_(tz)[String(empId).trim()] || [];
  if (!open.length) return { text: MSG.FIX_LIST_NONE, days: [] };

  var days = [];
  var body = MSG.FIX_LIST_HEAD;
  for (var i = open.length - 1; i >= 0; i--) {         // newest first
    var label = Utilities.formatDate(open[i].ts, tz, 'dd/MM');
    body += fill_(MSG.FIX_LIST_LINE, { date: label, time: hhmm_(open[i].ts, tz) });
    days.push({ date: Utilities.formatDate(open[i].ts, tz, 'yyyy-MM-dd'),
                label: label, inHHmm: hhmm_(open[i].ts, tz) });
  }

  var windowDays = selfReportDays_(cfg);
  body += windowDays ? fill_(MSG.FIX_LIST_TAIL, { days: windowDays })
                     : '\n\n' + MSG.FIX_DISABLED;
  return { text: body, days: days };
}

/**
 * The LIFF page: the employee closes their own forgotten day.
 * Same rules as HR's path, one extra gate (the window), and a different `source` so the
 * sheet always says the time was claimed rather than observed.
 */
function selfReportFix_(employee, dateStr, hhmm, cfg) {
  var windowDays = selfReportDays_(cfg);
  if (!windowDays) return { ok: false, error: 'disabled', text: MSG.FIX_DISABLED };

  var cleanDate = String(dateStr == null ? '' : dateStr).trim();
  var oldest = Utilities.formatDate(new Date(Date.now() - windowDays * 86400000),
                                    cfg.TZ, 'yyyy-MM-dd');
  if (cleanDate && cleanDate < oldest) {
    return { ok: false, error: 'expired',
             text: fill_(MSG.FIX_EXPIRED, { days: windowDays }) };
  }

  return closeOpenDay_(employee, cleanDate, hhmm, 'self_report', cfg);
}
