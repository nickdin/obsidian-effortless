/**
 * Review's list: a view in the right sidebar showing every waiting note, today's
 * included, oldest day first, each row with its date, its name, how many open
 * tasks it holds and how many plain bullets.
 *
 * It shows and never decides: a row click opens the note in the active pane and
 * nothing more. *Mark as processed* is ticket
 * #1056's, so a row has no
 * button yet.
 *
 * **The view keeps no list.** It asks for the waiting notes and the chain
 * each time it draws, both from one {@link ReviewRead}: the feature hands every
 * open list the read its one recompute made ({@link redrawOpenLists}), so the
 * count, the list, the chain and the closed row can never be drawn from
 * different reads.
 * A draw the view starts on its own — opening, a month arrow — asks its
 * {@link ReviewListSource} for a read of its own.
 *
 * **The chain**
 * is drawn in a strip above the list: a month of days, Monday first, one small
 * mark per routine, the two run counts, and arrows to earlier months. The shown
 * month is the view's own state, back to the current month each time the view
 * is opened; the grid is redrawn with the list on every trigger.
 *
 * **The Obsidian routes used**, all in `node_modules/obsidian/obsidian.d.ts`:
 * `ItemView` (`:3590`), `Workspace.getLeavesOfType` (`:8015`) to find the list
 * that is already open so it is revealed and not opened twice,
 * `Workspace.getRightLeaf` (`:7967`) for a new one, and `Workspace.revealLeaf`
 * (`:8029`).
 */

import { ItemView, Notice } from "obsidian";
import type { App, IconName, TFile, Workspace, WorkspaceLeaf } from "obsidian";
import type { Readiness } from "../../core/feature";
import { localDateKey } from "../../core/meetingName";
import { reasonOf } from "../../core/reason";
import type { Chain, ChainMark, ChainMonth } from "./chain";
import type { FollowedGroup, FollowedTask } from "./followedTasks";
import type { WaitingNote, WaitingNotes } from "./waitingNotes";
import type { Routine } from "./words";
import { monthName, reviewWords, weekdayNames } from "./words";

/** The id of the list's view type. Stable for ever: a saved layout names it. */
export const REVIEW_VIEW_TYPE = "effortless-review-list";

/** The ribbon icon and the tab's icon: Obsidian's own set carries it. */
export const REVIEW_LIST_ICON: IconName = "list-checks";

/** The waiting notes as the list draws them, and the notes it had to leave out. */
export interface ReviewList extends WaitingNotes {
	/** The paths of waiting notes whose text could not be read, which the list leaves out and says so. */
	readonly unreadable: readonly string[];
}

/**
 * What the chain reader answers for a month, and whether the diary takes part
 * at all: with a blank diary heading setting the reader marks every diary day
 * *none*, which a month whose logs merely lack the heading also does, so the
 * source says which it is and the grid leaves the diary out only for the first.
 */
export interface ReviewChain extends Chain {
	readonly diaryOn: boolean;
}

/**
 * One read of the vault: the rows and the chain of one draw come
 * from the same object, so the view cannot draw them from two reads.
 */
export interface ReviewRead {
	/**
	 * Whether Review is set up, as the refresh asked once for the whole of it. Absent
	 * on a read that did not ask: the view then asks its source once for the draw.
	 */
	readonly readiness?: Readiness;
	/** Every waiting note, today's included, with what the list shows of each. */
	waiting(): Promise<ReviewList>;
	/** The chain for `month`: what the chain reader answers. */
	chain(month: ChainMonth): Promise<ReviewChain>;
	/**
	 * The followed tasks of the vault, grouped by person and in the reader's
	 * order:
	 * what `followedTasks` answers over the same files as the rows and the chain.
	 */
	followed(): Promise<readonly FollowedGroup[]>;
}

/** What the view asks of the feature: kept as an interface so the view can be tested without one. */
export interface ReviewListSource {
	readiness(): Readiness;
	/** A new read of the vault as it is now, for a draw the view starts on its own. */
	read(): ReviewRead;
	/** Opens the note at `path` in the active pane, with the cursor on `line` (counted from zero) when one is given. */
	open(path: string, line?: number): Promise<void>;
	/** Opens the day's log for `date` in the active pane, creating it first when the day has none; it says so itself when it cannot. */
	openDay(date: Date): Promise<void>;
	/** Writes today's date into the processed field of the note at `path`; it says so itself when it cannot. */
	markProcessed(path: string): Promise<void>;
}

/** "1 open task", "2 open tasks". */
function tasksText(count: number): string {
	return reviewWords().tasks(count);
}

/** "1 plain bullet", "2 plain bullets". */
function bulletsText(count: number): string {
	return reviewWords().bullets(count);
}

/**
 * The words on today's row when today's diary is still empty. The one place
 * they are written, so the chain drawn above the list and a test can
 * name them without a second copy.
 */
export function diaryEmptyText(): string {
	return reviewWords().diaryEmpty;
}

/** The mark a day shows for a routine's state: a check kept, a cross missed, nothing otherwise. */
function markText(mark: ChainMark): string {
	if (mark === "kept") return "\u2713";
	if (mark === "missed") return "\u2717";
	return "";
}

/** The words a mark is read out as: what the cell shows, so a cell with no mark reads as no mark whether the routine is still open or does not apply. */
function markWords(routine: Routine, mark: ChainMark): string {
	return reviewWords().markLabel(routine, mark === "kept" || mark === "missed" ? mark : "none");
}

/**
 * Lets the screen paint, and a key be taken, before the next piece of a draw
 * runs: a
 * macrotask, which a promise that is already resolved is not. A `setTimeout` of
 * zero and not an animation frame, because an animation frame never fires in a
 * tab that is hidden and the list would then not follow the vault there.
 */
function yieldToScreen(): Promise<void> {
	return new Promise((resolve) => {
		window.setTimeout(resolve, 0);
	});
}

/** The chain's month, `monthsBack` whole months before the one that holds `now` (0 is that month). */
function monthBefore(now: Date, monthsBack: number): ChainMonth {
	const first = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
	return { year: first.getFullYear(), month: first.getMonth() + 1 };
}

export class ReviewListView extends ItemView {
	/** Which whole draw ({@link draw}) is the latest; one that finds a newer one started draws no further piece. */
	private latestDraw = 0;

	/** Which list draw is the latest; a draw that finds a newer one started drops its result. */
	private latest = 0;

	/** Which chain draw is the latest, kept apart from the list's so an arrow press redraws the grid alone. */
	private latestChain = 0;

	/** Which followed-tasks draw is the latest, kept apart from the rows' and the chain's. */
	private latestFollowed = 0;

	/**
	 * How many months before the current one the grid shows. The view's own
	 * state: reset to 0 when the view is opened, and counted back from the
	 * current month so a month that turns at midnight leaves a view on "now" on
	 * now. Never below 0: the grid never steps past the current month.
	 */
	private monthsBack = 0;

	/** The strip above the list that holds the chain; made on the first draw, removed on close. */
	private chainEl: HTMLElement | null = null;

	/**
	 * The followed-tasks part, a child at the end of the list's content; made
	 * only while at least one task is followed, so a vault with none holds no
	 * element for it. {@link drawList} leaves it standing while it redraws the
	 * rows above it and puts it last again, so a refresh does not blink it out
	 * for the length of a yield.
	 */
	private followedEl: HTMLElement | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly source: ReviewListSource,
	) {
		super(leaf);
	}

	getViewType(): string {
		return REVIEW_VIEW_TYPE;
	}

	getDisplayText(): string {
		return reviewWords().title;
	}

	override getIcon(): IconName {
		return REVIEW_LIST_ICON;
	}

	override async onOpen(): Promise<void> {
		this.monthsBack = 0;
		await this.draw();
	}

	override async onClose(): Promise<void> {
		// A read still in flight must not draw into a tab that is gone.
		this.latestDraw++;
		this.latest++;
		this.latestChain++;
		this.latestFollowed++;
		this.chainEl?.remove();
		this.chainEl = null;
		this.followedEl = null;
	}

	/**
	 * Draws the rows and the chain from `read`: the feature's own when its
	 * recompute redraws, a new one from the source when the view draws on its
	 * own. Two draws may overlap (a note changes while the text of the last is
	 * still being read): the later one wins, whichever finishes first.
	 *
	 * **The chain, the rows and the followed tasks are three pieces, one after
	 * the other, each behind a yield to the screen** ({@link yieldToScreen}, ticket
	 * #1178): a refresh with
	 * the list open used to read and redraw both in one stretch of about 100 ms
	 * (the 2026-10-14 laptop trace recorded on #1177 and #1178), and the screen
	 * could not paint, or a key be taken, until it ended. A draw
	 * that finds a newer one started when it comes back from a yield draws
	 * nothing, and starts no further piece.
	 *
	 * **The rows wait for the chain's piece to start, never for it to finish**: once
	 * the chain's read is asked for, the rows' piece follows, and the chain is
	 * drawn whenever its read answers. A chain read that is slow, one that
	 * rejects, or a grid that throws while it is drawn leaves the rows drawn as
	 * they would have been. The readiness asked here is not the chain's: all
	 * three pieces draw from it, and one that throws draws none of them. The
	 * draw resolves once all three are drawn.
	 */
	async draw(read: ReviewRead = this.source.read()): Promise<void> {
		const mine = ++this.latestDraw;
		// Asked once for both pieces when the read did not carry the answer.
		const asked: ReviewRead = read.readiness === undefined ? { ...read, readiness: this.source.readiness() } : read;
		const chain = await this.startChain(asked);
		if (mine === this.latestDraw) await this.drawList(asked);
		if (mine === this.latestDraw) await this.drawFollowed(asked);
		await chain.drawn;
	}

	/** The chain's piece whole, for a draw of the chain alone: a month arrow's. */
	private async drawChain(read: ReviewRead): Promise<void> {
		await (await this.startChain(read)).drawn;
	}

	/**
	 * The chain's piece up to its read: the yield to the screen, then the read
	 * asked for. Hands back the rest of the piece as `drawn`, which never
	 * rejects ({@link finishChain}); one that finds a newer chain draw started
	 * after its yield asks for nothing and draws nothing. `drawn` is wrapped in
	 * an object because an async function that returned the promise itself
	 * would be awaited to its end, and the rows would wait for the chain's read
	 * again.
	 */
	private async startChain(read: ReviewRead): Promise<{ readonly drawn: Promise<void> }> {
		const mine = ++this.latestChain;
		await yieldToScreen();
		if (mine !== this.latestChain) return { drawn: Promise.resolve() };
		return { drawn: this.finishChain(read, mine) };
	}

	/**
	 * The chain above the list, for the month the view is showing. The strip is
	 * a sibling above `contentEl` and not a child of it, so the chain is not
	 * among what `contentEl` holds: the list's own messages ("Nothing waiting")
	 * and the followed part, which is a child of it since ticket
	 * #1186.
	 *
	 * A read that rejects and a grid that throws while it is drawn are each said
	 * in the strip as the chain failing, with the reason, and nothing of the
	 * grid is left standing; so is a throwing readiness, asked
	 * here only for a read that did not carry one.
	 */
	private async finishChain(read: ReviewRead, mine: number): Promise<void> {
		const month = monthBefore(new Date(), this.monthsBack);
		let readiness: Readiness | null = null;
		let chain: ReviewChain | null = null;
		let failure: string | null = null;
		try {
			readiness = read.readiness ?? this.source.readiness();
			if (readiness.state === "ready") chain = await read.chain(month);
		} catch (error) {
			failure = reasonOf(error);
		}
		if (mine !== this.latestChain) return;

		if (this.chainEl === null) {
			this.chainEl = this.containerEl.createDiv({ cls: "effortless-review-chain", attr: { "data-review-chain": "" } });
			this.contentEl.before(this.chainEl);
		}
		const el = this.chainEl;
		el.empty();
		if (readiness !== null && readiness.state !== "ready") return;
		if (chain !== null) {
			try {
				this.drawGrid(el, chain, month);
				return;
			} catch (error) {
				failure = reasonOf(error);
				el.empty();
			}
		}
		el.createDiv({ cls: "pane-empty", text: reviewWords().chainFailed(failure ?? reviewWords().unknownReason) });
	}

	/** The run counts, the arrows with the month's name between them, and the month's days. */
	private drawGrid(parent: HTMLElement, chain: ReviewChain, month: ChainMonth): void {
		const words = reviewWords();
		const runs = parent.createDiv({ attr: { "data-review-runs": "" } });
		if (chain.diaryOn) {
			runs.createSpan({ text: words.run("diary", chain.runs.diary), attr: { "data-review-run": "diary" } });
		}
		runs.createSpan({ text: words.run("review", chain.runs.review), attr: { "data-review-run": "review" } });

		const nav = parent.createDiv({ attr: { "data-review-nav": "" } });
		const back = nav.createEl("button", { text: "\u2039", attr: { "data-review-arrow": "back", "aria-label": words.earlierMonth } });
		back.addEventListener("click", () => {
			this.monthsBack += 1;
			void this.drawChain(this.source.read());
		});
		nav.createSpan({
			text: monthName(month.year, month.month),
			attr: { "data-review-month": `${month.year}-${String(month.month).padStart(2, "0")}` },
		});
		const forward = nav.createEl("button", { text: "\u203A", attr: { "data-review-arrow": "forward", "aria-label": words.laterMonth } });
		forward.disabled = this.monthsBack === 0;
		forward.addEventListener("click", () => {
			if (this.monthsBack === 0) return;
			this.monthsBack -= 1;
			void this.drawChain(this.source.read());
		});

		const grid = parent.createDiv({ attr: { "data-review-grid": "" } });
		for (const name of weekdayNames()) grid.createDiv({ text: name, attr: { "data-review-weekday": name } });
		// Monday first: the first of the month sits under its own weekday, the cells before it left blank.
		const blanks = chain.days.length === 0 ? 0 : (chain.days[0].date.getDay() + 6) % 7;
		for (let i = 0; i < blanks; i += 1) grid.createDiv({ attr: { "data-review-blank": "" } });
		for (const day of chain.days) {
			const cell = grid.createDiv({ attr: { "data-review-day": localDateKey(day.date), role: "button", tabindex: "0" } });
			// A click goes to that day's log, created first when it has none. The date is the chain's own, not the attribute's text.
			const openDay = (): void => {
				void this.source.openDay(day.date);
			};
			cell.addEventListener("click", openDay);
			cell.addEventListener("keydown", (evt: KeyboardEvent) => {
				if (evt.key !== "Enter" && evt.key !== " ") return;
				evt.preventDefault();
				openDay();
			});
			cell.createSpan({ text: String(day.date.getDate()), attr: { "data-review-field": "day-number" } });
			// The two marks sit side by side in fixed places, diary left and review right, so a lone mark is still told apart.
			const marks = cell.createDiv({ attr: { "data-review-marks": "" } });
			if (chain.diaryOn) {
				marks.createSpan({
					text: markText(day.diary),
					attr: { "data-review-mark": "diary", "aria-label": markWords("diary", day.diary) },
				});
			}
			marks.createSpan({
				text: markText(day.review),
				attr: { "data-review-mark": "review", "aria-label": markWords("review", day.review) },
			});
		}
	}

	private async drawList(read: ReviewRead): Promise<void> {
		const mine = ++this.latest;
		await yieldToScreen();
		if (mine !== this.latest) return;
		const readiness = read.readiness ?? this.source.readiness();
		let list: ReviewList | null = null;
		let failure: string | null = null;
		if (readiness.state === "ready") {
			try {
				list = await read.waiting();
			} catch (error) {
				failure = reasonOf(error);
			}
		}
		if (mine !== this.latest) return;

		const el = this.contentEl;
		if (readiness.state !== "ready") {
			this.followedEl = null;
			el.empty();
			el.createDiv({ cls: "pane-empty", text: reviewWords().notSetUp(readiness.reason) });
			return;
		}
		// The rows go and are drawn again; the followed-tasks part above stays
		// standing until its own piece redraws it, and is put last again below.
		for (const child of Array.from(el.childNodes)) if (child !== this.followedEl) child.remove();
		if (list === null) {
			el.createDiv({ cls: "pane-empty", text: reviewWords().listFailed(failure ?? reviewWords().unknownReason) });
		} else if (list.list.length === 0 && list.unreadable.length === 0) {
			el.createDiv({ cls: "pane-empty", text: reviewWords().nothingWaiting });
			this.drawTodayDiary(el, list);
		} else {
			for (const note of list.list) this.drawRow(el, note);
			this.drawTodayDiary(el, list);
			if (list.unreadable.length > 0) {
				el.createDiv({
					cls: "pane-empty",
					text: reviewWords().unreadable(list.unreadable.length, list.unreadable.join(", ")),
				});
			}
		}
		if (this.followedEl !== null) el.appendChild(this.followedEl);
	}

	/**
	 * The followed tasks below the waiting notes: a heading with
	 * how many tasks are followed, then each person and the tasks that name them,
	 * in the order the reader gives. **Not drawn at all when none is followed**:
	 * the element is removed and no empty one stands in its place, so a vault
	 * with nothing followed shows the Review it showed before. A task a line
	 * names two people for is one task and counts once, though it stands under
	 * each. The heading's language is read now ({@link reviewWords}). Nothing is
	 * drawn while Review is not set up, the state the rows' own message already
	 * says.
	 */
	private async drawFollowed(read: ReviewRead): Promise<void> {
		const mine = ++this.latestFollowed;
		await yieldToScreen();
		if (mine !== this.latestFollowed) return;
		const readiness = read.readiness ?? this.source.readiness();
		let groups: readonly FollowedGroup[] = [];
		let failure: string | null = null;
		if (readiness.state === "ready") {
			try {
				groups = await read.followed();
			} catch (error) {
				failure = reasonOf(error);
			}
		}
		if (mine !== this.latestFollowed) return;

		const words = reviewWords();
		// `flatMap` is past the ES2018 floor `tsconfig.json` states, so the tasks are collected by loop.
		const distinct = new Set<string>();
		for (const group of groups) for (const task of group.tasks) distinct.add(`${task.path}\n${task.line}`);
		const count = distinct.size;
		if (readiness.state !== "ready" || (failure === null && count === 0)) {
			this.followedEl?.remove();
			this.followedEl = null;
			return;
		}
		const el = (this.followedEl ??= this.contentEl.createDiv({ attr: { "data-review-followed": "" } }));
		el.empty();
		// Last in the content, wherever the rows redraw put it.
		this.contentEl.appendChild(el);
		if (failure !== null) {
			el.createDiv({ cls: "pane-empty", text: words.followedUnreadable(failure) });
			return;
		}
		el.createDiv({ cls: "tree-item-self", text: words.followedHeading(count), attr: { "data-review-followed-heading": "" } });
		for (const group of groups) {
			const person = el.createDiv({ attr: { "data-review-person": group.person } });
			person.createDiv({ cls: "tree-item-inner", text: group.person, attr: { "data-review-field": "person" } });
			for (const task of group.tasks) this.drawFollowedRow(person, task);
		}
	}

	/** One followed task: its words, its follow-up date when it has one, and the note's name; a click opens the note at the line. */
	private drawFollowedRow(parent: HTMLElement, task: FollowedTask): void {
		const row = parent.createDiv({
			cls: "tree-item",
			attr: { "data-review-followed-row": task.path, "data-review-line": String(task.line) },
		});
		const self = row.createDiv({ cls: "tree-item-self is-clickable" });
		self.setAttribute("role", "button");
		self.setAttribute("tabindex", "0");
		self.createDiv({ cls: "tree-item-inner", text: task.words, attr: { "data-review-field": "words" } });
		const flair = self.createDiv({ cls: "tree-item-flair-outer" });
		// The date as the plugin writes dates elsewhere: the row's own `YYYY-MM-DD`.
		if (task.date !== null) flair.createSpan({ cls: "tree-item-flair", text: task.date, attr: { "data-review-field": "date" } });
		flair.createSpan({ cls: "tree-item-flair", text: task.name, attr: { "data-review-field": "name" } });
		const open = (): void => {
			void this.source.open(task.path, task.line);
		};
		self.addEventListener("click", open);
		self.addEventListener("keydown", (evt: KeyboardEvent) => {
			if (evt.key !== "Enter" && evt.key !== " ") return;
			evt.preventDefault();
			open();
		});
	}

	/**
	 * The *diary empty* words for a today that has no row to carry them: its log
	 * is marked processed, so it is not waiting, and the diary is still unwritten. A line of its own after the rows, where today's row would stand,
	 * saying *Today* beside the words; it opens nothing and marks nothing. Drawn
	 * only when no row of today shows the words already, so they never read
	 * twice, and it is never counted.
	 */
	private drawTodayDiary(parent: HTMLElement, list: ReviewList): void {
		if (!list.todayDiaryEmpty) return;
		if (list.list.some((note) => !note.counts && note.diaryEmpty)) return;
		const line = parent.createDiv({ cls: "tree-item", attr: { "data-review-today-diary": "" } });
		const self = line.createDiv({ cls: "tree-item-self" });
		self.createDiv({ cls: "tree-item-inner", text: reviewWords().today, attr: { "data-review-field": "name" } });
		const flair = self.createDiv({ cls: "tree-item-flair-outer" });
		flair.createSpan({ cls: "tree-item-flair", text: diaryEmptyText(), attr: { "data-review-field": "diary" } });
	}

	/**
	 * One row: Obsidian's own file-tree classes, so it follows the theme's hover
	 * and spacing without a stylesheet of ours, and `data-review-*` attributes
	 * for what a test or a drive reads it by. The narrow-sidebar layout (date and
	 * name on one line, the counts beneath, none wrapping into the next) is
	 * `styles.css` rules keyed on those attributes, never inline styles.
	 */
	private drawRow(parent: HTMLElement, note: WaitingNote): void {
		const row = parent.createDiv({ cls: "tree-item", attr: { "data-review-row": note.path } });
		const self = row.createDiv({ cls: "tree-item-self is-clickable" });
		self.setAttribute("role", "button");
		self.setAttribute("tabindex", "0");
		self.createSpan({ cls: "tree-item-flair", text: localDateKey(note.day), attr: { "data-review-field": "date" } });
		self.createDiv({ cls: "tree-item-inner", text: note.name, attr: { "data-review-field": "name" } });
		const flair = self.createDiv({ cls: "tree-item-flair-outer" });
		flair.createSpan({ cls: "tree-item-flair", text: tasksText(note.openTasks), attr: { "data-review-field": "tasks" } });
		flair.createSpan({ cls: "tree-item-flair", text: bulletsText(note.plainBullets), attr: { "data-review-field": "bullets" } });
		// The one nudge, on the day it can still be answered: a past day's empty
		// diary is shown nowhere, so nothing tempts a diary written in hindsight.
		// `counts` is "the day is before today", so `!counts` is today's row.
		if (!note.counts && note.diaryEmpty) {
			flair.createSpan({ cls: "tree-item-flair", text: diaryEmptyText(), attr: { "data-review-field": "diary" } });
		}

		const mark = self.createEl("button", {
			text: reviewWords().markProcessed,
			attr: { "data-review-action": "mark-processed", type: "button" },
		});
		// A press on the button is not a press on the row: it must not open the
		// note, and the key that presses it must not reach the row's own handler.
		// The path is this row's, fixed here, so it is never the active note's.
		mark.addEventListener("click", (evt: MouseEvent) => {
			evt.stopPropagation();
			// Disabled while the press runs, so a second click is not a second press.
			// The list redraws from the store when the write lands or is refused.
			mark.disabled = true;
			void this.source.markProcessed(note.path).finally(() => {
				mark.disabled = false;
			});
		});
		mark.addEventListener("keydown", (evt: KeyboardEvent) => evt.stopPropagation());

		const open = (): void => {
			void this.source.open(note.path);
		};
		self.addEventListener("click", open);
		self.addEventListener("keydown", (evt: KeyboardEvent) => {
			if (evt.key !== "Enter" && evt.key !== " ") return;
			evt.preventDefault();
			open();
		});
	}
}

/**
 * Redraws every open list from `read`, the one read of the vault the feature's
 * recompute made. Called as the last step of that recompute, so a metadata
 * change redraws the count and the list from the same trigger and the same
 * read. A list in a background tab Obsidian has not loaded yet
 * is a deferred view, not ours, and draws itself when it loads.
 */
export function redrawOpenLists(workspace: Workspace, read: ReviewRead): void {
	for (const leaf of workspace.getLeavesOfType(REVIEW_VIEW_TYPE)) {
		if (leaf.view instanceof ReviewListView) void leaf.view.draw(read);
	}
}

/**
 * Brings the list forward, opening it in the right sidebar when none is open.
 * One that is already open is revealed, never a second one made
 * (`getLeavesOfType`, `obsidian.d.ts:8015`).
 */
export async function openList(workspace: Workspace): Promise<void> {
	const existing = workspace.getLeavesOfType(REVIEW_VIEW_TYPE)[0];
	if (existing !== undefined) {
		await workspace.revealLeaf(existing);
		return;
	}
	const leaf = workspace.getRightLeaf(false);
	if (leaf === null) {
		new Notice("Effortless could not open the Review list: Obsidian gave it no place in the right sidebar.");
		return;
	}
	await leaf.setViewState({ type: REVIEW_VIEW_TYPE, active: true });
	await workspace.revealLeaf(leaf);
}

/**
 * Opens the note at `path` in the active pane, through the workspace
 * (`getLeaf(false).openFile`, as `src/features/dayView/openMeeting.ts` opens a
 * note it has resolved to a file). A note deleted since the list was drawn is
 * said so, not opened as a new empty one. With a `line` (counted from zero) the
 * note opens at that line: see {@link openFile}.
 */
export async function openNote(app: App, path: string, line?: number): Promise<void> {
	const file = app.vault.getFileByPath(path);
	if (file === null) {
		new Notice(`Effortless could not open "${path}": the note is gone.`);
		return;
	}
	await openFile(app, file, line);
}

/**
 * Opens `file`, which the caller already holds, in the active pane: the one
 * route every open here takes. A `line` is handed to Obsidian as the open
 * state's `eState.line` (`WorkspaceLeaf.openFile(file, openState?)` is
 * `node_modules/obsidian/obsidian.d.ts:8257`, `OpenViewState.eState` is `:4760`
 * and is typed as an open record), which the markdown view reads as the line to
 * show; that it places the cursor there is read back in
 * `docs/acceptance-shots/issue-1186-followed-drive.txt`. No line is the plain
 * `openFile(file)`.
 */
export async function openFile(app: App, file: TFile, line?: number): Promise<void> {
	const leaf = app.workspace.getLeaf(false);
	if (line === undefined) await leaf.openFile(file);
	else await leaf.openFile(file, { eState: { line } });
}

/**
 * Makes a tab of the list's type that is open without being the list a list.
 *
 * A tab of the type opened while the feature was off — reopened with undo-close-
 * tab, say — is the core's empty stand-in, and nothing rebuilds it when the
 * feature is switched on.
 * So when the feature starts, any such tab is given its view again: set to an
 * empty view first, because setting a view state to the type a leaf already
 * holds may keep the view it has (inferred; no drive in
 * `docs/acceptance-shots/` shows it either way). A deferred tab is left alone:
 * it becomes the list when Obsidian loads it.
 */
export async function adoptStandIns(workspace: Workspace): Promise<void> {
	for (const leaf of workspace.getLeavesOfType(REVIEW_VIEW_TYPE)) {
		if (leaf.view instanceof ReviewListView || leaf.isDeferred) continue;
		const state = leaf.getViewState();
		await leaf.setViewState({ type: "empty" });
		await leaf.setViewState(state);
	}
}
