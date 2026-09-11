import { Link } from "react-router-dom";
import { TopBar } from "../components/TopBar";

export function Landing() {
  return (
    <>
      <TopBar />
      <main className="page">
        <section className="hero">
          <h1>Remember them together.</h1>
          <p>
            A calm place to gather your family's memories of the person you lost,
            in their own voices.
          </p>
          <Link className="btn btn-primary" to="/signin">
            Create a space
          </Link>
        </section>
      </main>
      <p className="footer-note">
        Your family's voices stay yours. We keep them safe.
      </p>
    </>
  );
}
