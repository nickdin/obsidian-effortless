/**
 * Task consistency's slice of `data.json` — its id and its shipped defaults.
 *
 * The slice holds nothing of its own: spec
 * #48 puts this feature's
 * only state inside the files themselves, in the pairing marker (ADR 0002),
 * never in `data.json`. The empty object still goes through
 * `host.settings(DEFAULT_TASK_CONSISTENCY_SETTINGS)` rather than being
 * skipped, the way every other feature takes its slice — a feature that never
 * called `host.settings` would have no keyed place waiting the day it needs
 * one.
 */

/** Stable for ever: it keys this feature's slice of `data.json`. */
export const FEATURE_ID = "task-consistency";

/** Nothing to answer yet. */
export type TaskConsistencySettings = Record<string, never>;

/** The shipped default: an empty slice. */
export const DEFAULT_TASK_CONSISTENCY_SETTINGS: TaskConsistencySettings = {};
