/**
 * Effortless — the plugin's entry point.
 *
 * All this does is build the core and hand it the list of features. The core
 * owns the settings file, the vault layout and the queued note writer; a
 * feature owns nothing but its own job. Nothing here knows what any feature
 * does, which is why adding one changes this file and nothing else in the core.
 */

import { Notice, Plugin } from "obsidian";
import { keepBuiltDiaries } from "./core/builtDiaries";
import { CalendarSources, obsidianGateway } from "./core/calendarSources";
import { accountReader } from "./core/calendarAccounts";
import { collectionRenameResolvers, watchCollectionRenames } from "./core/collectionRename";
import { CollectionsIndex, noteCachesFrom } from "./core/collections";
import { NoteWriter, openNoteFromWorkspace } from "./core/noteWriter";
import { Problems } from "./core/problems";
import { reasonOf } from "./core/reason";
import type { CoreParts } from "./core/coreParts";
import { FeatureRegistry } from "./core/registry";
import { DeviceStore, SettingsStore } from "./core/settings";
import type { PasswordLeftBehind } from "./core/settings";
import type { CalendarAccount } from "./core/calendarAccounts";
import { EffortlessSettingTab } from "./core/settingsTab";
import { CheckboxCycling } from "./features/checkboxCycling";
import { DateEntry } from "./features/dateEntry";
import { DaysAhead } from "./features/daysAhead";
import { MeetingNotes } from "./features/meetingNotes";
import { DayView } from "./features/dayView";
import { Migration } from "./features/migration";
import { Review } from "./features/review";
import { TaskConsistency } from "./features/taskConsistency";

export default class EffortlessPlugin extends Plugin {
	/**
	 * Held only so `onunload` can drain a deferred write. Null until `onload`
	 * has run, which is the state Obsidian can unload from when `onload` threw.
	 *
	 * Not called `settings`: Obsidian's own `Plugin` declares a public
	 * `settings?: unknown`, and a private field of that name here makes the
	 * plugin no longer assignable to `Plugin` — which the compiler reports at
	 * every place this object is handed to the core, rather than here.
	 */
	private settingsStore: SettingsStore | null = null;

	/**
	 * Held only so `unload` can close the features' problem channel before
	 * anything is detached. Null until `onload` has built it, which is the state
	 * Obsidian can unload from when `onload` threw.
	 */
	private registry: FeatureRegistry | null = null;

	override async onload(): Promise<void> {
		const settings = new SettingsStore(this);
		this.settingsStore = settings;
		await settings.load();
		// The store defers a settings write for 400 ms so that a run of
		// keystrokes is one write, and that timer belongs to the window rather
		// than to the plugin. Left armed, it fired on an unloaded plugin and
		// wrote this instance's settings over the file a re-enabled instance had
		// since written. `teardown` runs the write it was holding and gives the
		// handle up, so nothing survives the unload.
		//
		// Through `register`, and for the same reason the writer's line below
		// is: `Plugin` extends `Component`, so this covers a disable, a vault
		// reload and a plugin update alike, and Obsidian owning the cleanup is
		// what the plugin guidelines require rather than merely prefer
		// (`docs/research/obsidian-publishing-requirements.md` § 1).
		//
		// `onunload` still awaits `flush`, and the two do not overlap whichever
		// order Obsidian runs them in: whichever arrives first runs the pending
		// write, and the other waits for it.
		//
		// **Either order is safe because both of them hand that write a copy of
		// the settings, not the live ones** — not because the order is known.
		// Only `teardown` copied at first, so a `flush` arriving first left the
		// write holding the live object and a save refused after the unload got
		// its change into the file anyway: #385 closed the teardown-first case and
		// #457 the flush-first one. The store
		// says how the copy is taken; the point here is that this line rests on
		// nothing about Obsidian's ordering.
		this.register(() => settings.teardown());

		// Every day's log is built by this writer, so the diary section it was built
		// with is kept from here too, whichever feature asked for the build and
		// whichever features are on (`core/builtDiaries.ts`, #1201).
		const notes = new NoteWriter(this.app.vault, openNoteFromWorkspace(this), this.app.fileManager, keepBuiltDiaries(settings));
		// The writer parks a write while the person is sitting in the note it
		// wants to change, and the listener that releases it is Obsidian's, so
		// it is gone the moment the plugin unloads. Without this line a write
		// parked at that moment never settles at all and whoever awaited it
		// waits for the rest of the app session with nothing said.
		//
		// Through `register` rather than `onunload`: `Plugin` extends
		// `Component`, and `Component.unload()` runs everything given to
		// `register` — so this covers a disable, a vault reload and a plugin
		// update alike, and it sits beside the writer it is about rather than
		// in a method at the bottom of the file.
		this.register(() => notes.teardown());
		const device = new DeviceStore(this.app);
		// Before the calendar is built, so its first read already finds a
		// password typed before the keychain held them.
		announcePasswordsLeftBehind(device.movePasswordsToKeychain(), settings.core().calendarAccounts);
		const calendar = this.addChild(
			new CalendarSources(
				() => settings.core().calendarSources,
				device,
				obsidianGateway(this.app.vault),
				Date.now,
				(callback) => this.app.workspace.onLayoutReady(callback),
				accountReader(() => settings.core().calendarAccounts),
			),
		);
		const noteCaches = noteCachesFrom(this);
		const collections = new CollectionsIndex(noteCaches, () => settings.core().layout);
		// One store, handed to both: the features report into it through the
		// registry, and the settings screen is what keeps saying so.
		const problems = new Problems();
		const { resolveBareLink, nameIsShared } = collectionRenameResolvers(this.app);
		watchCollectionRenames(noteCaches, () => settings.core().layout, notes, problems.forFeature("core", "Effortless"), resolveBareLink, nameIsShared, this.app.fileManager);

		// The core's parts, built here and nowhere else. The registry and the
		// settings screen are handed the same instances rather than a list of
		// arguments each, so neither can drift from the other by somebody adding a
		// parameter and filling it in at one call site only (#198;
		// `core/coreParts.ts` says why it matters for each of them).
		//
		// **Count it exactly, because this comment's whole subject is the count**. `built` holds four: the settings store, the per-device store, the
		// collections index and the standing problems. The registry is handed those
		// four and reads all four. The registry is itself one of the parts,
		// so it cannot be handed the finished bundle: the screen's bundle is `built`
		// spread with the registry added, so it holds five. Two objects, four
		// shared instances, and the fifth member of the screen's bundle is the
		// registry those four were used to build.
		//
		// No type holds that, and #198's third acceptance criterion asked for one
		// that would. It was refused on price and `core/coreParts.ts` carries the
		// measurement. So these lines are where the rule is actually kept, and
		// `main.test.ts`'s "builds one collections index, not one for the screen and
		// one for the features" is what checks it — it starts the plugin and counts
		// one `changed` subscription and one `rename`. Put a freshly built
		// `CollectionsIndex` into either object here and that test is what says so.
		const built = { settings, device, collections, problems };
		const registry = new FeatureRegistry(this, built, notes, calendar);
		this.registry = registry;
		const parts: CoreParts = { ...built, registry };

		// Features are registered here and nowhere else, one
		// `registry.register("<id>", (host) => new …)` line each. The id is
		// passed in as well as declared on the feature, so the core can refuse a
		// duplicate before anything is built, and it must match the feature's own
		// `id` or registering throws. Each feature arrives with its own
		// issue and adds one line here and nothing else anywhere in the core. See
		// src/core/feature.ts for what a feature has to declare.
		//
		// The id is written out rather than imported on purpose: the core has to
		// know it before the factory runs, and a mismatch with the feature's own
		// `id` is a mistake in this file that has to be seen and fixed.
		registry.register("checkbox-cycling", (host) => new CheckboxCycling(host));
		registry.register("date-entry", (host) => new DateEntry(host));
		registry.register("day-view", (host) => new DayView(host));
		registry.register("days-ahead", (host) => new DaysAhead(host));
		registry.register("meeting-notes", (host) => new MeetingNotes(host));
		registry.register("migration", (host) => new Migration(host));
		registry.register("review", (host) => new Review(host));
		registry.register("task-consistency", (host) => new TaskConsistency(host));

		// The one command the core offers of its own. Creating a day's log is
		// core work rather than a feature's, and until a feature asks for one
		// there is no way to make it happen in a real vault: the writer is a
		// local here and nothing puts it where a console could reach it. A
		// command is the better affordance anyway — it is discoverable in the
		// palette, it needs no knowledge of the plugin's insides, and it says so
		// through a `Notice` when it fails rather than through a console line
		// nobody is looking at.
		this.addCommand({
			id: "create-todays-log",
			name: "Create today's log",
			callback: () => {
				void notes.createDailyLog(new Date(), settings.core().layout).catch((error: unknown) => {
					// Obsidian owns this callback, so a rejection escaping it is
					// only ever an unhandled one. The layout ships blank, so the
					// commonest failure here is an install nobody has configured.
					const detail = reasonOf(error);
					new Notice(`Effortless: today's log was not created. ${detail}`);
				});
			},
		});

		registry.start();
		// Beside the line above rather than at the top of `onload`, because it is
		// about the registry and there is no registry until here. A feature keeps
		// whatever problem handle it took, so a re-check queued a moment before
		// the unload fires afterwards and reaches a `Notice` belonging to a
		// plugin that is gone. `stop()` closes that channel and unloads nothing:
		// `Component.unload()` detaches the features itself.
		//
		// Through `register`, like the two cleanups above it, so it covers a
		// disable, a vault reload and a plugin update alike. It is the backstop
		// rather than the first route: `Component.unload()` runs the children
		// before the registered cleanups, so by the time this line fires every
		// feature has already been detached and its own `onunload` has already
		// run. `unload` below closes the channel ahead of all of that; this stays
		// because `stop()` is safe to call twice and a cleanup Obsidian owns is
		// what the plugin guidelines ask for.
		this.register(() => registry.stop());
		this.addSettingTab(new EffortlessSettingTab(this.app, this, parts));
	}

	/**
	 * Closes the features' problem channel before anything is taken apart.
	 *
	 * `Component.unload()` runs its children first, then the callbacks given to
	 * `register`, then `onunload`. So the `register` line in `onload` — and
	 * `onunload` below it, which is later still — both fire after every feature
	 * has been detached and after each one's own `onunload` has run. A feature
	 * that reports a problem from its own teardown therefore reached a `Notice`
	 * and left a standing report in the store of a plugin that is going away,
	 * which is the exact channel #152
	 * exists to close.
	 *
	 * Overriding the public teardown is what puts the close ahead of all of it,
	 * and it is correct whatever order the real `Component.unload()` uses
	 * internally — this repository can only read its own stub of that method, so
	 * a fix that rests on the real one's ordering rests on something unverified.
	 *
	 * The registered cleanup stays as well. `stop()` is safe to call twice and
	 * leaves no state a later `start()` would trip over.
	 */
	override unload(): void {
		this.registry?.stop();
		super.unload();
	}

	/**
	 * A settings change typed in the last 400 ms is still sitting on its timer,
	 * and nothing but that timer would ever run it. Awaiting the flush here is
	 * what makes the write start before the plugin finishes unloading, so the
	 * last thing typed is still there next time.
	 *
	 * Obsidian does not await this, any more than it awaits `onload`. What the
	 * `await` buys is the write being issued rather than dropped; a failure is
	 * announced by the settings screen, which asked for the write in the first
	 * place, so `flush` answers rather than rejects and there is nothing to
	 * catch here.
	 *
	 * The promise is kept rather than the method made plain, because
	 * `main.test.ts`'s "waits for a write already running" holds on to it to tell
	 * a held write from a finished one. Obsidian's own type for this hook
	 * returns `void` (`node_modules/obsidian/obsidian.d.ts:1862`), so the
	 * checker is told so on the line.
	 */
	// eslint-disable-next-line @typescript-eslint/no-misused-promises -- Obsidian discards what onunload returns, and flush answers rather than rejects; see above.
	override async onunload(): Promise<void> {
		await this.settingsStore?.flush();
	}

	/**
	 * Obsidian calls this when `data.json` was changed from outside it — a Sync
	 * service carrying another device's save
	 * (`node_modules/obsidian/obsidian.d.ts:5085`, since 1.5.7). The store takes
	 * what the file now says before this device's next save writes its own copy
	 * over it;
	 * `SettingsStore.reloadExternal` says how. Obsidian does not await it, and a
	 * failure is a rejection nobody catches, which is reported rather than
	 * swallowed.
	 */
	override async onExternalSettingsChange(): Promise<void> {
		await this.settingsStore?.reloadExternal();
	}
}

/**
 * Says which calendar accounts' app-specific passwords could not move into
 * Obsidian's keychain, by the account's user name where it has one. Each
 * stays in the per-device store and is tried again at the next start.
 */
function announcePasswordsLeftBehind(stayed: readonly PasswordLeftBehind[], accounts: readonly CalendarAccount[]): void {
	if (stayed.length === 0) return;
	const named = stayed.map(({ accountId, reason }) => {
		const user = accounts.find((account) => account.id === accountId)?.user;
		return `"${user !== undefined && user !== "" ? user : accountId}": ${reason}`;
	});
	const which = stayed.length === 1 ? "a calendar account's app-specific password" : `${stayed.length} calendar accounts' app-specific passwords`;
	new Notice(
		`Effortless: ${which} could not move to Obsidian's keychain, and stayed on this device where it was kept before. ` +
			`Effortless tries again when it next starts. ${named.join(" ")}`,
	);
}
