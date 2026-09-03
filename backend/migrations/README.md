# PHIMOR database migrations

The current code sequence ends at `0018_extend_ai_interaction_audit_usage.js`. The canonical
tail is `0013_add_consultation_payment_recovery.js`, then
`0014_create_shared_rate_limit_windows.js`, `0015_add_plus_payment_v1.js`, then
`0016_add_center_family_linking_integrity.js`, then
`0017_create_integration_field_picker_adapters.js`, then
`0018_extend_ai_interaction_audit_usage.js`.
Plus payment must remain disabled until migration 0015 is applied after every
earlier pending migration and the compatible backend is ready to deploy.

Migration 0016 adds only expression/partial indexes to the legacy JSONB
`accessRequests` and `residents` tables. It performs explicit duplicate
preflight checks and stops without changing evidence if token, link-request,
or active Care Profile/Resident invariants are already violated.

Migration 0017 adds normalized reusable Integration Adapter templates, immutable
versions, per-client bindings, structural-change notices, and temporary
commissioning samples. Run `npm run preflight:integration-adapter-v1` before
applying it. The SELECT-only preflight also blocks the earlier undeployed
client-owned `integration_adapter_profiles` shape so incompatible 0017 schemas
cannot be mistaken for one another.

Migration 0018 additively extends `ai_interaction_audit` with nullable token,
research-plan, web-search, and source-count metadata. Nullable counts preserve
the distinction between provider-not-reported (`NULL`) and reported zero (`0`);
the migration stores no prompt, model response, search query, or clinical content.

Migrations are explicit operations. The application does not run them during startup.

Commands (from `backend`):

```sh
npm run migrate:status
npm run migrate
```

Create files named `NNNN_description.js`, using an increasing, unique version:

```js
module.exports = {
  version: '0001',
  name: 'description',
  async up(client) {},
  async down(client) {},
};
```

Rules:

- Never edit an applied migration. Its SHA-256 checksum is recorded.
- Use backward-compatible, expand-first changes and `IF NOT EXISTS` where appropriate.
- Test against staging and verify backups before production.
- `down` documents a rollback path, but production data migrations may be forward-only.
- Running `migrate` bootstraps `schema_migrations` and explicitly applies any pending migration files.
- Business migrations must be tested in staging and are never run automatically by application startup.
