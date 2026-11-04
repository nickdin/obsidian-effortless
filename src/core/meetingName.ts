/**
 * Turning a meeting's title into the text the vault can hold: a note
 * filename, a wikilink target, or a plain table cell.
 *
 * Two features read this module. Building the days ahead writes the
 * wikilink into a day's calendar table; meeting notes needs the
 * identical name to create and rename the note that link points at. What two
 * features must agree on belongs in the core, not in either one's own file.
 *
 * A note name and a plain cell are cleaned differently, because they survive
 * different things:
 *
 *  - **A note name** has to survive being a filename *and* being written
 *    between `[[` and `]]`. `* " \ / < > : | ?` are stripped for
 *    cross-platform portability — they are the printable characters the
 *    Windows filename rule reserves, so a vault synced to a Windows machine
 *    needs them gone regardless of what this plugin's own platform allows.
 *    That much is an inference from Windows' own naming rules rather than a
 *    drive — nobody here has run this on Windows, and the same rule reserves
 *    the control characters and a handful of device names as well, neither of
 *    which this strip covers. What *was* driven is Obsidian's own side, on
 *    Obsidian 1.13.7 on Linux
 *    (`docs/acceptance-shots/issue-707-filename-chars.txt`, Ticket #707):
 *    Obsidian itself refused only three of the nine — `\`, `/` and `:` — and
 *    accepted the other six into a real file without complaint; the strip is
 *    for the vault's sake on every machine it may reach, not because this
 *    Obsidian rejects them. `[ ] # ^` are legal in a filename but change what
 *    a wikilink means, so all thirteen go.
 *  - **A plain table cell** only has to survive the table. A colon or a
 *    slash is fine there — a hand-written row may carry either — and what
 *    has to go is a pipe, a line break, and a square bracket. The first two
 *    break a row outright; the third breaks it one step later, through the
 *    wikilink masking a reader must do before it can split a row on its
 *    pipes — an unclosed `[[` left in one cell swallows the pipe that
 *    follows it, so the row reads as the wrong width and the whole table is
 *    refused from then on.
 *
 * A character that cannot stay is replaced with a space, and the run of
 * spaces that leaves behind is collapsed to one rather than dropped outright
 * — a title cleaned of a colon should still read as two words, not one
 * run-together word.
 */

import type { Meeting } from "./icsReader";

/**
 * What a meeting with no title is called. A meeting's title may legitimately
 * be empty — an untitled meeting is something any calendar can create — and
 * a note or a cell built straight from an empty title would look wrong
 * without saying why.
 */
export const UNTITLED_MEETING_TITLE = "Untitled meeting";

/**
 * Characters that cannot appear in a note name. The first nine are the
 * printable characters the Windows filename rule reserves — kept out for
 * cross-platform portability, an inference from that rule rather than a
 * drive, and not because this plugin's own Obsidian rejects all nine (see
 * the module comment); `[`, `]`, `#` and `^` are legal in a filename but
 * change what a wikilink means, and the name has to work as both.
 */
const UNSAFE_IN_NOTE_NAME = /[*"\\/<>:|?[\]#^]/g;

/**
 * What breaks a table row. A pipe splits it and a line break ends it. A
 * square bracket is the one that is not obvious — see the module comment.
 */
const UNSAFE_IN_CELL = /[|[\]\r\n]/g;

const WHITESPACE_RUN = /\s+/g;

/** The meeting's title, or the placeholder when it has none. */
export function meetingTitle(summary: string): string {
	const trimmed = summary.trim();
	return trimmed.length > 0 ? trimmed : UNTITLED_MEETING_TITLE;
}

/**
 * A title cleaned to survive being both a filename and a wikilink target.
 *
 * Falls back to {@link UNTITLED_MEETING_TITLE} if cleaning empties the string
 * — a title made only of unsafe characters is not something to build a path
 * out of.
 */
function sanitiseNoteName(title: string): string {
	const cleaned = title
		.replace(UNSAFE_IN_NOTE_NAME, " ")
		.replace(WHITESPACE_RUN, " ")
		.trim();
	return cleaned.length > 0 ? cleaned : UNTITLED_MEETING_TITLE;
}

/**
 * The title part of a meeting note: the meeting's title, cleaned, with no
 * date.
 *
 * This is the note's own heading as well as the tail of its filename, and
 * the two have to be the same string — deriving one from the raw summary and
 * the other from the cleaned title would let the two drift apart the moment
 * a summary carried a character either side has to remove.
 */
export function meetingNoteTitle(summary: string): string {
	return sanitiseNoteName(meetingTitle(summary));
}

/**
 * The basename of a meeting note: `YYYY-MM-DD Title`, which is both the
 * filename without its extension and the wikilink target written into a
 * day's table. One function so the two can never disagree.
 *
 * **It carries no folder.** Where a meeting note lives in the vault is not
 * this module's question — it is meeting notes' own setting — and a
 * wikilink built from this basename needs none either: `[[YYYY-MM-DD
 * Title]]` resolves wherever the note sits (driven,
 * `docs/acceptance-shots/issue-707-wikilink-resolution.txt`, Ticket #707).
 */
export function meetingNoteBasename(date: string, summary: string): string {
	return `${date} ${meetingNoteTitle(summary)}`;
}

/**
 * The title as plain text in a table cell. Keeps a colon and a slash;
 * removes only what would break the row (see the module comment).
 */
export function plainCellText(title: string): string {
	const cleaned = title.replace(UNSAFE_IN_CELL, " ").replace(WHITESPACE_RUN, " ").trim();
	return cleaned.length > 0 ? cleaned : UNTITLED_MEETING_TITLE;
}

/**
 * A meeting's location as plain text for a table cell, its own parentheses
 * removed, or null when there is nothing to say.
 *
 * A parenthesis inside the location is removed along with a line break.
 * Left in place, a nested parenthesis would make the cell's own trailing one
 * unreadable to anything that finds a trailing parenthesis by matching
 * `\(([^)]+)\)\s*$` — and a reader that cannot read a cell as a wikilink may
 * then rewrite it into something worse.
 */
export function locationSuffix(location: string): string | null {
	const cleaned = location
		.replace(/[()[\]|\r\n]/g, " ")
		.replace(WHITESPACE_RUN, " ")
		.trim();
	return cleaned.length > 0 ? cleaned : null;
}

/** `date`'s local year, month and day as `YYYY-MM-DD`. */
export function localDateKey(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * The date a meeting's note carries when the run, or the row, is on `day`
 * (`YYYY-MM-DD`).
 *
 * **The rule that tells a several-day meeting from a moved one**: a
 * note is dated the first day of the meeting's current span, and only a day
 * inside that span asks for it. A meeting still running keeps one note under
 * its first day — days two and three land on the same name. An occurrence the
 * calendar moved has a new span, so its first day is the new day and the note
 * remembered under the old date is renamed to it. A `day` outside
 * the span is answered with itself, so nothing that is not this meeting's own
 * day is dated by it.
 *
 * Meeting notes names the note with this and days ahead writes the row's link
 * with it, so the two cannot disagree.
 */
export function meetingNoteDate(meeting: Meeting, day: string): string {
	const first = localDateKey(meeting.start);
	const last = localDateKey(meeting.end);
	return first <= day && day <= last ? first : day;
}
