import { describe, expect, it } from "vitest";
import { editTaskField, parseTaskLine, type TaskLine } from "../core/taskLine";
import { readMarker, snapshotOf } from "../features/taskConsistency/marker";
import { reconcilePair } from "../features/taskConsistency/reconcile";

// Every line below is invented: no real task, name or path from any vault.

/** Parses `raw`, failing the test rather than returning null. */
function parsed(raw: string): TaskLine {
	const task = parseTaskLine(raw);
	if (task === null) throw new Error(`expected a task line: ${JSON.stringify(raw)}`);
	return task;
}

/** The five travelling fields, read the way `snapshotOf` and `fieldsAgree` compare them. */
function structuralFields(line: TaskLine) {
	return {
		meaning: line.meaning,
		scheduled: line.scheduled,
		due: line.due,
		priority: line.priority,
		tags: [...line.tags].sort(),
	};
}

describe("reconcilePair — the six named cases", () => {
	it("only the collection changed: the log follows it", () => {
		const collectionBase = "- [ ] Read report #work";
		const logBase = "- [ ] Read report #work → [[Work]]";
		const lastSynced = snapshotOf(parsed(collectionBase));

		const collectionAfter = "- [ ] Read report #work #urgent";
		const result = reconcilePair(collectionAfter, logBase, lastSynced);

		expect(result.clash).toBe(false);
		expect(result.collection).toBeNull();
		expect(result.log).not.toBeNull();
		expect(structuralFields(parsed(result.log as string))).toEqual(
			structuralFields(parsed(collectionAfter)),
		);
		// The log's own breadcrumb is not one of the five fields, and survives.
		expect(result.log).toContain("→ [[Work]]");
	});

	it("only the log changed: the collection follows it", () => {
		const collectionBase = "- [ ] Read report #work";
		const lastSynced = snapshotOf(parsed(collectionBase));

		const logAfter = "- [ ] Read report #work #urgent → [[Work]]";
		const result = reconcilePair(collectionBase, logAfter, lastSynced);

		expect(result.clash).toBe(false);
		expect(result.log).toBeNull();
		expect(result.collection).not.toBeNull();
		expect(structuralFields(parsed(result.collection as string))).toEqual(
			structuralFields(parsed(logAfter)),
		);
	});

	it("both changed and now agree: an ordinary update, no clash", () => {
		const collectionBase = "- [ ] Read report #work";
		const lastSynced = snapshotOf(parsed(collectionBase));

		const collectionAfter = "- [x] Read report #work";
		const logAfter = "- [x] Read report #work → [[Work]]";
		const result = reconcilePair(collectionAfter, logAfter, lastSynced);

		expect(result).toEqual({ collection: null, log: null, clash: false });
	});

	it("both changed and disagree: a clash, neither side is edited", () => {
		const collectionBase = "- [ ] Read report #work";
		const lastSynced = snapshotOf(parsed(collectionBase));

		const collectionAfter = "- [x] Read report #work";
		const logAfter = "- [-] Read report #work → [[Work]]";
		const result = reconcilePair(collectionAfter, logAfter, lastSynced);

		expect(result).toEqual({ collection: null, log: null, clash: true });
	});

	it("neither changed: nothing is edited", () => {
		const collectionBase = "- [ ] Read report #work";
		const logBase = "- [ ] Read report #work → [[Work]]";
		const lastSynced = snapshotOf(parsed(collectionBase));

		const result = reconcilePair(collectionBase, logBase, lastSynced);

		expect(result).toEqual({ collection: null, log: null, clash: false });
	});

	it("marker missing on one side: never paired, so the collection is the source", () => {
		const collectionFirstTime = "- [ ] Sweep floor #chore #urgent";
		const logFirstTime = "- [ ] Sweep floor #chore → [[Chores]]";

		const result = reconcilePair(collectionFirstTime, logFirstTime, null);

		expect(result.clash).toBe(false);
		expect(result.collection).toBeNull();
		expect(result.log).not.toBeNull();
		expect(structuralFields(parsed(result.log as string))).toEqual(
			structuralFields(parsed(collectionFirstTime)),
		);
	});
});

/** The character `editTaskField(raw, "checkbox", …)` writes for a meaning — the three this suite's own rows ever drive. */
const CHECKBOX_CHAR: Readonly<Record<"open" | "done" | "cancelled", string>> = {
	open: " ",
	done: "x",
	cancelled: "-",
};

/** `reconcilePair`'s own marker suffix, appended once at the very end of a marker-free line — #825. */
const OWN_MARKER = / %% task-consistency:[0-9a-z]+ [0-9a-f]{8} %%$/u;

/** `raw` with `reconcilePair`'s own appended marker, if any, removed — so a byte comparison is about the travelling field, not the bookkeeping #825 adds. */
function withoutOwnMarker(raw: string): string {
	return raw.replace(OWN_MARKER, "");
}

describe("reconcilePair — one field travels at a time, every other byte identical", () => {
	const base = "- [ ] Buy stamps #errand ⏳ 2026-01-05 📅 2026-02-06 ⏫";

	const rows: ReadonlyArray<{
		field: keyof ReturnType<typeof structuralFields>;
		collectionAfter: string;
		expected: (collection: TaskLine) => string;
	}> = [
		{
			field: "meaning",
			collectionAfter: "- [x] Buy stamps #errand ⏳ 2026-01-05 📅 2026-02-06 ⏫",
			expected: (collection) => editTaskField(base, "checkbox", CHECKBOX_CHAR[collection.meaning as "open" | "done" | "cancelled"]),
		},
		{
			field: "scheduled",
			collectionAfter: "- [ ] Buy stamps #errand ⏳ 2026-03-09 📅 2026-02-06 ⏫",
			expected: (collection) => editTaskField(base, "scheduled", collection.scheduled),
		},
		{
			field: "due",
			collectionAfter: "- [ ] Buy stamps #errand ⏳ 2026-01-05 📅 2026-05-01 ⏫",
			expected: (collection) => editTaskField(base, "due", collection.due),
		},
		{
			field: "priority",
			collectionAfter: "- [ ] Buy stamps #errand ⏳ 2026-01-05 📅 2026-02-06 ⏬",
			expected: (collection) => editTaskField(base, "priority", collection.priority),
		},
		{
			field: "tags",
			collectionAfter: "- [ ] Buy stamps #errand #other ⏳ 2026-01-05 📅 2026-02-06 ⏫",
			expected: (collection) => editTaskField(base, "tags", collection.tags),
		},
	];

	for (const { field, collectionAfter, expected } of rows) {
		it(`copies only ${field} to the log, every other byte identical`, () => {
			// #830: a table that compared the five structural fields, rather than
			// the bytes the criterion names, would still pass if `editTaskField`
			// rewrote spacing or another field's own formatting — this instead
			// builds the exact byte-for-byte expectation `applyFields` itself
			// should produce, by calling the same field editor with the same
			// arguments, and would fail on any stray rewrite.
			const lastSynced = snapshotOf(parsed(base));
			const result = reconcilePair(collectionAfter, base, lastSynced);

			expect(result.clash).toBe(false);
			expect(result.collection).toBeNull();
			expect(result.log).not.toBeNull();

			expect(withoutOwnMarker(result.log as string)).toBe(expected(parsed(collectionAfter)));
		});
	}
});

describe("reconcilePair — the checkbox's forwarded and copied exceptions", () => {
	it("a hand-typed [>] on the log side does not change the collection's checkbox", () => {
		const collectionLine = "- [ ] Buy stamps #errand ⏳ 2026-01-05";
		const logBase = "- [ ] Buy stamps #errand ⏳ 2026-01-05 → [[Errands]]";
		const lastSynced = snapshotOf(parsed(logBase));

		// The log line was forwarded by hand, and picked up a due date the same
		// way — only the due date is a field this ticket copies; the forwarded
		// meaning never is.
		const logForwarded =
			"- [>] Buy stamps #errand ⏳ 2026-01-05 📅 2026-02-10 → [[Errands]]";
		const result = reconcilePair(collectionLine, logForwarded, lastSynced);

		expect(result.clash).toBe(false);
		expect(result.log).toBeNull();
		expect(result.collection).not.toBeNull();

		const after = parsed(result.collection as string);
		// Were the exception missing, this would read "done"-adjacent nonsense or
		// throw; instead the collection's checkbox stays exactly what it was.
		expect(after.meaning).toBe("open");
		expect(after.due).toBe("2026-02-10");
	});

	it("a freshly copied collection's own [/] is not reverted when the log gets a field edit", () => {
		// The bug #822 reported: the collection's own copied mark is bookkeeping
		// this feature wrote, not a state a person or the log moved to, so a real
		// field edit travelling from the log must never carry a checkbox change
		// with it. Were the exclusion missing, `applyFields` would read the
		// collection's "/" as disagreeing with the log's " " and rewrite it back
		// to open — exactly the defect this reproduces.
		const collectionCopied = "- [/] Buy stamps #errand ⏳ 2026-01-05";
		const lastSynced = snapshotOf(parsed(collectionCopied));

		const logWithDue = "- [ ] Buy stamps #errand ⏳ 2026-01-05 📅 2026-02-10 → [[Errands]]";
		const result = reconcilePair(collectionCopied, logWithDue, lastSynced);

		expect(result.clash).toBe(false);
		expect(result.log).toBeNull();
		expect(result.collection).not.toBeNull();

		const after = parsed(result.collection as string);
		expect(after.meaning).toBe("copied");
		expect(after.due).toBe("2026-02-10");
	});

	it("a collection's [/] never travels onto the log when the collection gets a field edit", () => {
		// The mirror direction: the collection is the side that changed (its own
		// due date moved), and it is still marked copied. `applyFields` must not
		// read "copied" as the collection's new checkbox value and write a
		// literal "/" onto the log — the log has to stay an ordinary open task.
		const collectionCopied = "- [/] Buy stamps #errand ⏳ 2026-01-05";
		const lastSynced = snapshotOf(parsed(collectionCopied));

		const collectionWithDue = "- [/] Buy stamps #errand ⏳ 2026-01-05 📅 2026-02-10";
		const logBase = "- [ ] Buy stamps #errand ⏳ 2026-01-05 → [[Errands]]";
		const result = reconcilePair(collectionWithDue, logBase, lastSynced);

		expect(result.clash).toBe(false);
		expect(result.collection).toBeNull();
		expect(result.log).not.toBeNull();

		const after = parsed(result.log as string);
		expect(after.meaning).toBe("open");
		expect(after.due).toBe("2026-02-10");
	});

	it("a log forwarded by hand and otherwise unchanged, beside a collection field edit, reads as no change at all — the target is frozen (#809, supersedes #832's own reading)", () => {
		// #832 (before #809 existed) proved only that the forwarded mark itself
		// does not count as a change, and expected the collection's scheduled
		// edit to still reach the forwarded line. #809 answers the question
		// #806's own closing comment flagged — whether an already-forwarded
		// line should be protected from a collection-driven edit — with yes:
		// once a line reads [>] it is frozen whole, so this now reads as
		// nothing to do rather than as an edit that keeps the forwarded mark.
		const collectionBase = "- [ ] Buy stamps #errand ⏳ 2026-01-05";
		const logForwarded = "- [>] Buy stamps #errand ⏳ 2026-01-05 → [[Errands]]";
		const lastSynced = snapshotOf(parsed(collectionBase));

		const collectionAfter = "- [ ] Buy stamps #errand ⏳ 2026-03-09";
		const result = reconcilePair(collectionAfter, logForwarded, lastSynced);

		// Were the forwarded target not frozen, `result.log` would carry the
		// new date and this would fail on a non-null log.
		expect(result).toEqual({ collection: null, log: null, clash: false });
	});

	it("a collection whose words alone changed, beside a log field edit, answers only the log changed", () => {
		// #832's second repro: a pure word edit on the collection must not read
		// as a change, so it never blocks the log's real edit from travelling,
		// and never turns an ordinary update into a clash.
		const collectionBase = "- [ ] Buy stamps #errand ⏳ 2026-01-05";
		const lastSynced = snapshotOf(parsed(collectionBase));

		const collectionWords = "- [ ] Buy the stamps at the post office #errand ⏳ 2026-01-05";
		const logWithDue = "- [ ] Buy stamps #errand ⏳ 2026-01-05 📅 2026-02-10 → [[Errands]]";
		const result = reconcilePair(collectionWords, logWithDue, lastSynced);

		expect(result.clash).toBe(false);
		expect(result.log).toBeNull();
		expect(result.collection).not.toBeNull();

		const after = parsed(result.collection as string);
		expect(after.due).toBe("2026-02-10");
		// The collection's own words are never touched by a field edit.
		expect(after.description).toContain("Buy the stamps at the post office");
	});
});

describe("reconcilePair — everything the five fields do not own", () => {
	it("an unrecognised fragment on either side survives a field edit on that side", () => {
		const logLine =
			"- [ ] Water plants 🔁 every week ✅ 2026-01-10 %% other-feature:xyz %% #chore";
		const lastSynced = snapshotOf(parsed(logLine));

		const collectionAfter =
			"- [ ] Water plants 🔁 every week ✅ 2026-01-10 %% other-feature:xyz %% #chore #urgent";
		const result = reconcilePair(collectionAfter, logLine, lastSynced);

		expect(result.clash).toBe(false);
		expect(result.log).not.toBeNull();
		const log = result.log as string;
		expect(log).toContain("🔁 every week");
		expect(log).toContain("✅ 2026-01-10");
		expect(log).toContain("%% other-feature:xyz %%");
		expect(parsed(log).tags).toEqual(["#chore", "#urgent"]);
	});

	it("a log line re-indented and otherwise unchanged is unchanged", () => {
		const collectionLine = "- [ ] Feed cat #chore";
		const lastSynced = snapshotOf(parsed(collectionLine));

		const logIndented = "  - [ ] Feed cat #chore";
		const result = reconcilePair(collectionLine, logIndented, lastSynced);

		expect(result).toEqual({ collection: null, log: null, clash: false });
	});
});

describe("reconcilePair — the marker advances on the edited line", () => {
	it("advancing the log's own marker so its stored hash matches its new content", () => {
		// #825's own repro: before the fix, nothing in this module imported
		// `setComment`/`writeMarker`, so the returned log line carried whatever
		// marker it already had — here, none at all — and its hash never caught
		// up with the field `applyFields` just copied onto it.
		const collectionBase = "- [ ] Buy stamps #errand ⏳ 2026-01-05";
		const logBase = "- [ ] Buy stamps #errand ⏳ 2026-01-05 → [[Errands]]";
		const lastSynced = snapshotOf(parsed(collectionBase));

		const collectionAfter = "- [ ] Buy stamps #errand ⏳ 2026-01-05 📅 2026-02-10";
		const result = reconcilePair(collectionAfter, logBase, lastSynced);

		expect(result.log).not.toBeNull();
		const marker = readMarker(parsed(result.log as string));
		if (marker === null) throw new Error("expected the returned log line to carry a marker");
		expect(marker.hash).toBe(snapshotOf(parsed(result.log as string)).hash);
	});

	it("a line reconcilePair does not edit keeps whatever marker it already had", () => {
		const collectionBase = "- [ ] Buy stamps #errand ⏳ 2026-01-05";
		const logBase = "- [ ] Buy stamps #errand ⏳ 2026-01-05 → [[Errands]]";
		const lastSynced = snapshotOf(parsed(collectionBase));

		const collectionAfter = "- [ ] Buy stamps #errand ⏳ 2026-01-05 📅 2026-02-10";
		const result = reconcilePair(collectionAfter, logBase, lastSynced);

		// Only the log was edited; the collection is returned null and this
		// function never touches its text, marker included.
		expect(result.collection).toBeNull();
	});
});

describe("reconcilePair — idempotency", () => {
	it("running the result back through with the advanced snapshot answers neither changed", () => {
		const collectionBase = "- [ ] Read report #work";
		const logBase = "- [ ] Read report #work → [[Work]]";
		const lastSynced = snapshotOf(parsed(collectionBase));

		const collectionAfter = "- [ ] Read report #work #urgent";
		const first = reconcilePair(collectionAfter, logBase, lastSynced);
		expect(first.log).not.toBeNull();

		const advanced = snapshotOf(parsed(collectionAfter));
		const second = reconcilePair(collectionAfter, first.log as string, advanced);

		expect(second).toEqual({ collection: null, log: null, clash: false });
	});

	it("running the result back through with lastSynced read from the returned line's own marker answers neither changed", () => {
		// The same idempotency claim, but driven the way a real caller would:
		// reading `lastSynced` off the marker `reconcilePair` itself just wrote,
		// rather than recomputing it externally with `snapshotOf`.
		const collectionBase = "- [ ] Read report #work";
		const logBase = "- [ ] Read report #work → [[Work]]";
		const lastSynced = snapshotOf(parsed(collectionBase));

		const collectionAfter = "- [ ] Read report #work #urgent";
		const first = reconcilePair(collectionAfter, logBase, lastSynced);
		expect(first.log).not.toBeNull();

		const marker = readMarker(parsed(first.log as string));
		if (marker === null) throw new Error("expected the returned log line to carry a marker");

		const second = reconcilePair(collectionAfter, first.log as string, { hash: marker.hash });
		expect(second).toEqual({ collection: null, log: null, clash: false });
	});
});
