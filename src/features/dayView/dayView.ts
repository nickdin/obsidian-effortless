/**
 * The day view: every `schema` block in any note, drawn as the day — a band of
 * all-day bars above a grid of timed blocks, overlaps side by side, a now-line
 * on today's log — in reading mode and live preview alike (spec
 * #618 decisions 1, 2, 3,
 * 8 and 9).
 *
 * This file is the Obsidian half and holds no decisions of its own: the table
 * is read by `readDay` through the core, the grid is laid out by `layoutDay`,
 * drawn by `render.ts`, and today's log is `isTodaysLog`'s answer from the
 * core's layout. What is left here is when to draw, what to keep, and what to
 * redraw.
 *
 * **It references no other feature**, and reads the calendar table, the time cell and the vault layout from
 * the core. **Opening a meeting, writing its link and the bubble are
 * `openMeeting.ts`'s**:
 * each drawn block is handed one `MeetingReach`, kept with the drawing so a
 * redraw keeps its bubble. The one other write this file registers is the
 * rename listener in `rename.ts`, which keeps a
 * `schema` block's own links true through a rename Obsidian does not follow
 * into a code block.
 */

import { MarkdownRenderChild, MarkdownRenderer, Notice } from "obsidian";
import type { MarkdownPostProcessorContext, MarkdownSectionInformation } from "obsidian";
import { Feature } from "../../core/feature";
import type { Readiness, SettingsChanged } from "../../core/feature";
import { parseCalendarTableFromBody } from "../../core/calendarTable";
import { reasonOf } from "../../core/reason";
import type { ColumnNames } from "../../core/calendarTable";
import { NOW_LINE_HIDDEN_CLASS, isTodaysLog, placeNowLine } from "./nowLine";
import { MeetingReach } from "./openMeeting";
import { readDay } from "./readDay";
import { createRenameListener } from "./rename";
import { drawDay, drawFallbackReason } from "./render";
import type { DrawnDay, ReadableDay } from "./render";
import {
	DAY_VIEW_SETTING_NAMES,
	DEFAULT_DAY_VIEW_SETTINGS,
	pixelsPerMinute,
	renderDayViewSettings,
	shownDensity,
	storedAsWritten,
	usableDensity,
} from "./settingsPanel";
import type { DayViewSettings } from "./settingsPanel";
import type { Density } from "./types";

/** Stable for ever: it keys this feature's slice of `data.json`. */
export const FEATURE_ID = "day-view";

/** The fenced block's info string the view draws. */
const LANGUAGE = "schema";

/** How often the now-line moves. */
const MINUTE_MS = 60_000;

/**
 * One `schema` block the feature has drawn and Obsidian has not thrown away —
 * read as a day or fallen back to its own text alike. Kept either way so a
 * density change, and a change to the core's calendar columns or daily-log
 * layout, can redraw it without Obsidian reprocessing the block; the minute's
 * tick moves its now-line the same way.
 */
interface Block {
	readonly el: HTMLElement;
	readonly sourcePath: string;
	/** The block's body Obsidian handed the renderer, split once and kept: what a later redraw reads again under the core's current columns. */
	readonly lines: readonly string[];
	/** The same body as one string, for the fallback path's own Markdown render. */
	readonly source: string;
	readonly sectionInfo: () => MarkdownSectionInformation | null;
	/** The block's own child; a fresh `MeetingReach` is handed this so its listeners still go with the block being thrown away. */
	readonly child: MarkdownRenderChild;
	/** What opens its meetings and writes their links; kept across a redraw so it keeps its one bubble. `null` while the block reads as no day at all. */
	reach: MeetingReach | null;
	/** The columns `reach` was built under; `null` exactly when `reach` is. What tells a later redraw whether it may still keep `reach` or has to discard it first. */
	reachColumns: ColumnNames | null;
	/** `null` while the block is drawn as its own text rather than a day. */
	drawn: DrawnDay | null;
}

export class DayView extends Feature {
	readonly id = FEATURE_ID;

	readonly name = "Day view";

	readonly description = "Draws the day's calendar table as a proportional schedule.";
	override readonly settingNames = DAY_VIEW_SETTING_NAMES;

	/**
	 * Taken here and used from `onload` onwards, as the feature contract asks:
	 * the handle finds its feature when it is read, not when it is taken.
	 */
	private readonly own = this.host.settings<DayViewSettings>(DEFAULT_DAY_VIEW_SETTINGS);

	/**
	 * Every `schema` block this feature has drawn and Obsidian has not thrown
	 * away — read as a day or fallen back alike.
	 *
	 * Kept so that the store stays the one truth for what the screen shows: a
	 * changed density, or a changed core column or layout, redraws each of
	 * these from the stored answer at once. A block
	 * leaves this set when Obsidian unloads it — a re-render, the note
	 * closed — and all of them leave when the feature is switched off.
	 */
	private readonly blocks = new Set<Block>();

	/**
	 * Registers the renderer, the redraw on a restored store and the minute's
	 * tick, and says once per load whether the stored density is unusable.
	 *
	 * **The renderer is registered here and never in the constructor**: the core
	 * builds every feature, one that is switched off included, and refuses a
	 * renderer from a constructor. The core keeps one renderer for `schema` for
	 * the session and forwards to the handler registered last while this
	 * feature runs, drawing plainly while it does not; registering from every
	 * `onload` only re-aims it, so switching off and on never stacks a second
	 * (`FeatureHost.registerMarkdownCodeBlockProcessor`,
	 * #622).
	 *
	 * **The notice is `onload`'s alone**, as date entry's is: the stored value
	 * is never rewritten, so it comes back at every start until the person
	 * changes the density on the card, which shows the stored value it names.
	 */
	override onload(): void {
		this.host.registerMarkdownCodeBlockProcessor(LANGUAGE, (source, el, ctx) => this.drawBlock(source, el, ctx));

		// Keeps a schema block's own links true through a rename; detaches with
		// the rest of onload's registrations when the feature is switched off.
		// The listener's own 250 ms batch timer is outside what registerEvent
		// detaches, so its cancel is registered alongside it: a batch
		// still pending when the feature is switched off must not run.
		const renameListener = createRenameListener(this.host);
		this.registerEvent(this.host.app.vault.on("rename", renameListener));
		this.register(() => renameListener.cancel());

		// The store puts memory back after a refused write, which may not be this
		// feature's own; nothing else says the slice changed under it.
		this.register(this.own.onChange(() => this.redrawAll()));

		// The core's own settings — the calendar columns, the daily-log
		// layout — are not this feature's slice, and this feature never writes
		// them, so nothing else says they changed under it either. Optional on
		// `FeatureHost`, so a hand-built host from before this signal existed is
		// still a `FeatureHost` — and simply never redraws for it.
		if (this.host.onCoreChange !== undefined) {
			this.register(this.host.onCoreChange(() => this.redrawAll()));
		}

		// Registered on the feature, so switching the feature off stops it.
		this.registerInterval(window.setInterval(() => this.tick(), MINUTE_MS));

		const stored = this.storedDensity();
		if (usableDensity(stored) === null) {
			new Notice(
				`Effortless: day view cannot use the density ${storedAsWritten(stored)} stored in its settings and draws at ${shownDensity(DEFAULT_DAY_VIEW_SETTINGS.density)} instead. Change it on the Effortless settings screen.`,
			);
		}
	}

	/** Lets go of every block; Obsidian redraws them plainly through the core. */
	override onunload(): void {
		this.blocks.clear();
	}

	/**
	 * Ready whenever the core's two configured column names can name two
	 * columns; not configured when either is blank or the two fold to the same
	 * text — the core's own `column-name-blank` and `column-names-alike`
	 * answers, which it gives before it looks at a single line.
	 *
	 * The daily-log folder and filename are not readiness: with either
	 * unanswered no note is today's log, so no now-line is drawn and the rest of
	 * the view runs. Never `unavailable` — a phone draws the day too — and never
	 * `standby`, since nothing about drawing a note is per device.
	 */
	readiness(): Readiness {
		const checked = parseCalendarTableFromBody([], this.host.core.layout.calendarColumns);
		if (!checked.found && checked.absence === "column-name-blank") {
			return {
				state: "unconfigured",
				reason:
					"One of the two calendar table column names is blank, so no table can be found. Enter both under Calendar table columns on the Your day's logs card.",
			};
		}
		if (!checked.found && checked.absence === "column-names-alike") {
			return {
				state: "unconfigured",
				reason:
					"The two calendar table column names read as the same name, so they cannot tell two columns apart. Give them different names under Calendar table columns on the Your day's logs card.",
			};
		}
		return { state: "ready" };
	}

	override displaySettings(containerEl: HTMLElement, changed: SettingsChanged): void {
		renderDayViewSettings(containerEl, this, changed);
	}

	/** The `density` field exactly as `data.json` holds it, unjudged — what the card shows. */
	storedDensity(): unknown {
		return (this.own.read() as { density?: unknown }).density;
	}

	/** The density the day is drawn at: the stored one when usable, `normal` otherwise. */
	density(): Density {
		return usableDensity(this.storedDensity()) ?? DEFAULT_DAY_VIEW_SETTINGS.density;
	}

	/**
	 * Stores `density` and redraws every day on screen at it, at once.
	 *
	 * The store takes the new slice into memory before it writes the file, so
	 * the redraw here already reads it; if the write is refused and the store
	 * puts memory back, the `onChange` registered in `onload` redraws them back.
	 */
	async saveDensity(density: Density): Promise<void> {
		const saving = this.own.save({ ...this.own.read(), density });
		this.redrawAll();
		await saving;
	}

	/**
	 * What the core's renderer calls with one `schema` block's body.
	 *
	 * Kept either way, read or fallen back, and rendered through
	 * {@link renderBlock}, which every later redraw calls again — so nothing
	 * about what a body reads as is decided here.
	 */
	private drawBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> | void {
		// One child per block, attached to the rendered section, so Obsidian
		// unloading the section is what lets go of the block here.
		const child = new MarkdownRenderChild(el);
		ctx.addChild(child);

		const block: Block = {
			el,
			sourcePath: ctx.sourcePath,
			lines: source.split(/\r?\n/),
			source,
			sectionInfo: () => ctx.getSectionInfo(el),
			child,
			reach: null,
			reachColumns: null,
			drawn: null,
		};
		this.blocks.add(block);
		child.register(() => this.blocks.delete(block));

		return this.renderBlock(block);
	}

	/**
	 * Reads `block`'s own body again under the core's current calendar columns
	 * and draws what that reads now.
	 *
	 * A body with a readable day is drawn and kept; one without is drawn as the
	 * person wrote it, as Markdown, under one sentence giving the reason, and
	 * neither is kept for that call. Either way, a `reach` built under columns
	 * that no longer match is torn down and let go through
	 * {@link releaseReach} first, never kept past the columns it was parsed
	 * under or past the block leaving the day state; one still
	 * good for the columns just read is kept as it was, so an ordinary redraw
	 * — a density change, a keystroke that leaves the columns as they were —
	 * still keeps its one bubble.
	 *
	 * Called once from {@link drawBlock} and again from every redraw, so a
	 * block already on screen picks up a changed column name or daily-log
	 * layout without Obsidian reprocessing it — the fallback notice included,
	 * both ways.
	 */
	private renderBlock(block: Block): Promise<void> | void {
		const columns = this.host.core.layout.calendarColumns;
		const day = readDay(block.lines, columns);

		if ("fallback" in day) {
			this.releaseReach(block);
			block.drawn = null;
			const below = drawFallbackReason(block.el, day.fallback);
			return MarkdownRenderer.render(this.host.app, block.source, below, block.sourcePath, block.child);
		}

		if (block.reach !== null && !sameColumns(block.reachColumns, columns)) {
			this.releaseReach(block);
		}
		if (block.reach === null) {
			block.reach = new MeetingReach({
				app: this.host.app,
				notes: this.host.notes,
				sourcePath: block.sourcePath,
				bodyLines: block.lines,
				columns,
				sectionInfo: block.sectionInfo,
				owner: block.child,
			});
			block.reachColumns = columns;
		}
		block.drawn = this.draw(block.el, day, block.sourcePath, block.reach);
	}

	/**
	 * Tears down `block`'s `reach`, if it has one, and lets go of it: the
	 * timer and bubble it may be holding, and the document click listener
	 * added at its first show, all through `MeetingReach.dispose` — never
	 * left for the block's own child to release, which only happens when
	 * Obsidian throws the whole block away.
	 */
	private releaseReach(block: Block): void {
		block.reach?.dispose();
		block.reach = null;
		block.reachColumns = null;
	}

	/** Draws `day` into `el` at the stored density, with a now-line when this is today's log, its meetings opened through `reach`. */
	private draw(el: HTMLElement, day: ReadableDay, sourcePath: string, reach: MeetingReach): DrawnDay {
		const now = new Date();
		return drawDay(el, day, {
			pxPerMinute: pixelsPerMinute(this.density()),
			today: isTodaysLog(sourcePath, this.host.core.layout, now),
			now,
			reach,
		});
	}

	/**
	 * Redraws every block still on screen, from its own body, under the store's
	 * current answer. The first draw hands a fallback's Markdown render back to
	 * Obsidian; a redraw has nobody to hand it to, so a render that fails here
	 * says so itself rather than being dropped.
	 */
	private redrawAll(): void {
		for (const block of this.blocks) {
			this.renderBlock(block)?.catch((error: unknown) => {
				new Notice(
					`Effortless could not show a day in ${block.sourcePath} as written. Close and reopen the note. ${reasonOf(error)}`,
				);
			});
		}
	}

	/**
	 * Moves every now-line to the current minute, re-checking on every tick
	 * whether the note it is on is still today's log: `isTodaysLog` was
	 * answered once, when the block was drawn, and Obsidian stays open
	 * overnight, so a note drawn as today's log stops being one at midnight
	 * while its block is still on screen. Once that happens the line is hidden
	 * for good — it never becomes today's log again — rather than left to the
	 * span check, which would otherwise show it again at the next moment the
	 * clock falls inside the grid.
	 */
	private tick(): void {
		const now = new Date();
		for (const block of this.blocks) {
			const { drawn } = block;
			// `null` while the block reads as no day at all — its own text has no
			// now-line to move.
			if (drawn === null || drawn.nowLine === null) continue;
			if (!isTodaysLog(block.sourcePath, this.host.core.layout, now)) {
				drawn.nowLine.toggleClass(NOW_LINE_HIDDEN_CLASS, true);
				continue;
			}
			placeNowLine(drawn.nowLine, drawn.span, drawn.pxPerMinute, now);
		}
	}
}

/** Whether a kept `reach`'s own columns, `built`, still read as `current` — `built` is `null` exactly when there is no `reach` to ask. */
function sameColumns(built: ColumnNames | null, current: ColumnNames): boolean {
	return built !== null && built.time === current.time && built.event === current.event;
}
