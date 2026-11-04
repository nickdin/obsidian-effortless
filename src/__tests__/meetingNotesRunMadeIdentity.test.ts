/**
 * A note the run itself made carries the meeting's identity, so a click after
 * the meeting moved or was renamed opens that note instead of making a second
 * one.
 *
 * The first note is made by the real `runMeetingNotes`; the click is the day
 * view's real `openOrCreate` answered by meeting notes' real `clickFill`; the
 * run afterwards is the real `runMeetingNotes` again, on the memory the first
 * run committed. Both see one shared vault. Every name, folder and date is
 * invented.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { App as ObsidianApp, TFile } from "obsidian";
import { App } from "./__mocks__/obsidian";
import { provideMeetingNote } from "../core/meetingNoteFill";
import type { Meeting } from "../core/icsReader";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { openOrCreate } from "../features/dayView/openMeeting";
import { clickFill } from "../features/meetingNotes/clickFill";
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

/** The vault the run and the click both see. */
const files = new Map<string, string>();
let takeBack: (() => void) | null = null;

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
	takeBack?.();
	takeBack = provideMeetingNote((linkpath, sourcePath) =>
		clickFill(linkpath, sourcePath, {
			layout: layout(),
			meetingsOn: (day) => byDay[dayKey(day)] ?? [],
			folder: FOLDER,
			template: DEFAULT_TEMPLATE,
			selfEmail: SELF,
			notesNamingIdentity: notesNaming,
		}),
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

/** The run on `day`, with the calendar giving `meetings` and the memory the last run committed. */
async function runOn(
	day: Date,
	meetings: readonly Meeting[],
	remembered: NotesMemory = {},
): Promise<{ renamed: Array<{ from: string; to: string }>; created: string[]; reported: string[]; committed: NotesMemory }> {
	let committed: NotesMemory = remembered;
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
	takeBack?.();
	takeBack = null;
});

describe("a note the run made, then the meeting moves or is renamed, then a click", () => {
	it("writes the meeting's identity into the note the run creates", async () => {
		const original = meeting();
		const path = meetingNotePath(FOLDER, "2026-10-14", original.summary);

		await runOn(new Date(2026, 9, 14), [original]);

		// If wrong (the run writes no identity, as it did): the property reads back as null.
		expect(identityInText(files.get(path) ?? "")).toBe(meetingIdentity(original.uid, null));
	});

	it("opens the first note after a move, makes no second, and the run afterwards renames it with no notice", async () => {
		const original = meeting();
		const oldPath = meetingNotePath(FOLDER, "2026-10-14", original.summary);
		const first = await runOn(new Date(2026, 9, 14), [original]);
		files.set(oldPath, (files.get(oldPath) ?? "") + PREPARATION);

		// The meeting moves to Friday and the person clicks its row before the next run.
		const moved = meeting(MOVED);
		const newPath = meetingNotePath(FOLDER, "2026-10-16", moved.summary);
		provide({ "2026-10-16": [moved] });
		const second = await click("2026-10-16 Design review", "2026-10-16");
		const ran = await runOn(new Date(2026, 9, 16), [moved], first.committed);

		// If wrong (the run left no identity): the click creates a second, empty note at newPath, and the run collides on it.
		expect(second.created).toEqual([]);
		expect(second.opened).toEqual([oldPath]);
		expect(ran.created).toEqual([]);
		expect(ran.renamed).toEqual([{ from: oldPath, to: newPath }]);
		expect([...files.keys()]).toEqual([newPath]);
		expect(files.get(newPath)).toContain("My preparation: ask about the budget.");
		expect(ran.reported).toEqual([]);
	});

	it("does the same when the title changed on the same day", async () => {
		const original = meeting();
		const oldPath = meetingNotePath(FOLDER, "2026-10-14", original.summary);
		const first = await runOn(new Date(2026, 9, 14), [original]);
		files.set(oldPath, (files.get(oldPath) ?? "") + PREPARATION);

		const retitled = meeting({ summary: "Design review follow-up" });
		const newPath = meetingNotePath(FOLDER, "2026-10-14", retitled.summary);
		provide({ "2026-10-14": [retitled] });
		const second = await click("2026-10-14 Design review follow-up", "2026-10-14");
		const ran = await runOn(new Date(2026, 9, 14), [retitled], first.committed);

		expect(second.created).toEqual([]);
		expect(second.opened).toEqual([oldPath]);
		expect(ran.created).toEqual([]);
		expect([...files.keys()]).toEqual([newPath]);
		expect(files.get(newPath)).toContain("My preparation: ask about the budget.");
		expect(ran.reported).toEqual([]);
	});
});

describe("one occurrence of a repeating meeting", () => {
	it("is written with the occurrence's own identity, and a click after it moved opens that note", async () => {
		const original = meeting({ occurrenceKey: "20261014T090000" });
		const oldPath = meetingNotePath(FOLDER, "2026-10-14", original.summary);
		const first = await runOn(new Date(2026, 9, 14), [original]);
		files.set(oldPath, (files.get(oldPath) ?? "") + PREPARATION);

		const moved = meeting({ ...MOVED, occurrenceKey: "20261014T090000" });
		provide({ "2026-10-16": [moved] });
		const second = await click("2026-10-16 Design review", "2026-10-16");

		// If wrong (the series id alone is written, as for a meeting that never repeats): the note names "uid-1", the click looks for "uid-1::20261014T090000", and a second note is made.
		expect(identityInText(files.get(oldPath) ?? "")).toBe("uid-1::20261014T090000");
		expect(first.reported).toEqual([]);
		expect(second.created).toEqual([]);
		expect(second.opened).toEqual([oldPath]);
	});
});

describe("the text of a created note, as exact bytes", () => {
	// A description with Windows line endings: the invitation is the one input a run copies in verbatim
	// (`noteText.ts` turns its line endings into `\n`), and every other part of the text is built here.
	const WINDOWS_DESCRIPTION = "Line one\r\nLine two\r\n";

	it("is the template's lines joined with line feeds only and ending in a line break, identity and written lines included", async () => {
		const original = meeting({ description: WINDOWS_DESCRIPTION });
		const path = meetingNotePath(FOLDER, "2026-10-14", original.summary);

		await runOn(new Date(2026, 9, 14), [original]);

		// If wrong (the identity line missing, or written with a carriage return): the exact text differs at that line.
		expect(files.get(path)).toBe(
			[
				"---",
				"tags:",
				"  - meeting",
				"effort:",
				"participants:",
				'  - "[[Alva Almgren]]"',
				'day: "[[2026-10-14]]"',
				"processed:",
				'effortless-meeting: "uid-1"',
				'effortless-written: "93:1ff3d772a7e3c2"',
				"---",
				"# Design review",
				"",
				"## Agenda and purpose",
				"",
				"Line one",
				"Line two",
				"",
				"# Notes",
				"",
				"",
				"## Decisions and actions",
				"",
			].join("\n"),
		);
		expect(files.get(path)).not.toContain("\r");
		expect(files.get(path)?.endsWith("\n")).toBe(true);
	});
});

describe("a note the run made, beside a click's note holding the preparation, once the invitation changed", () => {
	it("keeps the click's note, with an empty notes memory, and says the run's note was left", async () => {
		const OLD_AGENDA = "Old agenda: walk through the mock-ups.";
		const moved = meeting({ ...MOVED, description: OLD_AGENDA });
		const runMade = meetingNotePath(FOLDER, "2026-10-16", moved.summary);
		const clickMade = meetingNotePath(FOLDER, "2026-10-14", moved.summary);
		// The run makes its note for the 16th; the click's note was made for the 14th, before the meeting moved.
		await runOn(new Date(2026, 9, 16), [moved]);
		const clicked = clickFill("2026-10-14 Design review", "Journal/2026-10-14.md", {
			layout: layout(),
			meetingsOn: () => [meeting({ description: OLD_AGENDA })],
			folder: FOLDER,
			template: DEFAULT_TEMPLATE,
			selfEmail: SELF,
		});
		files.set(clickMade, (clicked?.text ?? "") + PREPARATION);

		// The device has lost its memory and the invitation's text has changed since both notes were written.
		const ran = await runOn(new Date(2026, 9, 16), [meeting({ ...MOVED, description: "New agenda: decide on the colour scheme." })], {});

		// If wrong (the run's note carries no fingerprint, so it reads as holding words and wins by sitting at the computed path):
		// the notice says it kept the run's note, and the click's note, with the preparation, is the one left.
		expect(ran.reported).toHaveLength(1);
		expect(ran.reported[0]).toContain(`kept up to date ${clickMade}, which holds your own words, and left ${runMade} as it is`);
		expect(files.get(clickMade)).toContain("My preparation: ask about the budget.");
		expect(files.get(runMade)).not.toContain("My preparation");
	});
});
