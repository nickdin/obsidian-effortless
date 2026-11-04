/**
 * A newly created meeting note's text — ticket
 * #759, carried from
 * `~/Devbox/calendar-scaffold/tests/meeting-note.test.ts`'s `meetingNoteText`
 * cases with the template's English field names substituted for the old
 * Swedish ones. No real name, address, path or calendar is in this file.
 */

import { describe, expect, it } from "vitest";
import type { Meeting } from "../core/icsReader";
import { meetingNoteTitle } from "../core/meetingName";
import { noteText } from "../features/meetingNotes/noteText";
import { DEFAULT_TEMPLATE } from "../features/meetingNotes/types";
import type { MeetingNoteTemplate } from "../features/meetingNotes/types";

const DATE = "2026-09-21";

function meeting(partial: Partial<Meeting> = {}): Meeting {
	return {
		uid: "uid-1",
		summary: "Weekly sync",
		location: null,
		description: null,
		organizer: null,
		attendees: [],
		occurrenceKey: null,
		allDay: false,
		start: new Date(2026, 8, 21, 9, 0),
		end: new Date(2026, 8, 21, 9, 30),
		...partial,
	};
}

const TEMPLATE_OUTPUT = [
	"---",
	"tags:",
	"  - meeting",
	"effort:",
	"participants:",
	'  - "[[Bo Bergman]]"',
	'  - "[[Cia Cedergren]]"',
	`day: "[[${DATE}]]"`,
	"processed:",
	"---",
	"# Weekly sync",
	"",
	"## Agenda and purpose",
	"",
	"",
	"# Notes",
	"",
	"",
	"## Decisions and actions",
	"",
].join("\n");

describe("noteText — the whole text of a newly created note", () => {
	it("produces every template field and heading in the old function's order", () => {
		expect(noteText(meeting(), DATE, DEFAULT_TEMPLATE, ["Bo Bergman", "Cia Cedergren"])).toBe(
			TEMPLATE_OUTPUT,
		);
	});

	it("produces a whole note for a meeting with a title, a description and two participants", () => {
		// #769: the whole-text test above has no description, so it does not
		// evidence where the description lands relative to the headings, or
		// that a multi-line description keeps its lines.
		const description = "Hi!\n\n- First point\n- Second point\n\n/Bo";
		const expected = [
			"---",
			"tags:",
			"  - meeting",
			"effort:",
			"participants:",
			'  - "[[Bo Bergman]]"',
			'  - "[[Cia Cedergren]]"',
			`day: "[[${DATE}]]"`,
			"processed:",
			"---",
			"# Weekly sync",
			"",
			"## Agenda and purpose",
			"",
			"Hi!",
			"",
			"- First point",
			"- Second point",
			"",
			"/Bo",
			"",
			"# Notes",
			"",
			"",
			"## Decisions and actions",
			"",
		].join("\n");

		expect(
			noteText(meeting({ description }), DATE, DEFAULT_TEMPLATE, ["Bo Bergman", "Cia Cedergren"]),
		).toBe(expected);
	});

	it("leaves the effort field blank", () => {
		expect(noteText(meeting(), DATE, DEFAULT_TEMPLATE, [])).toContain(
			"\neffort:\nparticipants:",
		);
	});

	it("leaves the effort field blank whatever the meeting", () => {
		expect(
			noteText(meeting({ uid: "uid-other", summary: "Another meeting" }), DATE, DEFAULT_TEMPLATE, []),
		).toContain("\neffort:\nparticipants:");
	});

	it("leaves the agenda section empty but present when there is no description", () => {
		const text = noteText(meeting({ description: null }), DATE, DEFAULT_TEMPLATE, []);
		expect(text).toContain("## Agenda and purpose\n\n\n# Notes");
	});

	it("puts the invitation body under the agenda heading, verbatim", () => {
		const body = "Hi!\n\n- First point\n- Second point\n\n/Bo";
		const text = noteText(meeting({ description: body }), DATE, DEFAULT_TEMPLATE, []);
		expect(text).toContain(`## Agenda and purpose\n\n${body}\n\n# Notes`);
	});

	it("keeps a `#` inside the invitation body, which is the person's own text and not a heading", () => {
		const text = noteText(meeting({ description: "See ticket #4711" }), DATE, DEFAULT_TEMPLATE, []);
		expect(text).toContain("See ticket #4711");
	});

	it("normalises CRLF, so one description cannot make a file with mixed line endings", () => {
		const text = noteText(
			meeting({ description: "Line one\r\nLine two" }),
			DATE,
			DEFAULT_TEMPLATE,
			[],
		);
		expect(text).not.toContain("\r");
		expect(text).toContain("Line one\nLine two");
	});

	it("does not stack blank lines when the description ends with them", () => {
		const text = noteText(meeting({ description: "Hi!\n\n\n" }), DATE, DEFAULT_TEMPLATE, []);
		expect(text).toContain("## Agenda and purpose\n\nHi!\n\n# Notes");
	});

	it("writes every participant, each on its own quoted line", () => {
		const text = noteText(meeting(), DATE, DEFAULT_TEMPLATE, ["Bo Bergman", "Cia Cedergren"]);
		expect(text).toContain(
			'participants:\n  - "[[Bo Bergman]]"\n  - "[[Cia Cedergren]]"\nday:',
		);
	});

	it("produces a custom template's fields and no English or Swedish default", () => {
		const custom: MeetingNoteTemplate = {
			tag: "gathering",
			effortField: "work",
			participantsField: "invited",
			notesHeading: "# Own notes",
			agendaHeading: "## Purpose",
			decisionsHeading: "## Outcomes",
			logbookHeading: "## Log",
			logbookLineStart: "- [i]",
		};
		const text = noteText(meeting(), DATE, custom, ["Bo Bergman"], { dayLinkField: "log", processedField: "filed", diaryDateField: "journal" });

		expect(text).toContain("  - gathering");
		expect(text).toContain("work:");
		expect(text).toContain('invited:\n  - "[[Bo Bergman]]"');
		expect(text).toContain(`log: "[[${DATE}]]"`);
		expect(text).toContain("filed:");
		expect(text).toContain("## Purpose");
		expect(text).toContain("# Own notes");
		expect(text).toContain("## Outcomes");

		expect(text).not.toContain("effort");
		expect(text).not.toContain("participants:");
		expect(text).not.toContain("day:");
		expect(text).not.toContain("processed:");
		expect(text).not.toContain("Agenda");
		expect(text).not.toContain("Notes");
		expect(text).not.toContain("Decisions");
		expect(text).not.toContain("möte");
		expect(text).not.toContain("ansträngning");
		expect(text).not.toContain("deltagare");
		expect(text).not.toContain("daglogg");
		expect(text).not.toContain("bearbetad");
		expect(text).not.toContain("Anteckningar");
	});

	it("heads the note with the same title the core's naming module gives the same summary", () => {
		const summary = "Status: part one\npart two";
		const text = noteText(meeting({ summary }), DATE, DEFAULT_TEMPLATE, []);
		expect(text).toContain(`# ${meetingNoteTitle(summary)}\n\n## Agenda and purpose`);
	});

	it("names an untitled meeting rather than heading the note with nothing", () => {
		const text = noteText(meeting({ summary: "" }), DATE, DEFAULT_TEMPLATE, []);
		expect(text).toContain(`# ${meetingNoteTitle("")}`);
	});
});
