// The whole-space export collector (EPIC 6). Pure, unit-testable functions
// assemble the archive content from the database so the tests never unzip
// anything: pass a Db + spaceId, assert on the returned entries. The archive is
// open formats only (ZIP, UTF-8 JSON, UTF-8 text, original audio bytes) so it
// outlives the app. The README.txt copy below is product-voice and swept by
// scripts/copy-sweep.mjs (export.ts is in its TARGET_FILES).
import type { Db } from "../db/index.js";

export interface ArchiveEntry {
  path: string; // POSIX path inside the archive, under the root folder
  content: Buffer; // UTF-8 bytes for text/JSON, raw bytes for audio
}

const SCHEMA_VERSION = 1;

/** lowercase, ASCII, non-alphanumerics to "-", collapse repeats, trim, fallback "x". */
export function slugify(s: string): string {
  const ascii = (s ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return ascii.length > 0 ? ascii : "x";
}

/** A stable per-person folder slug. The id suffix keeps two relatives with the
 * same label from colliding. */
export function personSlug(p: {
  display_name: string | null;
  relationship_to_subject: string | null;
  membership_id: string;
}): string {
  const label = slugify(p.display_name || p.relationship_to_subject || "family");
  return `${label}-${p.membership_id.slice(0, 8)}`;
}

/** The natural file extension for a stored audio mime. Unknown maps to "bin". */
export function audioExt(mime: string | null): string {
  switch (mime) {
    case "audio/webm":
      return "webm";
    case "audio/ogg":
      return "ogg";
    case "audio/mp4":
      return "m4a";
    case "audio/mpeg":
      return "mp3";
    case "audio/wav":
      return "wav";
    default:
      return "bin";
  }
}

/** The top-level folder name, e.g. "ask-the-living-jane-doe-2026-09-21". */
export function archiveRootName(subjectName: string, exportedAtIso: string): string {
  const date = exportedAtIso.slice(0, 10);
  return `ask-the-living-${slugify(subjectName)}-${date}`;
}

interface SpaceRow {
  id: string;
  subject_name: string;
  subject_birth_year: number | null;
  subject_death_year: number | null;
  created_at: string;
}

interface PersonRow {
  membership_id: string;
  display_name: string | null;
  relationship_to_subject: string | null;
  role: string;
  created_at: string;
}

interface SessionRow {
  id: string;
  membership_id: string;
  started_at: string;
  ended_at: string | null;
}

interface AnswerRow {
  id: string;
  membership_id: string;
  session_id: string;
  topic: string;
  prompt_text: string;
  bank_question_key: string;
  question_id: string | null;
  story_id: string | null;
  duration_ms: number;
  created_at: string;
  transcript_status: string;
  transcript: string | null;
  audio_mime: string | null;
}

interface StoryRow {
  id: string;
  label: string;
  created_at: string;
  created_by: string | null;
}

interface QuestionRow {
  id: string;
  text: string;
  topic: string;
  origin: string;
  status: string;
  membership_id: string | null;
  assigned_to: string | null;
  parent_answer_id: string | null;
  story_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

const README_TEXT = (subjectName: string): string =>
  `These are your family's memories of ${subjectName}, in the voices of the people who
loved them. This archive is yours to keep. It opens on any computer, with no
special software and no account.

What is inside
  README.txt        this file
  manifest.json     a short index of everything here
  space.json        the full record: people, recordings, stories, and the map
  audio/            the original voice recordings, one folder per person
  transcripts/      the words of each recording, as plain text

The formats are open. space.json and manifest.json are plain JSON. The
transcripts are plain text. The audio files are the exact recordings, and they
play in any media player. Start with this file, then open manifest.json for a
quick index, then space.json for the whole record.

About the map
space.json holds a map of the family's questions. It keeps what the family
answered, what it set aside for later, and the questions it chose to let go
because only ${subjectName} could have answered them. The holes are part of the
story, so they are kept here honestly alongside the rest.
`;

/**
 * Everything the archive needs, gathered from the DB and returned as entries.
 * Order is deterministic: README.txt, manifest.json, space.json, then one
 * transcript .txt per done-transcript answer, then one audio file per answer
 * with stored bytes. Every entry path begins with the single root folder.
 *
 * Extension point for a very large corpus: stream per answer (query each
 * answer_audio row as it is appended, rather than collecting all buffers
 * first). Not needed at v1 scale (a single family, a 12 MB per-answer cap).
 */
export async function collectArchiveEntries(
  db: Db,
  spaceId: string,
  exportedAtIso: string,
): Promise<ArchiveEntry[]> {
  const spaceRes = await db.query<SpaceRow>(
    `SELECT id, subject_name, subject_birth_year, subject_death_year, created_at
       FROM spaces WHERE id = $1`,
    [spaceId],
  );
  const space = spaceRes.rows[0];
  if (!space) {
    throw new Error("space not found for export");
  }

  const people = (
    await db.query<PersonRow>(
      `SELECT m.id AS membership_id, u.display_name, m.relationship_to_subject,
              m.role, m.created_at
         FROM memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.space_id = $1
        ORDER BY m.created_at ASC, m.id ASC`,
      [spaceId],
    )
  ).rows;

  const sessions = (
    await db.query<SessionRow>(
      `SELECT id, membership_id, started_at, ended_at
         FROM interview_sessions WHERE space_id = $1
        ORDER BY started_at ASC, id ASC`,
      [spaceId],
    )
  ).rows;

  const answers = (
    await db.query<AnswerRow>(
      `SELECT id, membership_id, session_id, topic, prompt_text, bank_question_key,
              question_id, story_id, duration_ms, created_at,
              transcript_status, transcript, audio_mime
         FROM answers WHERE space_id = $1
        ORDER BY created_at ASC, id ASC`,
      [spaceId],
    )
  ).rows;

  const stories = (
    await db.query<StoryRow>(
      `SELECT id, label, created_at, created_by
         FROM stories WHERE space_id = $1
        ORDER BY created_at ASC, id ASC`,
      [spaceId],
    )
  ).rows;

  const questions = (
    await db.query<QuestionRow>(
      `SELECT id, text, topic, origin, status, membership_id, assigned_to,
              parent_answer_id, story_id, created_at, resolved_at
         FROM questions WHERE space_id = $1
        ORDER BY created_at ASC, id ASC`,
      [spaceId],
    )
  ).rows;

  const audioRows = (
    await db.query<{ answer_id: string; bytes: Buffer | Uint8Array }>(
      `SELECT aa.answer_id, aa.bytes
         FROM answer_audio aa
         JOIN answers a ON a.id = aa.answer_id
        WHERE a.space_id = $1`,
      [spaceId],
    )
  ).rows;
  const audioBytes = new Map<string, Buffer>();
  for (const r of audioRows) audioBytes.set(r.answer_id, Buffer.from(r.bytes));

  const slugByMember = new Map<string, string>();
  for (const p of people) slugByMember.set(p.membership_id, personSlug(p));

  // Per-person sequence, assigned in the global created_at ASC order above.
  const seqByMember = new Map<string, number>();

  interface BuiltAnswer {
    row: AnswerRow;
    hasTranscript: boolean;
    transcriptFile: string | null;
    audio: { file: string; mime: string | null; size: number } | null;
  }

  const built: BuiltAnswer[] = answers.map((row) => {
    const personDir = slugByMember.get(row.membership_id) ?? `family-${row.membership_id.slice(0, 8)}`;
    const seq = (seqByMember.get(row.membership_id) ?? 0) + 1;
    seqByMember.set(row.membership_id, seq);
    const id8 = row.id.slice(0, 8);
    const stem = `${pad2(seq)}-${slugify(row.topic)}-${id8}`;

    const hasTranscript =
      row.transcript_status === "done" && (row.transcript ?? "").length > 0;
    const transcriptFile = hasTranscript ? `transcripts/${personDir}/${stem}.txt` : null;

    const bytes = audioBytes.get(row.id);
    const audio = bytes
      ? {
          file: `audio/${personDir}/${stem}.${audioExt(row.audio_mime)}`,
          mime: row.audio_mime,
          size: bytes.length,
        }
      : null;

    return { row, hasTranscript, transcriptFile, audio };
  });

  const answerIdsByStory = new Map<string, string[]>();
  for (const a of answers) {
    if (a.story_id) {
      const list = answerIdsByStory.get(a.story_id) ?? [];
      list.push(a.id);
      answerIdsByStory.set(a.story_id, list);
    }
  }

  const spaceJson = {
    schema_version: SCHEMA_VERSION,
    app: "Ask the Living",
    exported_at: exportedAtIso,
    space: {
      id: space.id,
      subject_name: space.subject_name,
      subject_birth_year: space.subject_birth_year,
      subject_death_year: space.subject_death_year,
      created_at: space.created_at,
    },
    people: people.map((p) => ({
      membership_id: p.membership_id,
      slug: slugByMember.get(p.membership_id)!,
      display_name: p.display_name,
      relationship_to_subject: p.relationship_to_subject,
      role: p.role,
    })),
    sessions: sessions.map((s) => ({
      id: s.id,
      membership_id: s.membership_id,
      started_at: s.started_at,
      ended_at: s.ended_at,
    })),
    answers: built.map((b) => ({
      id: b.row.id,
      membership_id: b.row.membership_id,
      session_id: b.row.session_id,
      topic: b.row.topic,
      prompt_text: b.row.prompt_text,
      bank_question_key: b.row.bank_question_key,
      question_id: b.row.question_id,
      story_id: b.row.story_id,
      duration_ms: b.row.duration_ms,
      created_at: b.row.created_at,
      transcript_status: b.row.transcript_status,
      transcript: b.hasTranscript ? b.row.transcript : null,
      transcript_file: b.transcriptFile,
      audio: b.audio,
    })),
    stories: stories.map((s) => ({
      id: s.id,
      label: s.label,
      created_at: s.created_at,
      created_by: s.created_by,
      answer_ids: answerIdsByStory.get(s.id) ?? [],
    })),
    questions: questions.map((q) => ({
      id: q.id,
      text: q.text,
      topic: q.topic,
      origin: q.origin,
      status: q.status,
      membership_id: q.membership_id,
      assigned_to: q.assigned_to,
      parent_answer_id: q.parent_answer_id,
      story_id: q.story_id,
      created_at: q.created_at,
      resolved_at: q.resolved_at,
    })),
  };

  const countStatus = (s: string): number =>
    questions.filter((q) => q.status === s).length;

  const manifestFiles: {
    path: string;
    kind: string;
    answer_id?: string;
  }[] = [{ path: "space.json", kind: "data" }];
  for (const b of built) {
    if (b.transcriptFile) {
      manifestFiles.push({ path: b.transcriptFile, kind: "transcript", answer_id: b.row.id });
    }
  }
  for (const b of built) {
    if (b.audio) {
      manifestFiles.push({ path: b.audio.file, kind: "audio", answer_id: b.row.id });
    }
  }

  const manifestJson = {
    schema_version: SCHEMA_VERSION,
    exported_at: exportedAtIso,
    subject_name: space.subject_name,
    counts: {
      people: people.length,
      answers: answers.length,
      recordings: built.filter((b) => b.audio).length,
      transcripts: built.filter((b) => b.transcriptFile).length,
      stories: stories.length,
      questions_open: countStatus("open"),
      questions_answered: countStatus("answered"),
      questions_deferred: countStatus("deferred"),
      questions_lost: countStatus("lost"),
    },
    files: manifestFiles,
  };

  const root = archiveRootName(space.subject_name, exportedAtIso);
  const entry = (rel: string, content: Buffer): ArchiveEntry => ({
    path: `${root}/${rel}`,
    content,
  });

  const entries: ArchiveEntry[] = [
    entry("README.txt", Buffer.from(README_TEXT(space.subject_name), "utf8")),
    entry("manifest.json", Buffer.from(JSON.stringify(manifestJson, null, 2), "utf8")),
    entry("space.json", Buffer.from(JSON.stringify(spaceJson, null, 2), "utf8")),
  ];

  for (const b of built) {
    if (b.transcriptFile) {
      entries.push(entry(b.transcriptFile, Buffer.from(b.row.transcript ?? "", "utf8")));
    }
  }
  for (const b of built) {
    if (b.audio) {
      entries.push(entry(b.audio.file, audioBytes.get(b.row.id)!));
    }
  }

  return entries;
}
