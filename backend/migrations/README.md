# PHIMOR database migrations

The current code sequence ends at `0015_add_plus_payment_v1.js`. The canonical
tail is `0013_add_consultation_payment_recovery.js`, then
`0014_create_shared_rate_limit_windows.js`, then `0015_add_plus_payment_v1.js`.
Plus payment must remain disabled until migration 0015 is applied after every
earlier pending migration and the compatible backend is ready to deploy.

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
