# `HR_MAIN` — HR's screen

One row per active employee for **today**, live from `DATA`. Everything in A:G is a
formula; nothing is typed by hand and **nothing is written by a script**. Google Sheets
does not push to the screen, but the dashboard recalculates whenever a punch is appended
(an API write propagates to open browsers) and on open — so no heartbeat trigger is needed.
For an idle open sheet, use File → Settings → Calculation rather than an Apps Script timer.

**Row 4 is the header** (rows 1–4 are frozen); data is rows 5–24. The CONFIG block sits
in `T:U` — see [`README.md`](README.md#hr_main).

## The formulas (all live in the spreadsheet, verified working)

**B1 — the missing list ("is everyone in?")**

```
=LET(nm,EMPLOYEES_LOG!$B$2:$B, act,EMPLOYEES_LOG!$G$2:$G, id,EMPLOYEES_LOG!$A$2:$A,
  miss,IFERROR(FILTER(nm,(act=TRUE)*
    (COUNTIFS(DATA!$B:$B,id,DATA!$C:$C,"in",INT(DATA!$A:$A),TODAY())=0)),""),
  IF(miss="","เข้างานครบทุกคน ✅",TEXTJOIN(", ",TRUE,miss)))
```

Reads: *every active employee with no `in` punch today*, or the positive message when that
list is empty. **A blank cell is indistinguishable from a broken formula**, and that
ambiguity is what makes HR distrust a dashboard — so it says `เข้างานครบทุกคน ✅` instead of
going quiet. `LET` keeps the FILTER in one place rather than duplicating it inside an IF.

**B2 — last activity (this replaced the old script heartbeat)**

```
=IFERROR(IF(MAXIFS(DATA!$A:$A,DATA!$A:$A,">="&TODAY(),DATA!$A:$A,"<="&NOW())=0,"",
  TEXT(MAXIFS(DATA!$A:$A,DATA!$A:$A,">="&TODAY(),DATA!$A:$A,"<="&NOW()),"HH:mm:ss")),"")
```

The upper bound is **`NOW()`, not `TODAY()+1`**. With `TODAY()+1` any *future-dated* row
counted, so "last update" could show a time that had not happened yet (a phone with a wrong
clock, or the sample rows which were written as `=TODAY()+TIME(17,32,0)` — at 15:55 the cell
read `17:32:00`). With `NOW()` a future row simply does not count until the clock catches up.

The newest punch time today — a **formula**, so no script writes it and no trigger is
needed. It refreshes exactly when a punch lands (the append recalculates the sheet) and on
open. There is deliberately **no per-minute heartbeat trigger**: a 1-minute timer ran ~1,440
times a day against the Apps Script daily quota to redraw a cell that only changes when
someone punches.

**A5 / B5 / C5 — id, name, dept** (spills down the column)

```
=ARRAYFORMULA(FILTER(EMPLOYEES_LOG!$A$2:$A, EMPLOYEES_LOG!$G$2:$G=TRUE))
=ARRAYFORMULA(FILTER(EMPLOYEES_LOG!$B$2:$B, EMPLOYEES_LOG!$G$2:$G=TRUE))
=ARRAYFORMULA(FILTER(EMPLOYEES_LOG!$C$2:$C, EMPLOYEES_LOG!$G$2:$G=TRUE))
```

> The dashboard keeps the **id** in column A precisely so the D/E/F formulas can match on
> it. Matching on the name would silently fail — the ledger stores `employee_id`, not the
> name. This was a real bug in the first draft.

**D5, filled down to D24 — first check-in today**

```
=IFERROR(TEXT(INDEX(FILTER(DATA!$A:$A,(DATA!$B:$B=$A5)*(DATA!$C:$C="in")
  *(INT(DATA!$A:$A)=TODAY())),1),"HH:mm"),"")
```

**E5, filled down to E24 — last check-out today**

```
=IFERROR(TEXT(MAX(FILTER(DATA!$A:$A,(DATA!$B:$B=$A5)*(DATA!$C:$C="out")
  *(INT(DATA!$A:$A)=TODAY()))),"HH:mm"),"")
```

**F5, filled down to F24 — status.** `WORK_START` and `LATE_GRACE_MIN` are the named
ranges at `HR_MAIN!U6` and `U7`.

```
=IF($A5="","",
  IF($D5="","ยังไม่เข้างาน",
    IF(TIMEVALUE($D5)>TIMEVALUE(WORK_START)+LATE_GRACE_MIN/1440,"สาย","ตรงเวลา")))
```

The two guards matter: `$A5=""` keeps the empty rows below the roster blank, and `$D5=""`
gives "not in yet" rather than a `#VALUE!` from `TIMEVALUE("")`.

**G5, filled down to G204 — left early.** Leaving early is allowed; this only makes it
visible. The number is the raw gap to `WORK_END`; `EARLY_GRACE_MIN` (named range) decides
whether the flag appears at all, so a 4-minute finish does not raise one.

```
=IF($A5="","",IF($E5="","",
  IF(ROUND((TIMEVALUE(WORK_END)-TIMEVALUE($E5))*1440)>EARLY_GRACE_MIN,
     "ก่อน "&ROUND((TIMEVALUE(WORK_END)-TIMEVALUE($E5))*1440)&" น.","")))
```

The same minutes appear in the `DATA` note (`early 119m`) and in the employee's check-out
message, because all three use the same rule: **grace is a threshold, never a discount** —
reporting 114 instead of 119 would make the sheet disagree with the chat.

## Conditional formatting

Applied to **F5:F24** (status):

| Rule | Format |
|---|---|
| Text is exactly `ยังไม่เข้างาน` | red background |
| Text contains `สาย` | amber background |
| Text is exactly `ตรงเวลา` | green background |

Applied to **G5:G204** (left early):

| Rule | Format |
|---|---|
| Cell is not empty | amber background |

## Provisioning: how many employees?

Columns A/B/C spill automatically (FILTER follows the roster), but **D/E/F are filled
row-by-row and need an explicit range**. A 20-row range silently stops computing times the
moment the 21st employee is hired — the dashboard would show a name with a blank check-in
column, which looks like "hasn't arrived" when it really means "not being calculated".

The sheet is currently provisioned for **200 employees** (rows 5–204). To change it:

```bash
python3 scripts/setup_dashboard.py --rows 500      # re-apply for 500
python3 scripts/audit_sheet.py                     # verify what is actually there
```

`audit_sheet.py` reads the range back with `valueRenderOption=FORMULA`, because a *blank
value* is indistinguishable from an *empty cell* — you cannot tell where the formulas stop
by looking at the rendered values.

## Gotchas found while building this

- **`#REF!` after editing named ranges.** Re-adding a named range in the same batch that
  deletes it leaves dependent formulas broken until they are rewritten. Fix: rewrite the
  formula column. Costs 30 seconds; looks terrifying otherwise.
- **`09:00` ≠ `"09:00"`.** A cell Sheets types as a Time comes back from `getValues()` as
  a `Date`, so `parseHhMm_()` fails on it. Column `U` is set to plain-text format and
  `getConfig_()` also normalises a `Date` → `"HH:mm"` as a second line of defence.
- **`INT(DATA!$A:$A) = TODAY()`** compares the date part in the Sheet's timezone — another
  reason the Sheet timezone must be `Asia/Bangkok`.
- **Sample rows must not be formulas.** The demo punches shipped as
  `=TODAY()+TIME(8,57,0)` / `=TODAY()+TIME(17,32,0)`, so they silently re-dated themselves to
  *today* every night: a fake employee showed `ตรงเวลา` every day, "last update" showed
  17:32 at 15:55, and B1 listed a name that does not exist. A static date in a few sample
  rows is harmless; a formula that follows `TODAY()` is a permanent lie. Written as
  **static** values or not at all.
- **`values.update` does not clear cells you omit.** The API trims trailing empty cells from
  what it returns, so a row with an empty `note` comes back 4 cells long; writing that row
  back into a 5-column block leaves the old 5th cell in place. When rewriting a block from
  a read, pad every row to the block width, and clear the range first.
- Whole-column refs (`DATA!$A:$A`) keep working as the ledger grows; switch to bounded
  ranges if the sheet gets very large.
- An employee with `active = FALSE` disappears from the dashboard and the digest — that is
  how a leaver is handled without deleting history.
