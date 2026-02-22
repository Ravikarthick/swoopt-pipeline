const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'sf_cle.db');
const db = new Database(DB_PATH, { readonly: true });

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Holiday'];

console.log('Exporting segments to GeoJSON...');

const allSegments = db.prepare(`
    SELECT s.id, s.corridor, s.limits_desc, s.side, s.block_side, s.geom_json,
           sc.weekday, sc.from_hour, sc.to_hour
    FROM segments s
    JOIN schedules sc ON sc.segment_id = s.id
`).all();

const features = allSegments.map(seg => ({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: JSON.parse(seg.geom_json) },
    properties: {
        id: seg.id,
        street: seg.corridor,
        block: seg.limits_desc,
        side: seg.side,
        day: WEEKDAY_NAMES[seg.weekday] || '?',
        hours: `${seg.from_hour}:00-${seg.to_hour}:00`,
        blockSide: seg.block_side
    }
}));

const geojson = { type: 'FeatureCollection', features };
fs.writeFileSync(path.join(__dirname, 'segments.geojson'), JSON.stringify(geojson));
console.log(`✓ Exported ${features.length} features to segments.geojson`);

db.close();
