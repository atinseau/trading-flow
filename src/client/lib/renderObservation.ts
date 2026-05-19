import type { Observation } from "@domain/schemas/Verdict";

/**
 * Accepts an `Observation` (`{kind, text, evidence?}`) or a bare string and
 * returns a renderable string. The pipeline canonically emits
 * `Observation` objects, but some older payloads / fixtures still ship
 * plain strings. Without this helper, rendering an `Observation` directly
 * as a React child throws "Objects are not valid as a React child".
 */
export function renderObservation(o: Observation | string): string {
  return typeof o === "string" ? o : o.text;
}
