# VALIDATION — Ask the Living

**Verdict: VIABLE** (with binding conditions the plan must honor, listed below).

## The value test, applied

The factory judges value, not business. On that test this idea clears every gate,
and clears some of them unusually well.

**Would anyone's life be genuinely better?** Yes, and the evidence is direct and
painful: "I realized after he passed how much I didn't know." The product's core
reframe is true and non-obvious: the memories of the dead are not gone, they are
distributed among the living and decaying on a schedule. A family that uses this
for even one month keeps something irreplaceable. Critically, the value holds at
n=1: one adult child recording ten minutes about their father, with good
questions, has already made the thing they feared was impossible to start. The
skeptic's 0.8 kill probability is a market-adoption number; it does not touch
whether the product is valuable to the family that does use it.

**Could a chatbot or a free tool do it?** The interview itself, yes: ChatGPT asks
decent follow-ups tonight, free. What no chat window or free incumbent holds:
(1) a persistent, organized, multi-voice audio corpus in the survivors' own
preserved voices; (2) the standing gap map, which converts grief's vague "so much
I didn't know" into a finite, visibly shrinking list; (3) routing an open
question out of one person's session into another person's; (4) side-by-side
divergent tellings with the interviewer pursuing the discrepancy. StoryWorth
Memorials and Kudoboard receive what people volunteer; volunteering is exactly
what the evidence says fails. The substitution defense is real, but it depends
entirely on those four mechanics shipping visibly. A version of this app that is
"record audio + AI summary" IS substitutable and should not be built.

**Durable artifact?** The strongest part of the idea. Hours of the survivors'
voices, organized by story and speaker, plus transcripts, plus the map of the
unknown including its permanently open items ("nobody knows how they met" is
itself a finding). Twenty years on it is a double artifact: the story of the
deceased and the voices of tellers who will by then be gone too. The third
evidence quote is a burned user whose dead father's voicemails were erased by a
cloud update. Export in open formats is therefore a launch requirement, not a
feature.

**Can agents deliver the promised experience at the quality bar?** Yes, with one
honest hard part. The infrastructure is ordinary full-stack work: browser audio
capture, transcription, multi-party state, invite links, the gap map, an
alignment UI. The hard part is not infrastructure, it is restraint: interview
tone under grief. One mis-aimed follow-up to a fresh widow is a product-ending
screenshot. This is prompt-engineering-deep and testable with canned scenarios,
but the plan must budget for it explicitly (see conditions). The LLM dependency
fits the BYOK contract unusually well: one tech-comfortable organizer pastes a
key once; invited relatives just open a link and talk. Without any key, the app
degrades to a curated biographer question bank plus the corpus and a
manually-tended gap map, which is still a better StoryWorth Memorials, and first
value is reachable before the key wall.

**Ambition bar?** Passes both tests. This is not the obvious answer (the obvious
answer is a tribute wall or a prompt list; the pre-scan shows both exist and
both are passive). The signature moment is a mechanic, nameable in one sentence:
your brother's telling of the same summer lands next to yours, and the app asks
you the one question his version left open. Value compounds mechanically: more
voices, more stories, more cross-links, a shrinking gap map.

## Core value proposition

After a death, a patient biographer interviews each surviving family member by
voice, at their own pace, about the person they lost; it asks the follow-ups a
good biographer would, lays different relatives' tellings of the same story side
by side, and keeps a visible map of what nobody has answered yet, routing each
open question to the relative most likely to know. The family keeps everything:
audio, transcripts, and the story structure, in their own voices, exportable,
forever. Strictly the survivors' voices; never a synthesized voice of the dead.

## Minimal feature set (the smallest product that delivers this)

1. **Solo session loop (must be excellent alone).** Create a space for the
   remembered person; record voice answers in the browser; transcription;
   adaptive follow-ups with a key, curated biographer question bank without one.
2. **The gap map.** Every unanswered question visible and standing; each answer
   spawns follow-ups; questions can be closed, deferred ("not this topic yet"),
   or marked lost with them.
3. **Invites and routing.** A relative opens a link and talks; an open question
   can be routed to a named relative and its answer flows back into the map.
4. **Side-by-side tellings.** When two people cover the same story, their
   versions sit next to each other and the interviewer asks each the question
   the other's version left open. This is the signature moment; it must be
   reachable and demonstrable.
5. **Export.** Audio files, transcripts, and story/gap structure in open
   formats, one click, from day one.

Everything else (eras/timelines, printed books, photos, communities beyond
families, the live gathering recorder variant) is out of the minimal set.

## Main risks

1. **Multi-party collapse (the skeptic's strongest objection).** Every
   distinguishing mechanic activates fully only when a second relative responds,
   and collaborative memorial products historically see one burst of
   contributions, then silence. Mitigation is structural, not hopeful: the solo
   loop must be genuinely valuable (it is: the corpus, the questions, the map
   all work for one voice), and the staging demo must not depend on a real
   second party (seed a demo family so the signature moment is visible in the
   first minute).
2. **Tone under grief.** Zero-tolerance register; one clumsy question does
   outsized damage. Requires restraint engineering: user-set pace, topic
   deferral, conservative follow-up style, and canned-scenario testing of the
   interviewer as a planned deliverable, not an afterthought.
3. **Demand is reframed, not proven.** Two of three evidence quotes mourn the
   deceased's own voice, which this product deliberately cannot deliver. The
   reframe (save what the living still hold) is emotionally true but no quote
   asks for this exact product. Acceptable for a value-judged factory; would be
   disqualifying for a revenue-judged one.
4. **Grief avoidance kills the return loop.** "At your own pace" can become
   never. The product must treat a single completed session as a success state,
   not a funnel stage.
5. **Trust and permanence.** A grief archive living only on a server repeats the
   documented failure (erased voicemails). Export is the mitigation; it must
   never slip out of the MVP.

## What would make me reject it

- If the plan's core loop degrades to record-plus-AI-summary, dropping the gap
  map, routing, or side-by-side mechanics: that product is substitutable by
  free tools and should not ship.
- If the signature moment cannot be demonstrated on staging without a real
  multi-person family (a seeded demo family solves this; its absence from the
  plan would be disqualifying).
- If interviewer tone cannot be tested before strangers see it: shipping an
  untested grief interviewer is the one failure mode here that harms users
  rather than merely boring them.
- If the product ever drifts toward synthesizing the deceased's voice or
  persona. The constraint is the position; violating it destroys the product's
  reason to exist and enters a space with active consumer backlash and
  regulation.

## Verdict, restated bluntly

The gap is real and specifically shaped: every interviewer product requires the
subject alive, every post-death tool is passive, and the AI-ghost products serve
the same moment disrespectfully. The risks are follow-through and tone, both
named, both mitigable in a plan that makes solo use excellent and tests the
interviewer hard. Build it.
