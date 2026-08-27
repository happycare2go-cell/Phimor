const { randomUUID } = require('crypto');
const { NotificationOutbox, id, now, withTransaction } = require('../db');
const lineClient = require('../providers/lineClient');

const MAX_ATTEMPTS = 5;
const DELIVERY_LEASE_MS = 2 * 60 * 1000;
const PROVIDER_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

function safeProviderRequestId(value) {
  const clean = String(value || '').trim();
  return /^[A-Za-z0-9._:-]{1,160}$/.test(clean) ? clean : null;
}

function createNotificationService(overrides = {}) {
  const outbox = overrides.NotificationOutbox || NotificationOutbox;
  const line = overrides.lineClient || lineClient;
  const idFactory = overrides.idFactory || id;
  const retryKeyFactory = overrides.retryKeyFactory || randomUUID;
  const clock = overrides.now || now;
  const transact = overrides.withTransaction || withTransaction;

  async function enqueue({ dedupeKey, to, messages, kind, meta = {} }) {
    if (!to) return { ok:false, reason:'missing_recipient' };
    return transact(`notification-enqueue:${dedupeKey || idFactory('UNKEYED')}`, async () => {
      const existing = dedupeKey && await outbox.findOne((item) => item.dedupe_key === dedupeKey);
      if (existing) return { ok:true, notification:existing, duplicate:true };
      const createdAt = clock();
      const notification = await outbox.insert({
        notification_id:idFactory('NTF'), dedupe_key:dedupeKey || null, to, messages,
        kind:kind || 'line_push', meta, status:'pending', attempts:0,
        created_at:createdAt, next_attempt_at:createdAt, sent_at:null, last_error:null,
        delivery_lease_until:null, provider_retry_key:retryKeyFactory(),
        provider_retry_key_created_at:createdAt, provider_first_attempt_at:null,
        provider_request_id:null, provider_acceptance:null,
      });
      return { ok:true, notification };
    });
  }

  async function deliver(notification) {
    if (!notification?.notification_id) return { ok:false, reason:'missing_notification' };
    const lockKey = `notification-delivery:${notification.notification_id}`;
    const claim = await transact(lockKey, async () => {
      const current = await outbox.findOne((item) => item.notification_id === notification.notification_id);
      if (!current || current.status === 'sent' || current.status === 'dead_letter') return { terminal:true, current };
      const currentTime = new Date(clock()).getTime();
      if (current.status === 'sending' && new Date(current.delivery_lease_until || 0).getTime() > currentTime) {
        return { inProgress:true, current };
      }
      const firstAttemptAt = current.provider_first_attempt_at || new Date(currentTime).toISOString();
      if (current.provider_first_attempt_at
        && currentTime - new Date(current.provider_first_attempt_at).getTime() >= PROVIDER_RETRY_WINDOW_MS) {
        const expired = await outbox.update((item) => item.notification_id === current.notification_id, {
          status:'dead_letter', last_error:'LINE_RETRY_WINDOW_EXPIRED', next_attempt_at:null,
          delivery_lease_until:null,
        });
        return { terminal:true, current:expired, retryWindowExpired:true };
      }
      const providerRetryKey = current.provider_retry_key || retryKeyFactory();
      const claimed = await outbox.update((item) => item.notification_id === notification.notification_id, {
        status:'sending', delivery_lease_until:new Date(currentTime + DELIVERY_LEASE_MS).toISOString(),
        provider_retry_key:providerRetryKey,
        provider_retry_key_created_at:current.provider_retry_key_created_at || new Date(currentTime).toISOString(),
        provider_first_attempt_at:firstAttemptAt,
      });
      return { claimed };
    });
    if (claim.terminal) {
      if (claim.retryWindowExpired) {
        return { ok:false, notification:claim.current, retryWindowExpired:true,
          reason:'retry_window_expired' };
      }
      return { ok:true, notification:claim.current, duplicate:true,
      };
    }
    if (claim.inProgress) return { ok:true, notification:claim.current, duplicate:true, inProgress:true };
    const claimed = claim.claimed;
    try {
      const provider = await line.pushMessage(claimed.to, claimed.messages, { retryKey:claimed.provider_retry_key });
      const acceptedByConflict = provider?.retryKeyConflict === true;
      const updated = await transact(lockKey, () => outbox.update(
        (item) => item.notification_id === claimed.notification_id,
        {
          status:'sent', sent_at:clock(), attempts:Number(claimed.attempts || 0) + 1,
          last_error:null, next_attempt_at:null, delivery_lease_until:null,
          provider_acceptance:acceptedByConflict ? 'retry_key_already_accepted' : 'accepted',
          provider_request_id:safeProviderRequestId(provider?.providerRequestId),
        },
      ));
      return { ok:true, notification:updated, providerAccepted:acceptedByConflict };
    } catch (_error) {
      const attempts = Number(claimed.attempts || 0) + 1;
      const terminal = attempts >= MAX_ATTEMPTS;
      const retryMinutes = Math.min(60, 2 ** attempts);
      const updated = await transact(lockKey, () => outbox.update(
        (item) => item.notification_id === claimed.notification_id,
        {
          status:terminal ? 'dead_letter' : 'retrying', attempts,
          last_error:'LINE_DELIVERY_FAILED',
          next_attempt_at:terminal ? null
            : new Date(new Date(clock()).getTime() + retryMinutes * 60000).toISOString(),
          delivery_lease_until:null,
        },
      ));
      return { ok:false, notification:updated, reason:'delivery_failed' };
    }
  }

  async function enqueueAndDeliver(input) {
    const queued = await enqueue(input);
    if (!queued.ok || queued.duplicate) return queued;
    return deliver(queued.notification);
  }

  async function processPending(limit = 50) {
    const currentTime = new Date(clock()).getTime();
    const due = await outbox.findWhere((item) => (
      ['pending', 'retrying'].includes(item.status)
        && new Date(item.next_attempt_at || 0).getTime() <= currentTime
    ) || (item.status === 'sending'
      && new Date(item.delivery_lease_until || 0).getTime() <= currentTime));
    let sent = 0; let failed = 0;
    for (const notification of due.slice(0, limit)) {
      const result = await deliver(notification);
      if (result.ok && !result.inProgress) sent += 1;
      else if (!result.ok) failed += 1;
    }
    return { processed:sent + failed, sent, failed };
  }

  async function getHealth() {
    const rows = await outbox.findWhere((item) => ['pending', 'retrying', 'sending', 'dead_letter'].includes(item.status));
    const deadLetters = rows.filter((item) => item.status === 'dead_letter').length;
    const oldest = rows.map((item) => new Date(item.created_at).getTime()).filter(Number.isFinite).sort()[0] || null;
    return { pending:rows.length - deadLetters, deadLetters,
      oldestPendingAt:oldest ? new Date(oldest).toISOString() : null };
  }

  return { enqueue, deliver, enqueueAndDeliver, processPending, getHealth };
}

const notificationService = createNotificationService();
module.exports = {
  ...notificationService, createNotificationService, MAX_ATTEMPTS,
  DELIVERY_LEASE_MS, PROVIDER_RETRY_WINDOW_MS,
};
