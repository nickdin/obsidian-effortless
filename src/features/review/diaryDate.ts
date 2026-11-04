/**
 * The diary-date write: the one change Review makes to a day's log without
 * being asked (ticket #1109,
 * spec #1049, ADR 0005).
 *
 * The twin of {@link markProcessedText}: a pure function from a note's text to
 * its new text, handed to the core's `NoteWriter`, which runs it on the note's
 * current text. It changes the diary-date field's line and no other byte: the
 * line endings, the final line break (or its absence), the other properties and
 * the body all stay.
 *
 * **It answers `null`, never throws, when there is nothing to record**: the
 * diary section holds no text, the heading is absent, blank or at another
 * level, or the field already holds a value. A value typed by hand counts, and
 * nothing here ever overwrites one.
 *
 * What counts as an empty field, and the line it becomes, is
 * {@link markProcessedChange}'s rule, used as it stands, so the two writes can
 * never disagree about whether `processed: null` is empty. The diary-date field
 * is written as a bare `YYYY-MM-DD`, which is the shape the chain reader reads.
 *
 * **Two guards say when the text is not the person's**, both on the
 * {@link DiaryContext} the caller hands in: a log for a day after the day being
 * recorded is never stamped, and a diary section that is still what the day's-log
 * template made is not the person's words. **A log that carries the mark of the
 * section it was built with** (`effortless-built-diary`, `src/core/builtDiaryMark.ts`,
 * ticket #1207) is judged by
 * that mark, read from its own text, before anything the caller hands in.
 */

import { builtDiaryMarkIn, comparableDiary, diaryFingerprint } from "../../core/builtDiaryMark";
import { frontmatterEnd, headingRange } from "../../core/markdownSections";
import { markProcessedChange } from "./markProcessed";
import type { ProcessedChange } from "./markProcessed";

/** A byte-order mark: not part of the opening rule to Obsidian, so the new block goes after it. */
const BYTE_ORDER_MARK = "﻿";

/** What the caller knows about the log that the log's text does not say. */
export interface DiaryContext {
	/** The log's own day (`YYYY-MM-DD`), or `null`/absent when it is not known. A log for a day after the day being recorded is never stamped: days ahead builds those, and nobody has written in them. A past day's log is stamped, with the day its text was seen. */
	readonly logDay?: string | null;
	/** The text the day's-log template puts under the diary heading ({@link dailyLogTemplateDiary}'s answer), or `null`/absent when the log is not built from one. While the section is exactly this, nothing has been written. Not read for a log that carries the mark of the section it was built with. */
	readonly templateDiary?: string | null;
}

/**
 * `text` with the diary-date field set to `today`, or `null` when there is
 * nothing to record.
 *
 * The diary section is the core's range for `heading` at `level`
 * ({@link headingRange}, which is what the core's `sectionRange` reads for the
 * layout's diary heading), so a heading inside a fence, or at another level, is
 * not the diary's. It is read below the note's frontmatter, so a `# Diary`
 * comment line inside the frontmatter is not taken for the heading. Any line
 * that is not blank under the heading, up to the next heading of the same or a
 * shallower level, is diary text; the heading line itself is not.
 *
 * Then, by the field's state in the frontmatter:
 * - present and empty: its line becomes `<field>: <today>` (a trailing comment
 *   stays; both lines of an empty list spread over two are replaced by that one
 *   line), as {@link markProcessedChange} decides;
 * - present with any value: `null`;
 * - absent from an existing block: `<field>: <today>` is added as the block's
 *   last line;
 * - no block: one is put in front of the note, carrying the one field.
 *
 * `today` is `YYYY-MM-DD`; the caller reads the clock when the change was
 * reported, so a test pins it. Throws when `field` is blank, which no layout the
 * settings store hands out has.
 */
export function diaryDateText(
	text: string,
	heading: string,
	level: number,
	field: string,
	today: string,
	context: DiaryContext = {},
): string | null {
	if (field.trim() === "") throw new Error("the property that records the diary's day has no name, so there is no line to write");
	// Compared as text: `YYYY-MM-DD` orders the way the days do.
	if (context.logDay != null && context.logDay > today) return null;

	// A note whose only line endings are carriage returns (an old Mac file) is
	// still lines to Obsidian; split it on the ending it has and join it on the same.
	const eol = !text.includes("\n") && text.includes("\r") ? "\r" : "\n";
	const lines = text.split(eol);
	// A byte-order mark in front of the opening rule is not part of the rule.
	const end = frontmatterEnd([lines[0]?.replace(BYTE_ORDER_MARK, "") ?? "", ...lines.slice(1)]);

	const body = lines.slice(end + 1);
	if (end === -1 && body.length > 0) body[0] = body[0].replace(BYTE_ORDER_MARK, "");
	if (!holdsDiaryText(body, heading, level, builtDiaryMarkIn(text), context.templateDiary ?? null)) return null;

	if (end === -1) {
		// Windows endings anywhere in the note mean the block is written with them.
		const ending = eol === "\n" && text.includes("\r\n") ? "\r\n" : eol;
		const bom = text.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK : "";
		return `${bom}---${ending}${field}: ${today}${ending}---${ending}${text.slice(bom.length)}`;
	}

	if (hasKey(lines, end, field)) {
		let change: ProcessedChange | null;
		try {
			change = markProcessedChange(lines, field, today, true);
		} catch {
			// The only refusal for a line that is there: it already holds a value.
			return null;
		}
		// A field that already holds today's date needs no write either.
		if (change === null) return null;
		lines.splice(change.index, 1 + change.removeAfter, change.line);
		return lines.join(eol);
	}

	// The closing rule's own ending is the block's: `---\r` on Windows endings.
	const carriageReturn = lines[end].endsWith("\r") ? "\r" : "";
	lines.splice(end, 0, `${field}: ${today}${carriageReturn}`);
	return lines.join(eol);
}

/**
 * Whether `body` (a note's lines below its frontmatter) holds a non-blank line
 * under the diary heading that is the person's: not the section the log was built
 * with, by {@link isBuiltSection}.
 */
function holdsDiaryText(body: readonly string[], heading: string, level: number, mark: string | null, templateDiary: string | null): boolean {
	const range = headingRange(body.join("\n"), heading, level);
	if (range === null) return false;
	const section = body.slice(range.start, range.end);
	if (!section.some((line) => line.trim() !== "")) return false;
	return !isBuiltSection(section, mark, templateDiary);
}

/**
 * Whether `section` (the lines under a log's diary heading) is still the section
 * the log was built with, so nothing in it is the person's. By `mark`, the
 * fingerprint the log's own frontmatter records ({@link builtDiaryMarkIn}), when it
 * carries one;
 * otherwise by `templateDiary` ({@link isTemplateDiary}), and never when neither is
 * there. Both compare the lines with the line endings, the spaces at each line's
 * end and the blank lines after the last text left out, none of which anyone
 * writes on purpose. The stamp and the *diary empty* sign both ask this, so they
 * agree on what the person has not written.
 */
export function isBuiltSection(section: readonly string[], mark: string | null, templateDiary: string | null): boolean {
	if (mark !== null) return diaryFingerprint(section) === mark;
	return templateDiary !== null && isTemplateDiary(section, templateDiary);
}

/**
 * Whether `text` has a diary section that is exactly the one it was built with —
 * by its own mark when it carries one, else `templateDiary`, the diary the
 * day's-log template would have produced ({@link isBuiltSection}): the log holds
 * only what the template made, which is no diary at all. Read below the
 * frontmatter like {@link diaryDateText}.
 */
export function diaryIsTemplates(text: string, heading: string, level: number, templateDiary: string | null): boolean {
	const lines = text.split("\n");
	const body = lines.slice(frontmatterEnd(lines) + 1);
	const range = headingRange(body.join("\n"), heading, level);
	return range !== null && isBuiltSection(body.slice(range.start, range.end), builtDiaryMarkIn(text), templateDiary);
}

/**
 * Whether `section` (the lines under the diary heading) is exactly the diary
 * section `templateDiary` ({@link dailyLogTemplateDiary}'s answer) describes:
 * the same comparison the diary-date decision makes, so the *diary empty* sign
 * and the stamp agree on what the person has not written.
 */
export function isTemplateDiary(section: readonly string[], templateDiary: string): boolean {
	return comparableDiary(section) === comparableDiary(templateDiary.split("\n"));
}

/** Whether a top-level line in the frontmatter (lines `1` to `end - 1`) is the key `field`, bare or in matching quotes. */
function hasKey(lines: readonly string[], end: number, field: string): boolean {
	for (let i = 1; i < end; i += 1) {
		const line = lines[i].replace(/\r$/, "");
		const colon = line.indexOf(":");
		if (colon === -1 || /^\s/.test(line)) continue;
		const key = line.slice(0, colon).trim();
		const unquoted = /^(["']).*\1$/.test(key) && key.length >= 2 ? key.slice(1, -1) : key;
		if (unquoted === field) return true;
	}
	return false;
}
