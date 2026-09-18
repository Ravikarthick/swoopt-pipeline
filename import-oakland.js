// import-oakland.js — pulls Oakland street sweeping routes into sf_cle.db
// Usage: node import-oakland.js      (idempotent: replaces all city='OAK' rows)
// Source: City of Oakland "Street Sweeping Routes" ArcGIS feature service.
// Day/time codes decoded from the service's official coded-value domains.
var path = require('path');
var https = require('https');
var Database = require('better-sqlite3');

var DB_PATH = process.env.DB_PATH || path.join(__dirname, 'sf_cle.db');
var URL_BASE = 'https://services.arcgis.com/9tC74aDHuml0x5Yz/arcgis/rest/services/StreetSweeping/FeatureServer/0/query';
var PAGE = 1000;

// Weekday indexes: Sun=0 ... Sat=6
var DAY_CODES = {
  // every week
  'E':     { days: [0,1,2,3,4,5,6], weeks: [1,2,3,4,5] },
  'EEH':   { days: [0,1,2,3,4,5,6], weeks: [1,2,3,4,5] },
  'EESSH': { days: [1,2,3,4,5],     weeks: [1,2,3,4,5] },
  'MF':    { days: [1,2,3,4,5],     weeks: [1,2,3,4,5] },
  'ME':    { days: [1], weeks: [1,2,3,4,5] },
  'TE':    { days: [2], weeks: [1,2,3,4,5] },
  'WE':    { days: [3], weeks: [1,2,3,4,5] },
  'THE':   { days: [4], weeks: [1,2,3,4,5] },
  'FE':    { days: [5], weeks: [1,2,3,4,5] },
  'S':     { days: [6], weeks: [1,2,3,4,5] },
  'SU':    { days: [0], weeks: [1,2,3,4,5] },
  'MWF':   { days: [1,3,5], weeks: [1,2,3,4,5] },
  'TTHS':  { days: [2,4,6], weeks: [1,2,3,4,5] },
  'TTH':   { days: [2,4],   weeks: [1,2,3,4,5] },
  'TTHE':  { days: [2,4],   weeks: [1,2,3,4,5] },
  'TFE':   { days: [2,5],   weeks: [1,2,3,4,5] },
  'MTHE':  { days: [1,4],   weeks: [1,2,3,4,5] },
  'THFE':  { days: [4,5],   weeks: [1,2,3,4,5] },
  'MFE':   { days: [1,5],   weeks: [1,2,3,4,5] },
  // monthly patterns
  'M1':   { days: [1], weeks: [1] },   'M2':   { days: [1], weeks: [2] },
  'M13':  { days: [1], weeks: [1,3] }, 'M24':  { days: [1], weeks: [2,4] },
  'T1':   { days: [2], weeks: [1] },   'T2':   { days: [2], weeks: [2] },
  'T13':  { days: [2], weeks: [1,3] }, 'T24':  { days: [2], weeks: [2,4] },
  'W2':   { days: [3], weeks: [2] },   'W4':   { days: [3], weeks: [4] },
  'W13':  { days: [3], weeks: [1,3] }, 'FW':   { days: [3], weeks: [1] },
  'TH1':  { days: [4], weeks: [1] },   'TH2':  { days: [4], weeks: [2] },
  'TH4':  { days: [4], weeks: [4] },   'TH13': { days: [4], weeks: [1,3] },
  'F1':   { days: [5], weeks: [1] },   'F2':   { days: [5], weeks: [2] },
  'F4':   { days: [5], weeks: [4] },   'F13':  { days: [5], weeks: [1,3] }
};
// Everything else (N, N-S, N-O, N-E, NS, NS-UC, NS-H, NS-O, NS-A, O, DM, MS, missing) = no sweeping on that side.

var TIME_CODES = {
  'M1':  { from: 0,  to: 3 },   // 12:00AM-3:00AM
  'M23': { from: 2,  to: 3 },   // 2:00AM-3:00AM
  'M2':  { from: 3,  to: 6 },   // 3:00AM-6:00AM
  'M68': { from: 6,  to: 8 },   // 6:00AM-8:00AM
  'M3':  { from: 9,  to: 12 },  // 9:00AM-12:00PM
  'A1':  { from: 12, to: 16 }   // 12:30PM-3:30PM (rounded outward)
};
// 'NA'/missing with a real day code: Oakland residential sweeping runs after 8 AM
// until ~2:30 PM per the city, so use 8-15 as the window.
var DEFAULT_TIME = { from: 8, to: 15 };

function fetchJson(url) {
  return new Promise(function (resolve, reject) {
    https.get(url, function (res) {
      var body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('bad JSON')); } });
    }).on('error', reject);
  });
}

async function fetchAll() {
  var all = [], offset = 0;
  while (true) {
    var url = URL_BASE + '?where=1%3D1&outFields=OBJECTID,NAME,TYPE,PREFIX,SUFFIX,L_F_ADD,L_T_ADD,R_F_ADD,R_T_ADD,DAY_ODD,TIME_ODD,DAY_EVEN,TIME_EVEN,ROUTE' +
      '&outSR=4326&returnGeometry=true&f=json&resultOffset=' + offset + '&resultRecordCount=' + PAGE;
    var d = await fetchJson(url);
    var feats = d.features || [];
    all = all.concat(feats);
    process.stdout.write('  fetched ' + all.length + '\r');
    if (!d.exceededTransferLimit || feats.length === 0) break;
    offset += feats.length;
  }
  console.log('');
  return all;
}

function bbox(coords) {
  var b = { minLng: Infinity, maxLng: -Infinity, minLat: Infinity, maxLat: -Infinity, sLng: 0, sLat: 0 };
  coords.forEach(function (c) {
    if (c[0] < b.minLng) b.minLng = c[0]; if (c[0] > b.maxLng) b.maxLng = c[0];
    if (c[1] < b.minLat) b.minLat = c[1]; if (c[1] > b.maxLat) b.maxLat = c[1];
    b.sLng += c[0]; b.sLat += c[1];
  });
  b.cLng = b.sLng / coords.length; b.cLat = b.sLat / coords.length;
  return b;
}

function streetName(a) {
  return [a.PREFIX, a.NAME, a.TYPE, a.SUFFIX].map(function (s) { return (s || '').trim(); }).filter(Boolean).join(' ') || 'Unknown';
}

// Which polyline side (L/R, relative to coordinate order) carries the ODD addresses?
// Dynamap/TIGER: L_* address ranges are the left side when travelling from->to.
function oddSideIs(a) {
  var l = parseInt(String(a.L_F_ADD || '').trim(), 10);
  var r = parseInt(String(a.R_F_ADD || '').trim(), 10);
  if (!isNaN(l)) return (l % 2 === 1) ? 'L' : 'R';
  if (!isNaN(r)) return (r % 2 === 1) ? 'R' : 'L';
  return 'L'; // no address data: assume odd on the left
}

async function main() {
  var db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  var cols = db.prepare("PRAGMA table_info(segments)").all().map(function (c) { return c.name; });
  if (cols.indexOf('city') < 0) db.exec("ALTER TABLE segments ADD COLUMN city TEXT NOT NULL DEFAULT 'SF'");
  if (cols.indexOf('enforced') < 0) db.exec("ALTER TABLE segments ADD COLUMN enforced INTEGER NOT NULL DEFAULT 1");
  db.exec("CREATE INDEX IF NOT EXISTS idx_seg_city ON segments(city)");

  var old = db.prepare("SELECT id FROM segments WHERE city = 'OAK'").all().map(function (r) { return r.id; });
  if (old.length) {
    var del = db.prepare("DELETE FROM schedules WHERE segment_id = ?");
    old.forEach(function (id) { del.run(id); });
    db.prepare("DELETE FROM segments WHERE city = 'OAK'").run();
    console.log('Removed previous OAK rows: ' + old.length);
  }

  var insSeg = db.prepare("INSERT INTO segments (cnn, corridor, limits_desc, side, block_side, block_sweep_id, geom_json, min_lng, max_lng, min_lat, max_lat, center_lng, center_lat, city, enforced) VALUES (?,?,?,?,?,NULL,?,?,?,?,?,?,?,'OAK',1)");
  var insSch = db.prepare("INSERT INTO schedules (segment_id, weekday, from_hour, to_hour, week1, week2, week3, week4, week5, holidays) VALUES (?,?,?,?,?,?,?,?,?,0)");

  console.log('Fetching Oakland street sweeping routes...');
  var feats = await fetchAll();
  var stats = { features: feats.length, segments: 0, schedules: 0, noSchedule: 0, unknownCodes: {} };

  db.transaction(function () {
    feats.forEach(function (f) {
      var a = f.attributes || {};
      var paths = (f.geometry && f.geometry.paths) || [];
      if (!paths.length) return;
      var oddSide = oddSideIs(a);
      var sides = [
        { side: oddSide,                    dayCode: (a.DAY_ODD  || '').trim(),  timeCode: (a.TIME_ODD  || '').trim(), label: 'Odd' },
        { side: oddSide === 'L' ? 'R' : 'L', dayCode: (a.DAY_EVEN || '').trim(), timeCode: (a.TIME_EVEN || '').trim(), label: 'Even' }
      ];
      var any = false;
      var cnn = 'OAK-' + a.OBJECTID;
      var limits = [String(a.L_F_ADD || '').trim(), String(a.L_T_ADD || '').trim()].filter(Boolean).join('-') || 'Oakland';
      sides.forEach(function (s) {
        var rule = DAY_CODES[s.dayCode];
        if (!rule) {
          if (s.dayCode && !/^(N|N-S|N-O|N-E|NS|NS-UC|NS-H|NS-O|NS-A|O|DM|MS|missing|NA|None)$/.test(s.dayCode)) {
            stats.unknownCodes[s.dayCode] = (stats.unknownCodes[s.dayCode] || 0) + 1;
          }
          return;
        }
        var time = TIME_CODES[s.timeCode] || DEFAULT_TIME;
        paths.forEach(function (coords) {
          if (!coords || coords.length < 2) return;
          var bb = bbox(coords);
          var r = insSeg.run(cnn, streetName(a), limits, s.side, s.label + ' addresses', JSON.stringify(coords),
            bb.minLng, bb.maxLng, bb.minLat, bb.maxLat, bb.cLng, bb.cLat);
          stats.segments++;
          rule.days.forEach(function (wd) {
            var w = [1,2,3,4,5].map(function (n) { return rule.weeks.indexOf(n) >= 0 ? 1 : 0; });
            insSch.run(r.lastInsertRowid, wd, time.from, time.to, w[0], w[1], w[2], w[3], w[4]);
            stats.schedules++;
          });
          any = true;
        });
      });
      if (!any) stats.noSchedule++;
    });
  })();

  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  console.log('Done:', JSON.stringify(stats));
}

main().catch(function (e) { console.error('Import failed:', e.message); process.exit(1); });
