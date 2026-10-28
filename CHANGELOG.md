# Changelog

Version markers follow the tags on `main`. The system is live, so "deployed" is stated
separately from "committed" — a tag whose code was never pushed with `clasp deploy` is not
running.

## v2.4.0 — 2026-10-28

Visual and functional pass across all three surfaces — the HR sheet, the LIFF page and the
chat — plus one latent production failure.

**Deployed:** not yet. The Apps Script code is pushed to HEAD (verified by pulling it back);
the live `/exec` still serves @20. To put it live: `clasp create-deployment -i
AKfycbzfyow… -d "v2.4.0"`, then `GET /exec?k=…` must report `"v2.4.0"`. The LIFF page goes
live on `git push` (GitHub Pages) and works against either server version. The sheet changes
are **already live** (applied by `scripts/setup_dashboard.py` + `scripts/style_sheet.py`).

### Fixed

- **`DATA` would stop accepting punches at grid row 1000.** `getRange()` throws past the
  sheet's grid instead of extending it, and the LOG block gains ~4 rows per employee per day —
  about two weeks of a 20-person team. `appendToBlock_` now grows the grid 500 rows at a time
  first (`ensureRows_`).
- **Status colours stopped at `HR_MAIN!F24`** while the formulas run to `F204`, so the 21st
  employee got no colour. Every conditional rule now covers the provisioned range.
- **The LIFF page sent people in a circle.** On a GPS or network failure it said "use the
  เข้างาน button in the chat menu instead" — which `PUNCH_REQUIRE_GEO=TRUE` refuses. A failed
  fix still punches (`no_fix`), so the page now says what was recorded; a network failure
  says retry is safe (the server refuses a second punch).
- `HR_MAIN!B2` went blank before the first punch of the day; it now says
  `ยังไม่มีการลงเวลาวันนี้` (a blank derived cell reads as a broken formula).
- The 09:15 digest used an English `d MMM yyyy` date in an otherwise Thai email.

### Changed

- **Google Sheet restyled** (`scripts/style_sheet.py`, idempotent, formatting only — no column
  moves): Sarabun throughout, coloured header bars per tab and per `DATA` block, zebra rows,
  status chips, column widths, hidden gridlines on `HR_MAIN`, tab colours, a leaver row greys
  out in `EMPLOYEES_LOG`, `DATA` flags claims (`auto_close` / `self_report` / `hr_fix`) and geo
  verdicts by colour, and warning-only protection on the formula area and on `DATA`.
- **`HR_MAIN` additions:** a today panel (`F1:G3`: Thai date, checked-in `n / total`, late
  count), an hours column (`H`, first in → last out), and a Thai description beside every
  CONFIG key (`V`, which nothing reads).
- **LIFF page redesigned:** live clock and Thai date, the employee's roster name, in/out
  tiles with status chips, and only the punch that makes sense is enabled (เข้างาน greys out
  with its time once used; เลิกงาน becomes the primary). The forgotten-day card defaults to
  `WORK_END` instead of a hard-coded 18:00.
- **One round-trip to open the page.** `me:today` now also returns `name`, `state`, `days`
  and `workEnd`; the page used to make two requests. Older pages ignore the extra fields.
- **Verified ID tokens are cached** (by SHA-256, until 60 s before `exp`, max 30 min), so the
  2–3 requests of one page visit cost one call to LINE instead of one each.
- **The spreadsheet is opened once per execution** (`book_` memoized) instead of on every
  `getTab_` — a punch made ten-plus `openById` calls.
- A chat punch refused by `PUNCH_REQUIRE_GEO` now gets a one-button card
  (`เปิดหน้าลงเวลา`) instead of a bare URL; the old sentence is its `altText`.
- `สถานะของฉัน` shows time worked so far while checked in.
- **09:15 digest** rewritten in the same formal register as the 05:00 report: Buddhist-era
  date, `เข้างานแล้ว n จาก m คน`, numbered missing list, and a new late list. Copy in
  `messages.gs` (`HR_DIGEST`).

### Added

- `scripts/harness.js` + `scripts/fixtures/seed.json` — the Node harness that runs the real
  `.gs` files against a stubbed runtime, now in the repo with an anonymized frozen fixture
  (56 assertions; previously it lived outside the repo).
- `scripts/style_sheet.py`.

### Notes

- Backup of the spreadsheet before the restyle: Drive file
  `Customer — backup before restyle 2026-10-28`.
- Verified: harness 56/56 (14 new: grid growth, single open, token cache incl. no-exp /
  near-expiry / rejected / cross-token, the `today` payload through a full in→out day, the
  button card's LINE limits, text routing, digest content and its bad-`WORK_START` path);
  LIFF page exercised in a 390 px browser against new-server, old-server, unregistered and
  GPS-denied responses; sheet re-run twice with identical rule/band/protection counts and no
  formula errors.

## v2.3.0 — 2026-10-27

A forgotten check-out stops hanging. It is still never *guessed* — the fallback uses the shift
end the company itself declared, marks the row so nobody can read it as a punch, and is replaced
the moment a person confirms the real time.

**Deployed:** version 20 (labelled `v2.3.0 self-heal auto-close + professional HR email` in
`clasp list-deployments`) → the same deployment id, URL unchanged. `AUTO_CLOSE_DAYS = 3` is live
at `HR_MAIN!T21:U21` (the CONFIG block is now read as `T4:U28`; it was full at `U20`).

### Added

- **Self-heal — `autoCloseStaleDays_`** (`fixes.gs`), run by `forgotOutReport` at 05:00 *before*
  the report is built: any day still open after `AUTO_CLOSE_DAYS` (CONFIG, default `3`) is
  closed at `WORK_END` **on that day**, with `source=auto_close` and the note
  `auto_close YYYY-MM-DD HH:mm scheduled_end`. A Friday forgotten shift is closed Monday at
  05:00, so a weekend can no longer leave a day open for ever. Not gated by `EMAIL_ENABLED` —
  data hygiene is not a notification. One `auto_close` LOG row per closing day.
- **`AUTO_CLOSE_DAYS` CONFIG key** (`3`; `0` = off). `CONFIG_RANGE` widened `T4:U20` → `T4:U28`.
- **`selfTest` section [8]** now reports whether the policy can run: days, `WORK_END` parseable,
  and whether the key was found in the block or the default is in use.
- A day whose check-in is at/after `WORK_END` is deliberately **not** auto-closed — it has no
  defensible shift end, so it stays open and stays in the email.

### Changed

- **The 05:00 email was rewritten for HR, not for a developer**: `[ระบบลงเวลาทำงาน]` subject,
  `เรียน ฝ่ายทรัพยากรบุคคล`, Buddhist-era dates (`26 ตุลาคม 2569`), one numbered section per
  case (ยังไม่ลงเวลาเลิกงาน / ระบบปิดเวลาออกอัตโนมัติ / พนักงานแจ้งเวลาเอง), an
  `แนวทางการดำเนินการ` block that states the real procedure, and a no-reply footer. All copy
  moved to `messages.gs` (`HR_MAIL` + `thaiDateLabel_`), so changing wording never touches
  logic. Gone: "ยังไม่ปิดเวลาออก", "เดาเวลา", `dd/MM` dates and raw `out 2026-10-26 20:00` log
  strings.
- **`openDaysByEmployee_` pairs an `out` only with check-ins from the previous
  `MAX_SHIFT_HOURS` (24 h)** instead of clearing every open check-in. The old rule silently
  swallowed a forgotten Friday as soon as the employee worked a normal Monday — no warning, no
  report, no row, no hours. Overnight shifts (in 22:00, out 02:00) still pair.
- **An `auto_close` row is a placeholder and is REPLACED in place** (`sheets.replaceBlockRow_`,
  note `replaced auto_close`) when HR or the employee supplies the real time. Appending a second
  `out` would leave the dashboard's `MAX(...)` preferring the later placeholder over the earlier
  truth.
- **`fixList_` also offers auto-closed days** for the rest of `SELF_REPORT_DAYS`, labelled
  `(ปิดอัตโนมัติ HH:mm)` in the picker, so a 3-day heal does not silently shorten the employee's
  7-day window. No page change needed: `docs/liff/index.html` renders `label — เข้างาน HH:mm`
  from the entry.

### Notes

- `B3` remains a latest-punch formula, so it can still be quiet while the report lists an older
  dangling day; making it per-day needs a live-sheet formula change. Documented in
  `sheet/dashboard.md`, not attempted here.
- Verified with the Node harness against the stubbed Apps Script runtime seeded from the live
  sheet: 42 assertions, including a full Friday→Saturday→Sunday→Monday timeline, placeholder
  replacement from both human paths, idempotency, `AUTO_CLOSE_DAYS=0`, unparseable `WORK_END`,
  the 24-hour pairing window, and no regressions on the punch/fix paths.

## v2.2.1 — 2026-10-27

`hrFixDay` shipped in v2.2.0 was not actually runnable by HR: the editor's **Run** button calls a
function with **no arguments**, so `hrFixDay('A0124', '2026-10-26', '19:30')` — the only form it
supported — could not be invoked from the UI at all.

**Deployed:** versions 18–19 → the same deployment id (URL unchanged); the health check reports
`"v2.2.1"`.

### Fixed

- **`hrFixDay` reads its request from Script Properties** (`FIX_EMP_ID`, `FIX_DATE`, `FIX_TIME`)
  when it is called with no arguments, which is what Run does. The properties are cleared after a
  **successful** run, so a stale request can never be applied twice, and kept after a failure so
  one wrong value can be corrected and re-run. Called with arguments it behaves exactly as before
  (programmatic use and the test harness unchanged).
- The 05:00 email's "how to close it" lines now describe that procedure instead of an argument
  list nobody can type.

### Notes

- Found while writing the hand-over rather than by any test: the harness called the function with
  arguments, so it never exercised the only way a human reaches it.

## v2.2.0 — 2026-10-27

The forgotten check-out gets a decision path. Nothing guesses a time.

**Deployed:** version 17 → deployment `AKfycbzfyow…` (id unchanged, so the LIFF page's `/exec`
URL still resolves). `installTriggers()` still has to be run once in the editor before the 05:00
trigger exists; `EMAIL_ENABLED` decides whether either email actually sends.

### Added

- **`fixes.gs`** — closes a day the bot never closed, by appending one `out` row dated to
  **that day**. Two entry points, both recording who claimed the time:
  `hrFixDay(employeeId, 'yyyy-MM-dd', 'HH:mm')` run from the editor (`source=hr_fix`), and
  `selfReportFix_` from the LIFF page (`source=self_report`).
- **`forgotOutReport()` at 05:00** — an exception-only email to `HR_EMAIL` listing every day
  still open before today (name, date, check-in time) plus every self-reported time from the
  last 24 h, so HR accepts or queries it. Gated by `EMAIL_ENABLED` **and** `HR_EMAIL`, like the
  digest. One `report:forgot_out` row per run in the LOG block, so "ran and found nothing" is
  distinguishable from "never ran".
- **LIFF actions `open` / `fix`** — a *ลืมลงเวลาเลิกงาน?* card that appears only when a day is
  open, with a date picker and a time field. No location is requested: it is a claim about a
  past day, not a punch, and no geo row is written.
- **`SELF_REPORT_DAYS`** (`7`) config key — how far back the employee path reaches. `0` = off,
  HR only. Added live at `HR_MAIN!T20:U20`.
- `selfTest` section **[8]**: who is stuck open, whether the fix paths are reachable, and
  whether the 05:00 trigger is actually installed.
- `doGet` health check now reports `version: "v2.2.0"` instead of a bare `v2`, so a stale
  deployment is visible.

### Changed

- **`openDaysByEmployee_`** is now the single definition of "dangling day" (all employees, all
  unclosed days); `staleOpenIn_`, the 05:00 report and both fix paths read it. The check-in
  warning is unchanged.

### Deliberately not done

- **No automatic check-out.** Any timestamp a job could write is invented, and it would be
  invisible or actively wrong: stamped today it reads as today's `out` to `E5`/`G5` (a 05:00
  check-out and a 13-hour early-leave flag for someone not yet arrived) and B3 stops naming
  anyone while the day stays broken; backdated it clears every signal *and* fakes the hours.
  Detection is a fact → `LOG` block. A punch row means a person was there → never written from
  a detection.
- A fix for **today** is refused by design: today is closed by pressing เลิกงาน.

### Notes

- Concept and review by Tartan; an overnight shift (in 22:00, out 02:00) still needs a manual
  row — the one-pair-per-day rule keys on the calendar date.
- The CONFIG block `T4:U20` is now full; a ninth key needs `CONFIG_RANGE` widened first.
- Verified with a Node harness that runs these `.gs` files against a stubbed Apps Script
  runtime seeded from the live sheet (25 assertions: guards, idempotency, email gating, the
  LIFF route, and no regressions on the punch paths).

## v2.1.0 — 2026-10-24

Attendance policy: one pair per day, and a forgotten day stops being invisible.

### Changed

- **One check-in per day, one check-out per day.** `punchIn_` refuses a second check-in
  whether or not the employee already checked out, so an in→out→in cycle can no longer exist.
  The dashboard reads the *first* in and the *last* out, so a second pair silently moved the
  recorded shift — and the old guard only refused a second check-in while the first was still
  open. `punchOut_` refuses a second check-out the same way.
- Early check-out is unchanged: still allowed, still flagged (`ออกก่อน`, `early Nm`).

### Added

- **`HR_MAIN!B3 "ค้างเลิกงาน"`** lists anyone whose shift is still open from an earlier day.
  The check is *the last punch before today was an `in`*, not a count of ins vs outs — a count
  also flags an old day with two pairs, which is honest but never actionable on a today-board.
- On check-in, a dangling earlier day is now reported to the employee
  (`⚠️ ยังไม่ได้ลงเวลาเลิกงานของวันที่ …`), recorded in the punch note as
  `forgot_out YYYY-MM-DD`, and logged as `forgot_out`. Silence was the bug: the old day stayed
  open forever with no hours and no trace of why.
- The phone cannot retro-close an earlier day (a check-out with nothing to close today is
  refused). That stays an HR decision, not a guess by the bot.

### Notes

- A mid-day break is not modelled: one pair per day means one pair. If HR ever wants a
  lunch out/in, that is a policy change, not a bug fix.
- B3 is bounded to rows 2:204 like the rest of the dashboard.

## v2.0.1 — 2026-10-23

Closes a hole: the location check could be bypassed by typing.

### Fixed

- **A check-in/out typed into the chat (`เข้างาน`, `เลิกงาน`) — or sent as a postback — recorded
  a punch with no location at all.** v2 left the chat path open as a fallback, which made the
  entire location check advisory: anyone could type the word from anywhere. `PUNCH_REQUIRE_GEO`
  (new CONFIG key, default `TRUE`) now refuses a chat punch and replies with the LIFF link. The
  aliases still resolve, so the employee gets a sentence they can act on rather than
  "not understood".
- It closes the **channel**, not the fix: a phone that refuses to give a position still punches
  **from the page** and is recorded as `no_fix`. Attendance is never blocked by a bad GPS fix —
  only by punching from the wrong place.
- If `LIFF_ID` is missing while the requirement is on, the punch is **allowed** and the
  misconfiguration is written to the error block. A config mistake must never lock the team out
  of the clock.
- `สถานะของฉัน` is unaffected: read-only, still answers in the chat.

## v2.0.0 — 2026-10-23

Location check, early-leave visibility, and the dashboard made truthful. Deployed.

### Added

- **LIFF check-in/out** (`liff.gs`, `docs/liff/index.html`, GitHub Pages). A page inside LINE
  reads the device position at punch time and posts it with a LINE ID token; the server
  verifies the token at `api.line.me/oauth2/v2.1/verify` and classifies the fix against
  `OFFICE_LAT/LNG` + `GEO_RADIUS_M`. Every verdict is recorded in `DATA!S:Z`.
- **`geo.gs`** — haversine + `geoCheck_` (`ok` / `far` / `weak_fix` / `no_fix` / `no_office`).
  Accuracy outranks distance, so an indoor fix reads `weak_fix`, never `far`.
- **`GEO_MODE`** (`OFF` default / `WARN` / `BLOCK`). Shipping `OFF` means a bad fix can never
  block a punch; `BLOCK` is opt-in.
- **Read-only status panel** on the page (`me:today`, writes nothing).
- **`ออกก่อน` column** on `HR_MAIN` (G5:G204), the matching `early Nm` ledger note, `early` log
  status, and an employee-facing line on the check-out reply. Leaving early is never refused.
- **`EARLY_GRACE_MIN`** config key + `WORK_END` / `EARLY_GRACE_MIN` named ranges.
- **JSONP transport** for the LIFF page, so a CORS-blocked POST still lands. Callback names
  are restricted to a plain identifier.
- `selfTest` sections [6] and [7]: data state, LIFF properties, geo block headers, verdicts.

### Fixed

- **`BLOCKS.ERROR` was `N:P`; the live sheet's header is `O:Q`.** Every `logError_` row was
  written one column beside its own block. Nothing had errored yet, so it never showed.
- **Sample rows were formulas** (`=TODAY()+TIME(8,57,0)`), so they re-dated themselves nightly:
  a non-existent employee showed `ตรงเวลา` daily and `อัปเดตล่าสุด` read `17:32:00` at 15:55.
  Removed, with the punch block compacted (rows could not be deleted — the log/geo/error
  blocks share them).
- **`B2` accepted future timestamps** (`< TODAY()+1`). Now `< NOW()`, so a wrong phone clock
  cannot make "last update" claim a time that has not happened.
- **`B1` went blank** when nobody was missing, which is indistinguishable from a broken
  formula. It now says `เข้างานครบทุกคน ✅`.
- **Geo timestamps showed a date only** — the column was formatted as a date.
- **Duplicate blank line** in the check-out reply, and coordinates silently dropped by
  `JSON.stringify` when geolocation returned `undefined` (now recorded as `no_fix`).
- A linked roster row could be reported as a deletable sample by `audit_sheet.py`.

### Removed

- Dead code: `appendPunch_`, `cfgTime_`, `getProfileDisplayName_`, `detachMenu_`.

## v1.0.0 — 2026-10-18

First tagged baseline, already live: rich-menu postback punches, one-time link-code
registration, append-only `DATA` ledger behind `LockService`, formula-only dashboard, 09:15
digest gated by `WORK_DAYS` + `EMAIL_ENABLED`, `?k=` webhook secret with `webhookEventId`
dedupe and a push fallback. Verified against the live deployment and sheet.
