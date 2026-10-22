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

### Registration — one-time invite code

A LINE account proves nothing about who the person is. HR types the roster once and hands each
person a 6-char `link_code`; the employee sends their employee id then the code, and the row
stores their `line_user_id` and clears the code (single use). The reply is identical for
"unknown id" and "wrong code" so the roster can't be probed. Re-binding is HR-only.

### The HR console — Google Sheets

`HR_MAIN` A:F is a live view of today: one row per active employee with in/out times and a
`ตรงเวลา / สาย / ยังไม่เข้างาน` status, colour-coded. `B1` is the missing-staff list; `B2` is
last activity. All formulas — no script writer and **no trigger**; the sheet recalculates on
every punch write and on open. The 09:15 digest email goes to `HR_EMAIL`, gated by
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
│   ├── registration.gs    # one-time-link-code flow + abuse controls
│   ├── triggers.gs        # dailyDigest (09:15, workday + on/off gated), installTriggers
│   ├── messages.gs        # ALL Thai user-facing copy (fixed constants)
│   └── diagnostics.gs     # selfTest — one-click "is it actually working?"
├── sheet/                 # the HR console, documented as it lives in the spreadsheet
│   ├── README.md          # the live sheet: id, tabs, columns, sharing, timezone
│   └── dashboard.md       # the HR_MAIN formulas + conditional formatting + gotchas
├── scripts/               # local tooling (run with uv, see below)
│   ├── make_richmenu.py   # generate the LINE rich-menu PNGs
│   ├── setup_dashboard.py # (re)apply the HR_MAIN formulas for N employees
│   └── audit_sheet.py     # verify the live sheet against this README
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
cd apps-script
clasp push                        # upload the .gs files
clasp deploy --description "..."   # publish a new version to the web app URL
clasp deployments                  # list deployments
```
> **Deploy trap:** the `/exec` URL is bound to a **deployment**. After `clasp push` you must
> `clasp deploy` (or redeploy the same id) or the webhook keeps hitting the old code.

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
Run `installTriggers()` **once** from the editor to schedule the 09:15 digest (and drop any
stale trigger).

### Verify it works (don't trust the "Verify" button)
The LINE console's "Verify" only checks for a 2xx — it passes even when the script is broken.
Use the real checks:

1. **`selfTest()`** — editor → function dropdown → `selfTest` → Run; read the Executions log.
   It checks the five things that silently break this bot (properties, sheet, config, LINE
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
uv run --with pillow python3 scripts/make_richmenu.py
```
> On this machine `uv` lives at `~/.hermes/tools/uv-0.12.3-darwin-x64/uv`.

---

## The sheet

One spreadsheet — **`Customer`**, id `1Ek-vacbfgWq11I2WhLvz6yc5WAD7IFojXRnnGVd0i-4`, timezone
`Asia/Bangkok`. Three tabs:

| Tab | Blocks | Who writes |
|---|---|---|
| `HR_MAIN` | dashboard `A:F` (formulas) + CONFIG `T:U` | formulas only; HR edits CONFIG |
| `EMPLOYEES_LOG` | roster `A:H` | HR, plus the script on registration |
| `DATA` | punches `A:E`, log `H:L`, errors `N:P` | script only |

Because three blocks share `DATA`, appends are **block-aware** (`appendToBlock_`), never
`Sheet.appendRow()` — that would append at the bottom of the whole sheet and scatter them. The
punch ledger is **append-only** — a correction is a new row, never an edit, so any day can be
reconstructed. Full column-by-column detail in [sheet/README.md](sheet/README.md).

### CONFIG (`HR_MAIN` T:U) — HR edits these; no redeploy

| key | value |
|---|---|
| `TZ` | `Asia/Bangkok` |
| `WORK_START` | `09:00` |
| `LATE_GRACE_MIN` | `5` |
| `WORK_END` | `18:00` |
| `WORK_DAYS` | `MON,TUE,WED,THU,FRI` — the digest sends **only** on these days |
| `HR_EMAIL` | where the 09:15 digest goes |
| `DIGEST_TIME` | `09:15` |
| `EMAIL_ENABLED` | `TRUE`/`FALSE` — turns the digest on/off |

Scanned, not read from fixed cells, so HR may add or reorder rows. Column `U` is plain text
(otherwise Sheets parses `09:00` into a time and `getValues()` returns a `Date`).

---

## Security & privacy

| Concern | Control |
|---|---|
| Who can POST to `/exec` | secret query param `?k=` |
| Who can punch | only a `source.userId` bound to an `EMPLOYEES_LOG` row |
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

**Live, stable, and free.** The Apps Script Web App is deployed (2 deployments; the LINE
webhook is bound to the live version) and the health endpoint answers correctly. Registration
and the punch flow run end-to-end against the live `Customer` sheet; the HR dashboard is live
and audited clean. No server to keep alive and nothing hosted — no downtime, ฿0/month.

**Verified 2026-10-18** against the live deployment and sheet:

- `clasp deployments` → 2 deployments; health check (`/exec?k=wrong`) → correct
  `{"ok":false,"error":"unauthorized"}` body.
- Dashboard audited clean: no formula errors, 200 employee rows provisioned, named ranges
  `WORK_START` / `LATE_GRACE_MIN` present.
- CONFIG as listed above; **`EMAIL_ENABLED=FALSE`** (digest currently off).

**Two things left before real use:**

1. **Sample rows are still in the sheet.** `EMPLOYEES_LOG` and `DATA` still hold test entries
   (marked `ตัวอย่าง` / `SAMPLE`), so the dashboard shows fake attendance. Delete **only** rows
   with an empty `line_user_id` — a roster row that is `linked` is a real binding; keep it and
   its punches.
2. **The digest is switched off** (`EMAIL_ENABLED=FALSE`). Set it `TRUE` when HR wants the 09:15
   email, and confirm the `dailyDigest` trigger is installed by running `installTriggers()` once
   from the editor.

**Not built:** the forgot-to-check-out report, a quota guard, and a 09:00 load test.

**Open decisions:** anti-cheat model (honour system vs PIN / office QR / WiFi / LIFF GPS), and
whether this is the system of record for payroll or a convenience front-end.
