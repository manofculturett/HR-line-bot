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
   | `LINE_CHANNEL_ID` | channel id (for building URLs / debugging) |

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
| `Code.gs` | `doPost` / `doGet`, secret check, dedupe, routing |
| `config.gs` | Script Properties + `Config` tab parsing |
| `line.gs` | LINE API calls: reply, push, rich menus |
| `sheets.gs` | Spreadsheet access, `LockService`, append-only writes |
| `attendance.gs` | Punch logic and late/on-time classification |
| `registration.gs` | Link-code registration state machine |
| `triggers.gs` | Installable triggers: 09:15 digest (workday + on/off gated) |
| `messages.gs` | All Thai user-facing copy (constants — never model-generated) |
| `diagnostics.gs` | `selfTest` — one-click "is it actually working?" (read-only) |

## Sandbox vs production

Keep two spreadsheets (a test one and the real one) and two LINE channels if you can —
`SHEET_ID` is a Script Property, so switching is a one-line change and no code edit.
