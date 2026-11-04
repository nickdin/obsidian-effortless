/**
 * The finishing move for a task no day's log ever paired: every finished
 * task under a collection's tasks heading that carries no pairing marker moves,
 * with its subtree, under the completed-tasks heading — the rule being that a
 * finished task never stays under the tasks heading, whatever state it was in
 * before this pass first saw it.
 *
 * A pure function over the collection's text. The move itself is
 * {@link completeLineInCollection}, reused as is, so the guard, the cascade,
 * waiting for an enclosing task and the two headings' rules are the ones a
 * paired task gets (`complete.ts`'s module comment).
 */

import type { VaultLayout } from "../../core/settings";
import { parseTaskLine } from "../../core/taskLine";
import {
	clippedEnd,
	completeLineInCollection,
	findHeading,
	hasEnclosingTask,
	indentOf,
	splitLines,
	subtreeEndFrom,
	subtreeHoldsHeld,
	tasksInsideCompleted,
} from "./complete";
import { readMarker } from "./marker";
import { readableRuleOf } from "./round";

/** What one call to {@link finishUnpaired} produces. */
export interface FinishUnpairedResult {
	readonly collection: string;
	/** Each top-of-subtree line moved, as it read before the move, in the order moved. */
	readonly moved: readonly string[];
}

/** The index of the first line under the tasks heading this pass would move, or -1. */
function firstCandidate(text: string, layout: VaultLayout, held: ReadonlySet<string>): number {
	// A blank completed-tasks heading switches the move off (`complete.ts`'s
	// module comment), so there is nothing this pass would move.
	if (layout.completedTasksHeading.trim() === "") return -1;
	const tasksMatch = findHeading(text, layout.tasksHeading);
	if (tasksMatch === null) return -1;
	const completedMatch = findHeading(text, layout.completedTasksHeading);
	if (tasksInsideCompleted(tasksMatch, completedMatch)) return -1;
	const tasksEnd = clippedEnd(tasksMatch, completedMatch);
	const { lines } = splitLines(text);
	for (let index = tasksMatch.start; index < tasksEnd; index += 1) {
		const task = parseTaskLine(lines[index]);
		if (task === null) continue;
		if (task.meaning !== "done" && task.meaning !== "cancelled") continue;
		// A paired line has its own path in the run, which moves it once both
		// copies agree; taking it here would move it ahead of that agreement.
		if (readMarker(task) !== null) continue;
		// A line whose 🔁 rule reads is the round step's: it writes the next
		// round and moves the line, or, with no date, leaves it standing with
		// its report. A rule nobody can read is a task that does not
		// repeat, and moves here as its paired twin does.
		if (readableRuleOf(task) !== null) continue;
		// A subtask waits for its enclosing task, as a paired one does; the
		// move would refuse it, and the scan goes on past it to the next line.
		const indent = indentOf(lines[index]).length;
		if (hasEnclosingTask(lines, index, indent, tasksMatch.start)) continue;
		// A subtree holding a pairing the run holds untouched waits until that
		// clash is resolved, as the move would refuse it.
		if (subtreeHoldsHeld(lines, index, subtreeEndFrom(lines, index, indent, tasksEnd), held)) continue;
		return index;
	}
	return -1;
}

/**
 * See the module comment. `held` names the pairings the run is holding
 * untouched; a finished task whose subtree carries one stays where it is.
 */
export function finishUnpaired(
	collectionText: string,
	layout: VaultLayout,
	held: ReadonlySet<string> = new Set(),
): FinishUnpairedResult {
	let text = collectionText;
	const moved: string[] = [];
	// Every move takes at least one line out of the tasks range for good, so
	// no note needs more moves than it has lines; a count past that means a
	// moved line landed back where this pass reads.
	const mostMoves = splitLines(collectionText).lines.length;
	for (;;) {
		if (moved.length > mostMoves) {
			throw new Error(`the unpaired finishing pass took ${moved.length} lines out of a note of ${mostMoves} lines`);
		}
		const index = firstCandidate(text, layout, held);
		if (index === -1) return { collection: text, moved };
		const result = completeLineInCollection(text, index, layout, held);
		// Every reason the move has to refuse a line is read above first, so a
		// refusal here is a rule the two disagree on, and every finished line
		// after this one would be skipped without a word.
		if (!result.moved) throw new Error(`the unpaired finishing pass chose line ${index} and the move refused it`);
		moved.push(splitLines(text).lines[index]);
		text = result.collection;
	}
}
