/**
 * The day view as a feature: what it declares, when it is ready, the renderer
 * it registers through the core, and the now-line's minute tick (spec
 * #618 decisions 1, 3, 4
 * and 9, #627).
 *
 * **These tests drive the real feature registry and settings store**, over the
 * Obsidian stub, because what they assert is where the feature meets the
 * core: the row the settings screen shows, the one renderer the core keeps for
 * `schema`, and what the core's switch does to both. A block is handed in the
 * way Obsidian hands one — through `MarkdownPreviewRenderer.renderReading` and
 * `renderLivePreview`, the stub's stand-ins for reading mode and live preview —
 * and the element that comes back is read.
 *
 * Every date is built from local parts; every folder and meeting name is
 * invented.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin, Vault as ObsidianVault } from "obsidian";
import {
	MarkdownPreviewRenderer,
	MarkdownRenderer,
	Notice,
	Plugin,
	Vault,
} from "./__mocks__/obsidian";
import type { Component, MarkdownPostProcessorContext } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { Collections } from "../core/collections";
import type { FeatureHost } from "../core/feature";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore, defaultData } from "../core/settings";
import type { EffortlessData, VaultLayout } from "../core/settings";
import * as dayViewModule from "../features/dayView";
import { DayView, FEATURE_ID } from "../features/dayView";
import { repoRoot } from "./repoRoot";

/** A local moment on an invented day. */
const at = (h: number, min: number): Date => new Date(2031, 3, 9, h, min);

/** The invented day's log under the layout {@link ANSWERED} gives. */
const TODAYS_LOG = "Logbook/2031-04-09.md";

/** The shipped layout, with the daily-log folder and filename answered. */
const ANSWERED: Partial<VaultLayout> = { dailyLogFolder: "Logbook", dailyLogFilename: "YYYY-MM-DD" };

/** Three timed meetings and one all-day one, under the shipped column names. */
const DAY_SOURCE = [
	"| Time | Meeting |",
	"| --- | --- |",
	"| heldag | Harbour festival |",
	"| 09:00–10:00 | Planning |",
	"| 09:30–10:30 | Review |",
	"| 13:00–13:45 | Walk |",
].join("\n");

/** The settings file with `layout` laid over the shipped layout and `features` as given. */
function dataWith(layout: Partial<VaultLayout>, features: Record<string, unknown> = {}): EffortlessData {
	const data = defaultData();
	return { ...data, core: { ...data.core, layout: { ...data.core.layout, ...layout } }, features };
}

interface Started {
	readonly plugin: Plugin;
	readonly registry: FeatureRegistry;
	readonly feature: DayView;
}

/**
 * The plugin loaded over `data`, the core's registry holding the day view under
 * its id, and the registry started, as `main.ts` starts it.
 */
async function startDayView(data: EffortlessData = dataWith({})): Promise<Started> {
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
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections, problems: new Problems(), device },
		notes,
		calendar,
	);
	let feature: DayView | undefined;
	registry.register(FEATURE_ID, (host: FeatureHost) => (feature = new DayView(host)));
	registry.start();
	return { plugin, registry, feature: feature! };
}

/**
 * What Obsidian hands a renderer beside the block: the note's path, and
 * `addChild`, which here loads the child at once and keeps it so a test can
 * unload it to stand in for the section being thrown away.
 */
function contextFor(sourcePath: string): { ctx: MarkdownPostProcessorContext; children: Component[] } {
	const children: Component[] = [];
	const ctx: MarkdownPostProcessorContext = {
		docId: "an-invented-doc",
		sourcePath,
		frontmatter: null,
		addChild: (child: Component) => {
			children.push(child);
			child.load();
		},
	};
	return { ctx, children };
}

/** Draws `source` the way reading mode does and hands back the block's own element. */
function inReading(source: string, sourcePath = "Notes/Anything.md"): HTMLElement {
	const section = MarkdownPreviewRenderer.renderReading("schema", source, contextFor(sourcePath).ctx);
	const el = section.querySelector<HTMLElement>(".block-language-schema");
	if (el === null) throw new Error("reading mode drew no schema block");
	return el;
}

beforeEach(() => {
	Notice.messages = [];
	MarkdownPreviewRenderer.reset();
	MarkdownRenderer.rendered = [];
});

afterEach(() => {
	vi.useRealTimers();
});

describe("what the feature declares", () => {
	it("is registered in main.ts with one line", () => {
		const main = readFileSync(resolve(repoRoot, "src/main.ts"), "utf8");
		const lines = main.split("\n").filter((line) => line.includes("DayView") || line.includes('"day-view"'));
		expect(lines.map((line) => line.trim())).toEqual([
			'import { DayView } from "./features/dayView";',
			'registry.register("day-view", (host) => new DayView(host));',
		]);
	});

	it("exports the class and the id from its index and nothing else", () => {
		expect(Object.keys(dayViewModule).sort()).toEqual(["DayView", "FEATURE_ID"]);
		expect(FEATURE_ID).toBe("day-view");
	});

	it("declares its id, name and description", async () => {
		const { registry } = await startDayView();
		const [row] = registry.statuses();
		expect(row).toMatchObject({
			id: "day-view",
			name: "Day view",
			description: "Draws the day's calendar table as a proportional schedule.",
		});
	});
});

describe("readiness", () => {
	it("reaches running with the shipped defaults", async () => {
		const { registry } = await startDayView();
		expect(registry.statuses()[0].state).toBe("running");
	});

	it("reaches running with the daily-log folder and filename unanswered — they are not readiness", async () => {
		const { registry } = await startDayView(dataWith({ dailyLogFolder: "", dailyLogFilename: "" }));
		expect(registry.statuses()[0].state).toBe("running");
	});

	it("is not configured with a blank column name, saying which and pointing at the core card", async () => {
		const { registry } = await startDayView(dataWith({ calendarColumns: { time: "Time", event: "" } }));
		const [row] = registry.statuses();
		expect(row.state).toBe("unconfigured");
		expect(row.detail).toBe(
			"One of the two calendar table column names is blank, so no table can be found. Enter both under Calendar table columns on the Your day's logs card.",
		);
	});

	it("is not configured with two column names that fold to one, saying which and pointing at the core card", async () => {
		const { registry } = await startDayView(dataWith({ calendarColumns: { time: "Time", event: "  TIME " } }));
		const [row] = registry.statuses();
		expect(row.state).toBe("unconfigured");
		expect(row.detail).toBe(
			"The two calendar table column names read as the same name, so they cannot tell two columns apart. Give them different names under Calendar table columns on the Your day's logs card.",
		);
	});
});

describe("the renderer", () => {
	it("is registered from onload only, never while the feature is being built", () => {
		const registered: string[] = [];
		const host = {
			core: dataWith({}).core,
			// #629's rename listener needs a vault to register on; this test
			// cares only about the code-block processor's own timing.
			app: { vault: { on: () => ({ name: "rename", detach: () => undefined }) } },
			registerMarkdownCodeBlockProcessor: (language: string) => {
				registered.push(language);
			},
			settings: <T extends object>(defaults: T) => ({
				read: () => defaults,
				save: async () => undefined,
				saveSoon: async () => undefined,
				onChange: () => () => undefined,
			}),
		} as unknown as FeatureHost;

		const feature = new DayView(host);
		expect(registered).toEqual([]);

		feature.load();
		expect(registered).toEqual(["schema"]);
		feature.unload();
	});

	it("draws a schema block as the day in reading mode and in live preview", async () => {
		await startDayView();

		const reading = inReading(DAY_SOURCE);
		const live = MarkdownPreviewRenderer.renderLivePreview("schema", DAY_SOURCE, contextFor("Notes/Anything.md").ctx);

		for (const drawn of [reading, live]) {
			expect(drawn?.querySelectorAll(".effortless-day-view-band > .effortless-day-view-bar")).toHaveLength(1);
			expect(drawn?.querySelectorAll(".effortless-day-view-track > .effortless-day-view-block")).toHaveLength(3);
		}
	});

	it("draws plainly once switched off, and as the day again once switched back on", async () => {
		const { registry } = await startDayView();

		await registry.setEnabled(FEATURE_ID, false);
		const off = inReading(DAY_SOURCE);
		expect(off.querySelector(".effortless-day-view-grid")).toBeNull();
		expect(off.querySelector("pre > code")?.textContent).toBe(DAY_SOURCE);

		await registry.setEnabled(FEATURE_ID, true);
		expect(inReading(DAY_SOURCE).querySelector(".effortless-day-view-grid")).not.toBeNull();
	});

	it("leaves exactly one renderer for schema after three switches off and on, drawing each block once", async () => {
		const { registry } = await startDayView();

		for (let round = 0; round < 3; round += 1) {
			await registry.setEnabled(FEATURE_ID, false);
			await registry.setEnabled(FEATURE_ID, true);
		}

		expect(Object.keys(MarkdownPreviewRenderer.codeBlockPostProcessors)).toEqual(["schema"]);
		expect(MarkdownPreviewRenderer.postProcessors).toHaveLength(1);
		const el = inReading(DAY_SOURCE);
		expect(el.querySelectorAll(".effortless-day-view-grid")).toHaveLength(1);
		expect(el.querySelectorAll(".effortless-day-view-block:not(.effortless-day-view-bar)")).toHaveLength(3);
	});

	it("shows a block with no table as its own text, drawn as Markdown under one sentence giving the core's reason", async () => {
		await startDayView();
		const source = ["| Start | Title |", "| --- | --- |", "| 09:00–10:00 | Planning |"].join("\n");

		const el = inReading(source, "Notes/Other.md");

		expect(el.querySelector(".effortless-day-view-fallback")?.textContent).toBe(
			"Effortless could not read a day here, so it is shown as written. No table names both columns.",
		);
		expect(MarkdownRenderer.rendered).toHaveLength(1);
		expect(MarkdownRenderer.rendered[0].markdown).toBe(source);
		expect(MarkdownRenderer.rendered[0].sourcePath).toBe("Notes/Other.md");
		expect(MarkdownRenderer.rendered[0].el).toBe(el.querySelector(".effortless-day-view-fallback-source"));
		expect(el.querySelector(".effortless-day-view-grid")).toBeNull();
	});

	it("lists a row error and an unread row above the grid", async () => {
		await startDayView();
		const source = [
			"| Time | Meeting |",
			"| --- | --- |",
			"| 09:00–10:00 | Planning |",
			"| soon | Unreadable |",
			"",
			"| 11:00–12:00 | Stranded |",
		].join("\n");

		const el = inReading(source);

		expect(Array.from(el.children).map((child) => child.className)).toEqual([
			"effortless-day-view-problems",
			"effortless-day-view-unread",
			"effortless-day-view-grid",
		]);
		expect(el.querySelector(".effortless-day-view-problems .effortless-day-view-problem-source")?.textContent).toBe(
			"| soon | Unreadable |",
		);
		expect(el.querySelector(".effortless-day-view-unread .effortless-day-view-problem-source")?.textContent).toBe(
			"| 11:00–12:00 | Stranded |",
		);
	});
});

describe("the now-line", () => {
	it("is drawn on today's log, and on no other note", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
		vi.setSystemTime(at(10, 15));
		await startDayView(dataWith(ANSWERED));

		const today = inReading(DAY_SOURCE, TODAYS_LOG);
		expect(today.querySelector<HTMLElement>(".effortless-day-view-now-line")?.style.top).toBe("135px");
		expect(inReading(DAY_SOURCE, "Logbook/2031-04-08.md").querySelector(".effortless-day-view-now-line")).toBeNull();
		expect(inReading(DAY_SOURCE, "Elsewhere/2031-04-09.md").querySelector(".effortless-day-view-now-line")).toBeNull();
	});

	it("is drawn on no note while the daily-log folder and filename are unanswered", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
		vi.setSystemTime(at(10, 15));
		await startDayView();

		expect(inReading(DAY_SOURCE, "2031-04-09.md").querySelector(".effortless-day-view-now-line")).toBeNull();
		expect(inReading(DAY_SOURCE, TODAYS_LOG).querySelector(".effortless-day-view-now-line")).toBeNull();
	});

	it("is created hidden by its class, not a fixed inline style, while now is outside the span, and appears when a minute's tick brings now inside it", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
		vi.setSystemTime(at(7, 59));
		await startDayView(dataWith(ANSWERED));

		const line = inReading(DAY_SOURCE, TODAYS_LOG).querySelector<HTMLElement>(".effortless-day-view-now-line");
		expect(line?.classList.contains("effortless-day-view-now-line--hidden")).toBe(true);
		expect(line?.style.display).not.toBe("none");

		vi.advanceTimersByTime(60_000);
		expect(line?.classList.contains("effortless-day-view-now-line--hidden")).toBe(false);
		expect(line?.style.top).toBe("0px");
	});

	it("moves once a minute on an interval registered on the feature, which stops when the feature is switched off", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
		vi.setSystemTime(at(10, 15));
		const { registry } = await startDayView(dataWith(ANSWERED));
		const line = inReading(DAY_SOURCE, TODAYS_LOG).querySelector<HTMLElement>(".effortless-day-view-now-line");

		vi.advanceTimersByTime(60_000);
		expect(line?.style.top).toBe("136px");

		await registry.setEnabled(FEATURE_ID, false);
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(5 * 60_000);
		expect(line?.style.top).toBe("136px");
	});

	it("stops moving a line whose block Obsidian has thrown away", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
		vi.setSystemTime(at(10, 15));
		await startDayView(dataWith(ANSWERED));
		const { ctx, children } = contextFor(TODAYS_LOG);
		const section = MarkdownPreviewRenderer.renderReading("schema", DAY_SOURCE, ctx);
		const line = section.querySelector<HTMLElement>(".effortless-day-view-now-line");

		for (const child of children) child.unload();
		vi.advanceTimersByTime(60_000);

		expect(line?.style.top).toBe("135px");
	});

	it("hides the line once its note stops being today's log, rather than letting it follow the clock onto yesterday's note", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
		vi.setSystemTime(at(10, 15));
		await startDayView(dataWith(ANSWERED));

		const line = inReading(DAY_SOURCE, TODAYS_LOG).querySelector<HTMLElement>(".effortless-day-view-now-line");
		expect(line?.classList.contains("effortless-day-view-now-line--hidden")).toBe(false);
		expect(line?.style.top).toBe("135px");

		// A full day later: the same time of day, so a tick that only checked the
		// span would place the line right back where it started — on a note that
		// is no longer today's log.
		vi.advanceTimersByTime(24 * 60 * 60_000);

		expect(line?.classList.contains("effortless-day-view-now-line--hidden")).toBe(true);
	});
});
