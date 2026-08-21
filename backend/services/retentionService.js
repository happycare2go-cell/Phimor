const { PendingCards, MedicationSnapshots, audit, now } = require('../db');

async function purgeExpiredSourceImages(referenceDate = new Date()) {
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
  if (cards.length || snapshots.length) await audit('privacy.source_images_purged', 'system', { cards:cards.length, medicationSnapshots:snapshots.length, retentionDays:days });
  return { cards:cards.length, medicationSnapshots:snapshots.length };
}

module.exports = { purgeExpiredSourceImages };
