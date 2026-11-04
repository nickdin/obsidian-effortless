import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TFile } from "obsidian";
import type { Collection, Collections } from "../core/collections";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { editTaskField, parseTaskLine } from "../core/taskLine";
import type { TaskLine } from "../core/taskLine";
import { dailyLogFrame, dailyLogPath } from "../core/vaultLayout";
import { copyIn } from "../features/taskConsistency/copyIn";
import { readMarker } from "../features/taskConsistency/marker";
import { freeze } from "../features/taskConsistency/rollOver";
import { checkLogFile, runOverCollection, runSweep } from "../features/taskConsistency/run";
import type { RunDeps, RunNotes, RunProblems, RunVault } from "../features/taskConsistency/run";

/**
 * One run over a changed file — task consistency's whole job, joined up from
 * the pure pieces `reconcile.ts`, `copyIn.ts`, `rollOver.ts` and
 * `complete.ts` build (spec #709
 * decisions 2, 9, 10, 11 and 13, ticket
 * #810). Every test here
 * drives `run.ts` against a fake `Collections`, a fake `NoteWriter` and a fake
 * `FeatureProblems`, the shape `meetingNotes/run.ts` and `daysAhead/run.ts`
 * are both tested against, and never touches `taskConsistency.ts` — the
 * feature's own timers and its vault-change watcher are
 * `taskConsistencyRunTimers.test.ts`'s job.
 *
 * Every collection, note and task below is invented: no real task, name or
 * path from any vault.
 */

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(2026, 8, 22, 9, 0));
});
afterEach(() => vi.useRealTimers());

const TODAY = new Date(2026, 8, 22, 9, 0);

function layout(overrides: Partial<VaultLayout> = {}): VaultLayout {
	return {
		...defaultData().core.layout,
		dailyLogFolder: "Journal",
		dailyLogFilename: "YYYY-MM-DD",
		...overrides,
	};
}

const COLLECTION_PATH = "Errands.md";
const TODAY_LOG_PATH = dailyLogPath(TODAY, layout());

function file(path: string): TFile {
	return { path } as TFile;
}

function collectionOf(overrides: Partial<Collection> = {}): Collection {
	return { path: COLLECTION_PATH, name: "Errands", headingLine: 0, headingLevel: 2, openTasks: 1, ...overrides };
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

/** A fake `NoteWriter`, keyed by path, that counts every `read` and `edit`. */
function fakeNotes(files: Map<string, string>): RunNotes & { readCounts: Map<string, number>; editCounts: Map<string, number> } {
	const readCounts = new Map<string, number>();
	const editCounts = new Map<string, number>();
	return {
		readCounts,
		editCounts,
		read: async (target) => {
			readCounts.set(target.path, (readCounts.get(target.path) ?? 0) + 1);
			const content = files.get(target.path);
			if (content === undefined) throw new Error(`fakeNotes: nothing at ${target.path}`);
			return content;
		},
		edit: async (target, edit) => {
			editCounts.set(target.path, (editCounts.get(target.path) ?? 0) + 1);
			const next = edit(files.get(target.path) ?? "");
			files.set(target.path, next);
			return next;
		},
	};
}

function fakeVault(paths: readonly string[]): RunVault {
	return { fileAt: (path) => (paths.includes(path) ? file(path) : null) };
}

/** A fake `FeatureProblems`, holding what is standing rather than raising a real `Notice`. */
function fakeProblems(): RunProblems & { standing: Map<string, string> } {
	const standing = new Map<string, string>();
	return {
		standing,
		report: (key, message) => standing.set(key, message),
		clear: (key) => standing.delete(key),
		list: () => [...standing.keys()],
	};
}

function fakeCollections(all: readonly Collection[]): Collections {
	return {
		all: () => all,
		at: (path) => all.find((collection) => collection.path === path) ?? null,
	};
}

function deps(collections: Collections, vault: RunVault, notes: RunNotes, problems: RunProblems): RunDeps {
	return { collections, vault, notes, problems, layout: layout(), today: TODAY };
}

/** A fresh pairing: a collection carrying only `taskLine`, and the log `copyIn` produced from it. */
function freshPairing(taskLine: string, collectionName = "Errands"): { collectionText: string; logText: string } {
	const collectionText = `## ${layout().tasksHeading}\n${taskLine}\n`;
	const logText = dailyLogFrame(layout());
	const out = copyIn(collectionText, logText, TODAY, layout(), collectionName);
	return { collectionText: out.collection, logText: out.log };
}

describe("runOverCollection", () => {
	it("copies a due unpaired task and folds a changed paired task's field into one edit per file", async () => {
		const { collectionText: pairedCollection, logText: pairedLog } = freshPairing(
			"- [ ] Renew the parking permit ⏳ 2026-09-20",
		);
		// The collection side changes after the pairing was made — a real edit,
		// nothing this feature wrote.
		const changedCollection = editTaskField(
			lineContaining(pairedCollection, "Renew the parking permit"),
			"priority",
			"high",
		);
		const collectionText = [
			`## ${layout().tasksHeading}`,
			"- [ ] Buy stamps ⏳ 2026-09-22",
			changedCollection,
		].join("\n");

		const files = new Map([
			[COLLECTION_PATH, collectionText],
			[TODAY_LOG_PATH, pairedLog],
		]);
		const notes = fakeNotes(files);
		const problems = fakeProblems();
		const runDeps = deps(fakeCollections([collectionOf()]), fakeVault([COLLECTION_PATH, TODAY_LOG_PATH]), notes, problems);

		await runOverCollection(runDeps, collectionOf());

		expect(notes.editCounts.get(COLLECTION_PATH)).toBe(1);
		expect(notes.editCounts.get(TODAY_LOG_PATH)).toBe(1);

		const finalCollection = files.get(COLLECTION_PATH)!;
		const finalLog = files.get(TODAY_LOG_PATH)!;

		// The due task was copied in, marked `/` in the collection, and appears
		// in the log with the collection's own name.
		const collectionDue = parsed(lineContaining(finalCollection, "Buy stamps"));
		expect(collectionDue.meaning).toBe("copied");
		expect(readMarker(collectionDue)).not.toBeNull();
		expect(lineContaining(finalLog, "Buy stamps")).toContain("[[Errands]]");

		// The priority change on the collection side travelled to the log.
		expect(parsed(lineContaining(finalLog, "Renew the parking permit")).priority).toBe("high");
		expect(problems.standing.size).toBe(0);
	});

	it("a clash raises one notice and one standing problem keyed by the eid, writes nothing, and clears when the lines next agree", async () => {
		const { collectionText, logText } = freshPairing("- [ ] Order the blue folders ⏳ 2026-09-22");
		const eid = readMarker(parsed(lineContaining(collectionText, "Order the blue folders")))!.eid;

		const clashedCollection = editTaskField(lineContaining(collectionText, "Order the blue folders"), "priority", "high");
		const clashedLog = editTaskField(lineContaining(logText, "Order the blue folders"), "priority", "low");
		const collectionFull = collectionText.replace(lineContaining(collectionText, "Order the blue folders"), clashedCollection);
		const logFull = logText.replace(lineContaining(logText, "Order the blue folders"), clashedLog);

		const files = new Map([
			[COLLECTION_PATH, collectionFull],
			[TODAY_LOG_PATH, logFull],
		]);
		const notes = fakeNotes(files);
		const problems = fakeProblems();
		const runDeps = deps(fakeCollections([collectionOf()]), fakeVault([COLLECTION_PATH, TODAY_LOG_PATH]), notes, problems);

		await runOverCollection(runDeps, collectionOf());

		expect(notes.editCounts.size).toBe(0);
		expect(files.get(COLLECTION_PATH)).toBe(collectionFull);
		expect(files.get(TODAY_LOG_PATH)).toBe(logFull);
		expect(problems.standing.has(eid)).toBe(true);
		// The two sides now disagree on priority — high (⏫) on the collection,
		// low (🔽) on the log — and the message names both wordings.
		expect(problems.standing.get(eid)).toContain("⏫");
		expect(problems.standing.get(eid)).toContain("\u{1F53D}");

		// The person resolves it by hand, editing the log to match the collection.
		const resolvedLog = editTaskField(clashedLog, "priority", "high");
		files.set(TODAY_LOG_PATH, logText.replace(lineContaining(logText, "Order the blue folders"), resolvedLog));

		await runOverCollection(runDeps, collectionOf());

		expect(problems.standing.has(eid)).toBe(false);
	});

	it("running twice with no further edit in between writes nothing the second time (#825's two-run test)", async () => {
		const { collectionText, logText } = freshPairing("- [ ] Order the blue folders ⏳ 2026-09-22");
		const edited = editTaskField(lineContaining(collectionText, "Order the blue folders"), "priority", "high");
		const collectionFull = collectionText.replace(lineContaining(collectionText, "Order the blue folders"), edited);

		const files = new Map([
			[COLLECTION_PATH, collectionFull],
			[TODAY_LOG_PATH, logText],
		]);
		const notes = fakeNotes(files);
		const problems = fakeProblems();
		const runDeps = deps(fakeCollections([collectionOf()]), fakeVault([COLLECTION_PATH, TODAY_LOG_PATH]), notes, problems);

		await runOverCollection(runDeps, collectionOf());
		expect(notes.editCounts.get(TODAY_LOG_PATH)).toBe(1);
		expect(parsed(lineContaining(files.get(TODAY_LOG_PATH)!, "Order the blue folders")).priority).toBe("high");

		notes.editCounts.clear();
		await runOverCollection(runDeps, collectionOf());

		expect(notes.editCounts.size).toBe(0);
		expect(problems.standing.size).toBe(0);
	});

	it("does nothing when today's log does not exist yet", async () => {
		const files = new Map([[COLLECTION_PATH, `## ${layout().tasksHeading}\n- [ ] Buy stamps ⏳ 2026-09-22\n`]]);
		const notes = fakeNotes(files);
		const problems = fakeProblems();
		const runDeps = deps(fakeCollections([collectionOf()]), fakeVault([COLLECTION_PATH]), notes, problems);

		await runOverCollection(runDeps, collectionOf());

		expect(notes.readCounts.size).toBe(0);
		expect(notes.editCounts.size).toBe(0);
	});

	it("a run whose collection write is refused writes nothing to the log, and reports it", async () => {
		const collectionText = `## ${layout().tasksHeading}\n- [ ] Buy stamps ⏳ 2026-09-20\n`;
		const logText = dailyLogFrame(layout());

		const files = new Map([
			[COLLECTION_PATH, collectionText],
			[TODAY_LOG_PATH, logText],
		]);
		// A fake NoteWriter whose *first* collection edit finds the note changed
		// underneath it — the same refusal a real `NoteWriter` gives when the
		// note is held open and a further keystroke lands before the write.
		let refuseNextCollectionWrite = true;
		const editCounts = new Map<string, number>();
		const notes: RunNotes & { editCounts: Map<string, number> } = {
			editCounts,
			read: async (target) => {
				const content = files.get(target.path);
				if (content === undefined) throw new Error(`fakeNotes: nothing at ${target.path}`);
				return content;
			},
			edit: async (target, edit) => {
				editCounts.set(target.path, (editCounts.get(target.path) ?? 0) + 1);
				const stale = target.path === COLLECTION_PATH && refuseNextCollectionWrite;
				if (target.path === COLLECTION_PATH) refuseNextCollectionWrite = false;
				const freshContent = stale ? `${files.get(target.path) ?? ""}\n` : files.get(target.path) ?? "";
				const next = edit(freshContent);
				files.set(target.path, next);
				return next;
			},
		};
		const problems = fakeProblems();
		const runDeps = deps(fakeCollections([collectionOf()]), fakeVault([COLLECTION_PATH, TODAY_LOG_PATH]), notes, problems);

		await runOverCollection(runDeps, collectionOf());

		// The collection's write was refused (the fresh content it saw — with an
		// added trailing newline — never matched the snapshot this run read), so
		// the log is never written either.
		expect(notes.editCounts.get(TODAY_LOG_PATH)).toBeUndefined();
		expect(files.get(TODAY_LOG_PATH)).toBe(logText);
		expect(problems.standing.has(`run-failed:${COLLECTION_PATH}`)).toBe(true);

		// A second, ordinary run over the same (still due, still unpaired) state
		// copies the task exactly once.
		problems.standing.clear();
		notes.editCounts.clear();
		await runOverCollection(runDeps, collectionOf());

		const finalLog = files.get(TODAY_LOG_PATH)!;
		const copies = finalLog.split("\n").filter((line) => line.includes("Buy stamps"));
		expect(copies).toHaveLength(1);
		expect(problems.standing.has(`run-failed:${COLLECTION_PATH}`)).toBe(false);
	});

	it("a run whose log write is refused reports it, naming the log, and a later run clears it", async () => {
		const collectionText = `## ${layout().tasksHeading}\n- [ ] Buy stamps ⏳ 2026-09-20\n`;
		const logText = dailyLogFrame(layout());

		const files = new Map([
			[COLLECTION_PATH, collectionText],
			[TODAY_LOG_PATH, logText],
		]);
		// A fake NoteWriter whose *first* log edit finds the note changed
		// underneath it — the same refusal a real `NoteWriter` gives once a
		// write to the note the person has open finally reaches the front of
		// the queue and the note has moved on since this run's own read
		// (`NoteWriter.edit` parks such a write until they leave the note,
		// `noteWriter.ts`, ADR 0002).
		let refuseNextLogWrite = true;
		const editCounts = new Map<string, number>();
		const notes: RunNotes & { editCounts: Map<string, number> } = {
			editCounts,
			read: async (target) => {
				const content = files.get(target.path);
				if (content === undefined) throw new Error(`fakeNotes: nothing at ${target.path}`);
				return content;
			},
			edit: async (target, edit) => {
				editCounts.set(target.path, (editCounts.get(target.path) ?? 0) + 1);
				const stale = target.path === TODAY_LOG_PATH && refuseNextLogWrite;
				if (target.path === TODAY_LOG_PATH) refuseNextLogWrite = false;
				const freshContent = stale ? `${files.get(target.path) ?? ""}\n` : files.get(target.path) ?? "";
				const next = edit(freshContent);
				files.set(target.path, next);
				return next;
			},
		};
		const problems = fakeProblems();
		const runDeps = deps(fakeCollections([collectionOf()]), fakeVault([COLLECTION_PATH, TODAY_LOG_PATH]), notes, problems);

		await runOverCollection(runDeps, collectionOf());

		// The collection's own write landed (nothing raced it), but the log's
		// write was refused — that must be reported, naming the log, the same
		// way a refused collection write already is. Today's code never
		// checks the log write's own `landed` result, so this fails there.
		// Keyed by the collection, `log-write-refused:<collection.path>`, its
		// own namespace rather than `run-failed:<log path>` — the key
		// `checkPath`'s log branch (`taskConsistency.ts`) already owns for the
		// log check's own failure, so the two must never share one.
		expect(problems.standing.has(`log-write-refused:${COLLECTION_PATH}`)).toBe(true);
		expect(problems.standing.get(`log-write-refused:${COLLECTION_PATH}`)).toContain("today's log");

		// A second, ordinary run finds the same task still uncopied — its eid
		// never reached the log — and lands it, clearing the standing problem.
		await runOverCollection(runDeps, collectionOf());

		const finalLog = files.get(TODAY_LOG_PATH)!;
		const copies = finalLog.split("\n").filter((line) => line.includes("Buy stamps"));
		expect(copies).toHaveLength(1);
		expect(problems.standing.has(`log-write-refused:${COLLECTION_PATH}`)).toBe(false);
	});

	it("rolls a live line from the most recent earlier log that has one, not only yesterday's", async () => {
		const twoDaysAgo = new Date(2026, 8, 20, 9, 0);
		const rawCollection = `## ${layout().tasksHeading}\n- [ ] Order the blue folders ⏳ 2026-09-20\n`;
		// The copy happened two days ago, on `twoDaysAgo` — the day this task's
		// log line has sat live in ever since, with yesterday's own log never
		// created at all (a skipped day).
		const copiedTwoDaysAgo = copyIn(rawCollection, dailyLogFrame(layout()), twoDaysAgo, layout(), "Errands");
		const collectionText = copiedTwoDaysAgo.collection;
		const oldLogText = copiedTwoDaysAgo.log;
		const oldPath = dailyLogPath(twoDaysAgo, layout());

		const files = new Map([
			[COLLECTION_PATH, collectionText],
			[oldPath, oldLogText],
			[TODAY_LOG_PATH, dailyLogFrame(layout())],
			// Yesterday's own log is missing entirely — a skipped day.
		]);
		const notes = fakeNotes(files);
		const problems = fakeProblems();
		const runDeps = deps(fakeCollections([collectionOf()]), fakeVault([COLLECTION_PATH, oldPath, TODAY_LOG_PATH]), notes, problems);

		await runOverCollection(runDeps, collectionOf());

		const finalOld = files.get(oldPath)!;
		const finalToday = files.get(TODAY_LOG_PATH)!;

		expect(parsed(lineContaining(finalOld, "Order the blue folders")).meaning).toBe("forwarded");
		const copies = finalToday.split("\n").filter((line) => line.includes("Order the blue folders"));
		expect(copies).toHaveLength(1);
		expect(parsed(copies[0]).meaning).toBe("open");
	});

	it("a marked log line naming a real collection with no line carrying its eid raises one standing problem keyed by the eid", async () => {
		const { collectionText, logText } = freshPairing("- [ ] Order the blue folders ⏳ 2026-09-22");
		const eid = readMarker(parsed(lineContaining(collectionText, "Order the blue folders")))!.eid;

		// The collection's own paired line is gone — deleted by hand — but the
		// log line, and its marker, are still there.
		const collectionWithoutLine = collectionText
			.split("\n")
			.filter((line) => !line.includes("Order the blue folders"))
			.join("\n");

		const files = new Map([
			[COLLECTION_PATH, collectionWithoutLine],
			[TODAY_LOG_PATH, logText],
		]);
		const notes = fakeNotes(files);
		const problems = fakeProblems();
		const runDeps = deps(fakeCollections([collectionOf()]), fakeVault([COLLECTION_PATH, TODAY_LOG_PATH]), notes, problems);

		await runOverCollection(runDeps, collectionOf());

		expect(problems.standing.has(`no-collection-line:${eid}`)).toBe(true);
		expect(notes.editCounts.size).toBe(0);
		expect(files.get(COLLECTION_PATH)).toBe(collectionWithoutLine);
		expect(files.get(TODAY_LOG_PATH)).toBe(logText);
	});

	it("skips a frozen [>] line above the live copy and pairs against the live one", async () => {
		const { collectionText, logText } = freshPairing("- [ ] Order the blue folders ⏳ 2026-09-22");
		const liveLine = lineContaining(logText, "Order the blue folders");
		const frozenLine = freeze(liveLine);
		const logWithFrozenAbove = logText.replace(liveLine, `${frozenLine}\n${liveLine}`);

		const changedCollection = editTaskField(lineContaining(collectionText, "Order the blue folders"), "priority", "high");
		const collectionFull = collectionText.replace(lineContaining(collectionText, "Order the blue folders"), changedCollection);

		const files = new Map([
			[COLLECTION_PATH, collectionFull],
			[TODAY_LOG_PATH, logWithFrozenAbove],
		]);
		const notes = fakeNotes(files);
		const problems = fakeProblems();
		const runDeps = deps(fakeCollections([collectionOf()]), fakeVault([COLLECTION_PATH, TODAY_LOG_PATH]), notes, problems);

		await runOverCollection(runDeps, collectionOf());

		const finalLog = files.get(TODAY_LOG_PATH)!;
		const linesAfter = finalLog.split("\n").filter((line) => line.includes("Order the blue folders"));
		expect(linesAfter).toHaveLength(2);
		const frozenAfter = linesAfter.find((line) => parsed(line).meaning === "forwarded")!;
		const liveAfter = linesAfter.find((line) => parsed(line).meaning !== "forwarded")!;
		expect(frozenAfter).toBe(frozenLine);
		expect(parsed(liveAfter).priority).toBe("high");
		expect(problems.standing.size).toBe(0);
	});

	it("a date changed from the log side is folded into the collection and freezes today's line", async () => {
		const { collectionText, logText } = freshPairing("- [ ] Order the blue folders ⏳ 2026-09-20");
		const rescheduledLog = editTaskField(lineContaining(logText, "Order the blue folders"), "scheduled", "2026-09-25");
		const logFull = logText.replace(lineContaining(logText, "Order the blue folders"), rescheduledLog);

		const files = new Map([
			[COLLECTION_PATH, collectionText],
			[TODAY_LOG_PATH, logFull],
		]);
		const notes = fakeNotes(files);
		const problems = fakeProblems();
		const runDeps = deps(fakeCollections([collectionOf()]), fakeVault([COLLECTION_PATH, TODAY_LOG_PATH]), notes, problems);

		await runOverCollection(runDeps, collectionOf());

		const finalCollection = files.get(COLLECTION_PATH)!;
		const finalLog = files.get(TODAY_LOG_PATH)!;
		expect(parsed(lineContaining(finalCollection, "Order the blue folders")).scheduled).toBe("2026-09-25");
		expect(parsed(lineContaining(finalLog, "Order the blue folders")).meaning).toBe("forwarded");
		expect(problems.standing.size).toBe(0);
	});

	it("collection edit, run, collection edit again, run: no clash, and the second edit lands", async () => {
		const { collectionText, logText } = freshPairing("- [ ] Order the blue folders ⏳ 2026-09-22");
		const firstEdit = editTaskField(lineContaining(collectionText, "Order the blue folders"), "priority", "high");
		const collectionAfterFirst = collectionText.replace(lineContaining(collectionText, "Order the blue folders"), firstEdit);

		const files = new Map([
			[COLLECTION_PATH, collectionAfterFirst],
			[TODAY_LOG_PATH, logText],
		]);
		const notes = fakeNotes(files);
		const problems = fakeProblems();
		const runDeps = deps(fakeCollections([collectionOf()]), fakeVault([COLLECTION_PATH, TODAY_LOG_PATH]), notes, problems);

		await runOverCollection(runDeps, collectionOf());
		expect(parsed(lineContaining(files.get(TODAY_LOG_PATH)!, "Order the blue folders")).priority).toBe("high");

		const collectionAfterFirstRun = files.get(COLLECTION_PATH)!;
		const secondEdit = editTaskField(lineContaining(collectionAfterFirstRun, "Order the blue folders"), "priority", "medium");
		files.set(COLLECTION_PATH, collectionAfterFirstRun.replace(lineContaining(collectionAfterFirstRun, "Order the blue folders"), secondEdit));

		notes.editCounts.clear();
		await runOverCollection(runDeps, collectionOf());

		expect(problems.standing.size).toBe(0);
		expect(parsed(lineContaining(files.get(TODAY_LOG_PATH)!, "Order the blue folders")).priority).toBe("medium");
		expect(notes.editCounts.get(TODAY_LOG_PATH)).toBe(1);
	});

	it.each([
		["x", "done"],
		["-", "cancelled"],
	] as const)(
		"a task ticked [%s] directly in the log is not re-copied, and the collection moves to %s under the completed-tasks heading",
		async (checkbox, meaning) => {
			// #936: before the fix, `copyIn`'s own `collectLogEids` read a `[x]`/`[-]`
			// log line as "not live" — the same rule it correctly applies to a
			// deleted or frozen line — so `copyIn` re-copied a fresh, open duplicate
			// ahead of the tick, and `reconcileAll`'s own `locateLiveLogLine` found
			// that duplicate first. The tick never reached the collection, and the
			// duplicate stayed in the log every run after.
			const { collectionText, logText } = freshPairing("- [ ] Prune the roses ⏳ 2026-09-22");
			const tickedLine = editTaskField(lineContaining(logText, "Prune the roses"), "checkbox", checkbox);
			const logFull = logText.replace(lineContaining(logText, "Prune the roses"), tickedLine);

			const files = new Map([
				[COLLECTION_PATH, collectionText],
				[TODAY_LOG_PATH, logFull],
			]);
			const notes = fakeNotes(files);
			const problems = fakeProblems();
			const runDeps = deps(fakeCollections([collectionOf()]), fakeVault([COLLECTION_PATH, TODAY_LOG_PATH]), notes, problems);

			await runOverCollection(runDeps, collectionOf());

			const finalLog = files.get(TODAY_LOG_PATH)!;
			const finalCollection = files.get(COLLECTION_PATH)!;

			// Exactly one line for this task in the log — the tick itself, never a
			// second, fresh-open copy ahead of it.
			const logCopies = finalLog.split("\n").filter((line) => line.includes("Prune the roses"));
			expect(logCopies).toHaveLength(1);
			expect(parsed(logCopies[0]).meaning).toBe(meaning);

			// The collection's own copy reads the same meaning and sits under the
			// completed-tasks heading, not still under the tasks heading as `[/]`.
			expect(parsed(lineContaining(finalCollection, "Prune the roses")).meaning).toBe(meaning);
			const headingIndex = finalCollection.indexOf(`## ${layout().completedTasksHeading}`);
			const taskIndex = finalCollection.indexOf("Prune the roses");
			expect(headingIndex).toBeGreaterThan(-1);
			expect(taskIndex).toBeGreaterThan(headingIndex);
			expect(problems.standing.size).toBe(0);
		},
	);

	it("a task whose log line was forwarded [>] by hand still gets a fresh copy, unlike a done or cancelled one", async () => {
		// The `[>]` (forwarded) case `collectLogEids`'s "not live" rule exists
		// for must still work after #936's fix: a frozen line is genuinely no
		// longer the live copy, unlike a `[x]`/`[-]` one, which is finished but
		// not missing.
		const { collectionText, logText } = freshPairing("- [ ] Prune the roses ⏳ 2026-09-22");
		const forwardedLine = editTaskField(lineContaining(logText, "Prune the roses"), "checkbox", ">");
		const logFull = logText.replace(lineContaining(logText, "Prune the roses"), forwardedLine);

		const files = new Map([
			[COLLECTION_PATH, collectionText],
			[TODAY_LOG_PATH, logFull],
		]);
		const notes = fakeNotes(files);
		const problems = fakeProblems();
		const runDeps = deps(fakeCollections([collectionOf()]), fakeVault([COLLECTION_PATH, TODAY_LOG_PATH]), notes, problems);

		await runOverCollection(runDeps, collectionOf());

		const finalLog = files.get(TODAY_LOG_PATH)!;
		const copies = finalLog.split("\n").filter((line) => line.includes("Prune the roses"));
		expect(copies).toHaveLength(2);
		const fresh = copies.find((line) => parsed(line).meaning === "open");
		const frozen = copies.find((line) => parsed(line).meaning === "forwarded");
		expect(fresh).not.toBeUndefined();
		expect(frozen).toBe(forwardedLine);
	});

	it.each([
		["x", "done"],
		["-", "cancelled"],
	] as const)(
		"a tick [%s] made directly in YESTERDAY's log, with no run in between, still reaches the collection and gets no fresh duplicate",
		async (checkbox, meaning) => {
			// #936 fixed this for a tick made in TODAY's own log; #947 is the same
			// defect one day early — a tick nobody's run has seen yet, in the log
			// `rollOver`'s own look-back reads as "yesterday's". `collectLogEids`
			// only ever reads the log it is handed, and `copyIn`'s own call reads
			// only today's, so a paired task still `[/]` in the collection was, before
			// this fix, re-copied fresh and open into today's log — the tick sitting
			// one day back was never seen at all.
			const yesterday = new Date(2026, 8, 21, 9, 0);
			const rawCollection = `## ${layout().tasksHeading}\n- [ ] Prune the roses ⏳ 2026-09-21\n`;
			const copiedYesterday = copyIn(rawCollection, dailyLogFrame(layout()), yesterday, layout(), "Errands");
			const collectionText = copiedYesterday.collection;
			const tickedLine = editTaskField(lineContaining(copiedYesterday.log, "Prune the roses"), "checkbox", checkbox);
			const oldLogText = copiedYesterday.log.replace(lineContaining(copiedYesterday.log, "Prune the roses"), tickedLine);
			const oldPath = dailyLogPath(yesterday, layout());

			const files = new Map([
				[COLLECTION_PATH, collectionText],
				[oldPath, oldLogText],
				[TODAY_LOG_PATH, dailyLogFrame(layout())],
			]);
			const notes = fakeNotes(files);
			const problems = fakeProblems();
			const runDeps = deps(fakeCollections([collectionOf()]), fakeVault([COLLECTION_PATH, oldPath, TODAY_LOG_PATH]), notes, problems);

			await runOverCollection(runDeps, collectionOf());

			const finalOld = files.get(oldPath)!;
			const finalToday = files.get(TODAY_LOG_PATH)!;
			const finalCollection = files.get(COLLECTION_PATH)!;

			// Yesterday's own tick is left exactly as it was written that day.
			expect(finalOld).toBe(oldLogText);

			// No fresh, open duplicate in today's log.
			const todayCopies = finalToday.split("\n").filter((line) => line.includes("Prune the roses"));
			expect(todayCopies).toHaveLength(0);

			// The collection reads the same meaning as yesterday's tick and sits
			// under the completed-tasks heading.
			expect(parsed(lineContaining(finalCollection, "Prune the roses")).meaning).toBe(meaning);
			const headingIndex = finalCollection.indexOf(`## ${layout().completedTasksHeading}`);
			const taskIndex = finalCollection.indexOf("Prune the roses");
			expect(headingIndex).toBeGreaterThan(-1);
			expect(taskIndex).toBeGreaterThan(headingIndex);
		},
	);

	it.each([
		["x", "done"],
		["-", "cancelled"],
	] as const)(
		"a live [ ] line in yesterday's log still rolls over and freezes when today's log already carries a finished [%s] copy of the same eid, and gains no duplicate there either",
		async (checkbox, meaning) => {
			// #936 changed collectLogEids, which rollOver.ts:158 also reads to decide whether today's log already carries the eid live —
			// before that fix, a done/cancelled line did not count, so rollOver
			// would add a second, fresh open copy in today's overdue section
			// beside the already-finished one. Nothing exercised this composition
			// until now: taskConsistencyRollOver.test.ts has no case with a
			// finished line in today's log, and #936's own closing comment cited
			// only taskConsistencyRun.test.ts and the parity replay, neither of
			// which ran rollOver and a finished today's-log line together.
			const yesterday = new Date(2026, 8, 21, 9, 0);
			const rawCollection = `## ${layout().tasksHeading}\n- [ ] Do the chores ⏳ 2026-09-21\n`;
			const copiedYesterday = copyIn(rawCollection, dailyLogFrame(layout()), yesterday, layout(), "Errands");
			const collectionText = copiedYesterday.collection;
			const oldLogText = copiedYesterday.log; // still [ ], live — nobody ticked it there
			const oldPath = dailyLogPath(yesterday, layout());

			// Today's log already carries a finished copy of the very same eid —
			// as if an earlier trigger today had already copied and ticked it.
			const liveYesterdayLine = lineContaining(oldLogText, "Do the chores");
			const finishedTodayLine = editTaskField(liveYesterdayLine, "checkbox", checkbox);
			const todayLogText = `${dailyLogFrame(layout())}${finishedTodayLine}\n`;

			const files = new Map([
				[COLLECTION_PATH, collectionText],
				[oldPath, oldLogText],
				[TODAY_LOG_PATH, todayLogText],
			]);
			const notes = fakeNotes(files);
			const problems = fakeProblems();
			const runDeps = deps(fakeCollections([collectionOf()]), fakeVault([COLLECTION_PATH, oldPath, TODAY_LOG_PATH]), notes, problems);

			await runOverCollection(runDeps, collectionOf());

			const finalOld = files.get(oldPath)!;
			const finalToday = files.get(TODAY_LOG_PATH)!;
			const finalCollection = files.get(COLLECTION_PATH)!;

			// Decision 11: an unfinished paired line rolls over and freezes on
			// meaning alone — whatever today's log already holds for the
			// same eid.
			expect(parsed(lineContaining(finalOld, "Do the chores")).meaning).toBe("forwarded");

			// #835/#936: today's log keeps exactly the one finished line — no
			// fresh, open duplicate added beside it.
			const todayCopies = finalToday.split("\n").filter((line) => line.includes("Do the chores"));
			expect(todayCopies).toHaveLength(1);
			expect(parsed(todayCopies[0]).meaning).toBe(meaning);

			// Decision 11: the collection reads the same finished meaning, moved
			// under the completed-tasks heading.
			expect(parsed(lineContaining(finalCollection, "Do the chores")).meaning).toBe(meaning);
			const headingIndex = finalCollection.indexOf(`## ${layout().completedTasksHeading}`);
			const taskIndex = finalCollection.indexOf("Do the chores");
			expect(headingIndex).toBeGreaterThan(-1);
			expect(taskIndex).toBeGreaterThan(headingIndex);
		},
	);
});

describe("the refused-log-write report clears when a later run has nothing left to write", () => {
	it("a run over the same collection with the task already in the log clears a standing refused-log-write report", async () => {
		// A fresh pairing: the task is already copied into today's log and its
		// marker matches, so this run has nothing left to write to either file —
		// the case #910's fix never addressed, because its own clear sits only
		// inside the branch that runs when this run's own log write differs from
		// what it read (`run.ts`'s `if (todayText !== todaySnapshot)`).
		const { collectionText, logText } = freshPairing("- [ ] Buy stamps ⏳ 2026-09-20");
		const files = new Map([
			[COLLECTION_PATH, collectionText],
			[TODAY_LOG_PATH, logText],
		]);
		const notes = fakeNotes(files);
		const problems = fakeProblems();
		// Simulates an earlier refusal still standing when this run starts — the
		// task reached the log by the time of this run (by a retry, or by hand),
		// but nothing yet cleared the report that named the earlier refusal.
		problems.report(
			`log-write-refused:${COLLECTION_PATH}`,
			`Effortless could not add "Errands"'s task to today's log: the write was held while the log was the open note and came back stale.`,
		);
		const runDeps = deps(fakeCollections([collectionOf()]), fakeVault([COLLECTION_PATH, TODAY_LOG_PATH]), notes, problems);

		await runOverCollection(runDeps, collectionOf());

		// Confirms this run really had nothing to write — the case under test —
		// rather than happening to land a no-op write.
		expect(notes.editCounts.get(TODAY_LOG_PATH)).toBeUndefined();
		// Fails on the pre-#914 code: it clears `log-write-refused:` only
		// inside the branch this run never enters, so the standing report is
		// left exactly as it was found.
		expect(problems.standing.has(`log-write-refused:${COLLECTION_PATH}`)).toBe(false);
	});
});

describe("reconcileAgainstOldLog's own clash reporting (#951, held and cleared per #961/#962/#965/#966/#967)", () => {
	/**
	 * One collection carrying one task, copied into `yesterday`'s log by an
	 * earlier run the way #947's own scenario always starts — the shared
	 * starting point every test below edits from. `describeWords` and
	 * `logWords` let a caller give each side its own wording (#967: the
	 * earlier fixture used "Water the plants" on both sides, so asserting each
	 * side's own words appear in the report could not fail whichever way the
	 * code read).
	 */
	function clashingPair(): {
		collectionText: string;
		oldLogText: string;
		oldPath: string;
		eid: string;
		tickedOldLine: string;
	} {
		const yesterday = new Date(2026, 8, 21, 9, 0);
		const rawCollection = `## ${layout().tasksHeading}\n- [ ] Water the plants ⏳ 2026-09-21\n`;
		const copiedYesterday = copyIn(rawCollection, dailyLogFrame(layout()), yesterday, layout(), "Errands");
		const eid = readMarker(parsed(lineContaining(copiedYesterday.collection, "Water the plants")))!.eid;
		const oldPath = dailyLogPath(yesterday, layout());

		// The tick happens directly in yesterday's log — a genuine finish — and
		// its own words are changed too, so a message naming both sides can be
		// told apart.
		const tickedOldRaw = editTaskField(lineContaining(copiedYesterday.log, "Water the plants"), "checkbox", "x");
		const tickedOldLine = tickedOldRaw.replace("Water the plants", "Water the ferns");
		const oldLogText = copiedYesterday.log.replace(lineContaining(copiedYesterday.log, "Water the plants"), tickedOldLine);

		// The collection's own copy is independently edited since the last
		// sync — its scheduled date dropped, by hand — and its own words
		// changed too, differently from the log's.
		const editedCollectionRaw = editTaskField(lineContaining(copiedYesterday.collection, "Water the plants"), "scheduled", null);
		const editedCollectionLine = editedCollectionRaw.replace("Water the plants", "Water the roses");
		const collectionText = copiedYesterday.collection.replace(
			lineContaining(copiedYesterday.collection, "Water the plants"),
			editedCollectionLine,
		);

		return { collectionText, oldLogText, oldPath, eid, tickedOldLine };
	}

	it("holds the pairing untouched across two runs with nothing changed, naming each side's own words and the earlier log (#961 route 1, #965, #967)", async () => {
		const { collectionText, oldLogText, oldPath, eid } = clashingPair();

		const files = new Map([
			[COLLECTION_PATH, collectionText],
			[oldPath, oldLogText],
			[TODAY_LOG_PATH, dailyLogFrame(layout())],
		]);
		const notes = fakeNotes(files);
		const problems = fakeProblems();
		const runDeps = deps(fakeCollections([collectionOf()]), fakeVault([COLLECTION_PATH, oldPath, TODAY_LOG_PATH]), notes, problems);

		await runOverCollection(runDeps, collectionOf());

		// Nothing is written — not even the collection's own marker hash
		// (`reconcileAll`'s own marker-healing, #852, would otherwise reach a
		// pairing with no live log copy the moment it were left unheld: #961's
		// own bug).
		expect(notes.editCounts.has(oldPath)).toBe(false);
		expect(notes.editCounts.has(COLLECTION_PATH)).toBe(false);
		expect(notes.editCounts.has(TODAY_LOG_PATH)).toBe(false);
		expect(files.get(oldPath)).toBe(oldLogText);
		expect(files.get(COLLECTION_PATH)).toBe(collectionText);

		expect(problems.standing.has(eid)).toBe(true);
		const message = problems.standing.get(eid)!;
		expect(message).toContain(oldPath);
		expect(message).toContain("Water the roses"); // the collection's own words
		expect(message).toContain("Water the ferns"); // the old log's own words

		// A second run with nothing changed: still zero writes, report still
		// standing (#961 route 1 — before the fix, this run alone folded the
		// old log's tick over the collection and cleared the report).
		await runOverCollection(runDeps, collectionOf());

		expect(notes.editCounts.has(oldPath)).toBe(false);
		expect(notes.editCounts.has(COLLECTION_PATH)).toBe(false);
		expect(notes.editCounts.has(TODAY_LOG_PATH)).toBe(false);
		expect(problems.standing.has(eid)).toBe(true);
	});

	it("with the task still due, copies nothing into today's log across two runs (#961 route 2, #965)", async () => {
		const yesterday = new Date(2026, 8, 21, 9, 0);
		const rawCollection = `## ${layout().tasksHeading}\n- [ ] Water the plants ⏳ 2026-09-21\n`;
		const copiedYesterday = copyIn(rawCollection, dailyLogFrame(layout()), yesterday, layout(), "Errands");
		const eid = readMarker(parsed(lineContaining(copiedYesterday.collection, "Water the plants")))!.eid;
		const oldPath = dailyLogPath(yesterday, layout());

		const tickedOldLine = editTaskField(lineContaining(copiedYesterday.log, "Water the plants"), "checkbox", "x");
		const oldLogText = copiedYesterday.log.replace(lineContaining(copiedYesterday.log, "Water the plants"), tickedOldLine);

		// The collection's edit keeps the task due — a priority added, not the
		// scheduled date dropped, so the task stays on copyIn's own "due" list
		// unless it is held.
		const editedCollectionLine = editTaskField(lineContaining(copiedYesterday.collection, "Water the plants"), "priority", "high");
		const collectionText = copiedYesterday.collection.replace(
			lineContaining(copiedYesterday.collection, "Water the plants"),
			editedCollectionLine,
		);

		const files = new Map([
			[COLLECTION_PATH, collectionText],
			[oldPath, oldLogText],
			[TODAY_LOG_PATH, dailyLogFrame(layout())],
		]);
		const notes = fakeNotes(files);
		const problems = fakeProblems();
		const runDeps = deps(fakeCollections([collectionOf()]), fakeVault([COLLECTION_PATH, oldPath, TODAY_LOG_PATH]), notes, problems);

		await runOverCollection(runDeps, collectionOf());

		// Before the fix, copyIn re-copied this still-due task into today's log
		// as a fresh open line, re-hashing the collection's marker as it did.
		expect(notes.editCounts.has(TODAY_LOG_PATH)).toBe(false);
		expect(notes.editCounts.has(COLLECTION_PATH)).toBe(false);
		expect(problems.standing.has(eid)).toBe(true);

		await runOverCollection(runDeps, collectionOf());

		expect(notes.editCounts.has(TODAY_LOG_PATH)).toBe(false);
		expect(notes.editCounts.has(COLLECTION_PATH)).toBe(false);
		expect(files.get(COLLECTION_PATH)).toBe(collectionText);
		expect(problems.standing.has(eid)).toBe(true);
	});

	it("un-ticking the old log's line clears the report on the next run", async () => {
		const { collectionText, oldLogText, oldPath, eid, tickedOldLine } = clashingPair();

		const files = new Map([
			[COLLECTION_PATH, collectionText],
			[oldPath, oldLogText],
			[TODAY_LOG_PATH, dailyLogFrame(layout())],
		]);
		const notes = fakeNotes(files);
		const problems = fakeProblems();
		const runDeps = deps(fakeCollections([collectionOf()]), fakeVault([COLLECTION_PATH, oldPath, TODAY_LOG_PATH]), notes, problems);

		await runOverCollection(runDeps, collectionOf());
		expect(problems.standing.has(eid)).toBe(true);

		// The person un-ticks the old log's line by hand — it no longer reads a
		// genuine finish.
		const untickedLine = editTaskField(tickedOldLine, "checkbox", " ");
		files.set(oldPath, oldLogText.replace(tickedOldLine, untickedLine));

		await runOverCollection(runDeps, collectionOf());

		expect(problems.standing.has(eid)).toBe(false);
	});

	it("a later day where another log is the nearest earlier one clears the report", async () => {
		const { collectionText, oldLogText, oldPath, eid } = clashingPair();

		const files = new Map([
			[COLLECTION_PATH, collectionText],
			[oldPath, oldLogText],
			[TODAY_LOG_PATH, dailyLogFrame(layout())],
		]);
		const notes = fakeNotes(files);
		const problems = fakeProblems();
		const runDeps = deps(fakeCollections([collectionOf()]), fakeVault([COLLECTION_PATH, oldPath, TODAY_LOG_PATH]), notes, problems);

		await runOverCollection(runDeps, collectionOf());
		expect(problems.standing.has(eid)).toBe(true);

		// The day moves on: 2026-09-23 is now today, so 2026-09-22 — which
		// never carried the tick — is the nearest earlier log, and the log the
		// clash was against (2026-09-21) is never read at all.
		const newToday = new Date(2026, 8, 23, 9, 0);
		const newTodayPath = dailyLogPath(newToday, layout());
		files.set(newTodayPath, dailyLogFrame(layout()));

		const laterDeps: RunDeps = {
			collections: fakeCollections([collectionOf()]),
			vault: fakeVault([COLLECTION_PATH, oldPath, TODAY_LOG_PATH, newTodayPath]),
			notes,
			problems,
			layout: layout(),
			today: newToday,
		};

		await runOverCollection(laterDeps, collectionOf());

		expect(problems.standing.has(eid)).toBe(false);
	});

	it("deleting the task's line from the collection clears the report once a sweep can see it is gone", async () => {
		const { collectionText, oldLogText, oldPath, eid } = clashingPair();

		const files = new Map([
			[COLLECTION_PATH, collectionText],
			[oldPath, oldLogText],
			[TODAY_LOG_PATH, dailyLogFrame(layout())],
		]);
		const notes = fakeNotes(files);
		const problems = fakeProblems();
		const runDeps = deps(fakeCollections([collectionOf()]), fakeVault([COLLECTION_PATH, oldPath, TODAY_LOG_PATH]), notes, problems);

		await runOverCollection(runDeps, collectionOf());
		expect(problems.standing.has(eid)).toBe(true);

		// The person deletes the task's own line from the collection — nothing
		// left to reconcile against.
		const withoutLine = files
			.get(COLLECTION_PATH)!
			.split("\n")
			.filter((line) => !line.includes("Water the roses"))
			.join("\n");
		files.set(COLLECTION_PATH, withoutLine);

		// reconcileAgainstOldLog's own loop is driven by the collection's own
		// marked eids, so a single run over this one collection never visits an
		// eid whose line is gone; the sweep's own bare-eid purge is what
		// catches it (#962's own "a run and a runSweep").
		await runSweep(runDeps, () => null);

		expect(problems.standing.has(eid)).toBe(false);
	});

	it("editing one side's fields to match resolves the clash and the ordinary sync resumes", async () => {
		const { collectionText, oldLogText, oldPath, eid } = clashingPair();

		const files = new Map([
			[COLLECTION_PATH, collectionText],
			[oldPath, oldLogText],
			[TODAY_LOG_PATH, dailyLogFrame(layout())],
		]);
		const notes = fakeNotes(files);
		const problems = fakeProblems();
		const runDeps = deps(fakeCollections([collectionOf()]), fakeVault([COLLECTION_PATH, oldPath, TODAY_LOG_PATH]), notes, problems);

		await runOverCollection(runDeps, collectionOf());
		expect(problems.standing.has(eid)).toBe(true);

		// The person resolves it by hand: their own edit to the collection's
		// scheduled date is undone, so only the log's own tick is still a real
		// change since the pairing was last synced — "edit one to match the
		// other," the clash message's own words, on the field that disagreed,
		// never the words (#709: words are never compared).
		const revertedCollectionLine = editTaskField(lineContaining(files.get(COLLECTION_PATH)!, "Water the roses"), "scheduled", "2026-09-21");
		files.set(COLLECTION_PATH, files.get(COLLECTION_PATH)!.replace(lineContaining(files.get(COLLECTION_PATH)!, "Water the roses"), revertedCollectionLine));

		await runOverCollection(runDeps, collectionOf());

		expect(problems.standing.has(eid)).toBe(false);
		const collectionLineAfter = parsed(lineContaining(files.get(COLLECTION_PATH)!, "Water the roses"));
		expect(collectionLineAfter.meaning).toBe("done");
	});

	it("a tick in an earlier log that does not disagree with the collection reports nothing (unchanged from #947)", async () => {
		const yesterday = new Date(2026, 8, 21, 9, 0);
		const rawCollection = `## ${layout().tasksHeading}\n- [ ] Water the plants ⏳ 2026-09-21\n`;
		const copiedYesterday = copyIn(rawCollection, dailyLogFrame(layout()), yesterday, layout(), "Errands");
		const eid = readMarker(parsed(lineContaining(copiedYesterday.collection, "Water the plants")))!.eid;
		const oldPath = dailyLogPath(yesterday, layout());

		// The tick happens directly in yesterday's log; the collection's own
		// copy is left exactly as copied — no independent edit, so nothing
		// disagrees.
		const tickedOldLine = editTaskField(lineContaining(copiedYesterday.log, "Water the plants"), "checkbox", "x");
		const oldLogText = copiedYesterday.log.replace(lineContaining(copiedYesterday.log, "Water the plants"), tickedOldLine);

		const files = new Map([
			[COLLECTION_PATH, copiedYesterday.collection],
			[oldPath, oldLogText],
			[TODAY_LOG_PATH, dailyLogFrame(layout())],
		]);
		const notes = fakeNotes(files);
		const problems = fakeProblems();
		const runDeps = deps(fakeCollections([collectionOf()]), fakeVault([COLLECTION_PATH, oldPath, TODAY_LOG_PATH]), notes, problems);

		await runOverCollection(runDeps, collectionOf());

		expect(problems.standing.has(eid)).toBe(false);
		expect(problems.standing.size).toBe(0);
		expect(parsed(lineContaining(files.get(COLLECTION_PATH)!, "Water the plants")).meaning).toBe("done");
	});
});

describe("checkLogFile", () => {
	it("a log line naming a note the index no longer calls a collection leaves both files untouched and raises one standing problem keyed by the path, cleared when it matches again", async () => {
		const { collectionText, logText } = freshPairing("- [ ] Order the blue folders ⏳ 2026-09-22");
		const renamedPath = "Old-name.md";

		const files = new Map([
			[COLLECTION_PATH, collectionText],
			[TODAY_LOG_PATH, logText],
		]);
		const notes = fakeNotes(files);
		const problems = fakeProblems();

		let collections: Collections = fakeCollections([]);
		const runDeps = deps(
			{ all: () => collections.all(), at: (path) => collections.at(path) },
			fakeVault([COLLECTION_PATH, TODAY_LOG_PATH]),
			notes,
			problems,
		);

		await checkLogFile(runDeps, () => renamedPath, file(TODAY_LOG_PATH));

		expect(problems.standing.has(renamedPath)).toBe(true);
		expect(notes.editCounts.size).toBe(0);
		expect(files.get(COLLECTION_PATH)).toBe(collectionText);
		expect(files.get(TODAY_LOG_PATH)).toBe(logText);

		// The heading is restored: the note matches again.
		collections = fakeCollections([{ path: renamedPath, name: "Errands", headingLine: 0, headingLevel: 2, openTasks: 0 }]);
		await checkLogFile(runDeps, () => renamedPath, file(TODAY_LOG_PATH));

		expect(problems.standing.has(renamedPath)).toBe(false);
	});

	it("a marked line with no breadcrumb is reported once, keyed by its own eid, and left untouched", async () => {
		const { collectionText, logText } = freshPairing("- [ ] Order the blue folders ⏳ 2026-09-22");
		const marker = readMarker(parsed(lineContaining(collectionText, "Order the blue folders")))!;
		const orphanLine = lineContaining(logText, "Order the blue folders").replace(/ \[\[[^\]]+\]\]/u, "");
		const orphanLog = logText.replace(lineContaining(logText, "Order the blue folders"), orphanLine);

		const files = new Map([[TODAY_LOG_PATH, orphanLog]]);
		const notes = fakeNotes(files);
		const problems = fakeProblems();
		const runDeps = deps(fakeCollections([]), fakeVault([TODAY_LOG_PATH]), notes, problems);

		await checkLogFile(runDeps, () => null, file(TODAY_LOG_PATH));

		expect(problems.standing.has(`no-collection:${marker.eid}`)).toBe(true);
		expect(notes.editCounts.size).toBe(0);
		expect(files.get(TODAY_LOG_PATH)).toBe(orphanLog);
	});

	it("a hand-typed log task carrying a link and no marker is left exactly as typed (spec #709 § Named differences row 4, #810 criterion 7)", async () => {
		const handTyped = "- [ ] Look into it [[Some collection]]";
		const logText = `${dailyLogFrame(layout())}${handTyped}\n`;

		const files = new Map([[TODAY_LOG_PATH, logText]]);
		const notes = fakeNotes(files);
		const problems = fakeProblems();
		const runDeps = deps(fakeCollections([]), fakeVault([TODAY_LOG_PATH]), notes, problems);

		await checkLogFile(runDeps, () => "Some collection.md", file(TODAY_LOG_PATH));

		expect(problems.standing.size).toBe(0);
		expect(notes.editCounts.size).toBe(0);
		expect(files.get(TODAY_LOG_PATH)).toBe(logText);
	});

	it("clears a no-collection: key whose orphan line is gone entirely", async () => {
		const logText = dailyLogFrame(layout());
		const files = new Map([[TODAY_LOG_PATH, logText]]);
		const notes = fakeNotes(files);
		const problems = fakeProblems();
		problems.standing.set("no-collection:stale-eid", "an old orphan, long since deleted");
		const runDeps = deps(fakeCollections([]), fakeVault([TODAY_LOG_PATH]), notes, problems);

		await checkLogFile(runDeps, () => null, file(TODAY_LOG_PATH));

		expect(problems.standing.has("no-collection:stale-eid")).toBe(false);
	});

	it("clears a broken-pairing key whose log line is gone entirely", async () => {
		const logText = dailyLogFrame(layout());
		const files = new Map([[TODAY_LOG_PATH, logText]]);
		const notes = fakeNotes(files);
		const problems = fakeProblems();
		problems.standing.set("Old-name.md", "a task in today's log names \"Old-name\", which is not a collection any more.");
		const runDeps = deps(fakeCollections([]), fakeVault([TODAY_LOG_PATH]), notes, problems);

		await checkLogFile(runDeps, () => null, file(TODAY_LOG_PATH));

		expect(problems.standing.has("Old-name.md")).toBe(false);
	});
});

describe("runSweep", () => {
	it("visits only collections with open tasks, plus today's log, and skips a collection with none unread", async () => {
		const busy = collectionOf({ path: "Busy.md", name: "Busy", openTasks: 2 });
		const idle = collectionOf({ path: "Idle.md", name: "Idle", openTasks: 0 });

		const files = new Map([
			["Busy.md", `## ${layout().tasksHeading}\n`],
			[TODAY_LOG_PATH, dailyLogFrame(layout())],
		]);
		const notes = fakeNotes(files);
		const problems = fakeProblems();
		const runDeps = deps(fakeCollections([busy, idle]), fakeVault(["Busy.md", TODAY_LOG_PATH]), notes, problems);

		await runSweep(runDeps, () => null);

		expect(notes.readCounts.get("Busy.md")).toBeGreaterThan(0);
		expect(notes.readCounts.has("Idle.md")).toBe(false);
		expect(notes.readCounts.get(TODAY_LOG_PATH)).toBeGreaterThan(0);
	});

	it("reads a collection named in today's log exactly once, even though the direct pass over open collections finds it too", async () => {
		const { collectionText, logText } = freshPairing("- [ ] Order the blue folders ⏳ 2026-09-22");
		const files = new Map([
			[COLLECTION_PATH, collectionText],
			[TODAY_LOG_PATH, logText],
		]);
		const notes = fakeNotes(files);
		const problems = fakeProblems();
		const runDeps = deps(fakeCollections([collectionOf({ openTasks: 1 })]), fakeVault([COLLECTION_PATH, TODAY_LOG_PATH]), notes, problems);

		await runSweep(runDeps, () => COLLECTION_PATH);

		expect(notes.readCounts.get(COLLECTION_PATH)).toBe(1);
	});

	it("clears a standing clash whose collection line has since been deleted", async () => {
		const files = new Map([
			["Busy.md", `## ${layout().tasksHeading}\n`],
			[TODAY_LOG_PATH, dailyLogFrame(layout())],
		]);
		const notes = fakeNotes(files);
		const problems = fakeProblems();
		problems.standing.set("abc123wxyz", "a task was edited in both places and now disagrees, long since resolved by deleting the line.");
		const runDeps = deps(
			fakeCollections([collectionOf({ path: "Busy.md", name: "Busy", openTasks: 1 })]),
			fakeVault(["Busy.md", TODAY_LOG_PATH]),
			notes,
			problems,
		);

		await runSweep(runDeps, () => null);

		expect(problems.standing.has("abc123wxyz")).toBe(false);
	});
});

describe("a ticked recurring task brings the next round", () => {
	/** The run's world for one collection: both files, the fakes, and the deps to run with. */
	function world(collectionText: string, logText: string) {
		const files = new Map([
			[COLLECTION_PATH, collectionText],
			[TODAY_LOG_PATH, logText],
		]);
		const notes = fakeNotes(files);
		const problems = fakeProblems();
		const runDeps = deps(fakeCollections([collectionOf()]), fakeVault([COLLECTION_PATH, TODAY_LOG_PATH]), notes, problems);
		return { files, notes, problems, runDeps };
	}

	it("a tick in today's log brings a fresh round in the collection in the same run", async () => {
		// If the round step ran before the pairing was reconciled, or never, the
		// collection would still hold the done line under the tasks heading with
		// no fresh round; if finishing ran first, the line would be moved bare.
		const { collectionText, logText } = freshPairing("- [ ] Water the ferns 🔁 every week ⏳ 2026-09-22");
		const ticked = logText.replace("- [ ] Water the ferns", "- [x] Water the ferns");
		expect(ticked).not.toBe(logText);
		const { files, runDeps } = world(collectionText, ticked);

		await runOverCollection(runDeps, collectionOf());

		const finalCollection = files.get(COLLECTION_PATH)!;
		const lines = finalCollection.split("\n");
		const tasksAt = lines.indexOf(`## ${layout().tasksHeading}`);
		const completedAt = lines.indexOf(`## ${layout().completedTasksHeading}`);
		expect(tasksAt).toBeGreaterThanOrEqual(0);
		expect(completedAt).toBeGreaterThan(tasksAt);
		// Under the tasks heading: the fresh round, open, a week on, unpaired.
		const fresh = parsed(lines[tasksAt + 1]);
		expect(fresh.meaning).toBe("open");
		expect(fresh.scheduled).toBe("2026-09-29");
		expect(fresh.repeat).toBe("every week");
		expect(readMarker(fresh)).toBeNull();
		// Under the completed-tasks heading: the ticked line, date unchanged.
		const done = parsed(lines[completedAt + 2]);
		expect(done.meaning).toBe("done");
		expect(done.scheduled).toBe("2026-09-22");
		expect(lines.filter((line) => line.includes("Water the ferns"))).toHaveLength(2);
		// The day's log is a mirror: the ticked copy stays done and no round was added.
		const finalLog = files.get(TODAY_LOG_PATH)!;
		expect(parsed(lineContaining(finalLog, "Water the ferns")).meaning).toBe("done");
		expect(finalLog.split("\n").filter((line) => line.includes("Water the ferns"))).toHaveLength(1);
	});

	it("copies the fresh round into today's log in that same run when the next date is today, and a second run over the result creates nothing", async () => {
		// A late tick: the line was due 2026-09-20 and the rule is `every day`, so
		// the first date not before today is today itself. This is the one test
		// that runs round step → finishing → copy-in over one text in one run.
		// If copy-in ran before the round step, the log would hold only the ticked
		// copy until the next run; if the second run's step read the completed
		// section or copy-in re-copied, the second run would write again.
		const { collectionText, logText } = freshPairing("- [ ] Water the ferns 🔁 every day ⏳ 2026-09-20");
		const ticked = logText.replace("- [ ] Water the ferns", "- [x] Water the ferns");
		const { files, notes, runDeps } = world(collectionText, ticked);

		await runOverCollection(runDeps, collectionOf());

		const finalCollection = files.get(COLLECTION_PATH)!;
		const finalLog = files.get(TODAY_LOG_PATH)!;
		const logLines = finalLog.split("\n").filter((line) => line.includes("Water the ferns"));
		expect(logLines.map((line) => parsed(line).meaning).sort()).toEqual(["done", "open"]);
		const copiedRound = parsed(logLines.find((line) => parsed(line).meaning === "open")!);
		expect(copiedRound.scheduled).toBe("2026-09-22");
		expect(readMarker(copiedRound)).not.toBeNull();
		// In the collection the fresh round is marked copied and dated today.
		const collectionRound = finalCollection
			.split("\n")
			.map((line) => parseTaskLine(line))
			.find((line) => line !== null && line.meaning === "copied");
		expect(collectionRound?.scheduled).toBe("2026-09-22");

		notes.editCounts.clear();
		await runOverCollection(runDeps, collectionOf());

		expect(notes.editCounts.size).toBe(0);
		expect(files.get(COLLECTION_PATH)).toBe(finalCollection);
		expect(files.get(TODAY_LOG_PATH)).toBe(finalLog);
	});

	it("a recurring task ticked straight in the collection, never copied into any day, gets its next round on the next run", async () => {
		// Unpaired and finished: the pairing loop never visits it, so only the
		// round step can bring the round.
		const collectionText = [
			`## ${layout().tasksHeading}`,
			"- [x] Water the ferns 🔁 every week ⏳ 2026-09-20",
			"- [ ] Buy stamps",
			"",
		].join("\n");
		const { files, runDeps } = world(collectionText, dailyLogFrame(layout()));

		await runOverCollection(runDeps, collectionOf());

		expect(files.get(COLLECTION_PATH)).toBe(
			[
				`## ${layout().tasksHeading}`,
				"- [ ] Water the ferns 🔁 every week ⏳ 2026-09-27",
				"- [ ] Buy stamps",
				"",
				`## ${layout().completedTasksHeading}`,
				"",
				"- [x] Water the ferns 🔁 every week ⏳ 2026-09-20",
				"",
			].join("\n"),
		);
	});

	it("a repeat rule edited in today's log does not travel to the collection, while a field that does travel, edited in the same line, does", async () => {
		// The priority change makes the log the source of a sync, so the run does
		// carry that line's fields across; if the 🔁 text were among the fields
		// that travel, the collection would read `every month` afterwards. With
		// only the rule edited, nothing would be a source and this could not fail.
		const { collectionText, logText } = freshPairing("- [ ] Water the ferns 🔁 every week ⏳ 2026-09-22");
		const edited = editTaskField(
			lineContaining(logText, "Water the ferns").replace("🔁 every week", "🔁 every month"),
			"priority",
			"high",
		);
		const editedLog = logText.replace(lineContaining(logText, "Water the ferns"), edited);
		expect(editedLog).not.toBe(logText);
		const { files, runDeps } = world(collectionText, editedLog);

		await runOverCollection(runDeps, collectionOf());

		const collectionLine = parsed(lineContaining(files.get(COLLECTION_PATH)!, "Water the ferns"));
		expect(collectionLine.priority).toBe("high");
		expect(collectionLine.repeat).toBe("every week");
		expect(parsed(lineContaining(files.get(TODAY_LOG_PATH)!, "Water the ferns")).repeat).toBe("every month");
	});

	it("a paired recurring line with no date is left alone, finished or not, as an unpaired one is", async () => {
		// Spec #1222 decision 5: "Rule readable, no own date: the line is left
		// alone and the no-date problem is raised (decision 8), finished or not."
		// The round step leaves the line alone; the held-back finishing loop must
		// not then move it, or the same line is treated two ways (an unpaired one
		// stays) and the line leaves the place the no-date report is read from.
		// The edit is made in the collection (date removed, line ticked) so the
		// collection is the source of the sync and the log follows it.
		const { collectionText, logText } = freshPairing("- [ ] Water the ferns 🔁 every week ⏳ 2026-09-22");
		const undated = collectionText.replace(" ⏳ 2026-09-22", "").replace("- [/] Water the ferns", "- [x] Water the ferns");
		expect(undated).not.toBe(collectionText);
		expect(undated).toContain("- [x] Water the ferns 🔁 every week %%");
		const { files, runDeps } = world(undated, logText);

		await runOverCollection(runDeps, collectionOf());

		// If the held-back finishing loop finished it, the line would sit under a
		// new completed-tasks heading and the tasks heading would hold nothing.
		const lines = files.get(COLLECTION_PATH)!.split("\n");
		expect(lines.filter((line) => line.includes("Water the ferns"))).toHaveLength(1);
		expect(lines).not.toContain(`## ${layout().completedTasksHeading}`);
		expect(lines.findIndex((line) => line.includes("Water the ferns"))).toBe(lines.indexOf(`## ${layout().tasksHeading}`) + 1);
		// The log still follows the collection: its copy reads done.
		expect(parsed(lineContaining(files.get(TODAY_LOG_PATH)!, "Water the ferns")).meaning).toBe("done");
	});

	it("a paired recurring line whose rule cannot be read is still finished as any task is", async () => {
		// Only the readable-rule, no-date case is "left alone, finished or not";
		// a rule nobody can read is a task that does not repeat, which "copies,
		// rolls over and finishes as any task". If the fix for #1247 held back
		// every line the round step left alone, this line would stay put.
		const { collectionText, logText } = freshPairing("- [ ] Water the ferns 🔁 every full moon ⏳ 2026-09-22");
		const ticked = collectionText.replace("- [/] Water the ferns", "- [x] Water the ferns");
		expect(ticked).not.toBe(collectionText);
		const { files, runDeps } = world(ticked, logText);

		await runOverCollection(runDeps, collectionOf());

		const lines = files.get(COLLECTION_PATH)!.split("\n");
		const completedAt = lines.indexOf(`## ${layout().completedTasksHeading}`);
		expect(completedAt).toBeGreaterThanOrEqual(0);
		expect(lines.findIndex((line) => line.includes("Water the ferns"))).toBeGreaterThan(completedAt);
	});

	it("a recurring parent with a separately paired subtask, ticked in the log: a second run writes nothing to either note (#1244, #1226 criterion)", async () => {
		// The parent's finishing is held back for the round step, so the subtask
		// the move marks done in the collection is reconciled only by a later
		// run. If that were left to the plugin's own write triggering one, the
		// second run would edit the log. The fixture has a paired `[/]` subtask,
		// which the earlier "second run" tests did not.
		const rawCollection = [
			`## ${layout().tasksHeading}`,
			"- [ ] Water the ferns 🔁 every week ⏳ 2026-09-22",
			"\t- [ ] Fill the can ⏳ 2026-09-22",
			"",
		].join("\n");
		const copied = copyIn(rawCollection, dailyLogFrame(layout()), TODAY, layout(), "Errands");
		expect(copied.collection).toContain("- [/] Fill the can");
		expect(copied.log).toContain("Fill the can");
		const ticked = copied.log.replace("- [ ] Water the ferns", "- [x] Water the ferns");
		expect(ticked).not.toBe(copied.log);
		const { files, notes, runDeps } = world(copied.collection, ticked);

		await runOverCollection(runDeps, collectionOf());
		const afterFirst = { collection: files.get(COLLECTION_PATH)!, log: files.get(TODAY_LOG_PATH)! };
		notes.editCounts.clear();
		await runOverCollection(runDeps, collectionOf());

		expect(notes.editCounts.size).toBe(0);
		expect(files.get(COLLECTION_PATH)).toBe(afterFirst.collection);
		expect(files.get(TODAY_LOG_PATH)).toBe(afterFirst.log);
		// And the first run already made the log a full mirror: the subtask the
		// move marked done in the collection reads done in the log too.
		expect(parsed(lineContaining(afterFirst.log, "Fill the can")).meaning).toBe("done");
	});

	it("a clashing recurring pairing is kept out of the round step: the notice says neither was changed, and neither note is written", async () => {
		// Both copies changed since the last sync and disagree: the collection's
		// is done, the log's cancelled. If the round step looked at every
		// finished recurring line whatever its pairing's state, the collection
		// would gain a fresh round and lose the done line to the completed-tasks
		// heading while the notice still says "Neither was changed".
		const { collectionText, logText } = freshPairing("- [ ] Water the ferns 🔁 every week ⏳ 2026-09-22");
		const clashedCollection = collectionText.replace("- [/] Water the ferns", "- [x] Water the ferns");
		const clashedLog = logText.replace("- [ ] Water the ferns", "- [-] Water the ferns");
		expect(clashedCollection).not.toBe(collectionText);
		expect(clashedLog).not.toBe(logText);
		const { files, notes, problems, runDeps } = world(clashedCollection, clashedLog);

		await runOverCollection(runDeps, collectionOf());

		expect([...problems.standing.values()].some((message) => message.includes("Neither was changed"))).toBe(true);
		expect(files.get(COLLECTION_PATH)).toBe(clashedCollection);
		expect(files.get(TODAY_LOG_PATH)).toBe(clashedLog);
		expect(notes.editCounts.size).toBe(0);
	});

	it("a recurring pairing held back by an older log's clash is kept out of the round step too", async () => {
		// Yesterday's log holds a genuine finish with one priority, and the
		// collection's own copy was ticked since with another: the old-log clash
		// of #951, held for the run. The notice says neither was changed.
		const yesterday = new Date(2026, 8, 21, 9, 0);
		const rawCollection = `## ${layout().tasksHeading}\n- [ ] Water the plants 🔁 every week ⏳ 2026-09-21\n`;
		const copiedYesterday = copyIn(rawCollection, dailyLogFrame(layout()), yesterday, layout(), "Errands");
		const oldPath = dailyLogPath(yesterday, layout());
		const tickedOld = editTaskField(
			editTaskField(lineContaining(copiedYesterday.log, "Water the plants"), "checkbox", "x"),
			"priority",
			"low",
		);
		const oldLogText = copiedYesterday.log.replace(lineContaining(copiedYesterday.log, "Water the plants"), tickedOld);
		const collectionText = copiedYesterday.collection.replace(
			lineContaining(copiedYesterday.collection, "Water the plants"),
			editTaskField(
				editTaskField(lineContaining(copiedYesterday.collection, "Water the plants"), "checkbox", "x"),
				"priority",
				"high",
			),
		);
		expect(collectionText).toContain("- [x] Water the plants 🔁 every week");

		const files = new Map([
			[COLLECTION_PATH, collectionText],
			[oldPath, oldLogText],
			[TODAY_LOG_PATH, dailyLogFrame(layout())],
		]);
		const notes = fakeNotes(files);
		const problems = fakeProblems();
		const runDeps = deps(fakeCollections([collectionOf()]), fakeVault([COLLECTION_PATH, oldPath, TODAY_LOG_PATH]), notes, problems);

		await runOverCollection(runDeps, collectionOf());

		expect([...problems.standing.values()].some((message) => message.includes("Neither was changed"))).toBe(true);
		expect(files.get(COLLECTION_PATH)).toBe(collectionText);
		expect(files.get(oldPath)).toBe(oldLogText);
		expect(notes.editCounts.size).toBe(0);
	});
});

describe("the startup sweep and a collection whose only task is a ticked recurring line", () => {
	it("writes the fresh round into a collection whose only task is a ticked recurring line, and still never reads one with no task at all", async () => {
		// `openTasks` counts only `[ ]` lines, so this collection reads as idle.
		// If the sweep keeps skipping on `openTasks` alone, the ticked line stays
		// under the tasks heading with no round and the collection is never read.
		const ticked = collectionOf({ path: "Rent.md", name: "Rent", openTasks: 0, finishedTasks: 1 });
		const empty = collectionOf({ path: "Empty.md", name: "Empty", openTasks: 0, finishedTasks: 0 });
		const files = new Map([
			["Rent.md", `## ${layout().tasksHeading}\n- [x] Pay rent 🔁 every month ⏳ 2026-10-01\n`],
			["Empty.md", `## ${layout().tasksHeading}\n`],
			[TODAY_LOG_PATH, dailyLogFrame(layout())],
		]);
		const notes = fakeNotes(files);
		const runDeps = deps(
			fakeCollections([ticked, empty]),
			fakeVault(["Rent.md", "Empty.md", TODAY_LOG_PATH]),
			notes,
			fakeProblems(),
		);

		await runSweep(runDeps, () => null);

		expect(files.get("Rent.md")).toBe(
			[
				`## ${layout().tasksHeading}`,
				"- [ ] Pay rent 🔁 every month ⏳ 2026-11-01",
				"",
				`## ${layout().completedTasksHeading}`,
				"",
				"- [x] Pay rent 🔁 every month ⏳ 2026-10-01",
				"",
			].join("\n"),
		);
		expect(notes.readCounts.has("Empty.md")).toBe(false);
	});
});
