/**
 * diagnostics.gs — one-click "is it actually working?" check.
 *
 * Run `selfTest` from the Apps Script editor (function dropdown → Run) and read the
 * Executions log. It answers, in order, the seven things that silently break this bot:
 *
 *   1. Script Properties present    → a missing one throws on the first real message
 *   2. Spreadsheet reachable        → SHEET_ID correct and shared with this account
 *   3. CONFIG readable              → WORK_START / WORK_END parse ("09:00", not a Date)
 *   4. LINE channel reachable       → the access token is valid
 *   5. Rich menus configured        → the ids match real menus on the channel
 *   6. Data state                   → who is linked, how many punches exist
 *   7. LIFF punch path              → LIFF_ID / LIFF_CHANNEL_ID set and distinct, and the
 *                                     geo block headers are where config.gs says they are
 *   8. Forgotten check-outs         → who is stuck open, whether the 05:00 trigger exists,
 *                                     and whether the report would actually send
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
   ['RICHMENU_REGISTERED', false], ['RICHMENU_UNREGISTERED', false],
   ['LIFF_ID', false], ['LIFF_CHANNEL_ID', false]].forEach(function (p) {
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
    // WORK_END feeds the HR_MAIN "ออกก่อน" column; a Time-formatted cell would silently
    // break that formula the same way it breaks WORK_START.
    if (parseHhMm_(c.WORK_END) === null) {
      throw new Error('WORK_END does not parse as HH:MM (got "' + c.WORK_END + '")');
    }
    return 'start=' + c.WORK_START + ' end=' + c.WORK_END +
           ' grace=' + c.LATE_GRACE_MIN + '/' + c.EARLY_GRACE_MIN +
           ' tz=' + c.TZ + ' hrEmail=' + (c.HR_EMAIL || '(unset)') +
           ' email=' + (cfgBool_(c.EMAIL_ENABLED) ? 'ON' : 'OFF') +
           ' geoMode=' + c.GEO_MODE +
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

  // 7. LIFF punch path
  console.log('\n[7] LIFF punch path');
  check('LIFF Script Properties', function () {
    var liffId = props.LIFF_ID;
    var lane = props.LIFF_CHANNEL_ID;
    if (!liffId || !lane) {
      throw new Error('LIFF_ID and LIFF_CHANNEL_ID must both be set, or every LIFF punch ' +
                      'answers "unauthorized" (got LIFF_ID=' + (liffId || 'UNSET') +
                      ' LIFF_CHANNEL_ID=' + (lane || 'UNSET') + ')');
    }
    // The classic mistake: pasting the Messaging API channel id here. The ID token is
    // issued by the LINE Login channel, so verifying against the OA channel id always fails.
    if (String(lane) === String(props.LINE_CHANNEL_ID || '-')) {
      throw new Error('LIFF_CHANNEL_ID equals LINE_CHANNEL_ID — it must be the LINE LOGIN channel id');
    }
    return 'liffId=' + liffId;
  });
  check('geo block headers', function () {
    var want = ['ts', 'employee_id', 'event', 'lat', 'lng', 'acc_m', 'dist_m', 'verdict'];
    var got = getTab_(TABS.DATA)
      .getRange(1, BLOCKS.GEO.col + 1, 1, BLOCKS.GEO.width)
      .getValues()[0]
      .map(function (v) { return String(v).trim(); });
    if (got.join('|') !== want.join('|')) {
      throw new Error('DATA geo block reads [' + got.join(',') + '] at column ' +
                      BLOCKS.GEO.col + ', expected [' + want.join(',') + ']');
    }
    return 'aligned at column ' + BLOCKS.GEO.col + ' (' + BLOCKS.GEO.width + ' wide)';
  });
  check('location verdicts recorded', function () {
    var rows = readBlock_('GEO');
    if (!rows.length) return 'none yet — no LIFF punch has run';
    var by = {};
    rows.forEach(function (r) {
      var v = String(r.values[COLS.GEO.VERDICT]).trim() || '?';
      by[v] = (by[v] || 0) + 1;
    });
    return rows.length + ' check(s): ' + JSON.stringify(by);
  });

  // 8. Forgotten check-outs (v2.2.0)
  console.log('\n[8] Forgotten check-outs');
  check('open days', function () {
    var c = getConfig_();
    var open = openDaysByEmployee_(c.TZ);
    var ids = Object.keys(open);
    if (!ids.length) return 'none ✅';
    return ids.map(function (id) {
      return id + ' (' + open[id].map(function (p) {
        return Utilities.formatDate(p.ts, c.TZ, 'dd/MM HH:mm');
      }).join(', ') + ')';
    }).join('; ');
  });
  check('fix paths configured', function () {
    var c = getConfig_();
    var days = selfReportDays_(c);
    if (!days && !cfgBool_(c.EMAIL_ENABLED)) {
      return 'self-report OFF, email OFF — a forgotten day is only visible in HR_MAIN!B3';
    }
    return 'selfReportDays=' + (days || 'OFF') +
           ' email=' + (cfgBool_(c.EMAIL_ENABLED) ? 'ON → ' + (c.HR_EMAIL || 'HR_EMAIL UNSET') : 'OFF');
  });
  check('forgotOutReport trigger', function () {
    var t = ScriptApp.getProjectTriggers().filter(function (x) {
      return x.getHandlerFunction() === 'forgotOutReport';
    });
    // A report nobody scheduled is the failure this section exists to catch: the code is
    // deployed, the sheet looks fine, and no email ever arrives.
    if (!t.length) throw new Error('not installed — run installTriggers() once from the editor');
    return t.length + ' trigger(s)';
  });

  console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===');
  if (fail) console.log('Fix the FAIL lines above before expecting a reply in LINE.');
  return { pass: pass, fail: fail };
}
