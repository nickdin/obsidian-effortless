/**
 * Turning an ordinary note into a collection by writing the tasks heading at its
 * end.
 *
 * Pure over text. The heading is written at level 2, and only after the person
 * has said yes to the question in `confirmation.ts`; the filing code that puts
 * the task under it is `placeInCollection`, which this is run before.
 */

import { headingRange } from "../../core/markdownSections";

/** The level the heading is written at: a collection's own headings carry none, so the spec names two. */
const HEADING_LEVEL = 2;

/** Whether `text` already has `heading` as a heading, at whichever level it is written. */
function hasHeading(text: string, heading: string): boolean {
	for (let level = 1; level <= 6; level += 1) {
		if (headingRange(text, heading, level) !== null) return true;
	}
	return false;
}

/**
 * `text` with `heading` written as a level-2 heading at its end, one blank line
 * after what was there and a blank line under it for the task to land beneath.
 * What the note already held is not touched: the heading and its blank lines
 * are only added after it.
 *
 * `text` unchanged when it already has that heading, so a note that became a
 * collection while the question was open is not given a second one.
 */
export function withTasksHeading(text: string, heading: string): string {
	if (hasHeading(text, heading)) return text;

	const cr = text.includes("\r\n") ? "\r" : "";
	const trailing = /(?:\r?\n)*$/.exec(text)?.[0] ?? "";
	const newlinesThere = (trailing.match(/\n/g) ?? []).length;
	const separator = text === "" ? "" : `${cr}\n`.repeat(Math.max(0, 2 - newlinesThere));
	return `${text}${separator}${"#".repeat(HEADING_LEVEL)} ${heading}${cr}\n${cr}\n`;
}
