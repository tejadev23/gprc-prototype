CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_project_id uuid
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id uuid PRIMARY KEY,
  ip text NOT NULL,
  email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS login_attempts_window ON login_attempts (ip, created_at);

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  revision integer NOT NULL DEFAULT 1,
  active_station_id text,
  page_number integer NOT NULL DEFAULT 1,
  document_name text,
  document_stored boolean NOT NULL DEFAULT false,
  visibility jsonb NOT NULL,
  dock_tab text NOT NULL,
  snap boolean NOT NULL DEFAULT false,
  stations jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS projects_owner ON projects (owner_id);

CREATE TABLE IF NOT EXISTS gprc_records (
  project_id uuid PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  record jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('pdf', 'plan')),
  object_key text NOT NULL,
  mime text NOT NULL,
  byte_size integer NOT NULL,
  UNIQUE (project_id, kind)
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
