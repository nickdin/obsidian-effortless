/**
 * A click on a meeting on a coming day creates its note filled in, and the run
 * on the day treats that note as its own.
 *
 * The click is the day view's real `openOrCreate` over the stub app, answered
 * by the core's slot; the run is meeting notes' real `runMeetingNotes` on a
 * second device that has received nothing from the first (its memory is empty)
 * and sees the same vault. Every name, folder and date is invented.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin, TFile, Vault as ObsidianVault } from "obsidian";
import { App, Plugin, Vault } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { FeatureHost } from "../core/feature";
import type { Meeting } from "../core/icsReader";
import { filledNoteFor, provideMeetingNote } from "../core/meetingNoteFill";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore, defaultData } from "../core/settings";
import type { EffortlessData, VaultLayout } from "../core/settings";
import { FEATURE_ID, MeetingNotes } from "../features/meetingNotes";
import { openOrCreate } from "../features/dayView/openMeeting";
import { clickFill } from "../features/meetingNotes/clickFill";
import { dayLinkOrRefusal } from "../features/meetingNotes/ensureNote";
import { noteText } from "../features/meetingNotes/noteText";
import { withOfferedLine, withWrittenLine } from "../features/meetingNotes/noteIdentity";
import { meetingIdentity } from "../features/meetingNotes/notesMemory";
import type { NotesMemory } from "../features/meetingNotes/notesMemory";
import { meetingNotePath } from "../features/meetingNotes/notePath";
import { participants } from "../features/meetingNotes/participants";
import { runMeetingNotes } from "../features/meetingNotes/run";
import type { RunCalendar, RunNotes, RunProblems, RunVault } from "../features/meetingNotes/run";
import { DEFAULT_TEMPLATE } from "../features/meetingNotes/types";

const FOLDER = "Meetings";
const SELF = "self@invented.test";
const CLICK_DAY = new Date(2026, 9, 14);
const LOG = "Journal/2026-10-14.md";

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

/** A calendar that answers only for the days it was given, and only for notes. */
function calendar(byDay: Record<string, readonly Meeting[]>): { meetingsOn(day: Date, use: "notes"): readonly Meeting[] } {
	return {
		meetingsOn: (day, use) => {
			if (use !== "notes") return [];
			const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
			return byDay[key] ?? [];
		},
	};
}

/** The notes a device's vault holds, shared by the click on one device and the run on another. */
const files = new Map<string, string>();
let taken: Array<() => void> = [];

function file(path: string): TFile {
	return { path } as unknown as TFile;
}

/** Provides the slot as meeting notes does, from the given settings and calendar. */
function provide(options: { byDay: Record<string, readonly Meeting[]>; on?: boolean; selfEmail?: string }): void {
	const cal = calendar(options.byDay);
	taken.push(
		provideMeetingNote((linkpath, sourcePath) =>
			options.on === false
				? null
				: clickFill(linkpath, sourcePath, {
						layout: layout(),
						meetingsOn: (day) => cal.meetingsOn(day, "notes"),
						folder: FOLDER,
						template: DEFAULT_TEMPLATE,
						selfEmail: options.selfEmail ?? SELF,
					}),
		),
	);
}

/** The click: the day view's `openOrCreate` over a fresh stub app, creating into `files`. */
async function click(linktext: string, existing: string[] = []): Promise<{ app: App; opened: string[] }> {
	const app = new App();
	for (const path of existing) {
		app.metadataCache.caches.set(path, {});
		app.vault.files.push({ path });
	}
	const opened: string[] = [];
	app.workspace.getLeaf = (() => ({
		openFile: async (opening: TFile) => {
			opened.push(opening.path);
		},
	})) as unknown as typeof app.workspace.getLeaf;
	app.workspace.openLinkText = async (text: string) => {
		opened.push(`link:${text}`);
	};
	const result = await openOrCreate(app as unknown as ObsidianApp, linktext, LOG, false, undefined, linktext, async (path, text) => {
		files.set(path, text);
		return file(path);
	});
	expect(result).toBe(true);
	// The stub's own `create` is what an empty creation reaches; record it as a file too.
	for (const path of app.vault.created) if (!files.has(path)) files.set(path, "");
	return { app, opened };
}

/** The run on another device: its memory as given, the shared vault, and the calendar of that day. */
async function runOn(
	day: Date,
	meetings: readonly Meeting[],
	memory: NotesMemory = {},
): Promise<{ memory: NotesMemory; renamed: Array<{ from: string; to: string }>; edited: string[]; created: string[] }> {
	const renamed: Array<{ from: string; to: string }> = [];
	const edited: string[] = [];
	const created: string[] = [];
	let committed: NotesMemory = memory;
	const cal: RunCalendar = {
		refresh: async () => undefined,
		meetingsOn: (askedDay, use) => (use === "notes" && askedDay.getTime() === day.getTime() ? meetings : []),
		presenceBetween: () => ({ whole: false, meetings: [] }),
	};
	const vault: RunVault = {
		exists: (path) => files.has(path),
		read: async (path) => files.get(path) ?? null,
		fileAt: (path) => (files.has(path) ? file(path) : null),
		notesNamingIdentity: (identity) =>
			[...files.entries()]
				.filter(([, text]) => text.includes(`effortless-meeting: ${JSON.stringify(identity)}`))
				.map(([path]) => path),
	};
	const notes: RunNotes = {
		async create(path, text) {
			created.push(path);
			files.set(path, text);
			return file(path);
		},
		async rename(target, newPath) {
			const mutable = target as unknown as { path: string };
			renamed.push({ from: mutable.path, to: newPath });
			files.set(newPath, files.get(mutable.path) ?? "");
			files.delete(mutable.path);
			mutable.path = newPath;
		},
		async edit(target, edit) {
			const path = (target as unknown as { path: string }).path;
			edited.push(path);
			const next = edit(files.get(path) ?? "");
			files.set(path, next);
			return next;
		},
		trashIf: async () => false,
	};
	const problems: RunProblems = { report: () => undefined, clear: () => undefined, list: () => [] };
	await runMeetingNotes({
		calendar: cal,
		vault,
		notes,
		problems,
		layout: layout(),
		folder: FOLDER,
		template: DEFAULT_TEMPLATE,
		selfEmail: SELF,
		today: day,
		memory,
		commitMemory: async (next) => {
			committed = next;
		},
	});
	return { memory: committed, renamed, edited, created };
}

beforeEach(() => {
	files.clear();
});

afterEach(() => {
	for (const takeBack of taken) takeBack();
	taken = [];
});

function expectedText(m: Meeting, noteDate: string): string {
	const link = dayLinkOrRefusal(noteDate, layout());
	if ("refused" in link) throw new Error(link.refused);
	const identity = meetingIdentity(m.uid, m.occurrenceKey);
	const text = noteText(m, link.target, DEFAULT_TEMPLATE, participants(m, SELF), layout(), identity);
	return withWrittenLine(withOfferedLine(text, identity, participants(m, SELF)), identity);
}

describe("a click on a meeting on a coming day", () => {
	it("creates the note with the bytes noteText gives, with the device not building the days", async () => {
		const m = meeting();
		provide({ byDay: { "2026-10-14": [m] } });

		const { opened } = await click("2026-10-14 Design review");

		const path = meetingNotePath(FOLDER, "2026-10-14", m.summary);
		expect(files.get(path)).toBe(expectedText(m, "2026-10-14"));
		expect(files.get(path)).toContain('- "[[Alva Almgren]]"');
		expect(files.get(path)).toContain('day: "[[2026-10-14]]"');
		expect(opened).toEqual([path]);
	});

	it("creates an empty note, as before, when meeting notes is switched off", async () => {
		provide({ byDay: { "2026-10-14": [meeting()] }, on: false });

		await click("2026-10-14 Design review");

		expect([...files.values()]).toEqual([""]);
	});

	it("creates an empty note, as before, when the meeting's calendar does not give each meeting a note", async () => {
		provide({ byDay: {} });

		await click("2026-10-14 Design review");

		expect([...files.values()]).toEqual([""]);
	});

	it("opens a note the person made at the path unchanged, and writes nothing", async () => {
		const m = meeting();
		provide({ byDay: { "2026-10-14": [m] } });
		const path = meetingNotePath(FOLDER, "2026-10-14", m.summary);
		files.set(path, "my own words\n");

		const { opened } = await click("2026-10-14 Design review", [path]);

		expect(files.get(path)).toBe("my own words\n");
		expect(opened).toEqual(["link:2026-10-14 Design review"]);
	});
});

describe("the run on the day, on a device that received nothing from the click", () => {
	it("adds a name invited after the click, and does not adopt", async () => {
		const m = meeting();
		provide({ byDay: { "2026-10-14": [m] } });
		await click("2026-10-14 Design review");
		const path = meetingNotePath(FOLDER, "2026-10-14", m.summary);

		const invitedLater = meeting({
			attendees: [...m.attendees, { name: "Bertil Berg", email: "bertil.berg@invented.test" }],
		});
		const ran = await runOn(CLICK_DAY, [invitedLater]);

		expect(ran.created).toEqual([]);
		expect(ran.renamed).toEqual([]);
		expect(ran.edited).toEqual([path]);
		expect(files.get(path)).toContain('- "[[Bertil Berg]]"');
		expect(files.get(path)).toContain('- "[[Alva Almgren]]"');
		const entry = ran.memory[meetingIdentity(m.uid, null)]["2026-10-14"];
		expect(entry.accounted).toEqual(["Alva Almgren", "Bertil Berg"]);
	});

	it("renames the note and corrects its heading and day link when the meeting moved day", async () => {
		const m = meeting();
		provide({ byDay: { "2026-10-14": [m] } });
		await click("2026-10-14 Design review");
		const oldPath = meetingNotePath(FOLDER, "2026-10-14", m.summary);

		const moved = meeting({ start: new Date(2026, 9, 16, 9, 0), end: new Date(2026, 9, 16, 9, 30) });
		const newPath = meetingNotePath(FOLDER, "2026-10-16", m.summary);
		const ran = await runOn(new Date(2026, 9, 16), [moved]);

		expect(ran.created).toEqual([]);
		expect(ran.renamed).toEqual([{ from: oldPath, to: newPath }]);
		expect(files.has(oldPath)).toBe(false);
		expect(files.get(newPath)).toContain('day: "[[2026-10-16]]"');
		expect(files.get(newPath)).not.toContain("2026-10-14");
	});

	it("keeps a note it recognises as it is when nothing changed, and records it", async () => {
		const m = meeting();
		provide({ byDay: { "2026-10-14": [m] } });
		await click("2026-10-14 Design review");
		const path = meetingNotePath(FOLDER, "2026-10-14", m.summary);
		const before = files.get(path);

		const ran = await runOn(CLICK_DAY, [m]);

		expect(ran.edited).toEqual([]);
		expect(files.get(path)).toBe(before);
		expect(ran.memory[meetingIdentity(m.uid, null)]["2026-10-14"].path).toBe(path);
	});

	it("still adopts a note the person made by hand, unread and unchanged", async () => {
		const m = meeting();
		const path = meetingNotePath(FOLDER, "2026-10-14", m.summary);
		files.set(path, "my own words\n");

		const ran = await runOn(CLICK_DAY, [m]);

		expect(ran.created).toEqual([]);
		expect(ran.edited).toEqual([]);
		expect(files.get(path)).toBe("my own words\n");
		expect(ran.memory[meetingIdentity(m.uid, null)]["2026-10-14"].accounted).toEqual(["Alva Almgren"]);
	});
});

/**
 * The slot as the real feature fills it: built by the real registry on a
 * device that does not build the days, so the feature stands down and never
 * starts — the device a click happens on.
 */
async function buildDevice(options: {
	switchedOff?: boolean;
	folder?: string;
	meetings?: Record<string, readonly Meeting[]>;
}): Promise<MeetingNotes> {
	const plugin = new Plugin();
	const base = defaultData();
	const data: EffortlessData = {
		...base,
		core: {
			...base.core,
			layout: layout(),
			enabled: options.switchedOff === true ? { [FEATURE_ID]: false } : {},
		},
		features: { [FEATURE_ID]: { meetingNotesFolder: options.folder ?? FOLDER, selfEmail: SELF } },
	};
	plugin.seedData(data);
	plugin.load();
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const cal = calendar(options.meetings ?? {});
	const calendarPort: Calendar = {
		meetingsOn: (day, use) => cal.meetingsOn(day, use as "notes"),
		presenceBetween: () => ({ whole: false, meetings: [] }),
		refresh: async () => {},
	};
	const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
	device.save({ buildsTheDays: false });
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections: { all: () => [], at: () => null }, problems: new Problems(), device },
		new NoteWriter(new Vault() as unknown as ObsidianVault, { path: () => null, onChange: () => undefined }),
		calendarPort,
	);
	let feature: MeetingNotes | undefined;
	registry.register(FEATURE_ID, (host: FeatureHost) => (feature = new MeetingNotes(host)));
	registry.start();
	return feature!;
}

describe("meeting notes' answer to a click, on a device that does not build the days", () => {
	it("fills the note while the feature itself stands down", async () => {
		const m = meeting();
		const feature = await buildDevice({ meetings: { "2026-10-14": [m] } });

		expect(feature.readiness().state).toBe("standby");
		const filled = await filledNoteFor("2026-10-14 Design review", LOG);

		expect(filled).not.toBeNull();
		expect(filled!.path).toBe(meetingNotePath(FOLDER, "2026-10-14", m.summary));
		expect(filled!.text).toBe(expectedText(m, "2026-10-14"));
	});

	it("answers nothing when meeting notes is switched off", async () => {
		await buildDevice({ switchedOff: true, meetings: { "2026-10-14": [meeting()] } });

		expect(filledNoteFor("2026-10-14 Design review", LOG)).toBeNull();
	});

	it("answers nothing when the meeting notes folder is not set", async () => {
		await buildDevice({ folder: "", meetings: { "2026-10-14": [meeting()] } });

		expect(filledNoteFor("2026-10-14 Design review", LOG)).toBeNull();
	});

	it("answers nothing for a link that names no meeting of that day's calendar", async () => {
		await buildDevice({ meetings: { "2026-10-14": [meeting()] } });

		expect(filledNoteFor("2026-10-14 Something else", LOG)).toBeNull();
		expect(filledNoteFor("2026-10-14 Design review", "Elsewhere/not a log.md")).toBeNull();
	});
});
