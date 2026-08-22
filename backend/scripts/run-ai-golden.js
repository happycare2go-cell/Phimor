// Optional live-AI regression runner. Default mode only validates the dataset;
// live calls require an explicit flag to prevent accidental cost/data upload.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const manifestPath = path.join(root, 'tests', 'fixtures', 'ai-golden', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
let failed = 0;

function validate(result, expected) {
  if (expected.documentType && result.documentType !== expected.documentType) return `documentType expected ${expected.documentType}, got ${result.documentType}`;
  if (expected.hasAppointment === true && !result.appointment) return 'appointment missing';
  if (expected.hasMedication === true && !(result.medications || []).length) return 'medication missing';
  return null;
}

(async () => {
  const live = process.env.RUN_REAL_AI_GOLDEN === 'true';
  if (live && !process.env.GEMINI_API_KEY) throw new Error('RUN_REAL_AI_GOLDEN=true requires GEMINI_API_KEY');
  const ai = live ? require('../providers/aiProvider') : null;
  for (const item of manifest.cases) {
    const imagePath = path.resolve(root, item.image);
    if (!fs.existsSync(imagePath)) { console.error(`FAIL ${item.id}: missing ${item.image}`); failed++; continue; }
    if (!live) { console.log(`VALID ${item.id}: ${item.image}`); continue; }
    const result = await ai.interpretDocument(fs.readFileSync(imagePath), item.mimeType);
    const error = validate(result, item.expected);
    if (error) { console.error(`FAIL ${item.id}: ${error}`); failed++; }
    else console.log(`PASS ${item.id}`);
  }
  if (!live) console.log('Dataset valid. Set RUN_REAL_AI_GOLDEN=true with a staging GEMINI_API_KEY to call the real model.');
  process.exitCode = failed ? 1 : 0;
})().catch((error) => { console.error(error); process.exit(1); });
