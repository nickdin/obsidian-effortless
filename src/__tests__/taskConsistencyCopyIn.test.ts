import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { editTaskField, parseTaskLine } from "../core/taskLine";
import type { TaskLine } from "../core/taskLine";
import { dailyLogFrame } from "../core/vaultLayout";
import { copyIn } from "../features/taskConsistency/copyIn";
import { readMarker } from "../features/taskConsistency/marker";
import { reconcilePair } from "../features/taskConsistency/reconcile";
import { freeze } from "../features/taskConsistency/rollOver";

// Every collection, note and task below is invented: no real task, name or
// path from any vault.

// Nothing under test here reads the clock — `copyIn` takes `today` as an
// argument — but every date and time test in this feature pins it anyway, so
// a later change that does read the clock cannot slip through unnoticed (the
// convention `daysAheadRunWindow.test.ts` sets).
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(2026, 8, 22, 12, 0));
});
afterEach(() => vi.useRealTimers());

/** A local date, built from local parts rather than an ISO string (the #618/#687 rule). */
function day(y: number, m: number, d: number): Date {
	return new Date(y, m - 1, d);
}

const TODAY = day(2026, 9, 22);

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

/** How many lines of `text` contain `needle`. */
function countLinesContaining(text: string, needle: string): number {
	return text.split("\n").filter((line) => line.includes(needle)).length;
}

/** `text` with the one line equal to `from` replaced by `to` — never a substring replace, since a marker's hash can recur elsewhere in the note. */
function replaceLine(text: string, from: string, to: string): string {
	return text
		.split("\n")
		.map((line) => (line === from ? to : line))
		.join("\n");
}

/** The non-blank lines strictly between `startHeading` and `endHeading`, in order. */
function linesBetween(text: string, startHeading: string, endHeading: string): string[] {
	const lines = text.split("\n");
	const start = lines.indexOf(startHeading);
	const end = lines.indexOf(endHeading);
	if (start === -1 || end === -1) throw new Error(`expected both ${JSON.stringify(startHeading)} and ${JSON.stringify(endHeading)} in ${JSON.stringify(text)}`);
	return lines.slice(start + 1, end).filter((line) => line !== "");
}

describe("copyIn", () => {
	it("copies a due-today task with no subtasks under the today heading, marks the collection copy /, and shares one eid", () => {
		const collection = "# Errands\n\n## Tasks\n\n- [ ] Buy stamps #errand ⏳ 2026-09-22\n";
		const result = copyIn(collection, freshLog(), TODAY, layout(), "Errands");

		expect(result.copied).toBe(1);

		const collectionLine = lineContaining(result.collection, "Buy stamps");
		const logLine = lineContaining(result.log, "Buy stamps");

		const collectionMarker = readMarker(parsed(collectionLine));
		const logMarker = readMarker(parsed(logLine));
		if (collectionMarker === null || logMarker === null) throw new Error("expected both copies to carry a marker");

		// Both texts, asserted exactly rather than by substring: a checkbox left
		// open, a breadcrumb in the wrong place, or a second eid would all fail
		// one of these two lines.
		expect(collectionLine).toBe(
			`- [/] Buy stamps #errand ⏳ 2026-09-22 %% task-consistency:${collectionMarker.eid} ${collectionMarker.hash} %%`,
		);
		expect(logLine).toBe(
			`- [ ] Buy stamps #errand ⏳ 2026-09-22 [[Errands]] %% task-consistency:${logMarker.eid} ${logMarker.hash} %%`,
		);
		expect(logMarker.eid).toBe(collectionMarker.eid);

		// Under the today heading, not the overdue one.
		const todayIndex = result.log.split("\n").indexOf("## Today");
		const overdueIndex = result.log.split("\n").indexOf("## Overdue");
		const copiedIndex = result.log.split("\n").findIndex((line) => line.includes("Buy stamps"));
		expect(copiedIndex).toBeGreaterThan(todayIndex);
		expect(copiedIndex).toBeLessThan(result.log.split("\n").findIndex((line) => line === "## Calendar"));
		expect(overdueIndex).toBeLessThan(todayIndex);
	});

	it("drops Migration's own link back when copying a filed task, keeping a person's own link on the same line", () => {
		// A collection line Migration filed carries its own link back right before its
		// marker, appended after the task's own words — here, a link the person typed.
		// The marker's own fourth word, `L`, is what claims the link is Migration's
		// own; every filing from #906 on writes it.
		const collection =
			"# Errands\n\n## Tasks\n\n- [ ] Buy stamps #errand ⏳ 2026-09-22 [[Some Day]] [[2026-09-20]] %% migration:mig123 deadbeef _ L %%\n";
		const result = copyIn(collection, freshLog(), TODAY, layout(), "Errands");

		expect(result.copied).toBe(1);
		const logLine = lineContaining(result.log, "Buy stamps");
		// Were the link back not recognised and dropped, or were the person's own
		// link dropped along with it, either assertion below would fail.
		expect(logLine).not.toContain("[[2026-09-20]]");
		expect(logLine).toContain("[[Some Day]]");
		expect(logLine).toContain(" [[Errands]] %%");
		expect(logLine).not.toContain("→");
		// The collection's own copy, only marked /, keeps the link back untouched.
		expect(lineContaining(result.collection, "Buy stamps")).toContain("[[2026-09-20]]");
	});

	it("keeps a person's own trailing link when the collection line's marker claims no link back — a task filed before #906's flag existed", () => {
		// Position alone used to be enough to eat this: the person's own link
		// sits exactly where Migration's link back would. The marker's own
		// three-word shape (no fourth, `L`, word) says it never appended one.
		const collection =
			"# Errands\n\n## Tasks\n\n- [ ] Buy stamps #errand ⏳ 2026-09-22 [[Some Day]] %% migration:mig123 deadbeef _ %%\n";
		const result = copyIn(collection, freshLog(), TODAY, layout(), "Errands");

		expect(result.copied).toBe(1);
		expect(lineContaining(result.log, "Buy stamps")).toContain("[[Some Day]]");
	});

	it("keeps a person's own trailing link when the collection line already carries Task consistency's own marker, which never claims a link — a re-copy under an existing eid", () => {
		const collection =
			"# Errands\n\n## Tasks\n\n- [ ] Buy stamps #errand ⏳ 2026-09-22 [[Some Day]] %% task-consistency:existingeid 11112222 %%\n";
		const result = copyIn(collection, freshLog(), TODAY, layout(), "Errands");

		expect(result.copied).toBe(1);
		expect(lineContaining(result.log, "Buy stamps")).toContain("[[Some Day]]");
	});

	it("keeps an embed intact, `!` included, when the marker that follows claims no link", () => {
		const collection =
			"# Errands\n\n## Tasks\n\n- [ ] Buy stamps #errand ⏳ 2026-09-22 ![[pic.png]] %% migration:mig123 deadbeef _ %%\n";
		const result = copyIn(collection, freshLog(), TODAY, layout(), "Errands");

		expect(result.copied).toBe(1);
		expect(lineContaining(result.log, "Buy stamps")).toContain("![[pic.png]]");
	});

	it("still drops Migration's own link back once a field Task consistency synced sits between the link and the marker that claims it", () => {
		// `applyFields` (`reconcile.ts`) inserts a synced field — a tag here — at
		// the same insertion point every added field uses: after the link back,
		// before the trailing marker. The marker's own flag is what keeps the
		// link found even then.
		const filedLine = "- [ ] Buy stamps ⏳ 2026-09-22 [[2026-09-20]] %% migration:mig123 deadbeef _ L %%";
		const synced = editTaskField(filedLine, "tags", ["#urgent"]);
		expect(synced).toContain("[[2026-09-20]] #urgent %% migration:");

		const collection = `# Errands\n\n## Tasks\n\n${synced}\n`;
		const result = copyIn(collection, freshLog(), TODAY, layout(), "Errands");

		expect(result.copied).toBe(1);
		const logLine = lineContaining(result.log, "Buy stamps");
		expect(logLine).not.toContain("[[2026-09-20]]");
		expect(logLine).toContain("#urgent");
	});

	it("lands an overdue task under the overdue heading", () => {
		const collection = "## Tasks\n\n- [ ] Pay the invoice ⏳ 2026-09-10\n";
		const result = copyIn(collection, freshLog(), TODAY, layout(), "Bills");

		expect(result.copied).toBe(1);
		expect(result.collection).toContain("[/] Pay the invoice");

		const lines = result.log.split("\n");
		const overdueIndex = lines.indexOf("## Overdue");
		const todayIndex = lines.indexOf("## Today");
		const copiedIndex = lines.findIndex((line) => line.includes("Pay the invoice"));
		// A wrong placement rule (today instead of overdue, or the reverse)
		// would still copy the task somewhere; only the position says which
		// heading it actually landed under.
		expect(copiedIndex).toBeGreaterThan(overdueIndex);
		expect(copiedIndex).toBeLessThan(todayIndex);
	});

	it("copies a due subtask under a due parent, both copied and the subtask's indentation carried through", () => {
		const collection = ["## Tasks", "", "- [ ] Plan the move ⏳ 2026-09-22", "\t- [ ] Book the van ⏳ 2026-09-22", ""].join(
			"\n",
		);
		const result = copyIn(collection, freshLog(), TODAY, layout(), "Move");

		expect(result.copied).toBe(2);
		expect(result.collection).toContain("[/] Plan the move");
		expect(result.collection).toContain("[/] Book the van");

		const logLines = result.log.split("\n");
		const parentIndex = logLines.findIndex((line) => line.includes("Plan the move"));
		const childIndex = logLines.findIndex((line) => line.includes("Book the van"));
		// The child follows its parent and starts one tab deeper — a copy that
		// dropped the nesting would still copy both lines, so only the relative
		// position and the leading whitespace tell the two apart.
		expect(childIndex).toBe(parentIndex + 1);
		expect(logLines[childIndex].startsWith("\t")).toBe(true);
		expect(logLines[parentIndex].startsWith("\t")).toBe(false);
	});

	it("copies a due-today parent and its overdue subtask together, under the parent's own section, not as a second bullet elsewhere", () => {
		const collection = ["## Tasks", "", "- [ ] Plan the move ⏳ 2026-09-22", "\t- [ ] Book the van ⏳ 2026-09-10", ""].join(
			"\n",
		);
		const result = copyIn(collection, freshLog(), TODAY, layout(), "Move");

		expect(result.copied).toBe(2);

		// The parent's words appear exactly once — a copy that also drew a
		// context bullet for it under Overdue would leave a second line
		// containing them.
		expect(countLinesContaining(result.log, "Plan the move")).toBe(1);

		const logLines = result.log.split("\n");
		const parentIndex = logLines.findIndex((line) => line.includes("Plan the move"));
		const childIndex = logLines.findIndex((line) => line.includes("Book the van"));
		// The child sits directly under the parent's own copy, not under a
		// separate bullet in another section.
		expect(childIndex).toBe(parentIndex + 1);
		expect(logLines[childIndex].startsWith("\t")).toBe(true);
		expect(parseTaskLine(logLines[parentIndex])).not.toBeNull();

		const todayIndex = logLines.indexOf("## Today");
		const overdueIndex = logLines.indexOf("## Overdue");
		expect(parentIndex).toBeGreaterThan(todayIndex);
		// Nothing of this family reaches Overdue at all — a leftover context
		// bullet there would show up here.
		expect(linesBetween(result.log, "## Overdue", "## Today")).toEqual([]);
		expect(overdueIndex).toBeLessThan(todayIndex);
	});

	it("copies an overdue parent and its due-today subtask together, under the parent's own section (#833, dates reversed)", () => {
		const collection = ["## Tasks", "", "- [ ] Plan the move ⏳ 2026-09-10", "\t- [ ] Book the van ⏳ 2026-09-22", ""].join(
			"\n",
		);
		const result = copyIn(collection, freshLog(), TODAY, layout(), "Move");

		expect(result.copied).toBe(2);
		expect(countLinesContaining(result.log, "Plan the move")).toBe(1);

		const logLines = result.log.split("\n");
		const parentIndex = logLines.findIndex((line) => line.includes("Plan the move"));
		const childIndex = logLines.findIndex((line) => line.includes("Book the van"));
		expect(childIndex).toBe(parentIndex + 1);
		expect(logLines[childIndex].startsWith("\t")).toBe(true);

		const overdueIndex = logLines.indexOf("## Overdue");
		const todayIndex = logLines.indexOf("## Today");
		expect(parentIndex).toBeGreaterThan(overdueIndex);
		expect(parentIndex).toBeLessThan(todayIndex);
		expect(linesBetween(result.log, "## Today", "## Calendar")).toEqual([]);
	});

	it("gives a due subtask of a not-due parent one plain context bullet, carrying the parent's own words", () => {
		const collection = [
			"## Tasks",
			"",
			"- [ ] Plan the holiday 📅 2026-12-01",
			"\t- [ ] Book the flights ⏳ 2026-09-22",
			"",
		].join("\n");
		const result = copyIn(collection, freshLog(), TODAY, layout(), "Errands");

		expect(result.copied).toBe(1);
		// The parent is not due and carries no marker: it never becomes a
		// candidate, and its own collection line is left exactly as written —
		// only the due child's line picks up `/` and the marker.
		expect(result.collection).toContain("- [ ] Plan the holiday 📅 2026-12-01\n");
		expect(result.collection).toContain("[/] Book the flights");

		const logLines = result.log.split("\n");
		const bulletIndex = logLines.findIndex((line) => line.includes("Plan the holiday"));
		const childIndex = logLines.findIndex((line) => line.includes("Book the flights"));
		expect(bulletIndex).toBeGreaterThan(-1);
		// A plain bullet: no checkbox brackets, so parsing it as a task line
		// fails — the one property that tells it apart from a copied task.
		expect(parseTaskLine(logLines[bulletIndex])).toBeNull();
		expect(logLines[bulletIndex]).toBe("- Plan the holiday 📅 2026-12-01");
		expect(childIndex).toBe(bulletIndex + 1);
	});

	it("shares one context bullet among three due children of one not-due parent", () => {
		const collection = [
			"## Tasks",
			"",
			"- [ ] Plan the conference 📅 2026-12-01",
			"\t- [ ] Book the venue ⏳ 2026-09-22",
			"\t- [ ] Book the caterer ⏳ 2026-09-22",
			"\t- [ ] Send the invites ⏳ 2026-09-22",
			"",
		].join("\n");
		const result = copyIn(collection, freshLog(), TODAY, layout(), "Work");

		expect(result.copied).toBe(3);
		expect(countLinesContaining(result.log, "Plan the conference")).toBe(1);
		expect(result.log).toContain("Book the venue");
		expect(result.log).toContain("Book the caterer");
		expect(result.log).toContain("Send the invites");
	});

	it("gives a not-due parent's context bullet no marker and no checkbox, even when the parent itself already carries one", () => {
		const collection = [
			"## Tasks",
			"",
			"- [/] Plan the holiday 📅 2026-12-01 %% task-consistency:abc123 11112222 %%",
			"\t- [ ] Book the flights ⏳ 2026-09-22",
			"",
		].join("\n");
		const result = copyIn(collection, freshLog(), TODAY, layout(), "Errands");

		expect(result.copied).toBe(1);

		const logLines = result.log.split("\n");
		const bulletIndex = logLines.findIndex((line) => line.includes("Plan the holiday"));
		// The exact text: the parent's words, and nothing this feature — or any
		// other — wrote as a comment onto its own line.
		expect(logLines[bulletIndex]).toBe("- Plan the holiday 📅 2026-12-01");
		expect(parseTaskLine(logLines[bulletIndex])).toBeNull();
	});

	it("does not copy a task dated tomorrow", () => {
		const collection = ["## Tasks", "", "- [ ] Future errand ⏳ 2026-09-23", ""].join("\n");
		const result = copyIn(collection, freshLog(), TODAY, layout(), "Errands");

		// A wrong "today or earlier" comparison (using >= instead of >, say)
		// would copy this and report 1, not 0.
		expect(result.copied).toBe(0);
		expect(result.collection).toBe(collection);
		expect(result.log).toBe(freshLog());
	});

	it("does not copy a task that already carries a marker and is still live in today's log", () => {
		const collection = [
			"## Tasks",
			"",
			"- [ ] Already paired ⏳ 2026-09-22 %% task-consistency:abc123 11112222 %%",
			"",
		].join("\n");
		const log = [
			"## Overdue",
			"",
			"## Today",
			"- [ ] Already paired ⏳ 2026-09-22 → [[Errands]] %% task-consistency:abc123 11112222 %%",
			"",
		].join("\n");
		const result = copyIn(collection, log, TODAY, layout(), "Errands");

		expect(result.copied).toBe(0);
		expect(result.collection).toBe(collection);
		expect(result.log).toBe(log);
	});

	it("re-copies a paired task reading open, not only one reading copied, when its log line is missing", () => {
		// #809 already proved this for a `[/]` (copied) collection line, the
		// state copyIn's own first copy always leaves. #843 found the same rule
		// was never applied to one reading `[ ]` (open) — a state the code
		// itself can produce (#840: reconcilePair carries a genuine tick back
		// through an open target) and a person can produce just as easily by
		// unticking a `[/]` that looks wrong. Both must come back the same way,
		// by the same rule: missing from the log, dated today or earlier.
		//
		// The pre-#843 fixture here (`taskConsistencyCopyIn.test.ts:271-285`
		// before this ticket) asserted the opposite — `copied: 0` — reading a
		// stale pre-#809 rule that a marker alone meant "already live". This is
		// the same fixture, corrected: the finding was the assertion, not the
		// task.
		const collection = [
			"## Tasks",
			"",
			"- [ ] Already paired ⏳ 2026-09-22 %% task-consistency:abc123 11112222 %%",
			"",
		].join("\n");
		const result = copyIn(collection, freshLog(), TODAY, layout(), "Errands");

		// Before the fix, `category` excluded any paired line whose meaning was
		// not `copied` outright, whatever the log actually carried — this would
		// still report copied: 0.
		expect(result.copied).toBe(1);

		const collectionMarker = readMarker(parsed(lineContaining(result.collection, "Already paired")));
		const logMarker = readMarker(parsed(lineContaining(result.log, "Already paired")));
		if (collectionMarker === null || logMarker === null) {
			throw new Error("expected both copies to carry a marker");
		}
		expect(collectionMarker.eid).toBe("abc123");
		expect(logMarker.eid).toBe("abc123");
	});

	it("re-copies a task rescheduled from the log to an earlier date, once today's line is frozen", () => {
		// #809's own repro (`.git/work-the-board/evidence/wave3-probe.test.ts`,
		// test "D"): rescheduling from the log moves the date to the collection
		// and freezes today's line rather than deleting it — but before #834's
		// fix, `collectLogEids` counted that frozen `[>]` line as still "live",
		// so the paired collection task never came back.
		const collection = "## Tasks\n\n- [ ] Buy stamps #errand 📅 2026-09-22\n";
		const first = copyIn(collection, freshLog(), TODAY, layout(), "Errands");

		const logLine = lineContaining(first.log, "Buy stamps");
		const collectionLine = lineContaining(first.collection, "Buy stamps");
		const marker = readMarker(parsed(collectionLine));
		if (marker === null) throw new Error("expected the collection's own copy to carry a marker");

		// The person reschedules from inside the log to an earlier date.
		const logRescheduled = editTaskField(logLine, "due", "2026-09-20");
		const reconciled = reconcilePair(collectionLine, logRescheduled, { hash: marker.hash });
		if (reconciled.collection === null) throw new Error("expected the collection to follow the log's new date");

		const collectionMoved = replaceLine(first.collection, collectionLine, reconciled.collection);
		const logFrozen = replaceLine(first.log, logLine, freeze(logRescheduled));

		const result = copyIn(collectionMoved, logFrozen, TODAY, layout(), "Errands");

		// Before the fix: copied: 0, and the task stayed stuck in the
		// collection with no live line anywhere in the log.
		expect(result.copied).toBe(1);
		expect(countLinesContaining(result.log, "Buy stamps")).toBe(2);
		// The frozen line from before this call is untouched.
		const frozenAfter = result.log.split("\n").find((line) => line.startsWith("- [>]") && line.includes("Buy stamps"));
		expect(frozenAfter).toBe(freeze(logRescheduled));
	});

	it("re-copies a task whose log line was forwarded by hand, not only one rescheduled through this feature", () => {
		// #836: no #709 sentence distinguishes a hand-typed `[>]` from one this
		// feature wrote itself, so it gets the same rule as #834 — a forwarded
		// line is never counted "live", whoever wrote the `[>]`.
		const collection = "## Tasks\n\n- [ ] Buy stamps #errand 📅 2026-09-22\n";
		const first = copyIn(collection, freshLog(), TODAY, layout(), "Errands");

		const logLine = lineContaining(first.log, "Buy stamps");
		// The person types `[>]` on today's own line by hand, for reasons of
		// their own — never through this feature's roll-over or reschedule
		// logic.
		const handTyped = editTaskField(logLine, "checkbox", ">");
		const logHandForwarded = replaceLine(first.log, logLine, handTyped);

		const result = copyIn(first.collection, logHandForwarded, TODAY, layout(), "Errands");

		// Before the fix: copied: 0 — the hand-typed `[>]` kept the collection's
		// `[/]` excluded for good, with no live line anywhere.
		expect(result.copied).toBe(1);
		// The hand-typed line itself is untouched.
		const handTypedAfter = result.log.split("\n").find((line) => line.startsWith("- [>]") && line.includes("Buy stamps"));
		expect(handTypedAfter).toBe(handTyped);
	});

	it("does not copy a task nested under a completed-tasks heading written shallower than, and above, the tasks heading", () => {
		// #845: a completed-tasks heading written shallower and above the tasks
		// heading naturally encloses it — `headingRange`'s own "runs to the next
		// heading of the same or a shallower level" rule never terminates the
		// completed section at a *deeper* tasks heading below it. Trying every
		// level for the completed heading and taking the first match, as before
		// the fix, would find that enclosing one and never look for one actually
		// nested inside the tasks range — so a second, legitimately nested
		// completed-tasks heading below the tasks heading was never excluded.
		const collection = [
			`## ${layout().completedTasksHeading}`,
			"",
			"- [x] Old errand",
			"",
			`### ${layout().tasksHeading}`,
			"",
			"- [ ] Buy stamps ⏳ 2026-09-22",
			"",
			`#### ${layout().completedTasksHeading}`,
			"",
			"- [ ] Not really a task of this collection's own tasks ⏳ 2026-09-22",
			"",
		].join("\n");
		const result = copyIn(collection, freshLog(), TODAY, layout(), "Errands");

		// Before the fix: copied 2 — the nested "not really a task" line above
		// was pulled in too, since nothing clipped the tasks range at the
		// correctly-nested completed heading.
		expect(result.copied).toBe(1);
		expect(result.log).toContain("Buy stamps");
		expect(result.log).not.toContain("Not really a task");
	});

	it("re-copies a paired task whose log line was deleted, keeping its existing eid", () => {
		// The log holds no line for "existingeid" at all — ADR 0002: a log line
		// you delete comes back, because the log itself remembers nothing. A
		// marker check that still excluded any paired task, ignoring whether
		// its log copy is actually there, would report copied: 0 here.
		const collection = [
			"## Tasks",
			"",
			"- [/] Buy stamps #errand ⏳ 2026-09-22 %% task-consistency:existingeid 11112222 %%",
			"",
		].join("\n");
		const result = copyIn(collection, freshLog(), TODAY, layout(), "Errands");

		expect(result.copied).toBe(1);

		const collectionMarker = readMarker(parsed(lineContaining(result.collection, "Buy stamps")));
		const logMarker = readMarker(parsed(lineContaining(result.log, "Buy stamps")));
		if (collectionMarker === null || logMarker === null) {
			throw new Error("expected both copies to carry a marker");
		}
		// A fresh eid here, rather than the one the collection already
		// carried, would silently start a second pairing for the same task.
		expect(collectionMarker.eid).toBe("existingeid");
		expect(logMarker.eid).toBe("existingeid");

		// The re-created log line starts open — the collection's own `/` is
		// this feature's bookkeeping, never the log's own checkbox.
		expect(parsed(lineContaining(result.log, "Buy stamps")).meaning).toBe("open");
	});

	it("does not copy a task under the completed-tasks heading", () => {
		const collection = [
			"## Tasks",
			"",
			"## Completed tasks",
			"",
			"- [ ] Reopened errand ⏳ 2026-09-22",
			"",
		].join("\n");
		const result = copyIn(collection, freshLog(), TODAY, layout(), "Errands");

		// A tasks-heading range that ran to the end of the note instead of
		// stopping at the next heading would still find this task and copy it.
		expect(result.copied).toBe(0);
		expect(result.collection).toBe(collection);
		expect(result.log).toBe(freshLog());
	});

	it("adds both missing headings, overdue directly above today, and never adds the notes heading", () => {
		const bareLog = "# Notes\n\nSome free writing.\n";
		const collection = ["## Tasks", "", "- [ ] Pay the invoice ⏳ 2026-09-10", "- [ ] Buy stamps ⏳ 2026-09-22", ""].join(
			"\n",
		);
		const result = copyIn(collection, bareLog, TODAY, layout(), "Errands");

		const lines = result.log.split("\n");
		// A wrong insertion point could duplicate the notes heading instead of
		// leaving it alone, or an unguarded pass could add it as a third
		// day's-task section — either would fail this count.
		expect(countLinesContaining(result.log, "# Notes")).toBe(1);
		expect(lines).toContain("## Overdue");
		expect(lines).toContain("## Today");
		expect(lines.indexOf("## Overdue")).toBeLessThan(lines.indexOf("## Today"));
		expect(result.log).toContain("Some free writing.");
		expect(result.log).toContain("Pay the invoice");
		expect(result.log).toContain("Buy stamps");
	});

	it("leaves a task uncopied when the heading its date would send it to is blank", () => {
		const collection = ["## Tasks", "", "- [ ] Pay the invoice ⏳ 2026-09-22", ""].join("\n");
		const result = copyIn(collection, "# Notes\n", TODAY, layout({ todayHeading: { text: " ", level: 2 } }), "Errands");

		// A rule that fell back to writing under the overdue heading instead
		// would still show copied: 1 and a changed log — decision left to this
		// ticket: a blank section is switched off, not redirected.
		expect(result.copied).toBe(0);
		expect(result.collection).toBe(collection);
		expect(result.log).toBe("# Notes\n");
	});

	it("copies nothing running over its own output", () => {
		const collection = [
			"## Tasks",
			"",
			"- [ ] Plan the conference 📅 2026-12-01",
			"\t- [ ] Book the venue ⏳ 2026-09-22",
			"- [ ] Pay the invoice ⏳ 2026-09-10",
			"",
		].join("\n");
		const first = copyIn(collection, freshLog(), TODAY, layout(), "Work");
		expect(first.copied).toBeGreaterThan(0);

		const second = copyIn(first.collection, first.log, TODAY, layout(), "Work");
		expect(second).toEqual({ collection: first.collection, log: first.log, copied: 0 });
	});
});
