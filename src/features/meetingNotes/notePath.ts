/**
 * A meeting note's vault path, and reading one back into the date and title
 * it was built from.
 *
 * Carried from `~/Devbox/calendar-scaffold/src/note-name.ts`'s
 * `meetingNotePath` (folder replaced by this feature's own
 * `meetingNotesFolder` setting rather than a hardcoded constant) and
 * `readMeetingNotePath`, unchanged in logic. This is the
 * feature's own reader. The date a note carries is decided in the core
 * (`meetingNoteDate`, `src/core/meetingName.ts`) and its basename by
 * `meetingNoteBasename` beside it, both shared with days ahead's row link;
 * only the folder is this feature's, so only this feature needs the inverse.
 */

import { meetingNoteBasename } from "../../core/meetingName";

/** The vault path of a meeting's note under `folder`. */
export function meetingNotePath(folder: string, date: string, summary: string): string {
	return `${folder}/${meetingNoteBasename(date, summary)}.md`;
}

/** The date and title a meeting note's path carries. */
export interface MeetingNoteName {
	readonly date: string;
	readonly title: string;
}

/**
 * Reads a meeting note's path back into the date and title
 * {@link meetingNotePath} built it from — the inverse, kept beside it so the
 * two cannot drift apart.
 *
 * Ensuring a note
 * needs this to know what a note was called *before* the calendar renamed or
 * moved the meeting, so it can find that exact `# ` heading line and day-link
 * value and rewrite them and nothing else.
 *
 * **Lossless in the direction that matters.** The title part is
 * `meetingNoteTitle`'s own output, already sanitised, so what comes back is
 * exactly the string the heading holds — not the calendar summary it came
 * from, which is not what the heading says either.
 *
 * Returns `null` for anything whose **filename** is not in this feature's own
 * `YYYY-MM-DD Title` shape — a name the person chose themselves, most likely.
 * A `null` is a refusal to edit, never a guess.
 *
 * **It does not look at the folder.** The only paths this ever sees are ones
 * this feature's own memory recorded, and the memory only ever records what
 * {@link meetingNotePath} built — if that ever stops being true, the caller
 * is the place to check; this function answers one question, and answering
 * two would hide which of them failed.
 */
export function readMeetingNotePath(path: string): MeetingNoteName | null {
	const basename = path.replace(/^.*\//, "").replace(/\.md$/, "");
	const match = basename.match(/^(\d{4}-\d{2}-\d{2}) (.+)$/);
	if (match === null) return null;
	return { date: match[1], title: match[2] };
}
