var fs = require('fs');
var http = require('http');
var path = require('path');
var { matchLocation } = require('./match');
var Database = require('better-sqlite3');

var DB_PATH = path.join(__dirname, 'sf_cle.db');
var PORT = process.env.PORT || 3456;

function startServer() {
  var db = new Database(DB_PATH, { readonly: true });

  var server = http.createServer(function(req, res) {
    var url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Swoopt API is running');
      return;
    }

    if (url.pathname === '/api/match') {
      var lat = parseFloat(url.searchParams.get('lat'));
      var lng = parseFloat(url.searchParams.get('lng'));
      if (isNaN(lat) || isNaN(lng)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'lat and lng required' }));
        return;
      }
      var result = matchLocation(lat, lng, { db });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify(result, null, 2));
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
