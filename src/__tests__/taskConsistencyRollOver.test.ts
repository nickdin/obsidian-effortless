import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { editTaskField, parseTaskLine } from "../core/taskLine";
import type { TaskLine } from "../core/taskLine";
import { dailyLogFrame } from "../core/vaultLayout";
import { copyIn } from "../features/taskConsistency/copyIn";
import { readMarker } from "../features/taskConsistency/marker";
import { reconcilePair } from "../features/taskConsistency/reconcile";
import { freeze, freezeIfRescheduled, rollOver } from "../features/taskConsistency/rollOver";

// Every collection, note and task below is invented: no real task, name or
// path from any vault.

// Nothing under test here reads the clock — `rollOver` takes `today` as an
// argument — but every date and time test in this feature pins it anyway,
// matching `taskConsistencyCopyIn.test.ts`'s own convention.
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(2026, 8, 22, 12, 0));
});
afterEach(() => vi.useRealTimers());

/** A local date, built from local parts rather than an ISO string (the #618/#687 rule). */
function day(y: number, m: number, d: number): Date {
	return new Date(y, m - 1, d);
}

function layout(overrides: Partial<VaultLayout> = {}): VaultLayout {
	return { ...defaultData().core.layout, ...overrides };
}

/** The fresh log a new day is created with — both new sections already blank. */
function freshLog(): string {
	return dailyLogFrame(layout());
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

/** `text` with the one line equal to `from` replaced by `to` — never a substring replace, since a marker's hash can recur elsewhere in the note. */
function replaceLine(text: string, from: string, to: string): string {
	return text
		.split("\n")
		.map((line) => (line === from ? to : line))
		.join("\n");
}

/** How many lines of `text` contain `needle`. */
function countLinesContaining(text: string, needle: string): number {
	return text.split("\n").filter((line) => line.includes(needle)).length;
}

describe("rollOver", () => {
	it("rolls an open paired task from yesterday's log into today's overdue heading, with the same eid, and freezes yesterday's line byte-for-byte", () => {
		const yesterday = day(2026, 9, 21);
		const today = day(2026, 9, 22);
		const collection = "## Tasks\n\n- [ ] Buy stamps #errand ⏳ 2026-09-21\n";
		const copied = copyIn(collection, freshLog(), yesterday, layout(), "Errands");

		const oldLine = lineContaining(copied.log, "Buy stamps");
		const oldMarker = readMarker(parsed(oldLine));
		if (oldMarker === null) throw new Error("expected yesterday's own copy to carry a marker");

		const result = rollOver(copied.log, freshLog(), copied.collection, today, layout(), "Errands");

		expect(result.rolled).toBe(1);
		// Roll-over moves the log's own copy; the collection is untouched.
		expect(result.collection).toBe(copied.collection);

		// Were the checkbox rewritten by rebuilding the line instead of editing
		// it in place, this would fail on a byte outside the brackets moving.
		const expectedOldLog = replaceLine(copied.log, oldLine, editTaskField(oldLine, "checkbox", ">"));
		expect(result.oldLog).toBe(expectedOldLog);
		expect(parsed(lineContaining(expectedOldLog, "Buy stamps")).meaning).toBe("forwarded");

		const newLine = lineContaining(result.todayLog, "Buy stamps");
		const newMarker = readMarker(parsed(newLine));
		if (newMarker === null) throw new Error("expected the rolled copy to carry a marker");
		// The same eid: the pairing continues rather than starting over.
		expect(newMarker.eid).toBe(oldMarker.eid);
		expect(parsed(newLine).meaning).toBe("open");

		const lines = result.todayLog.split("\n");
		const overdueIndex = lines.indexOf("## Overdue");
		const todayIndex = lines.indexOf("## Today");
		const newLineIndex = lines.findIndex((line) => line.includes("Buy stamps"));
		expect(newLineIndex).toBeGreaterThan(overdueIndex);
		expect(newLineIndex).toBeLessThan(todayIndex);
	});

	it("rebuilds indentation from the collection rather than from a log line re-indented inside its old day (D8)", () => {
		const yesterday = day(2026, 9, 21);
		const today = day(2026, 9, 22);
		const collection = "## Tasks\n\n- [ ] Buy stamps #errand ⏳ 2026-09-21\n";
		const copied = copyIn(collection, freshLog(), yesterday, layout(), "Errands");

		const oldLineOriginal = lineContaining(copied.log, "Buy stamps");
		// Re-indented one level inside the log — D8: this stays in the log and
		// never travels back to the collection.
		const reindentedOldLog = replaceLine(copied.log, oldLineOriginal, `\t${oldLineOriginal}`);

		const result = rollOver(reindentedOldLog, freshLog(), copied.collection, today, layout(), "Errands");

		expect(result.rolled).toBe(1);
		const newLine = lineContaining(result.todayLog, "Buy stamps");
		// The collection's own line carries no indentation. Were the rolled
		// copy built from the old log's line instead, this would carry the tab.
		expect(parsed(newLine).indent).toBe("");
	});

	it("rolls nothing over its own output", () => {
		const yesterday = day(2026, 9, 21);
		const today = day(2026, 9, 22);
		const collection = "## Tasks\n\n- [ ] Buy stamps #errand ⏳ 2026-09-21\n";
		const copied = copyIn(collection, freshLog(), yesterday, layout(), "Errands");

		const first = rollOver(copied.log, freshLog(), copied.collection, today, layout(), "Errands");
		expect(first.rolled).toBe(1);

		const second = rollOver(first.oldLog, first.todayLog, first.collection, today, layout(), "Errands");
		expect(second).toEqual({ oldLog: first.oldLog, todayLog: first.todayLog, collection: first.collection, rolled: 0 });
	});

	it("rolls a task due the last day of a month into the first day of the next (the #618/#687 local-date rule)", () => {
		const lastDayOfAugust = day(2026, 8, 31);
		const firstDayOfSeptember = day(2026, 9, 1);
		const collection = "## Tasks\n\n- [ ] Buy stamps #errand ⏳ 2026-08-31\n";
		const copied = copyIn(collection, freshLog(), lastDayOfAugust, layout(), "Errands");

		// A comparison that read the date as a string prefix, or that mishandled
		// the month rollover, would either skip this or throw building the key.
		const result = rollOver(copied.log, freshLog(), copied.collection, firstDayOfSeptember, layout(), "Errands");

		expect(result.rolled).toBe(1);
		expect(result.todayLog).toContain("Buy stamps");
	});

	it("drops a link Migration appended back to the day it was filed from, out of the rolled-over fresh copy too", () => {
		const today = day(2026, 9, 22);
		// The collection's line as Migration's filing and Task consistency's
		// pairing would leave it: the link back right before Migration's own
		// marker, which claims it, and Task consistency's own pairing
		// marker beside it.
		const collectionLine =
			"- [/] Buy stamps #errand ⏳ 2026-09-21 [[2026-09-20]] %% task-consistency:pair1 11112222 %% %% migration:mig1 deadbeef _ L %%";
		const collection = `## Tasks\n\n${collectionLine}\n`;
		const oldLog = `${freshLog()}\n- [ ] Buy stamps #errand ⏳ 2026-09-21 → [[Errands]] %% task-consistency:pair1 11112222 %%\n`;

		const result = rollOver(oldLog, freshLog(), collection, today, layout(), "Errands");

		expect(result.rolled).toBe(1);
		const freshCopy = lineContaining(result.todayLog, "Buy stamps");
		expect(freshCopy).not.toContain("[[2026-09-20]]");
		expect(freshCopy).toContain(" [[Errands]] %%");
		expect(freshCopy).not.toContain("→");
	});

	it("leaves a paired task alone when its collection line cannot be found — a broken pairing is not this function's to fix", () => {
		const today = day(2026, 9, 22);
		const oldLog = `${freshLog()}\n- [ ] Buy stamps #errand ⏳ 2026-09-21 %% task-consistency:orphan1 11112222 %%\n`;
		const collection = "## Tasks\n\n";

		const result = rollOver(oldLog, freshLog(), collection, today, layout(), "Errands");

		expect(result.rolled).toBe(0);
		expect(result.oldLog).toBe(oldLog);
		expect(result.todayLog).toBe(freshLog());
		expect(result.collection).toBe(collection);
	});

	it("freezes an old line whose collection date has moved to the future, without placing a copy under today's overdue heading", () => {
		// #837: roll and freeze on meaning alone (spec #709 decision 11 names no
		// date clause) — an unfinished paired line on an old day is always
		// frozen. Before the fix this line was skipped whole and stayed live
		// for good, so the next roll-over over the same old day rolled it again
		// once the date came back due, filing a duplicate.
		const yesterday = day(2026, 9, 21);
		const today = day(2026, 9, 22);
		const collection = "## Tasks\n\n- [ ] Buy stamps #errand ⏳ 2026-09-21\n";
		const copied = copyIn(collection, freshLog(), yesterday, layout(), "Errands");

		// The collection's own date moved out to next week — an ordinary field
		// edit, reconcilePair's job — before roll-over ever ran.
		const collectionLine = lineContaining(copied.collection, "Buy stamps");
		const collectionMoved = replaceLine(copied.collection, collectionLine, editTaskField(collectionLine, "scheduled", "2026-09-29"));

		const result = rollOver(copied.log, freshLog(), collectionMoved, today, layout(), "Errands");

		expect(result.rolled).toBe(1);
		expect(result.oldLog).not.toBe(copied.log);
		expect(parsed(lineContaining(result.oldLog, "Buy stamps")).meaning).toBe("forwarded");
		// The collection no longer calls it due today, so no fresh copy lands.
		expect(result.todayLog).toBe(freshLog());
	});

	it("a frozen, future-dated line is picked up by copyIn once its own date arrives", () => {
		const yesterday = day(2026, 9, 21);
		const today = day(2026, 9, 22);
		const dueDay = day(2026, 9, 29);
		const collection = "## Tasks\n\n- [ ] Buy stamps #errand ⏳ 2026-09-21\n";
		const copied = copyIn(collection, freshLog(), yesterday, layout(), "Errands");

		const collectionLine = lineContaining(copied.collection, "Buy stamps");
		const collectionMoved = replaceLine(copied.collection, collectionLine, editTaskField(collectionLine, "scheduled", "2026-09-29"));

		const rolled = rollOver(copied.log, freshLog(), collectionMoved, today, layout(), "Errands");
		expect(rolled.rolled).toBe(1);
		expect(rolled.todayLog).toBe(freshLog());

		// The day the collection's own date arrives, copyIn — never rollOver
		// again — is what brings it back (#809's own re-copy rule): the
		// pairing's marker is still on the collection, still `copied`, with no
		// live line anywhere in a log.
		const arrived = copyIn(rolled.collection, freshLog(), dueDay, layout(), "Errands");
		expect(arrived.copied).toBe(1);
		expect(arrived.log).toContain("Buy stamps");
	});

	it("does not roll a paired task whose old log line already reads done or cancelled", () => {
		const yesterday = day(2026, 9, 21);
		const today = day(2026, 9, 22);
		const collection = "## Tasks\n\n- [ ] Buy stamps #errand ⏳ 2026-09-21\n";
		const copied = copyIn(collection, freshLog(), yesterday, layout(), "Errands");

		const oldLine = lineContaining(copied.log, "Buy stamps");
		const oldLogTicked = replaceLine(copied.log, oldLine, editTaskField(oldLine, "checkbox", "x"));

		const result = rollOver(oldLogTicked, freshLog(), copied.collection, today, layout(), "Errands");

		expect(result.rolled).toBe(0);
		expect(result.oldLog).toBe(oldLogTicked);
	});

	it("does not roll a paired task whose collection line already reads done, even though the old log's own line is still open", () => {
		// #840: rollOver decided a candidate from the old log line's own
		// meaning alone and never read the collection line's — so a person
		// ticking the collection after the last run, before the old log caught
		// up, got a fresh open copy stamped with the *done* line's own hash.
		// Handed to reconcilePair, that reopened the collection's own task.
		const yesterday = day(2026, 9, 21);
		const today = day(2026, 9, 22);
		const collection = "## Tasks\n\n- [ ] Buy stamps #errand ⏳ 2026-09-21\n";
		const copied = copyIn(collection, freshLog(), yesterday, layout(), "Errands");

		const collectionLine = lineContaining(copied.collection, "Buy stamps");
		const collectionDone = replaceLine(copied.collection, collectionLine, editTaskField(collectionLine, "checkbox", "x"));

		const result = rollOver(copied.log, freshLog(), collectionDone, today, layout(), "Errands");

		expect(result.rolled).toBe(0);
		expect(result.oldLog).toBe(copied.log);
		expect(result.todayLog).toBe(freshLog());

		// The reopening this finding names: handing the fresh copy's marker to
		// reconcilePair against the done collection line must never read as
		// "the collection changed" and write `[ ]` back onto it.
		const oldLine = lineContaining(result.oldLog, "Buy stamps");
		const marker = readMarker(parsed(oldLine));
		if (marker === null) throw new Error("expected the old log's own line to still carry a marker");
		const collectionDoneLine = lineContaining(collectionDone, "Buy stamps");
		const reconciled = reconcilePair(collectionDoneLine, oldLine, { hash: marker.hash });
		expect(reconciled.collection).toBeNull();
	});

	it("does not duplicate a task copyIn already re-copied into today's log before rollOver runs", () => {
		// #835: rollOver never asked whether today's log already carried the
		// eid it was about to add — live from copyIn's own re-copy rule
		// — so on a day copyIn ran first, the task landed twice under overdue,
		// both lines sharing one eid.
		const yesterday = day(2026, 9, 21);
		const today = day(2026, 9, 22);
		const collection = "## Tasks\n\n- [ ] Buy stamps #errand ⏳ 2026-09-21\n";
		const copiedYesterday = copyIn(collection, freshLog(), yesterday, layout(), "Errands");

		const copiedToday = copyIn(copiedYesterday.collection, freshLog(), today, layout(), "Errands");
		expect(copiedToday.copied).toBe(1);

		const result = rollOver(copiedYesterday.log, copiedToday.log, copiedToday.collection, today, layout(), "Errands");

		expect(countLinesContaining(result.todayLog, "Buy stamps")).toBe(1);
		// The old day's own line is still frozen, even though no second copy
		// was placed — the pairing still moved forward, just with no
		// duplicate copy to carry it.
		expect(parsed(lineContaining(result.oldLog, "Buy stamps")).meaning).toBe("forwarded");
	});

	it("copyIn does not duplicate a task rollOver already carried into today's log (#835, the other order)", () => {
		const yesterday = day(2026, 9, 21);
		const today = day(2026, 9, 22);
		const collection = "## Tasks\n\n- [ ] Buy stamps #errand ⏳ 2026-09-21\n";
		const copiedYesterday = copyIn(collection, freshLog(), yesterday, layout(), "Errands");

		const rolled = rollOver(copiedYesterday.log, freshLog(), copiedYesterday.collection, today, layout(), "Errands");
		expect(rolled.rolled).toBe(1);

		const result = copyIn(rolled.collection, rolled.todayLog, today, layout(), "Errands");

		expect(result.copied).toBe(0);
		expect(countLinesContaining(result.log, "Buy stamps")).toBe(1);
	});

	it("changing a task's due date on the log side moves the date to the collection and freezes today's line — D9 shares D5's own freeze", () => {
		const today = day(2026, 9, 22);
		const collection = "## Tasks\n\n- [ ] Buy stamps #errand 📅 2026-09-22\n";
		const copied = copyIn(collection, freshLog(), today, layout(), "Errands");

		const logLine = lineContaining(copied.log, "Buy stamps");
		const collectionLine = lineContaining(copied.collection, "Buy stamps");
		const marker = readMarker(parsed(collectionLine));
		if (marker === null) throw new Error("expected the collection's own copy to carry a marker");

		// The person reschedules directly on the log's own line.
		const logRescheduled = editTaskField(logLine, "due", "2026-09-25");
		const reconciled = reconcilePair(collectionLine, logRescheduled, { hash: marker.hash });

		expect(reconciled.clash).toBe(false);
		expect(reconciled.log).toBeNull();
		expect(reconciled.collection).not.toBeNull();
		expect(parsed(reconciled.collection as string).due).toBe("2026-09-25");

		// D9: today's own line is then frozen rather than deleted — the same
		// `freeze` roll-over uses for D5, so there is one rule to learn.
		const frozen = freeze(logRescheduled);
		const after = parsed(frozen);
		expect(after.meaning).toBe("forwarded");
		// Were `freeze` rebuilding the line instead of editing the checkbox in
		// place, the just-typed due date would not survive.
		expect(after.due).toBe("2026-09-25");
	});

	it("D9's own detector freezes today's line when reconcilePair moved the scheduled or due date to the collection", () => {
		// #809's criterion 3 named code, not an argument: both reviews of wave 3
		// found the only test meeting "sets today's log line to [>]" called
		// `freeze` by hand after `reconcilePair`, with nothing deciding to
		// freeze. `freezeIfRescheduled` is that decision, so #810 does not have
		// to compare fields itself.
		const today = day(2026, 9, 22);
		const collection = "## Tasks\n\n- [ ] Buy stamps #errand 📅 2026-09-22\n";
		const copied = copyIn(collection, freshLog(), today, layout(), "Errands");

		const logLine = lineContaining(copied.log, "Buy stamps");
		const collectionLine = lineContaining(copied.collection, "Buy stamps");
		const marker = readMarker(parsed(collectionLine));
		if (marker === null) throw new Error("expected the collection's own copy to carry a marker");

		const logRescheduled = editTaskField(logLine, "due", "2026-09-25");
		const frozen = freezeIfRescheduled(collectionLine, logRescheduled, { hash: marker.hash });

		if (frozen === null) throw new Error("expected the reschedule to be recognised and frozen");
		const after = parsed(frozen);
		expect(after.meaning).toBe("forwarded");
		expect(after.due).toBe("2026-09-25");
	});

	it("D9's own detector freezes nothing when the log side changed a field other than the date", () => {
		const today = day(2026, 9, 22);
		const collection = "## Tasks\n\n- [ ] Buy stamps #errand 📅 2026-09-22\n";
		const copied = copyIn(collection, freshLog(), today, layout(), "Errands");

		const logLine = lineContaining(copied.log, "Buy stamps");
		const collectionLine = lineContaining(copied.collection, "Buy stamps");
		const marker = readMarker(parsed(collectionLine));
		if (marker === null) throw new Error("expected the collection's own copy to carry a marker");

		// Were this any field-changed check rather than the date specifically,
		// this would freeze too — #810 needs the narrower answer, since an
		// ordinary priority edit from the log is not a reschedule.
		const logPriority = editTaskField(logLine, "priority", "high");
		expect(freezeIfRescheduled(collectionLine, logPriority, { hash: marker.hash })).toBeNull();
	});

	it("rolls a due subtask on its own account, indented under its own still-live parent, with no context bullet substituted for either", () => {
		// The existing D8 test (`:98-116`, above) uses a root-level task, which
		// passes whether or not a rolled *subtask* keeps a stray indent
		// — this drives a genuine parent-and-child pair, both live.
		const yesterday = day(2026, 9, 21);
		const today = day(2026, 9, 22);
		const collection = "## Tasks\n\n- [ ] Pack for the trip ⏳ 2026-09-21\n\t- [ ] Buy stamps ⏳ 2026-09-21\n";
		const copied = copyIn(collection, freshLog(), yesterday, layout(), "Errands");
		expect(copied.copied).toBe(2);

		const result = rollOver(copied.log, freshLog(), copied.collection, today, layout(), "Errands");

		expect(result.rolled).toBe(2);
		const lines = result.todayLog.split("\n");
		const parentIndex = lines.findIndex((line) => line.includes("Pack for the trip"));
		const childIndex = lines.findIndex((line) => line.includes("Buy stamps"));
		expect(parentIndex).toBeGreaterThan(-1);
		expect(childIndex).toBe(parentIndex + 1);
		// Both are real task lines, each carrying its own marker — no context
		// bullet substituted for either.
		expect(parseTaskLine(lines[parentIndex])).not.toBeNull();
		expect(parseTaskLine(lines[childIndex])).not.toBeNull();
		expect(readMarker(parsed(lines[childIndex]))).not.toBeNull();
	});

	it("a rolled subtask whose parent is not itself live gets the context bullet copyIn's own first copy writes", () => {
		// #842: before the fix, a rolled subtask kept its collection
		// indentation verbatim with no parent line above it — a tab or
		// four-space indent directly under a heading reads as an indented code
		// block in CommonMark, so Obsidian drew the checkbox as plain text, not
		// a task.
		const yesterday = day(2026, 9, 21);
		const today = day(2026, 9, 22);
		const collection = "## Tasks\n\n- [ ] Pack for the trip ⏳ 2026-10-01\n\t- [ ] Buy stamps ⏳ 2026-09-21\n";
		const copied = copyIn(collection, freshLog(), yesterday, layout(), "Errands");
		// The parent is not due yet, so only the child copied — under a context
		// bullet carrying the parent's own words.
		expect(copied.copied).toBe(1);

		const result = rollOver(copied.log, freshLog(), copied.collection, today, layout(), "Errands");

		expect(result.rolled).toBe(1);
		const lines = result.todayLog.split("\n");
		const bulletIndex = lines.findIndex((line) => line.includes("Pack for the trip"));
		const childIndex = lines.findIndex((line) => line.includes("Buy stamps"));
		expect(bulletIndex).toBeGreaterThan(-1);
		// Before the fix, the rolled child was the first line under the
		// overdue heading, indented — this asserts a bullet precedes it and
		// the child nests directly beneath, the shape copyIn's own first copy
		// already writes.
		expect(childIndex).toBe(bulletIndex + 1);
		// The bullet carries no checkbox — it is not itself a task.
		expect(lines[bulletIndex]).not.toMatch(/^\s*- \[/);
		expect(lines[bulletIndex]).toContain("Pack for the trip");
	});
});
