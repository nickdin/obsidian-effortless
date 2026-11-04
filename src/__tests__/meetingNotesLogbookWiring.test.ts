/**
 * The logbook as the real meeting-notes feature wires it: a rename
 * Obsidian reports reaches the memory, the line is written in the vault's own
 * link format, and a memory entry of the wrong shape is named once at load.
 *
 * The real feature registry, settings store and device store over the
 * Obsidian stub, as `meetingNotesFeature.test.ts` drives them. Every path is
 * invented.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin, Vault as ObsidianVault } from "obsidian";
import { App, Notice, Plugin, resetSettings } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { Collections } from "../core/collections";
import type { FeatureHost } from "../core/feature";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore, defaultData } from "../core/settings";
import { FEATURE_ID, MeetingNotes } from "../features/meetingNotes";
import { runLogbook } from "../features/meetingNotes/logbook";
import { LOGBOOK_SETTLE_MS } from "../features/meetingNotes/logbookKeeper";
import { logbookLine, logbookPorts } from "../features/meetingNotes/logbookPorts";

async function start(slice: Record<string, unknown>, collections: Collections = { all: () => [], at: () => null }): Promise<Plugin> {
	const plugin = new Plugin();
	plugin.seedData({ ...defaultData(), features: { [FEATURE_ID]: slice } });
	plugin.load();
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const notes = new NoteWriter(plugin.app.vault as unknown as ObsidianVault, { path: () => null, onChange: () => undefined });
	const calendar: Calendar = {
		meetingsOn: () => [],
		presenceBetween: () => ({ whole: false, meetings: [] }),
		refresh: async () => {},
	};
	const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
	device.save({ buildsTheDays: true });
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections, problems: new Problems(), device },
		notes,
		calendar,
	);
	registry.register(FEATURE_ID, (host: FeatureHost) => new MeetingNotes(host));
	registry.start();
	return plugin;
}

function lastSavedSlice(plugin: Plugin): Record<string, unknown> {
	return JSON.parse(plugin.saved[plugin.saved.length - 1]).features[FEATURE_ID];
}

beforeEach(() => {
	Notice.messages = [];
	resetSettings();
});

describe("the logbook in the meeting-notes feature", () => {
	it("follows a meeting note Obsidian reports renamed in its memory of the lines it wrote", async () => {
		const plugin = await start({
			meetingNotesFolder: "Meetings",
			logbook: { "Areas/Garden.md": [{ note: "Meetings/2026-10-01 Shed.md", line: "- [[2026-10-01 Shed]]" }] },
		});
		plugin.app.vault.files.push({ path: "Meetings/2026-10-02 Shed.md" });
		plugin.app.vault.fire("rename", { path: "Meetings/2026-10-02 Shed.md" }, "Meetings/2026-10-01 Shed.md");

		await vi.waitFor(() => expect(plugin.saved.length).toBeGreaterThan(0));
		expect(lastSavedSlice(plugin).logbook).toEqual({
			"Areas/Garden.md": [
				{ note: "Meetings/2026-10-02 Shed.md", line: "- [[2026-10-02 Shed]]", was: "- [[2026-10-01 Shed]]" },
			],
		});
	});

	// The feature's refused line start reaching the keeper: with the
	// same vault, a usable start writes the line and a refused one writes nothing.
	it.each([
		["- [i]", "# Garden\n## Logbook\n- [i] [[2026-10-01 Shed]]\n"],
		["- [i] ", "# Garden\n## Logbook\n"],
	])("with the line start %j stored, leaves the collection as %j after a meeting note naming it changes", async (lineStart, after) => {
		vi.useFakeTimers();
		try {
			const garden = "Areas/Garden.md";
			const shed = "Meetings/2026-10-01 Shed.md";
			const collections: Collections = {
				all: () => [],
				at: (path) => (path === garden ? ({ path } as unknown as ReturnType<Collections["at"]>) : null),
			};
			const plugin = await start({ meetingNotesFolder: "Meetings", template: { logbookLineStart: lineStart } }, collections);
			const { vault, metadataCache } = plugin.app;
			vault.files.push({ path: garden, stat: { ctime: 0 } } as never, { path: shed, stat: { ctime: 0 } } as never);
			vault.allowReads({ [garden]: "# Garden\n## Logbook\n" });
			const shedCache = { frontmatter: { tags: ["meeting"], effort: "[[Garden]]" } };
			metadataCache.caches.set(garden, { headings: [{ heading: "Logbook", level: 2 }] });
			metadataCache.caches.set(shed, shedCache);

			metadataCache.fire("changed", { path: shed }, "", shedCache);
			await vi.advanceTimersByTimeAsync(LOGBOOK_SETTLE_MS);
			await vi.waitFor(() => expect(vault.readableContents()?.get(garden)).toBe(after));
		} finally {
			vi.useRealTimers();
		}
	});

	it("names a logbook memory entry of the wrong shape in one notice at load", async () => {
		await start({ meetingNotesFolder: "Meetings", logbook: { "Areas/Garden.md": [{ note: 4 }] } });
		expect(Notice.messages).toEqual([
			'Effortless: meeting notes dropped an entry of the wrong shape from its memory of the logbook lines it has written, for "Areas/Garden.md".',
		]);
	});
});

describe("logbookLine", () => {
	it("writes the link in the vault's own link format", () => {
		const app = new App();
		app.vault.files.push({ path: "Meetings/2026-10-01 Shed.md" });
		const asApp = app as unknown as ObsidianApp;
		expect(logbookLine(asApp, "Meetings/2026-10-01 Shed.md", "Areas/Garden.md", "-")).toBe("- [[2026-10-01 Shed]]");
		app.fileManager.useMarkdownLinks = true;
		expect(logbookLine(asApp, "Meetings/2026-10-01 Shed.md", "Areas/Garden.md", "-")).toBe(
			"- [2026-10-01 Shed](2026-10-01%20Shed.md)",
		);
		expect(logbookLine(asApp, "Meetings/gone.md", "Areas/Garden.md", "-")).toBeNull();
	});

	it("starts the line with the line start it is given, then a space and the link", () => {
		const app = new App();
		app.vault.files.push({ path: "Meetings/2026-10-01 Shed.md" });
		const asApp = app as unknown as ObsidianApp;
		expect(logbookLine(asApp, "Meetings/2026-10-01 Shed.md", "Areas/Garden.md", "- [i]")).toBe("- [i] [[2026-10-01 Shed]]");
	});
});

/**
 * The composition #1269 relies on: the real ports over the Obsidian stub and
 * the real note writer, the pass and the section rewrite together. A
 * remembered line in the old shape is claimed by its exact text and written
 * back in the new one; a hand-written line beside it is left byte-for-byte.
 */
describe("the logbook pass over the real ports, after the line start changed", () => {
	it("rewrites the feature's own line from - to - [i] and leaves the hand-written lines as they were", async () => {
		const app = new App();
		const garden = "Areas/Garden.md";
		const shed = "Meetings/2026-10-01 Shed.md";
		const pond = "Meetings/2026-09-01 Pond.md";
		// `TFile.stat.ctime`, which the ports read for a meeting's date; the stub's file carries only a path.
		const file = (path: string) => ({ path, stat: { ctime: 0 } });
		app.vault.files.push(file(garden), file(shed), file(pond));
		app.vault.allowReads({
			[garden]: "# Garden\n## Tasks\n- [ ] Dig\n## Logbook\n- [[2026-10-01 Shed]]\n- [[2026-09-01 Pond]]\n- [i] [[Fence talk]]\n",
		});
		app.metadataCache.caches.set(garden, { headings: [{ heading: "Logbook", level: 2 }] });
		app.metadataCache.caches.set(shed, { frontmatter: { tags: ["meeting"], effort: "[[Garden]]" } });
		app.metadataCache.caches.set(pond, { frontmatter: { tags: ["meeting"], effort: "[[Garden]]" } });
		const notes = new NoteWriter(app.vault as unknown as ObsidianVault, { path: () => null, onChange: () => undefined });
		const collections: Collections = {
			all: () => [],
			at: (path) => (path === garden ? ({ path } as unknown as ReturnType<Collections["at"]>) : null),
		};

		const ports = logbookPorts(app as unknown as ObsidianApp, notes, collections, "- [i]");
		const result = await runLogbook(ports, { tag: "meeting", effortField: "effort" }, "## Logbook", {
			[garden]: [{ note: shed, line: "- [[2026-10-01 Shed]]" }],
		});

		expect(app.vault.readableContents()?.get(garden)).toBe(
			"# Garden\n## Tasks\n- [ ] Dig\n## Logbook\n- [i] [[2026-10-01 Shed]]\n- [[2026-09-01 Pond]]\n- [i] [[Fence talk]]\n",
		);
		expect(result).toEqual({ memory: { [garden]: [{ note: shed, line: "- [i] [[2026-10-01 Shed]]" }] }, failed: [] });
	});
});
