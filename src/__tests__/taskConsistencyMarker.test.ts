import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTaskLine, type TaskLine } from "../core/taskLine";
import { newEid, readMarker, snapshotOf, writeMarker } from "../features/taskConsistency/marker";

// Every line below is invented: no real task, name or path from any vault.

/** Parses `raw`, failing the test rather than returning null. */
function parsed(raw: string): TaskLine {
	const task = parseTaskLine(raw);
	if (task === null) throw new Error(`expected a task line: ${JSON.stringify(raw)}`);
	return task;
}

describe("snapshotOf", () => {
	it("hashes the same five fields identically across two calls", () => {
		const line = parsed("- [ ] Buy stamps #errand ⏳ 2026-01-05 📅 2026-02-06 ⏫");
		expect(snapshotOf(line)).toEqual(snapshotOf(line));
	});

	it("hashes the same for a log line and a collection line differing only in the marker and the collection-name breadcrumb", () => {
		const collectionLine = parsed(
			"- [ ] Buy stamps #errand ⏳ 2026-01-05 %% task-consistency:abc123 11112222 %%",
		);
		const logLine = parsed(
			"- [ ] Buy stamps #errand ⏳ 2026-01-05 → [[Errands]] %% task-consistency:xyz789 33334444 %%",
		);
		// Were the marker or the breadcrumb not masked out, the two literal
		// strings differ and this would report two different hashes.
		expect(snapshotOf(collectionLine).hash).toBe(snapshotOf(logLine).hash);
	});

	it("changes the hash when any one of the five travelling fields changes on its own", () => {
		const base = parsed("- [ ] Buy stamps ⏳ 2026-01-05 📅 2026-02-06 ⏫ #errand");
		const baseHash = snapshotOf(base).hash;

		const rows: Array<[string, string]> = [
			["checkbox", "- [x] Buy stamps ⏳ 2026-01-05 📅 2026-02-06 ⏫ #errand"],
			["scheduled", "- [ ] Buy stamps ⏳ 2026-03-09 📅 2026-02-06 ⏫ #errand"],
			["due", "- [ ] Buy stamps ⏳ 2026-01-05 📅 2026-05-01 ⏫ #errand"],
			["priority", "- [ ] Buy stamps ⏳ 2026-01-05 📅 2026-02-06 ⏬ #errand"],
			["tags", "- [ ] Buy stamps ⏳ 2026-01-05 📅 2026-02-06 ⏫ #other"],
		];

		for (const [field, raw] of rows) {
			// Each row changes exactly one field from `base`; a hash equal to
			// `baseHash` here would mean that field was never actually hashed.
			expect([field, snapshotOf(parsed(raw)).hash]).not.toEqual([field, baseHash]);
		}
	});

	it("does not change the hash when only the description changes", () => {
		// Before the fix, `snapshotOf` hashed the masked description too, so a
		// pure word edit on either copy read as "changed" and, once #825 wired
		// `reconcilePair` to act on that reading, made a same-side word edit
		// permanently block the other side's real field edits from travelling.
		// A hash still sensitive to words here would fail this.
		const base = parsed("- [ ] Buy stamps ⏳ 2026-01-05 📅 2026-02-06 ⏫ #errand");
		const wordsChanged = parsed("- [ ] Buy the stamps at the post office ⏳ 2026-01-05 📅 2026-02-06 ⏫ #errand");
		expect(snapshotOf(wordsChanged).hash).toBe(snapshotOf(base).hash);
	});

	it("hashes each of the four copied fields through its parsed value, not through its own leftover text in the description", () => {
		// Each pair below parses to the same value for the named field — same
		// scheduled/due date under different stamp spacing, same priority level
		// with or without a presentation selector, the same tag set in a
		// different order (the canonical array already sorts tags). A hash that
		// read the field only through its own array entry would agree on every
		// row; before the fix, the field's own leftover text still sat inside
		// `description` and its formatting told the pair apart there instead.
		const rows: Array<[string, string, string]> = [
			["scheduled", "- [ ] Buy stamps ⏳2026-01-05", "- [ ] Buy stamps ⏳    2026-01-05"],
			["due", "- [ ] Buy stamps 📅2026-02-06", "- [ ] Buy stamps 📅    2026-02-06"],
			["priority", "- [ ] Buy stamps ⏫", "- [ ] Buy stamps ⏫️"],
			["tags", "- [ ] Buy stamps #errand #other", "- [ ] Buy stamps #other #errand"],
		];

		for (const [field, a, b] of rows) {
			expect([field, snapshotOf(parsed(a)).hash]).toEqual([field, snapshotOf(parsed(b)).hash]);
		}
	});

	it("hashes the same whether or not the line carries another feature's own bookkeeping comment", () => {
		// #15 G10: what is inside another feature's comment is that feature's
		// alone. Before the fix only this feature's own marker was masked out
		// of the description, so any other feature's comment still reached the
		// hash.
		const bare = parsed("- [ ] Buy stamps");
		const withOtherComment = parsed("- [ ] Buy stamps %% other-feature:1 %%");
		expect(snapshotOf(bare).hash).toBe(snapshotOf(withOtherComment).hash);
	});

	it("hashes the checkbox by the core's own meaning, with no second reading of the character here", () => {
		// #818: this rewrites a test that asserted the defect it now checks for
		// — the marker used to fold an upper-case X into "done" itself, a
		// second reading of the checkbox the core's own CHECKBOX_MEANINGS
		// (src/core/taskLine.ts:43-49) does not make; that map is not this
		// ticket's to change. CHECKBOX_MEANINGS keys only a lower-case "x", so
		// an upper-case X reads as "open" here exactly as parseTaskLine already
		// reads it, and a hash that read it any other way would fail below.
		const open = parsed("- [ ] Buy stamps");
		const doneLower = parsed("- [x] Buy stamps");
		const doneUpper = parsed("- [X] Buy stamps");
		const copied = parsed("- [/] Buy stamps");

		expect(doneUpper.meaning).toBe("open");
		expect(snapshotOf(doneUpper).hash).toBe(snapshotOf(open).hash);
		expect(snapshotOf(open).hash).not.toBe(snapshotOf(doneLower).hash);
		expect(snapshotOf(copied).hash).not.toBe(snapshotOf(doneLower).hash);
	});

	it("hashes a collection's own copied mark the same as an untouched open checkbox", () => {
		// This is #822's own criterion: a pairing that has just been copied,
		// and not touched since, must reconcile to "neither changed" — which
		// only holds if the collection's `/` and the log's untouched ` `
		// produce the same hash. Before the fix, `copied` was hashed as its own
		// literal meaning and this would fail.
		const open = parsed("- [ ] Buy stamps");
		const copied = parsed("- [/] Buy stamps");
		expect(snapshotOf(copied).hash).toBe(snapshotOf(open).hash);
	});

	it("hashes a hand-typed forwarded checkbox the same as an untouched open checkbox", () => {
		// The log side of #832's first repro: forwarding is this feature's own
		// bookkeeping, never a state that travels, so it must not make the log
		// read as changed on its own.
		const open = parsed("- [ ] Buy stamps");
		const forwarded = parsed("- [>] Buy stamps");
		expect(snapshotOf(forwarded).hash).toBe(snapshotOf(open).hash);
	});
});

describe("readMarker", () => {
	it("reads the eid and hash off a line that carries the marker", () => {
		const line = parsed("- [ ] Buy stamps %% task-consistency:abc123 11112222 %%");
		expect(readMarker(line)).toEqual({ eid: "abc123", hash: "11112222" });
	});

	it("reads null off a line that carries no marker of this feature's own", () => {
		expect(readMarker(parsed("- [ ] Buy stamps"))).toBeNull();
		expect(readMarker(parsed("- [ ] Buy stamps %% other-feature:xyz %%"))).toBeNull();
	});

	it("reads the first when two markers share this feature's id", () => {
		const line = parsed(
			"- [ ] Buy stamps %% task-consistency:first 11112222 %% %% task-consistency:second 33334444 %%",
		);
		expect(readMarker(line)).toEqual({ eid: "first", hash: "11112222" });
	});

	it("reads null off a marker whose inside does not parse", () => {
		// No space between the eid and a hash at all.
		expect(readMarker(parsed("- [ ] Buy stamps %% task-consistency:noSpaceHere %%"))).toBeNull();
		// A hash shorter, and longer, than the fixed eight hex characters.
		expect(readMarker(parsed("- [ ] Buy stamps %% task-consistency:abc123 aa %%"))).toBeNull();
		expect(
			readMarker(parsed("- [ ] Buy stamps %% task-consistency:abc123 aaaaaaaaaaaa %%")),
		).toBeNull();
	});
});

describe("writeMarker", () => {
	it("round-trips through readMarker, and the line is otherwise byte-identical", () => {
		const before = "- [ ] Buy stamps #errand ⏳ 2026-01-05";
		const after = writeMarker(before, "abc123", "11112222");

		expect(after).toBe("- [ ] Buy stamps #errand ⏳ 2026-01-05 %% task-consistency:abc123 11112222 %%");
		expect(readMarker(parsed(after))).toEqual({ eid: "abc123", hash: "11112222" });
	});

	it("replaces only the marker's own inside when one already exists", () => {
		const before = "- [ ] Buy stamps %% task-consistency:abc123 11112222 %% #errand";
		const after = writeMarker(before, "abc123", "99998888");
		expect(after).toBe("- [ ] Buy stamps %% task-consistency:abc123 99998888 %% #errand");
	});
});

describe("newEid", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("produces the old plugin's own shape: base-36 time, then four base-36 characters", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(2026, 8, 22, 9, 0, 0));

		const draws = [0, 0.5, 0.999, 0.25];
		let call = 0;
		vi.spyOn(Math, "random").mockImplementation(() => draws[call++ % draws.length] as number);

		const eid = newEid();
		const expectedTime = Date.now().toString(36);

		expect(eid.startsWith(expectedTime)).toBe(true);
		expect(eid.length).toBe(expectedTime.length + 4);
		// Deterministic from the stubbed draws above: floor(draw * 36) indexes
		// "0123456789abcdefghijklmnopqrstuvwxyz" at 0, 18, 35, 9.
		expect(eid.slice(expectedTime.length)).toBe("0iz9");
	});
});
