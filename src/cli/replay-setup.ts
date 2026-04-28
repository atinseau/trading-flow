import { events, setups } from "@adapters/persistence/schema";
import { loadPrompt } from "@adapters/prompts/loadPrompt";
import { getLogger } from "@observability/logger";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const log = getLogger({ component: "replay-setup-cli" });

const setupId = process.argv[2];
if (!setupId) {
  log.error("Usage: replay-setup <setup-id> [--prompt=detector|reviewer|finalizer]");
  process.exit(1);
}

const promptFilter = process.argv.find((a) => a.startsWith("--prompt="))?.slice(9);

const url = process.env.DATABASE_URL;
if (!url) {
  log.error("DATABASE_URL not set");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url });
const db = drizzle(pool);

// Load setup
const [setup] = await db.select().from(setups).where(eq(setups.id, setupId));
if (!setup) {
  log.error({ setupId }, "Setup not found");
  await pool.end();
  process.exit(2);
}

log.info(
  {
    setupId: setup.id,
    asset: setup.asset,
    timeframe: setup.timeframe,
    status: setup.status,
  },
  "Loaded setup",
);

// Load all events
const evts = await db
  .select()
  .from(events)
  .where(eq(events.setupId, setupId))
  .orderBy(asc(events.sequence));

log.info({ eventCount: evts.length }, "Loaded events");

// Filter to LLM events (those with promptVersion set)
const llmEvents = evts.filter((e) => e.promptVersion != null);

if (llmEvents.length === 0) {
  log.warn("No LLM events found (no events with promptVersion). Nothing to replay.");
  await pool.end();
  process.exit(0);
}

// Load current prompt versions
const detectorPrompt = await loadPrompt("detector");
const reviewerPrompt = await loadPrompt("reviewer");
const finalizerPrompt = await loadPrompt("finalizer");

const currentVersions = {
  detector: detectorPrompt.version,
  reviewer: reviewerPrompt.version,
  finalizer: finalizerPrompt.version,
};

log.info({ currentVersions }, "Current prompt versions");

// Compute diff
console.log("\n=== REPLAY DIFF for setup", setupId.slice(0, 8), "===\n");

let differences = 0;
let same = 0;

for (const evt of llmEvents) {
  const persistedVersion = evt.promptVersion as string;
  const stage = evt.stage;
  const currentVersion =
    stage === "detector"
      ? currentVersions.detector
      : stage === "reviewer"
        ? currentVersions.reviewer
        : stage === "finalizer"
          ? currentVersions.finalizer
          : "unknown";

  // Filter to specific stage if requested
  if (promptFilter && stage !== promptFilter) continue;

  const versionsDiffer = persistedVersion !== currentVersion;
  const marker = versionsDiffer ? "[CHANGED]" : "[SAME]";
  console.log(
    `${marker} [seq ${evt.sequence}] ${stage} ${evt.type}: ${persistedVersion} -> ${currentVersion}${
      versionsDiffer ? " (would re-run)" : " (no change)"
    }`,
  );

  if (versionsDiffer) differences++;
  else same++;
}

console.log(`\n${differences} events would re-run (prompt changed); ${same} unchanged.\n`);

if (differences === 0) {
  log.info("All persisted prompt versions match current. No replay needed.");
  await pool.end();
  process.exit(0);
}

// To actually re-run the LLM: load each event's tickSnapshot, reconstruct context,
// re-render the prompt, call the LLM, compare verdicts.
// For MVP: this is a "what would change" report only. Actually re-running requires
// instantiating provider registry, which needs the full config. That's a bigger ask.
console.log(
  "Note: this is a reporting-only replay. To actually re-execute against new prompts,\n" +
    "run a follow-up command (not yet implemented) that re-runs the LLM calls in dry-run mode\n" +
    "and compares verdicts side-by-side.",
);

await pool.end();
process.exit(0);
