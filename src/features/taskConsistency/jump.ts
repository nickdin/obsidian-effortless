/**
 * The jump-to-source command: from a log line carrying this feature's own
 * marker, jump to that task's own line in its collection.
 *
 * **Editor-side work, like checkbox cycling's and date entry's, and never
 * through the write queue.** Nothing here calls `host.notes`; a jump reads and
 * moves a cursor, and never writes a byte.
 *
 * **The destination is never cached.** `locatePairedLine` is asked fresh at
 * every activation, over the collection's text *as read at that moment* — the
 * `MeetingReach` rule this repository already states for a block's own reach
 * into the world (`CLAUDE.md` § *The rule the merge exists to enforce*, citing
 * #679 and
 * #686). Nothing in this
 * file keeps a line number, a path or a snapshot from one call to the next.
 *
 * **Not an Obsidian block id**. Nothing here ever writes into either file — a jump moves a cursor and
 * nothing else, so the "not found" cases below say so and change nothing.
 */

import { getLinkpath, MarkdownView, Notice } from "obsidian";
import type { App, EditorPosition, MarkdownPostProcessorContext, WorkspaceLeaf } from "obsidian";
import type { Collections } from "../../core/collections";
import { linksOnLine } from "../../core/linkReading";
import { findMarkedLine, openNoteEditor, placeOnMarkedLine } from "../../core/markedLine";
import type { PlaceResult, PlacingEditor } from "../../core/markedLine";
import { reasonOf } from "../../core/reason";
import type { TaskLine } from "../../core/taskLine";
import { parseTaskLine } from "../../core/taskLine";
import { readMarker } from "./marker";
import { FEATURE_ID } from "./types";

/**
 * The collection's own breadcrumb: an ordinary wikilink appended to the log
 * line's words at copy time, ` [[Name]]`, as the old plugin wrote it — spec
 * #709 decision 8, and
 * #976, which dropped the
 * `→` this feature once wrote before it. Not one of the five fields
 * `reconcilePair` copies and not core knowledge — this feature's own text.
 *
 * **Read as the last wikilink before this feature's own marker comment**,
 * outside every comment, by the core's own reading of a link (`linksOnLine`).
 * The copy appends the link after every word the person wrote and puts the
 * marker after it, so the task's own words may carry wikilinks of their own
 * and the last one before the marker is the one copy-in added. A line an
 * earlier version wrote with the arrow (`… → [[Name]] %% … %%`) has the same
 * link in the same place, so it is read the same way and nothing on it needs
 * rewriting. **A link the person types after the marker is never read**: the
 * daily sync run and the #848 check read the breadcrumb through this too, so
 * taking it would stop that task syncing.
 * An image embed (`![[photo.png]]`) is never the breadcrumb wherever it sits.
 * A line with no marker at all is read up to its end. The one link read from
 * after the marker is one the arrow an earlier version wrote sits directly in
 * front of, and only when no link comes before the marker: the earlier reader
 * took such a link wherever it sat on the line.
 *
 * The description is not a task line, so it is given a checkbox before it is
 * read: that is what lets the core tell a `%% … %%` comment from the words,
 * and a link inside a comment is never the collection. Only the link's path
 * is kept: an optional `#heading` or `|alias` is never part of the
 * collection's name.
 *
 * Null when the line carries none — a marker with no breadcrumb beside it,
 * which cannot come from an ordinary copy (decision 10 always writes both
 * together) but can come from a hand-edited line.
 */
export function collectionLinktextOf(description: string): string | null {
	const line = `- [ ] ${description}`;
	const before = markerStart(line);
	const wikilinks = linksOnLine(line).filter((link) => link.kind === "wikilink" && line[link.start - 1] !== "!");
	const beforeMarker = wikilinks.filter((link) => link.start < before);
	if (beforeMarker.length > 0) return beforeMarker[beforeMarker.length - 1].path;
	// Only when nothing before the marker is a link: the earlier reader took an
	// arrow's link wherever on the line it sat, and a hand-built line with the
	// arrow after the marker is still read that way. A bare link after the
	// marker is the person's own words and is never the breadcrumb.
	const afterArrow = wikilinks.filter((link) => link.start >= before && ARROW_BEFORE.test(line.slice(0, link.start)));
	return afterArrow.length === 0 ? null : afterArrow[afterArrow.length - 1].path;
}

/** The `→` an earlier version wrote in front of the breadcrumb, with whatever space followed it. */
const ARROW_BEFORE = /→\s*$/u;

/** Where this feature's own marker comment starts in `line` (the first one, as `readMarker` reads), or the line's length when it has none. */
function markerStart(line: string): number {
	const prefix = `${FEATURE_ID}:`;
	const own = parseTaskLine(line)?.comments.find((comment) => comment.slice(2, -2).trim().startsWith(prefix));
	return own === undefined ? line.length : line.indexOf(own);
}

/**
 * The line in `collectionText` whose marker carries `eid`, counted from zero —
 * matching every editor position in this codebase, `getCursor`/`setCursor`
 * included. Two lines sharing one eid: the first is the one found, matching
 * `setComment`'s own first-wins rule (ticket #811, and #29's own precedent for
 * a duplicated heading).
 *
 * The finding is the core's (`findMarkedLine`); what makes a marker this
 * feature's own — its eid and a hash that parses — is `readMarker`'s, asked on
 * each line the core offers.
 */
export function locatePairedLine(collectionText: string, eid: string): number | null {
	return findMarkedLine(collectionText, FEATURE_ID, (_inside, line) => readMarker(line)?.eid === eid);
}

/**
 * Whether `line` — the task line the cursor sits on right now — is one a jump
 * can start from: a task line carrying this feature's own marker. The one
 * predicate the command's check callback asks, so the same rule that enables
 * the command in the palette is what a test asks directly.
 */
export function canJumpFrom(line: TaskLine | null): line is TaskLine {
	return line !== null && readMarker(line) !== null;
}

/** What a jump needs of the editor it lands in: read its current text, and move the cursor. */
export type JumpEditor = PlacingEditor;

/** Everything a jump needs from Obsidian, behind one seam so the orchestration below is a pure function of it. */
export interface JumpTarget {
	/** The vault path `linktext` resolves to from `sourcePath`, or null when it names no note. */
	resolveLink(linktext: string, sourcePath: string): string | null;
	/** Whether `path` is a collection right now (`Collections.at`, #29). */
	isCollection(path: string): boolean;
	/** An already-open view of the collection at `path`, or null when none is open anywhere ({@link findOpenCollectionView}). */
	findOpenView(path: string): OpenCollectionView | null;
	/** Reveals and focuses `view`'s leaf and places the cursor on `eid`'s own line there ({@link jumpToOpenView}). */
	openView(view: OpenCollectionView, eid: string, linktext: string): Promise<void>;
	/** Opens the note at `path` fresh and hands back its editor. */
	open(path: string): Promise<JumpEditor>;
	/** One notice, said to the person. */
	notify(message: string): void;
}

/** What placing the cursor found, or that nothing on the page carries the eid any more. */
export type PlaceCursorResult = PlaceResult;

/**
 * Finds the eid's own line in `editor`'s **current** text and puts the cursor
 * there. The one place both the command and the click place a cursor, so
 * there is one rule for what "found" means and one for what "not found" means.
 */
export function placeCursorOn(editor: JumpEditor, eid: string): PlaceCursorResult {
	return placeOnMarkedLine(editor, FEATURE_ID, (_inside, line) => readMarker(line)?.eid === eid);
}

/**
 * What the person is told when no line in the named collection carries the
 * eid any more. Says "pairing" rather than "marker": `GLOSSARY.md`'s own
 * **Symbol** entry retires the bare word from every shown string, and
 * `manifest.test.ts`'s sweep enforces it.
 */
export function notFoundMessage(linktext: string): string {
	return `Effortless: no line in "${linktext}" is still paired with this task. Nothing was changed.`;
}

/**
 * Reads `line`'s own eid and collection, then either reveals the collection's
 * already-open view or opens it fresh, and places the cursor on the line that
 * still carries the eid — the command's own activation. Writes nothing in
 * every branch, including both "not found" cases (spec #709 decision 12,
 * ticket #811 acceptance criteria).
 *
 * **The collection check comes first, whether or not the note is open**: the open-view question ({@link JumpTarget.findOpenView},
 * ticket #938, reusing #905's own `findOpenCollectionView`/`jumpToOpenView`)
 * is asked only once `path` has already answered {@link JumpTarget.isCollection}
 * — a note that has stopped being a collection gets the "not a collection any
 * more" notice below whether or not some leaf still has it open, rather than
 * being revealed as if nothing had changed. One resolution of `linktext` and
 * `path`, not a second one beside this for the open-view question.
 *
 * Called only once {@link canJumpFrom} has already said `line` carries a
 * marker. The re-read below is not a second opinion about that — it is how
 * the eid itself is got hold of, and returning on null is what makes the type
 * narrow rather than a guard against the caller being wrong.
 */
export async function jumpFromLine(target: JumpTarget, sourcePath: string, line: TaskLine): Promise<void> {
	const marker = readMarker(line);
	if (marker === null) return;

	const linktext = collectionLinktextOf(line.description);
	if (linktext === null) {
		target.notify(
			"Effortless: this task names no collection, so there is nowhere to jump to. Nothing was changed.",
		);
		return;
	}

	const path = target.resolveLink(linktext, sourcePath);
	if (path === null || !target.isCollection(path)) {
		target.notify(
			`Effortless: "${linktext}" is not a collection any more, so there is nowhere to jump to. Nothing was changed.`,
		);
		return;
	}

	const openView = target.findOpenView(path);
	if (openView !== null) {
		try {
			await target.openView(openView, marker.eid, linktext);
		} catch (error) {
			target.notify(`Effortless could not open "${linktext}" for this task: ${reasonOf(error)}`);
		}
		return;
	}

	let editor: JumpEditor;
	try {
		editor = await target.open(path);
	} catch (error) {
		target.notify(`Effortless could not open "${linktext}" for this task: ${reasonOf(error)}`);
		return;
	}

	if (placeCursorOn(editor, marker.eid) === "not-found") target.notify(notFoundMessage(linktext));
}

/** The vault path `linktext` resolves to from `sourcePath`, or null when it names no note. */
export function resolveCollectionPath(app: App, linktext: string, sourcePath: string): string | null {
	return app.metadataCache.getFirstLinkpathDest(getLinkpath(linktext), sourcePath)?.path ?? null;
}

/**
 * The real `JumpTarget`: opening a note fresh is the core's (`openNoteEditor`);
 * finding and jumping to an already-open one is this feature's own
 * ({@link findOpenCollectionView}, {@link jumpToOpenView}, ticket #905), reused
 * rather than resolved a second way; this only says which notes are
 * collections and how a breadcrumb resolves.
 */
export function realJumpTarget(app: App, collections: Collections): JumpTarget {
	return {
		resolveLink: (linktext, sourcePath) => resolveCollectionPath(app, linktext, sourcePath),
		isCollection: (path) => collections.at(path) !== null,
		findOpenView: (path) => findOpenCollectionView(app, path),
		openView: (view, eid, linktext) => jumpToOpenView(app, view, eid, linktext),
		open: (path) => openNoteEditor(app, path),
		notify: (message) => new Notice(message),
	};
}

/* -------------------------------------------------------------------------- */
/* The click when the collection is not already open elsewhere: Obsidian's    */
/* own link handling opens the note; this only adds the cursor placement once */
/* it has. (When the collection is already open somewhere, the click is      */
/* intercepted instead — see the section below, ticket #905.)                 */
/* -------------------------------------------------------------------------- */

/** What a click on a collection breadcrumb remembers until the note it names opens. */
export interface PendingJump {
	readonly eid: string;
	readonly linktext: string;
	readonly sourcePath: string;
}

/**
 * How Obsidian 1.13.7 draws a wikilink in each editing mode, read back from
 * the running application (`docs/acceptance-shots/issue-811-jump-to-source.txt`
 * step 3, and `docs/acceptance-shots/issue-824-jump-click.txt`, which also
 * records what a real click's own `target` is):
 *
 * - **Reading view** draws `<a class="internal-link" href="Harbour"
 *   data-href="Harbour">`, an anchor, and a click lands on it.
 * - **Live Preview**, Obsidian's default for editing, draws `<span
 *   class="cm-hmd-internal-link"><span class="cm-underline">Harbour</span></span>`
 *   with no `href` at all, and a click lands on the *inner* span.
 *
 * Both are DOM Obsidian draws rather than an API, so there is no
 * `obsidian.d.ts` line to cite for either; the drive is the citation.
 */
const READING_LINK_SELECTOR = "a.internal-link";
const LIVE_PREVIEW_LINK_SELECTOR = ".cm-hmd-internal-link";

/** A wikilink a click landed on, in the element shape of the mode it was drawn in. */
export interface ClickedLink {
	readonly mode: "reading" | "live-preview";
	/** The element carrying the link itself: the anchor, or the outer span. */
	readonly element: Element;
	/** The name the link shows or points at: `data-href` (else `href`) in reading view, the drawn text in Live Preview. */
	readonly label: string;
}

/**
 * The wikilink `target` is, or sits inside, or null. Reads both modes' own
 * shapes and nothing the code's own selector would invent. Runs on every click
 * in the vault, so it must cost nothing when the click is not on a link.
 */
export function linkClickedOn(target: EventTarget | null): ClickedLink | null {
	// The check is by node type, so it does not depend on which window's realm
	// made the element: an `instanceof HTMLElement` would fail for one from a
	// popout window if that window's class differed from this one. The
	// drive read `true` for `instanceof` on Obsidian 1.13.7
	// (`docs/acceptance-shots/issue-828-popout-click.txt`, step 1), so this is a
	// guard against a realm that differs, not a fix for one seen failing.
	if (target === null || (target as Node).nodeType !== Node.ELEMENT_NODE) return null;
	const element = target as Element;
	const anchor = element.closest(READING_LINK_SELECTOR);
	if (anchor !== null) {
		const label = (anchor.getAttribute("data-href") ?? anchor.getAttribute("href") ?? anchor.textContent ?? "").trim();
		return { mode: "reading", element: anchor, label };
	}
	const span = element.closest(LIVE_PREVIEW_LINK_SELECTOR);
	if (span !== null) return { mode: "live-preview", element: span, label: (span.textContent ?? "").trim() };
	return null;
}

/** A task line and the note it is in — where a click was, once its row is known. */
export interface ClickedRow {
	readonly sourcePath: string;
	readonly line: TaskLine | null;
}

/** What Live Preview's editor answers that Obsidian's `Editor` type does not declare (`node_modules/obsidian/obsidian.d.ts:2403`, no `cm`). */
interface EditorWithView {
	readonly cm?: { posAtDOM(node: Node): number };
}

/** The part of a note's `Editor` a Live Preview click's row is read from. */
export interface LivePreviewEditor {
	getLine(line: number): string;
	offsetToPos(offset: number): EditorPosition;
}

/**
 * The row a Live Preview click landed on, read off the link's own element.
 *
 * **Not the cursor.** Driven: a real click on a link in Live Preview leaves the
 * cursor where it was (`docs/acceptance-shots/issue-824-jump-click.txt`, step
 * 1: the cursor read row 2 at mousedown, mouseup and click on a link on row
 * 5), so the row has to come from the element. Obsidian publishes no route for
 * that — `posAtCoords` and `coordsAtPos` are in no `obsidian.d.ts` line, and
 * `Editor` declares `posToOffset` (`:2566`) and `offsetToPos` (`:2571`) but
 * nothing from a DOM node. What Live Preview's editor does carry is `cm`, its
 * CodeMirror view (unpublished; present in 1.13.7, read back in the drive),
 * and CodeMirror's own `posAtDOM(node)` turns the link into an offset, which
 * the published `offsetToPos` turns into a row. Where `cm` is not there, or it cannot place the link (it throws a
 * `RangeError` for a node outside its content), the row is unknown and the
 * click does nothing: the command still works.
 */
export function livePreviewRowOf(link: Element, editor: LivePreviewEditor, sourcePath: string): ClickedRow | null {
	const cm = (editor as LivePreviewEditor & EditorWithView).cm;
	if (cm === undefined) return null;
	let row: number;
	try {
		row = editor.offsetToPos(cm.posAtDOM(link)).line;
	} catch (error) {
		// `posAtDOM` throws a RangeError for a node outside this editor's own
		// content — an embed's widget, or a click the drive did not cover. A
		// real mouse click on a link in another pane's editor does not reach
		// this: Obsidian has made the clicked pane active by `click`, in the
		// main window and in a popout
		// (`docs/acceptance-shots/issue-872-split-pane-click.txt`, steps 1-3).
		// That is a click that is not this note's row, not a failure of the
		// feature, and a throw here would escape into the document's click
		// listener on every such click. Anything but a RangeError is still let
		// through.
		if (error instanceof RangeError) return null;
		throw error;
	}
	return { sourcePath, line: parseTaskLine(editor.getLine(row)) };
}

/**
 * The row a reading-view click landed on. Reading view draws each section of
 * the note separately, and the `li` a link is in carries `data-line` counted
 * from the section's own first row (driven,
 * `docs/acceptance-shots/issue-824-jump-click.txt` step 2: the first item of a
 * list on rows 2 to 8 reads `data-line="0"`). Obsidian gives that first row
 * only through `MarkdownPostProcessorContext.getSectionInfo`
 * (`node_modules/obsidian/obsidian.d.ts:4023`), whose `text` is the whole note
 * and whose `lineStart` is the section's first row in it (same step), so
 * `sections` holds the context each rendered section was handed, and the
 * row's text is `text`'s line at `lineStart + data-line` — the row the person
 * clicked, whatever the source editor's cursor was left on.
 *
 * Asked at the click, "right before you need it" as `getSectionInfo`'s own
 * comment asks. Null information — which Obsidian may answer "in many
 * circumstances" — means the row is unknown and the click does nothing.
 */
export function readingRowOf(link: Element, sections: WeakMap<Element, MarkdownPostProcessorContext>): ClickedRow | null {
	const item = link.closest("li[data-line]");
	const dataLine = item?.getAttribute("data-line") ?? null;
	if (dataLine === null || !/^\d+$/u.test(dataLine)) return null;
	for (let el = link.parentElement; el !== null; el = el.parentElement) {
		const ctx = sections.get(el);
		if (ctx === undefined) continue;
		const info = ctx.getSectionInfo(el);
		if (info === null) return null;
		const text = info.text.split("\n")[info.lineStart + Number(dataLine)];
		return { sourcePath: ctx.sourcePath, line: text === undefined ? null : parseTaskLine(text) };
	}
	return null;
}

/**
 * What a click on a link labelled `label` should start, given `row` — the task
 * line the click itself was on — or null when it is not one of this feature's
 * own breadcrumbs: not on a paired line, or on a link that is not the collection
 * that line names.
 *
 * **Never opens anything itself.** "If Obsidian's own click already opens the
 * collection, the plugin adds only the cursor placement after the note opens": this only decides whether a `file-open` that follows is one
 * to react to, so it runs on every click on a link and must cost nothing when
 * the click is not one of these.
 */
export function pendingJumpFor(label: string, row: ClickedRow | null): PendingJump | null {
	if (row === null || !canJumpFrom(row.line)) return null;
	const linktext = collectionLinktextOf(row.line.description);
	if (linktext === null || label !== linktext.trim()) return null;
	const marker = readMarker(row.line);
	if (marker === null) return null;
	return { eid: marker.eid, linktext, sourcePath: row.sourcePath };
}

/* -------------------------------------------------------------------------- */
/* The collection already open elsewhere: found and jumped to directly,       */
/* rather than left to Obsidian's own link handling.            */
/* -------------------------------------------------------------------------- */

/**
 * An open view of the collection: just the leaf, since a deferred one has no editor yet to hand back — {@link jumpToOpenView} reads
 * the leaf's view fresh once it has made sure the leaf is loaded.
 */
export interface OpenCollectionView {
	readonly leaf: WorkspaceLeaf;
}

/**
 * Whether `leaf` already holds a view of the note at `path` — loaded, where
 * its view is a `MarkdownView`, or deferred (`WorkspaceLeaf.isDeferred`,
 * `node_modules/obsidian/obsidian.d.ts:8279`), where the file is read off
 * `getViewState()` (`:8267`) instead. A leaf Obsidian has not shown since
 * start-up is deferred: its `view` is not a `MarkdownView` until it loads, so
 * checking only `instanceof MarkdownView` misses it and lets the click fall
 * through to Obsidian's own handling — the #905 defect coming back. `getViewState()` is the one published route to a leaf's file that
 * does not require loading it first.
 */
function leafHoldsPath(leaf: WorkspaceLeaf, path: string): boolean {
	const view = leaf.view;
	if (view instanceof MarkdownView) return view.file?.path === path;
	if (!leaf.isDeferred) return false;
	const state = leaf.getViewState();
	return state.type === "markdown" && state.state?.file === path;
}

/**
 * The already-open view of the note at `path`, across every window, main or
 * popout (`iterateAllLeaves`, `node_modules/obsidian/obsidian.d.ts:8009`), or
 * null when none is open. Looked up fresh at the click — never kept from an
 * earlier lookup, the `MeetingReach` rule this repository states for a
 * block's own reach into the world (`CLAUDE.md` § *The rule the merge exists
 * to enforce*).
 *
 * **More than one open view of the same collection:** the first
 * `iterateAllLeaves` hands back is the one chosen, every time, for a given
 * layout. `iterateAllLeaves`'s own doc comment
 * (`node_modules/obsidian/obsidian.d.ts:8004-8009`) says only that it visits
 * "all leaves, including main area leaves, floating leaves, and sidebar
 * leaves" — it names no order among them, and no drive here has recorded one,
 * so this does not claim the main window comes before a popout's or that
 * leaves come in creation order. What it relies on is only that
 * `iterateAllLeaves` visits leaves in the same order every time for an
 * unchanged layout, so a repeated click always lands in the same pane
 * (the author's decision, 2026-09-25, ticket #905).
 */
export function findOpenCollectionView(app: App, path: string): OpenCollectionView | null {
	let found: OpenCollectionView | null = null;
	app.workspace.iterateAllLeaves((leaf) => {
		if (found !== null) return;
		if (leafHoldsPath(leaf, path)) found = { leaf };
	});
	return found;
}

/**
 * Waits, briefly, for a just-loaded `editor`'s own text to stop being empty.
 * Driven against real Obsidian 1.13.7 (ticket #932,
 * `docs/acceptance-shots/issue-905-jump-focus-readback.txt`): a leaf that was
 * deferred reports `isDeferred: false` and hands back a working `editor` the
 * instant `revealLeaf`/`loadIfDeferred` resolve, but the note's own text
 * lands in that editor a short beat later — about 18ms in the drive. Without
 * this, `placeCursorOn` reads `getValue() === ""` and reports the eid not
 * found, even though the note is not empty and the line is on the page a
 * moment later. Gives up after `timeoutMs`, so a genuinely empty note (or one
 * that never finishes loading) still reaches `placeCursorOn`'s own "not
 * found" — this only waits out the load, it never changes what "not found"
 * means.
 */
async function waitForNoteText(editor: JumpEditor, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (editor.getValue().length === 0 && Date.now() < deadline) {
		await new Promise((resolve) => window.setTimeout(resolve, 20));
	}
}

/**
 * Brings `view`'s leaf forward (`revealLeaf`), loads it if it was deferred
 * (`loadIfDeferred`, `node_modules/obsidian/obsidian.d.ts:8285` — a no-op once
 * loaded or if it never was, ticket #932), makes it the active, focused pane
 * (`setActiveLeaf` with `focus: true`), and places the cursor on `eid`'s own
 * line there, by the same rule {@link placeCursorOn} already states. Touches
 * no other leaf: the pane the click came from, wherever it is, is left
 * exactly as it was.
 *
 * The view is read off `view.leaf` only now, after loading — never kept from
 * {@link findOpenCollectionView}'s own lookup, since a deferred leaf has no
 * `MarkdownView`, and so no editor, until this has run. The extra wait for
 * the note's own text ({@link waitForNoteText}) runs only when this leaf was
 * actually deferred — an already-open view's editor already has its text,
 * and a genuinely empty already-open note must still report "not found" at
 * once, not after a needless pause.
 *
 * **`isDeferred` is read before `revealLeaf`, never after**: `revealLeaf`'s
 * own published contract ("ensure your view has been fully loaded and is not
 * deferred") means it can itself finish the load, so by the time it resolves
 * `isDeferred` may already read `false` for a leaf that was deferred a moment
 * ago — reading it afterward would make the `waitForNoteText` branch below
 * dead code. Driven against real Obsidian 1.13.7: exactly this happened on an
 * earlier version of this function, which read `isDeferred` after
 * `revealLeaf` and never waited, so it read `getValue() === ""` and never
 * placed the cursor (`docs/acceptance-shots/issue-905-jump-focus-readback.txt`).
 */
export async function jumpToOpenView(app: App, view: OpenCollectionView, eid: string, linktext: string): Promise<void> {
	const wasDeferred = view.leaf.isDeferred;
	await app.workspace.revealLeaf(view.leaf);
	if (wasDeferred) await view.leaf.loadIfDeferred();
	app.workspace.setActiveLeaf(view.leaf, { focus: true });
	const markdownView = view.leaf.view;
	if (!(markdownView instanceof MarkdownView)) return;
	if (wasDeferred) await waitForNoteText(markdownView.editor);
	if (placeCursorOn(markdownView.editor, eid) === "not-found") new Notice(notFoundMessage(linktext));
}
