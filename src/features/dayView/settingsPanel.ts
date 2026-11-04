/**
 * The day view's one setting, density, and the card that sets it.
 *
 * **The core draws the card and the on/off switch; this file draws neither.**
 * `src/core/settingsTab.ts` hands the feature an empty element inside its card,
 * and everything below goes into it.
 *
 * **It saves through the feature's own settings handle and calls `saveData`
 * nowhere.** Five plugins are merging under one Obsidian manifest id, and
 * Obsidian gives a plugin one `data.json`, so `src/core/settings.ts` is the one
 * writer of that file. The old day view wrote the whole file with only its
 * own setting in it (`~/Devbox/schema-render/src/main.ts:120-121`); carried
 * across, the first feature to save would erase every other feature's.
 *
 * **What `data.json` holds is judged here, on read, the way the card judges a
 * choice.** The file is hand-editable, so a density the dropdown could never
 * produce can still be stored. The feature refuses such a value with a notice
 * and draws at `normal` until it is changed, and the card shows the stored
 * value as it is, with the refusal beside it — never quietly the fallback
 * (#620, the rule after
 * #606).
 */

import { Setting } from "obsidian";
import type { SettingsChanged } from "../../core/feature";
import { announceFailedSave } from "../../core/saveFailureAnnouncer";
import { PIXELS_PER_HOUR } from "./types";
import type { Density } from "./types";

/**
 * The fixed names of the rows this card draws, for Obsidian's settings search. `settingsSearchAliases.test.ts`
 * holds the list to what the card draws.
 */
export const DAY_VIEW_SETTING_NAMES: readonly string[] = ["Density"];

/** The feature's slice of `data.json`. */
export interface DayViewSettings {
	density: Density;
}

/** A fresh install draws at `normal`, 60 pixels an hour, as the old day view did. */
export const DEFAULT_DAY_VIEW_SETTINGS: DayViewSettings = { density: "normal" };

/** What the dropdown offers, in order, and the word it shows for each. */
const DENSITIES: ReadonlyArray<readonly [value: Density, shown: string]> = [
	["compact", "Compact"],
	["normal", "Normal"],
	["spacious", "Spacious"],
];

/** The sentence under the dropdown when the stored density is one it offers. */
const DENSITY_LINE = "How much height an hour of the day takes.";

/**
 * The option value standing for a stored density the dropdown cannot offer.
 * Blank, because no density is blank, so choosing it can never be mistaken
 * for a choice.
 */
const STORED_AS_IS = "";

/**
 * The stored density when it is one of the three, or `null` for anything else
 * `data.json` may hold — another word, a number, nothing at all.
 */
export function usableDensity(stored: unknown): Density | null {
	for (const [value] of DENSITIES) if (stored === value) return value;
	return null;
}

/** A stored value as the person would recognise it in `data.json`: quoted when it is text. */
export function storedAsWritten(stored: unknown): string {
	const written = JSON.stringify(stored);
	return written === undefined ? String(stored) : written;
}

/** The word the card shows for a density: `Normal`, not `normal`. */
export function shownDensity(density: Density): string {
	for (const [value, shown] of DENSITIES) if (value === density) return shown;
	return density;
}

/** Pixels per minute at a density — what the grid is drawn at. */
export function pixelsPerMinute(density: Density): number {
	return PIXELS_PER_HOUR[density] / 60;
}

/**
 * The sentence the card shows in place of {@link DENSITY_LINE} for a stored
 * density the feature cannot use, or `null` for one it can.
 */
export function densityRefusal(stored: unknown): string | null {
	if (usableDensity(stored) !== null) return null;
	return `Day view cannot use the density ${storedAsWritten(stored)} stored here, and draws at ${shownDensity(DEFAULT_DAY_VIEW_SETTINGS.density)} until this is changed.`;
}

/**
 * What this card needs from the feature, and the whole of it: the density as
 * stored, unjudged, and the way to store a new one.
 */
export interface DayViewStore {
	/** The `density` field exactly as `data.json` holds it — an unusable one included. */
	storedDensity(): unknown;
	/** Stores `density` now, and redraws every day on screen at it. One choice, one write. */
	saveDensity(density: Density): Promise<void>;
}

/**
 * Draws the card's body into `parent`.
 *
 * **A stored density the dropdown cannot offer is shown as an option of its
 * own**, labelled with the value as stored, and selected, with the refusal as
 * the row's description. So the card shows what the notice named, and choosing
 * any of the three is a real change of the dropdown — a `<select>` fires no
 * `change` for the option it already shows, which is how a stored language
 * shown as English could not be fixed by choosing English. Choosing that
 * option back stores nothing.
 *
 * **`changed` is called after a save that landed, and only then**, as the
 * core's contract asks. A failed save is said out loud here: Obsidian's
 * handlers have nowhere to put a rejected promise.
 */
export function renderDayViewSettings(parent: HTMLElement, store: DayViewStore, changed?: SettingsChanged): void {
	const panel = parent.createDiv({ cls: "effortless-day-view-settings" });
	const stored = store.storedDensity();
	const usable = usableDensity(stored);

	const row = new Setting(panel)
		.setName("Density")
		.setDesc(densityRefusal(stored) ?? DENSITY_LINE)
		.addDropdown((dropdown) => {
			if (usable === null) dropdown.addOption(STORED_AS_IS, `${storedAsWritten(stored)} (stored, cannot be used)`);
			for (const [value, shown] of DENSITIES) dropdown.addOption(value, shown);
			dropdown.setValue(usable ?? STORED_AS_IS);
			dropdown.onChange((chosen) => {
				const density = usableDensity(chosen);
				if (density === null) return;
				row.setDesc(DENSITY_LINE);
				void save(density);
			});
		});

	async function save(density: Density): Promise<void> {
		try {
			await store.saveDensity(density);
		} catch (error) {
			announceFailedSave(error);
			return;
		}
		changed?.();
	}
}
