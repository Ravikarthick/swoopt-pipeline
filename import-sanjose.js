// import-sanjose.js — pulls San Jose street sweeping routes into sf_cle.db
// Usage: node import-sanjose.js
// Idempotent: re-running replaces all city='SJ' rows.
var path = require('path');
var https = require('https');
var Database = require('better-sqlite3');

var DB_PATH = process.env.DB_PATH || path.join(__dirname, 'sf_cle.db');
var BASE = 'https://geo.sanjoseca.gov/server/rest/services/OPN/OPN_OpenDataService/MapServer/';
var LAYERS = [
  { id: 515, label: 'Residential' },
  { id: 516, label: 'Major roads' }
];
var PAGE = 2000;
var DAY_IDX = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

function fetchJson(url) {
  return new Promise(function (resolve, reject) {
    https.get(url, function (res) {
      var body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('bad JSON from ' + url)); }
      });
    }).on('error', reject);
  });
}

async function fetchLayer(layerId) {
  var all = [];
  var offset = 0;
  while (true) {
    var url = BASE + layerId + '/query?where=1%3D1&outFields=OBJECTID,CENTERLINEID,ROADNAME,ROADFROM,ROADTO,ROUTETYPE,SIDEOFROAD,APPWEEKDAYCODE,APPSCHEDULEDTIME,PROGRAM' +
      '&outSR=4326&returnGeometry=true&f=json&resultOffset=' + offset + '&resultRecordCount=' + PAGE;
    var d = await fetchJson(url);
    var feats = d.features || [];
    all = all.concat(feats);
    process.stdout.write('  layer ' + layerId + ': ' + all.length + ' fetched\r');
    if (!d.exceededTransferLimit || feats.length === 0) break;
    offset += feats.length;
  }
  console.log('');
  return all;
}

// "8am - 4:30pm" -> { from: 8, to: 17 }  (start floors, end ceils = conservative)
// overnight "10pm - 6am" -> { from: 22, to: 24 } (window capped at midnight; the pre-sweep reminder is what matters)
function parseHours(s) {
  if (!s) return null;
  var m = String(s).toLowerCase().match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*-\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
  if (!m) return null;
  function to24(h, mm, ap) {
    h = parseInt(h, 10) % 12;
    if (ap === 'pm') h += 12;
    return h + (mm ? parseInt(mm, 10) / 60 : 0);
  }
  var from = to24(m[1], m[2], m[3]);
  var to = to24(m[4], m[5], m[6]);
  var fromH = Math.floor(from);
  var toH = Math.ceil(to);
  if (toH <= fromH) toH = 24;          // overnight window: cap at midnight
  if (toH > 24) toH = 24;
  return { from: fromH, to: toH };
}

// "Monday,Wednesday,1,2" -> [{ weekday:1, weeks:[1,2] }, { weekday:3, weeks:[1,2] }]
function parseDayCode(code) {
  if (!code) return [];
  var parts = String(code).split(',').map(function (p) { return p.trim(); }).filter(Boolean);
  var days = [], weeks = [];
  parts.forEach(function (p) {
    var lc = p.toLowerCase();
    if (DAY_IDX.hasOwnProperty(lc)) days.push(DAY_IDX[lc]);
    else if (/^\d$/.test(p)) weeks.push(parseInt(p, 10));
  });
  if (weeks.length === 0) weeks = [1, 2, 3, 4, 5];
  // "every week" codes list 1-4; the 5th occurrence is still swept
  if ([1, 2, 3, 4].every(function (w) { return weeks.indexOf(w) >= 0; }) && weeks.indexOf(5) < 0) weeks.push(5);
  return days.map(function (d) { return { weekday: d, weeks: weeks }; });
}

// Convert compass side to L/R relative to the polyline's overall direction
function compassToLR(side, coords) {
  var a = coords[0], b = coords[coords.length - 1];
  var dx = b[0] - a[0], dy = b[1] - a[1];
  var right = [dy, -dx]; // right-hand perpendicular in (lng,lat) space
  var vec = { east: [1, 0], west: [-1, 0], north: [0, 1], south: [0, -1] }[String(side).toLowerCase()];
  if (!vec) return null;
  var dot = right[0] * vec[0] + right[1] * vec[1];
  return dot >= 0 ? 'R' : 'L';
}

function bbox(coords) {
  var minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity, sLng = 0, sLat = 0;
  coords.forEach(function (c) {
    if (c[0] < minLng) minLng = c[0]; if (c[0] > maxLng) maxLng = c[0];
    if (c[1] < minLat) minLat = c[1]; if (c[1] > maxLat) maxLat = c[1];
    sLng += c[0]; sLat += c[1];
  });
  return { minLng: minLng, maxLng: maxLng, minLat: minLat, maxLat: maxLat, cLng: sLng / coords.length, cLat: sLat / coords.length };
}

async function main() {
  var db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Schema additions (safe if already present)
  var cols = db.prepare("PRAGMA table_info(segments)").all().map(function (c) { return c.name; });
  if (cols.indexOf('city') < 0) db.exec("ALTER TABLE segments ADD COLUMN city TEXT NOT NULL DEFAULT 'SF'");
  if (cols.indexOf('enforced') < 0) db.exec("ALTER TABLE segments ADD COLUMN enforced INTEGER NOT NULL DEFAULT 1");
  db.exec("CREATE INDEX IF NOT EXISTS idx_seg_city ON segments(city)");

  // Wipe previous SJ import
  var old = db.prepare("SELECT id FROM segments WHERE city = 'SJ'").all().map(function (r) { return r.id; });
  if (old.length) {
    var del = db.prepare("DELETE FROM schedules WHERE segment_id = ?");
    old.forEach(function (id) { del.run(id); });
    db.prepare("DELETE FROM segments WHERE city = 'SJ'").run();
    console.log('Removed previous SJ rows: ' + old.length);
  }

  var insSeg = db.prepare("INSERT INTO segments (cnn, corridor, limits_desc, side, block_side, block_sweep_id, geom_json, min_lng, max_lng, min_lat, max_lat, center_lng, center_lat, city, enforced) VALUES (?,?,?,?,?,NULL,?,?,?,?,?,?,?,'SJ',?)");
  var insSch = db.prepare("INSERT INTO schedules (segment_id, weekday, from_hour, to_hour, week1, week2, week3, week4, week5, holidays) VALUES (?,?,?,?,?,?,?,?,?,0)");

  var stats = { features: 0, segments: 0, schedules: 0, skippedMedian: 0, skippedNoSched: 0, skippedNoGeom: 0 };

  for (var li = 0; li < LAYERS.length; li++) {
    var layer = LAYERS[li];
    console.log('Fetching ' + layer.label + ' (layer ' + layer.id + ')...');
    var feats = await fetchLayer(layer.id);
    stats.features += feats.length;

    var tx = db.transaction(function (features) {
      features.forEach(function (f) {
        var a = f.attributes || {};
        var paths = (f.geometry && f.geometry.paths) || [];
        if (a.ROUTETYPE === 'Median Island') { stats.skippedMedian++; return; }
        if (!paths.length) { stats.skippedNoGeom++; return; }
        var hours = parseHours(a.APPSCHEDULEDTIME);
        var dayRules = parseDayCode(a.APPWEEKDAYCODE);
        if (!hours || !dayRules.length) { stats.skippedNoSched++; return; }

        var enforced = a.ROUTETYPE === 'Signed Route' ? 1 : 0;
        var cnn = 'SJ-' + a.OBJECTID;
        var limits = [a.ROADFROM, a.ROADTO].filter(Boolean).join(' - ');

        paths.forEach(function (coords) {
          if (!coords || coords.length < 2) return;
          var sides;
          var compass = String(a.SIDEOFROAD || 'Both');
          if (compass === 'Both') sides = ['L', 'R'];
          else { var lr = compassToLR(compass, coords); sides = lr ? [lr] : ['L', 'R']; }
          var bb = bbox(coords);
          sides.forEach(function (side) {
            var r = insSeg.run(cnn, a.ROADNAME || 'Unknown', limits, side, compass, JSON.stringify(coords),
              bb.minLng, bb.maxLng, bb.minLat, bb.maxLat, bb.cLng, bb.cLat, enforced);
            stats.segments++;
            dayRules.forEach(function (rule) {
              var w = [1, 2, 3, 4, 5].map(function (n) { return rule.weeks.indexOf(n) >= 0 ? 1 : 0; });
              insSch.run(r.lastInsertRowid, rule.weekday, hours.from, hours.to, w[0], w[1], w[2], w[3], w[4]);
              stats.schedules++;
            });
          });
        });
      });
    });
    tx(feats);
  }

  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  console.log('Done:', JSON.stringify(stats));
}

main().catch(function (e) { console.error('Import failed:', e.message); process.exit(1); });
