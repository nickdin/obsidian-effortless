/**
 * The words meeting notes shows a person while it is used, in the language
 * Obsidian is displayed in.
 *
 * **Swedish when Obsidian answers `sv`, English for every other answer**, the
 * rule Review's words keep (`src/features/review/words.ts`): the language is
 * Obsidian's own `getLanguage` (`node_modules/obsidian/obsidian.d.ts:3365`),
 * asked when the words are wanted, never kept. A change of display language
 * goes through Obsidian's relaunch, which reloads the plugin, so the command
 * and the icon are offered afresh in the new words.
 *
 * The settings card and every `Notice` stay English, as Review's do.
 */

import { getLanguage } from "obsidian";

/** Every word of meeting notes that follows the display language, for one language. */
export interface MeetingNotesWords {
	/** The command's name in the palette, and the ribbon icon's title. */
	readonly unplannedCommand: string;
	/** What an unplanned meeting's note is called, before its start time. */
	readonly unplannedTitle: string;
}

const ENGLISH: MeetingNotesWords = {
	unplannedCommand: "New note for an unplanned meeting",
	unplannedTitle: "Unplanned meeting",
};

const SWEDISH: MeetingNotesWords = {
	unplannedCommand: "Ny anteckning för ett oplanerat möte",
	unplannedTitle: "Oplanerat möte",
};

/** Meeting notes' words in the language Obsidian is displayed in now. */
export function meetingNotesWords(): MeetingNotesWords {
	return getLanguage() === "sv" ? SWEDISH : ENGLISH;
}
