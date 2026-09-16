-- EPIC 4: invite links, guest identities, and question routing.
-- Forward-only. Raw tokens are never stored, only their sha256 hash.

CREATE TABLE invites (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id   uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label      text,
  token_hash text NOT NULL UNIQUE,
  status     text NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','joined')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  joined_at  timestamptz
);
CREATE INDEX idx_invites_space ON invites (space_id);

-- A relative who joins by link has no email address. The session cookie is
-- their identity. UNIQUE(email) keeps holding: NULLs never collide.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

-- Which invite created a membership. NULL for organizer-created memberships.
-- This is also the "owner-validated" marker for the gateway tier.
ALTER TABLE memberships
  ADD COLUMN invite_id uuid REFERENCES invites(id) ON DELETE SET NULL;

-- Routing. assigned_to is the member a question was sent to; membership_id
-- keeps meaning "whose telling this question belongs to". They are distinct.
ALTER TABLE questions
  ADD COLUMN assigned_to uuid REFERENCES memberships(id) ON DELETE SET NULL;
ALTER TABLE questions ADD COLUMN routed_at timestamptz;
CREATE INDEX idx_questions_space_assigned ON questions (space_id, assigned_to);
