/**
 * Helpers for a test that opens the editor menu.
 *
 * `CLAUDE.md`: "An editor-menu entry decides from the line that was pressed,
 * never the cursor's line." The Obsidian stub throws when a test opens the menu
 * without naming that line (`__mocks__/obsidian.ts`, `UNNAMED_PRESSED_LINE_MESSAGE`),
 * because a test that presses the cursor's own line passes whether the entry
 * reads the pressed line or the cursor's. So a test names the line one of two ways:
 * {@link pressLine}, which says which line and where the cursor sits (a line
 * other than the pressed one, unless told otherwise), {@link pressLineAwayFromCursor},
 * for an editor a helper built with its cursor already on the pressed line, or
 * {@link pressCursorLine}, for a test where the two are the same line on purpose
 * and which must say why.
 */

import type { PressableEditor } from "./__mocks__/obsidian";

/**
 * Presses `pressed` in `editor`, whose cursor must be on another line: that is
 * where Obsidian has it when the person right-clicks somewhere else
 * (`docs/acceptance-shots/issue-881-rightclick-line.txt`), and a test whose
 * cursor is on the pressed line cannot tell an entry that reads the pressed
 * line from one that reads the cursor's. Throws when they are the same line,
 * so the test says why with {@link pressCursorLine} instead. `null` is a menu
 * opened with no mouse event. Returns the editor.
 */
export function pressLine<E extends PressableEditor>(editor: E, pressed: number | null): E {
	if (pressed !== null && editor.getCursor().line === pressed) {
		throw new Error(`pressLine: the cursor is on line ${pressed}, the pressed line. Put the cursor elsewhere, or use pressCursorLine and say why they must be one line.`);
	}
	editor.pressedLine = pressed;
	return editor;
}

/**
 * Presses the line the cursor is already on. `because` says why the test needs
 * the two to be one line, in words a reader of the test can check: a test that
 * can give no reason should use {@link pressLine}. Returns the editor.
 */
export function pressCursorLine<E extends PressableEditor>(editor: E, because: string): E {
	if (because.trim() === "") throw new Error("pressCursorLine needs a reason: say why this test presses the cursor's own line.");
	editor.pressedLine = editor.getCursor().line;
	return editor;
}

/**
 * Presses `pressed` in an editor whose cursor the test did not choose (a filing
 * left it on the line it filed, which is the line pressed next): the editor
 * then reports its cursor on line 0, or line 1 when `pressed` is 0, so an entry
 * that reads the cursor finds another line. Returns the editor.
 */
export function pressLineAwayFromCursor<E extends PressableEditor>(editor: E, pressed: number): E {
	const at = pressed === 0 ? 1 : 0;
	editor.getCursor = () => ({ line: at, ch: 0 });
	return pressLine(editor, pressed);
}
