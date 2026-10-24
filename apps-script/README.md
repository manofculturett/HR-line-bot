# apps-script — the bot backend

Google Apps Script project. This is the whole server: LINE's webhook lands on `doPost`,
and it reads/writes the HR spreadsheet.

Read [`../README.md`](../README.md) first — especially **The two Apps Script sharp edges**
(the signature problem and the 302 redirect). Both shape the code here.

## Setup

1. **Create the project**
   ```bash
   npm install -g @google/clasp
   clasp login
   clasp create --type webapp --title "HR-line-bot" --rootDir .
   ```
   Then copy `.clasp.json.example` → `.clasp.json` and paste your `scriptId`
   (or let `clasp create` write it).

2. **Script Properties** — Project Settings → Script Properties. Never commit these:
   | Key | Value |
   |---|---|
   | `LINE_CHANNEL_ACCESS_TOKEN` | Messaging API channel access token (long-lived) |
   | `WEBHOOK_SECRET` | random string; also goes in the webhook URL as `?k=` |
   | `SHEET_ID` | `1Ek-vacbfgWq11I2WhLvz6yc5WAD7IFojXRnnGVd0i-4` (the `Customer` sheet) |
   | `LINE_CHANNEL_ID` | **Messaging API** channel id (for building URLs / debugging) |
   | `LIFF_ID` | LIFF app id, `1234567890-AbCdEfgh` (LIFF tab of the LINE Login channel) |
   | `LIFF_CHANNEL_ID` | **LINE Login** channel id — the `client_id` used to verify ID tokens |

   ⚠️ `LINE_CHANNEL_ID` and `LIFF_CHANNEL_ID` are different channels and are not
   interchangeable. A LIFF app cannot be added to a Messaging API channel any more, so the
   Login channel is separate; the ID-token check fails with the wrong id.

3. **Deploy as a web app**
   ```bash
   clasp push
   clasp deploy --description "v1"
   ```
   - Execute as: **Me**
   - Who has access: **Anyone** (manifest sets `ANYONE_ANONYMOUS`)

4. **Bind the webhook** — LINE Developers Console → your Messaging API channel →
   Messaging API settings → Webhook URL:
   ```
   https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec?k=<WEBHOOK_SECRET>
   ```
   Then press **Verify**. ⚠️ Verify only checks for a 2xx — it passes even when the
   script is broken. Use the manual check below instead.

5. **Install triggers** — run `installTriggers()` once from the editor.

6. **LIFF check-in** — see the section below. Optional: the menu buttons work without it.

## LIFF check-in

The LIFF page is [`../docs/liff/index.html`](../docs/liff/index.html), served by GitHub
Pages at the URL you register as the LIFF **Endpoint URL**. It runs inside LINE, reads the
device location, and posts it here with an ID token.

Why it is not hosted here: an Apps Script web app's HTML executes inside an iframe at
`*.googleusercontent.com`, so `liff.init()` fails with *"called with a current URL that is
not related to the endpoint URL"* and LINE's login screen refuses to be framed. Static
hosting is required — do not move the page into HtmlService.

### Console steps (once)

1. LINE Developers Console → **same provider** as the OA → create a **LINE Login** channel
   (app type *Web app*). A LIFF app cannot be added to a Messaging API channel.
2. That channel → **LIFF** tab → Add:
   - Endpoint URL: `https://<user>.github.io/HR-line-bot/liff/` (exact path, HTTPS)
   - Size: Full · Scopes: `openid`, `profile`
3. **Publish** the LINE Login channel. While it is *Developing* only admins and testers
   can open the LIFF URL and everyone else gets a 404.
4. Basic settings → **Linked OA** → link the LINE Official Account.
5. Put `LIFF_ID` and `LIFF_CHANNEL_ID` in Script Properties (table above).
6. Paste the same LIFF id and this project's `/exec` URL into the two constants at the top
   of `docs/liff/index.html`, commit, and let Pages redeploy.
7. Rich menu → **only the two actions that need a location become URL actions**:

   | button | action type | why |
   |---|---|---|
   | เข้างาน | URL → `https://liff.line.me/<LIFF_ID>` | punch in, with the location check |
   | เลิกงาน | URL → `https://liff.line.me/<LIFF_ID>` | punch out, with the location check |
   | ลงทะเบียน | keep as postback / text | registration is a chat state machine; it needs no location and the page cannot do it |
   | สถานะของฉัน | keep as postback | instant reply in the chat — and the LIFF page shows the same summary in its own panel |

   Both location buttons point at the same page, which shows the two punches plus a
   read-only "สถานะวันนี้" panel (action `me:today`, the same token the menu button sends;
   it writes nothing). Check-out gets the same treatment as check-in on purpose: the hours
   on the dashboard come from the `out` row, so verifying only the morning verifies only
   half the day.

   **The chat path is closed.** `PUNCH_REQUIRE_GEO=TRUE` (default) makes a postback or a
   typed word answer with a link to the LIFF page instead of recording a punch — otherwise the
   location check is advisory and anyone can type "เข้างาน" from anywhere. It closes the
   *channel*, not the fix: a phone that refuses to give a position still punches **from the
   page** and is recorded as `no_fix`. Set the key to `FALSE` in the CONFIG block to reopen the
   chat path without a redeploy; those punches then record `source=line` and are visibly
   unverified in `DATA!D`.

### What the server does with a LIFF request

`doPost` sees a body with `idToken` and takes route 1: verify the token at
`api.line.me/oauth2/v2.1/verify`, map `sub` → `EMPLOYEES_LOG`, classify the position in
`geo.gs`, then run the same `punchIn_` / `punchOut_` the buttons use — with a `geo`
argument that adds `source=liff-geo`, a note like `geo:far 1200m`, and a row in `DATA!S:Z`.

`GEO_MODE` in `HR_MAIN!T:U` decides what a failed check does: `OFF` (default) records only,
`WARN` also tells the employee, `BLOCK` refuses the punch.

### Verifying it without deploying

```bash
# wrong/absent token → unauthorized, and nothing is written
curl -sL "https://script.google.com/macros/s/<ID>/exec" \
  -H 'Content-Type: text/plain' -d '{"idToken":"x","action":"in"}'
# → {"ok":false,"error":"unauthorized","text":"…"}

# JSONP fallback (what the page uses when fetch is CORS-blocked)
curl -sL "https://script.google.com/macros/s/<ID>/exec?cb=cb&p=%7B%22idToken%22%3A%22x%22%7D"
# → cb({"ok":false,"error":"unauthorized",…})
```

A real end-to-end check needs a phone: open the LIFF URL from the rich menu inside LINE,
tap เข้างาน, and confirm both the reply text and a new `DATA!S:Z` row.

## Manual verification (do not trust the Verify button)

```sh
# 1. Wrong secret must be rejected
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://script.google.com/macros/s/<ID>/exec?k=wrong"

# 2. Correct secret, empty body — should reach doPost and log
curl -s -L "https://script.google.com/macros/s/<ID>/exec?k=$WEBHOOK_SECRET" \
  -H 'Content-Type: application/json' -d '{"events":[]}'

# 3. Then check Executions in the Apps Script editor and the Log tab
```

Note the `-L`: the `/exec` endpoint redirects (302) to `script.googleusercontent.com`,
so without `-L` curl shows the redirect, not the body.

## Files

| File | Owns |
|---|---|
| `Code.gs` | `doPost` / `doGet`, route selection, secret check, dedupe, JSONP |
| `config.gs` | Script Properties, tab/column layout (`TABS`/`BLOCKS`/`COLS`), CONFIG parsing |
| `line.gs` | LINE API calls: reply, push, rich menus |
| `sheets.gs` | Spreadsheet access, `LockService`, append-only writes |
| `attendance.gs` | Punch logic and late/on-time classification |
| `geo.gs` | Distance maths and the location verdict (pure, no I/O) |
| `liff.gs` | LIFF entry point, ID-token verification, geo rows |
| `registration.gs` | Link-code registration state machine |
| `triggers.gs` | Installable triggers: 09:15 digest (workday + on/off gated) |
| `messages.gs` | All Thai user-facing copy (constants — never model-generated) |
| `diagnostics.gs` | `selfTest` — one-click "is it actually working?" (read-only) |

## Sandbox vs production

Keep two spreadsheets (a test one and the real one) and two LINE channels if you can —
`SHEET_ID` is a Script Property, so switching is a one-line change and no code edit.
