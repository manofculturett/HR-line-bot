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
            {'range': 'HR_MAIN!A5',
             'values': [['=ARRAYFORMULA(FILTER(EMPLOYEES_LOG!$A$2:$A,EMPLOYEES_LOG!$G$2:$G=TRUE))']]},
            {'range': 'HR_MAIN!B5',
             'values': [['=ARRAYFORMULA(FILTER(EMPLOYEES_LOG!$B$2:$B,EMPLOYEES_LOG!$G$2:$G=TRUE))']]},
            {'range': 'HR_MAIN!C5',
             'values': [['=ARRAYFORMULA(FILTER(EMPLOYEES_LOG!$C$2:$C,EMPLOYEES_LOG!$G$2:$G=TRUE))']]},
            {'range': 'HR_MAIN!D%d:F%d' % (FIRST, last),
             'values': [[CHECKIN.format(r=r), CHECKOUT.format(r=r), STATUS.format(r=r)]
                        for r in range(FIRST, last + 1)]}]

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


if __name__ == '__main__':
    main()
