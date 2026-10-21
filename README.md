# GPRC prototype

A standalone copy of the GPRC workspace. Projects, cross-section PDFs, and stitched plans are stored for the signed-in account, so the same login sees them on another browser or device.

Projects are private to the account that created them. There is no public registration and no anonymous write API.

This repository does not change the Earthwork-AI application it was copied from.

## Local setup

1. Install dependencies with `pnpm install`.
2. Create a Postgres database and set `DATABASE_URL` in `.env.local`. Copy the names from `.env.example`. Do not commit real values.
3. `pnpm db:migrate`
4. `BOOTSTRAP_EMAIL=you@example.com BOOTSTRAP_PASSWORD='a long password' pnpm user:create`
5. For a real file store, set `OBJECT_STORE=s3` and the `S3_*` variables. Cloudflare R2 and AWS S3 both work. `OBJECT_STORE=memory` keeps files in the server process only. A restart or redeploy drops them. Do not use it on Render.
6. `pnpm dev`

## Render

- Web service: build `pnpm install && pnpm build`, start `pnpm start`.
- Add a Render Postgres database and set `DATABASE_URL` to its internal URL.
- Set `AUTH_SECRET` to a long random string.
- Set the `S3_*` variables to a bucket that is not the web service disk. Render's local disk is wiped on deploy.
- Release command: `pnpm db:migrate`
- Create the first user with `pnpm user:create` from a shell that has the bootstrap variables. Do not add a signup page.
- Health check path: `/api/health`

## Backup

- `pg_dump "$DATABASE_URL" > gprc.sql` for the database.
- Copy the object-storage bucket with the provider's sync tool. The database stores the object keys, not the file bytes.

## Accounts

A missing project and a project owned by someone else both return 404. Signing in on two browsers with the same account shows the same projects. Sessions last 14 days, are stored hashed, and are revoked on sign out. The cookie is httpOnly and SameSite=Lax, and Secure in production. Sign-in is limited to 8 attempts per address per 15 minutes.

Saves send the project revision. A stale save gets 409 and the browser reloads the newer copy instead of overwriting it. The project row and the GPRC record update in one transaction.

`version` on the project is still the schema version (1). The concurrency counter is `revision`, which the original IndexedDB app did not have.
