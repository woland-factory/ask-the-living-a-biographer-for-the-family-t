# Ask the Living

When someone dies, the recordings we wish we had made were never made. Ask the
Living is a patient biographer for the people they left behind. Each family
member answers, at their own pace, questions about the person they lost. Over
time those answers gather into one life story told in the family's own voices.

A signed-in organizer creates a space for the person their family is
remembering, then records a voice interview about them. Follow-ups and the
shared story are built on top of it.

## Recording an interview

Open a space and choose **Record a memory**. The app asks one question at a
time from a curated biographer's bank. You record your answer in the browser,
play it back, and save it. You can skip a topic for now, step away and come
back where you left off, or finish the sitting whenever you like.

Each recording is transcribed on your own device, in the browser, using a
Whisper model that runs in a Web Worker. Your audio never leaves your device.
The model weights download once from Hugging Face and are cached by the
browser after that. If transcription cannot run, the recording is still saved
and you can try transcribing it again later. The audio is the memory; the
transcript is a convenience.

## Follow-up questions (optional)

The interview can ask one gentle follow-up drawn from what you just said. This
is off until you add your own model key in **Settings**. Paste an
OpenAI-compatible endpoint and key. Your key is encrypted, stored for you
alone, and sent only to the address you enter. We show only the last four
characters and never log it.

Without a key, the interview simply runs from the curated question bank. Every
generated question passes a restraint guardrail before it can be shown: it must
be a single gentle question, never about the death or its cause, never prying
at feelings or blame. When nothing kind fits, the app stays quiet.

Each space also keeps a **gap map**: every open question about the person, who
it belongs to, and what the family has answered, deferred, or chosen to let go.
From the gap map you can send an open question to a specific relative. It waits
at the top of their next sitting, framed as family wondering together, and
resolves on the shared map once they answer.

## Tellings side by side

When two people tell the same story, the app places their tellings next to each
other, each shown verbatim, never merged into one summary. The disagreements are
kept: that is the honest record. On the **Stories** page you group tellings by
hand. Create a story, choose a telling, and add it. When a second person's
telling joins the same story, open it to see the two accounts side by side.

With a model key, the app also asks each teller the single gentle question the
other's telling left open, through the same restraint guardrail as the
follow-ups. That question lands on the teller's next sitting. Without a key, you
still group tellings by hand and see them side by side. A person sees another's
raw telling only after adding their own telling of that story.

Signed out, **See how it works** on the landing page opens a small read-only
example: one remembered person, two relatives, and the side-by-side moment.

## Inviting family

An organizer invites one relative at a time with **Invite family**. Each link is
for one person, works once, and expires after 14 days. The organizer sends the
link themselves. A relative who opens it gives just their name and their
relationship to the person, then goes straight into the interview. They never
need an account or a key, and each person's raw recordings stay private to them.

## Keeping everything (export)

The organizer can download the whole space from the space home with **Download
everything**. It streams a single ZIP that holds the original audio recordings,
the transcripts as plain text and as JSON, the story structure, and the gap map
with its answered, deferred, and "lost with them" questions. The formats are
open, so the archive opens on any computer with no special software and no
account, and it keeps working after the app is gone.

Inside the ZIP:

- `README.txt`: what the archive is and where to look first.
- `manifest.json`: a short index with counts and every file path.
- `space.json`: the full record. People, sessions, answers with their
  transcripts, stories, and every question.
- `audio/`: the original voice recordings, one folder per person.
- `transcripts/`: the words of each recording, as plain text.

Export is the organizer's custodial download. A relative cannot export another
relative's private recordings, and the endpoint enforces that server-side.

## What's inside

- **backend/**: a Fastify API (TypeScript) that also serves the web app. It
  handles magic-link sign-in, spaces, interview sessions, and the audio store,
  and applies its own SQL migrations on startup.
- **frontend/**: a React and Vite single-page app. It holds the on-device
  transcription worker, the settings screen, and the gap map.
- **shared/**: `bank.json`, the curated question bank, imported by the frontend
  and read by the backend so the two never drift.
- **e2e/**: Playwright tests for sign-in, creating a space, the interview,
  settings, the gap map, inviting a relative, the side-by-side tellings, and the
  whole-space export.

Data lives in PostgreSQL. In production the API talks to Postgres directly; the
test suite uses an in-process Postgres so it needs no database of its own.

## Run it locally

You need Docker and Docker Compose.

```bash
git clone <this-repo-url> ask-the-living
cd ask-the-living
docker compose -f docker-compose.dev.yml up --build
```

Open http://127.0.0.1:8080.

Sign-in works by email link. Locally no email is sent, so the link is printed to
the server log. Grab it with:

```bash
docker compose -f docker-compose.dev.yml logs -f app
```

Copy the `Sign-in link (local only): ...` URL into your browser to finish signing
in, then create your first space.

To stop and remove the local data:

```bash
docker compose -f docker-compose.dev.yml down -v
```

## Develop with hot reload

You need Node.js 22+ and a local Postgres (the dev compose above can provide one
on `127.0.0.1:5433`).

```bash
cp .env.example .env          # then set DATABASE_URL and SESSION_SECRET
npm install
npm run dev                   # API on :8080, web on :5173 with live reload
```

Open http://127.0.0.1:5173.

## Run the tests

Unit and integration tests (Vitest, with an in-process Postgres):

```bash
npm install
npm test
```

End-to-end tests (Playwright). They build the app, start it against an
in-process Postgres, and drive a browser. Run them inside the matching
Playwright container:

```bash
./scripts/e2e.sh
```

`scripts/e2e.sh` starts each run from a clean, in-memory database, so runs never
interfere with each other.

The copy sweep, which keeps user-facing text plain and warm, runs with:

```bash
npm run copy-sweep
```

## Configuration

Copy `.env.example` to `.env` and fill it in. Every value is read from the
environment; nothing secret is committed. The important ones:

- `DATABASE_URL`: PostgreSQL connection string.
- `SESSION_SECRET`: a long random string used to sign session cookies.
- `PUBLIC_BASE_URL`: the public URL, used to build sign-in links.
- `MAILER_URL` / `INTERNAL_SERVICE_KEY`: email delivery. When the key is empty
  in development, sign-in links are logged instead of emailed.
- `SENTRY_DSN`, `UMAMI_URL`, `UMAMI_WEBSITE_ID`: error tracking and analytics.
  All optional; the app runs fine without them.

## License

MIT. See [LICENSE](./LICENSE).
