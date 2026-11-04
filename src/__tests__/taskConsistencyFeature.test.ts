/**
 * Task consistency as a feature: what it declares, its empty settings and its
 * readiness.
 * This ticket copies nothing yet — no line is read, no line is written — so
 * these tests cover the row a person sees and the four readiness answers.
 *
 * **These tests drive the real feature registry and the real settings
 * store**, over the Obsidian stub, because what they assert is where the
 * feature meets the core — the same shape
 * `src/__tests__/meetingNotesFeature.test.ts` and `daysAheadFeature.test.ts`
 * use for their own features.
 *
 * Every folder and filename here is invented.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin, Vault as ObsidianVault } from "obsidian";
import { Notice, Platform, Plugin, Vault, resetSettings } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { Collections } from "../core/collections";
import type { FeatureHost } from "../core/feature";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore, defaultData } from "../core/settings";
import type { EffortlessData, VaultLayout } from "../core/settings";
import { EffortlessSettingTab } from "../core/settingsTab";
import * as taskConsistencyModule from "../features/taskConsistency";
import { FEATURE_ID, TaskConsistency } from "../features/taskConsistency";

/** A layout with the daily-log folder and filename both answered, and the tasks heading blank. */
const ANSWERED: Partial<VaultLayout> = {
	dailyLogFolder: "Journal",
	dailyLogFilename: "YYYY-MM-DD",
	tasksHeading: "",
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
	readonly feature: TaskConsistency;
	readonly problems: Problems;
	readonly tab: EffortlessSettingTab;
}

/**
 * The plugin loaded over `data`, the core's registry holding the feature
 * under its id and started as `main.ts` starts it, and the real settings
 * screen built over the same parts.
 */
async function startTaskConsistency(data: EffortlessData = dataWith()): Promise<Started> {
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
	const problems = new Problems();
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections, problems, device },
		notes,
		calendar,
	);
	let feature: TaskConsistency | undefined;
	registry.register(FEATURE_ID, (host: FeatureHost) => (feature = new TaskConsistency(host)));
	registry.start();
	const tab = new EffortlessSettingTab(plugin.app as unknown as ObsidianApp, plugin as unknown as ObsidianPlugin, {
		settings,
		registry,
		device,
		collections,
		problems,
	});
	return { plugin, registry, feature: feature!, problems, tab };
}

/** The feature cards on a real settings screen, the core card excluded. */
function featureCards(tab: EffortlessSettingTab): HTMLElement[] {
	return Array.from(tab.containerEl.querySelectorAll(".effortless-card")).filter(
		(el) => !el.classList.contains("effortless-card-core"),
	) as HTMLElement[];
}

/** What a person reads on the feature's closed row: its name, its line and its badge. */
function closedRow(tab: EffortlessSettingTab): { name: string; line: string; badge: string } {
	tab.display();
	const cards = featureCards(tab);
	expect(cards).toHaveLength(1);
	const [card] = cards;
	return {
		name: card.querySelector(".effortless-card-name")?.textContent ?? "",
		line: card.querySelector(".effortless-card-line")?.textContent ?? "",
		badge: card.querySelector(".effortless-badge")?.textContent ?? "",
	};
}

/** Opens the feature's card on the real screen, the way a person clicks its name. */
function openCard(tab: EffortlessSettingTab): HTMLElement {
	tab.display();
	const text = featureCards(tab)[0].querySelector(".effortless-card-text") as HTMLElement;
	text.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	return featureCards(tab)[0];
}

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
		const lines = main
			.split("\n")
			.filter((line) => line.includes("TaskConsistency") || line.includes('"task-consistency"'));
		expect(lines.map((line) => line.trim())).toEqual([
			'import { TaskConsistency } from "./features/taskConsistency";',
			'registry.register("task-consistency", (host) => new TaskConsistency(host));',
		]);
	});

	it("exports the class and the id from its index and nothing else", () => {
		expect(Object.keys(taskConsistencyModule).sort()).toEqual(["FEATURE_ID", "TaskConsistency"]);
		expect(FEATURE_ID).toBe("task-consistency");
	});

	it("reports no standing problem of its own, on start or on a recheck", async () => {
		const { registry, problems } = await startTaskConsistency(dataWith(ANSWERED));
		expect(problems.all()).toEqual([]);
		registry.recheckReadiness();
		expect(problems.all()).toEqual([]);
	});
});

describe("the closed row on the settings screen", () => {
	it("names Task consistency and shows its description while it runs", async () => {
		const { tab } = await startTaskConsistency(dataWith(ANSWERED));
		expect(closedRow(tab)).toEqual({
			name: "Task consistency",
			line: "Keeps a task's line the same in its collection and in the day's log, editing one field at a time.",
			badge: "Running",
		});
	});

	it("shows the phone reason, with the Not available badge, under Platform.isMobile", async () => {
		Platform.isMobile = true;
		const { tab } = await startTaskConsistency(dataWith(ANSWERED));
		expect(closedRow(tab)).toEqual({
			name: "Task consistency",
			line: "Task consistency does not run on a phone.",
			badge: "Not available here",
		});
	});

	it("shows the daily-log layout missing, with the Not configured badge, when the folder is blank", async () => {
		const { tab } = await startTaskConsistency(dataWith());
		const row = closedRow(tab);
		expect(row.name).toBe("Task consistency");
		expect(row.line).toContain("daily-log folder is not set");
		expect(row.badge).toBe("Not configured");
	});

	it("has nothing to answer, and names the core settings it reads, on the open card", async () => {
		const { tab } = await startTaskConsistency(dataWith(ANSWERED));
		const card = openCard(tab);
		const body = card.querySelector(".effortless-card-body") as HTMLElement;
		expect(body.querySelectorAll(".setting-item")).toHaveLength(0);
		const line = body.textContent ?? "";
		expect(line).toContain("daily-log folder and filename");
		expect(line).toContain("tasks and completed-tasks headings");
		expect(line).toContain("today and overdue headings");
		expect(line).toContain("Your day's logs");
	});
});

describe("readiness", () => {
	it("answers unavailable under Platform.isMobile, always, whatever the layout says", async () => {
		Platform.isMobile = true;
		for (const layout of [{}, ANSWERED]) {
			const { registry } = await startTaskConsistency(dataWith(layout));
			const [status] = registry.statuses();
			expect(status.state).toBe("unavailable");
			expect(status.detail).toBe("Task consistency does not run on a phone.");
		}
	});

	it("answers unconfigured naming the folder when the daily-log folder is blank", async () => {
		const { registry } = await startTaskConsistency(dataWith({ dailyLogFolder: "", dailyLogFilename: "YYYY-MM-DD" }));
		const [status] = registry.statuses();
		expect(status.state).toBe("unconfigured");
		expect(status.detail).toBe("The daily-log folder is not set. Enter it under Folder on the Your day's logs card.");
	});

	it("answers unconfigured naming the filename when the daily-log filename is blank", async () => {
		const { registry } = await startTaskConsistency(dataWith({ dailyLogFolder: "Journal", dailyLogFilename: "" }));
		const [status] = registry.statuses();
		expect(status.state).toBe("unconfigured");
		expect(status.detail).toBe(
			"The daily-log filename pattern is not set. Enter it under Filename on the Your day's logs card.",
		);
	});

	it("answers ready with the layout answered and the tasks heading blank", async () => {
		const { registry } = await startTaskConsistency(
			dataWith({ dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD", tasksHeading: "" }),
		);
		expect(registry.statuses()[0].state).toBe("running");
	});

	it("never answers standby", async () => {
		for (const layout of [{}, ANSWERED]) {
			const { registry } = await startTaskConsistency(dataWith(layout));
			expect(registry.statuses()[0].state).not.toBe("standby");
		}
	});

	it("reads Platform.isMobile inside the check, not at module load — the stub flips between two checks", async () => {
		const { registry } = await startTaskConsistency(dataWith(ANSWERED));
		expect(registry.statuses()[0].state).toBe("running");

		Platform.isMobile = true;
		registry.recheckReadiness();
		expect(registry.statuses()[0].state).toBe("unavailable");

		Platform.isMobile = false;
		registry.recheckReadiness();
		expect(registry.statuses()[0].state).toBe("running");
	});
});

describe("the hook a switch to ready runs", () => {
	it("is run when the feature starts ready, and not when it starts unconfigured", async () => {
		const runNow = vi.spyOn(TaskConsistency.prototype as unknown as { runNow(): void }, "runNow");
		try {
			await startTaskConsistency(dataWith());
			expect(runNow).not.toHaveBeenCalled();
			await startTaskConsistency(dataWith(ANSWERED));
			expect(runNow).toHaveBeenCalledTimes(1);
		} finally {
			runNow.mockRestore();
		}
	});

	it("is not run when the feature starts unavailable on a phone", async () => {
		Platform.isMobile = true;
		const runNow = vi.spyOn(TaskConsistency.prototype as unknown as { runNow(): void }, "runNow");
		try {
			await startTaskConsistency(dataWith(ANSWERED));
			expect(runNow).not.toHaveBeenCalled();
		} finally {
			runNow.mockRestore();
		}
	});
});
