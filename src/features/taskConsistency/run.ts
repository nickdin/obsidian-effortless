/**
 * One run over a changed file: task consistency's whole job, joined up from
 * the pure pieces the earlier tickets built (spec
 * #709 decisions 2, 9, 10,
 * 11 and 13, ticket #810).
 *
 * **This module decides nothing about what one task's line should read.**
 * That is `reconcile.ts`, `copyIn.ts`, `rollOver.ts` and `complete.ts`'s job,
 * one layer down; this module only orders the calls and carries out what they
 * decided — a read through `host.notes.read`, a write through
 * `host.notes.edit`, a report through `host.problems`, always through the
 * queued writer and never through the vault directly.
 *
 * **The shape is the meeting-notes run's** (`meetingNotes/run.ts`): the
 * Obsidian half arrives as narrow ports rather than the real `Collections`,
 * `NoteWriter` and `FeatureProblems` themselves, so every test here exercises
 * this module against fakes of the three; `taskConsistency.ts` is the only
 * file that wires the real ones in.
 *
 * **Which marker is `lastSynced`.** The collection's own marker,
 * always. `reconcilePair` only advances the marker on the side it edits, so a
 * naive read of "the collection's marker" would go stale the moment the
 * collection is the *source* of a change (the log follows it, and only the
 * log's own marker moves) — a second, later collection edit would then read
 * as a clash against a log that is merely one step behind. {@link syncPairing}
 * closes that gap: after every non-clash reconcile, it refreshes the
 * collection's own marker to the hash its current content actually snapshots
 * to, whenever that differs from what the marker already says — whether
 * because the collection was the source (its marker never moved) or because
 * both sides changed and independently agreed (neither moved). The plain
 * two-run test in `taskConsistencyRun.test.ts` — an edit, a run, then a
 * second run with nothing further changed — passes even with `syncPairing`
 * made a passthrough (wave 4's own mutation, #852): after one edit both
 * sides hash equal and `fieldsAgree` short-circuits before this choice is
 * ever exercised. "collection edit, run, collection edit again, run: no
 * clash, and the second edit lands" is the one that fails if this
 * choice is wrong — a second, independent collection edit between two runs,
 * which a stale collection marker misreads as a clash against the log.
 */

import type { TFile } from "obsidian";
import type { Collection, Collections } from "../../core/collections";
import { reasonOf } from "../../core/reason";
import type { VaultLayout } from "../../core/settings";
import { dateStampText, parseTaskLine, repeatQuote } from "../../core/taskLine";
import type { TaskLine } from "../../core/taskLine";
import { dailyLogPath } from "../../core/vaultLayout";
import { completeInCollection } from "./complete";
import { copyIn } from "./copyIn";
import { finishUnpaired } from "./finishUnpaired";
import { collectionLinktextOf, locatePairedLine } from "./jump";
import { readMarker, snapshotOf, writeMarker } from "./marker";
import type { SyncedSnapshot } from "./marker";
import { reconcilePair } from "./reconcile";
import type { ReconcileResult } from "./reconcile";
import { freezeIfRescheduled, rollOver } from "./rollOver";
import { roundStep } from "./round";
import type { LeftAlone, RoundResult } from "./round";

/** The vault, narrowed to what one run needs: resolving a computed path to the `TFile` a write goes through. */
export interface RunVault {
	/** The `TFile` at `path` right now, or `null` when nothing is there. */
	fileAt(path: string): TFile | null;
}

/** The core's queued writer, narrowed to the two calls a run ever reaches for. */
export interface RunNotes {
	/** `file`'s current text — joins the same per-path queue `edit` uses (`noteWriter.ts:159-161`), so a read issued after a queued write to that path sees the write's own result, never a stale one. */
	read(file: TFile): Promise<string>;
	/** Rewrites `file` by handing its current text to `edit` and storing what comes back. */
	edit(file: TFile, edit: (content: string) => string): Promise<string>;
}

/** How one run says something is wrong, and has it stop being said. */
export interface RunProblems {
	report(key: string, message: string): void;
	clear(key: string): void;
	/**
	 * Every key this feature currently has standing, so a run can tell a
	 * pairing or a path it no longer visits apart from one still in front of
	 * it — the same shape building the days ahead's and meeting notes' own
	 * `RunProblems.list` keep, for the same reason (`FeatureProblems` itself
	 * has no route back to what is standing).
	 */
	list(): readonly string[];
}

export interface RunDeps {
	readonly collections: Collections;
	readonly vault: RunVault;
	readonly notes: RunNotes;
	readonly problems: RunProblems;
	readonly layout: VaultLayout;
	/** Now, read once by the caller — never the clock inside. */
	readonly today: Date;
	/**
	 * Runs `run` for `path` under whatever per-file lock the caller keeps,
	 * skipping it outright when `path` is already locked elsewhere — the same
	 * "one run per file at a time" rule #687 decision 4 states. Every
	 * collection this module reaches beyond the one a caller already locked
	 * for itself goes through this: the sweep's own direct list, and a
	 * log-named collection {@link checkLogFile} resolves. Left undefined by
	 * every test here, since none has a second run to collide with; the real
	 * feature (`taskConsistency.ts`) supplies its own {@link
	 * TaskConsistency.guardedRun}.
	 */
	readonly guard?: (path: string, run: () => Promise<void>) => Promise<void>;
}

/** {@link RunDeps.guard}'s own default: runs `run` unconditionally. */
async function defaultGuard(_path: string, run: () => Promise<void>): Promise<void> {
	await run();
}

/** How many days {@link runOverCollection} looks back for a log carrying a still-live pairing, newest first. Named rather than unbounded: a vault with years of daily logs should not be walked in full on every run. */
const ROLLOVER_LOOKBACK_DAYS = 14;

/** `today`, `daysBack` calendar days earlier, at local midnight. */
function daysBefore(today: Date, daysBack: number): Date {
	return new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysBack);
}

/** Whether `key` reads as a clash's own eid — `marker.ts`'s own `newEid`'s format, base36 digits and lowercase letters only. Never a path (always carrying at least a `.md` extension) or a prefixed key (always carrying a colon), so this is safe to use as "a standing key only `reconcileAll`'s own clash report could have raised". */
function looksLikeEid(key: string): boolean {
	return /^[0-9a-z]+$/u.test(key);
}

/** The key prefixes the three standing problems of a repeat rule are raised under; the first two continue with `<collection path>:<the line's words>`, the third with the path alone. */
const REPEAT_NO_DATE_KEY = "repeat-no-date:";
const REPEAT_UNREADABLE_KEY = "repeat-unreadable:";
const REPEAT_NO_COMPLETED_HEADING_KEY = "repeat-no-completed-heading:";

/** The line's words as a person reads them: its text after the checkbox, without any `%% … %%` comment (the pairing marker is one), so a report never says how the line came to be paired. */
function lineWords(raw: string): string {
	const task = requireTaskLine(raw);
	return squeezed(task.description, task.comments);
}

/**
 * {@link lineWords} without the line's ⏳ and 📅 stamps, the one thing besides
 * the pairing marker the plugin itself moves on a line: a task postponed from
 * either copy is the same fault, not a new one. A key is built from
 * this; a message still quotes {@link lineWords}.
 */
function lineWordsWithoutDates(raw: string): string {
	const task = requireTaskLine(raw);
	const stamps: string[] = [];
	if (task.scheduled !== null) stamps.push(dateStampText("scheduled", task.scheduled));
	if (task.due !== null) stamps.push(dateStampText("due", task.due));
	return squeezed(task.description, [...task.comments, ...stamps]);
}

/** `text` with each of `removed` replaced by a space and the whitespace left squeezed to single spaces. */
function squeezed(text: string, removed: readonly string[]): string {
	let words = text;
	for (const fragment of removed) words = words.replace(fragment, " ");
	return words.replace(/\s+/gu, " ").trim();
}

/** The report a recurring line the round step left alone raises, or null for a reason that is not one of the three standing problems (`no-next-date`, spec #1222 decision 8). */
function repeatReportOf(left: LeftAlone, collection: Collection): { key: string; message: string } | null {
	if (left.reason === "no-date") {
		const words = lineWords(left.text);
		return {
			key: `${REPEAT_NO_DATE_KEY}${collection.path}:${lineWordsWithoutDates(left.text)}`,
			message: `a task in "${collection.name}" repeats but has no date, so no round can be planned: "${words}". The line is untouched; give it a ⏳ or 📅 date.`,
		};
	}
	if (left.reason === "unreadable-rule") {
		const words = lineWords(left.text);
		return {
			key: `${REPEAT_UNREADABLE_KEY}${collection.path}:${lineWordsWithoutDates(left.text)}`,
			message: `a task in "${collection.name}" has a repeat rule Effortless cannot read, "${repeatQuote(left.rule)}", so it is treated as a task that does not repeat: "${words}". The line is untouched.`,
		};
	}
	return null;
}

/**
 * Raises the standing problems a repeat rule can raise in `collection`, and
 * clears every one of its keys the round step's answer no longer supports: a line that gained a date, a rule that became
 * readable, a line that was removed or reworded, a heading that was named, the
 * last recurring task gone. Nothing is written into a note.
 *
 * Keyed by the line's words rather than its position, so a line moving keeps
 * its key and a reworded line retires it. A line the run holds untouched (a
 * clash) is read for its fault but never rounded ({@link RoundResult.held}),
 * so its key stands for as long as the fault does. A finished line with
 * an unreadable rule is moved under the completed-tasks heading in the same
 * run, and `reconcileAll` leaves it out of the answer, so its key clears in
 * that run, paired or not.
 */
function reportRepeatProblems(problems: RunProblems, collection: Collection, rounded: RoundResult): void {
	const wanted = new Map<string, string>();
	for (const left of [...rounded.leftAlone, ...rounded.held]) {
		const report = repeatReportOf(left, collection);
		if (report !== null) wanted.set(report.key, report.message);
	}
	if (rounded.repeatsWithBlankHeading) {
		wanted.set(
			`${REPEAT_NO_COMPLETED_HEADING_KEY}${collection.path}`,
			`a task in "${collection.name}" repeats, but the completed-tasks heading is blank, so no round can be planned. Name one in the collections settings.`,
		);
	}
	for (const key of problems.list()) {
		if (!wanted.has(key) && isRepeatKeyOf(key, collection.path)) problems.clear(key);
	}
	for (const [key, message] of wanted) problems.report(key, message);
}

/** Whether `key` is one of the three repeat-rule keys raised for the collection at `path`. */
function isRepeatKeyOf(key: string, path: string): boolean {
	return (
		key.startsWith(`${REPEAT_NO_DATE_KEY}${path}:`) ||
		key.startsWith(`${REPEAT_UNREADABLE_KEY}${path}:`) ||
		key === `${REPEAT_NO_COMPLETED_HEADING_KEY}${path}`
	);
}

/** Whether `key` is a repeat-rule key of a collection `collections` still lists — the sweep clears the rest. */
function isRepeatKeyOfAnyOf(key: string, paths: readonly string[]): boolean {
	return paths.some((path) => isRepeatKeyOf(key, path));
}

/** Whether `key` has the shape of any repeat-rule key, whichever collection it names. */
function isRepeatKey(key: string): boolean {
	return (
		key.startsWith(REPEAT_NO_DATE_KEY) ||
		key.startsWith(REPEAT_UNREADABLE_KEY) ||
		key.startsWith(REPEAT_NO_COMPLETED_HEADING_KEY)
	);
}

/** Parses `raw`, throwing rather than returning null — every caller here hands in a line already known to be a task. */
function requireTaskLine(raw: string): TaskLine {
	const parsed = parseTaskLine(raw);
	if (parsed === null) throw new Error(`not a task line: ${JSON.stringify(raw)}`);
	return parsed;
}

/** Every eid a marker in `text` carries, in the order found — first occurrence only, matching `setComment`'s own first-wins rule. */
function markedEids(text: string): string[] {
	const seen = new Set<string>();
	const eids: string[] = [];
	for (const line of text === "" ? [] : text.split("\n")) {
		const parsed = parseTaskLine(line);
		if (parsed === null) continue;
		const marker = readMarker(parsed);
		if (marker === null || seen.has(marker.eid)) continue;
		seen.add(marker.eid);
		eids.push(marker.eid);
	}
	return eids;
}

/**
 * `reconcilePair`, with the collection's own marker kept fresh afterwards
 * (see the module comment). Never touches the log's marker beyond what
 * `reconcilePair` itself already decided — only the collection's.
 */
function syncPairing(collectionLine: string, logLine: string | null, lastSynced: SyncedSnapshot | null): ReconcileResult {
	const result = reconcilePair(collectionLine, logLine, lastSynced);
	if (result.clash) return result;

	const finalCollectionRaw = result.collection ?? collectionLine;
	const finalCollection = requireTaskLine(finalCollectionRaw);
	const marker = readMarker(finalCollection);
	const freshHash = snapshotOf(finalCollection).hash;
	if (marker !== null && marker.hash === freshHash) return result;

	const eid = marker?.eid ?? readMarker(requireTaskLine(collectionLine))?.eid;
	if (eid === undefined) return result;

	return { ...result, collection: writeMarker(finalCollectionRaw, eid, freshHash) };
}

/** The words a clash's own settings line reads, on one side. */
function wordsOf(raw: string): string {
	return requireTaskLine(raw).description.trim();
}

/**
 * The message a clash raises through `host.problems` — one `Notice` the first
 * time, one settings line kept until it clears. `logLabel` names which log
 * disagrees: `"today's log"` for `reconcileAll`'s own clash, or the earlier
 * day's log by path for `reconcileAgainstOldLog`'s — folded into one
 * function (#967 standards review) since both read each side's own words off
 * the raw line they were handed, never a shared wording.
 */
function clashMessage(collectionRaw: string, logRaw: string, logLabel = "today's log"): string {
	return (
		`a task was edited in both places and now disagrees: the collection reads "${wordsOf(collectionRaw)}", ` +
		`and ${logLabel} reads "${wordsOf(logRaw)}". Neither was changed; edit one to match the other.`
	);
}

/** Replaces the line at `index` in `lines`, returning a fresh array — `lines` itself is never mutated. */
function withLine(lines: readonly string[], index: number, value: string): string[] {
	const next = [...lines];
	next[index] = value;
	return next;
}

/**
 * The line in `logText` carrying `eid`'s marker, whose own checkbox does not
 * read forwarded — `locatePairedLine`'s own "first wins" rule (`./jump`), but
 * skipping every `[>]` line first: a frozen line is never the live
 * copy to reconcile against, whatever order it sits in relative to the live
 * one. Answers `null`, the same as "not yet copied", when every instance of
 * the eid is frozen.
 *
 * Written here rather than in `jump.ts`: that module's own `locatePairedLine`
 * is the jump command's, unfiltered on purpose — the line a person is
 * jumping to may itself be the frozen one they are looking at.
 */
function locateLiveLogLine(logText: string, eid: string): number | null {
	const lines = logText === "" ? [] : logText.split("\n");
	for (let at = 0; at < lines.length; at += 1) {
		const parsedLine = parseTaskLine(lines[at]);
		if (parsedLine === null || parsedLine.meaning === "forwarded") continue;
		const marker = readMarker(parsedLine);
		if (marker !== null && marker.eid === eid) return at;
	}
	return null;
}

/**
 * The line in `oldLogText` carrying `eid`'s marker whose own meaning already
 * reads `done` or `cancelled` — never `open`, `copied` or `forwarded`.
 *
 * Every other meaning reaching this point is `rollOver`'s own case, already
 * decided there: an `open` or `copied` candidate is either rolled forward and
 * frozen, or left exactly as it is by one of `rollOver`'s own guards (#840, a
 * missing relevant date, a missing collection line) — none of that is this
 * function's to revisit. Only a genuine finish, ticked or cancelled directly
 * in that day's log, is read here.
 */
function finishedOldLogLine(oldLogText: string, eid: string): string | null {
	for (const line of oldLogText === "" ? [] : oldLogText.split("\n")) {
		const parsedLine = parseTaskLine(line);
		if (parsedLine === null) continue;
		if (parsedLine.meaning !== "done" && parsedLine.meaning !== "cancelled") continue;
		const marker = readMarker(parsedLine);
		if (marker !== null && marker.eid === eid) return line;
	}
	return null;
}

/**
 * `collectionText`, with every paired task synced against a genuine finish
 * sitting in `oldLogText` — `rollOver`'s own "earlier day". Also
 * returns which eids it found clashing, so the caller can hold them out of
 * `copyIn` and `reconcileAll` for the rest of this run — see {@link
 * runOverCollection}.
 *
 * **Why this has to run before `copyIn`.** #936 keeps `copyIn` from re-copying
 * a task ticked directly in *today's* log by having `collectLogEids` read a
 * `[x]`/`[-]` line as live; `copyIn`'s own call only ever reads today's log,
 * so a tick made in an *earlier* day's log — one no run has seen yet, the
 * ordinary case for an evening tick after the desktop closes, or one made from
 * a phone — is a day early for that rule to reach. Syncing
 * the collection here first does the same job one call earlier: once the
 * collection's own line reads `done` or `cancelled`, `copyIn`'s own `category`
 * guard already excludes a paired line whose meaning is neither `copied` nor
 * `open`, so nothing is re-copied, and `reconcileAll`'s own sweep (the one
 * #930's scenario exercises) then moves it to the completed-tasks heading
 * exactly as it would for a tick found today — whether or not today's log
 * ever carries a live copy of it at all.
 *
 * **On a clash, this reports it and edits neither side** — the same
 * "neither side is edited" `reconcilePair` already answers for two sides that
 * disagree, but reported now rather than left silent: before #951 a clash
 * found here raised nothing, so it never reached the settings screen the way
 * a clash against today's log already does (#709's clash rule). Reported
 * through `problems`, keyed by the pairing's own eid — the same key
 * `reconcileAll`'s own today's-log clash uses (`GLOSSARY.md`'s *Standing
 * problem* entry names one clash kind, keyed by eid, not two). **What used to
 * make sharing that key unsafe no longer holds.** Before this fix,
 * `reconcileAll`'s own loop still iterated a held eid regardless, and
 * unconditionally cleared it the moment today's log carried no live copy — the
 * ordinary case here, since a task finished in an old log is not rolled
 * forward — erasing this report in the very same run; `copyIn` likewise still
 * treated a still-`copied` collection line as due and re-copied it. Now the
 * eids this function returns are held out of both — see {@link
 * runOverCollection} and `copyIn`'s own `heldEids` — so nothing else in this
 * run touches the pairing while it is held, and the two clash kinds can
 * safely share one namespace.
 *
 * **Clearing.** A held eid whose earlier log's line no longer reads a genuine
 * finish — the person un-ticks it, or the day has moved on so a different,
 * closer log is now the nearest earlier one and this eid is not finished
 * there either — is cleared the moment this function next finds that: every eid it visits either gets reported again or cleared, there is
 * no third state. A collection line deleted outright is never visited by this
 * loop at all, since `markedEids` drives it from the collection's own current
 * text — that case is left to the sweep that already clears a bare eid its
 * own pass never sees (`runSweep`'s own purge, `looksLikeEid`), which the
 * shared eid key now participates in for free.
 */
function reconcileAgainstOldLog(
	collectionText: string,
	oldLogText: string,
	oldLogPath: string,
	problems: RunProblems,
): { readonly collection: string; readonly heldEids: ReadonlySet<string> } {
	let collection = collectionText === "" ? [] : collectionText.split("\n");
	const heldEids = new Set<string>();

	for (const eid of markedEids(collection.join("\n"))) {
		const collectionIndex = locatePairedLine(collection.join("\n"), eid);
		if (collectionIndex === null) continue;
		const collectionLine = collection[collectionIndex];

		const finishedLine = finishedOldLogLine(oldLogText, eid);
		if (finishedLine === null) {
			problems.clear(eid);
			continue;
		}

		const marker = readMarker(requireTaskLine(collectionLine));
		const lastSynced: SyncedSnapshot | null = marker === null ? null : { hash: marker.hash };
		const result = syncPairing(collectionLine, finishedLine, lastSynced);
		if (result.clash) {
			problems.report(eid, clashMessage(collectionLine, finishedLine, `the log at "${oldLogPath}"`));
			heldEids.add(eid);
			continue;
		}
		problems.clear(eid);
		if (result.collection === null) continue;

		collection = withLine(collection, collectionIndex, result.collection);
	}

	return { collection: collection.join("\n"), heldEids };
}

/**
 * Reconciles every paired task between `collectionLines` and `logLines`
 * (both split, the log possibly already touched by roll-over and the
 * collection by the sync against an earlier log; copy-in runs after this),
 * gives every finished recurring line its next round through the round step,
 * moves a finished pairing to the completed-tasks heading once both sides
 * agree it is done or cancelled, and then moves every finished task no log
 * ever paired the same way (`finishUnpaired.ts`, #1261).
 *
 * Every clash found is reported through `problems`, keyed by eid; every
 * pairing checked and found *not* to be a clash has that same key cleared,
 * which is what lets a clash resolve itself the moment the lines next agree
 * (decision 13).
 *
 * **`heldEids`.** An eid `reconcileAgainstOldLog` found clashing
 * against an earlier day's log this same run is skipped here entirely — no
 * report, no clear, no field edit — so its own report stands untouched and
 * neither line here is rewritten out from under it. See that function's own
 * doc comment for why sharing the bare-eid key with this loop is now safe.
 *
 * **#848.** Decision 2's own further case — a marked log line naming
 * `collectionName` whose eid the collection no longer carries a line for —
 * is not found by the loop above at all, since that loop is driven by the
 * collection's own marked eids. A second pass, driven by the log's own
 * marked lines instead, catches it: reported once, keyed by the eid, and
 * cleared the moment the collection carries a line for it again.
 *
 * **#851.** D9's own detector, `freezeIfRescheduled` (`rollOver.ts`), has no
 * caller anywhere else in this run — decision 11's "a date changed from the
 * log side is folded into the collection, and today's line is then frozen"
 * needs one. It answers non-null only when the change `syncPairing` above
 * just carried to the collection came from the log side and moved the
 * scheduled or due date specifically (its own module comment); every other
 * pairing this loop sees answers null and the log line is left exactly as
 * `result.log` already decided.
 */
function reconcileAll(
	collectionLines: readonly string[],
	logLines: readonly string[],
	collectionName: string,
	layout: VaultLayout,
	today: Date,
	problems: RunProblems,
	heldEids: ReadonlySet<string>,
): { readonly collectionLines: string[]; readonly logLines: string[]; readonly rounded: RoundResult } {
	let collection = [...collectionLines];
	let log = [...logLines];
	// Pairings left untouched this run, kept out of the round step as well.
	const untouched = new Set<string>(heldEids);

	// One pairing as the two notes hold it now, and what syncing it answers;
	// null when the collection carries no line for it.
	const readPairing = (eid: string) => {
		const collectionIndex = locatePairedLine(collection.join("\n"), eid);
		if (collectionIndex === null) return null;
		const collectionLine = collection[collectionIndex];
		const logIndex = locateLiveLogLine(log.join("\n"), eid);
		const logLine = logIndex === null ? null : log[logIndex];
		const marker = readMarker(requireTaskLine(collectionLine));
		const lastSynced: SyncedSnapshot | null = marker === null ? null : { hash: marker.hash };
		return { collectionIndex, collectionLine, logIndex, logLine, lastSynced, result: syncPairing(collectionLine, logLine, lastSynced) };
	};

	// One pass over every paired line: syncs it, and moves a finished one that
	// does not repeat. Answers the finished recurring lines it held back.
	const syncPairs = (): string[] => {
		const recurring: string[] = [];
		// Every pairing that clashes is held before anything moves: the walk
		// below meets a parent before its subtasks, and a move made before a
		// subtask's clash was found would carry it along and rewrite it.
		for (const eid of markedEids(collection.join("\n"))) {
			if (heldEids.has(eid)) continue;
			if (readPairing(eid)?.result.clash === true) untouched.add(eid);
		}
		for (const eid of markedEids(collection.join("\n"))) {
			if (heldEids.has(eid)) continue;
			const pairing = readPairing(eid);
			if (pairing === null) continue;
			const { collectionIndex, collectionLine, logIndex, logLine, lastSynced, result } = pairing;

			if (result.clash) {
				// logLine is never null on a clash: reconcilePair only clashes once
				// both sides have something to disagree about.
				problems.report(eid, clashMessage(collectionLine, logLine as string));
				untouched.add(eid);
				continue;
			}
			problems.clear(eid);

			if (result.collection !== null) collection = withLine(collection, collectionIndex, result.collection);
			if (result.log !== null && logIndex !== null) log = withLine(log, logIndex, result.log);

			if (logLine !== null && logIndex !== null) {
				const frozen = freezeIfRescheduled(collectionLine, logLine, lastSynced);
				if (frozen !== null) log = withLine(log, logIndex, frozen);
			}

			const finalCollectionLine = result.collection ?? collectionLine;
			const meaning = requireTaskLine(finalCollectionLine).meaning;
			if (meaning === "done" || meaning === "cancelled") {
				// A finished recurring line waits for the round step below, which
				// must see it under the tasks heading; every other finished line
				// is moved at once, as it always was (a paired subtask's log copy
				// follows the cascade in this same run).
				if (requireTaskLine(finalCollectionLine).repeat !== null) {
					recurring.push(eid);
					continue;
				}
				const completed = completeInCollection(collection.join("\n"), eid, layout, untouched);
				if (completed.moved) collection = completed.collection === "" ? [] : completed.collection.split("\n");
			}
		}
		return recurring;
	};
	const recurring = syncPairs();

	// Every pairing is reconciled, so a tick in today's log has reached its
	// collection line; the round step comes before the finishing move, so a
	// recurring line is replaced by its next round and moved by the one step
	// rather than moved bare. It looks at every
	// finished recurring line under the tasks heading, paired or not.
	const rounded = roundStep(collection.join("\n"), today, layout, untouched);
	if (rounded.rounds > 0) collection = rounded.collection === "" ? [] : rounded.collection.split("\n");

	// The finishing move for the recurring lines held back above: one the
	// round step moved is already under the completed-tasks heading, which
	// `completeInCollection` leaves; one it left alone because its rule cannot
	// be read is a task that does not repeat and is finished as any task is.
	// One it left alone for want of a date stays where it is, finished or not, so the no-date report is still read from
	// the tasks heading next run.
	const undated = new Set<string>();
	for (const left of rounded.leftAlone) {
		if (left.reason !== "no-date") continue;
		const task = parseTaskLine(left.text);
		const marker = task === null ? null : readMarker(task);
		if (marker !== null) undated.add(marker.eid);
	}
	const finished = new Set<string>();
	for (const eid of recurring) {
		if (undated.has(eid)) continue;
		const completed = completeInCollection(collection.join("\n"), eid, layout, untouched);
		if (!completed.moved) continue;
		collection = completed.collection === "" ? [] : completed.collection.split("\n");
		finished.add(eid);
	}
	// The round step's answer was taken before the move above, so a line it
	// reported as left alone and this pass has just finished is no longer a
	// problem standing in the tasks section.
	const stillLeftAlone = rounded.leftAlone.filter((left) => {
		const task = parseTaskLine(left.text);
		const marker = task === null ? null : readMarker(task);
		return marker === null || !finished.has(marker.eid);
	});

	// Every finished task under the tasks heading that no day's log ever
	// paired moves too, by the same move; paired lines and lines whose 🔁 rule
	// reads are left to the two paths above.
	const unpaired = finishUnpaired(collection.join("\n"), layout, untouched);
	if (unpaired.moved.length > 0) collection = unpaired.collection === "" ? [] : unpaired.collection.split("\n");
	// A finished, unpaired line whose rule cannot be read is among them, and the
	// round step named it before it went: no longer a problem standing under the
	// tasks heading, as #1254 has it for a paired one. It carries no eid, so it
	// is known by its text as the move found it; a paired line's text holds its
	// marker, so it can never match one.
	const movedUnpaired = new Set(unpaired.moved);
	const stillStanding = stillLeftAlone.filter((left) => !movedUnpaired.has(left.text));

	// Moving a recurring or an unpaired line carries its subtree's open
	// subtasks to done in the collection only, and a subtask paired on its own
	// has a log copy that still reads open: one more pass lets the log follow
	// in this run rather than in the next one, which the plugin's own write
	// would trigger.
	if (recurring.length > 0 || unpaired.moved.length > 0) syncPairs();

	// #848: a log line naming this collection whose eid has no matching
	// collection line — driven by the log's own marked lines rather than the
	// collection's, so a deleted collection line is caught here instead of
	// simply never visited.
	for (const line of log) {
		const parsedLog = parseTaskLine(line);
		if (parsedLog === null) continue;
		const marker = readMarker(parsedLog);
		if (marker === null) continue;
		const linktext = collectionLinktextOf(parsedLog.description);
		if (linktext === null || linktext.trim() !== collectionName.trim()) continue;
		const key = `no-collection-line:${marker.eid}`;
		if (locatePairedLine(collection.join("\n"), marker.eid) !== null) {
			problems.clear(key);
		} else {
			problems.report(
				key,
				`a task in today's log names "${collectionName}" but no line in that collection carries this task's own marker. Both files are untouched.`,
			);
		}
	}

	return { collectionLines: collection, logLines: log, rounded: { ...rounded, leftAlone: stillStanding } };
}

/**
 * One run over `collection`: rolls over the most recent earlier log still
 * carrying a live pairing into today's, reconciles every live pairing
 * and brings each finished recurring line its next round, moves every
 * finished task no log ever paired under the completed-tasks heading,
 * copies in every newly due task, and writes whichever files actually changed.
 *
 * **The collection is written first, and the log write is queued only once
 * it is known to have landed**: a refused collection write reports
 * `run-failed:<path>` and this run stops there — neither today's log nor the
 * old log is written — so a copy the collection's own write never carried
 * can never land in the log on its own and duplicate on the next run. The
 * reverse (the collection lands, the log's own write is later refused)
 * needs no such guard: `copyIn`'s own re-copy-by-eid rule already
 * re-creates a missing live line on the next run, keyed by the same eid.
 *
 * A file already in flight for `collection.path` is the caller's to guard
 * against (#687 decision 4's "one run per file at a time") — this function
 * itself always runs to completion once called.
 */
export async function runOverCollection(deps: RunDeps, collection: Collection): Promise<{ readonly eids: ReadonlySet<string> }> {
	const noEids = { eids: new Set<string>() };
	const todayPath = dailyLogPath(deps.today, deps.layout);
	const todayFile = deps.vault.fileAt(todayPath);
	// Nothing this feature writes exists to write to yet — creating the day's
	// log is another feature's job, and a day nobody has opened has nothing to
	// copy into.
	if (todayFile === null) return noEids;

	const collectionFile = deps.vault.fileAt(collection.path);
	if (collectionFile === null) return noEids;

	try {
		const collectionSnapshot = await deps.notes.read(collectionFile);
		const todaySnapshot = await deps.notes.read(todayFile);

		let collectionText = collectionSnapshot;
		let todayText = todaySnapshot;

		let oldSnapshot: string | null = null;
		let oldText: string | null = null;
		let oldFile: TFile | null = null;
		// An eid `reconcileAgainstOldLog` finds clashing against an earlier
		// day's log: held out of `copyIn` and `reconcileAll` below for the rest
		// of this run, so nothing else moves that pairing while its own report
		// stands. Empty whenever there is no earlier log to check.
		let heldEids: ReadonlySet<string> = new Set();
		for (let daysBack = 1; daysBack <= ROLLOVER_LOOKBACK_DAYS; daysBack += 1) {
			const candidatePath = dailyLogPath(daysBefore(deps.today, daysBack), deps.layout);
			if (candidatePath === todayPath) break; // never today's own log
			const candidateFile = deps.vault.fileAt(candidatePath);
			if (candidateFile !== null) {
				oldFile = candidateFile;
				break;
			}
		}
		if (oldFile !== null) {
			oldSnapshot = await deps.notes.read(oldFile);
			oldText = oldSnapshot;
			const rolled = rollOver(oldText, todayText, collectionText, deps.today, deps.layout, collection.name);
			oldText = rolled.oldLog;
			todayText = rolled.todayLog;
			// rollOver never edits the collection (see its own module comment) —
			// the sync against a genuine finish sitting in that same file is
			// `reconcileAgainstOldLog`'s own job, run before `copyIn` gets a
			// chance to treat the still-`copied` collection line as a candidate.
			const againstOldLog = reconcileAgainstOldLog(collectionText, oldText, oldFile.path, deps.problems);
			collectionText = againstOldLog.collection;
			heldEids = againstOldLog.heldEids;
		}

		const reconciled = reconcileAll(
			collectionText === "" ? [] : collectionText.split("\n"),
			todayText === "" ? [] : todayText.split("\n"),
			collection.name,
			deps.layout,
			deps.today,
			deps.problems,
			heldEids,
		);
		collectionText = reconciled.collectionLines.join("\n");
		todayText = reconciled.logLines.join("\n");
		reportRepeatProblems(deps.problems, collection, reconciled.rounded);

		// Copy-in comes after the round step, so it sees a fresh round as an
		// ordinary unpaired open task and copies it into today's log in the
		// same run when its date is today.
		const copied = copyIn(collectionText, todayText, deps.today, deps.layout, collection.name, heldEids);
		collectionText = copied.collection;
		todayText = copied.log;
		const eids = new Set<string>([...markedEids(collectionText), ...markedEids(todayText)]);

		if (collectionText !== collectionSnapshot) {
			const landed = await editIfFresh(deps.notes, collectionFile, collectionText, collectionSnapshot);
			if (!landed) {
				deps.problems.report(
					`run-failed:${collection.path}`,
					`Effortless could not keep "${collection.name}" in step with today's log: the collection changed while this run was in progress.`,
				);
				return noEids;
			}
		}
		// The log's own write can be refused for the same reason the
		// collection's own write above can — the note changed between the
		// read this run took and the write reaching the front of its queue —
		// and, for today's log specifically, for a reason that can hold far
		// longer: `NoteWriter.edit` parks a write to the note the person has
		// open (`noteWriter.ts`, ADR 0002) until they leave it, and this
		// `await` sits inside that park. Silently accepting `landed === false`
		// here left a filing with no live copy and no word said — the
		// collection already landed, so this run keeps going rather than
		// undoing that (see the module comment on #846): the next run finds
		// the same eid still uncopied and tries again (copyIn's own
		// re-copy-by-eid rule, #809), and a trigger for this collection that
		// arrived while this write was parked is not lost either — it is
		// {@link TaskConsistency.guardedRun}'s own remembered rerun,
		// not a second mechanism built here.
		//
		// Reported under `log-write-refused:<collection.path>`, a key of its
		// own — never `run-failed:<log path>`, which `checkPath`'s own log
		// branch (`taskConsistency.ts`) already owns for the log check's own
		// failure. The two used to share a key, so a successful check of the
		// log cleared this report before the task ever reached the log, and a
		// standing log-check failure was overwritten or cleared by an
		// unrelated collection's landed write.
		//
		// Cleared right here, before the old-log write and the run-failed:
		// clear below, by every run that reaches this point — not only one
		// that itself attempted a log write: a run that finds nothing
		// left to write — the task already landed, by a retry or by hand —
		// never enters the branch below and clears it in the `else` instead.
		// Neither branch runs on this function's own early returns (no
		// log for today, no collection file): a report left standing through one of those is what
		// `runSweep`'s own clearing pass catches, once the path it names
		// stops being a collection at all.
		if (todayText !== todaySnapshot) {
			const landed = await editIfFresh(deps.notes, todayFile, todayText, todaySnapshot);
			if (!landed) {
				deps.problems.report(
					`log-write-refused:${collection.path}`,
					`Effortless could not add "${collection.name}"'s task to today's log: the write was held while the log was the open note and came back stale.`,
				);
			} else {
				deps.problems.clear(`log-write-refused:${collection.path}`);
			}
		} else {
			deps.problems.clear(`log-write-refused:${collection.path}`);
		}
		if (oldFile !== null && oldText !== null && oldSnapshot !== null && oldText !== oldSnapshot) {
			await editIfFresh(deps.notes, oldFile, oldText, oldSnapshot);
		}
		deps.problems.clear(`run-failed:${collection.path}`);
		return { eids };
	} catch (error) {
		deps.problems.report(
			`run-failed:${collection.path}`,
			`Effortless could not keep "${collection.name}" in step with today's log: ${reasonOf(error)}.`,
		);
		return noEids;
	}
}

/**
 * Writes `text` through `notes.edit`, but only once the content the callback
 * actually receives still matches `snapshot` — the note as this run read it
 * before it computed `text`. A note that changed between the read and the
 * write is left exactly as the person left it, the same rule meeting notes'
 * own `editIfFresh` keeps (`meetingNotes/run.ts:433`) and for the same
 * reason: this run's whole plan was computed from `snapshot`, and there is no
 * cheap way to recompute a multi-file plan inside a single file's own
 * callback, so a genuine race is left for the next run to catch rather than
 * risked as a stale write. Returns whether it landed: a caller that
 * must not write the log once the collection's own write was refused reads
 * this rather than guessing from `text`.
 */
async function editIfFresh(notes: RunNotes, file: TFile, text: string, snapshot: string): Promise<boolean> {
	let landed = false;
	await notes.edit(file, (freshContent) => {
		if (freshContent !== snapshot) return freshContent;
		landed = true;
		return text;
	});
	return landed;
}

/**
 * A key `checkLogFile` might have reported and never cleared, other than a
 * `no-collection:` orphan or a broken pairing (both cleared by the sweep
 * below) — `run-failed:`, `log-write-refused:` and the repeat-rule keys are
 * different reports' own keys, kept out of the clearing pass even though a path
 * under any of them happens to end `.md` too.
 */
function isReservedProblemKey(key: string): boolean {
	return key.startsWith("run-failed:") || key.startsWith("log-write-refused:") || isRepeatKey(key);
}

/** Whether `key` is a broken-pairing key `checkLogFile` could report — a resolved path (always carrying `/` or ending `.md`) or an `unresolved:` linktext, never `run-failed:`'s or `log-write-refused:`'s own namespace. */
function isBrokenPairingKey(key: string): boolean {
	if (isReservedProblemKey(key)) return false;
	return key.startsWith("unresolved:") || key.includes("/") || key.endsWith(".md");
}

/**
 * One run over `logFile`'s own paired lines: for every task line the log
 * carries with this feature's marker, resolves the collection its breadcrumb
 * names and checks it the same way {@link runOverCollection} would — unless
 * `alreadyVisited` says a caller's own direct pass already has.
 *
 * A breadcrumb naming a note the index no longer calls a collection — the
 * heading renamed, the note moved out of reach — leaves both files untouched
 * and raises one standing problem keyed by the resolved path (or, when the
 * link resolves to nothing at all, by the link text itself), cleared the
 * moment a later run finds it valid again (#29 C6-C8).
 *
 * A marked line carrying no breadcrumb at all — this cannot happen from
 * typing alone, only from a stale or hand-edited marker (spec #709 decision
 * 2) — is reported the same way, keyed by its own eid rather than a path, and
 * never repaired.
 *
 * **#850.** This call always reads the whole of `logFile` fresh, so it is
 * always the run that "could have seen" whether an orphan or a broken
 * pairing's own line is still there. A standing key of either kind that this
 * call's own fresh reading does not recompute is cleared here, rather than
 * left standing until the same key happens to be resolved again.
 */
export async function checkLogFile(
	deps: RunDeps,
	resolveLink: (linktext: string) => string | null,
	logFile: TFile,
	alreadyVisited: ReadonlySet<string> = new Set(),
	guard: (path: string, run: () => Promise<void>) => Promise<void> = defaultGuard,
): Promise<{ readonly eids: ReadonlySet<string> }> {
	// Bound to a name with no `.` before "at" — `platform.test.ts`'s ES-floor
	// sweep reads source text and cannot tell `Collections.at`
	// (`src/core/collections.ts:194`) apart from `Array`/`String.prototype.at`
	// (the same workaround `jump.ts`'s own `realJumpTarget` keeps).
	const collectionAt = deps.collections.at.bind(deps.collections);
	const text = await deps.notes.read(logFile);
	const resolved = new Map<string, string>();
	const orphanEids = new Set<string>();

	for (const line of text === "" ? [] : text.split("\n")) {
		const parsed = parseTaskLine(line);
		if (parsed === null) continue;
		const marker = readMarker(parsed);
		if (marker === null) continue;
		const linktext = collectionLinktextOf(parsed.description);
		if (linktext === null) {
			orphanEids.add(marker.eid);
			continue;
		}
		const path = resolveLink(linktext);
		resolved.set(path ?? `unresolved:${linktext}`, path ?? linktext);
	}

	for (const eid of orphanEids) {
		deps.problems.report(
			`no-collection:${eid}`,
			"a task in today's log carries this feature's own marker but names no collection. Both files are untouched.",
		);
	}

	const seenEids = new Set<string>();
	for (const [key, pathOrLinktext] of resolved) {
		const path = key.startsWith("unresolved:") ? null : key;
		const collection = path === null ? null : collectionAt(path);
		if (collection === null) {
			deps.problems.report(
				key,
				`a task in today's log names "${pathOrLinktext}", which is not a collection any more. Both files are untouched.`,
			);
			continue;
		}
		deps.problems.clear(key);
		if (alreadyVisited.has(collection.path)) continue;
		await guard(collection.path, async () => {
			const result = await runOverCollection(deps, collection);
			for (const eid of result.eids) seenEids.add(eid);
		});
	}

	const validOrphanKeys = new Set([...orphanEids].map((eid) => `no-collection:${eid}`));
	for (const key of deps.problems.list()) {
		if (validOrphanKeys.has(key) || resolved.has(key)) continue;
		if (key.startsWith("no-collection:") || isBrokenPairingKey(key)) deps.problems.clear(key);
	}

	return { eids: seenEids };
}

/**
 * The periodic sweep: every collection with an open
 * task, checked against today's log, plus today's own paired lines — the one
 * pass that catches a task crossing into "due" purely because midnight
 * passed, with no file touched at all.
 *
 * A collection with no open task and no finished one is skipped without being
 * read: the loop below never calls `notes.read` for one. A finished
 * task counts because a ticked recurring line is owed its next round whether
 * or not an open task sits beside it.
 *
 * **#850.** A collection this sweep's own direct pass already read is not
 * read a second time through today's log's own breadcrumbs — `visitedPaths`
 * is threaded into {@link checkLogFile} for exactly that — and every
 * collection this sweep reaches, by either route, runs under `deps.guard`,
 * the same "one run per file at a time" lock a debounced trigger keeps.
 *
 * Once both passes are done, this is the one place that has read every open
 * collection and today's log in a single sweep, so it is the one place that
 * can tell a standing clash apart from one whose own line has since been
 * deleted: any clash-shaped key not among the eids either pass actually saw
 * is cleared here (a collection with no open task, skipped by design above,
 * is not "seen" either way — the same limitation #29 C9 already accepts for
 * everything else about it).
 *
 * It is also the one place that can tell a standing
 * `log-write-refused:<collection.path>` report apart from
 * one whose collection has stopped being one — renamed or removed — since it
 * was reported. `runOverCollection` clears that key at the end of
 * every run it completes over the same path, but a collection that no longer
 * matches never gets such a run again: `deps.collections.all()` no longer
 * lists it under the old path, so the loop above never reaches it, and
 * `checkLogFile`'s own clearing pass leaves the key alone on purpose
 * (`isReservedProblemKey`). This sweep is the one pass that has just read
 * every collection that still exists, so a `log-write-refused:` key whose
 * path `deps.collections.at` no longer answers is cleared here instead —
 * whether that collection has no open task left (skipped above, but still a
 * collection) is irrelevant; only whether it is a collection at all decides
 * this.
 */
export async function runSweep(deps: RunDeps, resolveLink: (linktext: string) => string | null): Promise<void> {
	const guard = deps.guard ?? defaultGuard;
	const visitedPaths = new Set<string>();
	const seenEids = new Set<string>();

	const everyCollection = deps.collections.all();
	for (const collection of everyCollection) {
		if (collection.openTasks === 0 && (collection.finishedTasks ?? 0) === 0) continue;
		visitedPaths.add(collection.path);
		await guard(collection.path, async () => {
			const result = await runOverCollection(deps, collection);
			for (const eid of result.eids) seenEids.add(eid);
		});
	}

	const todayPath = dailyLogPath(deps.today, deps.layout);
	const todayFile = deps.vault.fileAt(todayPath);
	if (todayFile !== null) {
		await guard(todayPath, async () => {
			const result = await checkLogFile(deps, resolveLink, todayFile, visitedPaths, guard);
			for (const eid of result.eids) seenEids.add(eid);
		});
	}

	const collectionPaths = everyCollection.map((collection) => collection.path);
	for (const key of deps.problems.list()) {
		if (looksLikeEid(key) && !seenEids.has(key)) deps.problems.clear(key);
		if (isRepeatKey(key) && !isRepeatKeyOfAnyOf(key, collectionPaths)) deps.problems.clear(key);
		if (key.startsWith("log-write-refused:") && deps.collections.at(key.slice("log-write-refused:".length)) === null) {
			deps.problems.clear(key);
		}
	}
}
