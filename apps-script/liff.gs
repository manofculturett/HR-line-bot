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
 * @param {Object} payload { idToken, action, lat, lng, acc, date?, hhmm? }
 *                   date/hhmm are only read by the 'fix' action (a self-reported
 *                   check-out for a forgotten day); see fixes.gs.
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

  // 'open' and 'fix' are LIFF-only, and deliberately NOT in ACTION_ALIASES: that map is
  // shared with the chat/postback path, where any recognised action falls through to a
  // punch — so a typed "fix" would silently become a check-out.
  var raw = normalizeToken_(payload.action);
  var fixAction = (raw === 'open' || raw === 'fix') ? raw : null;
  var action = actionOf_(raw);
  if (!fixAction && action !== 'in' && action !== 'out' && action !== 'today') {
    return { ok: false, error: 'bad_action', text: MSG.NOT_UNDERSTOOD };
  }

  var cfg = getConfig_();
  var empId = employee.values[COLS.EMPLOYEES.ID];

  // Read-only: the "today" view needs no location, writes no punch and no geo row. It is
  // here rather than as a separate endpoint because the page already has a verified
  // identity for this request — a second route would need a second auth path.
  //
  // It also carries everything the page needs to draw itself in ONE round-trip: the roster
  // name, today's punches as structure (to enable the right button), the open-day list (the
  // "ลืมลงเวลาเลิกงาน?" card) and WORK_END (the card's default time). An older page ignores
  // the extra fields and keeps asking for 'open' separately, so both versions work.
  if (action === 'today') {
    var fl = fixList_(employee, cfg);
    return { ok: true, action: 'today', text: todayStatus_(employee, cfg),
             name: String(employee.values[COLS.EMPLOYEES.NAME] || ''),
             state: todayState_(employee, cfg),
             days: fl.days, workEnd: cfg.WORK_END };
  }

  // Listing or closing a forgotten day is not a punch: no location is requested and no geo
  // row is written, because nothing here claims the person is at the office NOW. The time
  // is self-reported and recorded as source 'self_report' — see fixes.gs.
  if (fixAction === 'open') {
    var list = fixList_(employee, cfg);
    return { ok: true, action: 'open', text: list.text, days: list.days };
  }
  if (fixAction === 'fix') {
    var fix = selfReportFix_(employee, payload.date, payload.hhmm, cfg);
    if (!fix.ok) {
      logEvent_('', empId, 'fix', 'refused:' + fix.error);
      return { ok: false, error: fix.error, text: fix.text };
    }
    return { ok: true, action: 'fix', text: fix.text };
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
 * The LIFF URL to send an employee to when a punch must be verified.
 *
 * Built from the LIFF_ID Script Property so the id lives in one place (the page has its own
 * copy, which is public and harmless). Returns null when the property is missing — callers
 * must treat that as a configuration error, never as a reason to refuse a punch.
 */
function liffPunchUrl_() {
  var id = PropertiesService.getScriptProperties().getProperty('LIFF_ID');
  return id ? 'https://liff.line.me/' + id : null;
}

/**
 * Verify a LIFF ID token against LINE and return the user id, or null.
 *
 * A missing LIFF_CHANNEL_ID is a configuration error, not an auth failure — it is logged
 * loudly so it cannot hide as "everyone is unauthorized".
 *
 * One page visit sends the same token 2–3 times (status, punch, refresh), and each verify is
 * an HTTPS round-trip to LINE on the path where the employee is waiting. A token LINE has
 * already accepted is remembered until shortly before its own `exp`, keyed by its SHA-256 —
 * the token itself is never stored. A replayed token gets nothing it could not already get:
 * LINE would accept it for exactly that window too.
 */
function verifyLiffIdToken_(idToken) {
  var channelId = PropertiesService.getScriptProperties().getProperty('LIFF_CHANNEL_ID');
  if (!channelId) {
    logError_('liff', 'Missing Script Property: LIFF_CHANNEL_ID');
    return null;
  }
  var cacheKey = 'idt:' + sha256Hex_(idToken);
  var cache = CacheService.getScriptCache();
  var hit = cache.get(cacheKey);
  if (hit) return hit;

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
    if (!claims.sub) return null;
    // Remember it until 60 s before the token expires (never longer than 30 min).
    var ttl = Math.min(1800, Math.floor((Number(claims.exp) * 1000 - Date.now()) / 1000) - 60);
    if (ttl > 0) cache.put(cacheKey, claims.sub, ttl);
    return claims.sub;
  } catch (err) {
    logError_('verifyLiffIdToken_', err);
    return null;
  }
}

function sha256Hex_(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s),
                                      Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
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
