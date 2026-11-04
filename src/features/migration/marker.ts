/**
 * Migration's hidden marker, `%% migration:<id> <hash> %%`.
 *
 * The marker is written on both lines of a filing — the copy in the collection
 * and the frozen line in the day's log — through the core's `setComment`, never
 * by building the comment as a string. `id` says which two lines belong to one
 * filing; `hash` says what the copied line looked like when it was written, so
 * that a later undo can tell whether the filed task has been touched since.
 *
 * **Both are this feature's own, not Task consistency's.** A feature never
 * references another, so the id generator and the short hash below are written again here
 * rather than imported from Task consistency's own marker module; the two
 * schemes share a shape on purpose and no code.
 */

import { lastLinkOnLine } from "../../core/linkReading";
import { withoutAppendedLink } from "../../core/markerLink";
import type { TaskLine } from "../../core/taskLine";
import { mayBeCheckbox, parseTaskLine, readComment, setComment } from "../../core/taskLine";
import { FEATURE_ID } from "./types";

/** How many random base-36 characters follow the time in a fresh id. */
const ID_RANDOM_LENGTH = 4;

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * A private id with no format promise to anyone but this feature: the time in
 * base 36, then four random base-36 characters. Made once per filing and
 * carried unchanged on both lines.
 */
export function newMigrationId(): string {
	let random = "";
	for (let at = 0; at < ID_RANDOM_LENGTH; at += 1) {
		random += BASE36[Math.floor(Math.random() * BASE36.length)];
	}
	return Date.now().toString(36) + random;
}

/** `djb2`, as eight lowercase hex characters. */
function shortHash(text: string): string {
	let hash = 5381;
	for (let at = 0; at < text.length; at += 1) hash = (hash * 33) ^ text.charCodeAt(at);
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * `raw` with `comment` (one of its own substrings, found by text rather than
 * by span) taken off along with the one whitespace character that separates
 * it from what is beside it — the space before it when there is one, else the
 * space after — the same rule `taskLine.ts`'s own `removeField` applies when
 * a field is taken off a line. A naive substring removal, with no separator
 * rule, leaves a stray double space wherever a comment did not happen to sit
 * at the very end of the line, and only a trailing run of those is ever
 * trimmed away.
 */
function withoutOneComment(raw: string, comment: string): string {
	const at = raw.indexOf(comment);
	if (at === -1) return raw;
	if (raw[at - 1] === " " || raw[at - 1] === "\t") return raw.slice(0, at - 1) + raw.slice(at + comment.length);
	const after = at + comment.length;
	if (raw[after] === " " || raw[after] === "\t") return raw.slice(0, at) + raw.slice(after + 1);
	return raw.slice(0, at) + raw.slice(after);
}

/**
 * The hash of one task line's fields and words with any link a feature
 * appended, and every `%% … %%` comment, masked out the way `setComment`'s
 * own removal would leave the line: each one taken off along with its one
 * separating space, never a bare substring cut that can leave a stray double
 * space depending on where it happened to sit. Taking the text rather than
 * the parsed fields is what puts the words in it as well as the checkbox,
 * dates, priority and tags, with no second reading of the line.
 *
 * **The appended link comes off first, the same way the marker itself does**: at filing time
 * there is no link yet to mask, since the marker that would claim one has not
 * been written, so the hash is of the bare filed words: `linesToWrite` hashes
 * `sourceLine`, before the link back is appended. At an undo's re-check the
 * collection line already carries both, and `withoutAppendedLink` finds the
 * link by the marker's own flag rather than by its text, so the hash comes
 * out the same whatever that link now reads — Obsidian rewriting it because
 * the day's log was renamed is not the person touching the task.
 *
 * Written once, at filing, on the line as it was copied. It is never
 * recomputed to watch for change; an undo computes it again on the collection
 * line it finds and compares.
 */
export function hashOfLine(line: TaskLine): string {
	let masked = withoutAppendedLink(line.raw);
	for (const comment of line.comments) masked = withoutOneComment(masked, comment);
	return shortHash(masked.replace(/\s+$/, ""));
}

/**
 * The character that stands for the space of `[ ]` in the marker's third word,
 * since the comment is split on whitespace. The plugin files only `[ ]`, `[/]`,
 * `[x]` and `[-]`, so no checkbox of its own reads as this character.
 */
const OPEN_WORD = "_";

/** The marker's own last word, `src/core/markerLink.ts`'s reserved flag, when the line also carries a link this feature appended right before the marker. */
const LINK_FLAG = "L";

/**
 * What filing wrote around a task that was not the task's own line: the lines it added
 * directly above the task's block and directly below it, in file order, so an
 * undo can take out exactly those and give the collection back byte for byte. One
 * letter per line: `b` a blank line, `h` a heading the filing wrote (the
 * completed-tasks heading, when the collection had none). The text alone cannot say
 * what filing added: `## Tasks\n## Notes` and `## Tasks\n\n## Notes` file to the
 * same text, so the filing writes it down.
 */
export interface Added {
	readonly above: string;
	readonly below: string;
	/**
	 * Where the filing put the block:
	 * {@link headingKey} of the heading line the block sits under, so an undo can tell
	 * a line still where the filing put it from one the person moved, whose
	 * neighbouring blank lines are then theirs. Optional and additive: a record
	 * without it is applied as it always was.
	 */
	readonly under?: string;
}

/**
 * What one side of {@link Added} may hold: `b` and `h` above the block, `b` below it,
 * and after them, when the record says where the block was put, `@` and the
 * {@link headingKey} of its heading (`bhb/-@1b792ebd`). Still one whitespace-free word.
 */
const ADDED_WORD = /^(-|[bh]+)\/(-|b+)(?:@([0-9a-f]{8}))?$/;

/** Whether nothing was added on either side. */
export function addedNothing(added: Added | undefined): boolean {
	return added === undefined || (added.above === "" && added.below === "");
}

/** {@link Added} as the marker's fifth word: `above/below`, `-` for a side with nothing on it, then `@<key>` when the record says where the block was put. */
function addedWord(added: Added): string {
	const sides = `${added.above === "" ? "-" : added.above}/${added.below === "" ? "-" : added.below}`;
	return added.under === undefined ? sides : `${sides}@${added.under}`;
}

/**
 * What a heading line reads as in {@link Added}'s `under`: the line without its
 * line ending or surrounding blanks, hashed. A hash and not the text, because the
 * marker is one whitespace-split word; a rename, or a change of level, changes it,
 * which is the point: a block under a heading the filing did not choose is not
 * where the filing put it.
 */
export function headingKey(headingLine: string): string {
	return shortHash(headingLine.replace(/\r$/, "").trim());
}

/**
 * `raw` with this feature's marker added, or replaced if it already carries one.
 * `checkbox` is the checkbox the task was filed with (`" "`, `"/"`, `"x"`, `"-"`),
 * written as the marker's third word so an undo can give it back after Task
 * consistency has marked the collection's copy `[/]`. `carriesLink` is
 * whether `raw` also carries, right before where this marker lands, a link
 * this feature itself appended — the frozen line's own link to the
 * collection, or the collection copy's own link back to the day's log — recorded as the
 * marker's own fourth word so a reader can tell that link apart from one the
 * person typed by what the marker says, not by where the link sits; every filing
 * from #906 on writes `true` on both lines, and a filing from an earlier
 * build has no such word at all.
 *
 * **`added` is the fifth word, and only the collection's copy carries it**: what the filing wrote
 * around the task, so undo removes exactly that. It follows the link flag, so a
 * marker that records lines added also records the link; and it is left out
 * when nothing was added, which keeps every marker filed into a section that
 * already held a task byte for byte what it was.
 */
export function writeMarker(raw: string, id: string, hash: string, checkbox: string, carriesLink: boolean, added?: Added): string {
	const box = checkbox === " " ? OPEN_WORD : checkbox;
	const record = addedNothing(added) ? null : addedWord(added as Added);
	if (record !== null && !carriesLink) throw new Error("the lines added around a task are recorded only after the link flag, which this comment must also carry");
	const head = `${id} ${hash} ${box}`;
	const withLink = carriesLink ? `${head} ${LINK_FLAG}` : head;
	return setComment(raw, FEATURE_ID, record === null ? withLink : `${withLink} ${record}`);
}

/**
 * `line`, a task line carrying a marker this feature just wrote, with what filing
 * added around it recorded in that marker. A line that carries no such marker, or
 * one that cannot carry the record (it is missing the link flag), is returned as
 * it is: the callers that hand `placeInCollection` a bare line have nothing to
 * undo later.
 */
export function withAdded(line: string, added: Added): string {
	const marker = readMarker(line);
	if (marker === null || marker.checkbox === undefined || !marker.carriesLink || addedNothing(added)) return line;
	return writeMarker(line, marker.id, marker.hash, marker.checkbox, true, added);
}

/**
 * What `%% migration:<id> <hash> <box> [L [above/below[@key]]] %%` holds. `checkbox` is absent from
 * a marker an earlier build wrote as `%% migration:<id> <hash> %%`, whose
 * filing checkbox is unknown and is never guessed; `carriesLink` is false
 * unless the marker's own fourth word says otherwise, so an earlier build's
 * marker, and one written before #906, both read as carrying no link.
 */
export interface FiledMarker {
	readonly id: string;
	readonly hash: string;
	readonly checkbox?: string;
	readonly carriesLink: boolean;
	/** What filing added around the task, when the marker records it ({@link Added}); absent from every marker written before #986, and from one that filed into a section already holding a task. */
	readonly added?: Added;
}

/**
 * What is inside a migration comment, read as an id, a hash and optionally the
 * filing checkbox, the link flag and what filing added: two to five
 * whitespace-separated words, however the person spaced them, the third exactly
 * one character, the fourth, when there is one, exactly `src/core/markerLink.ts`'s
 * reserved flag, and the fifth, when there is one, what {@link Added} writes.
 * A comment holding anything else is not a marker this feature wrote, and
 * gives null. A marker of two to four words reads exactly as it did before the
 * fifth word existed.
 */
export function readMarkerInside(inside: string): FiledMarker | null {
	const words = inside.trim().split(/\s+/);
	if (words.length < 2 || words.length > 5 || words[0] === "" || words[1] === "") return null;
	if (words.length === 2) return { id: words[0], hash: words[1], carriesLink: false };
	if (!mayBeCheckbox(words[2])) return null;
	const checkbox = words[2] === OPEN_WORD ? " " : words[2];
	if (words.length === 3) return { id: words[0], hash: words[1], checkbox, carriesLink: false };
	if (words[3] !== LINK_FLAG) return null;
	if (words.length === 4) return { id: words[0], hash: words[1], checkbox, carriesLink: true };
	const sides = ADDED_WORD.exec(words[4]);
	if (sides === null) return null;
	const added: Added = { above: sides[1] === "-" ? "" : sides[1], below: sides[2] === "-" ? "" : sides[2] };
	return { id: words[0], hash: words[1], checkbox, carriesLink: true, added: sides[3] === undefined ? added : { ...added, under: sides[3] } };
}

/**
 * The marker on a raw task line, or null when the line carries none of this
 * feature's own or it is malformed; a line carrying another feature's comment
 * has none. **The one reader of this marker**: the jump, the undo, the entries
 * and the filing all ask it, so two of them cannot read one hand-edited line two
 * ways. It goes through the core's `readComment`, the one place a comment is
 * found, so there is no second pattern.
 */
export function readMarker(raw: string): FiledMarker | null {
	const inside = readComment(raw, FEATURE_ID);
	return inside === null ? null : readMarkerInside(inside);
}

/** A test for `findMarkedLine` (`src/core/markedLine.ts`): the comment holds a marker with this `id`. */
export function hasMarkerId(id: string): (inside: string) => boolean {
	return (inside) => readMarkerInside(inside)?.id === id;
}

/**
 * The linktext of the note the frozen line points at: the last link on it,
 * outside its `%% … %%` comments, either the wikilink `[[…]]` or the markdown
 * link `[…](…)` the person's link format may have made. The last, because
 * the words the person wrote may hold a link of their own and the one filing adds
 * comes after them. The text is what `getLinkpath` and `getFirstLinkpathDest`
 * take: a wikilink's up to `]`, `|` or `#`, a markdown link's destination with
 * its `%20`s read back and its `<…>` taken off. **The one reader of that link**,
 * for the same reason as {@link readMarker}. Null when the line names none.
 */
export function collectionLinktextOf(raw: string): string | null {
	if (parseTaskLine(raw) === null) return null;
	return lastLinkOnLine(raw)?.path ?? null;
}
