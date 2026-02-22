const http = require('http');
const fs = require('fs');
const path = require('path');
const { matchLocation } = require('./match');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'sf_cle.db');
const db = new Database(DB_PATH, { readonly: true });

const PORT = 3456;

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(fs.readFileSync(path.join(__dirname, 'test-map.html')));
        return;
    }

    if (url.pathname === '/segments.geojson') {
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        });
        fs.createReadStream(path.join(__dirname, 'segments.geojson')).pipe(res);
        return;
    }

    if (url.pathname === '/api/match') {
        const lat = parseFloat(url.searchParams.get('lat'));
        const lng = parseFloat(url.searchParams.get('lng'));

        if (isNaN(lat) || isNaN(lng)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'lat and lng required' }));
            return;
        }

        const result = matchLocation(lat, lng, { db });
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

server.listen(PORT, () => {
    console.log(`\n🗺️  SF CLE Test Map: http://localhost:${PORT}\n`);
    console.log('Click anywhere on the map to test the matching engine.');
    console.log('Press Ctrl+C to stop.\n');
});
