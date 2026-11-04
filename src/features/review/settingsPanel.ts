/**
 * Review's card: the one row that sets `windowDays`.
 *
 * **The core draws the card and the on/off switch; this file draws neither.**
 * `src/core/settingsTab.ts` hands the feature an empty element inside its card,
 * and everything below goes into it. It saves through the feature's own
 * settings handle and calls `saveData` nowhere: `src/core/settings.ts` is the
 * one writer of `data.json`.
 *
 * **The row shows the stored value as it is**, with the refusal beside it when
 * Review cannot use it, never quietly the fallback (`types.ts` says why).
 *
 * **`changed` is accepted and never called.** No readiness answer reads
 * `windowDays`, so there is nothing above this card for a redraw to correct,
 * and calling it would rebuild every card on the screen under a person
 * mid-keystroke, this very box included, for nothing. The count in the
 * status bar is redrawn by the feature, not by this screen.
 *
 * The row is protected for as long as focus is anywhere on it, so a redraw the
 * settings screen runs for a restore that has nothing to do with this box
 * leaves it alone.
 */

import { Setting } from "obsidian";
import type { SettingsChanged } from "../../core/feature";
import { announceFailedSave } from "../../core/saveFailureAnnouncer";
import { protectWhileFocused } from "../../core/settingsTab";
import {
	DEFAULT_REVIEW_SETTINGS,
	storedAsWritten,
	usableWindowDays,
	windowDaysEntryRefusal,
	windowDaysRefusal,
} from "./types";

/** The sentence under the box when the stored value is one Review can use. */
const WINDOW_DAYS_LINE =
	"How many days Review looks at, today included. At the default, today and the six days before it.";

/** What this card needs from the feature, and the whole of it. */
export interface ReviewStore {
	/** The `windowDays` field exactly as `data.json` holds it — an unusable one included. */
	storedWindowDays(): unknown;
	/**
	 * Stores `windowDays` once the typing has stopped, and brings the count in
	 * the status bar into line with it at once. The box changes on every landed
	 * keystroke; only the write waits, so a run of digits is one write rather
	 * than one per character.
	 */
	saveWindowDaysSoon(windowDays: number): Promise<void>;
}

/**
 * The fixed names of the rows this card draws, for Obsidian's settings search. `settingsSearchAliases.test.ts`
 * holds the list to what the card draws.
 */
export const REVIEW_SETTING_NAMES: readonly string[] = ["Days to look at"];

/** Draws the card's body into `parent`. A failed save is said out loud: Obsidian's handlers have nowhere to put a rejected promise. */
export function renderReviewSettings(parent: HTMLElement, store: ReviewStore, _changed?: SettingsChanged): void {
	const stored = store.storedWindowDays();
	const usable = usableWindowDays(stored);

	const row = new Setting(parent)
		.setName("Days to look at")
		.setDesc(windowDaysRefusal(stored) ?? WINDOW_DAYS_LINE)
		.addText((text) => {
			text
				.setPlaceholder(String(DEFAULT_REVIEW_SETTINGS.windowDays))
				.setValue(usable === null ? storedAsWritten(stored) : String(usable))
				.onChange((typed) => {
					const refusal = windowDaysEntryRefusal(typed);
					if (refusal !== null) {
						row.setDesc(refusal);
						return;
					}
					row.setDesc(WINDOW_DAYS_LINE);
					void save(Number(typed.trim()));
				});
		});

	protectWhileFocused(row.settingEl);

	async function save(windowDays: number): Promise<void> {
		try {
			await store.saveWindowDaysSoon(windowDays);
		} catch (error) {
			announceFailedSave(error);
		}
	}
}
