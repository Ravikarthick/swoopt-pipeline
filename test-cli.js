/**
 * SF CLE — CLI Test Tool
 *
 * Usage: node test-cli.js <lat> <lng>
 * Example: node test-cli.js 37.7749 -122.4194
 */

const { matchLocation } = require('./match');

const lat = parseFloat(process.argv[2]);
const lng = parseFloat(process.argv[3]);

if (isNaN(lat) || isNaN(lng)) {
    console.log('Usage: node test-cli.js <lat> <lng>');
    console.log('Example: node test-cli.js 37.7749 -122.4194');
    console.log('\nSample locations to try:');
    console.log('  Market & 5th:        37.7837 -122.4070');
    console.log('  Mission & 24th:      37.7522 -122.4184');
    console.log('  Valencia & 16th:     37.7648 -122.4216');
    console.log('  Haight & Ashbury:    37.7694 -122.4470');
    console.log('  Divisadero & Hayes:  37.7755 -122.4376');
    console.log('  Sunset (Irving):     37.7637 -122.4680');
    process.exit(1);
}

console.log(`\n🅿️  SF CLE — Parking Match`);
console.log(`   Location: ${lat}, ${lng}\n`);

const result = matchLocation(lat, lng);

if (!result.matched) {
    console.log(`❌ No match: ${result.reason}`);
    if (result.nearestStreet) {
        console.log(`   Nearest street: ${result.nearestStreet} (${result.distance}m away)`);
    }
    process.exit(0);
}

console.log(`✅ Matched: ${result.street}`);
console.log(`   Block: ${result.block}`);
console.log(`   Distance to street: ${result.distance}`);
console.log(`   Computed side: ${result.computedSide} (${result.blockSide || 'unknown direction'})`);
console.log(`   Segments in range: ${result.candidateCount}`);

console.log(`\n── YOUR SIDE (${result.yourSide.side}) ──`);
if (result.yourSide.schedules.length === 0) {
    console.log('   No cleaning scheduled for this side');
} else {
    for (const s of result.yourSide.schedules) {
        console.log(`   ${s.day} ${s.hours} (${s.weeks})`);
    }
}

if (result.yourSide.nextCleanings.length > 0) {
    console.log('\n   Next cleaning:');
    for (const nc of result.yourSide.nextCleanings) {
        console.log(`   ⏰ ${nc.date} ${nc.start}-${nc.end} (${nc.hoursUntil}h from now)`);
    }
}

console.log(`\n── OTHER SIDE (${result.otherSide.side}) ──`);
if (result.otherSide.schedules.length === 0) {
    console.log('   No cleaning scheduled for this side');
} else {
    for (const s of result.otherSide.schedules) {
        console.log(`   ${s.day} ${s.hours} (${s.weeks})`);
    }
}

console.log(`\n⚠️  ${result.note}`);
