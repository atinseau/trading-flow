import { SetupsListSection } from "../components/setup/setups-list-section";

/**
 * /setups — global setups list across all watches.
 * Filter pills (live / wins / losses / other) + stats bar at the top.
 */
export function Component() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">Setups</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Tous les setups générés par tes watches — vivants et archivés.
        </p>
      </div>
      <SetupsListSection />
    </div>
  );
}
