# Changelog

Version markers follow the tags on `main`. The system is live, so "deployed" is stated
separately from "committed" — a tag whose code was never pushed with `clasp deploy` is not
running.

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
