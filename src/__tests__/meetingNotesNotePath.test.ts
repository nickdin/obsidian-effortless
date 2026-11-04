/**
 * A meeting note's vault path, and reading one back — ticket
 * #761, carried from
 * `~/Devbox/calendar-scaffold/src/note-name.ts`'s `meetingNotePath` and
 * `readMeetingNotePath`. No real name, address, path or calendar is in this
 * file.
 */

import { describe, expect, it } from "vitest";
import { meetingNotePath, readMeetingNotePath } from "../features/meetingNotes/notePath";

describe("meetingNotePath", () => {
	it("is the folder, the date, a space, and the title, with .md on the end", () => {
		expect(meetingNotePath("Meetings", "2026-09-18", "Weekly sync")).toBe(
			"Meetings/2026-09-18 Weekly sync.md",
		);
	});

	it("sanitises a title that cannot be a filename", () => {
		expect(meetingNotePath("Meetings", "2026-09-18", "Status: part 1/2")).toBe(
			"Meetings/2026-09-18 Status part 1 2.md",
		);
	});
});

describe("readMeetingNotePath", () => {
	it("is the inverse of meetingNotePath: reads the date and title back out", () => {
		const path = meetingNotePath("Meetings", "2026-09-18", "Weekly sync");
		expect(readMeetingNotePath(path)).toEqual({ date: "2026-09-18", title: "Weekly sync" });
	});

	it("ignores the folder — only the filename decides the shape", () => {
		expect(readMeetingNotePath("Deep/Nested/Folder/2026-09-18 Weekly sync.md")).toEqual({
			date: "2026-09-18",
			title: "Weekly sync",
		});
	});

	it("returns null for a name this feature did not build", () => {
		expect(readMeetingNotePath("Meetings/Notes about the offsite.md")).toBeNull();
	});

	it("returns null for a name missing the space between date and title", () => {
		expect(readMeetingNotePath("Meetings/2026-09-18.md")).toBeNull();
	});
});
