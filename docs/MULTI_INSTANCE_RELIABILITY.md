# Multi-instance reliability V1

This document describes runtime ownership and recovery. It contains no clinical payloads or credentials.

## Scheduled work

Every registered job is executed through `schedulerCoordinatorService`. Each backend instance has one bounded local execution lane, so only one job at a time may acquire a scheduler advisory-lock client and execute its task. A job already running or queued is not enqueued again. The queue is therefore bounded by the fixed, code-owned job registry, and one failed job cannot poison the lane.

After entering the local lane, each job uses its distinct PostgreSQL session advisory-lock key for cross-instance ownership. A backend that cannot acquire the job lock records `skipped_due_to_lock` and does no work; it does not make `/ready` fail. The same connection acquires and releases the lock in `finally`, and PostgreSQL releases it automatically if that connection dies. Consultation lifecycle business work deliberately has no second scheduler-level lock because the coordinator is the single ownership boundary.

The PostgreSQL pool keeps the existing small-deployment capacity explicit (`DATABASE_POOL_MAX=10`) and uses a bounded acquisition timeout (`DATABASE_POOL_CONNECTION_TIMEOUT_MS=2000`). The Consultation Realtime `LISTEN` session remains intentionally checked out. With one local scheduler lane, a scheduler burst reserves at most one additional lock client before its business task requests database capacity, leaving capacity for interactive traffic. These values may be overridden only within the documented safe bounds; increasing the pool is not the starvation fix.

The scheduler diagnostic returned by `/ready` includes only job name, timestamps, status, duration, lane counts, and a safe error code. Database pool diagnostics contain only `totalCount`, `idleCount`, `waitingCount`, and `configuredMax`. `/ready` has a bounded dependency-check budget (`READINESS_TIMEOUT_MS=2500`) and returns `503 not_ready` with a safe code when capacity is unavailable instead of hanging. It never includes connection strings, SQL, notification bodies, or clinical payloads. System Admin can read the scheduler summary together with notification and integration queue counts from `GET /api/admin/operations/reliability`.

| Job | Ownership / delivery boundary |
| --- | --- |
| Card expiry, Center staff reconciliation, source-image retention | One job-scoped advisory-lock owner |
| Pending-card and subscription reminders | Job lock plus notification outbox dedupe |
| Appointment reminders and Center summaries | Job lock plus recipient/date-specific outbox intents |
| Transport reminder stages | Job lock, atomic per-plan stage claim, and recipient/stage outbox dedupe |
| Notification retry | Job lock; individual outbox rows retain their existing claim lease and stable LINE retry key |
| LINE webhook inbox | Job lock; individual inbox rows retain event dedupe, claim ownership, and lease recovery |
| Integration inbox | Job lock; relational event claims and the pending-subject contract are unchanged |
| Consultation payment/lifecycle | Job lock plus the existing consultation lifecycle advisory lock and database idempotency |

## Shared rate limiting

Migration `0014_create_shared_rate_limit_windows.js` adds a bounded, indexed fixed-window store. Production request paths use atomic PostgreSQL upserts. Only a SHA-256 key hash, domain, window timestamps, and count are stored; raw LINE identities, IP addresses, bearer credentials, and secrets are not stored in the rate-limit table.

The domains remain separate: generic API, System Admin, integration edge, authenticated Integration Client, LINE image ingestion, Consultation, Plus, Lab explanation, Doctor Questions, and Doctor Visit AI. Expired rows are removed in bounded batches by a job-scoped cleanup task. A rate-limit database error fails closed with a safe 503 response; it never silently disables protection.

Migration 0014 must be applied before deploying code that uses the shared limiter. Application startup does not run migrations.

## Remaining boundaries

- The realtime gateway keeps process-local socket membership and a short duplicate-event cache by design; PostgreSQL LISTEN/NOTIFY supplies cross-instance signaling and REST sequence recovery remains authoritative.
- Existing synchronous, user-triggered LINE pushes are outside scheduled-job ownership. This V1 moves only scheduled reminder/summary delivery to the durable outbox.
- Advisory locks prevent simultaneous logical job runs. Per-record claims and outbox dedupe remain required and are intentionally retained for crash recovery.
