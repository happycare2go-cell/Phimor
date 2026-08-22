const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', 'liff-app');
const pages = {
  family: fs.readFileSync(path.join(root, 'family', 'index.html'), 'utf8'),
  center: fs.readFileSync(path.join(root, 'center-admin', 'index.html'), 'utf8'),
  register: fs.readFileSync(path.join(root, 'register', 'index.html'), 'utf8'),
  admin: fs.readFileSync(path.join(root, 'system-admin', 'index.html'), 'utf8'),
};

test('ทุก LIFF page มี LINE SDK, init, login และข้อความผิดพลาดที่ผู้ใช้มองเห็น', () => {
  for (const [name, html] of Object.entries(pages)) {
    assert.match(html, /static\.line-scdn\.net\/liff\/edge\/2\/sdk\.js/, `${name}: LINE SDK missing`);
    assert.match(html, /liff\.init\s*\(/, `${name}: liff.init missing`);
    assert.match(html, /liff\.login\s*\(/, `${name}: liff.login missing`);
    assert.match(html, /(toast|Error|error|ผิดพลาด|ไม่สำเร็จ)/, `${name}: visible error handling missing`);
  }
});

test('Family LIFF มี consent gate ก่อน flow Care Profile', () => {
  assert.match(pages.family, /\/api\/consent\/check/);
  assert.match(pages.family, /\/api\/consent/);
  assert.match(pages.family, /consentOverlay/);
});

test('Center LIFF tab รอดำเนินการเรียก named pending endpoint', () => {
  assert.match(pages.center, /\/api\/transport\/pending\?centerId=/);
  assert.match(pages.center, /id="transportList"/);
  assert.match(pages.center, /ไม่มีรายการรอดำเนินการ/);
});

test('องค์ประกอบสำคัญไม่มี id ซ้ำในหน้าเดียวกัน', () => {
  for (const [name, html] of Object.entries(pages)) {
    const ids = [...html.matchAll(/\sid=["']([^"']+)["']/g)].map((m) => m[1]);
    const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    assert.deepStrictEqual(duplicates, [], `${name}: duplicate ids: ${duplicates.join(', ')}`);
  }
});

test('หน้าใช้งานบนมือถือมี viewport และปุ่มสำคัญมีข้อความระบุการกระทำ', () => {
  for (const [name, html] of Object.entries(pages)) {
    assert.match(html, /name="viewport"/i, `${name}: viewport missing`);
    const emptyButtons = [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)]
      .filter((m) => m[1].replace(/<[^>]+>/g, '').trim() === '' && !/aria-label=/.test(m[0]));
    assert.strictEqual(emptyButtons.length, 0, `${name}: button without text or aria-label`);
  }
});
