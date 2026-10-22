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
MISSING = ('=ARRAYFORMULA(TEXTJOIN(", ",TRUE,IF((EMPLOYEES_LOG!$G$2:$G=TRUE)*'
           '(COUNTIFS(DATA!$B:$B,EMPLOYEES_LOG!$A$2:$A,DATA!$C:$C,"in",'
           'INT(DATA!$A:$A),TODAY())=0),EMPLOYEES_LOG!$B$2:$B,"")))')
# B2 — last activity: the newest punch time today. A FORMULA, not a script write, so the
# dashboard needs no per-minute heartbeat trigger; it recalculates whenever a punch is
# appended (and on open).
LAST_ACTIVITY = ('=IFERROR(IF(MAXIFS(DATA!$A:$A,DATA!$A:$A,">="&TODAY(),DATA!$A:$A,'
                '"<"&TODAY()+1)=0,"",TEXT(MAXIFS(DATA!$A:$A,DATA!$A:$A,">="&TODAY(),'
                'DATA!$A:$A,"<"&TODAY()+1),"HH:mm:ss")),"")')


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
