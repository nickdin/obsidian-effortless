/**
 * Which lines a filing takes, and what travels with each.
 *
 * Pure over text. The command hands it the editor's text, the selected line
 * range (a lone cursor is a range of one line) and what the note is (a day's
 * log or another note, #981);
 * it answers which top-level lines may be filed, each with the sub-lines
 * indented under it, and which lines were left out and why.
 * {@link filableCheck} decides every line, so a selection is never more
 * permissive than one press on one line, in either kind of note.
 *
 * - **A line's subtree** is the lines directly after it that are indented
 *   deeper than it, up to the first blank line or the first line no deeper.
 *   It travels whether or not the selection reaches it.
 * - **A top-level line** is a selected line that is not inside the subtree of
 *   an earlier selected one. Sub-lines are never filed on their own, so a
 *   selection that runs over a whole task does not file its children twice.
 *   When a top line is left out, its sub-lines stay with it and are not looked
 *   at again.
 * - **In a selection of several lines a blank line is ignored** without being
 *   named; on a lone cursor it is refused like any other line that is not a task.
 */

import type { VaultLayout } from "../../core/settings";
import { parseTaskLine } from "../../core/taskLine";
import { DAY_LOG, filableCheck } from "./filable";
import type { SourceNote } from "./filable";
import type { FiledLines } from "./fileInto";

/** One top-level line to file, with what is indented under it. */
export interface FilingItem {
	/** The line's index in the note it is filed from, counted from zero. */
	readonly lineIndex: number;
	/** The line as written, without a trailing carriage return. */
	readonly line: string;
	/** The sub-lines, as written, in order. Empty when it has none. */
	readonly subtree: readonly string[];
}

/** A selected line left in its note, and the sentence saying why. */
export interface SkippedLine {
	readonly lineIndex: number;
	readonly line: string;
	readonly reason: string;
}

export interface FilingPlan {
	readonly items: readonly FilingItem[];
	readonly skipped: readonly SkippedLine[];
	/** How many lines were looked at; one means the person pressed on a lone line. */
	readonly examined: number;
}

interface Position {
	readonly line: number;
	readonly ch: number;
}

/**
 * The first and last line a selection covers. A selection that ends at the very
 * start of a line does not take that line: dragging down over three lines ends
 * in column 0 of the fourth.
 */
export function selectedLineRange(from: Position, to: Position): { first: number; last: number } {
	const last = to.line > from.line && to.ch === 0 ? to.line - 1 : to.line;
	return { first: from.line, last };
}

/** A line's indentation in columns, a tab counting four. */
function indentWidth(line: string): number {
	let width = 0;
	for (const character of line) {
		if (character === " ") width += 1;
		else if (character === "\t") width += 4;
		else break;
	}
	return width;
}

const plain = (line: string): string => line.replace(/\r$/, "");
const isBlank = (line: string): boolean => plain(line).trim() === "";

/** The lines indented under `lines[index]`, as written and without carriage returns. */
export function subtreeOf(lines: readonly string[], index: number): string[] {
	const width = indentWidth(lines[index]);
	const subtree: string[] = [];
	for (let at = index + 1; at < lines.length; at += 1) {
		if (isBlank(lines[at]) || indentWidth(lines[at]) <= width) break;
		subtree.push(plain(lines[at]));
	}
	return subtree;
}

/** Whether the lines indented under `lines[index]` of `content` are exactly `subtree`. */
export function sameSubtree(content: string, index: number, subtree: readonly string[]): boolean {
	const now = subtreeOf(content.split("\n"), index);
	return now.length === subtree.length && now.every((line, at) => line === subtree[at]);
}

/**
 * Sorts lines `first` to `last` of `content` into the ones to file and the
 * ones left, in the note's order. `source` says what the note is; a caller
 * that does not say is filing from a day's log, as every caller did before #981.
 */
export function planFiling(content: string, first: number, last: number, layout: VaultLayout, source: SourceNote = DAY_LOG): FilingPlan {
	const lines = content.split("\n");
	const check = filableCheck(content, source, layout);
	const items: FilingItem[] = [];
	const skipped: SkippedLine[] = [];
	const several = last > first;
	let examined = 0;
	let coveredUntil = first - 1;

	for (let index = first; index <= Math.min(last, lines.length - 1); index += 1) {
		if (index <= coveredUntil) continue;
		const line = plain(lines[index]);
		if (several && isBlank(line)) continue;
		examined += 1;

		const subtree = subtreeOf(lines, index);
		coveredUntil = index + subtree.length;

		const answer = check(index, line);
		if (!answer.ok) {
			skipped.push({ lineIndex: index, line, reason: answer.reason });
			continue;
		}
		items.push({ lineIndex: index, line, subtree });
	}
	return { items, skipped, examined };
}

/** How much of a line a notice quotes before it is cut. */
const QUOTED = 40;

/**
 * The one notice that names every skipped line. Each is named by its line
 * number in the note and its own words, so a person can find it without the
 * notice repeating the layout's headings for every line.
 */
export function skippedNotice(skipped: readonly SkippedLine[]): string {
	const named = skipped.map((each) => {
		const words = each.line.trim();
		const quoted = words.length > QUOTED ? `${words.slice(0, QUOTED)}…` : words;
		return `line ${each.lineIndex + 1} "${quoted}": ${each.reason}`;
	});
	return `${skipped.length === 1 ? "One line was" : `${skipped.length} lines were`} left where ${skipped.length === 1 ? "it is" : "they are"}. ${named.join(" ")}`;
}

/**
 * What the collection receives for one item: the collection line and the
 * sub-lines, with the top line's own indentation taken off all of them so the
 * indentation kept is the one relative to the filed line. The marker sits on the
 * top line only.
 */
export function collectionBlock(item: FilingItem, filed: FiledLines): string[] {
	const indent = parseTaskLine(item.line)?.indent ?? "";
	// Up to the top line's own width, so a sub-line indented with other whitespace
	// than the top line still keeps whatever it has beyond it.
	const strip = (text: string): string =>
		text.startsWith(indent) ? text.slice(indent.length) : text.replace(new RegExp(`^[ \\t]{0,${indent.length}}`), "");
	return [strip(filed.collectionLine), ...item.subtree.map(strip)];
}
