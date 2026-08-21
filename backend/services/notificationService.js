const { NotificationOutbox, id, now } = require('../db');
const lineClient = require('../providers/lineClient');

async function enqueue({ dedupeKey, to, messages, kind, meta = {} }) {
  if (!to) return { ok: false, reason: 'missing_recipient' };
  const existing = dedupeKey && await NotificationOutbox.findOne((n) => n.dedupe_key === dedupeKey);
  if (existing) return { ok: true, notification: existing, duplicate: true };
  const notification = await NotificationOutbox.insert({
    notification_id: id('NTF'), dedupe_key: dedupeKey || null, to, messages,
    kind: kind || 'line_push', meta, status: 'pending', attempts: 0,
    created_at: now(), next_attempt_at: now(), sent_at: null, last_error: null,
  });
  return { ok: true, notification };
}

async function deliver(notification) {
  if (!notification || notification.status === 'sent') return { ok: true, duplicate: true };
  try {
    await lineClient.pushMessage(notification.to, notification.messages);
    const updated = await NotificationOutbox.update(
      (n) => n.notification_id === notification.notification_id,
      { status: 'sent', sent_at: now(), attempts: Number(notification.attempts || 0) + 1, last_error: null }
    );
    return { ok: true, notification: updated };
  } catch (error) {
    const attempts = Number(notification.attempts || 0) + 1;
    const terminal = attempts >= 5;
    const retryMinutes = Math.min(60, 2 ** attempts);
    const updated = await NotificationOutbox.update(
      (n) => n.notification_id === notification.notification_id,
      {
        status: terminal ? 'dead_letter' : 'retrying', attempts,
        last_error: String(error.message || error).slice(0, 500),
        next_attempt_at: new Date(Date.now() + retryMinutes * 60000).toISOString(),
      }
    );
    return { ok: false, notification: updated, reason: 'delivery_failed' };
  }
}

async function enqueueAndDeliver(input) {
  const queued = await enqueue(input);
  if (!queued.ok || queued.duplicate) return queued;
  return deliver(queued.notification);
}

async function processPending(limit = 50) {
  const due = await NotificationOutbox.findWhere((n) =>
    ['pending', 'retrying'].includes(n.status) && new Date(n.next_attempt_at || 0).getTime() <= Date.now()
  );
  let sent = 0; let failed = 0;
  for (const notification of due.slice(0, limit)) {
    const result = await deliver(notification);
    if (result.ok) sent += 1; else failed += 1;
  }
  return { processed: sent + failed, sent, failed };
}

async function getHealth() {
  const rows = await NotificationOutbox.findWhere((n) => ['pending', 'retrying', 'dead_letter'].includes(n.status));
  const deadLetters = rows.filter((n) => n.status === 'dead_letter').length;
  const oldest = rows.map((n) => new Date(n.created_at).getTime()).filter(Number.isFinite).sort()[0] || null;
  return { pending: rows.length - deadLetters, deadLetters, oldestPendingAt: oldest ? new Date(oldest).toISOString() : null };
}

module.exports = { enqueue, deliver, enqueueAndDeliver, processPending, getHealth };

