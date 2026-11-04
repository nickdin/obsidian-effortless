/**
 * The right-click entry on a line: the
 * same filing action as the command, offered on any line where a task may be
 * filed from: under the notes heading of a day's log, or anywhere in another
 * note that is neither a collection nor excluded, outside a fenced block (and,
 * outside the day's log, outside the frontmatter) — `placeCheck` in
 * `filable.ts`, widened by #981 —
 * **and only on a line the command could file**: a task line that passes
 * `checkLine` too. On a
 * heading, prose, a blank line, a plain bullet or an already-frozen line of
 * such a note, or on any line of a day's log that is not a task under the notes
 * heading (#996, which ends
 * #860's place-only rule there), the entry does not show. The command still
 * re-checks everything and refuses, in words, anything that reaches it.
 *
 * Obsidian's `Workspace.on('editor-menu', (menu, editor, info) => …)`
 * (`node_modules/obsidian/obsidian.d.ts:8128`) hands over the menu about to be
 * shown. This module adds one entry to it, or none. **The note, the place
 * and the line itself are the only checks made before the menu shows**, the
 * same the command asks first (`sourceNoteOf` and `filableCheck`, in a day's log and elsewhere alike). The entry's click runs the
 * function the command runs, and that runs the rest (readiness, the note and
 * the place again, the selection's plan and each line's own checks), so every
 * refusal is worded once, there. The long-press menu on a phone is
 * unverified.
 *
 * **Every entry decides on the line the right-click landed on, not the one the
 * cursor was on before it**:
 * each is handed a {@link PressedLine}, and a menu whose click it cannot read
 * gets no entry (`pressedLine.ts` says why and says so aloud). Once chosen, an
 * entry is handed that line when chosen, because Obsidian does not reliably
 * move the cursor there before the entry runs; a drive that saw
 * it move (`docs/acceptance-shots/issue-864-drive-1-settings-chooser-rightclick.txt`,
 * step 3a) saw one click, not every timing.
 *
 * Each entry a later ticket adds to this menu is a function of its own beside
 * {@link fileEntry}, so the feature registers them one line each.
 */

import type { Editor, MarkdownFileInfo, MarkdownView, Menu } from "obsidian";
import type { TFile } from "obsidian";
import type { VaultLayout } from "../../core/settings";
import { filableCheck, sourceNoteOf } from "./filable";
import { frozenLineAt } from "./frozenLine";
import type { PressedLine } from "./pressedLine";
import { selectedLineRange } from "./selection";

/** What the entry says. The command's own name carries the feature's, which a menu of one plugin's entries does not need. */
export const FILE_ENTRY_TITLE = "File this task into a collection";

/**
 * The `editor-menu` listener that adds the filing entry.
 *
 * `layout` and `isCollection` are asked each time the menu opens, never kept,
 * so a changed notes heading, or a note that has just become a collection, is
 * felt at once. `isCollection` is the collections index as it stands. `start`
 * is what the command does with a note's editor and file; the entry's click
 * calls exactly that.
 *
 * **The click files the pressed line**,
 * handed to `start` the way the jump entry hands it to `jump`. Where the
 * cursor's selection already covers the pressed line, `start` is called as the
 * command calls it, so a press inside a selection files the whole selection.
 */
export function fileEntry(
	layout: () => VaultLayout,
	start: (editor: Editor, file: TFile, lineIndex?: number) => void,
	pressed: PressedLine,
	isCollection: (path: string) => boolean,
): (menu: Menu, editor: Editor, info: MarkdownView | MarkdownFileInfo) => void {
	return (menu, editor, info) => {
		const file = info.file;
		if (file === null) return;
		const now = layout();
		const note = sourceNoteOf(file.path, isCollection, now);
		if (!note.ok) return;

		const lineIndex = pressed(menu, editor);
		if (lineIndex === null) return;
		// Offered only on the pressed line, and only where the command could file it: a task under the
		// notes heading of a day's log, or a task anywhere else outside fenced text and frontmatter.
		const offered = filableCheck(editor.getValue(), note.source, now)(lineIndex, editor.getLine(lineIndex));
		if (!offered.ok) return;

		menu.addItem((item) => item.setTitle(FILE_ENTRY_TITLE).setIcon("folder-input").onClick(() => {
			const { first, last } = selectedLineRange(editor.getCursor("from"), editor.getCursor("to"));
			if (lineIndex >= first && lineIndex <= last) start(editor, file);
			else start(editor, file, lineIndex);
		}));
	};
}

/** What the jump entry says. */
export const JUMP_ENTRY_TITLE = "Go to this task in its collection";

/**
 * The `editor-menu` listener that adds the jump entry: on a line that
 * is a frozen line ({@link frozenLineAt}: in a day's log or in any note that is not a
 * collection and not excluded, #983), and nowhere else. The
 * click runs `jump`, the function the command runs, so the two routes cannot
 * differ. The line and the layout are read when the menu opens, never kept.
 *
 * **The jump is handed the pressed line**:
 * a right-click does not reliably move the cursor before the entry runs, so the
 * entry that was offered on one line must not jump from another. Where the cursor
 * is on the pressed line already, the jump is called as the command calls it.
 */
export function jumpEntry(
	jump: (editor: Editor, file: TFile, lineIndex?: number) => void,
	layout: () => VaultLayout,
	pressed: PressedLine,
	isCollection: (path: string) => boolean,
): (menu: Menu, editor: Editor, info: MarkdownView | MarkdownFileInfo) => void {
	return (menu, editor, info) => {
		const file = info.file;
		if (file === null) return;
		const lineIndex = pressed(menu, editor);
		if (lineIndex === null) return;
		if (frozenLineAt(editor, file, layout(), isCollection, lineIndex) === null) return;

		menu.addItem((item) => item.setTitle(JUMP_ENTRY_TITLE).setIcon("corner-down-right").onClick(() => (editor.getCursor().line === lineIndex ? jump(editor, file) : jump(editor, file, lineIndex))));
	};
}

/** What the undo entry says; the notice's button says the same ({@link UNDO_BUTTON} in `undo.ts`). */
export const UNDO_ENTRY_TITLE = "Undo migration";

/**
 * The `editor-menu` listener that adds the undo entry: on a frozen line
 * in a day's log or any other note that is not a collection and not under an excluded folder, that is a task line marked `[>]` that carries this feature's
 * marker, outside fenced text and, outside a day's log, the frontmatter. **The place and the marker are all that is
 * checked before the menu shows**; whether the task is still untouched is undo's
 * to answer, when the entry is chosen, in a `Notice` that names the collection.
 *
 * `undo` is handed the editor and note the menu was opened in, the marker's
 * `id` and the pressed line, and runs what the notice's button runs. **The pressed
 * line is the one written**:
 * a copy of the frozen line elsewhere in the note, quoted in a fenced block or
 * repeated, carries the same `id` and is not the line the person pressed.
 */
export function undoEntry(
	layout: () => VaultLayout,
	undo: (editor: Editor, file: TFile, id: string, lineIndex: number) => void,
	pressed: PressedLine,
	isCollection: (path: string) => boolean,
): (menu: Menu, editor: Editor, info: MarkdownView | MarkdownFileInfo) => void {
	return (menu, editor, info) => {
		const file = info.file;
		if (file === null) return;
		const lineIndex = pressed(menu, editor);
		if (lineIndex === null) return;
		const frozen = frozenLineAt(editor, file, layout(), isCollection, lineIndex);
		if (frozen === null) return;

		menu.addItem((item) => item.setTitle(UNDO_ENTRY_TITLE).setIcon("undo-2").onClick(() => undo(editor, file, frozen.marker.id, lineIndex)));
	};
}
