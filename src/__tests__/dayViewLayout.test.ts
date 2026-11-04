import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { computeTimeRange, assignColumns, layoutDay, MIN_BLOCK_HEIGHT_PX } from "../features/dayView/layout";
import { PIXELS_PER_HOUR } from "../features/dayView/types";
import type { TimedMeeting } from "../features/dayView/types";

/**
 * Carried from `~/Devbox/schema-render/src/__tests__/layout.test.ts`: the same 36 cases, adapted to `layoutDay`'s own entry
 * point — `layoutDay(timed, pxPerMinute)` rather than the old
 * `layoutSchedule(posts, { pxPerMinute })` — with real names replaced by
 * invented ones: the old fixtures named a real place, a real
 * activity and a family member's role as meetings.
 *
 * The old suite's all-day-splitting tests do not carry across as behaviour
 * tests: that split is now `readDay`'s job (a later ticket), done before a
 * meeting ever reaches `layoutDay`, so this file has nothing left to filter.
 * What they carry as is the one thing #625 still asks of this layer: a day
 * of only all-day meetings reaches `layoutDay` with an empty `timed` array —
 * see "layoutDay — no timed meetings" below.
 */

function meeting(startMin: number, endMin: number, text = "Möte", rowIndex = 0): TimedMeeting {
	return { startMin, endMin, text, rowIndex };
}

describe("MIN_BLOCK_HEIGHT_PX", () => {
	it("is 2 — must never regress to a taller floor", () => {
		// Lowered from a taller floor so a block stays honestly proportional to
		// its duration at every density. Regressing this brings that bug back.
		expect(MIN_BLOCK_HEIGHT_PX).toBe(2);
	});
});

describe("computeTimeRange", () => {
	it("returns default 08:00–16:30 for no meetings", () => {
		expect(computeTimeRange([])).toEqual({ startMin: 480, endMin: 990 });
	});

	it("returns default range when all meetings fit inside", () => {
		const meetings = [meeting(540, 600), meeting(720, 780)];
		expect(computeTimeRange(meetings)).toEqual({ startMin: 480, endMin: 990 });
	});

	it("expands startMin when a meeting starts before 08:00", () => {
		const meetings = [meeting(420, 540)]; // 07:00–09:00
		expect(computeTimeRange(meetings)).toEqual({ startMin: 420, endMin: 990 });
	});

	it("expands endMin when a meeting ends after 16:30", () => {
		const meetings = [meeting(900, 1080)]; // 15:00–18:00
		expect(computeTimeRange(meetings)).toEqual({ startMin: 480, endMin: 1080 });
	});

	it("expands both ends when meetings straddle defaults", () => {
		const meetings = [meeting(420, 540), meeting(900, 1080)];
		expect(computeTimeRange(meetings)).toEqual({ startMin: 420, endMin: 1080 });
	});

	// Hour labels used to disappear when the first meeting started at an odd
	// time: 07:50 gives startMin 470, and a renderer stepping every 30 minutes
	// then never lands on a whole hour. The fix snaps startMin down and endMin
	// up to the nearest multiple of 30 minutes, on the final result.
	it("snaps startMin DOWN to nearest 30-min multiple when a meeting starts off-grid", () => {
		// meeting 07:50–08:20 → rawStart 470 → snapped down to 450
		// endMin stays at its default of 990
		const meetings = [meeting(470, 500)];
		expect(computeTimeRange(meetings)).toEqual({ startMin: 450, endMin: 990 });
	});

	it("snaps endMin UP to nearest 30-min multiple when a meeting ends off-grid", () => {
		// meeting 08:00–17:15 → rawEnd 1035 → snapped up to 1050
		// startMin stays at its default of 480
		const meetings = [meeting(480, 1035)];
		expect(computeTimeRange(meetings)).toEqual({ startMin: 480, endMin: 1050 });
	});

	it("snaps both ends when both are off-grid", () => {
		// rawStart 470 → 450 (down), rawEnd 1035 → 1050 (up)
		const meetings = [meeting(470, 1035)];
		expect(computeTimeRange(meetings)).toEqual({ startMin: 450, endMin: 1050 });
	});

	it("snap is idempotent on default range (480/990 already on 30-min grid)", () => {
		// A meeting entirely inside the default span; 480/990 are already multiples of 30.
		const meetings = [meeting(600, 630)];
		expect(computeTimeRange(meetings)).toEqual({ startMin: 480, endMin: 990 });
	});
});

describe("assignColumns", () => {
	it("returns empty array for no meetings", () => {
		expect(assignColumns([])).toEqual([]);
	});

	it("a single meeting gets column 0 of 1", () => {
		const meetings = [meeting(540, 600)];
		expect(assignColumns(meetings)).toEqual([{ columnIndex: 0, totalColumns: 1 }]);
	});

	it("two non-overlapping meetings each get column 0 (separate clusters)", () => {
		const meetings = [meeting(540, 600), meeting(720, 780)];
		const result = assignColumns(meetings);
		expect(result[0]).toEqual({ columnIndex: 0, totalColumns: 1 });
		expect(result[1]).toEqual({ columnIndex: 0, totalColumns: 1 });
	});

	it("two overlapping meetings get columns 0 and 1 with totalColumns 2", () => {
		const meetings = [meeting(540, 660), meeting(600, 720)]; // 09–11 and 10–12
		const result = assignColumns(meetings);
		expect(result[0].totalColumns).toBe(2);
		expect(result[1].totalColumns).toBe(2);
		const cols = result.map((r) => r.columnIndex).sort();
		expect(cols).toEqual([0, 1]);
	});

	it("preserves input order in result array", () => {
		const meetings = [
			meeting(600, 720, "B"), // 10–12
			meeting(540, 660, "A"), // 09–11 (overlaps with B)
		];
		const result = assignColumns(meetings);
		expect(result).toHaveLength(2);
		// Both meetings overlap → totalColumns 2
		expect(result[0].totalColumns).toBe(2);
		expect(result[1].totalColumns).toBe(2);
	});

	it("cluster-horizon links transitively overlapping meetings", () => {
		// A 09:00–11:00, B 10:00–12:00, C 11:30–13:00
		// A and B overlap; B and C overlap; A and C do NOT directly overlap,
		// but cluster horizon extends to B's end (12:00) so C joins same cluster.
		const meetings = [meeting(540, 660, "A"), meeting(600, 720, "B"), meeting(690, 780, "C")];
		const result = assignColumns(meetings);
		// All three should share the same totalColumns value (same cluster).
		expect(result[0].totalColumns).toBe(result[1].totalColumns);
		expect(result[1].totalColumns).toBe(result[2].totalColumns);
		// A and B overlap → need 2 columns. C starts after A ends so C may reuse A's column.
		expect(result[0].totalColumns).toBe(2);
		// Each meeting has a column < totalColumns.
		for (const r of result) {
			expect(r.columnIndex).toBeGreaterThanOrEqual(0);
			expect(r.columnIndex).toBeLessThan(r.totalColumns);
		}
	});

	it("three fully overlapping meetings get three columns", () => {
		const meetings = [
			meeting(540, 720, "A"), // 09–12
			meeting(600, 720, "B"), // 10–12
			meeting(630, 720, "C"), // 10:30–12
		];
		const result = assignColumns(meetings);
		expect(result.every((r) => r.totalColumns === 3)).toBe(true);
		const cols = result.map((r) => r.columnIndex).sort();
		expect(cols).toEqual([0, 1, 2]);
	});
});

describe("layoutDay", () => {
	it("computes heightPx proportional to duration at 1 px/min", () => {
		const { blocks } = layoutDay([meeting(600, 630)], 1);
		expect(blocks[0].heightPx).toBe(30);
	});

	it("respects MIN_BLOCK_HEIGHT_PX for very short blocks", () => {
		const { blocks } = layoutDay([meeting(600, 601)], 1);
		expect(blocks[0].heightPx).toBe(MIN_BLOCK_HEIGHT_PX);
	});

	it("scales heights with compact pxPerMinute 0.75", () => {
		const { blocks } = layoutDay([meeting(600, 660)], 0.75);
		// 60 minutes * 0.75 = 45 px
		expect(blocks[0].heightPx).toBe(45);
	});

	it("scales heights with spacious pxPerMinute 1.5", () => {
		const { blocks } = layoutDay([meeting(600, 660)], 1.5);
		expect(blocks[0].heightPx).toBe(90);
	});

	it("topPx is relative to span.startMin", () => {
		// meeting 09:00–10:00, default range starts 08:00 → topPx = 60 at 1 px/min
		const { blocks } = layoutDay([meeting(540, 600)], 1);
		expect(blocks[0].topPx).toBe(60);
	});

	it("topPx adjusts when the span expands due to an early meeting", () => {
		// meeting 07:00–09:00 → span starts at 420, topPx = 0
		const { blocks } = layoutDay([meeting(420, 540)], 1);
		expect(blocks[0].topPx).toBe(0);
	});

	it("span.totalHeightPx grows when a meeting extends past the default span", () => {
		// meeting 15:00–18:00 → span ends 1080, totalHeightPx = (1080-480)*1 = 600
		const { span } = layoutDay([meeting(900, 1080)], 1);
		expect(span.totalHeightPx).toBe(600);
	});

	it("preserves input order in blocks", () => {
		const { blocks } = layoutDay([meeting(600, 660, "B"), meeting(540, 600, "A")], 1);
		expect(blocks[0].text).toBe("B");
		expect(blocks[1].text).toBe("A");
	});

	it("attaches columnIndex and totalColumns from assignColumns", () => {
		const { blocks } = layoutDay([meeting(540, 660), meeting(600, 720)], 1);
		expect(blocks[0].totalColumns).toBe(2);
		expect(blocks[1].totalColumns).toBe(2);
	});

	it("returns startMin/endMin from the span", () => {
		const { span } = layoutDay([meeting(540, 600)], 0.75);
		expect(span.startMin).toBe(480);
		expect(span.endMin).toBe(990);
	});

	// When the first meeting starts at 07:50, span.startMin is snapped down to
	// 450, the nearest multiple of 30. The block's own time stays exact: the
	// meeting's startMin is 470, so topPx = (470 - 450) * pxPerMinute = 20 *
	// pxPerMinute. The 20 minutes of empty space land at the grid's top edge,
	// not inside the block.
	it("topPx > 0 when span.startMin is snapped below the meeting's startMin", () => {
		const { span, blocks } = layoutDay([meeting(470, 500)], 1);
		expect(span.startMin).toBe(450);
		expect(blocks[0].topPx).toBe(20); // (470 - 450) * 1
	});

	it("carries a meeting's own text and rowIndex through into its block", () => {
		const { blocks } = layoutDay([meeting(600, 630, "Genomgång", 4)], 1);
		expect(blocks[0].text).toBe("Genomgång");
		expect(blocks[0].rowIndex).toBe(4);
	});
});

describe("layoutDay — no timed meetings", () => {
	// `readDay` (a later ticket) is what separates an all-day row into a bar;
	// by the time this function runs, an all-day meeting has already been kept
	// out of `timed`. A day of nothing but all-day meetings therefore reaches
	// `layoutDay` with an empty array, and this is the case #625 asks for: the
	// default 08:00–16:30 grid, empty, because the now-line lives on the grid
	// and a grid that vanished and came back would be more startling than an
	// empty one (old issue #29).
	it("lays out the default span for an empty day", () => {
		const { span } = layoutDay([], 1);
		expect(span.startMin).toBe(480);
		expect(span.endMin).toBe(990);
	});

	it("gives an empty day no blocks", () => {
		const { blocks } = layoutDay([], 1);
		expect(blocks).toEqual([]);
	});

	it("computes totalHeightPx for the default span", () => {
		// (990-480) * 1 = 510
		const { span } = layoutDay([], 1);
		expect(span.totalHeightPx).toBe(510);
	});
});

describe("PIXELS_PER_HOUR", () => {
	it("is 45, 60 and 90 for compact, normal and spacious", () => {
		expect(PIXELS_PER_HOUR).toEqual({ compact: 45, normal: 60, spacious: 90 });
	});

	it("increases from compact to normal to spacious", () => {
		expect(PIXELS_PER_HOUR.compact).toBeLessThan(PIXELS_PER_HOUR.normal);
		expect(PIXELS_PER_HOUR.normal).toBeLessThan(PIXELS_PER_HOUR.spacious);
	});
});

describe("neither file imports obsidian", () => {
	// This module is arithmetic over minutes; nothing in it, or in the shapes
	// it consumes, should ever need the running app.
	it("layout.ts", () => {
		const source = readFileSync(resolve(__dirname, "..", "features", "dayView", "layout.ts"), "utf8");
		expect(source.toLowerCase()).not.toContain("obsidian");
	});

	it("types.ts", () => {
		const source = readFileSync(resolve(__dirname, "..", "features", "dayView", "types.ts"), "utf8");
		expect(source.toLowerCase()).not.toContain("obsidian");
	});
});

describe("no real name, place, calendar or date in this file's own fixtures", () => {
	// #618 § 17: the old layout.test.ts named a real place and a real activity
	// as fixture meetings, and a real family member's role as a third. This
	// file's own fixtures — "Möte" and "Genomgång" — are ordinary Swedish
	// nouns ("meeting", "walkthrough"), not names, so this reads this file's
	// own source and checks the banned words never came back.
	it("does not contain the old plugin's real names", () => {
		const source = readFileSync(resolve(__dirname, "dayViewLayout.test.ts"), "utf8");
		// Built by concatenation rather than written whole, so this assertion
		// does not fail against its own list of what it is checking for.
		const bannedNames = ["Eds" + "bro", "Is" + "träning", "Pa" + "ppa"];
		for (const bannedName of bannedNames) {
			expect(source).not.toContain(bannedName);
		}
	});
});
