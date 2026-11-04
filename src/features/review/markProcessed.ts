/**
 * *Mark as processed*: the one function that rewrites a note's text, used by
 * the list's button and by the palette command.
 *
 * It changes the processed field's line to `<field>: <date>` (and, for an empty
 * list spread over two lines, the line after it too) and keeps every other byte
 * of the note: the line endings, the final line break (or its
 * absence), the other properties and the body. The feature hands this to the
 * core's `NoteWriter`, which runs it on the note's current text, so what it is
 * given is never a copy kept from an earlier read.
 *
 * **It refuses rather than guesses.** A note whose field line it cannot find
 * with an empty value — no frontmatter, no such line, a value already there, a
 * value spread over following lines other than an empty list — is a note that changed since the list was
 * drawn, or is not what the reader took it for. It throws, naming why, so the
 * writer leaves the note as it was and the feature says so.
 */

import { frontmatterEnd } from "../../core/markdownSections";

/**
 * The spellings of nothing a property can be given by hand: bare, empty quotes,
 * blank quotes, YAML's null, an empty list on one line (`[]`, `[ ]`). It is the
 * one rule for empty: the diary-date write borrows it, and the chain reads an
 * empty list as empty too, so the write and the chain never disagree. A list opened on
 * one line and closed on the next (the closing line a `]`, a comment allowed after
 * it) is not matched here: {@link markProcessedChange}
 * recognises it on its own, for the callers that can remove the second line, and refuses it
 * as filled in for the rest.
 */
const EMPTY_VALUE = /^(?:""|''|"[ \t]*"|'[ \t]*'|null|Null|NULL|~|!!null|\[[ \t]*\])?$/;

/**
 * Whether the value Obsidian's cache holds for a property is empty by
 * {@link EMPTY_VALUE}'s rule: nothing, a blank text, or a list with nothing in
 * it. The cache has already parsed what the note spells, so a list is put back
 * into its one-line spelling and asked the same question.
 */
export function isEmptyPropertyValue(value: unknown): boolean {
	if (value === undefined || value === null) return true;
	if (typeof value === "string") return value.trim() === "";
	if (Array.isArray(value)) return EMPTY_VALUE.test(JSON.stringify(value));
	return false;
}

/** A block scalar's header: `|` or `>`, optionally with a chomping sign and an indentation digit. It is empty when no text sits under it. */
const BLOCK_SCALAR = /^[|>][+-]?[1-9]?[+-]?$/;

/**
 * `text` with the processed field's line set to `<field>: <date>`.
 *
 * `date` is the day as `YYYY-MM-DD`; the caller reads the clock, so a test
 * pins it. A note whose field already holds that same day comes back
 * unchanged, because a repeated press is not a failure ({@link markProcessedChange});
 * a field holding any other value is refused. A trailing comment on the field's line (`processed: # not yet`)
 * stays after the date, because it is the person's.
 *
 * Throws an `Error` whose message says what was missing when the note has no
 * empty field of that name in its frontmatter.
 */
export function markProcessedText(text: string, field: string, date: string): string {
	// A note whose only line endings are carriage returns (an old Mac file) is
	// still lines to Obsidian; split it on the ending it has and join it on the same.
	const eol = !text.includes("\n") && text.includes("\r") ? "\r" : "\n";
	const lines = text.split(eol);
	const change = markProcessedChange(lines, field, date, true);
	if (change === null) return text;
	lines.splice(change.index, 1 + change.removeAfter, change.line);
	return lines.join(eol);
}

/**
 * The line {@link markProcessedChange} rewrites: its index in the note's lines,
 * and what the line becomes. `removeAfter` is how many lines straight after it
 * go too — 1 for a list spread over `field: [` and `]`, otherwise 0.
 */
export interface ProcessedChange {
	readonly index: number;
	readonly line: string;
	readonly removeAfter: number;
}

/**
 * The second line of an empty list opened on the line before: a closing bracket,
 * alone or followed by a YAML comment (a `#` after whitespace, as
 * {@link splitComment} reads one). Group 1 is the comment, `#` included.
 */
const LIST_CLOSE = /^[ \t]*\](?:[ \t]+(#[^\r]*?))?[ \t]*\r?$/;

/**
 * Which line of `lines` (the note split on `\n`) holds the empty processed
 * field, and what it becomes. The editor route replaces just that line, so one
 * undo puts it back; {@link markProcessedText} is the same decision applied to
 * the whole text. Throws as {@link markProcessedText} does, and answers `null`
 * for a note whose field already holds `date`: it was marked a moment ago, which
 * is not a failure when the person presses again.
 *
 * `fillSpreadList` says the caller removes `removeAfter` lines as well. Only then
 * is an empty list spread over two lines (`field: [` then `]`) filled, as the
 * chain reads it; without it that spelling is refused as filled in, because a
 * caller that rewrote only the first line would leave the `]` behind.
 */
export function markProcessedChange(lines: readonly string[], field: string, date: string, fillSpreadList = false): ProcessedChange | null {
	// A byte-order mark in front of the opening rule is not part of the rule to
	// Obsidian; it stays where it is, since line 0 is never rewritten.
	const end = frontmatterEnd([lines[0]?.replace(/^\uFEFF/, "") ?? "", ...lines.slice(1)]);
	if (end === -1) {
		throw new Error(`the note has no frontmatter, so it has no \`${field}\` line to fill in`);
	}

	for (let i = 1; i < end; i += 1) {
		const line = lines[i];
		const carriageReturn = line.endsWith("\r") ? "\r" : "";
		const body = carriageReturn === "" ? line : line.slice(0, -1);
		const colon = body.indexOf(":");
		if (colon === -1 || unquoted(body.slice(0, colon).trim()) !== field || /^\s/.test(body)) continue;

		const rest = splitComment(body.slice(colon + 1));
		if (rest.value === date) return null;
		const close = fillSpreadList && rest.value === "[" && i + 1 < end ? LIST_CLOSE.exec(lines[i + 1]) : null;
		const spread = close !== null;
		if (BLOCK_SCALAR.test(rest.value)) {
			if (hasTextUnder(lines, i + 1, end)) throw new Error(`its \`${field}\` is already filled in`);
		} else if (!spread && !EMPTY_VALUE.test(rest.value)) {
			throw new Error(`its \`${field}\` is already filled in`);
		}
		// A bare key followed by an indented line or a list item is a value
		// spread over several lines, which Obsidian reads as filled in.
		if (rest.value === "" && continues(lines[i + 1], i + 1 < end)) {
			throw new Error(`its \`${field}\` is already filled in`);
		}

		// The closing line's comment is the person's too: it goes after the opening line's own.
		const comment = rest.comment + (close?.[1] === undefined ? "" : ` ${close[1]}`);
		return { index: i, line: `${field}: ${date}${comment}${carriageReturn}`, removeAfter: spread ? 1 : 0 };
	}

	throw new Error(`the note has no \`${field}\` line in its frontmatter`);
}

/** `key` without one pair of matching quotes around it: YAML reads `"processed"` and `processed` as the same key. */
function unquoted(key: string): string {
	return /^(["']).*\1$/.test(key) && key.length >= 2 ? key.slice(1, -1) : key;
}

/** Whether a line below a block scalar's header, past blank lines and before the frontmatter closes, is indented text: its content. */
function hasTextUnder(lines: readonly string[], from: number, end: number): boolean {
	for (let i = from; i < end; i += 1) {
		if (/^[ \t]*\r?$/.test(lines[i])) continue;
		return /^[ \t]+\S/.test(lines[i]);
	}
	return false;
}

/** Whether `next`, the line after a bare key, belongs to that key's value. */
function continues(next: string | undefined, insideFrontmatter: boolean): boolean {
	if (next === undefined || !insideFrontmatter) return false;
	return /^[ \t]+\S/.test(next) || /^-(?:[ \t]|\r?$)/.test(next);
}

/**
 * Splits what follows a key's colon into the value and a trailing YAML
 * comment. A comment starts at a `#` that begins the text or follows a space;
 * the whitespace before it goes with the comment, so the date is not followed
 * by a gap the person never wrote.
 */
function splitComment(afterColon: string): { value: string; comment: string } {
	const hash = /(^|[ \t])#/.exec(afterColon);
	if (hash === null) return { value: afterColon.trim(), comment: "" };
	const at = hash.index + hash[1].length;
	return { value: afterColon.slice(0, at).trim(), comment: ` ${afterColon.slice(at)}` };
}
