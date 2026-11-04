import { describe, expect, it } from "vitest";
import { mergeMeetings, type ExistingRow } from "../features/daysAhead/mergeMeetings";
import type { DesiredRow } from "../features/daysAhead/desiredRows";
import { isPluginsOwnCell, readRowMemory } from "../features/daysAhead/rowMemory";
import type { RowMemory, RowMemoryEntry, RowMemoryUpdate } from "../features/daysAhead/rowMemory";
import { meetingNoteBasename } from "../core/meetingName";

// Ticket #1035: a link the plugin wrote itself is the plugin's own, and is
// corrected until its row has ended, whether or not the meeting makes a note
// now. Any other link is the person's and is kept, on every run.

const DATE = "2026-10-01";
const MORNING = new Date(2026, 9, 1, 8, 0);
const EVENING = new Date(2026, 9, 1, 20, 0);
const ALL_DAY = "00:00–23:59";

/** A meeting that makes no note — no attendees — which is every case here unless said. */
function want(partial: Partial<DesiredRow>): DesiredRow {
	return {
		uid: "uid-quay",
		title: "Quay review",
		time: ALL_DAY,
		meetingCell: "Quay review",
		makesNote: false,
		startMin: 0,
		endMin: 1439,
		...partial,
	};
}

function memoryOf(entry: RowMemoryEntry, uid = "uid-quay"): RowMemory {
	return { [uid]: { [DATE]: { "0": entry } } };
}

/** What the caller stores after a successful write: each update as the entry it becomes. */
function stored(updates: readonly RowMemoryUpdate[]): RowMemory {
	const memory: Record<string, Record<string, Record<string, RowMemoryEntry>>> = {};
	for (const update of updates) {
		const entry: RowMemoryEntry = {
			time: update.time,
			event: update.meetingCell,
			title: update.title,
			...(update.wrote === undefined ? {} : { wrote: update.wrote }),
		};
		memory[update.uid] = { [DATE]: { [String(update.startMin)]: entry } };
	}
	return memory;
}

const PLACEHOLDER = `[[${meetingNoteBasename(DATE, "")}]]`;

describe("a link the plugin wrote itself, for a meeting that makes no note", () => {
	it("becomes the plain title when memory holds the placeholder link an older build wrote (box 1)", () => {
		// Memory as the current build wrote it: the cell text and the title, no provenance record.
		const existing: ExistingRow[] = [{ time: ALL_DAY, meetingCell: PLACEHOLDER }];
		const remembered = memoryOf({ time: ALL_DAY, event: PLACEHOLDER, title: "Quay review" });
		const { rows } = mergeMeetings(existing, [want({})], remembered, DATE, MORNING);
		expect(rows).toEqual([{ from: 0, time: ALL_DAY, event: "Quay review" }]);
	});

	it("becomes the plain title when memory records that the plugin wrote exactly that text", () => {
		const cell = `[[${meetingNoteBasename(DATE, "Quay review")}]]`;
		const existing: ExistingRow[] = [{ time: ALL_DAY, meetingCell: cell }];
		const remembered = memoryOf({ time: ALL_DAY, event: cell, title: "Quay review", wrote: cell });
		const { rows, remember } = mergeMeetings(existing, [want({})], remembered, DATE, MORNING);
		expect(rows).toEqual([{ from: 0, time: ALL_DAY, event: "Quay review" }]);
		// What it wrote now is what it records as its own.
		expect(remember).toEqual([
			{ uid: "uid-quay", startMin: 0, time: ALL_DAY, meetingCell: "Quay review", title: "Quay review", wrote: "Quay review" },
		]);
	});

	it("becomes the plain title for a titled link of the exact shape, location included, in an entry with no record", () => {
		const cell = `[[${meetingNoteBasename(DATE, "Quay review")}]] (Room 4)`;
		const existing: ExistingRow[] = [{ time: ALL_DAY, meetingCell: cell }];
		const remembered = memoryOf({ time: ALL_DAY, event: cell, title: "Quay review" });
		const { rows } = mergeMeetings(existing, [want({ meetingCell: "Quay review (Room 4)" })], remembered, DATE, MORNING);
		expect(rows).toEqual([{ from: 0, time: ALL_DAY, event: "Quay review (Room 4)" }]);
	});

	it("is left as written once its row has ended (box 3)", () => {
		// A meeting that ran 09:00–10:00 today, looked at in the evening.
		const morning = "09:00–10:00";
		const existing: ExistingRow[] = [{ time: morning, meetingCell: PLACEHOLDER }];
		const remembered: RowMemory = {
			"uid-quay": { [DATE]: { "540": { time: morning, event: PLACEHOLDER, title: "Quay review" } } },
		};
		const ended = want({ time: morning, startMin: 540, endMin: 600 });
		const { rows, remember } = mergeMeetings(existing, [ended], remembered, DATE, EVENING);
		expect(rows).toEqual([{ from: 0, time: morning, event: PLACEHOLDER }]);
		// An ended row stays as written, and the plugin does not claim it as its own writing.
		expect(remember[0].wrote).toBeUndefined();
	});
});

describe("a link the person made", () => {
	it("is kept on the first run and on the run after it (box 2)", () => {
		// Adopted by the title match: no memory yet, the person typed the link.
		const existing: ExistingRow[] = [{ time: ALL_DAY, meetingCell: "[[Quay review]]" }];
		const first = mergeMeetings(existing, [want({})], {}, DATE, MORNING);
		expect(first.rows).toEqual([{ from: 0, time: ALL_DAY, event: "[[Quay review]]" }]);
		// Memory now records the person's link as what the row says; it must
		// record it as kept, not as something the plugin wrote.
		expect(first.remember[0].meetingCell).toBe("[[Quay review]]");
		expect(first.remember[0].wrote).toBeNull();

		// The run after: the memory the first run left behind, the same row.
		const second = mergeMeetings(existing, [want({})], stored(first.remember), DATE, MORNING);
		expect(second.rows).toEqual([{ from: 0, time: ALL_DAY, event: "[[Quay review]]" }]);
		expect(second.remember[0].wrote).toBeNull();
	});

	it("is kept when the plugin wrote plain text and the person has since made it a link (the edited row)", () => {
		// The decision for exactly that cell: memory says the plugin wrote the
		// plain title; the row now reads a link, which is not that text.
		const entry: RowMemoryEntry = { time: ALL_DAY, event: "Quay review", title: "Quay review", wrote: "Quay review" };
		expect(isPluginsOwnCell("[[Quay review]]", DATE, [entry])).toBe(false);
		expect(isPluginsOwnCell("Quay review", DATE, [entry])).toBe(true);
	});

	it("is kept when it only looks like the plugin's link: a different date in front, or a different title", () => {
		const entry: RowMemoryEntry = { time: ALL_DAY, event: "[[2026-09-30 Quay review]]", title: "Quay review" };
		expect(isPluginsOwnCell("[[2026-09-30 Quay review]]", DATE, [entry])).toBe(false);
		const other: RowMemoryEntry = { time: ALL_DAY, event: "[[2026-10-01 Harbour talk]]", title: "Quay review" };
		expect(isPluginsOwnCell("[[2026-10-01 Harbour talk]]", DATE, [other])).toBe(false);
	});

	it("is kept when the record says the plugin wrote something else than the cell", () => {
		const entry: RowMemoryEntry = { time: ALL_DAY, event: "[[Quay review]]", title: "Quay review", wrote: "Quay review" };
		expect(isPluginsOwnCell("[[Quay review]]", DATE, [entry])).toBe(false);
	});

	// A link the person made in exactly the shape the plugin writes — what an
	// older build's entry is judged by — is still the person's once a run has
	// kept it: the kept run must leave a record that says so, or the next run
	// takes the entry for an older build's and replaces the link (review of
	// #1035, 2026-10-02).
	const ownShaped = `[[${meetingNoteBasename(DATE, "Quay review")}]]`;

	it("is kept on two runs when the plugin wrote plain text and the person made it a link in the plugin's own shape", () => {
		const existing: ExistingRow[] = [{ time: ALL_DAY, meetingCell: ownShaped }];
		const remembered = memoryOf({ time: ALL_DAY, event: "Quay review", title: "Quay review", wrote: "Quay review" });
		const first = mergeMeetings(existing, [want({})], remembered, DATE, MORNING);
		expect(first.rows).toEqual([{ from: 0, time: ALL_DAY, event: ownShaped }]);

		const second = mergeMeetings(existing, [want({})], stored(first.remember), DATE, MORNING);
		expect(second.rows).toEqual([{ from: 0, time: ALL_DAY, event: ownShaped }]);
	});

	it("is kept on two runs when the person typed a link in the plugin's own shape before any run", () => {
		const existing: ExistingRow[] = [{ time: ALL_DAY, meetingCell: ownShaped }];
		const first = mergeMeetings(existing, [want({})], {}, DATE, MORNING);
		expect(first.rows).toEqual([{ from: 0, time: ALL_DAY, event: ownShaped }]);

		const second = mergeMeetings(existing, [want({})], stored(first.remember), DATE, MORNING);
		expect(second.rows).toEqual([{ from: 0, time: ALL_DAY, event: ownShaped }]);
	});
});

describe("the provenance record is read like every other stored field", () => {
	it("keeps a text or null record and skips an entry whose record is neither", () => {
		const base = { time: ALL_DAY, event: "Quay review", title: "Quay review" };
		const memory = readRowMemory({
			good: { [DATE]: { "0": { ...base, wrote: "Quay review" } } },
			kept: { [DATE]: { "0": { ...base, wrote: null } } },
			bad: { [DATE]: { "0": { ...base, wrote: 7 } } },
			old: { [DATE]: { "0": base } },
		});
		expect(memory.good?.[DATE]["0"].wrote).toBe("Quay review");
		expect(memory.kept?.[DATE]["0"].wrote).toBeNull();
		expect(memory.bad).toBeUndefined();
		expect(memory.old?.[DATE]["0"]).toEqual(base);
	});
});

describe("a row the plugin wrote and the person then made a link, found again by #1037's title match", () => {
	// The composition: `findRow`'s own key holds the plugin's plain text, which
	// no row says any more, so the row is found by title — and
	// the keep decision must then see the link as the person's, not the
	// plugin's. Once with the provenance record, once as an older
	// build left memory, without it.
	const edsbro = (partial: Partial<DesiredRow> = {}) =>
		want({ uid: "uid-edsbro", title: "Edsbro", meetingCell: "Edsbro", ...partial });

	for (const [label, entry] of [
		["with the record", { time: ALL_DAY, event: "Edsbro", title: "Edsbro", wrote: "Edsbro" }],
		["without it", { time: ALL_DAY, event: "Edsbro", title: "Edsbro" }],
	] as const) {
		it(`keeps the link as the person's on two runs, in one row, ${label}`, () => {
			const existing: ExistingRow[] = [{ time: ALL_DAY, meetingCell: "[[Edsbro]]" }];

			const first = mergeMeetings(existing, [edsbro()], memoryOf(entry, "uid-edsbro"), DATE, MORNING);
			expect(first.rows).toEqual([{ from: 0, time: ALL_DAY, event: "[[Edsbro]]" }]);
			expect(first.remember).toEqual([
				{ uid: "uid-edsbro", startMin: 0, time: ALL_DAY, meetingCell: "[[Edsbro]]", title: "Edsbro", wrote: null },
			]);

			const second = mergeMeetings(existing, [edsbro()], stored(first.remember), DATE, MORNING);
			expect(second.rows).toEqual([{ from: 0, time: ALL_DAY, event: "[[Edsbro]]" }]);
			expect(second.remember[0].wrote).toBeNull();
		});
	}
});
