/**
 * Finishing a task in both places: once `reconcilePair` has made a paired task's checkbox agree on both
 * sides, the collection's own copy — with its subtree — moves to the
 * completed-tasks heading.
 *
 * A pure function over text. No vault, no app, no clock — this module never
 * reads the log at all, only the collection: what a caller does with the log
 * line once the move has happened (leaving it exactly as `reconcilePair` set
 * it, per decision 11) is not this module's job.
 *
 * **Why the checkbox itself is the guard, not an argument.** The caller is
 * meant to invoke this only once a paired task reads `done` or `cancelled` on
 * both copies, but this module does not trust that: it reads the collection
 * line it finds by `eid` and moves it only when that line's own meaning is
 * already `done` or `cancelled`. Everything else — `open`, `copied`,
 * `forwarded` — is left exactly as it is. That single guard is also what
 * keeps the old plugin's own defect from coming back: a `[/]` (copied) task
 * whose eid has no counterpart in any day's log is never cancelled or moved,
 * because nothing ever calls `reconcilePair` for it and its collection line
 * never reads anything but `copied` — the log holds no state, so a missing
 * counterpart is neither present nor absent to this feature (ADR 0002, § *Named
 * differences* row 5).
 *
 * **Waiting for the parent.** A task that is itself a subtask — an
 * indented task line with a shallower task line above it in the same
 * subtree — is left exactly where it is, however its own meaning reads,
 * for as long as that enclosing task line exists: the author's answer on issue
 * #950, 2026-09-29, to
 * the question #709 left open. It never moves by a call keyed to its own
 * eid; it moves only once the enclosing task is itself the subject of a
 * call that finds it `done` or `cancelled`, at which point the cascade below
 * carries it along already finished, exactly as an unticked sibling is
 * carried along and set to the parent's own meaning. The enclosing line's
 * own meaning is never asked — an enclosing line reading `done` is not
 * proof that some call is about to cascade it along: a parent with no date
 * carries no marker and so is never itself the subject of a call, and a done
 * parent may itself be waiting on its own open grandparent — so a subtask
 * waits for its immediate enclosing line unconditionally. A shallower line
 * that is not a task at all — a plain bullet, nothing this feature pairs —
 * means the ticked line is not a subtask, and it moves on its own as
 * before.
 *
 * **The cascade.** Every line indented under the moved task — task line or
 * not — travels with it, in order and with its own indentation untouched (a
 * blank line inside the subtree travels with it too, unless it is the one
 * that ends the subtree, which is left where it was — issue
 * #838). Among those, a
 * task line still open — a real `[ ]`, or `[/]` (`copied`), which
 * `marker.ts`'s own reading treats as annotating `open` — has its checkbox
 * rewritten to the exact character the parent itself carries; anything
 * already `done`, `cancelled` or `forwarded` is carried as it is, and so is a
 * checkbox character the core does not recognise, since `taskLine.ts`'s own
 * rule for one is that its symbol is left alone. The sentence
 * this cascade is built from is #808's own brief, not #27 D7 (which says only
 * "moves it, with its subtree, to the completed section"): "subtasks go with
 * the parent, their own checkboxes set to the parent's meaning if still
 * open".
 *
 * **The two headings.** The completed-tasks heading is written, directly
 * beneath the tasks heading and its tasks, the moment this module needs it and
 * finds none — the same placement `collections.ts`'s own `headingLine` comment
 * cites. The
 * tasks heading itself is never written here, whatever state the text is in
 * (issue #29 C11, the rule
 * the collections index itself follows). A blank completed-tasks heading text
 * is switched off — the symmetric choice to `copyIn.ts`'s own blank-heading
 * rule: the
 * task is left exactly where it is, `moved: false`, rather than invented a
 * place to go.
 */

import { clampLevel, headingRange } from "../../core/markdownSections";
import type { SectionRange } from "../../core/markdownSections";
import type { VaultLayout } from "../../core/settings";
import { editTaskField, parseTaskLine } from "../../core/taskLine";
import { readMarker } from "./marker";

/** What one call to {@link completeInCollection} produces. */
export interface CompleteResult {
	/** `collectionText` again, with the finished task's block moved if it needed to be. */
	readonly collection: string;
	/** Whether anything moved. */
	readonly moved: boolean;
}

/** A heading match, with the level it was actually found at — a collection's own headings carry no configured level, so every level is tried. */
export interface HeadingMatch extends SectionRange {
	readonly level: number;
}

/**
 * `match`'s own end, clipped to `other`'s heading when `other` is nested
 * inside `match`'s range — whichever heading, tasks or completed-tasks, is
 * written first and shallower encloses the other one's range unless both
 * directions are clipped this way.
 */
export function clippedEnd(match: HeadingMatch, other: HeadingMatch | null): number {
	if (other !== null && other.heading > match.heading && other.heading < match.end) {
		return other.heading;
	}
	return match.end;
}

/**
 * Where `headingText` opens a section in `content`, matched at whichever level
 * it is actually written at, the same "try every level" reading
 * `copyIn.ts`'s own `collectionHeadingRange` uses — carried here rather than
 * imported, since the two are separate modules of this one feature and
 * `copyIn.ts`'s own copy is private to it.
 */
export function findHeading(content: string, headingText: string): HeadingMatch | null {
	const text = headingText.trim();
	if (!text) return null;
	for (let level = 1; level <= 6; level += 1) {
		const found = headingRange(content, text, level);
		if (found !== null) return { ...found, level };
	}
	return null;
}

/** The whitespace `line` opens with, spaces and tabs, however much or little. */
export function indentOf(line: string): string {
	const match = /^[ \t]*/.exec(line);
	return match === null ? "" : match[0];
}

/**
 * Whether the task at `rootIndex` (indent `rootIndent`) sits under an
 * enclosing task line at all, within `[start, rootIndex)` — see the module
 * comment's *Waiting for the parent*. The nearest line with a strictly
 * shallower indent decides; a blank line is skipped rather than read as the
 * enclosing line, and a shallower line that is not a task at all means there
 * is no enclosing task to wait for.
 *
 * **The enclosing line's own meaning is never asked.** A subtask only ever
 * moves by being carried along in its enclosing task's own cascade (below),
 * never by a call keyed to its own eid — so it waits for that call whether
 * the enclosing line reads open, done, cancelled or forwarded. Reading the
 * meaning here used to let a subtask through the moment its enclosing line
 * read done or cancelled, on the assumption that line was about to cascade
 * it along in the same call; that assumption fails whenever the enclosing
 * line is never itself the subject of a call — an unmarked parent with no
 * date, never copied and so never visited by `reconcileAll`'s own sweep of
 * marked eids — or whenever only the *nearest* line was asked, so a
 * done parent that is itself still waiting on its own open grandparent read
 * as "no open parent" for the grandchild.
 */
export function hasEnclosingTask(
	lines: readonly string[],
	rootIndex: number,
	rootIndent: number,
	start: number,
): boolean {
	for (let index = rootIndex - 1; index >= start; index -= 1) {
		if (lines[index] === "") continue;
		if (indentOf(lines[index]).length >= rootIndent) continue;
		return parseTaskLine(lines[index]) !== null;
	}
	return false;
}

/** The line index in `[start, end)` whose own marker carries `eid`, or -1. */
function eidIndexIn(lines: readonly string[], start: number, end: number, eid: string): number {
	for (let index = start; index < end; index += 1) {
		const parsed = parseTaskLine(lines[index]);
		if (parsed === null) continue;
		const marker = readMarker(parsed);
		if (marker !== null && marker.eid === eid) return index;
	}
	return -1;
}

/**
 * An index into the pre-removal line array, mapped to where it now points
 * after the block `[rootIndex, rootIndex + removedCount)` has been spliced
 * out. An index at or before `rootIndex` is untouched — the removal starts
 * there — and every other index this module ever maps sits at or past the
 * removed block's own end, so the only other case is a shift down by
 * `removedCount`.
 */
function shiftedIndex(index: number, rootIndex: number, removedCount: number): number {
	return index > rootIndex ? index - removedCount : index;
}

/**
 * A note as lines without their ending, and for each line how it ended:
 * `true` for `\r\n`, `false` for a bare `\n`, `null` for no ending of its own
 * (the note's last line) or a line the move writes new. Every line the move
 * does not touch is written back with the ending it had, byte for byte; a
 * `null` takes the ending of the line before it, so the moved line and the line
 * it lands after follow their neighbour.
 */
export interface Lines {
	readonly lines: string[];
	readonly endings: (boolean | null)[];
}

export function splitLines(text: string): Lines {
	if (text === "") return { lines: [], endings: [] };
	const raw = text.split("\n");
	return {
		lines: raw.map((line) => line.replace(/\r$/, "")),
		endings: raw.map((line, index) => (index === raw.length - 1 ? null : line.endsWith("\r"))),
	};
}

export function joinLines(lines: readonly string[], endings: readonly (boolean | null)[]): string {
	let previous = false;
	let text = "";
	lines.forEach((line, index) => {
		text += line;
		if (index === lines.length - 1) return;
		const carriage = endings[index] ?? previous;
		previous = carriage;
		text += carriage ? "\r\n" : "\n";
	});
	return text;
}

/**
 * Where the subtree rooted at `rootIndex` (indent `rootIndent`) ends within
 * `[rootIndex + 1, limit)`. A blank line ends the subtree only when the next
 * non-blank line, looking past every blank in a run, is not deeper than the
 * root; a blank line that does not end it travels with the rest of the block.
 */
export function subtreeEndFrom(
	lines: readonly string[],
	rootIndex: number,
	rootIndent: number,
	limit: number,
): number {
	let end = rootIndex + 1;
	while (end < limit) {
		if (lines[end] === "") {
			let next = end + 1;
			while (next < limit && lines[next] === "") next += 1;
			if (next >= limit || indentOf(lines[next]).length <= rootIndent) break;
			end = next;
			continue;
		}
		if (indentOf(lines[end]).length <= rootIndent) break;
		end += 1;
	}
	return end;
}

/** Where the two headings and their searchable ranges sit, handed to whatever finds the line to move. */
interface MoveContext {
	readonly lines: readonly string[];
	readonly tasksMatch: HeadingMatch;
	/** End of the tasks heading's own range, clipped against the completed-tasks heading. */
	readonly tasksEnd: number;
	readonly completedMatch: HeadingMatch | null;
	/** End of the completed-tasks heading's own range, clipped against the tasks heading. */
	readonly completedSearchEnd: number;
}

/**
 * The shared move: finds the line with `findRoot` (an index into
 * `MoveContext.lines`, or -1 for "nothing to move") and moves it, with its
 * subtree, under the completed-tasks heading — the guard, the cascade, the
 * waiting-for-the-parent rule and the two headings' rules all live here, once,
 * so a call keyed to a pairing and a call keyed to a line cannot drift apart.
 */
function moveFinishedTask(
	collectionText: string,
	layout: VaultLayout,
	findRoot: (context: MoveContext) => number,
): CompleteResult {
	const unchanged: CompleteResult = { collection: collectionText, moved: false };

	const completedText = layout.completedTasksHeading.trim();
	if (completedText === "") return unchanged;

	const tasksMatch = findHeading(collectionText, layout.tasksHeading);
	if (tasksMatch === null) return unchanged;

	const completedMatch = findHeading(collectionText, layout.completedTasksHeading);
	const { lines, endings } = splitLines(collectionText);
	const endsWithNewline = lines.length > 0 && lines[lines.length - 1] === "";

	// Whichever of the two headings is written first and shallower encloses
	// the other one's range; both directions are clipped against it the same
	// way, or a completed-tasks heading enclosing the tasks heading would
	// find every not-yet-completed task "already under completed".
	const completedSearchEnd = completedMatch === null ? 0 : clippedEnd(completedMatch, tasksMatch);
	const tasksEnd = clippedEnd(tasksMatch, completedMatch);

	const rootIndex = findRoot({ lines, tasksMatch, tasksEnd, completedMatch, completedSearchEnd });
	if (rootIndex === -1) return unchanged;

	const root = parseTaskLine(lines[rootIndex]);
	if (root === null || (root.meaning !== "done" && root.meaning !== "cancelled")) return unchanged;

	const rootIndent = indentOf(lines[rootIndex]).length;
	if (hasEnclosingTask(lines, rootIndex, rootIndent, tasksMatch.start)) return unchanged;

	const subtreeEnd = subtreeEndFrom(lines, rootIndex, rootIndent, tasksEnd);

	const movedLines = lines.slice(rootIndex, subtreeEnd).map((line, offset) => {
		if (offset === 0) return line;
		const parsed = parseTaskLine(line);
		if (parsed === null) return line;
		// A real `[ ]`, or a paired `[/]` still open by the feature's own
		// reading, follows the parent; anything else — done, cancelled,
		// forwarded, or a character the core does not recognise (which parses
		// as `open` but is not the one character that means it) — is left
		// exactly as it is.
		if (parsed.checkbox !== " " && parsed.meaning !== "copied") return line;
		return editTaskField(line, "checkbox", root.checkbox);
	});

	const removedCount = subtreeEnd - rootIndex;
	const withoutMoved = [...lines.slice(0, rootIndex), ...lines.slice(subtreeEnd)];
	const movedEndings = endings.slice(rootIndex, subtreeEnd);
	const endingsWithoutMoved = [...endings.slice(0, rootIndex), ...endings.slice(subtreeEnd)];

	if (completedMatch !== null) {
		// The section's own trailing blank lines stay after the moved block,
		// which lands right after its last real content instead.
		let contentEnd = completedMatch.end;
		while (contentEnd > completedMatch.start && lines[contentEnd - 1] === "") {
			contentEnd -= 1;
		}
		const insertAt = shiftedIndex(contentEnd, rootIndex, removedCount);
		withoutMoved.splice(insertAt, 0, ...movedLines);
		endingsWithoutMoved.splice(insertAt, 0, ...movedEndings);
		return { collection: joinLines(withoutMoved, endingsWithoutMoved), moved: true };
	}

	const level = clampLevel(tasksMatch.level);
	const headingLine = `${"#".repeat(level)} ${completedText}`;
	const insertAt = shiftedIndex(tasksMatch.end, rootIndex, removedCount);
	const needsLeadingBlank = insertAt > 0 && withoutMoved[insertAt - 1] !== "";
	// A blank line separates the new heading from whatever already follows
	// it; at the very end of the file, a blank is added only when the file
	// itself already ended in one — never gained, never dropped.
	const needsTrailingBlank =
		insertAt < withoutMoved.length ? withoutMoved[insertAt] !== "" : endsWithNewline;
	const block = [
		...(needsLeadingBlank ? [""] : []),
		headingLine,
		"",
		...movedLines,
		...(needsTrailingBlank ? [""] : []),
	];
	const blockEndings = [
		...(needsLeadingBlank ? [null] : []),
		null,
		null,
		...movedEndings,
		...(needsTrailingBlank ? [null] : []),
	];
	withoutMoved.splice(insertAt, 0, ...block);
	endingsWithoutMoved.splice(insertAt, 0, ...blockEndings);
	return { collection: joinLines(withoutMoved, endingsWithoutMoved), moved: true };
}

/**
 * Moves the task `eid` names, with its subtree, from `collectionText`'s tasks
 * heading to its completed-tasks heading — see the module comment for the
 * guard, the cascade and the two headings' own rules.
 */
export function completeInCollection(
	collectionText: string,
	eid: string,
	layout: VaultLayout,
): CompleteResult {
	return moveFinishedTask(
		collectionText,
		layout,
		({ lines, tasksMatch, tasksEnd, completedMatch, completedSearchEnd }) => {
			if (
				completedMatch !== null &&
				eidIndexIn(lines, completedMatch.start, completedSearchEnd, eid) !== -1
			) {
				return -1;
			}
			return eidIndexIn(lines, tasksMatch.start, tasksEnd, eid);
		},
	);
}

/**
 * The same move, keyed to the line's place instead of a pairing: `lineIndex`
 * is a 0-based index into `collectionText.split("\n")`, and it must fall
 * under the tasks heading — a line anywhere else, past the end, or negative
 * leaves the text as it is. The line's pairing marker is never read, so a
 * finished task that carries none moves exactly as a paired one does; the
 * guard (the line's own meaning is `done` or `cancelled`) is the same.
 */
export function completeLineInCollection(
	collectionText: string,
	lineIndex: number,
	layout: VaultLayout,
): CompleteResult {
	return moveFinishedTask(collectionText, layout, ({ tasksMatch, tasksEnd }) =>
		Number.isInteger(lineIndex) && lineIndex >= tasksMatch.start && lineIndex < tasksEnd
			? lineIndex
			: -1,
	);
}
