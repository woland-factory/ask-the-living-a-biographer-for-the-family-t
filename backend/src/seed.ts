import type { Db, Queryable } from "./db/index.js";

export interface SeedLogger {
  info: (msg: string) => void;
}

// The demo family. Hand-authored, offline, copy-swept content shaped exactly
// like real data. It builds the signature moment so a first-time visitor on
// staging sees two tellings of one story side by side, with the two open
// questions already posed, in under a minute and with no key, network, or
// hand-crafted input. Keyed on a reserved, non-routable organizer email so the
// seed is idempotent across restarts.
export const DEMO = {
  email: "demo@ask-the-living.example",
  organizerName: "Rosa's family",
  subjectName: "Rosa",
  storyLabel: "The bakery on Sunday mornings",
  topic: "everyday",
  daughter: {
    name: "Maria",
    relationship: "daughter",
    prompt: "What did an ordinary Sunday morning look like?",
    transcript:
      "On Sunday mornings the whole house smelled of warm bread, and Rosa sang in the kitchen while the loaves rose.",
  },
  sister: {
    name: "Elena",
    relationship: "sister",
    prompt: "What did an ordinary Sunday morning look like?",
    transcript:
      "Rosa opened the bakery before dawn every Sunday, and she always saved the very first loaf for a neighbor down the street.",
  },
  // Posed to the daughter, grounded in the sister's telling.
  questionToDaughter: "Who was the neighbor your mother saved the first loaf for?",
  // Posed to the sister, grounded in the daughter's telling.
  questionToSister: "What songs did Rosa sing while the bread baked?",
  // Both questions together, for the guardrail and copy-sweep test.
  questions: [
    "Who was the neighbor your mother saved the first loaf for?",
    "What songs did Rosa sing while the bread baked?",
  ],
};

async function insertTelling(
  tx: Queryable,
  args: {
    spaceId: string;
    membershipId: string;
    storyId: string;
    prompt: string;
    transcript: string;
  }
): Promise<string> {
  const session = await tx.query<{ id: string }>(
    `INSERT INTO interview_sessions (space_id, membership_id, ended_at)
     VALUES ($1, $2, now()) RETURNING id`,
    [args.spaceId, args.membershipId]
  );
  const answer = await tx.query<{ id: string }>(
    `INSERT INTO answers
       (session_id, space_id, membership_id, bank_question_key, prompt_text,
        topic, duration_ms, transcript, transcript_status, story_id)
     VALUES ($1, $2, $3, $4, $5, $6, 0, $7, 'done', $8)
     RETURNING id`,
    [
      session.rows[0].id,
      args.spaceId,
      args.membershipId,
      "everyday-sunday-mornings",
      args.prompt,
      DEMO.topic,
      args.transcript,
      args.storyId,
    ]
  );
  return answer.rows[0].id;
}

/**
 * Idempotent demo-seed entry point, run on startup when SEED_DEMO=1. Writes only
 * offline, hand-authored content and makes no network or LLM call. Safe to run
 * on every boot: if the demo organizer already owns a space, it returns.
 */
export async function seedDemo(db: Db, log: SeedLogger): Promise<void> {
  const existing = await db.query(
    `SELECT 1
       FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.role = 'organizer'
      WHERE u.email = $1
      LIMIT 1`,
    [DEMO.email]
  );
  if (existing.rows.length > 0) {
    log.info("SEED_DEMO is on: demo family already present, nothing to add");
    return;
  }

  await db.transaction(async (tx) => {
    const organizer = await tx.query<{ id: string }>(
      "INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id",
      [DEMO.email, DEMO.organizerName]
    );
    const space = await tx.query<{ id: string }>(
      "INSERT INTO spaces (subject_name, created_by) VALUES ($1, $2) RETURNING id",
      [DEMO.subjectName, organizer.rows[0].id]
    );
    const spaceId = space.rows[0].id;

    await tx.query(
      "INSERT INTO memberships (space_id, user_id, role) VALUES ($1, $2, 'organizer')",
      [spaceId, organizer.rows[0].id]
    );

    const makeGuest = async (name: string, relationship: string): Promise<string> => {
      const user = await tx.query<{ id: string }>(
        "INSERT INTO users (email, display_name) VALUES (NULL, $1) RETURNING id",
        [name]
      );
      const membership = await tx.query<{ id: string }>(
        `INSERT INTO memberships (space_id, user_id, relationship_to_subject, role)
         VALUES ($1, $2, $3, 'contributor') RETURNING id`,
        [spaceId, user.rows[0].id, relationship]
      );
      return membership.rows[0].id;
    };

    const daughterId = await makeGuest(DEMO.daughter.name, DEMO.daughter.relationship);
    const sisterId = await makeGuest(DEMO.sister.name, DEMO.sister.relationship);

    const story = await tx.query<{ id: string }>(
      "INSERT INTO stories (space_id, label, created_by) VALUES ($1, $2, $3) RETURNING id",
      [spaceId, DEMO.storyLabel, daughterId]
    );
    const storyId = story.rows[0].id;

    const daughterAnswer = await insertTelling(tx, {
      spaceId,
      membershipId: daughterId,
      storyId,
      prompt: DEMO.daughter.prompt,
      transcript: DEMO.daughter.transcript,
    });
    const sisterAnswer = await insertTelling(tx, {
      spaceId,
      membershipId: sisterId,
      storyId,
      prompt: DEMO.sister.prompt,
      transcript: DEMO.sister.transcript,
    });

    // The two open questions, each grounded in the OTHER teller's telling.
    await tx.query(
      `INSERT INTO questions
         (space_id, membership_id, origin, topic, text, story_id, parent_answer_id, status)
       VALUES ($1, $2, 'crosstelling', $3, $4, $5, $6, 'open')`,
      [spaceId, daughterId, DEMO.topic, DEMO.questionToDaughter, storyId, sisterAnswer]
    );
    await tx.query(
      `INSERT INTO questions
         (space_id, membership_id, origin, topic, text, story_id, parent_answer_id, status)
       VALUES ($1, $2, 'crosstelling', $3, $4, $5, $6, 'open')`,
      [spaceId, sisterId, DEMO.topic, DEMO.questionToSister, storyId, daughterAnswer]
    );
  });

  log.info("SEED_DEMO is on: demo family seeded");
}
