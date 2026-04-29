import type { WatchConfig } from "@domain/schemas/WatchesConfig";

/**
 * Result of validating one row from watch_configs. Either contains a
 * successfully parsed `watch`, or an `error` string describing why parsing
 * failed (missing required fields, type mismatches, etc.).
 *
 * This shape lets callers surface invalid watches to the UI ("recreate watch")
 * without a single bad row crashing the entire system.
 */
export type WatchValidationResult =
  | { id: string; raw: unknown; watch: WatchConfig; error?: never }
  | { id: string; raw: unknown; watch?: never; error: string };

export interface WatchRepository {
  /** All valid (parsed) watches, regardless of enabled status. */
  findAll(): Promise<WatchConfig[]>;
  /** A single watch by id, or null if not found / invalid. */
  findById(id: string): Promise<WatchConfig | null>;
  /** All valid watches with `enabled === true`. */
  findEnabled(): Promise<WatchConfig[]>;
  /** All rows with their validation status (valid + invalid). */
  findAllWithValidation(): Promise<WatchValidationResult[]>;
}
