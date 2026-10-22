/**
 * geo.gs — distance and the location verdict. Pure functions: no sheet, no network.
 *
 * ⚠️ What this file is NOT: proof. Every coordinate here comes from the employee's own
 *    phone, so it is evidence about a device, not about a person. A phone can lie about
 *    where it is (a mock-location provider, a spoofed fix) and a WebView cannot detect
 *    that. The one signal this system can obtain that a phone cannot fabricate is a
 *    LINE Beacon event, which lives outside this file.
 *
 * So the verdict is a *weight* for HR, not a gate. GEO_MODE decides what happens when a
 * verdict fails:
 *
 *   OFF    record the verdict, punch anyway     ← shadow mode; start here
 *   WARN   record it, tell the employee, punch anyway
 *   BLOCK  refuse the punch
 *
 * Start on OFF. Indoor GPS drift, a denied permission and the iOS 16.4 geolocation bug
 * all look identical to a faker, and none of them should strand someone at 09:00.
 */

/** The only values geoCheck_().verdict can take. */
var GEO_VERDICT = {
  OK:        'ok',         // inside the radius, fix precise enough
  FAR:       'far',        // outside the radius
  WEAK_FIX:  'weak_fix',   // accuracy too poor to decide (indoors, no GPS lock)
  NO_FIX:    'no_fix',     // the page sent no usable coordinates
  NO_OFFICE: 'no_office'   // OFFICE_LAT / OFFICE_LNG not configured yet
};

/**
 * Classify one reported position against the office.
 *
 * @param {Object} cfg  the CONFIG block (OFFICE_LAT, OFFICE_LNG, GEO_RADIUS_M, ...)
 * @param {*} lat       latitude the page reported
 * @param {*} lng       longitude the page reported
 * @param {*} accM      accuracy radius in metres the page reported (may be null)
 * @returns {Object} { verdict, distM, accM, lat, lng, mode, pass }
 *                   lat/lng are rounded to 4 decimals (~11 m) before they are returned,
 *                   so the ledger never stores more precision than attendance needs.
 */
function geoCheck_(cfg, lat, lng, accM) {
  var mode = String(cfg.GEO_MODE || 'OFF').toUpperCase();
  var out = {
    verdict: GEO_VERDICT.NO_FIX,
    distM: null, accM: null, lat: null, lng: null,
    mode: mode, pass: false
  };

  var la = numOrNull_(lat);
  var ln = numOrNull_(lng);
  var ac = numOrNull_(accM);
  if (!isLatLng_(la, ln)) return out;                  // no_fix

  out.lat = round4_(la);
  out.lng = round4_(ln);
  out.accM = (ac === null) ? null : Math.round(ac);

  var officeLat = numOrNull_(cfg.OFFICE_LAT);
  var officeLng = numOrNull_(cfg.OFFICE_LNG);
  if (!isLatLng_(officeLat, officeLng)) {              // no_office
    out.verdict = GEO_VERDICT.NO_OFFICE;
    return out;
  }

  var dist = haversineM_(la, ln, officeLat, officeLng);
  out.distM = Math.round(dist);

  var radius = parseFloat(cfg.GEO_RADIUS_M);
  if (!isFinite(radius) || radius <= 0) radius = 150;
  var maxAcc = parseFloat(cfg.GEO_MAX_ACC_M);
  if (!isFinite(maxAcc) || maxAcc <= 0) maxAcc = 150;

  // An imprecise fix outranks distance: a 900 m accuracy radius makes the distance
  // meaningless, so "weak_fix" must win over "far" — otherwise a bad indoor fix reads
  // as fraud.
  if (out.accM === null || out.accM > maxAcc) out.verdict = GEO_VERDICT.WEAK_FIX;
  else if (dist > radius)                    out.verdict = GEO_VERDICT.FAR;
  else                                       out.verdict = GEO_VERDICT.OK;

  out.pass = (out.verdict === GEO_VERDICT.OK);
  return out;
}

/**
 * Great-circle distance in metres between two WGS84 points.
 * Haversine on a spherical Earth (R = 6 371 km) — the error at office scale is well
 * under the GPS noise we are measuring, so a geodesic library would be false precision.
 */
function haversineM_(lat1, lng1, lat2, lng2) {
  var R = 6371000;
  var toRad = Math.PI / 180;
  var dLat = (lat2 - lat1) * toRad;
  var dLng = (lng2 - lng1) * toRad;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
          Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * The punch-ledger note (DATA!E) for a geo punch. Short and greppable: HR reads
 * "geo:far 1200m" at a glance, and a later report can count verdicts with COUNTIF.
 * Returns '' when there was no geo at all, so a plain menu punch looks untouched.
 */
function geoNote_(geo) {
  if (!geo) return '';
  var note = 'geo:' + geo.verdict;
  if (geo.distM !== null && geo.distM !== undefined) note += ' ' + geo.distM + 'm';
  if (geo.verdict === GEO_VERDICT.WEAK_FIX && geo.accM !== null) note += ' acc' + geo.accM + 'm';
  return note;
}

/**
 * Append the location line to a punch reply. A verified punch always says so (the
 * employee should see that the check happened); a failure only speaks up in WARN mode,
 * where HR has decided the employee needs to know.
 */
function decorateGeo_(text, geo) {
  if (!geo) return text;
  // Every suffix already begins with "\n", so do not add another one — that produced a
  // blank line between the punch line and the location line in the chat bubble.
  if (geo.pass) return text + fill_(MSG.GEO_OK_SUFFIX, { dist: geo.distM });
  if (String(geo.mode).toUpperCase() === 'WARN') return text + geoWarnSuffix_(geo);
  return text;
}

/** The warning line for a failed verdict. */
function geoWarnSuffix_(geo) {
  switch (geo.verdict) {
    case GEO_VERDICT.FAR:
      return fill_(MSG.GEO_FAR_SUFFIX, { dist: geo.distM });
    case GEO_VERDICT.WEAK_FIX:
      return fill_(MSG.GEO_WEAK_SUFFIX, { acc: geo.accM === null ? '?' : geo.accM });
    case GEO_VERDICT.NO_OFFICE:
      return MSG.GEO_NO_OFFICE_SUFFIX;
    default:
      return MSG.GEO_NOFIX_SUFFIX;
  }
}

/* ---- small numeric helpers ---- */

/** A finite number, or null. Accepts a numeric string (query params arrive as text). */
function numOrNull_(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = parseFloat(v);
  return isFinite(n) ? n : null;
}

function isLatLng_(lat, lng) {
  return lat !== null && lng !== null &&
         Math.abs(lat) <= 90 && Math.abs(lng) <= 180 &&
         !(lat === 0 && lng === 0);            // 0,0 is a null island fix, never an office
}

function round4_(n) { return Math.round(n * 10000) / 10000; }
