/**
 * line.gs — everything that talks to the LINE Messaging API.
 *
 * Cost rule (LINE for Business TH, Free plan = 300 push msgs/month):
 *   reply  → free, unlimited, needs a fresh replyToken (valid 1 min, single use)
 *   push   → counts against the monthly quota
 * Always prefer reply_(); use push_() only for the fallback and the optional HR alert.
 */

var LINE_API = 'https://api.line.me/v2/bot';
var LINE_TIMEOUT_MS = 5000;

function authHeaders_() {
  return {
    'Authorization': 'Bearer ' + secret_('LINE_CHANNEL_ACCESS_TOKEN'),
    'Content-Type': 'application/json'
  };
}

/**
 * Free. The replyToken comes from the event and expires in 1 minute.
 * `content` is plain text, or an array of LINE message objects (e.g. a buttons template).
 */
function reply_(replyToken, content) {
  if (!replyToken) throw new Error('reply_ called without a replyToken');
  var messages = (typeof content === 'string') ? [{ type: 'text', text: content }] : content;
  var res = UrlFetchApp.fetch(LINE_API + '/message/reply', {
    method: 'post',
    headers: authHeaders_(),
    payload: JSON.stringify({ replyToken: replyToken, messages: messages }),
    muteHttpExceptions: true,
    timeout: LINE_TIMEOUT_MS
  });
  var code = res.getResponseCode();
  if (code !== 200) throw new Error('reply failed ' + code + ': ' + res.getContentText());
  return true;
}

/**
 * A one-button message that opens a URL. The button is the point: a bare URL in a chat
 * bubble is a blue string people hesitate to tap. `altText` is what notifications and old
 * clients show, so it carries the full sentence including the URL.
 */
function linkButton_(text, label, url, altText) {
  return [{
    type: 'template',
    altText: altText,
    template: { type: 'buttons', text: text,
                actions: [{ type: 'uri', label: label, uri: url }] }
  }];
}

/** Costs one message from the monthly quota. Fallback for an expired reply token. */
function push_(userId, text) {
  var res = UrlFetchApp.fetch(LINE_API + '/message/push', {
    method: 'post',
    headers: authHeaders_(),
    payload: JSON.stringify({ to: userId, messages: [{ type: 'text', text: text }] }),
    muteHttpExceptions: true,
    timeout: LINE_TIMEOUT_MS
  });
  var code = res.getResponseCode();
  if (code !== 200) throw new Error('push failed ' + code + ': ' + res.getContentText());
  return true;
}

/**
 * Answer with the reply token, fall back to a push if it has expired.
 * An employee must never be left unsure whether a punch landed.
 */
function answer_(userId, replyToken, text) {
  try {
    return reply_(replyToken, text);
  } catch (err) {
    console.warn('reply_ failed, falling back to push_: ' + err);
    logEvent_('', userId, 'push_fallback', String(err));
    return push_(userId, text);
  }
}

/* ---- rich menus ----
 *
 * The two menus are built in LINE's own OA Manager (visual designer, handles Thai text
 * and the button grid) and their ids stored in Script Properties. The code only assigns
 * the right one per user, which is the part worth automating.
 *
 *   RICHMENU_REGISTERED    → the punch menu
 *   RICHMENU_UNREGISTERED  → the ลงทะเบียน menu
 *
 * Every call here is best-effort: if the ids are not set yet, a punch must still work.
 * Postback actions cost nothing and count against no quota.
 */

function richMenuId_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || null;
}

/** Assign a menu to one user. Silent no-op when the menu id is unset. */
function attachMenu_(userId, menuKey) {
  var id = richMenuId_(menuKey);
  if (!userId || !id) { console.log('attachMenu_: ' + menuKey + ' not configured, skipped'); return false; }
  try {
    var res = UrlFetchApp.fetch(
      LINE_API + '/user/' + encodeURIComponent(userId) + '/richmenu/' + encodeURIComponent(id),
      { method: 'post', headers: authHeaders_(), muteHttpExceptions: true, timeout: LINE_TIMEOUT_MS });
    if (res.getResponseCode() !== 200) {
      console.warn('attachMenu_ ' + res.getResponseCode() + ': ' + res.getContentText());
      return false;
    }
    return true;
  } catch (err) {
    console.warn('attachMenu_ failed: ' + err);
    return false;
  }
}

/** Diagnostic: list the menus that exist on the channel, with their ids. */
function listRichMenus_() {
  var res = UrlFetchApp.fetch(LINE_API + '/richmenu/list',
    { headers: authHeaders_(), muteHttpExceptions: true, timeout: LINE_TIMEOUT_MS });
  if (res.getResponseCode() !== 200) throw new Error('richmenu/list ' + res.getResponseCode());
  return JSON.parse(res.getContentText()).richmenus || [];
}
