# Generic Integration commissioning

This runbook is for any compatible external care system. HHS is the first
pilot example; the PHIMOR Integration Client, scope, credential, and exact
mapping model is vendor-neutral.

## System Admin path

Open **System Admin LIFF → ศูนย์และระบบเชื่อมต่อ → ระบบเชื่อมต่อ**. Normal
commissioning uses an active LINE-authenticated System Admin. The Admin API key
remains a controlled bootstrap/break-glass mechanism, not a Center role.

## Commissioning sequence

1. Select **+ เพิ่มระบบเชื่อมต่อ** and choose the active Organization. Enter a
   unique client code, display name, and source-system name. A UI-created client
   starts **suspended**.
2. Open **จัดการระบบเชื่อมต่อ** and add only the intended Center scopes.
3. Add only the needed event scopes. PHIMOR currently supports
   `care.daily_report.finalized` and `care.vitals.recorded`. Linked Vital data in
   a finalized Daily event does not require the standalone Vital scope.
4. Choose **ออก Credential**. Copy the one-time value to the approved external
   server-side secret manager, then close the modal. The secret cannot be opened
   again and must never be placed in browser storage, Git, logs, ordinary LINE
   chat, or an external-system browser/LIFF.
5. Under **การระบุตัวตนอัตโนมัติ**, select one server-authoritative policy.
   Existing clients default to `manual_mapping_only` +
   `pending_subject_mapping` + `optional_for_ingest`; this preserves legacy
   behavior. A commissioned-only client may use `exact_name_learning` +
   `ignore` + `required_before_ingest`.
6. Exact-name learning uses only normalized first name + last name. PHIMOR does
   not use room, phone, alias, transliteration, fuzzy similarity, or AI. One
   exact eligible candidate learns both external Center and Resident IDs. The
   learned IDs become authoritative for later events even if display text
   changes.
7. Manual Center/Resident mapping remains under **ขั้นสูง / แก้ไขข้อยกเว้น**.
   It is required for manual-only clients, corrections, and cases where an
   exact automatic match is not safe.
8. If Family notifications are required, verify the normal PHIMOR Family
   GroupBinding. An external expected LINE group ID is reconciliation metadata,
   never routing authority.
9. Review **ความพร้อมใช้งาน**, then explicitly choose **เปิดใช้งาน**. The
   checklist is informational; backend status, scopes, mappings, capabilities,
   and credential validation remain authoritative.
10. Send one controlled event from a test or approved external server. Verify the
   integration inbox, canonical record, and intended notification projection.
11. Replay the identical event ID and payload. It must converge without a second
    canonical record or LINE intent.
12. Use **หมุน Credential** for replacement (the old value is revoked
    immediately with the UI's zero-overlap flow), or **เพิกถอน Credential** to
    stop that credential. Use **ระงับการใช้งาน** to temporarily deny the client
    while retaining scopes and mappings.

## Mapping correction

Mappings are exact and audited. To correct a mapping, first choose
**ปิดการเชื่อม**, then create the intended exact mapping. Deactivation does not
delete canonical clinical history, a Center, Resident, or Care Profile. Remove
dependent Resident mappings before changing an external Center destination.

## Pending subjects and LINE reconciliation

Existing/manual-policy events in `pending_subject_mapping` remain in **ผู้พักรอเชื่อม**.
Selecting **เชื่อมผู้พัก** creates the exact mapping and automatically
reprocesses pending events; the external system does not resend them. The
**กลุ่ม LINE** panel continues to show missing/mismatch states and
**ตรวจสอบอีกครั้ง** uses the verified PHIMOR GroupBinding. There is no
send-anyway or arbitrary LINE destination control.

Commissioned-only ignored events return HTTP 200 with `accepted:false` and
`stored:false`. PHIMOR retains no Integration Inbox or clinical payload for
these events. Zero matches are counted only in bounded per-client telemetry.
Ambiguous exact matches create one deduped, non-clinical item under
**รายการที่ต้องตรวจสอบ**; the item contains safe external references, the
normalized name, and candidate Center names, but no observations, care items,
LINE identity, group ID, or credential. Because the source event was dropped,
PHIMOR cannot reprocess it. After correcting the mapping, the source system
must resend the historical event only if that historical item is required.

## Fictional HHS-style acceptance journey

- Organization: `Fictional Organization`
- Client: `HHS Pilot` / code `hhs-pilot` / source `HHS`
- Center: `Fictional Pilot Center`
- Event: `care.daily_report.finalized`
- External Center/Resident IDs: learned from the first unique exact-name event
  for an automatic-policy local fixture, or configured manually for a
  manual-policy fixture
- Resident: `Fictional Resident`

Use only a local/test credential and fictional data. Confirm the readiness
summary, activate the client, close the credential modal, and verify the secret
is gone. Do not call production, create a real HHS credential, or send LINE.

## Stop conditions

Stop commissioning if Organization/Center scope is uncertain, a mapping would
cross Center or Organization, the Resident lacks the intended Care Profile,
the credential cannot be transferred securely, the Family GroupBinding is not
verified for a notification pilot, or readiness differs from the authoritative
backend state.
