const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'family', 'index.html'), 'utf8');

function functionSource(name, nextName) {
  const start = html.indexOf(`function ${name}`);
  const end = nextName ? html.indexOf(`function ${nextName}`, start + 1) : html.length;
  assert.notStrictEqual(start, -1, `${name} must exist`);
  assert.notStrictEqual(end, -1, `${nextName} must exist after ${name}`);
  return html.slice(start, end);
}

test('หน้า Home อธิบายว่า Care Profile เป็นข้อมูลของผู้สูงอายุหรือผู้รับการดูแล', () => {
  assert.match(html, /Care Profile คือข้อมูลของผู้สูงอายุหรือผู้รับการดูแลที่คุณมีสิทธิ์เข้าถึง/);
  assert.match(html, /<label>ชื่อผู้สูงอายุ<\/label>/);
  assert.match(html, />สร้าง Care Profile<\/button>/);
});

test('ไม่มี Care Profile จะแสดง empty state และซ่อน health profile content', () => {
  assert.match(html, /id="healthNoProfileState"/);
  assert.match(html, /ยังไม่ได้เลือก Care Profile/);
  assert.match(html, /รับคำเชิญจากศูนย์ดูแลก่อนบันทึกข้อมูลสุขภาพ/);
  assert.match(html, /id="healthProfileContent" hidden/);
  const render = functionSource('renderHealthProfile', 'openHomeForCareProfile');
  assert.match(render, /healthNoProfileState'\)\.hidden = Boolean\(profile\)/);
  assert.match(render, /healthProfileContent'\)\.hidden = !profile/);
});

test('Health heading และ helper text ระบุ Care Profile ที่กำลังเลือก', () => {
  assert.match(html, /id="healthProfileHeading"/);
  assert.match(html, /ข้อมูลด้านล่างเป็นข้อมูลของ Care Profile ที่กำลังเลือกอยู่/);
  assert.match(html, /การบันทึกจะอัปเดตข้อมูลปัจจุบันของ Care Profile นี้ ไม่ได้สร้างประวัติสุขภาพใหม่/);
  const render = functionSource('renderHealthProfile', 'openHomeForCareProfile');
  assert.match(render, /ข้อมูลสุขภาพปัจจุบันของ \$\{profile\.patient_name/);
});

test('การสลับ Care Profile ล้าง form ก่อนโหลดค่าของ profile ใหม่', () => {
  const render = functionSource('renderHealthProfile', 'openHomeForCareProfile');
  const clearAt = render.indexOf("HEALTH_VALUE_FIELDS.forEach");
  const fillAt = render.indexOf("profile.blood_type");
  assert.ok(clearAt >= 0 && fillAt > clearAt, 'health values must be cleared before the selected profile is rendered');
  assert.match(render, /setConditionChoices\('chronicConditions',\[\],'otherChronicConditions'\)/);
  const select = functionSource('selectProfile', 'saveHealthInfo');
  assert.match(select, /currentProfile=allProfiles\.find/);
  assert.match(select, /renderHealthProfile\(currentProfile\)/);
  assert.ok(select.indexOf('renderHealthProfile(currentProfile)') < select.indexOf('loadDashboard()'), 'new profile must render before the dashboard refresh');
  assert.match(html, /renderHealthProfile\(currentProfile\)/);
});

test('saveHealthInfo ยังคง PATCH Care Profile เดิมและไม่สร้าง health snapshot', () => {
  const save = functionSource('saveHealthInfo', 'copyForwardText');
  assert.match(save, /`\/api\/care-profile\/\$\{currentProfile\.profile\.care_profile_id\}`/);
  assert.match(save, /method:'PATCH'/);
  assert.doesNotMatch(save, /snapshot|POST/);
});

test('PDPA wording แยกผู้สูงอายุเจ้าของข้อมูลออกจากญาติและศูนย์ที่ได้รับสิทธิ์', () => {
  assert.doesNotMatch(html, /คุณในฐานะเจ้าของข้อมูล/);
  assert.match(html, /ผู้สูงอายุหรือผู้รับการดูแลเป็นเจ้าของข้อมูลสุขภาพ/);
  assert.match(html, /ญาติหรือผู้ดูแลสามารถเข้าถึงและจัดการข้อมูลตามสิทธิ์ที่ได้รับ/);
  assert.match(html, /ศูนย์ดูแลเข้าถึงได้เฉพาะเมื่อมีความสัมพันธ์และสิทธิ์ที่ยังใช้งานอยู่/);
});
