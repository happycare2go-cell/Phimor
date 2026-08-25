process.env.NODE_ENV = 'test';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../backend/db');
const aiProvider = require('../backend/providers/aiProvider');
const lineClient = require('../backend/providers/lineClient');
const centerService = require('../backend/services/centerService');
const webhook = require('../backend/routes/webhook');

beforeEach(() => {
  db.resetAll();
  aiProvider.clearMockQueue();
  lineClient.clearSentLog();
});

function textEvent(text, overrides = {}) {
  return {
    type: 'message',
    replyToken: 'REPLY-1',
    message: { type: 'text', text },
    source: { type: 'user', userId: 'U-SENDER-EXACT' },
    ...overrides,
  };
}

test('user_id matches exact text case-insensitively after trimming', () => {
  for (const value of ['user_id', 'USER_ID', '  user_id  ']) {
    assert.equal(webhook.isUserIdCommand(textEvent(value)), true);
  }
});

test('similar and partial text never triggers the command', () => {
  for (const value of ['id', 'userid', 'user id', 'user_id 123', 'get user_id', 'my user_id', 'identity', 'medication_id']) {
    assert.equal(webhook.isUserIdCommand(textEvent(value)), false, value);
  }
  assert.equal(webhook.isUserIdCommand({ type: 'message', message: { type: 'image' } }), false);
});

test('reply contains only the userId from the sender of that exact event', async () => {
  const handled = await webhook.handleUserIdCommand(textEvent('user_id', {
    source: { type: 'user', userId: 'U-FROM-EVENT' },
    targetUserId: 'U-UNTRUSTED',
  }));
  assert.equal(handled, true);
  assert.deepEqual(lineClient.getSentLog(), [{
    type: 'reply',
    replyToken: 'REPLY-1',
    messages: [{ type: 'text', text: 'LINE User ID:\nU-FROM-EVENT' }],
  }]);
});

test('missing source.userId replies safely and does not fabricate an ID', async () => {
  await webhook.handleUserIdCommand(textEvent('user_id', { source: { type: 'user' } }));
  assert.equal(lineClient.getSentLog()[0].messages[0].text, 'ไม่พบ LINE User ID ของบัญชีนี้');
});

test('missing reply token is handled without crashing or alternate disclosure', async () => {
  const event = textEvent('user_id');
  delete event.replyToken;
  assert.equal(await webhook.handleUserIdCommand(event), true);
  assert.deepEqual(lineClient.getSentLog(), []);
});

test('command exits before AI, staff capture, and all business database writes', async () => {
  let aiCalls = 0;
  aiProvider.setProviderForTests({ generateStructured: async () => { aiCalls += 1; return {}; } });
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U-OWNER' });
  await centerService.bindGroupToCenter({ centerId: center.center_id, groupId: 'G-CENTER', requesterLineId: 'U-OWNER' });
  const countsBefore = {
    centers: (await db.Centers.findAll()).length,
    staff: (await db.CenterStaff.findAll()).length,
    profiles: (await db.CareProfiles.findAll()).length,
    cards: (await db.PendingCards.findAll()).length,
    audit: (await db.AuditLog.findAll()).length,
    inbox: (await db.WebhookInbox.findAll()).length,
  };

  await webhook.processEvent(textEvent(' user_id ', {
    source: { type: 'group', groupId: 'G-CENTER', userId: 'U-COMMAND-SENDER' },
  }));

  assert.deepEqual({
    centers: (await db.Centers.findAll()).length,
    staff: (await db.CenterStaff.findAll()).length,
    profiles: (await db.CareProfiles.findAll()).length,
    cards: (await db.PendingCards.findAll()).length,
    audit: (await db.AuditLog.findAll()).length,
    inbox: (await db.WebhookInbox.findAll()).length,
  }, countsBefore);
  assert.equal(aiCalls, 0);
});

test('unrelated normal text continues through the existing group handling path', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ทดสอบ', ownerLineId: 'U-OWNER' });
  await centerService.bindGroupToCenter({ centerId: center.center_id, groupId: 'G-CENTER', requesterLineId: 'U-OWNER' });

  await webhook.processEvent(textEvent('สวัสดี', {
    source: { type: 'group', groupId: 'G-CENTER', userId: 'U-NORMAL-TEXT' },
  }));

  const staff = await db.CenterStaff.findOne((row) => row.line_user_id === 'U-NORMAL-TEXT');
  assert.equal(staff?.role, 'staff');
  assert.deepEqual(lineClient.getSentLog().filter((entry) => entry.type === 'reply'), []);
});
