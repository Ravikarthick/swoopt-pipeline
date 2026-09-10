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

function startServer() {
  var db = new Database(DB_PATH, { readonly: true });

  var server = http.createServer(function(req, res) {
    var url = new URL(req.url, 'http://localhost');

    if (isRateLimited(clientIp(req))) {
      res.writeHead(429, Object.assign({ 'Content-Type': 'application/json', 'Retry-After': '60' }, SECURITY_HEADERS));
      res.end(JSON.stringify({ error: 'Too many requests. Please slow down.' }));
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
