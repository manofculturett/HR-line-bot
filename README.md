# HR-line-bot

An attendance system where **employees punch in and out from LINE** and **HR watches a
Google Sheet** — with no server, no hosting bill, and no app to install. Runs entirely on
free tiers: **฿0/month**.

```
Employee's phone (LINE)                    HR's PC (browser)
        │                                        │
        │ taps "เข้างาน" on the rich menu         │ opens the spreadsheet
        ▼                                        ▼
┌──────────────────┐   HTTPS POST    ┌───────────────────────┐
│  LINE Official   │  (webhook)      │    Google Apps Script  │
│  Account         │ ──────────────▶ │    Web App  (/exec)    │
│  (Messaging API) │                 │  verify → route → work │
└──────────────────┘ ◀──── reply ────│  → reply               │
        │            (free)          └───────────┬───────────┘
        ▼                                        │ read / write
   confirmation in the chat          ┌───────────▼───────────┐
                                     │    Google Sheets       │
                                     │  (the HR console AND   │
                                     │       the database)    │
                                     └───────────────────────┘
```

- **Employees** only ever touch LINE, on their phone. They never see a spreadsheet.
- **HR** only ever touches the spreadsheet, on a PC. They never chat with the bot.
- **Apps Script** is the wire between them. Nobody logs into it.

**Stack:** LINE Official Account (Messaging API) → Google Apps Script Web App → Google
Sheets. No server, no hosting bill.

**Status:** live, stable, and free. The Web App is deployed (2 deployments; the LINE webhook
is bound to the live version) and the health endpoint answers correctly. Registration and the
punch flow run end-to-end against the live `Customer` sheet; the HR dashboard is live and
audited clean. No server to keep alive and nothing hosted — no downtime, ฿0/month. Two things
remain before real use — see [Status](#status).

---

## Contents

- [How it works](#how-it-works)
- [The two Apps Script sharp edges](#the-two-apps-script-sharp-edges)
- [Repository layout](#repository-layout)
- [Setup & deploy](#setup--deploy)
- [The sheet](#the-sheet)
- [Security & privacy](#security--privacy)
- [Cost](#cost)
- [Limits & failure modes](#limits--failure-modes)
- [Status](#status)

---

## How it works

### The split — who uses what

| | **Employee** (the app) | **HR** (the console) |
|---|---|---|
| Device | phone, inside LINE | PC, in a browser |
| Entry point | rich-menu buttons in the OA chat | the Google Sheet |
| Does | check in, check out, check own status | watches who's in, manages the roster |
| Sees | only their own data | everyone's data |
| Never does | opens a Sheet, reads a config file | chats with the bot, runs a script |

Everything serves that split. If a feature makes an employee open a browser, or makes HR talk
to the bot, it belongs in the other column.

### The employee app — three taps, no typing

The employee gets a **rich menu**; every button is a **postback** action, answered with a free
reply token. The whole flow is ฿0/month forever, as long as the bot never *pushes*.

| Button | postback data | Behaviour | Reply (free) |
|---|---|---|---|
| **เข้างาน** | `ck:in` | append an `in` row | "เข้างาน 08:57 ✓ สาย 27 นาที" |
| **เลิกงาน** | `ck:out` | close today's open `in` | "เลิกงาน 17:32 ✓ รวม 8 ชม. 35 นาที" |
| **สถานะของฉัน** | `me:today` | read-only | today's in/out + late minutes |

Two explicit buttons (in / out) rather than one toggle — a wrong-direction punch is hard to
notice and painful to clean up. No AI in the punch path: "tap → write a row" is
deterministic, and a check-in that waits on a model call hangs an employee at the door.

> **v2: the menu's two punch buttons are URL actions into the LIFF page, and the postback and
> typed-word paths are refused.** `PUNCH_REQUIRE_GEO=TRUE` (the default) answers a chat punch
> with a link to the page instead of recording one. Without that guard the location check is
> only advisory — anyone can type "เข้างาน" and punch from anywhere. The aliases above still
> exist, so the refusal is a sentence the employee can act on rather than silence. Set
> `PUNCH_REQUIRE_GEO=FALSE` to reopen the chat path (a phone swap, a broken camera); the
> punches then record `source=line` and are visibly unverified.

### What happens on a tap

```
Employee taps "เข้างาน"
        │
        ▼  postback event   data="ck:in"
LINE Platform ──POST──▶ Apps Script Web App (/exec?k=<WEBHOOK_SECRET>)
                          ├─ check ?k  (Apps Script cannot read headers — see Sharp edges)
                          ├─ dedupe webhookEventId (LINE redelivers after the 302)
                          ├─ map LINE userId → employee (EMPLOYEES_LOG)
                          ├─ LockService.getScriptLock()   ← punches race at 09:00
                          ├─ append a punch row to DATA (Asia/Bangkok timestamp)
                          ├─ classify: on-time / late / duplicate / no open punch
                          └─ reply via replyToken:  "เข้างาน 08:57 ✓ สาย 27 นาที"
```

The punch runs **inline** — the reply token lives 1 minute and the sheet append takes 1–3 s,
so deferring it to a trigger would risk the reply window for no gain. Triggers are only for
work with nobody waiting (the 09:15 digest). If the inline reply fails, the code pushes
instead and logs `push_used` — the employee is never left not knowing whether the punch landed.

### The location check — LIFF

A postback event carries no location, so a check-in that can say *where* has to run a page
inside LINE. That is the only reason LIFF exists in this project:

```
rich menu "เข้างาน" (URL action)
  → https://liff.line.me/<LIFF_ID>                    inside LINE
  → docs/liff/index.html, served by GitHub Pages
      liff.init()  →  liff.getIDToken()
      tap          →  navigator.geolocation  (a user action, as LINE requires)
  → POST /exec   { idToken, action, lat, lng, acc }
      verify the token at api.line.me/oauth2/v2.1/verify  → userId
      geoCheck_()  →  ok | far | weak_fix | no_fix
      punchIn_() / punchOut_()   — the same code the menu buttons use
  → text back into the page, plus a row in DATA!S:Z
```

The page shows both punches and a read-only "สถานะวันนี้" panel (action `me:today`, the
same token the rich-menu status button sends — it writes nothing). Only the two punches
carry a location; registration stays a chat flow and the menu's status button still answers
in the chat.

After a successful punch the page also leaves the confirmation **in the chat**
(`liff.sendMessages`, a message from the user — free, not a push) and closes itself, but only
when that receipt actually landed. It needs the `chat_message.write` scope on the LIFF app;
without it the punch still works and the page just stays open.

Trust is split deliberately. **Who** is verified: the ID token is checked server-side, which
is as strong as a signed webhook's `userId` and keeps the `?k=` secret out of public static
hosting. **Where** is self-reported by the phone, so it is evidence, not proof — a
mock-location app defeats it and a WebView cannot detect one. `GEO_MODE=OFF` (the default)
records verdicts and never blocks; a plain menu tap still punches, marked `source=line` and
therefore visibly unverified. The one presence signal a phone cannot fabricate is a LINE
Beacon at the door (available in Thailand) — designed, not built.

The page must stay on static hosting: Apps Script's HTML runs inside an iframe at
`*.googleusercontent.com`, where `liff.init()` refuses the page. Setup lives in
[apps-script/README.md](apps-script/README.md#liff-check-in).

### When someone forgets to check out

A forgotten check-out leaves an `in` with no `out`. Two things must not happen: the day must
not keep **no hours**, and nobody may invent the missing time. So nothing guesses — and
nothing is left open for ever either.

| Who | When | What they get |
|---|---|---|
| the employee | at the next check-in | `⚠️ ยังไม่ได้ลงเวลาเลิกงานของวันที่ …` + the note `forgot_out YYYY-MM-DD` on the new row |
| HR | 05:00 the next morning | an email listing what needs review — exception-only, gated by `EMAIL_ENABLED` + `HR_EMAIL` exactly like the digest |
| nobody | 05:00, once the day is `AUTO_CLOSE_DAYS` old (default `3`) | **self-heal**: the day is closed at `WORK_END` with `source=auto_close`, and reported in that morning's email |
| HR | any time they look | `HR_MAIN!B3 ค้างเลิกงาน`, which keeps naming the person until the day is closed |

The two human paths write the real time, as one `out` row dated to **that day** — the original
`in` is never edited:

- **HR** sets `FIX_EMP_ID` / `FIX_DATE` / `FIX_TIME` in Script Properties and runs `hrFixDay` from
  the editor (`source=hr_fix`). The editor's **Run** button passes no arguments, so the values
  cannot be typed into the call — they are consumed and cleared on success, and kept on a
  failure so one wrong value can be corrected.
- **The employee** reports the time on the LIFF page, which shows a *ลืมลงเวลาเลิกงาน?* card
  only when a day is actually open (`source=self_report`, within `SELF_REPORT_DAYS`). The
  next 05:00 email repeats every self-reported time so HR can accept or query it.

**The two things a "close" cannot fix** (v2.5). A day can be wrong in a way that has no open
shift to close, so both are separate corrections — HR-only, both append-only:

- **Nobody punched in at all.** `hrFixIn()` (same `FIX_EMP_ID` / `FIX_DATE` / `FIX_TIME`
  properties) appends the check-in, `source=hr_fix`, note `forgot_in … added by HR`. It is
  refused if that day already has a check-in — the sheet shows a day's *first* `in`, and two
  candidates would be ambiguous. If the day has no `out` either it stays open, and the result
  says so.
- **The check-out was a mis-tap** (out at noon). `hrFixDay()` with the real, **later** time
  appends a second `out`, note `corrected_out … (was 12:00)`. The sheet reads the day's last
  `out` (`MAX`), so the later row wins and the hours change everywhere at once. An **earlier**
  time is refused with the recorded one, because it could not change what the sheet shows —
  and removing a too-late check-out would mean editing history.

An employee can close their own forgotten day but **cannot claim a punch that never happened**:
a claimed check-in is exactly what the location check exists to prevent.

**The fallback, and why it is not a guess.** A day nobody confirms used to stay open for ever:
a Friday shift forgotten before a weekend had no hours, no row, and — the moment the employee
worked a normal Monday — not even a warning. Now the 05:00 sweep closes any day that has been
open for `AUTO_CLOSE_DAYS` at `WORK_END` **on that day**, the shift end the company declared in
CONFIG. It is written with its own `source=auto_close` and the note
`auto_close YYYY-MM-DD HH:mm scheduled_end`, so it can never be mistaken for an observation,
and the email states plainly that the time is the shift end and needs confirming. A Friday
forgotten shift is therefore closed on Monday at 05:00, before the new week starts.

The `auto_close` row is a **placeholder, not history**: when the employee or HR later supplies
the real time, that row is *replaced in place* (`replaced auto_close` in the note) rather than
appended beside it — a second `out` would leave the dashboard's `MAX(...)` preferring the later
placeholder over the earlier truth. `AUTO_CLOSE_DAYS=0` switches the fallback off.

The sweep fills in a number; it does not take the day away from the employee. An auto-closed
day **stays in the LIFF picker** for the rest of `SELF_REPORT_DAYS`, labelled
`(ปิดอัตโนมัติ 18:00)`, so a person who remembers the real time later can still correct it —
which is why the two windows can differ (`3` and `7`) without contradicting each other.

Two limits are deliberate. A day whose check-in is at or after `WORK_END` is never auto-closed
(there is no defensible shift end for it) — it stays open and stays in the email. And detection
pairs a check-out only with a check-in from the previous `MAX_SHIFT_HOURS` (24 h): a Monday
check-out cannot "close" a Friday check-in, which is how a forgotten day used to disappear the
moment the person worked normally again. An overnight shift (in 22:00, out 02:00) is well
inside that window.

### Registration — one-time invite code

A LINE account proves nothing about who the person is. HR types the roster once and hands each
person a 6-char `link_code`; the employee sends their employee id then the code, and the row
stores their `line_user_id` and clears the code (single use). The reply is identical for
"unknown id" and "wrong code" so the roster can't be probed. Re-binding is HR-only.

### The HR console — Google Sheets

`HR_MAIN` A:H is a live view of today: one row per active employee with in/out times, a
`ตรงเวลา / สาย / ยังไม่เข้างาน` status chip, a left-early flag and hours worked, plus a summary
panel — who has not checked in (`B1`), the latest punch (`B2`), who never checked out on an
earlier day (`B3`) — and a today panel (`F1:G3`: date, checked-in `n / total`, late count).
All formulas — no script writer and **no trigger**; the sheet recalculates on
every punch write and on open. The look (fonts, colours, chips, widths) is applied by
`scripts/style_sheet.py`. The 09:15 digest email goes to `HR_EMAIL`, gated by
`EMAIL_ENABLED` and `WORK_DAYS` (no weekend "everyone is missing" email).

---

## The two Apps Script sharp edges

### New to Google Apps Script?

Apps Script is Google's serverless JavaScript runtime inside your Google account — no machine
to provision. Three things it gives you that this project leans on:

1. **A web app** — publish a script as a public HTTPS endpoint; LINE's webhook POSTs there.
   This is the whole backend.
2. **Triggered functions** — schedule a function (the 09:15 digest), no server.
3. **Built-in Google services** — `SpreadsheetApp`, `GmailApp`, `UrlFetchApp`,
   `PropertiesService`, `CacheService`, `LockService` are just available, no SDKs.

Vocabulary: **`/exec`** = the deployed webhook URL (bound to a *deployment*, not the script);
**`doPost(e)`** = the one function Google calls for a POST; **Script Properties** = the
per-project secret store; **clasp** = the CLI that syncs local files to the project.

### The sharp edges that shaped the design

1. **`doPost(e)` cannot read request headers.** LINE's real `X-Line-Signature` is unreadable,
   so HMAC verification is impossible here. The substitute is a shared secret in the URL
   (`?k=`) — good enough for internal attendance, weaker than a signature. The hardening path
   is a Cloudflare Worker relay that verifies the signature and forwards a signed request; it
   was considered and **deliberately dropped** — this project stays on Apps Script only, no
   extra infra.
2. **A POST to `/exec` answers with a 302** to `script.googleusercontent.com`. LINE may treat
   a 3xx as failure and **retry** — so webhook handling must be **idempotent** (this code
   dedupes on `webhookEventId`). `HtmlService.createHtmlOutput()` is the known way to suppress
   the redirect, but verify it against LINE's delivery log before trusting it.

> Query params `c` and `sid` are reserved by Apps Script — the secret uses `k`, not those.

---

## Repository layout

```
HR-line-bot/
├── README.md              ← you are here (everything)
├── CHANGELOG.md           # what changed in each tagged version (and what is deployed)
├── apps-script/           # the entire backend (a clasp project)
│   ├── README.md          # setup, deploy, webhook binding, manual verification
│   ├── appsscript.json    # manifest: Asia/Bangkok, ANYONE_ANONYMOUS, OAuth scopes
│   ├── .clasp.json        # binds this folder to the live Apps Script project
│   ├── .clasp.json.example
│   ├── Code.gs            # doPost / doGet, secret check, dedupe, routing
│   ├── config.gs          # Script Properties + tabs/columns + CONFIG block
│   ├── line.gs            # reply / push / rich-menu calls to the LINE API
│   ├── sheets.gs          # spreadsheet access, LockService, block-aware appends
│   ├── attendance.gs      # punch logic, on-time / late classification
│   ├── geo.gs             # distance maths + the location verdict (pure, no I/O)
│   ├── liff.gs            # LIFF entry point, ID-token verify, geo rows
│   ├── registration.gs    # one-time-link-code flow + abuse controls
│   ├── triggers.gs        # dailyDigest (09:15, workday + on/off gated), installTriggers
│   ├── messages.gs        # ALL Thai user-facing copy (fixed constants)
│   └── diagnostics.gs     # selfTest — one-click "is it actually working?"
├── sheet/                 # the HR console, documented as it lives in the spreadsheet
│   ├── README.md          # the live sheet: id, tabs, columns, sharing, timezone
│   └── dashboard.md       # the HR_MAIN formulas + conditional formatting + gotchas
├── docs/liff/             # the LIFF check-in page — its URL is the LIFF Endpoint URL
│   └── index.html
├── scripts/               # local tooling (run with uv / node, see below)
│   ├── make_richmenu.py   # generate the LINE rich-menu PNGs
│   ├── setup_dashboard.py # (re)apply the HR_MAIN formulas for N employees
│   ├── style_sheet.py     # (re)apply the sheet's look — formatting only, idempotent
│   ├── audit_sheet.py     # verify the live sheet against this README
│   ├── harness.js         # run the real .gs files against a stubbed Apps Script runtime
│   └── fixtures/seed.json # frozen, anonymized sheet snapshot the harness runs on
└── assets/                # generated rich-menu images
```

The `apps-script/` folder is the source of truth for the backend; `clasp` syncs it up. The live
spreadsheet is the source of truth for the data model; `sheet/` documents it. Deep detail for
each area lives in the sub-README next to the code.

### Module map

| File | Owns |
|---|---|
| `Code.gs` | `doPost`/`doGet`, secret check, dedupe, routing — flow only, no sheet access |
| `config.gs` | Script Properties, tab/column layout (`TABS`/`BLOCKS`/`COLS`), CONFIG parsing |
| `line.gs` | reply, push fallback, rich-menu calls |
| `sheets.gs` | spreadsheet access, `LockService`, block-aware appends, roster lookup |
| `attendance.gs` | punch logic, on-time/late classification, day summary |
| `geo.gs` | haversine + the location verdict — pure functions, no sheet, no network |
| `liff.gs` | LIFF entry point, ID-token verification, geo rows |
| `registration.gs` | link-code state machine |
| `triggers.gs` | `installTriggers()`, the 09:15 digest |
| `messages.gs` | all Thai copy, as constants |
| `diagnostics.gs` | `selfTest` |

Rules: copy never comes from a model; every sheet write goes through `sheets.gs` so the lock
lives in one place.

---

## Setup & deploy

### Prerequisites
- `clasp` (`npm install -g @google/clasp`, then `clasp login`)
- Access to the Apps Script project (`scriptId` is in `apps-script/.clasp.json`)

### Push and deploy
```bash
node ../scripts/harness.js                                   # server logic first — exit 0
cd apps-script
clasp push                                                   # upload the .gs files → HEAD only
clasp create-deployment -i AKfycbzfyow… -d "vX.Y.Z what"     # publish behind the SAME /exec URL
clasp list-deployments                                       # @N must move
```
> **Deploy trap:** the `/exec` URL is bound to a **deployment**. After `clasp push` you must
> redeploy the same id (`-i`) or the webhook keeps hitting the old code — and a deploy
> *without* `-i` mints a new URL that neither the webhook nor the LIFF page points at.

### Secrets (Script Properties)
Apps Script editor → Project Settings → Script Properties. Never in a cell, never in git:

| Key | Value |
|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | Messaging API channel access token (long-lived) |
| `WEBHOOK_SECRET` | random string; also goes in the webhook URL as `?k=` |
| `SHEET_ID` | `1Ek-vacbfgWq11I2WhLvz6yc5WAD7IFojXRnnGVd0i-4` |
| `LINE_CHANNEL_ID` | channel id (for URLs / debugging) |
| `RICHMENU_REGISTERED`, `RICHMENU_UNREGISTERED` | the two rich-menu ids |

### Bind the webhook
LINE Developers Console → Messaging API → Webhook URL:
```
https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec?k=<WEBHOOK_SECRET>
```

### Install triggers
Run `installTriggers()` **once** from the editor to schedule both daily emails — `dailyDigest`
at 09:15 and `forgotOutReport` at 05:00 — and drop any stale trigger (it deletes its own before
creating, so re-running is safe). `selfTest` section [8] reports whether the 05:00 trigger is
actually installed: a report nobody scheduled is invisible otherwise.

### Verify it works (don't trust the "Verify" button)
The LINE console's "Verify" only checks for a 2xx — it passes even when the script is broken.
Use the real checks:

1. **`selfTest()`** — editor → function dropdown → `selfTest` → Run; read the Executions log.
   It checks the seven things that silently break this bot (properties, sheet, config, LINE
   channel, rich menus). Read-only.
2. **Health check** — `curl -sL "https://script.google.com/macros/s/<ID>/exec?k=$WEBHOOK_SECRET"`
   returns `{"ok":true,"role":"hr-line-bot",...}`; a wrong `k` returns
   `{"ok":false,"error":"unauthorized"}`.

### Local tooling (`scripts/`)
Python helpers run from the repo root. They use the Google Sheets API with the Hermes OAuth
token at `~/.hermes/google_token.json`; `uv` pulls the client libraries on demand:
```bash
uv run --with google-api-python-client --with google-auth-oauthlib python3 scripts/audit_sheet.py
uv run --with google-api-python-client --with google-auth-oauthlib python3 scripts/setup_dashboard.py --rows 500
uv run --with google-api-python-client --with google-auth-oauthlib python3 scripts/style_sheet.py
uv run --with pillow python3 scripts/make_richmenu.py
node scripts/harness.js          # server logic, before every clasp push — exit 0 = pass
```
> On this machine `uv` lives at `~/.hermes/tools/uv-0.12.3-darwin-x64/uv`.
> After `setup_dashboard.py --rows N`, re-run `style_sheet.py` (it sizes rules to row 204 —
> change `DASH_LAST` with it).

---

## The sheet

One spreadsheet — **`Customer`**, id `1Ek-vacbfgWq11I2WhLvz6yc5WAD7IFojXRnnGVd0i-4`, timezone
`Asia/Bangkok`. Three tabs:

| Tab | Blocks | Who writes |
|---|---|---|
| `HR_MAIN` | dashboard `A:G` (formulas) + CONFIG `T:U` | formulas only; HR edits CONFIG |
| `EMPLOYEES_LOG` | roster `A:H` | HR, plus the script on registration |
| `DATA` | punches `A:E`, log `H:L`, errors `O:Q`, location `S:Z` | script only |

Because four blocks share `DATA`, appends are **block-aware** (`appendToBlock_`), never
`Sheet.appendRow()` — that would append at the bottom of the whole sheet and scatter them. The
punch ledger is **append-only** — a correction is a new row, never an edit, so any day can be
reconstructed. Full column-by-column detail in [sheet/README.md](sheet/README.md).

### CONFIG (`HR_MAIN` T:U) — HR edits these; no redeploy

| key | value |
|---|---|
| `TZ` | `Asia/Bangkok` |
| `WORK_START` | `09:00` |
| `LATE_GRACE_MIN` | `5` |
| `WORK_END` | `18:00` — the `ออกก่อน` column measures against this |
| `EARLY_GRACE_MIN` | `5` — leaving within this many minutes of `WORK_END` is not flagged |
| `WORK_DAYS` | `MON,TUE,WED,THU,FRI` — the digest sends **only** on these days |
| `HR_EMAIL` | where the 09:15 digest and the 05:00 forgotten check-out report go |
| `DIGEST_TIME` | `09:15` |
| `EMAIL_ENABLED` | `TRUE`/`FALSE` — turns **both** emails on/off (digest and the 05:00 report) |
| `OFFICE_LAT` / `OFFICE_LNG` | the office point the distance is measured from |
| `GEO_RADIUS_M` | `150` — metres from that point that still count as on-site |
| `GEO_MAX_ACC_M` | `150` — a fix worse than this is `weak_fix`, never `far` |
| `GEO_MODE` | `OFF` / `WARN` / `BLOCK` — what a failed check does. Start `OFF` |
| `PUNCH_REQUIRE_GEO` | `TRUE` — only the LIFF page may punch; the chat path is refused |
| `SELF_REPORT_DAYS` | `7` — how far back an employee may close their own forgotten day on the LIFF page. `0` = off, HR only |
| `AUTO_CLOSE_DAYS` | `3` — a day left open this many days is closed at `WORK_END` by the 05:00 sweep (`source=auto_close`). `0` = off (a day then waits for a person) |

Scanned, not read from fixed cells, so HR may add or reorder rows. Column `U` is plain text
(otherwise Sheets parses `09:00` into a time and `getValues()` returns a `Date`). The scan
covers `T4:U28`; rows below the block are reserved, because anything typed in `T` becomes a
config key.

---

## Security & privacy

| Concern | Control |
|---|---|
| Who can POST to `/exec` | secret query param `?k=` |
| Who can punch | only a `source.userId` bound to an `EMPLOYEES_LOG` row |
| Who can post a LIFF punch | a LINE ID token verified server-side against the LINE Login channel |
| Punches from the chat | refused while `PUNCH_REQUIRE_GEO=TRUE`; only the LIFF page punches |
| The LIFF page | public static file — it holds **no** secret; identity comes from the token |
| Double punching | `webhookEventId` dedupe (10 min) + one open `in` per employee per day |
| Concurrent writes | `LockService.getScriptLock()` around every read-modify-write |
| Registration abuse | single-use codes, identical error for unknown/wrong, rate limit 5/hour |
| Re-binding | HR-only, by clearing `line_user_id` |
| Secrets | Script Properties only |
| Sheet sharing | `EMPLOYEES_LOG` + `DATA` are HR-only; staff never get access |
| Logs | `DATA` log block stores no names and no message content |

The `?k=` secret is the only thing gating the endpoint, because Apps Script cannot verify
LINE's signature. **Anyone who learns the URL can forge events** — in the worst case,
fabricated attendance rows and quota-flooding. There is **no data-exfiltration** risk (the
endpoint can't read the sheet back) and user-facing copy is fixed constants, so no message
injection. If the secret ever leaks: regenerate it in Script Properties, update the `?k=` in
the LINE console, and redeploy.

**PDPA.** Attendance is personal data. Keep the Sheet restricted, set a retention rule, keep
names out of the log block, and keep secrets in Script Properties. This design makes no LLM
call at all, so no personal data ever leaves Google.

---

## Cost

| Item | Cost |
|---|---|
| LINE OA **Free** plan | ฿0 — replies and rich-menu taps are **free**; only *push* counts (TH free = 300 msgs/month) |
| Apps Script | ฿0 (no hosting) |
| Gmail digest | ฿0 |
| LIFF app + LINE Login channel | ฿0 — no review, no MAU fee |
| GitHub Pages (the LIFF page) | ฿0 |
| **Total** | **฿0/month** |

The design answers **every** employee action with a *reply* (free, unlimited) and only
*pushes* as a fallback — and sends the HR alert by **email**, not LINE push. The one thing that
would cost money is pushing, so the design avoids it.

---

## Limits & failure modes

| Limit | Consumer (Gmail) | Workspace |
|---|---|---|
| Script runtime / execution | 6 min | 6 min |
| Trigger runtime / day | 90 min | 6 hr |
| UrlFetch calls / day | 20,000 | 100,000 |
| Triggers / script | 20 | 20 |
| Simultaneous executions | 30 | 30 |

| Failure | Symptom | Mitigation |
|---|---|---|
| `/exec` not `ANYONE_ANONYMOUS` | LINE gets a login page | set it in the manifest + deployment |
| Wrong deployment served | old code runs after a push | always redeploy; keep the deployment id |
| LINE retries after the 302 | duplicate rows | `webhookEventId` dedupe |
| Two people punch at 09:00:00 | interleaved writes | `LockService` |
| Reply token expired | employee sees nothing | push fallback + log |
| Apps Script cold start | replies take 3–5 s | acceptable for a punch |
| Quota hit | script throws | keep triggers rare; watch the `DATA` error block |
| Sheet timezone not `Asia/Bangkok` | punches look 7 h off | set both timezones |
| Employee blocks the OA | push fails silently | mark `blocked`; HR sees it on the dashboard |

---

## Status

**v2.3.0 — live, in production use, and ฿0/month.** Deployment `AKfycbzfyow…@20`; the `/exec`
URL is unchanged by design (`clasp create-deployment -i <deploymentId>` redeploys the same id — a
plain deploy would mint a new URL and leave the LIFF page and webhook pointing at the old
code). The Apps Script Web App is deployed (the
LINE webhook is bound to the live deployment) and the health endpoint answers. Registration,
the punch flow and the LIFF location check all run end-to-end against the live `Customer`
sheet; the HR dashboard is audited clean. No server to keep alive, nothing hosted except one
static page — no downtime, no bill.

**v2.4.0 is partly live.** The sheet restyle, hours column and today panel are applied to the
live spreadsheet. The Apps Script code is pushed to HEAD but **not deployed** — run
`clasp create-deployment -i AKfycbzfyow… -d "v2.4.0"` and confirm the health check reports
`"v2.4.0"`. The redesigned LIFF page goes live on `git push` and works against either server
version. See [CHANGELOG](CHANGELOG.md#v240--2026-10-28).

**Verified 2026-10-23** against the live deployment and sheet:

- Two deployments; the webhook points at the live one. A wrong `?k=` returns
  `{"ok":false,"error":"unauthorized"}`; the health check (with the real secret) reports the
  deployed version (`"v2.2.1"` as of 2026-10-27), which is how a stale deployment is spotted.
- The LIFF path ran end-to-end from a phone: check-in `12:05` and check-out `16:01`, both
  `source=liff-geo`, `verdict=ok`, 16 m from the office, with `early 119m` on the out row.
- Dashboard clean: no formula errors, 200 employee rows provisioned, named ranges
  `WORK_START` / `LATE_GRACE_MIN` / `WORK_END` / `EARLY_GRACE_MIN`; `B1` reads
  `เข้างานครบทุกคน ✅` when nobody is missing, `B2` ignores future-dated rows.
- No sample data left. `audit_sheet.py` → "none".
- CONFIG as listed above; **`EMAIL_ENABLED=FALSE`** (digest off).

**One thing left before real use:** both emails are switched off (`EMAIL_ENABLED=FALSE`). Set it
to `TRUE` when HR wants the 09:15 digest and the 05:00 forgotten check-out report, and run
`installTriggers()` once from the editor so both triggers exist.

**Shipped in v2:** LIFF check-in/out with the location verdict (`DATA!S:Z`), the read-only
"สถานะวันนี้" panel on the page, the `ออกก่อน` column, the `early Nm` ledger note, hardened
`B1`/`B2`, block columns aligned with the live sheet, dead code removed, and `selfTest`
extended to cover the LIFF path.

**Shipped in v2.2.0:** the forgotten check-out is now surfaced instead of silently rotting —
`HR_MAIN!B3` names whoever is stuck open, the check-in reply warns them, a 05:00 email tells HR
(exception-only, `EMAIL_ENABLED`-gated), and the day is closed by a human decision through
`hrFixDay()` or the employee's own report on the LIFF page. `openDaysByEmployee_` is the single
definition of "dangling day" that all of them read. See
[When someone forgets to check out](#when-someone-forgets-to-check-out).

**Shipped in v2.3.0:** the forgotten check-out now heals itself instead of hanging. The 05:00
run closes any day left open for `AUTO_CLOSE_DAYS` at `WORK_END` (`source=auto_close`, a
placeholder a confirmed time replaces in place), and the email was rewritten as a formal Thai
report with Buddhist-era dates and a section per case. Detection also stopped losing a
forgotten day when the employee later worked a normal one (`MAX_SHIFT_HOURS` pairing). See
[When someone forgets to check out](#when-someone-forgets-to-check-out).

**Not built:** a LINE-push reminder for an open shift on the same evening (email is free, a
push costs quota), a quota guard, the 09:00 load test, and a PDPA retention job for `DATA!S:Z`
(the sheet keeps coordinates forever until something deletes them — 90 days is the suggested
rule).

**Known limits of the fix paths:** an overnight shift (in 22:00, out 02:00) cannot be closed by
`hrFixDay`/self-report, because the one-pair-per-day rule keys on the calendar date and the fix
must be late enough to follow the check-in — such a day needs a manual row. (Confirmed: this
team works day shifts only, so the one-pair-per-day rule stands.) A check-out that is too
**late** cannot be corrected by any path — a correction may only move it forward, since the
sheet reads the last `out`. `HR_MAIN!B3` is a
*latest-punch* test while the bot's own detector is a per-day pairing, so in the narrow case
"an older day is dangling **and** a later day closed normally", B3 stays quiet while the 05:00
report still lists the day; making B3 per-day needs a formula change in the live sheet
(`sheet/dashboard.md`).

**Open decisions:** whether to move `GEO_MODE` from `OFF` to `WARN` after two weeks of
shadow data; whether to add a LINE Beacon at the door (the only presence signal a phone
cannot fabricate, and available in Thailand); and whether this is the system of record
for payroll or a convenience front-end.
