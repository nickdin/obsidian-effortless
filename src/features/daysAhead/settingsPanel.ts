/**
 * Building the days ahead's one setting a person can change, `windowDays`, and
 * the card row that sets it.
 *
 * **The core draws the card and the on/off switch; this file draws neither.**
 * `src/core/settingsTab.ts` hands the feature an empty element inside its card,
 * and everything below goes into it.
 *
 * **It saves through the feature's own settings handle and calls `saveData`
 * nowhere.** Five plugins are merging under one Obsidian manifest id, and
 * Obsidian gives a plugin one `data.json`, so `src/core/settings.ts` is the one
 * writer of that file.
 *
 * **What `data.json` holds is judged here, on read, the way the box judges what
 * is typed into it.** The file is hand-editable, so a number the box could
 * never produce can still be stored. The feature refuses such a value with a
 * notice and uses the shipped default until it is changed, and the row shows
 * the stored value as it is, with the refusal beside it — never quietly the
 * fallback (the rule this repository's `CLAUDE.md` records from
 * #606 and
 * #607; the day view's
 * density does the same, `src/features/dayView/settingsPanel.ts`).
 */

import { Setting } from "obsidian";
import type { SettingsChanged } from "../../core/feature";
import { announceFailedSave } from "../../core/saveFailureAnnouncer";
import { protectWhileFocused } from "../../core/settingsTab";
import type { RowMemory } from "./rowMemory";

/**
 * The fixed names of the rows this card draws, for Obsidian's settings search. `settingsSearchAliases.test.ts`
 * holds the list to what the card draws.
 */
export const DAYS_AHEAD_SETTING_NAMES: readonly string[] = ["Days ahead"];

/**
 * The feature's slice of `data.json`: `windowDays`, this card's own field, and
 * `rows`, this feature's memory of what it last wrote into a day's table
 * (built by #696, read
 * and written by #698's
 * run).
 *
 * **`rows` is read exactly like `windowDays`: validated on read, never
 * trusted as stored.** `data.json` is hand-editable, so `readRowMemory` is
 * the door every reader of it goes through (`rowMemory.ts`, from
 * #606 and
 * #607); this interface
 * only says what a valid slice looks like, the same way `windowDays: number`
 * here does not itself guard against a stored string.
 *
 * `rows` has no row on this card. A person does not edit it, and nothing
 * draws it.
 */
export interface DaysAheadSettings {
	windowDays: number;
	rows: RowMemory;
}

/** A fresh install keeps seven days ready, as `calendar-scaffold` did, with no memory yet. */
export const DEFAULT_DAYS_AHEAD_SETTINGS: DaysAheadSettings = { windowDays: 7, rows: {} };

const MIN_WINDOW_DAYS = 1;
/** Exported so a test holds a calendar account's fixed span to reach past it. */
export const MAX_WINDOW_DAYS = 60;

/** The sentence under the box when the stored value is one the box can offer. */
const WINDOW_DAYS_LINE =
	"How many days ahead, today included, to keep a log ready for. At the default, today through today plus six.";

/**
 * The stored `windowDays` when it is a whole number from 1 to 60, or `null`
 * for anything else `data.json` may hold — text, a fraction, out of range,
 * nothing at all.
 */
export function usableWindowDays(stored: unknown): number | null {
	if (typeof stored !== "number" || !Number.isInteger(stored)) return null;
	if (stored < MIN_WINDOW_DAYS || stored > MAX_WINDOW_DAYS) return null;
	return stored;
}

/** A stored value as the person would recognise it in `data.json`: quoted when it is text. */
export function storedAsWritten(stored: unknown): string {
	const written = JSON.stringify(stored);
	return written === undefined ? String(stored) : written;
}

/**
 * The sentence the row shows in place of {@link WINDOW_DAYS_LINE} for a
 * stored `windowDays` the feature cannot use, or `null` for one it can. Also
 * what the load notice names.
 */
export function windowDaysRefusal(stored: unknown): string | null {
	if (usableWindowDays(stored) !== null) return null;
	return `Days ahead cannot use the value ${storedAsWritten(stored)} stored here, and keeps ${DEFAULT_DAYS_AHEAD_SETTINGS.windowDays} until this is changed.`;
}

/** What was typed into the box, as a whole number, or `null` for anything else — blank included. */
function parsedWindowDays(typed: string): number | null {
	const trimmed = typed.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	return Number(trimmed);
}

/**
 * The sentence to show for what was just typed into the box, or `null` when
 * it may be stored as it stands. Refuses a non-whole-number the same as one
 * out of range, so 0, 61 and `"seven"` alike leave the stored value untouched.
 */
export function windowDaysEntryRefusal(typed: string): string | null {
	const parsed = parsedWindowDays(typed);
	if (parsed === null) {
		return `Days ahead must be a whole number from ${MIN_WINDOW_DAYS} to ${MAX_WINDOW_DAYS}.`;
	}
	if (parsed < MIN_WINDOW_DAYS || parsed > MAX_WINDOW_DAYS) {
		return `Days ahead must be from ${MIN_WINDOW_DAYS} to ${MAX_WINDOW_DAYS}, not ${parsed}.`;
	}
	return null;
}

/**
 * What this card needs from the feature, and the whole of it: `windowDays` as
 * stored, unjudged, and the way to store a new one.
 */
export interface DaysAheadStore {
	/** The `windowDays` field exactly as `data.json` holds it — an unusable one included. */
	storedWindowDays(): unknown;
	/**
	 * Stores `windowDays` once the typing has stopped. The box changes on every
	 * landed keystroke; only the write waits, until typing has stopped for
	 * `SAVE_AFTER_TYPING_MS`, so a run of digits is one write rather than one
	 * per character.
	 */
	saveWindowDaysSoon(windowDays: number): Promise<void>;
}

/**
 * Draws the card's body into `parent`.
 *
 * **What was refused is not stored**, and the box keeps what was typed so the
 * person can fix it where they are looking — the same rule date entry's
 * trigger box keeps (`src/features/dateEntry/settingsPanel.ts`).
 *
 * **`changed` is accepted, for the shape every feature's `displaySettings` is
 * called with, and never called.** No readiness answer reads `windowDays` —
 * the value only matters to the run this ticket does not build yet — so
 * there is nothing above this card for a redraw to correct. Calling it
 * anyway would rebuild every card on the screen under a person
 * mid-keystroke and replace this very box for nothing: the failure
 * #108 records and
 * #712 found here,
 * exactly the shape checkbox cycling's rename box already avoids.
 *
 * **The row is protected for as long as focus is anywhere on it**, so a
 * redraw the settings screen runs for a store restore that has nothing to do
 * with this box — another route's write failing, mid-typing here — leaves it
 * alone rather than resetting it and taking the caret with it.
 *
 * A failed save is said out loud here: Obsidian's handlers have nowhere to
 * put a rejected promise.
 */
export function renderDaysAheadSettings(parent: HTMLElement, store: DaysAheadStore, _changed?: SettingsChanged): void {
	const stored = store.storedWindowDays();
	const usable = usableWindowDays(stored);

	const row = new Setting(parent)
		.setName("Days ahead")
		.setDesc(windowDaysRefusal(stored) ?? WINDOW_DAYS_LINE)
		.addText((text) => {
			text
				.setPlaceholder(String(DEFAULT_DAYS_AHEAD_SETTINGS.windowDays))
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
