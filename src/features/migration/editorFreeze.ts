/**
 * The one write the command makes to the open day's log: the frozen line in the
 * place of the filed line and the sub-lines that travelled with it. Through the
 * `Editor` and not the core's note writer, for the reason
 * `Migration.file` gives.
 */

import type { Editor } from "obsidian";

/**
 * Replaces line `at` and the `subLines` lines under it with `frozenLine`. A task
 * with no sub-lines is one `Editor.setLine`; otherwise one `Editor.replaceRange`
 * over the whole run, so the log changes in a single step.
 */
export function freezeInEditor(editor: Editor, at: number, subLines: number, frozenLine: string): void {
	if (subLines === 0) {
		editor.setLine(at, frozenLine);
		return;
	}
	const lastLine = at + subLines;
	editor.replaceRange(frozenLine, { line: at, ch: 0 }, { line: lastLine, ch: editor.getLine(lastLine).length });
}
