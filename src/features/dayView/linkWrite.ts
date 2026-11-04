/**
 * Click-to-link, worked out: the clicked block's lines with one plain meeting
 * cell made a link, or the reason nothing may be written.
 *
 * Pure code over strings. `linkWrite` itself is handed only the lines of the
 * one block a caller located and asks it to rewrite; a held write's own
 * caller finds those lines by content, so a look-alike block
 * elsewhere in the note can be the one written if it reads closer to what
 * was drawn than the real one does. The row within the handed block is found
 * and rewritten by the core (`parseCalendarTable` and `editCalendarCell`),
 * which leaves every byte outside the one cell as it was; nothing here reads
 * or writes a table of its own.
 *
 * A held write cannot trust Obsidian's section information once the note has
 * been left: a line added or removed above the block while the write waited
 * moves it, so `linkWrite`'s own lines have to be found fresh in the note as
 * it now reads, not sliced by a position captured at the click. That is
 * {@link locateHeldBlock}'s job; {@link restoreLocatedBlock}
 * puts back what it set aside from a block written inside a callout. Obsidian
 * gives no section information at all for a block nested in a callout, so
 * those lines are never sliced from one; `locateHeldBlock` reads them
 * straight from the note's own raw lines, which is where the callout's `> `
 * marker is found and set aside.
 *
 * Carried from `~/Devbox/schema-render/src/writeback.ts:40-130`, with one guard
 * made stricter: the old one checked only that the row held *some* time, so a
 * row that had moved since the block was drawn had whichever row now sat there
 * rewritten (old issue #28, named difference 10). Here the row must still read
 * exactly the time and meeting the block was drawn from.
 */

import { closesFence, openingFence } from "../../core/markdownSections";
import { editCalendarCell, parseCalendarTable } from "../../core/calendarTable";
import type { ColumnNames } from "../../core/calendarTable";
import type { SectionCache } from "obsidian";
import { readMeetingCell } from "./meetingCell";

/** The two cells of the row a block was drawn from, as the core's reader read them then. */
export interface DrawnRow {
	readonly time: string;
	readonly meeting: string;
}

/**
 * Why nothing may be written:
 *
 * - `table-changed` — the lines no longer hold that row reading what was drawn:
 *   the row moved, changed, or went, or the table did.
 * - `already-a-link` — the cell is a link already; it is never written again.
 * - `mixed-link` — the cell holds `[[` the meeting-cell reading did not take as
 *   one whole link, so it names no note (named difference 11).
 * - `empty` — there is no name to make a link of.
 * - `pipe-in-name` — the name holds a `|`, which a link would read as the start
 *   of an alias, so the link written would name a different note.
 */
export type LinkWriteRefusal = "table-changed" | "already-a-link" | "mixed-link" | "empty" | "pipe-in-name";

export type LinkWriteOutcome = { readonly lines: string[] } | { readonly refused: LinkWriteRefusal };

/**
 * `blockLines` with the meeting cell of data row `row` made a link — `Möte
 * (Skype)` becomes `[[Möte]] (Skype)`, the trailing parenthesis kept outside
 * the link — when that row still reads `drawn`; otherwise the refusal.
 *
 * `row` counts the table's data rows from zero, as `readDay` numbers them.
 */
export function linkWrite(
	blockLines: readonly string[],
	columns: ColumnNames,
	row: number,
	drawn: DrawnRow,
): LinkWriteOutcome {
	const outcome = parseCalendarTable(blockLines, columns);
	if (!outcome.found) return { refused: "table-changed" };

	const now = outcome.table.rows[row];
	if (now === undefined || now.time !== drawn.time || now.event !== drawn.meeting) {
		return { refused: "table-changed" };
	}

	const cell = readMeetingCell(now.event);
	if (cell.isWikilink) return { refused: "already-a-link" };
	if (cell.looksLikeLink) return { refused: "mixed-link" };
	if (cell.linktext === null) return { refused: "empty" };
	if (cell.linktext.includes("|")) return { refused: "pipe-in-name" };

	const value = cell.trailingParen === null ? `[[${cell.linktext}]]` : `[[${cell.linktext}]] (${cell.trailingParen})`;
	const edited = editCalendarCell(blockLines, columns, { row, column: "event", value });
	// The same lookup found the row a moment ago, over the same lines.
	if (!edited.found) return { refused: "table-changed" };
	return { lines: edited.lines };
}

/**
 * One fenced `schema` block found fresh in a note's own lines, fence to
 * fence, with each line's own leading run of spaces, tabs and `>` set aside
 * so {@link restoreLocatedBlock} can put it back untouched (Ticket #668: a
 * block written inside a callout carries that marker on every line,
 * fences included, and the table reader wants none of it).
 */
export interface LocatedBlock {
	/** Index of the block's opening fence line in the note it was found in. */
	readonly from: number;
	/** One past the block's closing fence line, or the note's length when the fence never closes. */
	readonly to: number;
	/** Each line's own leading run, fence lines included, in the order the lines came in. */
	readonly prefixes: readonly string[];
	/** The block's lines, fence to fence, with that leading run taken off each one — what {@link linkWrite} reads and rewrites. */
	readonly lines: readonly string[];
}

/**
 * The clicked block's current lines in `noteLines`, found fresh rather than
 * trusted from a position captured at the click: a line added or removed
 * above the block while a held write waits must not misdirect it. `null` when nothing in `noteLines` reads as a `schema` block at all.
 *
 * Picked as whichever fenced `schema` block in `noteLines` reads closest to
 * `bodyLines` — the block's own lines as they were drawn — counting how many
 * lines agree at the same position; ties, and a note holding no schema block
 * that agrees at all, are broken by distance to `hint`, the line the block's
 * own fence opened at when it was drawn. A row inside the block that has
 * since changed still leaves this the closest block: whether that row still
 * reads what was drawn is {@link linkWrite}'s own question, asked after this
 * one, over the lines this returns.
 */
export function locateHeldBlock(
	noteLines: readonly string[],
	bodyLines: readonly string[],
	hint: number,
): LocatedBlock | null {
	let best: LocatedBlock | null = null;
	let bestScore = -1;
	let bestDistance = Infinity;

	for (const candidate of schemaFencedBlocks(noteLines)) {
		const body = candidate.lines.slice(1, candidate.lines.length - 1);
		const score = agreeingLines(body, bodyLines);
		const distance = Math.abs(candidate.from - hint);
		if (score > bestScore || (score === bestScore && distance < bestDistance)) {
			best = candidate;
			bestScore = score;
			bestDistance = distance;
		}
	}

	return best;
}

/**
 * Whether `block`, as {@link locateHeldBlock} found it, lies inside one of
 * `sections` — a note's own `callout` or `blockquote` sections, read from its
 * metadata cache.
 *
 * A note may hold a callout anywhere, but Obsidian's absent section
 * information means the block is genuinely inside one — driven,
 * `docs/acceptance-shots/issue-657-668-drive.txt` — or,
 * reasoned the same way but not driven, that the note is an exported view;
 * no drive in this repository has produced one. A whole-note embed is not
 * among them: Obsidian 1.13.7 hands it real section information for the
 * embedded note's own lines, counted from the note's own line 0 (driven,
 * `docs/acceptance-shots/issue-685-drive.txt`, Ticket #685). A heading or
 * block embed also gets real section information, but counted from the
 * embedded slice's own line 0, not the note's (same drive, "a heading embed
 * over two identical blocks") — either way real, so an embedded block is
 * written the ordinary way without ever reaching this function. Whether a
 * block embedded by heading or block reference, itself sitting inside a
 * callout in the embedded note, still reaches here has not been driven;
 * reasoned only, on the same absent-section behaviour the callout case above
 * showed for a block rendered directly. The callout case is told apart from
 * an exported view here, by line range, rather than by whether the note
 * holds a callout at all: an embedded block's own cache is the embedded
 * note's, and it may hold a callout the clicked block never sits in.
 */
export function blockInsideCallout(block: LocatedBlock, sections: readonly SectionCache[]): boolean {
	return sections.some((s) => s.position.start.line <= block.from && block.to - 1 <= s.position.end.line);
}

/** `edited`, a located block's lines after {@link linkWrite} rewrote them, with each line's set-aside prefix put back on — the inverse of what {@link locateHeldBlock} took off. */
export function restoreLocatedBlock(edited: readonly string[], block: LocatedBlock): string[] {
	return edited.map((line, i) => block.prefixes[i] + line);
}

/** How many lines of `a` and `b` read the same, at the same index. */
function agreeingLines(a: readonly string[], b: readonly string[]): number {
	let matches = 0;
	const length = Math.min(a.length, b.length);
	for (let i = 0; i < length; i++) {
		if (a[i] === b[i]) matches++;
	}
	return matches;
}

/**
 * Every fenced `schema` block in `lines`, fence to fence, with each line's
 * leading run of spaces, tabs and `>` set aside before the fence rule is
 * asked — the same generosity `rename.ts`'s `schemaBlockRanges` and
 * `registry.ts`'s `holdsBlockOf` give a `schema` block for the same reason: a
 * block drawn inside a callout or blockquote is still a block Obsidian
 * writes into. Carried locally rather than imported from either, since this
 * module reads raw note lines neither of those own.
 */
function schemaFencedBlocks(lines: readonly string[]): LocatedBlock[] {
	const blocks: LocatedBlock[] = [];

	for (let i = 0; i < lines.length; i++) {
		const prefix = leadingRun(lines[i]);
		const fence = openingFence(lines[i].slice(prefix.length));
		if (!fence) continue;

		let end = lines.length;
		for (let j = i + 1; j < lines.length; j++) {
			if (closesFence(lines[j].slice(leadingRun(lines[j]).length), fence)) {
				end = j;
				break;
			}
		}
		// An unclosed fence runs to the end of what it was given, as CommonMark says.
		const to = end < lines.length ? end + 1 : lines.length;

		if (isSchemaInfo(fence.info)) {
			const prefixes: string[] = [];
			const stripped: string[] = [];
			for (let k = i; k < to; k++) {
				const p = leadingRun(lines[k]);
				prefixes.push(p);
				stripped.push(lines[k].slice(p.length));
			}
			blocks.push({ from: i, to, prefixes, lines: stripped });
		}
		i = end;
	}

	return blocks;
}

/** A line's own leading run of spaces, tabs and `>` — a callout's or a blockquote's own marker, and any indentation before it. */
function leadingRun(line: string): string {
	return /^[ \t>]*/.exec(line)?.[0] ?? "";
}

/** Whether a fence's info string names a `schema` block: its first word, capitals ignored — the same rule `calendarTable.ts`'s reader states, restated here because this module reads a note's raw lines, which that reader never does. */
function isSchemaInfo(info: string): boolean {
	return (info.split(/\s+/)[0] ?? "").toLowerCase() === "schema";
}
