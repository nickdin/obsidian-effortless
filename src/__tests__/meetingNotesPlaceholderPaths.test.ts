/**
 * Ticket #1019, against
 * #1011: the folder
 * listing that finds placeholder notes is built from the core's own note path,
 * not a hand-made copy of it. Drives the function the real adapter in
 * `meetingNotes.ts` calls, not a fake standing in for it. Every path is
 * invented.
 */

import { describe, expect, it } from "vitest";
import { placeholderNotePaths } from "../features/meetingNotes/placeholderNotes";
import { meetingNotePath } from "../features/meetingNotes/notePath";

const DATE = "2026-09-30";
const FOLDER = "Meetings";
/** The path the core builds for a meeting with no title. */
const PLACEHOLDER = meetingNotePath(FOLDER, DATE, "");

describe("placeholderNotePaths", () => {
	it("finds the note at the path the core builds for an untitled meeting, and Obsidian's copy-suffixed twin", () => {
		const twin = PLACEHOLDER.replace(/\.md$/, " 1.md");
		const paths = [PLACEHOLDER, twin, meetingNotePath(FOLDER, DATE, "Budget"), `${FOLDER}/2026-10-01 Untitled meeting.md`];
		expect(placeholderNotePaths(paths, FOLDER, DATE)).toEqual([PLACEHOLDER, twin]);
	});

	it("finds nothing when the folder holds only titled notes", () => {
		expect(placeholderNotePaths([meetingNotePath(FOLDER, DATE, "Budget")], FOLDER, DATE)).toEqual([]);
	});
});
