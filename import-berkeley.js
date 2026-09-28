// import-berkeley.js — Berkeley street sweeping routes into sf_cle.db
// Usage: node import-berkeley.js   (idempotent: replaces all city='BRK' rows)
// Source: City of Berkeley GIS "Street Sweep Routes" (Portal_CommSvcs layer 7).
// Route codes encode the schedule, e.g. "1stMON912" = 1st Monday 9:00-12:00,
// "2ndTHUR1230330" = 2nd Thursday 12:30-3:30. Street names come from the city's
// street centerline layer (nearest centerline to each sweep segment).
var path = require('path');
var https = require('https');
var Database = require('better-sqlite3');

var DB_PATH = process.env.DB_PATH || path.join(__dirname, 'sf_cle.db');
var BASE = 'https://gis.cityofberkeley.info/arcgis3/rest/services/Public/';
var ROUTES = BASE + 'Portal_CommSvcs/MapServer/7/query';
var ADDRESSES = BASE + 'GISPortal/MapServer/0/query'; // 62k address points: FEANME + FEATYP
var DAY_IDX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
var ORD = { '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5 };
var DEFAULT_TIME = { from: 9, to: 16 }; // Berkeley sweeps 9-12 or 12:30-3:30; unknown -> cover both

function fetchJson(url) {
  return new Promise(function (resolve, reject) {
    https.get(url, function (res) {
      var body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('bad JSON from ' + url.slice(0, 80))); } });
    }).on('error', reject);
  });
}

async function fetchAll(base, fields, pageSize) {
  var all = [], offset = 0;
  while (true) {
    var url = base + '?where=1%3D1&outFields=' + fields + '&outSR=4326&returnGeometry=true&f=json&resultOffset=' + offset + '&resultRecordCount=' + pageSize;
    var d = await fetchJson(url);
    if (d.error) throw new Error(d.error.message || 'query error');
    var feats = d.features || [];
    all = all.concat(feats);
    process.stdout.write('  fetched ' + all.length + '\r');
    if (!d.exceededTransferLimit || feats.length === 0) break;
    offset += feats.length;
  }
  console.log('');
  return all;
}

// "2ndTHUR1230330" -> { weeks:[2], weekday:4, from:12, to:16 }
function parseRoute(code) {
  var m = String(code || '').trim().match(/^(1st|2nd|3rd|4th|5th)(MON|TUE|TUES|WED|THU|THUR|THURS|FRI|SAT|SUN)(\d*)$/i);
  if (!m) return null;
  var week = ORD[m[1].toLowerCase()];
  var day = DAY_IDX[m[2].toLowerCase().slice(0, 3)];
  var t = m[3];
  var time = DEFAULT_TIME;
  if (t === '912') time = { from: 9, to: 12 };
  else if (t === '1230330') time = { from: 12, to: 16 };
  else if (/^\d{3,4}$/.test(t)) {          // generic "HHMM"-ish start/end pairs like "912"
    var a = parseInt(t.slice(0, t.length - 2), 10), b = parseInt(t.slice(-2), 10);
    if (a >= 1 && a <= 12 && b >= 1 && b <= 12) time = { from: a, to: (b < a ? b + 12 : b) + (b < a ? 0 : 0) };
  }
  if (week == null || day == null) return null;
  return { weeks: [week], weekday: day, from: time.from, to: time.to };
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

function title(s) { return String(s || '').toLowerCase().replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }

// Grid index of address points for nearest-street-name lookup
function buildStreetIndex(feats) {
  var cell = 0.002, grid = {};
  feats.forEach(function (f) {
    var a = f.attributes || {};
    var name = [title(a.DIRPRE), title(a.FEANME), title(a.FEATYP), title(a.DIRSUF)].filter(Boolean).join(' ').trim();
    var g = f.geometry;
    if (!name || !g || typeof g.x !== 'number') return;
    var k = Math.floor(g.x / cell) + ':' + Math.floor(g.y / cell);
    (grid[k] = grid[k] || []).push({ x: g.x, y: g.y, name: name });
  });
  return function nearest(lng, lat) {
    var cx = Math.floor(lng / cell), cy = Math.floor(lat / cell), best = null, bd = Infinity;
    for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
      var arr = grid[(cx + dx) + ':' + (cy + dy)] || [];
      for (var i = 0; i < arr.length; i++) {
        var ddx = (arr[i].x - lng) * 0.79, ddy = arr[i].y - lat; // lng scaled by cos(38 deg)
        var d = ddx * ddx + ddy * ddy;
        if (d < bd) { bd = d; best = arr[i].name; }
      }
    }
    return bd < (0.0009 * 0.0009) ? best : null; // within ~90 m
  };
}

async function main() {
  var db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  var cols = db.prepare("PRAGMA table_info(segments)").all().map(function (c) { return c.name; });
  if (cols.indexOf('city') < 0) db.exec("ALTER TABLE segments ADD COLUMN city TEXT NOT NULL DEFAULT 'SF'");
  if (cols.indexOf('enforced') < 0) db.exec("ALTER TABLE segments ADD COLUMN enforced INTEGER NOT NULL DEFAULT 1");
  db.exec("CREATE INDEX IF NOT EXISTS idx_seg_city ON segments(city)");

  var old = db.prepare("SELECT id FROM segments WHERE city = 'BRK'").all().map(function (r) { return r.id; });
  if (old.length) {
    var del = db.prepare("DELETE FROM schedules WHERE segment_id = ?");
    old.forEach(function (id) { del.run(id); });
    db.prepare("DELETE FROM segments WHERE city = 'BRK'").run();
    console.log('Removed previous BRK rows: ' + old.length);
  }

  console.log('Fetching Berkeley address points (for street names)...');
  var streets = await fetchAll(ADDRESSES, 'FEANME,FEATYP,DIRPRE,DIRSUF', 2000);
  var nearestName = buildStreetIndex(streets);

  console.log('Fetching Berkeley sweep routes...');
  var routes = await fetchAll(ROUTES, 'OBJECTID,Route', 100);

  var insSeg = db.prepare("INSERT INTO segments (cnn, corridor, limits_desc, side, block_side, block_sweep_id, geom_json, min_lng, max_lng, min_lat, max_lat, center_lng, center_lat, city, enforced) VALUES (?,?,?,?,?,NULL,?,?,?,?,?,?,?,'BRK',1)");
  var insSch = db.prepare("INSERT INTO schedules (segment_id, weekday, from_hour, to_hour, week1, week2, week3, week4, week5, holidays) VALUES (?,?,?,?,?,?,?,?,?,0)");
  var stats = { routes: routes.length, segments: 0, schedules: 0, unparsed: [], named: 0, unnamed: 0 };

  db.transaction(function () {
    routes.forEach(function (f) {
      var a = f.attributes || {};
      var rule = parseRoute(a.Route);
      if (!rule) { stats.unparsed.push(a.Route); return; }
      var label = a.Route;
      (f.geometry && f.geometry.paths || []).forEach(function (coords, pi) {
        if (!coords || coords.length < 2) return;
        var bb = bbox(coords);
        var name = nearestName(bb.cLng, bb.cLat);
        if (name) stats.named++; else stats.unnamed++;
        var cnn = 'BRK-' + a.OBJECTID + '-' + pi;
        ['L', 'R'].forEach(function (side) {
          var r = insSeg.run(cnn, name || 'Berkeley street', 'Route ' + label, side, 'Both', JSON.stringify(coords),
            bb.minLng, bb.maxLng, bb.minLat, bb.maxLat, bb.cLng, bb.cLat);
          stats.segments++;
          var w = [1, 2, 3, 4, 5].map(function (n) { return rule.weeks.indexOf(n) >= 0 ? 1 : 0; });
          insSch.run(r.lastInsertRowid, rule.weekday, rule.from, rule.to, w[0], w[1], w[2], w[3], w[4]);
          stats.schedules++;
        });
      });
    });
  })();

  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  console.log('Done:', JSON.stringify(stats));
}

main().catch(function (e) { console.error('Import failed:', e.message); process.exit(1); });
