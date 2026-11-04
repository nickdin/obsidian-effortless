/**
 * The plugin's entry point, tested for the one thing only it can do: hand the
 * note writer a way to see which note is open.
 *
 * `NoteWriter` takes that as a required second argument since issue #91, so a
 * plugin built without one no longer compiles — `noteWriter.test.ts` holds the
 * `@ts-expect-error` guard that keeps it required. What the compiler cannot
 * catch is a port that is constructed, passed, and then never used, which loses
 * the rule that a background write never lands on the note being typed in just
 * as completely. That omission is in the caller, and this file is the only test
 * that reads the caller.
 *
 * The calendar and the collections index are the same shape of omission, and
 * the same size of consequence. Both are built here and handed to the registry,
 * which is the only route a feature has to either. A plugin built without those
 * lines compiles, loads, and passes every test in `calendarSources.test.ts` and
 * `collections.test.ts` — while no feature can ever reach a meeting or a
 * collection, and nothing starts the calendar's read cycle. The lines were
 * written at merge rather than by either ticket's author, because each ticket
 * needed one and neither owned the file; these tests are what stands in for the
 * author who would have noticed.
 *
 * The last two describes are about the Obsidian stub rather than the entry
 * point, and are here because the entry point is what drives them: it is the
 * only place that loads and unloads a whole plugin, which is what the stub's
 * event lifecycle has to get right.
 *
 * Every test here starts the plugin with `load()` rather than `onload()`. Obsidian's
 * `Component.load()` marks the component loaded *before* it calls `onload`,
 * which is what makes a child added inside `onload` start at once. Calling
 * `onload()` directly leaves that flag false, so a feature would be attached
 * and never started — a start-up the real app cannot produce, which is the
 * opposite of what this file is for.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TFile } from "obsidian";
import { App, Component, Events, MarkdownPreviewRenderer, Notice } from "./__mocks__/obsidian";
import type { Command } from "./__mocks__/obsidian";
import { CalendarSources } from "../core/calendarSources";
import { Feature } from "../core/feature";
import { localDateKey } from "../core/meetingName";
import { SAVE_AFTER_TYPING_MS, defaultData } from "../core/settings";
import type { Plugin as ObsidianPlugin } from "obsidian";
import type { FeatureHost, Readiness } from "../core/feature";
import type { FeatureProblems, Problems } from "../core/problems";
import type { FeatureRegistry } from "../core/registry";
import type { SettingsStore } from "../core/settings";
import type { NoteWriter } from "../core/noteWriter";
import EffortlessPlugin from "../main";

/**
 * Every `NoteWriter` the entry point builds, in order.
 *
 * The writer is a local inside `onload` and is handed only to the registry, so
 * there is no route to it from outside. Without one, the open-note assertion
 * below could only say that *some* `file-open` listener exists — which
 * `openNoteFromWorkspace` records on its own. The port is a required
 * constructor argument since issue #91, so a writer built without one no longer
 * compiles — but a port passed and then never used still would, and that is what
 * this test catches. Watching the constructor is what lets the test drive the
 * writer the entry point actually built.
 */
const writers = vi.hoisted(() => [] as NoteWriter[]);

/**
 * Every `SettingsStore` the entry point builds, in order.
 *
 * The store is a local inside `onload` and is handed only to the registry and
 * the settings screen, so there is no route to it from outside. The unload tests
 * below have to reach the one the plugin is really running on: a store built
 * beside it would have its own pending write and would prove nothing about the
 * plugin's. Watched the same way the note writer is, a few lines down.
 */
const stores = vi.hoisted(() => [] as SettingsStore[]);

vi.mock("../core/settings", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/settings")>();
	return {
		...actual,
		// The real store, subclassed rather than replaced, for the same reason
		// the note writer is: the test drives the production class and only
		// learns where the instance went.
		SettingsStore: class extends actual.SettingsStore {
			constructor(plugin: ObsidianPlugin) {
				super(plugin);
				stores.push(this);
			}
		},
	};
});

/**
 * Every `FeatureRegistry` and every `Problems` store the entry point builds.
 *
 * Both are locals inside `onload`, so a test about what happens to a feature at
 * unload has no other route to either: it has to reach the registry the plugin
 * is really running on and register one into it, then read the store that
 * registry reports through. The one feature `main.ts` ships is no substitute —
 * these tests need a feature that reports on cue, and reaching into the shipped
 * one would tie the core's teardown to what that feature happens to do. A
 * registry built beside the plugin would have no cleanup registered on it,
 * which is the half being tested. Watched the same way the two above are.
 */
const registries = vi.hoisted(() => [] as FeatureRegistry[]);
const problemStores = vi.hoisted(() => [] as Problems[]);

vi.mock("../core/registry", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/registry")>();
	return {
		...actual,
		// The real registry, subclassed rather than replaced, for the same
		// reason the store and the writer are.
		FeatureRegistry: class extends actual.FeatureRegistry {
			constructor(...args: ConstructorParameters<typeof actual.FeatureRegistry>) {
				super(...args);
				registries.push(this);
			}
		},
	};
});

vi.mock("../core/problems", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/problems")>();
	return {
		...actual,
		Problems: class extends actual.Problems {
			constructor() {
				super();
				problemStores.push(this);
			}
		},
	};
});

vi.mock("../core/noteWriter", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/noteWriter")>();
	return {
		...actual,
		// The real writer, subclassed rather than replaced: the test drives the
		// production class and only learns where the instance went.
		// Every argument is handed on: the listener for each day's log built
		// is one, and a subclass that took two dropped it in silence.
		NoteWriter: class extends actual.NoteWriter {
			constructor(...args: ConstructorParameters<typeof actual.NoteWriter>) {
				super(...args);
				writers.push(this);
			}
		},
	};
});

/**
 * Under vitest, `EffortlessPlugin`'s base class is the stub, whose constructor
 * takes the app alone. The compiler still sees Obsidian's own two-argument
 * `Plugin`, so the shape is asserted here rather than inferred.
 */
const StubPlugin = EffortlessPlugin as unknown as new (app: App) => EffortlessPlugin;

/** The stub's `Component` and `Plugin`, which is what the plugin really runs on. */
type Started = EffortlessPlugin & {
	loaded: boolean;
	children: unknown[];
	commands: Command[];
	/** Everything ever handed to `saveData`, which is the stub's own record. */
	saved: string[];
	/** Every command id handed to `removeCommand`, which is the stub's record too. */
	removedCommands: string[];
	/** Holds every later `saveData` open until the returned release runs. */
	holdSaves(): () => void;
	seedData(data: unknown): void;
	unload(): void;
};

/**
 * Starts the plugin the way Obsidian does.
 *
 * `load()` returns as soon as `onload` has been *called*, not when the promise
 * it returns has settled — Obsidian's own does the same. So the promise is
 * caught on the way past and awaited here, rather than guessing how many turns
 * of the microtask queue the start-up takes.
 */
async function start(app: App, seed?: (plugin: Started) => void): Promise<Started> {
	MarkdownPreviewRenderer.reset();
	const plugin = new StubPlugin(app) as Started;
	seed?.(plugin);
	let loading!: Promise<void>;
	const onload = plugin.onload.bind(plugin);
	plugin.onload = () => {
		loading = onload();
		return loading;
	};

	plugin.load();
	await loading;

	return plugin;
}

/** Lets the microtask queue run `count` times, so a hang shows up as a hang. */
async function turns(count: number): Promise<void> {
	for (let i = 0; i < count; i += 1) await Promise.resolve();
}

describe("load", () => {
	it("marks the plugin loaded before onload runs, as Obsidian does", async () => {
		const plugin = await start(new App());

		expect(plugin.loaded).toBe(true);
	});

	it("starts a child added during onload, which calling onload alone would not", () => {
		// The sequence the tests above depend on, in isolation. `load()` sets the
		// loaded flag first, so `addChild` starts the child there and then;
		// `onload()` on its own leaves the flag false and the child attached but
		// never started. This test is what says the difference is real.
		class Child extends Component {}
		class Host extends Component {
			readonly child = new Child();
			override onload(): void {
				this.addChild(this.child);
			}
		}

		const started = new Host();
		started.load();
		expect(started.child.loaded).toBe(true);

		const bypassed = new Host();
		bypassed.onload();
		expect(bypassed.loaded).toBe(false);
		expect(bypassed.child.loaded).toBe(false);
	});
});

describe("onload", () => {
	it("hands the note writer the open note, so a write waits while the person types", async () => {
		const app = new App();
		const note = "Journal/2026-09-06.md";
		app.vault.allowReads({ [note]: "typing" });

		await start(app);
		const writer = writers[writers.length - 1];

		// The person is in the note. A writer holding the port parks the write
		// until they leave; a writer built without it overwrites what they are
		// typing, at once and in silence — which is the whole reason this file
		// exists. Asserting on `app.workspace.listeners` cannot tell the two
		// apart: `openNoteFromWorkspace` records the listener itself.
		app.workspace.open(note);
		const write = writer.edit({ path: note } as TFile, (text) => `${text}+queued`);

		const answered = await Promise.race([write, turns(20).then(() => "held" as const)]);
		expect(answered).toBe("held");

		app.workspace.open(null);
		await expect(write).resolves.toBe("typing+queued");
	});

	it("subscribes to the open note changing", async () => {
		const app = new App();

		await start(app);

		const events = app.workspace.listeners.map(([name]) => name);
		expect(events).toContain("file-open");
	});

	it("starts the calendar's read cycle by making it a child of the plugin", async () => {
		const app = new App();

		const plugin = await start(app);

		// `addChild` is what loads it, which is what registers the interval.
		// Constructing the calendar and never adding it would leave every
		// source unread until something else happened to ask.
		// `children` is the stub's, not Obsidian's own `Component` API, so it is
		// cast at the call the way the rest of these tests cast the stub.
		const calendar = plugin.children.find((child) => child instanceof CalendarSources);
		expect(calendar).toBeInstanceOf(CalendarSources);
		// Attached is not started. Under the load sequence Obsidian really runs,
		// a child added during `onload` is loaded by the time `onload` returns.
		expect((calendar as CalendarSources & { loaded: boolean }).loaded).toBe(true);
	});

	/**
	 * Ticket #572. The calendar's own suite (`calendarSources.test.ts`) holds
	 * the readiness behaviour itself; this is only the wiring, that
	 * `onload` hands the calendar the workspace's own
	 * `onLayoutReady` rather than reading at once regardless.
	 *
	 * The stub's own `onLayoutReady` answers at once, which is indistinguishable
	 * from the plugin reading at once regardless — the very thing this test has
	 * to tell apart. So it replaces the instance's `onLayoutReady` with one that
	 * captures the callback instead of running it, and the assertion below is
	 * that a callback arrived at all: proof the plugin handed the calendar the
	 * workspace's own readiness rather than reading on its own.
	 */
	it("hands the calendar the workspace's own readiness, rather than reading at once regardless", async () => {
		const app = new App();
		let ready: (() => void) | undefined;
		(app.workspace as unknown as { onLayoutReady: (callback: () => void) => void }).onLayoutReady = (
			callback,
		) => {
			ready = callback;
		};

		await start(app);

		expect(ready).toBeTypeOf("function");
	});

	it("builds one collections index, not one for the screen and one for the features", async () => {
		const app = new App();

		await start(app);

		// The index subscribes to both events once when it is made, so a second
		// index is a second pair of subscriptions. Two indexes are both correct
		// — they just answer separately and do the work twice — so nothing but a
		// count of the subscriptions would ever say there were two.
		//
		// The compiler holds part of this rule now and this test holds the rest. No
		// constructor parameter carries a default any more, so `main.ts` can
		// neither leave the index out nor pass `undefined` in its place. Since
		// #198 the registry
		// and the settings screen are handed a bundle built in one place rather
		// than an argument list each, so the two cannot drift apart by somebody
		// adding a parameter and filling it in at only one call site. Two bundles,
		// strictly: the registry is one of the parts, so it takes the four built
		// before it and the screen takes those four with the registry added.
		//
		// **What is left, and the compiler still cannot see it.** `main.ts`
		// builds that bundle, so `main.ts` can put a freshly made index into it
		// — `{ ...built, registry, collections: new CollectionsIndex(…) }`
		// type-checks perfectly. The route is now one line in one file instead
		// of one argument in each of two calls, and this is what counts it.
		const changed = app.metadataCache.listeners.filter(([name]) => name === "changed");
		const renamed = app.vault.listeners.filter(([name]) => name === "rename");
		expect(changed).toHaveLength(1);
		// Two, not one, since #629: the collections index's own subscription plus
		// day view's rename listener, an independent "rename" hook this test's
		// count would otherwise conflate with a second collections index.
		expect(renamed).toHaveLength(2);
	});
});

describe("unload", () => {
	it("takes the note writer's file-open listener off the workspace", async () => {
		const app = new App();
		const plugin = await start(app);
		expect(app.workspace.names()).toContain("file-open");

		plugin.unload();

		// Nothing in `main.ts`'s `onunload` touches the workspace. This works
		// because the subscription went through `registerEvent`, which files a
		// cleanup on the same list `unload` empties. Delete that wrapper from
		// the note writer's wiring and this test is what says so.
		expect(app.workspace.names()).not.toContain("file-open");
	});

	it("takes the collections index's three subscriptions off the vault and the cache", async () => {
		const app = new App();
		const plugin = await start(app);
		expect(app.vault.names()).toEqual(expect.arrayContaining(["rename", "delete"]));
		expect(app.metadataCache.names()).toContain("changed");

		plugin.unload();

		expect(app.vault.names()).toEqual([]);
		expect(app.metadataCache.names()).toEqual([]);
	});

	/**
	 * The writer's own `teardown` tests build a writer and call `teardown()` on
	 * it, so they stay green whether or not anything in the plugin ever does.
	 * This one drives the plugin, which is the part that was missing (issues
	 * #150 and
	 * #239 — one defect
	 * filed twice).
	 */
	it("refuses a write parked on the open note, rather than leaving it unsettled", async () => {
		const app = new App();
		const note = "Journal/2026-09-06.md";
		app.vault.allowReads({ [note]: "typing" });
		const plugin = await start(app);
		const writer = writers[writers.length - 1];

		// The person is in the note, so the write parks and stays parked.
		app.workspace.open(note);
		const write = writer.edit({ path: note } as TFile, (text) => `${text}+queued`);
		const answered = await Promise.race([write, turns(20).then(() => "held" as const)]);
		expect(answered).toBe("held");

		plugin.unload();

		// Rejecting is the point: the listener that would have released this
		// write came off the workspace a moment ago, so anything but a
		// rejection here is a promise nobody will ever settle.
		await expect(write).rejects.toThrow(/plugin was unloaded/i);
	});
});

/**
 * A change typed within `SAVE_AFTER_TYPING_MS` of the plugin unloading.
 *
 * These tests read `SettingsStore.flush` rather than the settings screen,
 * because the store is where the deferral lives and `main.ts` is what has to
 * drain it. They sit in this file rather than in `settings.test.ts` because
 * every one of them starts a real plugin: what they guard is `main.ts` doing
 * the draining, which is the half a test over a store built beside the plugin
 * cannot see.
 *
 * Most of them go on to unload that plugin. The exception is "is a no-op the
 * second time, so flushing twice writes once", which never unloads — and it
 * belongs here all the same, because the store it flushes twice is the one the
 * plugin built rather than one built beside it. Starting a plugin is what all
 * four have in common, and it is the whole of the reason.
 *
 * A test added here should start a plugin too.
 */
describe("unload drains a deferred settings write", () => {
	/** The store the plugin is really running on, not one built beside it. */
	function storeOf(): SettingsStore {
		const store = stores[stores.length - 1];
		expect(store, "the plugin built no settings store").toBeDefined();
		return store;
	}

	/**
	 * `start`, with the plugin's own fresh-install languageHistory write settled and dropped from `plugin.saved` before a test
	 * counts the writes it asks for itself. `flush` waits on the write's own
	 * promise chain rather than a real timer, so it settles under fake timers
	 * too.
	 */
	async function startFresh(): Promise<Started> {
		const plugin = await start(new App());
		await storeOf().flush();
		plugin.saved.length = 0;
		return plugin;
	}

	/** A keystroke: the value changes at once and only the write waits. */
	function type(settings: SettingsStore, folder: string): void {
		const core = settings.core();
		void settings.saveCoreSoon({ ...core, layout: { ...core.layout, dailyLogFolder: folder } });
	}

	it("writes a change that was still inside the typing window", async () => {
		const plugin = await startFresh();
		const settings = storeOf();
		type(settings, "Journal");
		// Nothing has been written: the timer has not fired and nothing else
		// drains it. Before this ticket, nothing ever would.
		expect(plugin.saved).toHaveLength(0);

		plugin.unload();
		await turns(20);

		// A fresh store over the same plugin, so this reads `data.json` as the
		// next session would rather than the store's own memory of it.
		const reread = new (await import("../core/settings")).SettingsStore(
			plugin as unknown as ObsidianPlugin,
		);
		await reread.load();
		expect(reread.core().layout.dailyLogFolder).toBe("Journal");
	});

	it("writes nothing, and throws nothing, when no change is pending", async () => {
		const plugin = await start(new App());
		const before = plugin.saved.length;

		expect(() => plugin.unload()).not.toThrow();
		await turns(20);

		expect(plugin.saved.length).toBe(before);
	});

	it("is a no-op the second time, so flushing twice writes once", async () => {
		const plugin = await startFresh();
		const settings = storeOf();
		type(settings, "Journal");

		await settings.flush();
		const after = plugin.saved.length;
		await expect(settings.flush()).resolves.toBeUndefined();

		expect(after).toBe(1);
		expect(plugin.saved.length).toBe(after);
	});

	it("waits for a write already running, not only for one still on the timer", async () => {
		const plugin = await startFresh();
		const settings = storeOf();
		// A toggle, not a keystroke: `setEnabled` persists straight away, so
		// nothing is ever put on the debounce timer and `waiting` stays null.
		// That is the branch #212 is about.
		const release = plugin.holdSaves();
		void settings.setEnabled("day-plan", false);
		await turns(20);
		expect(plugin.saved).toHaveLength(0);

		// `unload()`, not `onunload()`. Obsidian never calls the hook itself:
		// `Component.unload()` runs the registered cleanups and then calls
		// `onunload` synchronously, discarding what it returns. This test used
		// to call the hook directly, so deleting the plugin's override left it
		// green — it asserted a property of a call no production path makes.
		//
		// The promise is caught on the way past, the way `start` catches
		// `onload`'s, because the override buys exactly one thing: a promise
		// that stays pending while the write is still open. Delete the override
		// and there is nothing here to hold, which the assertion below says out
		// loud rather than leaving to a type error.
		let unloading: unknown;
		const onunload = plugin.onunload.bind(plugin);
		plugin.onunload = () => {
			unloading = onunload();
			return unloading as Promise<void>;
		};

		plugin.unload();

		// Nothing has landed at the moment unload returns: the write is held.
		expect(plugin.saved).toHaveLength(0);
		expect(unloading, "the plugin's onunload returned no promise to wait on").toBeInstanceOf(
			Promise,
		);
		let unloaded = false;
		const unloadingPromise = (unloading as Promise<void>).then(() => {
			unloaded = true;
		});
		await turns(20);

		// Before #212, `flush` found the timer empty and answered at once,
		// while `saveData` was still open — so unload finished on a write that
		// had not landed. Holding the write open is the only way to tell the
		// two apart: the stub's own write takes no time at all.
		expect(unloaded).toBe(false);

		release();
		await unloadingPromise;
		expect(plugin.saved).toHaveLength(1);
	});
});

/**
 * The other half of the same unload: the timer the deferral arms.
 *
 * #187 gave the store a `flush` and `main.ts` an `onunload` that awaits it, so
 * the pending change lands. What that left was ownership: the handle was armed
 * with a bare `window.setTimeout` and nothing but its own firing emptied it, so
 * a deferral asked for *after* the unload armed a timer on a dead plugin, which
 * then wrote that instance's settings over the file a re-enabled instance had
 * since written. Obsidian's plugin guidelines make owned cleanup a requirement
 * (`docs/research/obsidian-publishing-requirements.md` § 1), so the cleanup is
 * handed to `Plugin.register` rather than done by hand.
 *
 * These start a real plugin for the same reason #187's do: what they read is
 * `main.ts` registering the cleanup, which a store built beside the plugin
 * cannot show.
 */
describe("unload leaves no settings timer behind", () => {
	/** The store the plugin is really running on, not one built beside it. */
	function storeOf(): SettingsStore {
		const store = stores[stores.length - 1];
		expect(store, "the plugin built no settings store").toBeDefined();
		return store;
	}

	/**
	 * `start`, with the plugin's own fresh-install languageHistory write settled and dropped from `plugin.saved` before a test
	 * counts the writes it asks for itself. `flush` waits on the write's own
	 * promise chain rather than a real timer, so it settles under fake timers
	 * too.
	 */
	async function startFresh(): Promise<Started> {
		const plugin = await start(new App());
		await storeOf().flush();
		plugin.saved.length = 0;
		return plugin;
	}

	it("writes once at unload and nothing when the typing window then passes", async () => {
		const plugin = await startFresh();
		const settings = storeOf();
		vi.useFakeTimers();
		try {
			const core = settings.core();
			void settings.saveCoreSoon({ ...core, layout: { ...core.layout, dailyLogFolder: "Journal" } });

			plugin.unload();
			await turns(20);
			expect(plugin.saved).toHaveLength(1);

			await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS * 3);
			expect(plugin.saved).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("arms nothing for a keystroke that arrives after the unload", async () => {
		const plugin = await start(new App());
		const settings = storeOf();
		plugin.unload();
		await turns(20);
		const after = plugin.saved.length;

		vi.useFakeTimers();
		try {
			// What a re-enabled instance has since stored. Before this ticket the
			// old instance's timer wrote its own `data` straight over it.
			plugin.seedData({ core: { layout: { dailyLogFolder: "Rebuilt" } } });

			const core = settings.core();
			const stray = settings.saveCoreSoon({
				...core,
				layout: { ...core.layout, dailyLogFolder: "Journal" },
			});
			await expect(stray).rejects.toThrow(/unloaded/i);
			await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS * 3);

			expect(plugin.saved.length).toBe(after);
		} finally {
			vi.useRealTimers();
		}

		const reread = new (await import("../core/settings")).SettingsStore(
			plugin as unknown as ObsidianPlugin,
		);
		await reread.load();
		expect(reread.core().layout.dailyLogFolder).toBe("Rebuilt");
	});

	it("drains the pending write through the registered cleanup, not through onunload", async () => {
		// `register` is what covers a disable, a vault reload and a plugin update
		// alike, and awaiting `flush` in `onunload` covers none of them on its
		// own. So this runs the cleanups Obsidian's `Component` runs and
		// deliberately never calls `onunload`: what lands here landed through the
		// registration.
		const plugin = await startFresh();
		const settings = storeOf();
		const core = settings.core();
		void settings.saveCoreSoon({ ...core, layout: { ...core.layout, dailyLogFolder: "Journal" } });
		expect(plugin.saved).toHaveLength(0);

		for (const cleanup of (plugin as unknown as { cleanups: (() => void)[] }).cleanups) cleanup();
		await turns(20);

		expect(plugin.saved).toHaveLength(1);
		expect(plugin.saved[0]).toContain("Journal");
	});
});

/**
 * The third of the plugin's cleanups: the features' problem channel.
 *
 * A feature keeps whatever problem handle it took, and a re-check queued on a
 * debounce fires after the switch that queued it. Switching one feature off
 * closes its channel in `FeatureRegistry.unload`; unloading the whole plugin
 * never reaches that method, because Obsidian detaches the features itself. So
 * every entry was left accepting and a late report reached `new Notice(...)`
 * from a plugin that is gone.
 *
 * Here rather than in `registry.test.ts` for the reason #187's and #188's
 * tests are: `registry.test.ts` calls `stop()` itself and stays green whether
 * or not anything in the plugin ever does. What this one reads is `main.ts`
 * registering it.
 */
describe("unload closes the features' problem channel", () => {
	/**
	 * Keeps the handle it took in `onload`, the way any feature that re-checks
	 * its work on a debounce does. `registry.test.ts` has a fuller twin of this;
	 * this file needs only the one method.
	 */
	class Debounced extends Feature {
		readonly id = "pairing";
		readonly name = "Pairing";
		readonly description = "Re-checks its work whenever the vault changes.";
		private channel?: FeatureProblems;

		readiness(): Readiness {
			return { state: "ready" };
		}

		override onload(): void {
			this.channel = this.host.problems;
		}

		/** The queued re-check firing, after the plugin has gone. */
		lateReport(note: string): void {
			this.channel?.report(note, `12 tasks in ${note} are no longer paired.`);
		}
	}

	/**
	 * Says something on the way out, which is the half `Debounced` above cannot
	 * show. Its report happens *inside* the plugin's unload rather than after it
	 * has returned, and that is a different moment:
	 * `Component.unload()` detaches its children before it runs the callbacks
	 * given to `register`, so the registered cleanup closed the channel only
	 * once every feature's own `onunload` had already run.
	 */
	class NoisyExit extends Feature {
		readonly id = "noisyExit";
		readonly name = "Noisy exit";
		readonly description = "Tidies up, and says what it could not tidy.";
		private channel?: FeatureProblems;

		readiness(): Readiness {
			return { state: "ready" };
		}

		override onload(): void {
			this.channel = this.host.problems;
		}

		override onunload(): void {
			this.channel?.report("bye", "Something was left half done.");
		}
	}

	beforeEach(() => {
		Notice.messages = [];
	});

	it("says nothing when a feature reports from its own teardown", async () => {
		const plugin = await start(new App());
		const registry = registries[registries.length - 1];
		expect(registry, "the plugin built no feature registry").toBeDefined();
		const problems = problemStores[problemStores.length - 1];
		expect(problems, "the plugin built no problems store").toBeDefined();

		registry.register("noisyExit", (host: FeatureHost) => new NoisyExit(host));
		registry.start();
		Notice.messages = [];

		// Everything happens inside this line: Obsidian detaches the feature,
		// the feature's `onunload` runs, and it reports. Before this ticket both
		// assertions below found what the feature said.
		plugin.unload();

		expect(Notice.messages).toEqual([]);
		expect(problems.all()).toEqual([]);
	});

	it("closes the channel from the unload override and again from the cleanup", async () => {
		// Twice on purpose: the override is what gets there before the children,
		// and the registration is what covers a disable, a vault reload and a
		// plugin update alike. `stop()` is documented safe to call twice, and
		// this is the path that calls it twice.
		const plugin = await start(new App());
		const registry = registries[registries.length - 1];
		const stop = vi.spyOn(registry, "stop");

		expect(() => plugin.unload()).not.toThrow();

		expect(stop).toHaveBeenCalledTimes(2);
	});

	it("says nothing when a feature reports through a handle it kept", async () => {
		const plugin = await start(new App());
		const registry = registries[registries.length - 1];
		expect(registry, "the plugin built no feature registry").toBeDefined();
		const problems = problemStores[problemStores.length - 1];
		expect(problems, "the plugin built no problems store").toBeDefined();

		// Registered into the registry the plugin is running on and started the
		// way `onload` starts them, so that this test drives a feature that
		// reports on cue rather than the shipped one. Everything after this line
		// is what the app does.
		let pairing!: Debounced;
		registry.register("pairing", (host: FeatureHost) => (pairing = new Debounced(host)));
		registry.start();
		Notice.messages = [];

		plugin.unload();

		expect(() => pairing.lateReport("Work/Roof.md")).not.toThrow();
		// Nothing said and nothing standing. Before this ticket the report
		// landed in the store the settings screen of a dead plugin would have
		// drawn, and a failing one raised a `Notice` over whatever is on screen
		// now.
		expect(Notice.messages).toEqual([]);
		expect(problems.all()).toEqual([]);
	});

	it("closes it through the registered cleanup, not through onunload", async () => {
		// `register` is what covers a disable, a vault reload and a plugin
		// update alike, and `onunload` covers none of them on its own. So this
		// runs the cleanups Obsidian's `Component` runs and never calls
		// `onunload`: what closes here closed through the registration.
		const plugin = await start(new App());
		const registry = registries[registries.length - 1];
		const problems = problemStores[problemStores.length - 1];
		let pairing!: Debounced;
		registry.register("pairing", (host: FeatureHost) => (pairing = new Debounced(host)));
		registry.start();
		Notice.messages = [];

		for (const cleanup of (plugin as unknown as { cleanups: (() => void)[] }).cleanups) cleanup();

		pairing.lateReport("Work/Roof.md");
		expect(problems.all()).toEqual([]);
		expect(Notice.messages).toEqual([]);
	});
});

describe("the obsidian stub's event lifecycle", () => {
	it("detaches only the subscription the ref names, not every one of that name", () => {
		const events = new Events();
		const heard: string[] = [];
		const first = events.on("changed", () => heard.push("first"));
		events.on("changed", () => heard.push("second"));

		events.offref(first);
		events.fire("changed");

		expect(heard).toEqual(["second"]);
	});

	it("ignores a ref that is already off, so unloading twice does not throw", () => {
		const component = new Component();
		const events = new Events();
		component.load();
		component.registerEvent(events.on("changed", () => undefined));

		component.unload();
		expect(() => component.unload()).not.toThrow();
		expect(() => events.offref(component.registeredEvents[0])).not.toThrow();
		expect(events.names()).toEqual([]);
	});
});

describe("the create-today's-log command", () => {
	beforeEach(() => {
		Notice.messages = [];
	});

	/** A vault that has been through the settings screen. */
	function configured(): ReturnType<typeof defaultData> {
		const data = defaultData();
		data.core.layout.dailyLogFolder = "Journal";
		data.core.layout.dailyLogFilename = "YYYY/YYYY-MM-DD";
		return data;
	}

	/**
	 * Presses the command, then lets the work it starts finish.
	 *
	 * Named by the id the core writes. Obsidian registers it under the manifest
	 * id and a colon in front of that, so the lookup adds the prefix the
	 * application would.
	 */
	async function press(plugin: Started, id: string): Promise<void> {
		const registeredAs = `${plugin.manifest.id}:${id}`;
		const command = plugin.commands.find((each) => each.id === registeredAs);
		expect(command, `no command with the id "${id}"`).toBeDefined();
		// Obsidian calls this and looks at nothing it returns, so the test does
		// the same: anything that escapes here escapes in the app too.
		expect(() => command?.callback?.()).not.toThrow();
		await turns(20);
	}

	it("is registered when the plugin loads, under an id that will not move", async () => {
		const plugin = await start(new App(), (p) => p.seedData(configured()));

		expect(plugin.commands[0].id).toBe("effortless:create-todays-log");
		expect(plugin.commands[0].name).toBe("Create today's log");

		// The core offers this one command and no other — whatever the extra one
		// were called, and wherever in the palette it sat.
		//
		// What makes that checkable is the registry itself rather than the shape
		// of an id. Switching every registered feature off makes the registry
		// hand back exactly the commands its features own, so whatever is left in
		// the palette afterwards was registered by the core. The stub's
		// `commands` is now a live set that a withdrawal really empties, as
		// Obsidian's palette is, so what is left is read directly rather than
		// worked out by subtracting one of the stub's lists from the other.
		//
		// This used to assert that the core's command came first and that every
		// later id began with `checkbox-cycling:`. Two core commands passed that:
		// one whose id copied the feature's prefix, and one registered after the
		// feature's. Neither passes a set derived from what the registry took
		// back (#437,
		// correcting the guard as it was left by
		// #325).
		const registry = registries[registries.length - 1];
		expect(registry, "the plugin built no feature registry").toBeDefined();
		for (const row of registry.statuses()) await registry.setEnabled(row.id, false);

		expect(plugin.commands.map((each) => each.id)).toEqual(["effortless:create-todays-log"]);
	});

	it("creates today's log, from today's date and the layout in settings", async () => {
		const app = new App();
		app.vault.allowReads({});
		const plugin = await start(app, (p) => p.seedData(configured()));
		const writer = writers[writers.length - 1];
		const asked = vi.spyOn(writer, "createDailyLog");

		await press(plugin, "create-todays-log");

		expect(asked).toHaveBeenCalledTimes(1);
		const [date, layout] = asked.mock.calls[0];
		expect(date.toDateString()).toBe(new Date().toDateString());
		expect(layout.dailyLogFolder).toBe("Journal");
		expect(layout.dailyLogFilename).toBe("YYYY/YYYY-MM-DD");
		expect(app.vault.created).toHaveLength(1);
		await expect(app.vault.read({ path: app.vault.created[0] })).resolves.toBe(
			"# Notes\n\n## Overdue\n\n## Today\n\n## Calendar\n\n```schema\n| Time | Meeting |\n| --- | --- |\n```\n\n# Diary\n\n",
		);
		expect(Notice.messages).toEqual([]);
	});

	it("creates exactly one note when it is run twice", async () => {
		const app = new App();
		app.vault.allowReads({});
		const plugin = await start(app, (p) => p.seedData(configured()));

		await press(plugin, "create-todays-log");
		await press(plugin, "create-todays-log");

		expect(app.vault.created).toHaveLength(1);
		expect(Notice.messages).toEqual([]);
	});

	// #1201: the writer the plugin builds keeps the section of every log it builds
	// from the template. If the entry point built it without `keepBuiltDiaries`, the
	// log would still be made and `data.json` would hold no day.
	it("keeps the diary section today's log was built with in data.json, when built from the template", async () => {
		const app = new App();
		app.vault.files = [{ path: "Templates/Day.md" }];
		app.vault.allowReads({ "Templates/Day.md": "# Notes\n\n# Diary\n- What did I learn today?\n" });
		const plugin = await start(app, (p) => {
			const data = configured();
			data.core.layout.dailyLogTemplate = "Templates/Day.md";
			p.seedData(data);
		});

		await press(plugin, "create-todays-log");

		expect(app.vault.created).toHaveLength(1);
		const stored = (await plugin.loadData()) as { core: { builtDiaries: Record<string, string> } };
		expect(stored.core.builtDiaries).toEqual({ [localDateKey(new Date())]: "- What did I learn today?\n" });
		expect(Notice.messages).toEqual([]);
	});

	it("says so in a Notice, and throws nothing, when the layout is not answered", async () => {
		// Both halves of the layout ship blank, so this is what an install that
		// has not been through the settings screen looks like — the commonest
		// state this command will be pressed in.
		const app = new App();
		const plugin = await start(app);

		await press(plugin, "create-todays-log");

		expect(Notice.messages).toEqual([
			"Effortless: today's log was not created. " +
				"The daily-log folder is not set. Answer it on the Effortless settings screen.",
		]);
		expect(app.vault.created).toEqual([]);
	});
});

/* -------------------------------------------------------------------------- */
/* The features main.ts registers.                        */
/* -------------------------------------------------------------------------- */

/*
 * This repository held the core and no feature at all until issue #325. What
 * `main.ts` gained for it is one `registry.register(...)` line, and these tests
 * are what say the line is there and that it names the id the feature declares.
 *
 * They do not say that nothing else in the entry point moved to make room for
 * it, and #325's own criterion claimed they did. "Nothing else changed" is a
 * property of a diff; a test watches a running plugin, so no test here can see
 * it. The part a run *can* show — that the core still registers exactly one
 * command of its own — is guarded above, in the create-today's-log describe.
 *
 * They read the plugin's own registry rather than a registry built beside it,
 * for the reason the three describes above give: a feature registered into a
 * separate registry proves nothing about the one the app is running.
 *
 * The stub now behaves as Obsidian does: `commands` is the palette as it stands,
 * which a withdrawal really empties, and `removedCommands` is the call log —
 * every id `removeCommand` was handed, exactly as the caller wrote it. So a test
 * about what is in the palette reads `commands`, and a test about the id the
 * plugin handed Obsidian reads `removedCommands`.
 */

describe("the features main.ts registers", () => {
	beforeEach(() => {
		Notice.messages = [];
	});

	/** The registry the plugin is really running on. */
	function registryOf(): FeatureRegistry {
		const registry = registries[registries.length - 1];
		expect(registry, "the plugin built no feature registry").toBeDefined();
		return registry;
	}

	/** A feature that starts cleanly and does nothing, to stand beside the shipped one. */
	class Quiet extends Feature {
		readonly id = "quiet";
		readonly name = "Quiet";
		readonly description = "Starts, and does nothing at all.";

		readiness(): Readiness {
			return { state: "ready" };
		}
	}

	it("registers eight features — three running, building the days ahead and meeting notes on standby, migration, review and task consistency not configured — and no other", async () => {
		await start(new App());

		expect(registryOf().statuses().map((row) => [row.id, row.state])).toEqual([
			["checkbox-cycling", "running"],
			["date-entry", "running"],
			["day-view", "running"],
			// Standby on a fresh install: nothing has told this device it builds
			// the days ahead, and meeting notes are the same job.
			["days-ahead", "standby"],
			["meeting-notes", "standby"],
			// Not configured on a fresh install: the daily-log folder and
			// filename are blank until answered, the same reason as task
			// consistency's below; migration also needs the tasks heading,
			// which ships as "Tasks".
			["migration", "unconfigured"],
			// Not configured on a fresh install: no note has a day until the
			// daily-log folder and filename are answered.
			["review", "unconfigured"],
			// Not configured on a fresh install: the daily-log folder and
			// filename are blank until answered, and that is task
			// consistency's own readiness.
			["task-consistency", "unconfigured"],
		]);
	});

	it("registers it under the id the feature declares, which the core would refuse", async () => {
		// `register` throws when the id in `main.ts` and the feature's own `id`
		// disagree, so a start that returns at all has already checked this. The
		// row is read as well, so the assertion says which id was agreed on.
		await start(new App());

		const [row] = registryOf().statuses();
		expect(row.id).toBe("checkbox-cycling");
		expect(row.name).toBe("Checkbox cycling");
		expect(row.description.endsWith(".")).toBe(true);
	});

	it("puts two commands per shipped sequence in the palette, after the core's own", async () => {
		const plugin = await start(new App());

		expect(plugin.commands.map((each) => each.id)).toEqual([
			"effortless:create-todays-log",
			"effortless:checkbox-cycling:shipped-task-flow:forward",
			"effortless:checkbox-cycling:shipped-task-flow:backward",
			"effortless:checkbox-cycling:shipped-annotations:forward",
			"effortless:checkbox-cycling:shipped-annotations:backward",
			// Migration's two commands, registered before
			// Task consistency's, which comes next.
			"effortless:file-task",
			"effortless:jump-filed",
			"effortless:mark-as-processed",
			// Task consistency's own jump-to-source command:
			// registered from `onload` regardless of readiness, the same way
			// checkbox cycling's own four are.
			"effortless:jump-to-source",
		]);
		expect(plugin.commands.map((each) => each.name)).toEqual([
			"Create today's log",
			"Task flow: cycle forward",
			"Task flow: cycle backward",
			"Annotations: cycle forward",
			"Annotations: cycle backward",
			"Migration: file this task into a collection",
			"Migration: go to this task in its collection",
			"Mark as processed",
			"Task consistency: go to the task in its collection",
		]);
	});

	it("takes every one of them back when the feature is switched off", async () => {
		const plugin = await start(new App());

		await registryOf().setEnabled("checkbox-cycling", false);

		// Short ids, because that is what Obsidian's `removeCommand` wants — it
		// adds the manifest prefix itself, and handing it a prefixed id removed
		// nothing at all.
		expect(plugin.removedCommands).toEqual([
			"checkbox-cycling:shipped-task-flow:forward",
			"checkbox-cycling:shipped-task-flow:backward",
			"checkbox-cycling:shipped-annotations:forward",
			"checkbox-cycling:shipped-annotations:backward",
		]);
		// And the palette is really empty of them, which is the assertion the
		// line above could not make while the stub removed nothing. Task
		// consistency's own jump-to-source command stays: only checkbox
		// cycling was switched off.
		expect(plugin.commands.map((each) => each.id)).toEqual([
			"effortless:create-todays-log",
			"effortless:file-task",
			"effortless:jump-filed",
			"effortless:mark-as-processed",
			"effortless:jump-to-source",
		]);
	});

	it("registers its whole set again when the feature is switched off and on", async () => {
		// The feature keeps its own record of what it holds, and the core empties
		// its list of ids on the way down. If the feature did not empty its record
		// too, switching it back on would find every command already registered
		// and put none of them back — a switch that turns the feature on and
		// leaves the palette empty.
		//
		// Unloading the whole *plugin* is not this case and is not tested here.
		// The registry takes a feature's commands back when that feature stops;
		// when the plugin stops, Obsidian drops every command the plugin added,
		// which is the app's own doing and not something the stub can show.
		const plugin = await start(new App());
		const registry = registryOf();

		await registry.setEnabled("checkbox-cycling", false);
		await registry.setEnabled("checkbox-cycling", true);

		// The stub's palette is a live set, so the four the first load registered
		// were taken out on the way down and the four the second load registers
		// are all that is there.
		const mine = plugin.commands
			.map((each) => each.id)
			.filter((id) => id.startsWith("effortless:checkbox-cycling:"));
		expect(mine).toHaveLength(4);
		expect(registry.statuses()[0].state).toBe("running");
	});

	it("leaves the core alone and every other feature in the state it had when this one fails to start", async () => {
		// A slice written by a hand-edited `data.json` or by a version this one
		// does not know: the sequences are not a list at all, so asking the
		// feature whether it is ready throws.
		const data = defaultData();
		data.features["checkbox-cycling"] = { sequences: "not a list" };
		const plugin = await start(new App(), (p) => p.seedData(data));

		expect(registryOf().statuses()[0].state).toBe("failed");
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("Checkbox cycling");
		// The core kept its own command, and nothing of the broken feature is in
		// the palette — task consistency's own jump-to-source command
		// still started, since it is a different feature.
		expect(plugin.commands.map((each) => each.id)).toEqual([
			"effortless:create-todays-log",
			"effortless:file-task",
			"effortless:jump-filed",
			"effortless:mark-as-processed",
			"effortless:jump-to-source",
		]);

		// And a feature registered beside it still starts.
		registryOf().register("quiet", (host: FeatureHost) => new Quiet(host));
		await registryOf().setEnabled("quiet", true);

		expect(registryOf().statuses().map((row) => [row.id, row.state])).toEqual([
			["checkbox-cycling", "failed"],
			["date-entry", "running"],
			["day-view", "running"],
			["days-ahead", "standby"],
			["meeting-notes", "standby"],
			["migration", "unconfigured"],
			["review", "unconfigured"],
			["task-consistency", "unconfigured"],
			["quiet", "running"],
		]);
	});
});

describe("renaming a collection, as main.ts wires it", () => {
	it("rewrites the renamed collection's link in a day's log through the plugin's own startup, not only through the module", async () => {
		// The wiring line in `main.ts` was applied by the wave for #803, which
		// was not allowed to touch this file; `collectionRename.test.ts` wires
		// the module by hand. If `main.ts` never called `watchCollectionRenames`,
		// or handed it a layout without the day's log answered, the log below
		// would still read `[[Old name]]`. Every path and line here is invented.
		const app = new App();
		await start(app, (plugin) => {
			const data = defaultData();
			data.core.layout.dailyLogFolder = "Journal";
			data.core.layout.dailyLogFilename = "YYYY-MM-DD";
			plugin.seedData(data);
		});
		app.vault.files = [{ path: "Journal/2026-01-05.md" }, { path: "Projects/New name.md" }];
		app.metadataCache.caches.set("Projects/New name.md", {
			headings: [{ heading: "Tasks", level: 2, position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 0, offset: 0 } } }],
		});
		app.metadataCache.resolvedLinks = { "Journal/2026-01-05.md": { "Projects/Old name.md": 1 } };
		app.vault.allowReads({ "Journal/2026-01-05.md": "- [ ] Call about the roof [[Old name]]\n" });

		app.vault.fire("rename", { path: "Projects/New name.md" }, "Projects/Old name.md");
		await turns(12);

		expect(await app.vault.cachedRead({ path: "Journal/2026-01-05.md" })).toBe("- [ ] Call about the roof [[New name]]\n");
	});
});

describe("an outside change to data.json, as main.ts wires the hook", () => {
	it("is taken by the store when Obsidian calls onExternalSettingsChange, and kept by the next save", async () => {
		// `onExternalSettingsChange` is Obsidian's hook (`obsidian.d.ts:5085`).
		// `SettingsStore.reloadExternal` is tested on its own in
		// `settingsExternalChange.test.ts`; this is the line that connects the
		// two, which only the entry point can show: a plugin that never defined
		// the hook would pass every one of those tests and still lose the
		// outside change at its next save.
		const plugin = await start(new App());
		const store = stores[stores.length - 1];
		await store.flush();
		const stored = (await plugin.loadData()) as { features: Record<string, unknown> };
		stored.features["probe-from-other-device"] = { rows: { "meeting-a|2031-01-05|540": "Stand-up" } };
		plugin.seedData(stored);

		await plugin.onExternalSettingsChange?.();
		await store.setEnabled("checkbox-cycling", false);

		const file = (await plugin.loadData()) as {
			core: { enabled: Record<string, boolean> };
			features: Record<string, unknown>;
		};
		expect(file.features["probe-from-other-device"]).toEqual({ rows: { "meeting-a|2031-01-05|540": "Stand-up" } });
		expect(file.core.enabled["checkbox-cycling"]).toBe(false);
	});
});

/*
 * Issue #1216: a password the per-device store held before the keychain moves
 * into it when the plugin starts, before the calendar is built.
 */
describe("a password kept before the keychain, as main.ts moves it", () => {
	beforeEach(() => {
		Notice.messages = [];
	});

	it("is in the keychain once the plugin has started, gone from the per-device store, and nothing is said", async () => {
		const app = new App();
		app.saveLocalStorage("effortless:device", { accountPasswords: { "acc-1": "fake-one" } });
		await start(app);
		expect(app.secretStorage.getSecret("effortless-calendar-acc-1")).toBe("fake-one");
		expect((app.loadLocalStorage("effortless:device") as { accountPasswords: unknown }).accountPasswords).toEqual({});
		expect(Notice.messages.filter((message) => message.includes("keychain"))).toEqual([]);
	});

	it("stays where it was when the keychain does not read it back, and a notice names the account", async () => {
		const app = new App();
		app.saveLocalStorage("effortless:device", { accountPasswords: { "acc-1": "fake-one" } });
		app.secretStorage.getSecret = () => "something else";
		await start(app, (plugin) => {
			plugin.seedData({
				core: { calendarAccounts: [{ id: "acc-1", address: "https://caldav.example.test", user: "someone@example.test" }] },
			});
		});
		expect((app.loadLocalStorage("effortless:device") as { accountPasswords: unknown }).accountPasswords).toEqual({
			"acc-1": "fake-one",
		});
		expect(Notice.messages).toContain(
			"Effortless: a calendar account's app-specific password could not move to Obsidian's keychain, and stayed on this device where it was kept before. " +
				'Effortless tries again when it next starts. "someone@example.test": The keychain did not read back what was written.',
		);
	});
});
