// tests/webhook.test.js — ทดสอบ Flow เต็มผ่าน HTTP จริง (join → ส่งรูป → ยืนยัน)

const { test, beforeEach, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const lineSdk = require('@line/bot-sdk');

const db = require('../backend/db');
const centerService = require('../backend/services/centerService');
const aiProvider = require('../backend/providers/aiProvider');
const lineClient = require('../backend/providers/lineClient');

let server, baseUrl;

before(async () => {
  const app = require('../backend/server');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  db.resetAll();
  aiProvider.clearMockQueue();
  lineClient.clearSentLog();
});

async function postWebhook(events) {
  const res = await fetch(`${baseUrl}/webhook`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events }),
  });
  await new Promise((r) => setTimeout(r, 60)); // เผื่อเวลาให้ประมวลผลแบบ async เสร็จก่อนตรวจสอบผล
  return res;
}

test('GET /health ต้องตอบ 200', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.status, 'ok');
});

test('LINE Verify ส่ง events ว่างมา ต้องตอบ 200 โดยไม่สร้าง inbox', async () => {
  const res = await postWebhook([]);
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await db.WebhookInbox.findAll()).length, 0);
});

test('private opencenter aliases reply with one runtime LIFF registration action and create no Center', async () => {
  const previous = process.env.LIFF_ID_REGISTER;
  process.env.LIFF_ID_REGISTER = '2000000000-AbCdEf12';
  try {
    const aliases = ['opencenter', '  OPEN   CENTER  ', 'เปิดศูนย์', 'สมัครศูนย์', 'ลงทะเบียนศูนย์'];
    for (const [index, text] of aliases.entries()) {
      lineClient.clearSentLog();
      await require('../backend/routes/webhook').processEvent({
        type:'message', replyToken:`RT-OPEN-${index}`,
        message:{ type:'text', text }, source:{ type:'user', userId:'U-OWNER' },
      });
      const sent = lineClient.getSentLog();
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sent[0].type, 'reply');
      assert.strictEqual(sent[0].messages[0].type, 'template');
      assert.strictEqual(sent[0].messages[0].template.actions[0].label, 'ลงทะเบียนศูนย์ใหม่');
      assert.strictEqual(sent[0].messages[0].template.actions[0].uri, 'https://liff.line.me/2000000000-AbCdEf12');
    }
    assert.strictEqual((await db.Centers.findAll()).length, 0);
  } finally {
    if (previous === undefined) delete process.env.LIFF_ID_REGISTER;
    else process.env.LIFF_ID_REGISTER = previous;
  }
});

test('opencenter exact matching does not accept substring commands', async () => {
  const previous = process.env.LIFF_ID_REGISTER;
  process.env.LIFF_ID_REGISTER = '2000000000-AbCdEf12';
  try {
    await require('../backend/routes/webhook').processEvent({
      type:'message', replyToken:'RT-NOT-COMMAND',
      message:{ type:'text', text:'please opencenter now' }, source:{ type:'user', userId:'U-OWNER' },
    });
    assert.strictEqual(lineClient.getSentLog().length, 0);
  } finally {
    if (previous === undefined) delete process.env.LIFF_ID_REGISTER;
    else process.env.LIFF_ID_REGISTER = previous;
  }
});

test('opencenter aliases are silently consumed in group and room sources', async () => {
  const previous = process.env.LIFF_ID_REGISTER;
  process.env.LIFF_ID_REGISTER = '2000000000-AbCdEf12';
  try {
    for (const source of [
      { type:'group', groupId:'G-FAMILY', userId:'U-1' },
      { type:'room', roomId:'R-CARE2GO', userId:'U-1' },
    ]) {
      await require('../backend/routes/webhook').processEvent({
        type:'message', replyToken:`RT-${source.type}`,
        message:{ type:'text', text:'เปิดศูนย์' }, source,
      });
    }
    assert.strictEqual(lineClient.getSentLog().length, 0);
    assert.strictEqual((await db.CenterStaff.findAll()).length, 0);
  } finally {
    if (previous === undefined) delete process.env.LIFF_ID_REGISTER;
    else process.env.LIFF_ID_REGISTER = previous;
  }
});

test('source authority recognizes both LINE groups and LINE rooms only', () => {
  const webhook = require('../backend/routes/webhook');
  assert.equal(webhook.isGroupOrRoomSource({ source:{ type:'group', groupId:'G-1' } }), true);
  assert.equal(webhook.isGroupOrRoomSource({ source:{ type:'room', roomId:'R-1' } }), true);
  assert.equal(webhook.isGroupOrRoomSource({ source:{ type:'user', userId:'U-1' } }), false);
  assert.equal(webhook.isGroupOrRoomSource({ source:{ groupId:'G-FORGED' } }), false);
});

test('group and room images short-circuit before LINE blob fetch, card processing, storage, or reply', async () => {
  const webhook = require('../backend/routes/webhook');
  let blobCalls = 0;
  let imageHandlerCalls = 0;
  const dependencies = {
    blobClient:{ getMessageContent:async () => { blobCalls += 1; throw new Error('must not fetch group media'); } },
    handleImageMessage:async () => { imageHandlerCalls += 1; },
  };
  for (const source of [
    { type:'group', groupId:'G-FAMILY', userId:'U-MEMBER' },
    { type:'room', roomId:'R-OPERATIONS', userId:'U-MEMBER' },
  ]) {
    await webhook.processEvent({
      type:'message', replyToken:`RT-${source.type}`, message:{ type:'image', id:`IMG-${source.type}` }, source,
    }, dependencies);
  }
  assert.equal(blobCalls, 0);
  assert.equal(imageHandlerCalls, 0);
  assert.equal((await db.PendingCards.findAll()).length, 0);
  assert.deepEqual(lineClient.getSentLog(), []);
});

test('verified Family and Care2Go groups remain silent for ordinary conversation and media', async () => {
  await db.CareProfiles.insert({ care_profile_id:'CP-SILENT', owner_line_id:'U-FAMILY', patient_name:'ผู้พักทดสอบ', status:'independent' });
  await db.GroupBindings.insert({ binding_id:'GB-FAMILY-SILENT', kind:'family', care_profile_id:'CP-SILENT',
    line_group_id:'G-FAMILY-SILENT', status:'active' });
  await db.GroupBindings.insert({ binding_id:'GB-CARE2GO-SILENT', kind:'care2go_ops',
    line_group_id:'G-CARE2GO-SILENT', status:'active' });
  const webhook = require('../backend/routes/webhook');
  for (const [groupId, userId] of [['G-FAMILY-SILENT', 'U-FAMILY'], ['G-CARE2GO-SILENT', 'U-OPS']]) {
    await webhook.processEvent({ type:'message', replyToken:`RT-${groupId}-TEXT`, message:{ type:'text', text:'คุยกันตามปกติ' },
      source:{ type:'group', groupId, userId } });
    await webhook.processEvent({ type:'message', replyToken:`RT-${groupId}-IMAGE`, message:{ type:'image', mockBase64:'cHJpdmF0ZQ==' },
      source:{ type:'group', groupId, userId } });
  }
  assert.deepEqual(lineClient.getSentLog().filter((item) => ['reply', 'push'].includes(item.type)), []);
  assert.equal((await db.PendingCards.findAll()).length, 0);
  assert.equal((await db.CenterStaff.findAll()).length, 0);
});

test('ordinary group and room media types are silent and retain no application records', async () => {
  const webhook = require('../backend/routes/webhook');
  for (const type of ['video', 'audio', 'file', 'location', 'sticker', 'unsupported']) {
    await webhook.processEvent({
      type:'message', replyToken:`RT-G-${type}`, message:{ type, id:`MSG-G-${type}` },
      source:{ type:'group', groupId:'G-UNBOUND', userId:'U-GROUP' },
    });
    await webhook.processEvent({
      type:'message', replyToken:`RT-R-${type}`, message:{ type, id:`MSG-R-${type}` },
      source:{ type:'room', roomId:'R-UNBOUND', userId:'U-ROOM' },
    });
  }
  assert.deepEqual(lineClient.getSentLog(), []);
  assert.equal((await db.PendingCards.findAll()).length, 0);
  assert.equal((await db.CenterStaff.findAll()).length, 0);
  assert.equal((await db.AuditLog.findAll()).length, 0);
});

test('ordinary Center Staff group text and sticker discover staff without replying', async () => {
  const center = await centerService.createCenter({ name:'ศูนย์เงียบ', ownerLineId:'U-OWNER' });
  await centerService.bindGroupToCenter({ centerId:center.center_id, groupId:'G-STAFF-SILENT', requesterLineId:'U-OWNER' });
  lineClient.clearSentLog();
  const webhook = require('../backend/routes/webhook');
  await webhook.processEvent({ type:'message', replyToken:'RT-TEXT', message:{ type:'text', text:'คุยงานกันตามปกติ' },
    source:{ type:'group', groupId:'G-STAFF-SILENT', userId:'U-TEXT-STAFF' } });
  await webhook.processEvent({ type:'message', replyToken:'RT-STICKER', message:{ type:'sticker', packageId:'1', stickerId:'1' },
    source:{ type:'group', groupId:'G-STAFF-SILENT', userId:'U-STICKER-STAFF' } });
  assert.equal((await db.CenterStaff.findOne((row) => row.line_user_id === 'U-TEXT-STAFF'))?.role, 'staff');
  assert.equal((await db.CenterStaff.findOne((row) => row.line_user_id === 'U-STICKER-STAFF'))?.role, 'staff');
  assert.deepEqual(lineClient.getSentLog().filter((item) => ['reply', 'push'].includes(item.type)), []);
});

test('private image still fetches content and reaches the existing image handler', async () => {
  const webhook = require('../backend/routes/webhook');
  let blobCalls = 0;
  let handledBuffer = null;
  await webhook.processEvent({
    type:'message', replyToken:'RT-PRIVATE', message:{ type:'image', id:'IMG-PRIVATE' },
    source:{ type:'user', userId:'U-PRIVATE' },
  }, {
    blobClient:{ getMessageContent:async () => {
      blobCalls += 1;
      return (async function* stream() { yield Buffer.from('private-image'); }());
    } },
    handleImageMessage:async (_event, buffer) => { handledBuffer = buffer; },
  });
  assert.equal(blobCalls, 1);
  assert.equal(handledBuffer.toString(), 'private-image');
});

test('malformed binding-like and random uppercase group text stay silent', async () => {
  const webhook = require('../backend/routes/webhook');
  for (const text of ['FAMILY-123', 'STAFF-ABC', 'CGROUP-invalid', 'RANDOM-UPPERCASE', 'คุยกันตามปกติ']) {
    await webhook.processEvent({ type:'message', replyToken:`RT-${text}`, message:{ type:'text', text },
      source:{ type:'group', groupId:'G-UNBOUND', userId:'U-RANDOM' } });
  }
  assert.deepEqual(lineClient.getSentLog(), []);
  assert.equal((await db.CenterStaff.findAll()).length, 0);
});

test('supported FAMILY and STAFF binding codes retain their authoritative replies', async () => {
  const groupBindingService = require('../backend/services/groupBindingService');
  const center = await centerService.createCenter({ name:'ศูนย์ผูกกลุ่ม', ownerLineId:'U-OWNER' });
  const staffToken = await groupBindingService.createStaffBindingToken(center.center_id, 'U-OWNER');
  await require('../backend/routes/webhook').processEvent({ type:'message', replyToken:'RT-STAFF',
    message:{ type:'text', text:staffToken.code }, source:{ type:'group', groupId:'G-STAFF-CODE', userId:'U-OWNER' } });
  assert.match(lineClient.getSentLog().find((item) => item.replyToken === 'RT-STAFF').messages[0].text, /ผูกเป็นกลุ่มพนักงาน/);

  db.resetAll();
  lineClient.clearSentLog();
  await db.CareProfiles.insert({ care_profile_id:'CP-FAMILY-CODE', owner_line_id:'U-FAMILY', patient_name:'ผู้พักทดสอบ', status:'independent' });
  const familyToken = await groupBindingService.createFamilyBindingToken('CP-FAMILY-CODE', 'U-FAMILY');
  await require('../backend/routes/webhook').processEvent({ type:'message', replyToken:'RT-FAMILY',
    message:{ type:'text', text:familyToken.code }, source:{ type:'group', groupId:'G-FAMILY-CODE', userId:'U-FAMILY' } });
  assert.match(lineClient.getSentLog().find((item) => item.replyToken === 'RT-FAMILY').messages[0].text, /ผูกเป็นกลุ่มครอบครัว/);
});

test('configured Care2Go binding code and valid binding failure still reply safely', async () => {
  const previousCode = process.env.CARE2GO_GROUP_BIND_CODE;
  const originalBind = require('../backend/services/transportService').bindCare2goOperationsGroup;
  process.env.CARE2GO_GROUP_BIND_CODE = 'CARE2GO-TEST-EXACT';
  require('../backend/services/transportService').bindCare2goOperationsGroup = async () => ({ ok:true });
  try {
    const webhook = require('../backend/routes/webhook');
    await webhook.processEvent({ type:'message', replyToken:'RT-CARE2GO', message:{ type:'text', text:'CARE2GO-TEST-EXACT' },
      source:{ type:'group', groupId:'G-CARE2GO', userId:'U-OPS' } });
    await webhook.processEvent({ type:'message', replyToken:'RT-INVALID-FAMILY', message:{ type:'text', text:'FAMILY-ABC123' },
      source:{ type:'group', groupId:'G-FAMILY', userId:'U-FAMILY' } });
    const replies = lineClient.getSentLog().filter((item) => item.type === 'reply');
    assert.equal(replies.length, 2);
    assert.match(replies[0].messages[0].text, /Care2Go/);
    assert.match(replies[1].messages[0].text, /ผูกกลุ่มไม่สำเร็จ/);
  } finally {
    require('../backend/services/transportService').bindCare2goOperationsGroup = originalBind;
    if (previousCode === undefined) delete process.env.CARE2GO_GROUP_BIND_CODE;
    else process.env.CARE2GO_GROUP_BIND_CODE = previousCode;
  }
});

test('authorized postback remains an explicit interaction even when sourced from a group', async () => {
  await require('../backend/routes/webhook').processEvent({
    type:'postback', replyToken:'RT-POSTBACK', postback:{ data:'action=care2go_ack' },
    source:{ type:'group', groupId:'G-OPERATIONS', userId:'U-OPS' },
  });
  const reply = lineClient.getSentLog().find((item) => item.replyToken === 'RT-POSTBACK');
  assert.match(reply.messages[0].text, /ปุ่มจากการ์ดรุ่นเก่า/);
});

test('ignored group media is marked processed, does not retry, and duplicate delivery is deduped', async () => {
  const webhook = require('../backend/routes/webhook');
  const event = { webhookEventId:'EVT-SILENT-GROUP-IMAGE', type:'message', replyToken:'RT-SILENT',
    message:{ type:'image', id:'IMG-SILENT' }, source:{ type:'group', groupId:'G-SILENT', userId:'U-MEMBER' } };
  await Promise.all([webhook.enqueueWebhookEvent(event), webhook.enqueueWebhookEvent({ ...event, deliveryContext:{ isRedelivery:true } })]);
  await webhook.enqueueWebhookEvent({ webhookEventId:'EVT-SILENT-GROUP-TEXT', type:'message', replyToken:'RT-TEXT',
    message:{ type:'text', text:'ordinary private conversation' },
    source:{ type:'group', groupId:'G-SILENT', userId:'U-MEMBER' } });
  const result = await webhook.processPendingWebhookEvents();
  const rows = await db.WebhookInbox.findWhere((row) => row.event_key === event.webhookEventId);
  const textRow = await db.WebhookInbox.findOne((row) => row.event_key === 'EVT-SILENT-GROUP-TEXT');
  assert.equal(result.processed, 2);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'processed');
  assert.equal(rows[0].attempts, 1);
  assert.equal(rows[0].last_error, undefined);
  assert.equal(textRow.status, 'processed');
  assert.equal(textRow.attempts, 1);
  assert.equal(textRow.last_error, undefined);
  assert.deepEqual(lineClient.getSentLog(), []);
  assert.equal((await db.PendingCards.findAll()).length, 0);
});

test('missing LIFF_ID_REGISTER returns a safe private reply without a broken URI', async () => {
  const previous = process.env.LIFF_ID_REGISTER;
  delete process.env.LIFF_ID_REGISTER;
  try {
    await require('../backend/routes/webhook').processEvent({
      type:'message', replyToken:'RT-MISSING-LIFF',
      message:{ type:'text', text:'opencenter' }, source:{ type:'user', userId:'U-OWNER' },
    });
    const text = lineClient.getSentLog()[0].messages[0].text;
    assert.match(text, /ติดต่อทีมงานพี่หมอ/);
    assert.doesNotMatch(text, /YOUR_LIFF_ID|undefined|https:\/\/liff\.line\.me\/$/);
  } finally {
    if (previous !== undefined) process.env.LIFF_ID_REGISTER = previous;
  }
});

test('opencenter webhook redelivery with the same event ID produces one reply', async () => {
  const previous = process.env.LIFF_ID_REGISTER;
  process.env.LIFF_ID_REGISTER = '2000000000-AbCdEf12';
  try {
    const event = {
      webhookEventId:'EVT-OPEN-CENTER', type:'message', replyToken:'RT-OPEN',
      deliveryContext:{ isRedelivery:false }, message:{ type:'text', text:'opencenter' },
      source:{ type:'user', userId:'U-OWNER' },
    };
    await Promise.all([postWebhook([event]), postWebhook([{ ...event, deliveryContext:{ isRedelivery:true } }])]);
    assert.strictEqual((await db.WebhookInbox.findWhere((row) => row.event_key === event.webhookEventId)).length, 1);
    assert.strictEqual(lineClient.getSentLog().filter((item) => item.type === 'reply').length, 1);
  } finally {
    if (previous === undefined) delete process.env.LIFF_ID_REGISTER;
    else process.env.LIFF_ID_REGISTER = previous;
  }
});

test('ลายเซ็น LINE แบบ HMAC-SHA256 ถูกต้องผ่าน และ body ที่ถูกแก้ต้องไม่ผ่าน', () => {
  const secret = 'test-channel-secret';
  const rawBody = JSON.stringify({ destination:'U_TEST', events:[] });
  const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  assert.strictEqual(lineSdk.validateSignature(rawBody, secret, signature), true);
  assert.strictEqual(lineSdk.validateSignature(rawBody + ' ', secret, signature), false);
  assert.strictEqual(lineSdk.validateSignature(rawBody, secret, 'invalid-signature'), false);
});

test('LINE join redelivery ที่มี webhookEventId เดิมต้องส่ง onboarding ครั้งเดียว', async () => {
  const event = { webhookEventId:'EVT_DUPLICATE', type:'join',
    deliveryContext:{ isRedelivery:false }, source:{ type:'group', groupId:'G_UNKNOWN' } };
  const redelivery = { ...event, deliveryContext:{ isRedelivery:true } };
  const [first, second] = await Promise.all([postWebhook([event]), postWebhook([redelivery])]);
  assert.strictEqual(first.status, 200);
  assert.strictEqual(second.status, 200);
  const rows = await db.WebhookInbox.findWhere((row) => row.event_key === 'EVT_DUPLICATE');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].attempts, 1);
  const onboarding = lineClient.getSentLog().filter((item) => item.type === 'push'
    && item.to === 'G_UNKNOWN' && item.messages[0].text.includes('พี่หมอเข้ากลุ่มแล้ว'));
  assert.strictEqual(onboarding.length, 1);
});

test('concurrent webhook workers atomically claim one pending join event', async () => {
  let pushes = 0;
  let releasePush;
  let markStarted;
  const pushGate = new Promise((resolve) => { releasePush = resolve; });
  const pushStarted = new Promise((resolve) => { markStarted = resolve; });
  const originalPush = lineClient.pushMessage;
  lineClient.pushMessage = async () => {
    pushes += 1;
    markStarted();
    await pushGate;
    return { ok:true };
  };
  try {
    await db.WebhookInbox.insert({
      inbox_id:'WH-CONCURRENT', event_key:'EVT-CONCURRENT',
      event:{ webhookEventId:'EVT-CONCURRENT', type:'join', source:{ type:'group', groupId:'G-CONCURRENT' } },
      status:'pending', attempts:0, received_at:db.now(),
    });
    const firstWorker = require('../backend/routes/webhook').processPendingWebhookEvents();
    await pushStarted;
    const secondResult = await require('../backend/routes/webhook').processPendingWebhookEvents();
    assert.strictEqual(pushes, 1);
    assert.strictEqual(secondResult.processed, 0);
    releasePush();
    await firstWorker;
    const row = await db.WebhookInbox.findOne((item) => item.inbox_id === 'WH-CONCURRENT');
    assert.strictEqual(row.status, 'processed');
    assert.strictEqual(row.attempts, 1);
  } finally {
    releasePush();
    lineClient.pushMessage = originalPush;
  }
});

test('onboarding retry reuses one stable LINE retry key', async () => {
  const retryKeys = [];
  const originalPush = lineClient.pushMessage;
  const originalError = console.error;
  lineClient.pushMessage = async (_to, _messages, options) => {
    retryKeys.push(options.retryKey);
    if (retryKeys.length === 1) throw new Error('simulated timeout');
    return { ok:true };
  };
  console.error = () => {};
  try {
    await db.WebhookInbox.insert({
      inbox_id:'WH-RETRY', event_key:'EVT-RETRY',
      event:{ webhookEventId:'EVT-RETRY', type:'join', source:{ type:'group', groupId:'G-RETRY' } },
      status:'pending', attempts:0, received_at:db.now(),
    });
    await require('../backend/routes/webhook').processPendingWebhookEvents();
    await require('../backend/routes/webhook').processPendingWebhookEvents();
    assert.strictEqual(retryKeys.length, 2);
    assert.strictEqual(retryKeys[0], retryKeys[1]);
    assert.match(retryKeys[0], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const row = await db.WebhookInbox.findOne((item) => item.inbox_id === 'WH-RETRY');
    assert.strictEqual(row.status, 'processed');
    assert.strictEqual(row.attempts, 2);
  } finally {
    console.error = originalError;
    lineClient.pushMessage = originalPush;
  }
});

test('memberJoined alongside join does not send a second onboarding message', async () => {
  const webhook = require('../backend/routes/webhook');
  await webhook.processEvent({ webhookEventId:'EVT-JOIN', type:'join', source:{ type:'group', groupId:'G-PAIR' } });
  await webhook.processEvent({ webhookEventId:'EVT-MEMBER', type:'memberJoined',
    source:{ type:'group', groupId:'G-PAIR' }, joined:{ members:[{ type:'user', userId:'U-MEMBER' }] } });
  const onboarding = lineClient.getSentLog().filter((item) => item.type === 'push'
    && item.to === 'G-PAIR' && item.messages[0].text.includes('พี่หมอเข้ากลุ่มแล้ว'));
  assert.strictEqual(onboarding.length, 1);
});

test('distinct legitimate group joins each receive one onboarding message', async () => {
  const webhook = require('../backend/routes/webhook');
  await webhook.processEvent({ webhookEventId:'EVT-JOIN-A', type:'join', source:{ type:'group', groupId:'G-A' } });
  await webhook.processEvent({ webhookEventId:'EVT-JOIN-B', type:'join', source:{ type:'group', groupId:'G-B' } });
  const onboarding = lineClient.getSentLog().filter((item) => item.type === 'push'
    && item.messages[0].text.includes('พี่หมอเข้ากลุ่มแล้ว'));
  assert.deepStrictEqual(onboarding.map((item) => item.to), ['G-A', 'G-B']);
});

test('shared Family group leave deactivates every profile and join does not reactivate history', async () => {
  await db.GroupBindings.insert({ binding_id:'GB-1', kind:'family', care_profile_id:'CP-1', line_group_id:'G-SHARED', status:'active' });
  await db.GroupBindings.insert({ binding_id:'GB-2', kind:'family', care_profile_id:'CP-2', line_group_id:'G-SHARED', status:'active' });
  const webhook = require('../backend/routes/webhook');
  await webhook.processEvent({ type:'leave', source:{ type:'group', groupId:'G-SHARED' } });
  let rows = await db.GroupBindings.findWhere((binding) => binding.line_group_id === 'G-SHARED');
  assert.ok(rows.every((binding) => binding.status === 'inactive' && binding.unbound_at));

  await webhook.processEvent({ webhookEventId:'EVT-REJOIN', type:'join', source:{ type:'group', groupId:'G-SHARED' } });
  rows = await db.GroupBindings.findWhere((binding) => binding.line_group_id === 'G-SHARED');
  assert.ok(rows.every((binding) => binding.status === 'inactive'));
});

test('shared Family group memberLeft deactivates only profiles owned by that LINE actor', async () => {
  await db.CareProfiles.insert({ care_profile_id:'CP-1', owner_line_id:'U-A', patient_name:'คุณพ่อ', status:'independent' });
  await db.CareProfiles.insert({ care_profile_id:'CP-2', owner_line_id:'U-B', patient_name:'คุณแม่', status:'independent' });
  await db.GroupBindings.insert({ binding_id:'GB-1', kind:'family', care_profile_id:'CP-1', line_group_id:'G-SHARED', status:'active' });
  await db.GroupBindings.insert({ binding_id:'GB-2', kind:'family', care_profile_id:'CP-2', line_group_id:'G-SHARED', status:'active' });
  await require('../backend/routes/webhook').processEvent({ type:'memberLeft', source:{ type:'group', groupId:'G-SHARED' },
    left:{ members:[{ type:'user', userId:'U-A' }] } });
  const rows = await db.GroupBindings.findWhere((binding) => binding.line_group_id === 'G-SHARED');
  assert.equal(rows.find((binding) => binding.care_profile_id === 'CP-1').status, 'inactive');
  assert.equal(rows.find((binding) => binding.care_profile_id === 'CP-2').status, 'active');
});

test('Flow เต็มผ่าน HTTP: พนักงานทักในกลุ่ม → ส่งรูปส่วนตัว → ผู้จัดการยืนยัน → ครอบครัวได้รับ', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  await centerService.bindGroupToCenter({ centerId: center.center_id, groupId: 'G_CENTER', requesterLineId: 'U_OWNER' });
  const { resident } = await centerService.addResident({ centerId: center.center_id, fullName: 'สมศรี ใจดี' });
  await db.CareProfiles.insert({ care_profile_id: 'CP-1', owner_line_id: 'U_FAMILY', patient_name: 'สมศรี ใจดี', center_id: center.center_id, status: 'linked' });
  await db.Residents.update((r) => r.resident_id === resident.resident_id, { care_profile_id: 'CP-1' });

  // ① พนักงานทักในกลุ่มหนึ่งครั้ง เพื่อให้ระบบรู้ว่าเป็นพนักงานของศูนย์ไหน
  await postWebhook([{
    type: 'message', replyToken: 'RT0', message: { type: 'text', text: 'สวัสดีครับ' },
    source: { type: 'group', groupId: 'G_CENTER', userId: 'U_STAFF' },
  }]);
  const staffRow = await db.CenterStaff.findOne((x) => x.line_user_id === 'U_STAFF');
  assert.ok(staffRow, 'ระบบต้องบันทึกพนักงานอัตโนมัติจากการทักในกลุ่ม');
  assert.strictEqual(staffRow.role, 'staff');

  // ② พนักงานส่งรูปในแชทส่วนตัว
  aiProvider.queueMockResponse({
    documentType: 'medical', nameGuess: 'สมศรี ใจดี', nameConfidence: 0.95,
    appointment: { hospital: 'รพ.จุฬาฯ', datetime: '2099-01-01T09:00:00', note: 'งดน้ำงดอาหาร' },
    medications: [{ name: 'Metformin', dose: '500mg หลังอาหารเช้า' }], doctorNote: null,
  });
  await postWebhook([{
    type: 'message', replyToken: 'RT1', message: { type: 'image', mockBase64: Buffer.from('fake').toString('base64') },
    source: { type: 'user', userId: 'U_STAFF' },
  }]);

  const cards = await db.PendingCards.findAll();
  assert.strictEqual(cards.length, 1);
  assert.strictEqual(cards[0].submitted_by, 'U_STAFF', 'ต้องบันทึกว่าใครเป็นคนส่งรูป');

  // ③ การ์ดต้องถูกส่งเข้าแชทส่วนตัวของเจ้าของ ไม่ใช่เข้ากลุ่ม
  const toOwner = lineClient.getSentLog().find((x) => x.type === 'push' && x.to === 'U_OWNER');
  const toGroup = lineClient.getSentLog().find((x) => x.type === 'push' && x.to === 'G_CENTER');
  assert.ok(toOwner, 'การ์ดยืนยันต้องส่งเข้าแชทส่วนตัวของผู้มีสิทธิ์อนุมัติ');
  assert.strictEqual(toGroup, undefined, 'ต้องไม่ส่งการ์ดยืนยันเข้ากลุ่มงานศูนย์');

  // ④ พนักงานทั่วไปกดยืนยันไม่ได้
  const staffTry = await postWebhook([{
    type: 'postback', replyToken: 'RT2', postback: { data: `action=confirm_card&cardId=${cards[0].card_id}` },
    source: { type: 'user', userId: 'U_STAFF' },
  }]);
  let updatedCard = await db.PendingCards.findOne((x) => x.card_id === cards[0].card_id);
  assert.strictEqual(updatedCard.status, 'pending', 'พนักงานทั่วไปต้องยืนยันไม่ได้');

  // ⑤ ผู้จัดการยืนยัน
  await postWebhook([{
    type: 'postback', replyToken: 'RT3', postback: { data: `action=confirm_card&cardId=${cards[0].card_id}` },
    source: { type: 'user', userId: 'U_OWNER' },
  }]);
  updatedCard = await db.PendingCards.findOne((x) => x.card_id === cards[0].card_id);
  assert.strictEqual(updatedCard.status, 'confirmed');

  const familyPush = lineClient.getSentLog().find((x) => x.type === 'push' && x.to === 'U_FAMILY');
  assert.ok(familyPush, 'ครอบครัวต้องได้รับข้อความหลังผู้จัดการยืนยัน');
});

test('crafted LINE confirm_card postback cannot bypass Center Lab review', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ Lab', ownerLineId: 'U_OWNER' });
  const { resident } = await centerService.addResident({ centerId: center.center_id, fullName: 'ผู้พัก Lab' });
  await db.PendingCards.insert({
    card_id: 'CARD-LAB-UNREVIEWED', center_id: center.center_id, resident_id: resident.resident_id,
    document_subtype: 'lab_report', ai_result: { documentSubtype: 'lab_report' },
    status: 'pending', lab_extraction_status: 'draft_created', created_at: new Date().toISOString(),
  });
  await postWebhook([{
    type: 'postback', replyToken: 'RT-LAB-GUARD',
    postback: { data: 'action=confirm_card&cardId=CARD-LAB-UNREVIEWED' },
    source: { type: 'user', userId: 'U_OWNER' },
  }]);
  const card = await db.PendingCards.findOne((item) => item.card_id === 'CARD-LAB-UNREVIEWED');
  assert.equal(card.status, 'pending');
  const reply = lineClient.getSentLog().find((item) => item.type === 'reply' && item.replyToken === 'RT-LAB-GUARD');
  assert.match(reply.messages[0].text, /หน้าตรวจสอบผล Lab/);
});

test('ส่งรูปในกลุ่มงานศูนย์ ต้องไม่ประมวลผลและไม่ตอบกลับ', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  await centerService.bindGroupToCenter({ centerId: center.center_id, groupId: 'G_CENTER', requesterLineId: 'U_OWNER' });

  await postWebhook([{
    type: 'message', replyToken: 'RT1', message: { type: 'image', mockBase64: 'x' },
    source: { type: 'group', groupId: 'G_CENTER', userId: 'U_STAFF' },
  }]);

  const cards = await db.PendingCards.findAll();
  assert.strictEqual(cards.length, 0, 'รูปในกลุ่มต้องไม่ถูกประมวลผลเลย');
  assert.deepStrictEqual(lineClient.getSentLog().filter((item) => ['reply', 'push'].includes(item.type)), []);
});

test('พนักงานที่ระบบยังไม่รู้จัก ส่งรูปส่วนตัว ต้องได้คำแนะนำให้ทักในกลุ่มก่อน', async () => {
  await postWebhook([{
    type: 'message', replyToken: 'RT1', message: { type: 'image', mockBase64: 'x' },
    source: { type: 'user', userId: 'U_UNKNOWN_STAFF' },
  }]);
  const reply = lineClient.getSentLog().find((x) => x.type === 'reply');
  assert.ok(reply.messages[0].text.includes('กลุ่มงานศูนย์'));
  const cards = await db.PendingCards.findAll();
  assert.strictEqual(cards.length, 0);
});

test('กลุ่มที่ไม่ได้ผูกกับศูนย์ใด ทักข้อความมา ต้องไม่บันทึกเป็นพนักงาน', async () => {
  await postWebhook([{
    type: 'message', replyToken: 'RT1', message: { type: 'text', text: 'สวัสดี' },
    source: { type: 'group', groupId: 'G_UNKNOWN', userId: 'U_RANDOM' },
  }]);
  const staff = await db.CenterStaff.findOne((x) => x.line_user_id === 'U_RANDOM');
  assert.strictEqual(staff, null, 'กลุ่มที่ไม่ผูกกับศูนย์ใด ต้องไม่บันทึกใครเป็นพนักงาน');
});

test('เชิญบอทเข้ากลุ่มอย่างเดียวยังไม่ผูก ต้องใช้รหัสระบุประเภทกลุ่ม', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  await postWebhook([{ type: 'join', source: { type: 'group', groupId: 'G_NEW', userId: 'U_OWNER' } }]);

  const updated = await db.Centers.findOne((c) => c.center_id === center.center_id);
  assert.strictEqual(updated.group_id, null);
  const prompt = lineClient.getSentLog().find((x) => x.type === 'push' && x.to === 'G_NEW');
  assert.ok(prompt.messages[0].text.includes('STAFF-'));
  assert.ok(prompt.messages[0].text.includes('FAMILY-'));
  assert.ok(prompt.messages[0].text.includes('CGROUP-'));
  assert.match(prompt.retryKey, /^[0-9a-f-]{36}$/);
  assert.strictEqual(lineClient.getSentLog().filter((item) => item.type === 'reply').length, 0);
});

test('CGROUP message binds the canonical Family destination and returns no internal IDs', async () => {
  const center = await centerService.createCenter({ name:'ศูนย์ทดสอบ', ownerLineId:'U-OWNER' });
  await db.CareProfiles.insert({ care_profile_id:'CP-CGROUP', owner_line_id:null,
    patient_name:'คุณสมใจ', center_id:center.center_id, status:'linked', managed_by_center:true });
  await db.Residents.insert({ resident_id:'R-CGROUP', center_id:center.center_id, full_name:'คุณสมใจ',
    care_profile_id:'CP-CGROUP', status:'active', link_status:'center_managed' });
  const token = await require('../backend/services/groupBindingService').createCenterFamilyBindingToken({
    centerId:center.center_id, residentId:'R-CGROUP', requesterLineId:'U-OWNER',
  });
  lineClient.clearSentLog();
  await postWebhook([{
    webhookEventId:'EVT-CGROUP', type:'message', replyToken:'RT-CGROUP',
    message:{ type:'text', text:token.code },
    source:{ type:'group', groupId:'G-CGROUP', userId:'U-FAMILY-MEMBER' },
  }]);
  const binding = await db.GroupBindings.findOne((item) => item.care_profile_id === 'CP-CGROUP');
  assert.equal(binding.kind, 'family');
  assert.equal(binding.line_group_id, 'G-CGROUP');
  const reply = lineClient.getSentLog().find((item) => item.type === 'reply');
  assert.equal(reply.messages[0].text, '✅ เชื่อมกลุ่มนี้กับ Care Profile เรียบร้อยแล้ว');
  assert.doesNotMatch(reply.messages[0].text, /CP-CGROUP|R-CGROUP|G-CGROUP|CTR-/);
});

test('ข้อ N4 (แก้ไขแล้ว): Care Profile อิสระส่งรูปแบบ 1-1 ต้องได้ข้อความสุภาพที่เสนอทางเลือก ไม่ใช่ข้อความปฏิเสธทั่วไป', async () => {
  const familyService = require('../backend/services/familyService');
  await familyService.createIndependentProfile({ ownerLineId: 'U_INDEPENDENT', patientName: 'คุณยายทองดี' });

  await postWebhook([{
    type: 'message', replyToken: 'RT1', message: { type: 'image', mockBase64: 'x' },
    source: { type: 'user', userId: 'U_INDEPENDENT' },
  }]);

  const reply = lineClient.getSentLog().find((s) => s.type === 'reply');
  assert.strictEqual(reply.messages[0].text, familyService.AI_RESTRICTED_MESSAGE);
  assert.ok(reply.messages[0].text.includes('บันทึกนัดด้วยการพิมพ์ได้เลย'), 'ต้องเสนอทางเลือกที่ใช้ได้ ไม่ใช่แค่บอกว่าทำไม่ได้');
});

test('ข้อ N4: ผู้ใช้ที่ไม่มี Care Profile เลย ส่งรูปแบบ 1-1 ยังได้ข้อความทั่วไปตามเดิม', async () => {
  await postWebhook([{
    type: 'message', replyToken: 'RT1', message: { type: 'image', mockBase64: 'x' },
    source: { type: 'user', userId: 'U_UNKNOWN' },
  }]);
  const reply = lineClient.getSentLog().find((s) => s.type === 'reply');
  assert.ok(reply.messages[0].text.includes('กลุ่มงานศูนย์'));
});

test('ข้อ N4: ครอบครัวที่ผูกกับศูนย์แล้ว (linked) ส่งรูปแบบ 1-1 ไม่ควรได้ข้อความปฏิเสธ AI แบบผู้ใช้อิสระ', async () => {
  const familyService = require('../backend/services/familyService');
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  await db.CareProfiles.insert({ care_profile_id: 'CP-1', owner_line_id: 'U_LINKED', patient_name: 'สมศรี', center_id: center.center_id, status: 'linked' });

  await postWebhook([{
    type: 'message', replyToken: 'RT1', message: { type: 'image', mockBase64: 'x' },
    source: { type: 'user', userId: 'U_LINKED' },
  }]);
  const reply = lineClient.getSentLog().find((s) => s.type === 'reply');
  assert.notStrictEqual(reply.messages[0].text, familyService.AI_RESTRICTED_MESSAGE, 'ผู้ใช้ linked ไม่ใช่กรณีที่ N4 พูดถึง ควรได้ข้อความทั่วไปแทน');
});

test('ข้อ C5: ส่งรูปเกินอัตราที่กำหนดในหนึ่งนาที ต้องถูกปฏิเสธและแจ้งให้รอ', async () => {
  const rateLimiter = require('../backend/utils/rateLimiter');
  rateLimiter.reset();

  const center = await centerService.createCenter({ name: 'ศูนย์จำกัดอัตรา', ownerLineId: 'U_OWNER' });
  await centerService.bindGroupToCenter({ centerId: center.center_id, groupId: 'G_RATE', requesterLineId: 'U_OWNER' });

  // ลงทะเบียนพนักงานก่อน (ทักในกลุ่มหนึ่งครั้ง)
  await postWebhook([{
    type: 'message', replyToken: 'RT0', message: { type: 'text', text: 'สวัสดี' },
    source: { type: 'group', groupId: 'G_RATE', userId: 'U_RATE_STAFF' },
  }]);

  // ค่าเริ่มต้น 5 ครั้ง/นาที/ผู้ใช้ — ยิง 5 ครั้งแรกต้องผ่าน
  for (let i = 0; i < 5; i++) {
    aiProvider.queueMockResponse({ documentType: 'unrelated', unrelatedNote: 'ทดสอบ' });
    await postWebhook([{
      type: 'message', replyToken: `RT${i}`, message: { type: 'image', mockBase64: 'x' },
      source: { type: 'user', userId: 'U_RATE_STAFF' },
    }]);
  }

  lineClient.clearSentLog();
  aiProvider.queueMockResponse({ documentType: 'unrelated', unrelatedNote: 'ทดสอบ' });
  await postWebhook([{
    type: 'message', replyToken: 'RT6', message: { type: 'image', mockBase64: 'x' },
    source: { type: 'user', userId: 'U_RATE_STAFF' },
  }]);

  const replies = lineClient.getSentLog().filter((s) => s.type === 'reply');
  assert.ok(replies[0].messages[0].text.includes('ถี่เกินไป'), 'ครั้งที่เกินโควต้าต้องได้รับข้อความแจ้งให้รอ');

  rateLimiter.reset();
});

test('ข้อ B8: พิมพ์ข้อความที่ดูเหมือนคำสั่งจัดการผู้พัก ต้องไม่มีผลใดๆ ต่อทะเบียนผู้พักเลย', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U_OWNER' });
  await centerService.bindGroupToCenter({ centerId: center.center_id, groupId: 'G_TEXT', requesterLineId: 'U_OWNER' });
  await centerService.addResident({ centerId: center.center_id, fullName: 'สมศรี ใจดี' });

  const suspiciousCommands = [
    'เพิ่มผู้พัก สมชาย ใจดี ห้อง 105',
    'ลบผู้พัก สมศรี ใจดี',
    'แก้ไขชื่อ สมศรี เป็น สมหญิง',
    'จำหน่ายผู้พัก R-1',
    '/add resident สมปอง',
  ];

  for (const text of suspiciousCommands) {
    const res = await postWebhook([{
      type: 'message', replyToken: 'RT-TXT', message: { type: 'text', text },
      source: { type: 'group', groupId: 'G_TEXT' },
    }]);
    assert.strictEqual(res.status, 200, `Server ต้องไม่ error แม้ได้รับข้อความ: "${text}"`);
  }

  const residents = await centerService.listResidents(center.center_id);
  assert.strictEqual(residents.length, 1, 'ทะเบียนผู้พักต้องมีแค่คนเดียวเท่าเดิม ไม่มีใครถูกเพิ่ม/ลบ/แก้ผ่านข้อความพิมพ์เลย');
  assert.strictEqual(residents[0].full_name, 'สมศรี ใจดี', 'ชื่อต้องไม่ถูกแก้ไขผ่านข้อความพิมพ์');
});
