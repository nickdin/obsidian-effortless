/**
 * Task consistency's own triggers: a relevant file
 * changing schedules a debounced check of that file alone; the periodic
 * sweep runs ten seconds after start and every fifteen minutes after; and a
 * file already being checked drops a second trigger rather than joining it.
 *
 * Drives the real `FeatureRegistry`, the real `SettingsStore` and a real
 * `NoteWriter` over the Obsidian stub — the same shape
 * `daysAheadRunTimers.test.ts` and `meetingNotesRunTimers.test.ts` use —
 * because what these tests assert is whether a real vault event and a real
 * timer, registered the real way, actually reach a real check. `run.ts`'s own
 * orchestration — what one check over a collection or a log actually decides
 * — is `taskConsistencyRun.test.ts`'s job; these tests only count how many
 * times it was asked to run.
 *
 * Every collection, note and task below is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin, Vault as ObsidianVault } from "obsidian";
import { Plugin, resetSettings } from "./__mocks__/obsidian";
import type { TFile } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { Collection, Collections } from "../core/collections";
import type { FeatureHost } from "../core/feature";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore, defaultData } from "../core/settings";
import type { EffortlessData, VaultLayout } from "../core/settings";
import { dailyLogFrame, dailyLogPath } from "../core/vaultLayout";
import { FEATURE_ID, TaskConsistency } from "../features/taskConsistency";

const ANSWERED: Partial<VaultLayout> = {
	dailyLogFolder: "Journal",
	dailyLogFilename: "YYYY-MM-DD",
};

function dataWith(layout: Partial<VaultLayout> = {}): EffortlessData {
	const data = defaultData();
	return { ...data, core: { ...data.core, layout: { ...data.core.layout, ...ANSWERED, ...layout } } };
}

const COLLECTION_PATH = "Errands.md";

function collectionOf(overrides: Partial<Collection> = {}): Collection {
	return { path: COLLECTION_PATH, name: "Errands", headingLine: 0, headingLevel: 2, openTasks: 1, ...overrides };
}

interface Started {
	readonly plugin: Plugin;
	readonly registry: FeatureRegistry;
	readonly feature: TaskConsistency;
	readonly problems: Problems;
}

/** Starts the plugin with `task-consistency` registered, its own vault shared between `host.app` and `host.notes`. */
async function startTaskConsistency(data: EffortlessData, collections: Collections): Promise<Started> {
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
	const calendar: Calendar = { meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} };
	const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
	const problems = new Problems();
	const registry = new FeatureRegistry(plugin as unknown as ObsidianPlugin, { settings, collections, problems, device }, notes, calendar);
	let feature: TaskConsistency | undefined;
	registry.register(FEATURE_ID, (host: FeatureHost) => (feature = new TaskConsistency(host)));
	registry.start();
	return { plugin, registry, feature: feature!, problems };
}

/** Seeds the stub vault with a collection note and today's day's log, both readable, and fires `modify` for `path`. */
function seedFiles(plugin: Plugin, today: Date, layout: VaultLayout): { collectionFile: TFile; todayFile: TFile } {
	const todayPath = dailyLogPath(today, layout);
	const contents = new Map([
		[COLLECTION_PATH, `## ${layout.tasksHeading}\n- [ ] Buy stamps ⏳ 2026-09-22\n`],
		[todayPath, dailyLogFrame(layout)],
	]);
	plugin.app.vault.allowReads(Object.fromEntries(contents));
	const collectionFile: TFile = { path: COLLECTION_PATH };
	const todayFile: TFile = { path: todayPath };
	plugin.app.vault.files.push(collectionFile, todayFile);
	return { collectionFile, todayFile };
}

beforeEach(() => {
	resetSettings();
	vi.useFakeTimers();
	vi.setSystemTime(new Date(2026, 8, 22, 9, 0));
});
afterEach(() => {
	vi.useRealTimers();
});

const DEBOUNCE_MS = 2_000;
const TEN_SECONDS = 10_000;
const FIFTEEN_MINUTES = 15 * 60 * 1000;

describe("a collection changing", () => {
	it("schedules one check after the debounce, and three edits inside the window schedule one", async () => {
		const today = new Date(2026, 8, 22, 9, 0);
		const layout = { ...defaultData().core.layout, ...ANSWERED };
		const { plugin } = await startTaskConsistency(dataWith(), { all: () => [collectionOf()], at: (p) => (p === COLLECTION_PATH ? collectionOf() : null) });
		seedFiles(plugin, today, layout);

		let processCalls = 0;
		const originalProcess = plugin.app.vault.process.bind(plugin.app.vault);
		vi.spyOn(plugin.app.vault, "process").mockImplementation((f, fn) => {
			if (f.path === COLLECTION_PATH) processCalls += 1;
			return originalProcess(f, fn);
		});

		plugin.app.vault.fire("modify", { path: COLLECTION_PATH });
		await vi.advanceTimersByTimeAsync(500);
		plugin.app.vault.fire("modify", { path: COLLECTION_PATH });
		await vi.advanceTimersByTimeAsync(500);
		plugin.app.vault.fire("modify", { path: COLLECTION_PATH });

		// Still inside the debounce window from the third edit: nothing ran yet.
		await vi.advanceTimersByTimeAsync(500);
		expect(processCalls).toBe(0);

		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
		expect(processCalls).toBe(1);
	});

	it("does nothing for a note the collections index does not call a collection", async () => {
		const today = new Date(2026, 8, 22, 9, 0);
		const layout = { ...defaultData().core.layout, ...ANSWERED };
		const { plugin } = await startTaskConsistency(dataWith(), { all: () => [], at: () => null });
		seedFiles(plugin, today, layout);

		let reads = 0;
		vi.spyOn(plugin.app.vault, "read").mockImplementation(async () => {
			reads += 1;
			return "";
		});

		plugin.app.vault.fire("modify", { path: "Unrelated.md" });
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1_000);

		expect(reads).toBe(0);
	});
});

describe("one run per file at a time", () => {
	it("remembers a trigger for a file mid-run and reruns once the lock releases, with no re-run loop", async () => {
		const today = new Date(2026, 8, 22, 9, 0);
		const layout = { ...defaultData().core.layout, ...ANSWERED };
		const { plugin } = await startTaskConsistency(dataWith(), { all: () => [collectionOf()], at: (p) => (p === COLLECTION_PATH ? collectionOf() : null) });
		seedFiles(plugin, today, layout);

		let releaseFirstRead: (() => void) | null = null;
		let starts = 0;
		const realRead = plugin.app.vault.read.bind(plugin.app.vault);
		vi.spyOn(plugin.app.vault, "read").mockImplementation(async (f: TFile) => {
			if (f.path === COLLECTION_PATH) {
				starts += 1;
				if (starts === 1) {
					await new Promise<void>((resolve) => {
						releaseFirstRead = resolve;
					});
				}
			}
			return realRead(f);
		});

		// The stub vault's own `process` (`__mocks__/obsidian.ts`) writes the map
		// and fires no `modify` — unlike a real vault, so no write in this
		// fixture could ever schedule the "standard self-check" the comments
		// below name, and the no-loop assertions could not have failed. Local to this test only, so no other test sees a `process`
		// that fires events: after the collection's own write lands, fire
		// `modify` for it the way Obsidian does, so a run that re-queued itself
		// on every write would keep `starts` climbing rather than settle.
		const originalProcess = plugin.app.vault.process.bind(plugin.app.vault);
		vi.spyOn(plugin.app.vault, "process").mockImplementation((f, fn) => {
			const result = originalProcess(f, fn);
			if (f.path === COLLECTION_PATH) void result.then(() => plugin.app.vault.fire("modify", { path: f.path }));
			return result;
		});

		plugin.app.vault.fire("modify", { path: COLLECTION_PATH });
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
		// The first run has started and is parked on its own first read.
		expect(starts).toBe(1);

		// A second edit arrives while the first run is still in flight.
		plugin.app.vault.fire("modify", { path: COLLECTION_PATH });
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
		// Still locked: remembered rather than dropped, so no second run has
		// started yet — this is the assertion that fails against today's code,
		// which drops the trigger here and never runs it again on its own.
		expect(starts).toBe(1);

		releaseFirstRead!();
		await vi.advanceTimersByTimeAsync(0);
		// The remembered rerun starts on its own the moment the lock is free —
		// no third `modify` was fired for it. The first run's own `[/]` write to
		// the collection, landed inside it, already fired this fixture's own
		// `modify` — a real debounced check now waiting in the timer queue, not
		// yet due, so it has not started.
		expect(starts).toBe(2);

		// The rerun's own read finds the task already marked by the first run
		// and writes nothing, so it schedules no further check of its own. The
		// first run's own write-triggered `modify` now reaches its debounce and
		// starts the standard self-check the comment above named — its own read
		// finds nothing left to change either, so it schedules nothing further.
		// `starts` is 3 by the end of this window (run, remembered rerun,
		// self-check) — not asserted as a literal here because this same window
		// (4s to 10s after load) also crosses the ten-second mark where the
		// feature's own first periodic sweep fires regardless of any of this
		// (`runNow`, `FIRST_RUN_DELAY_MS`) and reads the collection too, making
		// it 4 — still one read each, still nothing left for any of them to
		// write. Settling, not the exact count, is what the next window
		// asserts: with a `guardedRun` deliberately changed to replay
		// unconditionally (`this.pendingRerun.add(path); void
		// this.checkPath(path);` in its `finally`, rather than only on a
		// remembered trigger) `starts` keeps climbing through this second
		// window instead of holding still — recorded, with both runs' counts,
		// in this ticket's closing comment; reverted here, not left in the
		// source.
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3);
		const settledAt = starts;
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3);
		expect(starts).toBe(settledAt);
	});

	it("does not replay a rerun remembered under the lock once the feature has been switched off", async () => {
		const today = new Date(2026, 8, 22, 9, 0);
		const layout = { ...defaultData().core.layout, ...ANSWERED };
		const { plugin, feature } = await startTaskConsistency(dataWith(), { all: () => [collectionOf()], at: (p) => (p === COLLECTION_PATH ? collectionOf() : null) });
		seedFiles(plugin, today, layout);

		let releaseFirstRead: (() => void) | null = null;
		let starts = 0;
		const realRead = plugin.app.vault.read.bind(plugin.app.vault);
		vi.spyOn(plugin.app.vault, "read").mockImplementation(async (f: TFile) => {
			if (f.path === COLLECTION_PATH) {
				starts += 1;
				if (starts === 1) {
					await new Promise<void>((resolve) => {
						releaseFirstRead = resolve;
					});
				}
			}
			return realRead(f);
		});

		plugin.app.vault.fire("modify", { path: COLLECTION_PATH });
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
		expect(starts).toBe(1);

		// A second edit arrives while the run is still parked on its own first
		// read — remembered rather than dropped.
		plugin.app.vault.fire("modify", { path: COLLECTION_PATH });
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
		expect(starts).toBe(1);

		// The person switches Task consistency off while the run is still
		// parked — the same window #915 names: the lock is held across the
		// parked write for as long as the note the person has open stays open
		// (`noteWriter.ts`, ADR 0002).
		feature.unload();

		releaseFirstRead!();
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3);
		// The remembered rerun must not run once the feature is off. Today's
		// code replays it anyway: `starts` reads 2 there.
		expect(starts).toBe(1);
	});
});

describe("the periodic sweep", () => {
	it("runs once ten seconds after start and every fifteen minutes after", async () => {
		const today = new Date(2026, 8, 22, 9, 0);
		const layout = { ...defaultData().core.layout, ...ANSWERED };
		let sweeps = 0;
		const collections: Collections = {
			all: () => {
				sweeps += 1;
				return [];
			},
			at: () => null,
		};
		const { plugin } = await startTaskConsistency(dataWith(), collections);
		seedFiles(plugin, today, layout);

		expect(sweeps).toBe(0);
		await vi.advanceTimersByTimeAsync(TEN_SECONDS);
		expect(sweeps).toBe(1);

		await vi.advanceTimersByTimeAsync(FIFTEEN_MINUTES);
		expect(sweeps).toBe(2);

		await vi.advanceTimersByTimeAsync(FIFTEEN_MINUTES);
		expect(sweeps).toBe(3);
	});

	it("a second tick while a sweep is in flight starts no second sweep", async () => {
		const today = new Date(2026, 8, 22, 9, 0);
		const layout = { ...defaultData().core.layout, ...ANSWERED };
		const { plugin } = await startTaskConsistency(dataWith(), { all: () => [collectionOf()], at: (p) => (p === COLLECTION_PATH ? collectionOf() : null) });
		seedFiles(plugin, today, layout);

		let releaseFirstRead: (() => void) | null = null;
		let starts = 0;
		const realRead = plugin.app.vault.read.bind(plugin.app.vault);
		vi.spyOn(plugin.app.vault, "read").mockImplementation(async (f: TFile) => {
			if (f.path === COLLECTION_PATH) {
				starts += 1;
				if (starts === 1) {
					await new Promise<void>((resolve) => {
						releaseFirstRead = resolve;
					});
				}
			}
			return realRead(f);
		});

		await vi.advanceTimersByTimeAsync(TEN_SECONDS);
		expect(starts).toBe(1);

		// The fifteen-minute tick fires while the first sweep is still parked on
		// its own collection read — a second sweep must not also start.
		await vi.advanceTimersByTimeAsync(FIFTEEN_MINUTES);
		expect(starts).toBe(1);

		releaseFirstRead!();
		await vi.advanceTimersByTimeAsync(0);

		// Now that the first sweep has finished, the next fifteen-minute tick is
		// the next real chance.
		await vi.advanceTimersByTimeAsync(FIFTEEN_MINUTES);
		expect(starts).toBe(2);
	});
});

describe("a collection changing more than once inside the debounce window", () => {
	it("collapses to one check that sees only the final content, not one per edit", async () => {
		const today = new Date(2026, 8, 22, 9, 0);
		const layout = { ...defaultData().core.layout, ...ANSWERED };
		const { plugin } = await startTaskConsistency(dataWith(), { all: () => [collectionOf()], at: (p) => (p === COLLECTION_PATH ? collectionOf() : null) });
		seedFiles(plugin, today, layout);

		// The collection's own content grows between edits — a fixture where a
		// check that ran once per edit, rather than once after the debounce,
		// would find something new to write each time rather than a no-op.
		const baseMs = Date.now();
		const realRead = plugin.app.vault.read.bind(plugin.app.vault);
		vi.spyOn(plugin.app.vault, "read").mockImplementation(async (f: TFile) => {
			if (f.path !== COLLECTION_PATH) return realRead(f);
			const elapsed = Date.now() - baseMs;
			const tasks = ["Buy stamps", ...(elapsed >= 2000 ? ["Pay the rent"] : []), ...(elapsed >= 2500 ? ["Water the plants"] : [])];
			return `## ${layout.tasksHeading}\n${tasks.map((task) => `- [ ] ${task} ⏳ 2026-09-20`).join("\n")}\n`;
		});

		let processCalls = 0;
		const originalProcess = plugin.app.vault.process.bind(plugin.app.vault);
		vi.spyOn(plugin.app.vault, "process").mockImplementation((f, fn) => {
			if (f.path === COLLECTION_PATH) processCalls += 1;
			return originalProcess(f, fn);
		});

		plugin.app.vault.fire("modify", { path: COLLECTION_PATH });
		await vi.advanceTimersByTimeAsync(500);
		plugin.app.vault.fire("modify", { path: COLLECTION_PATH });
		await vi.advanceTimersByTimeAsync(500);
		plugin.app.vault.fire("modify", { path: COLLECTION_PATH });
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

		expect(processCalls).toBe(1);
	});
});

describe("a debounced log check that fails", () => {
	it("reports one standing problem and clears it once a later check succeeds", async () => {
		const today = new Date(2026, 8, 22, 9, 0);
		const layout = { ...defaultData().core.layout, ...ANSWERED };
		const { plugin, problems } = await startTaskConsistency(dataWith(), { all: () => [], at: () => null });
		const { todayFile } = seedFiles(plugin, today, layout);

		let rejectNext = true;
		const realRead = plugin.app.vault.read.bind(plugin.app.vault);
		vi.spyOn(plugin.app.vault, "read").mockImplementation(async (f: TFile) => {
			if (f.path === todayFile.path && rejectNext) {
				rejectNext = false;
				throw new Error("boom");
			}
			return realRead(f);
		});

		plugin.app.vault.fire("modify", { path: todayFile.path });
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

		expect(problems.all().some((p) => p.key === `run-failed:${todayFile.path}`)).toBe(true);

		// A later trigger over the same path succeeds and clears it.
		plugin.app.vault.fire("modify", { path: todayFile.path });
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

		expect(problems.all().some((p) => p.key === `run-failed:${todayFile.path}`)).toBe(false);
	});
});

describe("the refused-log-write report and the log check's own failure report", () => {
	it("a successful check of the log does not clear a standing refused-log-write report", async () => {
		const today = new Date(2026, 8, 22, 9, 0);
		const layout = { ...defaultData().core.layout, ...ANSWERED };
		const { plugin, problems } = await startTaskConsistency(dataWith(), {
			all: () => [collectionOf()],
			at: (p) => (p === COLLECTION_PATH ? collectionOf() : null),
		});
		const { todayFile } = seedFiles(plugin, today, layout);

		// The log's own write, the first time it is attempted, finds the note
		// changed underneath it — the same refusal a real `NoteWriter` gives once
		// a parked write reaches the front of the queue and the note has moved on
		// (`noteWriter.ts`, ADR 0002).
		let refuseNextLogWrite = true;
		const originalProcess = plugin.app.vault.process.bind(plugin.app.vault);
		vi.spyOn(plugin.app.vault, "process").mockImplementation((f, fn) => {
			if (f.path === todayFile.path && refuseNextLogWrite) {
				refuseNextLogWrite = false;
				const contents = plugin.app.vault.readableContents();
				const stale = `${contents?.get(f.path) ?? ""}\n`;
				const changed = fn(stale);
				contents?.set(f.path, changed);
				return Promise.resolve(changed);
			}
			return originalProcess(f, fn);
		});

		plugin.app.vault.fire("modify", { path: COLLECTION_PATH });
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

		expect(problems.all().some((p) => p.key === `log-write-refused:${COLLECTION_PATH}`)).toBe(true);

		// A change to the log itself now runs a plain check of the log, which
		// finds nothing of its own to report and succeeds. Today's code clears
		// the refused-log-write report here too, because it shares the log
		// check's own key — this assertion fails there.
		plugin.app.vault.fire("modify", { path: todayFile.path });
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

		expect(problems.all().some((p) => p.key === `log-write-refused:${COLLECTION_PATH}`)).toBe(true);
	});

	it("a collection's run whose log write lands does not clear a standing log-check-failure report", async () => {
		const today = new Date(2026, 8, 22, 9, 0);
		const layout = { ...defaultData().core.layout, ...ANSWERED };
		const { plugin, problems } = await startTaskConsistency(dataWith(), {
			all: () => [collectionOf()],
			at: (p) => (p === COLLECTION_PATH ? collectionOf() : null),
		});
		const { todayFile } = seedFiles(plugin, today, layout);

		let rejectNextLogRead = true;
		const realRead = plugin.app.vault.read.bind(plugin.app.vault);
		vi.spyOn(plugin.app.vault, "read").mockImplementation(async (f: TFile) => {
			if (f.path === todayFile.path && rejectNextLogRead) {
				rejectNextLogRead = false;
				throw new Error("boom");
			}
			return realRead(f);
		});

		plugin.app.vault.fire("modify", { path: todayFile.path });
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

		expect(problems.all().some((p) => p.key === `run-failed:${todayFile.path}`)).toBe(true);

		// A change to the collection now runs an ordinary collection check, which
		// reads and writes the log successfully. Today's code clears the
		// log-check-failure report here too, because a landed log write shares
		// its key — this assertion fails there.
		plugin.app.vault.fire("modify", { path: COLLECTION_PATH });
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

		expect(problems.all().some((p) => p.key === `run-failed:${todayFile.path}`)).toBe(true);
	});
});
