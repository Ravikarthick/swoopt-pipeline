// build-app-db.js — produce a slim copy of sf_cle.db for bundling inside the app.
// Usage: node build-app-db.js            -> writes app-db/sweepbay.db + app-db/version.json
// Keeps only what the phone needs; rounds coordinates to 6 decimals (~10 cm); vacuums.
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var Database = require('better-sqlite3');

var SRC = process.env.DB_PATH || path.join(__dirname, 'sf_cle.db');
var OUT_DIR = path.join(__dirname, 'app-db');
var OUT = path.join(OUT_DIR, 'sweepbay.db');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);
if (fs.existsSync(OUT)) fs.unlinkSync(OUT);

function roundGeom(json) {
  var coords = JSON.parse(json);
  return JSON.stringify(coords.map(function (c) { return [Math.round(c[0] * 1e6) / 1e6, Math.round(c[1] * 1e6) / 1e6]; }));
}

var src = new Database(SRC, { readonly: true });
var out = new Database(OUT);
out.pragma('journal_mode = OFF');
out.pragma('synchronous = OFF');
out.exec(`
CREATE TABLE segments (id INTEGER PRIMARY KEY, cnn TEXT NOT NULL, corridor TEXT NOT NULL, limits_desc TEXT, side TEXT NOT NULL, block_side TEXT,
  geom_json TEXT NOT NULL, min_lng REAL NOT NULL, max_lng REAL NOT NULL, min_lat REAL NOT NULL, max_lat REAL NOT NULL, city TEXT NOT NULL, enforced INTEGER NOT NULL);
CREATE TABLE schedules (segment_id INTEGER NOT NULL, weekday INTEGER NOT NULL, from_hour INTEGER NOT NULL, to_hour INTEGER NOT NULL,
  week1 INTEGER NOT NULL, week2 INTEGER NOT NULL, week3 INTEGER NOT NULL, week4 INTEGER NOT NULL, week5 INTEGER NOT NULL);
CREATE TABLE lots (id INTEGER PRIMARY KEY, name TEXT, kind TEXT, geom_json TEXT NOT NULL, min_lng REAL NOT NULL, max_lng REAL NOT NULL, min_lat REAL NOT NULL, max_lat REAL NOT NULL);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
`);

var insSeg = out.prepare('INSERT INTO segments VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
var insSch = out.prepare('INSERT INTO schedules VALUES (?,?,?,?,?,?,?,?,?)');
var insLot = out.prepare('INSERT INTO lots VALUES (?,?,?,?,?,?,?,?)');
var n = { segments: 0, schedules: 0, lots: 0 };

out.transaction(function () {
  for (var s of src.prepare('SELECT id, cnn, corridor, limits_desc, side, block_side, geom_json, city, enforced FROM segments').iterate()) {
    var g = roundGeom(s.geom_json);
    var c = JSON.parse(g), minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
    c.forEach(function (p) { if (p[0] < minLng) minLng = p[0]; if (p[0] > maxLng) maxLng = p[0]; if (p[1] < minLat) minLat = p[1]; if (p[1] > maxLat) maxLat = p[1]; });
    insSeg.run(s.id, s.cnn, s.corridor, s.limits_desc, s.side, s.block_side, g, minLng, maxLng, minLat, maxLat, s.city || 'SF', s.enforced == null ? 1 : s.enforced);
    n.segments++;
  }
  for (var r of src.prepare('SELECT segment_id, weekday, from_hour, to_hour, week1, week2, week3, week4, week5 FROM schedules').iterate()) {
    insSch.run(r.segment_id, r.weekday, r.from_hour, r.to_hour, r.week1, r.week2, r.week3, r.week4, r.week5); n.schedules++;
  }
  var hasLots = src.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='lots'").get();
  if (hasLots) for (var l of src.prepare('SELECT id, name, kind, geom_json FROM lots').iterate()) {
    var lg = roundGeom(l.geom_json), lc = JSON.parse(lg), a = Infinity, b = -Infinity, cc = Infinity, d = -Infinity;
    lc.forEach(function (p) { if (p[0] < a) a = p[0]; if (p[0] > b) b = p[0]; if (p[1] < cc) cc = p[1]; if (p[1] > d) d = p[1]; });
    insLot.run(l.id, l.name, l.kind, lg, a, b, cc, d); n.lots++;
  }
})();

out.exec('CREATE INDEX idx_seg_bbox ON segments(min_lng, max_lng, min_lat, max_lat)');
out.exec('CREATE INDEX idx_seg_cnn ON segments(cnn)');
out.exec('CREATE INDEX idx_sched_seg ON schedules(segment_id)');
out.exec('CREATE INDEX idx_lots_bbox ON lots(min_lng, max_lng, min_lat, max_lat)');
var built = new Date().toISOString().slice(0, 10);
out.prepare("INSERT INTO meta VALUES ('built', ?)").run(built);
out.prepare("INSERT INTO meta VALUES ('cities', ?)").run(src.prepare("SELECT GROUP_CONCAT(DISTINCT city) c FROM segments").get().c || 'SF');
out.exec('VACUUM');
out.close(); src.close();

var bytes = fs.statSync(OUT).size;
var sha = crypto.createHash('sha256').update(fs.readFileSync(OUT)).digest('hex').slice(0, 16);
fs.writeFileSync(path.join(OUT_DIR, 'version.json'), JSON.stringify({ built: built, sha: sha, bytes: bytes, counts: n }, null, 2));
console.log('app-db/sweepbay.db:', (bytes / 1048576).toFixed(1) + ' MB', JSON.stringify(n), '| sha', sha);
