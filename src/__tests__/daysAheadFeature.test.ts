/**
 * Building the days ahead as a feature: what it declares, its one setting and
 * its readiness (spec #687
 * decisions 1, 2 and 3). This ticket, #697,
 * builds nothing yet — no calendar is read here, no day is created — so these
 * tests cover the row a person sees and the one setting they can change.
 *
 * **These tests drive the real feature registry, the real settings store and a
 * real `DeviceStore`**, over the Obsidian stub, because what they assert is
 * where the feature meets the core: the row the settings screen shows, and
 * what the device switch does to it — the same shape
 * `src/__tests__/dayView.test.ts` and `dayViewSettings.test.ts` use for the
 * day view.
 *
 * Every folder, filename and calendar column name here is invented.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin, TFile, Vault as ObsidianVault } from "obsidian";
import { Notice, Platform, Plugin, Vault, controlsUnder, resetSettings } from "./__mocks__/obsidian";
import type { TextComponent } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { Collections } from "../core/collections";
import { Feature } from "../core/feature";
import type { FeatureHost, Readiness } from "../core/feature";
import type { Meeting } from "../core/icsReader";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SAVE_AFTER_TYPING_MS, SettingsStore, defaultData } from "../core/settings";
import type { EffortlessData, VaultLayout } from "../core/settings";
import { EffortlessSettingTab } from "../core/settingsTab";
import * as daysAheadModule from "../features/daysAhead";
import { DaysAhead, FEATURE_ID } from "../features/daysAhead";
import { runWindow } from "../features/daysAhead/run";
import type { RunCalendar, RunProblems } from "../features/daysAhead/run";

/** A layout with the folder, filename and both column names all answered. */
const ANSWERED: Partial<VaultLayout> = {
	dailyLogFolder: "Journal",
	dailyLogFilename: "YYYY-MM-DD",
	calendarColumns: { time: "Start", event: "What" },
};

/** The settings file with `layout` laid over the shipped layout and `features` as given. */
function dataWith(layout: Partial<VaultLayout> = {}, features: Record<string, unknown> = {}): EffortlessData {
	const data = defaultData();
	return {
		...data,
		core: { ...data.core, layout: { ...data.core.layout, ...layout } },
		features: { [FEATURE_ID]: features },
	};
}

interface Started {
	readonly plugin: Plugin;
	readonly registry: FeatureRegistry;
	readonly device: DeviceStore;
	readonly feature: DaysAhead;
	/** The one channel a standing problem would go through, if this feature raised one. */
	readonly problems: Problems;
}

/**
 * The plugin loaded over `data`, the core's registry holding the feature
 * under its id, and the registry started, as `main.ts` starts it. `buildsTheDays`
 * is set on the device store before the registry starts, the way a person's
 * own earlier answer would already be there.
 */
async function startDaysAhead(data: EffortlessData = dataWith(), buildsTheDays = false): Promise<Started> {
	const plugin = new Plugin();
	plugin.seedData(data);
	plugin.load();
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const notes = new NoteWriter(new Vault() as unknown as ObsidianVault, {
		path: () => null,
		onChange: () => undefined,
	});
	const calendar: Calendar = { meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} };
	const collections: Collections = { all: () => [], at: () => null };
	const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
	device.save({ buildsTheDays });
	const problems = new Problems();
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections, problems, device },
		notes,
		calendar,
	);
	let feature: DaysAhead | undefined;
	registry.register(FEATURE_ID, (host: FeatureHost) => (feature = new DaysAhead(host)));
	registry.start();
	return { plugin, registry, device, feature: feature!, problems };
}

/** The id of the mobile-sensitive control feature below, distinct from any real feature's. */
const MOBILE_CONTROL_ID = "mobile-only-control";

/**
 * A control whose readiness genuinely depends on `Platform.isMobile` — the
 * fixture issue #711(b)
 * asks for. `days-ahead` itself reads no platform switch at all, so a sweep
 * that only ever starts `days-ahead` cannot tell "the switch reaches nothing"
 * from "the switch reaches nothing that reads it".
 */
class MobileOnlyControl extends Feature {
	readonly id = MOBILE_CONTROL_ID;
	readonly name = "Mobile-only control";
	readonly description = "Test-only: answers unavailable under Platform.isMobile.";

	readiness(): Readiness {
		return Platform.isMobile
			? { state: "unavailable", reason: "Not available on this device." }
			: { state: "ready" };
	}
}

/** `startDaysAhead`'s own registry, with {@link MobileOnlyControl} registered beside `days-ahead`. */
async function startDaysAheadWithMobileControl(
	data: EffortlessData,
	buildsTheDays: boolean,
): Promise<{ registry: FeatureRegistry }> {
	const plugin = new Plugin();
	plugin.seedData(data);
	plugin.load();
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const notes = new NoteWriter(new Vault() as unknown as ObsidianVault, {
		path: () => null,
		onChange: () => undefined,
	});
	const calendar: Calendar = { meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} };
	const collections: Collections = { all: () => [], at: () => null };
	const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
	device.save({ buildsTheDays });
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections, problems: new Problems(), device },
		notes,
		calendar,
	);
	registry.register(FEATURE_ID, (host: FeatureHost) => new DaysAhead(host));
	registry.register(MOBILE_CONTROL_ID, (host: FeatureHost) => new MobileOnlyControl(host));
	registry.start();
	return { registry };
}

/** Clicks an element the way a person does: a bubbling event, so a handler bound higher up the tree still fires. */
function click(el: HTMLElement): void {
	el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

/** The feature cards on a real settings screen, the core card excluded. */
function featureCards(tab: EffortlessSettingTab): HTMLElement[] {
	return Array.from(tab.containerEl.querySelectorAll(".effortless-card")).filter(
		(el) => !el.classList.contains("effortless-card-core"),
	) as HTMLElement[];
}

/**
 * The real settings screen — `EffortlessSettingTab` itself, wired to a real
 * registry and a real store — with this feature's own card open.
 *
 * `startDaysAhead`'s `card()` helper draws the panel alone, with a no-op
 * `changed`, which is exactly why the suite never caught #712: a destructive
 * redraw is something only the real screen around the panel can do. This is
 * the harness that can catch it.
 */
async function openDaysAheadOnRealScreen(
	data: EffortlessData = dataWith(ANSWERED),
	buildsTheDays = true,
): Promise<{ tab: EffortlessSettingTab; plugin: Plugin }> {
	const plugin = new Plugin();
	plugin.seedData(data);
	plugin.load();
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const notes = new NoteWriter(new Vault() as unknown as ObsidianVault, {
		path: () => null,
		onChange: () => undefined,
	});
	const calendar: Calendar = { meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} };
	const collections: Collections = { all: () => [], at: () => null };
	const problems = new Problems();
	const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
	device.save({ buildsTheDays });
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections, problems, device },
		notes,
		calendar,
	);
	registry.register(FEATURE_ID, (host: FeatureHost) => new DaysAhead(host));
	registry.start();
	const tab = new EffortlessSettingTab(plugin.app as unknown as ObsidianApp, plugin as unknown as ObsidianPlugin, {
		settings,
		registry,
		device,
		collections,
		problems,
	});
	tab.display();
	// The chevron and the name-and-description block open the card; the header
	// as a whole does not, because it also carries the on/off switch
	// (`src/core/settingsTab.ts`'s own `renderFeatureCard`).
	click(featureCards(tab)[0].querySelector(".effortless-card-text") as HTMLElement);
	return { tab, plugin };
}

/** The Days ahead box, as the real screen's open card shows it right now. */
function daysAheadBox(tab: EffortlessSettingTab): TextComponent {
	const text = controlsUnder(featureCards(tab)[0]).get("Days ahead")?.[0] as TextComponent | undefined;
	if (text === undefined) throw new Error("the open card has no Days ahead row");
	return text;
}

/** The card's body, drawn as the settings screen draws it, and its Days ahead row. */
function card(feature: DaysAhead): { body: HTMLElement; text: TextComponent; desc: string } {
	const body = document.createElement("div");
	feature.displaySettings(body, () => undefined);
	const text = controlsUnder(body).get("Days ahead")?.[0] as TextComponent | undefined;
	if (text === undefined) throw new Error("the card has no Days ahead row");
	const row = text.inputEl.closest(".setting-item") ?? body;
	return { body, text, desc: row.querySelector(".setting-item-description")?.textContent ?? "" };
}

/** Lets every pending promise settle. */
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

beforeEach(() => {
	Notice.messages = [];
	resetSettings();
	Platform.isMobile = false;
});

describe("what the feature declares", () => {
	it("is registered in main.ts with one line", async () => {
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const { repoRoot } = await import("./repoRoot");
		const main = readFileSync(resolve(repoRoot, "src/main.ts"), "utf8");
		const lines = main.split("\n").filter((line) => line.includes("DaysAhead") || line.includes('"days-ahead"'));
		expect(lines.map((line) => line.trim())).toEqual([
			'import { DaysAhead } from "./features/daysAhead";',
			'registry.register("days-ahead", (host) => new DaysAhead(host));',
		]);
	});

	it("exports the class and the id from its index and nothing else", () => {
		expect(Object.keys(daysAheadModule).sort()).toEqual(["DaysAhead", "FEATURE_ID"]);
		expect(FEATURE_ID).toBe("days-ahead");
	});

	it("declares its id, name and description", async () => {
		const { registry } = await startDaysAhead();
		const [row] = registry.statuses();
		expect(row).toMatchObject({
			id: "days-ahead",
			name: "Building the days ahead",
			description: "Creates the day's log for today and the days ahead, and fills its calendar table from your calendars.",
		});
	});

	/*
	 * Issue #711(a). The
	 * old assertion was `expect(feature).toBeInstanceOf(DaysAhead)` — true
	 * whether or not the feature ever reported a problem. The harness already
	 * builds a real `Problems` channel; this reads it back instead of reasoning
	 * about what the feature never took.
	 */
	it("reports no standing problem of its own, on start, on a recheck and on a save from the card", async () => {
		vi.useFakeTimers();
		try {
			const { registry, feature, problems } = await startDaysAhead(dataWith(ANSWERED), true);
			expect(problems.all()).toEqual([]);

			registry.recheckReadiness();
			expect(problems.all()).toEqual([]);

			card(feature).text.change("14");
			await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);
			expect(problems.all()).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("readiness", () => {
	it("answers standby, naming another device, when this device does not build the days", async () => {
		const { registry } = await startDaysAhead(dataWith(ANSWERED), false);
		const [row] = registry.statuses();
		expect(row.state).toBe("standby");
		expect(row.detail).toBe("Another device builds the days.");
	});

	it("answers standby before anything else, even with the layout and columns all unanswered too", async () => {
		const { registry } = await startDaysAhead(dataWith(), false);
		const [row] = registry.statuses();
		expect(row.state).toBe("standby");
		expect(row.detail).toBe("Another device builds the days.");
	});

	it("answers unconfigured naming the daily-log folder when it is unanswered", async () => {
		const { registry } = await startDaysAhead(dataWith({ ...ANSWERED, dailyLogFolder: "" }), true);
		const [row] = registry.statuses();
		expect(row.state).toBe("unconfigured");
		expect(row.detail).toBe(
			"The daily-log folder is not set. Enter it under Folder on the Your day's logs card.",
		);
	});

	it("answers unconfigured naming the filename pattern when it is unanswered", async () => {
		const { registry } = await startDaysAhead(dataWith({ ...ANSWERED, dailyLogFilename: "" }), true);
		const [row] = registry.statuses();
		expect(row.state).toBe("unconfigured");
		expect(row.detail).toBe(
			"The daily-log filename pattern is not set. Enter it under Filename on the Your day's logs card.",
		);
	});

	it("answers unconfigured naming a blank calendar column name", async () => {
		const { registry } = await startDaysAhead(
			dataWith({ ...ANSWERED, calendarColumns: { time: "Start", event: "" } }),
			true,
		);
		const [row] = registry.statuses();
		expect(row.state).toBe("unconfigured");
		expect(row.detail).toBe(
			"One of the two calendar table column names is blank, so no table can be found. Enter both under Calendar table columns on the Your day's logs card.",
		);
	});

	it("answers unconfigured naming two calendar column names that fold to one", async () => {
		const { registry } = await startDaysAhead(
			dataWith({ ...ANSWERED, calendarColumns: { time: "Start", event: "  START " } }),
			true,
		);
		const [row] = registry.statuses();
		expect(row.state).toBe("unconfigured");
		expect(row.detail).toBe(
			"The two calendar table column names read as the same name, so they cannot tell two columns apart. Give them different names under Calendar table columns on the Your day's logs card.",
		);
	});

	it("answers ready when the device builds the days and the layout and both column names are answered", async () => {
		const { registry } = await startDaysAhead(dataWith(ANSWERED), true);
		expect(registry.statuses()[0].state).toBe("running");
	});

	/*
	 * Issue #711(b). The
	 * old sweep toggled `Platform.isMobile` around five layout/device cases,
	 * but `days-ahead`'s own `readiness()` reads no platform switch at all —
	 * the ten runs were five runs done twice, and a stub that never wired
	 * `Platform.isMobile` up to anything would have looked identical. The
	 * control feature below actually reads it, so the sweep has something that
	 * could show wrong.
	 */
	it("never answers unavailable itself, on a sweep proven able to see unavailable when a feature genuinely answers it", async () => {
		const cases: Array<{ layout: Partial<VaultLayout>; buildsTheDays: boolean }> = [
			{ layout: {}, buildsTheDays: false },
			{ layout: ANSWERED, buildsTheDays: false },
			{ layout: {}, buildsTheDays: true },
			{ layout: ANSWERED, buildsTheDays: true },
			{ layout: { ...ANSWERED, calendarColumns: { time: "X", event: "X" } }, buildsTheDays: true },
		];
		for (const { layout, buildsTheDays } of cases) {
			for (const mobile of [false, true]) {
				Platform.isMobile = mobile;
				const { registry } = await startDaysAheadWithMobileControl(dataWith(layout), buildsTheDays);
				const rows = registry.statuses();
				const days = rows.find((row) => row.id === FEATURE_ID);
				const control = rows.find((row) => row.id === MOBILE_CONTROL_ID);
				expect(days?.state).not.toBe("unavailable");
				expect(control?.state).toBe(mobile ? "unavailable" : "running");
			}
		}
		Platform.isMobile = false;
	});
});

describe("the device switch re-checks readiness with no reload", () => {
	it("moves the feature from standby to running through recheckReadiness alone", async () => {
		const { registry, device } = await startDaysAhead(dataWith(ANSWERED), false);
		expect(registry.statuses()[0].state).toBe("standby");

		device.save({ buildsTheDays: true });
		registry.recheckReadiness();

		expect(registry.statuses()[0].state).toBe("running");
	});

	it("moves the feature from running back to standby the same way", async () => {
		const { registry, device } = await startDaysAhead(dataWith(ANSWERED), true);
		expect(registry.statuses()[0].state).toBe("running");

		device.save({ buildsTheDays: false });
		registry.recheckReadiness();

		expect(registry.statuses()[0].state).toBe("standby");
	});
});

describe("the Days ahead row", () => {
	it("shows 7 on a fresh install, with no notice, and says what it means at the default", async () => {
		const { feature } = await startDaysAhead(dataWith(ANSWERED), true);
		const { text, desc } = card(feature);

		expect(text.getValue()).toBe("7");
		expect(desc).toBe(
			"How many days ahead, today included, to keep a log ready for. At the default, today through today plus six.",
		);
		expect(Notice.messages).toEqual([]);
		expect(feature.windowDays()).toBe(7);
	});

	it("stores a chosen value", async () => {
		vi.useFakeTimers();
		try {
			const { plugin, feature } = await startDaysAhead(dataWith(ANSWERED), true);
			card(feature).text.change("14");
			await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);

			expect(JSON.parse(plugin.saved[plugin.saved.length - 1]).features[FEATURE_ID]).toEqual({
				windowDays: 14,
				rows: {},
			});
		} finally {
			vi.useRealTimers();
		}
	});

	/*
	 * The old assertion here was `.not.toBe(WINDOW_DAYS_LINE)` on
	 * `text.inputEl.closest(".setting-item")`, which is `null` under this
	 * stub — `Setting.addText` never attaches the component's `inputEl` to the
	 * DOM the way the real Obsidian does, unlike `card()`'s own `desc`, which
	 * falls back to the drawn `body`. So `descAfter` was always `undefined`,
	 * and `.not.toBe(...)` passed on that alone, with no wrong description
	 * ever able to fail it, on top of "any other text passes" being true even
	 * had it read the real one.
	 *
	 * The pattern this follows is the one checkbox cycling's rename box and
	 * date entry's trigger box already use: the refusal is shown in the row's
	 * own description as it is typed, and no `Notice` is raised for it — a
	 * toast on every keystroke would be. The name is fixed to match: no
	 * `Notice` is raised here at all.
	 */
	it.each([
		["0", "Days ahead must be from 1 to 60, not 0."],
		["61", "Days ahead must be from 1 to 60, not 61."],
		["seven", "Days ahead must be a whole number from 1 to 60."],
	])("shows %s's exact refusal in the row's own description, with no Notice, and keeps the previous value stored", async (typed, refusal) => {
		const { plugin, feature } = await startDaysAhead(dataWith(ANSWERED, { windowDays: 3 }), true);
		const { text, body } = card(feature);

		text.change(typed);
		await settle();

		const descAfter = body.querySelector(".setting-item-description")?.textContent;
		expect(descAfter).toBe(refusal);
		expect(Notice.messages).toEqual([]);
		expect(plugin.saved).toEqual([]);
		expect(feature.windowDays()).toBe(3);
	});

	it("gives one notice naming a stored value it cannot use, and uses 7 instead", async () => {
		await startDaysAhead(dataWith(ANSWERED, { windowDays: 0 }), true);

		expect(Notice.messages).toEqual([
			"Effortless: Days ahead cannot use the value 0 stored here, and keeps 7 until this is changed.",
		]);
	});

	it("names a stored value that is not a number at all", async () => {
		await startDaysAhead(dataWith(ANSWERED, { windowDays: "many" }), true);

		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain('the value "many" stored');
	});

	it("shows a stored unusable value as typed, with its refusal beside it, and does not read as a usable number", async () => {
		const { feature } = await startDaysAhead(dataWith(ANSWERED, { windowDays: 90 }), true);
		const { text, desc } = card(feature);

		expect(text.getValue()).toBe("90");
		expect(desc).toBe("Days ahead cannot use the value 90 stored here, and keeps 7 until this is changed.");
		expect(feature.windowDays()).toBe(7);
	});

	it("is not rewritten by being shown, and is replaced once a usable value is entered", async () => {
		vi.useFakeTimers();
		try {
			const { plugin, feature } = await startDaysAhead(dataWith(ANSWERED, { windowDays: 90 }), true);
			expect(plugin.saved).toEqual([]);

			card(feature).text.change("10");
			await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);

			expect(JSON.parse(plugin.saved[plugin.saved.length - 1]).features[FEATURE_ID]).toEqual({
				windowDays: 10,
				rows: {},
			});
			expect(card(feature).desc).toBe(
				"How many days ahead, today included, to keep a log ready for. At the default, today through today plus six.",
			);
		} finally {
			vi.useRealTimers();
		}
	});
});

/*
 * Issue #712. The box
 * saved on every landed keystroke and then told the settings screen to redraw
 * itself — a whole-screen rebuild that replaces the box's own input element,
 * the failure #108
 * records. Typing `14` stored `1`, the screen rebuilt underneath the second
 * digit, and it reached nothing.
 *
 * `startDaysAhead`'s `card()` helper draws the panel alone, with a no-op
 * `changed`, so it cannot see this: the redraw it would trigger never runs.
 * These tests drive the real `EffortlessSettingTab` instead, the way #712's
 * own verified reproduction did.
 */
describe("typing a two-digit window into the real settings screen", () => {
	it("keeps the box in place after the first digit lands, so the second digit reaches it and both are stored", async () => {
		vi.useFakeTimers();
		try {
			const { tab, plugin } = await openDaysAheadOnRealScreen();
			const before = daysAheadBox(tab).inputEl;

			daysAheadBox(tab).change("1");
			await vi.advanceTimersByTimeAsync(0);

			// The box a second keystroke actually lands in — the one the real
			// screen shows right now, not the one held before the first
			// character. A destructive redraw here would have replaced it with a
			// fresh node holding "1", and the "4" below would never reach it.
			const midway = daysAheadBox(tab);
			expect(midway.inputEl).toBe(before);

			midway.change("14");
			await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);

			expect(JSON.parse(plugin.saved[plugin.saved.length - 1]).features[FEATURE_ID]).toEqual({
				windowDays: 14,
				rows: {},
			});
		} finally {
			vi.useRealTimers();
		}
	});
});

/*
 * The composition issue #907
 * asks for: `NoteWriter.createDailyLog` building a day from the person's own
 * template note, and days ahead's own `runWindow` (`src/features/daysAhead/run.ts`)
 * filling that same day's calendar table afterwards — the rule `CLAUDE.md`
 * states under "A ticket that consumes another ticket's module": a closing
 * comment cites one test that runs both.
 *
 * A real `NoteWriter`, over the obsidian stub's own `Vault`, is handed to
 * `runWindow` as its `notes` port directly — `NoteWriter`'s three public
 * methods, `createDailyLog`, `read` and `edit`, already match `RunNotes`
 * member for member, so nothing here fakes the note-writing half at all.
 */
describe("a template-built day, then days ahead's own table write on it", () => {
	function meeting(partial: Partial<Meeting> = {}): Meeting {
		return {
			uid: "uid-1",
			summary: "Standup",
			location: null,
			description: null,
			organizer: null,
			attendees: [],
			occurrenceKey: null,
			allDay: false,
			start: new Date(2026, 9, 15, 9, 0),
			end: new Date(2026, 9, 15, 9, 30),
			...partial,
		};
	}

	it("fills days ahead's own calendar table on a day createDailyLog built from a template", async () => {
		const templatePath = "Templates/Day.md";
		const vault = new Vault();
		vault.files.push({ path: templatePath } as unknown as TFile);
		vault.allowReads({
			[templatePath]:
				"# Dagplan {{date:dddd D MMMM}}\n\n← [[{{yesterday:YYYY-MM-DD}}]] | [[{{date:YYYY-MM}}]] | [[{{tomorrow:YYYY-MM-DD}}]] →\n\n# Notes\n\n## Overdue\n\n## Today\n\n## Calendar\n\n```schema\n| Start | What |\n| --- | --- |\n|  |  |\n```\n",
		});
		const notes = new NoteWriter(vault as unknown as ObsidianVault, {
			path: () => null,
			onChange: () => undefined,
		});
		const layout: VaultLayout = {
			...defaultData().core.layout,
			dailyLogFolder: "Journal",
			dailyLogFilename: "YYYY-MM-DD",
			calendarColumns: { time: "Start", event: "What" },
			dailyLogTemplate: templatePath,
		};

		const standing = new Set<string>();
		const problems: RunProblems = {
			report: (key) => standing.add(key),
			clear: (key) => standing.delete(key),
			list: () => [...standing],
		};
		const calendar: RunCalendar = {
			refresh: async () => {},
			meetingsOn: (_day, use) => (use === "day" ? [meeting()] : []),
			presenceBetween: () => ({ whole: false, meetings: [] }),
		};

		await runWindow({
			calendar,
			notes,
			problems,
			layout,
			windowDays: 1,
			today: new Date(2026, 9, 15),
			memory: {},
			commitMemory: async () => {},
		});

		// Every day this run touched came out clean: neither the template
		// nor the table write reported anything wrong.
		expect(standing.size).toBe(0);

		const text = vault.readableContents()?.get("Journal/2026-10-15.md") ?? "";
		// The template's own placeholders, filled for the day being built —
		// createDailyLog's own half of the composition.
		expect(text).toContain("Dagplan");
		expect(text).toContain("15 October");
		expect(text).toContain("[[2026-10-14]]");
		expect(text).toContain("[[2026-10]]");
		expect(text).toContain("[[2026-10-16]]");
		// Days ahead's own half: the meeting landed in the table the
		// template provided, and the template's blank placeholder row did
		// not survive to be read as a second, empty meeting — one meeting
		// named once, and no blank row left beside it.
		expect(text).toContain("| 09:00");
		expect(text.match(/Standup/g)?.length).toBe(1);
		expect(text).not.toContain("|  |  |");
	});

	it("reports a broken template through days ahead's own problems channel, and leaves the day uncreated", async () => {
		const templatePath = "Templates/Day.md";
		const vault = new Vault();
		vault.files.push({ path: templatePath } as unknown as TFile);
		vault.allowReads({ [templatePath]: "{{nextWeek:YYYY-MM-DD}}" });
		const notes = new NoteWriter(vault as unknown as ObsidianVault, {
			path: () => null,
			onChange: () => undefined,
		});
		const layout: VaultLayout = {
			...defaultData().core.layout,
			dailyLogFolder: "Journal",
			dailyLogFilename: "YYYY-MM-DD",
			calendarColumns: { time: "Start", event: "What" },
			dailyLogTemplate: templatePath,
		};

		const reported: { key: string; message: string }[] = [];
		const standing = new Set<string>();
		const problems: RunProblems = {
			report: (key, message) => {
				reported.push({ key, message });
				standing.add(key);
			},
			clear: (key) => standing.delete(key),
			list: () => [...standing],
		};
		const calendar: RunCalendar = { refresh: async () => {}, meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }) };

		await runWindow({
			calendar,
			notes,
			problems,
			layout,
			windowDays: 1,
			today: new Date(2026, 9, 15),
			memory: {},
			commitMemory: async () => {},
		});

		// createDailyLog's own rejection, carried through days ahead's
		// existing "could not create this day's log" report
		// (`src/features/daysAhead/run.ts`'s `runDay`, unedited by this
		// ticket) — naming what was wrong rather than a bare failure.
		expect(reported).toHaveLength(1);
		expect(reported[0].key).toBe("2026-10-15");
		expect(reported[0].message).toContain("could not create this day's log");
		expect(reported[0].message).toContain('a placeholder Effortless does not know: "{{nextWeek:YYYY-MM-DD}}"');
		expect(vault.getFileByPath("Journal/2026-10-15.md")).toBeNull();
	});
});
