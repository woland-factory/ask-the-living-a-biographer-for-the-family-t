import type { Db } from "../db/index.js";
import type { ChatFn, LlmAccess } from "./llm.js";
import { generateCrossQuestion } from "./crosstellings.js";

// Server-side helpers for the side-by-side surface. All SQL is parameterized;
// callers enforce membership before calling. A telling is one member's set of
// answers with the same story_id. Tellings are never merged; a story only
// places them beside each other.

export interface TellingAnswer {
  id: string;
  topic: string;
  prompt_text: string;
  transcript: string | null;
  transcript_status: string;
  duration_ms: number;
  has_audio: boolean;
  created_at: string;
}

export interface StoryTelling {
  membership_id: string;
  relationship_to_subject: string | null;
  display_name: string | null;
  answers: TellingAnswer[];
}

interface TellingRow {
  id: string;
  membership_id: string;
  topic: string;
  prompt_text: string;
  transcript: string | null;
  transcript_status: string;
  duration_ms: number;
  has_audio: boolean;
  created_at: string;
  relationship_to_subject: string | null;
  display_name: string | null;
}

/**
 * Every telling in a story, grouped by member in a stable order. Each member's
 * answers are returned verbatim (transcript included) for the callers that have
 * already passed canViewStory.
 */
export async function getStoryTellings(
  db: Db,
  storyId: string
): Promise<StoryTelling[]> {
  const { rows } = await db.query<TellingRow>(
    `SELECT a.id, a.membership_id, a.topic, a.prompt_text, a.transcript,
            a.transcript_status, a.duration_ms, a.created_at,
            m.relationship_to_subject, u.display_name,
            (aa.answer_id IS NOT NULL) AS has_audio
       FROM answers a
       JOIN memberships m ON m.id = a.membership_id
       JOIN users u ON u.id = m.user_id
       LEFT JOIN answer_audio aa ON aa.answer_id = a.id
      WHERE a.story_id = $1
      ORDER BY m.created_at ASC, a.created_at ASC`,
    [storyId]
  );

  const byMember = new Map<string, StoryTelling>();
  const order: string[] = [];
  for (const r of rows) {
    let telling = byMember.get(r.membership_id);
    if (!telling) {
      telling = {
        membership_id: r.membership_id,
        relationship_to_subject: r.relationship_to_subject,
        display_name: r.display_name,
        answers: [],
      };
      byMember.set(r.membership_id, telling);
      order.push(r.membership_id);
    }
    telling.answers.push({
      id: r.id,
      topic: r.topic,
      prompt_text: r.prompt_text,
      transcript: r.transcript,
      transcript_status: r.transcript_status,
      duration_ms: r.duration_ms,
      has_audio: r.has_audio,
      created_at: r.created_at,
    });
  }
  return order.map((id) => byMember.get(id)!);
}

/**
 * The consented-reveal rule. A viewer may read a story's raw tellings only when
 * they are the space organizer, or they have a telling of their own tagged to
 * the story. Nothing else opens another member's raw sitting.
 */
export async function canViewStory(
  db: Db,
  viewer: { id: string; role: string },
  storyId: string
): Promise<boolean> {
  if (viewer.role === "organizer") return true;
  const { rows } = await db.query(
    "SELECT 1 FROM answers WHERE story_id = $1 AND membership_id = $2 LIMIT 1",
    [storyId, viewer.id]
  );
  return rows.length > 0;
}

/** Join a teller's completed transcripts into one block for the model. */
function joinTranscripts(t: StoryTelling): string {
  return t.answers
    .filter((a) => a.transcript_status === "done" && (a.transcript ?? "").trim().length > 0)
    .map((a) => (a.transcript ?? "").trim())
    .join("\n\n");
}

export interface GeneratedCrossQuestion {
  id: string;
  text: string;
  topic: string;
  membership_id: string;
}

/**
 * The signature-moment orchestrator. Best-effort and non-blocking: it never
 * throws, and any single teller's failure is swallowed so the others still
 * generate. Idempotent by the partial unique index: at most one open
 * cross-question per teller per story.
 */
export async function generateStoryQuestions(
  db: Db,
  args: { storyId: string; access: LlmAccess; chat: ChatFn; subjectName: string }
): Promise<GeneratedCrossQuestion[]> {
  const { storyId, access, chat, subjectName } = args;
  if (access.mode === "off") return [];

  const story = await db.query<{ space_id: string; label: string }>(
    "SELECT space_id, label FROM stories WHERE id = $1",
    [storyId]
  );
  if (story.rows.length === 0) return [];
  const { space_id: spaceId, label: storyLabel } = story.rows[0];

  const tellings = await getStoryTellings(db, storyId);
  if (tellings.length < 2) return [];

  // Tellers who already hold an open cross-question for this story are skipped.
  const existing = await db.query<{ membership_id: string }>(
    `SELECT membership_id FROM questions
      WHERE story_id = $1 AND origin = 'crosstelling' AND status = 'open'`,
    [storyId]
  );
  const alreadyOpen = new Set(existing.rows.map((r) => r.membership_id));

  const created: GeneratedCrossQuestion[] = [];
  for (const teller of tellings) {
    if (alreadyOpen.has(teller.membership_id)) continue;

    const mine = joinTranscripts(teller);
    const others = tellings.filter((t) => t.membership_id !== teller.membership_id);
    const theirs = others.map(joinTranscripts).filter((s) => s.length > 0).join("\n\n");
    if (mine.length === 0 || theirs.length === 0) continue;

    // A representative answer id from the other teller(s) that raised the question.
    const otherAnswer = others
      .flatMap((t) => t.answers)
      .find((a) => a.id) ?? null;

    let text: string | null;
    try {
      text = await generateCrossQuestion({
        access,
        chat,
        ctx: {
          subjectName,
          storyLabel,
          mine,
          theirs,
          topic: teller.answers[0]?.topic ?? "",
        },
      });
    } catch {
      text = null;
    }
    if (!text) continue;

    const topic = teller.answers[0]?.topic ?? "";
    const ins = await db.query<{ id: string; text: string; topic: string }>(
      `INSERT INTO questions
         (space_id, membership_id, origin, topic, text, story_id, parent_answer_id, status)
       VALUES ($1, $2, 'crosstelling', $3, $4, $5, $6, 'open')
       ON CONFLICT DO NOTHING
       RETURNING id, text, topic`,
      [spaceId, teller.membership_id, topic, text, storyId, otherAnswer?.id ?? null]
    );
    if (ins.rows.length > 0) {
      created.push({ ...ins.rows[0], membership_id: teller.membership_id });
      alreadyOpen.add(teller.membership_id);
    }
  }
  return created;
}
