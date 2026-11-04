/**
 * Reading the day view's meeting cell — the calendar table's second column.
 *
 * Carried from `~/Devbox/schema-render/src/parser.ts`'s `parseCell`: a cell that is a whole wikilink, aliased either way, with an
 * optional trailing parenthesis; otherwise plain text whose own trailing
 * parenthesis is held apart from the rest, so `Möte (Skype)` names `Möte`.
 *
 * This reading stays the day view's own. Nothing else in the plugin displays
 * a link from a table cell; if building the days ahead turns out to need
 * the same reading, it moves into the core then, not before.
 *
 * `looksLikeLink` is new here, and the old plugin had no such field: a cell
 * holding `[[` that this reading does not take as a whole wikilink is marked
 * so, because a later ticket's click handling must create nothing from it
 * rather than treat the brackets as ordinary text (spec #618, named
 * difference 11).
 */

/** One meeting cell, read as a link or as plain text. */
export interface MeetingCell {
	/** The text to show: the alias if there is one, the note name otherwise, or the plain text as written. */
	readonly display: string;
	/** The note this cell links to, or would link to if clicked. Null only for an empty cell. */
	readonly linktext: string | null;
	/** True when the cell was written as a whole `[[wikilink]]`, alias and trailing parenthesis allowed. */
	readonly isWikilink: boolean;
	/** A trailing `(…)`, held apart so it is never part of the link target or the plain name. */
	readonly trailingParen: string | null;
	/** True when the cell holds `[[` but was not read as a whole wikilink — clicking it must create nothing. */
	readonly looksLikeLink: boolean;
}

/**
 * Reads one meeting cell's text.
 *
 * A wikilink match requires the whole cell, give or take a trailing
 * parenthesis: `[[X\|Y]], and more` is not a link, and neither is
 * `[[X]] (a) (b)` — two parenthesis groups is one more than the pattern
 * allows. Both fall back to the plain-text reading, and because their text
 * still holds `[[`, {@link MeetingCell.looksLikeLink} is set.
 */
export function readMeetingCell(text: string): MeetingCell {
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return { display: "", linktext: null, isWikilink: false, trailingParen: null, looksLikeLink: false };
	}

	const match = trimmed.match(/^\[\[([^\]|\\]+)(?:\\?\|([^\]]+))?\]\](?:\s*\(([^)]+)\))?\s*$/);
	if (match) {
		const target = match[1].trim();
		const alias = match[2]?.trim();
		const paren = match[3]?.trim();
		return {
			display: alias ?? target,
			linktext: target,
			isWikilink: true,
			trailingParen: paren ?? null,
			looksLikeLink: false,
		};
	}

	const { noteName, trailingParen } = plainText(trimmed);
	return {
		display: noteName,
		linktext: noteName,
		isWikilink: false,
		trailingParen,
		looksLikeLink: trimmed.includes("[["),
	};
}

/**
 * Plain text split into its name and an optional trailing `(…)`, exactly as
 * the old plugin's `deriveCreateName` reads it: `Möte (Skype)` names `Möte`
 * with `Skype` held apart; `A (b) c` has no *trailing* parenthesis, so the
 * whole string stays the name.
 */
function plainText(rawText: string): { noteName: string; trailingParen: string | null } {
	const match = rawText.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
	if (match) {
		return { noteName: match[1].trim(), trailingParen: match[2] };
	}
	return { noteName: rawText, trailingParen: null };
}
