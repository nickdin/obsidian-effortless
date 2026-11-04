/**
 * A note for a meeting that is on no calendar, made *now*.
 *
 * One press makes the note from the template every calendar-driven note uses,
 * opens it with the cursor under its notes heading, and then puts one link to
 * it in today's log. Nothing is asked first: the title and the participants
 * are filled in afterwards. Recording is not this feature's: Vault Recorder's
 * own meeting button, pressed next, inserts its link under the active note's
 * notes heading, which is why that heading has to be there and in front.
 *
 * **The calendar run never adopts the note.** The run finds a note by its
 * memory, by the identity in its frontmatter, by the placeholder name an
 * untitled meeting once had, or at the path its meeting's title computes
 * (`ensureNote.ts`). This note is in no memory, carries no identity
 * (`noteIdentity.ts`), and is titled by the words for an unplanned meeting
 * and its start time, so the only way a calendar meeting reaches it is one
 * whose own title is exactly those words and that time. A calendar meeting
 * that turns up later at the same time gets its own note, even if that makes
 * two (decided in triage, 2026-11-03).
 *
 * **The link goes under the day's notes heading, never into the calendar
 * section.** Building the days ahead rewrites the calendar table from the
 * calendar, so a row there would vanish at its next run.
 */

import type { TFile } from "obsidian";
import type { Meeting } from "../../core/icsReader";
import { localDateKey, meetingNoteDate } from "../../core/meetingName";
import { reasonOf } from "../../core/reason";
import type { VaultLayout } from "../../core/settings";
import { daySections, sectionOfLine, sectionRange } from "../../core/vaultLayout";
import { dayLinkOrRefusal } from "./ensureNote";
import { withWrittenLineLast } from "./noteIdentity";
import { meetingNotePath } from "./notePath";
import { noteText } from "./noteText";
import type { MeetingNoteTemplate } from "./types";

/** The note to create for an unplanned meeting. */
export interface UnplannedNote {
	/** Its vault path, under the meeting notes folder. */
	readonly path: string;
	/** Its filename without `.md`, which is also the link written into the day's log. */
	readonly basename: string;
	/** Its whole text. */
	readonly text: string;
	/** The line the cursor is put on when it opens: the empty one under the notes heading. */
	readonly cursorLine: number;
}

/**
 * The note an unplanned meeting starting at `now` gets, or why it gets none.
 *
 * Titled `title` and the start time as `HHMM` — with no colon, which a note
 * name cannot hold (`meetingName.ts`), and no dot, which a link could read as
 * a file's extension — so two meetings a minute apart get two notes. The date
 * and the name are the calendar-driven notes' own (`meetingNoteDate`,
 * `meetingNotePath`), and the text is `noteText` over a meeting of that title
 * with no invitation and nobody invited, so the template is the one the person
 * set and is never copied here. Refused, with the core's own sentence, where
 * the day's log has no folder or pattern yet, as the calendar run refuses.
 */
export function unplannedNote(
	now: Date,
	folder: string,
	template: MeetingNoteTemplate,
	layout: VaultLayout,
	title: string,
): UnplannedNote | { readonly refused: string } {
	const meeting = meetingAt(now, `${title} ${twoDigits(now.getHours())}${twoDigits(now.getMinutes())}`);
	const date = meetingNoteDate(meeting, localDateKey(now));
	const day = dayLinkOrRefusal(date, layout);
	if ("refused" in day) return day;
	const path = meetingNotePath(folder, date, meeting.summary);
	const text = withWrittenLineLast(noteText(meeting, day.target, template, [], layout));
	return {
		path,
		basename: path.replace(/^.*\//, "").replace(/\.md$/, ""),
		text,
		cursorLine: text.split("\n").indexOf(template.notesHeading) + 1,
	};
}

/**
 * The meeting `noteText` and `meetingNoteDate` are asked about: starting and
 * ending `now`, so its date is today's, and with no calendar behind it — no
 * uid, no organiser, nobody invited, no invitation text.
 */
function meetingAt(now: Date, summary: string): Meeting {
	return {
		uid: "",
		summary,
		location: null,
		description: null,
		organizer: null,
		attendees: [],
		occurrenceKey: null,
		allDay: false,
		start: now,
		end: now,
	};
}

function twoDigits(value: number): string {
	return String(value).padStart(2, "0");
}

/**
 * `day`, today's log, with a line linking `basename` after the last line the
 * person wrote under the notes heading — or straight under the heading when
 * nothing is written there — and a blank line before it, so a list above does
 * not take it in as one of its items. `null` when the day has no notes heading:
 * the person's day is not restructured to make room.
 *
 * A line belongs to the notes section when the core's `sectionOfLine` says
 * so (`vaultLayout.ts`): with the shipped layout the notes heading is level 1
 * and the sections after it level 2, so by levels alone the calendar would sit
 * inside it. The heading line of the section after it is not the notes'
 * either, though `sectionOfLine` counts it there: a section's range starts on
 * the line below its heading. Windows line endings are kept
 * on every line written, and a note with no final line break is left without one.
 */
export function withDayLink(day: string, basename: string, layout: VaultLayout): string | null {
	const notes = sectionRange(day, "notesHeading", layout);
	if (notes === null) return null;
	const lines = day.split("\n");
	const headings = new Set(daySections().map((section) => sectionRange(day, section, layout)?.heading));
	let last = notes.heading;
	for (let i = notes.start; i < notes.end; i += 1) {
		if (headings.has(i) || lines[i].replace(/\r$/, "").trim() === "") continue;
		if (sectionOfLine(day, i, layout) === "notesHeading") last = i;
	}
	const eol = day.includes("\r\n") ? "\r" : "";
	const link = `[[${basename}]]`;
	const atEnd = last === lines.length - 1;
	// The line that was last keeps no ending it did not have; the link takes its place as last.
	if (atEnd) {
		lines[last] = lines[last].replace(/\r$/, "") + eol;
		lines.splice(last + 1, 0, eol, link);
	} else {
		lines.splice(last + 1, 0, eol, link + eol);
	}
	return lines.join("\n");
}

/** What the unplanned-meeting command needs from Obsidian and the core, so it can be driven without either. */
export interface UnplannedPorts {
	readonly now: Date;
	/** The meeting notes folder; blank means the feature is not set up. */
	readonly folder: string;
	readonly template: MeetingNoteTemplate;
	readonly layout: VaultLayout;
	/** The words for an unplanned meeting, in the display language. */
	readonly title: string;
	/** The note at `path`, or `null`. */
	fileAt(path: string): TFile | null;
	/** The core's `NoteWriter.create`. */
	create(path: string, text: string): Promise<TFile>;
	/** Opens `file` in the active pane with the cursor on `line`. */
	open(file: TFile, line: number): Promise<void>;
	/** The core's `NoteWriter.createDailyLog`: today's log, created the way the core creates a day if it is not there. */
	todaysLog(date: Date, layout: VaultLayout): Promise<TFile>;
	/** The core's `NoteWriter.edit`, as a write the person asked for. */
	edit(file: TFile, edit: (content: string) => string): Promise<string>;
	notice(message: string): void;
}

/**
 * The command itself: makes the note, opens it, then links it from today's
 * log. Every refusal and failure is said in a notice; once the note is open a
 * failure to link it leaves it open, since the meeting is what matters.
 *
 * Pressed twice within one minute, the second press opens the note the first
 * made and links nothing again: an accidental double press is not a second
 * meeting. That holds for a second press made while the first one's note is
 * still being written, too.
 */
export async function startUnplannedMeeting(ports: UnplannedPorts): Promise<void> {
	if (ports.folder.trim() === "") {
		ports.notice("Effortless: no note was made for the unplanned meeting. Enter the meeting notes folder on the Meeting notes card first.");
		return;
	}
	const note = unplannedNote(ports.now, ports.folder, ports.template, ports.layout, ports.title);
	if ("refused" in note) {
		ports.notice(`Effortless: no note was made for the unplanned meeting. ${note.refused}`);
		return;
	}

	let already = ports.fileAt(note.path);
	let file: TFile;
	try {
		file = already ?? (await ports.create(note.path, note.text));
	} catch (error) {
		// A press while an earlier press's note was still being written finds no
		// note, and the writer refuses its own once it finds the earlier one there:
		// that note is opened, as a second press in the minute opens it.
		already = ports.fileAt(note.path);
		if (already === null) {
			ports.notice(`Effortless: no note was made for the unplanned meeting. ${reasonOf(error)}`);
			return;
		}
		file = already;
	}
	try {
		await ports.open(file, note.cursorLine);
	} catch (error) {
		ports.notice(`Effortless: the unplanned meeting's note "${note.path}" was made but could not be opened. ${reasonOf(error)}`);
	}
	if (already !== null) return;

	try {
		const day = await ports.todaysLog(ports.now, ports.layout);
		let refused = false;
		await ports.edit(day, (content) => {
			const next = withDayLink(content, note.basename, ports.layout);
			refused = next === null;
			return next ?? content;
		});
		if (refused) {
			ports.notice(
				`Effortless: the unplanned meeting's note was made, but today's log has no "${ports.layout.notesHeading.text}" heading to link it under.`,
			);
		}
	} catch (error) {
		ports.notice(`Effortless: the unplanned meeting's note was made, but it could not be linked from today's log. ${reasonOf(error)}`);
	}
}
