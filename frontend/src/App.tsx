import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth";
import { AppShellLoading } from "./components/Loading";
import { Landing } from "./pages/Landing";
import { SignIn } from "./pages/SignIn";
import { Home } from "./pages/Home";
import { SpaceDetail } from "./pages/SpaceDetail";
import { Interview } from "./pages/Interview";

export function App() {
  const { user, loading } = useAuth();

  return (
    <Routes>
      <Route
        path="/"
        element={loading ? <AppShellLoading /> : user ? <Home /> : <Landing />}
      />
      <Route
        path="/signin"
        element={
          loading ? (
            <AppShellLoading />
          ) : user ? (
            <Navigate to="/" replace />
          ) : (
            <SignIn />
          )
        }
      />
      <Route
        path="/space/:id"
        element={
          loading ? (
            <AppShellLoading />
          ) : user ? (
            <SpaceDetail />
          ) : (
            <Navigate to="/signin" replace />
          )
        }
      />
      <Route
        path="/space/:id/interview"
        element={
          loading ? (
            <AppShellLoading />
          ) : user ? (
            <Interview />
          ) : (
            <Navigate to="/signin" replace />
          )
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
