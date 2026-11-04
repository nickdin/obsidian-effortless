/**
 * A second click on a meeting whose note already exists under another name
 * opens that note instead of making a second one, and a run that still finds
 * two notes naming one meeting keeps the one holding the person's words.
 *
 * The click is the day view's real `openOrCreate` over the stub app, answered
 * by meeting notes' real `clickFill`; the run is the real `runMeetingNotes` on a
 * second device with an empty memory. Both see one shared vault. Every name,
 * folder and date is invented.
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
import { holdsContent } from "../features/meetingNotes/ensureNote";
import { noteText } from "../features/meetingNotes/noteText";
import { identityInText } from "../features/meetingNotes/noteIdentity";
import { meetingIdentity } from "../features/meetingNotes/notesMemory";
import type { NotesMemory } from "../features/meetingNotes/notesMemory";
import { meetingNotePath } from "../features/meetingNotes/notePath";
import { runMeetingNotes } from "../features/meetingNotes/run";
import type { RunCalendar, RunNotes, RunProblems, RunVault } from "../features/meetingNotes/run";
import { DEFAULT_TEMPLATE } from "../features/meetingNotes/types";

const FOLDER = "Meetings";
const SELF = "self@invented.test";
const PREPARATION = "\nMy preparation: ask about the budget.\n";

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

const MOVED = { start: new Date(2026, 9, 16, 9, 0), end: new Date(2026, 9, 16, 9, 30) };

/** The vault both devices see. */
const files = new Map<string, string>();
let taken: Array<() => void> = [];

function file(path: string): TFile {
	return { path } as unknown as TFile;
}

function dayKey(day: Date): string {
	return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

/** Every note in the vault whose text names `identity`, as the feature's vault port answers it. */
function notesNaming(identity: string): string[] {
	return [...files.entries()].filter(([, text]) => identityInText(text) === identity).map(([path]) => path);
}

/** The slot, answering for the meetings of the day the click happens on. */
function provide(byDay: Record<string, readonly Meeting[]>): void {
	taken.push(
		provideMeetingNote((linkpath, sourcePath) =>
			clickFill(linkpath, sourcePath, {
				layout: layout(),
				meetingsOn: (day) => byDay[dayKey(day)] ?? [],
				folder: FOLDER,
				template: DEFAULT_TEMPLATE,
				selfEmail: SELF,
				notesNamingIdentity: notesNaming,
			}),
		),
	);
}

/** A click on `linktext` in the log of `day`, over a stub app whose vault holds what `files` holds. */
async function click(linktext: string, day: string): Promise<{ opened: string[]; created: string[] }> {
	const app = new App();
	// The link name resolves only to a note of exactly that name, as Obsidian's own does.
	for (const path of files.keys()) {
		app.vault.files.push({ path });
		app.metadataCache.caches.set(path, {});
	}
	const opened: string[] = [];
	const created: string[] = [];
	app.workspace.getLeaf = (() => ({
		openFile: async (opening: TFile) => {
			opened.push(opening.path);
		},
	})) as unknown as typeof app.workspace.getLeaf;
	app.workspace.openLinkText = async (text: string) => {
		opened.push(`link:${text}`);
	};
	const result = await openOrCreate(app as unknown as ObsidianApp, linktext, `Journal/${day}.md`, false, undefined, linktext, async (path, text) => {
		created.push(path);
		files.set(path, text);
		return file(path);
	});
	expect(result).toBe(true);
	return { opened, created };
}

/** The run on a device with an empty memory, on `day`, with the calendar giving `meetings`. */
async function runOn(
	day: Date,
	meetings: readonly Meeting[],
	remembered: NotesMemory = {},
): Promise<{ renamed: Array<{ from: string; to: string }>; created: string[]; reported: string[]; committed: NotesMemory | null }> {
	let committed: NotesMemory | null = null;
	const renamed: Array<{ from: string; to: string }> = [];
	const created: string[] = [];
	const reported: string[] = [];
	const cal: RunCalendar = {
		refresh: async () => undefined,
		meetingsOn: (askedDay, use) => (use === "notes" && askedDay.getTime() === day.getTime() ? meetings : []),
		presenceBetween: () => ({ whole: false, meetings: [] }),
	};
	const vault: RunVault = {
		exists: (path) => files.has(path),
		read: async (path) => files.get(path) ?? null,
		fileAt: (path) => (files.has(path) ? file(path) : null),
		notesNamingIdentity: notesNaming,
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
			const next = edit(files.get(path) ?? "");
			files.set(path, next);
			return next;
		},
		trashIf: async () => false,
	};
	const problems: RunProblems = { report: (_key, message) => void reported.push(message), clear: () => undefined, list: () => [] };
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
		memory: remembered,
		commitMemory: async (memory) => {
			committed = memory;
		},
	});
	return { renamed, created, reported, committed };
}

beforeEach(() => {
	files.clear();
});

afterEach(() => {
	for (const takeBack of taken) takeBack();
	taken = [];
});

describe("a second click after the meeting moved or was renamed", () => {
	it("opens the note that already names the meeting, and the run on the new day leaves one note holding the preparation", async () => {
		const original = meeting();
		const oldPath = meetingNotePath(FOLDER, "2026-10-14", original.summary);
		provide({ "2026-10-14": [original] });
		await click("2026-10-14 Design review", "2026-10-14");
		files.set(oldPath, (files.get(oldPath) ?? "") + PREPARATION);

		// The meeting moves to Friday; the person clicks it on Friday's view.
		const moved = meeting(MOVED);
		const newPath = meetingNotePath(FOLDER, "2026-10-16", moved.summary);
		taken.pop()?.();
		provide({ "2026-10-16": [moved] });
		const second = await click("2026-10-16 Design review", "2026-10-16");
		const ran = await runOn(new Date(2026, 9, 16), [moved]);

		// If wrong (today): the second click creates a second file at newPath and the run leaves two.
		expect(second.created).toEqual([]);
		expect(second.opened).toEqual([oldPath]);
		expect(ran.created).toEqual([]);
		expect(ran.renamed).toEqual([{ from: oldPath, to: newPath }]);
		expect([...files.keys()]).toEqual([newPath]);
		expect(files.get(newPath)).toContain("My preparation: ask about the budget.");
	});

	it("does the same when the title changed on the same day", async () => {
		const original = meeting();
		const oldPath = meetingNotePath(FOLDER, "2026-10-14", original.summary);
		provide({ "2026-10-14": [original] });
		await click("2026-10-14 Design review", "2026-10-14");
		files.set(oldPath, (files.get(oldPath) ?? "") + PREPARATION);

		const retitled = meeting({ summary: "Design review follow-up" });
		const newPath = meetingNotePath(FOLDER, "2026-10-14", retitled.summary);
		taken.pop()?.();
		provide({ "2026-10-14": [retitled] });
		const second = await click("2026-10-14 Design review follow-up", "2026-10-14");
		const ran = await runOn(new Date(2026, 9, 14), [retitled]);

		expect(second.created).toEqual([]);
		expect(second.opened).toEqual([oldPath]);
		expect(ran.created).toEqual([]);
		expect([...files.keys()]).toEqual([newPath]);
		expect(files.get(newPath)).toContain("My preparation: ask about the budget.");
	});

	it("still makes the note on a first click, when no note names the meeting", async () => {
		const m = meeting();
		provide({ "2026-10-14": [m] });

		const first = await click("2026-10-14 Design review", "2026-10-14");

		const path = meetingNotePath(FOLDER, "2026-10-14", m.summary);
		expect(first.created).toEqual([path]);
		expect(identityInText(files.get(path) ?? "")).toBe(meetingIdentity(m.uid, null));
	});
});

describe("the run on the day, finding two notes that name one meeting", () => {
	it("keeps the one holding the person's words and names the other in a notice", async () => {
		const original = meeting();
		const oldPath = meetingNotePath(FOLDER, "2026-10-14", original.summary);
		provide({ "2026-10-14": [original] });
		await click("2026-10-14 Design review", "2026-10-14");
		files.set(oldPath, (files.get(oldPath) ?? "") + PREPARATION);
		// The state today's second click leaves: a second, empty note at the new path.
		const moved = meeting(MOVED);
		const newPath = meetingNotePath(FOLDER, "2026-10-16", moved.summary);
		provide({ "2026-10-16": [moved] });
		files.set(newPath, (files.get(oldPath) ?? "").replace(PREPARATION, "").replace("2026-10-14", "2026-10-16"));
		const emptyAtNewPath = files.get(newPath);

		const invited = { ...moved, attendees: [...moved.attendees, { name: "Berit Bergman", email: "berit.bergman@invented.test" }] };
		const ran = await runOn(new Date(2026, 9, 16), [invited]);

		// If wrong (the run collides on the empty note, as it did): no name is added to the note with the words,
		// nothing is remembered, and the notice also says "neither was changed".
		expect(files.get(oldPath)).toContain("Berit Bergman");
		expect(files.get(oldPath)).toContain("My preparation: ask about the budget.");
		expect(files.get(newPath)).toBe(emptyAtNewPath);
		expect(ran.created).toEqual([]);
		expect(ran.renamed).toEqual([]);
		expect(ran.committed?.[meetingIdentity("uid-1", null)]?.["2026-10-16"]?.path).toBe(oldPath);
		expect(ran.reported).toEqual([
			`this meeting has 2 notes made by a click. It kept up to date ${oldPath}, which holds your own words, ` +
				`and left ${newPath} as it is. Move anything you need across and delete the ones you do not want.`,
		]);
	});
});

describe("a click and the run choosing among several notes that name one meeting", () => {
	it("opens the note holding the person's words, not the first one in vault order", async () => {
		const moved = meeting(MOVED);
		const earlier = "Meetings/2026-10-13 Design review.md";
		const worded = "Meetings/2026-10-14 Design review.md";
		const identity = meetingIdentity(moved.uid, null);
		const empty = noteText(moved, "2026-10-14", DEFAULT_TEMPLATE, [], layout(), identity);
		files.set(earlier, empty);
		files.set(worded, empty + PREPARATION);

		const filled = clickFill("2026-10-16 Design review", "Journal/2026-10-16.md", {
			layout: layout(),
			meetingsOn: (day) => (dayKey(day) === "2026-10-16" ? [moved] : []),
			folder: FOLDER,
			template: DEFAULT_TEMPLATE,
			selfEmail: SELF,
			notesNamingIdentity: notesNaming,
			readNote: (path) => files.get(path) ?? null,
		});
		const ran = await runOn(new Date(2026, 9, 16), [moved]);

		// If wrong (the click takes the first note named, as it did): it answers with `earlier`, the empty one.
		expect(filled?.path).toBe(worded);
		expect(ran.renamed.map((move) => move.from)).toEqual([worded]);
	});
});

describe("where a note's frontmatter ends", () => {
	it("is the core's reading: a closing line that kept a stray carriage return still closes it", () => {
		const m = meeting();
		// Frontmatter only, its closing line ending in a lone carriage return and no line feed, as a Windows-ending note cut short leaves it.
		const frontmatterOnly = "---\nlocation: invented room\n---\r";

		// If wrong (the feature works the end out itself): it finds no closing line and counts the frontmatter as the person's words.
		expect(holdsContent(frontmatterOnly, m, DEFAULT_TEMPLATE, layout())).toBe(false);
	});
});

describe("the click's answer from the real meeting notes feature", () => {
	/** The feature built by the real registry on a device that does not build the days, over a vault holding `held`. */
	async function buildDevice(moved: Meeting, held: Record<string, string>): Promise<ObsidianApp> {
		const plugin = new Plugin();
		const base = defaultData();
		const data: EffortlessData = {
			...base,
			core: { ...base.core, layout: layout(), enabled: {} },
			features: { [FEATURE_ID]: { meetingNotesFolder: FOLDER, selfEmail: SELF } },
		};
		plugin.seedData(data);
		plugin.load();
		const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await settings.load();
		const calendarPort: Calendar = {
			meetingsOn: (day) => (dayKey(day) === "2026-10-16" ? [moved] : []),
			presenceBetween: () => ({ whole: false, meetings: [] }),
			refresh: async () => {},
		};
		const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
		device.save({ buildsTheDays: false });
		for (const path of Object.keys(held)) plugin.app.vault.files.push({ path });
		// What Obsidian's index of frontmatter says of the notes held, read when the feature asks.
		(plugin.app.metadataCache as unknown as { getFileCache: (file: TFile) => unknown }).getFileCache = (file) => ({
			frontmatter: { "effortless-meeting": identityInText(held[file.path] ?? "") },
		});
		const registry = new FeatureRegistry(
			plugin as unknown as ObsidianPlugin,
			{ settings, collections: { all: () => [], at: () => null }, problems: new Problems(), device },
			new NoteWriter(new Vault() as unknown as ObsidianVault, { path: () => null, onChange: () => undefined }),
			calendarPort,
		);
		registry.register(FEATURE_ID, (host: FeatureHost) => new MeetingNotes(host));
		registry.start();
		return plugin.app as unknown as ObsidianApp;
	}

	it("answers with the note that already names the meeting when the meeting moved", async () => {
		const original = meeting();
		const oldPath = meetingNotePath(FOLDER, "2026-10-14", original.summary);
		provide({ "2026-10-14": [original] });
		await click("2026-10-14 Design review", "2026-10-14");
		taken.pop()?.();
		const held = { [oldPath]: files.get(oldPath) ?? "" };

		await buildDevice(meeting(MOVED), held);
		const answer = await filledNoteFor("2026-10-16 Design review", "Journal/2026-10-16.md");

		// If wrong (the feature passes no index to the click): the path is the new, empty one.
		expect(answer?.path).toBe(oldPath);
	});
	it("reads the index of named notes at each click, not once at the first", async () => {
		const original = meeting();
		const oldPath = meetingNotePath(FOLDER, "2026-10-14", original.summary);
		const newPath = meetingNotePath(FOLDER, "2026-10-16", original.summary);
		const held: Record<string, string> = {};
		const app = await buildDevice(meeting(MOVED), held);

		const before = await filledNoteFor("2026-10-16 Design review", "Journal/2026-10-16.md");
		// Between the clicks a note comes to name the meeting, as a click on its old day makes one.
		held[oldPath] = noteText(original, "2026-10-14", DEFAULT_TEMPLATE, [], layout(), meetingIdentity(original.uid, null));
		(app.vault as unknown as { files: Array<{ path: string }> }).files.push({ path: oldPath });
		const after = await filledNoteFor("2026-10-16 Design review", "Journal/2026-10-16.md");

		// If wrong (the feature keeps the index from the first click): the second answer is the new, empty path too.
		expect(before?.path).toBe(newPath);
		expect(after?.path).toBe(oldPath);
	});
});
