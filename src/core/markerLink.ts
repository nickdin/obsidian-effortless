/**
 * The visible link a feature appends right before its own bookkeeping marker,
 * and how a second feature copying that line tells it apart from a link the
 * person typed themselves (#906:
 * Migration's collection copy carries a link back to the day's log it was
 * filed from, and Task consistency must leave that link off the live copy it
 * makes from the same line).
 *
 * **The convention.** Every feature that appends a visible link writes it at
 * `taskLine.ts`'s own `insertionPointOf` — the same point `setComment` adds a
 * field at — with nothing but the one separating space between the link and
 * the trailing `%% <id>:… %%` comment the feature writes in the same edit,
 * and **records the fact in its own marker**: the marker's last word is
 * {@link LINK_FLAG}. Migration's frozen line and its collection copy both do
 * this for their own appended link.
 *
 * **Why a flag rather than position**. A line filed
 * before this convention existed has no link back, so a person's own trailing
 * link sits in exactly the position a feature's would — and a collection task
 * that already carries a different feature's own marker (Task consistency's,
 * re-copying under an existing eid) puts a person's trailing link right
 * before *that* marker just as easily. Position alone cannot tell those apart
 * from the real thing, so the marker says so itself, and a marker that never
 * claims the flag is never read as carrying one, whatever sits before it.
 * The flag also survives a field the core adds later between the link and the
 * marker (a due date, a tag, a priority go in at the same insertion point and
 * land *after* the link but before the trailing comments): the link is still
 * found as the line's own last link, whatever now sits between it and the
 * marker that claims it.
 *
 * This is the one place that question is asked, so two features cannot answer
 * it two ways — the
 * rule the repository states once: "a rule the core already holds is
 * imported from `src/core`, never re-derived in a feature."
 */

import type { LineLink } from "./linkReading";
import { lastLinkOnLine } from "./linkReading";
import { insertionPointOf, parseTaskLine, readComment } from "./taskLine";

/** The hash word a feature's own marker carries: eight lowercase hex characters. */
const MARKER_HASH = /^[0-9a-f]{8}$/u;

/** A marker's own last word when it records that the line also carries a link it appended right before it. */
const LINK_FLAG = "L";

/**
 * Whether `comment`, one of `raw`'s comments, reads as a feature's own
 * bookkeeping marker: `%% <id>:<word> <hash> %%`, the hash eight lowercase
 * hex characters, with up to three further words — a one-character word, the
 * link flag, and after the flag one word of the feature's own — the
 * shape every feature's own marker shares, checked without naming which
 * feature wrote it (Migration's own undo already made this exact check of
 * another feature's comment, `echoesOf`'s `isMarkerShaped`; this is that
 * rule, moved here so both directions of the question — "is this another
 * feature's marker" and "is this link mine to drop" — read one place).
 */
export function isMarkerShapedComment(raw: string, comment: string): boolean {
	const inside = comment.slice(2, -2).trim();
	const colon = inside.indexOf(":");
	if (colon <= 0) return false;
	const id = inside.slice(0, colon);
	if (/\s/u.test(id)) return false;
	const content = readComment(raw, id);
	if (content === null) return false;
	const words = content.trim().split(/\s+/u);
	if (!MARKER_HASH.test(words[1])) return false;
	if (words.length === 2) return true;
	if (words.length === 3) return words[2].length === 1;
	// The fifth word is the feature's own, opaque here: Migration records what a filing added around the task there.
	if (words.length === 4 || words.length === 5) return words[2].length === 1 && words[3] === LINK_FLAG;
	return false;
}

/**
 * Whether `comment` is not only marker-shaped ({@link isMarkerShapedComment})
 * but its own feature's marker for recording that the line carries a link
 * that feature appended: the reserved fourth word, {@link LINK_FLAG}. Nothing
 * about *where* that link sits is asked here — {@link appendedLink} takes the
 * line's own last link once any comment answers yes, since a field the core
 * adds later may now sit between the two.
 */
export function marksAppendedLink(raw: string, comment: string): boolean {
	if (!isMarkerShapedComment(raw, comment)) return false;
	const inside = comment.slice(2, -2).trim();
	const content = readComment(raw, inside.slice(0, inside.indexOf(":")));
	return content !== null && content.trim().split(/\s+/u).length >= 4;
}

/**
 * The link on `raw` a feature appended, or `null`: no comment in the trailing
 * run — from `insertionPointOf`, which skips whitespace and comments alike,
 * to the end of the line — is a marker that claims one
 * ({@link marksAppendedLink}). A person's own link is never mistaken for the
 * feature's, whatever position it sits in, because nothing here asks about
 * position: only a marker that says so, in words the feature itself wrote,
 * ever answers yes.
 *
 * **A hand comment may sit between the link and the marker** — a person
 * editing after filing types wherever the cursor is — so every comment in the
 * trailing run is checked, not only the one right after the link.
 */
export function appendedLink(raw: string): LineLink | null {
	const task = parseTaskLine(raw);
	if (task === null || task.comments.length === 0) return null;

	const at = insertionPointOf(raw);
	const trailing = raw.slice(at);
	const marksLink = task.comments.some((each) => trailing.includes(each) && marksAppendedLink(raw, each));
	return marksLink ? lastLinkOnLine(raw) : null;
}

/** `raw` with {@link appendedLink} taken off, and the one space before it; unchanged when there is none. */
export function withoutAppendedLink(raw: string): string {
	const link = appendedLink(raw);
	if (link === null) return raw;
	const before = raw[link.start - 1];
	const start = before === " " || before === "\t" ? link.start - 1 : link.start;
	return raw.slice(0, start) + raw.slice(link.end);
}
