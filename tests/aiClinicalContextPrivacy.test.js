const test = require('node:test');
const assert = require('node:assert/strict');

const {
  redactClinicalText, minimizeAIClinicalContext,
} = require('../backend/services/aiClinicalContextPrivacy');

test('AI clinical context removes routing identifiers and direct contact fields while preserving clinical facts', () => {
  const value = minimizeAIClinicalContext({
    caseId:'CASE-PRIVATE', careProfileId:'CP-PRIVATE', residentId:'RES-PRIVATE',
    lineUserId:'U0123456789abcdef0123456789abcdef', groupId:'C0123456789abcdef0123456789abcdef',
    patientName:'ผู้ป่วย ทดสอบ', phone:'081-234-5678', email:'person@example.com', address:'กรุงเทพ',
    clinical:{ medicationName:'amlodipine', strength:'5 mg', condition:'ความดันโลหิตสูง' },
    source:{ category:'medication_snapshot', referenceId:'SNAPSHOT-PRIVATE' },
    contextVersion:{medicationSnapshotId:'SNAPSHOT-CONTEXT-PRIVATE',medicationVersionNo:2},
  });
  const serialized = JSON.stringify(value);
  for (const privateValue of [
    'CASE-PRIVATE','CP-PRIVATE','RES-PRIVATE','U0123456789abcdef0123456789abcdef',
    'C0123456789abcdef0123456789abcdef','ผู้ป่วย ทดสอบ','081-234-5678',
    'person@example.com','กรุงเทพ','SNAPSHOT-PRIVATE','SNAPSHOT-CONTEXT-PRIVATE',
  ]) assert.doesNotMatch(serialized, new RegExp(privateValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'));
  assert.match(serialized,/amlodipine|5 mg|ความดันโลหิตสูง/);
  assert.match(serialized,/"medicationVersionNo":2/);
});

test('AI clinical text redacts names contacts addresses DOB and known blocked identities', () => {
  const value = redactClinicalText(
    'ชื่อผู้ป่วย: สมชาย ใจดี, โทร 081-234-5678, email person@example.com, ที่อยู่: กรุงเทพ; วันเกิด: 1 มกราคม 2500; ใช้ amlodipine 5 mg',
    ['สมชาย ใจดี'],
  );
  assert.doesNotMatch(value,/สมชาย|081-234-5678|person@example\.com|กรุงเทพ|1 มกราคม 2500/);
  assert.match(value,/amlodipine 5 mg/);
});
