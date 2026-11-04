/**
 * Date entry's own settings body: which language a typed date is read in, and
 * which character opens the popup.
 *
 * **The core draws the card and the on/off switch; this file draws neither.**
 * `src/core/settingsTab.ts` makes one card per feature, puts the switch on its
 * closed row, and hands the feature an empty `div` inside it. Everything below
 * goes into that `div` and nothing above it is this feature's business.
 *
 * **Nothing here is dragged.** Not one handler: HTML5 drag does not fire from a
 * touch screen, and this feature exists on a phone as much as anywhere.
 *
 * **It saves through the feature's own settings handle and calls `saveData`
 * nowhere.** Five plugins are merging under one Obsidian manifest id and
 * Obsidian gives a plugin one `data.json`, so `src/core/settings.ts` is the one
 * writer of that file. The plugin this feature replaces writes the whole file
 * with only its own settings in it; carried across unchanged, the first feature
 * to save would erase every other feature's.
 *
 * A file of its own rather than more of `dateEntry.ts`, for the reason
 * `src/features/checkboxCycling/settingsPanel.ts` is one: the screen has rules
 * of its own — what a refused character is told, where the sentence sits — and
 * the class that turns a keystroke into a date should not grow a second job.
 */

import { Setting } from "obsidian";
import type { SettingsChanged } from "../../core/feature";
import { announceFailedSave } from "../../core/saveFailureAnnouncer";
import { triggerRefusal } from "./types";
import type { DateEntrySettings } from "./types";

/**
 * What this panel needs from the feature, and the whole of it.
 *
 * Two methods rather than the feature itself, so the panel can be drawn in a
 * test against a plain object and so that nothing here can reach the editor or
 * the settings file directly. `DateEntry` already has both and is handed in as
 * itself.
 */
export interface DateEntryStore {
	/**
	 * The slice exactly as `data.json` holds it — a trigger or language the
	 * feature has judged unusable and fallen back from, included unchanged.
	 * The card draws this, not the feature's own fallback-judged
	 * `DateEntry.settings()`, so a value the load notice named is the value
	 * the person actually sees and can fix.
	 */
	stored(): DateEntrySettings;
	/** Stores a new slice now. One press, one write. */
	saveSettings(next: DateEntrySettings): Promise<void>;
}

/** What the language dropdown offers, in the order it offers them. */
const LANGUAGES: ReadonlyArray<readonly [value: "sv" | "en", shown: string]> = [
	["sv", "Svenska"],
	["en", "English"],
];

/** The sentence under the language dropdown when the stored language is one of the two it offers. */
const LANGUAGE_LINE = "Which language a date you type is read in. It never follows Obsidian's own.";

/** The sentence under the trigger box. */
const TRIGGER_LINE =
	"The one character you type to open the date popup. On a phone keyboard @ sits on the symbol layer, so another character can be quicker to reach.";

/**
 * What the language row's description says instead, when the stored language
 * is neither of the two the dropdown offers, or `null` where it is one of
 * them.
 *
 * `data.json` is in the vault and can be hand-edited, so a language the
 * dropdown itself could never produce can still be stored there; the dropdown
 * cannot show it, so the row's own description names it instead. This is a
 * second copy of the same "`sv` is kept, anything else runs on English" test
 * `DateEntry.settings()` applies at `dateEntry.ts:526` — not a shared call,
 * so the two agree by convention, not by construction; a change to one
 * without the other would let this row disagree with what the popup actually
 * speaks.
 */
function languageProblem(stored: string): string | null {
	if (stored === "sv" || stored === "en") return null;
	return `Date entry cannot use the language ${JSON.stringify(stored)} stored here, and runs on English until this is changed.`;
}

/**
 * The fixed names of the rows this card draws, for Obsidian's settings search. `settingsSearchAliases.test.ts`
 * holds the list to what the card draws.
 */
export const DATE_ENTRY_SETTING_NAMES: readonly string[] = ["Language", "Trigger character"];

/**
 * Draws the body into `parent`.
 *
 * **`changed` is how this panel reaches the card around it**, and the only way
 * it can. It is called once after a save that actually happened, and not at all
 * after one this panel refused — asking the screen to rebuild itself over a
 * change nobody made would be reporting a change nobody made. Neither setting
 * here changes what readiness answers, so nothing visibly moves; it is called
 * because the core's contract is that a feature says when what it stores has
 * changed, and a later reader of the card should not have to work out which
 * saves are exempt.
 *
 * **Every value this card accepts is stored on the keystroke that changes it**,
 * so a redraw of the settings screen — including the one the store asks for
 * when it puts memory back after a refused write — draws what is stored and
 * loses nothing that landed.
 *
 * What a redraw does lose is a trigger the card **refused**: it and its
 * sentence live only in the box until a usable character replaces them, so a
 * redraw arriving mid-correction takes both away. That is the shape
 * #602 describes, standing
 * against the settings screen rather than against this card, and this box is
 * one of the boxes it is about.
 *
 * **Every read here is of the stored slice, never of the feature's judged
 * one.** A value the feature has fallen back from is drawn as what it is —
 * the trigger box shows a stored trigger it refuses with its own refusal
 * sentence beside it, the language row's description names a stored language
 * neither of its two options is — so the load notice's "change it here" is
 * true of the screen the person is looking at. Saving spreads
 * the stored slice too, not the judged one, so fixing one field never
 * launders the other's unrelated bad stored value along with it.
 */
export function renderDateEntrySettings(
	parent: HTMLElement,
	store: DateEntryStore,
	changed?: SettingsChanged,
): void {
	const panel = parent.createDiv({ cls: "effortless-date-entry-settings" });
	const stored = store.stored();

	/** Stores a slice now, saying out loud if the write failed. */
	const save = async (next: DateEntrySettings): Promise<void> => {
		try {
			await store.saveSettings(next);
		} catch (error) {
			// Obsidian's own handlers have nowhere to put a rejected promise, so a
			// failed write is announced here or nowhere: the box would go on showing
			// what was typed and the next reload would quietly drop it.
			announceFailedSave(error);
			return;
		}
		changed?.();
	};

	const languageSetting = new Setting(panel)
		.setName("Language")
		.setDesc(languageProblem(stored.language) ?? LANGUAGE_LINE)
		.addDropdown((dropdown) => {
			for (const [value, shown] of LANGUAGES) dropdown.addOption(value, shown);
			// `chosen` below really can only be one of the two above; Obsidian's
			// dropdown never answers with anything else, so that comparison only
			// turns its plain string back into one of the two for the compiler.
			// `stored.language` here is not the same: `data.json` can hold
			// anything, and this is the fallback that puts an unusable one on
			// English.
			const fallback = stored.language === "sv" ? "sv" : "en";
			dropdown.setValue(fallback);

			const commit = (chosen: string): void => {
				languageSetting.setDesc(LANGUAGE_LINE);
				void save({ ...store.stored(), language: chosen === "sv" ? "sv" : "en" });
			};

			dropdown.onChange(commit);

			/**
			 * A browser's `<select>` fires `change` only when the shown option
			 * differs from the one already selected, so choosing English where it
			 * is already shown -- exactly the fallback for a stored language the
			 * feature does not know -- fires nothing on its own. There is
			 * no DOM event for "the shown option was explicitly re-picked" -- a
			 * real `<select>` is silent on it, the same silence it gives "the
			 * list was opened and closed without a pick". #638's own
			 * mousedown-then-blur attempt at telling those two apart could not,
			 * either, and committed on an abandoned-but-opened control too.
			 *
			 * So instead of reading the gesture after the fact, this disarms the
			 * control the moment the list is about to open -- on `mousedown` for
			 * a mouse, on the `keydown` that opens a focused, closed `<select>`
			 * for a keyboard (`Enter` or `Space`; the arrow keys already move the
			 * value directly and fire a real `change` on their own, needing
			 * nothing here). Disarming sets the dropdown to a value neither
			 * option has, so the *next* pick -- English included, even though it
			 * is already what was shown -- is a real difference from the
			 * control's own point of view, and its native `change` fires for
			 * real, at the moment of the pick, not deferred to a later `blur`.
			 * Picking nothing at all leaves the control on that disarmed,
			 * non-existent value; `blur` is where that is noticed and put back to
			 * what was shown before, without writing anything -- opening the
			 * list and walking away is never a choice.
			 */
			let preOpenValue: string | null = null;
			const arm = (): void => {
				if (preOpenValue !== null) return;
				preOpenValue = dropdown.getValue();
				dropdown.setValue("");
			};
			const opensClosedSelect = (event: Event): boolean =>
				event instanceof KeyboardEvent && (event.key === "Enter" || event.key === " ");
			dropdown.selectEl.addEventListener("mousedown", arm);
			dropdown.selectEl.addEventListener("keydown", (event) => {
				if (opensClosedSelect(event)) arm();
			});
			dropdown.selectEl.addEventListener("blur", () => {
				if (preOpenValue === null) return;
				if (dropdown.getValue() === "") dropdown.setValue(preOpenValue);
				preOpenValue = null;
			});
		});

	// Above the box rather than below it, for the reason the cycling card's
	// refusals sit above theirs: a sentence that appears underneath pushes
	// everything after it down the screen at the moment the person is reading it.
	const refusal = panel.createDiv({ cls: "effortless-date-entry-refusal" });
	// Seeded from the stored trigger through the same reader a keystroke uses,
	// so a trigger the load notice named arrives already showing why.
	refusal.setText(triggerRefusal(stored.trigger) ?? "");

	new Setting(panel)
		.setName("Trigger character")
		.setDesc(TRIGGER_LINE)
		.addText((text) => {
			// **The box carries no length of its own.** `maxlength` is counted in
			// the units a string is stored in and this rule counts code points, so a
			// cap of one would refuse an emoji outright — and refuse it in silence,
			// because a character the browser never admits is one `triggerRefusal`
			// is never asked about.
			text
				.setPlaceholder("@")
				.setValue(stored.trigger)
				.onChange((typed) => {
					// **What was refused is not stored**, and the stored trigger is
					// left exactly as it was. The box keeps what was typed, so the
					// person can fix it where they are looking.
					const said = triggerRefusal(typed);
					if (said !== null) {
						refusal.setText(said);
						return;
					}
					refusal.setText("");
					void save({ ...store.stored(), trigger: typed });
				});
		});
}
