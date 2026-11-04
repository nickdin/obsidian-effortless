/**
 * The round step (spec #1222
 * decisions 4, 5 and 6, ticket #1226):
 * a recurring task ticked in a collection comes back as a fresh open line with
 * its next date, and the ticked line, with its subtree, moves under the
 * completed-tasks heading as every finished task does.
 *
 * A pure function over a collection's text, today and the layout — no vault,
 * no app, no clock. It reads every task line under the tasks heading that is
 * the top of its own subtree (a subtask waits for its parent, as in
 * `complete.ts`) and carries a `🔁` rule:
 *
 * - **Finished, rule readable, own date present:** the fresh round is written
 *   in the finished line's place and the finished line moves through
 *   {@link completeLineInCollection}, the same move finishing makes.
 * - **Rule readable, no own date:** the line is left alone, finished or not,
 *   and the answer names it ({@link LeftAlone}) so the standing-problems
 *   ticket can report it. The run does not finish it either.
 * - **Rule unreadable:** the line is not a round of any kind and is left
 *   alone here, named in the answer the same way; the run finishes it as any
 *   task that does not repeat. This module reports nothing itself.
 * - **Open, readable, dated:** nothing. The date arriving creates nothing.
 *
 * **No new state.** The fresh round and the move happen in one step over one
 * text, so afterwards the finished line sits under the completed-tasks heading,
 * where this step never looks, and the fresh round is an open line, which
 * creates nothing. A finished recurring line found under the tasks heading
 * later — ticked on a phone, ticked while the feature was off, ticked before it
 * was ever copied — is a round whose next has not been written, and gets it
 * then, paired or not. A blank completed-tasks heading leaves the text as it
 * is and the answer says so, since the finished line would have nowhere to go
 * and a fresh round written beside it would be written again every run.
 *
 * **The round's own date** is {@link relevantDate}: scheduled, or due when
 * there is no scheduled date. Both dates of the top line, and every date of a
 * subtask, move by the same number of days, so a gap between them is kept; a
 * dateless subtask stays dateless. The next date is the repeat-rule module's.
 *
 * **A completed-tasks heading that encloses the tasks heading, or is the same
 * heading,** puts every task line under both, so none is read: finishing
 * moves a line to the end of the enclosing section, which is still inside the
 * tasks range, and a round written for it would be written again by every run.
 *
 * **Line endings.** Every line of the fresh round takes the ending of the line
 * it was copied from, and the line that ended the note without one takes the
 * ending of the line before it, the rule {@link joinLines} keeps for the move.
 */

import { localDateKey } from "../../core/meetingName";
import { daysBetween, nextRepeatDate, readRepeatRule, shiftDate } from "../../core/repeatRule";
import type { RepeatRule } from "../../core/repeatRule";
import type { VaultLayout } from "../../core/settings";
import { editTaskField, parseTaskLine, relevantDate, setComment, uncapturedRepeat } from "../../core/taskLine";
import type { TaskLine } from "../../core/taskLine";
import {
	clippedEnd,
	completeLineInCollection,
	findHeading,
	hasEnclosingTask,
	indentOf,
	joinLines,
	splitLines,
	subtreeEndFrom,
	subtreeHoldsHeld,
	tasksInsideCompleted,
} from "./complete";
import { readMarker } from "./marker";
import { FEATURE_ID } from "./types";

/** Why the round step left a recurring line as it was. */
export type LeftAloneReason =
	/** The rule is readable and the line has neither a scheduled nor a due date. */
	| "no-date"
	/** The text after `🔁` is not a rule the repeat-rule module reads. */
	| "unreadable-rule"
	/** The rule is readable and the line dated, yet no next date can be counted or the dates cannot be moved to it (the rule never lands, or the date would pass year 9999). */
	| "no-next-date"
	/** The line is finished and would recur, but the layout's completed-tasks heading is blank, so there is nowhere to move it to. */
	| "no-completed-heading";

/** One recurring line the step left alone, as it stands in the returned text. */
export interface LeftAlone {
	/** 0-based index into the returned text split on `"\n"`. */
	readonly line: number;
	/** The line itself, without its line ending. */
	readonly text: string;
	/** The line's rule text, the words after `🔁`; for a rule the reader could not take, what follows the sign, empty for a bare one. */
	readonly rule: string;
	readonly reason: LeftAloneReason;
}

/** What one call to {@link roundStep} produces. */
export interface RoundResult {
	/** `collectionText` again, with every round written and every finished line moved. */
	readonly collection: string;
	/** How many fresh rounds were written. */
	readonly rounds: number;
	/** Every recurring line the step looked at and left alone, in the order they stand. */
	readonly leftAlone: readonly LeftAlone[];
	/**
	 * The `skipEids` lines the step did not round, with the fault each carries
	 * (`no-date` or `unreadable-rule`) — a line the run holds untouched is not
	 * looked at for a round, but its fault still stands, so its report must. A held line with no fault is absent.
	 */
	readonly held: readonly LeftAlone[];
	/**
	 * Whether the layout's completed-tasks heading is blank while a line with a
	 * readable rule stands under the tasks heading, finished or not, dated or
	 * not: the collection holds a recurring task that has nowhere to go once
	 * it is ticked. {@link LeftAlone}'s `no-completed-heading` names only a
	 * finished, dated line, which is too late for a report that should stand
	 * before anything is ticked.
	 */
	readonly repeatsWithBlankHeading: boolean;
}

/** What the scan decided about one recurring line. */
type Verdict =
	| { readonly kind: "round"; readonly fresh: readonly string[] }
	| { readonly kind: "left-alone"; readonly reason: LeftAloneReason }
	| { readonly kind: "nothing" };

interface Candidate {
	readonly index: number;
	readonly rule: string;
	/** Whether the repeat-rule module reads `rule`. */
	readonly readable: boolean;
	readonly verdict: Verdict;
	/** The run is holding this line's pairing untouched: it is read for its faults only, never rounded. */
	readonly held?: boolean;
}

/**
 * The fresh round for `block` (the finished line and its subtree, endings
 * stripped): every task line open, no pairing marker anywhere, the top line's
 * own date at `next` and everything else dated moved by `delta` days. Null
 * when a date cannot be moved. Every other byte of every line is kept.
 */
function freshRound(block: readonly string[], top: TaskLine, next: string, delta: number): string[] | null {
	const out: string[] = [];
	for (let offset = 0; offset < block.length; offset += 1) {
		const task = parseTaskLine(block[offset]);
		if (task === null) {
			out.push(block[offset]);
			continue;
		}
		let line = setComment(editTaskField(block[offset], "checkbox", " "), FEATURE_ID, null);
		const ownKind = offset === 0 ? (top.scheduled !== null ? "scheduled" : "due") : null;
		for (const kind of ["scheduled", "due"] as const) {
			const date = task[kind];
			if (date === null) continue;
			const moved = kind === ownKind ? next : shiftDate(date, delta);
			if (moved === null) return null;
			line = editTaskField(line, kind, moved);
		}
		out.push(line);
	}
	return out;
}

/**
 * The rule text after `task`'s 🔁 sign, readable or not, or null when the line
 * carries no sign. A sign whose rule the reader did not take
 * (`🔁 varje måndag`, a bare `🔁`) is an unreadable rule, not a line with no
 * rule, so its report stands like any other.
 */
function repeatSignOf(task: TaskLine): string | null {
	return task.repeat ?? uncapturedRepeat(task);
}

/**
 * `task`'s repeat rule when it has one the reader can take, or null. A line
 * with one is this step's to finish, dated or not; a line whose rule cannot be
 * read is a task that does not repeat, finished as any task is.
 */
export function readableRuleOf(task: TaskLine): RepeatRule | null {
	return task.repeat === null ? null : readRepeatRule(task.repeat);
}

/** Every recurring top-of-subtree task line under the tasks heading, with what the step does about it. */
function scan(text: string, todayKey: string, layout: VaultLayout, skipEids: ReadonlySet<string>): Candidate[] {
	const tasksMatch = findHeading(text, layout.tasksHeading);
	if (tasksMatch === null) return [];
	const completedMatch = findHeading(text, layout.completedTasksHeading);
	// A tasks heading within the completed-tasks heading's range: a finished
	// line this step moved would land back where it reads, and be rounded again
	// on every run. A line already under the completed-tasks heading is
	// never read.
	if (tasksInsideCompleted(tasksMatch, completedMatch)) return [];
	const tasksEnd = clippedEnd(tasksMatch, completedMatch);
	const nowhereToGo = layout.completedTasksHeading.trim() === "";
	const { lines } = splitLines(text);

	const candidates: Candidate[] = [];
	for (let index = tasksMatch.start; index < tasksEnd; index += 1) {
		const task = parseTaskLine(lines[index]);
		if (task === null) continue;
		const ruleText = repeatSignOf(task);
		if (ruleText === null) continue;
		const marker = readMarker(task);
		const held = marker !== null && skipEids.has(marker.eid);
		const indent = indentOf(lines[index]).length;
		if (hasEnclosingTask(lines, index, indent, tasksMatch.start)) continue;

		const rule = readableRuleOf(task);
		const left = (reason: LeftAloneReason): Candidate => ({
			index,
			rule: ruleText,
			readable: rule !== null,
			verdict: { kind: "left-alone", reason },
			held,
		});
		if (rule === null) {
			candidates.push(left("unreadable-rule"));
			continue;
		}
		const own = relevantDate(task);
		if (own === null) {
			candidates.push(left("no-date"));
			continue;
		}
		// A subtree holding a held pairing waits with it: rounding the line
		// would move the subtree and rewrite the held line. `held`
		// itself still names the line's own pairing only, which sorts its
		// faults above.
		const subtreeHeld = subtreeHoldsHeld(lines, index, subtreeEndFrom(lines, index, indent, tasksEnd), skipEids);
		if (held || subtreeHeld || (task.meaning !== "done" && task.meaning !== "cancelled")) {
			candidates.push({ index, rule: ruleText, readable: true, verdict: { kind: "nothing" }, held });
			continue;
		}
		if (nowhereToGo) {
			candidates.push(left("no-completed-heading"));
			continue;
		}
		const next = nextRepeatDate(rule, own, todayKey);
		const delta = next === null ? null : daysBetween(own, next);
		if (next === null || delta === null) {
			candidates.push(left("no-next-date"));
			continue;
		}
		const end = subtreeEndFrom(lines, index, indent, tasksEnd);
		const fresh = freshRound(lines.slice(index, end), task, next, delta);
		if (fresh === null) {
			candidates.push(left("no-next-date"));
			continue;
		}
		candidates.push({ index, rule: ruleText, readable: true, verdict: { kind: "round", fresh } });
	}
	return candidates;
}

/**
 * Writes the fresh round of the candidate at `index` in `text` and moves the
 * finished line away. The fresh block goes in directly above the finished line
 * and the line is then moved by its (shifted) index, so the block stays exactly
 * where the finished line stood whichever side of the tasks heading the
 * completed-tasks heading is on.
 */
function writeRound(
	text: string,
	index: number,
	fresh: readonly string[],
	layout: VaultLayout,
	skipEids: ReadonlySet<string>,
): string {
	const { lines, endings } = splitLines(text);
	const indent = indentOf(lines[index]).length;
	const tasksMatch = findHeading(text, layout.tasksHeading);
	const completedMatch = findHeading(text, layout.completedTasksHeading);
	if (tasksMatch === null) throw new Error("the round step lost the tasks heading it just found");
	const end = subtreeEndFrom(lines, index, indent, clippedEnd(tasksMatch, completedMatch));

	lines.splice(index, 0, ...fresh);
	endings.splice(index, 0, ...endings.slice(index, end));
	const moved = completeLineInCollection(joinLines(lines, endings), index + fresh.length, layout, skipEids);
	if (!moved.moved) {
		throw new Error(`the round step could not move the finished line at ${index} under the completed-tasks heading`);
	}
	return moved.collection;
}

/**
 * See the module comment. `today` is the day the run sees the tick.
 * `skipEids` names pairings the run is holding untouched — one whose two
 * copies clash, or that clashes against an earlier day's log — so their line
 * is not looked at, rounded or moved, and the "Neither was changed" the
 * problem report promises stays true. A finished recurring line whose
 * subtree holds one is not rounded or moved either.
 */
export function roundStep(
	collectionText: string,
	today: Date,
	layout: VaultLayout,
	skipEids: ReadonlySet<string> = new Set(),
): RoundResult {
	const todayKey = localDateKey(today);
	let text = collectionText;
	let rounds = 0;
	// Every round consumes one finished line from under the tasks heading and
	// writes an open one, so no note needs more rounds than it has lines; a
	// count past that means a round was written that did not stop being one.
	const mostRounds = splitLines(collectionText).lines.length;
	for (;;) {
		if (rounds > mostRounds) throw new Error(`the round step wrote ${rounds} rounds into a note of ${mostRounds} lines`);
		const candidates = scan(text, todayKey, layout, skipEids);
		const next = candidates.find((candidate) => candidate.verdict.kind === "round");
		if (next === undefined || next.verdict.kind !== "round") {
			const { lines } = splitLines(text);
			const leftAlone: LeftAlone[] = [];
			const heldFaults: LeftAlone[] = [];
			for (const candidate of candidates) {
				if (candidate.verdict.kind !== "left-alone") continue;
				(candidate.held === true ? heldFaults : leftAlone).push({
					line: candidate.index,
					text: lines[candidate.index],
					rule: candidate.rule,
					reason: candidate.verdict.reason,
				});
			}
			const repeatsWithBlankHeading =
				layout.completedTasksHeading.trim() === "" && candidates.some((candidate) => candidate.readable);
			return { collection: text, rounds, leftAlone, held: heldFaults, repeatsWithBlankHeading };
		}
		const written = writeRound(text, next.index, next.verdict.fresh, layout, skipEids);
		if (written === text) throw new Error("the round step wrote a round and the text did not change");
		text = written;
		rounds += 1;
	}
}
