-- EPIC 2: the solo voice interview loop. Forward-only.
-- Audio bytes live in Postgres so they persist in the same db-data volume as
-- everything else. The transcript is derived and may lag or fail without ever
-- putting the recording at risk.

CREATE TABLE interview_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id     uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  started_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz
);
CREATE INDEX idx_interview_sessions_member
  ON interview_sessions (space_id, membership_id);

CREATE TABLE answers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        uuid NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
  space_id          uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  membership_id     uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  bank_question_key text NOT NULL,
  prompt_text       text NOT NULL,
  topic             text NOT NULL,
  duration_ms       integer NOT NULL DEFAULT 0,
  audio_mime        text,
  audio_size        integer,
  transcript        text,
  transcript_status text NOT NULL DEFAULT 'pending'
                    CHECK (transcript_status IN ('pending','done','failed')),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_answers_member ON answers (space_id, membership_id);
CREATE INDEX idx_answers_session ON answers (session_id);

-- Audio kept in its own table so the hot metadata rows stay small.
CREATE TABLE answer_audio (
  answer_id  uuid PRIMARY KEY REFERENCES answers(id) ON DELETE CASCADE,
  bytes      bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- "Not this topic yet." One row per (membership, topic) the user has deferred.
CREATE TABLE topic_deferrals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id      uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  topic         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (space_id, membership_id, topic)
);
