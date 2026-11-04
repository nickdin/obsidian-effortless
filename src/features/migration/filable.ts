/**
 * What may be filed: whether one line, in the note and the place the cursor
 * found it, is a task Migration may move into a collection
 * (#856, spec
 * #716 decision 3, widened
 * by spec #980 decision 1
 * in #981).
 *
 * Pure. Three questions, asked in this order, and the first "no" is the
 * sentence a caller shows as a `Notice`, writing nothing:
 *
 * 1. **The note** ({@link sourceNoteOf}): a day's log, or any other note that is
 *    neither a collection nor under an excluded folder.
 * 2. **The place in it** ({@link placeCheck}): in a day's log, under the notes
 *    heading and outside a fenced block, as #716 decision 3 says; in any other
 *    note, anywhere outside a fenced block and outside the frontmatter.
 * 3. **The line itself** ({@link checkLine}): #716's shape, symbol and comment
 *    rules, the same wherever the line sits.
 *
 * Where the cursor sits in a day's log is worked out by the core's
 * `sectionOfLine`, re-exported here for the callers that ask Migration.
 */

import { isExcluded } from "../../core/collections";
import { fencedLinesOfNote, frontmatterEnd } from "../../core/markdownSections";
import { isDailyLogPath, sectionOfLine } from "../../core/vaultLayout";
import type { SectionName } from "../../core/vaultLayout";
import type { VaultLayout } from "../../core/settings";
import { checkboxSlot, hasBookkeepingComment, isFilableOpen, parseTaskLine } from "../../core/taskLine";

export { sectionOfLine };

/** Yes, or the sentence saying why not. */
export type FilableCheck = { ok: true } | { ok: false; reason: string };

/**
 * The note a task is filed from, as far as filing cares: a day's log, where
 * only the notes heading may be filed from, or any other note that may be filed
 * from anywhere. Which one is {@link sourceNoteOf}'s answer; a note that is
 * neither never gets this far.
 */
export type SourceNote = { readonly kind: "dailyLog" } | { readonly kind: "note" };

/** A day's log, the note every filing came from before #981. */
export const DAY_LOG: SourceNote = { kind: "dailyLog" };

/** Any other note that is not a collection and not excluded. */
export const ORDINARY_NOTE: SourceNote = { kind: "note" };

/** What a note is to filing, or the sentence saying why nothing in it is filed. */
export type SourceAnswer = { ok: true; source: SourceNote } | { ok: false; reason: string };

/** Said for a line in fenced text, in a day's log and in any other note alike; the glossary's word is "fenced". */
export const FENCED_REASON = "This line is inside fenced text, so it is not a task.";

/** Said for a line in a note's frontmatter, which is never a task line whatever it looks like. */
export const FRONTMATTER_REASON = "This line is in the note's frontmatter, so it is not a task.";

/** Said when the note is itself a collection: its tasks already live in one. */
export const IN_COLLECTION_REASON = "This note is a collection, so its tasks already live in one. A task is put in a collection from another note.";

/** Said when the note sits under a folder the person has excluded, such as their templates. */
export const EXCLUDED_REASON = "This note is in an excluded folder, so its tasks are not put in a collection.";

/**
 * What the note at `path` is to filing, asked when filing starts and never kept.
 *
 * - **A day's log** comes first, and is always one: the core's index never calls
 *   a day's log a collection, and #716 never asked whether it was excluded.
 * - **A note under an excluded folder** is refused. Asked of the core's own
 *   `isExcluded`, never re-derived here.
 * - **A collection** is refused. `isCollection` is the collections index as it
 *   stands now: the caller asks the index at the call, so a
 *   note that became a collection a moment ago is refused.
 * - **Any other note** may be filed from.
 */
export function sourceNoteOf(path: string, isCollection: (path: string) => boolean, layout: VaultLayout): SourceAnswer {
	if (isDailyLogPath(path, layout)) return { ok: true, source: DAY_LOG };
	if (isExcluded(path, layout.excludedFolders)) return { ok: false, reason: EXCLUDED_REASON };
	if (isCollection(path)) return { ok: false, reason: IN_COLLECTION_REASON };
	return { ok: true, source: ORDINARY_NOTE };
}

/**
 * Whether a task may be filed from each line of `content`, as far as its place
 * goes: one answer per line, asked of a function made once for the whole note,
 * because the fenced blocks and the frontmatter are read from the top and a
 * selection would otherwise read them once per line. In a day's log the notes
 * section is still found per line, by `sectionOfLine`.
 *
 * - **A day's log**: outside a fenced block and under the notes heading, with
 *   the sentences #716 gave, word for word.
 * - **Any other note**: outside the frontmatter and outside a fenced block,
 *   under any heading or none. A fence opened inside the frontmatter opens
 *   nothing below it.
 */
export function placeCheck(content: string, source: SourceNote, layout: VaultLayout): (lineIndex: number) => FilableCheck {
	const lines = content.split("\n");
	if (source.kind === "dailyLog") {
		const fenced = fencedLinesOfNote(lines, true);
		return (lineIndex) => {
			if (fenced[lineIndex]) return { ok: false, reason: FENCED_REASON };
			return checkSection(sectionOfLine(content, lineIndex, layout), layout);
		};
	}
	const frontmatter = frontmatterEnd(lines);
	const fenced = fencedLinesOfNote(lines, false);
	return (lineIndex) => {
		if (lineIndex <= frontmatter) return { ok: false, reason: FRONTMATTER_REASON };
		if (fenced[lineIndex]) return { ok: false, reason: FENCED_REASON };
		return { ok: true };
	};
}

/**
 * Whether a task may be filed from each line of `content`: its place, then the
 * line itself. What a selection, and the search for a moved line, both ask.
 */
export function filableCheck(content: string, source: SourceNote, layout: VaultLayout): (lineIndex: number, line: string) => FilableCheck {
	const place = placeCheck(content, source, layout);
	return (lineIndex, line) => {
		const where = place(lineIndex);
		return where.ok ? checkLine(line) : where;
	};
}

/** What a line that is not a task line is, in words for the refusal. */
function describeNonTask(line: string): string {
	const shape = checkboxSlot(line).shape;
	if (shape === "bullet" || shape === "numbered") return "a list item with no checkbox";
	if (shape === "unspaced-bracket") return "a list item whose bracket is not a checkbox";
	return "text that is not a task";
}

/**
 * Whether `line`, sitting in `section` of a day's log, may be filed into a
 * collection: {@link checkSection}, then {@link checkLine}.
 */
export function checkFilable(line: string, section: SectionName | null, layout: VaultLayout): FilableCheck {
	const place = checkSection(section, layout);
	return place.ok ? checkLine(line) : place;
}

/**
 * Whether a line under `section` of a day's log sits where a task may be filed
 * from. **Only under the notes heading.** Elsewhere the reason names the section
 * the line is under, or says it is under none.
 */
function checkSection(section: SectionName | null, layout: VaultLayout): FilableCheck {
	const notesHeading = layout.notesHeading.text;

	if (section === null) {
		return {
			ok: false,
			reason: `This line is not under ${notesHeading}. Only a task written there can be put in a collection.`,
		};
	}
	if (section !== "notesHeading") {
		return {
			ok: false,
			reason: `This task is under ${layout[section].text}. Only a task written under ${notesHeading} can be put in a collection.`,
		};
	}
	return { ok: true };
}

/**
 * Whether `line` itself may be filed, wherever it sits. Checked in this order,
 * and the first failure is the one said: the line's shape, then its checkbox,
 * then whether it already lives somewhere.
 *
 * - **Only a task line.** A plain bullet is refused naming what was found.
 * - **Only one of the five understood checkboxes.** The core reads every other
 *   symbol as an open task, so `- [I] an idea` would otherwise be filed by
 *   accident. The five are the core's own answer, read here and not copied: a
 *   symbol is understood when the core gives it a meaning other than `open`, or
 *   is the space that means open.
 * - **Only a line with no bookkeeping comment.** Any `%% … %%` comment — this
 *   feature's own from an earlier filing, Task consistency's pairing marker or
 *   any other — means the task may already be filed or paired.
 */
export function checkLine(line: string): FilableCheck {
	const task = parseTaskLine(line);
	if (task === null) {
		return { ok: false, reason: `This line is ${describeNonTask(line)}, not a task.` };
	}

	if (task.meaning === "open" && !isFilableOpen(task)) {
		return {
			ok: false,
			reason: `The checkbox [${task.checkbox}] is not one Effortless understands, so this task is not put in a collection.`,
		};
	}

	if (hasBookkeepingComment(task)) {
		return { ok: false, reason: "This task has a hidden comment on its line, so it may already be filed or paired." };
	}

	return { ok: true };
}
