/**
 * The note an unplanned meeting gets, and the one link line today's log gains
 * for it: the
 * pure half of meeting notes' unplanned-meeting command, with no Obsidian in
 * the way. The command itself is driven in `meetingNotesFeature.test.ts`.
 *
 * Every folder and title here is invented.
 */

import { describe, expect, it } from "vitest";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { unchangedSinceWritten, withWrittenLineLast, writtenInText, IDENTITY_FIELD } from "../features/meetingNotes/noteIdentity";
import { noteText } from "../features/meetingNotes/noteText";
import { DEFAULT_TEMPLATE } from "../features/meetingNotes/types";
import { unplannedNote, withDayLink } from "../features/meetingNotes/unplannedMeeting";

function layout(): VaultLayout {
	return { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };
}

const NOW = new Date(2026, 10, 4, 14, 5, 30);

describe("the note an unplanned meeting gets", () => {
	it("is the template's note for a meeting titled by the time, dated today, under the meetings folder, marked as written", () => {
		const note = unplannedNote(NOW, "Meetings", DEFAULT_TEMPLATE, layout(), "Unplanned meeting");
		if ("refused" in note) throw new Error(note.refused);

		expect(note.path).toBe("Meetings/2026-11-04 Unplanned meeting 1405.md");
		expect(note.basename).toBe("2026-11-04 Unplanned meeting 1405");
		// Written out by hand, the fingerprint line aside: what the template makes of this title.
		const lines = note.text.split("\n");
		const written = lines.findIndex((line) => line.startsWith("effortless-written: "));
		expect(written).toBeGreaterThan(0);
		expect([...lines.slice(0, written), ...lines.slice(written + 1)].join("\n")).toBe(
			[
				"---",
				"tags:",
				"  - meeting",
				"effort:",
				"participants:",
				'day: "[[2026-11-04]]"',
				"processed:",
				"---",
				"# Unplanned meeting 1405",
				"",
				"## Agenda and purpose",
				"",
				"",
				"# Notes",
				"",
				"",
				"## Decisions and actions",
				"",
			].join("\n"),
		);
		// The mark is the frontmatter's last line, and it fingerprints the body as written.
		expect(written).toBe(lines.indexOf("---", 1) - 1);
		expect(writtenInText(note.text)).not.toBeNull();
		expect(unchangedSinceWritten(note.text)).toBe(true);
	});

	it("is built by the template's own noteText, with nobody invited and no meeting identity", () => {
		const note = unplannedNote(NOW, "Meetings", DEFAULT_TEMPLATE, layout(), "Unplanned meeting");
		if ("refused" in note) throw new Error(note.refused);
		const meeting = {
			uid: "",
			summary: "Unplanned meeting 1405",
			location: null,
			description: null,
			organizer: null,
			attendees: [],
			occurrenceKey: null,
			allDay: false,
			start: NOW,
			end: NOW,
		};
		const withoutMark = note.text
			.split("\n")
			.filter((line) => !line.startsWith("effortless-written: "))
			.join("\n");

		expect(withoutMark).toBe(noteText(meeting as never, "2026-11-04", DEFAULT_TEMPLATE, [], layout()));
		// And whole, mark included: the template's text with the written line as the frontmatter's last.
		expect(note.text).toBe(withWrittenLineLast(noteText(meeting as never, "2026-11-04", DEFAULT_TEMPLATE, [], layout())));
		expect(note.text).not.toContain(`${IDENTITY_FIELD}:`);
	});

	it("puts the cursor on the empty line under the notes heading", () => {
		const note = unplannedNote(NOW, "Meetings", DEFAULT_TEMPLATE, layout(), "Unplanned meeting");
		if ("refused" in note) throw new Error(note.refused);
		const lines = note.text.split("\n");

		expect(lines[note.cursorLine - 1]).toBe("# Notes");
		expect(lines[note.cursorLine]).toBe("");
	});

	it("gives two meetings a minute apart two paths", () => {
		const first = unplannedNote(NOW, "Meetings", DEFAULT_TEMPLATE, layout(), "Unplanned meeting");
		const second = unplannedNote(new Date(2026, 10, 4, 14, 6, 0), "Meetings", DEFAULT_TEMPLATE, layout(), "Unplanned meeting");
		if ("refused" in first || "refused" in second) throw new Error("refused");

		expect(second.path).toBe("Meetings/2026-11-04 Unplanned meeting 1406.md");
		expect(second.path).not.toBe(first.path);
	});

	it("pads the hour and minute, so nine past eight in the morning reads 0809", () => {
		const note = unplannedNote(new Date(2026, 10, 4, 8, 9), "Meetings", DEFAULT_TEMPLATE, layout(), "Oplanerat möte");
		if ("refused" in note) throw new Error(note.refused);

		expect(note.basename).toBe("2026-11-04 Oplanerat möte 0809");
	});

	it("is refused, with the core's own sentence, when the day's log has no folder or pattern yet", () => {
		const blank = { ...defaultData().core.layout, dailyLogFolder: "", dailyLogFilename: "" };

		const note = unplannedNote(NOW, "Meetings", DEFAULT_TEMPLATE, blank, "Unplanned meeting");

		expect(note).toHaveProperty("refused");
	});
});

describe("today's log gains one link line, at the end of its notes section", () => {
	const LINK = "2026-11-04 Unplanned meeting 1405";

	it("writes it under an empty notes heading, leaving every other line as it was", () => {
		const day = "# Notes\n\n## Overdue\n\n## Calendar\n\n```schema\n| Time | Event |\n| --- | --- |\n```\n\n# Diary\n\n";

		expect(withDayLink(day, LINK, layout())).toBe(
			"# Notes\n\n[[2026-11-04 Unplanned meeting 1405]]\n\n## Overdue\n\n## Calendar\n\n```schema\n| Time | Event |\n| --- | --- |\n```\n\n# Diary\n\n",
		);
	});

	it("writes it after what the person already wrote there, with a blank line between so a list does not swallow it", () => {
		const day = "# Notes\n\n- a thought\n\n\n## Overdue\n";

		expect(withDayLink(day, LINK, layout())).toBe("# Notes\n\n- a thought\n\n[[2026-11-04 Unplanned meeting 1405]]\n\n\n## Overdue\n");
	});

	it("keeps a note with no final line break without one when the notes section runs to the end", () => {
		expect(withDayLink("# Notes\n\n- a thought", LINK, layout())).toBe("# Notes\n\n- a thought\n\n[[2026-11-04 Unplanned meeting 1405]]");
	});

	it("keeps Windows line endings on every line it writes, with a final line break", () => {
		const day = "# Notes\r\n\r\n- a thought\r\n\r\n## Overdue\r\n";

		expect(withDayLink(day, LINK, layout())).toBe(
			"# Notes\r\n\r\n- a thought\r\n\r\n[[2026-11-04 Unplanned meeting 1405]]\r\n\r\n## Overdue\r\n",
		);
	});

	it("keeps Windows line endings on every line it writes, with no final line break", () => {
		expect(withDayLink("# Notes\r\n\r\n- a thought", LINK, layout())).toBe(
			"# Notes\r\n\r\n- a thought\r\n\r\n[[2026-11-04 Unplanned meeting 1405]]",
		);
	});

	it("refuses a day whose notes heading is not there, rather than restructuring the person's day", () => {
		expect(withDayLink("## Calendar\n\n```schema\n| Time | Event |\n| --- | --- |\n```\n", LINK, layout())).toBeNull();
	});
});
