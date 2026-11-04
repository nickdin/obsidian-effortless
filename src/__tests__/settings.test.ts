import { describe, expect, it, vi } from "vitest";
// The stub is imported by path rather than as "obsidian": `tsc` checks this
// file against the real API, and only vitest redirects that name. Where the
// core asks for a real Obsidian type, the stub is cast at the call.
import type { App as ObsidianApp, Plugin as ObsidianPlugin } from "obsidian";
import { App, Notice, Plugin, resetLanguage, resetSettings, setLanguage } from "./__mocks__/obsidian";
import type { CalendarRead } from "../core/calendarSources";
import { newCalendarSource, sourceProblem } from "../core/calendarSources";
import { renderCalendarSources } from "../core/calendarSourcesSection";
import { createSaveFailureAnnouncer } from "../core/saveFailureAnnouncer";
import type { EffortlessData } from "../core/settings";
import { DeviceStore, SAVE_AFTER_TYPING_MS, SettingsStore, defaultData } from "../core/settings";

describe("SettingsStore", () => {
	it("ships with both daily-note answers blank", async () => {
		const store = new SettingsStore(new Plugin() as unknown as ObsidianPlugin);
		await store.load();
		expect(store.core().layout.dailyLogFolder).toBe("");
		expect(store.core().layout.dailyLogFilename).toBe("");
	});

	it("does not erase one feature's settings when another saves", async () => {
		const store = new SettingsStore(new Plugin() as unknown as ObsidianPlugin);
		await store.load();

		const cycler = store.handleFor("checkbox-cycler", { sequence: " x" });
		const dates = store.handleFor("task-dates", { language: "en" });

		await cycler.save({ sequence: " /x-" });
		await dates.save({ language: "sv" });

		expect(cycler.read()).toEqual({ sequence: " /x-" });
		expect(dates.read()).toEqual({ language: "sv" });
	});

	it("keeps the core settings when a feature saves", async () => {
		const plugin = new Plugin();
		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await store.load();

		const core = store.core();
		await store.saveCore({ ...core, layout: { ...core.layout, dailyLogFolder: "Journal" } });
		await store.handleFor("task-dates", { language: "en" }).save({ language: "sv" });

		const reloaded = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await reloaded.load();
		expect(reloaded.core().layout.dailyLogFolder).toBe("Journal");
	});

	it("fills in a setting a feature has gained since the file was written", async () => {
		const store = new SettingsStore(new Plugin() as unknown as ObsidianPlugin);
		await store.load();

		await store.handleFor("task-dates", { language: "en" }).save({ language: "sv" });
		const wider = store.handleFor("task-dates", { language: "en", suggest: true });

		expect(wider.read()).toEqual({ language: "sv", suggest: true });
	});

	it("treats a feature nobody has switched off as on", async () => {
		const store = new SettingsStore(new Plugin() as unknown as ObsidianPlugin);
		await store.load();
		expect(store.isEnabled("never-mentioned")).toBe(true);

		await store.setEnabled("never-mentioned", false);
		expect(store.isEnabled("never-mentioned")).toBe(false);
	});
});

describe("how the settings file is written", () => {
	/**
	 * A plugin whose writes finish only when the test says so, so a test can see
	 * exactly how many are open at once and settle them in an order it chooses.
	 * `saved` still gets its entry, but only when `finish` is called.
	 */
	class HeldPlugin extends Plugin {
		/** Every write that has begun and not yet been let finish, in order. */
		readonly inFlight: Array<{ data: unknown; finish: () => void; fail: (why: Error) => void }> = [];

		override saveData(data: unknown): Promise<void> {
			// Copied as the write begins, the way the real adapter serialises
			// what it was handed. The store passes the same object every time,
			// so a copy taken at `finish` would show every write the newest
			// values and hide the very lost update this is here to catch.
			const frozen: unknown = JSON.parse(JSON.stringify(data));
			const write = super.saveData.bind(this);
			return new Promise<void>((resolve, reject) => {
				this.inFlight.push({
					data: frozen,
					finish: () => void write(frozen).then(resolve),
					fail: (why) => reject(why),
				});
			});
		}
	}

	/** Lets every promise that is ready settle before the test looks again. */
	function settleMicrotasks(): Promise<void> {
		return new Promise<void>((resolve) => setTimeout(resolve, 0));
	}

	function storeOver(plugin: Plugin): SettingsStore {
		return new SettingsStore(plugin as unknown as ObsidianPlugin);
	}

	/**
	 * `storeOver`, loaded, with the load-time language-history write #747
	 * always starts on a fresh install — one write, of the whole file, since
	 * this store has no partial write — already settled and dropped from
	 * `plugin.saved` before the caller's own writes begin. This suite is about
	 * the writes each test itself asks for, not the one `load` starts on its
	 * own; `"the day's-log language history"` below is where that
	 * one is tested.
	 */
	async function loadedFresh(plugin: Plugin): Promise<SettingsStore> {
		const store = storeOver(plugin);
		await store.load();
		// `flush` waits on the write's own promise chain rather than a real
		// timer, so it settles the load-time write under fake timers too — a
		// plain macrotask-based settle would wait on a `setTimeout` fake
		// timers never fire. The push into `saved` happens synchronously
		// inside `saveData`, but the write's own read-back is still an
		// `await` or two behind it; a caller that changes `plugin.stored`
		// from here (`seedData`, standing in for another session) before that
		// read-back runs makes it find a file it did not write and report a
		// failure that has nothing to do with what the caller is actually
		// testing.
		await store.flush();
		plugin.saved.length = 0;
		return store;
	}

	/** {@link loadedFresh}, for a `HeldPlugin` — the load-time write is held open rather than landed, so it is finished before `flush` is asked to wait for it. */
	async function loadedFreshHeld(plugin: HeldPlugin): Promise<SettingsStore> {
		const store = storeOver(plugin);
		await store.load();
		// `saveData`'s override pushes into `inFlight` synchronously as it is
		// called, so the load-time write is already sitting there — no settle
		// needed before finishing it.
		plugin.inFlight[0]?.finish();
		await store.flush();
		plugin.saved.length = 0;
		plugin.inFlight.length = 0;
		return store;
	}

	function withFolder(store: SettingsStore, named: string): Promise<void> {
		const core = store.core();
		return store.saveCoreSoon({ ...core, layout: { ...core.layout, dailyLogFolder: named } });
	}

	/*
	 * Every text row on the core card saved on `onChange`, which fires once per
	 * character, and each save was a whole rewrite of the settings file. Typing
	 * `Journal` started seven of them, none of them awaited, none of them
	 * ordered — and the vault adapter does not queue writes to one path, so the
	 * file could keep `Journa` while the screen showed `Journal`.
	 */
	it("writes once for a run of characters, rather than once for each", async () => {
		vi.useFakeTimers();
		try {
			const plugin = new Plugin();
			const store = await loadedFresh(plugin);

			let settled: Promise<void> = Promise.resolve();
			for (const typed of ["J", "Jo", "Jou", "Jour", "Journ", "Journa", "Journal"]) {
				settled = withFolder(store, typed);
			}
			expect(plugin.saved).toEqual([]);

			await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);
			await settled;

			expect(plugin.saved).toHaveLength(1);
			expect(plugin.saved[0]).toContain("Journal");
		} finally {
			vi.useRealTimers();
		}
	});

	it("shows what was typed straight away, long before the write", async () => {
		vi.useFakeTimers();
		try {
			const store = storeOver(new Plugin());
			await store.load();

			void withFolder(store, "Journal");

			// A redraw between the keystroke and the write must show the typing.
			expect(store.core().layout.dailyLogFolder).toBe("Journal");
		} finally {
			vi.useRealTimers();
		}
	});

	it("never has two writes of the file open at once", async () => {
		const plugin = new HeldPlugin();
		const store = storeOver(plugin);
		await store.load();

		void store.saveCore({ ...store.core(), layout: { ...store.core().layout, tasksHeading: "One" } });
		void store.saveCore({ ...store.core(), layout: { ...store.core().layout, tasksHeading: "Two" } });
		await settleMicrotasks();

		expect(plugin.inFlight).toHaveLength(1);

		plugin.inFlight[0].finish();
		await settleMicrotasks();

		expect(plugin.inFlight).toHaveLength(2);
	});

	/*
	 * Two saves in a row end on the second one's text, in the file and on a fresh
	 * read of it.
	 *
	 * This is not a guard against out-of-order settlement, and once claimed to be. It drains `plugin.inFlight` with `pop()`, which is newest
	 * first — but the queue #54 added means `inFlight` never holds more than one
	 * entry, so `pop()` always takes the only element and newest-first is the
	 * same walk as oldest-first. The sequence the old name described cannot be
	 * produced here at all.
	 *
	 * The ordering guarantee is held by its sibling above,
	 * `it("never has two writes of the file open at once")`. That is the test to
	 * change if the queue ever goes; this one would still pass without it.
	 */
	it("ends on the last value written", async () => {
		const plugin = new HeldPlugin();
		const store = await loadedFreshHeld(plugin);

		const first = store.saveCore({
			...store.core(),
			layout: { ...store.core().layout, tasksHeading: "Older" },
		});
		const second = store.saveCore({
			...store.core(),
			layout: { ...store.core().layout, tasksHeading: "Newer" },
		});

		await settleMicrotasks();
		while (plugin.inFlight.length > 0) {
			const newest = plugin.inFlight.pop();
			newest?.finish();
			await settleMicrotasks();
		}
		await first;
		await second;

		expect(plugin.saved).toHaveLength(2);
		expect(plugin.saved[plugin.saved.length - 1]).toContain("Newer");

		const reloaded = storeOver(plugin);
		await reloaded.load();
		expect(reloaded.core().layout.tasksHeading).toBe("Newer");
	});

	it("serialises a feature's own save with the core's, because they share the file", async () => {
		const plugin = new HeldPlugin();
		const store = storeOver(plugin);
		await store.load();

		void store.saveCore(store.core());
		void store.setEnabled("task-dates", false);
		void store.handleFor("task-dates", { language: "en" }).save({ language: "sv" });
		await settleMicrotasks();

		expect(plugin.inFlight).toHaveLength(1);

		plugin.inFlight[0].finish();
		await settleMicrotasks();

		expect(plugin.inFlight).toHaveLength(2);
	});

	it("still lets a feature be switched off and read back off", async () => {
		vi.useFakeTimers();
		try {
			const plugin = new Plugin();
			const store = storeOver(plugin);
			await store.load();

			void withFolder(store, "Journal");
			await store.setEnabled("task-dates", false);
			await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);

			const reloaded = storeOver(plugin);
			await reloaded.load();
			expect(reloaded.isEnabled("task-dates")).toBe(false);
			expect(reloaded.core().layout.dailyLogFolder).toBe("Journal");
		} finally {
			vi.useRealTimers();
		}
	});

	/*
	 * The settings screen announces a failed write in a Notice, and it can only
	 * do that if the failure reaches it. Neither the debounce nor the queue may
	 * swallow one — the box would go on showing what the person typed and the
	 * next reload would quietly drop it.
	 */
	it("hands a failed write back to the caller rather than swallowing it", async () => {
		const plugin = new Plugin();
		const store = storeOver(plugin);
		await store.load();
		plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));

		await expect(store.saveCore(store.core())).rejects.toThrow("the vault is read-only");
	});

	it("hands a failed debounced write back too, once the typing has settled", async () => {
		vi.useFakeTimers();
		try {
			const plugin = new Plugin();
			const store = storeOver(plugin);
			await store.load();
			plugin.saveData = () => Promise.reject(new Error("no space left on device"));

			const settled = withFolder(store, "Journal");
			const caught = expect(settled).rejects.toThrow("no space left on device");
			await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);
			await caught;
		} finally {
			vi.useRealTimers();
		}
	});

	it("goes on writing after one write has failed", async () => {
		const plugin = new Plugin();
		const store = storeOver(plugin);
		await store.load();
		const real = plugin.saveData.bind(plugin);
		plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));

		await expect(store.saveCore(store.core())).rejects.toThrow("the vault is read-only");
		plugin.saveData = real;
		await store.saveCore({ ...store.core(), layout: { ...store.core().layout, tasksHeading: "Later" } });

		const reloaded = storeOver(plugin);
		await reloaded.load();
		expect(reloaded.core().layout.tasksHeading).toBe("Later");
	});

	/*
	 * Issue #358. #188 gave
	 * the store a flag saying the plugin had unloaded, and exactly one method
	 * read it — the one that defers a core-settings write. `setEnabled` and the
	 * handle a feature is given went straight to the write queue, so the
	 * overwrite #188 was filed about was still reachable through either of
	 * them: the queue waits for whatever write is open, so a save asked for a
	 * moment before the unload calls `saveData` a moment after it, over the
	 * file a re-enabled instance has since written.
	 *
	 * The refusal now lives in the write itself, so every route answers alike.
	 * The one exception is the write `teardown` runs, which has to land.
	 */
	describe("what every route into the file answers after the unload", () => {
		it("refuses a feature being switched off, and writes nothing", async () => {
			const plugin = new Plugin();
			const store = storeOver(plugin);
			await store.load();
			store.teardown();
			const after = plugin.saved.length;

			await expect(store.setEnabled("day-plan", false)).rejects.toThrow(/unloaded/i);

			expect(plugin.saved.length).toBe(after);
		});

		it("refuses a feature saving its own settings, and writes nothing", async () => {
			const plugin = new Plugin();
			const store = storeOver(plugin);
			await store.load();
			store.teardown();
			const after = plugin.saved.length;

			const dates = store.handleFor("task-dates", { language: "en" });
			await expect(dates.save({ language: "sv" })).rejects.toThrow(/unloaded/i);

			expect(plugin.saved.length).toBe(after);
		});

		it("refuses a save that was already queued behind an open write when the unload came", async () => {
			const plugin = new HeldPlugin();
			const store = await loadedFreshHeld(plugin);

			// One write open and held, and a second asked for behind it. Both
			// were asked for before the unload, which is why reading the flag
			// at the door would let this one through: its turn comes later.
			const open = store.setEnabled("day-plan", false);
			await settleMicrotasks();
			expect(plugin.inFlight).toHaveLength(1);
			const queued = store.handleFor("task-dates", { language: "en" }).save({ language: "sv" });

			store.teardown();
			plugin.inFlight[0].finish();

			await expect(queued).rejects.toThrow(/unloaded/i);
			await open;
			await settleMicrotasks();

			// A second entry here would be `saveData` reached on a dead plugin,
			// which is the whole of the defect.
			expect(plugin.inFlight).toHaveLength(1);
			expect(plugin.saved).toHaveLength(1);
		});

		it("still lands the write the unload was holding, which is the one exception", async () => {
			vi.useFakeTimers();
			try {
				const plugin = new Plugin();
				const store = await loadedFresh(plugin);
				const written = withFolder(store, "Journal");

				store.teardown();
				await written;
				await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS * 3);

				// Refusing this one would turn #188's fix into deliberate data
				// loss: the change is on that timer and nowhere else.
				expect(plugin.saved).toHaveLength(1);
				expect(plugin.saved[0]).toContain("Journal");
			} finally {
				vi.useRealTimers();
			}
		});
	});

	/*
	 * Issue #385. The
	 * refusal above stops the call and not the change: every route alters the
	 * store's in-memory settings before its write is attempted, which #358's own
	 * brief required and which is right on its own. The write `teardown` runs is
	 * exempt from the refusal, and it used to be handed those live settings — so
	 * a change made after the unload, by a caller that was told the plugin had
	 * unloaded, went into `data.json` all the same. Arbitrarily late, too: that
	 * write queues behind whatever is open, so it can land over what a
	 * re-enabled instance has since stored, which is the whole of #188.
	 *
	 * What these ask for is the pair in one run — a refused save *and* a write
	 * the unload was holding. Either alone is already covered above, and neither
	 * alone leaks.
	 *
	 * Issue #457 is the
	 * second half of the same defect. `flush` and `teardown` drain the one
	 * deferred slot, so whichever runs first is the one that hands the write its
	 * settings — and only `teardown` copied them. Every case #385 added drove
	 * `teardown` first, so the other order, in which `flush` handed the live
	 * object over and `teardown` found nothing left to copy, leaked exactly as
	 * before and no test saw it. The last case here is that order.
	 */
	describe("what the write the unload runs carries", () => {
		/**
		 * A store in the state where the leak is reachable: one write open and
		 * held, a change typed inside the debounce window, then the unload. The
		 * write the unload starts is queued behind the open one, so it cannot
		 * land until the test says so — which is the room a refused caller had to
		 * change the settings underneath it.
		 *
		 * **The unload is both halves, and which one goes first is the argument.**
		 * `main.ts` registers `teardown` as a cleanup and awaits `flush` in
		 * `onunload`, and no comment in this repository can say which of the two
		 * Obsidian reaches first. Both drain the deferred slot, so both orders
		 * have to leave the file alone.
		 */
		async function unloadedMidWrite(
			order: "teardown-first" | "flush-first" = "teardown-first",
		): Promise<{
			plugin: HeldPlugin;
			store: SettingsStore;
			open: Promise<void>;
			typed: Promise<void>;
			/** The flush this order started, or null where it started none. */
			flushed: Promise<void> | null;
		}> {
			const plugin = new HeldPlugin();
			const store = await loadedFreshHeld(plugin);

			// A feature switched off a moment before the unload, still writing.
			const open = store.setEnabled("day-plan", false);
			await settleMicrotasks();
			expect(plugin.inFlight).toHaveLength(1);

			// The folder box, typed into and not yet written. This is the change
			// only the deferred write can land.
			const typed = withFolder(store, "Journal");
			if (order === "teardown-first") {
				store.teardown();
				return { plugin, store, open, typed, flushed: null };
			}
			// Not awaited: `flush` starts the deferred write in the same
			// synchronous step and then waits for every write to land, which the
			// test itself is holding up. Awaiting here would deadlock.
			const flushed = store.flush();
			store.teardown();
			return { plugin, store, open, typed, flushed };
		}

		/** Lets every held write finish, in the order they began. */
		async function landEveryWrite(plugin: HeldPlugin): Promise<void> {
			for (let i = 0; i < plugin.inFlight.length; i++) {
				plugin.inFlight[i].finish();
				// A write that was queued behind this one begins here, so the
				// loop's bound is re-read rather than taken once.
				await settleMicrotasks();
			}
		}

		/** What the deferred write the unload ran handed the plugin. */
		function deferredWrite(plugin: HeldPlugin): EffortlessData {
			// Two writes land in all of these: the one that was open, and the
			// deferred one. A third would be a refused caller reaching `saveData`.
			expect(plugin.saved).toHaveLength(2);
			return JSON.parse(plugin.saved[1]) as EffortlessData;
		}

		it("leaves out what a refused setEnabled changed after the unload", async () => {
			const { plugin, store, open, typed } = await unloadedMidWrite();

			// The rejection is caught before the writes are let go, the way the
			// debounced-failure test above does it: the refusal happens while
			// they land, and a rejection nothing is listening to yet is reported
			// as unhandled.
			const refused = expect(store.setEnabled("mirror", false)).rejects.toThrow(/unloaded/i);
			await landEveryWrite(plugin);

			await refused;
			await open;
			await typed;

			// The store's own settings do carry it. `queueWrite`'s rule is that
			// after the unload nothing restores memory, because nothing reads it
			// again — so the refused change stays in memory. It is the file that
			// must not have it.
			expect(store.isEnabled("mirror")).toBe(false);

			const written = deferredWrite(plugin);
			expect(written.core.enabled).toEqual({ "day-plan": false });
			// And the change teardown was holding is still written. Dropping it
			// would turn #188's fix into deliberate data loss.
			expect(written.core.layout.dailyLogFolder).toBe("Journal");
		});

		it("leaves out what a refused feature save changed after the unload", async () => {
			const { plugin, store, open, typed } = await unloadedMidWrite();

			const refused = expect(
				store.handleFor("task-dates", { language: "en" }).save({ language: "sv" }),
			).rejects.toThrow(/unloaded/i);
			await landEveryWrite(plugin);

			await refused;
			await open;
			await typed;

			const written = deferredWrite(plugin);
			expect(written.features).toEqual({});
			expect(written.core.layout.dailyLogFolder).toBe("Journal");
		});

		it("leaves out what a refused saveCore changed after the unload", async () => {
			const { plugin, store, open, typed } = await unloadedMidWrite();

			const core = store.core();
			const refused = expect(
				store.saveCore({ ...core, layout: { ...core.layout, tasksHeading: "Later" } }),
			).rejects.toThrow(/unloaded/i);
			await landEveryWrite(plugin);

			await refused;
			await open;
			await typed;

			const written = deferredWrite(plugin);
			expect(written.core.layout.tasksHeading).toBe("Tasks");
			expect(written.core.layout.dailyLogFolder).toBe("Journal");
		});

		/*
		 * The same leak through the other door. `flush` empties the
		 * deferred slot first, so `teardown` finds nothing waiting and returns
		 * without copying anything — and the write flush started is the one that
		 * reaches the file. While that write held the live settings, the refused
		 * `setEnabled` below put `mirror` into `data.json` after the plugin had
		 * been told it was gone.
		 */
		it("leaves it out just the same when flush drained the write before teardown", async () => {
			const { plugin, store, open, typed, flushed } = await unloadedMidWrite("flush-first");

			const refused = expect(store.setEnabled("mirror", false)).rejects.toThrow(/unloaded/i);
			await landEveryWrite(plugin);

			await refused;
			await open;
			await typed;
			await flushed;

			expect(store.isEnabled("mirror")).toBe(false);

			const written = deferredWrite(plugin);
			expect(written.core.enabled).toEqual({ "day-plan": false });
			expect(written.core.layout.dailyLogFolder).toBe("Journal");
		});
	});

	/*
	 * Issue #567. #385 and
	 * #457 between them made `teardown` and `flush` each copy the settings as
	 * they emptied the deferred slot, but the slot has a third starter: its
	 * own debounce timer. A timer that fires on its own, before either half of
	 * the unload, empties the slot itself — so neither `teardown` nor `flush`
	 * has anything left to copy, and the write the timer started went on
	 * carrying the live settings object, exactly as before #385.
	 *
	 * The fix moves the copy into `waiting.write` itself, so the timer, `flush`
	 * and `teardown` all take it the same way, at the moment whichever of them
	 * runs. `plugin.holdSaves()` is what lets these hold the first write open
	 * long enough to drive the rest of the sequence around it and release
	 * everything at once.
	 */
	describe("the debounce timer as a third starter into the deferred write", () => {
		/*
		 * The sequence measured in the ticket body, driven against this file: a
		 * write held open, a folder typed, the timer let fire on its own, then
		 * both halves of the unload, then a refused toggle. Before the fix the
		 * second write — the one the timer started — carried
		 * `{ "day-plan": false, "mirror": false }`, because the timer had
		 * handed `persistDeferred` a live reference and the refused
		 * `setEnabled` mutated it before that write's own turn in the queue
		 * came.
		 */
		it("leaves out a refused toggle even though the timer started the deferred write before the unload", async () => {
			vi.useFakeTimers();
			try {
				const plugin = new Plugin();
				const store = await loadedFresh(plugin);
				const release = plugin.holdSaves();

				// 1. a write held open;
				const open = store.setEnabled("day-plan", false);

				// 2. a folder typed, so a deferred write is queued;
				const typed = withFolder(store, "Journal");

				// 3. the debounce timer allowed to fire on its own, before
				// either half of the unload. It starts the deferred write,
				// which queues behind the write already open above.
				await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);

				// 4. `teardown()`. The timer already emptied the slot, so
				// this finds nothing of its own to copy.
				store.teardown();

				// 5. `setEnabled("mirror", false)`, refused because the
				// store is unloaded.
				const refused = expect(store.setEnabled("mirror", false)).rejects.toThrow(
					/unloaded/i,
				);

				// 6. every held write released.
				release();

				await refused;
				await open;
				await typed;

				// Two writes land: the one that was open, and the one the
				// timer started. A third would be the refused `setEnabled`
				// reaching `saveData` after the unload.
				expect(plugin.saved).toHaveLength(2);
				const written = JSON.parse(plugin.saved[1]) as EffortlessData;
				expect(written.core.enabled).toEqual({ "day-plan": false });
				// The change the timer was holding is still written: leaving
				// it out would be #188's regression, not #567's fix.
				expect(written.core.layout.dailyLogFolder).toBe("Journal");
			} finally {
				vi.useRealTimers();
			}
		});

		/*
		 * The other half of the acceptance criteria: outside the unload, the
		 * timer copying at the moment it fires must not stop the file ending
		 * on the newest answers. A second change through an
		 * immediate route, arriving after the timer has already taken its
		 * snapshot but before that write's own turn in the queue, must still
		 * reach the file — through its own write, which queues in behind the
		 * timer's.
		 */
		it("still ends the file on both changes when an immediate save queues in behind the timer's write", async () => {
			vi.useFakeTimers();
			try {
				const plugin = new Plugin();
				const store = await loadedFresh(plugin);
				const release = plugin.holdSaves();

				// A write held open, so the timer's deferred write has to
				// queue behind it rather than reaching the file straight away.
				const open = store.setEnabled("day-plan", false);

				// A folder typed, then the timer fires on its own: the
				// deferred write starts, taking its snapshot now.
				const typed = withFolder(store, "Journal");
				await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);

				// A second change, through an immediate route, arrives after
				// the timer's snapshot was taken but before the deferred
				// write's own turn in the queue comes.
				const second = store.setEnabled("mirror", false);

				release();

				await open;
				await typed;
				await second;

				expect(plugin.saved).toHaveLength(3);
				// The timer's own write is the snapshot it took when it
				// fired, and does not carry the later change — #567 changes
				// what this one write carries, not what the file ends
				// holding.
				const deferred = JSON.parse(plugin.saved[1]) as EffortlessData;
				expect(deferred.core.enabled).toEqual({ "day-plan": false });

				// The immediate route's own write queues in behind it and
				// carries the live settings at its own turn, so the file
				// still ends on both changes.
				const last = JSON.parse(plugin.saved[2]) as EffortlessData;
				expect(last.core.enabled).toEqual({ "day-plan": false, mirror: false });
				expect(last.core.layout.dailyLogFolder).toBe("Journal");

				const reloaded = storeOver(plugin);
				await reloaded.load();
				expect(reloaded.isEnabled("mirror")).toBe(false);
				expect(reloaded.core().layout.dailyLogFolder).toBe("Journal");
			} finally {
				vi.useRealTimers();
			}
		});
	});

	/*
	 * Issue #558. Every
	 * route in changes the store's memory before its write is attempted, so a
	 * write that rejected used to leave memory holding what was attempted while
	 * `data.json` kept the old value — and anything drawn from the store showed
	 * a change that was never stored. The cycling panel's list was the one a
	 * person saw: a sequence whose removal failed vanished from the screen and
	 * came back on reload.
	 *
	 * The store now keeps a copy of what the last landed write carried, and
	 * puts memory back to it when a write rejects and no other write is going
	 * to carry the change: nothing queued behind it, nothing waiting on the
	 * timer, and the plugin still loaded. The first three cases are the three
	 * immediate routes. Of the rest, "does not let a restored copy share what
	 * a later change edits in place", "restores to the last write that
	 * landed, not to what was loaded" and "restores after a deferred write
	 * rejects with nothing behind it" are the restore itself; the other two —
	 * the queued-save case and the newer-run-of-typing case — are where
	 * memory must be left alone instead.
	 */
	describe("what the store reads after a write that rejected", () => {
		/**
		 * A store loaded over `plugin`'s file. Called again after a write, it is
		 * what `data.json` holds, read back by a store of its own.
		 */
		/**
		 * `fresh` is read before `load()` runs, so it is true exactly on a
		 * plugin's first ever load — the one case #747's own write can fire on
		 * — and false on a second `loadedOver` over a plugin this describe has
		 * already written to, where settling or clearing anything here would
		 * risk draining a held write this test itself queued rather than the
		 * load's own.
		 */
		async function loadedOver(plugin: Plugin): Promise<SettingsStore> {
			const fresh = plugin.saved.length === 0;
			const store = storeOver(plugin);
			await store.load();
			if (fresh) {
				if (plugin instanceof HeldPlugin) {
					await settleMicrotasks();
					plugin.inFlight[0]?.finish();
					await settleMicrotasks();
					plugin.inFlight.length = 0;
				}
				plugin.saved.length = 0;
			}
			return store;
		}

		it("reads what the file holds after a feature's save rejects", async () => {
			const plugin = new Plugin();
			const store = await loadedOver(plugin);
			const dates = store.handleFor("task-dates", { language: "en" });
			await dates.save({ language: "sv" });
			plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));

			await expect(dates.save({ language: "de" })).rejects.toThrow("the vault is read-only");

			expect(dates.read()).toEqual({ language: "sv" });
		});

		it("reads what the file holds after setEnabled rejects", async () => {
			const plugin = new Plugin();
			const store = await loadedOver(plugin);
			plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));

			await expect(store.setEnabled("day-plan", false)).rejects.toThrow("the vault is read-only");

			expect(store.isEnabled("day-plan")).toBe(true);
			expect((await loadedOver(plugin)).isEnabled("day-plan")).toBe(true);
		});

		it("reads what the file holds after saveCore rejects", async () => {
			const plugin = new Plugin();
			const store = await loadedOver(plugin);
			const core = store.core();
			await store.saveCore({ ...core, layout: { ...core.layout, tasksHeading: "Landed" } });
			plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));

			const attempted = store.core();
			await expect(
				store.saveCore({ ...attempted, layout: { ...attempted.layout, tasksHeading: "Refused" } }),
			).rejects.toThrow("the vault is read-only");

			expect(store.core().layout.tasksHeading).toBe("Landed");
			expect((await loadedOver(plugin)).core().layout.tasksHeading).toBe("Landed");
		});

		it("does not let a restored copy share what a later change edits in place", async () => {
			// `setEnabled` writes one key of `core.enabled` in place. Were memory
			// handed the kept copy itself rather than a copy of it, the next toggle
			// would edit the copy too, and a later restore would bring that toggle
			// back with it.
			const plugin = new Plugin();
			const store = await loadedOver(plugin);
			const real = plugin.saveData.bind(plugin);
			plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));
			await expect(store.setEnabled("day-plan", false)).rejects.toThrow();
			await expect(store.setEnabled("mirror", false)).rejects.toThrow();

			expect(store.isEnabled("day-plan")).toBe(true);
			expect(store.isEnabled("mirror")).toBe(true);
			plugin.saveData = real;
			await store.setEnabled("task-dates", false);
			expect(store.isEnabled("mirror")).toBe(true);
		});

		it("ends the file on the second of two queued saves when the first rejects, and leaves memory alone between them", async () => {
			const plugin = new HeldPlugin();
			const store = await loadedOver(plugin);

			const first = store.saveCore({
				...store.core(),
				layout: { ...store.core().layout, tasksHeading: "Older" },
			});
			const second = store.saveCore({
				...store.core(),
				layout: { ...store.core().layout, tasksHeading: "Newer" },
			});
			await settleMicrotasks();
			expect(plugin.inFlight).toHaveLength(1);

			const refused = expect(first).rejects.toThrow("the vault is read-only");
			plugin.inFlight[0].fail(new Error("the vault is read-only"));
			await refused;
			await settleMicrotasks();

			// The second write carries memory as it stands at its turn, so
			// rolling memory back here would undo the very value it is about to
			// write.
			expect(store.core().layout.tasksHeading).toBe("Newer");
			expect(plugin.inFlight).toHaveLength(2);

			plugin.inFlight[1].finish();
			await second;

			expect(plugin.saved).toHaveLength(1);
			expect(plugin.saved[0]).toContain("Newer");
			expect(store.core().layout.tasksHeading).toBe("Newer");
			expect((await loadedOver(plugin)).core().layout.tasksHeading).toBe("Newer");
		});

		it("restores to the last write that landed, not to what was loaded", async () => {
			const plugin = new HeldPlugin();
			const store = await loadedOver(plugin);

			const landed = store.setEnabled("day-plan", false);
			await settleMicrotasks();
			plugin.inFlight[0].finish();
			await landed;

			const failed = store.setEnabled("mirror", false);
			await settleMicrotasks();
			const refused = expect(failed).rejects.toThrow("the vault is read-only");
			plugin.inFlight[1].fail(new Error("the vault is read-only"));
			await refused;

			expect(store.isEnabled("day-plan")).toBe(false);
			expect(store.isEnabled("mirror")).toBe(true);
		});

		it("restores after a deferred write rejects with nothing behind it", async () => {
			// The run of typing is over and its write was the last: nothing is
			// left to carry what was typed, so the store reads what the file holds.
			// The store says that it put memory back at the moment of the
			// restore, so the settings screen draws the box from what the file
			// holds; a later save from another control of the same section then
			// rebuilds its payload from that restored memory — "saying that
			// memory was put back" below.
			vi.useFakeTimers();
			try {
				const plugin = new Plugin();
				const store = await loadedOver(plugin);
				plugin.saveData = () => Promise.reject(new Error("no space left on device"));

				const typed = withFolder(store, "Journal");
				const refused = expect(typed).rejects.toThrow("no space left on device");
				await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);
				await refused;

				expect(store.core().layout.dailyLogFolder).toBe("");
			} finally {
				vi.useRealTimers();
			}
		});

		it("keeps a newer run of typing in memory when the older run's write rejects, and lands it", async () => {
			vi.useFakeTimers();
			try {
				const plugin = new Plugin();
				const store = await loadedOver(plugin);
				const real = plugin.saveData.bind(plugin);
				let failOlder: (why: Error) => void = () => undefined;
				plugin.saveData = () =>
					new Promise<void>((_resolve, reject) => {
						failOlder = reject;
					});

				// The older run: typed, its timer fired, its write open.
				const older = withFolder(store, "Jour");
				const refused = expect(older).rejects.toThrow("no space left on device");
				await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);

				// The newer run, typed while that write is open. Its keystrokes are
				// in memory and on a timer of their own.
				plugin.saveData = real;
				const newer = withFolder(store, "Journal");

				failOlder(new Error("no space left on device"));
				await refused;

				expect(store.core().layout.dailyLogFolder).toBe("Journal");

				await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);
				await newer;

				expect(store.core().layout.dailyLogFolder).toBe("Journal");
				expect((await loadedOver(plugin)).core().layout.dailyLogFolder).toBe("Journal");
			} finally {
				vi.useRealTimers();
			}
		});
	});

	/*
	 * Issue #588. #558's
	 * restore changes the store's memory on a write that need not be the
	 * listener's own — a sibling box's run of typing, the timer's write behind a
	 * press, a core save queued after a feature's — and nothing that keeps a copy
	 * or a drawing of that memory was told. The store now says so, once per
	 * restore, to everyone who asked; a landing and a rejection that leaves
	 * memory alone change nothing, and say nothing.
	 */
	describe("saying that memory was put back", () => {
		/**
		 * `fresh` is read before `load()` runs, so it is true exactly on a
		 * plugin's first ever load — the one case #747's own write can fire on
		 * — and false on a second `loadedOver` over a plugin this describe has
		 * already written to, where settling or clearing anything here would
		 * risk draining a held write this test itself queued rather than the
		 * load's own.
		 */
		async function loadedOver(plugin: Plugin): Promise<SettingsStore> {
			const fresh = plugin.saved.length === 0;
			const store = storeOver(plugin);
			await store.load();
			if (fresh) {
				if (plugin instanceof HeldPlugin) {
					await settleMicrotasks();
					plugin.inFlight[0]?.finish();
					await settleMicrotasks();
					plugin.inFlight.length = 0;
				}
				plugin.saved.length = 0;
			}
			return store;
		}

		it("tells a listener once when a rejected write puts memory back, with memory already restored", async () => {
			const plugin = new Plugin();
			const store = await loadedOver(plugin);
			const told: string[] = [];
			store.onChange(() => told.push(store.core().layout.tasksHeading));
			plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));

			const core = store.core();
			await expect(
				store.saveCore({ ...core, layout: { ...core.layout, tasksHeading: "Refused" } }),
			).rejects.toThrow("the vault is read-only");

			expect(told).toEqual(["Tasks"]);
		});

		it("tells a feature's handle too, which is how a feature hears it", async () => {
			const plugin = new Plugin();
			const store = await loadedOver(plugin);
			const cycling = store.handleFor("checkbox-cycling", { sequences: ["Task flow"] });
			const told: string[][] = [];
			cycling.onChange(() => told.push(cycling.read().sequences));
			plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));

			await expect(store.setEnabled("day-plan", false)).rejects.toThrow("the vault is read-only");

			expect(told).toEqual([["Task flow"]]);
		});

		it("tells nobody when a write lands", async () => {
			const plugin = new Plugin();
			const store = await loadedOver(plugin);
			let told = 0;
			store.onChange(() => {
				told += 1;
			});

			await store.setEnabled("day-plan", false);
			await store.handleFor("task-dates", { language: "en" }).save({ language: "sv" });

			expect(told).toBe(0);
		});

		it("tells nobody when a rejected write leaves memory alone for the write queued behind it", async () => {
			const plugin = new HeldPlugin();
			const store = await loadedOver(plugin);
			let told = 0;
			store.onChange(() => {
				told += 1;
			});

			const first = store.setEnabled("day-plan", false);
			const second = store.setEnabled("mirror", false);
			await settleMicrotasks();
			const refused = expect(first).rejects.toThrow("the vault is read-only");
			plugin.inFlight[0].fail(new Error("the vault is read-only"));
			await refused;
			await settleMicrotasks();
			plugin.inFlight[1].finish();
			await second;

			expect(told).toBe(0);
		});

		it("tells nobody when a press is refused while typing waits, then once when the timer's write is refused too", async () => {
			// #590's interleaving at the store. The press's rejection keeps its
			// change, because the waiting write will carry it; the timer's write is
			// then the last, and its rejection takes memory back past the press as
			// well. That second change of memory is nobody's own write, and it is the
			// one a screen drawn after the press has to hear about.
			vi.useFakeTimers();
			try {
				const plugin = new Plugin();
				const store = await loadedOver(plugin);
				const told: boolean[] = [];
				store.onChange(() => told.push(store.isEnabled("day-plan")));
				plugin.saveData = () => Promise.reject(new Error("no space left on device"));

				const typed = withFolder(store, "Journal");
				const typedRefused = expect(typed).rejects.toThrow("no space left on device");
				await expect(store.setEnabled("day-plan", false)).rejects.toThrow("no space left on device");

				expect(store.isEnabled("day-plan")).toBe(false);
				expect(told).toEqual([]);

				await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);
				await typedRefused;

				expect(store.isEnabled("day-plan")).toBe(true);
				expect(store.core().layout.dailyLogFolder).toBe("");
				expect(told).toEqual([true]);
			} finally {
				vi.useRealTimers();
			}
		});

		it("tells a listener what the store settled to when a landed press is followed by a refused timer", async () => {
			// #588's second criterion as written: the immediate write *lands*
			// while the deferred one waits. The press carries the typed value to
			// the file, so the timer's later refusal takes memory back to what
			// the press landed — the same content, which is why nothing visible
			// changes, and the listener still fires so a screen drawn during the
			// press agrees with what the store settled to.
			vi.useFakeTimers();
			try {
				const plugin = new Plugin();
				const store = await loadedOver(plugin);
				const told: Array<{ enabled: boolean; folder: string }> = [];
				store.onChange(() =>
					told.push({
						enabled: store.isEnabled("day-plan"),
						folder: store.core().layout.dailyLogFolder,
					}),
				);

				const typed = withFolder(store, "Journal");
				await store.setEnabled("day-plan", false);
				expect(store.core().layout.dailyLogFolder).toBe("Journal");

				plugin.saveData = () => Promise.reject(new Error("no space left on device"));
				const typedRefused = expect(typed).rejects.toThrow("no space left on device");
				await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);
				await typedRefused;

				expect(store.isEnabled("day-plan")).toBe(false);
				expect(store.core().layout.dailyLogFolder).toBe("Journal");
				expect(told).toEqual([{ enabled: false, folder: "Journal" }]);
			} finally {
				vi.useRealTimers();
			}
		});

		it("stops telling a listener once it has asked to stop", async () => {
			const plugin = new Plugin();
			const store = await loadedOver(plugin);
			let told = 0;
			const stop = store.onChange(() => {
				told += 1;
			});
			stop();
			plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));

			await expect(store.setEnabled("day-plan", false)).rejects.toThrow("the vault is read-only");

			expect(told).toBe(0);
		});

		it("tells every listener when one throws, keeps the queue writing, and lets the error out", async () => {
			// A listener runs on the queue's own branch, which must never reject:
			// a rejection there would wedge every later write and `flush` with it.
			// So the throw is caught, and handed out on a microtask of its own,
			// where nothing is waiting on it and it is reported as uncaught.
			const plugin = new Plugin();
			const store = await loadedOver(plugin);
			const thrown = new Error("a listener broke");
			const outside: Array<() => void> = [];
			const queued = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((task) => {
				outside.push(task);
			});
			try {
				let second = 0;
				store.onChange(() => {
					throw thrown;
				});
				store.onChange(() => {
					second += 1;
				});
				const real = plugin.saveData.bind(plugin);
				plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));

				await expect(store.setEnabled("day-plan", false)).rejects.toThrow("the vault is read-only");
				expect(second).toBe(1);

				plugin.saveData = real;
				await store.setEnabled("mirror", false);
				await store.flush();
				expect((await loadedOver(plugin)).isEnabled("mirror")).toBe(false);
			} finally {
				queued.mockRestore();
			}
			expect(outside).toHaveLength(1);
			expect(outside[0]).toThrow(thrown);
		});
	});

	/*
	 * Issue #589. In the
	 * real application `saveData` resolves when the write to disk fails —
	 * `Vault.writeJson` catches the adapter's error — so a store that took a
	 * resolved `saveData` as a landing recorded a payload the file never got,
	 * restored nothing and announced nothing. The store now reads the file back
	 * after every write and treats anything but what it wrote as a failed save,
	 * exactly as a rejected `saveData` is treated: the stub's `swallowSaves` is
	 * the disk failure, resolving and leaving the file as it was.
	 */
	describe("reading the file back after every write", () => {
		/**
		 * `fresh` is read before `load()` runs, so it is true exactly on a
		 * plugin's first ever load — the one case #747's own write can fire on
		 * — and false on a second `loadedOver` over a plugin this describe has
		 * already written to, where settling or clearing anything here would
		 * risk draining a held write this test itself queued rather than the
		 * load's own.
		 */
		async function loadedOver(plugin: Plugin): Promise<SettingsStore> {
			const fresh = plugin.saved.length === 0;
			const store = storeOver(plugin);
			await store.load();
			if (fresh) {
				if (plugin instanceof HeldPlugin) {
					await settleMicrotasks();
					plugin.inFlight[0]?.finish();
					await settleMicrotasks();
					plugin.inFlight.length = 0;
				}
				plugin.saved.length = 0;
			}
			return store;
		}

		function withHeading(store: SettingsStore, heading: string): Promise<void> {
			const core = store.core();
			return store.saveCore({ ...core, layout: { ...core.layout, tasksHeading: heading } });
		}

		it("lands a write whose read-back matches, and announces nothing", async () => {
			Notice.messages = [];
			const plugin = new Plugin();
			const store = await loadedOver(plugin);
			const announce = createSaveFailureAnnouncer();

			const landed = withHeading(store, "Landed");
			await landed.catch((error: unknown) => announce(landed, error));
			expect(Notice.messages).toEqual([]);

			// What a later failed save restores to is the landed payload, so a
			// restore to "Landed" is the proof the matching write set it.
			plugin.swallowSaves();
			await expect(withHeading(store, "Swallowed")).rejects.toThrow();
			expect(store.core().layout.tasksHeading).toBe("Landed");
		});

		it("treats a resolved write the file never got as a failed save: nothing landed, memory restored, announced once", async () => {
			Notice.messages = [];
			const plugin = new Plugin();
			const store = await loadedOver(plugin);
			await withHeading(store, "Landed");
			plugin.swallowSaves();
			const announce = createSaveFailureAnnouncer();

			const swallowed = withHeading(store, "Swallowed");
			await expect(swallowed).rejects.toThrow();
			await swallowed.catch((error: unknown) => announce(swallowed, error));

			expect(store.core().layout.tasksHeading).toBe("Landed");
			expect((await loadedOver(plugin)).core().layout.tasksHeading).toBe("Landed");
			expect(Notice.messages).toHaveLength(1);
			expect(Notice.messages[0]).toContain("could not be saved");

			// Had the swallowed write replaced the landed payload, this second
			// failure would restore memory to "Swallowed".
			await expect(store.setEnabled("day-plan", false)).rejects.toThrow();
			expect(store.core().layout.tasksHeading).toBe("Landed");
			expect(store.isEnabled("day-plan")).toBe(true);
		});

		it("announces a run of typing whose write the file never got once, and restores what it held", async () => {
			vi.useFakeTimers();
			try {
				Notice.messages = [];
				const plugin = new Plugin();
				const store = await loadedOver(plugin);
				plugin.swallowSaves();
				const announce = createSaveFailureAnnouncer();

				const runs = ["J", "Jo", "Journal"].map((folder) => withFolder(store, folder));
				const heard = runs.map((run) => run.catch((error: unknown) => announce(run, error)));
				await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);
				await Promise.all(heard);

				expect(Notice.messages).toHaveLength(1);
				expect(store.core().layout.dailyLogFolder).toBe("");
			} finally {
				vi.useRealTimers();
			}
		});

		it("treats a read-back that fails as a failed save, with the read's own error", async () => {
			const plugin = new Plugin();
			const store = await loadedOver(plugin);
			await withHeading(store, "Landed");
			// Both reads reject: a lock held past one retry is still a
			// failed save, and the error it hands on is the retry's own.
			const reads = vi.fn(() => Promise.reject(new Error("EACCES: permission denied")));
			plugin.loadData = reads;

			await expect(withHeading(store, "Unread")).rejects.toThrow("EACCES: permission denied");
			expect(reads).toHaveBeenCalledTimes(2);

			expect(store.core().layout.tasksHeading).toBe("Landed");
		});

		it("treats a settings file gone by the read-back as a failed save", async () => {
			const plugin = new Plugin();
			const store = await loadedOver(plugin);
			await withHeading(store, "Landed");
			// Obsidian's `loadData` answers null when `data.json` is not there,
			// on both the read and its retry.
			const reads = vi.fn(() => Promise.resolve(null));
			plugin.loadData = reads;

			await expect(withHeading(store, "Missing")).rejects.toThrow();
			expect(reads).toHaveBeenCalledTimes(2);

			expect(store.core().layout.tasksHeading).toBe("Landed");
		});

		/*
		 * Issue #600. A read
		 * that fails only once — a sync tool or antivirus holding `data.json` for
		 * an instant right after a write that did land — used to be reported as a
		 * failed save while the file already held the new value. `readBack` now
		 * reads a second time, immediately, before giving up.
		 */
		it("treats a read that failed once but matched on retry as a landing: no rollback, no announcer", async () => {
			Notice.messages = [];
			const plugin = new Plugin();
			const store = await loadedOver(plugin);
			await withHeading(store, "Landed");
			const announce = createSaveFailureAnnouncer();

			const reads = vi.spyOn(plugin, "loadData");
			reads.mockRejectedValueOnce(new Error("EBUSY: resource busy or locked"));

			const retried = withHeading(store, "Retried");
			await retried.catch((error: unknown) => announce(retried, error));

			expect(reads).toHaveBeenCalledTimes(2);
			expect(store.core().layout.tasksHeading).toBe("Retried");
			expect((await loadedOver(plugin)).core().layout.tasksHeading).toBe("Retried");
			expect(Notice.messages).toHaveLength(0);
		});

		it("treats a read that failed once and then answered something else as a failed save", async () => {
			Notice.messages = [];
			const plugin = new Plugin();
			const store = await loadedOver(plugin);
			await withHeading(store, "Landed");
			const announce = createSaveFailureAnnouncer();

			const reads = vi.spyOn(plugin, "loadData");
			reads.mockRejectedValueOnce(new Error("EBUSY: resource busy or locked"));
			reads.mockResolvedValueOnce({ tasksHeading: "Something else entirely" });

			const mismatched = withHeading(store, "Mismatched");
			await expect(mismatched).rejects.toThrow();
			await mismatched.catch((error: unknown) => announce(mismatched, error));

			expect(reads).toHaveBeenCalledTimes(2);
			expect(store.core().layout.tasksHeading).toBe("Landed");
			expect(Notice.messages).toHaveLength(1);
			expect(Notice.messages[0]).toContain("could not be saved");
		});

		it("costs one write and one read for a whole run of typing", async () => {
			vi.useFakeTimers();
			try {
				const plugin = new Plugin();
				const store = await loadedOver(plugin);
				const reads = vi.spyOn(plugin, "loadData");

				const runs = ["J", "Jo", "Jou", "Jour", "Journal"].map((folder) => withFolder(store, folder));
				await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);
				await Promise.all(runs);

				expect(plugin.saved).toHaveLength(1);
				expect(reads).toHaveBeenCalledTimes(1);

				await store.setEnabled("day-plan", false);
				expect(plugin.saved).toHaveLength(2);
				expect(reads).toHaveBeenCalledTimes(2);
			} finally {
				vi.useRealTimers();
			}
		});

		it("does not read back a write that rejected", async () => {
			const plugin = new Plugin();
			const store = await loadedOver(plugin);
			const reads = vi.spyOn(plugin, "loadData");
			plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));

			await expect(withHeading(store, "Refused")).rejects.toThrow("the vault is read-only");

			expect(reads).not.toHaveBeenCalled();
		});
	});

	/*
	 * Issue #291. `flush`
	 * read the store's open-write promise once and awaited that. Every write
	 * reassigns the field, so a save that started while the flush was waiting
	 * chained onto a promise the flush had already stopped looking at, and the
	 * flush answered with that save still open — while its own documentation
	 * said awaiting it meant every write the store had started had landed.
	 *
	 * These sit here rather than in `main.test.ts` because none of them needs a
	 * plugin: what they read is the store's own waiting, and `HeldPlugin` above
	 * is what lets a test hold two writes open at once and settle them in an
	 * order it chooses.
	 */
	describe("flushing while saves keep arriving", () => {
		it("waits for a save that started during its own wait", async () => {
			const plugin = new HeldPlugin();
			const store = await loadedFreshHeld(plugin);

			// A toggle rather than a keystroke: `setEnabled` writes straight
			// away, so nothing goes on the timer and `flush` takes the no-timer
			// branch, which is the branch this defect lives in.
			const first = store.setEnabled("day-plan", false);
			await settleMicrotasks();
			expect(plugin.inFlight).toHaveLength(1);

			let flushed = false;
			const flushing = store.flush().then(() => {
				flushed = true;
			});
			await settleMicrotasks();

			// The second save arrives while the flush is already waiting, so it
			// chains onto a promise the flush read before this line ran.
			const second = store.setEnabled("task-dates", false);
			plugin.inFlight[0].finish();
			await settleMicrotasks();

			// The first write has landed and the second has not. Before this
			// ticket the flush answered here, which is one write early.
			expect(plugin.saved).toHaveLength(1);
			expect(flushed).toBe(false);

			plugin.inFlight[1].finish();
			await flushing;
			await Promise.all([first, second]);

			expect(plugin.saved).toHaveLength(2);
			expect(flushed).toBe(true);
		});

		it("answers rather than rejecting when the write it waited for failed", async () => {
			const plugin = new HeldPlugin();
			const store = await loadedFreshHeld(plugin);
			const failing = store.setEnabled("day-plan", false);
			await settleMicrotasks();

			const flushing = store.flush();
			plugin.inFlight[0].fail(new Error("the vault is read-only"));

			// The failure reaches whoever asked for the write, and the flush
			// still answers: the loop waits on the branch that cannot reject.
			await expect(failing).rejects.toThrow("the vault is read-only");
			await expect(flushing).resolves.toBeUndefined();
		});

		it("returns without writing when there is nothing pending", async () => {
			const plugin = new Plugin();
			const store = await loadedFresh(plugin);

			// Also what says the loop ends: with no write ever started, the
			// field it re-reads is the same settled promise both times round.
			await expect(store.flush()).resolves.toBeUndefined();

			expect(plugin.saved).toHaveLength(0);
		});
	});

	/*
	 * Issue #188. The debounce
	 * timer was armed with a bare `window.setTimeout` and emptied by its own firing
	 * alone, so a plugin unloaded inside the typing window left it armed on a dead
	 * plugin, where it called `saveData` and wrote that instance's settings over
	 * whatever a re-enabled instance had since stored. `main.ts` is what hands
	 * `teardown` to `Plugin.register`, and `main.test.ts` is what reads that half;
	 * these read the store's own.
	 */
	describe("what the store gives up when the plugin unloads", () => {
		it("writes the change that was still on the timer, rather than dropping it", async () => {
			vi.useFakeTimers();
			try {
				const plugin = new Plugin();
				const store = await loadedFresh(plugin);
				const written = withFolder(store, "Journal");
				// Nothing yet: the timer has not fired and nothing else drains it.
				expect(plugin.saved).toHaveLength(0);

				store.teardown();
				await written;

				// Cancelling must not be what loses the write: #188's fourth box.
				const reloaded = storeOver(plugin);
				await reloaded.load();
				expect(reloaded.core().layout.dailyLogFolder).toBe("Journal");
			} finally {
				vi.useRealTimers();
			}
		});

		it("leaves nothing armed, so the window passing writes nothing more", async () => {
			vi.useFakeTimers();
			try {
				const plugin = new Plugin();
				const store = storeOver(plugin);
				await store.load();
				void withFolder(store, "Journal");

				store.teardown();
				await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS * 3);

				// One write for the teardown, and none for a timer that fired after it.
				expect(plugin.saved.filter((written) => written.includes("Journal"))).toHaveLength(1);
			} finally {
				vi.useRealTimers();
			}
		});

		it("refuses a keystroke that arrives afterwards instead of arming a new timer", async () => {
			const plugin = new Plugin();
			const store = await loadedFresh(plugin);
			vi.useFakeTimers();
			try {
				store.teardown();
				const after = plugin.saved.length;

				// What a re-enabled instance has since stored. The old instance's
				// timer would write its own `data` straight over this.
				plugin.seedData({ core: { layout: { dailyLogFolder: "Rebuilt" } } });

				await expect(withFolder(store, "Journal")).rejects.toThrow(/unloaded/i);
				await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS * 3);

				expect(plugin.saved.length).toBe(after);
				const reloaded = storeOver(plugin);
				await reloaded.load();
				expect(reloaded.core().layout.dailyLogFolder).toBe("Rebuilt");
			} finally {
				vi.useRealTimers();
			}
		});

		it("is safe with nothing pending, and safe called twice", async () => {
			const plugin = new Plugin();
			const store = storeOver(plugin);
			await store.load();
			const after = plugin.saved.length;

			expect(() => {
				store.teardown();
				store.teardown();
			}).not.toThrow();
			await settleMicrotasks();

			expect(plugin.saved.length).toBe(after);
		});

		it("leaves flush with nothing of its own to do, and flush still waits for the write", async () => {
			vi.useFakeTimers();
			try {
				const plugin = new Plugin();
				const store = storeOver(plugin);
				await store.load();
				void withFolder(store, "Journal");

				// The order `main.ts` sees when Obsidian runs a registered cleanup
				// before `onunload`. The other order is `main.test.ts`'s to read.
				store.teardown();
				await expect(store.flush()).resolves.toBeUndefined();

				expect(plugin.saved[plugin.saved.length - 1]).toContain("Journal");
			} finally {
				vi.useRealTimers();
			}
		});
	});

	/*
	 * Issue #538. The
	 * sequence name box on the checkbox-cycling card saved on every keystroke
	 * through its feature's handle, whose only save was the immediate one — a
	 * whole-file write per character, where the core's own boxes on the same
	 * screen defer theirs. The handle now offers the deferred save beside the
	 * immediate one, and it is the *same* deferral: one pending write for the
	 * file, the one `flush` and `teardown` already drain, not a second slot per
	 * feature.
	 */
	describe("a feature's deferred save", () => {
		/** The handle a feature would take, over a slice with one text setting. */
		function handleOn(store: SettingsStore): ReturnType<typeof store.handleFor<{ name: string }>> {
			return store.handleFor("checkbox-cycling", { name: "" });
		}

		/** Types one more character into the feature's name box. */
		function withName(store: SettingsStore, named: string): Promise<void> {
			return handleOn(store).saveSoon({ name: named });
		}

		/** The feature's slice as the last write left it in the file. */
		function writtenName(plugin: Plugin, at: number): unknown {
			const data = JSON.parse(plugin.saved[at]) as EffortlessData;
			return (data.features["checkbox-cycling"] as { name: string } | undefined)?.name;
		}

		it("writes once for a run of characters, rather than once for each", async () => {
			vi.useFakeTimers();
			try {
				const plugin = new Plugin();
				const store = await loadedFresh(plugin);

				let settled: Promise<void> = Promise.resolve();
				for (const typed of ["M", "Mo", "Mor", "Morn", "Morni", "Mornin", "Morning"]) {
					settled = withName(store, typed);
				}
				expect(plugin.saved).toEqual([]);

				await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);
				await settled;

				expect(plugin.saved).toHaveLength(1);
				expect(writtenName(plugin, 0)).toBe("Morning");
			} finally {
				vi.useRealTimers();
			}
		});

		it("shows what was typed straight away, long before the write", async () => {
			vi.useFakeTimers();
			try {
				const store = storeOver(new Plugin());
				await store.load();

				void withName(store, "Morning");

				expect(handleOn(store).read().name).toBe("Morning");
			} finally {
				vi.useRealTimers();
			}
		});

		it("answers every keystroke in the run with the same promise", async () => {
			// The promise is how the settings screen names a run when it announces
			// a failed write once rather than once per character, so a
			// fresh one per call would bring the seven toasts back.
			vi.useFakeTimers();
			try {
				const store = storeOver(new Plugin());
				await store.load();

				const first = withName(store, "M");
				const second = withName(store, "Mo");
				await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);
				await second;

				expect(second).toBe(first);
			} finally {
				vi.useRealTimers();
			}
		});

		it("shares the one pending write with the core's deferred save", async () => {
			// One file, so one slot: typing into a core box and then into a
			// feature's box inside the window is one write carrying both, not two
			// timers racing to write `data.json`.
			vi.useFakeTimers();
			try {
				const plugin = new Plugin();
				const store = await loadedFresh(plugin);

				const core = withFolder(store, "Journal");
				const feature = withName(store, "Morning");
				expect(feature).toBe(core);

				await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);
				await feature;

				expect(plugin.saved).toHaveLength(1);
				expect(plugin.saved[0]).toContain("Journal");
				expect(writtenName(plugin, 0)).toBe("Morning");
			} finally {
				vi.useRealTimers();
			}
		});

		it("hands a failed deferred write back to the caller, once the typing has settled", async () => {
			vi.useFakeTimers();
			try {
				const plugin = new Plugin();
				const store = storeOver(plugin);
				await store.load();
				plugin.saveData = () => Promise.reject(new Error("no space left on device"));

				const settled = withName(store, "Morning");
				const caught = expect(settled).rejects.toThrow("no space left on device");
				await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);
				await caught;
			} finally {
				vi.useRealTimers();
			}
		});

		it("is drained by teardown, so a name typed just before the unload is written", async () => {
			vi.useFakeTimers();
			try {
				const plugin = new Plugin();
				const store = await loadedFresh(plugin);
				const written = withName(store, "Morning");
				expect(plugin.saved).toHaveLength(0);

				store.teardown();
				await written;
				await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS * 3);

				expect(plugin.saved).toHaveLength(1);
				const reloaded = storeOver(plugin);
				await reloaded.load();
				expect(handleOn(reloaded).read().name).toBe("Morning");
			} finally {
				vi.useRealTimers();
			}
		});

		it("is drained by flush as well, in the order where flush runs first", async () => {
			vi.useFakeTimers();
			try {
				const plugin = new Plugin();
				const store = await loadedFresh(plugin);
				void withName(store, "Morning");

				await store.flush();
				store.teardown();
				await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS * 3);

				expect(plugin.saved).toHaveLength(1);
				expect(writtenName(plugin, 0)).toBe("Morning");
			} finally {
				vi.useRealTimers();
			}
		});

		it("refuses a keystroke after the unload, tells the caller, and leaves the slice alone", async () => {
			vi.useFakeTimers();
			try {
				const plugin = new Plugin();
				const store = storeOver(plugin);
				await store.load();
				await handleOn(store).save({ name: "Task flow" });
				store.teardown();
				const after = plugin.saved.length;

				await expect(withName(store, "Morning")).rejects.toThrow(/unloaded/i);
				await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS * 3);

				// Refused before the change rather than after it, the way
				// `saveCoreSoon` is: a slice changed and then refused would be what
				// #385 closed, arriving through a new door.
				expect(plugin.saved.length).toBe(after);
				expect(handleOn(store).read().name).toBe("Task flow");
			} finally {
				vi.useRealTimers();
			}
		});
	});
});

describe("the shared group", () => {
	it("gives the calendar table two columns, Time and Meeting", () => {
		// The second column ships as *Meeting* rather than *Event* because
		// `GLOSSARY.md` retires *event* under **Meeting**, and this default is a
		// string on the settings screen of every install that has never
		// changed it.
		// The key is still `event`: that is a `data.json` field name, and
		// renaming it is a stored-data migration with no user-visible gain.
		expect(defaultData().core.layout.calendarColumns).toEqual({
			time: "Time",
			event: "Meeting",
		});
	});

	it("leaves a stored column name alone, including the one that used to ship", async () => {
		// **No migration, deliberately.** Someone whose `data.json` holds
		// `Event` chose that word, and `migrateLayout` reads a stored name
		// straight through. The rename moves what a fresh install starts from
		// and nothing else.
		const plugin = new Plugin();
		await plugin.saveData({
			core: { layout: { calendarColumns: { time: "Time", event: "Event" } } },
		});

		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await store.load();

		expect(store.core().layout.calendarColumns).toEqual({ time: "Time", event: "Event" });
	});

	it("holds everything two features must agree on about the vault", () => {
		// Named one by one rather than compared as a whole object, so that a
		// feature ticket adding a heading does not have to edit this test.
		const layout = defaultData().core.layout;
		expect(Object.keys(layout).sort()).toEqual(
			[
				"calendarColumns",
				"calendarHeading",
				"completedTasksHeading",
				"dailyLogFilename",
				"dailyLogFolder",
				"dailyLogTemplate",
				"dayLinkField",
				"diaryDateField",
				"diaryHeading",
				"excludedFolders",
				"languageHistory",
				"notesHeading",
				"overdueHeading",
				"processedField",
				"tasksHeading",
				"todayHeading",
			].sort(),
		);
	});

	it("carries a level on every day's-log heading and on neither collection heading", () => {
		// The two rules differ on purpose: in the day's log the level decides
		// where a line goes, in a collection it only decides whether the note
		// counts, and there it is ignored.
		const layout = defaultData().core.layout;
		expect(layout.notesHeading).toEqual({ text: "Notes", level: 1 });
		expect(layout.calendarHeading).toEqual({ text: "Calendar", level: 2 });
		expect(layout.todayHeading).toEqual({ text: "Today", level: 2 });
		expect(layout.overdueHeading).toEqual({ text: "Overdue", level: 2 });
		expect(layout.diaryHeading).toEqual({ text: "Diary", level: 1 });
		expect(layout.tasksHeading).toBe("Tasks");
		expect(layout.completedTasksHeading).toBe("Completed tasks");
	});

	it("ships English defaults, an empty excluded-folders list and one blank question", () => {
		const layout = defaultData().core.layout;
		expect(layout.excludedFolders).toEqual([]);
		expect(layout.dailyLogFolder).toBe("");
		expect(layout.dailyLogFilename).toBe("");
	});

	it("ships with no day's-log template, so a fresh install keeps the built-in frame", () => {
		expect(defaultData().core.layout.dailyLogTemplate).toBe("");
	});
});

describe("the day's-log template setting", () => {
	it("reads a stored template path straight through", async () => {
		const plugin = new Plugin();
		await plugin.saveData({ core: { layout: { dailyLogTemplate: "Templates/Day.md" } } });

		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await store.load();

		expect(store.core().layout.dailyLogTemplate).toBe("Templates/Day.md");
	});

	it("normalises a stored path on read the way the card normalises one typed into it", async () => {
		// The card stores through `asVaultPath` (`settingsTab.ts`'s Day's-log
		// template row), which a trailing slash does not survive. A read that
		// skips the same step would let a hand-edited "Templates/Day.md/" reach
		// `createDailyLog` unchanged and fail only there, with a different
		// message than typing the same text into the card would give.
		const plugin = new Plugin();
		await plugin.saveData({ core: { layout: { dailyLogTemplate: "Templates/Day.md/" } } });

		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await store.load();

		expect(store.core().layout.dailyLogTemplate).toBe("Templates/Day.md");
	});

	it("refuses a template path it cannot use, falls back to the shipped blank answer, and names it in a notice", async () => {
		// Before #911: this silently became "", indistinguishable from a vault
		// that never set the template at all (`readText`, no notice). The rule
		// this pins is the same one headings already follow just above
		// (`CLAUDE.md`'s rule after #606/#607) — a value present but unusable is
		// reported, never silently replaced.
		const plugin = new Plugin();
		await plugin.saveData({ core: { layout: { dailyLogTemplate: 5 } } });
		Notice.messages = [];

		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await store.load();

		expect(store.core().layout.dailyLogTemplate).toBe("");
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("Day's-log template");
		expect(Notice.messages[0]).toContain("could not be used");
	});

	it("says nothing about a template that is simply absent, the ordinary shape of a vault that has never answered it", async () => {
		const plugin = new Plugin();
		await plugin.saveData({ core: { layout: { dailyLogFolder: "Journal" } } });
		Notice.messages = [];

		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await store.load();

		expect(store.core().layout.dailyLogTemplate).toBe("");
		expect(Notice.messages).toEqual([]);
	});
});

describe("the day's-log language history", () => {
	it("starts with no previous language on a fresh install, and writes it once rather than waiting for something else to save", async () => {
		// Before #747's fix this wrote nothing, so a language change any time
		// before the next unrelated save re-derived `previous: null` from the
		// still-empty file and lost the language a log was actually written
		// under.
		resetLanguage();
		setLanguage("en");
		const plugin = new Plugin();
		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);

		await store.load();
		await store.flush();

		expect(store.core().layout.languageHistory).toEqual({ current: "en", previous: null });
		expect(plugin.saved).toHaveLength(1);
		expect(JSON.parse(plugin.saved[0]).core.layout.languageHistory).toEqual({
			current: "en",
			previous: null,
		});
	});

	it("keeps the first language recorded even when nothing else ever saved before the next launch", async () => {
		// The sequence the finding names: a fresh install records "en" and
		// writes it (the test above); the app's language then moves to "sv"
		// with nothing else ever saving in between; the next load must still
		// find "en" on disk to record as `previous`, rather than the `null`
		// the old code left there.
		resetLanguage();
		setLanguage("en");
		const plugin = new Plugin();
		await (async () => {
			const first = new SettingsStore(plugin as unknown as ObsidianPlugin);
			await first.load();
			await first.flush();
		})();

		setLanguage("sv");
		const second = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await second.load();

		expect(second.core().layout.languageHistory).toEqual({ current: "sv", previous: "en" });
	});

	it("records a real language change against what was stored, and writes it without being asked", async () => {
		resetLanguage();
		const plugin = new Plugin();
		plugin.seedData({ core: { layout: { languageHistory: { current: "en", previous: null } } } });
		setLanguage("sv");
		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);

		await store.load();

		expect(store.core().layout.languageHistory).toEqual({ current: "sv", previous: "en" });
		// Not awaited by `load` itself (the report says why); flush drains it.
		await store.flush();
		expect(plugin.saved).toHaveLength(1);
		expect(JSON.parse(plugin.saved[0]).core.layout.languageHistory).toEqual({
			current: "sv",
			previous: "en",
		});
	});

	it("leaves the history alone, and writes nothing, when the language has not moved since it was recorded", async () => {
		resetLanguage();
		const plugin = new Plugin();
		plugin.seedData({ core: { layout: { languageHistory: { current: "sv", previous: "en" } } } });
		setLanguage("sv");
		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);

		await store.load();

		expect(store.core().layout.languageHistory).toEqual({ current: "sv", previous: "en" });
		expect(plugin.saved).toHaveLength(0);
	});

	it("does not carry a stored language two changes back", async () => {
		resetLanguage();
		const plugin = new Plugin();
		// "en" was current, then "sv" became current with "en" as previous —
		// exactly what the test above leaves stored — and now the language has
		// moved a second time, to "fr", with nothing in between ever loaded.
		plugin.seedData({ core: { layout: { languageHistory: { current: "sv", previous: "en" } } } });
		setLanguage("fr");
		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);

		await store.load();

		// "sv" is the one step back this ticket promises; "en" is one step
		// further and is dropped, by the ticket's own stated boundary.
		expect(store.core().layout.languageHistory).toEqual({ current: "fr", previous: "sv" });
	});

	it("resets a stored value it cannot use, says so once, writes the repair, and does not say so again next launch", async () => {
		resetLanguage();
		setLanguage("en");
		const plugin = new Plugin();
		// A hand-edited file: a number where a language code belongs.
		plugin.seedData({ core: { layout: { languageHistory: { current: 5, previous: null } } } });
		Notice.messages = [];
		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);

		await store.load();
		await store.flush();

		expect(store.core().layout.languageHistory).toEqual({ current: "en", previous: null });
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("could not be used");
		// The repaired value is written rather than left for the next launch to
		// find the same bad value and announce the same reset again — the
		// second symptom #747 names.
		expect(plugin.saved).toHaveLength(1);
		expect(JSON.parse(plugin.saved[0]).core.layout.languageHistory).toEqual({
			current: "en",
			previous: null,
		});

		Notice.messages = [];
		const second = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await second.load();
		expect(Notice.messages).toEqual([]);
	});

	it("reports a languageHistory that is not an object at all as unusable, rather than silently treating it as absent", async () => {
		resetLanguage();
		setLanguage("en");
		const plugin = new Plugin();
		// A hand-edited file: a plain string where the {current, previous}
		// record belongs. `asRecord` alone turns this into `{}`, under which
		// both fields read as merely absent and nothing says the stored value
		// could not be used.
		plugin.seedData({ core: { layout: { languageHistory: "sv" } } });
		Notice.messages = [];
		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);

		await store.load();

		expect(store.core().layout.languageHistory).toEqual({ current: "en", previous: null });
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("could not be used");
	});

	it("keeps a usable previous language when only current is unusable, rather than discarding it", async () => {
		resetLanguage();
		setLanguage("en");
		const plugin = new Plugin();
		// A hand-edited file: `current` is a number, but `previous` is still a
		// real, usable language code that a log may already be written under.
		plugin.seedData({ core: { layout: { languageHistory: { current: 5, previous: "sv" } } } });
		Notice.messages = [];
		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);

		await store.load();

		expect(store.core().layout.languageHistory).toEqual({ current: "en", previous: "sv" });
		expect(Notice.messages).toHaveLength(1);
	});

	it("says nothing when the field is simply absent, the ordinary shape of a vault that has never recorded one", async () => {
		resetLanguage();
		setLanguage("en");
		const plugin = new Plugin();
		await plugin.saveData({ core: { layout: { dailyLogFolder: "Journal" } } });
		Notice.messages = [];
		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);

		await store.load();

		expect(Notice.messages).toEqual([]);
	});

	it("lets the load-time write's benign 'plugin unloaded' refusal pass without reporting it", async () => {
		// A fresh install writes its first history at load — the test at the
		// top of this file — so a plugin torn down before that write's own
		// turn on the queue comes is exactly the ordinary "loaded and disabled
		// within the same tick" case the finding names, and `queueWrite`
		// rejects that write with the plugin's own "unloaded" error, not a
		// real failure.
		resetLanguage();
		setLanguage("en");
		const plugin = new Plugin();
		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
		const reported: unknown[] = [];
		const queued = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((task) => {
			reported.push(task);
		});
		try {
			const loading = store.load();
			store.teardown();
			await loading;
			await store.flush();
		} finally {
			queued.mockRestore();
		}

		expect(reported).toHaveLength(0);
	});

	it("still reports a load-time write failure that is not the benign unload refusal", async () => {
		resetLanguage();
		setLanguage("en");
		const plugin = new Plugin();
		plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));
		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
		const reported: Array<() => void> = [];
		const queued = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((task) => {
			reported.push(task);
		});
		try {
			await store.load();
			await store.flush();
		} finally {
			queued.mockRestore();
		}

		expect(reported).toHaveLength(1);
		expect(reported[0]).toThrow(/read-only/);
	});
});

describe("a settings file written by an older version", () => {
	/** The shape shipped before the third calendar column was dropped. */
	function olderFile(): unknown {
		return {
			core: {
				layout: {
					dailyLogFolder: "Journal",
					calendarColumns: { time: "Tid", event: "Händelse", effort: "Insats" },
				},
			},
		};
	}

	it("loads with no question asked, missing values taking their defaults", async () => {
		const plugin = new Plugin();
		await plugin.saveData(olderFile());

		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await store.load();

		const layout = store.core().layout;
		expect(layout.dailyLogFolder).toBe("Journal");
		expect(layout.dailyLogFilename).toBe("");
		expect(layout.tasksHeading).toBe("Tasks");
		expect(layout.completedTasksHeading).toBe("Completed tasks");
		expect(layout.excludedFolders).toEqual([]);
		expect(layout.notesHeading).toEqual({ text: "Notes", level: 1 });
		expect(store.isEnabled("anything")).toBe(true);
	});

	// **Issue #159.** `asRecord` is how every layer of this file is read, so an
	// array reaching any of them was walked by index. The whole file is the
	// outermost of those layers.
	it("reads a whole settings file stored as an array as defaults, not by index", async () => {
		const plugin = new Plugin();
		await plugin.saveData([{ layout: { dailyLogFolder: "Journal" } }]);

		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await store.load();

		expect(store.core()).toEqual(defaultData().core);
	});

	it("discards the dropped column silently, keeping the two that stayed", async () => {
		const plugin = new Plugin();
		await plugin.saveData(olderFile());

		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await store.load();

		expect(store.core().layout.calendarColumns).toEqual({ time: "Tid", event: "Händelse" });

		// And it must not come back the next time the file is written.
		await store.saveCore(store.core());
		const written = plugin.saved[plugin.saved.length - 1];
		expect(written).not.toContain("effort");
		expect(written).not.toContain("Insats");
	});

	it("keeps a stored heading and fills in the level it never carried", async () => {
		const plugin = new Plugin();
		await plugin.saveData({
			core: { layout: { notesHeading: { text: "Anteckningar" } } },
		});

		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await store.load();

		expect(store.core().layout.notesHeading).toEqual({ text: "Anteckningar", level: 1 });
	});

	it("refuses a heading it cannot use, falls back to the shipped default, and names which heading in one notice", async () => {
		const plugin = new Plugin();
		// A hand-edited file: a text that is not a string at all, and a level
		// that is not a number at all — a blank text is not this shape:
		// it is #39's documented way to leave the section out, and is kept.
		plugin.seedData({
			core: {
				layout: {
					todayHeading: { text: 42, level: 3 },
					overdueHeading: { text: "Kvar", level: "two" },
				},
			},
		});
		Notice.messages = [];
		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);

		await store.load();

		// The usable half of each stored heading survives; only the unusable
		// half falls back — the same per-field rule `notesHeading`'s level
		// already followed before this ticket.
		expect(store.core().layout.todayHeading).toEqual({ text: "Today", level: 3 });
		expect(store.core().layout.overdueHeading).toEqual({ text: "Kvar", level: 2 });
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("Today heading");
		expect(Notice.messages[0]).toContain("Overdue heading");
		expect(Notice.messages[0]).toContain("could not be used");
	});

	it("says nothing about a heading that is simply absent, the ordinary shape of a vault that has never answered it", async () => {
		const plugin = new Plugin();
		await plugin.saveData({ core: { layout: { dailyLogFolder: "Journal" } } });
		Notice.messages = [];
		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);

		await store.load();

		expect(store.core().layout.todayHeading).toEqual({ text: "Today", level: 2 });
		expect(store.core().layout.overdueHeading).toEqual({ text: "Overdue", level: 2 });
		expect(Notice.messages).toEqual([]);
	});

	it("keeps a blank heading text, the documented way to leave a day's-log section out", async () => {
		const plugin = new Plugin();
		plugin.seedData({
			core: { layout: { calendarHeading: { text: "", level: 2 } } },
		});
		Notice.messages = [];
		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);

		await store.load();

		expect(store.core().layout.calendarHeading).toEqual({ text: "", level: 2 });
		expect(Notice.messages).toEqual([]);
	});
});

describe("DeviceStore", () => {
	it("ships with this device not building the days", () => {
		const device = new DeviceStore(new App() as unknown as ObsidianApp);
		expect(device.read().buildsTheDays).toBe(false);
	});

	it("remembers the answer for this vault on this device", () => {
		const app = new App();
		new DeviceStore(app as unknown as ObsidianApp).save({ buildsTheDays: true });

		const later = new DeviceStore(app as unknown as ObsidianApp);
		expect(later.read().buildsTheDays).toBe(true);
	});

	it("never lets anything per-device reach the settings file", async () => {
		const plugin = new Plugin();
		const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await settings.load();
		const device = new DeviceStore(plugin.app as unknown as ObsidianApp);

		device.save({ buildsTheDays: true });
		await settings.saveCore(settings.core());
		await settings.setEnabled("days-ahead", true);
		await settings.handleFor("days-ahead", { every: 15 }).save({ every: 30 });

		// data.json is in the vault and syncs, so the other device's answer must
		// not be in any of it — not under the core, not under a feature.
		for (const written of plugin.saved) {
			expect(written).not.toContain("buildsTheDays");
			expect(written).not.toContain("effortless:device");
		}
		expect(device.read().buildsTheDays).toBe(true);
	});

	it("writes nothing to the settings file at all", () => {
		const plugin = new Plugin();
		const device = new DeviceStore(plugin.app as unknown as ObsidianApp);

		device.save({ buildsTheDays: true });
		device.read();

		expect(plugin.saved).toEqual([]);
	});
});

describe("the per-device store, reading what local storage actually holds", () => {
	/** Puts a value under the store's own key without going through the store. */
	function storedAs(value: unknown): DeviceStore {
		const app = new App();
		app.saveLocalStorage("effortless:device", value);
		return new DeviceStore(app as unknown as ObsidianApp);
	}

	it("reads a build switch stored as the string \"false\" as off", () => {
		// The string is truthy, so a spread would have made this device the one
		// that writes the days — the outcome the field's own comment forbids.
		expect(storedAs({ buildsTheDays: "false" }).read().buildsTheDays).toBe(false);
	});

	it("takes the shipped answer for any build switch that is not a boolean", () => {
		for (const value of ["true", "false", 1, 0, null, [], {}, "yes"]) {
			expect(storedAs({ buildsTheDays: value }).read().buildsTheDays).toBe(false);
		}
	});

	it("keeps a build switch that really was stored as true", () => {
		expect(storedAs({ buildsTheDays: true }).read().buildsTheDays).toBe(true);
	});

	it("does not return a key the shape does not name, and does not write it back", () => {
		const app = new App();
		app.saveLocalStorage("effortless:device", { buildsTheDays: true, dropped: "gone" });
		const device = new DeviceStore(app as unknown as ObsidianApp);

		expect(Object.keys(device.read()).sort()).toEqual(["accountPasswords", "buildsTheDays", "calendarReads"]);

		device.save({ buildsTheDays: false });
		expect(JSON.stringify(app.localStorage.get("effortless:device"))).not.toContain("dropped");
	});

	// **Issue #159.** The array in this list holds an *object*, not a string.
	// A string element is dropped one layer further down, by the entry check in
	// `readCalendarReads`, so an array of strings passed this assertion without
	// the top-level guard ever being exercised. An array of read-shaped objects
	// is walked by `Object.entries` and comes back index-keyed — a read state
	// belonging to a calendar whose id is `"0"` — unless the top level rejects
	// arrays too.
	it("reads a calendar read state that is not an object as no read state at all", () => {
		for (const value of ["", 7, true, null, [{ readAt: 5, failure: null }]]) {
			expect(storedAs({ calendarReads: value }).read().calendarReads).toEqual({});
		}
	});

	it("drops one malformed entry and keeps the rest", () => {
		const reads = storedAs({
			calendarReads: {
				c1: { readAt: 1000, failure: null },
				c2: "not a read",
				c3: { readAt: "soon", failure: 7 },
			},
		}).read().calendarReads;

		expect(reads.c1).toEqual({ readAt: 1000, failure: null });
		expect(reads.c2).toBeUndefined();
		expect(reads.c3).toEqual({ readAt: null, failure: null });
	});

	it("keeps the address a read state was earned at", () => {
		// Absent means "belongs wherever the source points now", so a read that
		// dropped this field would hand a re-pointed calendar the previous
		// address's last-read time.
		// Typed against `CalendarRead` itself, so that dropping `readFrom` from
		// the interface fails this file to compile rather than quietly.
		const reads: Record<string, CalendarRead> = storedAs({
			calendarReads: { c1: { readAt: 1000, failure: null, readFrom: "https://cal.test/1.ics" } },
		}).read().calendarReads;

		expect(reads.c1.readFrom).toBe("https://cal.test/1.ics");
	});

	it("leaves the address out entirely when it is not a string", () => {
		for (const value of [7, null, true, {}, ["a"]]) {
			const reads = storedAs({
				calendarReads: { c1: { readAt: 1000, failure: null, readFrom: value } },
			}).read().calendarReads;

			// Keys rather than the value: an explicit undefined would still be a
			// key, and an absent address is what says "wherever it points now".
			expect(Object.keys(reads.c1).sort()).toEqual(["failure", "readAt"]);
		}
	});

	it("ships the defaults when local storage holds a non-object or holds nothing", () => {
		const shipped = { buildsTheDays: false, calendarReads: {}, accountPasswords: {} };
		expect(new DeviceStore(new App() as unknown as ObsidianApp).read()).toEqual(shipped);
		for (const value of ["a string", 42, true, []]) {
			expect(storedAs(value).read()).toEqual(shipped);
		}
	});

	it("still merges on save, so writing one answer leaves the other alone", () => {
		const app = new App();
		const device = new DeviceStore(app as unknown as ObsidianApp);

		device.save({ calendarReads: { c1: { readAt: 1000, failure: null } } });
		device.save({ buildsTheDays: true });

		expect(device.read()).toEqual({
			buildsTheDays: true,
			calendarReads: { c1: { readAt: 1000, failure: null } },
			accountPasswords: {},
		});
	});
});

describe("the calendar sources", () => {
	it("ships with none, because the plugin knows nothing about the vault yet", () => {
		expect(defaultData().core.calendarSources).toEqual([]);
	});

	it("stores as many as the person adds, in the order they were added", async () => {
		const plugin = new Plugin();
		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await store.load();

		await store.saveCore({
			...store.core(),
			calendarSources: [0, 1, 2, 3, 4, 5, 6].map((n) => ({
				id: `c${n}`,
				name: `Calendar ${n}`,
				kind: "link" as const,
				location: `https://cal.test/${n}.ics`,
				showInDay: true,
				makeNotes: true,
			})),
		});

		const reloaded = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await reloaded.load();
		expect(reloaded.core().calendarSources.map((source) => source.id)).toEqual([
			"c0",
			"c1",
			"c2",
			"c3",
			"c4",
			"c5",
			"c6",
		]);
	});

	it("reads a half-written source field by field, taking defaults for the rest", async () => {
		const plugin = new Plugin();
		await plugin.saveData({
			core: { calendarSources: [{ id: "c1", location: "https://cal.test/1.ics", effort: 3 }] },
		});
		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await store.load();

		expect(store.core().calendarSources).toEqual([
			{
				id: "c1",
				name: "",
				kind: "link",
				location: "https://cal.test/1.ics",
				showInDay: true,
				makeNotes: true,
			},
		]);
	});

	/**
	 * A stored address arrives from a file that lives in the vault and syncs, so
	 * it can carry whitespace no screen ever put there — a hand-edit, or a sync
	 * that mangled it. The check that says whether a calendar can be read judged
	 * the trimmed address while the read used the untrimmed one, so the row
	 * reported "There is no file at …" naming a path that looked exactly right. Cleaning it here is the loader's own stated job.
	 */
	it("trims the whitespace off a stored address as it loads", async () => {
		const plugin = new Plugin();
		await plugin.saveData({
			core: {
				calendarSources: [
					{ id: "c1", kind: "file", location: " Calendars/work.ics" },
					{ id: "c2", location: "https://cal.test/2.ics\t" },
					{ id: "c3", kind: "file", location: "\n Calendars/other.ics \n" },
				],
			},
		});
		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await store.load();

		expect(store.core().calendarSources.map((source) => source.location)).toEqual([
			"Calendars/work.ics",
			"https://cal.test/2.ics",
			"Calendars/other.ics",
		]);
	});

	it("reads a stored address that is nothing but whitespace as no address at all", async () => {
		const plugin = new Plugin();
		await plugin.saveData({ core: { calendarSources: [{ id: "c1", location: "   " }] } });
		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await store.load();

		const [loaded] = store.core().calendarSources;
		expect(loaded.location).toBe("");
		expect(sourceProblem(loaded)).toBe("This calendar has no link or file yet.");
	});

	it("leaves a stored address that carries no whitespace exactly as it was", async () => {
		const plugin = new Plugin();
		await plugin.saveData({
			core: { calendarSources: [{ id: "c1", location: "https://cal.test/a b.ics" }] },
		});
		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await store.load();

		// Whitespace inside an address is left alone: only the ends are in scope.
		expect(store.core().calendarSources[0].location).toBe("https://cal.test/a b.ics");
	});

	/*
	 * Issue #248. Until it,
	 * a calendar's file path was the one stored vault path nobody normalised on
	 * the way in: it was tidied where the person typed it and only trimmed when
	 * it was read back, so a `data.json` written before #190 — or edited by hand
	 * — kept its leading slash for ever. #190 exists so the three vault-path
	 * boxes share one rule, and the reader is where #63 says that rule is
	 * applied again.
	 */
	it("puts a stored file path through the shared vault-path rule as it loads", async () => {
		const plugin = new Plugin();
		await plugin.saveData({
			core: {
				calendarSources: [{ id: "c1", kind: "file", location: "/Calendars/work.ics" }],
			},
		});
		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await store.load();

		expect(store.core().calendarSources[0].location).toBe("Calendars/work.ics");
	});

	it("leaves a stored link alone but for its whitespace, double slash intact", async () => {
		// The shared rule collapses `https://` to `https:/`, which fetches
		// nothing. A link is the one stored address it must never touch.
		const plugin = new Plugin();
		await plugin.saveData({
			core: {
				calendarSources: [{ id: "c1", kind: "link", location: " https://cal.test/w.ics " }],
			},
		});
		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await store.load();

		expect(store.core().calendarSources[0].location).toBe("https://cal.test/w.ics");
	});

	it("still reads a file path of whitespace alone as no address, not as the vault root", async () => {
		// `normalizePath("")` answers `"/"`. `asVaultPath` trims first and
		// answers `""`, which is what keeps issue #109's rule intact through
		// the new call.
		const plugin = new Plugin();
		await plugin.saveData({
			core: { calendarSources: [{ id: "c1", kind: "file", location: "  \t " }] },
		});
		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await store.load();

		const [loaded] = store.core().calendarSources;
		expect(loaded.location).toBe("");
		expect(sourceProblem(loaded)).toBe("This calendar has no link or file yet.");
	});

	it("tidies in memory on load, without a write of its own reaching the file for it alone", async () => {
		// Out of scope by the ticket's own words: the tidied value on its own
		// reaches the file only when something else saves. A fresh install has
		// no stored `languageHistory` either, though, and #747 makes that its
		// own write — a whole-file write, since this store has no partial one
		// — so the tidied value lands in *that* write, not because tidying
		// asked for one.
		const plugin = new Plugin();
		resetLanguage();
		setLanguage("en");
		await plugin.saveData({
			core: {
				calendarSources: [{ id: "c1", kind: "file", location: "/Calendars/work.ics" }],
				layout: { languageHistory: { current: "en", previous: null } },
			},
		});
		const writesBefore = plugin.saved.length;

		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await store.load();

		expect(plugin.saved.length).toBe(writesBefore);
		expect(plugin.saved[writesBefore - 1]).toContain("/Calendars/work.ics");
	});

	it("gives a hand-written source an id of its own rather than letting two share one", async () => {
		const plugin = new Plugin();
		await plugin.saveData({
			core: {
				calendarSources: [
					{ location: "https://cal.test/1.ics" },
					{ location: "https://cal.test/2.ics" },
				],
			},
		});
		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await store.load();

		const [first, second] = store.core().calendarSources;
		expect(first.id).not.toBe(second.id);
		expect(first.id).not.toBe("");
	});
});

describe("a calendar's id, which its read state hangs on", () => {
	/** Loads the given rows the way a hand-edited data.json would arrive. */
	async function idsFrom(rows: unknown[]): Promise<string[]> {
		const plugin = new Plugin();
		await plugin.saveData({ core: { calendarSources: rows } });
		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await store.load();
		return store.core().calendarSources.map((source) => source.id);
	}

	it("gives a fresh id to a row whose id is an empty string", async () => {
		const [id] = await idsFrom([{ id: "", location: "https://cal.test/1.ics" }]);
		expect(id.trim()).not.toBe("");
	});

	it("gives a fresh id to a row whose id is whitespace only", async () => {
		for (const blank of [" ", "\t", "  \n "]) {
			const [id] = await idsFrom([{ id: blank, location: "https://cal.test/1.ics" }]);
			expect(id.trim()).not.toBe("");
			expect(id).not.toBe(blank);
		}
	});

	it("splits two rows that were stored carrying the same id", async () => {
		const [first, second] = await idsFrom([{ id: "c1" }, { id: "c1" }]);
		expect(first).not.toBe(second);
		// The first one to arrive keeps the stored id, so it keeps its read state.
		expect(first).toBe("c1");
	});

	it("splits two rows that both carry an empty id", async () => {
		const [first, second] = await idsFrom([{ id: "" }, { id: "" }]);
		expect(first).not.toBe(second);
	});

	it("still gives a fresh id to a row whose id is missing or not a string", async () => {
		const ids = await idsFrom([{}, { id: 7 }, { id: null }, { id: ["c1"] }]);
		expect(new Set(ids).size).toBe(4);
		for (const id of ids) expect(typeof id).toBe("string");
	});

	it("keeps a good, unique id exactly, so a calendar does not lose its read state", async () => {
		expect(await idsFrom([{ id: "c1" }, { id: "c2" }, { id: " c3 " }])).toEqual([
			"c1",
			"c2",
			" c3 ",
		]);
	});

	it("never lets two loaded calendars share an id, whatever the file says", async () => {
		const ids = await idsFrom([{ id: "c1" }, { id: "c1" }, { id: "" }, {}, { id: " " }, { id: "c1" }]);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("the settings screen's calendar section, over a corrupt per-device record", () => {
	/*
	 * The section indexes the stored read state by source id to write each row's
	 * state line. While the per-device store cast local storage over its
	 * defaults instead of checking it, a stored value that was not a record
	 * blanked the whole core settings card. This drives the real
	 * call site rather than the guard, because the guard is what the card
	 * depends on.
	 *
	 * It lives in this file rather than beside the section's own tests because
	 * the section's test file is outside this branch's file scope.
	 */
	// The array here holds a read-shaped object rather than a string, for the
	// reason issue #159 gives at the fixture above: a string element is dropped
	// by the entry check, so it never reaches the top-level array guard.
	for (const rubbish of [null, "reads", 7, [{ readAt: 5, failure: null }], { c1: "not a read" }]) {
		it(`draws every row when the read state is ${JSON.stringify(rubbish)}`, async () => {
			const plugin = new Plugin();
			const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
			await settings.load();
			await settings.saveCore({
				...settings.core(),
				calendarSources: [{ ...newCalendarSource(), name: "Work", location: "https://cal.test/w.ics" }],
			});
			plugin.app.saveLocalStorage("effortless:device", { calendarReads: rubbish });
			const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
			resetSettings();

			const body = document.createElement("div");
			expect(() => renderCalendarSources(body, settings, device, createSaveFailureAnnouncer())).not.toThrow();

			expect(body.querySelectorAll(".effortless-calendar-source").length).toBe(1);
		});
	}
});

describe("the per-device store, once two things live in it", () => {
	it("keeps the build switch when the calendar writes its read state", () => {
		const app = new App();
		const device = new DeviceStore(app as unknown as ObsidianApp);
		device.save({ buildsTheDays: true });

		device.save({ calendarReads: { c1: { readAt: 1000, failure: null } } });

		expect(device.read().buildsTheDays).toBe(true);
		expect(device.read().calendarReads.c1.readAt).toBe(1000);
	});

	it("keeps the read state when the build switch is answered", () => {
		const app = new App();
		const device = new DeviceStore(app as unknown as ObsidianApp);
		device.save({ calendarReads: { c1: { readAt: 1000, failure: null } } });

		device.save({ buildsTheDays: true });

		expect(device.read().calendarReads.c1.readAt).toBe(1000);
	});

	it("never lets a calendar failure reach the settings file, where it would sync", async () => {
		const plugin = new Plugin();
		const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await settings.load();
		const device = new DeviceStore(plugin.app as unknown as ObsidianApp);

		device.save({ calendarReads: { c1: { readAt: 1000, failure: "The network is down." } } });
		await settings.saveCore(settings.core());

		for (const written of plugin.saved) {
			expect(written).not.toContain("calendarReads");
			expect(written).not.toContain("The network is down.");
		}
	});
});

describe("SettingsStore — the processed and day-link field names live in the layout", () => {
	async function loaded(stored: unknown): Promise<{ store: SettingsStore; plugin: Plugin }> {
		const plugin = new Plugin();
		plugin.seedData(stored);
		Notice.messages = [];
		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await store.load();
		return { store, plugin };
	}

	const meetingNotesAnswering = (processedField: unknown, dayLinkField: unknown) => ({
		features: { "meeting-notes": { template: { processedField, dayLinkField } } },
	});

	it("loads the names a Meeting notes template answered when the layout carries neither", async () => {
		const { store } = await loaded({ core: { layout: {} }, ...meetingNotesAnswering("bearbetad", "datum") });
		expect(store.core().layout.processedField).toBe("bearbetad");
		expect(store.core().layout.dayLinkField).toBe("datum");
		expect(Notice.messages).toEqual([]);
	});

	it("loads the layout's own names over a Meeting notes template answering different ones", async () => {
		const { store } = await loaded({
			core: { layout: { processedField: "handled", dayLinkField: "logLink" } },
			...meetingNotesAnswering("bearbetad", "datum"),
		});
		expect(store.core().layout.processedField).toBe("handled");
		expect(store.core().layout.dayLinkField).toBe("logLink");
		expect(Notice.messages).toEqual([]);
	});

	it("takes each name from where it is answered: the layout's for one, the template's for the other", async () => {
		const { store } = await loaded({
			core: { layout: { dayLinkField: "logLink" } },
			...meetingNotesAnswering("bearbetad", "datum"),
		});
		expect(store.core().layout.processedField).toBe("bearbetad");
		expect(store.core().layout.dayLinkField).toBe("logLink");
	});

	it("loads processed and day when the file carries neither, saying nothing", async () => {
		const { store } = await loaded({ core: { layout: { dailyLogFolder: "Journal" } } });
		expect(store.core().layout.processedField).toBe("processed");
		expect(store.core().layout.dayLinkField).toBe("day");
		expect(Notice.messages).toEqual([]);
	});

	it("leaves the template's two old keys on disk untouched when the core is next saved", async () => {
		const { store, plugin } = await loaded({
			core: { layout: {} },
			...meetingNotesAnswering("bearbetad", "datum"),
		});
		await store.saveCore(store.core());
		const written = JSON.parse(plugin.saved[plugin.saved.length - 1]);
		expect(written.features["meeting-notes"].template).toEqual({
			processedField: "bearbetad",
			dayLinkField: "datum",
		});
		expect(written.core.layout.processedField).toBe("bearbetad");
		expect(written.core.layout.dayLinkField).toBe("datum");
	});

	it.each([
		["processedField", "kept-name"],
		["dayLinkField", "kept-name"],
	] as const)("uses a stored %s the rule accepts, with no notice", async (key, name) => {
		const { store } = await loaded({ core: { layout: { [key]: name } } });
		expect(store.core().layout[key]).toBe(name);
		expect(Notice.messages).toEqual([]);
	});

	it.each([
		["processedField", "Processed field", "processed", 42],
		["processedField", "Processed field", "processed", ""],
		["processedField", "Processed field", "processed", "   "],
		["dayLinkField", "Day link field", "day", ["day"]],
		["dayLinkField", "Day link field", "day", ""],
		["dayLinkField", "Day link field", "day", null],
	] as const)(
		"refuses a stored layout %s of %j with a notice naming %s, and uses the shipped default",
		async (key, row, shipped, stored) => {
			const { store } = await loaded({ core: { layout: { [key]: stored } } });
			expect(store.core().layout[key]).toBe(shipped);
			expect(Notice.messages).toHaveLength(1);
			expect(Notice.messages[0]).toContain(row);
			expect(Notice.messages[0]).toContain("could not be used");
		},
	);

	it.each([
		["processedField", " handled "],
		["dayLinkField", "\tlogLink  "],
	] as const)("loads a stored layout %s of %j as the card would take it, trimmed", async (key, stored) => {
		const { store } = await loaded({ core: { layout: { [key]: stored } } });
		expect(store.core().layout[key]).toBe(stored.trim());
		expect(Notice.messages).toEqual([]);
	});

	it("loads the names a Meeting notes template answered with spaces around them, trimmed", async () => {
		const { store } = await loaded({
			core: { layout: {} },
			...meetingNotesAnswering(" bearbetad", "datum "),
		});
		expect(store.core().layout.processedField).toBe("bearbetad");
		expect(store.core().layout.dayLinkField).toBe("datum");
		expect(Notice.messages).toEqual([]);
	});

	it("refuses a Meeting notes template name that is only spaces, with a notice", async () => {
		const { store } = await loaded({ core: { layout: {} }, ...meetingNotesAnswering("   ", "datum") });
		expect(store.core().layout.processedField).toBe("processed");
		expect(store.core().layout.dayLinkField).toBe("datum");
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("Processed field");
	});

	it("refuses an unusable name a Meeting notes template answered, since the layout carries none to win", async () => {
		const { store } = await loaded({ core: { layout: {} }, ...meetingNotesAnswering(7, "") });
		expect(store.core().layout.processedField).toBe("processed");
		expect(store.core().layout.dayLinkField).toBe("day");
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("Processed field");
		expect(Notice.messages[0]).toContain("Day link field");
	});

	it("does not let an unusable template answer override a usable layout one, nor notice it", async () => {
		const { store } = await loaded({
			core: { layout: { processedField: "handled", dayLinkField: "logLink" } },
			...meetingNotesAnswering(7, ""),
		});
		expect(store.core().layout.processedField).toBe("handled");
		expect(store.core().layout.dayLinkField).toBe("logLink");
		expect(Notice.messages).toEqual([]);
	});
});

describe("SettingsStore — the diary-date field name lives in the layout", () => {
	async function loaded(stored: unknown): Promise<SettingsStore> {
		const plugin = new Plugin();
		plugin.seedData(stored);
		Notice.messages = [];
		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await store.load();
		return store;
	}

	it("answers the shipped `diary` when the file carries no such key, saying nothing", async () => {
		const store = await loaded({ core: { layout: { dailyLogFolder: "Journal" } } });
		expect(store.core().layout.diaryDateField).toBe("diary");
		expect(Notice.messages).toEqual([]);
	});

	it("answers a usable name the file carries, trimmed like the card stores it", async () => {
		const store = await loaded({ core: { layout: { diaryDateField: " written " } } });
		expect(store.core().layout.diaryDateField).toBe("written");
		expect(Notice.messages).toEqual([]);
	});

	it.each([[42], [""], ["   "], ["when: written"], [null], [["diary"]]])(
		"refuses a stored diaryDateField of %j with one notice naming Diary date field, and answers `diary`",
		async (stored) => {
			const store = await loaded({ core: { layout: { diaryDateField: stored } } });
			expect(store.core().layout.diaryDateField).toBe("diary");
			expect(Notice.messages).toHaveLength(1);
			expect(Notice.messages[0]).toContain("Diary date field");
			expect(Notice.messages[0]).toContain("could not be used");
		},
	);

	it("names two refused fields in one notice, the diary-date field among them", async () => {
		const store = await loaded({ core: { layout: { processedField: 7, diaryDateField: "" } } });
		expect(store.core().layout.processedField).toBe("processed");
		expect(store.core().layout.diaryDateField).toBe("diary");
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("Processed field");
		expect(Notice.messages[0]).toContain("Diary date field");
	});
});

describe("SettingsStore — the diary heading: Diary for a fresh install, blank for a file that predates it", () => {
	async function loaded(stored: unknown): Promise<{ store: SettingsStore; plugin: Plugin }> {
		const plugin = new Plugin();
		if (stored !== null) plugin.seedData(stored);
		Notice.messages = [];
		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await store.load();
		return { store, plugin };
	}

	it("answers `Diary` at the notes heading's level when there is no stored data at all, saying nothing", async () => {
		const { store } = await loaded(null);
		expect(store.core().layout.diaryHeading).toEqual({ text: "Diary", level: store.core().layout.notesHeading.level });
		expect(store.core().layout.diaryHeading).toEqual({ text: "Diary", level: 1 });
		expect(Notice.messages).toEqual([]);
	});

	it("answers `Diary` for a stored file with no keys in it, which holds no settings either", async () => {
		const { store } = await loaded({});
		expect(store.core().layout.diaryHeading).toEqual({ text: "Diary", level: 1 });
	});

	it("answers a blank heading, with no notice, for a file whose layout carries no diaryHeading key", async () => {
		const { store } = await loaded({ core: { layout: { dailyLogFolder: "Journal", notesHeading: { text: "Notes", level: 1 } } } });
		expect(store.core().layout.diaryHeading.text).toBe("");
		expect(Notice.messages).toEqual([]);
	});

	it("gives the blank heading the notes heading's stored level, so a name typed later lands beside the notes", async () => {
		const { store } = await loaded({ core: { layout: { notesHeading: { text: "Notes", level: 3 } } } });
		expect(store.core().layout.diaryHeading).toEqual({ text: "", level: 3 });
	});

	it("answers a blank heading for a file that holds only a feature's settings and no core, since it was written by an older version", async () => {
		const { store } = await loaded({ features: { "meeting-notes": { folder: "Meetings" } } });
		expect(store.core().layout.diaryHeading.text).toBe("");
		expect(Notice.messages).toEqual([]);
	});

	it("keeps a stored heading as it is, a blank one included, with no notice", async () => {
		const named = await loaded({ core: { layout: { diaryHeading: { text: "Day writing", level: 2 } } } });
		expect(named.store.core().layout.diaryHeading).toEqual({ text: "Day writing", level: 2 });
		const blank = await loaded({ core: { layout: { diaryHeading: { text: "", level: 2 } } } });
		expect(blank.store.core().layout.diaryHeading).toEqual({ text: "", level: 2 });
		expect(Notice.messages).toEqual([]);
	});

	it.each([
		["a string", "Diary"],
		["a number", 7],
		["null", null],
		["a list", [{ text: "Diary", level: 1 }]],
		["a heading whose text is a number", { text: 42, level: 1 }],
	])("refuses a diaryHeading that is %s with one notice naming Diary heading, and uses `Diary`", async (_name, stored) => {
		const { store } = await loaded({ core: { layout: { diaryHeading: stored } } });
		expect(store.core().layout.diaryHeading.text).toBe("Diary");
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("Diary heading");
		expect(Notice.messages[0]).toContain("could not be used");
	});

	it("refuses a diaryHeading whose level is not a number, keeping the usable text", async () => {
		const { store } = await loaded({ core: { layout: { diaryHeading: { text: "Dagbok", level: "two" } } } });
		expect(store.core().layout.diaryHeading).toEqual({ text: "Dagbok", level: 1 });
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("Diary heading");
	});

	it("keeps the shipped `Diary` through a save and a load, so a fresh install is not turned blank by its own file", async () => {
		const first = await loaded(null);
		await first.store.saveCore(first.store.core());
		const written = JSON.parse(first.plugin.saved[first.plugin.saved.length - 1]);
		expect(written.core.layout.diaryHeading).toEqual({ text: "Diary", level: 1 });

		const second = await loaded(written);
		expect(second.store.core().layout.diaryHeading).toEqual({ text: "Diary", level: 1 });
	});

	it("keeps an upgraded file's blank heading blank through a save and a load", async () => {
		const first = await loaded({ core: { layout: { dailyLogFolder: "Journal" } } });
		await first.store.saveCore(first.store.core());
		const written = JSON.parse(first.plugin.saved[first.plugin.saved.length - 1]);
		expect(written.core.layout.diaryHeading).toEqual({ text: "", level: 1 });

		const second = await loaded(written);
		expect(second.store.core().layout.diaryHeading.text).toBe("");
		expect(Notice.messages).toEqual([]);
	});
});

describe("SettingsStore — settings a newer build stored, which this build does not know", () => {
	// What a newer build might keep beside the settings this one reads: a record
	// under the layout and one under the core, each more than one level deep.
	const newerLayout = { mode: "weekly", order: [3, 1, 2] };
	const newerCore = { since: "2031-01-05", rows: { a: true } };

	async function loadedFrom(stored: unknown): Promise<{ store: SettingsStore; plugin: Plugin }> {
		const plugin = new Plugin();
		plugin.seedData(stored);
		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await store.load();
		await store.flush();
		return { store, plugin };
	}

	function lastWritten(plugin: Plugin): Record<string, any> {
		return JSON.parse(plugin.saved[plugin.saved.length - 1]) as Record<string, any>;
	}

	it("writes both back unchanged when this device saves something else", async () => {
		const { store, plugin } = await loadedFrom({
			core: { layout: { dailyLogFolder: "Journal", somethingNewer: newerLayout }, somethingNewer: newerCore },
		});

		await store.setEnabled("checkbox-cycling", false);

		const written = lastWritten(plugin);
		expect(written.core.enabled["checkbox-cycling"]).toBe(false);
		expect(JSON.stringify(written.core.layout.somethingNewer)).toBe(JSON.stringify(newerLayout));
		expect(JSON.stringify(written.core.somethingNewer)).toBe(JSON.stringify(newerCore));
	});

	it("takes the file's copy of each on a reload, and the next save writes that copy", async () => {
		const { store, plugin } = await loadedFrom({
			core: { layout: { dailyLogFolder: "Journal", somethingNewer: newerLayout }, somethingNewer: newerCore },
		});
		const file = (await plugin.loadData()) as Record<string, any>;
		file.core.layout.somethingNewer = { mode: "daily", order: [1] };
		file.core.somethingNewer = { since: "2031-02-01", rows: {} };
		plugin.seedData(file);

		await store.reloadExternal();
		await store.setEnabled("checkbox-cycling", false);

		const written = lastWritten(plugin);
		expect(written.core.layout.somethingNewer).toEqual({ mode: "daily", order: [1] });
		expect(written.core.somethingNewer).toEqual({ since: "2031-02-01", rows: {} });
	});

	it("keeps what it held under a layout the reloaded file holds but cannot use, and writes it back", async () => {
		const { store, plugin } = await loadedFrom({
			core: { layout: { dailyLogFolder: "Journal", somethingNewer: newerLayout }, somethingNewer: newerCore },
		});
		const file = (await plugin.loadData()) as Record<string, any>;
		file.core.layout = "not a layout";
		plugin.seedData(file);

		await store.reloadExternal();
		await store.setEnabled("checkbox-cycling", false);

		const written = lastWritten(plugin);
		expect(written.core.layout.dailyLogFolder).toBe("Journal");
		expect(written.core.layout.somethingNewer).toEqual(newerLayout);
		expect(written.core.somethingNewer).toEqual(newerCore);
	});

	it("follows a write already open with one that carries the file's newer copy", async () => {
		// The open write was handed the older copy of the key and lands it over
		// the file's; with nothing after it, the file would end on the older one.
		const { store, plugin } = await loadedFrom({
			core: { layout: { dailyLogFolder: "Journal" }, somethingNewer: newerCore },
		});
		const release = plugin.holdSaves();
		const saving = store.setEnabled("checkbox-cycling", false);
		const file = (await plugin.loadData()) as Record<string, any>;
		file.core.somethingNewer = { since: "2031-02-01", rows: {} };
		plugin.seedData(file);

		await store.reloadExternal();
		release();
		await saving;
		await store.flush();

		const stored = (await plugin.loadData()) as Record<string, any>;
		expect(stored.core.somethingNewer).toEqual({ since: "2031-02-01", rows: {} });
		expect(stored.core.enabled["checkbox-cycling"]).toBe(false);
	});
});
