/**
 * Meeting notes' record of what it last wrote into a note, and of when the
 * note's meeting ends — what lets a run delete the untouched note of a
 * meeting gone from the calendar, and keep every note a person has added to.
 *
 * **A fingerprint, not a copy.** The memory is kept for ever (`notesMemory.ts`)
 * and lives in `data.json`, so a copy of every note's text would grow it by a
 * note's length per meeting, for ever. The fingerprint is the core's
 * (`src/core/fingerprint.ts`) of the note's whole text: a note whose text differs
 * by so much as a space reads as the person's.
 *
 * **What counts as the plugin's own writing.** Creating a note records its
 * text. An edit meeting notes makes — an added participant, a rename's
 * correction — records the edited text only when the note equalled the
 * record just before the edit; otherwise the person had already changed it,
 * the old record is kept, and the note goes on reading as theirs. A note
 * meeting notes adopted, or made before this record existed, has none and
 * is never deleted.
 */

import { fingerprintOf } from "../../core/fingerprint";

/** What meeting notes last wrote into a note, and when the note's meeting ends. */
export interface WrittenRecord {
	/** {@link fingerprintOf} the note's whole text as meeting notes last wrote it. */
	readonly fingerprint: string;
	/** When the meeting ends, in milliseconds since the epoch — after that, its note is history and is never deleted. */
	readonly endsAt: number;
}

/** A write meeting notes' own run landed on a note: its text before (null for a note it created) and after. */
export interface LandedWrite {
	readonly before: string | null;
	readonly after: string;
}

/**
 * The record to store for a note after this run, given the record it had,
 * the write this run landed on it (`null` for none) and when its meeting ends
 * now. `adopted` is a note meeting notes found rather than made, which never
 * has one. See the module comment for the rule.
 */
export function nextWritten(
	previous: WrittenRecord | undefined,
	write: LandedWrite | null,
	endsAt: number,
	adopted: boolean,
): WrittenRecord | undefined {
	if (adopted) return undefined;
	if (write !== null) {
		if (write.before === null) return { fingerprint: fingerprintOf(write.after), endsAt };
		if (previous !== undefined && fingerprintOf(write.before) === previous.fingerprint) {
			return { fingerprint: fingerprintOf(write.after), endsAt };
		}
	}
	return previous === undefined ? undefined : { fingerprint: previous.fingerprint, endsAt };
}
