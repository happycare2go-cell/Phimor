const { PendingFamilyDeliveries, CareProfiles, GroupBindings, id, now } = require('../db');

async function queueForResident({ residentId, cardId, messages }) {
  const existing = await PendingFamilyDeliveries.findOne((d) => d.card_id === cardId);
  if (existing) return existing;
  return PendingFamilyDeliveries.insert({ delivery_id:id('PFD'), resident_id:residentId, card_id:cardId, messages, status:'waiting_profile', created_at:now() });
}

async function deliverPendingForResident(residentId, careProfileId) {
  const profile = await CareProfiles.findOne((p) => p.care_profile_id === careProfileId);
  if (!profile) return { delivered:0 };
  const binding = await GroupBindings.findOne((g) => g.care_profile_id === careProfileId && g.kind === 'family' && g.status !== 'inactive');
  const target = binding?.line_group_id || profile.owner_line_id;
  if (!target) return { delivered:0 };
  const waiting = await PendingFamilyDeliveries.findWhere((d) => d.resident_id === residentId && d.status === 'waiting_profile');
  let delivered = 0;
  for (const item of waiting) {
    await require('./notificationService').enqueueAndDeliver({ dedupeKey:`pending-family-card:${item.card_id}:${target}`, to:target, kind:'delayed_family_card', meta:{residentId,careProfileId,cardId:item.card_id}, messages:item.messages });
    await PendingFamilyDeliveries.update((d) => d.delivery_id === item.delivery_id, { status:'sent', target, sent_at:now(), care_profile_id:careProfileId });
    delivered += 1;
  }
  return { delivered };
}

module.exports = { queueForResident, deliverPendingForResident };
