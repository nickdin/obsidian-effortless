/**
 * The core's list of features, and the switch that turns each one on and off.
 *
 * The core knows nothing about which features happen to exist. It knows only
 * how to make one, how to load it, how to unload it, and what state to report
 * for it — so adding a seventh feature changes `main.ts` and nothing here.
 *
 * A feature that throws while loading is caught: it is taken back off the
 * plugin, marked failed, the user is told once, and every other feature carries
 * on. Taking it off matters as much as the catch — Obsidian attaches a
 * component before running its `onload`, so a feature left on after a failure
 * would report running the next time it was switched on.
 *
 * A feature that throws while it is being *built* is caught too, and it leaves
 * less behind: the user is told once and there is no entry at all, so the
 * settings screen draws no row for it. There is nothing to mark failed, because
 * a row is drawn from a feature and that feature was never made.
 */

import { EditorSuggest, ItemView, MarkdownView, Notice, Scope } from "obsidian";
import type {
	App,
	Command,
	Editor,
	EditorPosition,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	IconName,
	Instruction,
	MarkdownPostProcessorContext,
	Plugin,
	TFile,
	ViewCreator,
	WorkspaceLeaf,
} from "obsidian";
import { Feature } from "./feature";
import type {
	DismissibleSuggester,
	FeatureFactory,
	FeatureHost,
	Readiness,
	SettingsChanged,
} from "./feature";
import type { NoteWriter } from "./noteWriter";
import type { Calendar } from "./calendarSources";
import type { Collections } from "./collections";
import type { SharedParts } from "./coreParts";
import { openingFence } from "./markdownSections";
import { gatedProblems } from "./problems";
import { reasonOf } from "./reason";
import type { FeatureProblems, Problems } from "./problems";
import type { SaveFailureAnnouncer } from "./saveFailureAnnouncer";
import type { DeviceStore, FeatureSettings, SettingsStore } from "./settings";

/**
 * The seven states a feature can be in, listed in the order they win in. A
 * feature is in exactly one of them, so the settings screen draws exactly one
 * badge per row.
 *
 * The order is fixed by the spec
 * and every pair in it follows one rule: say the thing the person can act on,
 * and never show a stored answer this device cannot honour.
 *
 * 1. `failed` — loading threw. A feature that could not start cannot report
 *    anything else.
 * 2. `unavailable` — the feature says this device cannot run it. It beats the
 *    stored switch, because that switch travelled here from another device.
 * 3. `off` — the person switched it off.
 * 4. `standby` — the feature stood itself down because another device does the
 *    job. It loses to `off`, because `off` is the person's own answer.
 * 5. `unconfigured` — settings are missing.
 * 6. `notStarted` — switched on, and nothing of it is attached. It loses to
 *    `unconfigured`, because missing settings are something the person can act
 *    on and this is not. See below for how a feature gets here.
 * 7. `running` — switched on and attached.
 *
 * `notStarted` is the state that keeps `running` honest. Readiness is asked
 * twice and separately — once by `load`, once by `stateOf` — and a feature
 * reading the platform, a settings value or a cached file can answer
 * differently each time. A feature that refused the load and then tells the
 * screen it is ready would otherwise be badged running while nothing of it
 * exists. A feature registered after `start()` reaches the same place;
 * `main.ts` registers before starting, so no shipped path does that today.
 *
 * It wears the `off` badge, the way `standby` does: the screen has five badges
 * and #26 weighed a sixth
 * and rejected it. The row's sentence is what says which of the three it is.
 */
export type FeatureState =
	| "failed"
	| "unavailable"
	| "off"
	| "standby"
	| "unconfigured"
	| "notStarted"
	| "running";

export interface FeatureStatus {
	id: string;
	name: string;
	description: string;
	state: FeatureState;
	/**
	 * Why, for the states that have a why: what is missing when `unconfigured`,
	 * what threw when `failed`, why not here when `unavailable`, which device
	 * does it instead when `standby`, and what to do about it when
	 * `notStarted`. Absent for `running` and `off`.
	 */
	detail?: string;
	/**
	 * The feature's own line for a `running` row, when it gives one
	 * ({@link Feature.liveLine}); absent otherwise, and the row shows
	 * `description`. Only a running feature is asked.
	 */
	line?: string;
	/**
	 * The fixed names of the rows the feature's settings body draws
	 * ({@link Feature.settingNames}), which the settings screen hands Obsidian
	 * as its card's search terms. Optional only so a status a test builds by
	 * hand need not carry it; the registry always fills it.
	 */
	settingNames?: readonly string[];
}

interface Entry {
	/**
	 * Null while the factory that makes it is still running, and never again.
	 *
	 * `hostFor` needs the entry before there is a feature to put in it — the
	 * host is what the factory is handed — so every deferred read on that host
	 * has a window in which there is nothing to read. Saying so in the type is
	 * what makes each of those reads answer for that window rather than reach
	 * through it and throw a `TypeError` about `null`.
	 */
	feature: Feature | null;
	loaded: boolean;
	/**
	 * Whether the core still listens to this feature's problem handle.
	 *
	 * Not the same question as `loaded`, and it is on for a shorter time. It
	 * goes on as the load attempt begins, because Obsidian runs `onload` while
	 * attaching the feature and a feature may report from there. It goes off
	 * again the moment the feature stops running, whether that was the person
	 * switching it off or a load that threw.
	 *
	 * A feature keeps whatever handle it took, and a debounced re-check queued
	 * before the switch-off fires after it. This is what makes that late call
	 * do nothing: a report from a feature that is not running is not news for
	 * the person, and there is nobody left to clear the row it would leave.
	 */
	accepting: boolean;
	/** Full command ids registered by this feature, to remove when it unloads. */
	commandIds: string[];
	/**
	 * The one suggester registered with the plugin for this feature, made the
	 * first time the feature asks and kept for the rest of the session, because
	 * Obsidian cannot take it back.
	 * Null until then.
	 */
	suggester: GatedSuggester | null;
	/**
	 * The code-block renderers registered with the plugin for this feature, one
	 * per language, each made the first time the feature asks for its language
	 * and kept for the rest of the session, because Obsidian cannot free a
	 * language again before the plugin unloads.
	 */
	renderers: Map<string, GatedRenderer>;
	/**
	 * The status-bar items this feature holds, to remove when it stops. Obsidian
	 * removes one only when the whole plugin unloads (`obsidian.d.ts:4947`), so
	 * taking them back is the registry's job.
	 */
	surfaces: HTMLElement[];
	/**
	 * The ribbon icons registered for this feature, one per title, made the first
	 * time the feature asks for its title and kept for the rest of the session.
	 * Obsidian's ribbon keeps its own list of items and redraws the bar from it
	 * (`obsidian.d.ts:8376` declares `WorkspaceRibbon` with no members), and
	 * `obsidian.d.ts:4938` declares `addRibbonIcon` and nothing that withdraws an
	 * item, so a removed element comes back on the next redraw.
	 */
	ribbonIcons: Map<string, GatedRibbonIcon>;
	/**
	 * The view types registered with the plugin for this feature, one creator
	 * each, made the first time the feature asks for its type and kept for the
	 * rest of the session, because `obsidian.d.ts` declares no route that
	 * withdraws a view type (`registerView` `:4974` is the only one).
	 */
	views: Map<string, GatedView>;
	/** Set when loading threw. Cleared when the feature loads cleanly again. */
	failure?: string;
}

export class FeatureRegistry {
	private readonly entries = new Map<string, Entry>();

	/**
	 * Which open tabs have a `rebuild` in flight, and whether another was asked
	 * for before that one finished. See `scheduleRebuild`.
	 */
	private readonly rebuilding = new Map<WorkspaceLeaf, boolean>();

	/** Gives up the store's reload listener; set by {@link start}, dropped by {@link stop}. */
	private stopFollowing: (() => void) | null = null;

	private readonly settings: SettingsStore;
	private readonly collections: Collections;
	private readonly problems: Problems;
	private readonly device: DeviceStore;

	/**
	 * The core's parts as one object, so the registry and the settings screen
	 * cannot be handed different instances of the four they share. It is the
	 * four the two of them share, because the registry is itself one of the
	 * core's parts and cannot be handed the finished bundle. `notes` and
	 * `calendar` stay positional: only the registry reaches either, so neither
	 * is anything two places must agree on.
	 */
	constructor(
		private readonly plugin: Plugin,
		parts: SharedParts,
		private readonly notes: NoteWriter,
		private readonly calendar: Calendar,
	) {
		this.settings = parts.settings;
		this.collections = parts.collections;
		this.problems = parts.problems;
		this.device = parts.device;
	}

	/**
	 * Makes the feature and records it. Nothing is loaded yet: constructing a
	 * feature must be cheap, because a feature the user has switched off — or
	 * that this device cannot run at all — is still constructed so its name and
	 * settings can be shown.
	 *
	 * The id is passed in as well as declared on the feature, so that the core
	 * knows it before anything is built. That is what lets the duplicate check
	 * run first: a second feature claiming a taken id is refused before its
	 * factory runs, so it cannot be fully constructed, hold a live host closure
	 * and register commands nothing tracks.
	 *
	 * A factory that throws takes only itself down. The person is told once and
	 * no entry is added, so `onload` finishes, every other feature registers,
	 * and the settings screen opens. Nothing of it is left behind either: the
	 * host refuses `addCommand` while the feature is being built, so a discarded
	 * entry can hold no command that nothing is left to remove.
	 */
	register(id: string, factory: FeatureFactory): void {
		if (this.entries.has(id)) {
			throw new Error(`Two features claim the id "${id}"; ids must be unique.`);
		}
		const entry: Entry = {
			feature: null,
			loaded: false,
			accepting: false,
			commandIds: [],
			suggester: null,
			renderers: new Map(),
			surfaces: [],
			ribbonIcons: new Map(),
			views: new Map(),
		};
		let feature: Feature;
		try {
			feature = factory(this.hostFor(entry));
		} catch (error) {
			new Notice(`Effortless: the ${id} feature could not be built. ${reasonOf(error)}`);
			return;
		}
		// The id is written twice — here and on the feature — and the two must
		// not drift: the settings and commands of a feature registered under one
		// id and calling itself another would be filed under different names.
		// A mismatch is a mistake in `main.ts` rather than a feature failing, so
		// it is not caught anywhere: it has to be seen and fixed.
		if (feature.id !== id) {
			throw new Error(
				`The feature registered as "${id}" calls itself "${feature.id}"; the two must match.`,
			);
		}
		entry.feature = feature;
		this.entries.set(id, entry);
	}

	/** Loads every registered feature the user has not switched off. */
	start(): void {
		for (const [id, entry] of this.entries) {
			if (this.settings.isEnabled(id)) this.load(entry);
		}
		this.stopFollowing ??= this.settings.onReloaded(() => this.followStoredSwitches());
	}

	/**
	 * Brings every feature into line with the switches the store now holds, and
	 * asks each again whether it is ready, after `data.json` was changed from
	 * outside and the store reloaded it: a feature
	 * switched off in the file stops, one switched on starts, as if the person
	 * had flipped the switch here.
	 *
	 * **The rule above {@link reconcileLoaded} holds, and is the reason this
	 * goes through it.** A reload is not the person asking, so a feature whose
	 * start failed is left failed whatever the file says, off or on, in any
	 * number of reloads. A switch
	 * Sync carries in from another device is a device-switch, not the person
	 * here switching it on. Stopping a feature clears its failure, so a
	 * failed one is skipped here rather than stopped: only the person's own
	 * switch in this device's settings (`setEnabled`) clears it.
	 */
	private followStoredSwitches(): void {
		for (const [id, entry] of this.entries) {
			if (entry.failure !== undefined) continue;
			this.reconcileLoaded(id, entry, false);
		}
		// The switches are not all a reload can change. Readiness reads the core
		// layout and each feature's own slice, and both arrive in the file too, so
		// the question `recheckReadiness` is documented for — "something a
		// feature's readiness reads has changed" — has been asked. Its rule
		// holds: a feature that failed to start stays failed.
		this.recheckReadiness();
	}

	/**
	 * Stands every feature down, so none of them may report a problem again.
	 *
	 * The counterpart to `start()`, and it is not a switch: nothing here is
	 * stored, no row changes and no feature is told anything. It closes the one
	 * channel that outlives the plugin. A feature keeps whatever problem handle
	 * it took, and a debounced re-check queued a moment before the unload fires
	 * after it — through a handle whose `Notice` and whose settings screen both
	 * belong to a plugin that is gone.
	 *
	 * Switching a feature off does this one entry at a time, in `unload`. There
	 * is no route from an unload of the whole plugin to that method, because
	 * Obsidian never calls it: it detaches the features itself.
	 *
	 * `main.ts` calls this from two places, and the order between them is the
	 * point. Its `unload` override calls it first, before anything is detached.
	 * `Plugin.register` was the only route until then, and it is not early
	 * enough on its own: `Component.unload()` runs its children before the
	 * callbacks given to `register`, so every feature had already been detached
	 * and each one's own `onunload` had already run — with `accepting` still on
	 * — by the time the registered cleanup fired. A feature reporting from its
	 * own teardown still reached a `Notice`. The
	 * registration stays as the backstop: it covers a disable, a vault reload
	 * and a plugin update alike, Obsidian owns it, and calling this twice is
	 * harmless.
	 *
	 * It unloads nothing on purpose. `Component.unload()` detaches every child
	 * the plugin has, so unloading the features here would be doing it twice —
	 * and doing it first, through a path whose `removeChild` failures the person
	 * would be told about while the plugin is disappearing.
	 *
	 * One route brings an entry back and the obvious one does not. `setEnabled`
	 * with `true` calls `load`, and for an entry that is not loaded, does not
	 * stand down and starts cleanly, that reaches `accepting = true` — so the
	 * person's own switch reopens the channel. All three conditions are needed,
	 * because two kinds of not-loaded entry come out of `load` with the channel
	 * still shut. A feature that stands down for this device returns inside the
	 * stand-down branch, above the line that opens the channel, and stays not
	 * loaded. A feature whose start throws does reach that line — it sits ahead
	 * of the attach on purpose, so a feature reporting from its own `onload` is
	 * heard — and then the attach throws and `detachFailed` shuts the channel
	 * again. Standing either of those back up leaves the person a feature that
	 * still cannot report.
	 *
	 * A second `start()` reopens nothing: it calls `load` for every enabled
	 * feature, and `load`'s first line returns on `entry.loaded`, so every
	 * feature that was running when this ran keeps `accepting: false`. That is
	 * features loaded, attached and running, unable to report a single problem,
	 * with nothing anywhere saying why — whoever gives this registry a restart
	 * has to reopen the channel deliberately.
	 *
	 * Neither route fires today. `main.ts` builds one registry, calls `start()`
	 * once and discards it after the unload — an unloaded plugin is not
	 * restarted, it is built again — and a plugin that has gone has no settings
	 * screen to switch anything from.
	 */
	stop(): void {
		this.stopFollowing?.();
		this.stopFollowing = null;
		for (const entry of this.entries.values()) entry.accepting = false;
	}

	/** One row per feature, in registration order, for the settings screen. */
	statuses(): FeatureStatus[] {
		return [...this.entries].map(([id, entry]) => ({
			id,
			name: this.featureIn(entry).name,
			description: this.featureIn(entry).description,
			settingNames: this.featureIn(entry).settingNames,
			...this.withLine(entry, this.stateOf(id, entry)),
		}));
	}

	/**
	 * Adds the feature's own line to a `running` state, when it gives one. A
	 * feature whose line throws is a failed feature, as one whose readiness
	 * throws is (`stateOf`), not a settings screen that cannot draw.
	 */
	private withLine(
		entry: Entry,
		state: { state: FeatureState; detail?: string },
	): { state: FeatureState; detail?: string; line?: string } {
		if (state.state !== "running") return state;
		let line: string | null | undefined;
		try {
			line = this.featureIn(entry).liveLine?.();
		} catch (error) {
			return { state: "failed", detail: reasonOf(error) };
		}
		return line === null || line === undefined ? state : { ...state, line };
	}

	/**
	 * Asks to be told when any feature's {@link Feature.liveLine} would answer
	 * something else, and hands back the one way to stop being told. The
	 * settings screen listens while it is open, so a row never shows a line that
	 * is already over.
	 *
	 * Covers the features registered when it is called, which is all of them
	 * once `main.ts` has registered the lot. The listener lives on each feature
	 * and not on its load, so it keeps hearing across a switch-off and back on.
	 */
	onLiveLineChange(listener: () => void): () => void {
		const stops = [...this.entries.values()].map((entry) => this.featureIn(entry).onLiveLineChange(listener));
		return () => {
			for (const stop of stops) stop();
		};
	}

	/**
	 * Stores the person's answer for one feature, and loads or unloads it to
	 * match.
	 *
	 * A redundant answer is accepted, and the two directions are accepted for
	 * different reasons. `true` for a feature already on genuinely changes
	 * nothing but the stored answer: `load` returns on `entry.loaded` before it
	 * touches anything. `false` for one already off is not a no-op. `unload`
	 * runs the cleanups that sit ahead of its own loaded guard, and one of them
	 * takes the feature's commands back out of the palette — a feature that was
	 * constructed and never started can be holding one, because the settings
	 * screen draws such a feature's own settings on purpose, and having that
	 * command taken back is what moving the cleanup ahead of the guard was for. So the
	 * redundant switch-off is accepted because the work it still does is work
	 * worth doing, not because there is none. The settings screen's toggle never
	 * sends one — it hands over the flipped value alone — so any caller that
	 * does is reaching this method directly, and the load path's failure clear
	 * is written for that caller rather than for the screen.
	 *
	 * **This call's own write to the store is not always the one that decides
	 * the stored answer.** It queues behind whatever else is open, and a write
	 * queued behind *that* can reject while carrying this one's flip into the
	 * file regardless — `this.settings.setEnabled` rejects only when nothing
	 * carries the change, but rejects here whenever this call's own write
	 * fails, carried or not. A caller that reached `load`/`unload` only on a
	 * landed await used to leave the feature running (or not started) against
	 * what the switch, the badge and the file went on to agree on, until the
	 * next reload.
	 * So a rejection here does not end the call: it waits for the store to
	 * finish whatever is still queued (`SettingsStore.flush`, which never
	 * itself rejects) and then loads or unloads the entry to match whatever
	 * the stored answer settled to — which may or may not be `on`, and may
	 * already match `entry.loaded`, in which case `load`/`unload` do the same
	 * nothing or the same redundant cleanup they always do — except for a
	 * feature whose start failed, which is left alone unless this call asked
	 * for it to be on (`reconcileLoaded`, #604). The caller still
	 * hears the original rejection: the value settling is not the same thing
	 * as this call's own write having landed, and every other route into the
	 * store keeps that caller's notice on a failure of its own
	 * (`settings.ts`, `queueWrite`).
	 */
	async setEnabled(id: string, on: boolean): Promise<void> {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`No feature with the id "${id}".`);
		try {
			await this.settings.setEnabled(id, on);
		} catch (error) {
			await this.settings.flush();
			this.reconcileLoaded(id, entry, on);
			throw error;
		}
		if (on) this.load(entry);
		else this.unload(entry);
	}

	/**
	 * Loads or unloads an entry to match whatever the store's memory has
	 * settled to for its id, once nothing is left queued to change it further.
	 *
	 * Two call sites. `setEnabled`'s catch calls it after `flush()` — not
	 * before, because a write may still be queued behind the one that just
	 * rejected, and that write, landing or rejecting in its turn, is what the
	 * stored answer is still waiting on. `followStoredSwitches` calls it for
	 * every feature after a reload of `data.json` except one with a recorded
	 * failure, which a reload leaves alone,
	 * where the stored answers are the ones the reload has just put in memory.
	 *
	 * **A feature whose start already failed is started again only where this
	 * call asked for it to be on.** `recheckReadiness` refuses the same retry
	 * for the same reason:
	 * nothing brings a failed feature back on its own, because a failure the
	 * person has already been told about would be reported again with nothing
	 * new behind it. Switching it on is the person asking for the retry, and is
	 * the one thing that gets one; a switch-*off* whose write was refused leaves
	 * the stored answer saying on, and reconciling to that must not be read as
	 * the person asking.
	 */
	private reconcileLoaded(id: string, entry: Entry, asked: boolean): void {
		if (!this.settings.isEnabled(id)) {
			this.unload(entry);
			return;
		}
		if (entry.failure !== undefined && !asked) return;
		this.load(entry);
	}

	/**
	 * Draws one feature's own settings. Works whether or not it is loaded.
	 *
	 * `changed` is passed straight through and is never called here: what the
	 * screen does when a feature reports a change is the screen's own business,
	 * and the registry's part in it is `recheckReadiness`, which the screen
	 * calls itself.
	 *
	 * `announceDeferredSaveFailure` is passed straight through on the same terms:
	 * the screen owns its one announcer, and the registry only carries it.
	 */
	displaySettings(
		id: string,
		containerEl: HTMLElement,
		changed: SettingsChanged,
		announceDeferredSaveFailure?: SaveFailureAnnouncer,
	): void {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`No feature with the id "${id}".`);
		this.featureIn(entry).displaySettings(containerEl, changed, announceDeferredSaveFailure);
	}

	/**
	 * Asks every feature again whether it should be running here, and loads or
	 * unloads it to match.
	 *
	 * Called when something a feature's readiness reads has changed. Two things
	 * ask for it. The device answer — which device builds the days — changes
	 * while the plugin is running, so a feature that stood itself down has to be
	 * able to start without a reload, and one that now stands down has to stop.
	 * And since #553 a
	 * feature asks for it itself, from inside its own settings body, when what
	 * it stores changes in a way its readiness reads.
	 *
	 * A feature the person has switched off is left alone whatever it answers:
	 * the switch is their own answer and nothing a feature says about itself may
	 * overrule it.
	 *
	 * So is a feature that already failed to start. Retrying a failed load is
	 * the person's own switch and nothing else: someone
	 * answering a question about which device builds the days has not asked for
	 * anything to be retried, and every flip of that switch used to raise the
	 * same failure notice again for a failure they had already been told about.
	 *
	 * The consequence, taken deliberately: a feature that failed at start-up,
	 * whose cause the person then fixes, does not come back on a device-switch
	 * flip. They switch that feature off and on, which is what `NOT_STARTED` and
	 * the failed row already tell them to do.
	 */
	recheckReadiness(): void {
		for (const [id, entry] of this.entries) {
			if (!this.settings.isEnabled(id)) continue;
			if (entry.loaded) {
				if (this.mustStandDown(entry)) this.unload(entry);
			} else if (entry.failure === undefined) {
				// `load` asks the same question again and refuses on the same two
				// answers, so a feature that must still stand down stays down.
				this.load(entry);
			}
		}
	}

	/**
	 * Whether a running feature's own answer now says it must stop.
	 *
	 * A feature that cannot answer at all is left running: its row already reads
	 * `failed` with what the question threw, and taking a running feature off on
	 * the strength of a question it could not answer is a decision no ticket has
	 * taken.
	 */
	private mustStandDown(entry: Entry): boolean {
		try {
			return standsDown(this.featureIn(entry).readiness());
		} catch {
			return false;
		}
	}

	/** The precedence `FeatureState` documents, in the order it documents it. */
	private stateOf(id: string, entry: Entry): { state: FeatureState; detail?: string } {
		if (entry.failure !== undefined) return { state: "failed", detail: entry.failure };
		// Asked before the switch, so every row — including the switched-off ones
		// — asks it on every draw of the settings screen. A feature that cannot
		// answer is a failed feature, not an empty settings screen.
		let readiness: Readiness;
		try {
			readiness = this.featureIn(entry).readiness();
		} catch (error) {
			return { state: "failed", detail: reasonOf(error) };
		}
		if (readiness.state === "unavailable") {
			return { state: "unavailable", detail: readiness.reason };
		}
		if (!this.settings.isEnabled(id)) return { state: "off" };
		if (readiness.state === "standby") return { state: "standby", detail: readiness.reason };
		if (readiness.state === "unconfigured") {
			return { state: "unconfigured", detail: readiness.reason };
		}
		// The one field that records whether the component is actually live.
		// Everything above this line is derived from what the feature says and
		// what the person stored, and neither of those knows whether the load
		// ever happened.
		if (!entry.loaded) return { state: "notStarted", detail: NOT_STARTED };
		return { state: "running" };
	}

	private load(entry: Entry): void {
		if (entry.loaded) return;
		try {
			// A feature that says this device cannot run it — or that another
			// device has been given the job — is constructed but never loaded, so
			// its settings still open and can still be edited here for the device
			// that will run it. The question is asked at every start and the answer
			// is never stored. It is asked inside the catch because a feature that
			// cannot answer must take only itself down.
			if (standsDown(this.featureIn(entry).readiness())) {
				// A feature that stands down is no longer a feature that failed,
				// so the record goes with the feature it described. Left standing,
				// it read `failed` on a row whose truth is `standby`, and
				// `recheckReadiness` skipped the feature for ever after.
				//
				// No screen reaches this line with a failure still recorded. The
				// settings screen's toggle hands over the flipped value alone, so
				// `setEnabled(id, true)` never arrives for a feature already on;
				// `start()` runs once, before any failure exists; a reload calls
				// `load()` on stood-down features too, but through
				// `recheckReadiness`, which refuses a feature that has a failure,
				// and `reconcileLoaded`, which refuses one too, unless the call it
				// came from asked for the feature to be on, which is the person
				// asking for this retry. The clear is
				// here for callers of `setEnabled` other than that toggle — it is
				// a public method, and making its correctness depend on one
				// screen's toggle semantics is the cross-coupling the feature
				// contract exists to prevent.
				entry.failure = undefined;
				return;
			}
			// Before the attach, not after it: `addChild` runs the feature's
			// `onload`, and a feature that finds something wrong there reports
			// it from there.
			entry.accepting = true;
			this.plugin.addChild(this.featureIn(entry));
			entry.loaded = true;
			entry.failure = undefined;
		} catch (error) {
			this.detachFailed(entry);
			entry.failure = reasonOf(error);
			new Notice(
				`Effortless: the ${this.featureIn(entry).name} feature failed to start. ${entry.failure}`,
			);
		}
		// Only a start that took: a failed one draws plainly before and after,
		// so an open note has nothing new to show.
		if (entry.loaded) this.redrawBlocks(entry);
	}

	private unload(entry: Entry): void {
		// A switched-off feature's standing problems go with it. Nothing is left
		// to clear them, and a line the person cannot act on or get rid of is
		// worse than no line: the section exists to be believed.
		//
		// Ahead of the guard below, and unconditional, because the feature that
		// most needs clearing is the one that never finished loading. Obsidian
		// runs `onload` while attaching the feature, so a feature that reports a
		// problem and then throws leaves the report standing while the registry
		// has it as never loaded. Behind the guard, switching it off cleared
		// nothing and no other path ever would. Clearing costs nothing for a
		// feature that reported nothing.
		this.problemsFor(entry).clearAll();
		// And it may not speak again through a handle it kept. Cleared first,
		// then silenced, because the core clears through its own channel rather
		// than through the feature's.
		entry.accepting = false;
		// Ahead of the guard below and unconditional, for the same reason the
		// clear above it is: the feature that most needs its failure cleared is
		// the one that never finished loading. Behind the guard, switching a
		// failed feature off cleared nothing, so `recheckReadiness` went on
		// skipping it and switching it on again could not bring it back.
		entry.failure = undefined;
		// Ahead of the guard below and unconditional once more, and for a reason
		// of its own: `addCommand` asks only whether the feature exists yet,
		// never whether it is running, so a feature that was constructed and
		// never started can still put a command in the palette — the settings
		// screen opens such a feature's own settings on purpose. Behind the
		// guard, switching that feature off gave up before reaching the line that
		// takes commands back, and the command sat in the palette for the rest of
		// the session with nothing left able to remove it.
		//
		// The list is emptied as it is read, so the second run below costs
		// nothing unless the feature's own `onunload` added something.
		this.removeCommands(entry);
		this.removeSurfaces(entry);
		// A popup this feature has open closes now rather than at the next
		// keystroke. The suggester itself stays registered with the plugin —
		// Obsidian cannot take it back — and declines every trigger from here on,
		// because it asks `entry.loaded`, which this method ends by clearing.
		entry.suggester?.closeQuietly();
		if (!entry.loaded) return;
		try {
			this.plugin.removeChild(this.featureIn(entry));
		} catch (error) {
			// Caught so that one feature's bad exit takes only itself down: this
			// runs inside `recheckReadiness`'s loop, and a throw here stopped that
			// loop half way, so the features after it were never asked and the
			// screen that asked never redrew.
			//
			// Said out loud, unlike the one in `detachFailed`. That path has
			// already told the person their feature failed and this one has not,
			// and `~/Devbox/CLAUDE.md` § Tests and failures forbids a fallback
			// that announces nothing.
			new Notice(
				`Effortless: the ${this.featureIn(entry).name} feature did not stop cleanly. ${reasonOf(error)}`,
			);
		}
		// Below the catch, not inside the `try`: a feature that would not stop is
		// still a feature that is no longer running, and leaving its commands in
		// the palette and its entry marked loaded is the inconsistent state the
		// catch exists to prevent.
		//
		// The second run of the same line. The first one above took back what the
		// feature was holding before it was told to stop; this one takes back
		// anything it registered from its own `onunload`, which has just run.
		this.removeCommands(entry);
		this.removeSurfaces(entry);
		entry.loaded = false;
		// Below the guard, unlike the cleanups above it: a feature that never
		// loaded drew every block plainly all along, so only one that was running
		// leaves an open note showing what it drew.
		this.redrawBlocks(entry);
	}

	/**
	 * Makes every open note holding a block this feature renders draw it again,
	 * now that the feature has started or stopped.
	 *
	 * Obsidian 1.13.7 redraws nothing here by itself. Live preview reuses a drawn
	 * block for as long as its language and text are unchanged, and none of
	 * `Workspace.updateOptions`, `Editor.refresh`, `MarkdownPreviewView.rerender`
	 * or setting the view's data again changes that — each was tried in the test
	 * Obsidian. Replacing the tab's view does, in both modes, and it is published:
	 * `WorkspaceLeaf.setViewState` to an empty view, then back to the state and
	 * ephemeral state the tab had, so the note, its mode, its scroll and its
	 * cursor come back.
	 *
	 * The note is saved first. A view rebuilt over an edit not yet on disk showed
	 * the note without that edit until the save landed, in the same drive; saved
	 * first, the edit was there at once and undoing it still worked
	 * (`docs/acceptance-shots/issue-622-redraw-both-modes.txt`). What the rebuild
	 * still costs is building the whole view again, which is why a tab whose note holds no block
	 * fenced with one of these languages is left alone.
	 *
	 * It runs on without the switch waiting for it. A tab that cannot be redrawn
	 * is said out loud, once, and the rest still are. Each leaf's own rebuild is
	 * serialized by `scheduleRebuild` — see that method for why a second call
	 * reaching the same leaf is never let run alongside the first.
	 *
	 * `load()` calls this on every start that took, including `start()` loading
	 * every enabled feature at the plugin's own `onload` — not only a switch the
	 * person threw. At a cold start that has no leaf open yet, `getLeavesOfType`
	 * finds nothing and this is a no-op; enabling the whole plugin while
	 * Obsidian is already running can find a note already open and drawing the
	 * block some other way (plainly, or not at all), and that note needs
	 * exactly the redraw a feature switch does. There is no third case to tell
	 * apart, so nothing here asks which one this is.
	 */
	private redrawBlocks(entry: Entry): void {
		const languages = [...entry.renderers.keys()];
		if (languages.length === 0) return;
		for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) continue;
			const text = view.getViewData();
			if (!languages.some((language) => holdsBlockOf(text, language))) continue;
			this.scheduleRebuild(leaf, entry);
		}
	}

	/**
	 * Runs `rebuild` for one leaf, never two at once for the same leaf.
	 *
	 * `rebuild` reads the leaf's state only after its own `await view.save()`
	 * resolves. A second call reaching the same leaf while that save is still
	 * pending used to run right alongside the first: whichever of the two
	 * captured the leaf's state after the other had already swapped it to the
	 * empty view captured `empty`, and went on to "restore" it — the note gone
	 * from the tab whichever of the two settled last. So a leaf
	 * already mid-rebuild takes no second one: it is marked to run once more,
	 * with the leaf's state read fresh, only once the one in flight has swapped
	 * the tab all the way back — by which point the leaf holds no rebuild of its
	 * own to collide with.
	 */
	private scheduleRebuild(leaf: WorkspaceLeaf, entry: Entry): void {
		if (this.rebuilding.has(leaf)) {
			this.rebuilding.set(leaf, true);
			return;
		}
		const view = leaf.view;
		if (!(view instanceof MarkdownView)) return;
		this.rebuilding.set(leaf, false);
		// `void`, not a dropped failure: the rebuild's own failure is caught and
		// announced just below, and what follows it is synchronous bookkeeping.
		void rebuild(leaf, view)
			.catch((error: unknown) => {
				new Notice(
					`Effortless: a note open in ${view.file?.path ?? "a tab"} could not be redrawn after the ` +
						`${this.featureIn(entry).name} feature was switched. Close and reopen it. ${reasonOf(error)}`,
				);
			})
			.then(() => {
				const queued = this.rebuilding.get(leaf) ?? false;
				this.rebuilding.delete(leaf);
				if (queued) this.scheduleRebuild(leaf, entry);
			});
	}

	/**
	 * Takes a feature that threw back off the plugin.
	 *
	 * Obsidian's `Component.load()` marks the component loaded and attaches it
	 * before calling `onload`, so a feature whose `onload` threw is still on the
	 * plugin and still flagged loaded, while the registry has it as not loaded.
	 * Left that way, switching the feature off removes nothing and switching it
	 * on again attaches a second copy whose `load()` sees itself already loaded,
	 * never re-enters `onload`, and so reports running for a feature that never
	 * started. Detaching is what makes switching it off and on a real retry.
	 *
	 * Unloading a feature that failed halfway can throw in its turn. It has
	 * already been reported as failed and there is nothing further to do for it,
	 * so that throw is not allowed to bury the first one.
	 */
	private detachFailed(entry: Entry): void {
		// It is not running, so it may not report again. What it managed to say
		// before it threw stays standing until the person switches it off, which
		// is the one thing that clears it.
		entry.accepting = false;
		try {
			this.plugin.removeChild(this.featureIn(entry));
		} catch {
			// Reported as failed either way; the first failure is the useful one.
		}
		this.removeCommands(entry);
		this.removeSurfaces(entry);
		// It was never marked loaded, so its suggester already declines; this
		// only closes a popup it could not have opened, and costs nothing.
		entry.suggester?.closeQuietly();
	}

	/**
	 * Takes back every command the feature is holding, whenever and wherever it
	 * registered them, and empties the list.
	 *
	 * Only one of the three callers is a feature that was loading. The unload
	 * path calls it ahead of its loaded guard, for a feature that was never
	 * started and registered from the settings screen, and again below the
	 * detach, for anything the feature registered from its own `onunload`; the
	 * failed-detach path calls it for a feature whose `onload` threw. Emptying
	 * the list is what makes the unload path's second call cost nothing when
	 * `onunload` registered nothing.
	 */
	private removeCommands(entry: Entry): void {
		// The list holds full ids and Obsidian wants short ones — see
		// `shortCommandId`. This is the site a person hits: it is what a
		// switch-off, a stand-down and a failed detach all reach.
		for (const commandId of entry.commandIds) {
			this.plugin.removeCommand(this.shortCommandId(commandId));
		}
		entry.commandIds = [];
	}

	/**
	 * Takes back what the feature put on screen: its status-bar items are removed
	 * from the window, its ribbon icons are hidden by a class (they cannot be
	 * removed, see `Entry.ribbonIcons`), and every open tab of a view type it
	 * registered is closed. A second call costs nothing, and the view types and
	 * ribbon icons stay.
	 *
	 * Called at the same three places as `removeCommands`, for the same reasons:
	 * a feature never started can still add an item from the settings screen,
	 * and one whose `onload` threw leaves what it added before throwing.
	 */
	private removeSurfaces(entry: Entry): void {
		for (const el of entry.surfaces) el.remove();
		entry.surfaces = [];
		for (const icon of entry.ribbonIcons.values()) icon.el.classList.add(WITHDRAWN_RIBBON_ICON);
		for (const type of entry.views.keys()) {
			this.plugin.app.workspace.detachLeavesOfType(type);
		}
	}

	private hostFor(entry: Entry): FeatureHost {
		const settings = this.settings;
		// Six host members below go through this one check, and they are two
		// different shapes. `problems` and `settings` are deferred: each hands
		// back a handle that reaches for the feature when a method on it is
		// called, so it may be taken before there is a feature and used once
		// there is one. `addCommand`, `removeCommand`, `registerEditorSuggest`
		// and `registerMarkdownCodeBlockProcessor` hand back nothing and simply
		// refuse while the feature is being built.
		//
		// That is why the rule is asked on every call rather than once when a
		// handle is taken: a handle taken in a constructor is taken at the one
		// moment there is no feature, and deciding then would leave it refusing
		// for the rest of the feature's life. This is the one place that says so,
		// so that all six answer alike.
		const refuseWhileBuilding = (what: string): void => {
			if (entry.feature === null) throw stillBeingBuilt(what);
		};
		// Built out here rather than in the getter below, because an arrow
		// written inside a getter takes its `this` from the host object rather
		// than from the registry. One arrow is what lets both the feature's
		// handle and the core's own `unload` go through `problemsFor`, so how a
		// channel is built is written once.
		const channel = () => this.problemsFor(entry);
		return {
			app: this.plugin.app,
			// A getter, not a snapshot: saving the core settings replaces the
			// object, and a feature holding the old one would read stale values.
			get core() {
				return settings.core();
			},
			notes: this.notes,
			calendar: this.calendar,
			collections: this.collections,
			// A narrow view, not the store itself: `buildsTheDays` is read fresh off
			// `DeviceStore.read()` on every call, never kept, so a feature asking
			// after the person flips the switch gets the new answer without a new
			// host or a reload.
			device: { buildsTheDays: () => this.device.read().buildsTheDays },
			// Asked of the settings and the entry on every call: a switch-off or a
			// failed start after the host was built changes the answer.
			isOn: () => entry.feature !== null && this.settings.isEnabled(entry.feature.id) && entry.failure === undefined,
			// A getter, because `hostFor` runs before `entry.feature` exists:
			// the host is what the factory is handed. Reading it must not touch
			// the feature either — `private readonly channel = this.host.problems`
			// is the cheapest line a feature author can write, and it runs while
			// `entry.feature` is still null — so the handle finds its feature
			// when a method on it is called rather than when it is taken. The
			// handle holds nothing of its own, so a fresh one per read costs
			// nothing.
			get problems(): FeatureProblems {
				// The rule below is asked on every call, never once when the
				// handle is taken, so a handle kept from before a switch-off is
				// inert rather than broken: switching the feature back on makes
				// that same handle work again. `gatedProblems` is what makes it
				// per call, and it is also why the three members are not written
				// out here a second time.
				//
				// `accepting` is false in two quite different situations and they
				// are not answered the same way. No feature yet means a
				// constructor, which is a mistake in the feature and is thrown
				// back at it — the throw leaves the rule and reaches the feature
				// untouched. A feature that exists and is switched off or failed
				// is the inert case above, and stays silent.
				return gatedProblems(channel, () => {
					refuseWhileBuilding("problem channel");
					return entry.accepting;
				});
			},
			// Guarded like the two deferred members around it, and for a reason of
			// its own: the id list that would take a command back lives on the
			// entry, and an entry whose factory throws is discarded without ever
			// reaching `this.entries` — so a command registered from a constructor
			// stays in the palette with nothing left able to remove it, running a
			// closure over a half-built feature. `register` also constructs every
			// feature, including one the person has switched off, so the same line
			// registered a command for a feature that is not running and `load`
			// never put it back once `unload` had taken it away. One guard closes
			// the factory throw and the id mismatch at once, because both are the
			// same question: is there a feature yet?
			//
			// It is the only question the guard asks, so it does not close the
			// switched-off case. A feature that exists and was never started is
			// past it, and the settings screen opens such a feature's own settings
			// on purpose — so that feature can still reach this line. What takes
			// its command back is the unconditional cleanup on the switch-off path
			// in `unload`, ahead of the early return for a feature that never
			// loaded.
			addCommand: (command: Command) => {
				refuseWhileBuilding("command");
				entry.commandIds.push(this.fullCommandId(this.plugin.addCommand(command).id));
			},
			// Guarded like `addCommand` above and with the same sentence, because it
			// is the same rule: the id list lives on the entry, and while the factory
			// runs there is no feature whose commands these would be.
			//
			// The id is struck off the entry before Obsidian is asked, so a feature
			// that unloads afterwards does not try to remove it a second time. An id
			// this feature never registered is not on the list and is not an error:
			// a feature rebuilding its set after the person edits it withdraws what
			// it thinks it holds, and the list is the only record of what that is.
			// Reading it here rather than trusting the caller is also what keeps one
			// feature from reaching another's commands.
			removeCommand: (commandId: string) => {
				refuseWhileBuilding("command");
				const fullId = this.fullCommandId(commandId);
				const at = entry.commandIds.indexOf(fullId);
				if (at < 0) return;
				entry.commandIds.splice(at, 1);
				// Full for the entry's own list above, short for Obsidian — the
				// two ends want different forms, which is what
				// #548 was.
				this.plugin.removeCommand(this.shortCommandId(fullId));
			},
			// Guarded like the two command members above, for their reason: a
			// suggester registered from a constructor belongs to a feature that may
			// be switched off or never kept, and Obsidian could never let go of it.
			//
			// The plugin is handed a suggester only once per feature, and it is the
			// core's own: `GatedSuggester` below, which forwards while `entry.loaded`
			// and declines otherwise. Every later call only re-aims it. Registering
			// the feature's own suggester instead would add one more to Obsidian on
			// every switch-on, and neither way of taking one back is open to us —
			// Obsidian's list is internal, and handing the feature the `Plugin` so it
			// could keep a flag of its own was rejected in the spec.
			registerEditorSuggest: <T>(suggest: EditorSuggest<T>) => {
				refuseWhileBuilding("editor suggester");
				if (entry.suggester === null) {
					entry.suggester = new GatedSuggester(this.plugin.app, () => entry.loaded);
					this.plugin.registerEditorSuggest(entry.suggester);
				}
				entry.suggester.aim(suggest);
			},
			// Guarded like the members above, for their reason: a renderer
			// registered from a constructor would draw for a feature that may be
			// switched off or never kept, and Obsidian could never let go of it.
			//
			// One renderer per language, the core's own, registered the first time
			// and kept: Obsidian 1.13.7 claims the language in a list only the
			// plugin's unload clears, so a renderer withdrawn at a switch-off could
			// be neither registered again at the next switch-on nor replaced by
			// another plugin — both throw. Every later call only re-aims it. Obsidian's
			// own throw, for a language another plugin holds, reaches the feature's
			// `onload` untouched and fails it with that message.
			registerMarkdownCodeBlockProcessor: (
				language: string,
				handler: CodeBlockHandler,
			) => {
				refuseWhileBuilding("code-block renderer");
				const held = entry.renderers.get(language);
				if (held !== undefined) {
					held.handler = handler;
					return;
				}
				const renderer: GatedRenderer = { handler };
				this.plugin.registerMarkdownCodeBlockProcessor(language, (source, el, ctx) => {
					if (!entry.loaded) {
						drawPlainly(source, el);
						return;
					}
					return renderer.handler(source, el, ctx);
				});
				entry.renderers.set(language, renderer);
			},
			// The three members below are guarded like `addCommand`, with the same
			// sentence, and for its reason: what they add is recorded on the entry,
			// and an entry whose factory throws is discarded without anything left
			// to take it back.
			//
			// The status-bar item Obsidian hands out stays in the window until the
			// whole plugin unloads, so the entry keeps it and `removeSurfaces`
			// removes it on the way out. A ribbon icon cannot be removed that way:
			// see `Entry.ribbonIcons` and `addRibbonIcon` below.
			addStatusBarItem: () => {
				refuseWhileBuilding("status-bar item");
				const item = this.plugin.addStatusBarItem();
				entry.surfaces.push(item);
				return item;
			},
			addRibbonIcon: (icon: IconName, title: string, callback: (evt: MouseEvent) => unknown) => {
				refuseWhileBuilding("ribbon icon");
				// One icon per title, the core's own, added the first time and kept:
				// Obsidian lists every icon in its ribbon menu (Settings, Appearance,
				// Ribbon) and redraws the bar from that list, and nothing published
				// takes an entry out of it. So a later call only re-aims the callback
				// and shows the element again, which keeps one entry per action.
				// `icon` is used by the first call only. A hidden element is hidden
				// by a class, not `el.hide()` or `el.remove()`: the redraw sets the
				// element's inline `display` and puts a removed one back, and only a
				// rule marked `!important` outranks the first.
				const held = entry.ribbonIcons.get(title);
				if (held !== undefined) {
					held.callback = callback;
					held.el.classList.remove(WITHDRAWN_RIBBON_ICON);
					return held.el;
				}
				const el = this.plugin.addRibbonIcon(icon, title, (evt) => {
					if (!entry.accepting) return;
					return entry.ribbonIcons.get(title)?.callback(evt);
				});
				entry.ribbonIcons.set(title, { el, callback });
				return el;
			},
			// One creator per type, the core's own, registered with the plugin the
			// first time and kept: `obsidian.d.ts` has no route that withdraws a
			// type, and registering one twice throws. Every later call only
			// re-aims it. It forwards while the feature is accepting, which is
			// from the start of `onload` to the moment it stops, and otherwise
			// makes an empty tab. Obsidian's own throw, for a type another feature
			// or plugin holds, reaches the feature's `onload` untouched.
			registerView: (type: string, viewCreator: ViewCreator) => {
				refuseWhileBuilding("view");
				const held = entry.views.get(type);
				if (held !== undefined) {
					held.creator = viewCreator;
					return;
				}
				const gated: GatedView = { creator: viewCreator };
				this.plugin.registerView(type, (leaf) => {
					if (!entry.accepting) return new DormantView(leaf, type);
					return gated.creator(leaf);
				});
				entry.views.set(type, gated);
			},
			// Deferred the same way as `problems` above, and for the same reason:
			// `hostFor` runs before `entry.feature` exists, and a feature's
			// constructor is the natural place to take the handle it will use for
			// the rest of its life. A settings handle is keyed by a feature id, and
			// there is no id yet — so the id is looked up when the handle is read or
			// written rather than when it is taken. Both are the same slice of the
			// same file, so a handle taken in a constructor and one taken later see
			// each other's writes.
			settings: <T extends object>(defaults: T): FeatureSettings<T> => ({
				read: () => {
					refuseWhileBuilding("settings handle");
					return this.settings.handleFor(this.featureIn(entry).id, defaults).read();
				},
				save: (next: T) => {
					refuseWhileBuilding("settings handle");
					return this.settings.handleFor(this.featureIn(entry).id, defaults).save(next);
				},
				saveSoon: (next: T) => {
					refuseWhileBuilding("settings handle");
					return this.settings.handleFor(this.featureIn(entry).id, defaults).saveSoon(next);
				},
				// Refused while building for the reason `addCommand` is: a listener
				// taken in a constructor would be told for a feature the core may
				// never load, with nothing to drop it.
				onChange: (listener: SettingsChanged) => {
					refuseWhileBuilding("settings handle");
					return this.settings.onChange(listener);
				},
			}),
			// Guarded like the settings handle's own `onChange` above, and for the
			// same reason: a listener taken in a constructor would be told for a
			// feature the core may never load, with nothing to drop it.
			onCoreChange: (listener: SettingsChanged) => {
				refuseWhileBuilding("core-change listener");
				return this.settings.onCoreChange(listener);
			},
		};
	}

	/**
	 * The channel one feature reports through. The only place that knows how a
	 * channel is built — the feature's id and its name together are what
	 * identifies a problem's owner, and a later ticket changing what a channel
	 * is keyed by has one site to change.
	 *
	 * Called rather than held: `hostFor` runs before `entry.feature` exists, so
	 * every caller must reach the feature at the moment it reports, not at the
	 * moment it takes its handle.
	 */
	/**
	 * The feature an entry holds, once there is one.
	 *
	 * Every entry in `this.entries` was put there by `register` after its
	 * factory returned, so nothing reached through this map can find a null.
	 * What can is the host built for an entry that is still under construction,
	 * and each of those reads answers for itself before getting here — see
	 * `hostFor`. This is what is left: a state the type allows and the code does
	 * not, said out loud rather than cast away.
	 */
	private featureIn(entry: Entry): Feature {
		if (entry.feature === null) {
			throw new Error("A registered feature entry holds no feature; this cannot happen.");
		}
		return entry.feature;
	}

	private problemsFor(entry: Entry): FeatureProblems {
		const feature = this.featureIn(entry);
		return this.problems.forFeature(feature.id, feature.name);
	}

	/**
	 * The form `entry.commandIds` holds: the plugin's manifest id, a colon, then
	 * the command's own id. That is the id Obsidian registers a command under and
	 * the id `addCommand` hands back, so a feature that kept the returned object
	 * has only this form to offer.
	 *
	 * It takes an id rather than a command because `removeCommand` has only an id
	 * to offer, and both ends of the entry's own lookup have to normalise the same
	 * way or a feature could never name a command it had registered.
	 *
	 * This is the registry's bookkeeping form and **not** what Obsidian's
	 * `removeCommand` wants — see `shortCommandId`.
	 */
	private fullCommandId(commandId: string): string {
		const prefix = `${this.plugin.manifest.id}:`;
		return commandId.startsWith(prefix) ? commandId : prefix + commandId;
	}

	/**
	 * The form Obsidian's `Plugin.removeCommand` wants: the command's own id,
	 * with no manifest prefix, because that method adds the prefix itself.
	 *
	 * `addCommand` and `removeCommand` are not symmetrical, and neither
	 * `obsidian.d.ts:4956-4962` nor the documentation says so. Both were read off
	 * the running application in Obsidian 1.13.7 during the #328 drive:
	 *
	 *     addCommand:    function(e){ ... e.id = this.manifest.id + ":" + e.id; ... return e }
	 *     removeCommand: function(e){ this.app.commands.removeCommand(this.manifest.id + ":" + e) }
	 *
	 * So `addCommand` gives back the full id and `removeCommand` wants the short
	 * one. Passing the full id asked Obsidian for `effortless:effortless:…`,
	 * which matched nothing and returned silently: every withdrawal this plugin
	 * made was a no-op, and a person who switched a feature off kept its hotkeys
	 * until Obsidian restarted
	 * (#548, measured in
	 * `docs/acceptance-shots/issue-328-commands-not-withdrawn.txt`).
	 */
	private shortCommandId(commandId: string): string {
		const prefix = `${this.plugin.manifest.id}:`;
		return commandId.startsWith(prefix) ? commandId.slice(prefix.length) : commandId;
	}
}

/**
 * The two readiness answers that mean the feature does not run on this device.
 *
 * `unavailable` is a device that cannot do this at all; `standby` is a feature
 * that stood itself down because another device has the job. Neither is an
 * error, and both leave the feature constructed — only its component, its
 * commands and its work stay off.
 */
function standsDown(readiness: Readiness): boolean {
	return readiness.state === "unavailable" || readiness.state === "standby";
}

/** What Obsidian calls to draw one fenced code block. */
type CodeBlockHandler = (
	source: string,
	el: HTMLElement,
	ctx: MarkdownPostProcessorContext,
) => Promise<unknown> | void;

/**
 * Where the renderer the core registered for one feature and language forwards:
 * the handler the feature registered last. See `registerMarkdownCodeBlockProcessor`
 * in `hostFor`.
 */
interface GatedRenderer {
	handler: CodeBlockHandler;
}

/**
 * Where the creator the core registered for one feature's view type forwards:
 * the creator the feature registered last. See `registerView` in `hostFor`.
 */
interface GatedView {
	creator: ViewCreator;
}

/**
 * The class that hides a ribbon icon whose feature is switched off. `styles.css`
 * gives it `display: none`, weighted to beat a theme.
 */
const WITHDRAWN_RIBBON_ICON = "effortless-ribbon-icon-withdrawn";

/**
 * One feature's ribbon icon: the element Obsidian made for it, and where its
 * clicks go, the callback the feature registered last. See `addRibbonIcon` in
 * `hostFor`.
 */
interface GatedRibbonIcon {
	el: HTMLElement;
	callback: (evt: MouseEvent) => unknown;
}

/**
 * The tab a view type makes while the feature that owns it is not running:
 * empty. Reached by a tab opened after the feature was switched off in this
 * session. A feature switched off at startup never registers the type, so a
 * saved layout's tab of it is not made by this class.
 */
class DormantView extends ItemView {
	constructor(leaf: WorkspaceLeaf, private readonly type: string) {
		super(leaf);
	}

	getViewType(): string {
		return this.type;
	}

	getDisplayText(): string {
		return "";
	}
}

/**
 * Draws a block the way Obsidian draws a fenced block in a language nothing
 * renders: its source, as it is written, in `<pre><code>`.
 *
 * No `language-…` class on the `<code>`, although Obsidian's own carries one.
 * Reading mode runs every registered processor over a section in turn, and one
 * for the same language would find the class and draw over this block — a
 * plugin whose claim on the language failed leaves exactly such a processor
 * behind (#622's drive).
 */
function drawPlainly(source: string, el: HTMLElement): void {
	el.createEl("pre").createEl("code", { text: source });
}

/**
 * Whether a note's text holds a block fenced for `language`: a line that opens a
 * fence, by `openingFence`'s rule, whose info string's first word is the
 * language.
 *
 * Generous on purpose. Quote markers and indentation are taken off a line before
 * the rule is asked, so a fence inside a callout or under a list item counts,
 * and a fence line inside another code block counts too. A match too many costs
 * one tab a needless rebuild at a switch; a match too few leaves it showing a
 * block drawn by a feature that has stopped.
 */
function holdsBlockOf(text: string, language: string): boolean {
	return text.split("\n").some((line) => {
		const fence = openingFence(line.replace(/^[ \t>]*/, ""));
		return fence !== null && fence.info.split(/[ \t]/)[0] === language;
	});
}

/**
 * Redraws one tab: saves its note, then swaps its view for an empty one and back
 * to the state it had. See `FeatureRegistry.redrawBlocks` for why this and not a
 * lighter call.
 */
async function rebuild(leaf: WorkspaceLeaf, view: MarkdownView): Promise<void> {
	await view.save();
	const state = leaf.getViewState();
	const ephemeral: unknown = leaf.getEphemeralState();
	await leaf.setViewState({ type: "empty" });
	await leaf.setViewState(state, ephemeral);
}

/**
 * The suggester the core registers with the plugin on a feature's behalf, once,
 * and keeps for the rest of the session.
 *
 * Obsidian runs this one and never the feature's own, so everything Obsidian
 * would do to the feature's suggester is passed on to it here: the four methods
 * it calls, the popup's `context` before each of the three that read it, and
 * the `limit` that cuts the list. Two calls go the other way. A feature whose
 * `selectSuggestion` ends with `this.close()`, or that sets instructions, means
 * the popup, and its own suggester has no popup — so `aim` points both at this
 * one. An override of either that the feature's class declares is kept, and runs
 * beside what this one does to the popup.
 *
 * Keys go the other way too. Obsidian asks the keys of the scope this object
 * pushes when its popup opens, so `aim` hands the feature's suggester a scope
 * of its own whose parent is the popup's, and makes it this object's `scope`.
 * A binding the feature registers on it answers first, and a key it does not
 * take falls through to the popup's list. The published interface can choose
 * a scope's parent only when the scope is built — `Scope`'s only published
 * members are the constructor, `register` and `unregister`
 * (`obsidian.d.ts:5537-5552`) — so the scope the feature's suggester was born
 * with is replaced, not joined, and a binding made on it in its constructor is
 * never asked.
 *
 * `running` is asked at every call that can start or complete a suggestion,
 * rather than decided at a switch, so there is no flag here that a switch could
 * forget to set. `renderSuggestion` does not ask: it draws rows only for a popup
 * already open, and switching the feature off closes that popup first.
 */
class GatedSuggester extends EditorSuggest<unknown> {
	private target: EditorSuggest<unknown> | null = null;
	/** What `target` declared of its own. See `overridesOf`. */
	private overrides: Overrides = NO_OVERRIDES;
	/**
	 * What each suggester this object has been aimed at declared, read before
	 * `aim` first pointed its two calls here.
	 *
	 * Read once per suggester, because a suggester handed back after another
	 * already carries this object's own `close`: read again, that would pass for
	 * the feature's override, and every close would call itself without end.
	 */
	private readonly declared = new WeakMap<EditorSuggest<unknown>, Overrides>();
	/**
	 * The scope Obsidian's constructor built for this popup, holding its list's
	 * navigation keys and Escape. Every scope `aim` hands out has it as parent.
	 */
	private readonly popupScope: Scope = this.scope;
	/**
	 * The scope handed to each suggester this object has been aimed at, made the
	 * first time and handed back after that, so a binding the feature registered
	 * on it is neither dropped nor registered twice when the suggester returns.
	 */
	private readonly scopes = new WeakMap<EditorSuggest<unknown>, Scope>();
	/** Set while a close this object itself made is under way. See `closeQuietly`. */
	private closingOurselves = false;

	constructor(
		app: App,
		private readonly running: () => boolean,
	) {
		super(app);
	}

	/**
	 * Forwards to `target` from now on. A popup open for the old one closes.
	 *
	 * The target's `close` and `setInstructions` are pointed at this object, and
	 * what its class declared for either is kept first, so that it still runs:
	 * `close` from this object's own `close()`, which every close goes through,
	 * and `setInstructions` right after the popup has been given the instructions.
	 *
	 * The popup's scope becomes the target's, on every aim, a target seen before
	 * included — see `scopeFor`. The popup has just closed, so the scope it
	 * pushed has been popped and the next `open()` pushes the new one.
	 */
	aim<T>(target: EditorSuggest<T>): void {
		if (this.target === target) return;
		this.closeQuietly();
		this.target = target;
		this.scope = this.scopeFor(target);
		const known = this.declared.get(target);
		if (known !== undefined) {
			this.overrides = known;
			return;
		}
		const overrides = overridesOf(target);
		this.declared.set(target, overrides);
		this.overrides = overrides;
		target.close = () => this.closeQuietly();
		target.setInstructions = (instructions: Instruction[]) => {
			this.setInstructions(instructions);
			overrides.setInstructions?.(instructions);
		};
	}

	/**
	 * The scope `target` holds its key bindings on while this object forwards to
	 * it: its parent is the popup's own scope, so a key no binding on it takes
	 * reaches the popup's list. Made and handed to `target` as its `scope` the
	 * first time; the same one after that.
	 */
	private scopeFor(target: EditorSuggest<unknown>): Scope {
		const known = this.scopes.get(target);
		if (known !== undefined) return known;
		const scope = new Scope(this.popupScope);
		this.scopes.set(target, scope);
		target.scope = scope;
		return scope;
	}

	/**
	 * Closes the popup without telling the feature it was dismissed.
	 *
	 * Every close the *plugin* makes comes through here: the feature's own
	 * `close()` after a choice, which `aim` pointed at this object, and the
	 * core's own closes at a switch-off. What is left going through `close()`
	 * is Obsidian's, which is the person's.
	 */
	closeQuietly(): void {
		this.closingOurselves = true;
		try {
			this.close();
		} finally {
			this.closingOurselves = false;
		}
	}

	/**
	 * Obsidian's own close, forwarded to the feature as a dismissal.
	 *
	 * Obsidian gives one `close()` for every kind of dismissal and they cannot
	 * be told apart, so this is the one route by which a feature learns that the
	 * person pressed Escape or clicked away. The hook is called **after** the
	 * popup has gone, so a feature that reopens from it sees a closed popup, and
	 * only while the feature is running — a suggester that is off was not
	 * showing the popup being closed.
	 *
	 * Every close, the plugin's included, also runs the `close()` override the
	 * feature's suggester declared, once the popup has gone and before the
	 * dismissal hook.
	 */
	override close(): void {
		const dismissed = !this.closingOurselves && this.target !== null && this.running();
		const target = this.target;
		super.close();
		this.overrides.close?.();
		if (dismissed) dismissalHook(target as EditorSuggest<unknown>)?.();
	}

	onTrigger(
		cursor: EditorPosition,
		editor: Editor,
		file: TFile | null,
	): EditorSuggestTriggerInfo | null {
		if (this.target === null || !this.running()) return null;
		return this.target.onTrigger(cursor, editor, file);
	}

	getSuggestions(context: EditorSuggestContext): unknown[] | Promise<unknown[]> {
		if (this.target === null || !this.running()) return [];
		this.target.context = this.context;
		this.limit = this.target.limit;
		return this.target.getSuggestions(context);
	}

	renderSuggestion(value: unknown, el: HTMLElement): void {
		if (this.target === null) return;
		this.target.context = this.context;
		this.target.renderSuggestion(value, el);
	}

	selectSuggestion(value: unknown, evt: MouseEvent | KeyboardEvent): void {
		if (this.target === null || !this.running()) return;
		this.target.context = this.context;
		this.target.selectSuggestion(value, evt);
	}
}

/** A feature suggester's own `close` and `setInstructions`. See `overridesOf`. */
interface Overrides {
	readonly close: (() => void) | null;
	readonly setInstructions: ((instructions: Instruction[]) => void) | null;
}

const NO_OVERRIDES: Overrides = { close: null, setInstructions: null };

/**
 * The `close` and `setInstructions` a feature's suggester declared of its own,
 * each bound to it, or `null` for one it left as Obsidian's.
 *
 * Obsidian's own is not called on the feature's suggester. A feature's override
 * reaches it anyway through `super`, and it is harmless there: Obsidian
 * 1.13.7's `close()` clears `context` and pops a key scope that was never
 * pushed, and its `setInstructions()` draws into a popup that is never shown.
 * But calling it for a suggester that declared nothing would change what that
 * suggester sees, so such a suggester is left alone, the way
 * {@link dismissalHook} leaves one without a hook.
 */
function overridesOf(target: EditorSuggest<unknown>): Overrides {
	return {
		close: target.close === EditorSuggest.prototype.close ? null : target.close.bind(target),
		setInstructions:
			target.setInstructions === EditorSuggest.prototype.setInstructions
				? null
				: target.setInstructions.bind(target),
	};
}

/**
 * The feature suggester's dismissal hook, bound to it, or `null` where it
 * declares none.
 *
 * Declaring {@link DismissibleSuggester.onDismissed} is optional, and a
 * suggester without it is left alone — so this asks the object rather than the
 * type.
 */
function dismissalHook(target: EditorSuggest<unknown>): (() => void) | null {
	const hook = (target as Partial<DismissibleSuggester>).onDismissed;
	return typeof hook === "function" ? () => hook.call(target) : null;
}

/**
 * The row's sentence for a feature that is switched on and was never attached.
 *
 * It names the remedy rather than the cause, because the cause is a readiness
 * answer that has already changed and the person can do nothing with it.
 * Switching the feature off and on again calls `load` a second time, which asks
 * readiness a second time — so the sentence is true whatever put the feature
 * here.
 */
export const NOT_STARTED =
	"Switched on, but not started on this device. Switch it off and on again to start it.";

/**
 * What a feature is told when it uses a host member while it is still being
 * built.
 *
 * A feature may *take* its problem channel or its settings handle in its
 * constructor — that is what the host promises, and it is the cheapest line a
 * feature author can write. Using one there is a different thing: both are keyed
 * by the feature's id, and there is no feature to ask for an id until the
 * constructor has returned.
 *
 * The two command members, `addCommand` and `removeCommand`, are behind this
 * rule too, and so are `registerEditorSuggest` and
 * `registerMarkdownCodeBlockProcessor`; they are the ones with nothing
 * worth taking early — so for them the rule is simply "not there": the entry
 * that holds what they register is still under construction and may be thrown
 * away.
 *
 * The message names what to do instead and where the rule is written, because
 * the author reads it in a `Notice` or a stack trace rather than in the file
 * they were working in.
 */
function stillBeingBuilt(what: string): Error {
	return new Error(
		`A feature's ${what} cannot be used while the feature is being built. ` +
			`Use it from onload() onwards: the core has no feature to ask for an id ` +
			`until the constructor has returned, so a handle taken there has nothing ` +
			`to key itself by and a command registered there belongs to an entry that ` +
			`may never be kept. Taking a handle in the constructor is fine; using one ` +
			`is not. See src/core/feature.ts.`,
	);
}

