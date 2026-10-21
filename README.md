# GPRC prototype

A standalone copy of the GPRC workspace. Projects, cross-section PDFs, and stitched plans are stored for the signed-in account, so the same login sees them on another browser or device.

Projects are private to the account that created them. There is no public registration and no anonymous write API.

This repository does not change the Earthwork-AI application it was copied from.

Requires Node.js 20.9 or newer (`engines.node`, `.nvmrc`).

## Local setup

1. `pnpm install`
2. Create a Postgres database. Copy `.env.example` to `.env.local`. Set `DATABASE_URL`. Do not commit real values.
3. For local files without R2, set `OBJECT_STORE=disk` and optionally `OBJECT_DIR=./data/objects`. Disk and memory stores are rejected when `NODE_ENV=production`.
4. `pnpm db:migrate`
5. `BOOTSTRAP_EMAIL=you@example.com BOOTSTRAP_PASSWORD='a long password' pnpm user:create`
6. For persistent files, set `OBJECT_STORE=s3` and the `S3_*` variables (Cloudflare R2 or AWS S3). `OBJECT_STORE=memory` is for tests; a restart drops those files.
7. `pnpm dev`

## Render

GitHub repository: `tejadev23/gprc-prototype`.

### Commands

| Step | Command |
| --- | --- |
| Build | `pnpm install --frozen-lockfile && pnpm build` |
| Start | `pnpm start` |
| Release (migrate) | `pnpm db:migrate` |
| Health check | `/api/health` |

Set the Node version to **20** (or newer 20.x / 22.x) in the Render service. The repo pins `>=20.9.0`.

### Environment variables (web service)

| Name | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Internal Database URL of the linked Render Postgres instance |
| `OBJECT_STORE` | yes | Must be `s3` in production |
| `S3_ENDPOINT` | yes | R2: `https://<accountid>.r2.cloudflarestorage.com` |
| `S3_REGION` | yes | Use `auto` for R2 |
| `S3_BUCKET` | yes | R2 bucket name |
| `S3_ACCESS_KEY_ID` | yes | R2 API token access key |
| `S3_SECRET_ACCESS_KEY` | yes | R2 API token secret |

If `OBJECT_STORE` is missing, the app uses S3 (not disk). Missing `S3_*` values throw a clear error on upload/download. `OBJECT_STORE=disk` and `OBJECT_STORE=memory` throw in production.

Do **not** set `BOOTSTRAP_EMAIL` or `BOOTSTRAP_PASSWORD` on the web service. Sessions are stored hashed in Postgres; there is no `AUTH_SECRET`.

### Deployment sequence

1. Create a **Render PostgreSQL** instance. Note the Internal Database URL.
2. Create a **Cloudflare R2** bucket and an API token with object read/write on that bucket.
3. Create a **Render Node.js Web Service** from `tejadev23/gprc-prototype` (`main`).
4. Set build `pnpm install --frozen-lockfile && pnpm build`, start `pnpm start`, release `pnpm db:migrate`, Node 20+, health `/api/health`.
5. Link the Postgres instance. Set `DATABASE_URL` (internal URL), `OBJECT_STORE=s3`, and the `S3_*` variables. Do not point storage at the web service disk; Render wipes it on deploy.
6. Deploy. Confirm the release command applies `drizzle/0001_init.sql`. Confirm `GET /api/health` returns `{ "ok": true }`.
7. Open **Render Shell** on the web service. Create the first account, then unset those variables from your shell history:

   ```bash
   BOOTSTRAP_EMAIL=you@example.com BOOTSTRAP_PASSWORD='a long password' pnpm user:create
   ```

   There is no signup page. A second account requires `BOOTSTRAP_ALLOW_MORE=1`.
8. Open the site, sign in, create or open a project, upload a cross-section PDF and a plan, and confirm they survive a refresh.

### Backup

- `pg_dump "$DATABASE_URL" > gprc.sql` for the database.
- Copy the R2/S3 bucket with the provider's sync tool. The database stores object keys, not file bytes.

## Accounts

A missing project and a project owned by someone else both return 404. Signing in on two browsers with the same account shows the same projects. Sessions last 14 days, are stored hashed, and are revoked on sign out. The cookie is httpOnly and SameSite=Lax, and Secure in production. Sign-in is limited to 8 attempts per address per 15 minutes.

Saves send the project revision. A stale save gets 409 and the browser reloads the newer copy instead of overwriting it. The project row and the GPRC record update in one transaction.

`version` on the project is still the schema version (1). The concurrency counter is `revision`, which the original IndexedDB app did not have.
