/**
 * triggers.gs — installable triggers. Work with no employee waiting on it.
 *
 * Nothing on the punch path lives here: the reply token expires in 1 minute, so the
 * punch is handled inline in doPost. These are for the HR console and housekeeping.
 */

/**
 * Run ONCE from the editor after deploying. Deletes its own triggers first so
 * re-running does not create duplicates (Apps Script happily allows many).
 */
function installTriggers() {
  // All three names are listed so re-running this also DELETES a previously installed
  // dashboardTick (the old every-minute heartbeat). Only the two reports are (re)created.
  var handled = ['dailyDigest', 'forgotOutReport', 'dashboardTick'];

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (handled.indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });

  // 09:15 Asia/Bangkok — who has not checked in. Silenced on non-work days and when
  // EMAIL_ENABLED is off (see dailyDigest).
  ScriptApp.newTrigger('dailyDigest').timeBased().atHour(9).nearMinute(15).everyDays(1).create();

  // 05:00 Asia/Bangkok — who never checked out on an earlier day. Runs before anyone
  // starts a new shift, so HR can chase it the same morning. Also gated by EMAIL_ENABLED.
  ScriptApp.newTrigger('forgotOutReport').timeBased().atHour(5).nearMinute(0).everyDays(1).create();

  console.log('Triggers installed: dailyDigest 09:15, forgotOutReport 05:00. No per-minute ' +
              'tick — the dashboard recalculates on every punch write; set Sheets ' +
              'recalculation for idle refresh.');
}

/**
 * Free: GmailApp, not a LINE push. A LINE push to HR would be ~22 of the 300 monthly
 * messages for one notification a day.
 *
 * Two gates before any work, both HR-editable in HR_MAIN!T:U:
 *   - EMAIL_ENABLED = FALSE  → off entirely
 *   - today not in WORK_DAYS → skipped (no weekend "everyone is missing" emails)
 */
function dailyDigest() {
  var cfg = getConfig_();

  if (!cfgBool_(cfg.EMAIL_ENABLED)) {
    console.log('Digest skipped: EMAIL_ENABLED is off (HR_MAIN CONFIG)');
    return;
  }
  if (!isWorkday_(cfg)) {
    console.log('Digest skipped: today is not a WORK_DAYS day (' + cfg.WORK_DAYS + ')');
    return;
  }
  if (!cfg.HR_EMAIL) { console.warn('HR_EMAIL not set; digest skipped'); return; }

  var missing = missingToday_(cfg);
  var subject = missing.length
    ? 'ยังไม่เข้างาน ' + missing.length + ' คน — ' + todayLabel_(cfg.TZ)
    : 'เข้างานครบทุกคน — ' + todayLabel_(cfg.TZ);

  var body = missing.length
    ? 'ยังไม่เข้างาน:\n- ' + missing.join('\n- ')
    : 'พนักงานทุกคนเข้างานแล้ว ✅';

  GmailApp.sendEmail(cfg.HR_EMAIL, subject, body);
  console.log('Digest sent to ' + cfg.HR_EMAIL);
}

/** Employees marked active with no `in` punch today. */
function missingToday_(cfg) {
  var tz = cfg.TZ;
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var present = {};
  readBlock_('ATTENDANCE').forEach(function (r) {
    var v = r.values;
    var ts = v[COLS.ATTENDANCE.TS];
    if (!(ts instanceof Date)) return;
    if (Utilities.formatDate(ts, tz, 'yyyy-MM-dd') !== today) return;
    if (String(v[COLS.ATTENDANCE.EVENT]).trim() !== 'in') return;
    present[String(v[COLS.ATTENDANCE.EMPLOYEE_ID]).trim()] = true;
  });

  var out = [];
  readBlock_('EMPLOYEES').forEach(function (r) {
    var v = r.values;
    if (!isActive_(v)) return;
    var id = String(v[COLS.EMPLOYEES.ID]).trim();
    if (!present[id]) out.push(String(v[COLS.EMPLOYEES.NAME]) + ' (' + id + ')');
  });
  return out;
}

/**
 * 05:00 — yesterday is over, so any shift still open from before today is a forgotten
 * check-out. This job does two things, in this order:
 *
 *   1. SELF-HEAL — `autoCloseStaleDays_` closes a day that has been open for
 *      AUTO_CLOSE_DAYS at WORK_END (source `auto_close`). Not gated by the email switches:
 *      a Friday shift nobody confirms must stop squatting in B3 over the weekend, whether
 *      or not HR wants mail. This is the case that used to hang forever.
 *   2. REPORT — an EXCEPTION email, only when there is something to say, because a nightly
 *      "all good" message is noise HR learns to filter out. Three sections:
 *        - still open          → no check-out at all, so no hours
 *        - auto-closed          → closed at the shift end; HR should confirm with the person
 *        - self-reported (24h)  → the employee closed it from the LIFF page; HR's to accept
 *
 * Gated exactly like dailyDigest: `EMAIL_ENABLED` (HR_MAIN CONFIG) and `HR_EMAIL`. Email
 * rather than a LINE push, for the same reason as the digest: a push per offender would
 * eat the monthly message quota; email costs nothing.
 *
 * ⚠️ The only attendance row this job can write is an `auto_close` placeholder, and only
 *    through fixes.gs. It never picks a time of its own.
 */
function forgotOutReport() {
  var cfg = getConfig_();
  var tz = cfg.TZ;

  var healed = autoCloseStaleDays_(cfg);

  // Read the open days AFTER the sweep, so a day it just closed is reported once, in its
  // own section, instead of also being listed as "still open".
  var open = openDaysByEmployee_(tz);

  var names = {};
  readBlock_('EMPLOYEES').forEach(function (r) {
    if (!isActive_(r.values)) return;
    names[String(r.values[COLS.EMPLOYEES.ID]).trim()] = String(r.values[COLS.EMPLOYEES.NAME]);
  });

  var openDays = [];
  Object.keys(open).forEach(function (id) {
    // A leaver is not chased: a report that grows names nobody will ever clear is how HR
    // learns to ignore the report. Their rows stay in DATA and hrFixDay still works on them.
    if (!names[id]) return;
    open[id].forEach(function (p) { openDays.push({ id: id, name: names[id], ts: p.ts }); });
  });

  var selfReports = selfReportedRecently_(tz);
  var total = openDays.length + healed.closed.length + selfReports.length;

  // One LOG row per run, so "the trigger ran and found nothing" stays distinguishable from
  // "the trigger never ran" — the silent-failure mode this project keeps guarding against.
  logEvent_('', '', 'report:forgot_out',
            openDays.length + ' open, ' + healed.closed.length + ' auto-closed, ' +
            selfReports.length + ' self-reported');

  if (!total) { console.log('forgotOutReport: nothing outstanding'); return; }

  if (!cfgBool_(cfg.EMAIL_ENABLED)) {
    console.log('forgotOutReport skipped the email: EMAIL_ENABLED is off (HR_MAIN CONFIG) — ' +
                total + ' item(s) outstanding');
    return;
  }
  if (!cfg.HR_EMAIL) { console.warn('HR_EMAIL not set; forgotOutReport skipped'); return; }

  var mail = buildForgotOutMail_(cfg, openDays, healed.closed, selfReports);
  GmailApp.sendEmail(cfg.HR_EMAIL, mail.subject, mail.body);
  console.log('forgotOutReport: ' + openDays.length + ' open, ' +
              healed.closed.length + ' auto-closed, ' + selfReports.length +
              ' self-reported → ' + cfg.HR_EMAIL);
}

/**
 * The email itself. All wording lives in messages.gs (HR_MAIL); this only decides layout,
 * numbering and which policy paragraph is true right now.
 *
 * @returns {{subject:string, body:string}}
 */
function buildForgotOutMail_(cfg, openDays, autoClosed, selfReports) {
  var tz = cfg.TZ;
  var now = new Date();
  var todayLabel = thaiDateLabel_(now, tz);
  var total = openDays.length + autoClosed.length + selfReports.length;
  var autoDays = autoCloseDays_(cfg);

  var out = [];
  out.push(HR_MAIL.GREETING, '');
  out.push(fill_(HR_MAIL.INTRO, { date: todayLabel, time: hhmm_(now, tz), n: total }), '');

  if (openDays.length) {
    out.push(fill_(HR_MAIL.OPEN_HEAD, { n: openDays.length }));
    openDays.forEach(function (d, i) {
      out.push(HR_MAIL.ITEM_INDENT + fill_(HR_MAIL.ITEM_OPEN, {
        n: i + 1, id: d.id, name: d.name,
        in_date: thaiDateLabel_(d.ts, tz), in_time: hhmm_(d.ts, tz)
      }));
    });
    out.push('', HR_MAIL.OPEN_NOTE, '');
  }

  if (autoClosed.length) {
    out.push(fill_(HR_MAIL.AUTO_HEAD, { n: autoClosed.length }));
    autoClosed.forEach(function (d, i) {
      out.push(HR_MAIL.ITEM_INDENT + fill_(HR_MAIL.ITEM_AUTO, {
        n: i + 1, id: d.id, name: d.name,
        in_date: thaiDateLabel_(d.date, tz), in_time: d.inTime, out_time: d.outTime
      }));
    });
    out.push('', fill_(HR_MAIL.AUTO_NOTE, { end: cfg.WORK_END }), '');
  }

  if (selfReports.length) {
    out.push(fill_(HR_MAIL.SELF_HEAD, { n: selfReports.length }));
    selfReports.forEach(function (s, i) {
      out.push(HR_MAIL.ITEM_INDENT + selfReportItem_(s, i + 1, tz));
    });
    out.push('', HR_MAIL.SELF_NOTE, '');
  }

  out.push(HR_MAIL.ACTIONS_HEAD);
  var selfDays = selfReportDays_(cfg);
  if (selfDays) out.push(fill_(HR_MAIL.ACTION_EMPLOYEE, { days: selfDays }));
  out.push(HR_MAIL.ACTION_HR);
  out.push(autoDays ? fill_(HR_MAIL.ACTION_AUTO_ON, { days: autoDays, end: cfg.WORK_END })
                    : HR_MAIL.ACTION_AUTO_OFF);
  out.push('', HR_MAIL.FOOTER);

  return { subject: fill_(HR_MAIL.SUBJECT, { n: total, date: todayLabel }),
           body: out.join('\n') };
}

/**
 * One self-report line. The LOG status is `out yyyy-MM-dd HH:mm` (plus ` replaced auto_close`
 * when the employee corrected a placeholder), so it is parsed for a readable date/time and
 * echoed verbatim when it does not match — never dropped, never reformatted by guesswork.
 */
function selfReportItem_(entry, n, tz) {
  var reported = thaiDateLabel_(entry.ts, tz) + ' ' + hhmm_(entry.ts, tz) + ' น.';
  var m = /^out (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/.exec(entry.status);
  if (!m) {
    return fill_(HR_MAIL.ITEM_SELF_RAW, { n: n, id: entry.id, status: entry.status,
                                          reported: reported });
  }
  return fill_(HR_MAIL.ITEM_SELF, { n: n, id: entry.id, out_date: thaiDateLabel_(m[1], tz),
                                    out_time: m[2], reported: reported });
}

/** Self-reported check-outs written in the last 24h (read from the LOG block). */
function selfReportedRecently_(tz) {
  var since = new Date(Date.now() - 24 * 3600 * 1000);
  var out = [];
  readBlock_('LOG').forEach(function (r) {
    var v = r.values;
    if (String(v[COLS.LOG.ACTION]).trim() !== 'self_report') return;
    var ts = v[COLS.LOG.TS];
    if (!(ts instanceof Date) || ts < since) return;
    out.push({ id: String(v[COLS.LOG.USER_ID]).trim(),
               status: String(v[COLS.LOG.STATUS]).trim(), ts: ts });
  });
  return out;
}

function todayLabel_(tz) {
  return Utilities.formatDate(new Date(), tz, 'd MMM yyyy');
}
