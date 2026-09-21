import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { TopBar } from "../components/TopBar";
import { AppShellLoading } from "../components/Loading";
import { api, ApiError, type CreatedInvite, type Invite, type Space } from "../api";
import { formatYears } from "../format";

type View =
  | { kind: "loading" }
  | { kind: "ready"; space: Space }
  | { kind: "forbidden" }
  | { kind: "missing" }
  | { kind: "error" };

export function SpaceDetail() {
  const { id } = useParams<{ id: string }>();
  const [view, setView] = useState<View>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    (async () => {
      if (!id) {
        setView({ kind: "missing" });
        return;
      }
      try {
        const space = await api.getSpace(id);
        if (active) setView({ kind: "ready", space });
      } catch (err) {
        if (!active) return;
        if (err instanceof ApiError && err.status === 403)
          setView({ kind: "forbidden" });
        else if (err instanceof ApiError && err.status === 404)
          setView({ kind: "missing" });
        else setView({ kind: "error" });
      }
    })();
    return () => {
      active = false;
    };
  }, [id]);

  return (
    <>
      <TopBar />
      <main className="page">
        {view.kind === "loading" && <AppShellLoading />}

        {view.kind === "ready" && (
          <article className="card stack">
            <div>
              <h1 className="section-title">{view.space.subject_name}</h1>
              {formatYears(
                view.space.subject_birth_year,
                view.space.subject_death_year
              ) && (
                <p className="space-years">
                  {formatYears(
                    view.space.subject_birth_year,
                    view.space.subject_death_year
                  )}
                </p>
              )}
            </div>
            <p className="muted">
              This is where your family's memories of{" "}
              {view.space.subject_name.split(" ")[0]} will gather, in the voices
              of everyone who loved them.
            </p>
            <Link
              className="btn btn-primary btn-block"
              to={`/space/${view.space.id}/interview`}
            >
              Record a memory
            </Link>
            <Link
              className="btn btn-quiet btn-block"
              to={`/space/${view.space.id}/questions`}
            >
              What's still open
            </Link>
            <Link
              className="btn btn-quiet btn-block"
              to={`/space/${view.space.id}/stories`}
            >
              See tellings side by side
            </Link>
            {view.space.role === "organizer" && (
              <InvitePanel spaceId={view.space.id} />
            )}
            <Link className="btn btn-quiet" to="/">
              Back to your spaces
            </Link>
          </article>
        )}

        {view.kind === "forbidden" && (
          <div className="card">
            <div className="notice notice-error" role="alert">
              This space is private to its family.
            </div>
            <Link className="btn btn-primary" to="/">
              Back to your spaces
            </Link>
          </div>
        )}

        {view.kind === "missing" && (
          <div className="card">
            <h1 className="section-title">That page is not here</h1>
            <p className="section-sub">
              The space may have been removed, or the link is off.
            </p>
            <Link className="btn btn-primary" to="/">
              Back to your spaces
            </Link>
          </div>
        )}

        {view.kind === "error" && (
          <div className="card">
            <div className="notice notice-error" role="alert">
              That didn't work. Check your connection and try again.
            </div>
            <Link className="btn btn-primary" to="/">
              Back to your spaces
            </Link>
          </div>
        )}
      </main>
    </>
  );
}

const GENERIC = "That didn't work. Check your connection and try again.";

function inviteStatusText(invite: Invite): string {
  if (invite.status === "joined") {
    const name = invite.joined?.display_name || "A relative";
    const rel = invite.joined?.relationship_to_subject;
    return rel ? `Joined. ${name}, their ${rel}` : `Joined. ${name}`;
  }
  if (invite.status === "expired") return "Expired";
  return "Waiting";
}

function InvitePanel({ spaceId }: { spaceId: string }) {
  const [open, setOpen] = useState(false);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await api.listInvites(spaceId);
      setInvites(res.invites);
    } catch {
      setError(GENERIC);
    }
  }, [spaceId]);

  const expand = () => {
    setOpen(true);
    void load();
  };

  const create = async () => {
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      const invite = await api.createInvite(spaceId, label.trim() || undefined);
      setCreated(invite);
      setLabel("");
      await load();
    } catch {
      setError(GENERIC);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
    } catch {
      /* the link is visible in the field for a manual copy */
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  if (!open) {
    return (
      <button className="btn btn-quiet btn-block" type="button" onClick={expand}>
        Invite family
      </button>
    );
  }

  return (
    <section className="card stack invite-panel">
      <h2 className="saved-heading">Invite family</h2>
      <label className="field">
        Who is this for?
        <input
          className="input"
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Aunt Carol"
          autoComplete="off"
        />
      </label>
      <button
        className="btn btn-primary btn-block"
        type="button"
        onClick={create}
        disabled={busy}
      >
        {busy ? "Making a link..." : "Create an invite link"}
      </button>

      {created && (
        <div className="stack invite-created">
          <label className="field">
            Invite link
            <input className="input cred-mono" type="text" value={created.url} readOnly />
          </label>
          <button className="btn btn-quiet" type="button" onClick={copy} aria-live="polite">
            {copied ? "Copied" : "Copy link"}
          </button>
          <p className="hint">
            Send this to one relative. The link works once and expires in 14 days.
          </p>
        </div>
      )}

      {error && (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      )}

      {invites.length > 0 && (
        <ul className="invite-list">
          {invites.map((invite) => (
            <li key={invite.id} className="invite-item">
              <span className="invite-label">{invite.label || "Invite link"}</span>
              <span className={`invite-status invite-${invite.status}`}>
                {inviteStatusText(invite)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
