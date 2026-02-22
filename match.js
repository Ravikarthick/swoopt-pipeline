const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'sf_cle.db');
const SEARCH_RADIUS_DEG = 0.003;
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Holiday'];

function haversineMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function closestPointOnSegment(P, A, B) {
    const dx = B[0] - A[0];
    const dy = B[1] - A[1];
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) {
        return { point: A, t: 0, dist: haversineMeters(P[1], P[0], A[1], A[0]) };
    }
    let t = ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const closest = [A[0] + t * dx, A[1] + t * dy];
    const dist = haversineMeters(P[1], P[0], closest[1], closest[0]);
    return { point: closest, t, dist };
}

function closestPointOnPolyline(P, coords) {
    let best = { dist: Infinity };
    for (let i = 0; i < coords.length - 1; i++) {
        const result = closestPointOnSegment(P, coords[i], coords[i + 1]);
        if (result.dist < best.dist) {
            best = {
                ...result,
                segIndex: i,
                segDirection: [
                    coords[i + 1][0] - coords[i][0],
                    coords[i + 1][1] - coords[i][1]
                ]
            };
        }
    }
    return best;
}

function determineSide(P, closestOnLine, segDirection) {
    const toPoint = [P[0] - closestOnLine[0], P[1] - closestOnLine[1]];
    const cross = segDirection[0] * toPoint[1] - segDirection[1] * toPoint[0];
    return cross >= 0 ? 'L' : 'R';
}

function weekOfMonth(date) {
    return Math.ceil(date.getDate() / 7);
}

function getNextCleaning(schedules, fromDate) {
    const now = fromDate || new Date();
    const results = [];
    for (let d = 0; d < 14; d++) {
        const checkDate = new Date(now);
        checkDate.setDate(checkDate.getDate() + d);
        const dayOfWeek = checkDate.getDay();
        const weekNum = weekOfMonth(checkDate);
        for (const sched of schedules) {
            if (sched.weekday !== dayOfWeek) continue;
            const weekKey = 'week' + weekNum;
            if (!sched[weekKey]) continue;

            const cleaningStart = new Date(checkDate);
            cleaningStart.setHours(sched.from_hour, 0, 0, 0);
            const cleaningEnd = new Date(checkDate);
            cleaningEnd.setHours(sched.to_hour, 0, 0, 0);

            // Include if cleaning hasn't ended yet (covers active + upcoming)
            if (cleaningEnd > now) {
                var isActive = (now >= cleaningStart && now < cleaningEnd);
                results.push({
                    date: checkDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }),
                    day: WEEKDAY_NAMES[dayOfWeek],
                    start: sched.from_hour + ':00',
                    end: sched.to_hour + ':00',
                    startTime: cleaningStart,
                    endTime: cleaningEnd,
                    hoursUntil: isActive ? '0' : ((cleaningStart - now) / 3600000).toFixed(1),
                    isActive: isActive,
                    minutesRemaining: isActive ? Math.ceil((cleaningEnd - now) / 60000) : null
                });
            }
        }
    }
    return results.sort(function(a, b) { return a.startTime - b.startTime; });
}

function matchLocation(lat, lng, options) {
    options = options || {};
    const maxDist = options.maxDistanceMeters || 200;
    const db = options.db || new Database(DB_PATH, { readonly: true });
    const shouldClose = !options.db;
    const point = [lng, lat];

    try {
        const candidates = db.prepare(
            'SELECT id, cnn, corridor, limits_desc, side, block_side, block_sweep_id, geom_json, center_lng, center_lat FROM segments WHERE min_lng <= ? AND max_lng >= ? AND min_lat <= ? AND max_lat >= ?'
        ).all(lng + SEARCH_RADIUS_DEG, lng - SEARCH_RADIUS_DEG, lat + SEARCH_RADIUS_DEG, lat - SEARCH_RADIUS_DEG);

        if (candidates.length === 0) {
            return { matched: false, reason: 'No street segments within search radius', coords: lat + ', ' + lng };
        }

        let bestMatch = null;
        let bestDist = Infinity;

        for (const seg of candidates) {
            const coords = JSON.parse(seg.geom_json);
            const closest = closestPointOnPolyline(point, coords);
            if (closest.dist < bestDist) {
                bestDist = closest.dist;
                bestMatch = {
                    segment: seg,
                    closestPoint: closest.point,
                    distance: closest.dist,
                    segDirection: closest.segDirection
                };
            }
        }

        if (!bestMatch || bestDist > maxDist) {
            return {
                matched: false,
                reason: 'Nearest segment is ' + bestDist.toFixed(1) + 'm away (max: ' + maxDist + 'm)',
                nearestStreet: bestMatch ? bestMatch.segment.corridor : null,
                distance: bestDist.toFixed(1),
                coords: lat + ', ' + lng
            };
        }

        const computedSide = determineSide(point, bestMatch.closestPoint, bestMatch.segDirection);
        const seg = bestMatch.segment;
        const allSchedules = db.prepare(
            'SELECT s.*, seg.side, seg.corridor, seg.limits_desc, seg.block_side FROM schedules s JOIN segments seg ON s.segment_id = seg.id WHERE seg.cnn = ? ORDER BY seg.side, s.weekday'
        ).all(seg.cnn);

        const bySide = { L: [], R: [] };
        for (const sched of allSchedules) {
            if (bySide[sched.side]) bySide[sched.side].push(sched);
        }

        const matchedSchedules = bySide[computedSide] || [];
        const otherSchedules = bySide[computedSide === 'L' ? 'R' : 'L'] || [];
        const now = new Date();
        const nextCleanings = getNextCleaning(matchedSchedules, now);
        const otherSideCleanings = getNextCleaning(otherSchedules, now);

        return {
            matched: true,
            street: seg.corridor,
            block: seg.limits_desc,
            distance: bestDist.toFixed(1) + 'm',
            computedSide: computedSide,
            blockSide: (matchedSchedules[0] && matchedSchedules[0].block_side) || seg.block_side,
            yourSide: {
                side: computedSide,
                schedules: matchedSchedules.map(function(sc) {
                    return {
                        day: WEEKDAY_NAMES[sc.weekday],
                        hours: sc.from_hour + ':00 - ' + sc.to_hour + ':00',
                        weeks: [sc.week1, sc.week2, sc.week3, sc.week4, sc.week5]
                            .map(function(w, i) { return w ? 'W' + (i + 1) : null; }).filter(Boolean).join(', ')
                    };
                }),
                nextCleanings: nextCleanings.slice(0, 3)
            },
            otherSide: {
                side: computedSide === 'L' ? 'R' : 'L',
                schedules: otherSchedules.map(function(sc) {
                    return {
                        day: WEEKDAY_NAMES[sc.weekday],
                        hours: sc.from_hour + ':00 - ' + sc.to_hour + ':00',
                        weeks: [sc.week1, sc.week2, sc.week3, sc.week4, sc.week5]
                            .map(function(w, i) { return w ? 'W' + (i + 1) : null; }).filter(Boolean).join(', ')
                    };
                }),
                nextCleanings: otherSideCleanings.slice(0, 3)
            },
            candidateCount: candidates.length,
            coords: lat + ', ' + lng,
            note: 'Side detection uses GPS heuristic - confirm with posted signs for MVP'
        };
    } finally {
        if (shouldClose) db.close();
    }
}

module.exports = { matchLocation: matchLocation, haversineMeters: haversineMeters, getNextCleaning: getNextCleaning };