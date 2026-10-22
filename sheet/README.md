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
| `HR_MAIN` | HR's dashboard (A:F) **and** the CONFIG block (T:U) | HR reads and edits; formulas only — the script writes nothing |
| `EMPLOYEES_LOG` | the roster, A:H | HR edits — **contains credentials, HR-only** |
| `DATA` | three append-only blocks: punches A:E, machine log H:L, errors N:P | machine writes, HR reads |

There is no separate Config/Log/Error tab — those live inside `HR_MAIN` and `DATA` to
match the three tabs already in the spreadsheet.

## `HR_MAIN`

```
        A              B          C        D         E          F
1   ยังไม่เข้างาน:   <formula>                                      ← the "is everyone in?" list
2   อัปเดตล่าสุด     <formula>                                     ← latest punch time today
3
4   id            พนักงาน     แผนก     เข้างาน   เลิกงาน   สถานะ     ← header (frozen)
5   A0123         สมชาย       ขาย      08:57     17:32     ตรงเวลา
…   (formulas, rows 5–24)

                                         T              U
4                                        key            value
5                                        TZ             Asia/Bangkok
6                                        WORK_START     09:00        ← named range
7                                        LATE_GRACE_MIN  0           ← named range
8                                        WORK_END       18:00
9                                        WORK_DAYS      MON,TUE,WED,THU,FRI
10                                       HR_EMAIL       (your address)
11                                       DIGEST_TIME    09:15
12                                       EMAIL_ENABLED  TRUE          ← FALSE stops the digest
```

- Dashboard rows 5–24 are **formulas only** — see [`dashboard.md`](dashboard.md).
- CONFIG is a plain key/value block. The script **scans** it, so HR can add or reorder
  rows freely. Named ranges `WORK_START` and `LATE_GRACE_MIN` point at `U6` and `U7`.
- `U` is formatted as **plain text** — otherwise Sheets parses `09:00` into a time value
  and the script sees a date instead of `"09:00"`.

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

Rows 2–4 currently hold **test employees**. Delete **only rows with an empty
`line_user_id`** — a row that is `linked` is a real binding; keep it (and its punches in
`DATA`).

## `DATA`

Three independent append-only blocks side by side:

| block | cols | header |
|---|---|---|
| punch ledger | A:E | `ts, employee_id, event(in\|out), source, note` |
| machine log | H:L | `event_id, ts, user_id, action, status` |
| errors | N:P | `ts, context, message` |

> ⚠️ Because three blocks share one tab, a row is "taken" only if **that block** is
> occupied. The code appends with a block-aware `appendToBlock_()`, never
> `Sheet.appendRow()` (which would append at the bottom of the whole sheet and scatter
> the blocks).

The ledger is append-only. Never edit or delete a punch to fix a mistake — **add a
correction row**, or the day can no longer be reconstructed.

`ts` must be a real datetime value (the script writes `new Date()`), or the dashboard
formulas will not match it.

Rows 2–3 hold **sample punches** (marked `SAMPLE` in the note) so the dashboard shows
something today. They are fake and safe to delete. A punch whose note is **empty** is
real — never delete it. (Rule of thumb: `SAMPLE` in the note = fake; `line_user_id`
present = a real binding.)

## Privacy

`EMPLOYEES_LOG` holds the one-time codes — credentials. Share the spreadsheet with HR
only; staff must never have access. Their only surface is LINE.
