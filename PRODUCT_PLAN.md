# PRODUCT PLAN — Ask the Living

A patient biographer for the family that just lost someone.

## Core value (one sentence)

After a death, the app interviews each surviving family member by voice at
their own pace, asks the follow-ups a good biographer would, lays different
relatives' tellings of the same story side by side, and keeps a standing,
family-visible map of what nobody has answered yet, routing each open
question to the relative most likely to know.

## North star

Years from now the family opens this and hears the person's life told in the
voices of everyone who loved them, fuller than any one of them could have
told it alone. The holes are marked honestly, the disagreements are kept
instead of smoothed over, and some of the tellers are themselves gone by
then, their voices saved too. The feeling is relief and company: a family
that feared it was too late finds out how much it still held between its
members, and that it is safe here, gathered, and theirs to keep.

## Quality differentiator

**Emotional safety.** The one dimension this app must win on is how the
interview *feels*: like being heard by someone kind and unhurried who never
oversteps. Every other option either cannot interview at all (tribute walls,
prompt lists) or risks the clumsy, wounding question (a raw chatbot asking a
fresh widow "how did that make you feel?"). This app wins by never asking
that question. Restraint is engineered, tested against canned grief
scenarios, and tunable by the user's own pace. Speed and polish are the
quality bar's job; gentleness is the wedge.

## Signature moment

Your brother's telling of the same lake summer lands next to yours, and the
app asks each of you the one question the other's version left open. From
that beat the artifact is something no single relative could have made.

---

## MVP user stories

**Organizer (the adult child, the family's rememberer)**
- I can create a space for the person we lost and start talking the same
  night, before I invite anyone or paste any key.
- I record voice answers one question at a time, and I can pause, stop, or
  say "not this topic yet" without losing my place.
- I hear a follow-up a friend would not have thought to ask, and it feels
  gentle, never prying.
- I see a standing list of what nobody has answered yet, and I can send a
  specific question to the relative most likely to know.
- I can download everything (audio, transcripts, the story and the map) in
  open formats, from the first day.

**Invited relative (Aunt Carol, a sibling)**
- I open a link, say who I am to the person, and start talking. I never see
  a key or a setup screen.
- I answer the questions routed to me, and I can add memories of my own.

**The family, over weeks**
- When two of us have told the same story, we see both tellings side by side
  and each of us gets asked the question the other left open.
- The gap map shrinks as questions get answered, deferred, or marked lost
  with the person.

---

## Data model sketch

- **user** — organizer or contributor account. `id, email, display_name,
  created_at`.
- **space** — one remembered person. `id, subject_name, subject_dates?,
  created_by, created_at, pace_default`.
- **membership** — a person's link to a space. `id, space_id, user_id,
  relationship_to_subject, role(organizer|contributor), pace_pref`.
- **invite** — link token for a relative. `id, space_id, token, label,
  invited_relationship, status(pending|joined), expires_at`.
- **question** — a node on the gap map. `id, space_id, text,
  origin(bank|followup|routed|manual), status(open|answered|deferred|lost),
  assigned_to(membership_id?), parent_answer_id?, story_id?, created_at`.
- **story** — a topic that groups tellings across people (e.g. "the lake
  summer"). `id, space_id, label, created_at`.
- **session** — one sitting by one participant. `id, space_id, membership_id,
  started_at, ended_at?`.
- **answer** — a recorded reply. `id, session_id, question_id?, story_id?,
  audio_path, duration_s, transcript, transcript_status(pending|done|failed),
  created_at`.
- **llm_credential** — per-user BYOK pair, encrypted at rest, never returned
  in full. `user_id, base_url, key_ciphertext, provider_label`.
- **export** — a generated archive record. `id, space_id, path, created_at`.

Audio is the source of truth; the transcript is derived and may lag or fail
without losing the recording. Divergent tellings are never merged; the story
groups them and keeps them side by side.

## Screen / endpoint inventory

**Screens**
- First-run landing (organizer): what this is, one action — create a space.
- Sign in: email magic link.
- Space home: the person, participants, gap-map summary, start a session,
  invite, export.
- Interview session: one question at a time, record and playback, pace and
  "not this topic yet" controls.
- Gap map: standing questions with status filters, route action.
- Side-by-side tellings: two versions of one story plus the open question.
- Settings: LLM key (BYOK), pace and tone preference.
- Invite landing (relative): who you are to the person, then talk.

**Endpoints** (all authorization checked server-side, input validated at the
boundary, mutations and auth rate-limited)
- `GET /healthz`
- `POST /auth/magic-link`, `GET /auth/verify`
- `POST /spaces`, `GET /spaces/:id`
- `POST /spaces/:id/invites`, `GET /invite/:token`, `POST /invite/:token/join`
- `POST /sessions`, `GET /sessions/:id`, `POST /sessions/:id/answers`
- `GET /spaces/:id/questions`, `PATCH /questions/:id`,
  `POST /questions/:id/route`, `POST /answers/:id/followups`
- `GET /spaces/:id/stories`, `GET /spaces/:id/stories/:sid` (side-by-side)
- `POST /spaces/:id/export`, `GET /exports/:id`
- `PUT /me/llm-credential`, `DELETE /me/llm-credential`

---

## Runtime LLM plan (bring-your-own-key first)

The adaptive follow-ups and the cross-telling "one open question" need a
runtime text model. Degradation is designed in three tiers:

1. **No key.** The interview runs off a curated biographer question bank.
   The corpus records, the gap map is tended by hand, side-by-side tellings
   still render. This is already a better StoryWorth Memorials. First value
   (a recorded session with good questions) is reached here, before any key.
2. **BYOK.** The organizer pastes an OpenAI-compatible base URL and key once,
   in settings. Stored per user, encrypted, never logged or echoed back in
   full, sent only to that endpoint. Adaptive follow-ups and auto-alignment
   light up. Invited relatives never see this surface.
3. **Gated gateway grant.** If the owner grants it, the same client points at
   `LLM_GATEWAY_URL` with `LLM_API_KEY`, unlocked for invited/validated users
   only. Budget exhaustion degrades exactly like "no key."

One client code path serves all three. Transcription runs on-device in the
browser (Whisper-class via a web worker), which is both the right privacy
posture for grief audio and keeps server-side audio cost at zero.

---

## EPIC list (build order)

### EPIC 1 — Foundation, organizer sign-in, and staging deploy
**Scope.** Repo scaffold (backend, Postgres, frontend), organizer magic-link
auth, create-a-space, health endpoint, error tracking (`SENTRY_DSN`) and
analytics (`UMAMI_WEBSITE_ID`) wiring, and the full staging deploy scaffold.
**Acceptance criteria**
- `Dockerfile` and `docker-compose.staging.yml` build and bring the app up
  clean from `docker compose -f docker-compose.staging.yml up`, with
  `GET /healthz` returning 200 and a `SEED_DEMO=1` hook present (seed content
  arrives in EPIC 5).
- An organizer signs in by email magic link and creates a space for a named
  person; the space persists across restart.
- Every route checks authorization server-side; auth and mutation endpoints
  are rate-limited; secrets load from env only; `.env.example` carries
  placeholders.
- First meaningful render under ~1s; empty, loading, and error states are
  designed (no blank screens, no raw stack traces); usable at 390px with no
  horizontal scroll.

### EPIC 2 — The voice interview loop (solo, key-free)
**Scope.** Record voice answers in the browser (MediaRecorder), play them
back, transcribe on-device in a worker, and drive a session from a curated
biographer question bank with pace and "not this topic yet" controls.
**Acceptance criteria**
- A signed-in organizer records an answer, plays it back, and the audio plus
  a derived transcript persist; if transcription fails the recording is still
  saved and the failure is shown gently with a retry.
- The question bank drives a one-question-at-a-time session; the user can
  pause, stop, resume where they left off, and defer a topic.
- A single completed session is presented as a success, not a funnel step.
- Every bank question passes the copy sweep (no em-dashes, no banned LLM
  vocabulary, positive and plain, gentle in register).
- Interaction feedback within 100ms (pressed/recording states); mobile-first
  at 390px; touch targets ~44px.

### EPIC 3 — Adaptive follow-ups and the living gap map
**Scope.** LLM settings surface (BYOK base URL + key; gateway tier gated by
invite), one client path, restrained follow-up generation from a transcript,
and the standing family-visible gap map those follow-ups feed. Includes a
grief-tone test harness.
**Acceptance criteria**
- BYOK pair is stored per user, encrypted, never logged or echoed in full,
  sent only to the entered endpoint; a delete control removes it.
- Each answer can spawn follow-up questions that land on the gap map with
  `origin=followup`; without a key the loop falls back to the bank and never
  crashes or blocks.
- The gap map lists every open question with status (open, answered,
  deferred, lost with them), filterable by topic and person; the visible
  count shrinks as questions resolve.
- A canned-scenario test suite exercises the interviewer against sensitive
  grief prompts (fresh widow, a child, a recent suicide, an estranged
  parent) and asserts the follow-ups stay within the restraint rules; this
  suite is part of the epic's DONE, not optional.
- Generated question copy passes the copy sweep before it can be shown.

### EPIC 4 — Invites and question routing
**Scope.** Invite a relative by link; they join with a lightweight tokened
identity and talk; route an open question to a named relative; the answer
flows back onto the map.
**Acceptance criteria**
- The organizer generates an invite link; a relative opens it, states their
  relationship to the person, and reaches the interview without seeing any
  key or settings surface.
- An open question can be routed to a specific membership; it appears in that
  person's session and, once answered, updates on the shared gap map.
- Invite tokens expire and are single-family scoped; every relative route
  enforces membership server-side; no participant sees another's raw session
  until a story is aligned.

### EPIC 5 — Side-by-side tellings (the signature moment)
**Scope.** When two participants cover the same story, render their tellings
side by side and pose to each the one question the other's version left open.
Story tagging is LLM-assisted with a key and manual without. Seed a demo
family so the moment is demonstrable on staging.
**Acceptance criteria**
- Two tellings tagged to the same story render side by side; the app
  generates and poses the single open question each version leaves for the
  other, in the restrained voice.
- Divergent tellings are kept side by side, never merged into one summary.
- `SEED_DEMO=1` seeds a small demo family (one person, two relatives, two
  tellings of one story) so a first-time visitor sees the side-by-side moment
  on staging within a minute, with no hand-crafted input and no real second
  party. All seeded copy passes the copy sweep.
- The feature works with a key; without one, participants can group tellings
  by hand and still see them side by side.

### EPIC 6 — Export (the family keeps everything)
**Scope.** One-click export of audio files, transcripts, and the story and
gap-map structure in open formats. This is a launch requirement and is not
cuttable.
**Acceptance criteria**
- Export produces a self-contained archive: original audio files, transcripts
  (plain text and JSON), the story structure, and the gap map including its
  closed and permanently-open items.
- Formats are open and documented in the README; the archive is portable and
  survives the app disappearing.
- Export is reachable from the space home in one action, with progress
  feedback and a designed completion state.

### EPIC 7 — Polish (UX / performance pass, no new features)
**Scope.** A pass over the whole delivered product against the quality bar
and the emotional-safety differentiator. No new features; tighten what
exists.
**Acceptance criteria**
- **First-run walkthrough:** a brand-new organizer is actively led through
  the core action once, in a skippable 2–4 step guided path anchored to the
  real controls (create the space, record the first answer, hear the first
  follow-up). It appears only until first success and never again.
- Full copy sweep across every user-visible string (components, pages, bank
  questions, seed copy, errors, emails): no "—" or "–", none of the banned
  LLM vocabulary, no negative empty-state phrasing; every empty, loading, and
  error state is designed and in the product's voice.
- Perceived speed verified: first meaningful render ~1s, interaction feedback
  within 100ms, no unindexed hot-path queries, gap-map and corpus lists
  paginated or capped.
- Accessibility: color contrast, visible focus states, labeled inputs,
  semantic headings and landmarks, full keyboard reach.
- Mobile-first verified end to end at 390px on every screen.
- Staging demo verified: the seeded family shows the side-by-side signature
  moment within a minute of landing.
- README for strangers: what it is, how to run it (verified against the
  compose files), how to contribute and run the tests. No pipeline jargon.

---

## Non-Goals / Out of scope

- **Never synthesize the deceased's voice or persona.** No cloned voice, no
  "talk to Dad" avatar, no generated speech of the dead. This constraint is
  the product's position, not a limitation.
- No condolence wall, guestbook, or public tribute page.
- No printed keepsake book, photo galleries, or rich media timelines.
- No merging divergent tellings into one authoritative summary; the
  disagreements are the record.
- No communities beyond a single family (congregations, regiments) in v1.
- No live "gathering recorder" (multi-speaker room diarization) in v1.
- No video capture; audio only.
- No social feeds, public sharing, discovery, or moderation.
- No grief counseling, therapy, or clinical advice.
- No native mobile apps; a mobile-first web app only.
- No server-side audio ML; transcription stays on-device.
