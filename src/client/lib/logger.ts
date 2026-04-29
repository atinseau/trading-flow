import { getLogger as base } from "@observability/logger";

export const webLogger = base({ component: "tf-web" });

export function childLogger(extra: Record<string, unknown>) {
  return webLogger.child(extra);
}
