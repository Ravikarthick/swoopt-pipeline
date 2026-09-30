// import-lots.js — parking lots and garages from OpenStreetMap into sf_cle.db
// Usage: node import-lots.js     (idempotent: rebuilds the `lots` table)
// A parked point inside one of these polygons is off-street: no cleaning alerts.
// Source: OSM amenity=parking ways (surface lots, multi-storey, underground, rooftop),
// excluding parking=street_side / lane which are on-street.
var path = require('path');
var https = require('https');
var Database = require('better-sqlite3');

var DB_PATH = process.env.DB_PATH || path.join(__dirname, 'sf_cle.db');
var ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];
// [name, south, west, north, east] — one query per box keeps each under Overpass limits
var BOXES = [
  ['San Francisco',       37.70, -122.52, 37.83, -122.35],
  ['South SF / Daly City',37.62, -122.50, 37.71, -122.38],
  ['Oakland / Berkeley',  37.72, -122.34, 37.91, -122.15],
  ['San Jose north',      37.30, -122.02, 37.45, -121.80],
  ['San Jose south',      37.20, -122.02, 37.30, -121.75]
];

function post(url, body, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var u = new URL(url);
    var req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SweepBay-import/1.0' } }, function (res) {
      var chunks = '';
      res.on('data', function (c) { chunks += c; });
      res.on('end', function () {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' ' + chunks.slice(0, 120)));
        try { resolve(JSON.parse(chunks)); } catch (e) { reject(new Error('bad JSON')); }
      });
    });
    req.setTimeout(timeoutMs, function () { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.write('data=' + encodeURIComponent(body));
    req.end();
  });
}

async function fetchBox(box) {
  var q = '[out:json][timeout:170];way["amenity"="parking"]["parking"!~"street_side|lane"](' +
    box[1] + ',' + box[2] + ',' + box[3] + ',' + box[4] + ');out geom;';
  var lastErr;
  for (var attempt = 0; attempt < ENDPOINTS.length * 2; attempt++) {
    var ep = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      process.stdout.write('  ' + box[0] + ' via ' + new URL(ep).hostname + ' ... ');
      var d = await post(ep, q, 190000);
      console.log((d.elements || []).length + ' polygons');
      return d.elements || [];
    } catch (e) {
      lastErr = e; console.log('failed (' + e.message + '), retrying');
      await new Promise(function (r) { setTimeout(r, 5000); });
    }
  }
  throw lastErr;
}

function bbox(coords) {
  var b = { minLng: Infinity, maxLng: -Infinity, minLat: Infinity, maxLat: -Infinity };
  coords.forEach(function (c) {
    if (c[0] < b.minLng) b.minLng = c[0]; if (c[0] > b.maxLng) b.maxLng = c[0];
    if (c[1] < b.minLat) b.minLat = c[1]; if (c[1] > b.maxLat) b.maxLat = c[1];
  });
  return b;
}

async function main() {
  var db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec('DROP TABLE IF EXISTS lots');
  db.exec('CREATE TABLE lots (id INTEGER PRIMARY KEY AUTOINCREMENT, osm_id INTEGER, name TEXT, kind TEXT, geom_json TEXT NOT NULL, min_lng REAL NOT NULL, max_lng REAL NOT NULL, min_lat REAL NOT NULL, max_lat REAL NOT NULL)');
  db.exec('CREATE INDEX idx_lots_bbox ON lots(min_lng, max_lng, min_lat, max_lat)');
  var ins = db.prepare('INSERT INTO lots (osm_id, name, kind, geom_json, min_lng, max_lng, min_lat, max_lat) VALUES (?,?,?,?,?,?,?,?)');

  var total = 0, seen = {};
  for (var i = 0; i < BOXES.length; i++) {
    var els = await fetchBox(BOXES[i]);
    db.transaction(function () {
      els.forEach(function (e) {
        if (seen[e.id] || !e.geometry || e.geometry.length < 4) return;
        seen[e.id] = true;
        var coords = e.geometry.map(function (p) { return [p.lon, p.lat]; });
        var t = e.tags || {};
        var b = bbox(coords);
        ins.run(e.id, t.name || null, t.parking || 'surface', JSON.stringify(coords), b.minLng, b.maxLng, b.minLat, b.maxLat);
        total++;
      });
    })();
  }
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  console.log('Done: ' + total + ' parking lots/garages stored');
}

main().catch(function (e) { console.error('Import failed:', e.message); process.exit(1); });
