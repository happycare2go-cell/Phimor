# PHIMOR database migrations

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
