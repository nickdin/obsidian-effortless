/**
 * Keeps the focus and the caret through a redraw that replaces the element
 * holding them.
 *
 * The settings screen redraws a card in place when the store changes under it
 * — another device's save arriving through Sync, a refused write put back —
 * and a redraw builds new boxes. Without this the box the person was typing in
 * is gone, and the focus with it. Obsidian's own
 * `update()` has the same cost and worse: it hands the focus to the card's
 * switch (`docs/acceptance-shots/issue-1265-drive.txt` § 4b), which is why the
 * screen never calls it.
 *
 * **The focused element is found again by where it stood, not by identity.**
 * It is named by its row — the nearest `.setting-item`, by the row's name and
 * which of the rows with that name it was — and by which of that row's
 * focusable parts it was. A redraw that adds or removes a row elsewhere in the
 * card, such as a problem appearing above, then still finds the same box. A
 * row that is gone after the redraw leaves the focus where the redraw left it.
 */

/** What can hold the focus inside a settings row: boxes, lists, buttons and Obsidian's switch. */
const FOCUSABLE = "input, textarea, select, button, [tabindex]";

/** Where the focus was inside a root, and the caret if it was in a box. */
export interface FocusMark {
	/** The row the part stood in, or `null` for a part outside every row under the root. */
	readonly row: { readonly name: string | null; readonly ordinal: number } | null;
	readonly partIndex: number;
	readonly caret: { start: number; end: number; direction: "forward" | "backward" | "none" } | null;
}

/** The text a row is known by: its name element's text, or `null` for a part outside any named row. */
function rowNameOf(row: Element | null): string | null {
	return row?.querySelector(".setting-item-name")?.textContent ?? null;
}

/** The rows under `root` (never `root` itself) that carry `name`, in document order. */
function rowsNamed(root: HTMLElement, name: string | null): Element[] {
	return Array.from(root.querySelectorAll(".setting-item")).filter((row) => rowNameOf(row) === name);
}

/**
 * Notes where the focus is, when it is inside `root`, and answers `null` when
 * it is not.
 *
 * Read through the root's own document, since the settings screen is a window
 * of its own (`.claude/skills/drive-test-vault/SKILL.md`), and with no
 * `instanceof`, which does not hold across two windows.
 */
export function noteFocus(root: HTMLElement): FocusMark | null {
	const active = root.ownerDocument.activeElement;
	if (active === null || active === root || !root.contains(active)) return null;
	const nearest = active.parentElement?.closest(".setting-item") ?? null;
	const inRow = nearest !== null && nearest !== root && root.contains(nearest) ? nearest : null;
	const scope: Element = inRow ?? root;
	const partIndex = Array.from(scope.querySelectorAll(FOCUSABLE)).indexOf(active);
	if (partIndex < 0) return null;
	const name = rowNameOf(inRow);
	const row = inRow === null ? null : { name, ordinal: rowsNamed(root, name).indexOf(inRow) };
	return { row, partIndex, caret: caretOf(active) };
}

/** Puts the focus, and the caret where there was one, back on the part `mark` names under `root`. */
export function restoreFocus(root: HTMLElement, mark: FocusMark): void {
	const scope: Element | undefined = mark.row === null ? root : rowsNamed(root, mark.row.name)[mark.row.ordinal];
	const part = scope?.querySelectorAll<HTMLElement>(FOCUSABLE)[mark.partIndex];
	if (part === undefined) return;
	part.focus({ preventScroll: true });
	if (mark.caret === null || !hasCaret(part)) return;
	part.setSelectionRange(mark.caret.start, mark.caret.end, mark.caret.direction);
}

/** A text box or text area, the parts that hold a caret. */
function hasCaret(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
	if (el.tagName === "TEXTAREA") return true;
	if (el.tagName !== "INPUT") return false;
	// The input types the browser keeps a selection for; asking any other
	// for `selectionStart` answers `null`, and setting it throws.
	return ["text", "search", "url", "tel", "password", ""].includes((el as HTMLInputElement).type);
}

function caretOf(el: Element): FocusMark["caret"] {
	if (!hasCaret(el)) return null;
	const { selectionStart, selectionEnd, selectionDirection } = el;
	if (selectionStart === null || selectionEnd === null) return null;
	return { start: selectionStart, end: selectionEnd, direction: selectionDirection ?? "none" };
}
