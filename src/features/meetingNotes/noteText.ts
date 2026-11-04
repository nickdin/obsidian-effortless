/**
 * A newly created meeting note's whole text.
 *
 * Carried from `~/Devbox/calendar-scaffold/src/meeting-note.ts`'s
 * `meetingNoteText` (lines 147-195), with every hardcoded Swedish key and
 * heading replaced by {@link MeetingNoteTemplate}'s fields.
 *
 * **The effort field starts blank for every note, on every calendar.** The
 * old function pre-filled it with the calendar's own name for a meeting on
 * any calendar but one hardcoded work calendar; that mechanism named one
 * person's calendar and does not come across (open question 3, answered
 * 2026-09-21). A person who wants a starting value for a given calendar can
 * already give the field one by hand, once, the same way it has always been
 * theirs from the moment the note exists.
 */

import type { Meeting } from "../../core/icsReader";
import { meetingNoteTitle } from "../../core/meetingName";
import { SHIPPED_FIELD_NAMES } from "../../core/vaultLayout";
import type { LayoutFieldNames } from "../../core/vaultLayout";
import { withoutJoinBlocks } from "./joinBlock";
import { identityLine } from "./noteIdentity";
import type { MeetingNoteTemplate } from "./types";

/**
 * The text a newly created meeting note is written with.
 *
 * @param date The wikilink target for the day's log this note belongs to —
 *   the day's own naming (`src/core/vaultLayout.ts`), already resolved by
 *   the caller. Embedded as-is, with no folder or extension, the same way
 *   `meetingNoteBasename`'s own wikilink needs none.
 * @param participants The list this note's participants field is written
 *   with, in order — `participants(meeting, selfEmail)`.
 * @param fields The vault layout's day-link and processed field names, which
 *   are the core's and no longer part of the template. Production callers
 *   always hand the layout's; the shipped names are only what a caller that
 *   does not care which names are written gets.
 * @param identity The meeting's `meetingIdentity`, written as one more
 *   frontmatter line for a note meeting notes does not record itself — the one
 *   a click creates (`noteIdentity.ts`). Left out, no such line is written.
 */
export function noteText(
	meeting: Meeting,
	date: string,
	template: MeetingNoteTemplate,
	participants: readonly string[],
	fields: LayoutFieldNames = SHIPPED_FIELD_NAMES,
	identity?: string,
): string {
	const lines: string[] = [
		"---",
		"tags:",
		`  - ${template.tag}`,
		`${template.effortField}:`,
		`${template.participantsField}:`,
		...participants.map((name) => `  - "[[${name}]]"`),
		`${fields.dayLinkField}: "[[${date}]]"`,
		`${fields.processedField}:`,
		...(identity === undefined ? [] : [identityLine(identity)]),
		"---",
		// The same string as the filename's title part, from the same function —
		// so a rename has one heading line to rewrite and the two can never
		// disagree about what the meeting is called.
		`# ${meetingNoteTitle(meeting.summary)}`,
		"",
		template.agendaHeading,
		"",
	];

	// The invitation body, verbatim but for its join blocks (`joinBlock.ts`).
	// Beyond those, only the line endings and the trailing
	// whitespace are touched, and both keep the file's own shape rather than
	// changing the text: a CRLF would be the only one in an otherwise LF file,
	// and trailing blank lines would stack up against the one this format puts
	// before the notes heading.
	const body = withoutJoinBlocks((meeting.description ?? "").replace(/\r\n/g, "\n")).replace(/\s+$/, "");

	if (body.length > 0) lines.push(...body.split("\n"));
	lines.push("");

	lines.push(template.notesHeading, "", "", template.decisionsHeading, "");
	return lines.join("\n");
}
