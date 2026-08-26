const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const db = require('../backend/db');
const { purgeExpiredSourceImages } = require('../backend/services/retentionService');

test('existing image retention purges Pending Card bytes and marks Lab source provenance without clinical payload', async () => {
  db.resetAll();
  await db.PendingCards.insert({
    card_id: 'CARD-LAB-1', document_subtype: 'lab_report', image_base64: 'PRIVATE_BASE64',
    created_at: '2025-01-01T00:00:00.000Z', confirmed_at: '2025-01-02T00:00:00.000Z',
  });
  const updates = [];
  const result = await purgeExpiredSourceImages(new Date('2026-08-26T00:00:00.000Z'), {
    markLabSourcePurged: async (cardId, purgedAt) => { updates.push({ cardId, purgedAt }); },
  });
  assert.equal(result.cards, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].cardId, 'CARD-LAB-1');
  const card = await db.PendingCards.findOne((item) => item.card_id === 'CARD-LAB-1');
  assert.equal(card.image_base64, null);
  assert.ok(card.source_image_purged_at);
});

test('Lab source-status failure never restores or extends expired image retention', async () => {
  db.resetAll();
  await db.PendingCards.insert({
    card_id: 'CARD-LAB-2', document_subtype: 'lab_report', image_base64: 'PRIVATE_BASE64',
    created_at: '2025-01-01T00:00:00.000Z',
  });
  const logs = [];
  await purgeExpiredSourceImages(new Date('2026-08-26T00:00:00.000Z'), {
    markLabSourcePurged: async () => { throw new Error('database detail'); },
    logger: (event) => logs.push(event),
  });
  const card = await db.PendingCards.findOne((item) => item.card_id === 'CARD-LAB-2');
  assert.equal(card.image_base64, null);
  assert.deepEqual(logs, [{ event: 'lab_source_purge_status_failed', errorCode: 'LAB_SOURCE_STATUS_WRITE_FAILED' }]);
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_BASE64|database detail/);
});
