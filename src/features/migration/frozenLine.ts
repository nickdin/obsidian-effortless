/**
 * The one place check for this feature's entries on a frozen line
 * (#877, found against
 * #861): the jump command,
 * its right-click entry and the undo entry all ask it, so they cannot gate three
 * ways on one marker.
 *
 * A frozen line is a task line marked `[>]` that carries this feature's marker,
 * in a day's log or in any other note that is not a collection and not under an
 * excluded folder, outside a fenced block. The collection's own copy of the task
 * carries the same marker with an open checkbox and is never one.
 *
 * "Which notes" is `sourceNoteOf` in `filable.ts`, the same answer filing asks,
 * so the two cannot read one note two ways; where in the note is
 * {@link frozenPlace}, which outside a day's log is filing's `placeCheck` and in
 * a day's log only rules out fenced text, since filing's notes-heading rule does
 * not bind a frozen line there. The rename
 * rewrite outside a day's log reaches a `[>]` line carrying any hidden comment
 * (`RenameWhere.frozenLinesOnly`), which every line passing this check does.
 */

import type { Editor, TFile } from "obsidian";
import { fencedLines } from "../../core/markdownSections";
import type { VaultLayout } from "../../core/settings";
import { placeCheck, sourceNoteOf } from "./filable";
import type { SourceNote } from "./filable";
import { canJumpFrom } from "./jump";
import { readMarker } from "./marker";
import type { FiledMarker } from "./marker";

/** The frozen line under the cursor, and what its marker says. */
export interface FrozenLine {
	readonly line: string;
	readonly marker: FiledMarker;
}

/**
 * Whether a frozen line may stand on each line of `content`, as far as its place
 * goes: the one rule {@link frozenLineAt} and undo both ask, so the line a menu
 * offers and the line undo writes cannot be read two ways. A day's log holds a
 * frozen line under any heading, so only fenced text rules it out there; any
 * other note also rules out its frontmatter, which `placeCheck` knows. Made once
 * for the whole text.
 */
export function frozenPlace(content: string, source: SourceNote, layout: VaultLayout): (lineIndex: number) => boolean {
	if (source.kind === "dailyLog") {
		const fenced = fencedLines(content.split("\n"));
		return (lineIndex) => !fenced[lineIndex];
	}
	const check = placeCheck(content, source, layout);
	return (lineIndex) => check(lineIndex).ok;
}

/**
 * The frozen line at `lineIndex` in `file` — the cursor's line unless the caller
 * names another, as a right-click does — or null when it
 * is anything else. `layout`, the editor's text and `isCollection` (the
 * collections index as it stands) are read now, never kept.
 */
export function frozenLineAt(
	editor: Pick<Editor, "getValue" | "getLine" | "getCursor">,
	file: Pick<TFile, "path">,
	layout: VaultLayout,
	isCollection: (path: string) => boolean,
	lineIndex: number = editor.getCursor().line,
): FrozenLine | null {
	const note = sourceNoteOf(file.path, isCollection, layout);
	if (!note.ok) return null;
	if (!frozenPlace(editor.getValue(), note.source, layout)(lineIndex)) return null;
	const line = editor.getLine(lineIndex).replace(/\r$/, "");
	if (!canJumpFrom(line)) return null;
	const marker = readMarker(line);
	return marker === null ? null : { line, marker };
}
