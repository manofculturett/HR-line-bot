/**
 * diagnostics.gs — one-click "is it actually working?" check.
 *
 * Run `selfTest` from the Apps Script editor (function dropdown → Run) and read the
 * Executions log. It answers, in order, the five things that silently break this bot:
 *
 *   1. Script Properties present    → a missing one throws on the first real message
 *   2. Spreadsheet reachable        → SHEET_ID correct and shared with this account
 *   3. CONFIG readable              → WORK_START parses (a Time cell would break it)
 *   4. LINE channel reachable       → the access token is valid
 *   5. Rich menus configured        → the ids match real menus on the channel
 *
 * Everything here is read-only. It never writes a punch.
 */

function selfTest() {
  var pass = 0, fail = 0;
  function ok(label, detail)   { pass++; console.log('  PASS  ' + label + (detail ? ' — ' + detail : '')); }
  function bad(label, detail)  { fail++; console.log('  FAIL  ' + label + (detail ? ' — ' + detail : '')); }
  function check(label, fn) {
    try { var d = fn(); ok(label, d); } catch (e) { bad(label, String(e && e.message || e)); }
  }

  console.log('=== HR-line-bot selfTest ===');

  // 1. Script Properties
  console.log('\n[1] Script Properties');
  var props = PropertiesService.getScriptProperties().getProperties();
  [['SHEET_ID', true], ['WEBHOOK_SECRET', true],
   ['LINE_CHANNEL_ACCESS_TOKEN', true], ['LINE_CHANNEL_ID', false],
   ['RICHMENU_REGISTERED', false], ['RICHMENU_UNREGISTERED', false]].forEach(function (p) {
    var v = props[p[0]];
    if (v) ok(p[0], p[0].indexOf('TOKEN') >= 0 || p[0].indexOf('SECRET') >= 0 ? '(set)' : v);
    else if (p[1]) bad(p[0], 'MISSING — required');
    else console.log('  note  ' + p[0] + ' not set (optional)');
  });

  // 2. Spreadsheet
  console.log('\n[2] Spreadsheet');
  check('open SHEET_ID', function () {
    var ss = SpreadsheetApp.openById(secret_('SHEET_ID'));
    return ss.getName() + ' / tz=' + ss.getSpreadsheetTimeZone();
  });
  ['HR_MAIN', 'EMPLOYEES_LOG', 'DATA'].forEach(function (tab) {
    check('tab ' + tab, function () {
      var sh = getTab_(tab);
      return 'rows=' + sh.getLastRow() + ' cols=' + sh.getLastColumn();
    });
  });

  // 3. CONFIG
  console.log('\n[3] CONFIG block');
  check('getConfig_', function () {
    var c = getConfig_();
    if (parseHhMm_(c.WORK_START) === null) {
      throw new Error('WORK_START does not parse as HH:MM (got "' + c.WORK_START + '")');
    }
    return 'start=' + c.WORK_START + ' grace=' + c.LATE_GRACE_MIN +
           ' tz=' + c.TZ + ' hrEmail=' + (c.HR_EMAIL || '(unset)') +
           ' email=' + (cfgBool_(c.EMAIL_ENABLED) ? 'ON' : 'OFF') +
           ' todayWorkday=' + (isWorkday_(c) ? 'yes' : 'no');
  });

  // 4. LINE channel
  console.log('\n[4] LINE channel');
  check('GET /v2/bot/info', function () {
    var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/info',
      { headers: authHeaders_(), muteHttpExceptions: true, timeout: LINE_TIMEOUT_MS });
    if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode() + ' ' + res.getContentText());
    var b = JSON.parse(res.getContentText());
    return (b.displayName || '?') + ' (' + (b.basicId || 'no basicId') + ')';
  });

  // 5. Rich menus
  console.log('\n[5] Rich menus — copy an id below into Script Properties');
  check('list menus on the channel', function () {
    var menus = listRichMenus_();
    if (!menus.length) return 'none exist yet — create them in OA Manager';
    menus.forEach(function (m) {
      console.log('        ' + m.richMenuId + '  |  ' + (m.name || '(no name)') +
                  '  |  ' + (m.size ? (m.size.width + 'x' + m.size.height) : '?'));
    });
    return menus.length + ' menu(s)';
  });
  check('configured ids exist on the channel', function () {
    var onChannel = listRichMenus_().map(function (m) { return m.richMenuId; });
    var out = [];
    ['RICHMENU_REGISTERED', 'RICHMENU_UNREGISTERED'].forEach(function (k) {
      var id = richMenuId_(k);
      if (!id) out.push(k + '=UNSET');
      else out.push(k + (onChannel.indexOf(id) >= 0 ? '=ok' : '=NOT FOUND'));
    });
    return out.join(', ');
  });

  // 6. Data state
  console.log('\n[6] Data');
  check('roster + blocks', function () {
    var emp = readBlock_('EMPLOYEES');
    var active = emp.filter(function (r) { return isActive_(r.values); }).length;
    var linked = emp.filter(function (r) {
      return String(r.values[COLS.EMPLOYEES.LINE_USER_ID]).trim() !== '';
    }).length;
    return 'employees=' + emp.length + ' active=' + active + ' linked=' + linked +
           ' | punches=' + readBlock_('ATTENDANCE').length;
  });

  console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===');
  if (fail) console.log('Fix the FAIL lines above before expecting a reply in LINE.');
  return { pass: pass, fail: fail };
}
