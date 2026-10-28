#!/usr/bin/env python3
"""Apply the visual theme to the live HR spreadsheet. Formatting only — idempotent.

What it touches: fonts, colours, column widths, header rows, banding, conditional
formatting, merges in HR_MAIN rows 1-3, tab colours, warning-only protections, and the
CONFIG descriptions in HR_MAIN!V (a column nothing reads).

What it never touches: any column position. The DATA blocks (A:E, H:L, O:Q, S:Z) and the
CONFIG block (T:U) are addressed by fixed offsets in apps-script/config.gs, so moving or
inserting a column would silently write every row beside its own header. Values are only
written to HR_MAIN!V (descriptions); formulas are scripts/setup_dashboard.py's job.

Re-run any time (e.g. after setup_dashboard.py --rows N): every banding, conditional rule
and protection this script owns is deleted and recreated, so nothing stacks up.

Usage:
    python3 scripts/style_sheet.py            # apply
    python3 scripts/style_sheet.py --dry-run  # print the request count only
"""
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
import argparse, os

FID = '1Ek-vacbfgWq11I2WhLvz6yc5WAD7IFojXRnnGVd0i-4'
DASH_LAST = 204            # last provisioned dashboard row (setup_dashboard.py default)
FONT = 'Sarabun'           # Thai + Latin in one face, on Google Fonts (Sheets loads it)
MONO = 'Roboto Mono'
OWNED_PROTECTION = '[style_sheet]'   # prefix marks protections this script recreates


def rgb(h):
    h = h.lstrip('#')
    return {'red': int(h[0:2], 16) / 255, 'green': int(h[2:4], 16) / 255, 'blue': int(h[4:6], 16) / 255}


C = {
    'ink': rgb('#202124'), 'muted': rgb('#5F6368'), 'white': rgb('#FFFFFF'),
    'line': rgb('#DADCE0'), 'panel': rgb('#F1F3F4'), 'panel2': rgb('#F8F9FA'),
    'green': rgb('#137333'), 'green_bg': rgb('#E6F4EA'), 'band_g': rgb('#F4F9F5'),
    'amber': rgb('#B06000'), 'amber_bg': rgb('#FEF7E0'),
    'red': rgb('#C5221F'), 'red_bg': rgb('#FCE8E6'),
    'blue': rgb('#1A73E8'), 'blue_bg': rgb('#E8F0FE'), 'band_b': rgb('#F5F8FE'),
    'slate': rgb('#3C4043'), 'band_s': rgb('#F8F9FA'),
}

# HR_MAIN!V — what each CONFIG key does, in HR's language. Matched by key, not by row, so
# the block may be reordered; a key without an entry here is simply left undescribed.
CONFIG_HELP = {
    'TZ': 'เขตเวลา — ต้องเป็น Asia/Bangkok',
    'WORK_START': 'เวลาเข้างาน (HH:mm) — ใช้คำนวณ “สาย”',
    'LATE_GRACE_MIN': 'ผ่อนผันการมาสาย (นาที) — เข้าหลังเวลาเข้างานไม่เกินนี้ ไม่นับว่าสาย',
    'WORK_END': 'เวลาเลิกงาน (HH:mm) — ใช้คำนวณ “ออกก่อน” และเวลาปิดอัตโนมัติ',
    'EARLY_GRACE_MIN': 'ผ่อนผันการออกก่อน (นาที) — ออกก่อนเวลาเลิกงานไม่เกินนี้ ไม่ถูกแจ้ง',
    'WORK_DAYS': 'วันทำงาน เช่น MON,TUE,WED,THU,FRI — อีเมลสรุปส่งเฉพาะวันเหล่านี้',
    'HR_EMAIL': 'อีเมลที่รับรายงานประจำวัน',
    'DIGEST_TIME': 'เวลาส่งอีเมลสรุปผู้ยังไม่เข้างาน (ข้อมูลอ้างอิง — ทริกเกอร์ตั้งไว้ 09:15)',
    'EMAIL_ENABLED': 'TRUE = ส่งอีเมลทั้งสองฉบับ (09:15 และ 05:00) / FALSE = ปิด',
    'OFFICE_LAT': 'ละติจูดของออฟฟิศ (จุดศูนย์กลางการตรวจตำแหน่ง)',
    'OFFICE_LNG': 'ลองจิจูดของออฟฟิศ',
    'GEO_RADIUS_M': 'รัศมีที่นับว่าอยู่ในออฟฟิศ (เมตร)',
    'GEO_MAX_ACC_M': 'ความคลาดเคลื่อน GPS สูงสุดที่ยอมรับ (เมตร) — เกินนี้ถือว่าสัญญาณอ่อน ไม่ใช่อยู่ไกล',
    'GEO_MODE': 'OFF = บันทึกอย่างเดียว / WARN = แจ้งพนักงานด้วย / BLOCK = ไม่ให้ลงเวลานอกพื้นที่',
    'PUNCH_REQUIRE_GEO': 'TRUE = ลงเวลาได้เฉพาะหน้าลงเวลา (มีตำแหน่ง) / FALSE = พิมพ์ในแชทได้ด้วย',
    'SELF_REPORT_DAYS': 'พนักงานแจ้งเวลาเลิกงานที่ลืมได้ย้อนหลังกี่วัน (0 = ให้ HR ทำเท่านั้น)',
    'AUTO_CLOSE_DAYS': 'วันที่ค้างนานเท่านี้ ระบบปิดให้ที่เวลาเลิกงาน (0 = ปิดฟังก์ชัน)',
}


def grid(sid, r1, r2, c1, c2):
    """0-based, end-exclusive — the Sheets API GridRange."""
    return {'sheetId': sid, 'startRowIndex': r1, 'endRowIndex': r2,
            'startColumnIndex': c1, 'endColumnIndex': c2}


def fmt(rng, fields, **f):
    return {'repeatCell': {'range': rng, 'cell': {'userEnteredFormat': f},
                           'fields': ','.join('userEnteredFormat.' + x for x in fields)}}


def text(fg=None, bold=None, size=None, family=None, italic=None):
    t = {}
    if fg is not None: t['foregroundColor'] = fg
    if bold is not None: t['bold'] = bold
    if size is not None: t['fontSize'] = size
    if family is not None: t['fontFamily'] = family
    if italic is not None: t['italic'] = italic
    return t


def widths(sid, spec):
    """spec: {0-based col: px}"""
    return [{'updateDimensionProperties': {
        'range': {'sheetId': sid, 'dimension': 'COLUMNS', 'startIndex': c, 'endIndex': c + 1},
        'properties': {'pixelSize': px}, 'fields': 'pixelSize'}} for c, px in spec.items()]


def row_height(sid, r1, r2, px):
    return {'updateDimensionProperties': {
        'range': {'sheetId': sid, 'dimension': 'ROWS', 'startIndex': r1, 'endIndex': r2},
        'properties': {'pixelSize': px}, 'fields': 'pixelSize'}}


def header(rng, bg):
    return fmt(rng, ['backgroundColor', 'textFormat', 'horizontalAlignment', 'verticalAlignment'],
               backgroundColor=bg, textFormat=text(C['white'], True, 11, FONT),
               horizontalAlignment='CENTER', verticalAlignment='MIDDLE')


def band(rng, header_bg, band_bg):
    return {'addBanding': {'bandedRange': {'range': rng, 'rowProperties': {
        'headerColor': header_bg, 'firstBandColor': C['white'], 'secondBandColor': band_bg}}}}


def cf_text(rng, kind, value, fg, bg, bold=True):
    cond = {'type': kind}
    if value is not None:
        cond['values'] = [{'userEnteredValue': value}]
    return {'addConditionalFormatRule': {'index': 0, 'rule': {'ranges': [rng], 'booleanRule': {
        'condition': cond, 'format': {'textFormat': {'foregroundColor': fg, 'bold': bold},
                                      'backgroundColor': bg}}}}}


def border_box(rng, color):
    s = {'style': 'SOLID', 'color': color}
    return {'updateBorders': {'range': rng, 'top': s, 'bottom': s, 'left': s, 'right': s,
                              'innerHorizontal': s}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    creds = Credentials.from_authorized_user_file(os.path.expanduser('~/.hermes/google_token.json'))
    svc = build('sheets', 'v4', credentials=creds)
    meta = svc.spreadsheets().get(spreadsheetId=FID, fields=(
        'sheets(properties(sheetId,title,gridProperties),conditionalFormats,bandedRanges,'
        'merges,protectedRanges)')).execute()
    tabs = {s['properties']['title']: s for s in meta['sheets']}
    HR = tabs['HR_MAIN']['properties']['sheetId']
    EMP = tabs['EMPLOYEES_LOG']['properties']['sheetId']
    DATA = tabs['DATA']['properties']['sheetId']
    data_rows = tabs['DATA']['properties']['gridProperties']['rowCount']
    emp_rows = tabs['EMPLOYEES_LOG']['properties']['gridProperties']['rowCount']

    # Safety: rows 1-3 F:H and the H column must be empty or ours before we merge/format them.
    probe = svc.spreadsheets().values().get(
        spreadsheetId=FID, range='HR_MAIN!C1:E3', valueRenderOption='FORMULA').execute()
    stray = [c for row in probe.get('values', []) for c in row if str(c).strip()]
    if stray:
        raise SystemExit('HR_MAIN!C1:E3 is not empty (%r) — refusing to merge over it' % stray)

    R = []

    # ── tear down what this script owns, so a re-run never stacks ─────────────────────
    for t in tabs.values():
        for cf in reversed(range(len(t.get('conditionalFormats', [])))):
            R.append({'deleteConditionalFormatRule': {'sheetId': t['properties']['sheetId'], 'index': cf}})
        for b in t.get('bandedRanges', []):
            R.append({'deleteBanding': {'bandedRangeId': b['bandedRangeId']}})
        for p in t.get('protectedRanges', []):
            if p.get('description', '').startswith(OWNED_PROTECTION):
                R.append({'deleteProtectedRange': {'protectedRangeId': p['protectedRangeId']}})
    R.append({'unmergeCells': {'range': grid(HR, 0, 3, 0, 8)}})

    # ── whole-sheet base: one font, vertically centred ────────────────────────────────
    for sid, rows in ((HR, 1000), (EMP, emp_rows), (DATA, data_rows)):
        R.append(fmt(grid(sid, 0, rows, 0, 26), ['textFormat.fontFamily', 'textFormat.fontSize',
                                                 'verticalAlignment'],
                     textFormat=text(size=10, family=FONT), verticalAlignment='MIDDLE'))

    # ── tab look ──────────────────────────────────────────────────────────────────────
    for sid, color, hide in ((HR, C['green'], True), (EMP, C['blue'], False), (DATA, C['slate'], False)):
        R.append({'updateSheetProperties': {'properties': {
            'sheetId': sid, 'tabColorStyle': {'rgbColor': color},
            'gridProperties': {'hideGridlines': hide}},
            'fields': 'tabColorStyle,gridProperties.hideGridlines'}})

    # ════════════════════════════ HR_MAIN ════════════════════════════════════════════
    R += widths(HR, {0: 90, 1: 170, 2: 120, 3: 90, 4: 90, 5: 120, 6: 110, 7: 90,
                     19: 170, 20: 170, 21: 520})
    for c in range(8, 19):
        R += widths(HR, {c: 24})          # the gap between dashboard and CONFIG

    # rows 1-3: summary panel (labels A, values merged B:E) + today panel (F label, G:H value)
    for r in range(3):
        R.append({'mergeCells': {'range': grid(HR, r, r + 1, 1, 5), 'mergeType': 'MERGE_ALL'}})
        R.append({'mergeCells': {'range': grid(HR, r, r + 1, 6, 8), 'mergeType': 'MERGE_ALL'}})
    R.append(fmt(grid(HR, 0, 3, 0, 1), ['backgroundColor', 'textFormat', 'horizontalAlignment'],
                 backgroundColor=C['panel'], textFormat=text(C['slate'], True, 10, FONT),
                 horizontalAlignment='LEFT'))
    R.append(fmt(grid(HR, 0, 3, 1, 5), ['backgroundColor', 'textFormat', 'wrapStrategy',
                                       'horizontalAlignment'],
                 backgroundColor=C['white'], textFormat=text(C['ink'], True, 11, FONT),
                 wrapStrategy='WRAP', horizontalAlignment='LEFT'))
    R.append(fmt(grid(HR, 0, 3, 5, 6), ['backgroundColor', 'textFormat', 'horizontalAlignment'],
                 backgroundColor=C['panel'], textFormat=text(C['slate'], True, 10, FONT),
                 horizontalAlignment='LEFT'))
    R.append(fmt(grid(HR, 0, 3, 6, 8), ['backgroundColor', 'textFormat', 'horizontalAlignment'],
                 backgroundColor=C['white'], textFormat=text(C['ink'], True, 12, FONT),
                 horizontalAlignment='CENTER'))
    R.append(border_box(grid(HR, 0, 3, 0, 5), C['line']))
    R.append(border_box(grid(HR, 0, 3, 5, 8), C['line']))
    R.append(row_height(HR, 0, 3, 30))

    # row 4 header + body
    R.append(header(grid(HR, 3, 4, 0, 8), C['green']))
    R.append(row_height(HR, 3, 4, 34))
    R.append(row_height(HR, 4, DASH_LAST, 26))
    R.append(fmt(grid(HR, 4, DASH_LAST, 0, 1), ['textFormat', 'horizontalAlignment'],
                 textFormat=text(C['muted'], False, 10, MONO), horizontalAlignment='LEFT'))
    R.append(fmt(grid(HR, 4, DASH_LAST, 1, 3), ['textFormat', 'horizontalAlignment'],
                 textFormat=text(C['ink'], False, 10, FONT), horizontalAlignment='LEFT'))
    R.append(fmt(grid(HR, 4, DASH_LAST, 3, 8), ['textFormat', 'horizontalAlignment'],
                 textFormat=text(C['ink'], False, 10, FONT), horizontalAlignment='CENTER'))
    R.append(band(grid(HR, 3, DASH_LAST, 0, 8), C['green'], C['band_g']))

    # status chips — over the FULL provisioned range (the old rules stopped at row 24, so
    # the 21st employee got no colour)
    st = grid(HR, 4, DASH_LAST, 5, 6)
    R.append(cf_text(st, 'TEXT_EQ', 'ตรงเวลา', C['green'], C['green_bg']))
    R.append(cf_text(st, 'TEXT_EQ', 'สาย', C['amber'], C['amber_bg']))
    R.append(cf_text(st, 'TEXT_EQ', 'ยังไม่เข้างาน', C['red'], C['red_bg']))
    R.append(cf_text(grid(HR, 4, DASH_LAST, 6, 7), 'NOT_BLANK', None, C['amber'], C['amber_bg']))
    # summary cells: green when the formula reports the all-clear, otherwise a warning
    # (rules are inserted at index 0, so the all-clear rule is added LAST to win)
    R.append(cf_text(grid(HR, 0, 1, 1, 5), 'NOT_BLANK', None, C['amber'], C['amber_bg']))
    R.append(cf_text(grid(HR, 0, 1, 1, 5), 'TEXT_EQ', 'เข้างานครบทุกคน ✅', C['green'], C['green_bg']))
    R.append(cf_text(grid(HR, 2, 3, 1, 5), 'NOT_BLANK', None, C['red'], C['red_bg']))
    R.append(cf_text(grid(HR, 2, 3, 1, 5), 'TEXT_EQ', 'ไม่มีรายการค้าง ✅', C['green'], C['green_bg']))

    # CONFIG card (T4:V28). U stays plain TEXT: Sheets would otherwise turn 09:00 into a Date.
    R.append(header(grid(HR, 3, 4, 19, 22), C['slate']))
    R.append(fmt(grid(HR, 4, 28, 19, 20), ['backgroundColor', 'textFormat', 'horizontalAlignment'],
                 backgroundColor=C['panel2'], textFormat=text(C['slate'], False, 10, MONO),
                 horizontalAlignment='LEFT'))
    R.append(fmt(grid(HR, 4, 28, 20, 21), ['backgroundColor', 'textFormat', 'numberFormat',
                                         'horizontalAlignment'],
                 backgroundColor=C['white'], textFormat=text(C['ink'], True, 10, FONT),
                 numberFormat={'type': 'TEXT'}, horizontalAlignment='LEFT'))
    R.append(fmt(grid(HR, 4, 28, 21, 22), ['backgroundColor', 'textFormat', 'wrapStrategy'],
                 backgroundColor=C['white'], textFormat=text(C['muted'], False, 9, FONT, True),
                 wrapStrategy='WRAP'))
    R.append(border_box(grid(HR, 3, 28, 19, 22), C['line']))

    # ═════════════════════════ EMPLOYEES_LOG ═════════════════════════════════════════
    R += widths(EMP, {0: 90, 1: 180, 2: 120, 3: 110, 4: 150, 5: 110, 6: 80, 7: 300})
    R.append(header(grid(EMP, 0, 1, 0, 8), C['blue']))
    R.append(row_height(EMP, 0, 1, 34))
    R.append(band(grid(EMP, 0, emp_rows, 0, 8), C['blue'], C['band_b']))
    R.append(fmt(grid(EMP, 1, emp_rows, 0, 1), ['textFormat'], textFormat=text(C['ink'], True, 10, MONO)))
    R.append(fmt(grid(EMP, 1, emp_rows, 3, 4), ['textFormat', 'horizontalAlignment'],
                 textFormat=text(C['ink'], True, 11, MONO), horizontalAlignment='CENTER'))
    R.append(fmt(grid(EMP, 1, emp_rows, 4, 5), ['textFormat', 'wrapStrategy'],
                 textFormat=text(C['muted'], False, 8, MONO), wrapStrategy='CLIP'))
    R.append(fmt(grid(EMP, 1, emp_rows, 5, 7), ['horizontalAlignment'], horizontalAlignment='CENTER'))
    R.append(fmt(grid(EMP, 1, emp_rows, 7, 8), ['textFormat', 'wrapStrategy'],
                 textFormat=text(C['muted'], False, 10, FONT), wrapStrategy='WRAP'))
    ls = grid(EMP, 1, emp_rows, 5, 6)
    R.append(cf_text(ls, 'TEXT_EQ', 'blocked', C['red'], C['red_bg']))
    R.append(cf_text(ls, 'TEXT_EQ', 'pending', C['amber'], C['amber_bg']))
    R.append(cf_text(ls, 'TEXT_EQ', 'linked', C['green'], C['green_bg']))
    # a leaver (active = FALSE) greys out the whole row — kept for history, not on the board
    R.append({'addConditionalFormatRule': {'index': 0, 'rule': {
        'ranges': [grid(EMP, 1, emp_rows, 0, 8)], 'booleanRule': {
            'condition': {'type': 'CUSTOM_FORMULA',
                          'values': [{'userEnteredValue': '=AND($A2<>"",UPPER($G2&"")="FALSE")'}]},
            'format': {'textFormat': {'foregroundColor': rgb('#9AA0A6'), 'strikethrough': True}}}}}})

    # ═════════════════════════════ DATA ══════════════════════════════════════════════
    # four blocks, each with its own colour, separated by narrow blank gutters
    blocks = [(0, 5, C['green'], C['band_g']),    # A:E  punches
              (7, 12, C['slate'], C['band_s']),   # H:L  machine log
              (14, 17, C['red'], C['red_bg']),    # O:Q  errors
              (18, 26, C['blue'], C['band_b'])]   # S:Z  location checks
    for c1, c2, hd, bd in blocks:
        R.append(header(grid(DATA, 0, 1, c1, c2), hd))
        R.append(band(grid(DATA, 0, data_rows, c1, c2), hd, bd))
    for gutter in (5, 6, 12, 13, 17):
        R.append(fmt(grid(DATA, 0, 1, gutter, gutter + 1), ['backgroundColor'], backgroundColor=C['white']))
    R += widths(DATA, {0: 150, 1: 90, 2: 60, 3: 100, 4: 380, 5: 16, 6: 16,
                       7: 70, 8: 150, 9: 100, 10: 130, 11: 230, 12: 16, 13: 16,
                       14: 150, 15: 150, 16: 420, 17: 16,
                       18: 150, 19: 90, 20: 60, 21: 85, 22: 85, 23: 65, 24: 65, 25: 85})
    R.append(row_height(DATA, 0, 1, 34))
    for c in (0, 8, 14, 18):             # every block's ts column
        R.append(fmt(grid(DATA, 1, data_rows, c, c + 1), ['numberFormat', 'horizontalAlignment'],
                     numberFormat={'type': 'DATE_TIME', 'pattern': 'yyyy-mm-dd hh:mm:ss'},
                     horizontalAlignment='LEFT'))
    for c in (1, 2, 19, 20, 25):
        R.append(fmt(grid(DATA, 1, data_rows, c, c + 1), ['horizontalAlignment'], horizontalAlignment='CENTER'))
    R.append(fmt(grid(DATA, 1, data_rows, 4, 5), ['textFormat'], textFormat=text(C['muted'], False, 9, MONO)))
    R.append(fmt(grid(DATA, 1, data_rows, 16, 17), ['textFormat', 'wrapStrategy'],
                 textFormat=text(C['red'], False, 9, MONO), wrapStrategy='CLIP'))
    # event: in = green, out = blue
    ev = grid(DATA, 1, data_rows, 2, 3)
    R.append(cf_text(ev, 'TEXT_EQ', 'in', C['green'], C['green_bg']))
    R.append(cf_text(ev, 'TEXT_EQ', 'out', C['blue'], C['blue_bg']))
    # source: anything that is a claim rather than an observation is amber, so HR can scan
    # the ledger for rows no phone produced
    src = grid(DATA, 1, data_rows, 3, 4)
    for s in ('auto_close', 'self_report', 'hr_fix'):
        R.append(cf_text(src, 'TEXT_EQ', s, C['amber'], C['amber_bg']))
    R.append(cf_text(src, 'TEXT_EQ', 'line', C['muted'], C['panel'], bold=False))
    # geo verdict
    vd = grid(DATA, 1, data_rows, 25, 26)
    R.append(cf_text(vd, 'TEXT_EQ', 'ok', C['green'], C['green_bg']))
    R.append(cf_text(vd, 'TEXT_EQ', 'far', C['red'], C['red_bg']))
    for v in ('weak_fix', 'no_fix', 'no_office'):
        R.append(cf_text(vd, 'TEXT_EQ', v, C['amber'], C['amber_bg']))

    # ── warning-only protections: HR can still edit, but gets asked first. Script writes
    #    (as the owner) are never affected.
    for rng, why in ((grid(HR, 0, DASH_LAST, 0, 8), 'แดชบอร์ดเป็นสูตรอัตโนมัติ — ไม่ต้องแก้ไขด้วยมือ'),
                     (grid(DATA, 0, data_rows, 0, 26), 'บันทึกโดยระบบเท่านั้น — การแก้ไขด้วยมือทำให้ประวัติการลงเวลาเชื่อถือไม่ได้')):
        R.append({'addProtectedRange': {'protectedRange': {
            'range': rng, 'description': OWNED_PROTECTION + ' ' + why, 'warningOnly': True}}})

    # ── CONFIG descriptions (values, column V only) ───────────────────────────────────
    cfg = svc.spreadsheets().values().get(spreadsheetId=FID, range='HR_MAIN!T4:T28').execute().get('values', [])
    help_rows = [['คำอธิบาย']]
    for row in cfg[1:]:
        key = (row[0] if row else '').strip()
        help_rows.append([CONFIG_HELP.get(key, '')])
    while len(help_rows) < 25:
        help_rows.append([''])

    print('%d formatting requests, %d CONFIG descriptions' % (
        len(R), sum(1 for r in help_rows[1:] if r[0])))
    if args.dry_run:
        print('dry run — nothing written')
        return

    svc.spreadsheets().batchUpdate(spreadsheetId=FID, body={'requests': R}).execute()
    svc.spreadsheets().values().update(
        spreadsheetId=FID, range='HR_MAIN!V4:V28', valueInputOption='RAW',
        body={'values': help_rows}).execute()
    print('applied')


if __name__ == '__main__':
    main()
