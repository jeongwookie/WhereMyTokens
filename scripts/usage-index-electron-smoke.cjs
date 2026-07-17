const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SqliteUsageIndexStorage } = require('../dist/main/usageIndex/index.js');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-usage-index-electron-'));
const storage = new SqliteUsageIndexStorage(path.join(tempDir, 'usage-index.sqlite'));
storage.close().then(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  process.exit(0);
}).catch(error => {
  console.error(error);
  process.exit(1);
});
