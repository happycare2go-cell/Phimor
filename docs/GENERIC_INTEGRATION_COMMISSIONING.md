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
5. Under **การเชื่อมรหัสศูนย์ภายนอก**, map one exact external Center ID to one
   Center already present in the client scope. There is no fuzzy match.
6. Optionally map exact external Resident IDs proactively under
   **การเชื่อมรหัสผู้พักภายนอก**. The Resident must be active, belong to the
   mapped Center, and have a Care Profile relationship. This is recommended for
   a controlled pilot; otherwise `pending_subject_mapping` remains supported.
7. If Family notifications are required, verify the normal PHIMOR Family
   GroupBinding. An external expected LINE group ID is reconciliation metadata,
   never routing authority.
8. Review **ความพร้อมใช้งาน**, then explicitly choose **เปิดใช้งาน**. The
   checklist is informational; backend status, scopes, mappings, capabilities,
   and credential validation remain authoritative.
9. Send one controlled event from a test or approved external server. Verify the
   integration inbox, canonical record, and intended notification projection.
10. Replay the identical event ID and payload. It must converge without a second
    canonical record or LINE intent.
11. Use **หมุน Credential** for replacement (the old value is revoked
    immediately with the UI's zero-overlap flow), or **เพิกถอน Credential** to
    stop that credential. Use **ระงับการใช้งาน** to temporarily deny the client
    while retaining scopes and mappings.

## Mapping correction

Mappings are exact and audited. To correct a mapping, first choose
**ปิดการเชื่อม**, then create the intended exact mapping. Deactivation does not
delete canonical clinical history, a Center, Resident, or Care Profile. Remove
dependent Resident mappings before changing an external Center destination.

## Pending subjects and LINE reconciliation

Existing events in `pending_subject_mapping` remain in **ผู้พักรอเชื่อม**.
Selecting **เชื่อมผู้พัก** creates the exact mapping and automatically
reprocesses pending events; the external system does not resend them. The
**กลุ่ม LINE** panel continues to show missing/mismatch states and
**ตรวจสอบอีกครั้ง** uses the verified PHIMOR GroupBinding. There is no
send-anyway or arbitrary LINE destination control.

## Fictional HHS-style acceptance journey

- Organization: `Fictional Organization`
- Client: `HHS Pilot` / code `hhs-pilot` / source `HHS`
- Center: `Fictional Pilot Center`
- Event: `care.daily_report.finalized`
- External Center ID: `HHS_BRANCH_TEST`
- External Resident ID: `HHS_RESIDENT_TEST`
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
