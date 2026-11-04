/**
 * Which tasks the person is following, as a pure rule: the vault's notes in, the
 * tasks grouped by the person they name out. Nothing here reads the vault,
 * Obsidian's metadata or the clock — the caller hands in each note's path and
 * text, the layout and the collection index's answer, so every case is a literal
 * in a test. It sits beside the waiting-notes reader and is shaped like it
 * (#1185, spec
 * #1181 implementation
 * decisions 1 to 3, ADR 0006, `GLOSSARY.md` under *Followed task*). Drawing the
 * result is the next ticket's business.
 *
 * A task line is **followed** when all of these hold:
 *
 * - its checkbox is live — `open` or `copied` by the core's reading; done,
 *   cancelled and forwarded never are;
 * - its line carries at least one person mark, read by the core's
 *   `personMarksOnLine` and never re-derived here. That reader hides a
 *   `%% … %%` comment only on a task line, so the line is asked whether it is a
 *   task first;
 * - it sits where the plugin reads tasks: under the collection's tasks heading
 *   in a collection (the caller's index says which note and at what level), under
 *   the notes heading of a day's log, and in any section of any other note —
 *   outside fenced text and frontmatter and outside the excluded folders. All of
 *   those rules are the core's, imported as the waiting-notes reader imports
 *   them.
 *
 * A line naming two people is one task listed under each. **A hidden comment does
 * not hide a task here**, unlike the waiting-notes count: a paired task's
 * collection line carries Task consistency's marker and is exactly what the list
 * must show. Its copy in the day's log sits under Today or Overdue, which the
 * day's-log rule never reads, so a paired task shows once, as the collection's
 * line.
 *
 * Groups are people in alphabetical order of the link path as written, compared
 * with a collator in the language Obsidian is displayed in (`getLanguage`,
 * `obsidian.d.ts:3365`), capitals and lower case together at the first level. Inside a group the tasks are ordered by
 * follow-up date, earliest first — {@link relevantDate}, the core's rule copy-in
 * uses — and the undated come last; ties fall to note path, then line.
 */

import { getLanguage } from "obsidian";
import { isExcluded, noteName } from "../../core/collections";
import type { Collection } from "../../core/collections";
import { fencedLinesOfNote, frontmatterEnd, headingRange } from "../../core/markdownSections";
import type { SectionRange } from "../../core/markdownSections";
import { personMarksOnLine } from "../../core/personMarks";
import type { VaultLayout } from "../../core/settings";
import { parseTaskLine, relevantDate } from "../../core/taskLine";
import type { TaskLine } from "../../core/taskLine";
import { isDailyLogPath, sectionOfLine } from "../../core/vaultLayout";
import type { ReviewNote } from "./waitingNotes";

/** One followed task, with what the list shows of it and where to open it. */
export interface FollowedTask {
	readonly path: string;
	/** The note's name as a person reads it: no folder, no extension. */
	readonly name: string;
	/** The line's index in the note's text, counted from zero, frontmatter included. */
	readonly line: number;
	/** What the line says after its checkbox, hidden comments removed and nothing else changed — dates and the person mark included. */
	readonly words: string;
	/** The follow-up date as `YYYY-MM-DD`, or `null` when the line has neither a scheduled nor a due date. */
	readonly date: string | null;
}

/** One person and the tasks that name them. */
export interface FollowedGroup {
	/** The link's path as written in the mark, without alias or heading. */
	readonly person: string;
	readonly tasks: readonly FollowedTask[];
}

/**
 * What the collection index says about a note that is one: the level its tasks
 * heading is written at in this note. `Collections.at` answers with a whole
 * {@link Collection}, which fits; `null` is a note that is not a collection.
 */
export type CollectionAt = (path: string) => Pick<Collection, "headingLevel"> | null;

/**
 * The followed tasks among `notes`, grouped by person and ordered.
 *
 * `collectionAt` is asked once per note outside the day's log, as the
 * waiting-notes reader asks `isCollection`: a day's log is never a collection,
 * whatever the index says.
 */
export function followedTasks(notes: readonly ReviewNote[], layout: VaultLayout, collectionAt: CollectionAt): FollowedGroup[] {
	const byPerson = new Map<string, FollowedTask[]>();

	for (const note of notes) {
		if (isExcluded(note.path, layout.excludedFolders)) continue;
		for (const [person, task] of followedIn(note, layout, collectionAt)) {
			const tasks = byPerson.get(person);
			if (tasks === undefined) byPerson.set(person, [task]);
			else tasks.push(task);
		}
	}

	const groups: FollowedGroup[] = [];
	for (const [person, tasks] of byPerson) groups.push({ person, tasks: tasks.sort(compareTasks) });
	// The language is read now, not kept: Obsidian's display language can change while the plugin runs.
	const collator = new Intl.Collator(getLanguage());
	return groups.sort((a, b) => collator.compare(a.person, b.person) || compareText(a.person, b.person));
}

/** Every followed task of one note, as `[person, task]` pairs: one pair per person the line names. */
function followedIn(note: ReviewNote, layout: VaultLayout, collectionAt: CollectionAt): Array<[string, FollowedTask]> {
	const lines = note.text.split("\n");
	const inDayLog = isDailyLogPath(note.path, layout);
	const collection = inDayLog ? null : collectionAt(note.path);
	// A collection whose tasks heading the text does not carry (the index read an
	// earlier text than this one) holds no followed task until the next read.
	const tasksRange = collection === null ? null : headingRange(note.text, layout.tasksHeading, collection.headingLevel);
	if (collection !== null && tasksRange === null) return [];
	// Where the fence scan starts is the core's rule, the one the waiting-notes reader asks too.
	const fenced = fencedLinesOfNote(lines, inDayLog);
	const found: Array<[string, FollowedTask]> = [];

	for (let i = frontmatterEnd(lines) + 1; i < lines.length; i += 1) {
		if (fenced[i]) continue;
		const task = parseTaskLine(lines[i]);
		if (task === null || !isLive(task)) continue;
		// A line is a task before its marks are read: a mark inside a comment is
		// hidden only on a task line (`personMarks.ts`).
		const people = new Set(personMarksOnLine(lines[i]).map((mark) => mark.person));
		if (people.size === 0) continue;
		if (!isRead(note, i, layout, inDayLog, tasksRange)) continue;

		const followed: FollowedTask = {
			path: note.path,
			name: noteName(note.path),
			line: i,
			words: wordsOf(task),
			date: relevantDate(task),
		};
		for (const person of people) found.push([person, followed]);
	}
	return found;
}

/** Whether the line at `index` sits where the plugin reads tasks in this note. */
function isRead(note: ReviewNote, index: number, layout: VaultLayout, inDayLog: boolean, tasksRange: SectionRange | null): boolean {
	if (inDayLog) return sectionOfLine(note.text, index, layout) === "notesHeading";
	if (tasksRange !== null) return index >= tasksRange.start && index < tasksRange.end;
	return true;
}

/** Whether the checkbox reads as a task still in someone's hands: open, or copied. */
function isLive(task: TaskLine): boolean {
	return task.meaning === "open" || task.meaning === "copied";
}

/**
 * The line's text after its checkbox with each `%% … %%` comment taken out, and
 * the spaces that stood before it, so the words close up where the comment was.
 * The ends are trimmed, which also clears the `\r` of a note with Windows line
 * endings. Nothing else is touched: dates, tags and the person mark stay.
 */
function wordsOf(task: TaskLine): string {
	let words = task.description;
	for (const comment of task.comments) {
		const at = words.indexOf(comment);
		if (at < 0) continue;
		words = words.slice(0, at).replace(/[ \t]+$/u, "") + words.slice(at + comment.length);
	}
	return words.trim();
}

/** Earliest follow-up date first, the undated last; equal dates by note path, then line. */
function compareTasks(a: FollowedTask, b: FollowedTask): number {
	if (a.date !== b.date) {
		if (a.date === null) return 1;
		if (b.date === null) return -1;
		return compareText(a.date, b.date);
	}
	return compareText(a.path, b.path) || a.line - b.line;
}

/** Code-point order, the same for every device and language: dates, paths, and the tie-break between two names the collator calls equal. */
function compareText(a: string, b: string): number {
	if (a < b) return -1;
	return a > b ? 1 : 0;
}
