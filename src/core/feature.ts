/**
 * What a feature is, and everything it is allowed to know.
 *
 * A feature is one thing a user would plausibly switch off on its own. It is an
 * Obsidian `Component`, so the core turns it on with `addChild` and off with
 * `removeChild`, and anything it registered through `registerEvent`,
 * `registerDomEvent`, `registerInterval` or a view detaches by itself.
 *
 * A feature never references another feature. Anything two features must agree
 * on lives in the core instead, which is why switching one off can never break
 * another.
 */

import { Component } from "obsidian";
import type {
	App,
	Command,
	EditorSuggest,
	IconName,
	MarkdownPostProcessorContext,
	ViewCreator,
} from "obsidian";
import type { CoreSettings, FeatureSettings } from "./settings";
import type { NoteWriter } from "./noteWriter";
import type { Calendar } from "./calendarSources";
import type { Collections } from "./collections";
import type { FeatureProblems } from "./problems";
import type { SaveFailureAnnouncer } from "./saveFailureAnnouncer";

/**
 * Whether a feature has what it needs to do its job. Only `ready` means the
 * feature will run; the other three are normal states rather than errors, and
 * each carries its reason so the settings screen can say what is going on
 * without guessing.
 *
 * The difference between the three is what the person can do about it:
 * `unconfigured` is work waiting for them, `unavailable` is a device that
 * cannot do this at all, and `standby` is a job another device has been given.
 *
 * A feature is asked this at every plugin start, and the answer is never
 * stored: `data.json` lives in the vault and syncs, so a stored answer would be
 * the other device's.
 */
export type Readiness =
	| { state: "ready" }
	| { state: "unconfigured"; reason: string }
	| { state: "unavailable"; reason: string }
	| { state: "standby"; reason: string };

/**
 * What the core promises a feature. Only the stateful things are here. Code
 * that never varies — how a task line is read, how a daily log's path is
 * derived — is imported directly instead, because a swappable seam with exactly
 * one implementation buys nothing and adds a step to every test.
 */
export interface FeatureHost {
	/** For a feature that draws its own interface. Not the route to the vault. */
	readonly app: App;
	/** The vault layout and the rest of the core's settings, read-only. */
	readonly core: Readonly<CoreSettings>;
	/** The only way to write a note the user is not looking at. */
	readonly notes: NoteWriter;
	/** The calendar. Two features read it and neither may ask the other. */
	readonly calendar: Calendar;
	/**
	 * Which notes in the vault are collections, found from Obsidian's own index.
	 * Two features read it and neither may ask the other.
	 */
	readonly collections: Collections;
	/**
	 * A narrow view onto the per-device store: whether this device is the one
	 * that builds the days ahead. Not the store itself — `DeviceStore.read()`
	 * also answers `calendarReads`, which no feature has any business with.
	 *
	 * **A method, not a property.** The answer is read when it is asked for and
	 * never kept from the first ask: a feature that cached it would keep saying
	 * *standby* after the person switched this device on, the same defect shape
	 * as a block's reach keeping what it read once.
	 */
	readonly device: { buildsTheDays(): boolean };
	/**
	 * Whether this feature is switched on and its start has not failed: the
	 * core's own answer, asked when it is needed and never kept. A feature that
	 * answers something while it stands down (meeting notes answers a click on a
	 * device that never starts it) asks this instead of reading
	 * `core.enabled` itself, so it meets the rule that a feature whose start
	 * failed comes back only when the person switches it on.
	 *
	 * **Optional**, because a host built by hand in a test need not give it; the
	 * registry always does. A feature reading an absent answer treats it as off.
	 */
	readonly isOn?: () => boolean;
	/**
	 * How this feature says something is wrong and has it stay said: one
	 * `Notice` now, and a line on the settings screen until it clears it again.
	 * One report per event, never one per affected item, and never a marker
	 * written into a note.
	 *
	 * Take it in the constructor if you like; do not report through it there.
	 * See `settings` below for the rule all four of these keep.
	 */
	readonly problems: FeatureProblems;
	/**
	 * Registers a command, removed again when the feature is switched off.
	 *
	 * **Call it from `onload` onwards, never while the feature is being built.**
	 * It throws there, saying so. Unlike `problems` and `settings` there is
	 * nothing here worth taking early, so for this one the rule is simply "not
	 * there" — and it has a second reason of its own: the core constructs every
	 * feature, including one the person has switched off and one whose factory
	 * then throws, and only a feature the core kept can have its commands taken
	 * back again. A command registered from a constructor either belongs to a
	 * feature that is not running, or to nothing at all — and stays in the
	 * palette for the rest of the session.
	 */
	addCommand(command: Command): void;
	/**
	 * Takes back one command this feature registered, leaving its others alone.
	 *
	 * Switching the feature off removes every command it holds, so this is only
	 * for the feature that has to change its own set while it keeps running — one
	 * whose commands come from a list the person edits. Without it, a renamed or
	 * deleted entry leaves its command in the palette for the rest of the session.
	 *
	 * Give it the same id you gave `addCommand`. The id Obsidian hands back,
	 * carrying the plugin's manifest id in front, is accepted too.
	 *
	 * An id this feature never registered is not an error and changes nothing:
	 * removing what is not there is how a feature rebuilds its set without first
	 * having to work out what it already holds. An id **another** feature
	 * registered is that same case — one feature can never reach another's
	 * commands.
	 *
	 * **Call it from `onload` onwards, never while the feature is being built.**
	 * It throws there, saying so, for `addCommand`'s reason: until the constructor
	 * has returned there is no feature, so there is nothing whose commands these
	 * would be.
	 */
	removeCommand(commandId: string): void;
	/**
	 * Registers an editor suggester — the popup that offers something as you
	 * type — that goes quiet when the feature is switched off.
	 *
	 * **Call it from `onload` onwards, never while the feature is being built.**
	 * It throws there, saying so, for `addCommand`'s reason: the core constructs
	 * every feature, including one that is switched off and one whose factory
	 * then throws, and a suggester registered for either would answer for a
	 * feature that is not running.
	 *
	 * **Switched off, it is quiet at once.** An open popup closes, and every
	 * keystroke after that is declined without your suggester being asked.
	 *
	 * **Switched on again, it does not stack.** Obsidian keeps every suggester a
	 * plugin registered until the plugin unloads and offers no way to take one
	 * back, so the core never hands yours to Obsidian. The first call from this
	 * feature registers one suggester of the core's own with the plugin; that
	 * one, and only that one, is what Obsidian runs for this feature for the
	 * rest of the session. It forwards to the suggester you registered last
	 * while the feature is running, and declines while it is not. Registering
	 * again — a fresh suggester from each `onload`, or the same one — only
	 * changes where it forwards, so one feature has one suggester at a time.
	 *
	 * What your suggester sees, since Obsidian runs the core's and not yours:
	 * `onTrigger`, `getSuggestions`, `renderSuggestion` and `selectSuggestion`
	 * are called as Obsidian would call them, and `this.context` is set to the
	 * popup's context before each of the last three. Its `limit` is read at
	 * each `getSuggestions`. Its `close()` and `setInstructions()` act on the
	 * popup; instructions set before registering are not carried over, so set
	 * them after. Its `scope` is replaced by one the popup listens to; see below.
	 *
	 * **An override of `close()` or `setInstructions()` is kept.** Your
	 * `close()` runs every time the popup closes, however it closed — a choice,
	 * Escape or a click outside, the feature being switched off — once the popup
	 * has gone, and it may run when nothing was showing, as Obsidian's own may.
	 * Your `setInstructions()` runs every time you set instructions, once the
	 * popup has them. The `super` call in either reaches your own suggester,
	 * which has no popup, and does no harm there. An override
	 * is kept when your class declares it or it is set on the instance before
	 * you register the suggester; one assigned after registering is not seen.
	 * A kept `close()` also runs once more after the feature is switched off,
	 * when the next switch-on closes the popup it replaces.
	 *
	 * **Key bindings on your suggester's `scope` take effect when you register
	 * them after this call, and not when you register them before it.**
	 * Obsidian listens to the keys of the popup that is open, which is the
	 * core's, so this call gives your suggester a new `scope` whose parent is
	 * the popup's, and the popup listens to it while it forwards to yours. A
	 * binding you register on it — `this.scope.register([], "Tab", …)` once the
	 * suggester is registered — answers before the popup's own keys, and a key
	 * you do not take still moves and chooses in the popup's list. A binding
	 * registered in your suggester's constructor was made on the scope this
	 * call replaces, and is never asked, with nothing to say so: Obsidian's
	 * published interface sets a scope's parent only when the scope is
	 * built — `Scope`'s only published members are the constructor,
	 * `register` and `unregister` (`obsidian.d.ts:5537-5552`) — so the core
	 * cannot put that one under the popup's. Register the
	 * same suggester again, or hand it over again after another, and it keeps
	 * the scope it was given first, with every binding on it, once.
	 *
	 * **To hear that the person dismissed the popup, declare `onDismissed()` on
	 * your suggester** — see {@link DismissibleSuggester}. Obsidian gives one
	 * `close()` for every kind of dismissal and it reaches the core's suggester,
	 * not yours; your `close()` then runs for that close and every other alike,
	 * so this hook is the one route to a dismissal.
	 */
	registerEditorSuggest<T>(suggest: EditorSuggest<T>): void;
	/**
	 * Registers a Markdown code-block renderer — what Obsidian calls to draw a
	 * fenced block whose info string names `language` — that draws only while
	 * the feature runs.
	 *
	 * **Call it from `onload` onwards, never while the feature is being built.**
	 * It throws there, saying so, for `addCommand`'s reason: the core constructs
	 * every feature, including one that is switched off and one whose factory
	 * then throws, and a renderer registered for either would draw for a feature
	 * that is not running.
	 *
	 * **Switched off, a block is drawn as a plain code block** — its source,
	 * unhighlighted, in `<pre><code>` — in reading mode and in live preview
	 * alike, and your handler is not called. The same holds for a feature whose
	 * `onload` throws after registering.
	 *
	 * **The renderer is not withdrawn from Obsidian, and another plugin cannot
	 * take the language while this plugin is enabled.** Obsidian 1.13.7 claims a
	 * language in a list live preview reads, which only the plugin's own unload
	 * clears; `MarkdownPreviewRenderer.unregisterPostProcessor`, the published
	 * route, clears reading mode's list alone, and a second claim on a language
	 * throws. Driven, not assumed
	 * (`docs/acceptance-shots/issue-622-withdrawal-does-not-free-the-language.txt`).
	 * So the first call for a language registers one renderer of the core's own,
	 * kept for the session, and it forwards to the handler you registered last
	 * while the feature runs. Registering again — from each `onload` — only
	 * changes where it forwards, so there is one renderer per language, never
	 * two. Handing the language to another plugin means disabling this plugin,
	 * and restarting Obsidian if that plugin already failed to load this session:
	 * Obsidian does not run a failed plugin's `onload` a second time
	 * (`docs/acceptance-shots/issue-622-two-plugins-load-order.txt`,
	 * #622).
	 *
	 * If another plugin already holds `language`, this throws Obsidian's own
	 * `Code block postprocessor for language … is already registered`, and a
	 * call from `onload` fails the feature with that message.
	 *
	 * **An open note redraws on the switch, in both modes.** Obsidian redraws
	 * nothing by itself here — live preview reuses a drawn block until its text
	 * changes — so when the feature is switched on or off the core goes through
	 * every open tab whose note holds a block fenced with `language`, saves the
	 * note, and replaces the tab's view with an empty one and back again with the
	 * state it had (`WorkspaceLeaf.setViewState`, with its ephemeral state for
	 * scroll and cursor). That redraws reading mode and live preview alike
	 * without the note being closed, and an edit typed just before the switch
	 * and its undo both came through it in the drive. What it costs is the whole
	 * view being built again, so a tab whose note holds no such block is left
	 * alone.
	 *
	 * **A quick switch off then back on lands as one redraw, not two racing
	 * ones.** The tab's own redraw is saving its note for as long as this takes,
	 * and a second switch reaching the same tab before that save lands is held
	 * back rather than run alongside it — the two used to be able to swap the
	 * tab to the empty view and each capture the other's swap, sometimes leaving
	 * the tab on that empty view for good. The held-back
	 * one still runs, once the first is all the way back on the note.
	 */
	registerMarkdownCodeBlockProcessor(
		language: string,
		handler: (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => Promise<unknown> | void,
	): void;
	/**
	 * Adds an item to Obsidian's status bar, the bar along the bottom of the
	 * window, and hands back its element to draw in.
	 *
	 * **Call it from `onload` onwards, never while the feature is being built.**
	 * It throws there, saying so, for `addCommand`'s reason: the core constructs
	 * every feature, including one that is switched off and one whose factory
	 * then throws, and an item added for either would sit in the bar for a
	 * feature that is not running.
	 *
	 * **Withdrawn on switch-off.** Obsidian's `Plugin.addStatusBarItem`
	 * (`obsidian.d.ts:4947`) hands the item out and takes it back only when the
	 * whole plugin unloads, so the core removes the element itself
	 * (`HTMLElement.remove()`) when the feature is switched off or its `onload`
	 * throws. The element you were given is then detached from the window; a
	 * feature that kept it and draws into it later draws nowhere. Switched on
	 * again, call this again for a fresh one.
	 *
	 * Not available on mobile: Obsidian does not draw the bar there
	 * (`obsidian.d.ts:4941`, "Not available on mobile"), and the element it hands
	 * back is not shown.
	 *
	 * **This and the next two members are optional, like `onCoreChange` below**,
	 * so the hosts tests built by hand before they existed still satisfy this
	 * interface unchanged. `FeatureRegistry.hostFor`'s own host always supplies
	 * all three; the feature that first uses one makes the member required and
	 * updates those hosts in the same change.
	 */
	addStatusBarItem?(): HTMLElement;
	/**
	 * Adds an icon to Obsidian's ribbon, the bar down the left edge, and hands
	 * back its element. `callback` runs on a click.
	 *
	 * **Call it from `onload` onwards, never while the feature is being built.**
	 * It throws there, saying so, for the reason {@link addStatusBarItem} gives.
	 *
	 * **Hidden on switch-off, not removed.** Obsidian's `Plugin.addRibbonIcon`
	 * (`obsidian.d.ts:4938`) is the only ribbon route the file declares:
	 * `WorkspaceRibbon` (`:8376`) has no members, so nothing withdraws an item.
	 * Obsidian keeps every icon in its own list, redraws the bar from it, and
	 * lists it in its ribbon menu (Settings, Appearance, Ribbon). So the core
	 * adds one icon per `title`, the first time you ask, and keeps it for the
	 * session. Switched off, the icon is hidden by a style that survives the
	 * redraw and a click on it does nothing, though its entry stays in the
	 * ribbon menu under its title. Switched on again, call this again with the
	 * same `title`: you get the same element back, the callback is the new one,
	 * and the menu still lists one entry. `icon` counts the first time only.
	 */
	addRibbonIcon?(icon: IconName, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement;
	/**
	 * Registers a view type — a pane of your own, such as a list in the right
	 * sidebar — that draws only while the feature runs. `viewCreator` is what
	 * Obsidian calls to make one when a tab of this type is opened.
	 *
	 * **Call it from `onload` onwards, never while the feature is being built.**
	 * It throws there, saying so, for the reason {@link addStatusBarItem} gives.
	 *
	 * **Switched off, every open tab of this type is closed**
	 * (`Workspace.detachLeavesOfType`, `obsidian.d.ts:8021`), so nothing a
	 * feature that is not running drew stays on screen. The type itself is not
	 * withdrawn from Obsidian: `obsidian.d.ts` declares `registerView` (`:4974`)
	 * and no route that undoes it — grepped on 2026-10-09, the file's only
	 * `unregister…` members are `MarkdownPreviewRenderer.unregisterPostProcessor`
	 * (`:4047`) and `Scope.unregister` (`:5550`). A type stays claimed until the
	 * plugin unloads, and a second claim on it throws (inferred from
	 * Obsidian's behaviour, as for code blocks in
	 * {@link registerMarkdownCodeBlockProcessor}; the stub models it).
	 *
	 * So the first call for a type registers one creator of the core's own with
	 * Obsidian, kept for the session. While the feature runs it forwards to the
	 * creator you registered last; otherwise it makes an empty tab, which can
	 * happen for a tab opened after the feature was switched off in the same
	 * session. A feature switched off at startup never registers the type, so a
	 * restored layout's tab of it is not made by the core. Registering again —
	 * from each `onload` — only changes where it forwards, so one type is
	 * claimed once, never twice.
	 */
	registerView?(type: string, viewCreator: ViewCreator): void;
	/**
	 * A handle onto this feature's own stored settings, and nothing else.
	 *
	 * It may be taken in the constructor: the handle finds its feature when it
	 * is read or written, not when it is taken.
	 *
	 * **Take it there, but do not use it there.** The same holds for `problems`
	 * above, and the four members between them refuse outright. All six are
	 * keyed to this feature, and the core has no feature to key them to until
	 * the constructor has returned — so
	 * `private readonly own = this.host.settings({ days: 7 })` is fine and
	 * `private readonly days = this.host.settings({ days: 7 }).read().days` is
	 * not. The second throws, saying this. Read, write and
	 * report from `onload` onwards.
	 */
	settings<T extends object>(defaults: T): FeatureSettings<T>;
	/**
	 * Asks to be told whenever the core settings change — the vault layout, the
	 * calendar columns — and hands back the one way to stop being told.
	 *
	 * A feature reads `core` off this host without ever writing it, so nothing
	 * else tells it that a change landed. This fires on every core save that
	 * changes memory, not only a restore — `settings(...).onChange` already
	 * covers a restore, for the feature's own slice and the core alike
	 * (`SettingsStore.onCoreChange` in `src/core/settings.ts` has the full
	 * contract, #651).
	 *
	 * **Call it from `onload` onwards, never while the feature is being built.**
	 * It throws there, saying so, for `addCommand`'s reason: until the
	 * constructor has returned there is no feature to drop the listener when it
	 * is switched off.
	 *
	 * **Optional, unlike the members above**, so a host a test built by hand
	 * before this member existed still satisfies this interface unchanged. The
	 * one host that matters — `FeatureRegistry.hostFor`'s own — always supplies
	 * it; a feature that finds it missing is standing on a stand-in a test
	 * built for a narrower purpose, and simply goes without the signal.
	 */
	onCoreChange?(listener: SettingsChanged): () => void;
}

/**
 * Extend this to add a feature, then register the factory in `main.ts`.
 *
 * `onload` and `onunload` are Obsidian's own — the core calls neither directly.
 * The host arrives through the constructor rather than through `onload`, because
 * `Component.onload()` is Obsidian's method and takes no arguments.
 */
export abstract class Feature extends Component {
	/** Stable. It keys this feature's settings and prefixes its command ids. */
	abstract readonly id: string;
	/** Shown on the settings screen. */
	abstract readonly name: string;
	/** One line saying what the feature does, shown when it is running. */
	abstract readonly description: string;
	/**
	 * The name of every row {@link displaySettings} draws whose name is fixed,
	 * so Obsidian's settings search finds this feature's card by any of them
	 * without the card being drawn. A name that
	 * comes from data — a sequence's own name — is not one of them.
	 *
	 * None by default, for a feature that draws no named row.
	 * `settingsSearchAliases.test.ts` draws every feature's body and holds this
	 * list to what it draws, so a renamed row cannot drop out of search
	 * unnoticed.
	 */
	readonly settingNames: readonly string[] = [];

	constructor(protected readonly host: FeatureHost) {
		super();
	}

	/**
	 * Whether the feature has what it needs. Only the feature knows its own
	 * shape, so only the feature can say what is missing.
	 */
	abstract readiness(): Readiness;

	/**
	 * Draws this feature's settings, if it has any. The core supplies the card
	 * around them and the on/off switch above them.
	 *
	 * `changed` is how the feature says that what it stores has changed. The
	 * badge, the status line and the running count above the card are the core's
	 * own drawing, built from what {@link readiness} answers, and a feature can
	 * reach none of them — so a panel that saved something readiness reads used
	 * to leave all three showing the state from before the edit until the plugin
	 * was reloaded.
	 *
	 * It is handed in rather than fetched, so a feature still cannot see the
	 * core: calling it is the whole of what a feature may do to the screen
	 * around it. A feature that never calls it draws exactly as it did before
	 * this argument existed, which is why every override that ignores it is
	 * correct and unchanged.
	 *
	 * `announceDeferredSaveFailure` is the settings screen's one announcer for a
	 * failed deferred write, handed in for the same reason and on the same
	 * terms. The store answers every deferred caller inside the typing window
	 * with one promise, whichever route it came by, so a run of typing that
	 * crosses a core box and a box in a feature's panel is one write — and a
	 * panel holding an announcer of its own told that one failure a second time
	 * (#569, the
	 * #254 shape across the
	 * feature boundary). Calling it says a failure out loud, once for the run;
	 * it is not a way to see anything. A caller with no screen around the
	 * panel — a test — passes nothing, and a panel that defers a write then
	 * builds its own.
	 */
	displaySettings(
		_containerEl: HTMLElement,
		_changed: SettingsChanged,
		_announceDeferredSaveFailure?: SaveFailureAnnouncer,
	): void {}

	/**
	 * The line this feature's closed row on the settings screen shows while it
	 * runs, or `null` for the row to keep showing {@link description}.
	 *
	 * **Optional, like `onCoreChange` on the host**, so every feature that
	 * never had one — and every test that builds a feature by hand — draws
	 * exactly as before: no answer means the description. Today's one user is
	 * Review, whose row says how many notes are waiting.
	 *
	 * **A line is a reading of now, not a copy made for the row.** The screen
	 * asks it at every draw and when {@link onLiveLineChange} fires; a feature
	 * answers from the same computation as everything else it shows. Review
	 * returns the line it last computed (`this.line`), which is the same
	 * answer kept once rather than a second one, so the row and the status-bar
	 * count never differ. It is only asked of a running feature:
	 * a row that reads off, failed or not configured says why in the core's own
	 * sentence, and no live line replaces that.
	 */
	liveLine?(): string | null;

	/**
	 * Asks to be told when {@link liveLine} would answer something else than it
	 * did, and hands back the one way to stop being told. This is how an open
	 * settings screen keeps a row from showing a line that is already over.
	 *
	 * **The listeners live on the feature, not on `register`.** `register`'s
	 * callbacks run when the feature is switched off, and the screen listening
	 * is not switched off with it: if they ran there, a screen open across a
	 * switch-off and back on would be left holding a stopper that had already
	 * fired and hear nothing from the second run. The screen takes its own
	 * listener away when it closes, in the settings tab's `hide()`.
	 *
	 * Present on every feature, so the screen can listen to all of them
	 * without asking which gives a line; a feature that never announces one
	 * simply never fires it.
	 */
	onLiveLineChange(listener: () => void): () => void {
		this.liveLineListeners.add(listener);
		return () => {
			this.liveLineListeners.delete(listener);
		};
	}

	private readonly liveLineListeners = new Set<() => void>();

	/**
	 * Tells everyone listening that {@link liveLine} now answers something
	 * else. Call it when the answer has changed and not otherwise — a feature
	 * that fires on every recompute makes the screen redraw a line nothing
	 * changed in. A copy of the set is walked, so a listener that stops itself
	 * while being told does not skip the next one.
	 */
	protected liveLineChanged(): void {
		for (const listener of [...this.liveLineListeners]) listener();
	}
}

/**
 * How a feature says that what it stores has changed, so the core can ask every
 * feature about its readiness again and redraw the settings screen.
 *
 * Call it after a save that actually happened, and only then. The intent is
 * that a failed save is not reported, because re-checking on the strength of it
 * would be re-checking a change nobody made.
 *
 * **What a failed save leaves behind is the store's to say**, and it says it on
 * `SettingsStore.queueWrite` in `src/core/settings.ts`. The store writes a
 * feature's slice into memory before it writes the file; when the write rejects
 * and no other write is going to carry the change, it puts memory back to what
 * `data.json` holds before the feature hears the rejection. So after a failed
 * press a feature that redraws its own section from the store draws what is
 * stored, and the badge and the count this callback would rebuild are already
 * right. When another write is queued or a typed change is waiting on its
 * timer, memory keeps the newer answers, because that write is about to put
 * them in the file.
 *
 * **The store uses the same shape for the one change nobody reports**: putting
 * memory back after a refused write that was not necessarily the reader's own
 * (`SettingsStore.onChange`, and `FeatureSettings.onChange` on a feature's
 * handle). The settings screen answers both the same way, and a feature that
 * keeps something in step with its slice registers for the store's.
 */
export type SettingsChanged = () => void;

/** How the core makes a feature. Constructing one must be cheap and side-effect free. */
export type FeatureFactory = (host: FeatureHost) => Feature;

/**
 * What a feature's suggester may declare to be told that the person dismissed
 * its popup.
 *
 * Obsidian hands one `close()` to the suggester it is running for every kind of
 * dismissal — Escape, a click outside — and cannot tell them apart. Since
 * #574 the one it runs is
 * the core's, and a feature had no way to learn this at all. An override of
 * `close()` on your suggester does run, but for every close alike, the
 * plugin's own included,
 * so it cannot tell you either.
 *
 * Declare `onDismissed()` and the core calls it for a close the person made,
 * just after the popup is gone. **It is not called for a close the plugin made**
 * — your own `close()` after a choice, or the core closing the popup when the
 * feature is switched off — because neither is the person dismissing anything,
 * and a feature that silenced a trigger on a switch-off would silence one the
 * person never touched.
 *
 * Declaring it is optional: a suggester without it is left alone.
 */
export interface DismissibleSuggester {
	/** Called once, after the popup the person dismissed has closed. */
	onDismissed(): void;
}
