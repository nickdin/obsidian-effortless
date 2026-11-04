import { describe, expect, it } from "vitest";
import { type DropReason, NAMED_DIFFERENCE_ROWS, taskConsistencyParity } from "./taskConsistencyParityFixture";

/**
 * Holds the parity fixture to its own header. The fixture is
 * data recorded once from the old plugin, so the risk is a hand edit later
 * that leaves the header's counts saying something the scenarios no longer
 * do. Running the scenarios through this feature is the replay's job, not this file's.
 */

const data = taskConsistencyParity();
const allAssertions = data.scenarios.flatMap((s) => s.assertions);

describe("the task consistency parity fixture", () => {
	it("holds all 53 of the old suite's named scenarios, each once, in the old file's order", () => {
		expect(data.scenarios).toHaveLength(53);
		expect(new Set(data.scenarios.map((s) => s.name)).size).toBe(53);
		const lines = data.scenarios.map((s) => s.oldLine);
		expect(lines).toEqual([...lines].sort((a, b) => a - b));
	});

	it("counts the same assertions in its header as in its scenarios", () => {
		expect(allAssertions).toHaveLength(data.assertions.total);
		expect(allAssertions.filter((a) => a.dropped === null)).toHaveLength(data.assertions.kept);
		for (const reason of Object.keys(data.assertions.dropped) as DropReason[]) {
			expect(allAssertions.filter((a) => a.dropped === reason), reason).toHaveLength(data.assertions.dropped[reason]);
		}
	});

	it("gives every dropped assertion a reason the header explains", () => {
		for (const a of allAssertions) {
			if (a.dropped !== null) expect(data.assertions.reasons[a.dropped], `${a.oldLine}`).toBeTruthy();
		}
	});

	it("names only rows that #709 § Named differences has", () => {
		for (const s of data.scenarios) {
			for (const row of s.namedDifferences) expect(NAMED_DIFFERENCE_ROWS, s.name).toContain(row);
		}
	});

	it("carries rows 4 and 5 on one scenario each and rows 1, 3, 6, 7 and 8 on none, as its header says", () => {
		const carrying = (row: number) => data.scenarios.filter((s) => (s.namedDifferences as readonly number[]).includes(row));
		expect(carrying(4)).toHaveLength(1);
		expect(carrying(5)).toHaveLength(1);
		for (const row of [1, 3, 6, 7, 8]) expect(carrying(row), `row ${row}`).toHaveLength(0);
	});

	it("gives every scenario both notes before, and each note after as lines or unchanged", () => {
		for (const s of data.scenarios) {
			expect(s.before.collection.length, s.name).toBeGreaterThan(0);
			expect(s.before.log.length, s.name).toBeGreaterThan(0);
			for (const after of [s.after.collection, s.after.log]) {
				if (after !== null) expect(after.every((line) => typeof line === "string"), s.name).toBe(true);
			}
		}
	});

	it("writes every id the old plugin generated as NEW-1, NEW-2, ... in order of first appearance, collection first", () => {
		const ids = (lines: readonly string[] | null) =>
			[...(lines ?? []).join("\n").matchAll(/%% eid:([a-zA-Z0-9_-]+) %%/g)].map((m) => m[1]);
		for (const s of data.scenarios) {
			const before = new Set([...ids(s.before.collection), ...ids(s.before.log)]);
			expect([...before].some((id) => id.startsWith("NEW-")), s.name).toBe(false);
			const fresh = [...new Set([...ids(s.after.collection), ...ids(s.after.log)].filter((id) => !before.has(id)))];
			expect(fresh, s.name).toEqual(fresh.map((_, i) => `NEW-${i + 1}`));
		}
	});
});
