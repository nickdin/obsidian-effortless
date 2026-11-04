/**
 * `meetingIdentity` — the memory key `readNotesMemory` already accepted any
 * non-blank string for
 * and this ticket
 * builds now that the occurrence key exists on `Meeting` — and
 * `readNotesMemory`'s own validation of `accounted`, the field a send-back
 * against this ticket added so a name the person removes by hand is never
 * offered again (`ensureNote.ts`'s own module comment). No real name,
 * address, path or calendar is in this file.
 */

import { describe, expect, it } from "vitest";
import { meetingIdentity, readNotesMemory } from "../features/meetingNotes/notesMemory";

describe("meetingIdentity", () => {
	it("is the uid alone for a meeting that does not repeat", () => {
		expect(meetingIdentity("series-a", null)).toBe("series-a");
	});

	it("joins the uid and the occurrence key for one occurrence of a repeat", () => {
		expect(meetingIdentity("series-b", "2026-09-14T09:00:00.000Z")).toBe(
			"series-b::2026-09-14T09:00:00.000Z",
		);
	});

	it("gives two occurrences of one series two different identities", () => {
		const first = meetingIdentity("series-c", "2026-09-07T09:00:00.000Z");
		const second = meetingIdentity("series-c", "2026-09-14T09:00:00.000Z");
		expect(first).not.toBe(second);
	});

	it("tells a repeating meeting's occurrence apart from a non-repeating meeting sharing its uid", () => {
		// Not a real collision the calendar could produce — the point is only
		// that the two forms never accidentally collide with each other.
		expect(meetingIdentity("series-d", null)).not.toBe(meetingIdentity("series-d", "series-d"));
	});
});

describe("readNotesMemory — reading accounted", () => {
	it("drops the old bare-path shape and names it — a missing accounted is refused like any other unusable value", () => {
		// Previously read back silently as a path with nobody accounted for.
		// `CLAUDE.md`'s validate-on-read rule: a stored value this code cannot
		// use is refused and named, never silently replaced — the same rule
		// `daysAhead/rowMemory.ts` already applies to a missing field. A
		// hand-edited entry that lost `accounted` this way lost its own
		// guarantee too: the note's participants would be re-offered on the
		// next run, and the run's notice never said why.
		const result = readNotesMemory({ "series-a": { "2026-09-11": "Meetings/Invented A.md" } });
		expect(result).toEqual({ notes: {}, dropped: ["series-a / 2026-09-11"] });
	});

	it("reads the current path-and-accounted shape whole", () => {
		const result = readNotesMemory({
			"series-a": { "2026-09-11": { path: "Meetings/Invented A.md", accounted: ["Ada Almgren"] } },
		});
		expect(result.notes).toEqual({
			"series-a": { "2026-09-11": { path: "Meetings/Invented A.md", accounted: ["Ada Almgren"] } },
		});
		expect(result.dropped).toEqual([]);
	});

	it("drops an object missing accounted and names it, the same as the bare-path shape", () => {
		// Previously filled in as accounted: [] — silently, with nothing in
		// dropped. Same failure as the bare-path case above.
		const result = readNotesMemory({ "series-a": { "2026-09-11": { path: "Meetings/Invented A.md" } } });
		expect(result).toEqual({ notes: {}, dropped: ["series-a / 2026-09-11"] });
	});

	it("drops the whole day's entry when accounted is not an array of strings", () => {
		const result = readNotesMemory({
			"series-a": {
				"2026-09-11": { path: "Meetings/Invented A.md", accounted: "Ada Almgren" },
				"2026-09-12": { path: "Meetings/Invented B.md", accounted: [7] },
			},
		});
		expect(result.notes).toEqual({});
		expect(result.dropped).toEqual(["series-a / 2026-09-11", "series-a / 2026-09-12"]);
	});
});

describe("readNotesMemory — reading a correction still owed", () => {
	it("reads an entry's pendingCorrection whole", () => {
		const stored = {
			"series-a": {
				"2026-09-11": {
					path: "Meetings/Invented A.md",
					accounted: [],
					pendingCorrection: { heading: "Invented B", dayLink: "2026-09-04" },
				},
			},
		};
		expect(readNotesMemory(stored)).toEqual({ notes: stored, dropped: [] });
	});

	it.each([
		["not an object", "Invented B"],
		["an array", ["Invented B", "2026-09-04"]],
		["missing its heading", { dayLink: "2026-09-04" }],
		["missing its day link", { heading: "Invented B" }],
		["with a blank heading", { heading: " ", dayLink: "2026-09-04" }],
		["with a day link that is not text", { heading: "Invented B", dayLink: 20260904 }],
		["null", null],
	])("drops the whole entry and names it when pendingCorrection is %s", (_shape, pendingCorrection) => {
		const result = readNotesMemory({
			"series-a": {
				"2026-09-11": { path: "Meetings/Invented A.md", accounted: [], pendingCorrection },
				"2026-09-12": { path: "Meetings/Invented C.md", accounted: [] },
			},
		});
		expect(result.notes).toEqual({ "series-a": { "2026-09-12": { path: "Meetings/Invented C.md", accounted: [] } } });
		expect(result.dropped).toEqual(["series-a / 2026-09-11"]);
	});
});

describe("readNotesMemory — reading what meeting notes last wrote", () => {
	it("reads an entry's written record whole, beside a correction still owed", () => {
		const stored = {
			"series-a": {
				"2026-10-02": {
					path: "Meetings/Invented A.md",
					accounted: ["Alva Almgren"],
					pendingCorrection: { heading: "Invented B", dayLink: "2026-10-02" },
					written: { fingerprint: "155:675e3ff255ecb", endsAt: 1790000000000 },
				},
			},
		};
		expect(readNotesMemory(stored)).toEqual({ notes: stored, dropped: [] });
	});

	it.each([
		["not an object", "155:675e3ff255ecb"],
		["missing its fingerprint", { endsAt: 1790000000000 }],
		["with a blank fingerprint", { fingerprint: " ", endsAt: 1790000000000 }],
		["missing its end", { fingerprint: "155:675e3ff255ecb" }],
		["with an end that is text", { fingerprint: "155:675e3ff255ecb", endsAt: "1790000000000" }],
		["with an end that is not finite", { fingerprint: "155:675e3ff255ecb", endsAt: Number.POSITIVE_INFINITY }],
		["null", null],
	])("drops the whole entry and names it when written is %s", (_shape, written) => {
		const result = readNotesMemory({
			"series-a": {
				"2026-10-02": { path: "Meetings/Invented A.md", accounted: [], written },
				"2026-10-03": { path: "Meetings/Invented C.md", accounted: [] },
			},
		});
		expect(result.notes).toEqual({ "series-a": { "2026-10-03": { path: "Meetings/Invented C.md", accounted: [] } } });
		expect(result.dropped).toEqual(["series-a / 2026-10-02"]);
	});
});
