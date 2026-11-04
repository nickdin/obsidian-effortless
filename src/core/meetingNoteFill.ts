/**
 * The one route by which the day view asks meeting notes for a meeting's
 * filled-in note, without either feature referencing the other.
 *
 * A click on a meeting whose note does not exist yet creates it. Meeting notes
 * knows what such a note says — the template, the participants, the day link —
 * and the day view knows only the link the person clicked. So meeting notes
 * *provides* a function here and the day view *asks* it; this file holds the
 * one slot between them and decides nothing.
 *
 * **Provided when meeting notes is built, not when it starts.** A device that
 * does not build the days leaves meeting notes in `standby`, which the core
 * never starts (`src/core/registry.ts`'s `standsDown`), yet the click happens
 * on exactly such devices — the phone, the laptop. The provider therefore
 * reads its answers when asked and never keeps them from an earlier ask.
 */

/** A note to create for a clicked meeting: where, and with what text. */
export interface FilledMeetingNote {
	/** The vault path meeting notes would create the note at. */
	readonly path: string;
	/** The note's whole text. */
	readonly text: string;
}

/**
 * Answers a click on `linkpath`, a link in the day's log at `sourcePath`:
 * the note meeting notes would create for that meeting, or `null` when it
 * would create none — switched off, no folder, the meeting's calendar not set
 * to make notes, or nothing on that day by that name.
 *
 * **The answer may be a promise**:
 * a click that has to choose among several notes naming one meeting can only
 * choose by their text, and a note's text is read, not known. A provider that
 * needs no read answers at once, as before, and the caller awaits either.
 */
export type MeetingNoteProvider = (linkpath: string, sourcePath: string) => MeetingNoteAnswer;

/** What a provider answers: the note, `null`, or either of them later. */
export type MeetingNoteAnswer = FilledMeetingNote | null | Promise<FilledMeetingNote | null>;

let provider: MeetingNoteProvider | null = null;

/**
 * Makes `next` the answer to {@link filledNoteFor}. Returns the call that
 * takes it back again, which does nothing once a later provider has replaced
 * it.
 */
export function provideMeetingNote(next: MeetingNoteProvider): () => void {
	provider = next;
	return () => {
		if (provider === next) provider = null;
	};
}

/** The note meeting notes would create for the meeting `linkpath` names, or `null`, now or later — see {@link MeetingNoteProvider}. */
export function filledNoteFor(linkpath: string, sourcePath: string): MeetingNoteAnswer {
	return provider === null ? null : provider(linkpath, sourcePath);
}
