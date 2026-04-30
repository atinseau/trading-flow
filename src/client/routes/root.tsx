import { Link, NavLink, Outlet } from "react-router-dom";
import { useLessonCounts } from "../hooks/useLessonCounts";
import { useSSEStream } from "../hooks/useSSEStream";

/**
 * App shell. Single-column layout. The previous live-events sidebar was
 * removed (it duplicated /live-events and /setups/:id timelines, and was
 * noise everywhere else). Per-page narrative views replace it where useful.
 */
export function RootLayout() {
  useSSEStream();
  const lessonCounts = useLessonCounts();
  const pending = lessonCounts.data?.PENDING ?? 0;

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
            <NavLink to="/setups" className={({ isActive }) => (isActive ? "text-foreground" : "")}>
              Setups
            </NavLink>
            <NavLink
              to="/lessons"
              className={({ isActive }) =>
                `inline-flex items-center gap-1.5 ${isActive ? "text-foreground" : ""}`
              }
            >
              Leçons
              {pending > 0 && (
                <span className="rounded-full bg-amber-500/20 text-amber-400 text-[10px] font-mono px-1.5 py-0.5 leading-none">
                  {pending}
                </span>
              )}
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
      <main className="p-6 max-w-7xl mx-auto w-full">
        <Outlet />
      </main>
    </div>
  );
}
