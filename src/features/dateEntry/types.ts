/**
 * What date entry's two halves agree on: the slice it stores, the answer its
 * popup draws, the little of Obsidian's editor it writes through, and the one
 * rule about a trigger character that both halves ask.
 *
 * Shapes and one rule, so that the editor half and the settings card agree on
 * a single description of the data without either importing the other's
 * behaviour — `src/features/checkboxCycling/types.ts` is the same file one
 * feature along.
 *
 * **{@link DateAnswer} is derived rather than written out.** `suggest` in
 * `./suggest.ts` names its two answers itself (`RuleAnswer` and
 * `DatePopupAnswer`) and returns their union, on purpose, so that this file is
 * the one place the shape of the whole answer is named. Naming it by
 * deriving it is what keeps the two from drifting: a field added there arrives
 * here with no edit, and one removed there fails here rather than in a caller.
 *
 * **{@link DateEntrySettings} is written out**, because it is the thing a
 * person edits and a reader of this file should be able to see its two fields.
 * It is reconciled with what `suggest` wants by the compiler, at the one call
 * in `dateEntry.ts` that hands one to the other.
 */

import type { EditorTransaction } from "obsidian";
import type { suggest } from "./suggest";

/** The id this feature is registered under, and the key of its settings slice. */
export const FEATURE_ID = "date-entry";

/**
 * This feature's slice of `data.json`: which language a typed date is read in,
 * and which character opens the popup.
 *
 * Both are read again at every keystroke, so neither ever needs a reload.
 */
export interface DateEntrySettings {
	/** `"sv"` or `"en"`. One at a time: the popup shows one suggestion. */
	readonly language: "sv" | "en";
	/** One character, and not a letter, a digit or whitespace. See {@link triggerRefusal}. */
	readonly trigger: string;
}

/**
 * What the feature starts with when nothing is stored.
 *
 * English rather than Swedish, which is spec #573's own decision: a published
 * plugin's first reader cannot be assumed to type Swedish.
 */
export const DEFAULT_DATE_ENTRY_SETTINGS: DateEntrySettings = {
	language: "en",
	trigger: "@",
};

/**
 * One answer from `suggest`: where the trigger sits, which kind of date was
 * asked for, the one suggestion or `null` for the `...` placeholder, and
 * whether the kind's emoji is drawn beside it.
 *
 * `null` — the popup does not open at all — is the one case this type leaves
 * out, because nothing is ever drawn for it.
 */
export type DateAnswer = NonNullable<ReturnType<typeof suggest>>;

/**
 * The part of Obsidian's `Editor` that accepting a suggestion uses.
 *
 * Obsidian's own `Editor` is an abstract class of forty-odd methods that only
 * the running app can supply, and naming it here would make every test of the
 * editor half need one. These two are what accepting a date asks for, and
 * Obsidian's `Editor` has both, so the real thing is handed straight in and a
 * test hands in two functions — the shape `CyclingEditor` in
 * `src/features/checkboxCycling/checkboxCycling.ts` already uses.
 */
export interface DateEntryEditor {
	/**
	 * One line, without its `\n` — but with any carriage return a note written
	 * or synced from Windows put in front of it. Nothing here takes one off:
	 * the line is handed to `stamp`, which rebuilds it around the date and
	 * leaves every other byte where it was, that one included.
	 */
	getLine(line: number): string;
	/**
	 * One edit, and an `origin` so that one undo puts the whole line back: a
	 * single edit alone still folds into the typing before it inside
	 * CodeMirror's grouping window. Obsidian's
	 * own `Editor.transaction` takes the same optional second parameter.
	 */
	transaction(tx: EditorTransaction, origin?: string): void;
}

/**
 * Why `trigger` cannot be the character that opens the popup, or `null` where
 * it can.
 *
 * **One rule, asked from both halves.** The settings card asks it before it
 * stores what was typed, and the editor half asks it of what is already
 * stored, because `data.json` is a file a person can edit by hand and a
 * trigger that got in that way has never passed the card. So it sits here
 * beside the shapes rather than in either half — the way `symbolRefusal` sits
 * beside the sequences one feature along, and for the same reason: the screen
 * supplies the sentence and the rule stays in one place.
 *
 * **The rule is the spec's own**: exactly one character, and
 * not a letter, a digit or whitespace. The popup opens on a trigger at the
 * start of a line or after whitespace, so a letter would open one at the start
 * of every word beginning with it, and whitespace could never be told from the
 * whitespace in front of it. `/` and `§` are ordinary punctuation and are
 * accepted.
 *
 * Counted in code points rather than in the units a string is stored in, which
 * is checkbox cycling's own convention: a plain emoji is one character
 * here as it is on the screen. It is not grapheme counting — an emoji built of
 * several code points, such as one carrying a variation selector or a flag, is
 * refused as more than one character.
 */
export function triggerRefusal(trigger: string): string | null {
	// Asked of a stored value as well as of a typed one, and `data.json` is in
	// the vault: nothing between the file and here checks that a feature's own
	// slice holds what its type says, so this can be handed a number, a null or
	// an object. Counting the characters of one of those throws, and it would
	// throw on every keystroke and again while the settings screen drew. Anything that
	// is not text is refused by the same sentence a person typing nothing gets,
	// because from the popup's side it is the same thing: no trigger.
	if (typeof trigger !== "string") {
		return "A trigger cannot be empty. It is the one character that opens the popup as you type.";
	}
	const points = [...trigger];
	if (points.length === 0) {
		return "A trigger cannot be empty. It is the one character that opens the popup as you type.";
	}
	if (points.length > 1) {
		return `A trigger is one character, and ${quoted(trigger)} is more than one.`;
	}
	if (/\s/u.test(trigger)) {
		return `A trigger cannot be ${quoted(trigger)}. The popup opens on a trigger at the start of a line or after whitespace, so whitespace itself could never be told from what sits in front of it.`;
	}
	if (/\p{L}/u.test(trigger)) {
		return `A trigger cannot be the letter ${quoted(trigger)}. The popup opens on a trigger at the start of a line or after whitespace, so every word beginning with that letter would open one.`;
	}
	if (/\p{N}/u.test(trigger)) {
		return `A trigger cannot be the digit ${quoted(trigger)}. The popup opens on a trigger at the start of a line or after whitespace, so every number beginning with that digit would open one.`;
	}
	return null;
}

/**
 * The trigger the feature actually opens on, given what is stored.
 *
 * A stored trigger the card would refuse is read as the shipped `@`. Nothing a
 * person types on the card can get here — the card refuses it and leaves the
 * stored one alone — but `data.json` is in the vault and can be edited by
 * hand, and an empty trigger there is the one that matters: `suggest` looks
 * for the last occurrence of the trigger in the line, and an empty string is
 * found at the end of every line, so the popup would open on every keystroke
 * anywhere.
 *
 * Read as `@` rather than as no trigger at all, so that a hand-edited file
 * leaves the feature working the way it shipped rather than silently doing
 * nothing. This function itself stays quiet — a keystroke never announces —
 * but `DateEntry.onload` (`./dateEntry.ts`) asks it once at load and shows a
 * one-time notice when the answer differs from what is stored.
 */
export function usableTrigger(stored: string): string {
	return triggerRefusal(stored) === null ? stored : DEFAULT_DATE_ENTRY_SETTINGS.trigger;
}

/**
 * A character as it is shown in a sentence, quoted.
 *
 * Quoted rather than bare because a trigger is punctuation or whitespace, and
 * either written bare into a sentence is a sentence with a hole in it — the
 * reason `settingsPanel.ts` one feature along quotes a symbol.
 */
function quoted(character: string): string {
	return JSON.stringify(character);
}
