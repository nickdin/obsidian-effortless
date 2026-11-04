/**
 * The line a right-click landed on
 * (#881, found against
 * #860).
 *
 * Obsidian fires `editor-menu` before it moves the typing cursor to the pressed
 * line, and hands the listener no pointer position
 * (`node_modules/obsidian/obsidian.d.ts:8128`: `(menu, editor, info)`), so the
 * cursor names the line the person was on before the click
 * (`docs/acceptance-shots/issue-881-rightclick-line.txt`). No published call
 * answers "which line is under the pointer" (`obsidian.d.ts` declares no
 * `posAtMouse`, `posAtCoords` or `coordsAtPos` on `Editor`), so this takes the
 * route the drive read back:
 *
 * 1. the `contextmenu` event that opens the menu reaches the window's
 *    document first, in the capture phase, carrying the pointer's position;
 * 2. `editor.cm.posAtCoords` turns that position into a document offset, and
 *    `Editor.offsetToPos` (`obsidian.d.ts:2571`, published) into a line.
 *
 * **`Editor.cm` is not in the published API**, only its type
 * (`editorEditorField`, `obsidian.d.ts:2597`, hands an `EditorView` to anyone
 * who already holds an `EditorState`, which is the same thing). When a step of
 * the route is missing, the entries are left out of that menu and one notice
 * says why: falling back to the cursor's line would put the entry on the wrong
 * line again and say nothing.
 *
 * **The menu can open a moment after the event**: with the pane not holding the
 * typing focus, `editor-menu` fired in a later turn, after the cursor had moved
 * (`docs/acceptance-shots/issue-881-rightclick-line.txt`, the first build's cases
 * A and C), so the click is kept for {@link CLICK_KEPT_MS}, and the first menu to
 * read it takes it: every listener of that one menu gets its answer, and a menu
 * opened some other way is never answered with an earlier click.
 */

import { Notice } from "obsidian";
import type { Editor, Menu, Workspace } from "obsidian";

/** What is said when the click cannot be read. */
export const UNREADABLE_CLICK_MESSAGE =
	"Effortless could not tell which line was right-clicked, so Migration's entries are left out of this menu.";

/** How long a right-click waits for the menu it opens, when the menu is not fired in the same turn. */
export const CLICK_KEPT_MS = 1000;

/** What Obsidian's editor carries that `obsidian.d.ts` does not declare. */
interface EditorWithView {
	readonly cm?: { posAtCoords?(coords: { x: number; y: number }): unknown } | null;
}

/** Answers, for a menu just opened, which line of `editor` the pointer was on; `null` when that cannot be read. */
export type PressedLine = (menu: Menu, editor: Editor) => number | null;

/**
 * Listens for the right-click on every window's document and answers
 * {@link PressedLine}. {@link follow} starts it and returns what stops it.
 */
export class PressedLineReader {
	private event: MouseEvent | null = null;
	private timer: number | null = null;
	private readonly answers = new WeakMap<Menu, number | null>();

	/**
	 * Listens on the main window's document, on every popout the workspace holds
	 * a leaf in, and on any opened later; a window that closes has its listener
	 * taken off. Each document is bound once.
	 */
	follow(workspace: Pick<Workspace, "on" | "offref" | "iterateAllLeaves">): () => void {
		const onContextMenu = (evt: MouseEvent): void => {
			this.event = evt;
			if (this.timer !== null) window.clearTimeout(this.timer);
			this.timer = window.setTimeout(() => {
				this.event = null;
				this.timer = null;
			}, CLICK_KEPT_MS);
		};
		const bound = new Map<Document, () => void>();
		const bind = (doc: Document): void => {
			if (bound.has(doc)) return;
			doc.addEventListener("contextmenu", onContextMenu, true);
			bound.set(doc, () => doc.removeEventListener("contextmenu", onContextMenu, true));
		};
		const unbind = (doc: Document): void => {
			bound.get(doc)?.();
			bound.delete(doc);
		};
		bind(document);
		workspace.iterateAllLeaves((leaf) => bind(leaf.getContainer().doc));
		const opened = workspace.on("window-open", (win) => bind(win.doc));
		const closed = workspace.on("window-close", (win) => unbind(win.doc));
		return () => {
			workspace.offref(opened);
			workspace.offref(closed);
			for (const doc of [...bound.keys()]) unbind(doc);
			if (this.timer !== null) window.clearTimeout(this.timer);
			this.timer = null;
			this.event = null;
		};
	}

	/** The line under the pointer for the menu now opening, or `null` after saying, once per menu, that it cannot be read. */
	readonly lineOf: PressedLine = (menu, editor) => {
		const known = this.answers.get(menu);
		if (known !== undefined) return known;
		const line = this.read(editor);
		this.event = null;
		this.answers.set(menu, line);
		if (line === null) new Notice(UNREADABLE_CLICK_MESSAGE);
		return line;
	};

	private read(editor: Editor): number | null {
		const evt = this.event;
		if (evt === null) return null;
		const cm = (editor as Editor & EditorWithView).cm;
		if (cm === undefined || cm === null || typeof cm.posAtCoords !== "function") return null;
		const offset = cm.posAtCoords({ x: evt.clientX, y: evt.clientY });
		if (typeof offset !== "number") return null;
		return editor.offsetToPos(offset).line;
	}
}
