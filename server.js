var fs = require('fs');
var http = require('http');
var path = require('path');
var { matchLocation } = require('./match');
var Database = require('better-sqlite3');

var DB_PATH = path.join(__dirname, 'sf_cle.db');
var PORT = process.env.PORT || 3456;

// ── Rate limiting: per-IP, sliding 1-minute window ──
var RATE_LIMIT = 60;            // max requests per IP per minute
var RATE_WINDOW_MS = 60 * 1000;
var hits = new Map();           // ip -> array of timestamps

function clientIp(req) {
  var fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function isRateLimited(ip) {
  var now = Date.now();
  var arr = hits.get(ip) || [];
  arr = arr.filter(function (t) { return now - t < RATE_WINDOW_MS; });
  if (arr.length >= RATE_LIMIT) { hits.set(ip, arr); return true; }
  arr.push(now);
  hits.set(ip, arr);
  return false;
}

// Forget idle IPs so memory never grows
setInterval(function () {
  var now = Date.now();
  hits.forEach(function (arr, ip) {
    if (arr.length === 0 || now - arr[arr.length - 1] > RATE_WINDOW_MS) hits.delete(ip);
  });
}, RATE_WINDOW_MS).unref();

var SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store'
};

function readBody(req) {
  return new Promise(function (resolve) {
    var chunks = '';
    var tooBig = false;
    req.on('data', function (c) {
      chunks += c;
      if (chunks.length > 10000) { tooBig = true; req.destroy(); }
    });
    req.on('end', function () {
      if (tooBig) return resolve(null);
      try { resolve(JSON.parse(chunks || '{}')); } catch (e) { resolve(null); }
    });
    req.on('error', function () { resolve(null); });
  });
}

// ── Feedback: stored locally, optionally forwarded by email (Resend) ──
var FEEDBACK_DB_PATH = path.join(__dirname, 'feedback.db');
var FEEDBACK_TOKEN = process.env.FEEDBACK_TOKEN || '';
var RESEND_API_KEY = process.env.RESEND_API_KEY || '';
var FEEDBACK_TO = process.env.FEEDBACK_TO || '';
var FEEDBACK_TYPES = ['wrong_schedule', 'not_detected', 'bug', 'idea', 'other'];

function openFeedbackDb() {
  var fdb = new Database(FEEDBACK_DB_PATH);
  fdb.exec('CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, type TEXT NOT NULL, message TEXT NOT NULL, reply_to TEXT, street TEXT, lat REAL, lng REAL, app_version TEXT, device TEXT, ip_hash TEXT)');
  return fdb;
}

function forwardFeedback(row) {
  if (!RESEND_API_KEY || !FEEDBACK_TO) return;
  var https = require('https');
  var body = JSON.stringify({
    from: 'SweepBay <onboarding@resend.dev>',
    to: [FEEDBACK_TO],
    subject: 'SweepBay feedback: ' + row.type + (row.street ? ' - ' + row.street : ''),
    text: 'Type: ' + row.type + '\nWhen: ' + row.created_at + '\nApp: ' + (row.app_version || '?') + ' on ' + (row.device || '?') +
      '\nStreet: ' + (row.street || '-') + '\nReply-to: ' + (row.reply_to || '-') + '\n\n' + row.message
  });
  var req = https.request({ hostname: 'api.resend.com', path: '/emails', method: 'POST',
    headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
    function (r) { r.resume(); });
  req.on('error', function (e) { console.error('feedback forward failed:', e.message); });
  req.end(body);
}

function startServer() {
  var db = new Database(DB_PATH, { readonly: true });
  var fdb = openFeedbackDb();
  var insFeedback = fdb.prepare('INSERT INTO feedback (created_at, type, message, reply_to, street, lat, lng, app_version, device, ip_hash) VALUES (?,?,?,?,?,?,?,?,?,?)');

  var server = http.createServer(function(req, res) {
    var url = new URL(req.url, 'http://localhost');

    if (isRateLimited(clientIp(req))) {
      res.writeHead(429, Object.assign({ 'Content-Type': 'application/json', 'Retry-After': '60' }, SECURITY_HEADERS));
      res.end(JSON.stringify({ error: 'Too many requests. Please slow down.' }));
      return;
    }

    if (url.pathname === '/api/feedback') {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, Object.assign({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }, SECURITY_HEADERS));
        res.end(); return;
      }
      if (req.method !== 'POST') { res.writeHead(405, SECURITY_HEADERS); res.end(); return; }
      readBody(req).then(function (body) {
        var msg = body && typeof body.message === 'string' ? body.message.trim() : '';
        var type = body && FEEDBACK_TYPES.indexOf(body.type) >= 0 ? body.type : 'other';
        if (!msg || msg.length < 3) {
          res.writeHead(400, Object.assign({ 'Content-Type': 'application/json' }, SECURITY_HEADERS));
          res.end(JSON.stringify({ error: 'Please write a short message.' })); return;
        }
        var clean = function (v, n) { return typeof v === 'string' ? v.trim().slice(0, n) : null; };
        var lat = body.lat != null ? parseFloat(body.lat) : null, lng = body.lng != null ? parseFloat(body.lng) : null;
        var ipHash = require('crypto').createHash('sha256').update(clientIp(req)).digest('hex').slice(0, 12);
        var row = {
          created_at: new Date().toISOString(), type: type, message: msg.slice(0, 2000),
          reply_to: clean(body.replyTo, 200), street: clean(body.street, 120),
          lat: isNaN(lat) ? null : lat, lng: isNaN(lng) ? null : lng,
          app_version: clean(body.appVersion, 40), device: clean(body.device, 80), ip_hash: ipHash
        };
        try {
          insFeedback.run(row.created_at, row.type, row.message, row.reply_to, row.street, row.lat, row.lng, row.app_version, row.device, row.ip_hash);
        } catch (e) {
          console.error('feedback store failed:', e.message);
          res.writeHead(500, Object.assign({ 'Content-Type': 'application/json' }, SECURITY_HEADERS));
          res.end(JSON.stringify({ error: 'Could not save feedback. Please try again.' })); return;
        }
        forwardFeedback(row);
        res.writeHead(200, Object.assign({ 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, SECURITY_HEADERS));
        res.end(JSON.stringify({ ok: true, message: 'Thanks! Your feedback was received.' }));
      });
      return;
    }

    if (url.pathname === '/admin/feedback') {
      if (!FEEDBACK_TOKEN || url.searchParams.get('token') !== FEEDBACK_TOKEN) { res.writeHead(404); res.end('Not found'); return; }
      var rows = fdb.prepare('SELECT id, created_at, type, street, reply_to, app_version, device, message FROM feedback ORDER BY id DESC LIMIT 200').all();
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, SECURITY_HEADERS));
      res.end(JSON.stringify(rows, null, 2));
      return;
    }

    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Swoopt API is running');
      return;
    }

    if (url.pathname === '/api/match') {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, Object.assign({
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }, SECURITY_HEADERS));
        res.end();
        return;
      }

      function respond(lat, lng) {
        if (isNaN(lat) || isNaN(lng)) {
          res.writeHead(400, Object.assign({ 'Content-Type': 'application/json' }, SECURITY_HEADERS));
          res.end(JSON.stringify({ error: 'lat and lng required' }));
          return;
        }
        var result;
        try {
          result = matchLocation(lat, lng, { db });
        } catch (e) {
          console.error('match error:', e && e.message);
          res.writeHead(500, Object.assign({ 'Content-Type': 'application/json' }, SECURITY_HEADERS));
          res.end(JSON.stringify({ error: 'Lookup failed. Please try again.' }));
          return;
        }
        res.writeHead(200, Object.assign({
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }, SECURITY_HEADERS));
        res.end(JSON.stringify(result, null, 2));
      }

      // POST keeps coordinates out of URLs and server logs.
      // GET is still supported so older app builds keep working.
      if (req.method === 'POST') {
        readBody(req).then(function (body) {
          if (!body) {
            res.writeHead(400, Object.assign({ 'Content-Type': 'application/json' }, SECURITY_HEADERS));
            res.end(JSON.stringify({ error: 'Invalid request body' }));
            return;
          }
          respond(parseFloat(body.lat), parseFloat(body.lng));
        });
        return;
      }

      respond(parseFloat(url.searchParams.get('lat')), parseFloat(url.searchParams.get('lng')));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(PORT, function() {
    console.log('Swoopt API running on port ' + PORT);
  });
}

startServer();
