#!/usr/bin/env python3
"""Audit the live HR spreadsheet against what README.md promises HR.

Emulates the Apps Script block logic (readBlock_ / firstFreeRowInBlock_) in Python against
the real sheet, so the block-aware append can be verified without deploying anything.
"""
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
import os, re

FID = '1Ek-vacbfgWq11I2WhLvz6yc5WAD7IFojXRnnGVd0i-4'
creds = Credentials.from_authorized_user_file(os.path.expanduser('~/.hermes/google_token.json'))
svc = build('sheets', 'v4', credentials=creds)

# blocks, exactly as config.gs declares them: (key, tab, 0-based col, width)
BLOCKS = [
    ('ATTENDANCE', 'DATA',          0,  5),
    ('LOG',        'DATA',          7,  5),
    ('ERROR',      'DATA',          13, 3),
    ('EMPLOYEES',  'EMPLOYEES_LOG', 0,  8),
]
ERRORS = ('#REF!', '#VALUE!', '#N/A', '#ERROR!', '#DIV/0!', '#NAME?')

print('=' * 72)
print('SHEET AUDIT — Customer / HR-line-bot')
print('=' * 72)

meta = svc.spreadsheets().get(
    spreadsheetId=FID,
    fields='properties,namedRanges,sheets(properties,conditionalFormats)').execute()
print('title    :', meta['properties']['title'])
print('timezone :', meta['properties']['timeZone'])
print('locale   :', meta['properties']['locale'])
print('named ranges:', [(n['name'], n['range']['startRowIndex'] + 1) for n in meta.get('namedRanges', [])])
for s in meta['sheets']:
    p = s['properties']
    print('tab %-15s frozen=%-2s cfRules=%s' % (
        p['title'], p.get('gridProperties', {}).get('frozenRowCount'),
        len(s.get('conditionalFormats', []))))

# ---- full dump + error scan -------------------------------------------------
def rows(tab, a1='A1:Z60'):
    return svc.spreadsheets().values().get(
        spreadsheetId=FID, range='%s!%s' % (tab, a1)).execute().get('values', [])

print('\n' + '-' * 72)
print('HR_MAIN — computed values (what HR actually sees)')
print('-' * 72)
for i, r in enumerate(rows('HR_MAIN', 'A1:F12'), 1):
    print('%3d | %s' % (i, ' | '.join('' if c is None else str(c) for c in r)))

print('\nHR_MAIN config block T:U')
for i, r in enumerate(rows('HR_MAIN', 'T4:U12'), 4):
    print('%3d | %s' % (i, ' | '.join('' if c is None else str(c) for c in r)))

print('\n' + '-' * 72)
print('Formula error scan')
print('-' * 72)
found = 0
for tab in ('HR_MAIN', 'EMPLOYEES_LOG', 'DATA'):
    for i, r in enumerate(rows(tab), 1):
        for j, c in enumerate(r):
            if isinstance(c, str) and any(e in c for e in ERRORS):
                print('  !! %s row %d col %d: %s' % (tab, i, j + 1, c)); found += 1
print('  none' if not found else '  %d error cell(s)' % found)

# ---- emulate the Apps Script block logic ------------------------------------
print('\n' + '-' * 72)
print('Block emulation (matches readBlock_ / firstFreeRowInBlock_ in sheets.gs)')
print('-' * 72)
raw = {}   # tab -> full value grid
for tab in ('DATA', 'EMPLOYEES_LOG'):
    raw[tab] = svc.spreadsheets().values().get(
        spreadsheetId=FID, range='%s!A1:Z60' % tab).execute().get('values', [])


def cell(grid, r, c):
    """0-based row/col, '' when absent."""
    if r >= len(grid):
        return ''
    row = grid[r]
    return row[c] if c < len(row) and row[c] is not None else ''


for key, tab, col, width in BLOCKS:
    grid = raw[tab]
    last = 0
    for r in range(len(grid)):
        if any(str(v).strip() for v in grid[r]):
            last = r + 1                      # 1-based last row with content (getLastRow)
    # Mirror firstFreeRowInBlock_ exactly: scan sheet rows 2..last, RETURN on the first
    # fully-blank row within this block; only fall through to last+1 if none is blank.
    target, data_rows = None, 0
    for r in range(1, last):
        vals = [cell(grid, r, col + k) for k in range(width)]
        if all(str(v).strip() == '' for v in vals):
            if target is None:
                target = r + 1
            continue
        data_rows += 1
    if target is None:
        target = last + 1 if last >= 1 else 2
    print('%-11s tab=%-14s cols=%d-%d  dataRows=%-2d  nextAppendRow=%d'
          % (key, tab, col + 1, col + width, data_rows, target))

# ---- plan conformance -------------------------------------------------------
print('\n' + '-' * 72)
print('Plan conformance')
print('-' * 72)
hr = rows('HR_MAIN', 'A1:F40')
emp = rows('EMPLOYEES_LOG', 'A1:H60')
active = sum(1 for r in emp[1:] if len(r) > 6 and str(r[6]).strip().upper() == 'TRUE')
dash_rows = sum(1 for r in hr[4:] if len(r) > 0 and str(r[0]).strip())

# Where do the ROW-WISE formulas actually stop? Read them as formulas, not values —
# a blank value is indistinguishable from an empty cell.
fr = svc.spreadsheets().values().get(
    spreadsheetId=FID, range='HR_MAIN!D1:F1200',
    valueRenderOption='FORMULA').execute().get('values', [])
last_formula = 0
for i, r in enumerate(fr, 1):
    if any(isinstance(c, str) and c.startswith('=') for c in r):
        last_formula = i
first_formula = min((i for i, r in enumerate(fr, 1)
                     if any(isinstance(c, str) and c.startswith('=') for c in r)), default=0)

print('active employees in roster      :', active)
print('dashboard rows currently shown  :', dash_rows)
print('row-wise formulas span          : rows %s..%s (%s employees)'
      % (first_formula, last_formula, last_formula - first_formula + 1))
print('-> headroom before a time column silently stops computing:',
      (last_formula - first_formula + 1) - active)
print()
print('B1 missing list   :', hr[0][1] if len(hr) > 0 and len(hr[0]) > 1 else '(empty)')
print('B2 last activity  :', (hr[1][1] if len(hr) > 1 and len(hr[1]) > 1 else '(empty)') or '(empty — formula not applied yet)')

# ---- leftover sample data ---------------------------------------------------
print('\n' + '-' * 72)
print('Leftover sample data (must be deleted before real use)')
print('-' * 72)
samples = 0
for tab, grid in raw.items():
    for i, r in enumerate(grid, 1):
        # Only the block that actually belongs to this tab's first block — DATA holds the
        # log/error blocks too, and joining a whole row mixes three unrelated tables.
        width = 8 if tab == 'EMPLOYEES_LOG' else 5
        joined = ' '.join(str(c) for c in r[:width])
        if 'SAMPLE' in joined or 'ตัวอย่าง' in joined:
            print('  %s row %d: %s' % (tab, i, joined.strip()[:100])); samples += 1
print('  none' if not samples else '  %d sample row(s) still live — they make the dashboard show fake attendance' % samples)
