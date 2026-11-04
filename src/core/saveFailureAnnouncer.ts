/**
 * Saying out loud that a setting was not stored, and saying it once.
 *
 * The sentence lives here because three settings sections raise it — the core
 * card's own boxes, the calendar rows and, since #538, the Checkbox cycling
 * card's name box — and the shape of the deferred write makes one copy each
 * wrong. The store holds one pending write for the whole plugin and answers
 * every deferred caller inside the window with the same promise, whichever
 * route it came by, so a run of typing that crossed two sections used to
 * arrive in two `catch` blocks, each holding its own flag, each finding it
 * unset, each announcing. The person was told twice about one failed write:
 * between the core card and the calendar rows, and again between
 * the core card and the Checkbox cycling panel, which held a second announcer
 * behind the feature boundary. All three now
 * share one announcer, the screen's.
 *
 * **The promise is the run's own name**, which is #186's mechanism and is not
 * replaced here by a counter or an id: a rejection from the run already
 * announced is skipped, and a later run is a different promise and speaks for
 * itself.
 *
 * **The store learns nothing about any of this.** Announcing is the settings
 * screen's job alone, so the announcer is built by the screen and handed down
 * to the sections it draws — a feature's panel through `displaySettings`,
 * beside `changed`, since #569; `settings.ts` stays the one caller of `saveData`
 * and goes on knowing nothing about notices.
 */

import { Notice } from "obsidian";
import { reasonOf } from "./reason";

/**
 * Says out loud that a setting was not stored. The same shape the feature
 * registry uses for a feature that would not start, so the two read alike.
 *
 * This is the one copy of that sentence. Callers with nothing to deduplicate —
 * a switch, a button, a write to the per-device store — reach it directly;
 * anything on the deferred route goes through {@link SaveFailureAnnouncer}
 * instead, which ends up here once per run.
 */
export function announceFailedSave(error: unknown): void {
	const detail = reasonOf(error);
	new Notice(`Effortless: that setting could not be saved. ${detail}`);
}

/**
 * Announces a failed deferred write, once for the run rather than once for each
 * caller that joined it.
 *
 * `run` is the promise `saveCoreSoon` or a feature handle's `saveSoon` answered
 * with — the same one for both inside a window, and the run's identity — and
 * `error` is what it rejected with.
 */
export type SaveFailureAnnouncer = (run: Promise<void>, error: unknown) => void;

/**
 * Makes one announcer, holding the last run it spoke about.
 *
 * One of these is made per settings screen and shared by every section on it,
 * rather than left at module scope: a module-level flag would outlive the
 * screen for no gain, and a shared one made where both sections are reachable
 * is explicit and can be handed to a test.
 */
export function createSaveFailureAnnouncer(): SaveFailureAnnouncer {
	/** The run this announcer has already spoken about, and `null` before any. */
	let announced: Promise<void> | null = null;
	return (run, error) => {
		if (announced === run) return;
		announced = run;
		announceFailedSave(error);
	};
}
