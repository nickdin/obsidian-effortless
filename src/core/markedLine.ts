/**
 * Going to the line a feature's hidden comment names: finding it in a note's
 * text, opening the note, and putting the cursor there.
 *
 * Two features jump this way — Task consistency to a task's other copy,
 * Migration to the task it filed — and neither may reference the other, so
 * what they share lives here. Each keeps what is its own: how it reads its
 * comment, what it says when nothing is found. Nothing here writes to a note,
 * and nothing here remembers a line number, a path or a text from one call to
 * the next: every call reads the world again.
 */

import { MarkdownView } from "obsidian";
import type { App, EditorPosition } from "obsidian";
import type { TaskLine } from "./taskLine";
import { parseTaskLine, readComment } from "./taskLine";

/**
 * A caller's question about a line: given what is inside the feature's own
 * comment and the task line it is on, is this the line being looked for?
 */
export type MarkedLineTest = (inside: string, line: TaskLine) => boolean;

/**
 * The line in `text` whose `featureId` comment satisfies `test`, counted from
 * zero — matching every editor position in this codebase. Two lines that both
 * satisfy it: the first is the one found. Only the first comment carrying the
 * id on a line is asked, and a comment with another id never is.
 *
 * Pure over the text handed in; how fresh that text is is the caller's.
 */
export function findMarkedLine(text: string, featureId: string, test: MarkedLineTest): number | null {
	const lines = text.split("\n");
	for (let at = 0; at < lines.length; at += 1) {
		const inside = readComment(lines[at], featureId);
		if (inside === null) continue;
		const line = parseTaskLine(lines[at]);
		if (line !== null && test(inside, line)) return at;
	}
	return null;
}

/** What placing the cursor found, or that no line answered. */
export type PlaceResult = "placed" | "not-found";

/** What placing needs of an editor: its current text, and a way to move its cursor. */
export interface PlacingEditor {
	getValue(): string;
	setCursor(pos: EditorPosition): void;
}

/**
 * Reads `editor`'s **current** text, and puts the cursor at the start of the
 * line {@link findMarkedLine} finds in it. Not found moves nothing.
 */
export function placeOnMarkedLine(editor: PlacingEditor, featureId: string, test: MarkedLineTest): PlaceResult {
	const at = findMarkedLine(editor.getValue(), featureId, test);
	if (at === null) return "not-found";
	editor.setCursor({ line: at, ch: 0 });
	return "placed";
}

/**
 * Opens the note at `path` in the active pane and hands back its editor.
 * Throws, saying which, when the note no longer exists or did not open as a
 * note.
 *
 * `Vault.getFileByPath` (`node_modules/obsidian/obsidian.d.ts:7351`),
 * `Workspace.getLeaf` (`:7892`), `WorkspaceLeaf.openFile` (`:8257`),
 * `Workspace.getActiveViewOfType` (`:7989`) and `MarkdownView.editor`
 * (`:4191`) are all published.
 */
export async function openNoteEditor(app: App, path: string): Promise<PlacingEditor> {
	const file = app.vault.getFileByPath(path);
	if (file === null) throw new Error(`"${path}" no longer exists`);
	await app.workspace.getLeaf(false).openFile(file);
	const view = app.workspace.getActiveViewOfType(MarkdownView);
	if (view === null) throw new Error(`"${path}" did not open as a note`);
	return view.editor;
}
