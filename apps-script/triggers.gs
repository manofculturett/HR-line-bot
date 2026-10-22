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
  // Both names are listed so re-running this also DELETES a previously installed
  // dashboardTick (the old every-minute heartbeat). Only dailyDigest is (re)created.
  var handled = ['dailyDigest', 'dashboardTick'];

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (handled.indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });

  // 09:15 Asia/Bangkok — who has not checked in. Silenced on non-work days and when
  // EMAIL_ENABLED is off (see dailyDigest).
  ScriptApp.newTrigger('dailyDigest').timeBased().atHour(9).nearMinute(15).everyDays(1).create();

  console.log('Triggers installed: dailyDigest 09:15. No per-minute tick — the dashboard ' +
              'recalculates on every punch write; set Sheets recalculation for idle refresh.');
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

function todayLabel_(tz) {
  return Utilities.formatDate(new Date(), tz, 'd MMM yyyy');
}
