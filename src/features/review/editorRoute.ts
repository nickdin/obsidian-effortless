/**
 * *Mark as processed* on a note that is on screen in an editor.
 *
 * The core's `NoteWriter` holds every write to the note on screen until the
 * person leaves it, to protect what they are typing. A press on *Mark as
 * processed* is not a background write: the person asked for it, and the field
 * sits in the frontmatter, not under the cursor. So for a note an editor shows,
 * the date goes in through that editor, as the repo's other commands on the open
 * note do (`Editor.transaction`, `node_modules/obsidian/obsidian.d.ts:2556`):
 * one transaction replacing the one line, so one undo puts it back and the
 * cursor and the rest of the note are untouched. A note no editor shows still
 * goes through the `NoteWriter`: at once unless a tab shows it in source mode, where it is held.
 *
 * **Line endings are Obsidian's, not this route's.** A note whose file has
 * Windows endings, a byte-order mark or bare carriage returns is loaded into an
 * editor as line feeds only, and saved that way once it has been opened and left,
 * with or without a write from here (`docs/acceptance-shots/fix-1079-drive.txt`,
 * steps 2, 5 and 5b). Holding the press back for such a note would keep nothing, so
 * it goes through the editor like any other.
 */

import type { App, Editor } from "obsidian";
import { sourceModeViews } from "../../core/noteWriter";
import { markProcessedChange } from "./markProcessed";

/**
 * The editor of a tab showing the note at `path` for editing, or `null` when no
 * tab does. Which tabs count is the core's rule, `sourceModeViews`; the
 * `MarkdownView.editor` it hands back is `obsidian.d.ts:4191`. Read when used,
 * never kept: a tab closed or moved since is not there.
 *
 * **A tab in reading mode does not count.** It still has an `editor`, but
 * nothing in `docs/acceptance-shots/` shows that a write through it reaches the
 * file: one earlier drive of this ticket read such a tab's editor holding the
 * text of another note (inferred from that drive; its record was overwritten),
 * and step 6 of the #1079 drive read one holding this note's text. A note shown
 * that way goes through the `NoteWriter` as a write the person asked for, which
 * writes it at once.
 */
export function editorOn(app: App, path: string): Editor | null {
	return sourceModeViews(app, path)[0]?.editor ?? null;
}

/**
 * Sets the processed field's line in `editor` (both lines, for an empty list spread over two) to `<field>: <date>` in one
 * transaction, from the text the editor holds now. Throws as
 * `markProcessedText` does when that text has no empty field to fill.
 */
export function markInEditor(editor: Editor, field: string, date: string): void {
	const lines = editor.getValue().split("\n");
	const change = markProcessedChange(lines, field, date, true);
	if (change === null) return;
	const last = change.index + change.removeAfter;
	editor.transaction({
		changes: [
			{
				from: { line: change.index, ch: 0 },
				to: { line: last, ch: lines[last].length },
				text: change.line,
			},
		],
	});
}
