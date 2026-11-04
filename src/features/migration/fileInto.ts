/**
 * What is written when a task is filed into a collection
 * (#856, spec
 * #716 decisions 6, 7 and 8).
 *
 * Pure over text: no vault, no app, no clock. Three seams, smallest first.
 *
 * - {@link linesToWrite} works on the one line. The collection's line is the
 *   log line's own text, verbatim, plus the link back to the day's log it was
 *   filed from and the marker; the frozen line is the same text with `[>]`,
 *   the link to the collection the caller gives (whatever shape the person's
 *   link setting writes) appended, and the marker. Neither is built by taking
 *   the line apart, so every byte the two lines do not change is the byte the
 *   person wrote, and **no date is ever added**. **The link back does not
 *   travel**: Task consistency later copies this same collection line
 *   into a day's log without it, told apart from a link the person typed by
 *   `src/core/markerLink.ts`'s own rule — the marker itself says it carries a
 *   link, rather than the link merely sitting right before it.
 * - {@link placeInCollection} puts a line into the collection's text: an open or
 *   cancelled task at the bottom of the tasks section, a done task under the
 *   completed-tasks heading, written if it is missing.
 * - {@link freezeInLog} swaps the frozen line into the day's log.
 *
 * {@link fileInto} runs all three over the two texts. The command does not call
 * it: the two files are written by two separate edits, each of which is handed
 * the file's text as it is at that moment, so the command calls the seams one
 * at a time. What `fileInto` answers is what the two files hold afterwards.
 *
 * **The completed-tasks heading is written here without asking**, and the tasks
 * heading never is. Filing an already-done task is the one case decision 8
 * allows it, because ticking the task already authorised that bookkeeping; a
 * note without the tasks heading is not a collection, and turning it into one
 * is a question for the person.
 *
 * The two headings are found at whatever level the collection wrote them, not
 * at a configured level, because a collection's headings carry none. The shape of
 * "written if missing, beneath the tasks" is `completeInCollection`'s in Task
 * consistency, read for its shape and written again here: a feature never
 * references another.
 */

import { clampLevel, headingRange, isAtxHeading } from "../../core/markdownSections";
import type { SectionRange } from "../../core/markdownSections";
import type { VaultLayout } from "../../core/settings";
import type { CheckboxMeaning } from "../../core/taskLine";
import { editTaskField, insertionPointOf, parseTaskLine } from "../../core/taskLine";
import { DAY_LOG, filableCheck } from "./filable";
import type { SourceNote } from "./filable";
import type { Added } from "./marker";
import { hashOfLine, headingKey, readMarker, withAdded, writeMarker } from "./marker";

/** The two lines one filing writes, and what kind of task it was. */
export interface FiledLines {
	/** The id both lines carry, so a caller need not read it back out of them. */
	readonly id: string;
	/** The collection's new line: the log line's own text plus the marker. */
	readonly collectionLine: string;
	/** The log line as it is left behind: `[>]`, the link, the marker. */
	readonly frozenLine: string;
	/** What the original's checkbox meant, which decides where the copy lands. */
	readonly meaning: CheckboxMeaning;
}

/**
 * Both lines for filing `sourceLine` under `id`. `link` is the whole link the
 * frozen line ends in, as the person's own link setting writes it — the caller
 * asks the vault for it (`FileManager.generateMarkdownLink`), since two
 * collections may share a name and the name alone opens whichever Obsidian
 * prefers. It is
 * required: a default of the bare `[[name]]` would let a caller that forgot it
 * write the one link #871 exists to stop writing. `logLink` is the same kind
 * of whole link, to the note `sourceLine` is being filed from, appended
 * to the collection's own line the same way — the mirror of `link`, settled
 * by the author on #906.
 * Throws when `sourceLine` is not a task line — the caller has already asked
 * `filableCheck`.
 *
 * **The hash is taken from `sourceLine` alone, the link back masked out the
 * same way the marker itself is**:
 * at the moment of filing there is no marker yet to claim the link, so
 * `hashOfLine` (`marker.ts`) has nothing to mask and hashes the bare filed
 * words; at an undo's later re-check the collection line already carries
 * both, and `hashOfLine` masks the link out by the marker's own flag before
 * hashing, so appending the link back never by itself makes undo read the
 * task as touched (#716 decision 8, #906's own acceptance criterion) — and
 * neither does Obsidian later rewriting the link's own text, which is not the
 * person touching the task.
 *
 * **The link back is inserted at `taskLine.ts`'s own `insertionPointOf`**, the
 * same point `setComment`'s own `addField` uses, rather than appended to the
 * raw string: any trailing whitespace the person wrote moves past it, to sit
 * after the marker instead, exactly the way appending a field already does —
 * so `withoutAppendedLink` and the marker's own removal together give that
 * whitespace back byte for byte on undo, whatever ran before it. A field
 * added later still lands at this same point, so it comes to sit *after* the
 * link and before the marker — the marker's own flag is what keeps the link
 * found even then.
 */
export function linesToWrite(sourceLine: string, id: string, link: string, logLink: string): FiledLines {
	const task = parseTaskLine(sourceLine);
	if (task === null) throw new Error(`not a task line: ${JSON.stringify(sourceLine)}`);

	const hash = hashOfLine(task);

	const at = insertionPointOf(sourceLine);
	const withLogLink = `${sourceLine.slice(0, at)} ${logLink}${sourceLine.slice(at)}`;

	const forwarded = editTaskField(sourceLine, "checkbox", ">");
	// One space before the frozen line's own link, unless it already ends in
	// whitespace the person wrote: that whitespace is theirs and stays where it is.
	const frozenSeparator = /[ \t]$/.test(forwarded) ? "" : " ";
	const withLink = `${forwarded}${frozenSeparator}${link}`;

	return {
		id,
		collectionLine: writeMarker(withLogLink, id, hash, task.checkbox, true),
		frozenLine: writeMarker(withLink, id, hash, task.checkbox, true),
		meaning: task.meaning,
	};
}

/** A heading match with the level it was found at. */
interface HeadingMatch extends SectionRange {
	readonly level: number;
}

/**
 * The first place in `content` where `text` is a heading, at whichever level it
 * is written; the earliest line wins when it is written at more than one.
 */
function findHeading(content: string, text: string): HeadingMatch | null {
	if (!text.trim()) return null;
	let best: HeadingMatch | null = null;
	for (let level = 1; level <= 6; level += 1) {
		const found = headingRange(content, text, level);
		if (found !== null && (best === null || found.heading < best.heading)) best = { ...found, level };
	}
	return best;
}

/**
 * `match`'s end, cut short at `other`'s heading when that sits inside `match`:
 * whichever of the tasks and completed-tasks headings is written first and
 * shallower would otherwise swallow the other's lines.
 */
function clippedEnd(match: HeadingMatch, other: HeadingMatch | null): number {
	if (other !== null && other.heading > match.heading && other.heading < match.end) return other.heading;
	return match.end;
}

/** Where a line added to the section `[start, end)` goes: after its last line that is not blank. */
function endOfContent(lines: readonly string[], start: number, end: number): number {
	let at = end;
	while (at > start && lines[at - 1].replace(/\r$/, "") === "") at -= 1;
	return at;
}

/** What placing a line in a collection answers. */
export type Placement = { ok: true; text: string } | { ok: false; reason: string };

/**
 * `collectionText` with `line` (or a task's line followed by its sub-lines, as
 * an array) added where a task of that `meaning` belongs.
 *
 * Refuses, with a sentence, when the collection no longer has the tasks heading
 * (it stopped being a collection since it was chosen), and when a done task is
 * filed while the completed-tasks heading in the settings is blank.
 */
export function placeInCollection(
	collectionText: string,
	line: string | readonly string[],
	meaning: CheckboxMeaning,
	layout: VaultLayout,
	noteBefore?: string,
): Placement {
	const placed = place(collectionText, line, meaning, layout);
	if (!placed.ok || noteBefore === undefined) return placed;
	return { ok: true, text: recordingAllAdded(noteBefore, placed.text, typeof line === "string" ? [line] : line) };
}

/**
 * `after`, the text {@link placeInCollection} made from `before` plus something the
 * caller wrote first (the tasks heading, #1004),
 * with the marker on `block`'s first line recording **everything** that separates
 * `after` from `before` apart from the block: the caller's lines and placing's own.
 * `after` unchanged when the first line carries no marker of this feature's, or
 * when what was added is not a run of blank lines and headings right around the
 * block (nothing is then recorded, and an undo takes the block alone).
 *
 * Read from the two texts rather than assembled from what each step meant to
 * write: the note's last line break belongs to whichever step happens to see it as
 * a blank line, and only the texts say where each byte ended up.
 */
function recordingAllAdded(before: string, after: string, block: readonly string[]): string {
	const marker = readMarker(block[0]);
	if (marker === null) return after;
	const was = before.split("\n");
	// A Windows-endings note whose last line had no break gained one when anything was written below it: that `\r` is the same line, not an added one.
	if (before.includes("\r\n") && !before.endsWith("\n")) was[was.length - 1] += "\r";
	const lines = after.split("\n");
	const at = lines.findIndex((each) => readMarker(each)?.id === marker.id);
	if (at < 0) return after;
	const added = addedAround(was, lines, at, block.length);
	if (added === null) return after;
	// The record names the heading the block went under: the one placing named, else the heading this filing wrote.
	const written = added.above.lastIndexOf("h");
	const under = readMarker(lines[at])?.added?.under ?? (written < 0 ? undefined : headingKey(lines[at - added.above.length + written]));
	const recorded = under === undefined ? added : { ...added, under };
	lines[at] = withAdded(lines[at].replace(/\r$/, ""), recorded) + (lines[at].endsWith("\r") ? "\r" : "");
	return lines.join("\n");
}

/**
 * What lies directly above and below the `length` lines of `after` at `at`, in
 * {@link Added}'s letters, when taking exactly those lines and the block out gives
 * `before` back; null when nothing was added, or something else was.
 * Where the blank lines of `before` and the ones added cannot be told apart, the
 * split with the most lines above the block is used, which reads as the filing wrote
 * it (a blank line, the heading, a blank line, the task); every split gives the same text.
 */
function addedAround(before: readonly string[], after: readonly string[], at: number, length: number): Added | null {
	const extra = after.length - before.length - length;
	if (extra <= 0) return null;
	const blank = (line: string): boolean => line.replace(/\r$/, "") === "";
	for (let above = extra; above >= 0; above -= 1) {
		const from = at - above;
		const to = at + length + (extra - above);
		if (from < 0 || to > after.length) continue;
		const rest = [...after.slice(0, from), ...after.slice(to)];
		if (rest.length !== before.length || rest.some((line, index) => line !== before[index])) continue;
		const kinds = after.slice(from, at).map((line) => (blank(line) ? "b" : isAtxHeading(line.replace(/\r$/, "")) ? "h" : "?"));
		const below = after.slice(at + length, to);
		if (kinds.includes("?") || !below.every(blank)) continue;
		return { above: kinds.join(""), below: "b".repeat(below.length) };
	}
	return null;
}

/**
 * {@link placeInCollection}'s work over the text, in one line model: in a Windows-endings
 * note every line is read as ending in its break, so a note whose last line has none is
 * given one for the work and loses it again afterwards. What stops the text is then never
 * one of the lines, and every splice at the end of the note lands after a terminated line.
 * The final break the note had is the final break it keeps.
 */
function place(
	collectionText: string,
	line: string | readonly string[],
	meaning: CheckboxMeaning,
	layout: VaultLayout,
): Placement {
	const windows = collectionText.includes("\r\n");
	if (!windows || collectionText.endsWith("\n")) return placeTerminated(collectionText, line, meaning, layout);
	const placed = placeTerminated(`${collectionText}\r\n`, line, meaning, layout);
	if (!placed.ok) return placed;
	if (!placed.text.endsWith("\r\n")) throw new Error(`placing a line left a Windows-endings note without its closing line break: ${JSON.stringify(placed.text.slice(-20))}`);
	return { ok: true, text: placed.text.slice(0, -2) };
}

function placeTerminated(
	collectionText: string,
	line: string | readonly string[],
	meaning: CheckboxMeaning,
	layout: VaultLayout,
): Placement {
	const cr = collectionText.includes("\r\n") ? "\r" : "";
	const lines = collectionText.split("\n");
	const block = (typeof line === "string" ? [line] : line).map((each) => each + cr);

	const tasks = findHeading(collectionText, layout.tasksHeading);
	if (tasks === null) {
		return { ok: false, reason: `The note no longer has the ${layout.tasksHeading} heading, so it is not a collection.` };
	}

	const completedText = layout.completedTasksHeading.trim();
	const completed = findHeading(collectionText, layout.completedTasksHeading);

	if (meaning !== "done") {
		insertBelow(lines, tasks.start, clippedEnd(tasks, completed), block, cr, lines[tasks.heading]);
		return { ok: true, text: lines.join("\n") };
	}

	if (completedText === "") {
		return {
			ok: false,
			reason: "The completed-tasks heading is blank in the settings, so a done task has nowhere to go.",
		};
	}

	if (completed !== null) {
		insertBelow(lines, completed.start, clippedEnd(completed, tasks), block, cr, lines[completed.heading]);
		return { ok: true, text: lines.join("\n") };
	}

	const insertAt = tasks.end;
	const endsWithNewline = lines.length > 0 && lines[lines.length - 1].replace(/\r$/, "") === "";
	const needsLeadingBlank = insertAt > 0 && lines[insertAt - 1].replace(/\r$/, "") !== "";
	const needsTrailingBlank =
		insertAt < lines.length ? lines[insertAt].replace(/\r$/, "") !== "" : endsWithNewline;
	// What the filing writes around the block, recorded in its marker so an undo takes out exactly that.
	const heading = `${"#".repeat(clampLevel(tasks.level))} ${completedText}`;
	// At the end of a Windows-endings note that ends in a line break, the note's old last element (the one that
	// stops the text) becomes the blank line above the heading and a new one stops the text, so the record
	// counts that blank above and nothing below.
	const movesEnd = cr !== "" && insertAt >= lines.length && endsWithNewline;
	const added = movesEnd
		? { above: "bhb", below: "", under: headingKey(heading) }
		: { above: `${needsLeadingBlank ? "b" : ""}hb`, below: needsTrailingBlank ? "b" : "", under: headingKey(heading) };
	const written = [
		...(needsLeadingBlank ? [cr] : []),
		`${heading}${cr}`,
		cr,
		...recorded(block, added, cr),
		...(needsTrailingBlank ? [cr] : []),
	];
	if (cr !== "" && insertAt >= lines.length) {
		// Written at the very end of a Windows-endings note:
		// the note's last element is where its text stops, not a line of its own, so it
		// ends in no `\r`. What goes after it makes it a line, and the new last element
		// is the one that stops the text.
		const last = lines.length - 1;
		if (!lines[last].endsWith("\r")) lines[last] += cr;
		const end = written.length - 1;
		written[end] = written[end].replace(/\r$/, "");
	}
	lines.splice(insertAt, 0, ...written);
	return { ok: true, text: lines.join("\n") };
}

/**
 * `block` with what the filing added around it written into the marker on its
 * first line ({@link withAdded}), in the block's own line endings. The lines
 * carry `cr` at their ends; the marker is read from the line without it.
 */
function recorded(block: readonly string[], added: Added, cr: string): string[] {
	const [first, ...rest] = block;
	const bare = cr === "" ? first : first.replace(/\r$/, "");
	return [withAdded(bare, added) + cr, ...rest];
}

/**
 * Adds `block` (a task's line and its sub-lines, each already ending as the
 * file's lines do) at the bottom of the section `[start, end)` of `lines`, in place.
 * A section with nothing in it gets the line under a blank line, and a blank
 * line after it when a heading follows directly; **the blank lines it wrote are
 * recorded in the block's marker**,
 * because the text afterwards cannot say which of them were the person's:
 * `## Tasks\n## Notes` and `## Tasks\n\n## Notes` file to the same text. **The
 * record also names the heading the block went under** (`headingLine`, the section's
 * own), so an undo can tell a block still where this filing put it from one the
 * person moved between blank lines of their own.
 */
function insertBelow(lines: string[], start: number, end: number, block: readonly string[], cr: string, headingLine: string): void {
	// In a Windows-endings note the text's last element is where the text stops, not a line:
	// set aside, so it is neither read as the blank line under an empty section nor spliced
	// before.
	const stops = cr !== "" && lines[lines.length - 1] === "";
	if (stops) lines.pop();
	insertInLines(lines, start, Math.min(end, lines.length), block, cr, headingLine);
	if (stops) lines.push("");
}

function insertInLines(lines: string[], start: number, end: number, block: readonly string[], cr: string, headingLine: string): void {
	const at = endOfContent(lines, start, end);
	if (at > start) {
		lines.splice(at, 0, ...block);
		return;
	}
	const hasBlankUnderHeading = start < end && lines[start].replace(/\r$/, "") === "";
	const insertAt = hasBlankUnderHeading ? start + 1 : start;
	const next = lines[insertAt];
	const needsTrailingBlank = next !== undefined && next.replace(/\r$/, "") !== "";
	const added = { above: hasBlankUnderHeading ? "" : "b", below: needsTrailingBlank ? "b" : "", under: headingKey(headingLine) };
	lines.splice(
		insertAt,
		0,
		...(hasBlankUnderHeading ? [] : [cr]),
		...recorded(block, added, cr),
		...(needsTrailingBlank ? [cr] : []),
	);
}

/**
 * The line of `logText` the frozen line replaces: `lineIndex` when it still
 * reads exactly as `sourceLine`, else the one other line that does. A line
 * found the second way must also be one {@link filableCheck} would accept where
 * it now sits in that note, so an identical line under a day's task section, or
 * in fenced text or the frontmatter of another note, is never taken for the
 * task that was filed. `null` when there is none, or several.
 *
 * `logText` is the text of the note the task came from; `source` says what that
 * note is, a day's log unless said otherwise.
 */
export function lineToFreeze(logText: string, lineIndex: number, sourceLine: string, layout: VaultLayout, source: SourceNote = DAY_LOG): number | null {
	const lines = logText.split("\n");
	const plain = (line: string): string => line.replace(/\r$/, "");

	if (lineIndex < lines.length && plain(lines[lineIndex]) === sourceLine) return lineIndex;

	const check = filableCheck(logText, source, layout);
	const matches: number[] = [];
	lines.forEach((line, index) => {
		if (plain(line) === sourceLine && check(index, sourceLine).ok) {
			matches.push(index);
		}
	});
	return matches.length === 1 ? matches[0] : null;
}

/**
 * `logText` with `frozenLine` in the place of the original, found by
 * {@link lineToFreeze}. `null` when there is no such line: the note then
 * stays as it is and the caller says so.
 */
export function freezeInLog(
	logText: string,
	lineIndex: number,
	sourceLine: string,
	frozenLine: string,
	layout: VaultLayout,
	source: SourceNote = DAY_LOG,
): string | null {
	const at = lineToFreeze(logText, lineIndex, sourceLine, layout, source);
	if (at === null) return null;

	const lines = logText.split("\n");
	lines[at] = lines[at].endsWith("\r") ? `${frozenLine}\r` : frozenLine;
	return lines.join("\n");
}

/** What filing answers: the two texts afterwards, and the id on both lines. */
export type FileIntoResult =
	| { ok: true; log: string; collection: string; id: string }
	| { ok: false; reason: string };

/**
 * What {@link fileInto} is given. The fields keep the names they had when every
 * filing came from a day's log; since #981 `logText` and `logLink` are the note
 * the task came from, whatever it is, and `source` says what that note is.
 */
export interface FileIntoInput {
	/** The text of the note the task came from: the day's log, or another note. */
	readonly logText: string;
	/** The line of it the task sits on, counted from zero. */
	readonly lineIndex: number;
	/** The collection's text. */
	readonly collectionText: string;
	/** The whole link the frozen line ends in, as the person's link setting writes it. */
	readonly collectionLink: string;
	/** The whole link the collection's copy ends in, back to the note the task came from — the mirror of {@link collectionLink}. */
	readonly logLink: string;
	readonly id: string;
	readonly layout: VaultLayout;
	/** What the note the task came from is; a day's log when left out. */
	readonly source?: SourceNote;
}

/** Files the task on line `lineIndex` of the note it came from into the collection, over the two texts. */
export function fileInto(input: FileIntoInput): FileIntoResult {
	const source = input.source ?? DAY_LOG;
	const sourceLine = input.logText.split("\n")[input.lineIndex]?.replace(/\r$/, "");
	if (sourceLine === undefined) {
		return { ok: false, reason: source.kind === "dailyLog" ? "The task's line is not in the day's log." : "The task's line is not in the note." };
	}

	const filed = linesToWrite(sourceLine, input.id, input.collectionLink, input.logLink);
	const placed = placeInCollection(input.collectionText, filed.collectionLine, filed.meaning, input.layout);
	if (!placed.ok) return placed;

	const log = freezeInLog(input.logText, input.lineIndex, sourceLine, filed.frozenLine, input.layout, source);
	if (log === null) return { ok: false, reason: "The task's line has changed since it was read." };

	return { ok: true, log, collection: placed.text, id: input.id };
}
