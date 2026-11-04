import { describe, expect, it } from "vitest";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { completeInCollection, completeLineInCollection } from "../features/taskConsistency/complete";
import { writeMarker } from "../features/taskConsistency/marker";

// Every collection, note and task below is invented: no real task, name or
// path from any vault.

function layout(overrides: Partial<VaultLayout> = {}): VaultLayout {
	return { ...defaultData().core.layout, ...overrides };
}

/** `raw` with a pairing marker for `eid` — the hash's own value is never read by this module, so one fixed, valid hash serves every fixture. */
function marked(raw: string, eid: string): string {
	return writeMarker(raw, eid, "aaaaaaaa");
}

describe("completeInCollection", () => {
	it("moves a done task with two subtasks to the end of an existing completed-tasks section, an open subtask set to done, every other byte identical", () => {
		// If the move dropped a subtask, copied the wrong checkbox onto one, or
		// inserted anywhere but the end of the existing section, this exact
		// string would not match.
		const collection = [
			"## Tasks",
			"",
			marked("- [x] Plan the picnic #outdoors", "picnic-1"),
			"\t- [ ] Buy the basket",
			"\t- [x] Pack the blanket",
			"## Completed tasks",
			"",
			"- [x] Sweep the porch",
		].join("\n");

		const result = completeInCollection(collection, "picnic-1", layout());

		expect(result.moved).toBe(true);
		expect(result.collection).toBe(
			[
				"## Tasks",
				"",
				"## Completed tasks",
				"",
				"- [x] Sweep the porch",
				marked("- [x] Plan the picnic #outdoors", "picnic-1"),
				"\t- [x] Buy the basket",
				"\t- [x] Pack the blanket",
			].join("\n"),
		);
	});

	it("moves a cancelled task the same way, an open subtask set to cancelled", () => {
		// A code path that only handled `done`, not `cancelled`, would leave the
		// block where it started and this would still equal the input — failing
		// the `moved` assertion and the text assertion both. The fixture's
		// completed-tasks heading has nothing under it but a trailing blank
		// line, kept at the end: a fix that dropped it, or inserted the
		// block after it, would fail this exact string.
		const collection = [
			"## Tasks",
			"",
			marked("- [-] Cancel the trip #travel", "trip-1"),
			"\t- [ ] Notify the guide",
			"\t- [-] Refund the deposit",
			"## Completed tasks",
			"",
		].join("\n");

		const result = completeInCollection(collection, "trip-1", layout());

		expect(result.moved).toBe(true);
		expect(result.collection).toBe(
			[
				"## Tasks",
				"",
				"## Completed tasks",
				marked("- [-] Cancel the trip #travel", "trip-1"),
				"\t- [-] Notify the guide",
				"\t- [-] Refund the deposit",
				"",
			].join("\n"),
		);
	});

	it("keeps a blank line inside a subtree with the subtree, rather than ending it there", () => {
		// If a blank line always ended the subtree, "Water the seedlings" would
		// stay open and orphaned above "Walk the dog" instead of moving and
		// being ticked with the rest of the block.
		const collection = [
			"## Tasks",
			"",
			marked("- [x] Tend the garden", "garden-1"),
			"\t- [ ] Weed the beds",
			"",
			"\t- [ ] Water the seedlings",
			"- [ ] Walk the dog",
			"## Completed tasks",
			"",
		].join("\n");

		const result = completeInCollection(collection, "garden-1", layout());

		expect(result.moved).toBe(true);
		expect(result.collection).toBe(
			[
				"## Tasks",
				"",
				"- [ ] Walk the dog",
				"## Completed tasks",
				marked("- [x] Tend the garden", "garden-1"),
				"\t- [x] Weed the beds",
				"",
				"\t- [x] Water the seedlings",
				"",
			].join("\n"),
		);
	});

	it("lands the moved block before the completed-tasks section's own trailing blank lines, keeping the file's final newline", () => {
		// The section already holds a finished task and ends with two blank
		// lines, the ordinary shape of a saved note. A fix that appended after
		// them would insert a blank line before the moved block and drop the
		// file's own trailing newline.
		const collection = [
			"## Tasks",
			"",
			marked("- [x] Fold the laundry", "laundry-1"),
			"## Completed tasks",
			"",
			"- [x] Empty the bin",
			"",
			"",
		].join("\n");

		const result = completeInCollection(collection, "laundry-1", layout());

		expect(result.moved).toBe(true);
		expect(result.collection).toBe(
			[
				"## Tasks",
				"",
				"## Completed tasks",
				"",
				"- [x] Empty the bin",
				marked("- [x] Fold the laundry", "laundry-1"),
				"",
				"",
			].join("\n"),
		);
	});

	it("writes the completed-tasks heading, beneath the tasks heading, when the collection carries none", () => {
		// The fixture has no trailing newline, the state a note is in when it
		// carries no completed-tasks heading yet has never been re-saved with
		// one; the result keeps that state rather than gaining a newline the
		// file never had.
		const collection = [
			"## Tasks",
			"",
			marked("- [x] Water the seedlings", "seedling-1"),
			"\t- [ ] Log the count",
		].join("\n");

		const result = completeInCollection(collection, "seedling-1", layout());

		expect(result.moved).toBe(true);
		expect(result.collection).toBe(
			[
				"## Tasks",
				"",
				"## Completed tasks",
				"",
				marked("- [x] Water the seedlings", "seedling-1"),
				"\t- [x] Log the count",
			].join("\n"),
		);
	});

	it("moves a task when the completed-tasks heading is written shallower than and above the tasks heading", () => {
		// The completed-tasks heading is level 2, written before a level-3
		// tasks heading; a section clipped only against a completed heading
		// nested deeper would let this shallower-and-earlier one enclose the
		// whole tasks section, and the task would never be found "not yet
		// completed".
		const collection = [
			"## Completed tasks",
			"",
			"- [x] Sweep the porch",
			"",
			"### Tasks",
			"",
			marked("- [x] Water the seedlings", "seedling-1"),
			"- [ ] Buy more seeds",
		].join("\n");

		const result = completeInCollection(collection, "seedling-1", layout());

		expect(result.moved).toBe(true);
		expect(result.collection).toBe(
			[
				"## Completed tasks",
				"",
				"- [x] Sweep the porch",
				"",
				"### Tasks",
				"",
				"- [ ] Buy more seeds",
				marked("- [x] Water the seedlings", "seedling-1"),
			].join("\n"),
		);
	});

	it("never writes the tasks heading itself: a collection carrying none stays exactly as it is", () => {
		// If the code ever "ensured" both headings the way a naive port of
		// `copyIn.ts`'s day-view helper would, this collection would gain a
		// "## Tasks" heading it never had — the exact-equality check below
		// catches that; nothing here can be found without one, so `moved` alone
		// would not.
		const collection = ["# Stray notes", "", marked("- [x] Forgotten chore", "stray-1")].join(
			"\n",
		);

		const result = completeInCollection(collection, "stray-1", layout());

		expect(result.moved).toBe(false);
		expect(result.collection).toBe(collection);
	});

	it("leaves a task already under the completed-tasks heading unchanged, moved false", () => {
		const collection = [
			"## Tasks",
			"",
			"## Completed tasks",
			"",
			marked("- [x] Finished chore", "already-1"),
		].join("\n");

		const result = completeInCollection(collection, "already-1", layout());

		expect(result.moved).toBe(false);
		expect(result.collection).toBe(collection);
	});

	it("rewrites a paired [/] child to the parent's meaning, the same as an open one", () => {
		// `marker.ts`'s own reading treats `copied` as still annotating `open`: if the cascade only rewrote a literal `[ ]`, this child
		// would stay `[/]` under a `[x]` parent and this string would not match.
		const collection = [
			"## Tasks",
			"",
			marked("- [x] Finish the report", "report-1"),
			"\t- [/] Attach the appendix",
			"## Completed tasks",
			"",
		].join("\n");

		const result = completeInCollection(collection, "report-1", layout());

		expect(result.moved).toBe(true);
		expect(result.collection).toBe(
			[
				"## Tasks",
				"",
				"## Completed tasks",
				marked("- [x] Finish the report", "report-1"),
				"\t- [x] Attach the appendix",
				"",
			].join("\n"),
		);
	});

	it("leaves a child whose checkbox the core does not recognise untouched", () => {
		// `taskLine.ts` maps an unknown character to the meaning `open` so
		// that ordinary code can treat it as an unfinished task, but its own
		// rule for the character itself is that it is left alone.
		// A cascade that rewrote every child read as `open` would turn this
		// into `[x]` and fail this string.
		const collection = [
			"## Tasks",
			"",
			marked("- [x] Review the draft", "draft-1"),
			"\t- [?] Ask about the ending",
			"## Completed tasks",
			"",
		].join("\n");

		const result = completeInCollection(collection, "draft-1", layout());

		expect(result.moved).toBe(true);
		expect(result.collection).toBe(
			[
				"## Tasks",
				"",
				"## Completed tasks",
				marked("- [x] Review the draft", "draft-1"),
				"\t- [?] Ask about the ending",
				"",
			].join("\n"),
		);
	});

	it("leaves a [/] task with no counterpart in any log exactly as it is — the log holds no state, so a missing counterpart is nothing to this feature", () => {
		// This module never reads a log at all; the guard that stops it here is
		// reading the collection's own checkbox. If the guard checked only that
		// an eid matched, rather than that the meaning is done or cancelled, a
		// copied task would wrongly move and this would fail on both fields.
		const collection = [
			"## Tasks",
			"",
			marked("- [/] Still copied, never finished", "float-1"),
		].join("\n");

		const result = completeInCollection(collection, "float-1", layout());

		expect(result.moved).toBe(false);
		expect(result.collection).toBe(collection);
	});

	it("leaves the task where it is when the completed-tasks heading is blank, rather than inventing a place to put it", () => {
		const collection = [
			"## Tasks",
			"",
			marked("- [x] Done, nowhere to go", "blank-1"),
		].join("\n");

		const result = completeInCollection(
			collection,
			"blank-1",
			layout({ completedTasksHeading: "" }),
		);

		expect(result.moved).toBe(false);
		expect(result.collection).toBe(collection);
	});

	it("leaves a subtask ticked on its own under its still-open parent, moved false", () => {
		// If the guard read only the subtask's own meaning, this would move to
		// `## Completed tasks` and leave "Plan the picnic" open above nothing —
		// the shape #950 was filed against. Instead the whole string must equal
		// the input, indented subtask included.
		const collection = [
			"## Tasks",
			"",
			"- [ ] Plan the picnic #outdoors",
			"\t" + marked("- [x] Buy the basket", "basket-1"),
			"## Completed tasks",
			"",
		].join("\n");

		const result = completeInCollection(collection, "basket-1", layout());

		expect(result.moved).toBe(false);
		expect(result.collection).toBe(collection);
	});

	it("leaves a subtask alone under a done, unmarked parent: nothing in the sweep ever moves the parent, so the child must never move without it", () => {
		// A parent with no date is never copied to a log and so never carries
		// this feature's own marker; `reconcileAll`'s sweep only ever calls
		// `completeInCollection` for a marked eid, so this parent is never
		// visited on its own account, whatever its checkbox reads. The old guard
		// asked only whether the parent's own meaning was still open, copied or
		// forwarded — done unblocked it — so this would move "Buy the basket"
		// alone and leave "Plan the picnic" ticked, stranded, above nothing.
		const collection = [
			"## Tasks",
			"",
			"- [x] Plan the picnic #outdoors",
			"\t" + marked("- [x] Buy the basket", "basket-1"),
			"## Completed tasks",
			"",
		].join("\n");

		const result = completeInCollection(collection, "basket-1", layout());

		expect(result.moved).toBe(false);
		expect(result.collection).toBe(collection);
	});

	it("leaves a grandchild under a done parent that is itself waiting on an open grandparent", () => {
		// The old guard read only the nearest shallower line: "Pack the boxes"
		// reads done, so it answered "no open parent" for the grandchild without
		// ever asking about "Organise the move" above it — even though "Pack the
		// boxes" itself is waiting on that same open grandparent and has not
		// moved. A grandchild must wait on its own immediate parent regardless of
		// that parent's own meaning, so it never leaves it behind.
		const collection = [
			"## Tasks",
			"",
			"- [ ] Organise the move",
			"\t" + marked("- [x] Pack the boxes", "boxes-1"),
			"\t\t" + marked("- [x] Label the boxes", "labels-1"),
			"## Completed tasks",
			"",
		].join("\n");

		const result = completeInCollection(collection, "labels-1", layout());

		expect(result.moved).toBe(false);
		expect(result.collection).toBe(collection);
	});

	it("never moves the subtask alone, whichever eid the sweep tries first, once the parent is ticked too", () => {
		// The standards review reproduced #958 by resolving the child's own eid
		// before the parent's — exactly what would happen if the child's marker
		// ever sorted ahead of the parent's in a sweep. Whichever eid is tried
		// first, moving the child alone must never happen: it waits until the
		// parent's own call carries it along, and the two end up together,
		// parent first.
		const ticked = [
			"## Tasks",
			"",
			marked("- [x] Plan the picnic #outdoors", "picnic-3"),
			"\t" + marked("- [x] Buy the basket", "basket-2"),
			"## Completed tasks",
			"",
		].join("\n");

		const childFirst = completeInCollection(ticked, "basket-2", layout());
		expect(childFirst.moved).toBe(false);
		expect(childFirst.collection).toBe(ticked);

		const afterParent = completeInCollection(childFirst.collection, "picnic-3", layout());
		expect(afterParent.moved).toBe(true);
		expect(afterParent.collection).toBe(
			[
				"## Tasks",
				"",
				"## Completed tasks",
				marked("- [x] Plan the picnic #outdoors", "picnic-3"),
				"\t" + marked("- [x] Buy the basket", "basket-2"),
				"",
			].join("\n"),
		);
	});

	it("moves a ticked subtask once its parent is later ticked too, an unticked sibling following it set to the parent's meaning", () => {
		// The subtask ("Buy the basket") was already done and left in place by
		// the rule above; ticking the parent now must carry it — still done —
		// and the still-open sibling ("Pack the blanket") along together, in
		// order. A fix that only stopped the lone-subtask move, without leaving
		// the existing cascade to carry a done child through untouched, would
		// fail this exact string.
		const collection = [
			"## Tasks",
			"",
			marked("- [x] Plan the picnic #outdoors", "picnic-2"),
			"\t" + marked("- [x] Buy the basket", "basket-1"),
			"\t- [ ] Pack the blanket",
			"## Completed tasks",
			"",
		].join("\n");

		const result = completeInCollection(collection, "picnic-2", layout());

		expect(result.moved).toBe(true);
		expect(result.collection).toBe(
			[
				"## Tasks",
				"",
				"## Completed tasks",
				marked("- [x] Plan the picnic #outdoors", "picnic-2"),
				"\t" + marked("- [x] Buy the basket", "basket-1"),
				"\t- [x] Pack the blanket",
				"",
			].join("\n"),
		);
	});

	it("moves a top-level task whose only shallower line is a plain bullet, not a task, treating it as having no parent to wait for", () => {
		// A plain bullet above at a shallower indent is not a task this feature
		// pairs, so the ticked line below it is not a subtask at all. If the
		// guard treated any shallower line as an enclosing task, this would stay
		// put instead of moving.
		const collection = [
			"## Tasks",
			"",
			"- Some context, not a task",
			"\t" + marked("- [x] Finish the errand", "errand-1"),
			"## Completed tasks",
			"",
		].join("\n");

		const result = completeInCollection(collection, "errand-1", layout());

		expect(result.moved).toBe(true);
		expect(result.collection).toBe(
			[
				"## Tasks",
				"",
				"- Some context, not a task",
				"## Completed tasks",
				"\t" + marked("- [x] Finish the errand", "errand-1"),
				"",
			].join("\n"),
		);
	});

	it("carries an unrecognised trailing fragment on the moved task untouched", () => {
		// A recurrence rule or a foreign comment is not one of the fields this
		// module ever reads; if a rebuild-from-parts crept in anywhere, this
		// fragment would be the first casualty.
		const collection = [
			"## Tasks",
			"",
			marked("- [x] Water the garden 🔁 every week", "recur-1"),
			"## Completed tasks",
			"",
		].join("\n");

		const result = completeInCollection(collection, "recur-1", layout());

		expect(result.moved).toBe(true);
		expect(result.collection).toBe(
			[
				"## Tasks",
				"",
				"## Completed tasks",
				marked("- [x] Water the garden 🔁 every week", "recur-1"),
				"",
			].join("\n"),
		);
	});
});

describe("completeLineInCollection", () => {
	it("moves a finished task that carries no pairing marker, with its subtree and the cascade, where the pairing-keyed call moves nothing", () => {
		// If the line call looked for a marker, it would find none and move
		// nothing, failing the `moved` and the text assertions below; if the
		// cascade were skipped, the open subtask would stay `[ ]`.
		const collection = [
			"## Tasks",
			"",
			"- [ ] Fix the gate",
			"- [x] Water the plants 🔁 every week ⏳ 2031-03-03",
			"\t- [ ] Fill the can",
			"\t- [x] Check the soil",
			"## Completed tasks",
			"",
			"- [x] Sweep the porch",
		].join("\n");

		const result = completeLineInCollection(collection, 3, layout());

		expect(result.moved).toBe(true);
		expect(result.collection).toBe(
			[
				"## Tasks",
				"",
				"- [ ] Fix the gate",
				"## Completed tasks",
				"",
				"- [x] Sweep the porch",
				"- [x] Water the plants 🔁 every week ⏳ 2031-03-03",
				"\t- [x] Fill the can",
				"\t- [x] Check the soil",
			].join("\n"),
		);

		const keyed = completeInCollection(collection, "no-such-pairing", layout());
		expect(keyed.moved).toBe(false);
		expect(keyed.collection).toBe(collection);
	});

	it("leaves a finished unmarked line where it is when the pairing-keyed call matches a different, marked line", () => {
		// An implementation that moved the first finished line under the tasks
		// heading whenever any pairing matched would move "Water the plants"
		// (the unmarked one) instead of, or as well as, the marked one.
		const collection = [
			"## Tasks",
			"",
			"- [x] Water the plants",
			marked("- [x] Rinse the jars", "jars-1"),
			marked("- [ ] Oil the hinge", "hinge-1"),
			"## Completed tasks",
			"",
		].join("\n");

		const keyed = completeInCollection(collection, "jars-1", layout());

		expect(keyed.moved).toBe(true);
		expect(keyed.collection).toBe(
			[
				"## Tasks",
				"",
				"- [x] Water the plants",
				marked("- [ ] Oil the hinge", "hinge-1"),
				"## Completed tasks",
				marked("- [x] Rinse the jars", "jars-1"),
				"",
			].join("\n"),
		);

		// The same call answering for an open marked line moves nothing, and
		// still leaves the finished unmarked line where it is.
		const open = completeInCollection(collection, "hinge-1", layout());
		expect(open.moved).toBe(false);
		expect(open.collection).toBe(collection);
	});

	it("leaves the text byte-identical for an open line, a line outside the tasks heading, and an index out of range", () => {
		// A call that moved without asking the line's own meaning would move
		// the open line and change the text.
		const collection = [
			"## Tasks",
			"",
			"- [ ] Water the plants 🔁 every week ⏳ 2031-03-03",
			"\t- [x] Check the soil",
			"## Completed tasks",
			"",
			"- [x] Sweep the porch",
		].join("\n");

		for (const index of [2, 4, 6, 99, -1]) {
			const result = completeLineInCollection(collection, index, layout());
			expect(result.moved).toBe(false);
			expect(result.collection).toBe(collection);
		}
	});
});

describe("the move on a note with Windows line endings", () => {
	// Both entries share one move, so each is driven on every shape. If the
	// move joined with a bare "\n", split off a "\r" onto the wrong line, or
	// left the moved line's "\r" at the end of a note that had no final break,
	// the exact strings below would not match.
	const entries: [string, (text: string) => string][] = [
		["completeInCollection", (text) => completeInCollection(text, "a-1", layout()).collection],
		["completeLineInCollection", (text) => completeLineInCollection(text, 1, layout()).collection],
	];

	for (const [name, run] of entries) {
		it(`${name} keeps \\r\\n on the moved line and the line it lands after, with no final line break`, () => {
			const input = ["## Tasks", marked("- [x] A", "a-1"), "## Completed tasks", "- [x] B"].join("\r\n");
			expect(run(input)).toBe(
				["## Tasks", "## Completed tasks", "- [x] B", marked("- [x] A", "a-1")].join("\r\n"),
			);
		});

		it(`${name} keeps \\r\\n through to the final line break`, () => {
			const input = ["## Tasks", marked("- [x] A", "a-1"), "## Completed tasks", "- [x] B", ""].join("\r\n");
			expect(run(input)).toBe(
				["## Tasks", "## Completed tasks", "- [x] B", marked("- [x] A", "a-1"), ""].join("\r\n"),
			);
		});

		it(`${name} writes a missing completed-tasks heading with \\r\\n, with no final line break`, () => {
			const input = ["## Tasks", marked("- [x] A", "a-1")].join("\r\n");
			expect(run(input)).toBe(
				["## Tasks", "", "## Completed tasks", "", marked("- [x] A", "a-1")].join("\r\n"),
			);
		});

		it(`${name} writes a missing completed-tasks heading with \\r\\n, ending in a line break`, () => {
			const input = ["## Tasks", marked("- [x] A", "a-1"), ""].join("\r\n");
			expect(run(input)).toBe(
				["## Tasks", "", "## Completed tasks", "", marked("- [x] A", "a-1"), ""].join("\r\n"),
			);
		});

		// A note whose lines end differently: every line the move does not
		// touch keeps its own ending, the moved line keeps its own, and a line
		// that had no ending (the note's last) takes the ending of the line
		// before it. Normalising the whole note to one ending would fail each.
		it(`${name} leaves untouched lines' own endings alone on a mixed note, with no final line break`, () => {
			const input =
				`## Tasks\r\n${marked("- [x] A", "a-1")}\n- [ ] C\r\n## Completed tasks\n- [x] B`;
			expect(run(input)).toBe(
				`## Tasks\r\n- [ ] C\r\n## Completed tasks\n- [x] B\n${marked("- [x] A", "a-1")}`,
			);
		});

		it(`${name} leaves untouched lines' own endings alone on a mixed note, ending in a line break`, () => {
			const input = `## Tasks\r\n${marked("- [x] A", "a-1")}\n- [ ] C\r\n## Completed tasks\n- [x] B\r\n`;
			expect(run(input)).toBe(
				`## Tasks\r\n- [ ] C\r\n## Completed tasks\n- [x] B\r\n${marked("- [x] A", "a-1")}\n`,
			);
		});

		it(`${name} gives the line it lands after the ending of the line before it, whichever ending that is`, () => {
			const input =
				`## Tasks\n${marked("- [x] A", "a-1")}\r\n- [ ] C\n## Completed tasks\r\n- [x] B`;
			expect(run(input)).toBe(
				`## Tasks\n- [ ] C\n## Completed tasks\r\n- [x] B\r\n${marked("- [x] A", "a-1")}`,
			);
		});

		it(`${name} writes a missing completed-tasks heading in the neighbouring line's ending on a mixed note`, () => {
			const input = `## Tasks\n${marked("- [x] A", "a-1")}\r\n- [ ] C`;
			expect(run(input)).toBe(`## Tasks\n- [ ] C\n\n## Completed tasks\n\n${marked("- [x] A", "a-1")}`);
		});
	}
});
