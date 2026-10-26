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
 * check-out. This is an EXCEPTION report: it only sends when there is something to say,
 * because a nightly "all good" email is noise HR learns to filter out.
 *
 * Two sections, both about days the bot could not close on its own:
 *   - still open  → the day has no check-out, so it has no hours at all
 *   - self-reported in the last 24h → the employee closed it from the LIFF page, and a
 *     self-reported time is HR's to accept or query
 *
 * Gated exactly like dailyDigest: `EMAIL_ENABLED` (HR_MAIN CONFIG) and `HR_EMAIL`. Email
 * rather than a LINE push, for the same reason as the digest: a push per offender would
 * eat the monthly message quota; email costs nothing.
 *
 * ⚠️ This reports; it never writes an attendance row. Inventing a check-out time to "clean
 *    up" the sheet would put a number in the ledger that nobody observed — see fixes.gs.
 */
function forgotOutReport() {
  var cfg = getConfig_();

  if (!cfgBool_(cfg.EMAIL_ENABLED)) {
    console.log('forgotOutReport skipped: EMAIL_ENABLED is off (HR_MAIN CONFIG)');
    return;
  }
  if (!cfg.HR_EMAIL) { console.warn('HR_EMAIL not set; forgotOutReport skipped'); return; }

  var tz = cfg.TZ;
  var open = openDaysByEmployee_(tz);

  var names = {};
  readBlock_('EMPLOYEES').forEach(function (r) {
    if (!isActive_(r.values)) return;
    names[String(r.values[COLS.EMPLOYEES.ID]).trim()] = String(r.values[COLS.EMPLOYEES.NAME]);
  });

  var openLines = [];
  Object.keys(open).forEach(function (id) {
    // A leaver is not chased: a report that grows names nobody will ever clear is how HR
    // learns to ignore the report. Their rows stay in DATA and hrFixDay still works on them.
    if (!names[id]) return;
    open[id].forEach(function (p) {
      openLines.push('- ' + names[id] + ' (' + id + ') เข้างาน ' +
                     Utilities.formatDate(p.ts, tz, 'dd/MM HH:mm') + ' — ยังไม่ลงเวลาเลิกงาน');
    });
  });
  var selfLines = selfReportedRecently_(tz);

  // One LOG row per run, so "the trigger ran and found nothing" stays distinguishable from
  // "the trigger never ran" — the silent-failure mode this project keeps guarding against.
  logEvent_('', '', 'report:forgot_out',
            openLines.length + ' open, ' + selfLines.length + ' self-reported');

  if (!openLines.length && !selfLines.length) {
    console.log('forgotOutReport: nothing outstanding');
    return;
  }

  var subject = openLines.length
    ? 'ค้างเลิกงาน ' + openLines.length + ' รายการ — ' + todayLabel_(tz)
    : 'พนักงานแจ้งเวลาเลิกงานเอง — ' + todayLabel_(tz);

  var body = [];
  if (openLines.length) {
    body.push('ยังไม่ปิดเวลาออก ' + openLines.length + ' รายการ:', openLines.join('\n'));
  }
  if (selfLines.length) {
    if (body.length) body.push('');
    body.push('พนักงานแจ้งเวลาเองใน 24 ชม. ที่ผ่านมา (ไม่ได้สแกน — โปรดตรวจสอบ):',
              selfLines.join('\n'));
  }
  body.push('',
            'วิธีปิดเวลาด้วยเวลาจริง: ตั้ง FIX_EMP_ID / FIX_DATE / FIX_TIME ใน Script Properties',
            'แล้วรัน hrFixDay ใน Apps Script editor — หรือให้พนักงานแจ้งเวลาเองจากหน้าลงเวลา',
            'ระบบไม่ปิดวันให้เองโดยเดาเวลา — วันนั้นจะยังไม่มีชั่วโมงทำงานจนกว่าจะมีคนยืนยัน');

  GmailApp.sendEmail(cfg.HR_EMAIL, subject, body.join('\n'));
  console.log('forgotOutReport: ' + openLines.length + ' open, ' +
              selfLines.length + ' self-reported → ' + cfg.HR_EMAIL);
}

/** Self-reported check-outs written in the last 24h, as report lines (read from the LOG block). */
function selfReportedRecently_(tz) {
  var since = new Date(Date.now() - 24 * 3600 * 1000);
  var out = [];
  readBlock_('LOG').forEach(function (r) {
    var v = r.values;
    if (String(v[COLS.LOG.ACTION]).trim() !== 'self_report') return;
    var ts = v[COLS.LOG.TS];
    if (!(ts instanceof Date) || ts < since) return;
    out.push('- ' + String(v[COLS.LOG.USER_ID]).trim() + ' — ' +
             String(v[COLS.LOG.STATUS]).trim() +
             ' (แจ้งเมื่อ ' + Utilities.formatDate(ts, tz, 'dd/MM HH:mm') + ')');
  });
  return out;
}

function todayLabel_(tz) {
  return Utilities.formatDate(new Date(), tz, 'd MMM yyyy');
}
