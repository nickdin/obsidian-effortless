import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The stub is imported by path rather than as "obsidian": `tsc` checks this
// file against the real API, and only vitest redirects that name. Where the
// core asks for a real Obsidian type, the stub is cast at the call.
import type {
	App as ObsidianApp,
	EditorSuggest as ObsidianEditorSuggest,
	MarkdownPostProcessorContext as ObsidianPostProcessorContext,
	Plugin as ObsidianPlugin,
	Vault as ObsidianVault,
} from "obsidian";
import {
	EditorSuggest,
	MarkdownPreviewRenderer,
	MarkdownView,
	Notice,
	Plugin,
	Vault,
	WorkspaceLeaf,
} from "./__mocks__/obsidian";
import type {
	App,
	EditorPosition,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	StubEditor,
	TFile,
} from "./__mocks__/obsidian";
import { shippedSources, withoutComments } from "./sourceGuards";
import { Feature } from "../core/feature";
import type { Calendar } from "../core/calendarSources";
import type { FeatureHost, Readiness } from "../core/feature";
import type { Collection, Collections } from "../core/collections";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import type { FeatureProblems } from "../core/problems";
import { reasonOf } from "../core/reason";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore } from "../core/settings";
import type { FeatureSettings } from "../core/settings";

/** The smallest thing that satisfies the feature contract. */
class Simple extends Feature {
	readonly name = "Simple";
	readonly description = "Does a simple thing.";
	loads = 0;
	unloads = 0;

	constructor(
		host: FeatureHost,
		readonly id: string,
		private readonly ready: Readiness = { state: "ready" },
	) {
		super(host);
	}

	readiness(): Readiness {
		return this.ready;
	}

	override onload(): void {
		this.loads += 1;
		this.host.addCommand({ id: "do-the-thing", name: "Do the thing" });
	}

	override onunload(): void {
		this.unloads += 1;
	}
}

/**
 * The stand-in feature for the standing-problem channel: it finds a broken
 * pairing, says so once, and later says it is well again. Nothing else in this
 * repository reports a problem yet, so this is what proves the route works
 * end to end — the feature touches neither the settings screen nor the vault.
 */
class Reporter extends Feature {
	readonly id = "pairing";
	readonly name = "Pairing";
	readonly description = "Keeps a day's tasks and their collection in step.";

	readiness(): Readiness {
		return { state: "ready" };
	}

	/** One call, however many tasks were orphaned. */
	breaks(note: string, orphanedTasks: number): void {
		this.host.problems.report(note, `${orphanedTasks} tasks in ${note} are no longer paired.`);
	}

	mends(note: string): void {
		this.host.problems.clear(note);
	}
}

/**
 * Takes its problem channel the cheapest way a feature author can: a plain
 * field initializer, which runs while `register` still has nowhere to put the
 * feature. The contract says constructing must be cheap, and this is as cheap
 * as a line gets — `Reporter` above never reaches the channel until a method
 * runs, which is why it cannot catch a channel that is taken too early.
 */
class Eager extends Feature {
	readonly id = "eager";
	readonly name = "Eager";
	readonly description = "Takes its problem channel while it is being built.";
	private readonly channel = this.host.problems;

	readiness(): Readiness {
		return { state: "ready" };
	}

	breaks(note: string, orphanedTasks: number): void {
		this.channel.report(note, `${orphanedTasks} tasks in ${note} are no longer paired.`);
	}
}

/**
 * Takes its settings handle in its constructor, which is where a feature would
 * naturally take the one it uses for the rest of its life. `register` has
 * nowhere to put the feature while the factory runs, so a handle keyed by
 * `entry.feature.id` at that moment is keyed by nothing at all.
 */
class Greedy extends Feature {
	readonly id = "greedy";
	readonly name = "Greedy";
	readonly description = "Takes its settings handle while it is being built.";
	readonly own = this.host.settings({ days: 7, heading: "Today" });

	readiness(): Readiness {
		return { state: "ready" };
	}

	/** The same handle, taken the ordinary way once the feature exists. */
	laterHandle(): FeatureSettings<{ days: number; heading: string }> {
		return this.host.settings({ days: 7, heading: "Today" });
	}
}

/**
 * Says what is wrong and then dies of it: `onload` reports a problem and then
 * throws. That order is the whole of #124 —
 * Obsidian runs `onload` while attaching the feature, so the report lands and
 * the registry never records the feature as loaded.
 */
class Doomed extends Feature {
	readonly id = "doomed";
	readonly name = "Doomed";
	readonly description = "Says what is wrong, then fails to start.";
	/** Set false to make it throw without having reported anything first. */
	reports = true;
	/** Kept from the load that failed, the way a queued re-check would keep it. */
	private channel?: FeatureProblems;

	readiness(): Readiness {
		return { state: "ready" };
	}

	override onload(): void {
		this.channel = this.host.problems;
		if (this.reports) {
			this.channel.report("House/Garden.md", "12 tasks in House/Garden.md are no longer paired.");
		}
		throw new Error("could not reach the calendar file");
	}

	/** Reports after the load that took this feature back off the plugin. */
	lateReport(note: string): void {
		this.channel?.report(note, `12 tasks in ${note} are no longer paired.`);
	}
}

/**
 * Keeps the handle it took in `onload`, the way any feature that re-checks its
 * work on a debounce does: the callback is already queued when the person
 * switches the feature off, and it fires afterwards.
 * #131.
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

	/** The queued re-check firing. */
	lateReport(note: string): void {
		this.channel?.report(note, `12 tasks in ${note} are no longer paired.`);
	}

	lateClear(note: string): void {
		this.channel?.clear(note);
	}

	lateClearAll(): void {
		this.channel?.clearAll();
	}

	/** A handle taken now rather than kept from before. */
	reportThroughAFreshHandle(note: string): void {
		this.host.problems.report(note, `12 tasks in ${note} are no longer paired.`);
	}

	/**
	 * A handle taken while the feature is switched off, and kept. Nothing about
	 * a handle says when it may be taken, so a re-check that runs while the
	 * feature is off takes one and holds it — and it has to come alive when the
	 * feature does.
	 */
	private takenWhileOff?: FeatureProblems;

	takeAHandleNow(): void {
		this.takenWhileOff = this.host.problems;
	}

	reportThroughTheHandleTakenWhileOff(note: string): void {
		this.takenWhileOff?.report(note, `12 tasks in ${note} are no longer paired.`);
	}
}

/**
 * Stands itself down while another device has the job, and can be told that the
 * answer changed. That answer moves while the plugin is running — the person
 * turns "Build the days on this device" on — so the registry has to be able to
 * load and unload it without a reload.
 */
class Deferring extends Feature {
	readonly id = "days";
	readonly name = "Days ahead";
	readonly description = "Builds the days ahead.";
	ready: Readiness = { state: "standby", reason: "Your desktop builds the days." };
	loads = 0;
	unloads = 0;

	readiness(): Readiness {
		return this.ready;
	}

	override onload(): void {
		this.loads += 1;
		this.host.addCommand({ id: "build-the-days", name: "Build the days" });
	}

	override onunload(): void {
		this.unloads += 1;
	}
}

class Broken extends Feature {
	readonly id = "broken";
	readonly name = "Broken";
	readonly description = "Never gets going.";
	/** How many times `onload` was actually entered. */
	attempts = 0;

	readiness(): Readiness {
		return { state: "ready" };
	}

	override onload(): void {
		this.attempts += 1;
		throw new Error("could not reach the calendar file");
	}
}

/**
 * Fails its first load and can be mended afterwards, the way the person fixes
 * whatever `onload` could not reach. `Broken` above never recovers, so it
 * cannot show a failure record outliving the failure.
 */
class Mendable extends Feature {
	readonly id = "mendable";
	readonly name = "Mendable";
	readonly description = "Fails once, then works.";
	ready: Readiness = { state: "ready" };
	/** Set false once the cause of the first failure is fixed. */
	throws = true;
	loads = 0;

	readiness(): Readiness {
		return this.ready;
	}

	override onload(): void {
		if (this.throws) throw new Error("could not reach the calendar file");
		this.loads += 1;
	}
}

/**
 * Throws while loading, and can be told afterwards that this device cannot run
 * it — the one way to put `failed` and `not available here` on the same feature.
 */
class Fickle extends Feature {
	readonly id = "fickle";
	readonly name = "Fickle";
	readonly description = "Never gets going.";
	ready: Readiness = { state: "ready" };

	readiness(): Readiness {
		return this.ready;
	}

	override onload(): void {
		throw new Error("could not reach the calendar file");
	}
}

/**
 * Answers one thing when loading asks and another when the screen asks.
 *
 * Readiness is asked twice and separately — once by `load`, once by `stateOf`
 * — and a feature reading `Platform`, a settings value or a cached file can
 * honestly change its mind between the two calls. This is the
 * stand-in that puts the two answers out of step on purpose.
 */
class Changeable extends Feature {
	readonly id = "changeable";
	readonly name = "Changeable";
	readonly description = "Answers differently each time it is asked.";
	loads = 0;
	ready: Readiness = { state: "ready" };

	readiness(): Readiness {
		return this.ready;
	}

	override onload(): void {
		this.loads += 1;
	}
}

/**
 * Cannot even say whether this device can run it: `readiness()` throws. A
 * feature reading `Platform`, a settings value or a cached file can.
 */
class Unaskable extends Feature {
	readonly id = "unaskable";
	readonly name = "Unaskable";
	readonly description = "Cannot say whether it belongs here.";
	loads = 0;

	readiness(): Readiness {
		throw new Error("Platform is not defined");
	}

	override onload(): void {
		this.loads += 1;
	}
}

/**
 * Dies while it is being built: its constructor throws before there is a
 * feature at all. Nothing in `register` used to stand between that throw and
 * the plugin's `onload`, so one bad feature took the whole plugin down with it.
 */
class Stillborn extends Feature {
	readonly id = "stillborn";
	readonly name = "Stillborn";
	readonly description = "Never gets as far as existing.";

	constructor(host: FeatureHost) {
		super(host);
		throw new Error("the vault has no Calendars folder");
	}

	readiness(): Readiness {
		return { state: "ready" };
	}
}

/**
 * Registers a command in its constructor, which is where a feature author
 * reading `addCommand` beside `problems` and `settings` had every reason to
 * think it was allowed: those two say to take them there, and `addCommand`
 * said nothing at all.
 */
class Premature extends Feature {
	readonly id = "premature";
	readonly name = "Premature";
	readonly description = "Registers a command while it is being built.";

	constructor(host: FeatureHost) {
		super(host);
		host.addCommand({ id: "do-the-thing", name: "Do the thing" });
	}

	readiness(): Readiness {
		return { state: "ready" };
	}
}

/**
 * Withdraws a command in its constructor, which is the mistake `Premature`
 * above makes at the other end of the same pair. There is no feature yet, so
 * there is nothing whose commands these would be.
 */
class PrematureWithdrawal extends Feature {
	readonly id = "premature-withdrawal";
	readonly name = "Premature withdrawal";
	readonly description = "Withdraws a command while it is being built.";

	constructor(host: FeatureHost) {
		super(host);
		host.removeCommand("do-the-thing");
	}

	readiness(): Readiness {
		return { state: "ready" };
	}
}

/**
 * A feature whose commands come from a list the person edits, which is the one
 * `removeCommand` exists for: its set changes while it goes on running, so
 * unloading is far too big a hammer for a renamed entry.
 */
class Editable extends Feature {
	readonly id = "cycling";
	readonly name = "Checkbox cycling";
	readonly description = "Steps a checkbox along a sequence of symbols.";

	readiness(): Readiness {
		return { state: "ready" };
	}

	override onload(): void {
		this.add("cycling:first:forward");
	}

	add(commandId: string): void {
		this.host.addCommand({ id: commandId, name: `Cycle ${commandId}` });
	}

	withdraw(commandId: string): void {
		this.host.removeCommand(commandId);
	}
}

/**
 * Registers its command when its settings are drawn rather than from `onload`,
 * and stands itself down so it is never started at all.
 *
 * That pair is the one way a feature which never ran can reach `addCommand`:
 * the guard there asks whether the feature exists yet, never whether it is
 * running, and the settings screen opens a switched-off or stood-down feature's
 * own settings on purpose.
 */
class Configurable extends Feature {
	readonly id = "configurable";
	readonly name = "Configurable";
	readonly description = "Registers its command when its settings are opened.";
	ready: Readiness = { state: "standby", reason: "Your desktop builds the days." };

	readiness(): Readiness {
		return this.ready;
	}

	override displaySettings(): void {
		this.host.addCommand({ id: "do-the-thing", name: "Do the thing" });
	}
}

/**
 * Registers a command on its way out, which is the other end of the same hole:
 * `onunload` runs while the feature is being detached, so anything it adds
 * arrives after the cleanup that ran before the detach.
 */
class LateCommand extends Feature {
	readonly id = "late";
	readonly name = "Late";
	readonly description = "Registers a command on its way out.";

	readiness(): Readiness {
		return { state: "ready" };
	}

	override onunload(): void {
		this.host.addCommand({ id: "one-last-thing", name: "One last thing" });
	}
}

/**
 * Starts cleanly and will not stop cleanly: `onunload` throws. Obsidian's
 * `removeChild` runs it, so the throw comes back out of the registry's own
 * unload.
 */
class BadExit extends Feature {
	readonly id = "bad-exit";
	readonly name = "Bad exit";
	readonly description = "Starts cleanly and will not stop cleanly.";
	ready: Readiness = { state: "ready" };
	loads = 0;

	readiness(): Readiness {
		return this.ready;
	}

	override onload(): void {
		this.loads += 1;
		this.host.addCommand({ id: "do-the-thing", name: "Do the thing" });
	}

	override onunload(): void {
		throw new Error("the file watcher was already gone");
	}
}

async function build(plugin: Plugin = new Plugin()): Promise<{
	plugin: Plugin;
	settings: SettingsStore;
	registry: FeatureRegistry;
	problems: Problems;
	device: DeviceStore;
}> {
	plugin.load();
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const notes = new NoteWriter(new Vault() as unknown as ObsidianVault, {
		path: () => null,
		onChange: () => undefined,
	});
	// The calendar and the collections both reach a feature through the host and
	// nothing here reads them, so the smallest thing of each shape will do. Two
	// object literals, and no real index: that is what #115 bought, and the test
	// below, "lets a feature's own test satisfy the collections member with a
	// plain object", says why the collections one is now this small.
	const calendar: Calendar = { meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} };
	const collections: Collections = { all: () => [], at: () => null };
	// The problems store is read here, unlike the two above: it is the one thing
	// on the host a feature both writes to and the settings screen reads back.
	const problems = new Problems();
	// A real store, like `settings` above: the device tests read and change what
	// this actually holds rather than a fake that could not tell a caching bug
	// from a correct one.
	const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections, problems, device },
		notes,
		calendar,
	);
	return { plugin, settings, registry, problems, device };
}

describe("FeatureRegistry", () => {
	beforeEach(() => {
		Notice.messages = [];
	});

	it("lets a feature's own test satisfy the collections member with a plain object", async () => {
		// The point of #115. What a feature may know about collections is two
		// methods, so this is everything a feature's test has to build: no
		// note-cache port, no layout callback, nothing about how the index
		// decides a note is a collection or when it throws its answer away.
		// `build()` above now satisfies the member the same way, beside its
		// calendar literal; before #115 it had to construct a real index there.
		const roof: Collection = {
			path: "Work/Roof.md",
			name: "Roof",
			headingLine: 0,
			headingLevel: 2,
			openTasks: 3,
		};
		const collections: FeatureHost["collections"] = {
			all: () => [roof],
			at: (path) => (path === roof.path ? roof : null),
		};

		expect(collections.all().map((c) => c.name)).toEqual(["Roof"]);
		expect(collections.at("Work/Roof.md")?.openTasks).toBe(3);
		expect(collections.at("Work/Diary.md")).toBeNull();
	});

	it("is itself built from a plain collections object, not the concrete index", async () => {
		// The other half of #115, and the one line no wave-1 worker could reach:
		// `FeatureRegistry`'s own constructor named `CollectionsIndex`, so every
		// caller had to build the real index however little of it it needed.
		// `npx tsc --noEmit` does not compile this test while that parameter
		// names the class — `npx vitest run` stays green either way, because
		// vitest strips types rather than checking them.
		const plugin = new Plugin();
		plugin.load();
		const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await settings.load();
		const collections: Collections = { all: () => [], at: () => null };
		const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
		const registry = new FeatureRegistry(
			plugin as unknown as ObsidianPlugin,
			{ settings, collections, problems: new Problems(), device },
			new NoteWriter(new Vault() as unknown as ObsidianVault, {
				path: () => null,
				onChange: () => undefined,
			}),
			{ meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} },
		);

		const hosts: FeatureHost[] = [];
		registry.register("reader", (host) => {
			hosts.push(host);
			return new Simple(host, "reader");
		});

		expect(hosts[0].collections.all()).toEqual([]);
	});

	it("hands a feature an answer it cannot re-order for every other feature", async () => {
		const { registry } = await build();
		const hosts: FeatureHost[] = [];
		registry.register("reader", (host) => {
			hosts.push(host);
			return new Simple(host, "reader");
		});

		const collections = hosts[0].collections.all();

		// Compile-time rather than runtime: the arrow is never called. The index
		// caches its answer, so a feature sorting or shortening what it is handed
		// would be answering wrongly for every other feature until the next vault
		// event. The host must carry the read-only type, not only a direct call.
		() => {
			// @ts-expect-error — sorting in place would re-order the shared cache.
			collections.sort((a, b) => a.name.localeCompare(b.name));
			// @ts-expect-error — pushing would lengthen it.
			collections.push(collections[0]);
		};

		expect(collections).toEqual([]);
	});

	it("hands a feature what the per-device store holds for whether this device builds the days", async () => {
		const { registry, device } = await build();
		device.save({ buildsTheDays: true });

		const hosts: FeatureHost[] = [];
		registry.register("reader", (host) => {
			hosts.push(host);
			return new Simple(host, "reader");
		});

		expect(hosts[0].device.buildsTheDays()).toBe(true);
	});

	it("answers a feature's next call from what the store now holds, with no new host and no reload", async () => {
		const { registry, device } = await build();

		const hosts: FeatureHost[] = [];
		registry.register("reader", (host) => {
			hosts.push(host);
			return new Simple(host, "reader");
		});

		expect(hosts[0].device.buildsTheDays()).toBe(false);
		device.save({ buildsTheDays: true });
		// Same host object, same call — proves the answer is read each time
		// rather than kept from when the host was built.
		expect(hosts[0].device.buildsTheDays()).toBe(true);
	});

	it("gives a feature no way to reach the per-device store's other field", async () => {
		const { registry } = await build();
		const hosts: FeatureHost[] = [];
		registry.register("reader", (host) => {
			hosts.push(host);
			return new Simple(host, "reader");
		});

		// Compile-time rather than runtime: the arrow is never called.
		// `host.device` is a narrow view, and `calendarReads` is not a member of
		// its declared shape — no feature has any business with it.
		() => {
			// @ts-expect-error — calendarReads is not on the narrow device view.
			hosts[0].device.calendarReads;
		};

		expect(hosts[0].device.buildsTheDays()).toBe(false);
	});

	it("loads every feature the user has not switched off", async () => {
		const { settings, registry } = await build();
		await settings.setEnabled("b", false);

		const made: Simple[] = [];
		for (const id of ["a", "b"]) {
			registry.register(id, (host) => {
				const feature = new Simple(host, id);
				made.push(feature);
				return feature;
			});
		}
		registry.start();

		expect(made.map((f) => f.loads)).toEqual([1, 0]);
		expect(registry.statuses().map((s) => s.state)).toEqual(["running", "off"]);
	});

	it("reports a feature that is on but has nothing to work with", async () => {
		const { registry } = await build();
		registry.register("calendar",
			(host) =>
				new Simple(host, "calendar", {
					state: "unconfigured",
					reason: "Tell it where your calendar file is.",
				}),
		);
		registry.start();

		expect(registry.statuses()[0]).toMatchObject({
			state: "unconfigured",
			detail: "Tell it where your calendar file is.",
		});
	});

	it("keeps the other features running when one fails to start", async () => {
		const { registry } = await build();
		let survivor: Simple | undefined;
		registry.register("broken", (host) => new Broken(host));
		registry.register("fine", (host) => (survivor = new Simple(host, "fine")));
		registry.start();

		expect(survivor?.loads).toBe(1);
		const states = registry.statuses();
		expect(states[0]).toMatchObject({
			state: "failed",
			detail: "could not reach the calendar file",
		});
		expect(states[1].state).toBe("running");
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("could not reach the calendar file");
	});

	it("keeps the other features running when one cannot say if it is ready", async () => {
		const { registry } = await build();
		let survivor: Simple | undefined;
		let unaskable: Unaskable | undefined;
		registry.register("unaskable", (host) => (unaskable = new Unaskable(host)));
		registry.register("fine", (host) => (survivor = new Simple(host, "fine")));

		expect(() => registry.start()).not.toThrow();

		expect(unaskable?.loads).toBe(0);
		expect(survivor?.loads).toBe(1);
		const states = registry.statuses();
		expect(states[0]).toMatchObject({ state: "failed", detail: "Platform is not defined" });
		expect(states[1].state).toBe("running");
	});

	it("still draws every row when a switched-off feature cannot say if it is ready", async () => {
		// `stateOf` asks readiness before the switch, so an off feature is asked
		// on every draw of the settings screen. One throw must not empty it.
		const { settings, registry } = await build();
		await settings.setEnabled("unaskable", false);
		registry.register("unaskable", (host) => new Unaskable(host));
		registry.register("fine", (host) => new Simple(host, "fine"));
		registry.start();

		expect(registry.statuses().map((s) => s.state)).toEqual(["failed", "running"]);
	});

	it("still reports a failed feature as failed after switching it off and on", async () => {
		// The obvious thing a person does on seeing "Failed". Obsidian marks a
		// component loaded before calling `onload`, so a feature that threw is
		// still attached and still flagged loaded; unless the registry detaches
		// it, the retry never re-enters `onload` and the row reads "running".
		const { registry } = await build();
		let broken: Broken | undefined;
		registry.register("broken", (host) => (broken = new Broken(host)));
		registry.start();

		expect(registry.statuses()[0].state).toBe("failed");

		await registry.setEnabled("broken", false);
		await registry.setEnabled("broken", true);

		expect(broken?.attempts).toBe(2);
		expect(registry.statuses()[0]).toMatchObject({
			state: "failed",
			detail: "could not reach the calendar file",
		});
	});

	it("leaves no copy of a failed feature attached to the plugin", async () => {
		const { plugin, registry } = await build();
		registry.register("broken", (host) => new Broken(host));
		registry.start();
		await registry.setEnabled("broken", false);
		await registry.setEnabled("broken", true);

		expect(plugin.children).toHaveLength(0);
	});

	it("unloads a feature and removes its commands when it is switched off", async () => {
		const { plugin, registry } = await build();
		let feature: Simple | undefined;
		registry.register("cycler", (host) => (feature = new Simple(host, "cycler")));
		registry.start();

		await registry.setEnabled("cycler", false);

		expect(feature?.unloads).toBe(1);
		expect(plugin.removedCommands).toEqual(["do-the-thing"]);
		expect(registry.statuses()[0].state).toBe("off");
	});

	it("leaves the palette empty when the feature is switched off", async () => {
		// The state, not the call log. Every other test here reads
		// `removedCommands`, which says only that a withdrawal was attempted with
		// some id; this one asks the application whether the command is still
		// there. That is the difference #548 lived in: the plugin handed Obsidian
		// an id that already carried the manifest prefix, Obsidian added the
		// prefix again, looked for `effortless:effortless:do-the-thing`, found
		// nothing, and said nothing — so a person switched a feature off and its
		// hotkeys went on firing until Obsidian was restarted.
		const { plugin, registry } = await build();
		registry.register("cycler", (host) => new Simple(host, "cycler"));
		registry.start();
		expect(plugin.commands).toHaveLength(1);

		await registry.setEnabled("cycler", false);

		expect(plugin.commands).toEqual([]);
	});

	it("leaves the palette without a command a feature withdraws", async () => {
		// The other call site, the one a running feature reaches through its host
		// rather than the one a switch-off reaches. Both prefixed the id and both
		// were no-ops; a fix to either alone leaves the other standing.
		const { plugin, registry } = await build();
		let cycling: Editable | undefined;
		registry.register("cycling", (host) => (cycling = new Editable(host)));
		registry.start();
		expect(plugin.commands.map((command) => command.id)).toEqual([
			"effortless:cycling:first:forward",
		]);

		cycling?.withdraw("cycling:first:forward");

		expect(plugin.commands).toEqual([]);
	});

	it("keeps a switched-off feature's settings and brings them back", async () => {
		const { settings, registry } = await build();
		registry.register("cycler", (host) => new Simple(host, "cycler"));
		registry.start();

		await settings.handleFor("cycler", { sequence: " x" }).save({ sequence: " /x-" });
		await registry.setEnabled("cycler", false);
		await registry.setEnabled("cycler", true);

		expect(settings.handleFor("cycler", { sequence: " x" }).read()).toEqual({
			sequence: " /x-",
		});
		expect(registry.statuses()[0].state).toBe("running");
	});

	it("constructs a feature that stood itself down but never loads it", async () => {
		const { plugin, registry } = await build();
		let days!: Deferring;
		registry.register("days", (host) => (days = new Deferring(host)));

		registry.start();

		// Constructed, so its row and its own settings are there to be read and
		// edited here. Not attached, so nothing of it runs and it registers no
		// commands — it said another device has the job.
		expect(days.loads).toBe(0);
		expect(plugin.children).toHaveLength(0);
		expect(plugin.commands).toHaveLength(0);
		expect(registry.statuses()[0]).toMatchObject({
			state: "standby",
			detail: "Your desktop builds the days.",
		});
	});

	it("still opens the settings of a feature that stood itself down", async () => {
		const { registry } = await build();
		let drawn = false;
		registry.register("days", (host) => {
			const days = new Deferring(host);
			days.displaySettings = () => {
				drawn = true;
			};
			return days;
		});
		registry.start();

		registry.displaySettings("days", document.createElement("div"), () => {});

		expect(drawn).toBe(true);
	});

	it("hands the feature the way of saying its stored state changed", async () => {
		// The registry carries it and never calls it: what the screen does when a
		// feature reports a change is the screen's own.
		const { registry } = await build();
		let handed: unknown = "nothing was handed over";
		registry.register("days", (host) => {
			const days = new Deferring(host);
			days.displaySettings = (_containerEl, changed) => {
				handed = changed;
			};
			return days;
		});
		registry.start();
		const changed = (): void => {};

		registry.displaySettings("days", document.createElement("div"), changed);

		expect(handed).toBe(changed);
	});

	it("draws a feature that ignores that hook exactly as it did before", async () => {
		// Every feature but the cycling one takes the element alone, and the
		// promise made to them is that nothing changes for them.
		const { plugin, registry } = await build();
		registry.register("configurable", (host) => new Configurable(host));
		registry.start();
		let asked = 0;

		registry.displaySettings("configurable", document.createElement("div"), () => {
			asked += 1;
		});

		expect(plugin.commands.map((c) => c.id)).toEqual(["effortless:do-the-thing"]);
		expect(asked).toBe(0);
	});

	it("loads a feature that stops standing by, with no plugin reload", async () => {
		const { plugin, registry } = await build();
		let days!: Deferring;
		registry.register("days", (host) => (days = new Deferring(host)));
		registry.start();

		// The person has just told this device to build the days.
		days.ready = { state: "ready" };
		registry.recheckReadiness();

		expect(days.loads).toBe(1);
		expect(plugin.children).toHaveLength(1);
		expect(registry.statuses()[0].state).toBe("running");
	});

	it("unloads a feature that starts standing by, and takes its commands with it", async () => {
		const { plugin, registry } = await build();
		let days!: Deferring;
		registry.register("days", (host) => (days = new Deferring(host)));
		days.ready = { state: "ready" };
		registry.start();

		// And now the other device has been given the job instead.
		days.ready = { state: "standby", reason: "Your desktop builds the days." };
		registry.recheckReadiness();

		expect(days.unloads).toBe(1);
		expect(plugin.children).toHaveLength(0);
		expect(plugin.removedCommands).toEqual(["build-the-days"]);
		expect(registry.statuses()[0].state).toBe("standby");
	});

	it("leaves a switched-off feature off, whatever its readiness now answers", async () => {
		const { plugin, registry } = await build();
		let days!: Deferring;
		registry.register("days", (host) => (days = new Deferring(host)));
		registry.start();
		await registry.setEnabled("days", false);

		days.ready = { state: "ready" };
		registry.recheckReadiness();

		// The switch is the person's own answer. Nothing a feature says about
		// itself may overrule it.
		expect(days.loads).toBe(0);
		expect(plugin.children).toHaveLength(0);
		expect(registry.statuses()[0].state).toBe("off");
	});

	it("leaves a feature this device cannot run exactly as it was", async () => {
		const { plugin, registry } = await build();
		let made!: Simple;
		registry.register("recorder",
			(host) =>
				(made = new Simple(host, "recorder", {
					state: "unavailable",
					reason: "Recording needs a microphone this device has not got.",
				})),
		);
		registry.start();

		registry.recheckReadiness();

		expect(made.loads).toBe(0);
		expect(plugin.children).toHaveLength(0);
		expect(registry.statuses()[0].state).toBe("unavailable");
	});

	it("refuses a settings handle read while the feature is being built", async () => {
		// #86's message is what this used to be: `Cannot read properties of null
		// (reading 'id')`, from the deferred lookup reaching for a feature the
		// core has nowhere to put yet. The author is told what to do instead.
		const { registry } = await build();
		let thrown: unknown;

		registry.register("hasty", (host) => {
			try {
				host.settings({ days: 7 }).read();
			} catch (error) {
				thrown = error;
			}
			return new Simple(host, "hasty");
		});

		expect(thrown).toBeInstanceOf(Error);
		expect(reasonOf(thrown)).toContain("settings handle");
		expect(reasonOf(thrown)).toContain("onload()");
		expect(reasonOf(thrown)).toContain("src/core/feature.ts");
		expect(reasonOf(thrown)).not.toContain("Cannot read properties of null");
	});

	it("refuses a problem reported while the feature is being built", async () => {
		// The other half. This one used to be worse than a wrong message: the
		// report went through the `accepting` gate, which is false during
		// construction, and was dropped with nothing said at all.
		const { registry, problems } = await build();
		let thrown: unknown;

		registry.register("hasty", (host) => {
			try {
				host.problems.report("House/Garden.md", "12 tasks are no longer paired.");
			} catch (error) {
				thrown = error;
			}
			return new Simple(host, "hasty");
		});

		expect(thrown).toBeInstanceOf(Error);
		expect(reasonOf(thrown)).toContain("problem channel");
		expect(reasonOf(thrown)).toContain("onload()");
		expect(problems.all()).toEqual([]);
	});

	it("still says nothing when a switched-off feature reports", async () => {
		// The distinction #177 turns on. `accepting` is false in two situations:
		// no feature yet, which is the constructor above and throws, and a
		// feature that exists and is switched off, which stays silent. Only the
		// first changed.
		const { registry, problems } = await build();
		let pairing!: Debounced;
		registry.register("pairing", (host) => (pairing = new Debounced(host)));
		registry.start();
		await registry.setEnabled("pairing", false);
		Notice.messages = [];

		expect(() => pairing.lateReport("Work/Roof.md")).not.toThrow();

		expect(problems.all()).toEqual([]);
		expect(Notice.messages).toEqual([]);
	});

	it("says nothing when a feature reports after stop(), and unloads nothing", async () => {
		// The whole-plugin counterpart of the test above. Switching one feature
		// off silences it through `unload`; unloading the plugin never reaches
		// that method, because Obsidian detaches the features itself. Without
		// `stop()` every entry was left accepting, so a queued re-check firing
		// after the unload reached a `Notice` and a settings screen belonging to
		// a plugin that is gone.
		const { registry, problems } = await build();
		let pairing!: Debounced;
		let plain!: Simple;
		registry.register("pairing", (host) => (pairing = new Debounced(host)));
		registry.register("simple", (host) => (plain = new Simple(host, "simple")));
		registry.start();
		Notice.messages = [];

		registry.stop();

		expect(() => pairing.lateReport("Work/Roof.md")).not.toThrow();
		expect(problems.all()).toEqual([]);
		expect(Notice.messages).toEqual([]);
		// It closes a channel and does nothing else. `Component.unload()`
		// detaches every child on its own, so unloading the features here would
		// run each one's `onunload` twice — and run it first, through a path
		// whose failures the person is told about while the plugin disappears.
		expect(plain.unloads).toBe(0);
		expect(registry.statuses().map((row) => row.state)).toEqual(["running", "running"]);
	});

	it("silences a handle taken after stop() as well as one kept from before", async () => {
		// The gate is asked on every call rather than when the handle is taken, so a feature that takes a fresh handle after the plugin has
		// stood down is silenced by the same line. Nothing brings the entries
		// back: an unloaded plugin is built again rather than restarted.
		const { registry, problems } = await build();
		let pairing!: Debounced;
		registry.register("pairing", (host) => (pairing = new Debounced(host)));
		registry.start();
		Notice.messages = [];

		registry.stop();

		expect(() => pairing.reportThroughAFreshHandle("Work/Roof.md")).not.toThrow();
		expect(problems.all()).toEqual([]);
		expect(Notice.messages).toEqual([]);
	});

	it("throws nothing when a registry with no features is stopped", async () => {
		// What `main.ts` ships today: the features arrive one issue at a time,
		// so every unload until the first of them lands takes this path.
		const { registry } = await build();
		registry.start();

		expect(() => registry.stop()).not.toThrow();
	});

	it("finishes the round when one feature will not stop", async () => {
		// The device switch asks every feature again in one loop. A throw from
		// one feature's exit used to end that loop, so every feature after it
		// was never asked and the switch never took effect for them.
		const { registry } = await build();
		let stubborn!: BadExit;
		let waiting!: Deferring;
		registry.register("bad-exit", (host) => (stubborn = new BadExit(host)));
		registry.register("days", (host) => (waiting = new Deferring(host)));
		registry.start();
		expect(stubborn.loads).toBe(1);
		expect(waiting.loads).toBe(0);
		Notice.messages = [];

		// The building job has just moved: one feature stands down, the next starts.
		stubborn.ready = { state: "standby", reason: "Another device does it." };
		waiting.ready = { state: "ready" };

		expect(() => registry.recheckReadiness()).not.toThrow();

		expect(waiting.loads).toBe(1);
		// Once, naming the feature. The person has not been told anything about
		// this feature yet, so the catch may not be a silent one.
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("Bad exit");
		expect(Notice.messages[0]).toContain("the file watcher was already gone");
	});

	it("leaves nothing behind of a feature that would not stop", async () => {
		const { plugin, registry } = await build();
		let stubborn!: BadExit;
		registry.register("bad-exit", (host) => (stubborn = new BadExit(host)));
		registry.start();

		stubborn.ready = { state: "standby", reason: "Another device does it." };
		registry.recheckReadiness();

		// Its command is gone from the palette rather than left pointing at a
		// feature that is no longer running.
		expect(plugin.removedCommands).toEqual(["do-the-thing"]);
		// And the entry is not left marked loaded: if it were, the load below
		// would be refused at the door and the feature would never come back.
		stubborn.ready = { state: "ready" };
		registry.recheckReadiness();
		expect(stubborn.loads).toBe(2);
	});

	it("does not retry a load that already failed", async () => {
		// `recheckReadiness` asks whether a feature should be running here. It is
		// not a retry, and a person moving the building job between devices has
		// not asked for one.
		const { registry } = await build();
		let broken!: Broken;
		registry.register("broken", (host) => (broken = new Broken(host)));
		registry.start();
		expect(broken.attempts).toBe(1);
		expect(Notice.messages).toHaveLength(1);

		registry.recheckReadiness();
		registry.recheckReadiness();

		expect(broken.attempts).toBe(1);
		// One failure, told about once. Two flips of the device switch used to
		// mean three notices for the same thing.
		expect(Notice.messages).toHaveLength(1);
	});

	it("still retries when the person switches the feature off and on", async () => {
		// The one affordance a retry is attached to. `setEnabled` calls `load`
		// directly and is untouched by the skip above.
		const { registry } = await build();
		let broken!: Broken;
		registry.register("broken", (host) => (broken = new Broken(host)));
		registry.start();
		expect(broken.attempts).toBe(1);

		await registry.setEnabled("broken", false);
		await registry.setEnabled("broken", true);

		expect(broken.attempts).toBe(2);
	});

	it("stops calling a feature failed once the person switches it off", async () => {
		// A feature that is off is not a feature that failed. `unload` returned
		// on `!entry.loaded` ahead of the line that clears the record, and a
		// failed load is exactly the case that never marked the entry loaded —
		// so the one path that cleared a failure was the one that had none.
		const { registry } = await build();
		registry.register("mendable", (host) => new Mendable(host));
		registry.start();
		expect(registry.statuses()[0].state).toBe("failed");

		await registry.setEnabled("mendable", false);

		expect(registry.statuses()[0].state).toBe("off");
		expect(registry.statuses()[0].detail).toBeUndefined();
	});

	it("clears it on the other early return too, where load finds the feature standing down", async () => {
		// The settings screen cannot produce this sequence. Its toggle hands over
		// the flipped value and nothing else, so `setEnabled(id, true)` never
		// arrives for a feature that is already on; the only caller that can
		// reach this return with a failure still recorded is the registry's own
		// public API, which is what this test is. The branch
		// is kept for exactly that reason: `setEnabled` is public, and making its
		// correctness depend on one screen's toggle semantics is the
		// cross-coupling the feature contract exists to prevent. It is the
		// return the switch-off above does not cover.
		const { registry } = await build();
		let mendable!: Mendable;
		registry.register("mendable", (host) => (mendable = new Mendable(host)));
		registry.start();
		expect(registry.statuses()[0].state).toBe("failed");

		mendable.ready = { state: "standby", reason: "Your desktop builds the days." };
		await registry.setEnabled("mendable", true);

		expect(registry.statuses()[0]).toMatchObject({
			state: "standby",
			detail: "Your desktop builds the days.",
		});
	});

	it("brings back a feature that failed, was fixed, and stood down in between", async () => {
		// The whole dead end, end to end. The person fixes the cause, gives the
		// building job to the other device, switches the feature off and on, and
		// then takes the job back. A failure record surviving any of those steps
		// made `recheckReadiness` skip the feature for the rest of the session,
		// and nothing on the screen said the remedy was to switch it off and on a
		// second time.
		const { registry } = await build();
		let mendable!: Mendable;
		registry.register("mendable", (host) => (mendable = new Mendable(host)));
		registry.start();
		expect(registry.statuses()[0].state).toBe("failed");

		mendable.throws = false;
		mendable.ready = { state: "standby", reason: "Your desktop builds the days." };
		await registry.setEnabled("mendable", false);
		await registry.setEnabled("mendable", true);

		// The truth is standby, and the row says so rather than blaming a failure
		// the person has already fixed.
		expect(registry.statuses()[0]).toMatchObject({
			state: "standby",
			detail: "Your desktop builds the days.",
		});

		mendable.ready = { state: "ready" };
		registry.recheckReadiness();

		expect(mendable.loads).toBe(1);
		expect(registry.statuses()[0].state).toBe("running");
	});

	it("refuses two features claiming the same id", async () => {
		const { registry } = await build();
		registry.register("twin", (host) => new Simple(host, "twin"));
		expect(() => registry.register("twin", (host) => new Simple(host, "twin"))).toThrow(/twin/);
	});

	it("does not run the second factory for an id already taken", async () => {
		// The id is known before anything is built, so the duplicate is refused
		// while it is still a factory. It never gets to hold a live host closure
		// or register commands nothing would ever take back.
		const { registry } = await build();
		let ran = false;
		registry.register("twin", (host) => new Simple(host, "twin"));

		expect(() =>
			registry.register("twin", (host) => {
				ran = true;
				return new Simple(host, "twin");
			}),
		).toThrow(/twin/);

		expect(ran).toBe(false);
	});

	it("keeps the plugin up when a feature's constructor throws", async () => {
		const { registry } = await build();
		let survivor: Simple | undefined;

		expect(() => registry.register("stillborn", (host) => new Stillborn(host))).not.toThrow();
		registry.register("fine", (host) => (survivor = new Simple(host, "fine")));
		registry.start();

		expect(survivor?.loads).toBe(1);
		// No entry, so no row: a row is drawn from a feature, and this one was
		// never made. The person hears about it once instead.
		expect(registry.statuses()).toHaveLength(1);
		expect(registry.statuses()[0].id).toBe("fine");
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("stillborn");
		expect(Notice.messages[0]).toContain("the vault has no Calendars folder");
	});

	it("refuses a command registered while the feature is being built", async () => {
		// The entry that holds the ids to remove is discarded when the factory
		// throws, and `removeCommands` is reachable only through an entry the
		// registry kept. So a command registered from a constructor used to sit
		// in the palette for the rest of the session with nothing able to take it
		// back, running a closure over a feature that was never finished.
		const { plugin, registry } = await build();

		expect(() => registry.register("premature", (host) => new Premature(host))).not.toThrow();

		expect(registry.statuses()).toHaveLength(0);
		expect(plugin.commands).toHaveLength(0);
		expect(plugin.removedCommands).toEqual([]);
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("premature");
		expect(Notice.messages[0]).toContain("onload()");
		expect(Notice.messages[0]).toContain("src/core/feature.ts");
	});

	it("refuses it for a switched-off feature as well", async () => {
		// The second way the same line stranded a command, and the one a person
		// could hit without anything failing: `register` constructs every
		// feature, so a constructor's command was registered for a feature that
		// is off. Switching it on and off again removed the command and never put
		// it back.
		const { plugin, settings, registry } = await build();
		await settings.setEnabled("premature", false);

		registry.register("premature", (host) => new Premature(host));
		registry.start();

		expect(plugin.commands).toHaveLength(0);
		expect(registry.statuses()).toHaveLength(0);
	});

	it("still lets a feature register a command from onload", async () => {
		// The guard is about when, not about whether. `Simple` registers one the
		// ordinary way, and switching it off still takes it back.
		const { plugin, registry } = await build();
		registry.register("cycler", (host) => new Simple(host, "cycler"));
		registry.start();

		expect(plugin.commands.map((c) => c.id)).toEqual(["effortless:do-the-thing"]);

		await registry.setEnabled("cycler", false);

		expect(plugin.removedCommands).toEqual(["do-the-thing"]);
		expect(plugin.commands).toEqual([]);
	});

	it("takes back a command from a feature that was never started", async () => {
		// The guard on `addCommand` asks whether the feature exists yet, not
		// whether it is running, so a feature that stood itself down is past it.
		// Switching such a feature off used to give up before the line that takes
		// commands back, and the command stayed in the palette for the session.
		const { plugin, registry } = await build();
		registry.register("configurable", (host) => new Configurable(host));
		registry.start();
		expect(registry.statuses()[0].state).toBe("standby");

		// The settings screen draws a stood-down feature's own settings on purpose.
		registry.displaySettings("configurable", document.createElement("div"), () => {});
		expect(plugin.commands.map((c) => c.id)).toEqual(["effortless:do-the-thing"]);

		await registry.setEnabled("configurable", false);

		expect(plugin.removedCommands).toEqual(["do-the-thing"]);
		expect(plugin.commands).toEqual([]);
	});

	it("takes back a command a feature registers from its own teardown", async () => {
		// The second run of the cleanup, below the catch, is what catches this
		// one: the first run happens before the feature is detached, so it cannot
		// see anything `onunload` adds.
		const { plugin, registry } = await build();
		registry.register("late", (host) => new LateCommand(host));
		registry.start();

		await registry.setEnabled("late", false);

		// Added from `onunload` and taken straight back out again by the second
		// run of the cleanup. The stub's palette is a live set now, so what says
		// the command was ever there is the withdrawal below.
		expect(plugin.commands).toEqual([]);
		expect(plugin.removedCommands).toEqual(["one-last-thing"]);
	});

	it("takes back one command and leaves the feature's others", async () => {
		// The whole of #321: a feature whose commands come from an edited list has
		// to be able to drop one without unloading, and the entry has to forget it
		// so that unloading later does not ask Obsidian to remove it twice.
		const { plugin, registry } = await build();
		let cycling: Editable | undefined;
		registry.register("cycling", (host) => (cycling = new Editable(host)));
		registry.start();
		cycling?.add("cycling:second:forward");

		cycling?.withdraw("cycling:first:forward");

		expect(plugin.removedCommands).toEqual(["cycling:first:forward"]);

		await registry.setEnabled("cycling", false);

		// One entry per command and no more: the withdrawn one is gone from the
		// entry's record, so unloading takes back only what was left.
		expect(plugin.removedCommands).toEqual([
			"cycling:first:forward",
			"cycling:second:forward",
		]);
	});

	it("accepts the id Obsidian hands back as well as the one given", async () => {
		// `addCommand` returns a command whose id may already carry the plugin's
		// manifest id, and a feature that kept that object has only that form to
		// offer. Both ends normalise the same way or a feature could not name a
		// command it registered itself.
		const { plugin, registry } = await build();
		let cycling: Editable | undefined;
		registry.register("cycling", (host) => (cycling = new Editable(host)));
		registry.start();

		cycling?.withdraw("effortless:cycling:first:forward");

		// Named with the prefix and withdrawn all the same. What reaches Obsidian
		// is the short form either way, because that is the form its own
		// `removeCommand` wants.
		expect(plugin.removedCommands).toEqual(["cycling:first:forward"]);
		expect(plugin.commands).toEqual([]);
	});

	it("does nothing for an id the feature never registered", async () => {
		// Including an id another feature holds. The entry's own list is the only
		// thing read, so one feature can neither reach another's commands nor be
		// made to throw by naming one — and a feature rebuilding its set may
		// withdraw what it thinks it holds without first working out what that is.
		const { plugin, registry } = await build();
		let cycling: Editable | undefined;
		registry.register("cycling", (host) => (cycling = new Editable(host)));
		registry.register("simple", (host) => new Simple(host, "simple"));
		registry.start();

		expect(() => cycling?.withdraw("cycling:never-registered:forward")).not.toThrow();
		expect(() => cycling?.withdraw("do-the-thing")).not.toThrow();

		expect(plugin.removedCommands).toEqual([]);

		// `Simple` still holds it, and still gives it up when it stops.
		await registry.setEnabled("simple", false);

		expect(plugin.removedCommands).toEqual(["do-the-thing"]);
	});

	it("refuses a command withdrawn while the feature is being built", async () => {
		// The same guard and the same sentence as `addCommand`'s, because it is the
		// same rule: the list a withdrawal reads lives on an entry the registry may
		// yet throw away, and until the constructor has returned there is no
		// feature whose commands those would be.
		const { plugin, registry } = await build();

		expect(() =>
			registry.register("premature-withdrawal", (host) => new PrematureWithdrawal(host)),
		).not.toThrow();

		expect(registry.statuses()).toHaveLength(0);
		expect(plugin.removedCommands).toEqual([]);
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("premature-withdrawal");
		expect(Notice.messages[0]).toContain("onload()");
		expect(Notice.messages[0]).toContain("src/core/feature.ts");
	});

	it("leaves exactly one command after register, withdraw, register again", async () => {
		// `removedCommands` is every id ever taken back, so what proves "exactly
		// one" is the count at the end. Unloading removes the id a second time and
		// no more: a third removal would mean the entry had kept two records of one
		// command, and the palette would be showing it.
		const { plugin, registry } = await build();
		let cycling: Editable | undefined;
		registry.register("cycling", (host) => (cycling = new Editable(host)));
		registry.start();

		cycling?.withdraw("cycling:first:forward");
		cycling?.add("cycling:first:forward");

		await registry.setEnabled("cycling", false);

		expect(plugin.removedCommands).toEqual([
			"cycling:first:forward",
			"cycling:first:forward",
		]);
	});

	it("refuses a feature whose own id is not the one it was registered under", async () => {
		// The id is written twice, and a drift between the two would file the
		// feature's settings and commands under different names.
		const { registry } = await build();

		expect(() => registry.register("days", (host) => new Simple(host, "cycler"))).toThrow(
			/"days".*"cycler"/,
		);
		expect(registry.statuses()).toHaveLength(0);
	});

	it("gives a feature a live view of the core settings", async () => {
		const { settings, registry } = await build();
		let host: FeatureHost | undefined;
		registry.register("reader", (h) => {
			host = h;
			return new Simple(h, "reader");
		});
		registry.start();

		const core = settings.core();
		await settings.saveCore({ ...core, layout: { ...core.layout, dailyLogFolder: "Journal" } });

		expect(host?.core.layout.dailyLogFolder).toBe("Journal");
	});
});

describe("the seven states, and the order they win in", () => {
	beforeEach(() => {
		Notice.messages = [];
	});

	it("never loads a feature that says this device cannot run it", async () => {
		const { registry } = await build();
		let feature: Simple | undefined;
		registry.register("recorder",
			(host) =>
				(feature = new Simple(host, "recorder", {
					state: "unavailable",
					reason: "Recording needs a microphone this device has not got.",
				})),
		);
		registry.start();

		expect(feature?.loads).toBe(0);
		expect(registry.statuses()[0]).toMatchObject({
			state: "unavailable",
			detail: "Recording needs a microphone this device has not got.",
		});
	});

	it("lets not available here beat the switch the other device stored", async () => {
		// The stored switch travels in data.json, so on this device it is the
		// other device's answer. Availability is asked here, every start.
		const { settings, registry } = await build();
		await settings.setEnabled("recorder", false);
		registry.register("recorder",
			(host) =>
				new Simple(host, "recorder", {
					state: "unavailable",
					reason: "Recording needs a microphone this device has not got.",
				}),
		);
		registry.start();

		expect(registry.statuses()[0].state).toBe("unavailable");
	});

	it("still refuses to load an unavailable feature switched on by hand", async () => {
		const { registry } = await build();
		let feature: Simple | undefined;
		registry.register("recorder",
			(host) =>
				(feature = new Simple(host, "recorder", {
					state: "unavailable",
					reason: "Recording needs a microphone this device has not got.",
				})),
		);
		registry.start();

		await registry.setEnabled("recorder", true);

		expect(feature?.loads).toBe(0);
		expect(registry.statuses()[0].state).toBe("unavailable");
	});

	it("reads a feature that stood itself down as off, with its own reason", async () => {
		const { registry } = await build();
		registry.register("days-ahead",
			(host) =>
				new Simple(host, "days-ahead", {
					state: "standby",
					reason: "Another device builds the days.",
				}),
		);
		registry.start();

		expect(registry.statuses()[0]).toMatchObject({
			state: "standby",
			detail: "Another device builds the days.",
		});
	});

	it("lets the person's own switch beat the feature standing itself down", async () => {
		const { settings, registry } = await build();
		await settings.setEnabled("days-ahead", false);
		registry.register("days-ahead",
			(host) =>
				new Simple(host, "days-ahead", {
					state: "standby",
					reason: "Another device builds the days.",
				}),
		);
		registry.start();

		expect(registry.statuses()[0]).toMatchObject({ state: "off" });
		expect(registry.statuses()[0].detail).toBeUndefined();
	});

	it("lets the person's own switch beat a feature that is not configured", async () => {
		const { settings, registry } = await build();
		await settings.setEnabled("calendar", false);
		registry.register("calendar",
			(host) =>
				new Simple(host, "calendar", {
					state: "unconfigured",
					reason: "Tell it where your calendar file is.",
				}),
		);
		registry.start();

		expect(registry.statuses()[0]).toMatchObject({ state: "off" });
		expect(registry.statuses()[0].detail).toBeUndefined();
	});

	it("lets failed beat not available here", async () => {
		// A feature that could not start cannot report anything else, so the
		// failure keeps the row even once the feature says it does not belong here.
		const { registry } = await build();
		let feature: Fickle | undefined;
		registry.register("fickle", (host) => (feature = new Fickle(host)));
		registry.start();

		expect(registry.statuses()[0].state).toBe("failed");

		if (feature) {
			feature.ready = { state: "unavailable", reason: "Not this device." };
		}

		expect(registry.statuses()[0]).toMatchObject({
			state: "failed",
			detail: "could not reach the calendar file",
		});
	});

	it("writes nothing at all while working out what this device can run", async () => {
		const { plugin, registry, settings } = await build();
		const before = plugin.saved.length;
		registry.register("recorder",
			(host) =>
				new Simple(host, "recorder", {
					state: "unavailable",
					reason: "Recording needs a microphone this device has not got.",
				}),
		);
		registry.start();
		registry.statuses();

		expect(plugin.saved.length).toBe(before);
		expect(settings.isEnabled("recorder")).toBe(true);
	});

	it("does not read a feature as running when nothing of it was ever started", async () => {
		// The two readiness calls are separate, so the feature can refuse the
		// load and then answer ready to the screen. Nothing was attached, and
		// the row has to say so rather than borrow `running`.
		const { registry } = await build();
		let feature: Changeable | undefined;
		registry.register("changeable", (host) => {
			feature = new Changeable(host);
			feature.ready = { state: "unavailable", reason: "Not while the disk is unplugged." };
			return feature;
		});
		registry.start();
		if (feature) feature.ready = { state: "ready" };

		expect(feature?.loads).toBe(0);
		expect(registry.statuses()[0]).toMatchObject({
			state: "notStarted",
			detail: "Switched on, but not started on this device. Switch it off and on again to start it.",
		});
	});

	it("still reads a feature that did start as running", async () => {
		const { registry } = await build();
		let feature: Changeable | undefined;
		registry.register("changeable", (host) => (feature = new Changeable(host)));
		registry.start();

		expect(feature?.loads).toBe(1);
		expect(registry.statuses()[0].state).toBe("running");
		expect(registry.statuses()[0].detail).toBeUndefined();
	});

	it("does not read a feature registered after start as running", async () => {
		// `start` has already been past, so nothing loads this one. `main.ts`
		// registers before starting, so no shipped path reaches here — the state
		// exists so that a path that ever does cannot lie about it.
		const { registry } = await build();
		let feature: Changeable | undefined;
		registry.start();
		registry.register("changeable", (host) => (feature = new Changeable(host)));

		expect(feature?.loads).toBe(0);
		expect(registry.statuses()[0].state).toBe("notStarted");
	});

	it("lets not configured beat a feature that was never started", async () => {
		// Both are true of it and only one can be acted on, so the row says the
		// one with something to do in it.
		const { registry } = await build();
		let feature: Changeable | undefined;
		registry.register("changeable", (host) => {
			feature = new Changeable(host);
			feature.ready = { state: "unavailable", reason: "Not while the disk is unplugged." };
			return feature;
		});
		registry.start();
		if (feature) feature.ready = { state: "unconfigured", reason: "Tell it where your calendar is." };

		expect(registry.statuses()[0]).toMatchObject({
			state: "unconfigured",
			detail: "Tell it where your calendar is.",
		});
	});

	it("reads a feature switched off and on again as running, not as never started", async () => {
		// The remedy the row's sentence names has to work. Switching the feature
		// on calls `load` again, which asks readiness again.
		const { registry } = await build();
		let feature: Changeable | undefined;
		registry.register("changeable", (host) => {
			feature = new Changeable(host);
			feature.ready = { state: "unavailable", reason: "Not while the disk is unplugged." };
			return feature;
		});
		registry.start();
		if (feature) feature.ready = { state: "ready" };

		await registry.setEnabled("changeable", false);
		await registry.setEnabled("changeable", true);

		expect(feature?.loads).toBe(1);
		expect(registry.statuses()[0].state).toBe("running");
	});
});

describe("the standing-problem channel", () => {
	beforeEach(() => {
		Notice.messages = [];
	});

	it("carries a feature's report to the screen, and clears it again", async () => {
		const { registry, problems } = await build();
		let pairing!: Reporter;
		registry.register("pairing", (host) => (pairing = new Reporter(host)));
		registry.start();

		pairing.breaks("House/Garden.md", 12);
		expect(problems.all()).toEqual([
			{
				featureId: "pairing",
				featureName: "Pairing",
				key: "House/Garden.md",
				message: "12 tasks in House/Garden.md are no longer paired.",
			},
		]);

		pairing.mends("House/Garden.md");
		expect(problems.all()).toEqual([]);
	});

	it("raises one notice for twelve orphaned tasks, however often it is re-checked", async () => {
		const { registry } = await build();
		let pairing!: Reporter;
		registry.register("pairing", (host) => (pairing = new Reporter(host)));
		registry.start();

		// A feature re-checks its work whenever the vault changes.
		for (let i = 0; i < 4; i += 1) pairing.breaks("House/Garden.md", 12);

		expect(Notice.messages).toEqual([
			"Effortless: 12 tasks in House/Garden.md are no longer paired.",
		]);
	});

	it("writes nothing to the settings file when a feature reports a problem", async () => {
		const { plugin, registry } = await build();
		let pairing!: Reporter;
		registry.register("pairing", (host) => (pairing = new Reporter(host)));
		registry.start();
		const before = plugin.saved.length;

		pairing.breaks("House/Garden.md", 12);
		pairing.mends("House/Garden.md");

		expect(plugin.saved.length).toBe(before);
	});

	it("survives a feature that takes its channel while it is being built", async () => {
		const { registry } = await build();

		// `register` is called straight from `onload` with no `try`/`catch`, so
		// one such feature used to take the whole plugin down with it: no
		// feature started, and no settings screen was ever added.
		expect(() => registry.register("eager", (host) => new Eager(host))).not.toThrow();
		expect(registry.statuses().map((s) => s.id)).toEqual(["eager"]);
	});

	it("gives a channel taken that early the feature it actually belongs to", async () => {
		const { registry, problems } = await build();
		let eager!: Eager;
		registry.register("eager", (host) => (eager = new Eager(host)));
		registry.start();

		eager.breaks("House/Garden.md", 12);

		expect(problems.all()).toEqual([
			{
				featureId: "eager",
				featureName: "Eager",
				key: "House/Garden.md",
				message: "12 tasks in House/Garden.md are no longer paired.",
			},
		]);
	});

	it("survives a feature that takes its settings handle while it is being built", async () => {
		const { registry } = await build();

		// `register` is called straight from `onload` with no `try`/`catch`. The
		// throw this used to make was `Cannot read properties of null (reading
		// 'id')`, which named neither the feature nor the rule it broke, and it
		// took every other feature down with it.
		expect(() => registry.register("greedy", (host) => new Greedy(host))).not.toThrow();
		expect(registry.statuses().map((s) => s.id)).toEqual(["greedy"]);
	});

	it("still loads and runs the feature registered beside a greedy one", async () => {
		const { registry } = await build();
		let simple!: Simple;
		registry.register("greedy", (host) => new Greedy(host));
		registry.register("cycler", (host) => (simple = new Simple(host, "cycler")));

		registry.start();

		expect(simple.loads).toBe(1);
		expect(registry.statuses().map((s) => s.state)).toEqual(["running", "running"]);
	});

	it("gives a handle taken that early the same stored settings as one taken later", async () => {
		const { settings, registry } = await build();
		let greedy!: Greedy;
		registry.register("greedy", (host) => (greedy = new Greedy(host)));
		registry.start();

		// Nothing stored yet, so both handles answer with the defaults.
		expect(greedy.own.read()).toEqual({ days: 7, heading: "Today" });
		expect(greedy.laterHandle().read()).toEqual({ days: 7, heading: "Today" });

		await greedy.own.save({ days: 3, heading: "Now" });

		// One slice of one file, keyed by this feature's id however the handle
		// was taken — the constructor's handle writes where the later one reads.
		expect(greedy.laterHandle().read()).toEqual({ days: 3, heading: "Now" });
		expect(settings.handleFor("greedy", { days: 7, heading: "Today" }).read()).toEqual({
			days: 3,
			heading: "Now",
		});
	});

	it("hands a feature's deferred save through to the store, where the unload drains it", async () => {
		// The registry's handle is a third route into the store beside `read` and
		// `save`. Nothing shipped typed through it until the name box did, so the
		// compiler was the only thing that noticed the member missing on the
		// registry side; this pins that the handle reaches the store's one deferred
		// slot — the slice changes at once and the file waits for the drain.
		const { settings, registry } = await build();
		let greedy!: Greedy;
		registry.register("greedy", (host) => (greedy = new Greedy(host)));
		registry.start();

		const pending = greedy.own.saveSoon({ days: 3, heading: "Now" });

		expect(greedy.laterHandle().read()).toEqual({ days: 3, heading: "Now" });
		await settings.flush();
		await pending;
		expect(settings.handleFor("greedy", { days: 7, heading: "Today" }).read()).toEqual({
			days: 3,
			heading: "Now",
		});
	});

	it("takes a failed feature's problems off the screen when it is switched off", async () => {
		const { registry, problems } = await build();
		registry.register("doomed", (host) => new Doomed(host));
		registry.start();
		// It reported, then threw, so it was never recorded as loaded.
		expect(problems.all()).toHaveLength(1);
		expect(registry.statuses()[0].state).toBe("failed");

		await registry.setEnabled("doomed", false);

		// Nothing is left running to clear it, and the person's one action must
		// be enough to get rid of it.
		expect(problems.all()).toEqual([]);
	});

	it("clears them again each time the failure is retried and switched off", async () => {
		const { registry, problems } = await build();
		registry.register("doomed", (host) => new Doomed(host));
		registry.start();
		await registry.setEnabled("doomed", false);

		await registry.setEnabled("doomed", true);
		expect(problems.all()).toHaveLength(1);
		await registry.setEnabled("doomed", false);

		expect(problems.all()).toEqual([]);
	});

	it("switches off a feature that threw without reporting anything, and does not throw doing it", async () => {
		const { registry, problems } = await build();
		let doomed!: Doomed;
		registry.register("doomed", (host) => (doomed = new Doomed(host)));
		doomed.reports = false;
		registry.start();

		await expect(registry.setEnabled("doomed", false)).resolves.toBeUndefined();
		expect(problems.all()).toEqual([]);
	});

	it("leaves another feature's problems standing when a failed one is switched off", async () => {
		const { registry, problems } = await build();
		let pairing!: Reporter;
		registry.register("pairing", (host) => (pairing = new Reporter(host)));
		registry.register("doomed", (host) => new Doomed(host));
		registry.start();
		pairing.breaks("Work/Roof.md", 3);

		await registry.setEnabled("doomed", false);

		expect(problems.all().map((p) => p.featureId)).toEqual(["pairing"]);
	});

	it("drops a report from a feature the person has switched off, and says nothing", async () => {
		const { registry, problems } = await build();
		let pairing!: Debounced;
		registry.register("pairing", (host) => (pairing = new Debounced(host)));
		registry.start();
		await registry.setEnabled("pairing", false);
		Notice.messages = [];

		// The debounced re-check that was already queued when the switch went off.
		pairing.lateReport("House/Garden.md");

		// The person switched it off — the one action open to them — and nothing
		// is left running that would ever clear a row it left behind.
		expect(problems.all()).toEqual([]);
		expect(Notice.messages).toEqual([]);
	});

	it("lets a feature switched back on report again, through the handle it kept and a fresh one", async () => {
		const { registry, problems } = await build();
		let pairing!: Debounced;
		registry.register("pairing", (host) => (pairing = new Debounced(host)));
		registry.start();
		await registry.setEnabled("pairing", false);
		await registry.setEnabled("pairing", true);

		pairing.lateReport("House/Garden.md");
		pairing.reportThroughAFreshHandle("Work/Roof.md");

		expect(problems.all().map((p) => p.key)).toEqual(["House/Garden.md", "Work/Roof.md"]);
	});

	it("lets a handle taken while the feature was off report once it is switched on", async () => {
		// The gate is asked on every call, not when the handle is taken. This is
		// the case that tells the two apart: the handle here was never alive at
		// the moment it was taken, so a gate decided once would leave it inert
		// for the rest of the feature's life. Every other handle in this file
		// was taken while the feature was running.
		const { registry, problems } = await build();
		let pairing!: Debounced;
		registry.register("pairing", (host) => (pairing = new Debounced(host)));
		registry.start();
		await registry.setEnabled("pairing", false);
		Notice.messages = [];

		pairing.takeAHandleNow();
		pairing.reportThroughTheHandleTakenWhileOff("House/Garden.md");
		expect(problems.all()).toEqual([]);

		await registry.setEnabled("pairing", true);
		pairing.reportThroughTheHandleTakenWhileOff("House/Garden.md");

		expect(problems.all().map((p) => p.key)).toEqual(["House/Garden.md"]);
	});

	it("ignores a clear from a switched-off feature and leaves every other feature's problems alone", async () => {
		const { registry, problems } = await build();
		let pairing!: Debounced;
		let other!: Eager;
		registry.register("pairing", (host) => (pairing = new Debounced(host)));
		registry.register("eager", (host) => (other = new Eager(host)));
		registry.start();
		other.breaks("Work/Roof.md", 3);
		await registry.setEnabled("pairing", false);

		expect(() => pairing.lateClear("Work/Roof.md")).not.toThrow();
		expect(() => pairing.lateClearAll()).not.toThrow();

		expect(problems.all().map((p) => p.featureId)).toEqual(["eager"]);
	});

	it("drops a report from a feature whose load threw", async () => {
		const { registry, problems } = await build();
		let doomed!: Doomed;
		registry.register("doomed", (host) => (doomed = new Doomed(host)));
		registry.start();
		Notice.messages = [];

		doomed.lateReport("Work/Roof.md");

		expect(problems.all().map((p) => p.key)).toEqual(["House/Garden.md"]);
		expect(Notice.messages).toEqual([]);
	});

	it("takes a switched-off feature's problems off the screen with it", async () => {
		const { registry, problems } = await build();
		let pairing!: Reporter;
		registry.register("pairing", (host) => (pairing = new Reporter(host)));
		registry.start();
		pairing.breaks("House/Garden.md", 12);

		await registry.setEnabled("pairing", false);

		// Nothing is left running to clear it, and a line the person can neither
		// act on nor get rid of would teach them to stop reading the section.
		expect(problems.all()).toEqual([]);
	});
});

describe("the settings screen's announcer, carried to a feature's panel", () => {
	it("hands the feature the announcer it was given, the way it hands `changed`", async () => {
		// The registry carries it and never calls it: announcing a failed write is
		// the screen's job, and the screen owns the one announcer for itself.
		const { registry } = await build();
		let handed: unknown = "nothing was handed over";
		registry.register("days", (host) => {
			const days = new Deferring(host);
			days.displaySettings = (_containerEl, _changed, announce) => {
				handed = announce;
			};
			return days;
		});
		registry.start();
		const announce = (): void => {};

		registry.displaySettings("days", document.createElement("div"), () => {}, announce);

		expect(handed).toBe(announce);
	});
});

/**
 * A suggester that offers the words starting with what follows the cursor's
 * line start, and counts what it is asked, so a test can tell a keystroke the
 * core declined from one the feature's own suggester answered.
 */
class WordSuggester extends EditorSuggest<string> {
	triggers = 0;
	readonly chosen: Array<{ value: string; query: string | undefined }> = [];

	onTrigger(
		cursor: EditorPosition,
		_editor: StubEditor,
		_file: TFile | null,
	): EditorSuggestTriggerInfo | null {
		this.triggers += 1;
		return { start: { line: cursor.line, ch: 0 }, end: cursor, query: "to" };
	}

	getSuggestions(context: EditorSuggestContext): string[] {
		return ["today", "tomorrow", "tonight", "yesterday"].filter((word) =>
			word.startsWith(context.query),
		);
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.textContent = value;
	}

	/** Reads `context` as a real suggester does, then closes, as many do. */
	selectSuggestion(value: string): void {
		this.chosen.push({ value, query: this.context?.query });
		this.close();
	}
}

/** Registers a fresh suggester from every `onload`, the way a feature naturally would. */
class Suggesting extends Feature {
	readonly id = "suggesting";
	readonly name = "Suggesting";
	readonly description = "Offers words as you type.";
	/** Every suggester this feature has made, oldest first. */
	readonly suggesters: WordSuggester[] = [];

	readiness(): Readiness {
		return { state: "ready" };
	}

	override onload(): void {
		const suggester = new WordSuggester(this.host.app as unknown as App);
		this.suggesters.push(suggester);
		this.host.registerEditorSuggest(suggester as unknown as ObsidianEditorSuggest<string>);
	}

	/** The one it registered last. */
	own(): WordSuggester {
		return this.suggesters[this.suggesters.length - 1];
	}
}

/**
 * A suggester that records every time the core told it its popup was dismissed.
 *
 * `onDismissed` is the hook the core forwards Obsidian's own `close()` to; a suggester that
 * does not declare it is left alone.
 */
class DismissibleSuggester extends WordSuggester {
	dismissals = 0;

	onDismissed(): void {
		this.dismissals += 1;
	}
}

/** Registers a suggester that can hear a dismissal, fresh from every `onload`. */
class Dismissible extends Suggesting {
	override onload(): void {
		const suggester = new DismissibleSuggester(this.host.app as unknown as App);
		this.suggesters.push(suggester);
		this.host.registerEditorSuggest(suggester as unknown as ObsidianEditorSuggest<string>);
	}

	override own(): DismissibleSuggester {
		return this.suggesters[this.suggesters.length - 1] as DismissibleSuggester;
	}
}

/**
 * A suggester whose own `close()` and `setInstructions()` do something of their
 * own and then hand on to Obsidian's, the way a feature that clears a timer on
 * close would write them. Each records every call, so a test can tell an
 * override the core kept from one it replaced.
 */
class OverridingSuggester extends WordSuggester {
	closes = 0;
	readonly instructed: Array<{ command: string; purpose: string }[]> = [];

	override close(): void {
		this.closes += 1;
		super.close();
	}

	override setInstructions(instructions: { command: string; purpose: string }[]): void {
		this.instructed.push(instructions);
		super.setInstructions(instructions);
	}
}

/** Registers a suggester with its own `close()` and `setInstructions()`, fresh from every `onload`. */
class Overriding extends Suggesting {
	override onload(): void {
		const suggester = new OverridingSuggester(this.host.app as unknown as App);
		this.suggesters.push(suggester);
		this.host.registerEditorSuggest(suggester as unknown as ObsidianEditorSuggest<string>);
	}

	override own(): OverridingSuggester {
		return this.suggesters[this.suggesters.length - 1] as OverridingSuggester;
	}
}

/**
 * Keeps two suggesters with overrides and registers them in turn, one per
 * `onload`, so the second switch-on hands the core back one it has held before.
 */
class TakingTurns extends Feature {
	readonly id = "taking-turns";
	readonly name = "Taking turns";
	readonly description = "Offers words as you type, from two suggesters in turn.";
	readonly pair: [OverridingSuggester, OverridingSuggester];
	private loads = 0;

	constructor(host: FeatureHost) {
		super(host);
		const app = host.app as unknown as App;
		this.pair = [new OverridingSuggester(app), new OverridingSuggester(app)];
	}

	readiness(): Readiness {
		return { state: "ready" };
	}

	override onload(): void {
		const suggester = this.pair[this.loads % 2];
		this.loads += 1;
		this.host.registerEditorSuggest(suggester as unknown as ObsidianEditorSuggest<string>);
	}
}

/** Registers its suggester in its constructor, the mistake #234 refused for commands. */
class PrematureSuggester extends Feature {
	readonly id = "premature-suggester";
	readonly name = "Premature suggester";
	readonly description = "Registers a suggester while it is being built.";

	constructor(host: FeatureHost) {
		super(host);
		host.registerEditorSuggest(
			new WordSuggester(host.app as unknown as App) as unknown as ObsidianEditorSuggest<string>,
		);
	}

	readiness(): Readiness {
		return { state: "ready" };
	}
}

/** Registers a suggester from `onload`, then throws. */
class SuggestsThenThrows extends Suggesting {
	override onload(): void {
		super.onload();
		throw new Error("could not finish starting");
	}
}

/** An editor with its cursor on line 0, column 2. */
const editor: StubEditor = { getCursor: () => ({ line: 0, ch: 2 }) };

describe("a feature's editor suggester", () => {
	beforeEach(() => {
		Notice.messages = [];
	});

	it("refuses one registered while the feature is being built", async () => {
		// `addCommand`'s rule and reason: `register` constructs every
		// feature, including one that is off and one whose factory then throws,
		// and Obsidian can never let go of a suggester once it has one.
		const { plugin, registry } = await build();

		expect(() =>
			registry.register("premature-suggester", (host) => new PrematureSuggester(host)),
		).not.toThrow();

		expect(registry.statuses()).toHaveLength(0);
		expect(plugin.editorSuggests).toHaveLength(0);
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("premature-suggester");
		expect(Notice.messages[0]).toContain("editor suggester");
		expect(Notice.messages[0]).toContain("onload()");
		expect(Notice.messages[0]).toContain("src/core/feature.ts");
	});

	it("answers a trigger as the feature's own suggester does while the feature runs", async () => {
		const { plugin, registry } = await build();
		let feature: Suggesting | undefined;
		registry.register("suggesting", (host) => (feature = new Suggesting(host)));
		registry.start();
		const own = feature!.own();
		const [registered] = plugin.editorSuggests;
		const cursor = { line: 0, ch: 2 };

		// Obsidian runs the core's suggester, never the feature's.
		expect(registered).not.toBe(own);
		expect(registered.onTrigger(cursor, editor, null)).toEqual(own.onTrigger(cursor, editor, null));

		expect(registered.trigger(editor, null, true)).toBe(true);
		expect(registered.isOpen).toBe(true);
		expect(registered.shown).toEqual(["today", "tomorrow", "tonight"]);

		// The feature's limit is the one that cuts the list.
		own.limit = 2;
		registered.trigger(editor, null, false);
		expect(registered.shown).toEqual(["today", "tomorrow"]);

		// Its `selectSuggestion` reads the popup's context, and its `close()`
		// closes the popup it cannot otherwise reach.
		registered.selectSuggestion("today", new KeyboardEvent("keydown"));
		expect(own.chosen).toEqual([{ value: "today", query: "to" }]);
		expect(registered.isOpen).toBe(false);
	});

	it("declines every trigger once the feature is switched off, and closes an open popup", async () => {
		const { plugin, registry } = await build();
		let feature: Suggesting | undefined;
		registry.register("suggesting", (host) => (feature = new Suggesting(host)));
		registry.start();
		const own = feature!.own();
		const [registered] = plugin.editorSuggests;
		registered.trigger(editor, null, true);
		expect(registered.isOpen).toBe(true);
		const asked = own.triggers;

		await registry.setEnabled("suggesting", false);

		expect(registered.isOpen).toBe(false);
		expect(registered.context).toBeNull();
		expect(registered.trigger(editor, null, true)).toBe(false);
		expect(registered.onTrigger({ line: 0, ch: 2 }, editor, null)).toBeNull();
		expect(registered.isOpen).toBe(false);
		// Declined by the core: the feature's suggester was not even asked.
		expect(own.triggers).toBe(asked);
	});

	it("leaves exactly one suggester with the plugin after switching off and on three times", async () => {
		const { plugin, registry } = await build();
		let feature: Suggesting | undefined;
		registry.register("suggesting", (host) => (feature = new Suggesting(host)));
		registry.start();

		for (let round = 0; round < 3; round += 1) {
			await registry.setEnabled("suggesting", false);
			await registry.setEnabled("suggesting", true);
		}

		// Four `onload`s, four suggesters made, one registered with Obsidian.
		expect(feature!.suggesters).toHaveLength(4);
		expect(plugin.editorSuggests).toHaveLength(1);
		// And that one forwards to the suggester made last, and to no other.
		const [registered] = plugin.editorSuggests;
		expect(registered.trigger(editor, null, true)).toBe(true);
		expect(feature!.suggesters.map((each) => each.triggers)).toEqual([0, 0, 0, 1]);
	});

	it("declines for a feature whose onload registered one and then threw", async () => {
		const { plugin, registry } = await build();
		registry.register("suggesting", (host) => new SuggestsThenThrows(host));
		registry.start();

		expect(registry.statuses()[0].state).toBe("failed");
		expect(plugin.editorSuggests).toHaveLength(1);
		expect(plugin.editorSuggests[0].trigger(editor, null, true)).toBe(false);
	});

	it("registers nothing with the plugin for a feature that registers no suggester", async () => {
		const { plugin, registry } = await build();
		registry.register("cycler", (host) => new Simple(host, "cycler"));
		registry.start();
		await registry.setEnabled("cycler", false);
		await registry.setEnabled("cycler", true);

		expect(plugin.editorSuggests).toEqual([]);
	});

	it("reaches no internal Obsidian API to do it", () => {
		// Rejected in the spec: splicing a suggester out of
		// `app.workspace.editorSuggest` behind a cast. Read comment-free, so the
		// doc comments that name what was rejected do not trip it.
		const core = shippedSources().filter(({ path }) => /core[\\/](registry|feature)\.ts$/.test(path));
		expect(core).toHaveLength(2);
		for (const { source } of core) {
			const code = withoutComments(source);
			expect(code).not.toMatch(/workspace\s*\.\s*editorSuggest/);
			expect(code).not.toMatch(/\bas\s+(unknown|any)\b/);
		}
	});

	/*
	 * Issue #603. Obsidian
	 * gives one `close()` for every kind of dismissal, and since this ticket it
	 * goes to the core's own suggester, never the feature's — so a feature had
	 * no way to learn that the person pressed Escape or clicked away. Spec
	 * #573 decision 4 needs
	 * exactly that, to keep one trigger silent until it is deleted or another is
	 * typed. The forward below is the one route, and what it must *not* fire for
	 * is as much of the rule as what it must: a switch-off is the plugin closing
	 * the popup, not the person dismissing it.
	 */
	it("tells the feature's suggester when Obsidian closes its popup", async () => {
		const { plugin, registry } = await build();
		let feature: Dismissible | undefined;
		registry.register("suggesting", (host) => (feature = new Dismissible(host)));
		registry.start();
		const own = feature!.own();
		const [registered] = plugin.editorSuggests;

		registered.trigger(editor, null, true);
		expect(registered.isOpen).toBe(true);

		// Escape, or a click outside: Obsidian closes the popup it owns.
		registered.close();

		expect(own.dismissals).toBe(1);
		expect(registered.isOpen).toBe(false);
	});

	it("says nothing to the feature when it closes the popup itself after a choice", async () => {
		const { plugin, registry } = await build();
		let feature: Dismissible | undefined;
		registry.register("suggesting", (host) => (feature = new Dismissible(host)));
		registry.start();
		const own = feature!.own();
		const [registered] = plugin.editorSuggests;

		registered.trigger(editor, null, true);
		// `WordSuggester.selectSuggestion` ends with `this.close()`, which `aim`
		// pointed at the popup: the feature closing its own popup is not the
		// person dismissing it.
		registered.selectSuggestion("today", new KeyboardEvent("keydown"));

		expect(own.chosen).toHaveLength(1);
		expect(own.dismissals).toBe(0);
		expect(registered.isOpen).toBe(false);
	});

	it("says nothing to the feature when the core closes the popup at a switch-off", async () => {
		const { plugin, registry } = await build();
		let feature: Dismissible | undefined;
		registry.register("suggesting", (host) => (feature = new Dismissible(host)));
		registry.start();
		const own = feature!.own();
		const [registered] = plugin.editorSuggests;

		registered.trigger(editor, null, true);
		expect(registered.isOpen).toBe(true);

		await registry.setEnabled("suggesting", false);

		expect(registered.isOpen).toBe(false);
		expect(own.dismissals).toBe(0);
	});

	it("leaves a suggester that declares no dismissal hook alone", async () => {
		const { plugin, registry } = await build();
		registry.register("suggesting", (host) => new Suggesting(host));
		registry.start();
		const [registered] = plugin.editorSuggests;

		registered.trigger(editor, null, true);

		expect(() => registered.close()).not.toThrow();
		expect(registered.isOpen).toBe(false);
	});
});

/*
 * Issue #599. Obsidian runs
 * the core's suggester, so the core points a feature suggester's `close()` and
 * `setInstructions()` at the popup — and it used to do that by writing its own
 * functions over them, which threw away any override the feature's class
 * declared. A feature that clears a timer in `close()` lost that cleanup on
 * every close. What is watched here is Obsidian's own `close()` and
 * `setInstructions()`, the ones every override hands on to, and *which object*
 * each ran on: the popup must still close once, and a feature's own suggester,
 * which has no popup, is left alone unless it declared an override.
 */
describe("a feature suggester's own close() and setInstructions()", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** Every run of Obsidian's own `method` from here on, as the arguments of each, on one object. */
	function watch(method: "close" | "setInstructions"): (on: object) => unknown[][] {
		const spy = vi.spyOn(EditorSuggest.prototype, method);
		return (on) => spy.mock.calls.filter((_, call) => spy.mock.contexts[call] === on);
	}

	async function overriding(): Promise<{
		registry: FeatureRegistry;
		feature: Overriding;
		registered: EditorSuggest<unknown>;
	}> {
		const { plugin, registry } = await build();
		let feature: Overriding | undefined;
		registry.register("suggesting", (host) => (feature = new Overriding(host)));
		registry.start();
		return { registry, feature: feature!, registered: plugin.editorSuggests[0] };
	}

	it("runs the feature's own close() when Obsidian closes the popup, and closes the popup once", async () => {
		const { feature, registered } = await overriding();
		const own = feature.own();
		registered.trigger(editor, null, true);
		const closed = watch("close");

		// Escape, or a click outside: Obsidian closes the popup it owns.
		registered.close();

		expect(own.closes).toBe(1);
		expect(registered.isOpen).toBe(false);
		expect(closed(registered)).toHaveLength(1);
	});

	it("runs the feature's own close() when a choice closes the popup, and closes the popup once", async () => {
		const { feature, registered } = await overriding();
		const own = feature.own();
		registered.trigger(editor, null, true);
		const closed = watch("close");

		// `WordSuggester.selectSuggestion` ends with `this.close()`, which reaches
		// the override, whose `super.close()` then runs on the feature's own
		// suggester — a popup that was never open, so it must not count.
		registered.selectSuggestion("today", new KeyboardEvent("keydown"));

		expect(own.chosen).toHaveLength(1);
		expect(own.closes).toBe(1);
		expect(registered.isOpen).toBe(false);
		expect(closed(registered)).toHaveLength(1);
	});

	it("runs the feature's own close() when switching the feature off closes the popup", async () => {
		const { registry, feature, registered } = await overriding();
		const own = feature.own();
		registered.trigger(editor, null, true);
		const closed = watch("close");

		await registry.setEnabled("suggesting", false);

		expect(own.closes).toBe(1);
		expect(registered.isOpen).toBe(false);
		expect(closed(registered)).toHaveLength(1);
	});

	it("runs the feature's own setInstructions() and gives the popup the same instructions once", async () => {
		const { feature, registered } = await overriding();
		const own = feature.own();
		const instructed = watch("setInstructions");
		const instructions = [{ command: "↵", purpose: "to choose" }];

		own.setInstructions(instructions);

		expect(own.instructed).toEqual([instructions]);
		expect(instructed(registered)).toEqual([[instructions]]);
	});

	it("runs only the newest suggester's close() once a switch-on has replaced the old one", async () => {
		const { registry, feature, registered } = await overriding();
		const first = feature.own();
		await registry.setEnabled("suggesting", false);
		await registry.setEnabled("suggesting", true);
		const second = feature.own();
		expect(second).not.toBe(first);
		const told = first.closes;

		registered.trigger(editor, null, true);
		registered.close();

		expect(first.closes).toBe(told);
		expect(second.closes).toBe(1);
	});

	it("runs a suggester's close() once, not in a loop, when the core is handed it back after another", async () => {
		const { plugin, registry } = await build();
		let feature: TakingTurns | undefined;
		registry.register("taking-turns", (host) => (feature = new TakingTurns(host)));
		registry.start();
		// Aimed at the first, then the second, then the first again.
		for (let round = 0; round < 2; round += 1) {
			await registry.setEnabled("taking-turns", false);
			await registry.setEnabled("taking-turns", true);
		}
		const [first, second] = feature!.pair;
		const [registered] = plugin.editorSuggests;
		const told = [first.closes, second.closes];
		registered.trigger(editor, null, true);
		const closed = watch("close");

		registered.selectSuggestion("today", new KeyboardEvent("keydown"));

		expect(first.chosen).toHaveLength(1);
		expect([first.closes, second.closes]).toEqual([told[0] + 1, told[1]]);
		expect(closed(registered)).toHaveLength(1);
	});

	it("leaves a suggester that overrides neither exactly as it was", async () => {
		// Watched from before the core first sees the suggester, so a core that
		// kept Obsidian's own methods as if they were overrides is caught calling them.
		const closed = watch("close");
		const instructed = watch("setInstructions");
		const { plugin, registry } = await build();
		let feature: Suggesting | undefined;
		registry.register("suggesting", (host) => (feature = new Suggesting(host)));
		registry.start();
		const own = feature!.own();
		const [registered] = plugin.editorSuggests;
		const closedBefore = closed(registered).length;

		registered.trigger(editor, null, true);
		registered.selectSuggestion("today", new KeyboardEvent("keydown"));
		registered.trigger(editor, null, true);
		registered.close();
		own.setInstructions([{ command: "↵", purpose: "to choose" }]);
		registered.trigger(editor, null, true);
		await registry.setEnabled("suggesting", false);

		// A choice, Escape and a switch-off each closed the popup once, and the
		// instructions reached it once; Obsidian's own methods never ran on the
		// feature's suggester, just as before overrides were kept.
		expect(closed(registered).length - closedBefore).toBe(3);
		expect(instructed(registered)).toHaveLength(1);
		expect(closed(own)).toHaveLength(0);
		expect(instructed(own)).toHaveLength(0);
		expect(registered.isOpen).toBe(false);
	});
});

/**
 * A suggester that counts every Tab that reached a binding of its own. `bindTab`
 * registers that binding on whatever `scope` the suggester holds at the time.
 */
class TabSuggester extends WordSuggester {
	tabs = 0;

	bindTab(): void {
		this.scope.register([], "Tab", () => {
			this.tabs += 1;
			return false;
		});
	}
}

/** Binds Tab in its constructor, as Obsidian's own suggesters do. */
class EarlyTabSuggester extends TabSuggester {
	constructor(app: App) {
		super(app);
		this.bindTab();
	}
}

/**
 * Keeps two suggesters and registers them in turn, one per `onload`, binding
 * Tab on each right after handing it over — once per suggester, the first time,
 * so a Tab counted twice is the core's doing and not the feature's.
 */
class BindingTurns extends Feature {
	readonly id = "binding-turns";
	readonly name = "Binding turns";
	readonly description = "Offers words as you type, and takes Tab, from two suggesters in turn.";
	readonly pair: [TabSuggester, TabSuggester];
	private loads = 0;

	constructor(host: FeatureHost) {
		super(host);
		const app = host.app as unknown as App;
		this.pair = [new TabSuggester(app), new TabSuggester(app)];
	}

	readiness(): Readiness {
		return { state: "ready" };
	}

	override onload(): void {
		const suggester = this.pair[this.loads % 2];
		this.host.registerEditorSuggest(suggester as unknown as ObsidianEditorSuggest<string>);
		if (this.loads < 2) suggester.bindTab();
		this.loads += 1;
	}

	/** The one it registered last. */
	own(): TabSuggester {
		return this.pair[(this.loads - 1) % 2];
	}
}

/** Registers a fresh suggester from every `onload` and binds Tab on it after handing it over. */
class Binding extends Suggesting {
	override onload(): void {
		const suggester = new TabSuggester(this.host.app as unknown as App);
		this.suggesters.push(suggester);
		this.host.registerEditorSuggest(suggester as unknown as ObsidianEditorSuggest<string>);
		suggester.bindTab();
	}

	override own(): TabSuggester {
		return this.suggesters[this.suggesters.length - 1] as TabSuggester;
	}
}

/** Registers a fresh suggester from every `onload` that bound Tab in its constructor. */
class BindingEarly extends Suggesting {
	override onload(): void {
		const suggester = new EarlyTabSuggester(this.host.app as unknown as App);
		this.suggesters.push(suggester);
		this.host.registerEditorSuggest(suggester as unknown as ObsidianEditorSuggest<string>);
	}

	override own(): EarlyTabSuggester {
		return this.suggesters[this.suggesters.length - 1] as EarlyTabSuggester;
	}
}

/*
 * Issue #598. Obsidian asks
 * the keys of the suggester whose popup is open, which is the core's, so a key
 * binding a feature registered on its own suggester's `scope` was never asked.
 * The author decided on 2026-09-17 to stay inside Obsidian's published interface:
 * the core hands the feature's suggester a scope whose parent is the popup's
 * own, and makes that scope the popup's while the core forwards to it. A binding
 * registered on it from then on answers first; the popup's navigation keys are
 * found beneath it. A binding registered in the suggester's constructor was
 * made on a scope the core replaces, and stays dead — pinned below, and said in
 * the host doc. The stub's `Scope`, `Keymap` and popup keys are written from
 * Obsidian 1.13.7's own code for this reason: a stub without them could not
 * tell a key the feature took from one that reached nothing.
 */
describe("a feature suggester's own key bindings", () => {
	async function binding<F extends Feature & { own(): TabSuggester }>(
		make: (host: FeatureHost) => F,
		id = "suggesting",
	): Promise<{ plugin: Plugin; registry: FeatureRegistry; feature: F; registered: EditorSuggest<unknown> }> {
		const { plugin, registry } = await build();
		let feature: F | undefined;
		registry.register(id, (host) => (feature = make(host)));
		registry.start();
		return { plugin, registry, feature: feature!, registered: plugin.editorSuggests[0] };
	}

	it("answers a Tab the feature bound on its suggester's scope after handing the suggester over", async () => {
		const { plugin, feature, registered } = await binding((host) => new Binding(host));
		const own = feature.own();
		registered.trigger(editor, null, true);
		expect(registered.isOpen).toBe(true);

		expect(plugin.app.keymap.press("Tab")).toBe(false);

		expect(own.tabs).toBe(1);
	});

	it("keeps ArrowDown and Enter on the popup's list, not the feature's", async () => {
		const { plugin, feature, registered } = await binding((host) => new Binding(host));
		const own = feature.own();
		registered.trigger(editor, null, true);
		expect(registered.shown).toEqual(["today", "tomorrow", "tonight"]);

		plugin.app.keymap.press("ArrowDown");

		expect(registered.selected).toBe(1);
		expect(own.selected).toBe(0);

		plugin.app.keymap.press("Enter");

		// The popup's list chose its highlighted row, through the feature's
		// `selectSuggestion`, which then closed the popup.
		expect(own.chosen).toEqual([{ value: "tomorrow", query: "to" }]);
		expect(registered.isOpen).toBe(false);
		expect(own.tabs).toBe(0);
	});

	it("reaches no binding of the feature's once the popup has closed", async () => {
		const { plugin, feature, registered } = await binding((host) => new Binding(host));
		const own = feature.own();
		registered.trigger(editor, null, true);
		registered.close();

		expect(plugin.app.keymap.press("Tab")).toBeUndefined();

		expect(own.tabs).toBe(0);
	});

	it("neither duplicates nor drops the binding when the feature is switched off and on three times", async () => {
		const { plugin, registry, feature, registered } = await binding((host) => new Binding(host));

		for (let round = 0; round < 3; round += 1) {
			await registry.setEnabled("suggesting", false);
			await registry.setEnabled("suggesting", true);
			const own = feature.own();
			registered.trigger(editor, null, true);

			plugin.app.keymap.press("Tab");

			expect(own.tabs).toBe(1);
			registered.close();
		}
		expect(feature.suggesters).toHaveLength(4);
		expect(feature.suggesters.map((suggester) => (suggester as TabSuggester).tabs)).toEqual([0, 1, 1, 1]);
	});

	it("keeps the binding of a suggester the core is handed back after another, once", async () => {
		const { plugin, registry, feature, registered } = await binding(
			(host) => new BindingTurns(host),
			"binding-turns",
		);
		const [first, second] = feature.pair;

		// Aimed at the first, then the second, first, second: each handed back
		// once, and bound only the first time it was handed over.
		for (let round = 0; round < 3; round += 1) {
			await registry.setEnabled("binding-turns", false);
			await registry.setEnabled("binding-turns", true);
			const own = feature.own();
			const before = [first.tabs, second.tabs];
			registered.trigger(editor, null, true);

			plugin.app.keymap.press("Tab");

			expect([first.tabs, second.tabs]).toEqual(
				own === first ? [before[0] + 1, before[1]] : [before[0], before[1] + 1],
			);
			registered.close();
		}
	});

	it("does not answer a Tab bound in the suggester's constructor, before the core had it", async () => {
		// Pinned by the author's decision of 2026-09-17 on #598: the published
		// interface cannot put a scope that already exists under the popup's, so
		// a binding made before the handover stays dead, and the host doc says so.
		const { plugin, feature, registered } = await binding((host) => new BindingEarly(host));
		const own = feature.own();
		registered.trigger(editor, null, true);
		expect(registered.isOpen).toBe(true);

		plugin.app.keymap.press("Tab");

		expect(own.tabs).toBe(0);
	});
});

describe("the stub's registerEditorSuggest", () => {
	it("keeps every suggester until the plugin itself unloads, as Obsidian does", () => {
		// Obsidian 1.13.7 adds the suggester and registers its removal for the
		// plugin's unload, and offers no other way to take one back. A stub that
		// could drop one earlier would let a core that registers afresh on every
		// switch-on pass here while the real application stacked suggesters —
		// the way withdrawn commands stayed in Obsidian and passed every test.
		const plugin = new Plugin();
		plugin.load();
		const first = new WordSuggester(plugin.app);
		const second = new WordSuggester(plugin.app);

		plugin.registerEditorSuggest(first);
		plugin.registerEditorSuggest(second);
		first.close();

		expect(plugin.editorSuggests).toEqual([first, second]);

		plugin.unload();

		expect(plugin.editorSuggests).toEqual([]);
	});
});

/**
 * Draws every `schema` block it is handed, and records who drew it: each
 * `onload` registers a fresh handler, numbered by the load it came from, so a
 * test can tell which of them a block reached.
 */
class Rendering extends Feature {
	readonly id = "rendering";
	readonly name = "Rendering";
	readonly description = "Draws schema blocks.";
	readonly drawn: { load: number; source: string; el: HTMLElement; ctx: ObsidianPostProcessorContext }[] = [];
	private loads = 0;

	readiness(): Readiness {
		return { state: "ready" };
	}

	override onload(): void {
		this.loads += 1;
		const load = this.loads;
		this.host.registerMarkdownCodeBlockProcessor("schema", (source, el, ctx) => {
			this.drawn.push({ load, source, el, ctx });
			el.createDiv({ cls: "drawn", text: `drawn by load ${load}` });
		});
	}
}

/** Registers its renderer in its constructor, the mistake #234 refused for commands. */
class PrematureRenderer extends Feature {
	readonly id = "premature-renderer";
	readonly name = "Premature renderer";
	readonly description = "Registers a code-block renderer while it is being built.";

	constructor(host: FeatureHost) {
		super(host);
		host.registerMarkdownCodeBlockProcessor("schema", () => undefined);
	}

	readiness(): Readiness {
		return { state: "ready" };
	}
}

/** Registers its renderer, then fails to start. */
class RendersThenThrows extends Feature {
	readonly id = "rendering";
	readonly name = "Rendering";
	readonly description = "Registers a renderer and then throws.";
	reached = 0;

	readiness(): Readiness {
		return { state: "ready" };
	}

	override onload(): void {
		this.host.registerMarkdownCodeBlockProcessor("schema", () => {
			this.reached += 1;
		});
		throw new Error("could not start");
	}
}

const SOURCE = "| Time | Event |\n| --- | --- |\n| 09:00-09:30 | Standup |";
const context = { docId: "doc-1", sourcePath: "Notes/Sample.md", frontmatter: null };

/** A note open in a tab, holding `text`, in the given mode. */
function openNote(plugin: Plugin, path: string, text: string, mode: "preview" | "source"): WorkspaceLeaf {
	const leaf = new WorkspaceLeaf(new MarkdownView({ path }, text, mode));
	plugin.app.workspace.leaves.push(leaf);
	return leaf;
}

/** Lets the redraw the core started without waiting for it run to its end. */
async function settled(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

/*
 * Issue #622. A feature
 * that draws a fenced code block — the day view draws `schema` — has no
 * `Plugin` to register a renderer with, so the host does it for the feature.
 *
 * The ticket asked for the renderer to be **withdrawn** at a switch-off, so the
 * old day-view plugin could take `schema` back. The drive proved Obsidian
 * 1.13.7 cannot do that through its published interface: a registration claims
 * the language in a second list that only the plugin's own unload clears, and
 * a second claim throws
 * (`docs/acceptance-shots/issue-622-withdrawal-does-not-free-the-language.txt`).
 * So this is the fallback the ticket named: the core registers one renderer per
 * feature and language, keeps it, and forwards to the feature's handler only
 * while the feature runs. The stub keeps both of Obsidian's lists for the same
 * reason #574's stub keeps every suggester.
 */
describe("a feature's code-block renderer", () => {
	beforeEach(() => {
		Notice.messages = [];
		MarkdownPreviewRenderer.reset();
	});

	it("refuses one registered while the feature is being built", async () => {
		const { registry } = await build();

		expect(() =>
			registry.register("premature-renderer", (host) => new PrematureRenderer(host)),
		).not.toThrow();

		expect(registry.statuses()).toHaveLength(0);
		expect(MarkdownPreviewRenderer.postProcessors).toHaveLength(0);
		expect(MarkdownPreviewRenderer.codeBlockPostProcessors).toEqual({});
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("premature-renderer");
		expect(Notice.messages[0]).toContain("code-block renderer");
		expect(Notice.messages[0]).toContain("onload()");
		expect(Notice.messages[0]).toContain("src/core/feature.ts");
	});

	it("hands a block to the feature's handler with its source, element and context while the feature runs", async () => {
		const { registry } = await build();
		let feature: Rendering | undefined;
		registry.register("rendering", (host) => (feature = new Rendering(host)));
		registry.start();

		const reading = MarkdownPreviewRenderer.renderReading("schema", SOURCE, context);
		const live = MarkdownPreviewRenderer.renderLivePreview("schema", SOURCE, context);

		expect(feature!.drawn).toHaveLength(2);
		const [inReading, inLive] = feature!.drawn;
		expect(inReading.source).toBe(SOURCE);
		expect(inReading.ctx).toBe(context);
		expect(inReading.el).toBe(reading.querySelector(".block-language-schema"));
		expect(reading.querySelector(".drawn")?.textContent).toBe("drawn by load 1");
		expect(inLive.source).toBe(SOURCE);
		expect(inLive.ctx).toBe(context);
		expect(inLive.el).toBe(live);
		expect(live?.querySelector(".drawn")?.textContent).toBe("drawn by load 1");
	});

	it("reaches no handler once the feature is switched off, and draws the block as a plain code block in both modes", async () => {
		const { registry } = await build();
		let feature: Rendering | undefined;
		registry.register("rendering", (host) => (feature = new Rendering(host)));
		registry.start();

		await registry.setEnabled("rendering", false);
		const reading = MarkdownPreviewRenderer.renderReading("schema", SOURCE, context);
		const live = MarkdownPreviewRenderer.renderLivePreview("schema", SOURCE, context);

		expect(feature!.drawn).toHaveLength(0);
		for (const drawn of [reading, live]) {
			expect(drawn?.querySelector(".drawn")).toBeNull();
			expect(drawn?.querySelector("pre > code")?.textContent).toBe(SOURCE);
		}
	});

	it("keeps exactly one renderer for the language after switching off and on three times, forwarding to the newest handler", async () => {
		const { registry } = await build();
		let feature: Rendering | undefined;
		registry.register("rendering", (host) => (feature = new Rendering(host)));
		registry.start();

		for (let round = 0; round < 3; round += 1) {
			await registry.setEnabled("rendering", false);
			await registry.setEnabled("rendering", true);
		}

		expect(Object.keys(MarkdownPreviewRenderer.codeBlockPostProcessors)).toEqual(["schema"]);
		expect(MarkdownPreviewRenderer.postProcessors).toHaveLength(1);
		expect(Notice.messages).toEqual([]);
		MarkdownPreviewRenderer.renderReading("schema", SOURCE, context);
		MarkdownPreviewRenderer.renderLivePreview("schema", SOURCE, context);
		expect(feature!.drawn.map((each) => each.load)).toEqual([4, 4]);
	});

	it("draws plainly for a feature whose onload registered a renderer and then threw", async () => {
		const { registry } = await build();
		let feature: RendersThenThrows | undefined;
		registry.register("rendering", (host) => (feature = new RendersThenThrows(host)));
		registry.start();

		expect(registry.statuses()[0].state).toBe("failed");
		const live = MarkdownPreviewRenderer.renderLivePreview("schema", SOURCE, context);
		expect(feature!.reached).toBe(0);
		expect(live?.querySelector("pre > code")?.textContent).toBe(SOURCE);
	});

	it("fails to start, saying why, when another plugin already holds the language", async () => {
		const other = new Plugin();
		other.load();
		other.registerMarkdownCodeBlockProcessor("schema", () => undefined);
		const { registry } = await build();
		registry.register("rendering", (host) => new Rendering(host));

		registry.start();

		expect(registry.statuses()[0]).toMatchObject({
			state: "failed",
			detail: "Code block postprocessor for language schema is already registered",
		});
	});

	it("redraws every open note holding a block of the language, in each mode, at each switch — saving it first", async () => {
		const { plugin, registry } = await build();
		const reading = openNote(plugin, "Notes/Reading.md", `# A\n\n\`\`\`schema\n${SOURCE}\n\`\`\`\n`, "preview");
		const live = openNote(plugin, "Notes/Live.md", `# B\n\n~~~ schema\n${SOURCE}\n~~~\n`, "source");
		const unrelated = openNote(plugin, "Notes/Other.md", "# C\n\n```schemata\nnot this one\n```\n", "source");
		registry.register("rendering", (host) => new Rendering(host));
		registry.start();
		await settled();
		for (const leaf of [reading, live, unrelated]) leaf.events.length = 0;

		await registry.setEnabled("rendering", false);
		await settled();

		expect(reading.events).toEqual(["save", "view:empty", "view:markdown"]);
		expect(live.events).toEqual(["save", "view:empty", "view:markdown"]);
		expect(unrelated.events).toEqual([]);
		// Each tab comes back in the mode it was in, on the same note.
		expect(reading.getViewState()).toEqual({ type: "markdown", state: { file: "Notes/Reading.md", mode: "preview" } });
		expect(live.getViewState()).toEqual({ type: "markdown", state: { file: "Notes/Live.md", mode: "source" } });

		reading.events.length = 0;
		await registry.setEnabled("rendering", true);
		await settled();

		expect(reading.events).toEqual(["save", "view:empty", "view:markdown"]);
		expect(unrelated.events).toEqual([]);
	});

	it("ends on the note, not empty, when a redraw reaches a tab before an earlier one has swapped it back", async () => {
		const { plugin, registry } = await build();
		const leaf = openNote(plugin, "Notes/Reading.md", `# A\n\n\`\`\`schema\n${SOURCE}\n\`\`\`\n`, "preview");
		registry.register("rendering", (host) => new Rendering(host));
		registry.start();
		await settled();
		leaf.events.length = 0;

		// The tab's first redraw is stuck saving when the second one, from
		// switching the feature straight back on, reaches the same tab.
		const view = leaf.view as MarkdownView;
		let releaseSave: (() => void) | undefined;
		view.saveGate = new Promise((resolve) => {
			releaseSave = resolve;
		});

		const off = registry.setEnabled("rendering", false);
		const on = registry.setEnabled("rendering", true);
		await settled();
		releaseSave!();
		await Promise.all([off, on]);
		await settled();
		await settled();

		expect(leaf.view.getViewType()).toBe("markdown");
		expect((leaf.view as MarkdownView).file.path).toBe("Notes/Reading.md");
	});

	it("registers nothing and redraws nothing for a feature that registers no renderer", async () => {
		const { plugin, registry } = await build();
		const leaf = openNote(plugin, "Notes/Reading.md", `\`\`\`schema\n${SOURCE}\n\`\`\`\n`, "preview");
		registry.register("cycler", (host) => new Simple(host, "cycler"));
		registry.start();
		await registry.setEnabled("cycler", false);
		await registry.setEnabled("cycler", true);
		await settled();

		expect(MarkdownPreviewRenderer.postProcessors).toEqual([]);
		expect(MarkdownPreviewRenderer.codeBlockPostProcessors).toEqual({});
		expect(leaf.events).toEqual([]);
	});

	it("reaches no internal Obsidian API to do it", () => {
		// The language list live preview reads, its unregister, a view's rebuild
		// and Obsidian's own redraw event are all unpublished in obsidian.d.ts
		// 1.13.1. Read comment-free, so the doc comments that name them as what
		// was not used do not trip it.
		const core = shippedSources().filter(({ path }) => /core[\\/](registry|feature)\.ts$/.test(path));
		expect(core).toHaveLength(2);
		for (const { source } of core) {
			const code = withoutComments(source);
			expect(code).not.toMatch(/codeBlockPostProcessors|CodeBlockPostProcessor\s*\(/);
			expect(code).not.toMatch(/rebuildView|post-processor-change/);
			expect(code).not.toMatch(/\bas\s+(unknown|any)\b/);
		}
	});
});

describe("the stub's registerMarkdownCodeBlockProcessor", () => {
	beforeEach(() => {
		MarkdownPreviewRenderer.reset();
	});

	it("keeps the language held after the processor it handed back is unregistered, as Obsidian 1.13.7 does", () => {
		// Obsidian's registration writes two lists and hands back the entry in
		// one; the published `unregisterPostProcessor` clears only that one, and
		// a second claim on the language throws. A stub whose unregister freed the
		// language would let a withdrawing core pass here while the real
		// application refused the old day-view plugin (#551's shape).
		const first = new Plugin();
		first.load();
		const processor = first.registerMarkdownCodeBlockProcessor("schema", () => undefined);

		MarkdownPreviewRenderer.unregisterPostProcessor(processor);

		expect(MarkdownPreviewRenderer.postProcessors).toEqual([]);
		expect(Object.keys(MarkdownPreviewRenderer.codeBlockPostProcessors)).toEqual(["schema"]);
		const second = new Plugin();
		second.load();
		expect(() => second.registerMarkdownCodeBlockProcessor("schema", () => undefined)).toThrow(
			"Code block postprocessor for language schema is already registered",
		);

		first.unload();

		expect(MarkdownPreviewRenderer.codeBlockPostProcessors).toEqual({});
		expect(() => second.registerMarkdownCodeBlockProcessor("schema", () => undefined)).not.toThrow();
	});
});

/*
 * Issue #591.
 * `registry.setEnabled` awaits the store's own write for the feature's switch
 * and only reaches `load`/`unload` if that write did not reject. A write
 * queues behind whatever is already open, and a *different* write queued
 * behind that one can go on to carry the same flip into the file even though
 * this call's own write rejected — the store leaves memory holding the flip
 * whenever something else is going to write it (`settings.ts`, `queueWrite`).
 * So the stored answer, the switch and the badge all end up agreeing on the
 * new value while the feature itself was never loaded or unloaded to match,
 * until the next reload. `settings.test.ts:751` covers the store's own
 * contract for a rejected `setEnabled`; nothing there or here paired that
 * with a second write behind it before this ticket.
 */
describe("bringing a feature's loaded state into line once a rejected switch settles", () => {
	/**
	 * A plugin whose writes finish only when the test says so, so a test can
	 * hold one write open while a second queues behind it and choose which of
	 * the two lands. The same shape as `settings.test.ts`'s `HeldPlugin` —
	 * this ticket's bug only shows with two writes open at once, which the
	 * registry's other tests never needed.
	 */
	class HeldPlugin extends Plugin {
		/** Every write that has begun and not yet been let finish, in order. */
		readonly inFlight: Array<{ finish: () => void; fail: (why: Error) => void }> = [];

		override saveData(data: unknown): Promise<void> {
			const frozen: unknown = JSON.parse(JSON.stringify(data));
			const write = super.saveData.bind(this);
			return new Promise<void>((resolve, reject) => {
				this.inFlight.push({
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

	/**
	 * `build`, with the fresh-install languageHistory write `settings.load()`
	 * itself starts already finished and drained, so
	 * `plugin.inFlight` begins at this describe's own zero rather than
	 * holding that write open where every test here means index 0 to be its
	 * own first write. `flush` waits on the write's own promise chain, which
	 * this describe's `settleMicrotasks` — a real `setTimeout` — would also
	 * wait on correctly, but `flush` needs no macrotask to do it.
	 */
	async function buildFresh(plugin: HeldPlugin): ReturnType<typeof build> {
		const built = await build(plugin);
		plugin.inFlight[0]?.finish();
		await built.settings.flush();
		plugin.inFlight.length = 0;
		return built;
	}

	it("unloads a feature once the store settles to off, though the switch-off's own write was the one that rejected", async () => {
		const plugin = new HeldPlugin();
		const { settings, registry } = await buildFresh(plugin);
		let x: Simple | undefined;
		registry.register("x", (host) => (x = new Simple(host, "x")));
		registry.start();
		expect(x?.loads).toBe(1);

		// Another write is already open — a press elsewhere, in the ticket's
		// telling.
		const opened = settings.setEnabled("filler", true);
		await settleMicrotasks();
		expect(plugin.inFlight).toHaveLength(1);

		// The switch-off. Its own write queues behind the open one. Caught
		// immediately so a rejection here is never unhandled, whichever tick it
		// settles on.
		const offSettled = registry.setEnabled("x", false).then(
			() => ({ ok: true as const }),
			(error: unknown) => ({ ok: false as const, error }),
		);
		// A second write, queued behind the switch-off's own — the one that
		// goes on to carry the flip into the file once the switch-off's write
		// rejects.
		const carrier = settings.setEnabled("carrier", true);

		plugin.inFlight[0].finish();
		await settleMicrotasks();
		expect(plugin.inFlight).toHaveLength(2);

		plugin.inFlight[1].fail(new Error("the vault is read-only"));
		await settleMicrotasks();
		// Nothing was rolled back — another write was already queued behind the
		// refused one — so that write's own turn has come.
		expect(plugin.inFlight).toHaveLength(3);

		plugin.inFlight[2].finish();
		const outcome = await offSettled;
		await carrier;
		await opened;

		// The switch-off's own promise still tells its caller what went wrong.
		expect(outcome.ok).toBe(false);
		expect((outcome as { ok: false; error: Error }).error.message).toContain("read-only");
		// The stored answer settled to off, carried by the second write.
		expect(settings.isEnabled("x")).toBe(false);
		// And the feature actually stopped: its component detached and its
		// command withdrawn from the palette, not left running until a reload.
		expect(x?.unloads).toBe(1);
		expect(plugin.commands).toHaveLength(0);
	});

	it("loads a feature once the store settles to on, though the switch-on's own write was the one that rejected", async () => {
		const plugin = new HeldPlugin();
		plugin.seedData({ core: { enabled: { x: false } } });
		const { settings, registry } = await buildFresh(plugin);
		let x: Simple | undefined;
		registry.register("x", (host) => (x = new Simple(host, "x")));
		registry.start();
		expect(x?.loads).toBe(0);

		const opened = settings.setEnabled("filler", true);
		await settleMicrotasks();
		expect(plugin.inFlight).toHaveLength(1);

		const onSettled = registry.setEnabled("x", true).then(
			() => ({ ok: true as const }),
			(error: unknown) => ({ ok: false as const, error }),
		);
		const carrier = settings.setEnabled("carrier", true);

		plugin.inFlight[0].finish();
		await settleMicrotasks();
		expect(plugin.inFlight).toHaveLength(2);

		plugin.inFlight[1].fail(new Error("the vault is read-only"));
		await settleMicrotasks();
		expect(plugin.inFlight).toHaveLength(3);

		plugin.inFlight[2].finish();
		const outcome = await onSettled;
		await carrier;
		await opened;

		expect(outcome.ok).toBe(false);
		expect((outcome as { ok: false; error: Error }).error.message).toContain("read-only");
		expect(settings.isEnabled("x")).toBe(true);
		// Loaded to match the settled answer, though this call's own write to
		// get there rejected.
		expect(x?.loads).toBe(1);
		expect(plugin.commands.some((command) => command.id === "effortless:do-the-thing")).toBe(
			true,
		);
	});

	it("still rejects a switch-off whose own write is the only one queued, leaving the feature running behind the restored answer", async () => {
		// The ordinary case this ticket must leave unchanged: nothing queued
		// behind the refused write, so the store rolls memory back to what
		// landed rather than carrying the flip — and the feature,
		// never unloaded, still agrees with that restored answer.
		const plugin = new HeldPlugin();
		const { settings, registry } = await buildFresh(plugin);
		let x: Simple | undefined;
		registry.register("x", (host) => (x = new Simple(host, "x")));
		registry.start();
		expect(x?.loads).toBe(1);

		const offSettled = registry.setEnabled("x", false).then(
			() => ({ ok: true as const }),
			(error: unknown) => ({ ok: false as const, error }),
		);
		await settleMicrotasks();
		expect(plugin.inFlight).toHaveLength(1);

		plugin.inFlight[0].fail(new Error("the vault is read-only"));
		const outcome = await offSettled;

		expect(outcome.ok).toBe(false);
		expect(settings.isEnabled("x")).toBe(true);
		expect(x?.unloads).toBe(0);
		expect(x?.loads).toBe(1);
		expect(plugin.commands.some((command) => command.id === "effortless:do-the-thing")).toBe(
			true,
		);
	});

	it("does not retry a feature whose start already failed when a switch-off's own write is refused", async () => {
		// #604. A feature
		// that threw on the way up carries a recorded failure, and #174 settled
		// that nothing brings it back on its own: `recheckReadiness` skips such
		// an entry, and the person is told to switch it off and on. The reconcile
		// this ticket added reads only the stored answer, which after a refused
		// switch-off still says on — so it would call `load` a second time and
		// raise the same "did not start" notice for a failure already reported.
		const plugin = new HeldPlugin();
		const { settings, registry } = await buildFresh(plugin);
		let broken: Broken | undefined;
		registry.register("broken", (host) => (broken = new Broken(host)));
		registry.start();

		// One failed attempt, one notice about it.
		expect(broken?.attempts).toBe(1);
		expect(Notice.messages).toHaveLength(1);
		Notice.messages = [];

		const offSettled = registry.setEnabled("broken", false).then(
			() => ({ ok: true as const }),
			(error: unknown) => ({ ok: false as const, error }),
		);
		await settleMicrotasks();
		expect(plugin.inFlight).toHaveLength(1);

		plugin.inFlight[0].fail(new Error("the vault is read-only"));
		const outcome = await offSettled;

		expect(outcome.ok).toBe(false);
		// The stored answer went back to on, and the feature is left exactly as
		// the failure left it: not started again, and nothing said twice.
		expect(settings.isEnabled("broken")).toBe(true);
		expect(broken?.attempts).toBe(1);
		expect(Notice.messages).toHaveLength(0);
	});
});
