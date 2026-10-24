#!/usr/bin/env python3
"""Apply (or re-apply) the HR_MAIN dashboard formulas on the live spreadsheet.

The A/B/C columns are dynamic (FILTER spills as the roster grows), but the time columns
must be filled row-by-row, so they need an explicit range. A 20-row range silently stops
computing times once the 21st employee is hired — this sets a generous range instead.

Usage:
    python3 scripts/setup_dashboard.py            # default 200 employees
    python3 scripts/setup_dashboard.py --rows 500
"""
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
import argparse, os

FID = '1Ek-vacbfgWq11I2WhLvz6yc5WAD7IFojXRnnGVd0i-4'
FIRST = 5           # header is row 4

CHECKIN = ('=IFERROR(TEXT(INDEX(FILTER(DATA!$A:$A,(DATA!$B:$B=$A{r})*(DATA!$C:$C="in")'
           '*(INT(DATA!$A:$A)=TODAY())),1),"HH:mm"),"")')
CHECKOUT = ('=IFERROR(TEXT(MAX(FILTER(DATA!$A:$A,(DATA!$B:$B=$A{r})*(DATA!$C:$C="out")'
            '*(INT(DATA!$A:$A)=TODAY()))),"HH:mm"),"")')
STATUS = ('=IF($A{r}="","",IF($D{r}="","ยังไม่เข้างาน",IF(TIMEVALUE($D{r})>'
          'TIMEVALUE(WORK_START)+LATE_GRACE_MIN/1440,"สาย","ตรงเวลา")))')
# B1 — who has not checked in today. Says so explicitly when nobody is missing: a blank
# cell is indistinguishable from a broken formula, which is exactly the doubt this removes.
# LET keeps the FILTER expression in one place instead of duplicating it inside an IF.
# G — left early. Leaving early is ALLOWED (nothing refuses it); this only makes it visible.
# The reported number is the raw gap to WORK_END, and EARLY_GRACE_MIN decides whether the
# flag appears at all, so the dashboard, the ledger note and the employee's message agree.
# Same shape as the punch reply: it never says "early" for a couple of minutes.
EARLY = ('=IF($A{r}="","",IF($E{r}="","",'
         'IF(ROUND((TIMEVALUE(WORK_END)-TIMEVALUE($E{r}))*1440)>EARLY_GRACE_MIN,'
         '"ก่อน "&ROUND((TIMEVALUE(WORK_END)-TIMEVALUE($E{r}))*1440)&" น.","")))')
# B3 — people whose shift is STILL OPEN from an earlier day (they forgot to check out).
#
# The test is "the last punch before today was an `in`", not "ins > outs". A count also
# flags a historical day that had two pairs, which is honest but never actionable on a
# today-board — and a cell that nags about old data is how a dashboard loses its audience.
#
# ⚠️ MAP is required. A COUNTIFS/MAP expression assigned inside LET does not spill on its
#    own; without MAP the value collapses to a single one and every comparison is silently
#    false, so the cell says "nothing outstanding" while someone is stuck open.
# Bounded to rows 2:204 — the same 203 roster rows the dashboard provisions.
STALE = ('=IFERROR(LET('
         'act,EMPLOYEES_LOG!$G$2:$G$204,'
         'nm,FILTER(EMPLOYEES_LOG!$B$2:$B$204,act=TRUE),'
         'id,FILTER(EMPLOYEES_LOG!$A$2:$A$204,act=TRUE),'
         'ev,MAP(id,LAMBDA(x,IFERROR(INDEX(FILTER(DATA!$C:$C,(DATA!$B:$B=x)*'
         '(DATA!$A:$A=MAXIFS(DATA!$A:$A,DATA!$B:$B,x,DATA!$A:$A,"<"&TODAY()))),1),""))),'
         'hits,(ev="in")*1,'
         'IF(SUM(hits)=0,"ไม่มีรายการค้าง ✅",TEXTJOIN(", ",TRUE,FILTER(nm,hits)))),'
         '"สูตรผิดพลาด — ตรวจ B3")')

MISSING = ('=LET(nm,EMPLOYEES_LOG!$B$2:$B,act,EMPLOYEES_LOG!$G$2:$G,'
           'id,EMPLOYEES_LOG!$A$2:$A,'
           'miss,IFERROR(FILTER(nm,(act=TRUE)*(COUNTIFS(DATA!$B:$B,id,DATA!$C:$C,"in",'
           'INT(DATA!$A:$A),TODAY())=0)),""),'
           'IF(miss="","เข้างานครบทุกคน ✅",TEXTJOIN(", ",TRUE,miss)))')
# B2 — last activity: the newest punch time today. A FORMULA, not a script write, so the
# dashboard needs no per-minute heartbeat trigger; it recalculates whenever a punch is
# appended (and on open).
#
# The upper bound is NOW(), not TODAY()+1. With the old bound, any future-dated row —
# a phone with a wrong clock, or a sample row written as =TODAY()+TIME(17,32,0) — made
# "last update" show a time that had not happened yet. NOW() makes a future row simply
# not count until the clock catches up, so the cell can never claim a time ahead of now.
LAST_ACTIVITY = ('=IFERROR(IF(MAXIFS(DATA!$A:$A,DATA!$A:$A,">="&TODAY(),DATA!$A:$A,'
                '"<="&NOW())=0,"",TEXT(MAXIFS(DATA!$A:$A,DATA!$A:$A,">="&TODAY(),'
                'DATA!$A:$A,"<="&NOW()),"HH:mm:ss")),"")')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--rows', type=int, default=200, help='employee rows to provision')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    last = FIRST + args.rows - 1
    body = [{'range': 'HR_MAIN!B1', 'values': [[MISSING]]},
            {'range': 'HR_MAIN!B2', 'values': [[LAST_ACTIVITY]]},
            {'range': 'HR_MAIN!A3', 'values': [['ค้างเลิกงาน']]},
            {'range': 'HR_MAIN!B3', 'values': [[STALE]]},
            {'range': 'HR_MAIN!A5',
             'values': [['=ARRAYFORMULA(FILTER(EMPLOYEES_LOG!$A$2:$A,EMPLOYEES_LOG!$G$2:$G=TRUE))']]},
            {'range': 'HR_MAIN!B5',
             'values': [['=ARRAYFORMULA(FILTER(EMPLOYEES_LOG!$B$2:$B,EMPLOYEES_LOG!$G$2:$G=TRUE))']]},
            {'range': 'HR_MAIN!C5',
             'values': [['=ARRAYFORMULA(FILTER(EMPLOYEES_LOG!$C$2:$C,EMPLOYEES_LOG!$G$2:$G=TRUE))']]},
            {'range': 'HR_MAIN!D%d:F%d' % (FIRST, last),
             'values': [[CHECKIN.format(r=r), CHECKOUT.format(r=r), STATUS.format(r=r)]
                        for r in range(FIRST, last + 1)]},
            {'range': 'HR_MAIN!G4', 'values': [['ออกก่อน']]},
            {'range': 'HR_MAIN!G%d:G%d' % (FIRST, last),
             'values': [[EARLY.format(r=r)] for r in range(FIRST, last + 1)]}]

    print('would write rows %d..%d (%d employee rows)' % (FIRST, last, args.rows))
    if args.dry_run:
        print('dry run — nothing written')
        return

    creds = Credentials.from_authorized_user_file(os.path.expanduser('~/.hermes/google_token.json'))
    svc = build('sheets', 'v4', credentials=creds)
    res = svc.spreadsheets().values().batchUpdate(
        spreadsheetId=FID,
        body={'valueInputOption': 'USER_ENTERED', 'data': body}).execute()
    print('wrote %d cells' % res.get('totalUpdatedCells'))
    for r in res.get('responses', []):
        print('  ', r['updatedRange'], r['updatedCells'])

    # Named ranges the formulas depend on. HR is allowed to reorder the CONFIG block, so the
    # formulas reference names rather than fixed cells. Idempotent: only missing ones are made.
    meta = svc.spreadsheets().get(
        spreadsheetId=FID, fields='namedRanges,sheets.properties(title,sheetId)').execute()
    have = {n['name'] for n in meta.get('namedRanges', [])}
    main_id = next(s['properties']['sheetId'] for s in meta['sheets']
                   if s['properties']['title'] == 'HR_MAIN')
    # 1-based CONFIG rows: U6 WORK_START, U7 LATE_GRACE_MIN, U8 WORK_END, U18 EARLY_GRACE_MIN
    want = {'WORK_START': 6, 'LATE_GRACE_MIN': 7, 'WORK_END': 8, 'EARLY_GRACE_MIN': 18}
    reqs, made = [], []
    for name, row in want.items():
        if name in have:
            continue
        reqs.append({'addNamedRange': {'namedRange': {'name': name, 'range': {
            'sheetId': main_id, 'startRowIndex': row - 1, 'endRowIndex': row,
            'startColumnIndex': 20, 'endColumnIndex': 21}}}})
        made.append('%s→U%d' % (name, row))
    if reqs:
        svc.spreadsheets().batchUpdate(spreadsheetId=FID, body={'requests': reqs}).execute()
        print('created named ranges:', ', '.join(made))
    else:
        print('named ranges already present')


if __name__ == '__main__':
    main()
