# Changelog

Version markers follow the tags on `main`. The system is live, so "deployed" is stated
separately from "committed" — a tag whose code was never pushed with `clasp deploy` is not
running.

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
