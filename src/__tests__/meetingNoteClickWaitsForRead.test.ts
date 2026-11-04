/**
 * The first click of a session, over two notes that name one meeting, waits for
 * the notes' text before it chooses
 * (#1126, against #1103
 * and its fix #1120).
 *
 * The click and the run choose by one rule (`chooseNamedNote`): the note
 * holding the person's own words wins. A click can only judge a note whose text
 * it has read, and on the first click of a session nothing has been read. The
 * feature here is the real `MeetingNotes`, built by the real registry on a
 * device that does not build the days, over a vault whose notes and their text
 * the test holds. Every name, folder and date is invented.
 */

import { describe, expect, it } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin, TFile, Vault as ObsidianVault } from "obsidian";
import { Plugin, Vault } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { FeatureHost } from "../core/feature";
import type { Meeting } from "../core/icsReader";
import { filledNoteFor } from "../core/meetingNoteFill";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore, defaultData } from "../core/settings";
import type { EffortlessData, VaultLayout } from "../core/settings";
import { FEATURE_ID, MeetingNotes } from "../features/meetingNotes";
import { identityInText, withWrittenLine, writtenInText } from "../features/meetingNotes/noteIdentity";
import { noteText } from "../features/meetingNotes/noteText";
import { meetingIdentity } from "../features/meetingNotes/notesMemory";
import { meetingNotePath } from "../features/meetingNotes/notePath";
import { runMeetingNotes } from "../features/meetingNotes/run";
import type { RunCalendar, RunNotes, RunProblems, RunVault } from "../features/meetingNotes/run";
import { DEFAULT_TEMPLATE } from "../features/meetingNotes/types";

const FOLDER = "Meetings";
const SELF = "self@invented.test";
const LOG = "Journal/2026-10-16.md";
const LINK = "2026-10-16 Design review";
const PREPARATION = "\nMy preparation: ask about the budget.\n";

function layout(): VaultLayout {
	return { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };
}

function meeting(description: string | null = null): Meeting {
	return {
		uid: "uid-1",
		summary: "Design review",
		location: null,
		description,
		organizer: null,
		attendees: [{ name: "Alva Almgren", email: "alva.almgren@invented.test" }],
		occurrenceKey: null,
		allDay: false,
		start: new Date(2026, 9, 16, 9, 0),
		end: new Date(2026, 9, 16, 9, 30),
	};
}

/** A note the click made for the meeting, as it stood on `day`: carrying the mark that nobody has touched it. */
function clickNote(day: string): string {
	const identity = meetingIdentity("uid-1", null);
	return withWrittenLine(noteText(meeting(), day, DEFAULT_TEMPLATE, [], layout(), identity), identity);
}

/** Two notes naming the meeting, neither at the path the click computes; the worded one is second in vault order. */
const EARLIER = "Meetings/2026-10-13 Design review.md";
const WORDED = "Meetings/2026-10-14 Design review.md";

interface Device {
	/** What the vault holds: the path, the text and the modified time of each note, in vault order. */
	held: Array<{ path: string; text: string; mtime: number }>;
	/** Makes the vault report `held` again, after a note's text or time changed. */
	sync(): void;
}

/**
 * The feature built by the real registry on a device that does not build the
 * days, over a vault holding `held`. A fresh one has read no note's text.
 */
async function buildDevice(held: Device["held"]): Promise<Device> {
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
		meetingsOn: (day) => (day.getFullYear() === 2026 && day.getMonth() === 9 && day.getDate() === 16 ? [meeting()] : []),
		presenceBetween: () => ({ whole: false, meetings: [] }),
		refresh: async () => {},
	};
	const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
	device.save({ buildsTheDays: false });
	const vault = plugin.app.vault as unknown as { files: Array<{ path: string; stat: { mtime: number } }>; allowReads(contents: Record<string, string>): void };
	const sync = (): void => {
		vault.files.length = 0;
		for (const note of held) vault.files.push({ path: note.path, stat: { mtime: note.mtime } });
		vault.allowReads(Object.fromEntries(held.map((note) => [note.path, note.text])));
	};
	sync();
	// What Obsidian's index of frontmatter says of the notes held, read when the feature asks.
	(plugin.app.metadataCache as unknown as { getFileCache: (file: TFile) => unknown }).getFileCache = (file) => ({
		frontmatter: { "effortless-meeting": identityInText(held.find((note) => note.path === file.path)?.text ?? "") },
	});
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections: { all: () => [], at: () => null }, problems: new Problems(), device },
		new NoteWriter(new Vault() as unknown as ObsidianVault, { path: () => null, onChange: () => undefined }),
		calendarPort,
	);
	registry.register(FEATURE_ID, (host: FeatureHost) => new MeetingNotes(host));
	registry.start();
	return { held, sync };
}

describe("the first click of a session over two notes that name one meeting", () => {
	it("opens the note holding the person's words, though it is second in vault order and nothing was read yet", async () => {
		const device = await buildDevice([
			{ path: EARLIER, text: clickNote("2026-10-13"), mtime: 1 },
			{ path: WORDED, text: clickNote("2026-10-14") + PREPARATION, mtime: 1 },
		]);
		expect(device.held.map((note) => note.path)).toEqual([EARLIER, WORDED]);

		const answer = await filledNoteFor(LINK, LOG);

		// If wrong (the click chooses before it has read anything, as it did): it answers with EARLIER, the empty note first in vault order.
		expect(answer?.path).toBe(WORDED);
	});

	it("reads a note again once the person has written in it since the last click", async () => {
		const device = await buildDevice([
			{ path: EARLIER, text: clickNote("2026-10-13"), mtime: 1 },
			{ path: WORDED, text: clickNote("2026-10-14"), mtime: 1 },
		]);
		// Neither holds words yet: the first click reads both and falls back to vault order.
		const before = await filledNoteFor(LINK, LOG);
		// The person then writes in the second note, which changes its modified time.
		device.held[1] = { path: WORDED, text: clickNote("2026-10-14") + PREPARATION, mtime: 2 };
		device.sync();
		const after = await filledNoteFor(LINK, LOG);

		// If wrong (the click keeps the first reading of each note): the second answer is EARLIER too.
		expect(before?.path).toBe(EARLIER);
		expect(after?.path).toBe(WORDED);
	});

	it("answers at once, with no wait, when the texts were already read by an earlier click", async () => {
		await buildDevice([
			{ path: EARLIER, text: clickNote("2026-10-13"), mtime: 1 },
			{ path: WORDED, text: clickNote("2026-10-14") + PREPARATION, mtime: 1 },
		]);
		await filledNoteFor(LINK, LOG);

		const second = filledNoteFor(LINK, LOG);

		// If wrong (every click reads again): the answer is a promise even though nothing changed.
		expect(second).not.toBeInstanceOf(Promise);
		expect((second as { path: string }).path).toBe(WORDED);
	});
});

describe("a click over one note that names the meeting, or none", () => {
	it("answers at once without reading a note's text", async () => {
		await buildDevice([{ path: EARLIER, text: clickNote("2026-10-13"), mtime: 1 }]);

		const answer = filledNoteFor(LINK, LOG);

		// This passes on the code before the fix too: it pins that the single-note case stays immediate (#1126's last sentence).
		expect(answer).not.toBeInstanceOf(Promise);
		expect((answer as { path: string }).path).toBe(EARLIER);
	});

	it("answers at once with the path it would create when no note names the meeting", async () => {
		await buildDevice([]);

		const answer = filledNoteFor(LINK, LOG);

		// This passes on the code before the fix too.
		expect(answer).not.toBeInstanceOf(Promise);
		expect((answer as { path: string }).path).toBe(meetingNotePath(FOLDER, "2026-10-16", "Design review"));
	});
});

/** The note the real run writes for the meeting on 2026-10-16, over an empty vault: what it creates, untouched. */
async function noteTheRunMakes(description: string | null = null): Promise<{ path: string; text: string }> {
	const made = new Map<string, string>();
	const file = (path: string): TFile => ({ path }) as unknown as TFile;
	const day = new Date(2026, 9, 16);
	const calendar: RunCalendar = {
		refresh: async () => undefined,
		meetingsOn: (asked, use) => (use === "notes" && asked.getTime() === day.getTime() ? [meeting(description)] : []),
		presenceBetween: () => ({ whole: false, meetings: [] }),
	};
	const vault: RunVault = {
		exists: (path) => made.has(path),
		read: async (path) => made.get(path) ?? null,
		fileAt: (path) => (made.has(path) ? file(path) : null),
		notesNamingIdentity: () => [],
	};
	const notes: RunNotes = {
		async create(path, text) {
			made.set(path, text);
			return file(path);
		},
		rename: async () => undefined,
		edit: async (target, edit) => {
			const path = (target as unknown as { path: string }).path;
			const next = edit(made.get(path) ?? "");
			made.set(path, next);
			return next;
		},
		trashIf: async () => false,
	};
	const problems: RunProblems = { report: () => undefined, clear: () => undefined, list: () => [] };
	await runMeetingNotes({
		calendar,
		vault,
		notes,
		problems,
		layout: layout(),
		folder: FOLDER,
		template: DEFAULT_TEMPLATE,
		selfEmail: SELF,
		today: day,
		memory: {},
		commitMemory: async () => undefined,
	});
	const [entry] = [...made.entries()];
	return { path: entry[0], text: entry[1] };
}

describe("the first click over a note the run made and a note the person wrote in (#1126 with #1156)", () => {
	it("opens the note holding the person's words, not the untouched note the run made at the computed path", async () => {
		// The invitation described the meeting when the run made the note; the calendar the click reads has since dropped that line,
		// so the run's note no longer matches a fresh one line by line, and only its mark says nobody has touched it.
		const run = await noteTheRunMakes("Agenda: the budget.");
		// The fixture is the run's real output: at the computed path, with the mark saying nobody has touched it.
		expect(run.text).toContain("Agenda: the budget.");
		expect(run.path).toBe(meetingNotePath(FOLDER, "2026-10-16", "Design review"));
		expect(writtenInText(run.text)).not.toBeNull();
		await buildDevice([
			{ path: run.path, text: run.text, mtime: 1 },
			{ path: WORDED, text: clickNote("2026-10-14") + PREPARATION, mtime: 1 },
		]);

		const answer = await filledNoteFor(LINK, LOG);

		// If wrong (the mark is ignored, so the run's note, whose description line the invitation no longer has, counts as the person's; or the click chooses before reading): the computed path wins, and the answer is the run's note.
		expect(answer?.path).toBe(WORDED);
	});
});
