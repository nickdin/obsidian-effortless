/**
 * Meeting notes' card body: the folder notes go in, the person's own address,
 * and the eight field names and headings a note is written with.
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
 * **What `data.json` holds is drawn as it is, with its refusal beside it.**
 * The file is hand-editable, so a value no box could produce can still be
 * stored. Each row shows the stored value and, where the feature cannot use
 * it, the sentence saying so in place of the row's own description — never
 * quietly the fallback, so the load notice's "change it on the card" sends the
 * person to a row showing the value it named.
 *
 * **Saving spreads the stored slice, not the judged one**, so fixing one row
 * never launders another row's unrelated stored value along with it — the
 * rule date entry's card keeps (`src/features/dateEntry/settingsPanel.ts`).
 */

import { Setting } from "obsidian";
import type { SettingsChanged } from "../../core/feature";
import { createSaveFailureAnnouncer } from "../../core/saveFailureAnnouncer";
import type { SaveFailureAnnouncer } from "../../core/saveFailureAnnouncer";
import { protectWhileFocused } from "../../core/settingsTab";
import {
	DEFAULT_TEMPLATE,
	TEMPLATE_FIELDS,
	TEMPLATE_FIELD_NAMES,
	insteadOfRefused,
	storedAsWritten,
	templateFieldRefusal,
} from "./types";
import type { MeetingNoteTemplate } from "./types";

/**
 * The fixed names of the rows this card draws, for Obsidian's settings search. `settingsSearchAliases.test.ts`
 * holds the list to what the card draws.
 */
export const MEETING_NOTES_SETTING_NAMES: readonly string[] = [
	"Meeting notes folder",
	"Your email address",
	...TEMPLATE_FIELDS.map((field) => TEMPLATE_FIELD_NAMES[field]),
];

/**
 * What this card needs from the feature, and the whole of it.
 *
 * `MeetingNotes` has all three and is handed in as itself; a test can hand in
 * a plain object.
 */
export interface MeetingNotesStore {
	/** The slice exactly as `data.json` holds it, defaults filled in only where a field is missing. */
	storedSlice(): Record<string, unknown>;
	/**
	 * Stores a new slice once the typing has stopped. The box changes on every
	 * landed keystroke; only the write waits, so a run of characters is one
	 * write rather than one per character.
	 */
	saveSliceSoon(next: Record<string, unknown>): Promise<void>;
	/**
	 * Says the folder box was committed — Enter, or focus leaving it — so the
	 * feature can run at once if that answer made it ready (spec #701
	 * decision 4, "a switch to `ready` runs it at once").
	 */
	folderCommitted(): void;
}

/** The sentence under the folder box. */
const FOLDER_LINE = "The folder meeting notes are created in. Until it is set, this feature does not run.";

/** The sentence under the address box. */
const SELF_EMAIL_LINE =
	"Your own calendar address, left off the participant list of every meeting note. You may leave it blank.";

/** The sentence under each template row, saying where in a note the field shows up. */
const TEMPLATE_LINES: Readonly<Record<keyof MeetingNoteTemplate, string>> = {
	tag: "The tag every meeting note carries.",
	effortField: "The property a meeting note records its effort in.",
	participantsField: "The property that lists who was invited.",
	notesHeading: "The heading a meeting note opens with.",
	agendaHeading: "The heading the invitation's own text goes under.",
	decisionsHeading: "The heading left for your decisions and actions.",
	logbookHeading: "The heading in a collection where every meeting note naming it in its effort field is linked. A collection without it gets nothing.",
	logbookLineStart: "What each logbook line starts with, before the link: - for a plain list item, or a marked one such as - [i].",
};

/** Why a stored folder or address cannot be used, or `null` where it can. Both must be text; blank is allowed here. */
function textRefusal(name: string, stored: unknown): string | null {
	if (typeof stored === "string") return null;
	return `${name} cannot use the value ${storedAsWritten(stored)} stored here. Enter it again.`;
}

/** Is the stored folder answered, the way readiness reads it? */
export function folderAnswered(stored: unknown): boolean {
	return typeof stored === "string" && stored.trim() !== "";
}

/** The stored `template` as an object to spread over, or an empty one where it is not an object at all. */
function storedTemplate(slice: Record<string, unknown>): Record<string, unknown> {
	const raw = slice.template;
	return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/**
 * Draws the card's body into `parent`.
 *
 * **A refused entry is not stored, and the previous value stays.** The row's
 * description says why, and the box keeps what was typed so the person can
 * fix it where they are looking. No `Notice` is raised for it: a box emptied
 * on the way to a new answer is an ordinary second of typing, and a toast for
 * it is the one the days-ahead card and date entry's trigger box already
 * refuse to raise (`src/__tests__/daysAheadFeature.test.ts`).
 *
 * **`changed` is called only when the folder box is committed and its answer
 * moved between blank and set** — the one edit here that changes what
 * readiness says. Calling it on a keystroke would rebuild the screen under the
 * box and take the caret out of it; every other row
 * changes nothing readiness reads, so nothing above the card needs redrawing
 * for it.
 *
 * **Every row is protected while focus is on it**, so a redraw the settings
 * screen runs for another route's refused write leaves it alone rather than
 * resetting it mid-typing.
 */
export function renderMeetingNotesSettings(
	parent: HTMLElement,
	store: MeetingNotesStore,
	changed?: SettingsChanged,
	announceDeferredSaveFailure?: SaveFailureAnnouncer,
): void {
	const announce = announceDeferredSaveFailure ?? createSaveFailureAnnouncer();
	const drawn = store.storedSlice();

	const save = async (next: Record<string, unknown>): Promise<void> => {
		const write = store.saveSliceSoon(next);
		try {
			await write;
		} catch (error) {
			// Obsidian's handlers have nowhere to put a rejected promise, so a
			// failed write is said here, once for the run of typing, or nowhere.
			announce(write, error);
		}
	};

	let folderWasAnswered = folderAnswered(drawn.meetingNotesFolder);
	const folderRow = new Setting(parent)
		.setName("Meeting notes folder")
		.setDesc(textRefusal("Meeting notes folder", drawn.meetingNotesFolder) ?? FOLDER_LINE)
		.addText((text) => {
			const stored = drawn.meetingNotesFolder;
			text
				.setPlaceholder("Meetings")
				.setValue(typeof stored === "string" ? stored : storedAsWritten(stored))
				.onChange((typed) => {
					folderRow.setDesc(FOLDER_LINE);
					void save({ ...store.storedSlice(), meetingNotesFolder: typed });
				});
			text.inputEl.addEventListener("change", () => {
				const answered = folderAnswered(store.storedSlice().meetingNotesFolder);
				if (answered === folderWasAnswered) return;
				folderWasAnswered = answered;
				store.folderCommitted();
				changed?.();
			});
		});
	protectWhileFocused(folderRow.settingEl);

	const emailRow = new Setting(parent)
		.setName("Your email address")
		.setDesc(textRefusal("Your email address", drawn.selfEmail) ?? SELF_EMAIL_LINE)
		.addText((text) => {
			const stored = drawn.selfEmail;
			text
				.setPlaceholder("name@example.com")
				.setValue(typeof stored === "string" ? stored : storedAsWritten(stored))
				.onChange((typed) => {
					emailRow.setDesc(SELF_EMAIL_LINE);
					void save({ ...store.storedSlice(), selfEmail: typed });
				});
		});
	protectWhileFocused(emailRow.settingEl);

	const template = storedTemplate(drawn);
	for (const field of TEMPLATE_FIELDS) {
		const stored = field in template && template[field] !== undefined ? template[field] : DEFAULT_TEMPLATE[field];
		const refusedOnRead = templateFieldRefusal(field, stored);
		const row = new Setting(parent)
			.setName(TEMPLATE_FIELD_NAMES[field])
			.setDesc(
				refusedOnRead === null
					? TEMPLATE_LINES[field]
					: `${refusedOnRead} The value ${storedAsWritten(stored)} stored here is not used; ${insteadOfRefused(field).row} until this is changed.`,
			)
			.addText((text) => {
				text
					.setPlaceholder(DEFAULT_TEMPLATE[field])
					.setValue(typeof stored === "string" ? stored : storedAsWritten(stored))
					.onChange((typed) => {
						const refusal = templateFieldRefusal(field, typed);
						if (refusal !== null) {
							row.setDesc(refusal);
							return;
						}
						row.setDesc(TEMPLATE_LINES[field]);
						const slice = store.storedSlice();
						void save({ ...slice, template: { ...storedTemplate(slice), [field]: typed } });
					});
			});
		protectWhileFocused(row.settingEl);
	}
}
