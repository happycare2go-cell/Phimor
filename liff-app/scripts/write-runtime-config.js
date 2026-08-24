const fs = require('node:fs');
const path = require('node:path');
const { requireBackendUrl } = require('../runtime-config');

function buildRuntimeConfigSource(value) {
  const backendUrl = requireBackendUrl(value);
  return `// Generated at deploy time. Do not place secrets in this file.\nwindow.PHIMOR_PUBLIC_BACKEND_URL = ${JSON.stringify(backendUrl)};\n`;
}

function main() {
  const output = path.resolve(__dirname, '..', 'environment.js');
  fs.writeFileSync(output, buildRuntimeConfigSource(process.env.PUBLIC_BACKEND_URL), 'utf8');
  process.stdout.write('LIFF runtime configuration generated.\n');
}

if (require.main === module) main();

module.exports = { buildRuntimeConfigSource };
