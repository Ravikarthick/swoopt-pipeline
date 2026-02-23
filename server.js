async function downloadDatabase() {
  if (fs.existsSync(DB_PATH)) {
    var size = fs.statSync(DB_PATH).size;
    if (size > 5000000) {
      console.log('Database valid, size: ' + size + ' bytes');
      return;
    }
    console.log('Corrupted file found, deleting...');
    fs.unlinkSync(DB_PATH);
  }
  console.log('Downloading database...');
  var fetch = require('node-fetch');
  var response = await fetch(DB_URL);
  if (!response.ok) throw new Error('Download failed: ' + response.status);
  var buffer = await response.buffer();
  fs.writeFileSync(DB_PATH, buffer);
  console.log('Downloaded! Size: ' + buffer.length + ' bytes');
}
