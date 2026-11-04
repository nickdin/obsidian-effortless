import { describe, expect, it } from "vitest";
import { defaultData } from "../core/settings";
import { editTaskField, parseTaskLine, type TaskLine } from "../core/taskLine";
import { dailyLogFrame } from "../core/vaultLayout";
import { copyIn } from "../features/taskConsistency/copyIn";
import { readMarker, snapshotOf } from "../features/taskConsistency/marker";
import { reconcilePair } from "../features/taskConsistency/reconcile";
import { rollOver } from "../features/taskConsistency/rollOver";

// Every collection, note and task below is invented: no real task, name or
// path from any vault.

/**
 * The composition `copyIn` then `reconcilePair` over its own output — where
 * #822, #825, #826, #830 and #832 all actually live, and where no test in
 * the repository went before this file (`CLAUDE.md`'s own board-run finding,
 * and the wave's repro, `.git/work-the-board/evidence/wave2-seam-806-807.test.ts`).
 * `taskConsistencyReconcile.test.ts` drives `reconcilePair` alone against
 * hand-built fixtures; this file drives it against a real `copyIn` result, so
 * a defect that only shows up in what `copyIn` actually writes — its marker's
 * exact shape, its breadcrumb, its own `/` mark — has somewhere to fail.
 */

const TODAY = new Date(2026, 8, 22, 9, 0, 0);

function layout() {
	return defaultData().core.layout;
}

/** Parses `raw`, failing the test rather than returning null. */
function parsed(raw: string): TaskLine {
	const task = parseTaskLine(raw);
	if (task === null) throw new Error(`expected a task line: ${JSON.stringify(raw)}`);
	return task;
}

/** The one line of `text` containing `needle`, failing the test rather than returning undefined. */
function lineContaining(text: string, needle: string): string {
	const found = text.split("\n").find((line) => line.includes(needle));
	if (found === undefined) throw new Error(`no line of ${JSON.stringify(text)} contains ${JSON.stringify(needle)}`);
	return found;
}

/** A freshly copied pair: the collection's own text, and the two lines `copyIn` produced from it. */
function freshPair(taskLine: string, collectionName = "Office"): { collectionLine: string; logLine: string } {
	const collectionText = `## ${layout().tasksHeading}\n${taskLine}\n`;
	const logText = dailyLogFrame(layout());
	const out = copyIn(collectionText, logText, TODAY, layout(), collectionName);

	return {
		collectionLine: lineContaining(out.collection, "Order the blue folders"),
		logLine: lineContaining(out.log, "Order the blue folders"),
	};
}

describe("seam: copyIn then reconcilePair", () => {
	it("a freshly copied pair reconciles as unchanged", () => {
		// Before the fix: the collection's `/` hashed apart from the log's
		// untouched ` `, so this read as "only the log changed" and the log's
		// open checkbox travelled back onto the collection — the `/` is gone.
		// A hash still sensitive to the copied mark would fail this.
		const { collectionLine, logLine } = freshPair("- [ ] Order the blue folders 📅 2026-09-22");
		const marker = readMarker(parsed(collectionLine));
		if (marker === null) throw new Error("expected the collection's own copy to carry a marker");

		const result = reconcilePair(collectionLine, logLine, { hash: marker.hash });
		expect(result).toEqual({ collection: null, log: null, clash: false });
	});

	it("a hand-typed [>] on the log side does not make the pairing read as changed, and freezes the line rather than accepting the collection's date", () => {
		// #832's first repro, driven through a real copy, updated for #809's own
		// answer to the question #806 flagged: before #832's own fix, the
		// forwarded meaning alone made the log's hash read as changed, so this
		// clashed forever over a date nobody disagreed about. #832 fixed the
		// hash; #809 goes further and freezes a forwarded target whole, so the
		// date no longer reaches it at all — a hash still sensitive to a
		// hand-typed `[>]` would report a clash here instead, and an unfrozen
		// target would carry the new date onto the forwarded line.
		const { collectionLine, logLine } = freshPair("- [ ] Order the blue folders 📅 2026-09-22");
		const marker = readMarker(parsed(collectionLine));
		if (marker === null) throw new Error("expected the collection's own copy to carry a marker");

		const collectionMoved = editTaskField(collectionLine, "scheduled", "2026-09-25");
		const logForwardedByHand = editTaskField(logLine, "checkbox", ">");
		const result = reconcilePair(collectionMoved, logForwardedByHand, { hash: marker.hash });

		expect(result).toEqual({ collection: null, log: null, clash: false });
	});

	it("words edited on one side, then a due date added on the other, ends as an ordinary update and never as a clash", () => {
		// The code review's own repro: before the fix, the description was part
		// of the hash, so the collection's word edit alone made both hashes
		// read as changed — with no field difference to resolve on the
		// collection's side, this clashed forever over a due date nobody
		// disagreed about.
		const { collectionLine, logLine } = freshPair("- [ ] Order the blue folders 📅 2026-09-22");
		const marker = readMarker(parsed(collectionLine));
		if (marker === null) throw new Error("expected the collection's own copy to carry a marker");

		const collectionWords = collectionLine.replace("Order the blue folders", "Order the green folders");
		const logWithDue = editTaskField(logLine, "due", "2026-09-25");

		const result = reconcilePair(collectionWords, logWithDue, { hash: marker.hash });

		expect(result.clash).toBe(false);
		expect(result.log).toBeNull();
		expect(result.collection).not.toBeNull();
		expect(parsed(result.collection as string).due).toBe("2026-09-25");
		// The collection's own word edit is never overwritten by a field edit.
		expect(result.collection).toContain("Order the green folders");
	});

	it("a tick on either side still travels, so the bookkeeping exclusions are narrow", () => {
		// Not a bug either fix touches — `done` was never excluded, before or
		// after — but the shape of the fix is "skip the checkbox when the
		// meaning is bookkeeping", and this is the case that would fail were
		// that exclusion ever widened by mistake to cover a real tick: the
		// collection's own copied mark (bookkeeping) must still yield to a
		// genuine done coming from the log.
		const { collectionLine, logLine } = freshPair("- [ ] Order the blue folders 📅 2026-09-22");
		const marker = readMarker(parsed(collectionLine));
		if (marker === null) throw new Error("expected the collection's own copy to carry a marker");

		const logTicked = editTaskField(logLine, "checkbox", "x");
		const result = reconcilePair(collectionLine, logTicked, { hash: marker.hash });

		expect(result.clash).toBe(false);
		expect(result.log).toBeNull();
		expect(result.collection).not.toBeNull();
		// A genuine tick still overrides the collection's own copied mark —
		// the narrow exclusion is for bookkeeping, never for a real done.
		expect(parsed(result.collection as string).meaning).toBe("done");
	});

	it("running the result back through with the returned lines answers neither changed, now that the markers advance by themselves", () => {
		const { collectionLine, logLine } = freshPair("- [ ] Order the blue folders 📅 2026-09-22");
		const marker = readMarker(parsed(collectionLine));
		if (marker === null) throw new Error("expected the collection's own copy to carry a marker");

		const collectionMoved = editTaskField(collectionLine, "scheduled", "2026-09-25");
		const first = reconcilePair(collectionMoved, logLine, { hash: marker.hash });
		expect(first.log).not.toBeNull();

		const advancedMarker = readMarker(parsed(first.log as string));
		if (advancedMarker === null) throw new Error("expected the returned log line to carry a marker");
		// The direct claim #825 makes: before the fix, nothing wrote the log's
		// marker at all, so it still carried the copy-time hash — this would
		// fail on the stale value rather than the one the edited line now
		// hashes to.
		expect(advancedMarker.hash).toBe(snapshotOf(parsed(first.log as string)).hash);

		const second = reconcilePair(collectionMoved, first.log as string, { hash: advancedMarker.hash });
		expect(second).toEqual({ collection: null, log: null, clash: false });
	});
});

describe("seam: copyIn then rollOver then reconcilePair", () => {
	it("a rolled-over line is frozen for good: a later collection change reaches today's copy, never yesterday's", () => {
		const yesterday = new Date(2026, 8, 21, 9, 0, 0);
		const collectionText = `## ${layout().tasksHeading}\n- [ ] Order the blue folders ⏳ 2026-09-21\n`;
		const copied = copyIn(collectionText, dailyLogFrame(layout()), yesterday, layout(), "Office");

		const rolled = rollOver(copied.log, dailyLogFrame(layout()), copied.collection, TODAY, layout(), "Office");
		expect(rolled.rolled).toBe(1);

		const frozenLine = lineContaining(rolled.oldLog, "Order the blue folders");
		const liveLine = lineContaining(rolled.todayLog, "Order the blue folders");
		const marker = readMarker(parsed(liveLine));
		if (marker === null) throw new Error("expected the rolled copy to carry a marker");

		// The collection's own priority changes after the roll-over. Not a
		// change to the task's *words* — words are never one of the five
		// travelling fields (`reconcile.ts`'s own module comment), so a
		// words-only edit would not even register as changed here; priority is
		// what actually exercises "a later collection-side change… edits
		// today's".
		const collectionLine = lineContaining(rolled.collection, "Order the blue folders");
		const collectionChanged = editTaskField(collectionLine, "priority", "high");

		// Were the frozen target not protected, this would return an edited
		// log carrying the new priority onto yesterday's own line.
		const againstFrozen = reconcilePair(collectionChanged, frozenLine, { hash: marker.hash });
		expect(againstFrozen).toEqual({ collection: null, log: null, clash: false });

		// The same change, against today's live copy, travels normally.
		const againstLive = reconcilePair(collectionChanged, liveLine, { hash: marker.hash });
		expect(againstLive.collection).toBeNull();
		expect(againstLive.log).not.toBeNull();
		expect(parsed(againstLive.log as string).priority).toBe("high");
	});
});
