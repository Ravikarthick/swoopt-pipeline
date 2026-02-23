var fs = require('fs');
var https = require('https');
var http = require('http');
var path = require('path');
var { matchLocation } = require('./match');
var Database = require('better-sqlite3');

var DB_PATH = path.join(__dirname, 'sf_cle.db');
var DB_URL = 'https://github.com/ravkar/swoopt-pipeline/releases/download/v1.0/sf_cle.db';
var PORT = process.env.PORT || 3456;

function downloadDatabase() {
  return new Promise(function(resolve, reject) {
    if (fs.existsSync(DB_PATH)) {
  var size = fs.statSync(DB_PATH).size;
  if (size > 1000000) {
    console.log('Database already exists and looks valid');
    resolve();
    return;
  }
  console.log('Database exists but looks corrupted, re-downloading...');
  fs.unlinkSync(DB_PATH);
}
    console.log('Downloading database from GitHub...');
    var file = fs.createWriteStream(DB_PATH);
    function download(url) {
      https.get(url, function(response) {
        if (response.statusCode === 301 || response.statusCode === 302) {
          download(response.headers.location);
          return;
        }
        response.pipe(file);
        file.on('finish', function() {
          file.close();
          console.log('Database downloaded successfully!');
          resolve();
        });
      }).on('error', function(err) {
        fs.unlink(DB_PATH, function() {});
        reject(err);
      });
    }
    download(DB_URL);
  });
}

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

downloadDatabase()
  .then(function() {
    startServer();
  })
  .catch(function(err) {
    console.error('Failed to download database:', err);
    process.exit(1);
  });
