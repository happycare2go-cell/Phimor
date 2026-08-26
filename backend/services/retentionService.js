const { PendingCards, MedicationSnapshots, audit, now } = require('../db');
const { createLabRepository } = require('./labRepository');

async function purgeExpiredSourceImages(referenceDate = new Date(), overrides = {}) {
  const days = Math.max(7, Number(process.env.MEDICAL_IMAGE_RETENTION_DAYS || 90));
  const cutoff = referenceDate.getTime() - days * 86400000;
  const cards = await PendingCards.updateAll(
    (c) => !!c.image_base64 && new Date(c.confirmed_at || c.created_at).getTime() < cutoff,
    { image_base64:null, source_image_purged_at:now(), source_image_retention_days:days }
  );
  const snapshots = await MedicationSnapshots.updateAll(
    (s) => !!s.source_image_base64 && new Date(s.recorded_at).getTime() < cutoff,
    { source_image_base64:null, source_image_purged_at:now(), source_image_retention_days:days }
  );
  const markLabSourcePurged = overrides.markLabSourcePurged
    || ((pendingCardId, purgedAt) => createLabRepository().markPendingCardSourcePurged(pendingCardId, purgedAt));
  for (const card of cards) {
    try {
      await markLabSourcePurged(card.card_id, card.source_image_purged_at);
    } catch (_) {
      // Structured Lab data is independent of source-image deletion. Emit only
      // a safe operational code; never log card contents or Lab values.
      if (typeof overrides.logger === 'function') {
        overrides.logger({ event: 'lab_source_purge_status_failed', errorCode: 'LAB_SOURCE_STATUS_WRITE_FAILED' });
      }
    }
  }
  if (cards.length || snapshots.length) await audit('privacy.source_images_purged', 'system', { cards:cards.length, medicationSnapshots:snapshots.length, retentionDays:days });
  return { cards:cards.length, medicationSnapshots:snapshots.length };
}

module.exports = { purgeExpiredSourceImages };
