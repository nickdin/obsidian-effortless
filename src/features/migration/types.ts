/**
 * Migration's slice of `data.json` — its id and its shipped defaults.
 *
 * The slice holds one value: the collections a person filed into most recently,
 * newest first, so the chooser can open on them. `recentlyUsed.ts` keeps it in
 * order and `migration.ts` reads it when the chooser opens and saves it after a
 * filing. Only the
 * core's settings module saves (`CLAUDE.md`'s invariant grep), so this feature reaches it through
 * `host.settings` and nothing else.
 */

/** Stable for ever: it keys this feature's slice of `data.json`. */
export const FEATURE_ID = "migration";

export interface MigrationSettings {
	/** Paths of the collections most recently filed into, newest first. */
	recentlyUsed: string[];
}

/** The shipped default: nothing filed into yet. */
export const DEFAULT_MIGRATION_SETTINGS: MigrationSettings = { recentlyUsed: [] };
