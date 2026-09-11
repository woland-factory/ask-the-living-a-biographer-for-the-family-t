import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { TopBar } from "../components/TopBar";
import { api, ApiError } from "../api";

type Status = "idle" | "sending" | "sent" | "error";

export function SignIn() {
  const [params] = useSearchParams();
  const linkExpired = params.get("e") === "expired";

  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (status === "sending") return;
    setStatus("sending");
    setError("");
    try {
      await api.requestMagicLink(email.trim());
      setStatus("sent");
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : "That didn't work. Check your connection and try again.";
      setError(message);
      setStatus("error");
    }
  };

  if (status === "sent") {
    return (
      <>
        <TopBar />
        <main className="page">
          <div className="card confirm">
            <div className="mark" aria-hidden="true">
              ✓
            </div>
            <h1 className="section-title">Check your email</h1>
            <p className="muted">
              We sent a link to <strong>{email.trim()}</strong>. It works for 15
              minutes.
            </p>
            <button
              type="button"
              className="btn btn-quiet mt-2"
              onClick={() => {
                setStatus("idle");
                setEmail("");
              }}
            >
              Use a different email
            </button>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <TopBar />
      <main className="page">
        <div className="card">
          <h1 className="section-title">Sign in</h1>
          <p className="section-sub">
            We email you a link. No password to remember.
          </p>

          {linkExpired && (
            <div className="notice notice-error" role="alert">
              That link has expired. Ask for a new one.
            </div>
          )}
          {status === "error" && (
            <div className="notice notice-error" role="alert">
              {error}
            </div>
          )}

          <form onSubmit={onSubmit} noValidate>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                className="input"
                type="email"
                inputMode="email"
                autoComplete="email"
                required
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <button
              type="submit"
              className="btn btn-primary btn-block"
              disabled={status === "sending" || email.trim().length === 0}
            >
              {status === "sending" ? "Sending..." : "Email me a link"}
            </button>
          </form>
        </div>
        <p className="footer-note">
          <Link to="/">Back to start</Link>
        </p>
      </main>
    </>
  );
}
