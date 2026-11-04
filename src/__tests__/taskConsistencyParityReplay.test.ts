import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import type { Collection, Collections } from "../core/collections";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import type { CheckboxMeaning, Priority } from "../core/taskLine";
import { editTaskField, parseTaskLine } from "../core/taskLine";
import { isAtxHeading } from "../core/markdownSections";
import { dailyLogPath } from "../core/vaultLayout";
import { snapshotOf, writeMarker } from "../features/taskConsistency/marker";
import { runOverCollection } from "../features/taskConsistency/run";
import type { RunDeps, RunNotes, RunProblems, RunVault } from "../features/taskConsistency/run";
import { taskConsistencyParity } from "./taskConsistencyParityFixture";
import type { NoteLines, ParityScenario } from "./taskConsistencyParityFixture";

/**
 * The parity replay:
 * every one of the old sync engine's 53 named scenarios, run through the
 * real production pipeline (`runOverCollection` — `copyIn`, `rollOver`,
 * `reconcilePair` and `completeInCollection` joined up exactly as one run over
 * a changed file joins them, spec #709
 * decisions 2, 9, 10, 11, 13), and compared to what the old plugin did —
 * except where #709 overturns that answer, named row by row in
 * `taskConsistencyParityFixture.ts`'s own header or listed here from #813's
 * comment on the ticket.
 *
 * **Why field-level, not byte-level.** The old marker (`%% eid:x %%`) and this
 * plugin's (`%% task-consistency:x <hash> %%`) never read alike, so no
 * scenario could ever byte-match regardless of the fixture's own
 * `namedDifferences` tag. What is compared instead, per side, is the *set* of
 * task lines' five travelling fields — checkbox meaning, scheduled, due,
 * priority, tags — the same fields `reconcile.ts`'s `applyFields` and
 * `marker.ts`'s `snapshotOf` already single out as everything that travels —
 * plus, since #946 and
 * #939, which heading each
 * task line sits under and its own indentation depth ({@link
 * StructuredTuple}): comparing only the five fields let a scenario named for a
 * heading move (the move to completed tasks), an orphaned subtask, or a
 * subtree's own indentation (oldLine 1442) pass no matter where the code
 * actually put the line. A task's own words are asserted separately, by
 * substring, because `reconcile.ts:9-16` states plainly that words are never
 * compared and never copied — comparing them field-by-field would be
 * asserting a copy that never happens.
 *
 * **The checkbox's one universal normalisation.** A fresh copy into the log
 * always starts open, whatever the collection's own checkbox reads at copy
 * time (`copyIn.ts`'s own `liveCopyBase`, decision 10's "the collection's own
 * copy is marked `/`" naming only the collection's side). The old plugin's own
 * fixture carries `/` on both copies for an already-paired task. So every log
 * line's `copied` meaning is read as `open` for this replay's own comparison —
 * on both the actual output and the expected side — the same collapse
 * `reconcile.ts`'s own `isBookkeepingMeaning` already makes for reconcile
 * itself; the collection's own `copied` mark is never collapsed, since there
 * it is a real, load-bearing answer to "has this been copied".
 *
 * **Where #709 overturns the old answer without a named-differences row**
 * (#813's comment on #814): a date moved later in the log — lines 211, 369 — is
 * forwarded, not deleted, with the collection edited to follow it (decision
 * 11). A date changed or removed in the collection — lines 720, 746 — edits
 * the log's field rather than removing the line (decision 9). A log line whose
 * date reads today while it still sits under the overdue heading — line 391 —
 * is left exactly where it is, because no field actually differs on the day
 * this snapshot was taken (decision 9 "no field changed"). Line 609 is copied
 * in on this plugin's own event-driven trigger (decision 2), which has no
 * notion of the old "direction" that skipped it. Line 1186's due subtask under
 * an undated parent gets the parent's own context bullet (decision 10), not
 * the old flattened line. Line 930 (`AC-10`) hands this replay's own harness a
 * paired task with no live copy anywhere in the log it is given — the old
 * scenario never needed one, since it tested only its own narrow reconcile
 * step — and `copyIn`'s own re-copy-by-eid rule reads that the same way
 * a deleted line reads: it copies the task in fresh, which this replay asserts
 * rather than treats as a fixture-input error.
 *
 * Every scenario in {@link COPY_IN_SCENARIOS} feeds only `copyIn` directly:
 * `runOverCollection`'s own roll-over look-back finds no earlier day (the
 * fake vault holds none), so nothing there fires, but its own reconcile pass
 * still runs after `copyIn` over whatever `copyIn` produced — harmless for a
 * scenario with no other paired task in view, and exercised deliberately for
 * one that has both (#833-shaped fixtures).
 */

const fixture = taskConsistencyParity();

function layout(): VaultLayout {
	return {
		...defaultData().core.layout,
		dailyLogFolder: "Journal",
		dailyLogFilename: "YYYY-MM-DD",
		tasksHeading: fixture.settings.tasksHeading,
		completedTasksHeading: fixture.settings.completedHeading,
		todayHeading: { text: fixture.settings.todayHeading, level: 2 },
		overdueHeading: { text: fixture.settings.overdueHeading, level: 2 },
	};
}

/** `fixture.settings.today` ("2026-03-25"), read as a local calendar day. */
function fixtureToday(): Date {
	const [year, month, day] = fixture.settings.today.split("-").map(Number);
	return new Date(year, month - 1, day);
}

const COLLECTION_PATH = "My Project.md";

function file(path: string): TFile {
	return { path } as TFile;
}

function fakeNotes(files: Map<string, string>): RunNotes {
	return {
		read: async (target) => {
			const content = files.get(target.path);
			if (content === undefined) throw new Error(`fakeNotes: nothing at ${target.path}`);
			return content;
		},
		edit: async (target, edit) => {
			const next = edit(files.get(target.path) ?? "");
			files.set(target.path, next);
			return next;
		},
	};
}

function fakeVault(paths: readonly string[]): RunVault {
	return { fileAt: (path) => (paths.includes(path) ? file(path) : null) };
}

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
	return { all: () => all, at: (path) => all.find((collection) => collection.path === path) ?? null };
}

/** The old marker, `%% eid:<id> %%` — the fixture's own shape (`taskConsistencyParityFixture.ts`'s header). */
const OLD_MARKER = /\s*%% eid:(\S+) %%/u;

function stripOldMarker(line: string): string {
	return line.replace(OLD_MARKER, "");
}

function collectOldEidLines(lines: NoteLines): Map<string, string> {
	const map = new Map<string, string>();
	for (const line of lines) {
		const found = OLD_MARKER.exec(line);
		if (found !== null) map.set(found[1], line);
	}
	return map;
}

/**
 * `scenario.before`, translated into this plugin's own marker shape, with each
 * marker's hash set from whichever side the scenario's own `editedSide` says
 * was *not* the one edited — the state the pairing was last synced to,
 * exactly as `run.ts`'s own module comment reads "the collection's own
 * marker" for `lastSynced`. `editedSide: "neither"` and `"unstated"` fall back
 * to the collection's own line, matching `reconcilePair`'s own reading of a
 * never-paired task as "the collection is the source" (decision 9).
 */
function translate(scenario: ParityScenario): { collectionText: string; logText: string } {
	const collectionEids = collectOldEidLines(scenario.before.collection);
	const logEids = collectOldEidLines(scenario.before.log);

	function lastSyncedHash(eid: string): string {
		// The unedited side is the last-synced state (`run.ts`'s own reading of
		// "the collection's marker"). A subtask carrying its own marker with no
		// line on the other side at all (a cascade's own child, never
		// individually copied) falls back to its own current line: `logLine ===
		// null` short-circuits `reconcilePair` before `lastSynced` is ever read
		// for that pairing, so which value this returns for it is never
		// observed.
		const source =
			(scenario.editedSide === "log"
				? collectionEids.get(eid)
				: scenario.editedSide === "collection"
					? logEids.get(eid)
					: undefined) ??
			collectionEids.get(eid) ??
			logEids.get(eid);
		if (source === undefined) throw new Error(`${scenario.name}: no before-line carries eid ${eid}`);
		const parsed = parseTaskLine(stripOldMarker(source));
		if (parsed === null) throw new Error(`${scenario.name}: not a task line: ${JSON.stringify(source)}`);
		return snapshotOf(parsed).hash;
	}

	function rewrite(line: string): string {
		const found = OLD_MARKER.exec(line);
		if (found === null) return line;
		return writeMarker(stripOldMarker(line), found[1], lastSyncedHash(found[1]));
	}

	return {
		collectionText: scenario.before.collection.map(rewrite).join("\n"),
		logText: scenario.before.log.map(rewrite).join("\n"),
	};
}

async function runScenario(scenario: ParityScenario): Promise<{ collectionText: string; logText: string }> {
	const { collectionText, logText } = translate(scenario);
	const today = fixtureToday();
	const todayPath = dailyLogPath(today, layout());
	const files = new Map([
		[COLLECTION_PATH, collectionText],
		[todayPath, logText],
	]);
	const collections = fakeCollections([
		{ path: COLLECTION_PATH, name: fixture.settings.collectionName, headingLine: 0, headingLevel: 2, openTasks: 1 },
	]);
	const deps: RunDeps = {
		collections,
		vault: fakeVault([COLLECTION_PATH, todayPath]),
		notes: fakeNotes(files),
		problems: fakeProblems(),
		layout: layout(),
		today,
	};
	await runOverCollection(deps, collections.all()[0]);
	return { collectionText: files.get(COLLECTION_PATH) ?? "", logText: files.get(todayPath) ?? "" };
}

/** The five travelling fields, read for the multiset comparison — never the words, never the marker. */
interface FieldTuple {
	readonly meaning: CheckboxMeaning;
	readonly scheduled: string | null;
	readonly due: string | null;
	readonly priority: Priority | null;
	readonly tags: string;
}

/** `meaning`, with the log side's own `copied` collapsed to `open` — see the module comment. */
/*
 * This collapse exists because of #709's named difference, § Named differences row 9: the
 * old plugin's copy into the day's log starts `[/]`, this plugin's starts `[ ]` — decided by
 * The author on 2026-09-29, #968. It is applied to both sides' log lines, so this replay cannot
 * catch a `[/]` written into the log; the test that pins row 9 is in
 * `taskConsistencyCopyIn.test.ts` ("The re-created log line starts open").
 */
function normaliseForLog(meaning: CheckboxMeaning): CheckboxMeaning {
	return meaning === "copied" ? "open" : meaning;
}

/**
 * A task line's five travelling fields plus the two placement facts #946 and
 * #939 found the plain {@link FieldTuple} comparison blind to: which heading
 * it sits under, and its own indentation depth. Both are read the same way a
 * reader of the rendered note would: the nearest ATX heading line above it
 * (`null` before the first one), lower-cased and trimmed so `## Uppgifter`
 * and a stray extra space still match; and `parsed.indent.length`, the same
 * indent string `buildTree` (`copyIn.ts`) already keys a subtree's depth by.
 */
interface StructuredTuple extends FieldTuple {
	readonly heading: string | null;
	readonly indent: number;
}

/** `line`'s own heading text, lower-cased and trimmed, or `null` when it is not an ATX heading line at all. */
function headingTextOf(line: string): string | null {
	if (!isAtxHeading(line)) return null;
	return line.replace(/^[ \t]{0,3}#{1,6}[ \t]*/u, "").trim().toLowerCase();
}

/**
 * `tuplesOf`, with each task line's own heading and indentation carried
 * alongside its five fields — what #946 and #939 found missing: a scenario
 * about which heading a line ends up under (the move to completed tasks, an
 * orphaned subtask left behind, a log line kept under the overdue heading)
 * or about a subtree's own indentation (oldLine 1442) could not fail without
 * these two read back too.
 */
function structuredTuplesOf(text: string, side: "collection" | "log"): StructuredTuple[] {
	const tuples: StructuredTuple[] = [];
	let heading: string | null = null;
	for (const line of text === "" ? [] : text.split("\n")) {
		const headingText = headingTextOf(line);
		if (headingText !== null) {
			heading = headingText;
			continue;
		}
		const parsed = parseTaskLine(line);
		if (parsed === null) continue;
		tuples.push({
			heading,
			indent: parsed.indent.length,
			meaning: side === "log" ? normaliseForLog(parsed.meaning) : parsed.meaning,
			scheduled: parsed.scheduled,
			due: parsed.due,
			priority: parsed.priority,
			tags: [...parsed.tags].sort().join(","),
		});
	}
	return tuples;
}

function sortedJson(tuples: readonly FieldTuple[]): string {
	return JSON.stringify([...tuples].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

/** A plain bullet — no checkbox — trimmed of its list marker, for a context bullet's own words (decision 10). */
function plainBulletsOf(text: string): string[] {
	return (text === "" ? [] : text.split("\n"))
		.filter((line) => /^[ \t]*[-*+]\s+\S/u.test(line) && parseTaskLine(line) === null)
		.map((line) => line.replace(/^[ \t]*[-*+]\s+/u, "").trim());
}

/**
 * `sideLines`, or an explicit override's replacement, as the text this
 * replay's fields are expected from. `null` (the fixture's own "unchanged")
 * reads as `fallback` — the scenario's own before-text for that side.
 */
function expectedText(after: NoteLines | null, fallback: NoteLines): string {
	return (after ?? fallback).join("\n");
}

/** One scenario's expected answer, built once per side rather than from the raw fixture. */
interface Expected {
	readonly collection: NoteLines;
	readonly log: NoteLines;
}

/**
 * The line `copyIn.ts`'s own `copyTaskLine` produces for a fresh copy of the
 * collection's line carrying `eid` — open checkbox, the collection's own
 * fields, a placeholder marker (this replay compares fields, never the marker
 * text). Used to build this replay's own expectation for a re-copy, never fed
 * to the harness itself.
 */
function freshCopyOf(scenario: ParityScenario, eid: string): string {
	const collectionLine = scenario.before.collection.find((line) => line.includes(`eid:${eid}`));
	if (collectionLine === undefined) throw new Error(`${scenario.name}: no collection line carries eid ${eid}`);
	return editTaskField(stripOldMarker(collectionLine), "checkbox", " ");
}

/**
 * The seven scenarios #813's comment on #814 names as ones #709 overturns
 * without a § *Named differences* row, plus:
 * - oldLine 930 (the harness's own re-copy — see the module comment);
 * - oldLine 345, whose own row 5 ("nothing changes") is itself superseded by
 *   #809, built after
 *   #709 and shipped: `copyIn.ts`'s own module comment states plainly that a
 *   paired task with no live line in the log "is copied again, keeping its
 *   eid" — the opposite of row 5's "nothing changes". The later, built
 *   ticket wins, the same rule #709 itself uses for two disagreeing tickets;
 * - oldLine 116, where the old plugin's `[<]` is not one of this plugin's
 *   five understood checkbox characters (`taskLine.ts`'s own
 *   `CHECKBOX_MEANINGS`) and so reads as an ordinary open task, eligible for
 *   copying like any other (`taskLine.ts`: "any other character is an
 *   ordinary open task whose symbol is left alone");
 * - oldLine 422, § *Named differences* row 4: a hand-typed log task carrying
 *   a collection's link is never auto-filed;
 * - oldLines 1371, 1409 and 1442, on user story 4's own words — "ticking a
 *   task in either file to tick it in both and move it to the collection's
 *   completed section, cascading to its subtasks" — decided by decision 11
 *   ("ticking or cancelling either copy ticks or cancels both… and moves the
 *   collection's task, with its subtree, to the completed-tasks heading") for
 *   the cascade and the move, and decision 9 (`reconcilePair`, run once per
 *   pairing found on the changed lines) for why the subtask's own, separate
 *   pairing is what actually carries its tick to its own log line the same
 *   run, rather than the cascade itself touching the log. Each of these three
 *   is the one shape among the eleven oldLines #936 fixed (below) where a
 *   subtask already has its own live, separately-paired copy in the log
 *   (`[/]`, not merely nested under the parent's own copy the way oldLines
 *   831, 870, 897 and 956's subtasks are, which carry no marker of their own
 *   at all). Once the parent's tick cascades the subtask to `done`/`cancelled`
 *   in the collection, that subtask's own pairing is reconciled the same run
 *   — the log's own `[/]` line is not "unstated" here, it is a real, separate
 *   copy decision 11 requires stay the same as the collection's, so it is
 *   ticked too. The fixture's own `before.log` already pairs each subtask
 *   there (`[/]`, its own eid); what the old plugin's `after.log: null`
 *   actually shows is that it never *ticked* that paired subtask, not that it
 *   never paired one — that narrower fact is superseded.
 *
 * **The final count, after #936's fix**: 14 of the fixture's 53 scenarios
 * assert #709's own answer instead of the old plugin's — down from 22 before
 * that fix. Eight of the eleven `copyIn` masked now match the fixture's own
 * `after` and need no override; the other three of the eleven keep the
 * override explained just above. oldLine 345, never one of the eleven, keeps
 * the override it always needed, unaffected by that fix.
 *
 * **Five more, after #946/#939's fix**: comparing heading and indentation
 * (see {@link StructuredTuple}) found five re-indent scenarios — oldLines
 * 1269, 1300, 1492, 1520 and 1547 — whose own `after` the field-only
 * comparison could not tell apart from `before`, and which needed their own
 * override the moment indentation was read back: see the comment directly
 * above the loop that adds them. oldLine 930's own override changed again
 * after #950: the author's
 * answer settled that an independently-completed subtask waits for its
 * still-open parent, so it now stays under `## Uppgifter` beside it rather
 * than moving alone — see the comment on its own entry below. Nineteen
 * scenarios in total now diverge from the fixture's own `after`.
 *
 * Every other scenario's expectation is the fixture's own `after`, unchanged —
 * including, since #936's
 * fix, eight of the eleven scenarios (oldLines 234, 264, 283, 316, 831, 870,
 * 897, 956) that once asserted `copyIn`'s own confirmed-buggy answer here: a
 * `[x]`/`[-]` tick made directly in the log, on a task the collection still
 * reads `copied`, was re-copied fresh and open by `copyIn` before
 * `reconcileAll` ever saw the tick, and `reconcileAll`'s own `locateLiveLogLine`
 * then found that duplicate first — the tick never reached the collection,
 * this run or any later one. `collectLogEids` now reads a `[x]`/`[-]` log line
 * as live (the task is finished, not missing), so `copyIn` no longer re-copies
 * it, and these eight now match the fixture's own `after` like any other
 * scenario. The other three of the eleven — oldLines 1371, 1409 and 1442 —
 * still need their own override, for the reason given just above. oldLine 345
 * is not one of the eleven at all, on its own evidence: its own `before.log`
 * carries no line at all for the eid (a genuinely deleted line, not a
 * `[x]`/`[-]` one), so it was never the duplicate-masking shape #936 found —
 * it is #809's re-copy-by-eid rule, unaffected by this fix, and keeps its own
 * override below.
 */
const OVERRIDES = new Map<number, Expected>([
	[
		211,
		{
			collection: ["## Uppgifter", "- [/] Task A ⏳ 2026-03-26 %% eid:meta01 %%"],
			log: ["## Att göra idag", "- [>] Task A ⏳ 2026-03-26 [[My Project]] %% eid:meta01 %%"],
		},
	],
	[
		369,
		{
			collection: ["## Uppgifter", "- [/] Postponed ⏳ 2026-03-26 %% eid:post01 %%"],
			log: ["## Att göra idag", "- [>] Postponed ⏳ 2026-03-26 [[My Project]] %% eid:post01 %%"],
		},
	],
	[
		720,
		{
			collection: ["## Uppgifter", "- [/] Postponed ⏳ 2026-03-26 %% eid:2c03 %%"],
			log: ["## Att göra idag", "- [/] Postponed ⏳ 2026-03-26 [[My Project]] %% eid:2c03 %%"],
		},
	],
	[
		746,
		{
			collection: ["## Uppgifter", "- [/] No date anymore %% eid:2c04 %%"],
			log: ["## Att göra idag", "- [/] No date anymore [[My Project]] %% eid:2c04 %%"],
		},
	],
	[
		391,
		{
			collection: ["## Uppgifter", "- [/] Was late ⏳ 2026-03-25 %% eid:late01 %%"],
			log: ["## Försenade", "- [/] Was late ⏳ 2026-03-25 [[My Project]] %% eid:late01 %%", "", "## Att göra idag", ""],
		},
	],
	[
		609,
		{
			collection: ["## Uppgifter", "- [/] New task ⏳ 2026-03-25 %% eid:x %%"],
			log: ["## Att göra idag", "- [ ] New task ⏳ 2026-03-25 [[My Project]] %% eid:x %%"],
		},
	],
	[
		1186,
		{
			collection: ["## Uppgifter", "- [ ] Parent no date", "\t- [/] Child with date ⏳ 2026-03-25 %% eid:x %%"],
			log: ["## Att göra idag", "- Parent no date", "\t- [ ] Child with date ⏳ 2026-03-25 [[My Project]] %% eid:x %%"],
		},
	],
	[
		930,
		{
			// `up02` is already `[x]` in the fixture's own before-text, with no
			// event this run — decision 11's "ticking or cancelling either copy…
			// moves the collection's task… to the completed-tasks heading" is
			// read by `completeInCollection` (`complete.ts`) as a sweep over
			// every marked eid whose collection meaning already reads done or
			// cancelled, on every run, not only the one where the tick happened
			// (its own module comment: "the caller is meant to invoke this only
			// once… but this module does not trust that"). The author's answer on
			// #950,
			// 2026-09-29, settles what #709 left open: `up02` waits for its
			// still-open parent `up01` and stays exactly where it is, under
			// `## Uppgifter`, at its own indentation, rather than moving alone —
			// so no `## Slutförda uppgifter` heading is written at all, since
			// nothing moved to need one. `up01` itself is untouched by this (the
			// scenario's own point, "cascade does NOT go upward") but does gain
			// a fresh log copy, since it is due today and unpaired-live
			// (decision 10).
			collection: [
				"## Uppgifter",
				"- [/] Parent stays open ⏳ 2026-03-25 %% eid:up01 %%",
				"\t- [x] Already done subtask %% eid:up02 %%",
			],
			log: ["## Att göra idag", "- [ ] Parent stays open ⏳ 2026-03-25 [[My Project]] %% eid:up01 %%"],
		},
	],
	[
		116,
		{
			collection: [
				"## Uppgifter",
				"- [>] Forwarded task ⏳ 2026-03-25",
				"- [/] Scheduled task ⏳ 2026-03-25 %% eid:x %%",
			],
			log: ["## Att göra idag", "- [ ] Scheduled task ⏳ 2026-03-25 [[My Project]] %% eid:x %%"],
		},
	],
	[
		422,
		{
			collection: ["## Uppgifter", "- [ ] Existing task"],
			log: ["## Att göra idag", "- [ ] Brand new task [[My Project]]"],
		},
	],
	[
		1371,
		{
			collection: [
				"## Uppgifter",
				"",
				"## Slutförda uppgifter",
				"- [x] Parent task ⏳ 2026-03-25 %% eid:ac1a %%",
				"\t- [x] Child A ⏳ 2026-03-25 %% eid:ac1b %%",
				"\t- [x] Child B ⏳ 2026-03-25 %% eid:ac1c %%",
			],
			log: [
				"## Att göra idag",
				"- [x] Parent task ⏳ 2026-03-25 [[My Project]] %% eid:ac1a %%",
				"\t- [x] Child A ⏳ 2026-03-25 [[My Project]] %% eid:ac1b %%",
				"\t- [x] Child B ⏳ 2026-03-25 [[My Project]] %% eid:ac1c %%",
			],
		},
	],
	[
		1409,
		{
			collection: [
				"## Uppgifter",
				"",
				"## Slutförda uppgifter",
				"- [x] Parent task ⏳ 2026-03-25 %% eid:ac1d %%",
				"\t- [x] Child A ⏳ 2026-03-25 %% eid:ac1e %%",
				"\t- [x] Child B ⏳ 2026-03-25 %% eid:ac1f %%",
			],
			log: [
				"## Att göra idag",
				"- [x] Parent task ⏳ 2026-03-25 [[My Project]] %% eid:ac1d %%",
				"\t- [x] Child A ⏳ 2026-03-25 [[My Project]] %% eid:ac1e %%",
				"\t- [x] Child B ⏳ 2026-03-25 [[My Project]] %% eid:ac1f %%",
			],
		},
	],
	[
		1442,
		{
			collection: [
				"## Uppgifter",
				"",
				"## Slutförda uppgifter",
				"- [x] Parent ⏳ 2026-03-25 %% eid:ac2a %%",
				"\t- [x] Child ⏳ 2026-03-25 %% eid:ac2b %%",
				"\t\t- [x] Grandchild ⏳ 2026-03-25 %% eid:ac2c %%",
			],
			log: [
				"## Att göra idag",
				"- [x] Parent ⏳ 2026-03-25 [[My Project]] %% eid:ac2a %%",
				"\t- [x] Child ⏳ 2026-03-25 [[My Project]] %% eid:ac2b %%",
				"\t\t- [x] Grandchild ⏳ 2026-03-25 [[My Project]] %% eid:ac2c %%",
			],
		},
	],
]);

{
	const scenario345 = fixture.scenarios.find((candidate) => candidate.oldLine === 345);
	if (scenario345 === undefined) throw new Error("no fixture scenario at oldLine 345");
	OVERRIDES.set(345, {
		collection: scenario345.before.collection,
		log: [...scenario345.before.log, freshCopyOf(scenario345, "del001")],
	});
}

/**
 * A re-indent, on either side, stays exactly where it was typed and never
 * travels to the other side — decision 9's own bullet, "re-indenting a task
 * inside the log stays in the log," and `reconcile.ts:9-16`'s "either line's
 * indentation… is never compared and never copied." #946/#939: comparing
 * indentation at all is what surfaces these five — the old plugin's own
 * fixture propagates a re-indent the other way (`reconcileByHierarchy`,
 * superseded whole), and the field-only comparison this replay used before
 * could not see indentation differ, so these five passed against the old
 * plugin's own `after` by accident. Each override below is the scenario's own
 * `before`, unchanged on both sides — nothing else about these six lines was
 * edited, so once indentation is taken out of what travels, there is nothing
 * left to reconcile.
 */
for (const oldLine of [1269, 1300, 1492, 1520, 1547]) {
	const scenario = fixture.scenarios.find((candidate) => candidate.oldLine === oldLine);
	if (scenario === undefined) throw new Error(`no fixture scenario at oldLine ${oldLine}`);
	OVERRIDES.set(oldLine, { collection: scenario.before.collection, log: scenario.before.log });
}

/** Every scenario `oldLine` this replay asserts #709's own answer for instead of the old plugin's. */
const OVERRIDE_LINES = [...OVERRIDES.keys()].sort((a, b) => a - b);

describe("task consistency parity replay", () => {
	it("holds the fixture to the counts #813 recorded", () => {
		expect(fixture.source.commit).toBe("3a1deba861e94481046d74e65ddc40dceb3b2180");
		expect(fixture.assertions.total).toBe(245);
		expect(fixture.assertions.kept).toBe(241);
		expect(fixture.assertions.dropped.breadcrumb).toBe(4);
		expect(fixture.assertions.dropped.rebuildShape).toBe(0);
		expect(fixture.scenarios).toHaveLength(53);
	});

	it("diverges from the fixture's own `after` for exactly the scenarios named in the module comment", () => {
		expect(OVERRIDE_LINES).toEqual([
			116, 211, 345, 369, 391, 422, 609, 720, 746, 930, 1186, 1269, 1300, 1371, 1409, 1442, 1492, 1520, 1547,
		]);
	});

	for (const scenario of fixture.scenarios) {
		it(`#${scenario.oldLine} ${scenario.name}`, async () => {
			const override = OVERRIDES.get(scenario.oldLine);
			const expected: Expected = override ?? {
				collection: (scenario.after.collection ?? scenario.before.collection) as NoteLines,
				log: (scenario.after.log ?? scenario.before.log) as NoteLines,
			};

			const actual = await runScenario(scenario);

			expect(sortedJson(structuredTuplesOf(actual.collectionText, "collection"))).toBe(
				sortedJson(structuredTuplesOf(expectedText(expected.collection, scenario.before.collection), "collection")),
			);
			expect(sortedJson(structuredTuplesOf(actual.logText, "log"))).toBe(
				sortedJson(structuredTuplesOf(expectedText(expected.log, scenario.before.log), "log")),
			);
			expect(plainBulletsOf(actual.logText).sort()).toEqual(
				plainBulletsOf(expectedText(expected.log, scenario.before.log)).sort(),
			);

			// Words never travel between copies (reconcile.ts:9-16): each side's
			// own before-words must still be present in that same side's own
			// output, whether or not this scenario changed anything else about it.
			for (const line of scenario.before.collection) {
				const parsed = parseTaskLine(stripOldMarker(line));
				if (parsed === null) continue;
				const words = parsed.description.trim();
				if (words.length === 0) continue;
				expect(actual.collectionText).toContain(words.split(/\s*(?:⏳|📅|🔺|⏫|🔼|🔽|⏬)/u)[0].trim());
			}
			for (const line of scenario.before.log) {
				const parsed = parseTaskLine(stripOldMarker(line));
				if (parsed === null) continue;
				const words = parsed.description.trim();
				if (words.length === 0) continue;
				expect(actual.logText).toContain(words.split(/\s*(?:⏳|📅|🔺|⏫|🔼|🔽|⏬)/u)[0].trim());
			}
		});
	}
});

/**
 * A composition no single-call test above exercises: the real
 * sweep, `runOverCollection` (`copyIn`, `reconcileAll`, `completeInCollection`
 * joined), run twice, with a hand edit to the collection between the two
 * runs — the shape #954's own "sequence, inferred from the code" describes.
 * Every collection, note and task below is invented.
 */
describe("a subtask waits for its parent across two real runs", () => {
	function subtaskLayout(): VaultLayout {
		return { ...defaultData().core.layout, dailyLogFolder: "Household", dailyLogFilename: "YYYY-MM-DD" };
	}

	it("never moves a marked, done subtask alone: it waits under its open, unmarked parent, and goes with the parent once the parent is hand-ticked too", async () => {
		const COLLECTION_PATH = "Chores.md";
		const today = new Date(2026, 8, 22);
		const todayLogPath = dailyLogPath(today, subtaskLayout());

		const eid = "basket-1";
		const subtaskFields = parseTaskLine("- [x] Buy the basket");
		if (subtaskFields === null) throw new Error("fixture line does not parse");
		const hash = snapshotOf(subtaskFields).hash;

		// The parent carries no marker at all — it has no date, so `copyIn` never
		// made it a candidate and it was never copied to any log (#954's own
		// "a parent with no date is never marked").
		const collectionBefore = [
			"## Tasks",
			"",
			"- [ ] Plan the picnic",
			"\t" + writeMarker("- [x] Buy the basket", eid, hash),
			"## Completed tasks",
			"",
		].join("\n");
		const logBefore = writeMarker("- [x] Buy the basket", eid, hash);

		const files = new Map([
			[COLLECTION_PATH, collectionBefore],
			[todayLogPath, logBefore],
		]);
		const collections = fakeCollections([
			{ path: COLLECTION_PATH, name: "Chores", headingLine: 0, headingLevel: 2, openTasks: 1 },
		]);
		const deps: RunDeps = {
			collections,
			vault: fakeVault([COLLECTION_PATH, todayLogPath]),
			notes: fakeNotes(files),
			problems: fakeProblems(),
			layout: subtaskLayout(),
			today,
		};

		await runOverCollection(deps, collections.all()[0]);
		// Nothing to reconcile yet: the child is already done on both sides and
		// its parent is still open, so the first run is a no-op — the sweep's
		// own baseline, #950's rule already covers this shape.
		expect(files.get(COLLECTION_PATH)).toBe(collectionBefore);

		// The person ticks the still-unmarked parent by hand — the plugin never
		// sees this line as a candidate to copy or reconcile.
		const collectionParentTicked = (files.get(COLLECTION_PATH) ?? "").replace(
			"- [ ] Plan the picnic",
			"- [x] Plan the picnic",
		);
		files.set(COLLECTION_PATH, collectionParentTicked);

		await runOverCollection(deps, collections.all()[0]);

		// The parent carries no marker, so it is never `completeInCollection`'s
		// subject; since #1261 it is moved by the run's pass over unpaired
		// finished tasks instead (the owner's go-ahead on #1261, 2026-11-04, on
		// this test's earlier expectation that both lines stayed put). The subtask goes with
		// it, directly beneath it. A pre-#954 run would have moved "Buy the
		// basket" by itself, and a run without #1261 would have left both lines
		// under "## Tasks"; either way this exact string would not match.
		expect(files.get(COLLECTION_PATH)).toBe(
			[
				"## Tasks",
				"",
				"## Completed tasks",
				"- [x] Plan the picnic",
				"\t" + writeMarker("- [x] Buy the basket", eid, hash),
				"",
			].join("\n"),
		);
	});
});
