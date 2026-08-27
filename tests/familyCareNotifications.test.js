process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createFamilyCareNotificationService, PROJECTION_VERSION, renderFamilyCareMessage,
} = require('../backend/services/familyCareNotificationService');
const {
  createNotificationService, PROVIDER_RETRY_WINDOW_MS,
} = require('../backend/services/notificationService');
const { createPushMessage } = require('../backend/providers/lineClient');

function table(rows = []) {
  return {
    rows,
    async findOne(predicate) { return rows.find(predicate) || null; },
    async findWhere(predicate) { return rows.filter(predicate); },
    async insert(row) { rows.push({ ...row }); return rows.at(-1); },
    async update(predicate, patch) {
      const index = rows.findIndex(predicate); if (index < 0) return null;
      rows[index] = { ...rows[index], ...patch }; return rows[index];
    },
  };
}

function retryKeys() {
  let value = 0;
  return () => `00000000-0000-4000-8000-${String(++value).padStart(12, '0')}`;
}

const fullProjection = {
  careRecipientName:'ชื่อจาก payload ที่ไม่ควรแทน canonical', room:'A-12',
  centerDisplayName:'ศูนย์พี่หมอ สาขาทดสอบ',
  occurredAt:'2026-08-27T01:30:00Z', recordedAt:'2026-08-27T01:31:00Z',
  recorderDisplayName:'ผู้ดูแลเวรเช้า',
  vitalSigns:[
    { measurementType:'temperature', sourceValueText:'36.7', sourceUnit:'°C' },
    { measurementType:'blood_pressure_systolic', sourceValueText:'128', sourceUnit:'mm[Hg]' },
    { measurementType:'blood_pressure_diastolic', sourceValueText:'76', sourceUnit:'mm[Hg]' },
    { measurementType:'pulse', numericValue:72, sourceUnit:'bpm' },
    { measurementType:'spo2', numericValue:95, sourceUnit:'%' },
    { measurementType:'respiratory_rate', numericValue:18, sourceUnit:'breaths/min' },
  ],
  dailyCare:[
    { itemType:'shift', valueType:'text', textValue:'เวรเช้า' },
    { itemType:'nutrition', valueType:'text', textValue:'รับประทานอาหารได้ครึ่งจาน' },
    { itemType:'fluid_intake', valueType:'numeric', numericValue:500, sourceUnit:'mL' },
    { itemType:'bowel_movement', valueType:'numeric', numericValue:1, sourceUnit:'ครั้ง' },
    { itemType:'urination', valueType:'text', textValue:'ปัสสาวะ 3 ครั้ง' },
    { itemType:'sleep_rest', valueType:'text', textValue:'พักกลางวัน 1 ชั่วโมง' },
    { itemType:'activity', valueType:'text', textValue:'เดินรอบอาคาร' },
    { itemType:'mood_behavior', valueType:'text', textValue:'พูดคุยดี' },
    { itemType:'general_condition', valueType:'text', textValue:'รู้สึกตัวดี' },
    { itemType:'symptom_note', valueType:'text', textValue:'บ่นปวดเข่าหลังเดิน' },
  ],
};

test('active Family GroupBinding is canonical recipient and an external destination cannot override routing', async () => {
  const calls = [];
  const profiles = table([{ care_profile_id:'CP-A', owner_line_id:'U-OWNER', patient_name:'คุณยายใจดี', status:'active' }]);
  const bindings = table([{ binding_id:'GB-A', kind:'family', care_profile_id:'CP-A', line_group_id:'G-FAMILY', status:'active' }]);
  const service = createFamilyCareNotificationService({ CareProfiles:profiles, GroupBindings:bindings,
    enqueue:async (input) => { calls.push(input); return { ok:true }; } });
  await service.enqueueRecorded({ kind:'daily_care', careProfileId:'CP-A', resourceId:'DCR-1',
    projection:{ ...fullProjection, to:'G-ATTACKER', lineGroupId:'G-ATTACKER' } });
  assert.equal(calls[0].to, 'G-FAMILY');
  assert.doesNotMatch(calls[0].messages[0].text, /G-ATTACKER/);
  bindings.rows[0].status = 'inactive';
  await service.enqueueRecorded({ kind:'daily_care', careProfileId:'CP-A', resourceId:'DCR-2', projection:{} });
  assert.equal(calls[1].to, 'U-OWNER');
  assert.equal(calls[1].meta.recipientType, 'profile_owner');
});

test('missing active GroupBinding and owner creates no unsafe external recipient', async () => {
  let calls = 0;
  const service = createFamilyCareNotificationService({
    CareProfiles:table([{ care_profile_id:'CP-A', owner_line_id:null, status:'active' }]),
    GroupBindings:table([]), enqueue:async () => { calls += 1; },
  });
  assert.deepEqual(await service.enqueueRecorded({ kind:'vital_signs', careProfileId:'CP-A', resourceId:'VSET-1',
    projection:{ to:'G-UNTRUSTED' } }), { ok:false, reason:'no_family_recipient' });
  assert.equal(calls, 0);
});

test('Family Daily Care projection renders canonical identity, factual Daily fields, and recorded Vital values', () => {
  const text = renderFamilyCareMessage({ kind:'daily_care',
    profile:{ patient_name:'คุณยายใจดี' }, projection:fullProjection });
  for (const expected of [
    'คุณยายใจดี', 'ห้อง: A-12', 'ศูนย์พี่หมอ สาขาทดสอบ', 'เวรเช้า',
    'อุณหภูมิ 36.7 °C', 'ความดัน 128/76 mmHg', 'ชีพจร 72 bpm', 'SpO₂ 95%',
    'อัตราการหายใจ 18 breaths/min', 'รับประทานอาหารได้ครึ่งจาน', '500 mL',
    'ปัสสาวะ 3 ครั้ง', 'พักกลางวัน 1 ชั่วโมง', 'เดินรอบอาคาร', 'พูดคุยดี',
    'รู้สึกตัวดี', 'บ่นปวดเข่าหลังเดิน', 'ผู้ดูแลเวรเช้า',
  ]) assert.match(text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(text, /ชื่อจาก payload/);
});

test('missing values are omitted and renderer adds no high/low/normal/diagnosis interpretation', () => {
  const text = renderFamilyCareMessage({ kind:'vital_signs', profile:{ patient_name:'คุณตา' },
    projection:{ occurredAt:'2026-08-27T01:30:00Z', vitalSigns:[
      { measurementType:'spo2', numericValue:95, sourceUnit:'%' },
    ] } });
  assert.match(text, /SpO₂ 95%/);
  assert.doesNotMatch(text, /อุณหภูมิ|ความดัน|ชีพจร|อัตราการหายใจ|ห้อง:|ศูนย์\/สาขา:/);
  assert.doesNotMatch(text, /ปกติ|ผิดปกติ|สูง|ต่ำ|วิกฤต|วินิจฉัย|ควรพบแพทย์/);
});

test('notification text and metadata expose no internal or external technical identifiers', async () => {
  const calls = [];
  const service = createFamilyCareNotificationService({
    CareProfiles:table([{ care_profile_id:'CP-SECRET', patient_name:'ผู้รับการดูแล', status:'active' }]),
    GroupBindings:table([{ binding_id:'GB-SECRET', kind:'family', care_profile_id:'CP-SECRET', line_group_id:'G-SECRET', status:'active' }]),
    enqueue:async (input) => { calls.push(input); return { ok:true }; },
  });
  await service.enqueueRecorded({ kind:'daily_care', careProfileId:'CP-SECRET', resourceId:'DCR-SECRET',
    projection:{ ...fullProjection, externalResidentId:'EXT-RES-SECRET', integrationClientId:'INT-SECRET',
      integrationEventId:'EV-SECRET', lineUserId:'U-SECRET', apiCredential:'TOKEN-SECRET' } });
  const publicPayload = JSON.stringify(calls[0].messages);
  assert.doesNotMatch(publicPayload, /CP-SECRET|DCR-SECRET|EXT-RES-SECRET|INT-SECRET|EV-SECRET|U-SECRET|TOKEN-SECRET|G-SECRET|GB-SECRET/);
});

test('canonical record, projection version, and recipient dedupe create one replay-safe intent', async () => {
  const outbox = table([]);
  const notifications = createNotificationService({ NotificationOutbox:outbox,
    lineClient:{ async pushMessage() {} }, idFactory:() => `N-${outbox.rows.length + 1}`,
    retryKeyFactory:retryKeys(), now:() => '2026-08-27T00:00:00Z' });
  const family = createFamilyCareNotificationService({ CareProfiles:table([]),
    GroupBindings:table([{ binding_id:'GB-A', kind:'family', care_profile_id:'CP-A', line_group_id:'G-SECRET', status:'active' }]),
    enqueue:notifications.enqueue });
  const first = await family.enqueueRecorded({ kind:'vital_signs', careProfileId:'CP-A', resourceId:'VSET-1', projection:fullProjection });
  const replay = await family.enqueueRecorded({ kind:'vital_signs', careProfileId:'CP-A', resourceId:'VSET-1', projection:fullProjection });
  assert.equal(first.duplicate, undefined); assert.equal(replay.duplicate, true);
  assert.equal(outbox.rows.length, 1); assert.match(outbox.rows[0].dedupe_key, new RegExp(PROJECTION_VERSION));
  assert.doesNotMatch(outbox.rows[0].dedupe_key, /G-SECRET/);
});

test('first LINE request includes persisted retry key and every retry reuses the exact same key', async () => {
  const outbox = table([]); const seen = []; let current = new Date('2026-08-27T00:00:00Z');
  const notifications = createNotificationService({ NotificationOutbox:outbox,
    lineClient:{ async pushMessage(_to, _messages, options) { seen.push(options.retryKey); throw new Error('timeout'); } },
    idFactory:() => 'N-1', retryKeyFactory:retryKeys(), now:() => current.toISOString() });
  const queued = await notifications.enqueue({ dedupeKey:'K-1', to:'G-1', messages:[{ type:'text', text:'ข้อมูล' }] });
  assert.match(queued.notification.provider_retry_key, /^[0-9a-f-]{36}$/);
  await notifications.deliver(queued.notification);
  current = new Date(current.getTime() + 3 * 60000);
  await notifications.deliver(outbox.rows[0]);
  assert.equal(seen.length, 2); assert.equal(new Set(seen).size, 1);
  assert.equal(seen[0], outbox.rows[0].provider_retry_key);
});

test('expired worker lease recovers with the same persistent provider retry identity', async () => {
  const outbox = table([]); const seen = []; let current = new Date('2026-08-27T00:00:00Z');
  const notifications = createNotificationService({ NotificationOutbox:outbox,
    lineClient:{ async pushMessage(_to, _messages, options) { seen.push(options.retryKey); return { ok:true }; } },
    idFactory:() => 'N-1', retryKeyFactory:retryKeys(), now:() => current.toISOString() });
  const queued = await notifications.enqueue({ dedupeKey:'K-LEASE', to:'G-1', messages:[{ type:'text', text:'ข้อมูล' }] });
  const key = queued.notification.provider_retry_key;
  Object.assign(outbox.rows[0], { status:'sending', provider_first_attempt_at:current.toISOString(),
    delivery_lease_until:new Date(current.getTime() + 2 * 60000).toISOString() });
  current = new Date(current.getTime() + 3 * 60000);
  await notifications.deliver(outbox.rows[0]);
  assert.deepEqual(seen, [key]); assert.equal(outbox.rows[0].status, 'sent');
});

test('LINE retry-key 409 is provider acceptance and the outbox becomes sent without a new key', async () => {
  const acceptedId = 'accepted-request-1'; const providerKeys = [];
  const pushMessage = createPushMessage({ environment:() => 'production', log:[], messagingClient:{
    async pushMessage(_request, retryKey) {
      providerKeys.push(retryKey);
      throw { status:409, response:{ headers:{ 'x-line-accepted-request-id':acceptedId },
        data:{ message:'The retry key is already accepted', secret:'must-not-leak' } } };
    },
  } });
  const outbox = table([]);
  const notifications = createNotificationService({ NotificationOutbox:outbox, lineClient:{ pushMessage },
    idFactory:() => 'N-1', retryKeyFactory:retryKeys(), now:() => '2026-08-27T00:00:00Z' });
  const queued = await notifications.enqueue({ dedupeKey:'K-409', to:'G-1', messages:[{ type:'text', text:'ข้อมูล' }] });
  const result = await notifications.deliver(queued.notification);
  assert.equal(result.ok, true); assert.equal(result.providerAccepted, true);
  assert.equal(result.notification.status, 'sent');
  assert.equal(result.notification.provider_acceptance, 'retry_key_already_accepted');
  assert.equal(result.notification.provider_request_id, acceptedId);
  assert.deepEqual(providerKeys, [queued.notification.provider_retry_key]);
});

test('provider failure exposes only safe code and never token, clinical payload, or raw provider body', async () => {
  const pushMessage = createPushMessage({ environment:() => 'production', log:[], messagingClient:{
    async pushMessage() { throw { status:500, message:'TOKEN-SECRET value 72', response:{ data:{ token:'TOKEN-SECRET', value:72 } } }; },
  } });
  await assert.rejects(pushMessage('G-1', [{ type:'text', text:'SpO₂ 72%' }], { retryKey:'00000000-0000-4000-8000-000000000001' }),
    (error) => error.code === 'LINE_PUSH_FAILED' && error.providerStatus === 500
      && !/TOKEN-SECRET|72/.test(JSON.stringify(error)));
});

test('delivery failure retains intent, uses bounded retries, and never stores raw provider error', async () => {
  const outbox = table([]); let current = new Date('2026-08-27T00:00:00Z');
  const notifications = createNotificationService({ NotificationOutbox:outbox,
    lineClient:{ async pushMessage() { throw new Error('secret token and clinical value 72'); } },
    idFactory:() => 'N-1', retryKeyFactory:retryKeys(), now:() => current.toISOString() });
  const queued = await notifications.enqueue({ dedupeKey:'K-1', to:'G-1', kind:'family_vital_signs_recorded',
    meta:{ resourceId:'VSET-1' }, messages:[{ type:'text', text:'safe' }] });
  let result;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    current = new Date(current.getTime() + 2 * 60 * 60 * 1000);
    result = await notifications.deliver(outbox.rows[0]);
  }
  assert.equal(result.notification.status, 'dead_letter'); assert.equal(result.notification.attempts, 5);
  assert.equal(outbox.rows.length, 1); assert.equal(result.notification.last_error, 'LINE_DELIVERY_FAILED');
  assert.doesNotMatch(JSON.stringify(result.notification), /secret token|clinical value 72/);
  assert.equal(queued.ok, true);
});

test('five-attempt exponential policy reaches dead letter 30 minutes after the first attempt', async () => {
  const outbox = table([]); const started = new Date('2026-08-27T00:00:00Z'); let current = new Date(started);
  const notifications = createNotificationService({ NotificationOutbox:outbox,
    lineClient:{ async pushMessage() { throw new Error('timeout'); } }, idFactory:() => 'N-1',
    retryKeyFactory:retryKeys(), now:() => current.toISOString() });
  await notifications.enqueue({ dedupeKey:'K-HORIZON', to:'G-1', messages:[{ type:'text', text:'safe' }] });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await notifications.deliver(outbox.rows[0]);
    if (outbox.rows[0].next_attempt_at) current = new Date(outbox.rows[0].next_attempt_at);
  }
  assert.equal(outbox.rows[0].status, 'dead_letter');
  assert.equal(current.getTime() - started.getTime(), 30 * 60000);
});

test('ambiguous delivery is dead-lettered without sending beyond the provider 24-hour retry window', async () => {
  const outbox = table([]); let pushes = 0; let current = new Date('2026-08-27T00:00:00Z');
  const notifications = createNotificationService({ NotificationOutbox:outbox,
    lineClient:{ async pushMessage() { pushes += 1; } }, idFactory:() => 'N-1',
    retryKeyFactory:retryKeys(), now:() => current.toISOString() });
  await notifications.enqueue({ dedupeKey:'K-OLD', to:'G-1', messages:[{ type:'text', text:'safe' }] });
  Object.assign(outbox.rows[0], { status:'retrying', provider_first_attempt_at:current.toISOString(),
    next_attempt_at:current.toISOString() });
  current = new Date(current.getTime() + PROVIDER_RETRY_WINDOW_MS);
  const result = await notifications.deliver(outbox.rows[0]);
  assert.equal(result.retryWindowExpired, true); assert.equal(pushes, 0);
  assert.equal(outbox.rows[0].status, 'dead_letter');
  assert.equal(outbox.rows[0].last_error, 'LINE_RETRY_WINDOW_EXPIRED');
});

test('notification scheduler can later deliver a queued transactional intent', async () => {
  const outbox = table([]); const sent = [];
  const notifications = createNotificationService({ NotificationOutbox:outbox,
    lineClient:{ async pushMessage(to, messages, options) { sent.push({ to, messages, options }); } },
    idFactory:() => 'N-1', retryKeyFactory:retryKeys(), now:() => '2026-08-27T00:00:00Z' });
  await notifications.enqueue({ dedupeKey:'K-1', to:'G-1', messages:[{ type:'text', text:'safe' }] });
  assert.equal((await notifications.processPending()).sent, 1);
  assert.equal(outbox.rows[0].status, 'sent'); assert.equal(sent.length, 1);
  assert.equal(sent[0].options.retryKey, outbox.rows[0].provider_retry_key);
});

test('concurrent workers claim one delivery lease and do not push the same outbox row twice', async () => {
  const outbox = table([]); let pushes = 0; let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const notifications = createNotificationService({ NotificationOutbox:outbox,
    lineClient:{ async pushMessage() { pushes += 1; await gate; } }, idFactory:() => 'N-1',
    retryKeyFactory:retryKeys(), now:() => '2026-08-27T00:00:00Z' });
  const queued = await notifications.enqueue({ dedupeKey:'K-LEASE', to:'G-1', messages:[{ type:'text', text:'safe' }] });
  const first = notifications.deliver(queued.notification);
  await new Promise((resolve) => setImmediate(resolve));
  const second = await notifications.deliver(queued.notification);
  assert.equal(second.inProgress, true); release(); await first;
  assert.equal(pushes, 1); assert.equal(outbox.rows[0].status, 'sent');
});
