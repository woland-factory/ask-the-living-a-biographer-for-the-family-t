import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { TopBar } from "../components/TopBar";
import {
  api,
  type GapMap as GapMapData,
  type Person,
  type Question,
  type QuestionStatus,
} from "../api";
import { topicLabel } from "../interview/bank";

const GENERIC = "That didn't work. Check your connection and try again.";

const STATUS_CHIPS: { key: QuestionStatus | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "answered", label: "Answered" },
  { key: "deferred", label: "Not yet" },
  { key: "lost", label: "Lost with them" },
];

type View =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "forbidden" }
  | { kind: "missing" }
  | { kind: "ready"; data: GapMapData };

interface Filters {
  status: QuestionStatus | "all";
  topic: string;
  person: string; // membership_id, "anyone", or "" for everyone
}

function personName(people: Person[], membershipId: string | null): string {
  if (!membershipId) return "For anyone";
  const p = people.find((x) => x.membership_id === membershipId);
  return p?.relationship_to_subject || "A family member";
}

export function GapMap() {
  const { id } = useParams<{ id: string }>();
  const [view, setView] = useState<View>({ kind: "loading" });
  const [filters, setFilters] = useState<Filters>({ status: "all", topic: "", person: "" });

  const load = useCallback(async () => {
    if (!id) {
      setView({ kind: "missing" });
      return;
    }
    try {
      const data = await api.getQuestions(id, {
        status: filters.status === "all" ? undefined : filters.status,
        topic: filters.topic || undefined,
        membership_id: filters.person || undefined,
      });
      setView({ kind: "ready", data });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 403) setView({ kind: "forbidden" });
      else if (status === 404) setView({ kind: "missing" });
      else setView({ kind: "error" });
    }
  }, [id, filters]);

  useEffect(() => {
    void load();
  }, [load]);

  const resolve = useCallback(
    async (question: Question, next: QuestionStatus) => {
      if (view.kind !== "ready") return;
      const prev = view.data;
      // Optimistic: adjust the count and the item within 100ms, then reconcile.
      const counts = { ...prev.counts };
      counts[question.status] = Math.max(0, counts[question.status] - 1);
      counts[next] += 1;
      const questions = prev.questions.map((q) =>
        q.id === question.id ? { ...q, status: next } : q
      );
      setView({ kind: "ready", data: { ...prev, questions, counts } });
      try {
        await api.patchQuestion(question.id, next);
      } catch {
        // Fall back to the server's truth if the write did not land.
      }
      await load();
    },
    [view, load]
  );

  return (
    <>
      <TopBar />
      <main className="page">
        {view.kind === "loading" && <GapSkeleton />}

        {view.kind === "error" && (
          <div className="card">
            <div className="notice notice-error" role="alert">
              {GENERIC}
            </div>
            <button className="btn btn-primary" type="button" onClick={load}>
              Try again
            </button>
          </div>
        )}

        {view.kind === "forbidden" && (
          <SimpleCard title="This space is private to its family." to="/" cta="Back to your spaces" />
        )}
        {view.kind === "missing" && (
          <SimpleCard
            title="That page is not here"
            to="/"
            cta="Back to your spaces"
          />
        )}

        {view.kind === "ready" && (
          <GapReady
            spaceId={id!}
            data={view.data}
            filters={filters}
            onFilters={setFilters}
            onResolve={resolve}
          />
        )}
      </main>
    </>
  );
}

function GapReady({
  spaceId,
  data,
  filters,
  onFilters,
  onResolve,
}: {
  spaceId: string;
  data: GapMapData;
  filters: Filters;
  onFilters: (f: Filters) => void;
  onResolve: (q: Question, next: QuestionStatus) => void;
}) {
  const open = data.counts.open;
  const openLabel = open === 0 ? "All caught up for now" : `${open} still open`;
  const filtered = filters.status !== "all" || filters.topic !== "" || filters.person !== "";

  const personOptions = useMemo(
    () =>
      data.people.map((p) => ({
        value: p.membership_id,
        label: p.relationship_to_subject || "A family member",
      })),
    [data.people]
  );

  return (
    <div className="stack">
      <div className="gap-header">
        <p className="topic-label">What's still open</p>
        <h1 className="section-title" aria-live="polite">
          {openLabel}
        </h1>
        <p className="muted">
          Every question your family can still answer, and the ones you choose
          to keep or let go.
        </p>
      </div>

      <div className="gap-filters">
        <div className="chips" role="group" aria-label="Filter by status">
          {STATUS_CHIPS.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className={`chip${filters.status === chip.key ? " chip-on" : ""}`}
              aria-pressed={filters.status === chip.key}
              onClick={() => onFilters({ ...filters, status: chip.key })}
            >
              {chip.label}
            </button>
          ))}
        </div>
        <div className="row gap-selects">
          <label className="field">
            Topic
            <select
              className="input"
              value={filters.topic}
              onChange={(e) => onFilters({ ...filters, topic: e.target.value })}
            >
              <option value="">Every topic</option>
              {data.topics.map((t) => (
                <option key={t} value={t}>
                  {topicLabel(t) || t}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Person
            <select
              className="input"
              value={filters.person}
              onChange={(e) => onFilters({ ...filters, person: e.target.value })}
            >
              <option value="">Everyone</option>
              <option value="anyone">For anyone</option>
              {personOptions.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {data.questions.length === 0 ? (
        filtered ? (
          <div className="card gap-empty">
            <p>These filters have no matches.</p>
            <button
              className="btn btn-quiet"
              type="button"
              onClick={() => onFilters({ status: "all", topic: "", person: "" })}
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className="card gap-empty">
            <p>The map fills as you record. Record a memory to begin.</p>
            <Link className="btn btn-primary" to={`/space/${spaceId}/interview`}>
              Record a memory
            </Link>
          </div>
        )
      ) : (
        <ul className="gap-list">
          {data.questions.map((q) => (
            <GapItem
              key={q.id}
              question={q}
              people={data.people}
              onResolve={onResolve}
            />
          ))}
        </ul>
      )}

      <Link className="btn btn-quiet" to={`/space/${spaceId}`}>
        Back to the space
      </Link>
    </div>
  );
}

function GapItem({
  question,
  people,
  onResolve,
}: {
  question: Question;
  people: Person[];
  onResolve: (q: Question, next: QuestionStatus) => void;
}) {
  const label = topicLabel(question.topic) || question.topic;
  return (
    <li className={`gap-item gap-${question.status}`}>
      <div className="gap-item-meta">
        <span className="gap-topic">{label}</span>
        {question.origin === "followup" && (
          <span className="gap-tag">Follow-up</span>
        )}
        <span className="gap-person">{personName(people, question.membership_id)}</span>
      </div>
      <p className="gap-text">{question.text}</p>
      {question.status === "open" ? (
        <div className="gap-actions">
          <button
            className="btn btn-quiet"
            type="button"
            onClick={() => onResolve(question, "answered")}
          >
            Mark answered
          </button>
          <button
            className="btn btn-quiet"
            type="button"
            onClick={() => onResolve(question, "deferred")}
          >
            Not yet
          </button>
          <button
            className="btn btn-quiet"
            type="button"
            onClick={() => onResolve(question, "lost")}
          >
            Lost with them
          </button>
        </div>
      ) : (
        <div className="gap-actions">
          <span className="gap-status-note">{statusNote(question.status)}</span>
          <button
            className="btn btn-quiet"
            type="button"
            onClick={() => onResolve(question, "open")}
          >
            Reopen
          </button>
        </div>
      )}
    </li>
  );
}

function statusNote(status: QuestionStatus): string {
  if (status === "answered") return "Answered";
  if (status === "deferred") return "Kept for later";
  if (status === "lost") return "Lost with them";
  return "";
}

function SimpleCard({ title, to, cta }: { title: string; to: string; cta: string }) {
  return (
    <div className="card">
      <h1 className="section-title">{title}</h1>
      <Link className="btn btn-primary" to={to}>
        {cta}
      </Link>
    </div>
  );
}

function GapSkeleton() {
  return (
    <div className="stack" aria-busy="true" aria-label="Loading the map">
      <div className="skeleton sk-line" style={{ width: "45%", height: "1.6rem" }} />
      <div className="skeleton sk-line" style={{ width: "80%" }} />
      <div className="skeleton sk-card" />
      <div className="skeleton sk-card" />
      <div className="skeleton sk-card" />
    </div>
  );
}
