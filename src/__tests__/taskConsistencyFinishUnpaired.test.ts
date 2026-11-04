import { describe, expect, it } from "vitest";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { finishUnpaired } from "../features/taskConsistency/finishUnpaired";
import { writeMarker } from "../features/taskConsistency/marker";

/**
 * The finishing move for a task no day's log ever paired: a finished
 * task under the tasks heading that carries no pairing marker moves under the
 * completed-tasks heading by the same rules a paired one does.
 *
 * Every collection, note and task below is invented: no real task, name or
 * path from any vault.
 */

function layout(overrides: Partial<VaultLayout> = {}): VaultLayout {
	return { ...defaultData().core.layout, ...overrides };
}

describe("finishUnpaired", () => {
	it("moves an undated, never-paired done task with its subtree under the completed-tasks heading, an open subtask set to done, every other byte identical", () => {
		// If the pass ignored unpaired lines, this text would come back as it
		// went in and `moved` would be empty.
		const collection = [
			"## Tasks",
			"",
			"- [x] Call @[[Alex]] about the boat",
			"\t- [ ] Find the number",
			"\tA plain note line",
			"- [ ] Buy stamps",
			"",
			"## Completed tasks",
			"",
			"- [x] Sweep the porch",
			"",
		].join("\n");

		const result = finishUnpaired(collection, layout());

		expect(result.moved).toEqual(["- [x] Call @[[Alex]] about the boat"]);
		expect(result.collection).toBe(
			[
				"## Tasks",
				"",
				"- [ ] Buy stamps",
				"",
				"## Completed tasks",
				"",
				"- [x] Sweep the porch",
				"- [x] Call @[[Alex]] about the boat",
				"\t- [x] Find the number",
				"\tA plain note line",
				"",
			].join("\n"),
		);
	});

	it("leaves a finished subtask under an open parent where it is, and still moves a finished task written after it", () => {
		// A pass that stopped at the first line it could not move would leave
		// "Post the letter" behind; one that ignored the parent would move the
		// subtask out from under it.
		const collection = [
			"## Tasks",
			"- [ ] Plan the trip",
			"\t- [x] Book the ferry",
			"- [x] Post the letter",
			"",
		].join("\n");

		const result = finishUnpaired(collection, layout());

		expect(result.moved).toEqual(["- [x] Post the letter"]);
		expect(result.collection).toBe(
			[
				"## Tasks",
				"- [ ] Plan the trip",
				"\t- [x] Book the ferry",
				"",
				"## Completed tasks",
				"",
				"- [x] Post the letter",
				"",
			].join("\n"),
		);
	});

	it("leaves a finished line that carries a pairing marker byte-identical: the paired path moves it, never this one", () => {
		// If this pass took paired lines too, the marked line would be under
		// the completed-tasks heading here, ahead of the run's own pairing step.
		const collection = ["## Tasks", writeMarker("- [x] Return the drill", "drill-1", "aaaaaaaa"), ""].join("\n");

		const result = finishUnpaired(collection, layout());

		expect(result).toEqual({ collection, moved: [] });
	});

	it("leaves a finished 🔁 line whose rule reads byte-identical, dated or not: the round step owns it", () => {
		// Moved here, a dated line would lose its next round, and a dateless
		// one its standing report.
		const collection = [
			"## Tasks",
			"- [x] Water the ferns 🔁 every week ⏳ 2026-09-20",
			"- [x] Air the tent 🔁 every week",
			"",
		].join("\n");

		const result = finishUnpaired(collection, layout());

		expect(result).toEqual({ collection, moved: [] });
	});

	it("moves a finished 🔁 line whose rule cannot be read, as any task that does not repeat", () => {
		// A pass that skipped every line with a 🔁 sign would leave this line
		// under the tasks heading for good, while its paired twin moves.
		const collection = ["## Tasks", "- [x] Oil the hinges 🔁 every full moon ⏳ 2026-09-20", ""].join("\n");

		const result = finishUnpaired(collection, layout());

		expect(result.moved).toEqual(["- [x] Oil the hinges 🔁 every full moon ⏳ 2026-09-20"]);
		expect(result.collection).toBe(
			[
				"## Tasks",
				"",
				"## Completed tasks",
				"",
				"- [x] Oil the hinges 🔁 every full moon ⏳ 2026-09-20",
				"",
			].join("\n"),
		);
	});

	it("reads nothing under a completed-tasks heading that encloses the tasks heading, or is the same heading: no loop, no throw, bytes unchanged", () => {
		// The move would put the line at the end of the enclosing section,
		// which is still inside the tasks range, so a pass that read it would
		// find the same line again forever.
		const enclosing = ["# Completed tasks", "", "## Tasks", "- [x] Post the letter", ""].join("\n");
		const same = ["## Tasks", "- [x] Post the letter", ""].join("\n");

		expect(finishUnpaired(enclosing, layout())).toEqual({ collection: enclosing, moved: [] });
		expect(finishUnpaired(same, layout({ completedTasksHeading: "Tasks" }))).toEqual({ collection: same, moved: [] });
	});

	it("moves a cancelled, never-paired task the same way, writing the completed-tasks heading when the note has none, an open subtask set to cancelled", () => {
		// A pass that read only `done` as finished would leave this line put.
		const collection = ["## Tasks", "- [-] Paint the shed", "\t- [ ] Buy the paint", "- [ ] Buy stamps", ""].join("\n");

		const result = finishUnpaired(collection, layout());

		expect(result.moved).toEqual(["- [-] Paint the shed"]);
		expect(result.collection).toBe(
			[
				"## Tasks",
				"- [ ] Buy stamps",
				"",
				"## Completed tasks",
				"",
				"- [-] Paint the shed",
				"\t- [-] Buy the paint",
				"",
			].join("\n"),
		);
	});

	it("leaves the bytes unchanged when the completed-tasks heading is blank", () => {
		// A blank heading means the move is switched off; anything else would
		// have to invent a place for the line to go.
		const collection = ["## Tasks", "- [x] Post the letter", "- [-] Paint the shed", ""].join("\n");

		expect(finishUnpaired(collection, layout({ completedTasksHeading: "  " }))).toEqual({ collection, moved: [] });
	});

	it("moves every finished line in the order it was written, and a second call over the result is byte-identical", () => {
		const collection = ["## Tasks", "- [x] Post the letter", "- [ ] Buy stamps", "- [-] Paint the shed", ""].join("\n");

		const once = finishUnpaired(collection, layout());
		const twice = finishUnpaired(once.collection, layout());

		expect(once.moved).toEqual(["- [x] Post the letter", "- [-] Paint the shed"]);
		expect(once.collection).toBe(
			[
				"## Tasks",
				"- [ ] Buy stamps",
				"",
				"## Completed tasks",
				"",
				"- [x] Post the letter",
				"- [-] Paint the shed",
				"",
			].join("\n"),
		);
		expect(twice).toEqual({ collection: once.collection, moved: [] });
	});
});

describe("finishUnpaired on a note with Windows line endings", () => {
	it("keeps \\r\\n on every line through to a final line break", () => {
		// A move that rejoined with bare \n, or dropped the final break, would
		// differ from this string in exactly those bytes.
		const collection = "## Tasks\r\n- [x] Post the letter\r\n\t- [ ] Buy a stamp\r\n- [ ] Buy milk\r\n";

		const result = finishUnpaired(collection, layout());

		expect(result.moved).toEqual(["- [x] Post the letter"]);
		expect(result.collection).toBe(
			"## Tasks\r\n- [ ] Buy milk\r\n\r\n## Completed tasks\r\n\r\n- [x] Post the letter\r\n\t- [x] Buy a stamp\r\n",
		);
	});

	it("keeps \\r\\n on every line and gains no final line break when the note had none", () => {
		// "Buy milk" ended the note with no ending; once lines follow it, it
		// takes the ending of the line before it.
		const collection = "## Tasks\r\n- [x] Post the letter\r\n\t- [ ] Buy a stamp\r\n- [ ] Buy milk";

		const result = finishUnpaired(collection, layout());

		expect(result.moved).toEqual(["- [x] Post the letter"]);
		expect(result.collection).toBe(
			"## Tasks\r\n- [ ] Buy milk\r\n\r\n## Completed tasks\r\n\r\n- [x] Post the letter\r\n\t- [x] Buy a stamp",
		);
	});

	it("leaves a finished task whose subtree holds a held pairing where it stands, and still moves the finished task after it", () => {
		// If the pass ignored the held set, the boat call would move and its
		// subtask read `[x]`; if a refused line stopped the scan (or threw, as
		// the pass does when the move refuses a line it chose), "Post the
		// letter" would not move either.
		const heldLine = "\t" + writeMarker("- [/] Find the number", "number-1", "aaaaaaaa");
		const collection = [
			"## Tasks",
			"- [x] Call the boatyard",
			heldLine,
			"- [x] Post the letter",
			"",
		].join("\n");

		const result = finishUnpaired(collection, layout(), new Set(["number-1"]));

		expect(result.moved).toEqual(["- [x] Post the letter"]);
		expect(result.collection).toBe(
			[
				"## Tasks",
				"- [x] Call the boatyard",
				heldLine,
				"",
				"## Completed tasks",
				"",
				"- [x] Post the letter",
				"",
			].join("\n"),
		);
	});
});
