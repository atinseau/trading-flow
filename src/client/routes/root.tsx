import { LiveEventsSidebar } from "../components/live-events-sidebar";
import { useSSEStream } from "../hooks/useSSEStream";
import { cn } from "../lib/utils";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";

// Routes that already render their own full live-events feed — hide the
// sidebar there to avoid duplication.
const SIDEBAR_HIDDEN_PATHS = new Set(["/live-events"]);

export function RootLayout() {
  useSSEStream();
  const { pathname } = useLocation();
  const sidebarVisible = !SIDEBAR_HIDDEN_PATHS.has(pathname);

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
              to="/watches"
              className={({ isActive }) => (isActive ? "text-foreground" : "")}
            >
              Watches
            </NavLink>
            <NavLink to="/search" className={({ isActive }) => (isActive ? "text-foreground" : "")}>
              Rechercher
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
      <div className={cn("grid", sidebarVisible ? "grid-cols-[1fr_288px]" : "grid-cols-1")}>
        <main className="p-6">
          <Outlet />
        </main>
        {sidebarVisible && (
          <aside className="border-l border-border bg-card/50 p-4 sticky top-12 h-[calc(100vh-3rem)] overflow-auto">
            <LiveEventsSidebar />
          </aside>
        )}
      </div>
    </div>
  );
}
