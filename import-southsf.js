// import-southsf.js — South San Francisco street sweeping routes into sf_cle.db
// Usage: node import-southsf.js   (idempotent: replaces all city='SSF' rows)
// Source: SSF_Streetsweeping ArcGIS feature service (weekly sweep day per street).
// The city data carries only the day; hours are not published per street, so a
// conservative 7:00-15:00 window is used. Posted signs are the final authority.
var path = require('path');
var https = require('https');
var Database = require('better-sqlite3');

var DB_PATH = process.env.DB_PATH || path.join(__dirname, 'sf_cle.db');
var URL_BASE = 'https://services5.arcgis.com/inY93B27l4TSbT7h/arcgis/rest/services/SSF_Streetsweeping/FeatureServer/0/query';
var PAGE = 1000;
var DAY_IDX = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
var FROM_HOUR = 7, TO_HOUR = 15;

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
    var url = URL_BASE + '?where=1%3D1&outFields=FID,StName,RouteName,Classifica&outSR=4326&returnGeometry=true&f=json&resultOffset=' + offset + '&resultRecordCount=' + PAGE;
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

// "Monday & Tuesday" -> [1, 2]; "No Route"/"No Info"/blank -> []
function parseDays(routeName) {
  var s = String(routeName || '').toLowerCase();
  if (!s.trim() || s.indexOf('no ') === 0) return [];
  var days = [];
  Object.keys(DAY_IDX).forEach(function (name) { if (s.indexOf(name) >= 0) days.push(DAY_IDX[name]); });
  return days;
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

function prettyStreet(s) {
  // "HILLSIDE BLVD 0 Block" -> "Hillside Blvd"
  var name = String(s || '').replace(/\s+\d+\s+Block$/i, '').trim();
  return name.toLowerCase().replace(/\b\w/g, function (c) { return c.toUpperCase(); }) || 'Unknown';
}
function blockOf(s) { var m = String(s || '').match(/(\d+)\s+Block$/i); return m ? m[1] + ' block' : 'South San Francisco'; }

async function main() {
  var db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  var cols = db.prepare("PRAGMA table_info(segments)").all().map(function (c) { return c.name; });
  if (cols.indexOf('city') < 0) db.exec("ALTER TABLE segments ADD COLUMN city TEXT NOT NULL DEFAULT 'SF'");
  if (cols.indexOf('enforced') < 0) db.exec("ALTER TABLE segments ADD COLUMN enforced INTEGER NOT NULL DEFAULT 1");
  db.exec("CREATE INDEX IF NOT EXISTS idx_seg_city ON segments(city)");

  var old = db.prepare("SELECT id FROM segments WHERE city = 'SSF'").all().map(function (r) { return r.id; });
  if (old.length) {
    var del = db.prepare("DELETE FROM schedules WHERE segment_id = ?");
    old.forEach(function (id) { del.run(id); });
    db.prepare("DELETE FROM segments WHERE city = 'SSF'").run();
    console.log('Removed previous SSF rows: ' + old.length);
  }

  var insSeg = db.prepare("INSERT INTO segments (cnn, corridor, limits_desc, side, block_side, block_sweep_id, geom_json, min_lng, max_lng, min_lat, max_lat, center_lng, center_lat, city, enforced) VALUES (?,?,?,?,?,NULL,?,?,?,?,?,?,?,'SSF',1)");
  var insSch = db.prepare("INSERT INTO schedules (segment_id, weekday, from_hour, to_hour, week1, week2, week3, week4, week5, holidays) VALUES (?,?,?,?,1,1,1,1,1,0)");

  console.log('Fetching South San Francisco street sweeping routes...');
  var feats = await fetchAll();
  var stats = { features: feats.length, segments: 0, schedules: 0, noRoute: 0 };

  db.transaction(function () {
    feats.forEach(function (f) {
      var a = f.attributes || {};
      var days = parseDays(a.RouteName);
      var paths = (f.geometry && f.geometry.paths) || [];
      if (!days.length || !paths.length) { stats.noRoute++; return; }
      var cnn = 'SSF-' + a.FID;
      paths.forEach(function (coords) {
        if (!coords || coords.length < 2) return;
        var bb = bbox(coords);
        ['L', 'R'].forEach(function (side) {
          var r = insSeg.run(cnn, prettyStreet(a.StName), blockOf(a.StName), side, 'Both', JSON.stringify(coords),
            bb.minLng, bb.maxLng, bb.minLat, bb.maxLat, bb.cLng, bb.cLat);
          stats.segments++;
          days.forEach(function (wd) { insSch.run(r.lastInsertRowid, wd, FROM_HOUR, TO_HOUR); stats.schedules++; });
        });
      });
    });
  })();

  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  console.log('Done:', JSON.stringify(stats));
}

main().catch(function (e) { console.error('Import failed:', e.message); process.exit(1); });
