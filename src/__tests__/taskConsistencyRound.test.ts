import { describe, expect, it } from "vitest";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { writeMarker } from "../features/taskConsistency/marker";
import { roundStep } from "../features/taskConsistency/round";

// The round step,
// spec #1222 decisions 4–7.
// Every collection, note and task below is invented: no real task, name or path
// from any vault. The day the run sees is Tuesday 2026-09-22.

const TODAY = new Date(2026, 8, 22, 9, 0);

function layout(overrides: Partial<VaultLayout> = {}): VaultLayout {
	return { ...defaultData().core.layout, ...overrides };
}

/** `raw` with a pairing marker for `eid` — the hash is never read by the round step, so one fixed, valid hash serves every fixture. */
function marked(raw: string, eid: string): string {
	return writeMarker(raw, eid, "aaaaaaaa");
}

const TASKS = "## Tasks";
const COMPLETED = "## Completed tasks";

function run(text: string, overrides: Partial<VaultLayout> = {}) {
	return roundStep(text, TODAY, layout(overrides));
}

describe("roundStep: the round a finished recurring line brings", () => {
	it("replaces a done line with a scheduled date by the fresh round and moves the done line under the completed-tasks heading, asserting every byte", () => {
		// If the step wrote no round, left the done line under the tasks heading,
		// kept the old date, or put the round after the done line, this exact
		// string would not match.
		const input = [TASKS, "- [x] Water the ferns 🔁 every week ⏳ 2026-09-20", "- [ ] Buy stamps", COMPLETED, "- [x] Sweep the porch"].join("\n");

		const result = run(input);

		expect(result.rounds).toBe(1);
		expect(result.leftAlone).toEqual([]);
		expect(result.collection).toBe(
			[
				TASKS,
				"- [ ] Water the ferns 🔁 every week ⏳ 2026-09-27",
				"- [ ] Buy stamps",
				COMPLETED,
				"- [x] Sweep the porch",
				"- [x] Water the ferns 🔁 every week ⏳ 2026-09-20",
			].join("\n"),
		);
	});

	it("writes the completed-tasks heading when the note has none, as finishing does", () => {
		const input = [TASKS, "- [x] Water the ferns 🔁 every week ⏳ 2026-09-20", ""].join("\n");

		expect(run(input).collection).toBe(
			[TASKS, "- [ ] Water the ferns 🔁 every week ⏳ 2026-09-27", "", COMPLETED, "", "- [x] Water the ferns 🔁 every week ⏳ 2026-09-20", ""].join("\n"),
		);
	});

	it("keeps the fresh round where the finished line stood when the completed-tasks heading is written above the tasks heading", () => {
		// If the fresh block were placed by the finished line's index after the
		// move, it would land inside the completed section here.
		const input = [COMPLETED, "- [x] Sweep the porch", "", TASKS, "- [ ] Buy stamps", "- [x] Water the ferns 🔁 every week ⏳ 2026-09-20", "- [ ] Call the plumber"].join("\n");

		expect(run(input).collection).toBe(
			[
				COMPLETED,
				"- [x] Sweep the porch",
				"- [x] Water the ferns 🔁 every week ⏳ 2026-09-20",
				"",
				TASKS,
				"- [ ] Buy stamps",
				"- [ ] Water the ferns 🔁 every week ⏳ 2026-09-27",
				"- [ ] Call the plumber",
			].join("\n"),
		);
	});

	it("recurs a cancelled line the same way", () => {
		// A step that read only `done` would leave the text as it came.
		const input = [TASKS, "- [-] Water the ferns 🔁 every week ⏳ 2026-09-20", COMPLETED].join("\n");

		expect(run(input).collection).toBe(
			[TASKS, "- [ ] Water the ferns 🔁 every week ⏳ 2026-09-27", COMPLETED, "- [-] Water the ferns 🔁 every week ⏳ 2026-09-20"].join("\n"),
		);
	});

	it("moves ⏳ and 📅 by the same count of days, keeping their gap", () => {
		// The gap is three days: ⏳ 09-20 and 📅 09-23. Moving only ⏳ to 09-27
		// would leave 📅 at 09-23 and fail this string.
		const input = [TASKS, "- [x] Pay the invoice 🔁 every week ⏳ 2026-09-20 📅 2026-09-23", COMPLETED].join("\n");

		expect(run(input).collection).toBe(
			[
				TASKS,
				"- [ ] Pay the invoice 🔁 every week ⏳ 2026-09-27 📅 2026-09-30",
				COMPLETED,
				"- [x] Pay the invoice 🔁 every week ⏳ 2026-09-20 📅 2026-09-23",
			].join("\n"),
		);
	});

	it("follows a line with a due date only by its due date", () => {
		// If the step looked only at ⏳ it would find no date and leave the line.
		const input = [TASKS, "- [x] Renew the permit 🔁 every month 📅 2026-09-20", COMPLETED].join("\n");

		const result = run(input);

		expect(result.rounds).toBe(1);
		expect(result.collection).toBe(
			[TASKS, "- [ ] Renew the permit 🔁 every month 📅 2026-10-20", COMPLETED, "- [x] Renew the permit 🔁 every month 📅 2026-09-20"].join("\n"),
		);
	});

	it("follows scheduled before due when a line has both: the next date counts from ⏳", () => {
		// Counting from 📅 09-21 would give 09-28 for ⏳, not 09-27.
		const input = [TASKS, "- [x] Pay the invoice 🔁 every week ⏳ 2026-09-20 📅 2026-09-21", COMPLETED].join("\n");

		expect(run(input).collection).toContain("- [ ] Pay the invoice 🔁 every week ⏳ 2026-09-27 📅 2026-09-28");
	});

	it("gives one fresh round not before today for a late tick on a fixed rule, and counts a when-done rule from today", () => {
		// Fixed: the own date 2026-08-01 is several weeks past; the round is the
		// first on the rhythm not before today (09-26), never a pile of them and
		// never 08-08. When done: the first date strictly after today, 09-29.
		const fixed = [TASKS, "- [x] Water the ferns 🔁 every week ⏳ 2026-08-01", COMPLETED].join("\n");
		const whenDone = [TASKS, "- [x] Clean the filter 🔁 every week when done ⏳ 2026-08-01", COMPLETED].join("\n");

		const fixedResult = run(fixed);
		const doneResult = run(whenDone);

		expect(fixedResult.rounds).toBe(1);
		expect(fixedResult.collection).toBe(
			[TASKS, "- [ ] Water the ferns 🔁 every week ⏳ 2026-09-26", COMPLETED, "- [x] Water the ferns 🔁 every week ⏳ 2026-08-01"].join("\n"),
		);
		expect(doneResult.collection).toBe(
			[TASKS, "- [ ] Clean the filter 🔁 every week when done ⏳ 2026-09-29", COMPLETED, "- [x] Clean the filter 🔁 every week when done ⏳ 2026-08-01"].join("\n"),
		);
	});

	it("gives every finished recurring line under the heading its round, one after another", () => {
		const input = [
			TASKS,
			"- [x] Water the ferns 🔁 every week ⏳ 2026-09-20",
			"- [ ] Buy stamps",
			"- [-] Pay the invoice 🔁 every month ⏳ 2026-09-15",
			COMPLETED,
		].join("\n");

		const result = run(input);

		expect(result.rounds).toBe(2);
		expect(result.collection).toBe(
			[
				TASKS,
				"- [ ] Water the ferns 🔁 every week ⏳ 2026-09-27",
				"- [ ] Buy stamps",
				"- [ ] Pay the invoice 🔁 every month ⏳ 2026-10-15",
				COMPLETED,
				"- [x] Water the ferns 🔁 every week ⏳ 2026-09-20",
				"- [-] Pay the invoice 🔁 every month ⏳ 2026-09-15",
			].join("\n"),
		);
	});

	it("moves and recurs a finished line that carries no pairing marker, and one that does, the same way", () => {
		// The round step never reads the marker: an unpaired finished recurring
		// line gets its round, though an unpaired finished plain task is not moved.
		const unpaired = [TASKS, "- [x] Water the ferns 🔁 every week ⏳ 2026-09-20", COMPLETED].join("\n");
		const paired = [TASKS, marked("- [x] Water the ferns 🔁 every week ⏳ 2026-09-20", "fern-1"), COMPLETED].join("\n");

		expect(run(unpaired).collection).toBe(
			[TASKS, "- [ ] Water the ferns 🔁 every week ⏳ 2026-09-27", COMPLETED, "- [x] Water the ferns 🔁 every week ⏳ 2026-09-20"].join("\n"),
		);
		const result = run(paired);
		expect(result.collection).toBe(
			[TASKS, "- [ ] Water the ferns 🔁 every week ⏳ 2026-09-27", COMPLETED, marked("- [x] Water the ferns 🔁 every week ⏳ 2026-09-20", "fern-1")].join("\n"),
		);
	});
});

describe("roundStep: the subtree", () => {
	it("brings every subtask back open with its dates moved by the same count, a dateless subtask dateless, plain bullets kept, every pairing marker gone and every other byte identical", () => {
		// If a checkbox stayed done, a dated subtask kept its old date, a dateless
		// one gained a date, a marker survived on any line, or a tag, priority,
		// done date or plain bullet changed, this exact string would not match.
		// The finished subtree moves with its open subtask set done by the move,
		// markers and all.
		const input = [
			TASKS,
			marked("- [x] Clear the shed 🔁 every week ⏳ 2026-09-20 📅 2026-09-24 #home ⏫", "shed-1"),
			marked("\t- [x] Sort the tools ⏳ 2026-09-21 ✅ 2026-09-21", "shed-2"),
			"\t- [ ] Sweep the floor",
			marked("\t- [/] Take the bags out 📅 2026-09-23", "shed-3"),
			"\t- a plain note about the key",
			"\t\t- [-] Ask the neighbour about the ladder ⏳ 2026-09-22",
			"- [ ] Buy stamps",
			COMPLETED,
		].join("\n");

		const result = run(input);

		expect(result.collection).toBe(
			[
				TASKS,
				"- [ ] Clear the shed 🔁 every week ⏳ 2026-09-27 📅 2026-10-01 #home ⏫",
				"\t- [ ] Sort the tools ⏳ 2026-09-28 ✅ 2026-09-21",
				"\t- [ ] Sweep the floor",
				"\t- [ ] Take the bags out 📅 2026-09-30",
				"\t- a plain note about the key",
				"\t\t- [ ] Ask the neighbour about the ladder ⏳ 2026-09-29",
				"- [ ] Buy stamps",
				COMPLETED,
				marked("- [x] Clear the shed 🔁 every week ⏳ 2026-09-20 📅 2026-09-24 #home ⏫", "shed-1"),
				marked("\t- [x] Sort the tools ⏳ 2026-09-21 ✅ 2026-09-21", "shed-2"),
				"\t- [x] Sweep the floor",
				marked("\t- [x] Take the bags out 📅 2026-09-23", "shed-3"),
				"\t- a plain note about the key",
				"\t\t- [-] Ask the neighbour about the ladder ⏳ 2026-09-22",
			].join("\n"),
		);
	});

	it("carries a subtask's own 🔁 rule as text, spawns nothing for it and does not name it", () => {
		// A subtask with a readable rule and a subtask with an unreadable one:
		// neither makes a round of its own and neither is among the answers, while
		// both rules come back as text.
		const input = [
			TASKS,
			"- [x] Clear the shed 🔁 every month ⏳ 2026-09-20",
			"\t- [x] Oil the hinges 🔁 every week ⏳ 2026-09-20",
			"\t- [ ] Sort the screws 🔁 every weekday please",
			COMPLETED,
		].join("\n");

		const result = run(input);

		expect(result.rounds).toBe(1);
		expect(result.leftAlone).toEqual([]);
		expect(result.collection).toBe(
			[
				TASKS,
				"- [ ] Clear the shed 🔁 every month ⏳ 2026-10-20",
				"\t- [ ] Oil the hinges 🔁 every week ⏳ 2026-10-20",
				"\t- [ ] Sort the screws 🔁 every weekday please",
				COMPLETED,
				"- [x] Clear the shed 🔁 every month ⏳ 2026-09-20",
				"\t- [x] Oil the hinges 🔁 every week ⏳ 2026-09-20",
				"\t- [x] Sort the screws 🔁 every weekday please",
			].join("\n"),
		);
	});

	it("never reads a finished recurring line that is itself a subtask, and does not name it", () => {
		const input = [TASKS, "- [ ] Clear the shed", "\t- [x] Oil the hinges 🔁 every week ⏳ 2026-09-20", COMPLETED].join("\n");

		const result = run(input);

		expect(result.collection).toBe(input);
		expect(result.rounds).toBe(0);
		expect(result.leftAlone).toEqual([]);
	});
});

describe("roundStep: what it leaves alone", () => {
	it("never reads a finished recurring line already under the completed-tasks heading: a second call over the first's result creates nothing and is byte-identical", () => {
		// The bookkeeping decision: if the step read the
		// completed section, the second call would write a round for the moved
		// line again.
		const input = [TASKS, "- [x] Water the ferns 🔁 every week ⏳ 2026-09-20", COMPLETED].join("\n");

		const first = run(input);
		const second = run(first.collection);

		expect(first.rounds).toBe(1);
		expect(second.rounds).toBe(0);
		expect(second.collection).toBe(first.collection);
	});

	it("reads nothing under a completed-tasks heading that encloses the tasks heading: no throw, no round, and a second call is byte-identical", () => {
		// Every line under the tasks heading is also under the completed-tasks
		// heading that encloses it, and the move lands a finished line at the end
		// of that enclosing section, which is still inside the tasks range. If the
		// step read the tasks range, it would round the moved line again and
		// again until its loop guard threw "wrote 7 rounds into a note of 6 lines".
		const input = ["# Completed tasks", "", "## Tasks", "- [x] A 🔁 every day ⏳ 2026-09-20", "- [ ] B", ""].join("\n");

		const first = run(input);
		const second = run(first.collection);

		expect(first.collection).toBe(input);
		expect(first.rounds).toBe(0);
		expect(second.collection).toBe(input);
		expect(second.rounds).toBe(0);
	});

	it("reads nothing when the completed-tasks heading's text is the tasks heading's own: no throw, no round", () => {
		// There is no second place for the finished line to go, so a round written
		// beside it would be written again by every run.
		const input = [TASKS, "- [x] A 🔁 every day ⏳ 2026-09-20", "- [ ] B", ""].join("\n");

		const result = run(input, { completedTasksHeading: "Tasks" });

		expect(result.collection).toBe(input);
		expect(result.rounds).toBe(0);
	});

	it("still rounds when the completed-tasks heading is written above the tasks heading without enclosing it", () => {
		// The guard against an enclosing heading must not catch this ordinary
		// layout: both level 2, the completed section ends where the tasks one
		// begins.
		const input = [COMPLETED, "- [x] Sweep the porch", "", TASKS, "- [x] A 🔁 every day ⏳ 2026-09-20", "- [ ] B"].join("\n");

		const result = run(input);

		expect(result.rounds).toBe(1);
		expect(result.collection).toBe(
			[COMPLETED, "- [x] Sweep the porch", "- [x] A 🔁 every day ⏳ 2026-09-20", "", TASKS, "- [ ] A 🔁 every day ⏳ 2026-09-22", "- [ ] B"].join("\n"),
		);
	});

	it("creates nothing for an open, dated recurring line whose date is today or past", () => {
		const input = [TASKS, "- [ ] Water the ferns 🔁 every week ⏳ 2026-09-22", "- [ ] Pay the invoice 🔁 every month 📅 2026-08-01", COMPLETED].join("\n");

		const result = run(input);

		expect(result.collection).toBe(input);
		expect(result.rounds).toBe(0);
		expect(result.leftAlone).toEqual([]);
	});

	it("leaves a readable rule on a dateless line byte-identical, finished or not, and names the line and the fault", () => {
		const input = [TASKS, "- [x] Water the ferns 🔁 every week", "- [ ] Dust the shelves 🔁 every month", COMPLETED].join("\n");

		const result = run(input);

		expect(result.collection).toBe(input);
		expect(result.rounds).toBe(0);
		expect(result.leftAlone).toEqual([
			{ line: 1, text: "- [x] Water the ferns 🔁 every week", rule: "every week", reason: "no-date" },
			{ line: 2, text: "- [ ] Dust the shelves 🔁 every month", rule: "every month", reason: "no-date" },
		]);
	});

	it("leaves an unreadable rule on a dated line byte-identical, finished or not, and names the line and the fault", () => {
		// `every weekday please`, `every 1 week` and `every Mon` are refused by the
		// repeat-rule module; reading them as a rule would write a round.
		const input = [
			TASKS,
			"- [x] Water the ferns 🔁 every 1 week ⏳ 2026-09-20",
			"- [ ] Dust the shelves 🔁 every weekday please ⏳ 2026-09-20",
			COMPLETED,
		].join("\n");

		const result = run(input);

		expect(result.collection).toBe(input);
		expect(result.leftAlone).toEqual([
			{ line: 1, text: "- [x] Water the ferns 🔁 every 1 week ⏳ 2026-09-20", rule: "every 1 week", reason: "unreadable-rule" },
			{ line: 2, text: "- [ ] Dust the shelves 🔁 every weekday please ⏳ 2026-09-20", rule: "every weekday please", reason: "unreadable-rule" },
		]);
	});

	it("names an unreadable rule as unreadable even on a dateless line, since the rule is what is wrong first", () => {
		const result = run([TASKS, "- [x] Water the ferns 🔁 every 1 week", COMPLETED].join("\n"));

		expect(result.leftAlone.map((item) => item.reason)).toEqual(["unreadable-rule"]);
	});

	it("leaves a collection whose completed-tasks heading is blank byte-identical, and the answer says so", () => {
		// With the heading blank there is nowhere to move the finished line to;
		// a round written anyway would be written again on every run.
		const input = [TASKS, "- [x] Water the ferns 🔁 every week ⏳ 2026-09-20", "- [ ] Buy stamps"].join("\n");

		const result = run(input, { completedTasksHeading: "   " });

		expect(result.collection).toBe(input);
		expect(result.rounds).toBe(0);
		expect(result.leftAlone).toEqual([
			{ line: 1, text: "- [x] Water the ferns 🔁 every week ⏳ 2026-09-20", rule: "every week", reason: "no-completed-heading" },
		]);
	});

	it("leaves a line alone and says so when the rule gives no next date", () => {
		// Counting past year 9999 gives nothing to write.
		const input = [TASKS, "- [x] Water the ferns 🔁 every day ⏳ 9999-12-31", COMPLETED].join("\n");

		const result = run(input);

		expect(result.collection).toBe(input);
		expect(result.leftAlone.map((item) => item.reason)).toEqual(["no-next-date"]);
	});

	it("leaves a line alone when a subtask's date is in a year the repeat rule does not read", () => {
		// The repeat-rule module reads years 1000–9999 only, and the round moves
		// a subtask's date the way that module reads it, so `0999-12-31` cannot
		// be moved. A round written anyway would invent `1000-01-07`.
		const input = [
			TASKS,
			"- [x] Water the ferns 🔁 every week ⏳ 2026-09-20",
			"\t- [x] Fill the can ⏳ 0999-12-31",
			COMPLETED,
		].join("\n");

		const result = run(input);

		expect(result.collection).toBe(input);
		expect(result.rounds).toBe(0);
		expect(result.leftAlone.map((item) => item.reason)).toEqual(["no-next-date"]);
	});

	it("leaves a when-done line alone when its own date is in a year the repeat rule does not read", () => {
		// A when-done rule counts its next date from today, not from the line's own
		// date, so the next date is found; the subtasks would then be moved by the
		// days between `0999-12-31` and that date, which the repeat rule cannot count.
		const input = [
			TASKS,
			"- [x] Water the ferns 🔁 every week when done ⏳ 0999-12-31",
			"\t- [x] Fill the can ⏳ 2026-09-20",
			COMPLETED,
		].join("\n");

		const result = run(input);

		expect(result.collection).toBe(input);
		expect(result.rounds).toBe(0);
		expect(result.leftAlone.map((item) => item.reason)).toEqual(["no-next-date"]);
	});

	it("writes nothing when the note has no tasks heading", () => {
		const input = ["## Notes", "- [x] Water the ferns 🔁 every week ⏳ 2026-09-20"].join("\n");

		expect(run(input).collection).toBe(input);
	});
});

describe("roundStep on a note with Windows line endings", () => {
	const crlf = (lines: readonly string[]) => lines.join("\r\n");

	it("keeps \\r\\n on every line and writes the round with it, with no final line break", () => {
		// A bare "\n" anywhere, or a stray "\r" left at the end of the note, fails
		// the exact string. The moved line was the note's last and takes the
		// ending of the line before it.
		const input = crlf([TASKS, marked("- [x] Water the ferns 🔁 every week ⏳ 2026-09-20", "fern-1"), COMPLETED, "- [x] Sweep the porch"]);

		expect(run(input).collection).toBe(
			crlf([
				TASKS,
				"- [ ] Water the ferns 🔁 every week ⏳ 2026-09-27",
				COMPLETED,
				"- [x] Sweep the porch",
				marked("- [x] Water the ferns 🔁 every week ⏳ 2026-09-20", "fern-1"),
			]),
		);
	});

	it("keeps \\r\\n through to a final line break", () => {
		const input = crlf([TASKS, marked("- [x] Water the ferns 🔁 every week ⏳ 2026-09-20", "fern-1"), COMPLETED, "- [x] Sweep the porch", ""]);

		expect(run(input).collection).toBe(
			crlf([
				TASKS,
				"- [ ] Water the ferns 🔁 every week ⏳ 2026-09-27",
				COMPLETED,
				"- [x] Sweep the porch",
				marked("- [x] Water the ferns 🔁 every week ⏳ 2026-09-20", "fern-1"),
				"",
			]),
		);
	});

	it("gives a round written at the end of a note with no final line break the ending of the line before it, with a subtree", () => {
		// The finished block is the note's last lines and has no ending of its
		// own on the last one; the fresh block above it must end its last line
		// with \r\n, and the moved block must not end the note with one.
		const input = crlf([TASKS, "- [x] Clear the shed 🔁 every week ⏳ 2026-09-20", "\t- [ ] Sort the tools ⏳ 2026-09-21"]);

		expect(run(input).collection).toBe(
			crlf([
				TASKS,
				"- [ ] Clear the shed 🔁 every week ⏳ 2026-09-27",
				"\t- [ ] Sort the tools ⏳ 2026-09-28",
				"",
				COMPLETED,
				"",
				"- [x] Clear the shed 🔁 every week ⏳ 2026-09-20",
				"\t- [x] Sort the tools ⏳ 2026-09-21",
			]),
		);
	});

	it("leaves a bare-\\n line of a mixed note as it was", () => {
		const input = `${TASKS}\r\n- [ ] Buy stamps\n- [x] Water the ferns 🔁 every week ⏳ 2026-09-20\r\n${COMPLETED}\n- [x] Sweep the porch`;

		expect(run(input).collection).toBe(
			`${TASKS}\r\n- [ ] Buy stamps\n- [ ] Water the ferns 🔁 every week ⏳ 2026-09-27\r\n${COMPLETED}\n- [x] Sweep the porch\n- [x] Water the ferns 🔁 every week ⏳ 2026-09-20`,
		);
	});
});
