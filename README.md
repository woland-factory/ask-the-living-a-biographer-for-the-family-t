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

## What's inside

- **backend/**: a Fastify API (TypeScript) that also serves the web app. It
  handles magic-link sign-in, spaces, interview sessions, and the audio store,
  and applies its own SQL migrations on startup.
- **frontend/**: a React and Vite single-page app. It also holds the question
  bank and the on-device transcription worker.
- **e2e/**: Playwright tests for sign-in, creating a space, and the interview.

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
