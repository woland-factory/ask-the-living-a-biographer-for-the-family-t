import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";

export function TopBar() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate("/", { replace: true });
  };

  return (
    <header className="topbar">
      <Link to="/" className="brand">
        Ask the Living
      </Link>
      {user && user.email !== null && (
        <nav className="topbar-nav">
          <Link className="btn btn-quiet" to="/settings">
            Settings
          </Link>
          <button className="btn btn-quiet" onClick={handleSignOut} type="button">
            Sign out
          </button>
        </nav>
      )}
    </header>
  );
}
