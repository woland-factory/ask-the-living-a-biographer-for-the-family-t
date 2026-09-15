# EPIC SPEC — Adaptive follow-ups and the living gap map

## Quality differentiator (this EPIC is where it is won)

**Emotional safety.** The interview must feel like being heard by someone
kind and unhurried who never oversteps, and it wins by never asking the
clumsy, wounding question a raw chatbot or a fixed prompt list would ask.

**What it demands of THIS EPIC:** this is the EPIC that first puts a model
between a grieving person and a generated question. Every other EPIC can
lean on curated, hand-written copy. Here the words are produced at runtime,
so restraint cannot be a hope pinned on a prompt. It must be **engineered
and tested**: a deterministic guardrail sits after the model and drops any
candidate that strays, and a canned grief-scenario suite proves the
guardrail holds against the exact questions that would wound (a fresh
widow, a child, a recent suicide, an estranged parent). A generated
question that is merely "usually fine" is a defect. The safe default when
nothing gentle can be asked is **silence**, never a risky question.

---

## 1. Scope

### In scope
- A per-user **LLM settings surface** (bring-your-own-key): base URL + API
  key + optional model, stored encrypted, shown only redacted, removable.
- **One client code path** that serves BYOK today and the owner-granted
  gateway tier when present, gated so it is never the anonymous default.
- **Restrained follow-up generation** from a saved answer's transcript,
  with a deterministic restraint guardrail and a copy sweep applied before
  any generated question can be stored or shown.
- The standing, family-visible **gap map**: every open question in a space
  with status (open, answered, deferred, lost with them), filterable by
  topic and by person, with a visible open-count that shrinks as questions
  resolve. Unanswered bank questions and generated follow-ups both live
  here.
- Serving a freshly generated follow-up back into the same member's
  interview loop as the next question they may answer or leave on the map.
  Without a key the loop simply continues from the bank.
- A **grief-tone test harness** (canned scenarios) that is part of DONE.

### Out of scope (non-goals — binding)
- **No cross-person side-by-side** tellings. That is EPIC 5. A follow-up is
  attributed to the member whose telling spawned it; comparing two members'
  tellings of one story is not built here.
- **No routing between relatives.** That is EPIC 4. Questions carry no
  `assigned_to` in this EPIC, and there is no "send this to Aunt Carol"
  action. The gap-map person filter reflects who a question belongs to, not
  a routing target.
- **Never fund anonymous LLM usage.** No app-owned key is ever used for a
  user who has neither entered a BYOK pair nor been explicitly granted the
  gateway tier by the owner. With no access, the feature is simply off.
- No invites (EPIC 4), no export (EPIC 6), no first-run walkthrough
  (EPIC 7). New surfaces still meet the QUALITY BAR (see §11).

---

## 2. How this builds toward the signature moment

The product's signature moment (EPIC 5) is your telling and your brother's
telling of the same summer landing side by side, and the app asking each of
you the one question the other's version left open. **This EPIC builds the
"one open question" mechanic in its single-person form**: the app reads what
you just said and, when it can do so gently, asks the one question your own
telling left open. The restraint engineering and the gap map delivered here
are the exact machinery EPIC 5 reuses across people. Depth on the gentle
follow-up is the point; breadth is not.

---

## 3. Technical design

### 3.1 Data model — migration `backend/migrations/0003_followups.sql`

Forward-only, in the house style (lowercase types, `gen_random_uuid()`,
partial/plain unique indexes, indexes on every hot filter path).

```sql
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
```

Notes:
- `membership_id ON DELETE SET NULL` keeps a question on the map even if a
  member is later removed; the question falls back to "for anyone".
- No `assigned_to` and no `story_id` columns are added here. EPIC 4 and
  EPIC 5 add them as their own forward-only migrations. Do not add
  speculative columns.

### 3.2 The question bank as a single source of truth

The gap map must show unanswered bank questions as open gaps, so the
backend needs the bank that today lives only in
`frontend/src/interview/bank.ts`. Avoid a silent duplicate.

- Extract the bank data to `shared/bank.json` at the repo root: an array of
  `{ "key": string, "topic": string, "text": string }` in interview order,
  holding exactly the 16 entries currently in `frontend/src/interview/bank.ts`.
- `frontend/src/interview/bank.ts` imports `shared/bank.json` for its `BANK`
  array and keeps `TOPIC_LABELS`, `topicLabel`, `nextQuestion`, and the
  `BankQuestion` type unchanged. Frontend behavior is identical.
- Backend adds `backend/src/interview/bank.ts` that imports the same JSON and
  exports the typed `BANK` list for seeding. Enable `resolveJsonModule` in
  the tsconfigs that need it (Vite reads JSON natively).
- The JSON is scanned by the copy sweep (extend `scripts/copy-sweep.mjs`
  `TARGET_FILES` to include `shared/bank.json`) so bank copy stays swept from
  a single place.

Bank rows are seeded per space **idempotently** by
`seedBankQuestions(db, spaceId)`:
```sql
INSERT INTO questions (space_id, origin, topic, text, bank_question_key, status)
VALUES ($1, 'bank', $2, $3, $4, 'open')
ON CONFLICT (space_id, bank_question_key) DO NOTHING;
```
Call it on `POST /spaces/:id/sessions` (so a space gets its map the moment
an interview starts) and at the top of `GET /spaces/:id/questions` (so
spaces created before this migration seed on first visit). It is safe to run
repeatedly.

### 3.3 Config and environment

Add to `AppConfig` / `loadConfig()` (`backend/src/config.ts`):
- `llmCredSecret: string` — key material for credential encryption. Read
  `LLM_CRED_SECRET`, falling back to `SESSION_SECRET`, falling back to the
  existing dev-only default. Production should set a dedicated value.
- `llmGatewayUrl: string` — `LLM_GATEWAY_URL` (default `""`).
- `llmApiKey: string` — `LLM_API_KEY` (default `""`).
- `llmGatewayModel: string` — `LLM_GATEWAY_MODEL` (default `claude-haiku`;
  must be a catalog id: `claude-sonnet`, `claude-haiku`, `gpt-4o`,
  `gpt-4o-mini`, `mistral-large`, `groq-llama`).
- `llmGatewayAllowEmails: string[]` — parsed from `LLM_GATEWAY_ALLOW_EMAILS`
  (comma-separated, normalized lowercase). The owner's explicit-grant list.

Add these to `.env.example` with placeholder/empty values and a one-line
comment each. Add the same names to the `environment:` list in
`docker-compose.staging.yml` (inert when empty). No secret is ever
committed.

### 3.4 Credential encryption — extend `backend/src/lib/crypto.ts`

Add AES-256-GCM helpers (Node `crypto`, no new dependency):
- `deriveKey(material: string): Buffer` — `scryptSync(material, "atl-llm-cred", 32)`.
- `encryptSecret(plaintext, material) => { ciphertext, iv, tag }` (all base64):
  random 12-byte iv, `createCipheriv("aes-256-gcm", key, iv)`.
- `decryptSecret({ ciphertext, iv, tag }, material) => string`.

The plaintext key exists in memory only at store time and at call time. It
is written to the DB only as ciphertext. It is never returned to any client
and never logged.

### 3.5 One LLM client path — `backend/src/lib/llm.ts`

```ts
export type LlmMode = "byok" | "gateway" | "off";
export interface LlmAccess { mode: LlmMode; baseUrl: string; apiKey: string; model: string; }
export type ChatFn = (args: {
  baseUrl: string; apiKey: string; model: string;
  messages: { role: "system" | "user"; content: string }[];
  timeoutMs: number; signal?: AbortSignal;
}) => Promise<string>;
```

- `resolveLlmAccess(db, user, config): Promise<LlmAccess>` resolves in strict
  priority:
  1. **BYOK** — the user has a row in `llm_credentials`. Decrypt the key,
     use its `base_url`/`model`.
  2. **Gateway** — no BYOK, and `config.llmGatewayUrl && config.llmApiKey &&
     gatewayEligible(user, config)`. Use `LLM_GATEWAY_URL`, `LLM_API_KEY`,
     `LLM_GATEWAY_MODEL`.
  3. **Off** — otherwise (`mode: "off"`).
- `gatewayEligible(user, config)`: EPIC 3 returns true only when the user's
  email is in `config.llmGatewayAllowEmails` (the owner's explicit grant).
  This is the "explicitly validated by the owner" path from the capability
  contract and needs no invites. Add a code comment marking this as the
  extension point EPIC 4 widens to invited users. It must never default to
  true for an anonymous or ordinary signed-in user.
- The real `chat` (default export used by routes) POSTs
  `${baseUrl}/chat/completions`, OpenAI-compatible, with
  `Authorization: Bearer ${apiKey}`, a short timeout (default 20s via
  `AbortController`), and **no retries**. It returns the assistant message
  text. On any non-2xx, timeout, or network error it throws a **scrubbed**
  error whose message contains neither the key nor the full URL (only the
  host and status). Callers treat a throw as "no follow-up this time".
- **Outbound-URL guard** `assertSafeOutboundUrl(rawUrl)` (used at credential
  store time and before every call): require `https:` (allow `http:` only for
  `localhost`/`127.0.0.1` in non-production, to keep local dev workable);
  reject IP-literal hosts in loopback/private/link-local ranges
  (`127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`),
  the cloud metadata IP `169.254.169.254`, and hostnames ending in
  `.internal`/`.local` or matching the central service hostnames
  (`central-mailer-prod-api`, anything with `-prod-` internal). This blunts
  SSRF via a user-controlled base URL. Document DNS-rebinding as a known
  residual risk (out of scope to fully close here).

### 3.6 Follow-up generation and the restraint guardrail — `backend/src/lib/followups.ts`

Pure, individually testable functions plus one orchestrator:

- `buildFollowupPrompt(ctx): { role, content }[]` where `ctx` carries
  `subjectName`, `topicLabel`, and the answer `transcript`. The **system
  message** encodes the restraint rules in the product's own gentle voice
  and instructs the model to return at most one short question, grounded in
  something the teller actually said, or the literal token `NONE` when no
  gentle question fits. It explicitly forbids the wounding moves listed in
  the restraint rules below.
- `parseCandidates(modelText): string[]` — split into candidate questions,
  trim, treat `NONE`/empty as no candidates.
- `passesRestraint(text): { ok: boolean; reasons: string[] }` — the
  deterministic guardrail. Rejects a candidate that violates ANY rule:

  **Restraint rules (all must hold):**
  1. **Exactly one question.** One sentence ending in `?`, no second `?`,
     no stacked clauses that hide a second ask.
  2. **Never about the death, dying, cause, or manner.** Reject any match of
     a death/harm lexicon: `die|died|death|dying|dead|passed away|funeral|
     burial|grave|cause of death|suicide|kill|overdose|illness|cancer|
     accident|hospice`. Cause of death is never introduced by the app.
  3. **No prying at feelings.** Reject `how (did|does|do).*feel`,
     `how are you (doing|coping|holding up)`, `coping`, `closure`,
     `move on`, `get over`.
  4. **No pressure or blame.** Reject `regret|guilt|blame|fault|
     should have|whose fault|why (did|do) (you|they)|worst|suffer|
     suffering|pain|last words|say goodbye|warning signs`.
  5. **Short.** Length `<= 140` characters.
  6. **Passes the copy sweep** (see §3.7): no em/en dash, no banned LLM
     vocabulary, no negative empty-state phrasing.
  7. **Grounded and gentle in register** (prompt-enforced; the deterministic
     layer enforces 1–6). Second-person interrogation of feelings is caught
     by rules 3–4.

  Matching is case-insensitive, on word boundaries. When in doubt the
  guardrail rejects. Rejection is safe; a dropped candidate simply means no
  follow-up.
- `filterCandidates(candidates): string[]` — keep only `passesRestraint`
  survivors, de-duplicate, cap at **2**.
- `generateFollowups({ access, chat, ctx }): Promise<string[]>` — when
  `access.mode === "off"` return `[]` immediately (no call). Otherwise call
  `chat` with the built prompt and the resolved access, then
  `filterCandidates(parseCandidates(text))`. Any thrown error (timeout,
  non-2xx, parse) resolves to `[]`. It never throws and never blocks.

Because `filterCandidates` runs on every path, **nothing wounding and
nothing that fails the copy sweep can ever be stored** — this is the
engineered restraint the differentiator requires.

### 3.7 Shared copy rules — `backend/src/lib/copy-rules.ts`

Extract the copy-sweep checks into a reusable module so the runtime
guardrail and the static sweep agree:
- Export `COPY_CHECKS` (the same em-dash, en-dash, banned-vocabulary,
  banned-phrase, and negative-phrasing regexes currently inlined in
  `scripts/copy-sweep.mjs`) and `copyViolations(text): string[]`.
- `passesRestraint` calls `copyViolations` for rule 6.
- A unit test asserts the runtime list catches every pattern the static
  script lists (guards against the two drifting apart). The standalone
  `scripts/copy-sweep.mjs` may keep its own literal list; the test is the
  anti-drift guard.

### 3.8 API contracts

All routes: `preHandler: requireAuth`, membership checked server-side,
input validated at the boundary, mutations rate-limited (reuse the existing
`mutate` config, `{ max: 60, timeWindow: "1 minute" }`), product-voice error
copy only. Invalid or non-UUID ids return 404; a member of another space
gets 403; these mirror the existing interview routes.

**Credentials (per user)** — new file `backend/src/routes/settings.ts`,
registered in `app.ts`:

- `GET /me/llm-credential` → 200
  ```json
  { "configured": true, "provider_label": "OpenAI", "base_url": "https://api.openai.com/v1",
    "model": "gpt-4o-mini", "key_last4": "1234",
    "gateway_available": false }
  ```
  When no row exists: `{ "configured": false, "gateway_available": <bool> }`.
  `gateway_available` reflects `gatewayEligible(user)` plus gateway env
  present, so the UI can tell an eligible user follow-ups already work
  without a key. The full key is never present in any response.

- `PUT /me/llm-credential` (rate-limited) — body:
  ```json
  { "base_url": "https://api.openai.com/v1", "api_key": "sk-...",
    "model": "gpt-4o-mini", "provider_label": "OpenAI" }
  ```
  Schema: `base_url` 1–2000 chars, `api_key` 1–500, `model` 1–100 optional
  (default `gpt-4o-mini`), `provider_label` 0–100 optional,
  `additionalProperties: false`. Validate `assertSafeOutboundUrl(base_url)`;
  reject with 400 + `copy.validation` on failure. Encrypt the key, upsert the
  row (`ON CONFLICT (user_id) DO UPDATE`, refresh `updated_at`), store
  `key_last4`. Respond 200 with the same redacted shape as `GET`. The key
  never appears in the response.

- `DELETE /me/llm-credential` (rate-limited) → `DELETE FROM llm_credentials
  WHERE user_id = $1`; 204 whether or not a row existed (idempotent).

**Follow-ups** — add to `backend/src/routes/interview.ts`:

- `POST /answers/:id/followups` (rate-limited) → membership-checked via the
  existing `requireAnswer`. Behavior:
  - If the answer has no completed transcript (`transcript_status !== 'done'`
    or empty text) → 200 `{ "followups": [], "mode": "<mode>" }`, no rows.
  - Resolve access; if `off` → 200 `{ "followups": [], "mode": "off" }`, no
    rows (this is the "falls back to the bank" path; the client just asks the
    next bank question).
  - Otherwise `generateFollowups`, then insert each survivor as a `questions`
    row: `origin='followup'`, `membership_id = answer.membership_id`,
    `topic = answer.topic`, `parent_answer_id = answer.id`, `status='open'`.
    De-duplicate against existing open followups already stored for this
    `parent_answer_id` (skip identical text). Cap at 2 per answer.
  - Return 200 `{ "followups": [{ id, text, topic }...], "mode": "<mode>" }`.
  - The `chat` transport is taken from an injectable seam (see §3.9) so this
    route is testable without a network.

**Gap map** — new file `backend/src/routes/questions.ts`, registered in
`app.ts`:

- `GET /spaces/:id/questions?status=&topic=&membership_id=` → after
  membership check and idempotent `seedBankQuestions`, return:
  ```json
  {
    "questions": [
      { "id": "...", "text": "...", "topic": "everyday", "origin": "followup",
        "status": "open", "membership_id": "...", "parent_answer_id": "...",
        "created_at": "..." }
    ],
    "counts": { "open": 12, "answered": 4, "deferred": 1, "lost": 0, "total": 17 },
    "people": [ { "membership_id": "...", "relationship_to_subject": "daughter" } ],
    "topics": ["beginnings","family","everyday", "..."]
  }
  ```
  - `counts` are **unfiltered** (whole space) so the open-count stays stable
    while the user filters; the `questions` list honors the filters.
  - Filters: `status` in the enum, `topic` a known topic, `membership_id` a
    UUID (or the literal `anyone` to select `membership_id IS NULL`).
    Unknown filter values → 400 `copy.validation`.
  - Ordered `status='open' first, then created_at DESC`. Capped at
    `LIMIT 500` (a family's map is bounded: 16 bank + follow-ups). Add a code
    comment that pagination is the extension point if a space ever exceeds
    the cap. All filter columns are indexed (§3.1), so no unindexed hot-path
    query.

- `PATCH /questions/:id` (rate-limited) — body `{ "status":
  "open"|"answered"|"deferred"|"lost" }`, `additionalProperties: false`.
  Membership-checked (load the question, confirm caller is a member of its
  space; unknown id → 404, non-member → 403). Set `status`; set
  `resolved_at = now()` when moving out of `open`, `NULL` when moving back to
  `open`. Return 200 with the updated row. This is how `deferred` and
  `lost with them` are reached, and how a user resolves a follow-up by hand.

**Answer flow changes** — in `POST /sessions/:id/answers`
(`backend/src/routes/interview.ts`):
- Accept an optional `question_id` (UUID) in the body schema. When present,
  validate it is a `questions` row in the same space; store it on the answer.
- After inserting the answer, inside the same handler resolve the matching
  gap-map question to `answered`:
  - If `question_id` was given → mark that question `answered`,
    `resolved_at=now()`.
  - Else mark the family-wide bank row for this `bank_question_key`:
    `UPDATE questions SET status='answered', resolved_at=now()
     WHERE space_id=$1 AND bank_question_key=$2 AND origin='bank'
       AND status='open'`.
- Extend `GET /sessions/:id` to also return this member's **open followups**
  so the interview can serve them:
  `followups: [{ id, text, topic }]` where `origin='followup'`,
  `status='open'`, `membership_id = session.membership_id`.

### 3.9 Test seam for the LLM

`buildApp` gains an optional `opts.llm?: { chat?: ChatFn }`. When provided,
the followups route uses it; otherwise it uses the default fetch-based
`chat`. Production never sets it. Tests pass a fake `chat` to exercise the
"with key" path deterministically with no network. `resolveLlmAccess`
remains DB/config-driven so tests set access by seeding a credential row or
by config.

### 3.10 Frontend

Add to `frontend/src/api.ts` typed methods for every endpoint above, in the
existing `request` style (bodyless requests send no JSON content-type). Add
the routes to `frontend/src/App.tsx`.

**Settings page** `frontend/src/pages/Settings.tsx`, route `/settings`,
linked from `TopBar` (and reachable from a space). One screen, one primary
action:
- Loads `GET /me/llm-credential`. Designed loading (skeleton) and error
  (retry) states.
- Not-configured state: a short plain explainer and a form. Base URL input
  prefilled `https://api.openai.com/v1`; API key input `type="password"`
  (write-only, never populated from the server); optional model (default
  `gpt-4o-mini`); optional provider label. Primary button **Save**. On
  success show the connected state.
- Configured state: shows provider label, base URL, model, and
  `Key ending in <last4>` (never the full key). A subordinate **Remove key**
  action calls `DELETE` and returns to the not-configured state.
- If `gateway_available` is true and no BYOK key is set, show a calm line
  that gentle follow-ups already work, and keep the form available.
- Mobile-first at 390px, ~44px touch targets, labeled inputs, visible focus,
  full keyboard reach. Every string passes the copy sweep.

**Gap map** `frontend/src/pages/GapMap.tsx`, route `/space/:id/questions`,
linked from `SpaceDetail` (a clear secondary link such as `What's still
open`). It shows:
- A header with the live open count (for example `12 still open`) that
  visibly drops when an item resolves (optimistic update within 100ms, then
  reconcile).
- Two filters: topic and person (person options come from `people`, plus a
  `For anyone` option for `membership_id IS NULL`). Status filter chips
  (`Open`, `Answered`, `Not yet`, `Lost with them`).
- A list of questions: text, topic label (via frontend `topicLabel`), a
  small origin marker distinguishing a follow-up from a bank question, and
  the person it belongs to (or `For anyone`). Each open item offers gentle
  resolve actions: `Mark answered`, `Not yet` (→ deferred), `Lost with them`
  (→ lost). Resolved items can be reopened.
- Designed empty state (when only the seeded bank remains, that is still a
  full list; a truly empty list only appears if a space has no questions,
  which the seed prevents, but handle it: `The map fills as you record.
  Record a memory to begin.`). Designed loading and error states.
- Mobile-first, a11y, copy-swept.

**Interview integration** `frontend/src/pages/Interview.tsx`:
- After an answer is saved and its transcript reaches `done`, call
  `POST /answers/:id/followups`. On a returned follow-up, present it inline
  in the interview card as the next gentle question with the label
  `A question your telling opened`, offering `Answer this now` (records a new
  answer with `question_id` set) or `Keep it on the map` (leaves it open).
  This is skippable and never blocks the flow.
- When there is no key or no follow-up comes back, the loop continues from
  the bank exactly as today (the fallback path). Nothing about the existing
  key-free interview regresses.
- Incorporate the member's open followups from `GET /sessions/:id`
  (`followups`) into the next-question selection so a follow-up left on the
  map earlier can be offered again to that member. Bank ordering is
  otherwise unchanged.

### 3.11 README and env docs

- `.env.example`: add `LLM_CRED_SECRET`, `LLM_GATEWAY_URL`, `LLM_API_KEY`,
  `LLM_GATEWAY_MODEL`, `LLM_GATEWAY_ALLOW_EMAILS`, each with a one-line
  comment and placeholder/empty value.
- `README.md`: a short, stranger-facing section explaining that follow-ups
  are optional and turned on by adding your own model key in Settings, that
  the key is stored for you alone and sent only to the address you enter,
  and that without a key the interview runs from the curated question bank.
  No factory internals. Verify the run/test commands still hold.

---

## 4. Security, privacy, logging (QUALITY BAR §5)

- **Authorization on every route** server-side (all new routes carry
  `requireAuth` and membership checks; credential routes are strictly the
  signed-in user's own row via `req.user.id`).
- **The key is never exposed.** Stored only as GCM ciphertext; returned only
  as `key_last4`; decrypted in memory only at store/call time; never logged;
  never in an error message (scrubbed in the client); Sentry keeps
  `sendDefaultPii: false` and request bodies are not logged. No PII (email,
  transcript text, key) in logs.
- **Key sent only to the entered endpoint** (BYOK) or the gateway
  (`LLM_GATEWAY_URL`) and nowhere else. SSRF guard on the user-controlled
  base URL per §3.5.
- **Input validated at the boundary** on every new route (JSON schema, enum
  checks, UUID checks, URL validation).
- **Rate limiting** on every new mutation (`PUT`/`DELETE` credential,
  `POST followups`, `PATCH questions`). Follow-up generation is additionally
  capped (2 per answer) to prevent runaway model calls.
- **Never fund anonymous usage**: `resolveLlmAccess` returns `off` unless the
  user has BYOK or is on the owner allow-list; the gateway key is never used
  otherwise. Budget exhaustion (429/400 from the gateway) degrades exactly
  like "no key": `generateFollowups` returns `[]`.

---

## 5. Ordered task list (each with acceptance criteria)

**T1 — Migration and the shared bank.**
- `0003_followups.sql` applies clean on a fresh DB and on top of 0002
  (verify via the existing migrate test path). `shared/bank.json` holds the
  16 bank entries; frontend and backend both import it; `npm test` and the
  frontend build pass. Copy sweep includes `shared/bank.json`.

**T2 — Crypto + config + client path.**
- `encryptSecret`/`decryptSecret` round-trip in a unit test; ciphertext
  differs from plaintext. Config exposes the five new values with correct
  defaults. `resolveLlmAccess` returns `byok`/`gateway`/`off` for the three
  cases; `gatewayEligible` is false for a non-listed user and true only for
  an allow-listed email. `assertSafeOutboundUrl` rejects http (non-local),
  loopback/private/link-local IPs, the metadata IP, and internal hostnames;
  accepts a normal https URL.

**T3 — Credential endpoints + settings UI.**
- `PUT` stores an encrypted row (DB row has ciphertext, correct `key_last4`,
  no plaintext key anywhere); `GET` returns the redacted view with no key;
  `DELETE` removes it and is idempotent; all three require auth; a bad base
  URL is rejected 400. The settings page saves, shows `Key ending in
  <last4>`, and removes, with designed loading/error/empty states, at 390px,
  copy-swept.

**T4 — Follow-up generation + restraint guardrail.**
- `passesRestraint` rejects every wounding fixture and accepts every gentle
  fixture (§6). `filterCandidates` drops wounding candidates, de-dupes, caps
  at 2. `generateFollowups` returns `[]` when `mode==='off'` and on any
  injected error, and returns only safe survivors otherwise. `copy-rules.ts`
  is the shared source and the anti-drift test passes.

**T5 — Follow-up endpoint + gap-map storage.**
- `POST /answers/:id/followups`: with an injected fake key returning safe
  candidates, follow-ups are stored with `origin='followup'`,
  `parent_answer_id`, and the member's `membership_id`, and returned; with a
  wounding candidate, nothing is stored; with no key, `{followups:[],
  mode:'off'}` and no rows; with no transcript, no rows. Auth + membership
  enforced. Rate-limited. Capped at 2 per answer.

**T6 — Gap map endpoints + page.**
- `GET /spaces/:id/questions` seeds the bank idempotently, lists open
  questions with the four statuses, filters by topic and person, returns
  stable unfiltered counts, and is capped/indexed. `PATCH /questions/:id`
  moves status and sets/clears `resolved_at`, membership-checked. Answering a
  bank question flips its family-wide row to `answered`; answering a
  follow-up (with `question_id`) flips that follow-up. The open count shrinks
  as questions resolve. The gap-map page renders all of this, mobile-first,
  a11y, copy-swept, with designed states.

**T7 — Interview integration.**
- After a saved answer transcribes, the interview offers at most one gentle
  follow-up inline (when a key is present and one survives), answerable now
  (with `question_id`) or leavable on the map, skippable, non-blocking.
  Without a key the loop continues from the bank with no regression to the
  EPIC 2 flow.

**T8 — The grief-tone harness (part of DONE).**
- `backend/test/followups.test.ts` runs the four canned scenarios (§6)
  against the guardrail and `generateFollowups` (fake `chat`), asserting no
  wounding follow-up ever survives and every survivor passes the copy sweep.
  It runs under `npm test` with no network.

**T9 — Docs, env, staging wiring, full sweep.**
- `.env.example`, `docker-compose.staging.yml`, and `README.md` updated per
  §3.11. `npm run copy-sweep`, `npm test`, and `./scripts/e2e.sh` all pass.
  Mechanical copy sweep run over every user-visible string added or changed.

---

## 6. Test plan (each acceptance criterion → the automated tests that prove it)

**AC: BYOK pair stored per user, encrypted, never logged or echoed in full,
sent only to the entered endpoint; a delete control removes it.**
- `backend/test/settings.test.ts`: `PUT` then read the raw row — `key_ciphertext`
  present, plaintext key absent, `key_last4` matches; `GET` body has no full
  key; `decryptSecret` recovers the key with the configured secret. `DELETE`
  removes the row and is idempotent (204 twice). Auth required (401 without a
  cookie). Bad base URL → 400.
- `backend/test/crypto.test.ts`: encrypt/decrypt round-trip; tampered tag
  fails to decrypt.
- `backend/test/llm.test.ts`: `assertSafeOutboundUrl` table (accept/reject);
  `chat` error messages contain neither the key nor the full path (assert on
  the thrown message with a stub transport).
- E2E `e2e/settings.spec.ts`: sign in, open Settings, save a dummy BYOK pair,
  see `Key ending in ...`, remove it, see the form again.

**AC: each answer can spawn follow-ups (origin=followup) on the gap map;
without a key the loop falls back to the bank and never crashes or blocks.**
- `backend/test/followups.test.ts`: with a fake `chat` returning a safe,
  grounded question, `POST /answers/:id/followups` stores a `questions` row
  with `origin='followup'` and returns it; the row then appears in
  `GET /spaces/:id/questions`. With `mode:'off'` (no credential, no gateway),
  the endpoint returns `{followups:[], mode:'off'}`, writes no rows, and the
  subsequent `GET /sessions/:id` still offers the next bank question. With an
  injected `chat` that throws, the endpoint still returns 200 with `[]`.

**AC: gap map lists every open question with status (open, answered,
deferred, lost with them), filterable by topic and person; the visible count
shrinks as questions resolve.**
- `backend/test/questions.test.ts`: after seeding, `GET` returns the bank as
  open questions; `PATCH` to `answered`/`deferred`/`lost` moves each and the
  `counts.open` drops accordingly; filter by `topic` and by `membership_id`
  (and `anyone`) each return the right subset while `counts` stay unfiltered;
  answering a bank question via `POST /sessions/:id/answers` flips its row to
  `answered`; unknown filter value → 400; non-member → 403.
- E2E `e2e/gapmap.spec.ts`: record one answer, open the gap map, resolve a
  question, watch the open count decrease.

**AC: canned-scenario suite asserts follow-ups stay within the restraint
rules (fresh widow, a child, a recent suicide, an estranged parent).**
- `backend/test/followups.test.ts` (the harness). For each scenario, define a
  candidate list mixing safe questions with the wounding ones below and
  assert `filterCandidates` returns only safe survivors, each passing
  `passesRestraint` and `copyViolations([]) === []`. Also assert
  `buildFollowupPrompt` output includes the restraint instructions and the
  scenario transcript. Direct-tables:
  - **Reject (must all fail `passesRestraint`):** `How did it feel when he
    died?` / `How are you coping without her?` / `Did you get to say
    goodbye?` / `Why do you think she did it?` / `Were there any warning
    signs?` / `Do you regret not reconciling with him?` / `Whose fault was
    the estrangement?` / `What were his last words?` / `How did she pass
    away?`
  - **Accept (must all pass):** `What did his coffee mornings look like?` /
    `What did she like to grow in her garden?` / `What kinds of radios did he
    like to fix?` / `What was your favorite game to play with him?` / `What
    is a story he liked to tell?`

**AC: generated question copy passes the copy sweep before it can be shown.**
- `backend/test/copy-rules.test.ts`: `copyViolations` catches em-dash, banned
  vocabulary, and negative phrasing; the anti-drift test confirms the runtime
  checks cover the static script's patterns. In `followups.test.ts`, a
  candidate containing an em-dash or a banned word is dropped by
  `filterCandidates`, so it can never be stored or returned.

**Regression / whole-suite gate:** `npm test` (backend Vitest with in-process
Postgres), `npm run copy-sweep`, and `./scripts/e2e.sh` all pass. Run each in
the foreground to completion.

---

## 7. Notes for the implementer

- Do not build invites, routing (`assigned_to`), side-by-side tellings
  (`story_id`), export, or the first-run walkthrough. If a follow-up feels
  like it needs one of those, stop and record it in `requested_tasks`.
- Keep the EPIC 2 key-free interview working exactly as it does today. The
  follow-up loop is additive and degrades to the current behavior when no
  key is present.
- The restraint guardrail is the product here. When you are unsure whether a
  pattern is wounding, reject it. Silence is always safe; a bad question is
  the one failure this app cannot afford.
- Sweep every user-visible string you add (settings, gap map, interview
  follow-up labels, README) for em/en dashes, banned vocabulary, and
  negative empty-state phrasing before you finish.
