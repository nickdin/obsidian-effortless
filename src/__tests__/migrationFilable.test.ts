/**
 * What Migration may file: `checkFilable` and the `sectionOfLine` that finds
 * where a line sits.
 *
 * Pure functions over a line, a note's text and the shipped layout. Every line
 * here is invented.
 */

import { describe, expect, it } from "vitest";
import { defaultData } from "../core/settings";
import { checkFilable, sectionOfLine } from "../features/migration/filable";

const layout = defaultData().core.layout;

/** A day's log in the shipped layout: notes at level 1, the day's task sections at level 2 inside it. */
const LOG = [
	"# Notes", // 0
	"", // 1
	"- [ ] Order more tea", // 2
	"- Just a thought", // 3
	"", // 4
	"## Overdue", // 5
	"", // 6
	"- [ ] Return the ladder", // 7
	"", // 8
	"## Today", // 9
	"", // 10
	"- [ ] Water the plants", // 11
	"", // 12
	"## Calendar", // 13
].join("\n");

describe("checkFilable", () => {
	it.each([
		[" ", "open"],
		["/", "copied"],
		["x", "done"],
		["-", "cancelled"],
		[">", "forwarded"],
	])("accepts the %j checkbox (%s) under the notes heading", (symbol) => {
		expect(checkFilable(`- [${symbol}] Order more tea`, "notesHeading", layout)).toEqual({ ok: true });
	});

	it("refuses a line under a day's task section, naming the section", () => {
		const verdict = checkFilable("- [ ] Water the plants", "todayHeading", layout);

		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.reason).toContain("Today");
	});

	it("refuses a line under no section at all", () => {
		const verdict = checkFilable("- [ ] Order more tea", null, layout);

		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.reason).toContain("not under Notes");
	});

	it("refuses a plain bullet, saying what it found", () => {
		const verdict = checkFilable("- Just a thought", "notesHeading", layout);

		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.reason).toContain("a list item with no checkbox");
	});

	it("refuses a line that is not a list item, saying what it found", () => {
		const verdict = checkFilable("Just some words", "notesHeading", layout);

		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.reason).toContain("text that is not a task");
	});

	it("refuses another Minimal-theme symbol, naming it — the core reads it as an open task", () => {
		const verdict = checkFilable("- [I] An idea for the shed", "notesHeading", layout);

		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.reason).toContain("[I]");
	});

	it("refuses a line carrying this feature's own comment and one carrying another's, with the same message", () => {
		const own = checkFilable("- [>] Order tea [[Errands]] %% migration:abc123 0badc0de %%", "notesHeading", layout);
		const foreign = checkFilable("- [ ] Order tea %% task-consistency:abc123 0badc0de %%", "notesHeading", layout);

		expect(own.ok).toBe(false);
		expect(foreign.ok).toBe(false);
		if (!own.ok && !foreign.ok) {
			expect(own.reason).toBe(foreign.reason);
			expect(own.reason).toContain("may already be filed or paired");
		}
	});
});

describe("sectionOfLine", () => {
	it("finds a line written under the notes heading", () => {
		expect(sectionOfLine(LOG, 2, layout)).toBe("notesHeading");
	});

	it("finds the day's task section a line sits in, though the notes section reaches over it", () => {
		expect(sectionOfLine(LOG, 11, layout)).toBe("todayHeading");
		expect(sectionOfLine(LOG, 7, layout)).toBe("overdueHeading");
	});

	it("answers null for a line above every heading", () => {
		expect(sectionOfLine("- [ ] Loose line\n\n# Notes\n", 0, layout)).toBeNull();
	});
});
