# EPIC SPEC — The voice interview loop (solo, key-free)

## Quality differentiator (hold every decision to this)

**Emotional safety.** The interview must feel like being heard by someone kind
and unhurried who never oversteps. This EPIC is the first place a grieving user
meets that promise, so it carries the weight of the whole product's wedge.

What it demands of THIS EPIC's work:
- The interview never rushes. There is no visible funnel, no progress bar that
  counts the person down, no "X of Y questions." One question sits on the
  screen at a time, and the user decides when to move.
- Every bank question is a question a thoughtful biographer would ask a
  grieving person: concrete, invitational, and safe. No prying about feelings,
  no clinical wording, no assumptions about how the person died or who the
  survivor is.
- The user can always step back without penalty: pause, stop, or say "not this
  topic yet," and nothing is lost or scolded.
- A finished sitting is treated as an accomplishment, not a step toward a
  quota. Warmth in, funnel out.
- When transcription fails, the failure is shown gently and the recording is
  never at risk. The audio is the memory; the transcript is a convenience.

---

## 1. Scope

### In scope
- A signed-in organizer opens a space and runs a solo voice interview.
- Record a voice answer in the browser with `MediaRecorder`; play it back.
- Persist the audio and its metadata server-side so it survives a restart.
- Transcribe the recording on-device in a Web Worker (Whisper-class), attach
  the transcript to the answer, and degrade gently when transcription fails.
- Drive the session from a curated, in-code biographer question bank, one
  question at a time.
- Pace controls: pause (leave and come back), stop, resume where they left off,
  and "not this topic yet" (defer the current question's topic).
- A warm completion surface when a sitting ends.
- New forward-only migration for `interview_sessions`, `answers`,
  `answer_audio`, and `topic_deferrals`.
- CSP and Fastify body-handling changes needed to serve the worker and accept
  audio uploads.

### Out of scope (binding non-goals — do NOT build)
- **No adaptive / LLM follow-ups.** The bank is the only source of questions in
  this EPIC. No BYOK surface, no gateway calls, no follow-up generation. That
  is EPIC 3.
- **No server-side audio processing.** The server stores audio bytes and hands
  them back. It never transcodes, transcribes, or runs any audio ML. All
  transcription is on-device.
- **No video.** Audio only.
- **No gap map, no `questions` table, no stories / side-by-side.** The standing
  family-visible question map is EPIC 3; stories are EPIC 5. This EPIC tracks
  session progress from answers and deferrals only.
- **No invites / relatives / routing.** Solo organizer only (EPIC 4).
- **No export.** (EPIC 6.)
- **No first-run walkthrough overlay.** (EPIC 7 owns the guided path.) This
  EPIC still meets the baseline first-run bar: the interview screen's own empty
  and ready states make the core action obvious without a coach-mark layer.
- **No transcript editing UI, no answer deletion UI, no re-recording an
  existing answer.** Keep the loop: read a question, record, play back, save,
  next. (Retrying a failed *transcription* is in scope; re-recording audio is
  not.)

---

## 2. Technical design

### 2.1 Data model (forward-only migration `backend/migrations/0002_interview.sql`)

Audio is the source of truth; the transcript is derived and may lag or fail
without losing the recording. Store audio bytes in Postgres so they persist in
the same `db-data` volume as everything else (the `web` container has no
persistent volume; the filesystem is not durable across redeploys). Audio is
capped in duration and size, and family-scale, so `bytea` is the right fit.

```sql
-- EPIC 2: the solo voice interview loop. Forward-only.

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
```

Notes:
- The migration runner (`runMigrations`) picks up new `.sql` files by sorted
  filename automatically; no code change needed to apply it. PGlite (tests /
  e2e) and Postgres 16 both support `bytea` and `gen_random_uuid()`.
- `bank_question_key` and `topic` are stored as free text validated at the
  boundary (see §2.4). The bank itself is a client concern in this EPIC; the
  server records the snapshot the client sends and never trusts it for
  authorization.

### 2.2 The question bank (`frontend/src/interview/bank.ts`)

A curated, ordered, in-code list. Each entry: `{ key: string; topic: string;
text: string }`. `key` is a stable slug (e.g. `beginnings-hometown`). `topic`
is a stable slug used by deferral (e.g. `beginnings`). The list order is the
interview order; the client walks it and skips answered keys and deferred
topics.

The bank lives under `frontend/src/`, so `scripts/copy-sweep.mjs` already scans
it. Every question MUST pass the sweep: no `—`/`–`, none of the banned
vocabulary, no negative empty-state phrasing, plain and gentle in register, and
no prying "how did that make you feel" shape.

**Ship this starter bank** (already swept — keep it clean if you edit it):

| key | topic | text |
| --- | --- | --- |
| `beginnings-hometown` | `beginnings` | Where did they grow up, and what was the house like? |
| `beginnings-childhood-story` | `beginnings` | What is a story they told about their own childhood? |
| `family-how-they-met` | `family` | How did they meet the people they built a family with? |
| `family-who-they-leaned-on` | `family` | Who did they turn to when things got hard? |
| `everyday-ordinary-day` | `everyday` | What did an ordinary day look like for them? |
| `everyday-cooking` | `everyday` | What did they cook, and who did they cook it for? |
| `character-laughter` | `character` | What could always make them laugh? |
| `character-what-they-defended` | `character` | What did they care about enough to argue over? |
| `together-a-day-you-keep` | `together` | Tell me about a day with them you still think about. |
| `together-what-they-taught` | `together` | What is something they taught you without meaning to? |
| `work-their-days` | `work` | What work filled their days, and were they proud of it? |
| `work-with-their-hands` | `work` | What could they fix, make, or do with their hands? |
| `later-comfort` | `later` | What brought them comfort in their later years? |
| `later-looking-forward` | `later` | What were they still looking forward to? |
| `keeping-never-forget` | `keeping` | What do you never want the family to forget about them? |
| `keeping-thank-you` | `keeping` | What would you thank them for, if they were here? |

Topic display labels (for the "not this topic yet" affordance and any topic
heading) live beside the bank: `beginnings` → "Their early life",
`family` → "Family", `everyday` → "Everyday life", `character` → "Who they
were", `together` → "You and them", `work` → "Work and making",
`later` → "Later years", `keeping` → "What to keep". Labels are copy-swept too.

### 2.3 On-device transcription (`frontend/src/interview/transcribe.worker.ts`)

- Use Transformers.js (`@xenova/transformers`) running a Whisper-class model in
  a **Web Worker**, so the main thread stays responsive. Default model:
  `Xenova/whisper-base.en` (quantized). The model id is a module constant so it
  can be tuned later; do not add a settings surface for it.
- The library JS is bundled locally by Vite (served `'self'`). Configure the
  ONNX runtime `wasmPaths` so the wasm backend is served from the app bundle
  (`'self'`) rather than a third-party CDN. Model **weights** are fetched once
  from Hugging Face and then cached in the browser by the library; the audio
  itself never leaves the device. This is the privacy posture for grief audio
  and keeps server-side audio cost at zero.
- Flow: worker receives the recorded audio (as a decoded `Float32Array` at 16
  kHz, or a `Blob`/`ArrayBuffer` it decodes) plus the answer id; it posts back
  `{ answerId, transcript }` on success or `{ answerId, error }` on failure.
  The main thread then `PATCH`es the answer (see §2.4). Model load and
  inference are lazy: nothing loads until the user finishes their first
  recording.
- Transcription is **best-effort**. If the model cannot load (offline, blocked
  origin, wasm unsupported) or inference throws, the answer stays saved with
  `transcript_status='failed'` and the UI shows the gentle retry (§2.5). It
  must never block saving, playback, or advancing to the next question.
- A test seam is required so e2e is deterministic and offline (§4): gate the
  real worker behind a flag/injection so the failure path and a stubbed success
  path can be driven without downloading a model. E.g. read a
  `window.__ATL_TRANSCRIBE__` hook (or `import.meta.env`) that, when set to
  `"fail"`/`"stub"`, short-circuits the worker. The hook is inert in production.

### 2.4 API contracts (all under the existing Fastify app, all `requireAuth`)

Every route checks that the caller is a member of the space server-side
(reuse the `memberships` join pattern from `spaces.ts`). A well-formed id that
is not the caller's returns 403; an unknown id returns 404 (mirror
`GET /spaces/:id`). Inputs validated with Fastify JSON schema at the boundary.
Mutations get a per-route `rateLimit` config like the existing routes.

Body handling: the global `bodyLimit` is 32 KB. Keep all JSON routes under it.
The audio upload route accepts a raw binary body, so:
- Register an `application/octet-stream` content-type parser (`parseAs:
  "buffer"`).
- Give the audio route its own `bodyLimit` of `12 * 1024 * 1024` (12 MB).
Client caps recording length (see §2.5); server enforces the size cap and
rejects oversize bodies with 413 (Fastify default) surfaced as `copy.validation`
or a dedicated gentle message.

New routes (add `backend/src/routes/interview.ts`, register in `app.ts`):

1. `POST /spaces/:id/sessions` → start or resume.
   - Membership required. If an open session (`ended_at IS NULL`) exists for
     this membership, return it; otherwise create one.
   - Returns `{ id, space_id, started_at, ended_at }`.
   - Rate limit e.g. `{ max: 30, timeWindow: "1 minute" }`.

2. `GET /sessions/:id` → session + progress for resume.
   - Returns `{ session: {...}, answered_keys: string[],
     deferred_topics: string[], answers: AnswerSummary[] }` where
     `answered_keys` and `deferred_topics` span the **membership across the
     space** (not just this session row), so resume works across sittings.
   - `AnswerSummary`: `{ id, bank_question_key, prompt_text, topic,
     duration_ms, transcript_status, transcript, created_at }` (no bytes).
   - Cap the returned `answers` list (e.g. most recent 200) to stay off the
     unbounded-list bar.

3. `POST /sessions/:id/answers` → create the answer metadata row.
   - Body: `{ bank_question_key: string(1..200), prompt_text: string(1..1000),
     topic: string(1..100), duration_ms: integer(0..1_800_000) }`.
   - Creates the row with `transcript_status='pending'`. Returns
     `{ id, transcript_status }`.
   - Small JSON body; under the global limit.

4. `PUT /answers/:id/audio` → store the recorded bytes.
   - Content-Type `application/octet-stream`; body is the raw audio.
   - Query or header carries the mime (`?mime=audio/webm`); validate it is an
     allowed audio type (`audio/webm`, `audio/ogg`, `audio/mp4`,
     `audio/mpeg`, `audio/wav`). Reject others with 400.
   - Enforce size cap; store into `answer_audio`, set `answers.audio_mime` and
     `answers.audio_size`. Returns 204.
   - Idempotent-ish: a second PUT replaces the bytes (upsert on `answer_id`).

5. `PATCH /answers/:id` → attach transcript result.
   - Body: `{ transcript_status: "done" | "failed", transcript?: string(0..20000) }`.
   - `done` requires a `transcript`; `failed` clears/ignores it. Updates the
     row. Returns the updated `AnswerSummary`.

6. `GET /answers/:id/audio` → stream the audio back for playback.
   - Membership-scoped. Sets `Content-Type` from `audio_mime`,
     `Content-Length`, `Cache-Control: private, no-store`, and
     `Content-Disposition: inline`. Returns the bytes, or 404 if none.

7. `POST /sessions/:id/defer` → defer the current topic.
   - Body: `{ topic: string(1..100) }`. Upsert into `topic_deferrals`
     (`ON CONFLICT DO NOTHING`). Returns `{ ok: true }`.

8. `POST /sessions/:id/complete` → end the sitting.
   - Sets `ended_at = now()` if still open. Returns
     `{ id, ended_at, answered_count }` where `answered_count` is this
     session's answer count. Idempotent.

Add the new client methods to `frontend/src/api.ts` mirroring the existing
`api` object and `ApiError` handling. Audio upload uses `fetch` with a
`Blob`/`ArrayBuffer` body and the octet-stream content type (do not send the
default JSON content-type for that call).

### 2.5 Frontend

New route `space/:id/interview` (add to `App.tsx`, auth-gated like
`space/:id`). New page `frontend/src/pages/Interview.tsx` plus small
components under `frontend/src/interview/`.

Entry point: add a clear primary action on the space page
(`SpaceDetail.tsx`) — a single obvious button, e.g. "Record a memory" — that
navigates to the interview. It is the one primary action on that screen.

Interview screen behavior:
- On open, `POST /spaces/:id/sessions` then `GET /sessions/:id`. Compute the
  current question = first bank entry whose `key` is not in `answered_keys` and
  whose `topic` is not in `deferred_topics`.
- Show ONE question at a time, large and calm. No progress counter, no
  "X of Y". A quiet topic label is allowed; a countdown is not.
- Record control (`MediaRecorder`):
  - On tap, the button enters a pressed/preparing state **synchronously**
    (within 100 ms, before `getUserMedia` resolves) so the tap always feels
    acknowledged. When the stream is live, show a steady recording indicator
    (a dot / timer). These are CSS + immediate state, not awaiting the mic.
  - Cap length client-side (e.g. 5 minutes); auto-stop at the cap.
  - On stop: build the `Blob`, create an object URL, and show an inline
    `<audio controls>` for playback immediately (local, instant).
- Save flow (in order, with inline progress and optimistic UI):
  1. `POST /sessions/:id/answers` → answer id.
  2. `PUT /answers/:id/audio` with the blob. This is the save that matters; on
     success the answer is safe.
  3. Start transcription in the worker. While it runs, show a gentle inline
     state on the saved answer, e.g. "Writing down what you said." On success
     `PATCH` `done` and show the transcript; on failure `PATCH` `failed` and
     show a gentle line with a "Try transcribing again" button that re-runs the
     worker on the already-saved audio (re-fetch via `GET /answers/:id/audio`
     if the local blob is gone). The recording is never lost on failure.
- Advance: an "Ask the next one" action moves to the next eligible question.
  "Not this topic yet" calls `POST /sessions/:id/defer` with the current
  topic and advances past every question in that topic.
- Pause = simply leave (a quiet "Save and step away" / back action). Because
  `answered_keys` and `deferred_topics` persist, returning later resumes at the
  right question. Stop / "I'm done for now" calls
  `POST /sessions/:id/complete` and shows the completion surface.
- **Completion surface (success, not funnel):** warm heading and a plain count
  of what they recorded, in the product's voice, celebrating the sitting. It
  offers "Record another" and a link back to the person's space. It never
  frames the sitting as progress toward a quota and never shows remaining
  count. Suggested copy (swept): heading "You gave them your voice today.",
  body naming the person and the number of memories saved this sitting. Read
  everything you write against QUALITY BAR §8 and sweep it.
- **Designed states** (QUALITY BAR §3):
  - Empty/first view of the interview: says what this screen is for and shows
    the first question with the record control ready. No blank region.
  - Loading: skeletons that hold layout (reuse `.skeleton` classes), never a
    white screen.
  - Error (session load fails, save fails, mic permission denied): the
    product's voice, what to do next, a retry. Mic-denied is a designed,
    gentle state that tells the user how to allow the mic. No raw errors.
- **Mobile-first / a11y:** usable at 390 px with no horizontal scroll; touch
  targets ≥44 px (reuse `.btn` conventions, which are 44–48 px); visible focus
  states (global `:focus-visible` already covers this); the record control is a
  real `<button>` with an accessible label that reflects state
  (`aria-pressed` / label change); the recording indicator uses `role="status"`
  / `aria-live="polite"`; audio elements have labels; semantic headings.

### 2.6 CSP and config

Update `buildCsp` in `backend/src/lib/html.ts`:
- `script-src`: add `'wasm-unsafe-eval'` (Whisper wasm needs it), keeping the
  existing `'self' 'nonce-...'`.
- Add `worker-src 'self' blob:` and `child-src 'self' blob:` (worker created
  from a bundled script; blob covers bundler worker strategies).
- `connect-src`: add the model-weight host(s) as documented constants:
  `https://huggingface.co` and `https://*.hf.co` (and `https://cdn-lfs.huggingface.co`
  if the pinned model resolves there). Keep `'self'` and the existing dynamic
  Sentry/Umami origins. Add a comment explaining that only public model weights
  are fetched, never user audio.
- `img-src`/`media-src`: ensure media playback works. Add `media-src 'self'
  blob:` so the local object-URL playback and same-origin `GET /answers/:id/audio`
  both play.

If a test asserts CSP contents (see EPIC 1 tests), update it to match.

Frontend deps: add `@xenova/transformers` to `frontend/package.json`
dependencies. Confirm the Vite build bundles the worker and the ONNX wasm as
static assets served `'self'`. Keep the image lean; do not commit model
binaries to the repo (weights are fetched and cached at runtime).

### 2.7 Files to touch

- `backend/migrations/0002_interview.sql` (new)
- `backend/src/routes/interview.ts` (new); register in `backend/src/app.ts`
- `backend/src/app.ts`: octet-stream content-type parser; register routes
- `backend/src/lib/html.ts`: CSP updates
- `backend/src/lib/copy.ts`: any new server messages (keep swept)
- `frontend/src/interview/bank.ts` (new), `transcribe.worker.ts` (new),
  supporting components
- `frontend/src/pages/Interview.tsx` (new); route in `frontend/src/App.tsx`
- `frontend/src/pages/SpaceDetail.tsx`: primary "Record a memory" action
- `frontend/src/api.ts`: new client methods
- `frontend/package.json`: `@xenova/transformers`
- `frontend/src/styles.css`: interview + recording + completion styles
- Tests per §4
- `README.md`: a short "Recording an interview" note; state that transcription
  runs on-device in the browser, that audio never leaves the device, and that
  model weights download once from Hugging Face and are cached. Verify any run
  commands still match the compose files. Sweep it.

---

## 3. Ordered task list (each with acceptance criteria)

**T1 — Migration and schema.**
Add `0002_interview.sql`. AC: `runMigrations` applies it on a fresh PGlite and
Postgres; the four tables and indexes exist; a migration test asserts presence.

**T2 — Session + progress endpoints.**
`POST /spaces/:id/sessions`, `GET /sessions/:id`. AC: non-member gets 403,
unknown space 404, unauthenticated 401; a second `POST` for the same membership
returns the same open session (resume), not a duplicate; `GET` returns
`answered_keys` and `deferred_topics` for the membership; list is capped.

**T3 — Answer create + audio store + playback.**
`POST /sessions/:id/answers`, `PUT /answers/:id/audio`, `GET /answers/:id/audio`.
AC: metadata validated at boundary (bad types/oversize → 400/413, never 500);
audio round-trips byte-for-byte with the stored mime; a non-member cannot read
another family's audio (403/404); audio persists across a simulated restart
(new app instance, same DB).

**T4 — Transcript attach + graceful failure.**
`PATCH /answers/:id`. AC: `done` with transcript sets status and text; `failed`
sets status and leaves the audio intact; a `done` without transcript is
rejected; audio row is untouched by either.

**T5 — Defer + complete.**
`POST /sessions/:id/defer`, `POST /sessions/:id/complete`. AC: deferring a
topic adds it once (idempotent) and it appears in `deferred_topics`; complete
sets `ended_at` and is idempotent; deferred topics are excluded from the
computed next question.

**T6 — Question bank + client session logic.**
`bank.ts` and the next-question computation. AC: every bank entry passes
`npm run copy-sweep`; the client picks the first unanswered, non-deferred
question in bank order; when none remain it shows completion, not an error.

**T7 — Recording, playback, save, worker.**
`Interview.tsx`, recorder, worker, `api.ts` methods. AC: tap-to-record shows a
pressed/recording state within 100 ms; stop yields immediate local playback;
save persists audio; the worker transcribes off the main thread; failure keeps
the recording and shows a gentle retry that re-runs transcription.

**T8 — Pace controls + completion surface.**
Pause (leave/return resumes correctly), stop→complete, defer topic, and the
warm completion surface. AC: reloading mid-interview resumes at the right
question; a completed sitting shows a success surface with no funnel framing.

**T9 — States, mobile, a11y, CSP, copy sweep.**
Designed empty/loading/error (including mic-denied) states; 390 px with no
horizontal scroll; ≥44 px targets; focus states; CSP updated so the worker,
wasm, and playback work; full copy sweep of every string added. AC: all of §5
pass.

---

## 4. Test plan (which automated test proves each criterion)

Backend (Vitest + PGlite, pattern from `backend/test/spaces.test.ts` and
`helpers.ts`):
- `interview.test.ts`:
  - session create/resume returns same open session; 401/403/404 authz cases.
  - `GET /sessions/:id` returns correct `answered_keys` / `deferred_topics`.
  - answer create boundary validation (oversize `duration_ms`, missing fields →
    400, not 500).
  - audio upload + `GET` round-trips bytes and mime; oversize body rejected;
    disallowed mime rejected; cross-family read blocked.
  - `PATCH` done/failed transitions; `done` without transcript rejected;
    `answer_audio` untouched on `failed`.
  - defer idempotent + reflected in progress + excluded from next-question
    (compute helper can be unit-tested if factored server-side, else asserted
    via `deferred_topics`).
  - complete sets `ended_at`, idempotent.
- `persistence`-style check: audio saved by one app instance is readable by a
  fresh instance on the same PGlite dir (mirrors EPIC 1's restart test).
- `migrate.test.ts`: new tables present after migration.

Copy sweep:
- `npm run copy-sweep` passes with the bank and all new UI copy present (the
  bank lives under `frontend/src`, already scanned). This is a required gate.

E2E (Playwright, extend `e2e/`):
- Enable fake media: add Chromium args
  `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream` (and, if
  a deterministic waveform helps, `--use-file-for-fake-audio-capture`) via
  `playwright.config.ts` `launchOptions.args` or per-test context. Set the
  transcription test seam (§2.3) so no model downloads in CI.
- `interview.spec.ts`:
  - sign in, create a space, open the interview, see one question and the
    record control.
  - record a short clip (fake mic), stop, see local playback, and confirm the
    answer persisted (reload the interview and see it is not re-asked).
  - drive the transcription **failure** path via the seam: the recording is
    still present and a gentle retry is shown (no raw error, no lost audio).
  - defer a topic and confirm the next question is from a different topic.
  - complete the sitting and see the success surface (no "X of Y").
  - at 390 px viewport, assert `document.scrollWidth <= clientWidth` on the
    interview screen (no horizontal scroll).

---

## 5. Definition of done (maps to planner acceptance criteria)

1. **Record, play back, persist audio + transcript; graceful transcription
   failure.** T3, T4, T7 and their tests. Audio survives restart; a failed
   transcription keeps the audio and shows a gentle retry.
2. **Bank drives one-question-at-a-time; pause / stop / resume / defer.** T2,
   T5, T6, T8 and tests; reload resumes at the correct question.
3. **A completed session is presented as success, not a funnel step.** T8; e2e
   asserts the success surface and the absence of "X of Y" framing.
4. **Every bank question passes the copy sweep.** T6; `npm run copy-sweep`
   gate. No em-dashes, no banned vocabulary, plain and gentle.
5. **100 ms interaction feedback; mobile-first at 390 px; ~44 px targets.** T7,
   T9; e2e no-horizontal-scroll check; pressed/recording state within 100 ms.

Plus the always-in-scope QUALITY BAR: designed empty/loading/error states
(including mic-denied), security hygiene on every new route (server-side
membership checks, boundary validation, rate limits on mutations, no PII in
logs, no secrets), accessibility basics, and the full copy sweep across every
new string. The emotional-safety differentiator governs the bank wording, the
no-funnel completion, and the gentle failure copy.

---

## 6. Verification before you finish

Run to completion in the foreground, then write `result.json`:
- `npm test` (backend Vitest) — all green.
- `npm run copy-sweep` — passes.
- `npm run build` (both workspaces typecheck + build).
- `./scripts/e2e.sh` — the new interview spec passes with fake media and the
  transcription test seam.
Do not leave any suite running in the background.
