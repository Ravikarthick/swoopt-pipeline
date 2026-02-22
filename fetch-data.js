/**
 * SF CLE — Data Pipeline: Fetch + Store
 *
 * Pulls the full Street Sweeping Schedule from SF Open Data (SODA API)
 * and stores it in a local SQLite database with spatial indexing.
 */

const fetch = require('node-fetch');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'sf_cle.db');
const SODA_BASE = 'https://data.sfgov.org/resource/yhqp-riqs.json';
const PAGE_SIZE = 5000;

const WEEKDAY_MAP = {
    'Sun': 0, 'Mon': 1, 'Tues': 2, 'Wed': 3,
    'Thu': 4, 'Fri': 5, 'Sat': 6, 'Holiday': 7
};

async function fetchAllRecords() {
    let allRecords = [];
    let offset = 0;

    console.log('Fetching SF street sweeping data from SODA API...');

    while (true) {
        const url = `${SODA_BASE}?$limit=${PAGE_SIZE}&$offset=${offset}&$order=blocksweepid`;
        console.log(`  Fetching records ${offset} - ${offset + PAGE_SIZE}...`);

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`SODA API error: ${response.status} ${response.statusText}`);
        }

        const records = await response.json();
        if (records.length === 0) break;

        allRecords = allRecords.concat(records);
        offset += PAGE_SIZE;

        await new Promise(r => setTimeout(r, 500));
    }

    console.log(`✓ Fetched ${allRecords.length} total records\n`);
    return allRecords;
}

function createDatabase() {
    if (fs.existsSync(DB_PATH)) {
        fs.unlinkSync(DB_PATH);
    }

    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');

    db.exec(`
        CREATE TABLE segments (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            cnn             TEXT NOT NULL,
            corridor        TEXT NOT NULL,
            limits_desc     TEXT,
            side            TEXT NOT NULL,
            block_side      TEXT,
            block_sweep_id  INTEGER UNIQUE,
            geom_json       TEXT NOT NULL,
            min_lng         REAL NOT NULL,
            max_lng         REAL NOT NULL,
            min_lat         REAL NOT NULL,
            max_lat         REAL NOT NULL,
            center_lng      REAL NOT NULL,
            center_lat      REAL NOT NULL
        );

        CREATE TABLE schedules (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            segment_id      INTEGER NOT NULL REFERENCES segments(id),
            weekday         INTEGER NOT NULL,
            from_hour       INTEGER NOT NULL,
            to_hour         INTEGER NOT NULL,
            week1           INTEGER NOT NULL DEFAULT 0,
            week2           INTEGER NOT NULL DEFAULT 0,
            week3           INTEGER NOT NULL DEFAULT 0,
            week4           INTEGER NOT NULL DEFAULT 0,
            week5           INTEGER NOT NULL DEFAULT 0,
            holidays        INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX idx_seg_bbox ON segments(min_lng, max_lng, min_lat, max_lat);
        CREATE INDEX idx_seg_cnn ON segments(cnn);
        CREATE INDEX idx_sched_segment ON schedules(segment_id);
        CREATE INDEX idx_sched_weekday ON schedules(weekday);
    `);

    return db;
}

function computeBBox(coordinates) {
    let minLng = Infinity, maxLng = -Infinity;
    let minLat = Infinity, maxLat = -Infinity;

    for (const [lng, lat] of coordinates) {
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
    }

    const centerLng = (minLng + maxLng) / 2;
    const centerLat = (minLat + maxLat) / 2;

    return { minLng, maxLng, minLat, maxLat, centerLng, centerLat };
}

function insertRecords(db, records) {
    const insertSeg = db.prepare(`
        INSERT INTO segments (cnn, corridor, limits_desc, side, block_side,
                              block_sweep_id, geom_json, min_lng, max_lng,
                              min_lat, max_lat, center_lng, center_lat)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertSched = db.prepare(`
        INSERT INTO schedules (segment_id, weekday, from_hour, to_hour,
                               week1, week2, week3, week4, week5, holidays)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let inserted = 0;
    let skipped = 0;

    const insertAll = db.transaction((records) => {
        for (const rec of records) {
            if (!rec.line || !rec.line.coordinates || rec.line.coordinates.length === 0) {
                skipped++;
                continue;
            }

            const coords = rec.line.coordinates;
            const bbox = computeBBox(coords);

            const segResult = insertSeg.run(
                rec.cnn || '',
                rec.corridor || '',
                rec.limits || '',
                (rec.cnnrightleft || 'L').charAt(0),
                rec.blockside || '',
                parseInt(rec.blocksweepid) || null,
                JSON.stringify(coords),
                bbox.minLng, bbox.maxLng,
                bbox.minLat, bbox.maxLat,
                bbox.centerLng, bbox.centerLat
            );

            const segId = segResult.lastInsertRowid;
            const weekday = WEEKDAY_MAP[rec.weekday] ?? -1;

            insertSched.run(
                segId,
                weekday,
                parseInt(rec.fromhour) || 0,
                parseInt(rec.tohour) || 0,
                parseInt(rec.week1) || 0,
                parseInt(rec.week2) || 0,
                parseInt(rec.week3) || 0,
                parseInt(rec.week4) || 0,
                parseInt(rec.week5) || 0,
                parseInt(rec.holidays) || 0
            );

            inserted++;
        }
    });

    insertAll(records);

    console.log(`✓ Inserted ${inserted} segments with schedules`);
    if (skipped > 0) {
        console.log(`  (Skipped ${skipped} records without geometry)`);
    }
}

async function main() {
    console.log('=== SF CLE Data Pipeline ===\n');

    const records = await fetchAllRecords();

    console.log('Creating SQLite database...');
    const db = createDatabase();

    console.log('Inserting records...');
    insertRecords(db, records);

    const segCount = db.prepare('SELECT COUNT(*) as n FROM segments').get().n;
    const schedCount = db.prepare('SELECT COUNT(*) as n FROM schedules').get().n;
    const corridors = db.prepare('SELECT COUNT(DISTINCT corridor) as n FROM segments').get().n;
    const dbSize = (fs.statSync(DB_PATH).size / 1024 / 1024).toFixed(2);

    console.log(`\n=== Database Summary ===`);
    console.log(`  Segments:    ${segCount}`);
    console.log(`  Schedules:   ${schedCount}`);
    console.log(`  Streets:     ${corridors}`);
    console.log(`  DB size:     ${dbSize} MB`);
    console.log(`  Location:    ${DB_PATH}`);

    db.close();
}

main().catch(err => {
    console.error('Pipeline failed:', err);
    process.exit(1);
});
