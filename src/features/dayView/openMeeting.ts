/**
 * What happens when a person reaches for a drawn block or bar: on the laptop a
 * click opens the meeting's note and a resting pointer shows the bubble; on a
 * phone a tap shows the bubble and a tap on the bubble opens (spec
 * #618 decisions 10, 11
 * and 12, #628).
 *
 * Carried from `~/Devbox/schema-render/src/renderer.ts:47-189` and `:538-639`.
 * What changed is named in spec #618:
 *
 * - **The creation race is recognised by asking whether the note exists now**,
 *   not by matching Obsidian's English error text, which a translated
 *   Obsidian never says (old issue #25).
 * - **A cell mixing a link with other text names no note**: clicking it
 *   creates nothing, writes nothing, and says why (named difference 11).
 * - **The link is written through the core's note writer**, never the vault,
 *   and only when the row still reads what the block was drawn from (named
 *   difference 10). The writer holds a write to the note the person has open
 *   until they leave it, so a middle-click's link lands when the day's log is
 *   left (named difference 9).
 * - **On a phone a tap shows the bubble first** (named difference 8), asked of
 *   `Platform.isMobile` at the tap, never while this module loads.
 *
 * The decisions are elsewhere and pure: what the bubble says is
 * `bubbleText`, what the write changes is `linkWrite`. What is left here is
 * which event does what, and in what order.
 */

import { getLinkpath, Notice, Platform } from "obsidian";
import type { App, Component, HoverParent, MarkdownSectionInformation, PaneType, TFile } from "obsidian";
import { parseCalendarTableFromBody } from "../../core/calendarTable";
import type { CalendarRow, ColumnNames } from "../../core/calendarTable";
import { filledNoteFor } from "../../core/meetingNoteFill";
import type { NoteWriter } from "../../core/noteWriter";
import { reasonOf } from "../../core/reason";
import { BUBBLE_DELAY_MS, Bubble, bubbleText } from "./bubble";
import type { BubbleMeeting } from "./bubble";
import { blockInsideCallout, linkWrite, locateHeldBlock, restoreLocatedBlock } from "./linkWrite";
import type { DrawnRow, LinkWriteRefusal } from "./linkWrite";
import { readMeetingCell } from "./meetingCell";

/** Where a click opens a note: the same pane, a new tab, or a split. */
export type OpenIn = PaneType | false;

/**
 * Ctrl or Cmd with Shift opens a split, Ctrl or Cmd alone a new tab, and a
 * plain click the same pane. Obsidian's `Keymap.isModEvent` never answers
 * `split`, which is why this is decided here.
 */
export function openIn(evt: MouseEvent): OpenIn {
	const mod = evt.ctrlKey || evt.metaKey;
	if (mod && evt.shiftKey) return "split";
	if (mod) return "tab";
	return false;
}

/**
 * Opens `linktext`, creating it first where Obsidian puts new notes when no
 * note answers to it. Answers whether anything was opened.
 *
 * Looks the note up and creates it by `linkpath` alone — defaulted to
 * `linktext` for a caller with no `#heading` or `^block` part to set aside —
 * so a wikilink's subpath never becomes part of a stray file's name or a
 * failed lookup. When a subpath was set aside this way,
 * `linktext` still differs from `linkpath`, and the open uses `linktext` in
 * full so Obsidian's own `openLinkText` lands on that heading or block. But
 * when nothing was set aside — a plain-text cell, where `linktext` and
 * `linkpath` are the same — a literal `#` in that text is not a subpath:
 * `openLinkText` (`obsidian.d.ts:7914`) would still read it as one and
 * land on a different, shorter-named note than the one just resolved or
 * created here — the declarations say nothing about how the text is split;
 * the drive `docs/acceptance-shots/issue-680-drive.txt` is what shows
 * Obsidian 1.13.7 splitting it at the first `#`. There the resolved `TFile`
 * is opened directly instead, through `Workspace.getLeaf` and
 * `WorkspaceLeaf.openFile` (`obsidian.d.ts:7892`, `:8257`), which needs
 * no such parsing.
 *
 * `beforeOpen` runs once the note is known to exist and before the open,
 * which may replace the pane the block is drawn in: that is the one moment a
 * write may both trust the note is there and still read the block's section
 * information.
 *
 * **A note meeting notes would make for this meeting is created filled in**: where the
 * core's slot (`meetingNoteFill.ts`) answers the click with a path and a text,
 * that note is created at that path with that text, through `create` when the
 * caller hands one (the core's writer, which makes the folders), and opened
 * directly. Where it answers nothing — meeting notes off, the meeting's
 * calendar not set to make notes, no such meeting that day — the note is
 * created empty as before. A note that exists already is opened as it is.
 *
 * A creation that fails says why in a notice and opens nothing. The one
 * failure that is not a failure is the race — the note appeared between the
 * look and the create, from another device's sync, say — and it is recognised
 * by looking again rather than by reading Obsidian's error text.
 */
export async function openOrCreate(
	app: App,
	linktext: string,
	sourcePath: string,
	newLeaf: OpenIn,
	beforeOpen?: () => void,
	linkpath: string = linktext,
	create?: (path: string, text: string) => Promise<TFile>,
): Promise<boolean> {
	const existing = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
	let file: TFile;
	let filled = false;
	if (existing !== null) {
		file = existing;
	} else {
		const note = await filledNoteFor(linkpath, sourcePath);
		filled = note !== null;
		// The slot's path may be a note that already exists under another name —
		// the meeting moved or was retitled since it was first clicked — which is
		// opened as it is, never created beside.
		const named = note !== null ? app.vault.getFileByPath(note.path) : null;
		const parent = app.fileManager.getNewFileParent(sourcePath, linkpath);
		const folder = parent.path === "/" || parent.path === "" ? "" : `${parent.path}/`;
		const path = note !== null ? note.path : `${folder}${linkpath}.md`;
		if (named !== null) {
			file = named;
		} else {
			try {
				file = note !== null ? await (create ?? ((at, text) => app.vault.create(at, text)))(path, note.text) : await app.vault.create(path, "");
			} catch (error) {
				const raced = app.vault.getFileByPath(path);
				if (raced === null) {
					new Notice(`Effortless could not create the note "${path}" for this meeting: ${reasonOf(error)}`);
					return false;
				}
				file = raced;
			}
		}
	}

	beforeOpen?.();
	if (filled || (linktext === linkpath && linktext.includes("#"))) {
		await app.workspace.getLeaf(newLeaf).openFile(file);
		return true;
	}
	await app.workspace.openLinkText(linktext, sourcePath, newLeaf);
	return true;
}

/** Everything a drawn block needs to open its meetings and write their links, handed in by the feature. */
export interface ReachContext {
	readonly app: App;
	/** The core's note writer: the only way the link is written. */
	readonly notes: NoteWriter;
	/** The note the block is drawn in. */
	readonly sourcePath: string;
	/** The block's body as Obsidian handed it to the renderer — what the day was read from. */
	readonly bodyLines: readonly string[];
	/** The column names the day was read with. */
	readonly columns: ColumnNames;
	/**
	 * Obsidian's section information for the drawn block, asked at the click.
	 * Real for a block rendered directly, for one inside a whole-note embed,
	 * and for one inside a heading or block embed: Obsidian 1.13.7 gives all
	 * three real section information, not `null` (driven,
	 * `docs/acceptance-shots/issue-685-drive.txt`, Ticket #685). Only the
	 * first two count from the note's own line 0; a heading or block embed's
	 * own `text` is the embedded slice alone, and its `lineStart`/`lineEnd`
	 * count from that slice's own line 0 instead (same drive, "a heading
	 * embed over two identical blocks") — {@link sectionHint} is what turns
	 * that back into a note-relative line before it reaches
	 * `locateHeldBlock`. `null` for a block genuinely inside a callout or
	 * blockquote — the callout case driven,
	 * `docs/acceptance-shots/issue-657-668-drive.txt`, a
	 * blockquote reasoned the same way but not driven — or, reasoned rather
	 * than driven, for an exported view.
	 */
	readonly sectionInfo: () => MarkdownSectionInformation | null;
	/** The drawn block's own child: when it unloads, the bubble and every listener here go with it. */
	readonly owner: Component;
}

/** A block or bar as drawn: its row in the table, its time or `null` for a bar, and its text. */
export interface ReachedMeeting extends BubbleMeeting {
	readonly rowIndex: number;
}

/** The meeting cell a block was drawn from, read as the click needs it. */
interface Target {
	/** The note it opens, or `null` when it opens nothing — an empty cell. */
	readonly linktext: string | null;
	/** It holds `[[` that is not one whole link, so it names no note. */
	readonly mixed: boolean;
	readonly isLink: boolean;
	readonly rowIndex: number;
	readonly drawn: DrawnRow;
}

/**
 * The text `target` is looked up and created by: the link path alone, with
 * any `#heading` or `^block` part set aside — but only when the cell was
 * written as a wikilink. A `#` sitting inside plain text is not a subpath and
 * stays whole. Call only once `target.linktext` is known not
 * to be `null`.
 */
function linkpathOf(target: Target): string {
	const linktext = target.linktext as string;
	return target.isLink ? getLinkpath(linktext) : linktext;
}

/** What the person is told when a cell mixes a link with other text (named difference 11). */
export const MIXED_LINK_NOTICE =
	"Effortless did not open a note: this meeting cell mixes a link with other text, so it names no note. Nothing was created or written. Make the cell one link, or plain text.";

/**
 * The reach of one drawn `schema` block: wires each block and bar `render.ts`
 * draws, and owns the one bubble they share.
 *
 * Made once per block by the feature and handed to every redraw whose
 * columns have not changed since — a density change, a keystroke that leaves
 * the calendar columns as they were — so those keep the same bubble rather
 * than stacking another. A column that no longer matches, or a block that
 * fell back to its own text, gets a fresh reach from `dayView.ts`'s
 * `renderBlock`, which calls {@link dispose} on the one it is discarding
 * first.
 */
export class MeetingReach {
	private readonly bubble: Bubble;

	/** What a tap on the showing bubble opens: the block it was shown for. */
	private tapTarget: Target | null = null;

	/** The pending hover-delay timer, one per `MeetingReach` — shared across every cell `wire()` reaches on this schema block, so only one can ever be pending for it. */
	private hoverTimer: number | null = null;

	/** The drawn table's rows, read once from the body the day was drawn from. */
	private readonly rows: readonly CalendarRow[];

	/** Hands Page preview a parent for its popover, as Obsidian asks of whatever raises one. */
	private readonly hoverParent: HoverParent = { hoverPopover: null };

	/**
	 * Removes the document click listener currently wired for this reach —
	 * a no-op before {@link followAnchorDocument} has ever run. Reassigned
	 * each time the anchor's document changes, so it always undoes only the
	 * listener that document carries; safe to call more than once.
	 */
	private detachDocumentListener: () => void = () => {};

	/** The document the bubble and its tap-elsewhere listener are anchored to now; `null` before either has ever shown. */
	private doc: Document | null = null;

	constructor(private readonly ctx: ReachContext) {
		this.bubble = new Bubble(ctx.owner, () => this.tapBubble());
		const table = parseCalendarTableFromBody(ctx.bodyLines, ctx.columns);
		this.rows = table.found ? table.table.rows : [];
	}

	/**
	 * Shows `anchor`'s bubble, first asking `anchor`'s current document and
	 * moving both the tap-anywhere-but-the-bubble listener and the bubble
	 * itself there when it differs from wherever they were last shown — the
	 * popout's, when the day's log is drawn there, or the main window's again
	 * once a tab carrying it moves back. Does nothing once the block
	 * has unloaded, so a hover timer that fires late adds no listener with
	 * nothing left to ever take it off.
	 *
	 * Asked at the same moment the bubble itself is mounted, on the anchor
	 * about to be shown, rather than at `wire()` time: a freshly opened
	 * popout's window is not yet the one `HTMLElement.doc` answers with while
	 * the block is still being drawn into it, only once it is actually on
	 * screen — asking early would wire the listener to the wrong document
	 * for a bubble a person may not hover for minutes, if ever, so nothing is
	 * lost by asking exactly when it is first needed instead.
	 */
	private showBubble(anchor: HTMLElement, text: string): void {
		if (this.bubble.disposed) return;
		this.followAnchorDocument(anchor.doc);
		this.bubble.show(anchor, text);
	}

	/**
	 * The one place that decides which document the bubble and its
	 * tap-elsewhere listener both belong to: does nothing once `doc`
	 * is already where they were last moved, and otherwise detaches the
	 * listener from wherever it was, attaches it fresh to `doc` — in the
	 * capture phase, before the tapped element hears it, so a tap on another
	 * block hides this bubble first and that block's own tap then shows its
	 * own — and tells the bubble itself to move there too.
	 */
	private followAnchorDocument(doc: Document): void {
		if (this.doc === doc) return;
		this.detachDocumentListener();
		this.doc = doc;
		const hideOnTapElsewhere = (evt: MouseEvent): void => {
			if (this.bubble.showing && !this.bubble.holds(evt.target)) this.hideBubble();
		};
		doc.addEventListener("click", hideOnTapElsewhere, true);
		this.detachDocumentListener = () => doc.removeEventListener("click", hideOnTapElsewhere, true);
		this.ctx.owner.register(this.detachDocumentListener);
		this.bubble.moveTo(doc);
	}

	/**
	 * Called by `drawDay` before it draws again: a bubble shown for a block
	 * about to be thrown away goes, and so does any hover timer still waiting
	 * to show one — otherwise it fires later against the detached block, whose
	 * zero-size rectangle places the bubble at the window's top-left.
	 */
	redrawing(): void {
		this.clearHoverTimer();
		this.hideBubble();
	}

	/**
	 * Tears this reach down before `dayView.ts` discards it and, if the block
	 * still reads as a day, builds another under the columns now current: runs
	 * {@link redrawing} and also removes the document click listener
	 * {@link followAnchorDocument} added, if it ever ran.
	 *
	 * Without this, a discarded reach's listener would sit on its document
	 * until the block's own child unloads — never, while the block keeps
	 * flipping between a day and its fallback text under the same note —
	 * stacking one more of them on every fresh reach built in its place.
	 */
	dispose(): void {
		this.redrawing();
		this.detachDocumentListener();
	}

	/**
	 * Wires `el`, a drawn block or bar whose text is in `textEl`, to open
	 * `meeting`'s note and to show its bubble. Adds no `aria-label`: Obsidian
	 * draws one as a tooltip of its own, on top of the bubble (old issue #32).
	 */
	wire(el: HTMLElement, textEl: HTMLElement, meeting: ReachedMeeting): void {
		const target = this.targetOf(meeting.rowIndex);
		const opens = target !== null && target.linktext !== null && !target.mixed;
		if (opens) {
			el.addClass("effortless-day-view-block--clickable");
			const resolved = this.ctx.app.metadataCache.getFirstLinkpathDest(linkpathOf(target), this.ctx.sourcePath);
			if (resolved === null) el.addClass("effortless-day-view-block--unresolved");
		}

		const say = (): string | null => bubbleText(meeting, clips(el, textEl));

		// The middle button's autoscroll starts on the mouse going down, so it is
		// stopped there; the open itself comes with `auxclick`.
		el.addEventListener("mousedown", (evt) => {
			if (evt.button === 1) evt.preventDefault();
		});

		el.addEventListener("click", (evt) => {
			evt.preventDefault();
			if (Platform.isMobile) {
				const text = say();
				if (text !== null) {
					this.tapTarget = target;
					this.showBubble(el, text);
					return;
				}
			}
			if (target !== null) this.open(target, openIn(evt));
		});

		el.addEventListener("auxclick", (evt) => {
			if (evt.button !== 1) return;
			evt.preventDefault();
			if (target !== null) this.open(target, "tab");
		});

		// Page preview only with Ctrl or Cmd held, so it never fires on a plain
		// hover whatever Obsidian's own setting says.
		el.addEventListener("mouseover", (evt) => {
			if (!opens || !(evt.ctrlKey || evt.metaKey)) return;
			this.ctx.app.workspace.trigger("hover-link", {
				event: evt,
				source: "effortless",
				hoverParent: this.hoverParent,
				targetEl: el,
				linktext: target?.linktext,
				sourcePath: this.ctx.sourcePath,
			});
		});

		// The bubble on the laptop. A phone has no pointer to rest, and its taps
		// raise these too, so there the tap alone decides.
		el.addEventListener("mouseenter", () => {
			if (Platform.isMobile) return;
			this.hoverTimer = window.setTimeout(() => {
				this.hoverTimer = null;
				const text = say();
				if (text !== null) this.showBubble(el, text);
			}, BUBBLE_DELAY_MS);
		});
		el.addEventListener("mouseleave", () => {
			if (Platform.isMobile) return;
			this.clearHoverTimer();
			this.hideBubble();
		});
	}

	/** Cancels the pending hover-delay timer, if one is waiting. */
	private clearHoverTimer(): void {
		if (this.hoverTimer !== null) window.clearTimeout(this.hoverTimer);
		this.hoverTimer = null;
	}

	/** The meeting cell of data row `rowIndex`, as the day was drawn from it. */
	private targetOf(rowIndex: number): Target | null {
		const row = this.rows[rowIndex];
		if (row === undefined) return null;
		const cell = readMeetingCell(row.event);
		return {
			linktext: cell.linktext,
			mixed: cell.looksLikeLink,
			isLink: cell.isWikilink,
			rowIndex,
			drawn: { time: row.time, meeting: row.event },
		};
	}

	/** A tap on the showing bubble opens the block it was shown for, exactly as a plain click does. */
	private tapBubble(): void {
		const target = this.tapTarget;
		this.hideBubble();
		if (target !== null) this.open(target, false);
	}

	private hideBubble(): void {
		this.tapTarget = null;
		this.bubble.hide();
	}

	/** Opens `target`'s note in `where`, writing its link first when the cell is plain text. */
	private open(target: Target, where: OpenIn): void {
		if (target.mixed) {
			new Notice(MIXED_LINK_NOTICE);
			return;
		}
		if (target.linktext === null) return;
		const { app, sourcePath } = this.ctx;
		openOrCreate(
			app,
			target.linktext,
			sourcePath,
			where,
			() => this.writeLink(target),
			linkpathOf(target),
			(path, text) => this.ctx.notes.create(path, text),
		).catch((error: unknown) => {
			new Notice(`Effortless could not open the note for this meeting: ${reasonOf(error)}`);
		});
	}

	/**
	 * Hands the writer the clicked block's lines to make the cell a link.
	 *
	 * Runs inside `openOrCreate`'s window, before the open, so the section
	 * information is read while the block is still on screen; the write itself
	 * may wait, and re-reads the note when it runs. That position is only a
	 * hint by the time the write runs: a line added or removed above the block
	 * while it waited moves it, so the block is found fresh in the note as it
	 * now reads, by `locateHeldBlock` — which also sets aside a
	 * callout's own leading `>` on every line so `linkWrite` reads the block
	 * exactly as it would outside one, put back by `restoreLocatedBlock` on
	 * write. `target.drawn`'s own row check still refuses a
	 * genuinely changed row, exactly as before.
	 *
	 * Obsidian gives no section information at all for a block nested inside
	 * a callout — a TestVault drive found no section of its own reaches a
	 * schema block there, only the callout's own single section spanning it,
	 * which is what `getSectionInfo` has to match against — so
	 * `section` is `null` there, and, reasoned the same way but not driven,
	 * for an exported view too, the one other case that already meant
	 * nothing may be written. A whole-note, heading or block embed is not
	 * this case: Obsidian 1.13.7 hands all three real section information,
	 * so a plain cell drawn inside any of them is written the ordinary way,
	 * in the embedded note itself (driven,
	 * `docs/acceptance-shots/issue-685-drive.txt`, Ticket #685 — amending
	 * spec #618 decision 12, which assumed "an embed" and "no section
	 * information" always meant the same thing). A heading or block embed's
	 * own section information counts from the embedded slice, not the note
	 * (same drive, "a heading embed over two identical blocks");
	 * {@link sectionHint} turns that back into a note-relative hint before
	 * `locateHeldBlock` sees it, so a byte-identical block under a different
	 * heading is never the one written instead. The callout case and an
	 * exported view are told apart only once the block itself is known:
	 * `locateHeldBlock` still finds it by the lines it was drawn from, never
	 * by a position nothing can give, and only when that block's own line
	 * range lies inside a `callout` or `blockquote` section of the note's
	 * metadata cache is it written. A callout anywhere else in the note is
	 * not enough — an embedded block's own cache is the embedded note's, and
	 * may hold a callout the clicked block never sits in.
	 */
	private writeLink(target: Target): void {
		if (target.isLink) return;
		// A literal `#` in a plain-text cell's own name can never round-trip
		// through a wikilink: `[[Q3 review #2]]` is read as note `Q3 review `
		// with heading `2` (`parseLinktext`, `obsidian.d.ts:4798`), so it can
		// never resolve back to a note literally named `Q3 review #2` —
		// driven in the test vault, `docs/acceptance-shots/issue-680-drive.txt`. The cell stays plain text, which `openOrCreate`
		// already opens correctly by its full name.
		if (target.linktext?.includes("#")) return;
		const section = this.ctx.sectionInfo();
		const file = this.ctx.app.vault.getFileByPath(this.ctx.sourcePath);
		if (file === null) return;
		const calloutSections =
			section === null
				? (this.ctx.app.metadataCache.getCache(this.ctx.sourcePath)?.sections ?? []).filter(
						(s) => s.type === "callout" || s.type === "blockquote",
					)
				: [];
		if (section === null && calloutSections.length === 0) return;

		let refused: LinkWriteRefusal | null = null;
		this.ctx.notes
			.edit(file, (content) => {
				const lines = content.split("\n");
				const block = locateHeldBlock(lines, this.ctx.bodyLines, sectionHint(content, section));
				if (block === null) {
					refused = "table-changed";
					return content;
				}
				if (section === null && !blockInsideCallout(block, calloutSections)) return content;
				const outcome = linkWrite(block.lines, this.ctx.columns, target.rowIndex, target.drawn);
				if ("refused" in outcome) {
					refused = outcome.refused;
					return content;
				}
				const written = restoreLocatedBlock(outcome.lines, block);
				return [...lines.slice(0, block.from), ...written, ...lines.slice(block.to)].join("\n");
			})
			.then(() => {
				if (refused !== null) new Notice(refusalNotice(refused));
			})
			.catch((error: unknown) => {
				new Notice(`Effortless could not make this meeting a link in its table: ${reasonOf(error)}`);
			});
	}
}

/**
 * The note-relative line `section` sits at, for use as `locateHeldBlock`'s
 * tie-break hint over `content`'s own lines.
 *
 * A whole-note embed's and an ordinary block's own `section.text` is the
 * note's whole current text, so `section.lineStart` already counts from its
 * line 0 (driven, `docs/acceptance-shots/issue-685-drive.txt`). A heading or
 * block embed's `section.text` is only the embedded slice, counted from that
 * slice's own line 0 — handing `lineStart` straight to `locateHeldBlock`
 * compares a heading-relative number against note-relative block positions,
 * and can pick the wrong one of two byte-identical blocks (driven, same
 * file, Ticket #685). Found here by where `section.text` itself sits in
 * `content`, which is exact whenever nothing has changed since the click.
 * Falls back to `section.lineStart` unchanged when `section.text` no longer
 * reads inside `content` at all — content moved on while a held write
 * waited — where `locateHeldBlock`'s own line-agreement score,
 * not this hint, is what actually finds the block.
 */
function sectionHint(content: string, section: MarkdownSectionInformation | null): number {
	if (section === null) return 0;
	const at = content.indexOf(section.text);
	if (at === -1) return section.lineStart;
	return content.slice(0, at).split("\n").length - 1 + section.lineStart;
}

/**
 * The notice for a write `linkWrite` refused. Only `already-a-link` is never
 * said: it is the one refusal that means everything is as it should be, and
 * it cannot even reach here, since a linked cell is never handed to the writer.
 */
function refusalNotice(refused: LinkWriteRefusal): string {
	switch (refused) {
		case "table-changed":
			return "Effortless did not make this meeting a link in its table: the table changed since it was drawn. The note was opened as usual.";
		case "mixed-link":
			return MIXED_LINK_NOTICE;
		case "pipe-in-name":
			return "Effortless did not make this meeting a link in its table: its name holds a |, which a link would read as the start of a different name. The note was opened as usual.";
		case "empty":
		case "already-a-link":
			return "Effortless did not make this meeting a link in its table: the cell has nothing to link, or is a link already.";
	}
}

/** Whether `el` clips its text: too wide for its line, or too tall for its block. */
function clips(el: HTMLElement, textEl: HTMLElement): boolean {
	return textEl.scrollWidth > textEl.clientWidth || el.scrollHeight > el.clientHeight;
}
