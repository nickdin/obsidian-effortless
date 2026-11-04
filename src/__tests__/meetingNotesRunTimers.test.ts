/**
 * Meeting notes' own two timers:
 * ten seconds after start, then every fifteen minutes; one run at a time;
 * both timers stop when the feature is switched off; and a switch to `ready`
 * — the device coming out of `standby`, or the folder box making the feature
 * ready — runs it with no reload.
 *
 * Drives the real `FeatureRegistry`, the real `SettingsStore` and a real
 * `NoteWriter` built with `plugin.app.fileManager`, the same shape
 * `daysAheadRunTimers.test.ts` uses, because what these tests assert is
 * whether a real timer, registered the real way, actually reaches Obsidian's
 * own writer — including, for the last suite below, whether a rename reaches
 * `fileManager.renameFile` and not `vault.rename` through the real plugin's
 * own construction of `NoteWriter` (`src/main.ts:79`), the wiring the
 * 2026-09-21 afternoon board run's wave 1 left for this ticket to supply.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App as ObsidianApp, FileManager as ObsidianFileManager, Plugin as ObsidianPlugin, TFile, Vault as ObsidianVault } from "obsidian";
import { App, Plugin, resetSettings } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { Meeting } from "../core/icsReader";
import type { Collections } from "../core/collections";
import type { FeatureHost } from "../core/feature";
import type { NoteWriter as RealNoteWriter } from "../core/noteWriter";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore, defaultData } from "../core/settings";
import type { EffortlessData, VaultLayout } from "../core/settings";
import { FEATURE_ID, MeetingNotes } from "../features/meetingNotes";
import EffortlessPlugin from "../main";

/**
 * Every `NoteWriter` the entry point builds, in order — the same technique
 * `main.test.ts` uses and explains: the writer is a local inside `onload`
 * with no route out, so watching the constructor is the only way to reach
 * the instance the real plugin actually built.
 */
const writers = vi.hoisted(() => [] as RealNoteWriter[]);

vi.mock("../core/noteWriter", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/noteWriter")>();
	return {
		...actual,
		NoteWriter: class extends actual.NoteWriter {
			constructor(...args: ConstructorParameters<typeof actual.NoteWriter>) {
				super(...args);
				writers.push(this);
			}
		},
	};
});

/** A daily-log layout with the folder and filename both answered — created's own day link needs it. */
const ANSWERED_LAYOUT: Partial<VaultLayout> = {
	dailyLogFolder: "Journal",
	dailyLogFilename: "YYYY-MM-DD",
};

/** This feature's own slice, the folder answered by default. */
function dataWith(featureSlice: Record<string, unknown> = {}, layout: Partial<VaultLayout> = {}): EffortlessData {
	const data = defaultData();
	return {
		...data,
		core: { ...data.core, layout: { ...data.core.layout, ...ANSWERED_LAYOUT, ...layout } },
		features: { [FEATURE_ID]: { meetingNotesFolder: "Meetings", ...featureSlice } },
	};
}

function meeting(partial: Partial<Meeting> = {}): Meeting {
	return {
		uid: "uid-1",
		summary: "Weekly sync",
		location: null,
		description: null,
		organizer: null,
		attendees: [],
		occurrenceKey: null,
		allDay: false,
		start: new Date(2026, 8, 21, 9, 0),
		end: new Date(2026, 8, 21, 9, 30),
		...partial,
	};
}

/** A calendar that counts its own `refresh` calls and answers `meetings` for every day it is asked about. */
function countingCalendar(meetings: readonly Meeting[] = []): { calendar: Calendar; refreshCalls: () => number } {
	let calls = 0;
	return {
		calendar: {
			meetingsOn: () => meetings,
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
	readonly feature: MeetingNotes;
}

/**
 * Starts the plugin with `meeting-notes` registered, its own vault shared
 * between `host.app` and `host.notes`, and `plugin.app.fileManager` wired
 * into the writer — the same construction `src/main.ts` makes.
 */
async function startMeetingNotes(data: EffortlessData, buildsTheDays: boolean, calendar: Calendar): Promise<Started> {
	const plugin = new Plugin();
	plugin.seedData(data);
	plugin.load();
	plugin.app.vault.allowReads();

	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const notes = new NoteWriter(
		plugin.app.vault as unknown as ObsidianVault,
		{ path: () => null, onChange: () => undefined },
		plugin.app.fileManager as unknown as ObsidianFileManager,
	);
	const collections: Collections = { all: () => [], at: () => null };
	const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
	device.save({ buildsTheDays });
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections, problems: new Problems(), device },
		notes,
		calendar,
	);
	let feature: MeetingNotes | undefined;
	registry.register(FEATURE_ID, (host: FeatureHost) => (feature = new MeetingNotes(host)));
	registry.start();
	return { plugin, registry, device, feature: feature! };
}

beforeEach(() => {
	resetSettings();
	vi.useFakeTimers();
	vi.setSystemTime(new Date(2026, 8, 21, 8, 0));
});
afterEach(() => {
	vi.useRealTimers();
});

const TEN_SECONDS = 10_000;
const FIFTEEN_MINUTES = 15 * 60 * 1000;

describe("the two timers", () => {
	it("runs for the first time about ten seconds after the feature starts", async () => {
		const { calendar, refreshCalls } = countingCalendar();
		await startMeetingNotes(dataWith(), true, calendar);

		expect(refreshCalls()).toBe(0);
		await vi.advanceTimersByTimeAsync(TEN_SECONDS);
		expect(refreshCalls()).toBe(1);
	});

	it("runs again about every fifteen minutes after that", async () => {
		const { calendar, refreshCalls } = countingCalendar();
		await startMeetingNotes(dataWith(), true, calendar);

		await vi.advanceTimersByTimeAsync(TEN_SECONDS);
		expect(refreshCalls()).toBe(1);

		await vi.advanceTimersByTimeAsync(FIFTEEN_MINUTES);
		expect(refreshCalls()).toBe(2);

		await vi.advanceTimersByTimeAsync(FIFTEEN_MINUTES);
		expect(refreshCalls()).toBe(3);
	});

	it("stops both timers when the feature is switched off", async () => {
		const { calendar, refreshCalls } = countingCalendar();
		const { registry } = await startMeetingNotes(dataWith(), true, calendar);

		await vi.advanceTimersByTimeAsync(TEN_SECONDS);
		expect(refreshCalls()).toBe(1);

		await registry.setEnabled(FEATURE_ID, false);
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

		await startMeetingNotes(dataWith(), true, calendar);

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

describe("a run in flight across a reload", () => {
	it("resets runInFlight on a fresh load, so a run parked from a previous load does not block every tick after it", async () => {
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

		const { registry } = await startMeetingNotes(dataWith(), true, calendar);

		await vi.advanceTimersByTimeAsync(TEN_SECONDS);
		expect(calls).toBe(1);

		// The feature stands down while its run is still parked on
		// calendar.refresh() — the same shape a write parked on the person's
		// open note takes, since only the plugin's own teardown, not this
		// feature's unload, rejects a parked write (`noteWriter.ts:264-274`).
		await registry.setEnabled(FEATURE_ID, false);
		await registry.setEnabled(FEATURE_ID, true);

		// The fresh load's own first-run timer fires ten seconds later — this
		// must start a genuinely new run rather than finding `runInFlight`
		// still `true` from the load that never finished.
		await vi.advanceTimersByTimeAsync(TEN_SECONDS);
		expect(calls).toBe(2);

		// Letting the stale run's own refresh resolve now must not disturb the
		// fresh run's own in-flight flag or block the tick after it.
		releaseRefresh!();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(FIFTEEN_MINUTES);
		expect(calls).toBe(3);
	});
});

describe("coming out of standby", () => {
	it("starts the feature and its first run through recheckReadiness alone, with no reload", async () => {
		const { calendar, refreshCalls } = countingCalendar();
		const { registry, device } = await startMeetingNotes(dataWith(), false, calendar);

		await vi.advanceTimersByTimeAsync(TEN_SECONDS + FIFTEEN_MINUTES);
		expect(refreshCalls()).toBe(0);

		device.save({ buildsTheDays: true });
		registry.recheckReadiness();
		expect(registry.statuses()[0].state).toBe("running");

		await vi.advanceTimersByTimeAsync(TEN_SECONDS);
		expect(refreshCalls()).toBe(1);
	});
});

describe("answering the folder box while the device is ready", () => {
	it("runs once, ten seconds after the box is committed, with no reload", async () => {
		const { calendar, refreshCalls } = countingCalendar();
		const { registry, feature } = await startMeetingNotes(dataWith({ meetingNotesFolder: "" }), true, calendar);
		expect(registry.statuses()[0].state).toBe("unconfigured");

		await vi.advanceTimersByTimeAsync(TEN_SECONDS + FIFTEEN_MINUTES);
		expect(refreshCalls()).toBe(0);

		// The slice changes straight away on `saveSoon` — only the file write
		// defers (`FeatureSettings.saveSoon`'s own doc comment) — so readiness
		// already reads the answered folder the moment `folderCommitted` asks,
		// the way the settings panel's own commit handler calls it.
		void feature.saveSliceSoon({ ...feature.storedSlice(), meetingNotesFolder: "Meetings" });
		feature.folderCommitted();
		expect(registry.statuses()[0].state).toBe("running");

		await vi.advanceTimersByTimeAsync(TEN_SECONDS);
		expect(refreshCalls()).toBe(1);
	});

	it("runs within ten seconds of a second answer, not the first, when the box is blanked in between", async () => {
		const { calendar, refreshCalls } = countingCalendar();
		const { feature } = await startMeetingNotes(dataWith({ meetingNotesFolder: "" }), true, calendar);

		void feature.saveSliceSoon({ ...feature.storedSlice(), meetingNotesFolder: "Meetings" });
		feature.folderCommitted();

		await vi.advanceTimersByTimeAsync(5_000);
		// Blanked again before the first answer's own ten seconds are up —
		// `folderCommitted` is a no-op while `unconfigured`, so this changes
		// nothing about the pending timer by itself.
		void feature.saveSliceSoon({ ...feature.storedSlice(), meetingNotesFolder: "" });
		feature.folderCommitted();

		await vi.advanceTimersByTimeAsync(1_000);
		// Answered again, six seconds after the very first answer. This is a
		// second crossing to `ready` within the same load, and it must start
		// its own fresh ten-second countdown rather than leaving the first
		// answer's own pending timer as the only thing that will ever fire.
		void feature.saveSliceSoon({ ...feature.storedSlice(), meetingNotesFolder: "Meetings" });
		feature.folderCommitted();

		// Ten seconds after the *first* answer (four seconds after the
		// second) — nothing has run yet if the second answer's own countdown
		// is what is actually pending.
		await vi.advanceTimersByTimeAsync(4_000);
		expect(refreshCalls()).toBe(0);

		// Ten seconds after the second answer.
		await vi.advanceTimersByTimeAsync(6_000);
		expect(refreshCalls()).toBe(1);
	});
});

describe("a run that is not ready", () => {
	it("does nothing on a tick when the folder is unanswered, and reports nothing", async () => {
		const { calendar, refreshCalls } = countingCalendar();
		const { registry } = await startMeetingNotes(dataWith({ meetingNotesFolder: "" }), true, calendar);

		expect(registry.statuses()[0].state).toBe("unconfigured");
		await vi.advanceTimersByTimeAsync(TEN_SECONDS);
		expect(refreshCalls()).toBe(0);
	});
});

describe("a second run with nothing changed", () => {
	it("creates no second note for the meeting the first run already wrote", async () => {
		const { calendar } = countingCalendar([meeting()]);
		const { plugin, feature } = await startMeetingNotes(dataWith(), true, calendar);

		// Watches the real writer's own calls, the instance `src/main.ts`'s own
		// construction technique reaches through `writers` — counting only
		// `plugin.app.vault.created` cannot tell "nothing changed, so nothing
		// written" from "the memory was never persisted, so the second run
		// adopted the note instead", since adopting also creates nothing.
		const writer = writers[writers.length - 1];
		const createSpy = vi.spyOn(writer, "create");
		const renameSpy = vi.spyOn(writer, "rename");
		const editSpy = vi.spyOn(writer, "edit");

		await vi.advanceTimersByTimeAsync(TEN_SECONDS);
		expect(plugin.app.vault.created).toHaveLength(1);
		expect(createSpy).toHaveBeenCalledTimes(1);

		// Reads the stored `notes` slice back after the first run — the
		// `startFresh` shape `main.test.ts` uses — rather than merely trusting
		// that a commit happened: an empty memory would still pass every
		// assertion below, since an unremembered note is simply adopted next
		// time, which also creates, renames and edits nothing.
		const remembered = Object.values(feature.notes()).flatMap((byDate) => Object.values(byDate));
		// `written` is #1036's record of what the run wrote, kept so a gone
		// meeting's untouched note can be deleted: the note's fingerprint, and
		// the meeting's own end, 09:30 on 2026-09-21.
		expect(remembered).toEqual([
			{
				path: plugin.app.vault.created[0],
				accounted: [],
				written: { fingerprint: expect.stringMatching(/^\d+:[0-9a-f]+$/), endsAt: new Date(2026, 8, 21, 9, 30).getTime() },
			},
		]);
		const savesAfterFirst = plugin.saved.length;
		expect(savesAfterFirst).toBeGreaterThan(0);

		createSpy.mockClear();
		renameSpy.mockClear();
		editSpy.mockClear();

		await vi.advanceTimersByTimeAsync(FIFTEEN_MINUTES);

		expect(plugin.app.vault.created).toHaveLength(1);
		expect(createSpy).not.toHaveBeenCalled();
		expect(renameSpy).not.toHaveBeenCalled();
		expect(editSpy).not.toHaveBeenCalled();
		// The load-time write has long since settled by the second tick, so a
		// count that has not moved is the second run's own doing, the
		// `startFresh` shape `main.test.ts` uses for the identical reason.
		expect(plugin.saved.length).toBe(savesAfterFirst);
	});
});

describe("the real plugin's own writer reaches fileManager.renameFile (wave 1 of the 2026-09-21 afternoon board run, on #762)", () => {
	/**
	 * `src/main.ts:79` builds the one `NoteWriter` every feature shares, as a
	 * local inside `onload` with no route out — `main.test.ts`'s own doc
	 * comment says why watching the constructor is the way to reach it. This
	 * drives that instance directly, with no calendar and no feature run in
	 * the way, to ask the one question this ticket's line answers: does a
	 * rename through the writer the real plugin built actually reach
	 * `fileManager.renameFile`, not `vault.rename`. Without
	 * `this.app.fileManager` on that line, `rename` rejects naming the
	 * missing file manager (#756's own closing comment) and the first
	 * assertion below would see nothing moved.
	 *
	 * **The wikilink elsewhere updating is the mock's own rewriting, not a
	 * guarantee about Obsidian.** `app.fileManager.renameFile` updates links
	 * "depending on the user's preferences" (`node_modules/obsidian/obsidian.d.ts:2896`)
	 * — Obsidian's own *Automatically update internal links* setting, which
	 * this mock does not model at all and always rewrites as if it were on.
	 * A drive or test that needs to say what the real application does with
	 * that setting off reads it back from the application rather than naming
	 * it (#762's own closing comment, second constraint).
	 */
	it("renames a note and updates a wikilink elsewhere that named it", async () => {
		const oldPath = "Meetings/Standup.md";
		const newPath = "Meetings/2026-09-21 Standup.md";
		const elsewherePath = "Journal/2026-09-20.md";
		const elsewhereText = "## Calendar\n\n- [[Standup]] at 09:00\n";

		const app = new App();
		const oldFile = { path: oldPath } as TFile;
		app.vault.files.push(oldFile, { path: elsewherePath } as TFile);
		app.vault.allowReads({ [oldPath]: "# Standup\n", [elsewherePath]: elsewhereText });

		// `Plugin.load()` calls `onload()` without awaiting it (the mock's own
		// `Component.load()`), so the promise is caught on the way past —
		// `main.test.ts`'s own `start()` does the same, for the same reason.
		const StubPlugin = EffortlessPlugin as unknown as new (a: App) => EffortlessPlugin;
		const plugin = new StubPlugin(app);
		let loading!: Promise<void>;
		const onload = plugin.onload.bind(plugin);
		plugin.onload = () => {
			loading = onload();
			return loading;
		};
		(plugin as unknown as { load(): void }).load();
		await loading;

		const writer = writers[writers.length - 1];
		expect(writer, "src/main.ts built no NoteWriter").toBeDefined();

		await writer.rename(oldFile, newPath);

		expect(app.vault.getFileByPath(oldPath)).toBeNull();
		expect(app.vault.getFileByPath(newPath)).not.toBeNull();
		expect(app.vault.readableContents()?.get(elsewherePath)).toBe("## Calendar\n\n- [[2026-09-21 Standup]] at 09:00\n");
	});
});
