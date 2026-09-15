-- EPIC 3: BYOK LLM credentials, the gap map (questions), follow-up links.
-- Forward-only. The API key is stored as AES-256-GCM ciphertext and is never
-- returned in full, logged, or shared between users.

CREATE TABLE llm_credentials (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  base_url       text NOT NULL,
  model          text NOT NULL DEFAULT 'gpt-4o-mini',
  provider_label text,
  key_ciphertext text NOT NULL,          -- base64 (AES-256-GCM)
  key_iv         text NOT NULL,          -- base64 (12-byte GCM nonce)
  key_tag        text NOT NULL,          -- base64 (GCM auth tag)
  key_last4      text NOT NULL,          -- last 4 chars, for the redacted view
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- The gap map. Every row is one standing question in a space.
-- EPIC 3 uses origin in ('bank','followup'); 'routed'/'manual' arrive later.
CREATE TABLE questions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id          uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  -- The person this question belongs to. NULL means "for anyone who knows".
  membership_id     uuid REFERENCES memberships(id) ON DELETE SET NULL,
  origin            text NOT NULL CHECK (origin IN ('bank','followup')),
  topic             text NOT NULL,
  text              text NOT NULL,
  bank_question_key text,                 -- set when origin='bank'
  parent_answer_id  uuid REFERENCES answers(id) ON DELETE SET NULL, -- origin='followup'
  status            text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','answered','deferred','lost')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz
);
CREATE INDEX idx_questions_space_status ON questions (space_id, status);
CREATE INDEX idx_questions_space_topic  ON questions (space_id, topic);
CREATE INDEX idx_questions_space_member ON questions (space_id, membership_id);
-- One bank row per (space, bank question). followup rows have a NULL
-- bank_question_key, and NULLs never collide, so a plain unique index both
-- de-duplicates bank seeding and leaves followups unconstrained.
CREATE UNIQUE INDEX uq_questions_space_bank
  ON questions (space_id, bank_question_key);

-- Link an answer to the follow-up question it answers (NULL for bank answers).
ALTER TABLE answers
  ADD COLUMN question_id uuid REFERENCES questions(id) ON DELETE SET NULL;
CREATE INDEX idx_answers_question ON answers (question_id);
