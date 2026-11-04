/**
 * The findings the wave's reviews filed against the click that creates a
 * meeting's note filled in
 * (#1046: #1094, #1095,
 * #1096, #1097, #1098, #1099 and, against Review's reading, #1101).
 *
 * Every test here builds the **real** meeting notes feature through the real
 * registry and clicks through the day view's real `openOrCreate`, so the
 * answer to a click is the feature's own and not a copy of it in the test. The
 * vault, the metadata index and the calendar are the stand-ins. Every name,
 * folder and date is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App as ObsidianApp, FileManager, Plugin as ObsidianPlugin, TFile, Vault as ObsidianVault } from "obsidian";
import { Notice, Plugin } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { FeatureHost } from "../core/feature";
import type { Meeting } from "../core/icsReader";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore, defaultData } from "../core/settings";
import type { EffortlessData, VaultLayout } from "../core/settings";
import { openOrCreate } from "../features/dayView/openMeeting";
import { FEATURE_ID, MeetingNotes } from "../features/meetingNotes";
import { waitingNotes } from "../features/review/waitingNotes";
import type { ResolveLink, ReviewNote } from "../features/review/waitingNotes";

const FOLDER = "Meetings";
const SELF = "self@invented.test";
const LOG = "Journal/2026-10-14.md";
const LINK = "2026-10-14 Design review";
const NOTE_PATH = `${FOLDER}/${LINK}.md`;

function layout(): VaultLayout {
	return { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };
}

function meeting(partial: Partial<Meeting> = {}): Meeting {
	return {
		uid: "uid-1",
		summary: "Design review",
		location: null,
		description: null,
		organizer: null,
		attendees: [{ name: "Alva Almgren", email: "alva.almgren@invented.test" }],
		occurrenceKey: null,
		allDay: false,
		start: new Date(2026, 9, 14, 9, 0),
		end: new Date(2026, 9, 14, 9, 30),
		...partial,
	};
}

function dayKey(day: Date): string {
	const two = (n: number) => String(n).padStart(2, "0");
	return `${day.getFullYear()}-${two(day.getMonth() + 1)}-${two(day.getDate())}`;
}

/** A feature whose start throws, after the core has built it — the failed-start device. */
class FailsToStart extends MeetingNotes {
	override onload(): void {
		throw new Error("invented start failure");
	}
}

interface DeviceOptions {
	/** Whether this device builds the days; the click happens on one that does not. */
	buildsTheDays?: boolean;
	stored?: Record<string, unknown>;
	/** What the calendar returns, and for which use; any other use gets nothing. */
	meetings?: readonly Meeting[];
	meetingsUse?: "notes" | "day";
	failToStart?: boolean;
	switchedOff?: boolean;
}

interface Device {
	feature: MeetingNotes;
	registry: FeatureRegistry;
	settings: SettingsStore;
	plugin: Plugin;
	/** The note texts the vault holds, by path. */
	texts: Map<string, string>;
	/** The meetings the calendar returns for the "notes" use, by day key; a test changes them between the click and the run. */
	calendarDays: Map<string, readonly Meeting[]>;
	/** What the feature has reported as standing problems, so a run that refused something can be read. */
	problems: Problems;
}

/** The feature as the registry builds it, over one stub vault the click and the run share. */
async function buildDevice(options: DeviceOptions = {}): Promise<Device> {
	const plugin = new Plugin();
	const base = defaultData();
	const data: EffortlessData = {
		...base,
		core: {
			...base.core,
			layout: layout(),
			enabled: options.switchedOff === true ? { [FEATURE_ID]: false } : {},
		},
		features: { [FEATURE_ID]: { meetingNotesFolder: FOLDER, selfEmail: SELF, ...options.stored } },
	};
	plugin.seedData(data);
	plugin.load();
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const use = options.meetingsUse ?? "notes";
	const calendarDays = new Map<string, readonly Meeting[]>([["2026-10-14", options.meetings ?? []]]);
	const calendarPort: Calendar = {
		meetingsOn: (day, asked) => (asked === use ? (calendarDays.get(dayKey(day)) ?? []) : []),
		presenceBetween: () => ({ whole: false, meetings: [] }),
		refresh: async () => {},
	};
	const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
	device.save({ buildsTheDays: options.buildsTheDays ?? false });
	const vault = plugin.app.vault;
	const texts = new Map<string, string>();
	vault.allowReads();
	const created = vault.create.bind(vault);
	vault.create = async (path: string, text: string) => {
		texts.set(path, text);
		return created(path, text);
	};
	const problems = new Problems();
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections: { all: () => [], at: () => null }, problems, device },
		new NoteWriter(
			vault as unknown as ObsidianVault,
			{ path: () => null, onChange: () => undefined },
			plugin.app.fileManager as unknown as FileManager,
		),
		calendarPort,
	);
	let feature: MeetingNotes | undefined;
	const make = options.failToStart === true ? FailsToStart : MeetingNotes;
	registry.register(FEATURE_ID, (host: FeatureHost) => (feature = new make(host)));
	registry.start();
	return { feature: feature!, registry, settings, plugin, texts, calendarDays, problems };
}

/** The click: the day view's real `openOrCreate` on the device's own app. */
async function click(device: Device, linktext = LINK): Promise<string[]> {
	const app = device.plugin.app;
	const opened: string[] = [];
	app.workspace.getLeaf = (() => ({
		openFile: async (opening: TFile) => {
			opened.push(opening.path);
		},
	})) as unknown as typeof app.workspace.getLeaf;
	app.workspace.openLinkText = async (text: string) => {
		opened.push(`link:${text}`);
	};
	const result = await openOrCreate(app as unknown as ObsidianApp, linktext, LOG, false, undefined, linktext);
	expect(result).toBe(true);
	return opened;
}

/** The note an empty creation makes: at the link's own name, with no text, and nothing at the meeting notes folder. */
function expectEmptyNote(device: Device): void {
	expect([...device.texts.entries()]).toEqual([[`${LINK}.md`, ""]]);
}


/**
 * The frontmatter of a note written in the shape meeting notes writes it: a
 * scalar `key: value` (JSON-quoted text, or empty for `null`) or a `key:` over
 * `- "item"` lines. A stand-in for Obsidian's own parse, reading the real text
 * the click and the run write, so a property name or value that is wrong in
 * the text is wrong here too.
 */
function frontmatterOf(text: string): Record<string, unknown> | null {
	const lines = text.split(/\r?\n/);
	if (lines[0] !== "---") return null;
	const end = lines.indexOf("---", 1);
	if (end < 0) return null;
	const found: Record<string, unknown> = {};
	let open: string | null = null;
	for (const line of lines.slice(1, end)) {
		const item = /^\s*- (.*)$/.exec(line);
		if (item !== null && open !== null) {
			found[open] = [...((found[open] as unknown[] | null) ?? []), item[1].startsWith('"') ? JSON.parse(item[1]) : item[1]];
			continue;
		}
		const scalar = /^([^:\s][^:]*):\s*(.*)$/.exec(line);
		if (scalar === null) continue;
		open = scalar[2] === "" ? scalar[1] : null;
		found[scalar[1]] = scalar[2] === "" ? null : scalar[2].startsWith('"') ? JSON.parse(scalar[2]) : scalar[2];
	}
	return found;
}

/**
 * Obsidian's index of frontmatter, over the notes the vault holds: what
 * `metadataCache.getFileCache` hands back. `notIndexed` lists notes Obsidian
 * has not got to yet (`null`), `noFrontmatter` ones it has cached with none.
 */
function indexLikeObsidian(device: Device, options: { notIndexed?: string[]; noFrontmatter?: string[] } = {}): void {
	const cache = device.plugin.app.metadataCache as unknown as { getFileCache(file: TFile): unknown };
	cache.getFileCache = (file: TFile) => {
		if (options.notIndexed?.includes(file.path)) return null;
		if (options.noFrontmatter?.includes(file.path)) return {};
		const text = device.plugin.app.vault.readableContents()?.get(file.path);
		return text === undefined ? null : { frontmatter: frontmatterOf(text) ?? undefined };
	};
}

function textOf(device: Device, path: string): string | undefined {
	return device.plugin.app.vault.readableContents()?.get(path);
}

/** The run on `day`, at eight in the morning, over the device's own feature. */
async function runOn(device: Device, day: Date): Promise<void> {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 8, 0));
	const inside = device.feature as unknown as { runOnce(generation: number): Promise<void>; generation: number };
	await inside.runOnce(inside.generation);
}

const toCrlf = (text: string): string => text.replace(/\n/g, "\r\n");

const BERTIL = { name: "Bertil Berg", email: "bertil.berg@invented.test" };

beforeEach(() => {
	Notice.messages = [];
});

afterEach(() => {
	vi.useRealTimers();
});

describe("a clicked note when a stored setting is one the feature cannot use", () => {
	it("says which template field it refused, and the note still opens with the English default for that field", async () => {
		const device = await buildDevice({
			meetings: [meeting()],
			stored: { template: { notesHeading: "Notes without a hash" } },
		});
		expect(device.feature.readiness().state).toBe("standby");

		await click(device);

		expect(Notice.messages).toEqual([
			'Effortless: meeting notes cannot use the Notes heading "Notes without a hash" stored in its settings, and uses "# Notes" until it is changed on the Meeting notes card.',
		]);
		expect(device.texts.get(NOTE_PATH)).toContain("# Notes");
	});

	it("says nothing when every stored field is usable", async () => {
		const device = await buildDevice({ meetings: [meeting()], stored: { template: { tag: "sync" } } });

		await click(device);

		expect(Notice.messages).toEqual([]);
		expect(device.texts.get(NOTE_PATH)).toContain("sync");
	});

	it("says it for an email address that is not text, which the click would otherwise leave blank in silence", async () => {
		const device = await buildDevice({ meetings: [meeting()], stored: { selfEmail: 7 } });

		await click(device);

		expect(Notice.messages).toEqual([
			"Effortless: meeting notes cannot use the email address 7 stored in its settings, and leaves it blank until it is entered on the Meeting notes card.",
		]);
	});

	it("says nothing for a click on a link that names no meeting, so a plain link click is never noisy", async () => {
		const device = await buildDevice({
			meetings: [meeting()],
			stored: { template: { notesHeading: "Notes without a hash" } },
		});

		await click(device, "2026-10-14 Something else");

		expect(Notice.messages).toEqual([]);
	});
});

describe("a click on a device where meeting notes' start failed", () => {
	it("creates an empty note, as with the feature switched off", async () => {
		const device = await buildDevice({ buildsTheDays: true, failToStart: true, meetings: [meeting()] });
		expect(device.registry.statuses()[0].state).toBe("failed");

		await click(device);

		expectEmptyNote(device);
	});
});

describe("the click and the real provider together, for the cases that make an empty note", () => {
	it("creates an empty note after meeting notes is switched off through the registry once the feature is built", async () => {
		const device = await buildDevice({ meetings: [meeting()] });
		await device.settings.setEnabled(FEATURE_ID, false);

		await click(device);

		expectEmptyNote(device);
	});

	it("creates an empty note when the meeting's calendar shows it on the day but is not set to make notes", async () => {
		const device = await buildDevice({ meetings: [meeting()], meetingsUse: "day" });

		await click(device);

		expectEmptyNote(device);
	});

	it("fills the note with the same meeting when the calendar is set to make notes (the pair the two above must differ from)", async () => {
		const device = await buildDevice({ meetings: [meeting()], meetingsUse: "notes" });

		await click(device);

		expect(device.texts.get(NOTE_PATH)).toContain('- "[[Alva Almgren]]"');
	});
});

describe("the run recognises a clicked note through the real frontmatter lookup", () => {
	it("adds a name invited after the click to the clicked note, and makes no second note", async () => {
		const device = await buildDevice({ meetings: [meeting()], buildsTheDays: true });
		indexLikeObsidian(device);
		await click(device);
		expect(textOf(device, NOTE_PATH)).toContain('effortless-meeting: "uid-1"');

		device.calendarDays.set("2026-10-14", [meeting({ attendees: [...meeting().attendees, BERTIL] })]);
		await runOn(device, new Date(2026, 9, 14));

		expect(device.plugin.app.vault.created).toEqual([NOTE_PATH]);
		expect(textOf(device, NOTE_PATH)).toContain('- "[[Bertil Berg]]"');
		expect(device.feature.notes()["uid-1"]["2026-10-14"].accounted).toEqual(["Alva Almgren", "Bertil Berg"]);
	});

	it("renames the clicked note and corrects its day link when the meeting moved day", async () => {
		const device = await buildDevice({ meetings: [meeting()], buildsTheDays: true });
		indexLikeObsidian(device);
		await click(device);

		device.calendarDays.set("2026-10-14", []);
		device.calendarDays.set("2026-10-16", [meeting({ start: new Date(2026, 9, 16, 9, 0), end: new Date(2026, 9, 16, 9, 30) })]);
		await runOn(device, new Date(2026, 9, 16));

		const moved = `${FOLDER}/2026-10-16 Design review.md`;
		expect(device.plugin.app.vault.created).toEqual([NOTE_PATH]);
		expect(textOf(device, moved)).toContain('day: "[[2026-10-16]]"');
		expect(textOf(device, moved)).not.toContain("2026-10-14");
	});
});

describe("a clicked note Obsidian has not indexed yet when the run fires", () => {
	it.each([
		["has no cache entry at all", { notIndexed: [NOTE_PATH] }],
		["is cached with no frontmatter", { noFrontmatter: [NOTE_PATH] }],
	])("is still the feature's own note when it %s, and gets the invited name", async (_name, index) => {
		const device = await buildDevice({ meetings: [meeting()], buildsTheDays: true });
		await click(device);
		indexLikeObsidian(device, index);

		device.calendarDays.set("2026-10-14", [meeting({ attendees: [...meeting().attendees, BERTIL] })]);
		await runOn(device, new Date(2026, 9, 14));

		expect(textOf(device, NOTE_PATH)).toContain('- "[[Bertil Berg]]"');
		expect(device.plugin.app.vault.created).toEqual([NOTE_PATH]);
	});

	it("still adopts, and leaves unchanged, a hand-made note the index has nothing for (its text is read for an identity it does not carry)", async () => {
		const device = await buildDevice({ meetings: [meeting()], buildsTheDays: true });
		await device.plugin.app.vault.create(NOTE_PATH, "my own words\n");
		indexLikeObsidian(device, { notIndexed: [NOTE_PATH] });

		device.calendarDays.set("2026-10-14", [meeting({ attendees: [...meeting().attendees, BERTIL] })]);
		await runOn(device, new Date(2026, 9, 14));

		expect(textOf(device, NOTE_PATH)).toBe("my own words\n");
		expect(device.feature.notes()["uid-1"]["2026-10-14"].accounted).toEqual(["Alva Almgren", "Bertil Berg"]);
	});
});

describe("the run's write into a clicked note with Windows line endings", () => {
	it.each([
		["ending in a line break", true],
		["not ending in a line break", false],
	])("adds the invited name to a clicked note %s, in exact bytes", async (_name, endsInBreak) => {
		const device = await buildDevice({ meetings: [meeting()], buildsTheDays: true });
		indexLikeObsidian(device);
		await click(device);
		const clicked = textOf(device, NOTE_PATH)!;
		expect(clicked.endsWith("\n")).toBe(true);
		const lf = endsInBreak ? clicked : clicked.slice(0, -1);
		device.plugin.app.vault.readableContents()!.set(NOTE_PATH, toCrlf(lf));

		device.calendarDays.set("2026-10-14", [meeting({ attendees: [...meeting().attendees, BERTIL] })]);
		await runOn(device, new Date(2026, 9, 14));

		// The record grows with the name the run adds, so a device holding no notes memory knows it was offered.
		const expectedLf = lf
			.replace('  - "[[Alva Almgren]]"\n', '  - "[[Alva Almgren]]"\n  - "[[Bertil Berg]]"\n')
			.replace('effortless-offered: ["Alva Almgren"]', 'effortless-offered: ["Alva Almgren","Bertil Berg"]');
		expect(expectedLf).not.toBe(lf);
		expect(textOf(device, NOTE_PATH)).toBe(toCrlf(expectedLf));
	});
});

describe("Review reads the note meeting notes wrote", () => {
	const layoutNow = layout();
	const resolveLink: ResolveLink = (linkText) => (/^\d{4}-\d{2}-\d{2}$/.test(linkText) ? `Journal/${linkText}.md` : null);

	function reviewNote(device: Device, path: string): ReviewNote {
		const text = textOf(device, path)!;
		return { path, frontmatter: frontmatterOf(text), text };
	}

	it("finds the clicked note, identity and all, waiting on its day and not before it", async () => {
		const device = await buildDevice({ meetings: [meeting()], buildsTheDays: true });
		await click(device);
		const note = reviewNote(device, NOTE_PATH);
		expect(note.frontmatter).toHaveProperty("effortless-meeting");

		const onTheDay = waitingNotes([note], layoutNow, 7, new Date(2026, 9, 14), resolveLink, () => false);
		const theDayBefore = waitingNotes([note], layoutNow, 7, new Date(2026, 9, 13), resolveLink, () => false);

		expect(onTheDay.list.map((row) => row.path)).toEqual([NOTE_PATH]);
		expect(theDayBefore.list).toEqual([]);
	});

	it("finds the note a run creates on the day, which carries the meeting's identity", async () => {
		const device = await buildDevice({ meetings: [meeting()], buildsTheDays: true });
		await runOn(device, new Date(2026, 9, 14));
		const note = reviewNote(device, NOTE_PATH);
		expect(note.frontmatter).toHaveProperty("effortless-meeting");

		const found = waitingNotes([note], layoutNow, 7, new Date(2026, 9, 14), resolveLink, () => false);

		expect(found.list.map((row) => row.path)).toEqual([NOTE_PATH]);
	});
});
