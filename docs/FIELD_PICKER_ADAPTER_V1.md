# PHIMOR Field Picker Adapter V1

Field Picker Adapter V1 lets a commissioned Integration Client send one native
sample for `care.daily_report.finalized`. The sample is captured only after the
normal Integration credential and rate-limit gates. Capture returns
`sample_captured`; it does not run identity learning, create clinical records,
enqueue notifications, or contact LINE.

System Admin uses **ระบบเชื่อมต่อ → Integration Client detail → การจับคู่ข้อมูล**.
The screen is PHIMOR-field-first: the operator selects sample values, while the
server stores deterministic source locators rather than sample literals. Runtime
never uses AI or heuristic remapping. Unmapped fields are ignored.

Samples are bounded to 256 KiB, eight nesting levels, 250 discovered fields, and
20 items per array. Secret-like values are irreversibly cleared before storage.
The capture window is 30 minutes and a captured sample expires after at most 24
hours. Activation clears the stored sample payload immediately. Audit events keep
only client, adapter, version, size, count, and timestamps—not sample values.

An active adapter transforms only mapped fields before the existing strict
`normalizeEnvelope()` gate. Canonical clients without an adapter are unchanged.
The generated `schemaVersion` is `1.0`; `eventType` comes from the adapter; and
`occurredAt` equals confirmed `finalizedAt`. If no source event ID is mapped, a
stable ID is derived from Integration Client, target event type, and
`externalRecordId`, preserving retries and idempotency.

Array mappings use stable discriminator selection such as `type=temperature`.
Arrays without a unique stable discriminator cannot be selected. If a required
locator disappears, changes type, or has an unsupported unit, processing fails
closed as `ADAPTER_SOURCE_CHANGED`; no alternative field is guessed and no
clinical write occurs.

Active versions are immutable. Editing begins with a new sample and Draft V2;
V1 remains active until V2 passes preview and activation. Activation supersedes
the previous version atomically and never changes already processed clinical data.

## Controlled rollout

1. Hold Auto-Deploy and verify a current database backup.
2. Run `npm run migrate:status` from `backend`.
3. Run the SELECT-only `npm run preflight:integration-adapter-v1`.
4. Require `RESULT: SAFE_TO_MIGRATE`.
5. Apply migration 0017 with `npm run migrate`; do not deploy code first.
6. Re-run `npm run migrate:status` and require no pending/checksum mismatch.
7. Deploy backend, verify `/health` and `/ready`, then deploy System Admin LIFF.
8. Capture only fictional or approved commissioning data first, preview, activate,
   and run one controlled end-to-end event before releasing the sender backlog.

No Production migration or external call is performed by repository tests.
