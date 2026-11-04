/**
 * Building the days ahead's own two timers: ten
 * seconds after start, then every fifteen minutes; one run at a time; both
 * timers stop when the feature is switched off; and coming out of `standby`
 * starts the feature — and its first run — with no reload.
 *
 * Drives the real `FeatureRegistry`, the real `SettingsStore` and a real
 * `NoteWriter`, over the Obsidian stub — the same shape
 * `daysAheadFeature.test.ts` uses — because what these tests assert is
 * whether a real timer, registered the real way, actually fires a real run.
 * `host.app.vault` and the vault behind `host.notes` are the same instance
 * here, as `src/main.ts` wires them, which is what lets a run peek a file it
 * just created through the core.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin, Vault as ObsidianVault } from "obsidian";
import { Plugin, resetSettings } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { Collections } from "../core/collections";
import type { FeatureHost } from "../core/feature";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore, defaultData } from "../core/settings";
import type { EffortlessData, VaultLayout } from "../core/settings";
import { DaysAhead, FEATURE_ID } from "../features/daysAhead";

/** A layout with the folder, filename and both column names all answered. */
const ANSWERED: Partial<VaultLayout> = {
	dailyLogFolder: "Journal",
	dailyLogFilename: "YYYY-MM-DD",
	calendarColumns: { time: "Start", event: "What" },
};

function dataWith(layout: Partial<VaultLayout> = {}): EffortlessData {
	const data = defaultData();
	return { ...data, core: { ...data.core, layout: { ...data.core.layout, ...layout } } };
}

/** A calendar that counts its own `refresh` calls and resolves at once. */
function countingCalendar(): { calendar: Calendar; refreshCalls: () => number } {
	let calls = 0;
	return {
		calendar: {
			meetingsOn: () => [],
			presenceBetween: () => ({ whole: false, meetings: [] }),
			refresh: async () => {
				calls++;
			},
		},
		refreshCalls: () => calls,
	};
}

interface Started {
	readonly plugin: Plugin;
	readonly registry: FeatureRegistry;
	readonly device: DeviceStore;
	readonly feature: DaysAhead;
}

/** Starts the plugin with `days-ahead` registered, its own vault shared between `host.app` and `host.notes`. */
async function startDaysAhead(
	data: EffortlessData,
	buildsTheDays: boolean,
	calendar: Calendar,
): Promise<Started> {
	const plugin = new Plugin();
	plugin.seedData(data);
	plugin.load();
	plugin.app.vault.allowReads();

	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const notes = new NoteWriter(plugin.app.vault as unknown as ObsidianVault, {
		path: () => null,
		onChange: () => undefined,
	});
	const collections: Collections = { all: () => [], at: () => null };
	const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
	device.save({ buildsTheDays });
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections, problems: new Problems(), device },
		notes,
		calendar,
	);
	let feature: DaysAhead | undefined;
	registry.register(FEATURE_ID, (host: FeatureHost) => (feature = new DaysAhead(host)));
	registry.start();
	return { plugin, registry, device, feature: feature! };
}

beforeEach(() => {
	resetSettings();
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const TEN_SECONDS = 10_000;
const FIFTEEN_MINUTES = 15 * 60 * 1000;

describe("the two timers", () => {
	it("runs for the first time about ten seconds after the feature starts", async () => {
		const { calendar, refreshCalls } = countingCalendar();
		await startDaysAhead(dataWith(ANSWERED), true, calendar);

		expect(refreshCalls()).toBe(0);
		await vi.advanceTimersByTimeAsync(TEN_SECONDS);
		expect(refreshCalls()).toBe(1);
	});

	it("runs again about every fifteen minutes after that", async () => {
		const { calendar, refreshCalls } = countingCalendar();
		await startDaysAhead(dataWith(ANSWERED), true, calendar);

		await vi.advanceTimersByTimeAsync(TEN_SECONDS);
		expect(refreshCalls()).toBe(1);

		await vi.advanceTimersByTimeAsync(FIFTEEN_MINUTES);
		expect(refreshCalls()).toBe(2);

		await vi.advanceTimersByTimeAsync(FIFTEEN_MINUTES);
		expect(refreshCalls()).toBe(3);
	});

	it("stops both timers when the feature is switched off", async () => {
		const { calendar, refreshCalls } = countingCalendar();
		const { registry } = await startDaysAhead(dataWith(ANSWERED), true, calendar);

		await vi.advanceTimersByTimeAsync(TEN_SECONDS);
		expect(refreshCalls()).toBe(1);

		registry.setEnabled(FEATURE_ID, false);
		await vi.advanceTimersByTimeAsync(FIFTEEN_MINUTES * 3);
		expect(refreshCalls()).toBe(1);
	});

	it("a second tick while a run is in flight starts no second run", async () => {
		let releaseRefresh: (() => void) | null = null;
		let calls = 0;
		const calendar: Calendar = {
			meetingsOn: () => [],
			presenceBetween: () => ({ whole: false, meetings: [] }),
			refresh: () =>
				new Promise<void>((resolve) => {
					calls++;
					releaseRefresh = resolve;
				}),
		};

		await startDaysAhead(dataWith(ANSWERED), true, calendar);

		await vi.advanceTimersByTimeAsync(TEN_SECONDS);
		expect(calls).toBe(1);

		// The fifteen-minute tick fires while the first run's refresh is still
		// pending — the tick must do nothing rather than start a second run.
		await vi.advanceTimersByTimeAsync(FIFTEEN_MINUTES);
		expect(calls).toBe(1);

		releaseRefresh!();
		await vi.advanceTimersByTimeAsync(0);

		// Now that the first run has finished, the next fifteen-minute tick is
		// the next real chance.
		await vi.advanceTimersByTimeAsync(FIFTEEN_MINUTES);
		expect(calls).toBe(2);
	});
});

describe("coming out of standby", () => {
	it("starts the feature and its first run through recheckReadiness alone, with no reload", async () => {
		const { calendar, refreshCalls } = countingCalendar();
		const { registry, device } = await startDaysAhead(dataWith(ANSWERED), false, calendar);

		await vi.advanceTimersByTimeAsync(TEN_SECONDS + FIFTEEN_MINUTES);
		expect(refreshCalls()).toBe(0);

		device.save({ buildsTheDays: true });
		registry.recheckReadiness();
		expect(registry.statuses()[0].state).toBe("running");

		await vi.advanceTimersByTimeAsync(TEN_SECONDS);
		expect(refreshCalls()).toBe(1);
	});
});

describe("a run that is not ready", () => {
	it("does nothing on a tick when the daily-log folder is unanswered, and reports nothing", async () => {
		const { calendar, refreshCalls } = countingCalendar();
		const { registry } = await startDaysAhead(dataWith(), true, calendar);

		expect(registry.statuses()[0].state).toBe("unconfigured");
		await vi.advanceTimersByTimeAsync(TEN_SECONDS);
		expect(refreshCalls()).toBe(0);
	});
});
