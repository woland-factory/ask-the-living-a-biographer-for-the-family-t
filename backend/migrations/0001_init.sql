-- Foundation schema for Ask the Living (EPIC 1).
-- Forward-only. gen_random_uuid() is available in PostgreSQL 16 core.

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE magic_link_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_magic_link_tokens_expires_at ON magic_link_tokens (expires_at);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_auth_sessions_user_id ON auth_sessions (user_id);

CREATE TABLE spaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_name text NOT NULL,
  subject_birth_year int,
  subject_death_year int,
  created_by uuid NOT NULL REFERENCES users(id),
  pace_default text NOT NULL DEFAULT 'gentle',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_spaces_created_by ON spaces (created_by);

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  relationship_to_subject text,
  role text NOT NULL CHECK (role IN ('organizer', 'contributor')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (space_id, user_id)
);
CREATE INDEX idx_memberships_user_id ON memberships (user_id);
