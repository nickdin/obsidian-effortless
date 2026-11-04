/**
 * The settings screen: a pinned card for the core's own settings, a count line,
 * then one collapsed card per feature.
 *
 * Each feature's card is closed by default and carries, on its closed row, the
 * one line that says what the feature is doing right now — what it does when it
 * is running, what is missing when it is not configured, why it stopped when it
 * failed. That is the point of the shape: with a dozen features installed, a
 * problem is visible without opening anything.
 */

import { Notice, PluginSettingTab, Setting } from "obsidian";
import type { App, Plugin, SettingDefinitionItem } from "obsidian";
import { NOT_STARTED } from "./registry";
import type { FeatureRegistry, FeatureState, FeatureStatus } from "./registry";
import { CALENDAR_SOURCES_SETTING_NAMES, renderCalendarSources } from "./calendarSourcesSection";
import type { CoreParts } from "./coreParts";
import type { Collections } from "./collections";
import { COLLECTIONS_SETTING_NAMES, renderCollections } from "./collectionsSection";
import { noteFocus, restoreFocus } from "./focusKeeper";
import type { Problems } from "./problems";
import { PROBLEMS_SETTING_NAMES, renderProblems } from "./problemsSection";
import { reasonOf } from "./reason";
import { announceFailedSave, createSaveFailureAnnouncer } from "./saveFailureAnnouncer";
import { asVaultPath, dailyLogPathPattern, fieldNameRefusal, storedFieldName, unreadableFilenamePattern } from "./vaultLayout";
import type { DeviceStore } from "./settings";
import type { HeadingSetting, SettingsStore, VaultLayout } from "./settings";

/**
 * One badge per row, and never two. `standby` and `notStarted` deliberately wear
 * the same badge as `off`: #26 weighed a
 * sixth badge and rejected it, because the screen has to stay readable at
 * fifteen features. The row's sentence is what carries the difference.
 */
function badgeClass(status: FeatureStatus): string {
	return `effortless-badge effortless-badge-${status.state}`;
}

function runningCount(statuses: readonly FeatureStatus[]): string {
	return `${statuses.filter((s) => s.state === "running").length} of ${statuses.length} features running`;
}

/** The core card's name, on its closed row and as its row's name in Obsidian's search. */
const CORE_CARD_NAME = "Your day's logs";

/**
 * The fixed names of every row the core card's body draws, its sections'
 * included, for the settings search, in the order
 * `renderCoreBody` draws them. `settingsSearchAliases.test.ts` holds the list
 * to what the body draws.
 */
const CORE_SETTING_NAMES: readonly string[] = [
	"Folder",
	"Filename",
	"Day's-log template",
	"Notes heading",
	"Calendar heading",
	"Today heading",
	"Overdue heading",
	"Diary heading",
	"Tasks heading",
	"Completed tasks heading",
	"Processed field",
	"Day link field",
	"Diary date field",
	"Calendar table columns",
	"Excluded folders",
	...CALENDAR_SOURCES_SETTING_NAMES,
	"Build the days on this device",
	...PROBLEMS_SETTING_NAMES,
	...COLLECTIONS_SETTING_NAMES,
];

/**
 * Each row's key: the core card, the count line, or a feature's card by its id.
 * What a redraw names, and what {@link EffortlessSettingTab.rows} is keyed by.
 */
const CORE_ROW = "core";
const COUNT_ROW = "count";
function featureRow(id: string): string {
	return `feature:${id}`;
}

/** Each name once, in the order first given: a search term repeated finds nothing more. */
function distinct(names: readonly string[]): string[] {
	return [...new Set(names)];
}

const BADGE_LABEL: Record<FeatureState, string> = {
	running: "Running",
	unconfigured: "Not configured",
	off: "Off",
	standby: "Off",
	unavailable: "Not available here",
	failed: "Failed",
	notStarted: "Off",
};

/**
 * The attribute a control puts on itself to say *while I hold it, leave me
 * out of a redraw the store's own restore asks for*.
 *
 * A box that writes to the store on every keystroke needs none of this:
 * `settings.ts` already holds a run of typing's write until it lands or is
 * refused, and puts nothing back while one waits, so this screen is never
 * even told (`stopWatchingStore` below, #558). This is for the other shape —
 * a control that keeps what was typed only in the DOM until a press, so the
 * store has no write of its own to hold back and nothing to warn this screen
 * with. {@link protectWhileFocused} puts it on the control's region for as
 * long as focus is anywhere inside, and takes it off the moment focus leaves,
 * so the mark never outlives the moment it protects.
 * `checkboxCycling/settingsPanel.ts`'s "Add a symbol" row is the first to use
 * it.
 */
export const PROTECT_WHILE_FOCUSED_ATTR = "data-effortless-protect-while-focused";

/**
 * Carries {@link PROTECT_WHILE_FOCUSED_ATTR} on `region` for as long as focus
 * is anywhere inside it.
 *
 * **The region, not the element that takes the focus**, because a control can
 * have more than one focusable part, and moving between them is not leaving.
 * The "Add a symbol" box is committed only by the Add button beside it; a mark
 * on the box alone came off on the way to that button, and the redraw it had
 * held off rebuilt the screen under the press meant to use what it kept.
 *
 * Heard in the capture phase, because `focus` and `blur` do not bubble and a
 * capturing listener on an ancestor still hears them. Focus that goes to
 * nothing — a press on something that takes no focus — counts as leaving.
 */
export function protectWhileFocused(region: HTMLElement): void {
	region.addEventListener(
		"focus",
		() => {
			region.setAttribute(PROTECT_WHILE_FOCUSED_ATTR, "");
		},
		true,
	);
	region.addEventListener(
		"blur",
		(event) => {
			// A focus event's `relatedTarget` is the element focus moves to, or
			// `null` when it moves to none.
			if (region.contains(event.relatedTarget as Node | null)) return;
			region.removeAttribute(PROTECT_WHILE_FOCUSED_ATTR);
		},
		true,
	);
}

export class EffortlessSettingTab extends PluginSettingTab {
	/** Which feature cards the user has opened. Not stored: it resets each visit. */
	private readonly opened = new Set<string>();
	/**
	 * Whether the person has opened or closed the core card themselves, and
	 * `null` while they have not touched it. Not stored either way: it resets
	 * each visit, like the feature cards above.
	 *
	 * The default is worked out at every draw rather than fixed at `false`,
	 * because a standing problem is drawn inside this card and a card
	 * that started closed would hide the one line that cannot wait — the
	 * `Notice` has already faded by the time anyone opens the settings screen.
	 * Working a default out from what is standing right now stores nothing, so
	 * § 11's "which cards are open is not stored" still holds.
	 */
	private coreOpen: boolean | null = null;

	/**
	 * Drops the standing-problems listener, and `null` while there is none.
	 *
	 * The screen is the only thing that says a problem is standing — there is
	 * no "it is well again" notice — so it has to follow the problems rather
	 * than sample them once.
	 */
	private stopWatchingProblems: (() => void) | null = null;

	/**
	 * Drops the settings store's listener, and `null` while there is none.
	 *
	 * The store puts its memory back to what `data.json` holds when a write is
	 * refused with nothing else to carry the change, and the refused write need
	 * not be the one this screen last drew after. A box whose run of typing was
	 * refused went on showing what was typed, so a save from a control beside it
	 * rebuilt its payload from the restored store and carried the stored value
	 * back into the file while the box showed another; a press refused while a
	 * typed change waited was drawn, then undone in memory by the timer's own
	 * refusal, with nothing drawing again. So the screen
	 * follows the store the way it follows the problems, and is dropped the same
	 * way, in the same two places.
	 */
	private stopWatchingStore: (() => void) | null = null;

	/**
	 * Drops the listener on features' live lines, and `null` while there is none.
	 * A feature whose closed row carries a live line says when it changes, and the
	 * open screen follows it, so a row never shows a line that is already over. Dropped in
	 * the same two places as {@link stopWatchingStore}.
	 */
	private stopWatchingLines: (() => void) | null = null;

	/**
	 * The line element of each feature's closed row, as the last draw made them,
	 * by feature id. What {@link redrawLines} writes into: the row's text is set
	 * in place and the screen is not rebuilt, because a feature can announce a
	 * change while the person is typing in a box on the same screen (Review's
	 * window box redraws its count on every keystroke), and a rebuild would
	 * replace that box under their hands. Replaced when the card is drawn
	 * again, and emptied by `hide()`.
	 */
	private readonly lineEls = new Map<string, HTMLElement>();

	/**
	 * The badge of each feature's closed row, and the "N of M features running"
	 * count, as the last draw made them. {@link redrawLines} rewrites both with
	 * the line, because a row's line and its badge come from one state. Cleared
	 * wherever {@link lineEls} is.
	 */
	private readonly badgeEls = new Map<string, HTMLElement>();
	private countEl: HTMLElement | null = null;

	/**
	 * Calls off the redraw a restore asked for while a
	 * {@link PROTECT_WHILE_FOCUSED_ATTR} region held it off — `null` while none
	 * is owed. See {@link redrawAfterRestore}.
	 *
	 * Called in `hide()`, the same as {@link stopWatchingProblems} and
	 * {@link stopWatchingStore} above: a screen that draws nothing once closed
	 * must not have a blur reach back into it later and draw anyway.
	 *
	 * And called whenever the region it waits on is drawn again, because left
	 * in place it went on pointing at a region that draw had taken off the
	 * screen, and every later restore while the new region held focus found a
	 * redraw already owed, added none, and was never drawn. Obsidian
	 * drawing every row is the redraw it was owed, so there it is only called
	 * off; one card redrawn by this screen pays it there and then, by redrawing
	 * every row ({@link redrawRow}). Chromium fires `blur` on a focused element
	 * a draw removes, which would reach the old listener; the draw calls it off
	 * before it empties the row, so nothing here counts on that blur either way.
	 */
	private callOffOwedRedraw: (() => void) | null = null;

	/** The region the owed redraw waits on, while one is owed; see {@link callOffOwedRedraw}. */
	private owedRegion: HTMLElement | null = null;

	/**
	 * The element each row draws into, by row key, while the row is on the
	 * screen. Obsidian makes the element and hands it to the row's `render`
	 * ({@link getSettingDefinitions}); this screen draws the card into it and
	 * draws it again there, in place, when the card has to change. Emptied by
	 * `hide()`, so nothing draws into a screen that is closed.
	 */
	private readonly rows = new Map<string, HTMLElement>();

	/**
	 * Says a failed deferred write out loud, once for the run.
	 *
	 * A run of keystrokes is one write, and `saveCoreSoon` answers every
	 * keystroke in that run with the same promise. So one failed write used to
	 * arrive in one `catch` block per keystroke and raise one `Notice` each —
	 * seven toasts for typing `Journal` into a read-only vault.
	 *
	 * **One announcer for the whole screen, not one per section.** The calendar
	 * rows write through the same store and join the same run, so a second flag
	 * behind that module boundary brought the double announcement back for a run
	 * of typing that crossed the two. This one is
	 * handed to `renderCalendarSources`, and lives as long as this tab does.
	 * It is handed to every feature's panel too, beside `changed`: the Checkbox
	 * cycling card's name box has deferred its write since #538, and while that
	 * panel held an announcer of its own a run of typing that crossed it and a
	 * core box was told twice — the #254 shape across the feature boundary.
	 *
	 * The store learns nothing about any of this — announcing is this screen's
	 * job alone.
	 */
	private readonly announceDeferredSaveFailure = createSaveFailureAnnouncer();

	/**
	 * The core card's closed row while it is on the screen, and `null` before
	 * the first draw.
	 *
	 * Held because the row has to follow the Folder and Filename boxes as they
	 * are typed into, and the only other way to bring it up to date is a full
	 * redraw — which rebuilds the card's DOM and takes the focus and the caret
	 * out of the box the person is typing in. Replaced on
	 * every draw, so it always names the row now on the screen.
	 */
	private coreLineEl: HTMLElement | null = null;

	/**
	 * The Filename row's description element: the host the unreadable-pattern
	 * line is written into. `null` while the card is shut, since the row is
	 * drawn only inside the open body.
	 *
	 * The refresh writes into this one and never removes it — it is set when the
	 * open body is drawn and stands until the card is shut again.
	 */
	private filenameDescEl: HTMLElement | null = null;

	/**
	 * The unreadable-pattern line itself while there is one, and `null` when
	 * there is not — including while the card is shut, since the row is drawn
	 * only inside the open body.
	 *
	 * The refresh removes this one and makes it again rather than writing into
	 * it, because its absence is half of what it says. Held for the same reason
	 * as {@link coreLineEl}: the line has to follow the Filename box as it is
	 * typed into, and #194's own criterion is that it goes *as soon as the
	 * pattern is whole*.
	 */
	private unreadableLineEl: HTMLElement | null = null;

	/**
	 * The rows being drawn right now, so that a second draw of the same row
	 * started from inside the first does nothing.
	 *
	 * The screen runs feature-supplied code while it draws — every open
	 * feature card is drawn by the feature itself — and a feature that reports
	 * a standing problem from there provokes the announcement this screen
	 * listens to, which draws again. A nested draw of the same element empties
	 * it and rebuilds it, and the outer one then goes on appending to it:
	 * duplicated rows, and a card disagreeing with what is stored. Since each
	 * card has a row of its own, a draw of
	 * another row from inside one is safe and goes ahead: the problem a feature
	 * reports while its card draws reaches the core card at once.
	 *
	 * The guard is here, on the draw, rather than only on the announcement.
	 * `Problems.announce` refuses to re-enter itself, which covers a draw the
	 * announcement started and nothing else — and most draws are started by a
	 * card click, where that flag is off
	 * (#199 is the half
	 * this completes). Both guards stay: they refuse different loops.
	 *
	 * Dropping the nested draw rather than queueing it, because a queued redraw
	 * is what #199 ruled out — a feature reporting a varying message would queue
	 * the next one for ever. What the person loses, when a row asks for itself
	 * while it draws, is that row arriving one change late; `problems.ts` says
	 * so beside its own guard.
	 */
	private readonly drawingRows = new Set<string>();

	/**
	 * Whether this visit to the screen has drawn yet. Cleared by `hide()`, set
	 * by the first row Obsidian draws: the difference between a first draw,
	 * which starts at the top, and every later one, which keeps the container's
	 * scroll position.
	 */
	private drawnThisVisit = false;

	private readonly settings: SettingsStore;
	private readonly registry: FeatureRegistry;
	private readonly device: DeviceStore;
	private readonly collections: Collections;
	private readonly problems: Problems;

	/**
	 * `app` and `plugin` positionally, because `PluginSettingTab`'s own
	 * `super(app, plugin)` wants them and the compiler catches a transposition
	 * of two different types. Everything else arrives as a `CoreParts`, so
	 * nobody adds a parameter here and fills it in at one call site only.
	 *
	 * **That bundle names the invariant and does not hold it**, and this comment
	 * said the opposite until #539.
	 * `CoreParts` ties its `registry` field to nothing beside it, so a tab can be
	 * handed a bundle whose registry was built from entirely different instances
	 * and it compiles — `openTab` in `settingsTab.test.ts` is that object
	 * deliberately. `main.ts` is where the rule is actually kept, and
	 * `main.test.ts`'s *"builds one collections index, not one for the screen and
	 * one for the features"* is what checks it. `coreParts.ts` holds the reasoning
	 * and why a branded type was refused.
	 */
	constructor(app: App, plugin: Plugin, parts: CoreParts) {
		super(app, plugin);
		this.settings = parts.settings;
		this.registry = parts.registry;
		this.device = parts.device;
		this.collections = parts.collections;
		this.problems = parts.problems;
		// `hide()` is the ordinary way the listener goes, and it is not
		// guaranteed: a destroyed host window never calls it, and the listener
		// then holds this tab and, through it, the whole settings screen.
		//
		// Here, once, and deliberately not where the listeners are added. This
		// tab's lifetime is the plugin's — it is built in `onload` and handed to
		// `addSettingTab` — and `Component.register` callbacks accumulate until
		// unload and are never dropped one at a time. Registering on every
		// visit would add a closure per visit: a new leak to fix a leak.
		//
		// `?.` because the ordinary path is exactly the one where `hide()` has
		// already run and set the field to `null`.
		plugin.register(() => {
			this.stopWatchingProblems?.();
			this.stopWatchingProblems = null;
			this.stopWatchingStore?.();
			this.stopWatchingStore = null;
			this.stopWatchingLines?.();
			this.stopWatchingLines = null;
			this.lineEls.clear();
			this.badgeEls.clear();
			this.countEl = null;
			this.rows.clear();
		});
	}

	/**
	 * The screen as Obsidian 1.13 draws it: one row per card — the core card,
	 * the "N of M features running" line, then each feature — each drawn by
	 * its own `render`.
	 *
	 * **Why rows rather than drawing the tab by hand:** Obsidian's settings
	 * search reads a tab's definitions and nothing it draws, so a tab drawn by
	 * hand held no entry at all and a search for "Date entry" answered "No
	 * settings found." (`docs/acceptance-shots/issue-1265-drive.txt` § 0, § 2).
	 * A row is found by its name and its `aliases`, which are the fixed names
	 * of every setting inside its card, so a search finds a closed card by
	 * anything in it and a click on the hit opens this tab at that card, closed.
	 *
	 * **The rows are drawn by this screen, in place.** Obsidian calls every
	 * row's `render` when the tab opens and on a search hit, each time on the
	 * same row element (§ 3); the screen keeps that element ({@link rows}) and
	 * redraws one card in it when that card has to change
	 * ({@link redrawRow}). `update()` is never called: it draws every row
	 * again and hands the focus to a card's own switch, so a half-typed box
	 * lost it (§ 4b).
	 *
	 * The standing problems stay inside the core card, where spec
	 * #32 § 10 put them, and
	 * open it by default; the count line gets a row of its own, not searchable,
	 * because it holds no setting.
	 */
	override getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: CORE_CARD_NAME,
				aliases: distinct(CORE_SETTING_NAMES),
				render: (setting) => this.renderRow(CORE_ROW, setting.settingEl),
			},
			{
				name: "Features running",
				searchable: false,
				render: (setting) => this.renderRow(COUNT_ROW, setting.settingEl),
			},
			...this.registry.statuses().map((status) => ({
				name: status.name,
				aliases: distinct(status.settingNames ?? []),
				render: (setting: Setting) => this.renderRow(featureRow(status.id), setting.settingEl),
			})),
		];
	}

	/**
	 * What a row's `render` does: keeps the element Obsidian made for it, and
	 * draws the row's card into it. Answers the cleanup Obsidian calls before
	 * the row is drawn again or taken away, which forgets the element.
	 */
	private renderRow(key: string, rowEl: HTMLElement): () => void {
		this.beginVisit();
		// Obsidian drawing this row is the redraw a restore owed it.
		if (this.holdsOwedRegion(rowEl)) this.callOffTheOwedRedraw();
		this.rows.set(key, rowEl);
		this.drawRow(key, rowEl);
		return () => {
			if (this.rows.get(key) === rowEl) this.rows.delete(key);
		};
	}

	/**
	 * Draws one row again, in place, when its card has to change: a card
	 * opened or closed, its switch pressed. Nothing else on the screen is
	 * touched, so the scroll position stays where it is and a box
	 * in another card keeps what it holds.
	 *
	 * Does nothing for a row not on the screen — before the first draw, or
	 * once the screen has closed.
	 */
	private redrawRow(key: string): void {
		const rowEl = this.rows.get(key);
		if (rowEl === undefined) return;
		// The row holds the region a restore's redraw is waiting on, and is
		// about to replace it: pay that redraw now, which draws this row too,
		// rather than leave it waiting on a region gone from the screen.
		if (this.holdsOwedRegion(rowEl)) {
			this.callOffTheOwedRedraw();
			this.recheckAndRedraw(() => undefined);
			return;
		}
		this.drawRow(key, rowEl);
	}

	/**
	 * Draws every row again, in place: what a change to what is stored needs,
	 * since it may be anything any card shows. Each row keeps its element, so
	 * the scroll position stays, and each keeps the focus and caret of
	 * a box in it (`drawRow`).
	 */
	private redrawEveryRow(): void {
		// This is the redraw a restore owed, whatever region it waited on.
		this.callOffTheOwedRedraw();
		for (const [key, rowEl] of [...this.rows]) this.drawRow(key, rowEl);
	}

	/**
	 * Empties one row and draws its card again, keeping the focus and the caret
	 * where they were when they were inside it ({@link noteFocus}). Refused for
	 * a row already being drawn (#225, {@link drawingRows}).
	 */
	private drawRow(key: string, rowEl: HTMLElement): void {
		if (this.drawingRows.has(key)) return;
		this.drawingRows.add(key);
		try {
			const focus = noteFocus(rowEl);
			rowEl.empty();
			if (key === CORE_ROW) this.renderCoreCard(rowEl);
			else if (key === COUNT_ROW) this.renderCount(rowEl);
			else this.renderFeatureCard(rowEl, this.statusOf(key));
			if (focus !== null) restoreFocus(rowEl, focus);
		} finally {
			// A card that throws while it draws must not leave its row unable to
			// redraw for the rest of the session.
			this.drawingRows.delete(key);
		}
	}

	/** The status of the feature a row key names. Throws for a feature the registry no longer has. */
	private statusOf(key: string): FeatureStatus {
		const status = this.registry.statuses().find((candidate) => featureRow(candidate.id) === key);
		if (status === undefined) throw new Error(`The settings screen has a row for a feature the registry does not know: "${key}".`);
		return status;
	}

	/** The "N of M features running" line, in its own row. */
	private renderCount(rowEl: HTMLElement): void {
		this.countEl = rowEl.createDiv({ cls: "effortless-count", text: runningCount(this.registry.statuses()) });
	}

	/**
	 * What the first row Obsidian draws on a visit does before drawing it:
	 * starts the visit at the top, and starts following what the screen shows.
	 */
	private beginVisit(): void {
		if (this.drawnThisVisit) return;
		this.drawnThisVisit = true;
		// **The rule for the scroll position: the first draw of a visit starts
		// at the top, every later draw keeps the place.** The container is the
		// element that scrolls, and a row opened near the bottom used to jump
		// out of sight when a redraw emptied it. No
		// redraw empties it now — each redraws one row in place — so only the
		// first half needs saying: Obsidian keeps a tab's row elements between
		// visits, and the container with them (read from Obsidian 1.15's own
		// code, not driven), so a position from the last visit may still be on
		// it. Obsidian scrolls to a search hit after drawing the rows, so a hit
		// still lands on its card: driven in
		// `docs/acceptance-shots/issue-1266-drive.txt` § 2.
		this.containerEl.scrollTop = 0;

		// Added once a visit, because a listener per draw would be a hundred
		// listeners by the time the person leaves. Dropped in `hide()`, and
		// again at the plugin's unload through the callback the constructor
		// registered.
		//
		// A standing problem is drawn in the core card, and opens it by
		// default, so that card is the one a change of problems redraws.
		if (this.stopWatchingProblems === null) {
			this.stopWatchingProblems = this.problems.onChange(() => this.redrawRow(CORE_ROW));
		}
		// On the same terms, for the store putting memory back. Answered
		// as a feature's report of a change is answered: every feature is asked
		// again, because what was put back may be what a readiness reads, and
		// the screen is drawn from the store. No card is forced open — nobody
		// pressed anything to get here, and the cards the person opened stay
		// open by themselves.
		//
		// **This is not a redraw on a deferred failure**, and #558's rule
		// against one stands. That rule exists because a new run of typing may
		// be under way when an old run's refusal arrives; while one is, the
		// store has a write waiting and puts nothing back, so this is never
		// called. It is called only once no keystroke has reached the store
		// since the refused write began.
		//
		// **That rule reaches only a box that writes to the store on the
		// keystroke.** A control that keeps what it holds in the DOM until a
		// press — `checkboxCycling/settingsPanel.ts`'s "Add a symbol" box —
		// starts no write for the store to hold, so #558 never sees it and this
		// still fires. `redrawAfterRestore` is where that second case is
		// answered, by waiting rather than skipping: the redraw the restore
		// asked for still happens, once the person's own attention has left
		// the control it would otherwise have emptied.
		if (this.stopWatchingStore === null) {
			this.stopWatchingStore = this.settings.onChange(() => this.redrawAfterRestore());
		}

		// On the same terms again, for a feature's live line. `?.`
		// because the registries tests build by hand before this member existed
		// do not have it; the one `main.ts` builds always does.
		if (this.stopWatchingLines === null) {
			this.stopWatchingLines = this.registry.onLiveLineChange?.(() => this.redrawLines()) ?? null;
		}
	}

	/** Whether `rowEl` holds the region an owed redraw waits on (see {@link callOffOwedRedraw}). */
	private holdsOwedRegion(rowEl: HTMLElement): boolean {
		return this.owedRegion !== null && rowEl.contains(this.owedRegion);
	}

	/** Calls off the redraw a restore owed, if one is owed (see {@link callOffOwedRedraw}). */
	private callOffTheOwedRedraw(): void {
		this.callOffOwedRedraw?.();
		this.callOffOwedRedraw = null;
		this.owedRegion = null;
	}

	/**
	 * Obsidian calls this when the settings modal closes, the tab is switched
	 * away from, or the person navigates off the page. Everything a visit
	 * started goes here, and the rows are forgotten so nothing draws into a
	 * screen that is closed.
	 *
	 * It is not guaranteed to run when the host window is destroyed, which is
	 * why it is no longer the only thing that drops the listener: the
	 * constructor registers the same drop on the plugin, so unloading releases
	 * it whether this ran or not. Calling both
	 * is safe — the field is `null` after the first.
	 *
	 * This is still not the whole answer to what the plugin releases: #150 and
	 * #152 are open, and neither is this screen.
	 */
	override hide(): void {
		super.hide();
		this.stopWatchingProblems?.();
		this.stopWatchingProblems = null;
		this.stopWatchingStore?.();
		this.stopWatchingStore = null;
		this.stopWatchingLines?.();
		this.stopWatchingLines = null;
		this.lineEls.clear();
		this.badgeEls.clear();
		this.countEl = null;
		this.rows.clear();
		this.callOffTheOwedRedraw();
		// The next draw is a new visit and starts at the top.
		this.drawnThisVisit = false;
	}

	private renderCoreCard(parent: HTMLElement): void {
		const layout = this.settings.core().layout;
		// Dropped before the card is built again, because a shut card draws no
		// Filename row at all and a reference to the last draw's would have the
		// refresh writing into a screen nobody is looking at. `renderCoreBody`
		// sets them again when it draws the row.
		this.filenameDescEl = null;
		this.unreadableLineEl = null;

		// Open by default while anything is standing, so a problem is on the
		// screen the moment the settings screen is. A card the person has
		// opened or closed themselves keeps their answer for this visit.
		//
		// A filename pattern the plugin cannot read opens it for the same
		// reason. That line is drawn inside the card, and the person whose
		// `data.json` arrived with the bad pattern has no reason to click
		// anything — nothing else on the screen looks wrong.
		const open =
			this.coreOpen ??
			(this.problems.all().length > 0 || unreadableFilenamePattern(layout) !== null);

		const card = parent.createDiv({ cls: "effortless-card effortless-card-core" });
		const header = card.createDiv({ cls: "effortless-card-header" });
		header.createSpan({ cls: "effortless-chevron", text: open ? "▾" : "▸" });
		const text = header.createDiv({ cls: "effortless-card-text" });
		text.createDiv({ cls: "effortless-card-name", text: CORE_CARD_NAME });
		this.coreLineEl = text.createDiv({
			cls: "effortless-card-line",
			text: coreSummary(layout),
		});
		header.onClickEvent(() => {
			this.coreOpen = !open;
			this.redrawRow(CORE_ROW);
		});

		if (!open) return;

		this.renderCoreBody(card.createDiv({ cls: "effortless-card-body" }));
	}

	/**
	 * Everything two features must agree on, entered once. The order is the
	 * order a person meets it: where the notes are, then what the sections in
	 * them are called, then what the plugin should leave alone.
	 */
	private renderCoreBody(body: HTMLElement): void {
		const layout = this.settings.core().layout;

		new Setting(body)
			.setName("Folder")
			.setDesc("Where your day's logs are kept, as a path inside the vault.")
			.addText((text) =>
				text
					.setPlaceholder("Days")
					.setValue(layout.dailyLogFolder)
					.onChange((value) => this.saveLayout({ dailyLogFolder: asVaultPath(value) })),
			);

		const filename = new Setting(body)
			.setName("Filename")
			.setDesc("The date pattern a day's log is named after, such as YYYY-MM-DD.")
			.addText((text) =>
				text
					.setPlaceholder("YYYY-MM-DD")
					.setValue(layout.dailyLogFilename)
					.onChange((value) => this.saveLayout({ dailyLogFilename: value.trim() })),
			);

		// A pattern the plugin cannot read makes every note unrecognisable as a
		// day's log, silently and for ever, because reading answers `null` where
		// writing throws. The line says the consequence and not only that
		// the pattern is wrong, because the consequence is the part nobody would
		// guess.
		//
		// A line on this row rather than a `Notice` or a standing problem. The
		// screen saves on every keystroke, so `YYY` on the way to `YYYY-MM-DD`
		// is an ordinary second of use and must stay usable — nothing
		// modal, nothing that has to be dismissed. A standing problem is not
		// available either: that channel belongs to a running feature and the
		// core has none of its own (`GLOSSARY.md`, **Standing problem**).
		this.filenameDescEl = filename.descEl;
		this.refreshUnreadablePattern(layout);

		new Setting(body)
			.setName("Day's-log template")
			.setDesc(
				"A note to build a new day's log from, instead of the built-in frame. Leave it blank for the built-in frame. Fill {{date:FORMAT}}, {{yesterday:FORMAT}} and {{tomorrow:FORMAT}} for the day being created, such as {{date:dddd D MMMM}}.",
			)
			.addText((text) =>
				text
					.setPlaceholder("Templates/Day.md")
					.setValue(layout.dailyLogTemplate)
					.onChange((value) => this.saveLayout({ dailyLogTemplate: asVaultPath(value) })),
			);

		this.renderHeading(
			body,
			"Notes heading",
			"The section of a day's log where something to do is first written down.",
			() => this.settings.core().layout.notesHeading,
			(notesHeading) => this.saveLayout({ notesHeading }),
			{ refuseBlank: false },
		);

		this.renderHeading(
			body,
			"Calendar heading",
			"The section of a day's log holding that day's calendar table.",
			() => this.settings.core().layout.calendarHeading,
			(calendarHeading) => this.saveLayout({ calendarHeading }),
			{ refuseBlank: false },
		);

		this.renderHeading(
			body,
			"Today heading",
			"The section a copied task lands under when it is due today.",
			() => this.settings.core().layout.todayHeading,
			(todayHeading) => this.saveLayout({ todayHeading }),
			{ refuseBlank: true },
		);

		this.renderHeading(
			body,
			"Overdue heading",
			"The section a task reappears under, directly above today's, when it rolled over unfinished.",
			() => this.settings.core().layout.overdueHeading,
			(overdueHeading) => this.saveLayout({ overdueHeading }),
			{ refuseBlank: true },
		);

		this.renderHeading(
			body,
			"Diary heading",
			"The section of a day's log where you write about the day itself. Leave it blank to keep it out of new days.",
			() => this.settings.core().layout.diaryHeading,
			(diaryHeading) => this.saveLayout({ diaryHeading }),
			{ refuseBlank: false },
		);

		// The two collection headings carry no level. A note counts as a
		// collection whatever size its heading is written at, so storing one
		// would be storing an answer nothing is allowed to use.
		new Setting(body)
			.setName("Tasks heading")
			.setDesc("A note carrying this heading is a collection. Nothing else marks one.")
			.addText((text) =>
				text
					.setValue(layout.tasksHeading)
					.onChange((value) => this.saveLayout({ tasksHeading: value.trim() })),
			);

		new Setting(body)
			.setName("Completed tasks heading")
			.setDesc("Where a collection's finished tasks go.")
			.addText((text) =>
				text
					.setValue(layout.completedTasksHeading)
					.onChange((value) => this.saveLayout({ completedTasksHeading: value.trim() })),
			);

		this.renderFieldName(
			body,
			"Processed field",
			"The property a note carries, blank until you have gone through it. Meeting notes writes it on every note it makes.",
			"processedField",
		);

		this.renderFieldName(
			body,
			"Day link field",
			"The property that links a note to its day's log. Meeting notes writes it on every note it makes.",
			"dayLinkField",
		);

		this.renderFieldName(
			body,
			"Diary date field",
			"The property that holds the date the plugin first saw text under your diary heading. A date you type yourself counts.",
			"diaryDateField",
		);

		new Setting(body)
			.setName("Calendar table columns")
			.setDesc("Matched by name and ignoring capitals, so your other tables are left alone.")
			.addText((text) =>
				text.setValue(layout.calendarColumns.time).onChange((value) =>
					this.saveLayout({
						calendarColumns: {
							...this.settings.core().layout.calendarColumns,
							time: value.trim(),
						},
					}),
				),
			)
			.addText((text) =>
				text.setValue(layout.calendarColumns.event).onChange((value) =>
					this.saveLayout({
						calendarColumns: {
							...this.settings.core().layout.calendarColumns,
							event: value.trim(),
						},
					}),
				),
			);

		new Setting(body)
			.setName("Excluded folders")
			.setDesc("One folder per line. Nothing under them is ever a collection.")
			.addTextArea((text) =>
				text
					.setValue(layout.excludedFolders.join("\n"))
					.onChange((value) => this.saveLayout({ excludedFolders: asFolderList(value) })),
			);

		renderCalendarSources(body, this.settings, this.device, this.announceDeferredSaveFailure);

		// The one answer on this card that stays on this device. It is read
		// from and written to the per-device store, never to the settings file,
		// because the other machine's answer must not arrive here through sync.
		new Setting(body)
			.setName("Build the days on this device")
			.setDesc("Only one of your devices should create the days ahead. Pick this one here.")
			.addToggle((toggle) =>
				toggle.setValue(this.device.read().buildsTheDays).onChange((value) => {
					// The person is inside this card — the switch is only reachable
					// from here — so the redraw below must not close it under their
					// hands. Recording that is what makes it survive a redraw where
					// the last standing problem went with a feature that just stopped.
					const keepThisCardOpen = () => {
						this.coreOpen = true;
					};
					// Re-checked only after an answer that was actually stored: this
					// is the one answer a feature's readiness reads, so the features
					// that stood themselves down because another device had the job
					// start here now, and the ones that now stand down stop — with no
					// plugin reload. Nothing changed when the save failed, so
					// nothing should start or stop on the strength of it.
					//
					// Redrawn whatever happened, and this is the only switch on the
					// screen that redraws nothing by itself. Every feature row
					// this answer decides is now wrong, and after a save that failed
					// the switch has to come back showing what is actually stored
					// rather than what was clicked.
					if (this.saveDevice({ buildsTheDays: value })) {
						this.recheckAndRedraw(keepThisCardOpen);
					} else {
						this.redrawKeeping(keepThisCardOpen);
					}
				}),
			);

		// Immediately above the collections list: a problem you find by scrolling
		// forty-seven rows is not a notice. It draws nothing at
		// all while nothing is wrong.
		renderProblems(body, this.problems.all());

		renderCollections(body, this.collections.all(), (path) => {
			void this.app.workspace.openLinkText(path, "", false);
		});
	}

	/**
	 * A heading's text and the level it is written at, on one row.
	 *
	 * `read` is a getter rather than a value because the row is drawn once and
	 * then edited: changing the level after typing the text must keep the text
	 * that is stored now, not the one that was there when the card opened.
	 *
	 * **A blank text is refused rather than saved only where `refuseBlank` is
	 * true** (issue #801, narrowed by #816): on the Today and Overdue rows,
	 * nothing could ever find a task's target section by an empty name, so a
	 * refused write fires a `Notice` and leaves the stored text as it was. The
	 * box itself is left alone — Obsidian's `onChange` fires on every
	 * keystroke, and putting the stored text back into the box on the same
	 * keystroke that emptied it would land the next keystroke after it instead
	 * of in an empty box, making the ordinary clear-and-retype gesture
	 * impossible. This is the trigger box's own shape for a value
	 * it cannot save: what was typed stays in the box, and only the write is
	 * refused (`dateEntry.ts`'s `settingsPanel`, issue #607). On the Notes and
	 * Calendar rows a blank text is instead #39's documented way to leave that
	 * section out of the day's frame (`dailyLogFrame`), so it is saved like any
	 * other value.
	 */
	private renderHeading(
		body: HTMLElement,
		name: string,
		desc: string,
		read: () => HeadingSetting,
		save: (next: HeadingSetting) => Promise<void>,
		{ refuseBlank }: { refuseBlank: boolean },
	): void {
		const heading = read();
		new Setting(body)
			.setName(name)
			.setDesc(desc)
			.addText((text) =>
				text.setValue(heading.text).onChange((value) => {
					const trimmed = value.trim();
					if (!trimmed && refuseBlank) {
						new Notice(`Effortless: ${name} cannot be blank. Kept "${read().text}".`);
						return undefined;
					}
					return save({ ...read(), text: trimmed });
				}),
			)
			.addDropdown((dropdown) => {
				for (const level of [1, 2, 3, 4, 5, 6]) {
					dropdown.addOption(String(level), "#".repeat(level));
				}
				dropdown
					.setValue(String(heading.level))
					.onChange((value) => save({ ...read(), level: Number(value) }));
			});
	}

	/**
	 * One text row naming a frontmatter property the layout keeps. A name the
	 * shared rule ({@link fieldNameRefusal}) refuses is not stored and the
	 * previous one stays, said in a notice the way a blank heading is.
	 */
	private renderFieldName(
		body: HTMLElement,
		name: string,
		desc: string,
		key: "processedField" | "dayLinkField" | "diaryDateField",
	): void {
		new Setting(body)
			.setName(name)
			.setDesc(desc)
			.addText((text) =>
				text.setValue(this.settings.core().layout[key]).onChange((value) => {
					const refusal = fieldNameRefusal(name, value);
					if (refusal !== null) {
						new Notice(`Effortless: ${refusal} Kept "${this.settings.core().layout[key]}".`);
						return undefined;
					}
					return this.saveLayout({ [key]: storedFieldName(value) });
				}),
			);
	}

	/**
	 * Writes one part of the layout back, leaving the rest of the core alone.
	 *
	 * Every row on the card goes through here, and none of them awaits what it
	 * gets back — Obsidian's `onChange` has nowhere to put a promise. So the
	 * failure is announced here or nowhere: the box would go on showing what
	 * the person typed, and the next reload would quietly drop it.
	 *
	 * The rest of the layout is read from the store at the keystroke, not from
	 * the draw, so a change carries every other box's value as the store holds
	 * it then. After a refused write has put the store back, that is the stored
	 * value — and the screen has already drawn every box again from it, which is
	 * what keeps a save here from carrying it into the file while a box beside
	 * this one shows another.
	 */
	private async saveLayout(change: Partial<VaultLayout>): Promise<void> {
		const core = this.settings.core();
		const write = this.settings.saveCoreSoon({ ...core, layout: { ...core.layout, ...change } });
		// Before the write is awaited, not after it. `saveCoreSoon` changes the
		// stored answer straight away and only the write to disk waits, so the
		// screen follows the keystroke rather than the debounce: #54 decides how
		// often the answer is stored, not how often it is shown.
		this.refreshCoreCard();
		try {
			await write;
		} catch (error) {
			// Once per failed write, not once per keystroke that joined it, and
			// not once per section that joined it either. See
			// `announceDeferredSaveFailure` above for why the promise is the
			// run's name.
			this.announceDeferredSaveFailure(write, error);
		}
	}

	/**
	 * Brings the parts of the core card that follow a box up to date, in place.
	 *
	 * Called from every layout save, so the closed row answers the Folder and
	 * Filename boxes as they are typed into rather than at the next draw. It
	 * updates the text of a row that is already on the screen and rebuilds no
	 * DOM, which is what keeps the focus and the caret in the box being typed in
	 * — #78's rule that a half-typed answer is an ordinary second of use forbids
	 * a redraw here.
	 *
	 * Does nothing before the first draw, and nothing for the rows this card
	 * draws that no box changes.
	 */
	private refreshCoreCard(): void {
		const layout = this.settings.core().layout;
		if (this.coreLineEl !== null) this.coreLineEl.textContent = coreSummary(layout);
		this.refreshUnreadablePattern(layout);
	}

	/**
	 * Puts the Filename row's unreadable-pattern line where `layout` says it
	 * should be: there and naming the pattern in the box, or gone.
	 *
	 * The line is taken away and made again rather than edited, because its
	 * absence is half of what it says. It is a child of the row's description,
	 * not of the box, so replacing it leaves the input element alone — the focus
	 * and the caret are in that, and this is what lets `YYY` on the way to
	 * `YYYY-MM-DD` stay an ordinary second of use.
	 *
	 * Does nothing while the card is shut, when the row is not on the screen.
	 */
	private refreshUnreadablePattern(layout: VaultLayout): void {
		const host = this.filenameDescEl;
		if (host === null) return;
		this.unreadableLineEl?.remove();
		this.unreadableLineEl = null;

		const unreadable = unreadableFilenamePattern(layout);
		if (unreadable === null) return;
		this.unreadableLineEl = host.createDiv({
			cls: "effortless-unreadable-pattern",
			text: `Effortless cannot read “${unreadable}”, so no note is recognised as a day's log.`,
		});
	}

	/**
	 * The same, for the one answer that is kept on this device rather than saved.
	 * Answers whether it was stored, because what the caller does next depends on
	 * something having actually changed.
	 */
	private saveDevice(next: { buildsTheDays: boolean }): boolean {
		try {
			this.device.save(next);
			return true;
		} catch (error) {
			announceFailedSave(error);
			return false;
		}
	}

	/**
	 * What the screen does when something a feature's readiness reads has been
	 * stored: ask every feature again, keep the card the person is standing in
	 * open, and draw the screen from what is stored now.
	 *
	 * One copy, because two things run it — the core card's own device switch
	 * and any feature reporting a change from inside its own settings body — and they must
	 * not drift apart. Which card is held open is the caller's, because only the
	 * caller knows which one the person is inside.
	 */
	private recheckAndRedraw(keepOpen: () => void): void {
		// Caught rather than allowed out, so the person hears about it and the
		// screen is still redrawn rather than left showing the answer they
		// replaced.
		try {
			this.registry.recheckReadiness();
		} catch (error) {
			announceFailedRecheck(error);
		}
		this.redrawKeeping(keepOpen);
	}

	/**
	 * Draws every row again, in place, without asking any feature anything,
	 * leaving the named card open.
	 *
	 * This is the half of {@link recheckAndRedraw} that runs when nothing was
	 * stored: the rows still have to come back showing what is actually stored
	 * rather than what was clicked, and nothing has changed for a feature to be
	 * asked about.
	 */
	private redrawKeeping(keepOpen: () => void): void {
		keepOpen();
		this.redrawEveryRow();
	}

	/**
	 * What the store's own restore runs into: the ordinary
	 * {@link recheckAndRedraw}, unless a {@link PROTECT_WHILE_FOCUSED_ATTR}
	 * region is holding focus somewhere on this screen right now.
	 *
	 * Found, the redraw is not skipped — it is owed, and paid once focus has
	 * left the region ({@link afterFocusLeaves}), so the screen catches up to
	 * whatever the store now holds when the person's own attention moves on.
	 *
	 * **The whole redraw waits, not only the region.** Until it is paid, every
	 * other box on the screen goes on showing what it showed, the refused one
	 * included, while the store and the file hold the value put back. A second
	 * restore that lands while the same region is still held finds a redraw
	 * already owed and asks for no second one.
	 */
	private redrawAfterRestore(): void {
		const engaged = this.containerEl.querySelector<HTMLElement>(`[${PROTECT_WHILE_FOCUSED_ATTR}]`);
		if (engaged === null) {
			this.recheckAndRedraw(() => undefined);
			return;
		}
		if (this.callOffOwedRedraw !== null) return;
		this.owedRegion = engaged;
		this.callOffOwedRedraw = afterFocusLeaves(engaged, () => {
			this.callOffOwedRedraw = null;
			this.owedRegion = null;
			this.recheckAndRedraw(() => undefined);
		});
	}

	/**
	 * Writes each closed row's line again from what the features say now, in
	 * place. Called when a feature says its live line changed; nothing else on
	 * the screen is touched, so a box being typed in stays as it is.
	 *
	 * Reads the state for every row rather than for the one that spoke: the
	 * registry's `statuses()` is the one place a row's line and badge are
	 * decided, and a row that did not change is written what it had. The badge
	 * and the running count are written with the line, from the same read, so a
	 * feature whose readiness turned `unconfigured` or whose line began to throw
	 * never shows its new reason under a Running badge.
	 */
	private redrawLines(): void {
		const statuses = this.registry.statuses();
		for (const status of statuses) {
			this.lineEls.get(status.id)?.setText(statusLine(status));
			const badge = this.badgeEls.get(status.id);
			if (badge !== undefined) {
				badge.className = badgeClass(status);
				badge.setText(BADGE_LABEL[status.state]);
			}
		}
		this.countEl?.setText(runningCount(statuses));
	}

	private renderFeatureCard(parent: HTMLElement, status: FeatureStatus): void {
		const open = this.opened.has(status.id);
		const card = parent.createDiv({ cls: "effortless-card" });
		const header = card.createDiv({ cls: "effortless-card-header" });
		const chevron = header.createSpan({ cls: "effortless-chevron", text: open ? "▾" : "▸" });

		const text = header.createDiv({ cls: "effortless-card-text" });
		text.createDiv({ cls: "effortless-card-name", text: status.name });
		this.lineEls.set(status.id, text.createDiv({ cls: "effortless-card-line", text: statusLine(status) }));

		this.badgeEls.set(
			status.id,
			header.createSpan({ cls: badgeClass(status), text: BADGE_LABEL[status.state] }),
		);

		// The switch sits on the closed row, so turning a feature off never means
		// opening it first. Its settings are kept and come straight back.
		//
		// It is disabled where this device cannot run the feature: pressing it
		// would store an answer nobody could ever see take effect here. It reads
		// off there too, because the stored value is the other device's.
		//
		// Its value is the stored answer, not the row's state. Drawing anything
		// that is not `off` as on made the switch spring back for the rest of the
		// session on a feature that failed to load: that feature is `failed`, not
		// `off`, however the person set the switch. Switching it off then
		// clears the recorded failure, so the row reads `off` and names nothing:
		// a failure line the person can neither act on nor get rid of is worse
		// than no line.
		const unavailable = status.state === "unavailable";
		const toggleHost = header.createDiv({ cls: "effortless-switch" });
		new Setting(toggleHost).addToggle((toggle) =>
			toggle
				.setValue(!unavailable && this.settings.isEnabled(status.id))
				.setDisabled(unavailable)
				.onChange(async (value) => {
					try {
						await this.registry.setEnabled(status.id, value);
					} catch (error) {
						announceFailedSave(error);
					}
					// This card from what is stored now, and every row's line,
					// badge and the count in place, since the count is the
					// running total and nothing else on the screen changed.
					this.redrawRow(featureRow(status.id));
					this.redrawLines();
				}),
		);

		// The chevron and the name-and-description block open and close the
		// card; the header as a whole does not, unlike the core card's. The
		// header also holds the switch, and a handler on the whole row would have
		// to decide, on every click, whether the click was the switch's — the
		// regression it risks (a press on the switch that also opens the card) is
		// worse than the arrow doing nothing was. Binding the two elements a
		// thumb actually reaches for cannot go wrong that way, and the cost is
		// that the badge and the row's empty space stay inert on a feature card
		// where they are live on the core one.
		//
		// That cost is real rather than forced: `toggleHost` above is this file's
		// own element, so a row handler could return early for a click inside it
		// without touching Obsidian's toggle. The narrow route was chosen at
		// triage anyway, on the size of the regression rather than on any
		// impossibility. Making the whole row live is a ticket of its own, and it
		// owes the switch a guard.
		const toggleOpen = () => {
			if (open) this.opened.delete(status.id);
			else this.opened.add(status.id);
			this.redrawRow(featureRow(status.id));
		};
		chevron.onClickEvent(toggleOpen);
		text.onClickEvent(toggleOpen);

		// An off feature still opens: you configure it before switching it on.
		if (open) {
			// The feature draws the body; the badge, the line above it and the
			// count are drawn here from what its readiness answers. So the feature
			// is handed a way to say that what it stores has changed, and this
			// screen answers it the way the device switch above answers itself. The card
			// is held open by name because the person is standing inside it — they
			// pressed something in this body to get here. It is handed this screen's
			// one announcer as well, so a failed write that the feature's body and a
			// core box both joined is told once.
			this.registry.displaySettings(
				status.id,
				card.createDiv({ cls: "effortless-card-body" }),
				() => this.recheckAndRedraw(() => this.opened.add(status.id)),
				this.announceDeferredSaveFailure,
			);
		}
	}
}

/** The one line on the closed row: what this feature is doing right now. */
export function statusLine(status: FeatureStatus): string {
	switch (status.state) {
		case "running":
			// The feature's own line when it gives one, what it does
			// otherwise.
			return status.line ?? status.description;
		case "unconfigured":
			return status.detail ?? "Needs setting up before it can run.";
		case "failed":
			return status.detail ?? "Stopped without saying why.";
		case "off":
			return status.description;
		case "unavailable":
			return status.detail ?? "Not available on this device.";
		case "standby":
			// The feature's own reason, not its description: the row has to say
			// which device does the job instead.
			return status.detail ?? "Another device does this instead.";
		case "notStarted":
			// Switched on and never attached. The registry always supplies this
			// sentence as the detail; the fallback reads the same constant so a
			// status built without one still names the remedy.
			return status.detail ?? NOT_STARTED;
	}
}

/**
 * The one line on the core card's closed row: where the day's logs go, or the
 * sentence for a layout half of which has not been answered yet.
 *
 * Read whole from {@link dailyLogPathPattern} rather than assembled here from
 * the two fields. That helper's own comment is where the argument for it lives:
 * it sits beside the writer in `vaultLayout.ts`, and every time this line has
 * built part of the path itself the row and the writer have come to different
 * conclusions.
 *
 * The unanswered sentence reads the helper's `null` rather than testing the
 * folder field again. The folder helper answers `""` for the vault root, which
 * is a real answer and falsy, so a second test here would put the two back into
 * disagreement for the one folder #139 is about. `"Not answered yet"` is this
 * screen's own wording, and the only thing this function decides.
 *
 * A function of the layout alone, so the row drawn on the first pass and the
 * row rewritten on a keystroke cannot come to different conclusions.
 */
function coreSummary(layout: VaultLayout): string {
	return dailyLogPathPattern(layout) ?? "Not answered yet";
}

/**
 * Runs `pay` once focus has left `region` and whatever moved it has finished,
 * and answers the way to call that off.
 *
 * **Left means the region's mark is gone.** {@link protectWhileFocused} takes
 * it off only when focus moves outside the region, so focus passing from one
 * of its parts to another — the symbol box to its Add button — is not leaving,
 * and the redraw goes on waiting.
 *
 * **Never inside the event that moved the focus.** Paying there is what lost
 * the press it came from. Chromium moves focus to a button when the pointer
 * goes down, so a redraw run inside that `blur` rebuilt the screen between the
 * press and the release; the release came up over a new button that had seen
 * no press, no click happened, and a press on anything the redraw replaced
 * reached nothing. So a `blur` only
 * asks for a look on a later task, and while a pointer is down that look waits
 * for it to come up. A click is sent together with the release that makes it,
 * and a tap that lifted before focus moved sends its click together with the
 * focus change, so in both cases the press lands first.
 *
 * The cost is that the redraw is still every card. A press that leaves the
 * region for another box lands, and the redraw after it then rebuilds that
 * box too; the focus and the caret are put back in the new one where they
 * were (`focusKeeper.ts`, #1266).
 */
function afterFocusLeaves(region: HTMLElement, pay: () => void): () => void {
	const doc = region.ownerDocument;
	let pointerDown = false;
	let lookOnRelease = false;
	let look: number | null = null;

	const lookSoon = (): void => {
		if (pointerDown) {
			lookOnRelease = true;
			return;
		}
		if (look !== null) return;
		look = window.setTimeout(() => {
			look = null;
			if (region.hasAttribute(PROTECT_WHILE_FOCUSED_ATTR)) return;
			callOff();
			pay();
		}, 0);
	};
	const onPointerDown = (): void => {
		pointerDown = true;
	};
	const onPointerUp = (): void => {
		pointerDown = false;
		if (!lookOnRelease) return;
		lookOnRelease = false;
		lookSoon();
	};
	const callOff = (): void => {
		region.removeEventListener("blur", lookSoon, true);
		doc.removeEventListener("pointerdown", onPointerDown, true);
		doc.removeEventListener("pointerup", onPointerUp, true);
		doc.removeEventListener("pointercancel", onPointerUp, true);
		if (look !== null) window.clearTimeout(look);
		look = null;
	};

	// Listened for from the moment the redraw is owed rather than from the
	// `blur`, because the pointer goes down before the focus moves.
	region.addEventListener("blur", lookSoon, true);
	doc.addEventListener("pointerdown", onPointerDown, true);
	doc.addEventListener("pointerup", onPointerUp, true);
	doc.addEventListener("pointercancel", onPointerUp, true);
	return callOff;
}

/** A folder per line, normalised, with blank lines and stray spaces dropped. */
function asFolderList(value: string): string[] {
	return value
		.split("\n")
		.map((folder) => asVaultPath(folder))
		.filter((folder) => folder.length > 0);
}

/**
 * Says out loud that the answer was stored but the features could not all be
 * asked about it again.
 *
 * Its own sentence rather than `announceFailedSave`'s, because the save is the
 * one thing that did work here: telling the person their setting was not saved
 * would send them to check something that is fine and leave the real trouble
 * unnamed.
 */
function announceFailedRecheck(error: unknown): void {
	const detail = reasonOf(error);
	new Notice(
		`Effortless: that answer was saved, but the features were not all asked about it again. ${detail}`,
	);
}
