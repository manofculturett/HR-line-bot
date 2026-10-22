/**
 * Code.gs — the entry point. Flow only; no sheet access, no copy, no business rules.
 *
 * Apps Script allows ONE doGet and ONE doPost per project, so routing happens here.
 *
 * ⚠️ doPost(e) CANNOT read request headers — X-Line-Signature is unreadable.
 *    Auth is therefore the secret query param `?k=` (see ../README.md, "The two Apps Script sharp edges").
 *    Do not "fix" this by looking for e.headers; it does not exist.
 *
 * ⚠️ Returning ContentService causes a 302 redirect. If LINE retries, doPost runs
 *    again — that is why webhookEventId dedupe below is mandatory.
 */

/** Max seconds an event id is remembered for dedupe. */
var DEDUPE_TTL_SEC = 600;

function doPost(e) {
  // 1. Auth: secret query param. Reject before touching the body.
  var secret = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
  if (!e || !e.parameter || e.parameter.k !== secret) {
    console.warn('Rejected: bad or missing ?k=');
    return textOut_(JSON.stringify({ ok: false, error: 'unauthorized' }));
  }

  var payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    console.error('Bad JSON body: ' + err);
    return textOut_(JSON.stringify({ ok: false, error: 'invalid_json' }));
  }

  var events = payload.events || [];
  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    try {
      if (isDuplicate_(ev.webhookEventId)) {
        console.log('Duplicate event skipped: ' + ev.webhookEventId);
        continue;
      }
      route_(ev);
    } catch (err) {
      logError_('route', err);
    }
  }

  // The body is irrelevant to LINE; only the status matters.
  return textOut_(JSON.stringify({ ok: true }));
}

/** Health check: GET /exec?k=<secret> → tells you which deployment is live. */
function doGet(e) {
  var secret = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
  if (!e || !e.parameter || e.parameter.k !== secret) {
    return textOut_(JSON.stringify({ ok: false, error: 'unauthorized' }));
  }
  return textOut_(JSON.stringify({
    ok: true,
    role: 'hr-line-bot',
    version: 'v1',
    timezone: Session.getScriptTimeZone()
  }));
}

/** Route one LINE event to its handler. */
function route_(ev) {
  var userId = ev.source && ev.source.userId;   // trustworthy: LINE signed this
  var replyToken = ev.replyToken;

  switch (ev.type) {
    case 'follow':
      return onFollow_(userId, replyToken);

    case 'unfollow':
      return onUnfollow_(userId);

    case 'postback':
      return onPostback_(userId, ev.postback.data, replyToken);

    case 'message':
      return onMessage_(userId, ev.message, replyToken);

    default:
      console.log('Ignored event type: ' + ev.type);
  }
}

/* ---- handlers ---- */

/** New friend. Greet, attach the right menu, point them at registration. */
function onFollow_(userId, replyToken) {
  var employee = employeeByLineId_(userId);
  if (employee) {
    attachMenu_(userId, 'RICHMENU_REGISTERED');
    return reply_(replyToken, fill_(MSG.WELCOME_BACK, { name: employee.values[COLS.EMPLOYEES.NAME] }));
  }
  attachMenu_(userId, 'RICHMENU_UNREGISTERED');
  return reply_(replyToken, MSG.WELCOME);
}

/** Blocked the OA. Keep the binding — a re-add is the same userId. */
function onUnfollow_(userId) {
  var employee = employeeByLineId_(userId);
  if (employee) setLinkStatus_(employee.row, 'blocked');
  logEvent_('', userId, 'unfollow', employee ? 'blocked' : 'unknown');
}

/**
 * Map whatever the menu actually sends onto our three actions.
 *
 * A rich-menu LABEL is only pixels. What reaches the bot depends on the action type:
 *   postback → a `data` string  (silent)
 *   text     → a message equal to the label  (shows the word in the chat)
 *   link/URL → nothing at all
 *
 * Both working types are accepted. Matching is EXACT after normalisation (whitespace and
 * emoji stripped) so a label like "เข้างาน 🕘" still matches, while "เข้าประชุม" cannot.
 */
var ACTION_ALIASES = {
  'ck:in': 'in', 'checkin': 'in', 'check-in': 'in', 'in': 'in',
  'เข้างาน': 'in', 'เข้า': 'in',
  'ck:out': 'out', 'checkout': 'out', 'check-out': 'out', 'out': 'out',
  'เลิกงาน': 'out', 'ออกงาน': 'out', 'ออก': 'out',
  'me:today': 'today', 'mytoday': 'today', 'status': 'today',
  'สถานะ': 'today', 'สถานะของฉัน': 'today'
};

/** Words that open registration. Same normalisation. */
var REGISTER_WORDS = { 'ลงทะเบียน': true, 'register': true, 'สมัคร': true, 'reg:start': true };

/**
 * Strip whitespace and anything that is not Thai, Latin, a digit or :.-_
 * A label with an emoji or a trailing space must not break the match.
 */
function normalizeToken_(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\s+/g, '')
    .replace(/[^\u0E00-\u0E7Fa-zA-Z0-9:._-]/g, '')
    .toLowerCase();
}

/** 'in' | 'out' | 'today' | null */
function actionOf_(raw) {
  return ACTION_ALIASES[normalizeToken_(raw)] || null;
}

function isRegisterWord_(raw) {
  return REGISTER_WORDS[normalizeToken_(raw)] === true;
}

/** A rich-menu tap (postback) — the primary path. */
function onPostback_(userId, data, replyToken) {
  var raw = String(data || '');

  if (isRegisterWord_(raw)) {
    var existing = employeeByLineId_(userId);
    if (existing) return reply_(replyToken, MSG.REG_TAKEN);
    return startRegistration_(userId, replyToken);
  }

  var action = actionOf_(raw);
  if (!action) {
    console.warn('Unknown postback data: ' + raw);
    logEvent_('', userId, 'postback', 'unknown:' + raw);
    return reply_(replyToken, MSG.NOT_UNDERSTOOD);
  }

  return runAction_(userId, action, replyToken);
}

/**
 * Free text. A menu built with Message actions arrives here instead of as a postback, so an
 * exact-match label is treated as the button it came from. Anything else is refused —
 * an unmatched sentence must never become a punch.
 */
function onMessage_(userId, message, replyToken) {
  if (!message || message.type !== 'text') return reply_(replyToken, MSG.NOT_UNDERSTOOD);

  var cfg = getConfig_();
  if (regState_(userId)) {
    var text = registrationTurn_(userId, message.text, cfg);
    // On success the state is cleared and the user is now bound — swap them onto the
    // punch menu. On a failure the state is also cleared but no binding exists, so this
    // stays a no-op.
    if (!regState_(userId) && employeeByLineId_(userId)) {
      attachMenu_(userId, 'RICHMENU_REGISTERED');
    }
    return reply_(replyToken, text);
  }

  var action = actionOf_(message.text);
  if (action) return runAction_(userId, action, replyToken);

  // A brand-new employee may have no button for this — typing the word must also work.
  if (!employeeByLineId_(userId) && isRegisterWord_(message.text)) {
    return startRegistration_(userId, replyToken);
  }

  // An ALREADY-registered user who taps/types ลงทะเบียน: answer "already registered"
  // (matching the postback path) instead of the confusing "not understood".
  if (isRegisterWord_(message.text) && employeeByLineId_(userId)) {
    return reply_(replyToken, MSG.REG_TAKEN);
  }

  if (!usableEmployee_(employeeByLineId_(userId))) return reply_(replyToken, MSG.REG_NOT_LINKED);

  // Log the raw text (Executions only, never the sheet) so an unrecognised button label is
  // one glance away from being diagnosed.
  console.log('Unmatched text [%s] (normalised: "%s")',
              message.text, normalizeToken_(message.text));
  return reply_(replyToken, MSG.NOT_UNDERSTOOD);
}

/** The three actions, however they were triggered. */
function runAction_(userId, action, replyToken) {
  var cfg = getConfig_();
  var employee = employeeByLineId_(userId);

  if (action === 'today') {
    if (!usableEmployee_(employee)) return reply_(replyToken, MSG.REG_NOT_LINKED);
    return reply_(replyToken, todayStatus_(employee, cfg));
  }

  if (!usableEmployee_(employee)) return reply_(replyToken, MSG.REG_NOT_LINKED);

  // Write then confirm; answer_ falls back to a push so a punch is never silent.
  var text = (action === 'in') ? punchIn_(employee, cfg) : punchOut_(employee, cfg);
  return answer_(userId, replyToken, text);
}

/** Linked and still employed. */
function usableEmployee_(employee) {
  return !!employee && isActive_(employee.values);
}

/* ---- helpers ---- */

/**
 * True if this webhookEventId was seen recently. Uses CacheService so the read is
 * cheap and self-expiring; falls back to false if the cache is unavailable.
 */
function isDuplicate_(eventId) {
  if (!eventId) return false;
  var cache = CacheService.getScriptCache();
  if (cache.get('ev:' + eventId)) return true;
  cache.put('ev:' + eventId, '1', DEDUPE_TTL_SEC);
  return false;
}

function textOut_(body) {
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}
