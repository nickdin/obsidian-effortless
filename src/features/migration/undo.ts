/**
 * Undoing a filing while the filed task is untouched
 * (#862, spec
 * #716 decision 10, user
 * stories 24 and 25).
 *
 * **Two routes, one function.** The "Undo migration" button in the notice a
 * filing shows and the right-click entry on the frozen line both end in
 * {@link undoFilings}. What each route hands it differs only in what it already
 * has: the menu route the `Editor` it was opened in, the notice route the
 * collection it just wrote to.
 *
 * **Untouched** ({@link canUndo}) means the collection's line, found by the
 * marker's `id` in the collection's text as it is now, hashes the same as the
 * `hash` written when it was filed. That hash is read from the frozen line in
 * the day's log, which nothing rewrites but the collection's name.
 *
 * **The log line is put back from the collection's line, not undone field by
 * field.** The collection's line is the log line's own text plus the marker
 * (`linesToWrite`), so taking the marker off it and giving it back the
 * indentation the frozen line kept gives every byte the person wrote, checkbox
 * included, which `[>]` overwrote and nothing else remembers. A subtree that
 * travelled with the line comes back the same way.
 *
 * **Order: the source note first, then the collection.** A failure between the two
 * puts the log line back as it stood, so both notes are as they were; where the
 * log cannot be put back either, the task is twice, once in each note, and the
 * `Notice` says so, where the other order would leave it in neither. The log half
 * goes through an `Editor` on the source note when one is at hand, as the filing's
 * own log half does (`Migration.file`, #867), and through `host.notes.edit` only
 * where no editor on that note exists. The collection half does the same
 * ({@link removeFromCollectionNote}, #978).
 *
 * **A feature's live copy goes with it**.
 * When another feature has copied the task into the day's log, it carries that
 * feature's comment and this feature's marker too. The undo takes each such line
 * out of the log in the same write, so the log equals its text before filing; see
 * {@link echoesOf} for how a feature's comments, taken off the restored line whether
 * or not a live copy exists, and a person's, which stay, are told apart.
 *
 * **Where the live copy is**:
 * in today's log, the one note the other feature copies into, whatever note the task
 * was filed from. The undo reads today's log by the core's rule for where a day's log
 * lives ({@link todaysLogOf}), when it is asked, and takes the live copy out in a write
 * of its own ({@link takeOutLiveCopies}). From an ordinary note that is the only place
 * looked in: the note the task came from is touched on the frozen line and nowhere else.
 *
 * A refusal is a plain `Notice` naming the collection; nothing is written and
 * nothing goes to `host.problems`.
 *
 * **"The log" is the note the frozen line is in**:
 * a day's log, or any other note a task was filed from. The code below
 * keeps the word "log"; the sentences a person reads say "the day's log" or "the
 * note" by the `source` {@link undoFilings} is given.
 *
 * Pure over text below {@link undoFilings}: no vault, no app, no clock.
 */

import { Notice, getLinkpath } from "obsidian";
import type { App, Editor, MarkdownView, TFile } from "obsidian";
import type { Collections } from "../../core/collections";
import { noteName } from "../../core/collections";
import { findMarkedLine } from "../../core/markedLine";
import { isAtxHeading } from "../../core/markdownSections";
import { isMarkerShapedComment, withoutAppendedLink } from "../../core/markerLink";
import type { NoteWriter } from "../../core/noteWriter";
import { reasonOf } from "../../core/reason";
import type { VaultLayout } from "../../core/settings";
import { dailyLogPath, dailyLogPrefix } from "../../core/vaultLayout";
import { editTaskField, parseTaskLine, setComment } from "../../core/taskLine";
import { collectionLinktextOf, hasMarkerId, hashOfLine, headingKey, readMarker } from "./marker";
import type { Added } from "./marker";
import { DAY_LOG } from "./filable";
import type { SourceNote } from "./filable";
import { frozenPlace } from "./frozenLine";
import { subtreeOf } from "./selection";
import { FEATURE_ID } from "./types";

// The undo's callers and tests reach the reader through here.
export { readMarker };

/**
 * Whether a collection's line is still the one that was filed: it is a task
 * line, and read the way `hashOfLine` reads it (comments masked out) it hashes
 * to `storedHash`. A reworded line and a ticked one both fail, because the
 * hash covers the checkbox and the words.
 *
 * **One difference is ignored**: a `[/]` on a copy
 * filed open (`filedAs` is `" "`, from the marker), because Task consistency
 * writes that mark itself when it copies an open task into today's log and the
 * person did nothing. The copy is then judged as if it still had `filedAs`. A
 * task filed done, cancelled, forwarded or in progress is never marked that way,
 * so a `[/]` on one is the person's; with no `filedAs`, a marker from an earlier
 * build, nothing is ignored.
 */
export function canUndo(collectionLine: string, storedHash: string, filedAs?: string): boolean {
	const task = parseTaskLine(collectionLine);
	if (task === null) return false;
	if (hashOfLine(task) === storedHash) return true;
	if (filedAs !== " " || task.checkbox !== "/") return false;
	const asFiled = parseTaskLine(editTaskField(collectionLine, "checkbox", filedAs));
	return asFiled !== null && hashOfLine(asFiled) === storedHash;
}

/** The frozen line in the source note that carries `id`. */
export interface FrozenReading {
	/** Its index in the log, counted from zero. */
	readonly at: number;
	/** The hash written when the task was filed. */
	readonly hash: string;
	/** The indentation the line keeps; the collection's copy had it taken off. */
	readonly indent: string;
	/** The collection the line names, as {@link collectionLinktextOf} reads it: the last link outside the line's comments, a wikilink or a markdown link, by name, path or relative to the log. */
	readonly collectionName: string | null;
	/** Whether the log's lines end in a carriage return. */
	readonly cr: string;
}

/** Whichever line of `text` carries a migration marker with `id`, first match. */
function lineWith(text: string, id: string): number | null {
	return findMarkedLine(text, FEATURE_ID, hasMarkerId(id));
}

/**
 * The frozen line for `id` in the source note's text, or `null` when there is none.
 * With `accepts`, only a line it accepts can be the one: a copy quoted in a
 * fenced block or the frontmatter carries the same id and is not the frozen line.
 * Without it the first line carrying the id anywhere is, which only a caller with
 * no note in hand asks for.
 */
export function readFrozen(logText: string, id: string, accepts?: (lineIndex: number) => boolean): FrozenReading | null {
	// Lines the caller refuses are blanked, not removed, so an index still counts from the top of `logText`.
	const searched = accepts === undefined ? logText : logText.split("\n").map((each, at) => (accepts(at) ? each : "")).join("\n");
	const at = lineWith(searched, id);
	if (at === null) return null;
	const raw = logText.split("\n")[at];
	const line = raw.replace(/\r$/, "");
	const marker = readMarker(line);
	const task = parseTaskLine(line);
	if (marker === null || task === null) return null;

	return {
		at,
		hash: marker.hash,
		indent: task.indent,
		collectionName: collectionLinktextOf(line),
		cr: raw.endsWith("\r") ? "\r" : "",
	};
}

/** The collection's line for one filing, found in the collection's current text. */
export type FiledReading =
	| { ok: true; at: number; line: string; subtree: readonly string[]; prefix: string; filedAs?: string; added?: Added }
	| { ok: false; why: "gone" | "touched" };

/**
 * The line of `collectionText` carrying `id`, its subtree, and whether it is
 * still untouched. `indent` is what the frozen line kept. The command's copy
 * has it taken off (`collectionBlock`), so it is given back before hashing; a
 * copy that kept it (`fileInto`'s own, whose text is the whole line) hashes as
 * it stands. `prefix` is what must go in front of the line, and of its subtree,
 * to be what the log held: the indentation given back, or nothing.
 */
export function readFiled(collectionText: string, id: string, hash: string, indent: string): FiledReading {
	const at = lineWith(collectionText, id);
	if (at === null) return { ok: false, why: "gone" };
	const lines = collectionText.split("\n");
	const line = lines[at].replace(/\r$/, "");
	// The checkbox the task was filed with is read from the copy's own marker. The frozen line's marker carries the same word; this does not cross-check them.
	const marker = readMarker(line);
	const filedAs = marker?.checkbox;
	const prefix = canUndo(line, hash, filedAs) ? "" : canUndo(indent + line, hash, filedAs) ? indent : null;
	if (prefix === null) return { ok: false, why: "touched" };
	return { ok: true, at, line, subtree: subtreeOf(lines, at), prefix, filedAs, added: marker?.added };
}

/**
 * What another feature wrote next to Migration's marker on the copy, and where its
 * echo is in the day's log.
 *
 * **How a feature's comment is told from a person's.** Two tests, either is enough,
 * and neither names a feature:
 *
 * 1. **By shape** ({@link isMarkerShapedComment}, `src/core/markerLink.ts`):
 *    the comment reads `%% <id>:<word> <hash> %%` with the hash eight
 *    lowercase hex characters, the shape the features' markers share
 *    (`<id>:<eid> <hash>`). It is found whether or not the feature also wrote
 *    a live copy, which it does not while the day's log is open in a tab.
 * 2. **By echo**: another line of the log carries the same comment word for word,
 *    which is a feature's comment copied onto its live copy.
 *
 * A comment that passes neither was added by the person after filing and stays:
 * `%% note: ring after 5 %%`, `%% 12:30 call %%` and `%% https://example.com/x %%`
 * are not marker-shaped, and no other line carries them. The comments come from
 * the core's `parseTaskLine`, and the id is confirmed by its `readComment`.
 */
export interface Echoes {
	/** The comments of the copy that are a feature's, to be taken off the restored line. */
	readonly comments: readonly string[];
	/** The log's lines carrying them, other than the frozen line: the live copies, to be removed. */
	readonly at: readonly number[];
}

/**
 * The feature comments of `copyLine`, the collection's line for one filing, and
 * the lines of `logText` that echo it. The frozen line at `frozenAt` is never one.
 * With `scan` false only the comments to take off the restored line are answered and
 * no line is looked for: what an ordinary source note is asked.
 * Migration's own marker is set aside first: the frozen line and a live copy both
 * carry it and it is Migration's.
 */
export function echoesOf(logText: string, frozenAt: number, copyLine: string, scan = true): Echoes {
	const unmarked = setComment(copyLine, FEATURE_ID, null);
	const wanted = parseTaskLine(unmarked)?.comments ?? [];
	const comments = new Set<string>(wanted.filter((each) => isMarkerShapedComment(unmarked, each)));
	const at: number[] = [];
	// A note that is not a day's log is not scanned: no feature copies a task into it, and a line there
	// carrying a comment the person also typed on the copy is the person's own.
	if (!scan || wanted.length === 0) return { comments: [...comments], at };
	logText.split("\n").forEach((raw, index) => {
		if (index === frozenAt) return;
		const shared = (parseTaskLine(raw.replace(/\r$/, ""))?.comments ?? []).filter((each) => wanted.includes(each));
		if (shared.length === 0) return;
		at.push(index);
		for (const each of shared) comments.add(each);
	});
	return { comments: [...comments], at };
}

/** `raw` without `comment`, and the one space before it that the feature put there. */
function withoutComment(raw: string, comment: string): string {
	const spaced = raw.replace(` ${comment}`, "");
	return spaced !== raw ? spaced : raw.replace(comment, "");
}

/**
 * The lines that go back into the day's log: the task as it was written, then what
 * travelled with it. **The link back comes off first**:
 * it is this feature's own appended text, never the person's, told apart by
 * `src/core/markerLink.ts`'s own rule, and it is stripped while Migration's
 * marker (or an echoed feature's) still sits right after it — the shape that
 * rule is built to recognise. Migration's own marker comes off the copy next,
 * and so does each of `echoed`, the comments a feature put beside it after
 * filing ({@link echoesOf}); the line as it was filed carried none, since
 * `checkFilable` refuses a task with a comment on it. Any other comment on the
 * copy is the person's and stays.
 */
export function restoredLines(
	filed: { line: string; subtree: readonly string[]; prefix: string; filedAs?: string },
	echoed: readonly string[] = [],
): string[] {
	let unmarked = setComment(withoutAppendedLink(filed.line), FEATURE_ID, null);
	for (const comment of echoed) unmarked = withoutComment(unmarked, comment);
	// A copy Task consistency marked `[/]` goes back to the checkbox it was filed with.
	const original = filed.filedAs !== undefined && parseTaskLine(unmarked)?.checkbox === "/" ? editTaskField(unmarked, "checkbox", filed.filedAs) : unmarked;
	return [filed.prefix + original, ...filed.subtree.map((each) => filed.prefix + each)];
}

/** `logText` with the frozen line replaced by `restored`, and the lines at `echoAt`, a feature's live copies, removed. */
export function restoreInLog(logText: string, frozen: FrozenReading, restored: readonly string[], echoAt: readonly number[] = []): string {
	const lines: string[] = [];
	logText.split("\n").forEach((line, index) => {
		if (index === frozen.at) lines.push(...restored.map((each) => each + frozen.cr));
		else if (!echoAt.includes(index)) lines.push(line);
	});
	return lines.join("\n");
}

/**
 * The lines of today's log, `text`, that are another feature's live copy of the task
 * whose collection line is `copyLine`.
 * A line is one when it carries, word for word, a comment of the copy that is
 * marker-shaped ({@link echoesOf}); a comment the person typed is never enough here,
 * so an unrelated task in today's log carrying the same words stays. A line in a
 * fenced block is quoted text and never one, by the rule the frozen line is held to.
 */
export function liveCopiesIn(text: string, copyLine: string, layout: VaultLayout): number[] {
	const unmarked = setComment(copyLine, FEATURE_ID, null);
	const wanted = (parseTaskLine(unmarked)?.comments ?? []).filter((each) => isMarkerShapedComment(unmarked, each));
	if (wanted.length === 0) return [];
	const outsideFences = frozenPlace(text, DAY_LOG, layout);
	const at: number[] = [];
	text.split("\n").forEach((raw, index) => {
		if (!outsideFences(index)) return;
		const comments = parseTaskLine(raw.replace(/\r$/, ""))?.comments ?? [];
		if (comments.some((each) => wanted.includes(each))) at.push(index);
	});
	return at;
}

/** Whether `line`, in a collection's text, is blank, its line ending aside. */
function isBlank(line: string | undefined): boolean {
	return line !== undefined && line.replace(/\r$/, "") === "";
}

/** Whether `line`, in a collection's text, is a heading by the core's rule, its line ending aside. */
function isHeadingLine(line: string | undefined): boolean {
	return line !== undefined && isAtxHeading(line.replace(/\r$/, ""));
}

/**
 * Whether the section the window `[from, to)` of `lines` sits in holds nothing but
 * the window and blank lines: the one thing a filing's record is only true of. A second filing lands
 * directly under the first, and a person may have moved the line into text of their
 * own; in either case a blank line or heading taken out with the block would leave
 * the other task under the wrong heading, or take a blank line that is the person's.
 *
 * The section's top is the heading the record wrote when it wrote one (`above` holds
 * an `h`), else the nearest heading above the window with only blank lines between;
 * its bottom is the next heading or the end of the note, with only blank lines
 * between. Headings are found by the core's rule, {@link isAtxHeading}.
 */
function windowIsAlone(lines: readonly string[], from: number, to: number, above: string): boolean {
	let down = to;
	while (isBlank(lines[down])) down += 1;
	if (down < lines.length && !isHeadingLine(lines[down])) return false;
	if (above.includes("h")) return true;
	let up = from - 1;
	while (up >= 0 && isBlank(lines[up])) up -= 1;
	return isHeadingLine(lines[up]);
}

/**
 * The lines `[from, to)` of a collection's `lines` that undoing `filed` takes out:
 * the task's line and its subtree, and with them the lines the filing added around
 * them, when the marker recorded any ({@link Added},
 * #986).
 *
 * **The record is checked against the text before it is applied, and either all of
 * it holds or none of it is used.** Each recorded line must still be what filing
 * wrote, directly against the block: a blank line, or a heading. And the section
 * must still hold nothing but the block and those lines ({@link windowIsAlone}): a
 * task filed under it since, by a second filing or by the person, or a line moved
 * into text of the person's own, makes the record stale. **So does a block that is
 * no longer under the heading the filing put it under** ({@link isWhereFiled}), when
 * the record names one: a line the person moved into a section holding nothing else,
 * between blank lines of their own, is otherwise indistinguishable from the filing's.
 * Then the task's block alone comes out, as it did before the record existed. A marker
 * with no record (an earlier build's, or a filing into a section that already held a
 * task) takes the same road, and so does a record that names no heading (one written
 * before #1005) but is otherwise intact: it is applied as it always was, and nothing
 * is guessed.
 */
export function removalRange(lines: readonly string[], filed: { at: number; subtree: readonly string[]; added?: Added }): { from: number; to: number } {
	const end = filed.at + 1 + filed.subtree.length;
	const own = { from: filed.at, to: end };
	const added = filed.added;
	if (added === undefined) return own;
	const from = filed.at - added.above.length;
	const to = end + added.below.length;
	if (from < 0 || to > lines.length) return own;
	const above = [...added.above].every((kind, index) => (kind === "b" ? isBlank(lines[from + index]) : isHeadingLine(lines[from + index])));
	const below = [...added.below].every((_, index) => isBlank(lines[end + index]));
	if (!above || !below || !windowIsAlone(lines, from, to, added.above)) return own;
	if (added.under !== undefined && !isWhereFiled(lines, from, added)) return own;
	return { from, to };
}

/**
 * Whether the block whose recorded window starts at `from` still sits under the
 * heading the filing put it under ({@link Added}'s `under`,
 * #1005): the heading the
 * record wrote when it wrote one, else the nearest heading above the window with
 * only blank lines between. A line the person moved, into a section that holds
 * nothing else, looks exactly like a line the filing put there; the heading is what
 * tells them apart.
 */
function isWhereFiled(lines: readonly string[], from: number, added: Added): boolean {
	const written = added.above.lastIndexOf("h");
	let at = from + written;
	if (written < 0) {
		at = from - 1;
		while (at >= 0 && isBlank(lines[at])) at -= 1;
	}
	return isHeadingLine(lines[at]) && headingKey(lines[at]) === added.under;
}

/** `collectionText` without the line at `filed.at`, the subtree under it, and the lines its filing added around them. */
export function removeFromCollection(collectionText: string, filed: { at: number; subtree: readonly string[]; added?: Added }): string {
	const lines = collectionText.split("\n");
	const { from, to } = removalRange(lines, filed);
	const dangling = leavesDanglingReturn(lines, from, to);
	lines.splice(from, to - from);
	if (dangling) lines[lines.length - 1] = lines[lines.length - 1].slice(0, -1);
	return lines.join("\n");
}

/**
 * Whether taking the lines `[from, to)` out of `lines` leaves the text ending in the `\r`
 * of a line break that went with them.
 * A Windows-endings note whose last line had no break gained one when the filing wrote below
 * it, and the line it gained it on is not among the lines removed. When the removed window
 * reaches the text's end, the new last line takes the ending of the one removed: a `\r` on
 * it, where the removed one had none, is that break's. A note that kept a final break keeps
 * its last element out of the window, so nothing is taken from it.
 */
function leavesDanglingReturn(lines: readonly string[], from: number, to: number): boolean {
	return to > from && to >= lines.length && from > 0 && lines[from - 1].endsWith("\r") && !lines[to - 1].endsWith("\r");
}

/** `text` with its first letter upper-case: a sentence's opening word. */
function capitalised(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What undoing one filing answers, as a sentence for a `Notice`. */
interface One {
	readonly undone: boolean;
	readonly said: string;
}

/**
 * Which line of the note undo may write, so it agrees with {@link frozenLineAt}: never a line the place
 * rule refuses. `lineIndex` is the line the right-click landed on, the only line
 * then written; the notice's button has none and takes the accepted line carrying
 * the id.
 */
export interface UndoPlace {
	readonly layout: VaultLayout;
	readonly lineIndex?: number;
}

/** The lines of `text` undo may write as the frozen line, or `undefined` where the caller named no place. */
function acceptedIn(text: string, source: SourceNote, place: UndoPlace | undefined): ((lineIndex: number) => boolean) | undefined {
	if (place === undefined) return undefined;
	const placed = frozenPlace(text, source, place.layout);
	return place.lineIndex === undefined ? placed : (lineIndex) => lineIndex === place.lineIndex && placed(lineIndex);
}

/** What {@link undoFilings} reaches into the world through. */
export interface UndoWorld {
	readonly app: App;
	readonly notes: Pick<NoteWriter, "read" | "edit">;
	readonly collections: Pick<Collections, "all">;
}

/** The editor of a tab showing the note at `path`, or `null` when no tab does. */
export function editorOn(app: App, path: string): Editor | null {
	for (const leaf of app.workspace.getLeavesOfType("markdown")) {
		const view = leaf.view as MarkdownView;
		if (view.file?.path === path) return view.editor;
	}
	return null;
}

/**
 * The collections that could hold the filing, in the order they are tried: the
 * one the caller already knows, then the note Obsidian resolves the frozen line's
 * link to from the day's log (as the jump does, so a link Obsidian rewrote to a
 * path still finds its collection), then every collection named as the link
 * spells it. The last is for a link that resolves to none, or to another note of
 * the same name: two collections of one name are both tried.
 */
function candidates(world: UndoWorld, log: TFile, linktext: string | null, hintPath: string | null): string[] {
	const paths: string[] = [];
	const add = (path: string): void => {
		if (!paths.includes(path)) paths.push(path);
	};
	if (hintPath !== null) add(hintPath);
	if (linktext !== null) {
		const resolved = world.app.metadataCache.getFirstLinkpathDest(getLinkpath(linktext), log.path);
		if (resolved !== null) add(resolved.path);
		// By the note's name alone: the link may spell a folder or an extension the note no longer has.
		const named = noteName(linktext).toLowerCase();
		for (const each of world.collections.all()) {
			if (each.name.toLowerCase() === named) add(each.path);
		}
	}
	return paths;
}

async function undoOne(world: UndoWorld, log: TFile, id: string, hintPath: string | null, editor: Editor | null, where: string, search: FrozenSearch): Promise<One> {
	const logText = editor !== null ? editor.getValue() : await world.notes.read(log);
	const frozen = readFrozen(logText, id, acceptedIn(logText, search.source, search.place));
	if (frozen === null) {
		return { undone: false, said: `The task's line in ${where} is not there any more, so nothing was undone.` };
	}
	// By its note name, as the filing notice says it, whatever the link spells.
	const called = frozen.collectionName === null ? "its collection" : noteName(frozen.collectionName);

	let hit: { file: TFile; found: Extract<FiledReading, { ok: true }> } | null = null;
	let touched = false;
	for (const path of candidates(world, log, frozen.collectionName, hintPath)) {
		const file = world.app.vault.getFileByPath(path);
		if (file === null) continue;
		const reading = readFiled(await world.notes.read(file), id, frozen.hash, frozen.indent);
		if (reading.ok) {
			hit = { file, found: reading };
			break;
		}
		if (reading.why === "touched") {
			touched = true;
			break;
		}
	}
	if (hit === null) {
		return {
			undone: false,
			said: touched
				? `The task in ${called} has been changed or ticked since it was put there, so nothing was undone.`
				: `The task is not in ${called} any more, so nothing was undone.`,
		};
	}
	const { file: target, found } = hit;

	// Task consistency's live copy is in today's log, which is not the note the task came from unless that is today's log.
	// Resolved before anything is written: a layout the core cannot write a path for throws here, and nothing has changed yet.
	const todays = todaysLogOf(world, log, search);

	const wrote = await restoreLog(world, log, editor, id, found, where, search);

	let liveCopies: LogWrite | null = null;
	if (todays !== null) {
		try {
			liveCopies = await takeOutLiveCopies(world, todays.file, editorOn(world.app, todays.file.path), found.line, todays.layout);
		} catch (error) {
			const said = `Today's log could not be written (${reasonOf(error)}), so nothing was undone.`;
			if (await putLogBack(world, log, editor, wrote)) return { undone: false, said: `${said} ${capitalised(where)} and ${called} are as they were.` };
			// Nothing else was written: the task is in the source note again, still in the collection, and its live copy is still in today's log.
				return { undone: false, said: `The task is back in ${where}, but it is also still in ${called} and as a live copy in today's log. ${said} Delete the copies you do not want by hand, so it is not there three times.` };
		}
	}

	// Read again inside the write: the collection may have changed since it was checked.
	let removed = false;
	let failure: string | null = null;
	try {
		removed = await removeFromCollectionNote(world, target, id, frozen);
	} catch (error) {
		failure = reasonOf(error);
	}
	if (removed) return { undone: true, said: called };

	// The collection's half was refused or failed after the log's was written: the
	// log goes back as it stood, so the person is left with both files as they were.
	const why = failure === null ? `The task in ${called} was changed just now` : `${called} could not be written (${failure})`;
	const backInSource = await putLogBack(world, log, editor, wrote);
	const backInToday = liveCopies === null || todays === null || (await putLogBack(world, todays.file, editorOn(world.app, todays.file.path), liveCopies));
	if (backInSource && backInToday) {
		return { undone: false, said: `${why}, so nothing was undone. ${capitalised(where)} and ${called} are as they were.` };
	}
	// Which put-back failed says what the person will find.
	if (!backInSource && backInToday) {
		return {
			undone: false,
			said: `The task is back in ${where}, but its copy in ${called} was left there. ${why}. Delete it by hand if you do not want it twice.`,
		};
	}
	if (backInSource) {
		// The source note reads as before the undo: its line is frozen again, so the task is not back in it. Only the live copy taken out of today's log is missing.
		return {
			undone: false,
			said: `The task is still in ${called}, and its line in ${where} is frozen again. Its live copy in today's log was taken out and could not be put back. ${why}. Add the live copy to today's log by hand if you want it there.`,
		};
	}
	return {
		undone: false,
		said: `The task is back in ${where}, and its copy in ${called} was left there. Its live copy in today's log was taken out and could not be put back. ${why}. Delete one of the two by hand if you do not want it twice, and add the live copy back to today's log if you want it there.`,
	};
}

/**
 * The collection half: the copy and its subtree taken out, read again at the moment
 * of the write. True when they were removed, false when the copy is no longer an
 * untouched one.
 *
 * **Through the collection's own editor when a tab shows it**, as the log half is. The note writer holds
 * a write to the note on screen until the person leaves it (ADR 0002), which is
 * right for a background write and wrong here: the person just pressed the undo,
 * and a held write left the log restored, the undo unanswered and the task in both
 * notes. Where no tab shows the collection the write goes through the note writer.
 */
async function removeFromCollectionNote(world: UndoWorld, target: TFile, id: string, frozen: FrozenReading): Promise<boolean> {
	const editor = editorOn(world.app, target.path);
	if (editor === null) {
		let removed = false;
		await world.notes.edit(target, (text) => {
			const now = readFiled(text, id, frozen.hash, frozen.indent);
			removed = now.ok;
			return now.ok ? removeFromCollection(text, now) : text;
		});
		return removed;
	}
	const text = editor.getValue();
	const now = readFiled(text, id, frozen.hash, frozen.indent);
	if (!now.ok) return false;
	const lines = text.split("\n");
	const { from, to } = removalRange(lines, now);
	if (to < lines.length) {
		editor.replaceRange("", { line: from, ch: 0 }, { line: to, ch: 0 });
	} else {
		// The block runs to the end of the note: take the line break before it instead.
		// A `\r` that only that line break gave the line above goes with it ({@link leavesDanglingReturn}).
		const above = from === 0 ? 0 : lines[from - 1].length - (leavesDanglingReturn(lines, from, to) ? 1 : 0);
		const start = from === 0 ? { line: 0, ch: 0 } : { line: from - 1, ch: above };
		editor.replaceRange("", start, { line: lines.length - 1, ch: lines[lines.length - 1].length });
	}
	return true;
}

/**
 * Today's log, when the live copy of a filing can be in a note other than the one
 * the frozen line is in:
 * the file at the path the core's rule gives for today, read at the call and never
 * kept. `null` when the caller named no layout, when the vault names no day's log
 * folder, when today's log does not exist, and when it is the note the frozen line
 * is in, where the one write of {@link restoreLog} already takes the live copy out.
 * A layout the core cannot write a path for throws, before anything is written.
 */
function todaysLogOf(world: UndoWorld, log: TFile, search: FrozenSearch): { file: TFile; layout: VaultLayout } | null {
	const layout = search.place?.layout;
	if (layout === undefined || dailyLogPrefix(layout) === null) return null;
	const path = dailyLogPath(new Date(), layout);
	if (path === log.path) return null;
	const file = world.app.vault.getFileByPath(path);
	return file === null ? null : { file, layout };
}

/** `text` without the lines at `at`. */
function withoutLines(text: string, at: readonly number[]): string {
	return text.split("\n").filter((_, index) => !at.includes(index)).join("\n");
}

/**
 * The live copy of the filing whose collection line is `copyLine` taken out of
 * today's log ({@link liveCopiesIn}), through the editor of a tab showing it when
 * there is one and through the note writer otherwise, the two routes the source
 * note's write takes. Answers what changed, or `null` when today's log holds no live
 * copy, in which case it is not written at all.
 */
async function takeOutLiveCopies(world: UndoWorld, file: TFile, editor: Editor | null, copyLine: string, layout: VaultLayout): Promise<LogWrite | null> {
	const withoutCopies = (text: string): string => withoutLines(text, liveCopiesIn(text, copyLine, layout));
	if (editor !== null) {
		const text = editor.getValue();
		const run = changedRun(text, withoutCopies(text));
		if (run === null) return null;
		const lines = text.split("\n");
		const last = run.at + run.before.length - 1;
		if (run.after.length > 0) {
			editor.replaceRange(run.after.join("\n"), { line: run.at, ch: 0 }, { line: last, ch: lines[last].length });
		} else if (last + 1 < lines.length) {
			editor.replaceRange("", { line: run.at, ch: 0 }, { line: last + 1, ch: 0 });
		} else {
			// The lines run to the end of the note: take the line break before them instead.
			const from = run.at === 0 ? { line: 0, ch: 0 } : { line: run.at - 1, ch: lines[run.at - 1].length };
			editor.replaceRange("", from, { line: last, ch: lines[last].length });
		}
		return run;
	}
	// Looked at before the write, so a log with no live copy is not handed to the note writer at all.
	const seen = await world.notes.read(file);
	if (changedRun(seen, withoutCopies(seen)) === null) return null;
	const wrote: (LogWrite | null)[] = [];
	await world.notes.edit(file, (text) => {
		const now = withoutCopies(text);
		wrote.push(changedRun(text, now));
		return now;
	});
	return wrote[wrote.length - 1] ?? null;
}

/**
 * What the log's half changed: the lines from `at` that were there before, and the
 * lines written over them, each in the log's own bytes. The change is one run of
 * lines, from the first the undo altered to the last. In the note the frozen line is
 * in, a live copy of the task in that same note is inside the run and goes back with
 * the frozen line. Today's log, when it is another note, is a write of its own
 * ({@link takeOutLiveCopies}, since #994)
 * with its own `LogWrite`, put back on its own.
 */
interface LogWrite {
	readonly at: number;
	readonly before: readonly string[];
	readonly after: readonly string[];
	/**
	 * The line just above the run and the one just below it in the text the write left,
	 * `undefined` at an end of the note. A run that only removed lines has no `after` to
	 * compare, so these are what tell {@link putLogBack} the log still reads as the undo
	 * left it.
	 */
	readonly around: { readonly above: string | undefined; readonly below: string | undefined };
}

/** The one run of lines in which `before` and `after` differ, or `null` when they do not. */
function changedRun(before: string, after: string): LogWrite | null {
	const was = before.split("\n");
	const now = after.split("\n");
	let head = 0;
	while (head < was.length && head < now.length && was[head] === now[head]) head += 1;
	let tail = 0;
	while (tail < was.length - head && tail < now.length - head && was[was.length - 1 - tail] === now[now.length - 1 - tail]) tail += 1;
	if (head === was.length && head === now.length) return null;
	const written = now.slice(head, now.length - tail);
	return { at: head, before: was.slice(head, was.length - tail), after: written, around: { above: now[head - 1], below: now[head + written.length] } };
}

/** How undo looks for the frozen line: the kind of note it is in, and which of its lines may be the one. */
interface FrozenSearch {
	readonly source: SourceNote;
	readonly place: UndoPlace | undefined;
}

/** The log with the filing undone: the frozen line put back and the live copies of the task removed. */
function unwound(text: string, id: string, found: Extract<FiledReading, { ok: true }>, where: string, search: FrozenSearch): string {
	const frozen = readFrozen(text, id, acceptedIn(text, search.source, search.place));
	if (frozen === null) throw new Error(`the frozen line is no longer in ${where}`);
	// Only a day's log is scanned for the echo; from any other note the live copy is in today's log ({@link takeOutLiveCopies}).
	const echoes = echoesOf(text, frozen.at, found.line, search.source.kind === "dailyLog");
	return restoreInLog(text, frozen, restoredLines(found, echoes.comments), echoes.at);
}

/** The log half: through an editor on the source note when one is at hand, else through the note writer. */
async function restoreLog(world: UndoWorld, log: TFile, editor: Editor | null, id: string, found: Extract<FiledReading, { ok: true }>, where: string, search: FrozenSearch): Promise<LogWrite> {
	if (editor !== null) {
		// The editor's own text is read again here, so a line that moved is found where it is.
		const text = editor.getValue();
		const run = changedRun(text, unwound(text, id, found, where, search));
		if (run === null) throw new Error(`the undo changed nothing in ${where}`);
		const last = run.at + run.before.length - 1;
		editor.replaceRange(run.after.join("\n"), { line: run.at, ch: 0 }, { line: last, ch: editor.getLine(last).length });
		return run;
	}
	const wrote: LogWrite[] = [];
	await world.notes.edit(log, (text) => {
		const now = unwound(text, id, found, where, search);
		const run = changedRun(text, now);
		if (run === null) throw new Error(`the undo changed nothing in ${where}`);
		wrote.push(run);
		return now;
	});
	return wrote[wrote.length - 1];
}

/** Whether `lines` are exactly `expected`, a log's carriage returns aside. */
function holds(lines: readonly string[], expected: readonly string[]): boolean {
	return lines.length === expected.length && lines.every((each, at) => each.replace(/\r$/, "") === expected[at].replace(/\r$/, ""));
}

/** Whether `lines` still have, around the place a run of lines was removed from, the two lines the write left there. */
function stillAround(lines: readonly string[], wrote: LogWrite): boolean {
	const same = (a: string | undefined, b: string | undefined): boolean => a?.replace(/\r$/, "") === b?.replace(/\r$/, "");
	return same(lines[wrote.at - 1], wrote.around.above) && same(lines[wrote.at], wrote.around.below);
}

/**
 * Puts a note back where one write of the undo changed it, whether that is
 * {@link restoreLog}'s on the note the frozen line is in or {@link takeOutLiveCopies}'s
 * on today's log; `log` is that note. It is put back only while the note still reads as
 * the write left it: the lines the write put there are still exactly there, or, for a
 * write that only removed lines and so left none to compare, the line above and the line
 * below the place are still the two the write left. A note the person has typed in
 * since is left as it is. True when the note is back, false when it could not be,
 * whether because it moved on or because writing it failed.
 */
async function putLogBack(world: UndoWorld, log: TFile, editor: Editor | null, wrote: LogWrite): Promise<boolean> {
	const last = wrote.at + wrote.after.length - 1;
	try {
		if (editor !== null && wrote.after.length === 0) {
			// The write only removed lines ({@link takeOutLiveCopies}): they go back in as lines, with the break that went with them.
			const lines = editor.getValue().split("\n");
			if (!stillAround(lines, wrote)) return false;
			if (wrote.at < lines.length) editor.replaceRange(`${wrote.before.join("\n")}\n`, { line: wrote.at, ch: 0 }, { line: wrote.at, ch: 0 });
			else editor.replaceRange(`\n${wrote.before.join("\n")}`, { line: lines.length - 1, ch: lines[lines.length - 1].length }, { line: lines.length - 1, ch: lines[lines.length - 1].length });
			return true;
		}
		if (editor !== null) {
			if (!holds(editor.getValue().split("\n").slice(wrote.at, last + 1), wrote.after)) return false;
			editor.replaceRange(wrote.before.join("\n"), { line: wrote.at, ch: 0 }, { line: last, ch: editor.getLine(last).length });
			return true;
		}
		let put = false;
		await world.notes.edit(log, (text) => {
			const lines = text.split("\n");
			if (wrote.after.length === 0 ? !stillAround(lines, wrote) : !holds(lines.slice(wrote.at, last + 1), wrote.after)) return text;
			lines.splice(wrote.at, wrote.after.length, ...wrote.before);
			put = true;
			return lines.join("\n");
		});
		return put;
	} catch {
		return false;
	}
}

/**
 * Undoes each filing named by `ids` in the source note at `logPath`, and answers
 * the one sentence to tell the person. Each filing is judged on its own: one
 * refused because its task was touched does not stop the others, and writes
 * nothing.
 *
 * `source` says what note `logPath` is, so the sentences name it as the day's
 * log or as "the note".
 * The default is the day's log, which is what every caller was before #981.
 *
 * `place` says which line may be the frozen one: without it the first line carrying the id
 * anywhere is; with it, only a line {@link frozenPlace} accepts, and only `place.lineIndex`
 * where the right-click named one.
 *
 * `editor` is the one the route already holds; the notice route passes none,
 * and the editor of a tab showing the log is looked for now. `hintPath` is the
 * collection the notice route just wrote to, tried before any found by name.
 */
export async function undoFilings(
	world: UndoWorld,
	logPath: string,
	ids: readonly string[],
	hintPath: string | null,
	editor: Editor | null,
	source: SourceNote = DAY_LOG,
	place?: UndoPlace,
): Promise<string> {
	const where = source.kind === "dailyLog" ? "the day's log" : "the note";
	const log = world.app.vault.getFileByPath(logPath);
	if (log === null) return `${capitalised(where)} is not in the vault any more, so nothing was undone.`;
	const on = editor ?? editorOn(world.app, logPath);

	const results: One[] = [];
	for (const id of ids) {
		try {
			results.push(await undoOne(world, log, id, hintPath, on, where, { source, place }));
		} catch (error) {
			results.push({ undone: false, said: `The undo did not finish. ${reasonOf(error)}` });
		}
	}

	const undone = results.filter((each) => each.undone);
	const refused = results.filter((each) => !each.undone).map((each) => each.said);
	if (refused.length === 0 && undone.length === 1) {
		return `Undone. The task is back in ${where} and no longer in ${undone[0].said}.`;
	}
	const head = undone.length > 0 ? [`Undone for ${undone.length} ${undone.length === 1 ? "task" : "tasks"}.`] : [];
	return [...head, ...refused].join(" ");
}

/**
 * The notice a filing ends with: the sentence, and a button that runs `onUndo`.
 * `Notice` takes a `DocumentFragment` for a message
 * (`node_modules/obsidian/obsidian.d.ts:4637`); a click hides the notice first,
 * so a second click cannot start a second undo.
 */
export function noticeWithUndo(text: string, onUndo: () => void): Notice {
	const fragment = createFragment();
	fragment.append(text);
	const button = createEl("button", { text: UNDO_BUTTON });
	fragment.append(" ", button);
	const notice = new Notice(fragment, UNDO_NOTICE_MS);
	button.addEventListener("click", () => {
		notice.hide();
		onUndo();
	});
	return notice;
}

/** What the button says. */
export const UNDO_BUTTON = "Undo migration";

/** Long enough to read the sentence and press the button; Obsidian's default is five seconds. */
const UNDO_NOTICE_MS = 10000;
