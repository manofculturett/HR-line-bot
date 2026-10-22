/**
 * liff.gs — the LIFF punch path (check in / out with a location).
 *
 * Why LIFF exists here: a postback carries no location at all, so the only way to attach
 * one is to run a page inside LINE. That page is a static file in docs/liff/ served by
 * GitHub Pages.
 *
 * ⚠️ It cannot be served by Apps Script. An Apps Script web app's HTML executes inside an
 *    iframe at *.googleusercontent.com, so liff.init() fails with "called with a current
 *    URL that is not related to the endpoint URL" and LINE's login screen refuses to be
 *    framed. Do not move the page into HtmlService.
 *
 * Trust model — the two halves are deliberately different:
 *   WHO   verified: the request carries a LINE-issued ID token; we verify it server-side
 *         at api.line.me/oauth2/v2.1/verify with the LINE LOGIN channel id. That is as
 *         trustworthy as a signed webhook's source.userId, and it keeps the ?k= webhook
 *         secret out of a public page. Never trust liff.getProfile() / getDecodedIDToken();
 *         they are client-side and tamperable (LINE's own docs say so).
 *   WHERE self-reported: coordinates come from the phone. See geo.gs — evidence, not proof.
 */

/**
 * Entry point for both transports (POST body, and the JSONP fallback in Code.gs).
 *
 * @param {Object} payload { idToken, action, lat, lng, acc }
 * @returns {Object} { ok, action, text, geo, error?, blocked? } — always JSON-safe, so
 *                   the page can render `text` directly and never shows a stack trace.
 */
function handleLiffPunch_(payload) {
  var idToken = String((payload && payload.idToken) || '');
  if (!idToken) return { ok: false, error: 'unauthorized', text: MSG.GEO_FAILED };

  var userId = verifyLiffIdToken_(idToken);
  if (!userId) {
    logEvent_('', '', 'liff', 'bad_idtoken');
    return { ok: false, error: 'unauthorized', text: MSG.GEO_FAILED };
  }

  var employee = employeeByLineId_(userId);
  if (!usableEmployee_(employee)) {
    return { ok: false, error: 'not_linked', text: MSG.REG_NOT_LINKED };
  }

  var action = actionOf_(payload.action);
  if (action !== 'in' && action !== 'out' && action !== 'today') {
    return { ok: false, error: 'bad_action', text: MSG.NOT_UNDERSTOOD };
  }

  var cfg = getConfig_();
  var empId = employee.values[COLS.EMPLOYEES.ID];

  // Read-only: the "today" view needs no location, writes no punch and no geo row. It is
  // here rather than as a separate endpoint because the page already has a verified
  // identity for this request — a second route would need a second auth path.
  if (action === 'today') {
    return { ok: true, action: 'today', text: todayStatus_(employee, cfg) };
  }

  var geo = geoCheck_(cfg, payload.lat, payload.lng, payload.acc);

  // BLOCK is the only setting that refuses a punch — and it is the one that breaks people
  // at the door, so it is opt-in. Record the refused attempt: "tried and was stopped" is
  // exactly what HR needs to see.
  if (geo.mode === 'BLOCK' && !geo.pass) {
    recordGeo_(empId, action, geo);
    logEvent_('', empId, 'liff:' + action, 'blocked:' + geo.verdict);
    return { ok: true, action: action, blocked: true, geo: geo,
             text: fill_(MSG.GEO_BLOCKED, { dist: geo.distM === null ? '?' : geo.distM }) };
  }

  // No webhookEventId on this path (it is not a webhook event), so idempotency comes from
  // the domain rule that already exists: punchIn_ refuses a second open `in`, punchOut_
  // refuses a second `out`. A double tap therefore writes at most one punch row.
  var text = (action === 'in') ? punchIn_(employee, cfg, geo)
                               : punchOut_(employee, cfg, geo);

  logEvent_('', empId, 'liff:' + action, geoNote_(geo) || 'no_geo');
  return { ok: true, action: action, geo: geo, text: text };
}

/**
 * Verify a LIFF ID token against LINE and return the user id, or null.
 *
 * A missing LIFF_CHANNEL_ID is a configuration error, not an auth failure — it is logged
 * loudly so it cannot hide as "everyone is unauthorized".
 */
function verifyLiffIdToken_(idToken) {
  var channelId = PropertiesService.getScriptProperties().getProperty('LIFF_CHANNEL_ID');
  if (!channelId) {
    logError_('liff', 'Missing Script Property: LIFF_CHANNEL_ID');
    return null;
  }
  try {
    var res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'post',
      // UrlFetchApp form-encodes an object payload — the endpoint wants x-www-form-urlencoded.
      payload: { id_token: idToken, client_id: channelId },
      muteHttpExceptions: true,
      timeout: LINE_TIMEOUT_MS
    });
    if (res.getResponseCode() !== 200) {
      console.warn('ID token rejected ' + res.getResponseCode() + ': ' + res.getContentText());
      return null;
    }
    var claims = JSON.parse(res.getContentText());
    return claims.sub || null;
  } catch (err) {
    logError_('verifyLiffIdToken_', err);
    return null;
  }
}

/**
 * One row per location check in DATA!S:Z, written under the same lock as the punch, so
 * "a punch row carrying geo" and "a geo row" never disagree.
 *
 * Two forms on purpose: appendGeoUnlocked_ is called from inside attendance.gs's existing
 * withLock_ block (LockService is not reentrant — nesting waitLock would deadlock the
 * execution), while recordGeo_ takes the lock itself for callers that are not inside one.
 */
function appendGeoUnlocked_(when, empId, event, geo) {
  if (!geo) return;
  appendToBlock_('GEO', [when, empId, event,
    geo.lat, geo.lng, geo.accM, geo.distM, geo.verdict]);
}

/** A standalone geo row (used when a punch was refused, so no punch row exists). */
function recordGeo_(empId, event, geo) {
  if (!geo) return;
  var now = new Date();
  withLock_(function () { appendGeoUnlocked_(now, empId, event, geo); });
}
