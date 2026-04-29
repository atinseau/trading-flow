import { isAutoActionAllowed } from "@domain/feedback/lessonTransitions";
import type {
  AutoRejectReason,
  LessonAction,
  LessonCategory,
  LessonStatus,
} from "@domain/feedback/lessonAction";

export type PoolLesson = {
  id: string;
  watchId: string;
  category: LessonCategory;
  status: LessonStatus;
  pinned: boolean;
};

export type PoolSnapshot = {
  watchId: string;
  watchSymbols: string[]; // e.g. ["BTC", "BTCUSDT"]
  watchTimeframeStrings: string[]; // e.g. ["1h", "4h"]
  capPerCategory: number;
  activeByCategory: Record<LessonCategory, PoolLesson[]>;
  pinnedById: ReadonlyMap<string, boolean>;
};

export type ValidationResult = {
  applied: LessonAction[];
  rejected: { action: LessonAction; reason: AutoRejectReason }[];
};

const TIMEFRAME_REGEX =
  /\b(?:\d+\s*(?:m|min|minute|h|hr|hour|d|day|w|week)s?|hourly|daily|weekly|intraday|swing|scalp|(?:one|two|three|four|five|six|seven|eight|nine|ten|fifteen|thirty|sixty)[\s-](?:minute|hour|day)s?|[mhdw]\d{1,2})\b/i;

const CONSTANT_TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w"] as const;

function mentionsTimeframe(text: string, configured: string[]): boolean {
  if (TIMEFRAME_REGEX.test(text)) return true;
  for (const tf of [...CONSTANT_TIMEFRAMES, ...configured]) {
    const re = new RegExp(`\\b${tf}\\b`, "i");
    if (re.test(text)) return true;
  }
  return false;
}

function mentionsAsset(text: string, symbols: string[]): boolean {
  for (const s of symbols) {
    if (s.length < 3) continue;
    const re = new RegExp(`\\b${s.toUpperCase()}\\b`);
    if (re.test(text.toUpperCase())) return true;
  }
  // Common asset class & symbol whitelist for safety.
  // False positives are acceptable here (only AutoRejected; LLM gets another shot).
  // False negatives are NOT acceptable (mention pollutes the prompt pool forever).
  const generic =
    /\b(BTC|ETH|EUR|USD|JPY|GBP|AAPL|TSLA|SPX|NQ|ES|XAU|GOLD|SILVER|OIL|forex|crypto|stocks?|equities|fx|Bitcoin|Ethereum|Solana|Dogecoin|Cardano|Ripple|Litecoin|DOGE|SOL|ADA|XRP|LTC|BNB|MATIC|USDT|USDC|BUSD|DAI)\b/i;
  return generic.test(text);
}

export function validateActions(actions: LessonAction[], pool: PoolSnapshot): ValidationResult {
  const applied: LessonAction[] = [];
  const rejected: { action: LessonAction; reason: AutoRejectReason }[] = [];

  // Cap accounting depends on action ordering within a batch: actions are
  // processed sequentially, so a DEPRECATE must come BEFORE a same-category
  // CREATE to free a slot for it. [CREATE, DEPRECATE] at cap rejects the
  // CREATE; [DEPRECATE, CREATE] applies both. See validateActions.test.ts.
  // Track simulated pool growth from CREATE actions to enforce cap.
  const simulatedAdds: Record<LessonCategory, number> = {
    detecting: 0,
    reviewing: 0,
    finalizing: 0,
  };
  // Track simulated removals (DEPRECATE) to free up cap space.
  const simulatedRemovesById = new Set<string>();

  for (const action of actions) {
    if (action.type === "CREATE") {
      const text = `${action.title} ${action.body}`;
      if (mentionsAsset(text, pool.watchSymbols)) {
        rejected.push({ action, reason: "asset_mention" });
        continue;
      }
      if (mentionsTimeframe(text, pool.watchTimeframeStrings)) {
        rejected.push({ action, reason: "timeframe_mention" });
        continue;
      }
      const currentCount =
        pool.activeByCategory[action.category].length + simulatedAdds[action.category];
      const remainingAfterRemoves =
        currentCount -
        pool.activeByCategory[action.category].filter((l) => simulatedRemovesById.has(l.id)).length;
      if (remainingAfterRemoves >= pool.capPerCategory) {
        rejected.push({ action, reason: "cap_exceeded" });
        continue;
      }
      simulatedAdds[action.category]++;
      applied.push(action);
      continue;
    }

    // REINFORCE / REFINE / DEPRECATE: check lesson exists and is ACTIVE in this watch's pool
    const all = [
      ...pool.activeByCategory.detecting,
      ...pool.activeByCategory.reviewing,
      ...pool.activeByCategory.finalizing,
    ];
    const lesson = all.find((l) => l.id === action.lessonId);
    if (!lesson || lesson.watchId !== pool.watchId) {
      rejected.push({ action, reason: "lesson_not_found" });
      continue;
    }
    if (lesson.status !== "ACTIVE") {
      rejected.push({ action, reason: "lesson_not_active" });
      continue;
    }

    const pinned = pool.pinnedById.get(action.lessonId) ?? false;
    if (!isAutoActionAllowed({ pinned, action: action.type })) {
      rejected.push({ action, reason: "pinned_lesson" });
      continue;
    }

    if (action.type === "REFINE") {
      const text = `${action.newTitle} ${action.newBody}`;
      if (mentionsAsset(text, pool.watchSymbols)) {
        rejected.push({ action, reason: "asset_mention" });
        continue;
      }
      if (mentionsTimeframe(text, pool.watchTimeframeStrings)) {
        rejected.push({ action, reason: "timeframe_mention" });
        continue;
      }
    }

    if (action.type === "DEPRECATE") {
      simulatedRemovesById.add(action.lessonId);
    }

    applied.push(action);
  }

  return { applied, rejected };
}
