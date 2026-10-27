/**
 * fixes.gs — closing a day the bot never closed, without inventing a punch.
 *
 * A forgotten check-out leaves an `in` with no `out`: no hours, and an open day that
 * HR_MAIN!B3 keeps listing. Three things can close it, and the ledger always says which:
 *
 *   HR            → hrFixDay()          from the editor     source 'hr_fix'
 *   the employee  → selfReportFix_()    from the LIFF page  source 'self_report'
 *   nobody at all → autoCloseStaleDays_ 05:00 sweep         source 'auto_close'
 *
 * The first two know the real time. The third does not — so it does not invent one either:
 * it writes WORK_END on that date, the shift end the company itself declared, and marks the
 * row `auto_close` so it can never be read as a punch. The point is that a day is never left
 * open forever (a Friday forgotten shift that nobody touches all weekend), while the number
 * stays distinguishable from an observation and is replaced the moment a person confirms it.
 *
 * ⚠️ The closing row is dated to the day it belongs to — that is the whole point. The
 *    corollary is that a fix for TODAY must be refused: a row dated today is "today's
 *    check-out" to D5/E5/G5, so the dashboard would read "เลิกงาน 05:00" and raise a 13-hour
 *    early-leave flag for someone who has not checked in yet. Today is closed by pressing
 *    เลิกงาน, as always.
 *
 * ⚠️ An `auto_close` row is a PLACEHOLDER, not history: a later real time REPLACES it in
 *    place (sheets.replaceBlockRow_). Appending instead would leave two `out` rows for one
 *    day, and the dashboard's `MAX(...)` would keep preferring the later placeholder over an
 *    earlier real time — the correction would be invisible.
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

/** The latest `in` on one specific date (closed or not), or null. */
function dayInPunch_(empId, dateStr, tz) {
  var best = null;
  readBlock_('ATTENDANCE').forEach(function (r) {
    var v = r.values;
    if (String(v[COLS.ATTENDANCE.EMPLOYEE_ID]).trim() !== String(empId).trim()) return;
    if (String(v[COLS.ATTENDANCE.EVENT]).trim() !== 'in') return;
    var ts = v[COLS.ATTENDANCE.TS];
    if (!(ts instanceof Date)) return;
    if (Utilities.formatDate(ts, tz, 'yyyy-MM-dd') !== dateStr) return;
    if (!best || ts.getTime() > best.getTime()) best = ts;
  });
  return best;
}

/**
 * The `auto_close` placeholder row for one day, or null. `row` is the sheet row, so a real
 * time can replace it in place instead of appending a second `out`.
 */
function autoCloseRow_(empId, dateStr, tz) {
  var rows = readBlock_('ATTENDANCE');
  for (var i = rows.length - 1; i >= 0; i--) {
    var v = rows[i].values;
    if (String(v[COLS.ATTENDANCE.EMPLOYEE_ID]).trim() !== String(empId).trim()) continue;
    if (String(v[COLS.ATTENDANCE.EVENT]).trim() !== 'out') continue;
    if (String(v[COLS.ATTENDANCE.SOURCE]).trim() !== 'auto_close') continue;
    var ts = v[COLS.ATTENDANCE.TS];
    if (!(ts instanceof Date)) continue;
    if (Utilities.formatDate(ts, tz, 'yyyy-MM-dd') !== dateStr) continue;
    return { row: rows[i].row, ts: ts };
  }
  return null;
}

/**
 * Close one open day at the declared shift end. The one writer of source 'auto_close'.
 *
 * Refuses (returns false, leaving the day open for a human) when the day was already closed
 * by anyone, or when the still-open check-in is at/after WORK_END — there is no defensible
 * shift end to use then, and a zero-length day would be a worse lie than an open one.
 */
function autoCloseOpenDay_(empId, dateStr, end, tz) {
  var written = false;
  withLock_(function () {
    var openIn = openDayIn_(empId, dateStr, tz);
    if (!openIn) return;                                  // a person closed it first
    if (openIn.ts.getTime() >= end.getTime()) return;      // checked in after the shift end
    if (autoCloseRow_(empId, dateStr, tz)) return;         // already healed by an earlier run

    var endHhMm = hhmm_(end, tz);
    appendToBlock_('ATTENDANCE', [end, empId, 'out', 'auto_close',
      'auto_close ' + dateStr + ' ' + endHhMm + ' scheduled_end']);
    logEvent_('', empId, 'auto_close', 'out ' + dateStr + ' ' + endHhMm);
    written = true;
  });
  return written;
}

/**
 * The self-heal: close every day that has been open for AUTO_CLOSE_DAYS, at WORK_END.
 *
 * Run by the 05:00 trigger before the report is built, and NOT gated by the email switches —
 * a stale day is a data problem whether or not HR wants mail about it.
 *
 * A Friday forgotten shift is 3 days old on Monday 05:00 and is closed then, before anyone
 * starts a new week; the weekend passing is exactly what used to leave it open forever.
 *
 * @returns {{closed:Array, skipped:Array}} what this run wrote, for the email and the log.
 */
function autoCloseStaleDays_(cfg) {
  var out = { closed: [], skipped: [] };
  var days = autoCloseDays_(cfg);
  if (!days) return out;

  var tz = cfg.TZ;
  if (parseHhMm_(cfg.WORK_END) === null) {
    // Fail loudly at the operator's screen, never by writing a time nobody declared.
    logError_('autoCloseStaleDays_', 'WORK_END is not HH:MM ("' + cfg.WORK_END + '") — nothing auto-closed');
    return out;
  }

  // String dates compare correctly ('yyyy-MM-dd'), and this is the same arithmetic the
  // self-report window uses: "N days ago" in the script timezone, not N*24h of clock drift.
  var cutoff = Utilities.formatDate(new Date(Date.now() - days * 86400000), tz, 'yyyy-MM-dd');

  // Active employees only, the same population the email reports on: writing a placeholder
  // check-out for someone who has left the company would put a fabricated row in a leaver's
  // history that nobody asked for. Their rows stay for hrFixDay.
  var names = {};
  readBlock_('EMPLOYEES').forEach(function (r) {
    if (!isActive_(r.values)) return;
    names[String(r.values[COLS.EMPLOYEES.ID]).trim()] = String(r.values[COLS.EMPLOYEES.NAME]);
  });

  // One day per (employee, date): a legacy day with two stray check-ins is still one day, and
  // its anchor is the LATEST one, so the placeholder can never precede the punch it closes.
  var targets = {};
  var open = openDaysByEmployee_(tz);
  Object.keys(open).forEach(function (id) {
    if (!names.hasOwnProperty(id)) return;      // not on the active roster → hrFixDay only
    open[id].forEach(function (p) {
      var dateStr = Utilities.formatDate(p.ts, tz, 'yyyy-MM-dd');
      if (dateStr > cutoff) return;             // still inside the confirmation window
      var key = id + '|' + dateStr;
      if (!targets[key] || targets[key].ts.getTime() < p.ts.getTime()) {
        targets[key] = { id: id, date: dateStr, ts: p.ts };
      }
    });
  });

  Object.keys(targets).forEach(function (key) {
    var t = targets[key];
    var end = parseLocalDate_(t.date, cfg.WORK_END);
    if (!end || end.getTime() <= t.ts.getTime()) {
      out.skipped.push({ id: t.id, name: names[t.id], date: t.date });
      return;
    }
    if (!autoCloseOpenDay_(t.id, t.date, end, tz)) return;
    out.closed.push({ id: t.id, name: names[t.id], date: t.date,
                      inTime: hhmm_(t.ts, tz), outTime: hhmm_(end, tz),
                      worked: minutesBetween_(t.ts, end) });
  });

  if (out.closed.length || out.skipped.length) {
    console.log('autoCloseStaleDays_: ' + out.closed.length + ' closed, ' +
                out.skipped.length + ' left open (no usable shift end)');
  }
  return out;
}

/**
 * Close one open day with a time a PERSON supplied. Shared by both fix paths so their rules
 * cannot diverge. Also the path that replaces an `auto_close` placeholder.
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
  // 'auto_close' is deliberately NOT accepted here — it is written only by the sweep, which
  // has no person behind it and must never be reachable from a claim.
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

  // A day the sweep already closed at WORK_END is still correctable: the placeholder is a
  // machine stand-in, not an observation, so a real time replaces it.
  var openIn = openDayIn_(empId, cleanDate, tz);
  var placeholder = openIn ? null : autoCloseRow_(empId, cleanDate, tz);
  if (!openIn && !placeholder) return { ok: false, error: 'not_open', text: MSG.FIX_NOT_OPEN };

  var anchorTs = openIn ? openIn.ts : dayInPunch_(empId, cleanDate, tz);
  if (!anchorTs) return { ok: false, error: 'not_open', text: MSG.FIX_NOT_OPEN };
  if (when.getTime() <= anchorTs.getTime()) {
    return { ok: false, error: 'before_in',
             text: fill_(MSG.FIX_BEFORE_IN, { time: hhmm_(anchorTs, tz) }) };
  }

  var worked = minutesBetween_(anchorTs, when);

  // The state is re-read inside the lock: a double tap on the page (the button disables
  // itself, but a retry can slip through) must not write two `out` rows for one day — and a
  // placeholder that appeared between the read above and here must be replaced, not doubled.
  var closed = false;
  withLock_(function () {
    var note = 'forgot_out ' + cleanDate + ' ' +
               (source === 'hr_fix' ? 'closed by HR' : 'self-reported') + ' ' + cleanTime;
    var p = autoCloseRow_(empId, cleanDate, tz);
    if (p) {
      replaceBlockRow_('ATTENDANCE', p.row, [when, empId, 'out', source,
                                             note + ' replaced auto_close']);
      logEvent_('', empId, source, 'out ' + cleanDate + ' ' + cleanTime + ' replaced auto_close');
    } else {
      if (!openDayIn_(empId, cleanDate, tz)) return;
      appendToBlock_('ATTENDANCE', [when, empId, 'out', source, note]);
      logEvent_('', empId, source, 'out ' + cleanDate + ' ' + cleanTime);
    }
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
 * HR: close a forgotten check-out.
 *
 * ⚠️ The editor's **Run** button calls a function with NO arguments — so with arguments this
 *    is not runnable from the UI at all. The request therefore comes from three Script
 *    Properties (Project Settings → Script Properties), and the function is run bare:
 *
 *        FIX_EMP_ID   A0124
 *        FIX_DATE     2026-10-26
 *        FIX_TIME     19:30
 *
 *    They are cleared after a SUCCESSFUL run, so a stale request cannot be applied twice; a
 *    failed run leaves them in place so one wrong value can be fixed and re-run.
 *
 * Called with arguments (from code, or a test) it behaves identically and touches no
 * properties: `hrFixDay('A0124', '2026-10-26', '19:30')`.
 *
 * Appends one `out` row (source `hr_fix`) dated to that day, so B3 stops listing the
 * employee and the check-in warning stops. Never edit or delete the original `in` — the
 * ledger is append-only, and the `in` is not the row that is wrong.
 *
 * @returns {string} a one-line result, also written to the Executions log.
 */
function hrFixDay(employeeId, dateStr, hhmm) {
  var props = PropertiesService.getScriptProperties();
  var fromProps = (employeeId === undefined || employeeId === null);

  if (fromProps) {
    employeeId = props.getProperty('FIX_EMP_ID') || '';
    dateStr = props.getProperty('FIX_DATE') || '';
    hhmm = props.getProperty('FIX_TIME') || '';
    if (!employeeId) {
      var hint = 'ยังไม่ได้ระบุคำขอ: ตั้ง FIX_EMP_ID / FIX_DATE / FIX_TIME ใน Script ' +
                 'Properties แล้วรันอีกครั้ง';
      console.log(hint);
      return hint;
    }
  }

  var out;
  var ok = false;
  try {
    var cfg = getConfig_();
    var employee = employeeById_(employeeId);
    if (!employee) {
      out = 'ไม่พบรหัสพนักงาน "' + employeeId + '" ใน EMPLOYEES_LOG คอลัมน์ A';
    } else {
      var r = closeOpenDay_(employee, dateStr, hhmm, 'hr_fix', cfg);
      ok = r.ok;
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

  if (fromProps && ok) {
    ['FIX_EMP_ID', 'FIX_DATE', 'FIX_TIME'].forEach(function (k) { props.deleteProperty(k); });
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
  var windowDays = selfReportDays_(cfg);
  var oldest = windowDays
    ? Utilities.formatDate(new Date(Date.now() - windowDays * 86400000), tz, 'yyyy-MM-dd')
    : null;

  var open = openDaysByEmployee_(tz)[String(empId).trim()] || [];

  // A day the sweep already closed is still the employee's to correct while their window
  // lasts: the sweep filled in the shift end, it did not take the day away from them.
  var auto = autoClosedDays_(empId, tz).filter(function (d) {
    return !oldest || d.date >= oldest;
  });

  if (!open.length && !auto.length) return { text: MSG.FIX_LIST_NONE, days: [] };

  var days = [];
  var body = '';

  if (open.length) {
    body = MSG.FIX_LIST_HEAD;
    for (var i = open.length - 1; i >= 0; i--) {       // newest first
      var label = Utilities.formatDate(open[i].ts, tz, 'dd/MM');
      body += fill_(MSG.FIX_LIST_LINE, { date: label, time: hhmm_(open[i].ts, tz) });
      days.push({ date: Utilities.formatDate(open[i].ts, tz, 'yyyy-MM-dd'),
                  label: label, inHHmm: hhmm_(open[i].ts, tz) });
    }
  }

  if (auto.length) {
    body += MSG.FIX_LIST_AUTO_HEAD;
    auto.forEach(function (d) {                        // already newest first
      var inHhMm = d.inTs ? hhmm_(d.inTs, tz) : '?';
      body += fill_(MSG.FIX_LIST_LINE_AUTO, { date: d.label, time: inHhMm, out: hhmm_(d.outTs, tz) });
      // The page builds each <option> as `label — เข้างาน HH:mm`, so the "this was closed for
      // you" fact has to travel in the label; a day must never look identical to a real punch.
      days.push({ date: d.date, label: d.label + ' (ปิดอัตโนมัติ ' + hhmm_(d.outTs, tz) + ')',
                  inHHmm: inHhMm });
    });
  }

  body += windowDays ? fill_(MSG.FIX_LIST_TAIL, { days: windowDays })
                     : '\n\n' + MSG.FIX_DISABLED;
  return { text: body, days: days };
}

/**
 * The employee's `auto_close` rows, newest first, as {date, label, inTs, outTs}.
 * Read by the LIFF list so an auto-closed day can still be corrected with the real time.
 */
function autoClosedDays_(empId, tz) {
  var out = [];
  readBlock_('ATTENDANCE').forEach(function (r) {
    var v = r.values;
    if (String(v[COLS.ATTENDANCE.EMPLOYEE_ID]).trim() !== String(empId).trim()) return;
    if (String(v[COLS.ATTENDANCE.EVENT]).trim() !== 'out') return;
    if (String(v[COLS.ATTENDANCE.SOURCE]).trim() !== 'auto_close') return;
    var ts = v[COLS.ATTENDANCE.TS];
    if (!(ts instanceof Date)) return;
    var dateStr = Utilities.formatDate(ts, tz, 'yyyy-MM-dd');
    out.push({ date: dateStr, label: Utilities.formatDate(ts, tz, 'dd/MM'),
               inTs: dayInPunch_(empId, dateStr, tz), outTs: ts });
  });
  return out.sort(function (a, b) { return b.outTs.getTime() - a.outTs.getTime(); });
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
