/**
 * The mark a day's log carries of the diary section it was built with (ticket
 * #1207, after
 * #1201): a frontmatter
 * property holding a fingerprint of that section, written by the note writer when
 * it builds the log from the day's-log template.
 *
 * **Why in the log.** Days ahead builds a log up to eight days before its day, and
 * Review stamps a log whose diary section holds the person's words. A log nobody
 * touched must read as untouched however the template has been reworded since.
 * `core.builtDiaries` keeps the section in `data.json`, but that file reaches
 * another device on its own schedule, and a log that arrives and is indexed there
 * first was judged against the reworded template and stamped. The mark travels
 * with the log, so whatever order Sync delivers the two in, the log answers for
 * itself. Meeting notes' `effortless-written` (`noteIdentity.ts`, #1124) holds a
 * note's fingerprint in the note for the same reason.
 *
 * **What the fingerprint covers.** The diary section only, read the way the stamp
 * compares a section with the template ({@link comparableDiary}): each line trimmed
 * at its end, the blank lines after the last text dropped. The plugin's own writes
 * elsewhere in the log — a rolled-over task, a filed line, days ahead's calendar
 * table — leave the mark true, and so do Windows line endings or a final line
 * break an editor adds. **A plugin write that changes the diary section rewrites
 * the mark**, the way every plugin write rewrites `effortless-written`; none does
 * today.
 *
 * **Read as absent when it is not a fingerprint.** The frontmatter is
 * hand-editable, so {@link builtDiaryMarkIn} trusts only a value of a fingerprint's
 * shape; anything else leaves the log to `core.builtDiaries` and the rest of the
 * #1201 order, as for a log built before the mark existed. Nothing is replaced,
 * so no notice is given.
 */

import { diarySectionOf } from "./dailyLogTemplate";
import { fingerprintOf, isFingerprint } from "./fingerprint";
import { frontmatterEnd } from "./markdownSections";
import type { VaultLayout } from "./settings";

/** The frontmatter property that holds the fingerprint of the diary section a log was built with. */
export const BUILT_DIARY_FIELD = "effortless-built-diary";

/** A byte-order mark: not part of the opening rule, so the mark's block goes after it. */
const BYTE_ORDER_MARK = "﻿";

/**
 * `lines`, a diary section's lines, as the comparison with what the log was built
 * with reads them: each trimmed at its end, the trailing blank lines dropped, joined
 * by `\n`. Line endings, the spaces at a line's end and blank lines after the last
 * text are nothing anyone writes on purpose.
 */
export function comparableDiary(lines: readonly string[]): string {
	const trimmed = lines.map((line) => line.replace(/\s+$/, ""));
	while (trimmed.length > 0 && trimmed[trimmed.length - 1] === "") trimmed.pop();
	return trimmed.join("\n");
}

/** The fingerprint of the diary section `section` (its lines), read as {@link comparableDiary} reads it. */
export function diaryFingerprint(section: readonly string[]): string {
	return fingerprintOf(comparableDiary(section));
}

/**
 * `log`, a day's log the template just built, carrying the mark of its own diary
 * section as its frontmatter block's last line — or in a block of its own in front
 * of the note when it has none. A line of the property already there, which a
 * template copied from a built log carries, is replaced rather than repeated. The
 * line takes the log's line endings, and a byte-order mark stays in front.
 */
export function withBuiltDiaryMark(log: string, layout: VaultLayout): string {
	const bom = log.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK : "";
	const text = log.slice(bom.length);
	const line = `${BUILT_DIARY_FIELD}: ${JSON.stringify(diaryFingerprint(diarySectionOf(text, layout).split("\n")))}`;
	const lines = text.split("\n");
	const end = frontmatterEnd(lines);
	if (end < 0) {
		const eol = text.includes("\r\n") ? "\r\n" : "\n";
		return `${bom}---${eol}${line}${eol}---${eol}${text}`;
	}
	const at = markLine(lines, end);
	if (at !== null) lines[at.index] = line + (lines[at.index].endsWith("\r") ? "\r" : "");
	else lines.splice(end, 0, line + (lines[end].endsWith("\r") ? "\r" : ""));
	return bom + lines.join("\n");
}

/**
 * The fingerprint `text`'s frontmatter records for the diary section it was built
 * with, or `null` when it records none: no frontmatter, no such property, or a
 * value that is not a fingerprint (blank, a list, hand-edited text). The value is
 * read quoted in either quotes, as the writer and Obsidian's property editor write
 * it, or bare.
 */
export function builtDiaryMarkIn(text: string): string | null {
	const lines = (text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text).split("\n");
	const end = frontmatterEnd(lines);
	if (end < 0) return null;
	const at = markLine(lines, end);
	if (at === null) return null;
	const value = lines[at.index].replace(/\r$/, "").slice(at.valueFrom).trim();
	return isFingerprint(unquoted(value)) ? unquoted(value) : null;
}

/** The property's key as a top-level frontmatter line can start: bare, or in either quotes, as a property editor may write it. */
const MARK_KEYS = [BUILT_DIARY_FIELD, `"${BUILT_DIARY_FIELD}"`, `'${BUILT_DIARY_FIELD}'`].map((key) => `${key}:`);

/** The top-level line of the property among the frontmatter's lines (`1` to `end - 1`) and where its value starts, or `null`. */
function markLine(lines: readonly string[], end: number): { index: number; valueFrom: number } | null {
	for (let index = 1; index < end; index += 1) {
		const key = MARK_KEYS.find((prefix) => lines[index].startsWith(prefix));
		if (key !== undefined) return { index, valueFrom: key.length };
	}
	return null;
}

/** `value` without one pair of matching quotes around it; a value in double quotes is read as JSON, and one that does not parse is returned as it is. */
function unquoted(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		try {
			const parsed: unknown = JSON.parse(value);
			return typeof parsed === "string" ? parsed : value;
		} catch {
			return value;
		}
	}
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
	return value;
}
