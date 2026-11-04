/**
 * Meeting notes' memory of the logbook lines it wrote: read from a
 * hand-editable `data.json` and never trusted as stored, and moved along when
 * this device sees a collection or a meeting note renamed.
 *
 * Every path here is invented.
 */

import { describe, expect, it } from "vitest";
import { readLogbookMemory, renamedInLogbook } from "../features/meetingNotes/logbookMemory";

describe("readLogbookMemory", () => {
	it("keeps entries of the right shape exactly as stored", () => {
		const stored = {
			"Areas/Garden.md": [
				{ note: "Meetings/2026-10-01 Shed.md", line: "- [[2026-10-01 Shed]]" },
				{ note: "Meetings/2026-09-01 Fence.md", line: "- [[2026-09-01 Fence]]", was: "- [[Fence]]" },
			],
		};
		expect(readLogbookMemory(stored)).toEqual({ memory: stored, dropped: [] });
	});

	it("reads nothing stored as an empty memory, without a word", () => {
		expect(readLogbookMemory(undefined)).toEqual({ memory: {}, dropped: [] });
	});

	it("drops each entry of the wrong shape and names its collection once, keeping the rest", () => {
		const read = readLogbookMemory({
			"Areas/Garden.md": [
				{ note: "Meetings/2026-10-01 Shed.md", line: "- [[2026-10-01 Shed]]" },
				{ note: "", line: "- [[x]]" },
				{ note: "Meetings/a.md" },
				"Meetings/b.md",
				{ note: "Meetings/c.md", line: "- [[c]]", was: 4 },
			],
			"Areas/Kitchen.md": "not a list",
		});
		expect(read.memory).toEqual({
			"Areas/Garden.md": [{ note: "Meetings/2026-10-01 Shed.md", line: "- [[2026-10-01 Shed]]" }],
		});
		expect(read.dropped).toEqual(["Areas/Garden.md", "Areas/Kitchen.md"]);
	});

	it("refuses a memory that is not an object at all, under its own name", () => {
		expect(readLogbookMemory(["Areas/Garden.md"])).toEqual({ memory: {}, dropped: ["logbook"] });
	});
});

describe("renamedInLogbook", () => {
	const memory = {
		"Areas/Garden.md": [{ note: "Meetings/2026-10-01 Shed.md", line: "- [[2026-10-01 Shed]]" }],
		"Areas/Kitchen.md": [{ note: "Meetings/2026-10-01 Shed.md", line: "- [[2026-10-01 Shed]]" }],
	};
	const lineFor = (note: string) => `- [[${note.replace(/^.*\//, "").replace(/\.md$/, "")}]]`;

	it("moves a renamed collection's lines to its new path, untouched", () => {
		expect(renamedInLogbook(memory, "Areas/Garden.md", "Areas/Yard.md", lineFor)).toEqual({
			"Areas/Yard.md": memory["Areas/Garden.md"],
			"Areas/Kitchen.md": memory["Areas/Kitchen.md"],
		});
	});

	it("follows a renamed meeting note in every collection, recording the line written and the line the link updater makes of it", () => {
		expect(renamedInLogbook(memory, "Meetings/2026-10-01 Shed.md", "Meetings/2026-10-02 Shed.md", lineFor)).toEqual({
			"Areas/Garden.md": [
				{ note: "Meetings/2026-10-02 Shed.md", line: "- [[2026-10-02 Shed]]", was: "- [[2026-10-01 Shed]]" },
			],
			"Areas/Kitchen.md": [
				{ note: "Meetings/2026-10-02 Shed.md", line: "- [[2026-10-02 Shed]]", was: "- [[2026-10-01 Shed]]" },
			],
		});
	});

	it("keeps the line first written across two renames, since that is what an unchanged note still holds", () => {
		const once = renamedInLogbook(memory, "Meetings/2026-10-01 Shed.md", "Meetings/2026-10-02 Shed.md", lineFor);
		const twice = renamedInLogbook(once, "Meetings/2026-10-02 Shed.md", "Meetings/2026-10-03 Shed.md", lineFor);
		expect(twice["Areas/Garden.md"]).toEqual([
			{ note: "Meetings/2026-10-03 Shed.md", line: "- [[2026-10-03 Shed]]", was: "- [[2026-10-01 Shed]]" },
		]);
	});

	it("hands the same memory back when the rename touches nothing it holds", () => {
		expect(renamedInLogbook(memory, "Elsewhere/a.md", "Elsewhere/b.md", lineFor)).toBe(memory);
	});
});
