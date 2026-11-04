/**
 * Which notes are waiting to be gone through, as a pure rule: the vault's notes
 * in, the list and the count out. Nothing here reads the vault, Obsidian's
 * metadata or the clock — the caller hands in each note's path, frontmatter and
 * text, the layout, the window, today's date and a link resolver — so every case
 * is a literal in a test.
 *
 * A **waiting note** is one whose processed field is present and empty, whose
 * day lies in the window, and that sits outside the excluded folders. Its day is
 * the date its name carries when it is a day's log, and otherwise the date of
 * the day's log its day-link field points to. Template notes fall out without a
 * rule of their own: the day's-log template's name is not a date and it links to
 * no day's log.
 *
 * What a day's log is, what an excluded folder is, what a task line is and what
 * a fenced block is are the core's answers, imported; this module states none of
 * them again. The reader keeps nothing: every call reads what it is given.
 */

import { builtDiaryMarkIn } from "../../core/builtDiaryMark";
import { isExcluded, noteName } from "../../core/collections";
import { linksOnLine } from "../../core/linkReading";
import { fencedLinesOfNote, frontmatterEnd } from "../../core/markdownSections";
import type { VaultLayout } from "../../core/settings";
import { checkboxSlot, hasBookkeepingComment, isFilableOpen, parseTaskLine } from "../../core/taskLine";
import { isDailyLogPath, parseDailyLogDate, sectionOfLine, sectionRange } from "../../core/vaultLayout";
import { isBuiltSection } from "./diaryDate";
import { isEmptyPropertyValue } from "./markProcessed";

/** One note as the caller read it: where it is, what its frontmatter holds, and its text. */
export interface ReviewNote {
	readonly path: string;
	/**
	 * The note's frontmatter as Obsidian's metadata cache gives it, or `null`
	 * when it has none. A property written with nothing after the colon is
	 * present with the value `null` (inferred from how YAML parses an empty
	 * value; no drive in `docs/acceptance-shots/` shows what the cache hands over).
	 */
	readonly frontmatter: Readonly<Record<string, unknown>> | null;
	/** The whole text of the note, frontmatter included. */
	readonly text: string;
}

/**
 * Resolves the text of a link written in the note at `sourcePath` to the path
 * of the note it points at, or `null` when it points nowhere. The feature hands
 * Obsidian's own, so a link resolves here the way it does in the app.
 */
export type ResolveLink = (linkText: string, sourcePath: string) => string | null;

/** One waiting note, with what the list shows of it. */
export interface WaitingNote {
	readonly path: string;
	/** The note's name as a person reads it: no folder, no extension. */
	readonly name: string;
	/** The day it belongs to, a local-time date at midnight. */
	readonly day: Date;
	/**
	 * Open tasks that nothing else handles: open task lines with the space
	 * checkbox, outside fenced text and frontmatter, carrying no hidden
	 * `%% … %%` comment (a filed or paired task is already handled). In a day's
	 * log only those under the notes heading count, because Today and Overdue
	 * hold what Roll-over and Task consistency already carry; in any other note
	 * every section counts, except that **a note the collections index calls a
	 * collection counts 0**, because Migration refuses every line of one (its
	 * tasks already live in a collection). Such a note is still listed. The
	 * count is exactly the open tasks Migration's check lets through: the symbol,
	 * the place and the comment rules are its own, and so is where the fence scan
	 * starts — at line 0 in a day's log, below the frontmatter in any other note
	 * (`fencedLinesOfNote` in the core, which both ask).
	 */
	readonly openTasks: number;
	/** List items without a checkbox, nested ones included, outside fenced text and frontmatter. */
	readonly plainBullets: number;
	/** Whether the day is before today, which is what the count counts. */
	readonly counts: boolean;
	/**
	 * Whether this is a day's log whose diary section exists and holds no
	 * non-blank line below its heading. `false` when the diary heading setting is
	 * blank, the section is absent, or the note is not a day's log (the diary is
	 * the day's own, glossary *Diary*). It is the reader's fact for any day in
	 * the window; the list decides to show it on today's row only, and `count`
	 * never reads it.
	 */
	readonly diaryEmpty: boolean;
}

/** The waiting notes, today's included, and how many of them count. */
export interface WaitingNotes {
	/** Every waiting note, oldest day first, notes of one day in name order. */
	readonly list: readonly WaitingNote[];
	/** The waiting notes whose day is before today. */
	readonly count: number;
	/**
	 * Whether today's log has a diary section with nothing under it, **whatever
	 * its processed field says**. A log marked processed has no row, so the
	 * nudge cannot hang on one; the list draws the words from this when today has
	 * no row (the author, 2026-10-13, #1151).
	 * Today's log only, read with {@link diaryEmptyIn} like a row's `diaryEmpty`,
	 * and a log in an excluded folder is left out as it is from the rows. It is
	 * never counted: `count` does not read it.
	 */
	readonly todayDiaryEmpty: boolean;
}

/**
 * Whether the note at `path` is the day's log of `today`, in a folder that is
 * not excluded. Asks neither the frontmatter nor the text: Review reads today's
 * log whatever its processed field says, so the feature uses this to know whose
 * text to read besides the waiting notes'.
 */
export function isTodaysLog(path: string, layout: VaultLayout, today: Date): boolean {
	if (isExcluded(path, layout.excludedFolders)) return false;
	const day = parseDailyLogDate(path, layout);
	return day !== null && dayNumber(day) === dayNumber(today);
}

/**
 * The waiting notes among `notes`.
 *
 * `windowDays` is a whole number of at least 1: today and the `windowDays - 1`
 * days before it are in the window, a day after today never is. The oldest day
 * of a 7-day window is today minus 6.
 *
 * `templateDiaryOf` answers, for a day's log, the diary section the day's-log
 * template would have made for it, or `null` when there is none to compare with.
 * A log whose diary section is exactly that is read as empty ({@link diaryEmptyIn}).
 */
export function waitingNotes(
	notes: readonly ReviewNote[],
	layout: VaultLayout,
	windowDays: number,
	today: Date,
	resolveLink: ResolveLink,
	isCollection: (path: string) => boolean,
	templateDiaryOf: (path: string) => string | null = () => null,
): WaitingNotes {
	const todayNumber = dayNumber(today);
	const oldest = todayNumber - (windowDays - 1);
	const found: WaitingNote[] = [];

	for (const note of notes) {
		if (!hasEmptyField(note.frontmatter, layout.processedField)) continue;
		if (isExcluded(note.path, layout.excludedFolders)) continue;

		const day = dayOf(note, layout, resolveLink);
		if (day === null) continue;
		const number = dayNumber(day);
		if (number > todayNumber || number < oldest) continue;

		const lines = countLines(note, layout, isCollection);
		found.push({
			path: note.path,
			name: noteName(note.path),
			day,
			openTasks: lines.openTasks,
			plainBullets: lines.plainBullets,
			counts: number < todayNumber,
			diaryEmpty: diaryEmptyIn(note, layout, templateDiaryOf(note.path)),
		});
	}

	found.sort((a, b) => dayNumber(a.day) - dayNumber(b.day) || compareNames(a.name, b.name) || compareNames(a.path, b.path));
	const todayDiaryEmpty = notes.some((note) => isTodaysLog(note.path, layout, today) && diaryEmptyIn(note, layout, templateDiaryOf(note.path)));
	return { list: found, count: found.filter((note) => note.counts).length, todayDiaryEmpty };
}

/**
 * Whether a note takes part in going through at all: its frontmatter holds
 * `field`, the processed field, whatever the value. A note without the field
 * never takes part, so the list leaves it out and the chain steps over it as it
 * would a missing note.
 */
export function takesPartInReview(frontmatter: ReviewNote["frontmatter"], field: string): frontmatter is Readonly<Record<string, unknown>> {
	return frontmatter !== null && Object.prototype.hasOwnProperty.call(frontmatter, field);
}

/**
 * Whether `field` is present in `frontmatter` and empty. A property written
 * with nothing after its colon reaches the metadata cache as `null` (inferred,
 * not driven); `undefined`, an empty or blank string and a list with nothing in
 * it are empty too, by {@link isEmptyPropertyValue}, the one answer the chain and
 * *Mark as processed* use.
 * Any other value — `true`, a date, a word, a number, a list holding something —
 * is a note gone through. A key that is absent is not
 * present, so a note without the field never takes part.
 */
function hasEmptyField(frontmatter: ReviewNote["frontmatter"], field: string): boolean {
	if (!takesPartInReview(frontmatter, field)) return false;
	return isEmptyPropertyValue(frontmatter[field]);
}

/**
 * The day a note belongs to: its own date when it is a day's log, otherwise the
 * date of the day's log its day-link field points to. `null` when it has
 * neither — a link that points nowhere, or at a note that is not a day's log,
 * gives no day.
 */
export function dayOf(note: ReviewNote, layout: VaultLayout, resolveLink: ResolveLink): Date | null {
	const own = parseDailyLogDate(note.path, layout);
	if (own !== null) return own;

	const link = dayLinkText(note.frontmatter?.[layout.dayLinkField]);
	if (link === null) return null;
	const target = linksOnLine(link)[0];
	if (target === undefined) return null;
	const resolved = resolveLink(target.path, note.path);
	return resolved === null ? null : parseDailyLogDate(resolved, layout);
}

/**
 * The text of the link a day-link field holds, whichever way the person wrote it.
 * A quoted `"[[day]]"` is a string; the same under a list property is a list of
 * that string; an unquoted `[[day]]` is a list holding a list of the bare target,
 * and as an item under a list property it is one list deeper, so its brackets are
 * put back. The first three were read back from Obsidian's metadata cache
 * (`docs/acceptance-shots/issue-1066-day-link-shapes.txt`), the fourth in
 * `docs/acceptance-shots/fix-1102-drive.txt`. Anything else — a number, an empty
 * list, a list deeper than these — gives `null`; an empty string is returned as
 * it is, and `dayOf` turns it into no day because no link is found in it.
 */
function dayLinkText(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return null;
	const first: unknown = value[0];
	if (typeof first === "string") return first;
	if (!Array.isArray(first)) return null;
	const second: unknown = first[0];
	if (typeof second === "string") return `[[${second}]]`;
	if (Array.isArray(second) && typeof second[0] === "string") return `[[${second[0]}]]`;
	return null;
}

/**
 * A calendar day as a whole number, from its local year, month and date. Two
 * days one apart differ by exactly 1 whatever the clock does between them, so a
 * daylight-saving change never moves a day across the window's edge.
 */
function dayNumber(date: Date): number {
	return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
}

/** Name order: by code point, the same for every device and language. */
function compareNames(a: string, b: string): number {
	if (a < b) return -1;
	return a > b ? 1 : 0;
}

/**
 * Whether `note` is a day's log whose diary section exists and has no non-blank
 * line in it. The section is the core's `sectionRange` for the diary heading at
 * its level, so a blank heading setting finds nothing and answers `false`. It is
 * asked of the text below the frontmatter, as {@link countLines} reads it: a
 * `# Diary` comment in a property block is a value there, not the heading.
 * Trimming a line also clears the `\r` of a note with Windows line endings.
 * **A section that is exactly the diary the day's-log template would have
 * produced is empty too** (`templateDiary`, ticket
 * #1170, against #1136), and
 * so is one that still matches the mark the log carries of the section it was
 * built with: the person has written nothing, and the stamp already reads
 * it so ({@link isBuiltSection}).
 */
function diaryEmptyIn(note: ReviewNote, layout: VaultLayout, templateDiary: string | null): boolean {
	if (!isDailyLogPath(note.path, layout)) return false;
	const lines = note.text.split("\n");
	const body = lines.slice(frontmatterEnd(lines) + 1);
	const range = sectionRange(body.join("\n"), "diaryHeading", layout);
	if (range === null) return false;
	const section = body.slice(range.start, range.end);
	return section.every((line) => line.trim() === "") || isBuiltSection(section, builtDiaryMarkIn(note.text), templateDiary);
}

/**
 * The note's open task lines and plain list items, both outside fenced text and
 * frontmatter. A task line is whatever the core's reader says one is. An open
 * one counts when it is the open task the core calls filable
 * ({@link isFilableOpen}), carries no bookkeeping comment, and, in a day's log,
 * sits under the notes heading; the section is the core's `sectionOfLine`, asked
 * only for the lines that got that far. A list item without a checkbox is a line
 * the core's reader refuses as a task whose shape the core gives a list marker.
 * In a note the collections index calls a collection no open task counts, while
 * its list items still do.
 */
function countLines(note: ReviewNote, layout: VaultLayout, isCollection: (path: string) => boolean): { openTasks: number; plainBullets: number } {
	const text = note.text;
	const lines = text.split("\n");
	const frontmatter = frontmatterEnd(lines);
	const inDayLog = isDailyLogPath(note.path, layout);
	// A day's log is never a collection, whatever the index says: Migration asks
	// the day's log first too (`sourceNoteOf`), and the index is read now, here.
	const collection = !inDayLog && isCollection(note.path);
	// Where the fence scan starts is the core's rule, the one Migration asks too.
	const fenced = fencedLinesOfNote(lines, inDayLog);
	let openTasks = 0;
	let plainBullets = 0;

	for (let i = frontmatter + 1; i < lines.length; i += 1) {
		if (fenced[i]) continue;
		const task = parseTaskLine(lines[i]);
		if (task !== null) {
			if (collection || !isFilableOpen(task) || hasBookkeepingComment(task)) continue;
			if (inDayLog && sectionOfLine(text, i, layout) !== "notesHeading") continue;
			openTasks += 1;
			continue;
		}
		// `- [x]text` has no space after its bracket, so the core does not call
		// it a task line, and Obsidian draws it as a bullet of that text.
		const shape = checkboxSlot(lines[i]).shape;
		if (shape === "bullet" || shape === "numbered" || shape === "unspaced-bracket") plainBullets += 1;
	}

	return { openTasks, plainBullets };
}
