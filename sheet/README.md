# sheet — the HR console (live)

The spreadsheet is both HR's screen and the database. This folder documents the layout
**as it exists**, so it can be rebuilt or handed to HR without guessing.

## The live spreadsheet

| | |
|---|---|
| Name | `Customer` |
| Id | `1Ek-vacbfgWq11I2WhLvz6yc5WAD7IFojXRnnGVd0i-4` |
| Owner | `tartan.tat@gmail.com` |
| Timezone | `Asia/Bangkok` ✅ |
| Locale | `en_US` |
| Sharing | owner only — **keep it that way** |

Put the id in the Apps Script Script Property `SHEET_ID` (see `../apps-script/README.md`).

## Tabs

| Tab | Holds | Who touches it |
|---|---|---|
| `HR_MAIN` | HR's dashboard (A:G) **and** the CONFIG block (T:U) | HR reads and edits; formulas only — the script writes nothing |
| `EMPLOYEES_LOG` | the roster, A:H | HR edits — **contains credentials, HR-only** |
| `DATA` | four append-only blocks: punches A:E, log H:L, errors O:Q, location checks S:Z | machine writes, HR reads |

There is no separate Config/Log/Error tab — those live inside `HR_MAIN` and `DATA` to
match the three tabs already in the spreadsheet.

## `HR_MAIN`

```
        A              B  (B:E merged)                F              G  (G:H merged)
1   ยังไม่เข้างาน    <formula>  ← missing list       วันที่          28 ต.ค. 2569
2   อัปเดตล่าสุด     <formula>  ← latest punch       เข้างานแล้ว     3 / 5
3   ค้างเลิกงาน     <formula>  ← earlier open day    มาสาย          1
4   id     พนักงาน     แผนก     เข้างาน   เลิกงาน   สถานะ     ออกก่อน    ชั่วโมง   ← header (frozen)
5   A0123  สมชาย       ขาย      08:57     17:32     ตรงเวลา              8:35
…   (formulas, rows 5–204)

                                         T              U                V
4                                        key            value            คำอธิบาย
5                                        TZ             Asia/Bangkok     (what the key does, in Thai)
6                                        WORK_START     09:00        ← named range
7                                        LATE_GRACE_MIN  0           ← named range
8                                        WORK_END       18:00
9                                        WORK_DAYS      MON,TUE,WED,THU,FRI
10                                       HR_EMAIL       (your address)
11                                       DIGEST_TIME    09:15
12                                       EMAIL_ENABLED  TRUE          ← FALSE stops BOTH emails
13                                       OFFICE_LAT     13.7563       ← location check (v2)
14                                       OFFICE_LNG     100.5018
15                                       GEO_RADIUS_M   150
16                                       GEO_MAX_ACC_M  150
17                                       GEO_MODE       OFF           ← OFF | WARN | BLOCK
18                                       EARLY_GRACE_MIN 5            ← named range; flag if out earlier than WORK_END−5m
19                                       PUNCH_REQUIRE_GEO TRUE       ← FALSE reopens typed/postback punches
20                                       SELF_REPORT_DAYS 7           ← v2.2; 0 = only HR may close a day
21                                       AUTO_CLOSE_DAYS 3            ← v2.3; close at WORK_END after 3 days, 0 = off
```

- Dashboard rows 5–204 are **formulas only** — see [`dashboard.md`](dashboard.md).
- Column **H (`ชั่วโมง`)** is hours worked today, first in → last out (`8:35`).
- **`V` describes each CONFIG key in Thai.** Nothing reads it; `scripts/style_sheet.py`
  writes it by matching the key, so re-run that script after adding a key.
- The look — Sarabun, header bars, chips, widths, warning-only protection on `A1:H204` and on
  `DATA` — is applied by `scripts/style_sheet.py`. It is formatting only and idempotent; it
  never moves a column (the DATA/CONFIG offsets in `config.gs` are load-bearing).
- Column **G (`ออกก่อน`)** flags an early check-out, e.g. `ก่อน 119 น.`. It never blocks
  anything: leaving early is allowed and is only made visible to HR.
- **`B3` lists anyone who never checked out on an earlier day.** It counts punches *before*
  today, so an open shift in progress does not appear there. It clears when an `out` for that
  day is appended — `hrFixDay()` (HR), the employee's own report on the LIFF page, or the
  05:00 `auto_close` sweep (see `AUTO_CLOSE_DAYS`) — and on nothing else: no job invents a
  time, it uses `WORK_END` and says so. The 05:00 email is the alert; `B3` is the state.
  `B3` is a *latest-punch* test, so it goes quiet when an older day is dangling but a later day
  closed normally — the emailed report still lists that day.
- CONFIG is a plain key/value block. The script **scans** it, so HR can add or reorder
  rows freely. Named ranges `WORK_START` and `LATE_GRACE_MIN` point at `U6` and `U7`.
- `U` is formatted as **plain text** — otherwise Sheets parses `09:00` into a time value
  and the script sees a date instead of `"09:00"`.
- The scan is **last-row-wins** for a duplicated key. If a value looks ignored, look for a
  second row with the same key further down.
- The geo keys (13–17) arrived in v2 and may be absent — missing keys fall back to the
  defaults in `config.gs`, where `GEO_MODE` is `OFF` (shadow mode).

## `EMPLOYEES_LOG` (A:H)

| col | field | notes |
|---|---|---|
| A | `id` | employee code, e.g. `A0123` — what the employee types at registration |
| B | `name` | shown back to the employee on successful registration |
| C | `dept` | same |
| D | `link_code` | **one-time secret** HR hands out; the bot clears it on success |
| E | `line_user_id` | filled by the bot; blank = not registered |
| F | `link_status` | `pending` / `linked` / `blocked` |
| G | `active` | `TRUE`/`FALSE`; `FALSE` removes them from the dashboard and the digest |
| H | `note` | free text for HR |

As of v2.2.0 the roster holds one **linked test employee** (`A0124`, note says so). Delete
**only rows with an empty `line_user_id`** — a row that is `linked` is a real binding; keep it
(and its punches in `DATA`).

## `DATA`

Four independent append-only blocks side by side:

| block | cols | header |
|---|---|---|
| punch ledger | A:E | `ts, employee_id, event(in\|out), source, note` |
| machine log | H:L | `event_id, ts, user_id, action, status` |
| errors | O:Q | `ts, context, message` |
| location checks | S:Z | `ts, employee_id, event, lat, lng, acc_m, dist_m, verdict` |

> ⚠️ Because three blocks share one tab, a row is "taken" only if **that block** is
> occupied. The code appends with a block-aware `appendToBlock_()`, never
> `Sheet.appendRow()` (which would append at the bottom of the whole sheet and scatter
> the blocks).

The ledger is append-only. Never edit or delete a punch to fix a mistake — **add a
correction row**, or the day can no longer be reconstructed.

`ts` must be a real datetime value (the script writes `new Date()`), or the dashboard
formulas will not match it.

### Reading the punch columns

- `source` = `line` for a plain rich-menu tap, `liff-geo` for a punch that arrived with a
  location. Filtering `source = line` lists every punch nobody verified.
- `source` = **`hr_fix`** or **`self_report`** on a row that was *not* scanned: HR ran
  `hrFixDay()` / `hrFixIn()`, or the employee reported the time on the LIFF page. These close a
  forgotten day (or add the check-in nobody made) and are dated to that day, so they never
  appear on today's dashboard. `self_report` is a claim; the 05:00 email repeats it to HR.
- `source` = **`auto_close`** on an `out` row the 05:00 sweep wrote because nobody confirmed the
  day: the time is `WORK_END`, the note says `auto_close YYYY-MM-DD HH:mm scheduled_end`, and it
  is a **placeholder** — when a person later supplies the real time, that row is rewritten
  (`replaced auto_close`) rather than duplicated. Filter `source = auto_close` to list every
  day whose hours are the shift end rather than an observation.
- `note` carries `late 27m` and/or a geo verdict: `geo:ok 34m`, `geo:far 1200m`,
  `geo:weak_fix 42m acc300m`, `geo:no_fix`. A forgotten check-out is greppable as
  `forgot_out YYYY-MM-DD` — written on the *next* check-in (the detection) and on the closing
  row itself (`closed by HR` / `self-reported`).
- Two HR corrections (v2.5) are also greppable, and both leave the original rows in place:
  `forgot_in YYYY-MM-DD HH:mm added by HR` on an `in` row (`hrFixIn`), and
  `corrected_out YYYY-MM-DD HH:mm (was HH:mm)` on a **second** `out` row — the sheet shows the
  day's last `out`, so the later row is the one that counts and the old time stays visible in
  the note.
- `verdict` in S:Z is one of `ok`, `far`, `weak_fix`, `no_fix`, `no_office`. `weak_fix`
  means the phone's accuracy was too poor to judge — indoors that is normal, and it is
  **not** evidence of anything.
- Coordinates are rounded to 4 decimals (~11 m), one row per punch attempt. There is no
  continuous tracking anywhere in this system.
- A location is **evidence about a phone, not about a person**: it can be spoofed by a
  mock-location app. Treat a `far` verdict as a question for HR, not a conclusion.

There is **no sample data left** (v2.0.0 removed it; `scripts/audit_sheet.py` reports
`none`). If a `SAMPLE` note ever reappears it is fake and safe to delete — and if it is a
*formula* (`=TODAY()+…`), delete it immediately: it re-dates itself every night and puts a
fake employee on the dashboard forever.

## Privacy

`EMPLOYEES_LOG` holds the one-time codes — credentials. Share the spreadsheet with HR
only; staff must never have access. Their only surface is LINE.

Location is personal data under Thailand's PDPA: collect it only at punch time, keep this
sheet HR-only, tell staff the purpose, and set a retention rule for `DATA!S:Z` (for
example, delete rows older than 90 days).
