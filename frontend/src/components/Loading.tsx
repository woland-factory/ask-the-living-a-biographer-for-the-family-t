/** Layout-stable loading placeholders. Never a blank screen. */
export function AppShellLoading() {
  return (
    <div className="page" aria-busy="true" aria-label="Loading">
      <div className="skeleton sk-line" style={{ width: "60%", height: "1.8rem" }} />
      <div className="skeleton sk-line" style={{ width: "85%" }} />
      <div className="mt-2">
        <div className="skeleton sk-card" />
        <div className="skeleton sk-card" />
      </div>
    </div>
  );
}

export function ListLoading() {
  return (
    <div aria-busy="true" aria-label="Loading spaces">
      <div className="skeleton sk-card" />
      <div className="skeleton sk-card" />
      <div className="skeleton sk-card" />
    </div>
  );
}
