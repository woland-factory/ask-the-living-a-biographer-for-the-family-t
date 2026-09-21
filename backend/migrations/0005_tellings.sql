-- EPIC 5: side-by-side tellings. A story groups tellings of one story across
-- people. The cross-telling question is the single open question each teller's
-- version leaves for the other. Forward-only. Divergent tellings are never
-- merged; a story only places them beside each other.

CREATE TABLE stories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id    uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  label       text NOT NULL,
  created_by  uuid REFERENCES memberships(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_stories_space ON stories (space_id);

-- Tag a telling (an answer) to a story. NULL means "not part of any story yet".
ALTER TABLE answers
  ADD COLUMN story_id uuid REFERENCES stories(id) ON DELETE SET NULL;
CREATE INDEX idx_answers_story ON answers (story_id);

-- The story a cross-telling question belongs to (NULL for bank/followup rows).
ALTER TABLE questions
  ADD COLUMN story_id uuid REFERENCES stories(id) ON DELETE SET NULL;
CREATE INDEX idx_questions_space_story ON questions (space_id, story_id);

-- Widen origin for the cross-telling open question. For a 'crosstelling' row
-- membership_id is "the teller this question is posed to" and parent_answer_id
-- points at the OTHER teller's telling that raised it.
ALTER TABLE questions DROP CONSTRAINT IF EXISTS questions_origin_check;
ALTER TABLE questions ADD CONSTRAINT questions_origin_check
  CHECK (origin IN ('bank','followup','crosstelling'));

-- At most one OPEN cross-telling question per (story, teller). An answered row
-- leaves this partial index, so a later regeneration may pose a fresh one.
CREATE UNIQUE INDEX uq_questions_crosstelling_open
  ON questions (story_id, membership_id)
  WHERE origin = 'crosstelling' AND status = 'open';
