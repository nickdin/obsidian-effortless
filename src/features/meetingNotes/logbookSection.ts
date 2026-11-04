/**
 * One collection's logbook section, rewritten to hold a link to each meeting
 * note naming it.
 *
 * Pure code over a note's text. The feature's own lines — the ones its memory
 * names (`logbookMemory.ts`), matched by exact text — are taken out of the
 * section, and the lines wanted now are put back at its top, newest first, so
 * they sit above every line the person wrote there. A line the feature did not
 * write is never moved, changed or taken out, and a meeting a line the person
 * wrote already links gets no second one.
 *
 * The section is found with the core's own heading rule (`headingRange` in
 * `markdownSections.ts`): the heading at its level, as a whole line, outside a
 * fenced block, running to the next heading of the same or a larger size. A
 * note without it gets nothing; the heading is never created.
 *
 * **Line endings.** Every line keeps its own ending. A line written into a
 * note with Windows line endings gets one too, and a note that did not end in
 * a line break still does not after a line is put at, or taken from, its end.
 */

import { headingRange } from "../../core/markdownSections";
import type { HeadingParts } from "../../core/markdownSections";
import type { LogbookEntry } from "./logbookMemory";

/** One line wanted under the heading: the meeting note it links, its date, and the line itself. */
export interface WantedLine {
	readonly note: string;
	/** `YYYY-MM-DD`, or `null` when the note's date is not known, which sorts after every dated one. */
	readonly date: string | null;
	/** The line without its line ending: the card's logbook line start (`-` by default, #1269), a space, and the link as the vault's link setting writes it. */
	readonly line: string;
}

/** The section's new text, and the feature's lines in it now, top first. */
export interface LogbookOutcome {
	readonly text: string;
	readonly owned: LogbookEntry[];
}

/**
 * `content` with the feature's lines under the heading (`heading.text` at
 * `heading.level`) made the `wanted` ones, or `null` when the note does not
 * carry that heading. `owned` is what the memory says the feature wrote here;
 * `linksNote` says whether a line links a meeting note, and is asked only of
 * lines the feature did not write. A line of its own that is no longer in the
 * section — the person took it out — is simply forgotten.
 */
export function withLogbook(
	content: string,
	heading: HeadingParts,
	owned: readonly LogbookEntry[],
	wanted: readonly WantedLine[],
	linksNote: (line: string, note: string) => boolean,
): LogbookOutcome | null {
	const range = headingRange(content, heading.text, heading.level);
	if (range === null) return null;

	const lines = content.split("\n");
	const ending = content.includes("\r\n") ? "\r" : "";
	const lastLineEndsInCarriageReturn = lines[lines.length - 1].endsWith("\r");

	// The feature's own lines, each claimed once, top down.
	const claimed = new Set<number>();
	for (const entry of owned) {
		for (let i = range.start; i < range.end; i += 1) {
			if (claimed.has(i)) continue;
			const bare = lines[i].replace(/\r$/, "");
			if (bare === entry.line || bare === entry.was) {
				claimed.add(i);
				break;
			}
		}
	}

	const others: number[] = [];
	for (let i = range.start; i < range.end; i += 1) if (!claimed.has(i)) others.push(i);
	const toWrite = [...wanted]
		.filter((want) => !others.some((i) => linksNote(lines[i].replace(/\r$/, ""), want.note)))
		.sort(newestFirst);

	// Where the lines go: where the feature's own top line was, so every line
	// around them — a blank one the person left below them included — stays
	// where it is. With none of its lines there yet: above the first line the
	// person wrote, below any blank lines straight under the heading; under the
	// heading itself when the section holds nothing but blank lines.
	const firstWritten = others.find((i) => lines[i].trim() !== "");
	const at = claimed.size > 0 ? Math.min(...claimed) : (firstWritten ?? range.start);

	const result: string[] = [];
	let oldLastAt = -1;
	for (let i = 0; i <= lines.length; i += 1) {
		if (i === at) result.push(...toWrite.map((want) => want.line + ending));
		if (i < lines.length && !claimed.has(i)) {
			if (i === lines.length - 1) oldLastAt = result.length;
			result.push(lines[i]);
		}
	}

	if (!lastLineEndsInCarriageReturn && ending !== "") {
		// The note's last line had no ending; whichever line is last now has none,
		// and the old last line, if something now follows it, gets one.
		if (oldLastAt >= 0 && oldLastAt < result.length - 1) result[oldLastAt] += ending;
		result[result.length - 1] = result[result.length - 1].replace(/\r$/, "");
	}

	return { text: result.join("\n"), owned: toWrite.map((want) => ({ note: want.note, line: want.line })) };
}

/** Newest date first, an unknown date last, then by path so the order is the same every time. */
function newestFirst(a: WantedLine, b: WantedLine): number {
	if (a.date !== b.date) {
		if (a.date === null) return 1;
		if (b.date === null) return -1;
		return a.date < b.date ? 1 : -1;
	}
	return a.note.localeCompare(b.note);
}
