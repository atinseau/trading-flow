import { useSSEStream } from "@client/hooks/useSSEStream";
import { Link, NavLink, Outlet } from "react-router-dom";

function LiveEventsSidebarPlaceholder() {
  return <div className="text-xs text-muted-foreground">Live events…</div>;
}

export function RootLayout() {
  useSSEStream();
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="flex items-center gap-6 px-6 h-12">
          <Link to="/" className="font-bold tracking-wide">
            trading-flow
          </Link>
          <nav className="flex items-center gap-4 text-sm text-muted-foreground">
            <NavLink to="/" end className={({ isActive }) => (isActive ? "text-foreground" : "")}>
              Dashboard
            </NavLink>
            <NavLink
              to="/live-events"
              className={({ isActive }) => (isActive ? "text-foreground" : "")}
            >
              Live events
            </NavLink>
            <NavLink to="/costs" className={({ isActive }) => (isActive ? "text-foreground" : "")}>
              Coûts
            </NavLink>
          </nav>
        </div>
      </header>
      <div className="grid grid-cols-[1fr_288px]">
        <main className="p-6">
          <Outlet />
        </main>
        <aside className="border-l border-border bg-card/50 p-4 sticky top-12 h-[calc(100vh-3rem)] overflow-auto">
          <LiveEventsSidebarPlaceholder />
        </aside>
      </div>
    </div>
  );
}
