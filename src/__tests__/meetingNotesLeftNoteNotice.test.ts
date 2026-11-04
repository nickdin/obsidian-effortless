/**
 * The notice naming the note a run left as it is stands for as long as that
 * note exists, run after run, and clears once the note is gone.
 *
 * Every test drives the real `runMeetingNotes` over one shared vault, feeding
 * each run the memory the run before it committed, and a problems channel that
 * keeps its standing keys the way the core's does: a key already standing
 * speaks once, so a notice cleared and reported again counts as a new one.
 * Every name, folder and date is invented.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import type { Meeting } from "../core/icsReader";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { identityInText, withOfferedLine, withWrittenLine } from "../features/meetingNotes/noteIdentity";
import { noteText } from "../features/meetingNotes/noteText";
import { meetingIdentity, readNotesMemory } from "../features/meetingNotes/notesMemory";
import type { NotesMemory } from "../features/meetingNotes/notesMemory";
import { meetingNotePath } from "../features/meetingNotes/notePath";
import { participants } from "../features/meetingNotes/participants";
import { runMeetingNotes } from "../features/meetingNotes/run";
import type { RunCalendar, RunNotes, RunProblems, RunVault } from "../features/meetingNotes/run";
import { DEFAULT_TEMPLATE } from "../features/meetingNotes/types";

const FOLDER = "Meetings";
const SELF = "self@invented.test";
const PREPARATION = "\nMy preparation: ask about the budget.\n";
const DAY = new Date(2026, 9, 16);
const IDENTITY = meetingIdentity("uid-1", null);

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
		start: new Date(2026, 9, 16, 9, 0),
		end: new Date(2026, 9, 16, 9, 30),
		...partial,
	};
}

const BERIT = { name: "Berit Bergman", email: "berit.bergman@invented.test" };

/** The vault the runs share. */
const files = new Map<string, string>();

function file(path: string): TFile {
	return { path } as unknown as TFile;
}

function notesNaming(identity: string): string[] {
	return [...files.entries()].filter(([, text]) => identityInText(text) === identity).map(([path]) => path);
}

/** A note as a click writes it: filled in, carrying the meeting's identity, the names it offered and the fingerprint of its body. */
function clickedNote(m: Meeting, noteDay: string): string {
	const names = participants(m, SELF);
	return withWrittenLine(withOfferedLine(noteText(m, noteDay, DEFAULT_TEMPLATE, names, layout(), IDENTITY), IDENTITY, names), IDENTITY);
}

/** A problems channel with the core's rule: only the first report of a standing key raises a notice. */
class StandingProblems implements RunProblems {
	readonly standing = new Map<string, string>();
	readonly raised: string[] = [];
	report(key: string, message: string): void {
		if (!this.standing.has(key)) this.raised.push(message);
		this.standing.set(key, message);
	}
	clear(key: string): void {
		this.standing.delete(key);
	}
	list(): readonly string[] {
		return [...this.standing.keys()];
	}
}

interface Ran {
	readonly memory: NotesMemory;
	readonly renamed: Array<{ from: string; to: string }>;
}

/** One run on `DAY` over `meetings`, from `remembered`, returning the memory it committed (or the one it was given). */
async function runOn(
	problems: StandingProblems,
	meetings: readonly Meeting[],
	remembered: NotesMemory,
	options: { readonly changeBeforeEdit?: boolean } = {},
): Promise<Ran> {
	let committed: NotesMemory | null = null;
	const renamed: Array<{ from: string; to: string }> = [];
	const calendar: RunCalendar = {
		refresh: async () => undefined,
		meetingsOn: (askedDay, use) => (use === "notes" && askedDay.getTime() === DAY.getTime() ? meetings : []),
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
			// The person types into the note between this run's read and its write.
			if (options.changeBeforeEdit === true) files.set(path, `${files.get(path) ?? ""}\nA line typed meanwhile.`);
			const next = edit(files.get(path) ?? "");
			files.set(path, next);
			return next;
		},
		trashIf: async () => false,
	};
	await runMeetingNotes({
		calendar,
		vault,
		notes,
		problems,
		layout: layout(),
		folder: FOLDER,
		template: DEFAULT_TEMPLATE,
		selfEmail: SELF,
		today: DAY,
		memory: remembered,
		commitMemory: async (memory) => {
			committed = memory;
		},
	});
	return { memory: committed ?? remembered, renamed };
}

beforeEach(() => {
	files.clear();
});

/** The notice for two click-made notes, the first holding the person's words, as `ensureNote` words it. */
function keptAndLeft(kept: string, left: readonly string[]): string {
	return (
		`this meeting has ${left.length + 1} notes made by a click. It kept up to date ${kept}, ` +
		`which holds your own words, and left ${left.join(", ")} as it is. ` +
		`Move anything you need across and delete the ones you do not want.`
	);
}

describe("the notice naming the note a run left, over several runs", () => {
	it("stands on the second run while the left note exists, and clears once it is deleted", async () => {
		const m = meeting();
		const kept = meetingNotePath(FOLDER, "2026-10-16", m.summary);
		const left = "Meetings/2026-10-15 Design review.md";
		files.set(kept, clickedNote(m, "2026-10-16") + PREPARATION);
		files.set(left, clickedNote(m, "2026-10-16"));
		const problems = new StandingProblems();

		const first = await runOn(problems, [m], {});
		const second = await runOn(problems, [m], first.memory);

		// If wrong (the notice is one run's state): the second run finds the kept note through memory,
		// strands nothing, and clears the notice while the left note is still in the vault.
		expect([...problems.standing]).toEqual([[kept, keptAndLeft(kept, [left])]]);
		// A standing notice speaks once: the second run neither cleared it nor raised it again.
		expect(problems.raised).toEqual([keptAndLeft(kept, [left])]);
		expect(files.has(left)).toBe(true);

		files.delete(left);
		const third = await runOn(problems, [m], second.memory);

		expect([...problems.standing]).toEqual([]);
		expect(third.memory[IDENTITY]?.["2026-10-16"]?.path).toBe(kept);
		expect(third.memory[IDENTITY]?.["2026-10-16"]).not.toHaveProperty("leftNotes");
	});

	it("names only the notes still there, as they are deleted one by one", async () => {
		const m = meeting();
		const kept = meetingNotePath(FOLDER, "2026-10-16", m.summary);
		const leftOne = "Meetings/2026-10-14 Design review.md";
		const leftTwo = "Meetings/2026-10-15 Design review.md";
		files.set(kept, clickedNote(m, "2026-10-16") + PREPARATION);
		files.set(leftOne, clickedNote(m, "2026-10-16"));
		files.set(leftTwo, clickedNote(m, "2026-10-16"));
		const problems = new StandingProblems();

		const first = await runOn(problems, [m], {});
		expect(problems.standing.get(kept)).toBe(keptAndLeft(kept, [leftOne, leftTwo]));

		files.delete(leftOne);
		const second = await runOn(problems, [m], first.memory);
		// If wrong (the stored list is never narrowed): the sentence still names the deleted note, or counts three notes.
		expect(problems.standing.get(kept)).toBe(keptAndLeft(kept, [leftTwo]));

		files.delete(leftTwo);
		await runOn(problems, [m], second.memory);
		expect([...problems.standing]).toEqual([]);
	});

	it("keeps the note holding the words up to date where it is, name added, on every run while an empty note sits at the computed path", async () => {
		const original = meeting({ start: new Date(2026, 9, 14, 9, 0), end: new Date(2026, 9, 14, 9, 30) });
		const kept = meetingNotePath(FOLDER, "2026-10-14", original.summary);
		const moved = meeting();
		const empty = meetingNotePath(FOLDER, "2026-10-16", moved.summary);
		files.set(kept, clickedNote(original, "2026-10-14") + PREPARATION);
		files.set(empty, clickedNote(moved, "2026-10-16"));
		const emptyBefore = files.get(empty);
		const problems = new StandingProblems();

		const first = await runOn(problems, [moved], {});
		const invited = { ...moved, attendees: [...moved.attendees, BERIT] };
		const second = await runOn(problems, [invited], first.memory);

		// If wrong (the second run renames the kept note onto the empty one's path): it collides, adds no name,
		// remembers nothing, and says the calendar renamed the meeting, which it did not.
		expect(files.get(kept)).toContain("Berit Bergman");
		expect(files.get(kept)).toContain("My preparation: ask about the budget.");
		expect(files.get(empty)).toBe(emptyBefore);
		expect(second.renamed).toEqual([]);
		expect(second.memory[IDENTITY]?.["2026-10-16"]?.path).toBe(kept);
		expect([...problems.standing]).toEqual([[kept, keptAndLeft(kept, [empty])]]);
		expect(problems.raised).toHaveLength(1);

		// The empty note is deleted: the kept note moves onto the computed path and the notice goes, its old key with it.
		files.delete(empty);
		const third = await runOn(problems, [invited], second.memory);
		expect(third.renamed).toEqual([{ from: kept, to: empty }]);
		expect([...problems.standing]).toEqual([]);
	});

	it("stands through a rename whose correction did not land, saying both", async () => {
		const original = meeting({ start: new Date(2026, 9, 14, 9, 0), end: new Date(2026, 9, 14, 9, 30) });
		const kept = meetingNotePath(FOLDER, "2026-10-14", original.summary);
		const moved = meeting();
		const empty = meetingNotePath(FOLDER, "2026-10-16", moved.summary);
		files.set(kept, clickedNote(original, "2026-10-14") + PREPARATION);
		files.set(empty, clickedNote(moved, "2026-10-16"));
		const problems = new StandingProblems();
		const first = await runOn(problems, [moved], {});

		// The calendar retitles the meeting, so the kept note is renamed onto a free path, and the person types into it
		// between the run's read and its write, which stops the correction.
		const retitled = meeting({ summary: "Design review follow-up" });
		const renamedTo = meetingNotePath(FOLDER, "2026-10-16", retitled.summary);
		const second = await runOn(problems, [retitled], first.memory, { changeBeforeEdit: true });

		// If wrong (the correction message replaces the notice): the left note is no longer named.
		expect(second.renamed).toEqual([{ from: kept, to: renamedTo }]);
		expect([...problems.standing.keys()]).toEqual([renamedTo]);
		expect(problems.standing.get(renamedTo)).toContain("its correction was not applied");
		expect(problems.standing.get(renamedTo)).toContain(`left ${empty} as it is`);
		const entry = second.memory[IDENTITY]?.["2026-10-16"];
		expect(entry?.path).toBe(renamedTo);
		expect(entry?.pendingCorrection).toBeDefined();
		expect(entry?.leftNotes).toEqual([empty]);

		// The next run lands the correction; the left note is still named, and the empty note's deletion clears it.
		const third = await runOn(problems, [retitled], second.memory);
		expect(problems.standing.get(renamedTo)).toBe(keptAndLeft(renamedTo, [empty]));
		expect(third.memory[IDENTITY]?.["2026-10-16"]?.pendingCorrection).toBeUndefined();
		files.delete(empty);
		await runOn(problems, [retitled], third.memory);
		expect([...problems.standing]).toEqual([]);
	});

	it("stands through a retry of that correction that does not land either", async () => {
		const original = meeting({ start: new Date(2026, 9, 14, 9, 0), end: new Date(2026, 9, 14, 9, 30) });
		const kept = meetingNotePath(FOLDER, "2026-10-14", original.summary);
		const moved = meeting();
		const empty = meetingNotePath(FOLDER, "2026-10-16", moved.summary);
		files.set(kept, clickedNote(original, "2026-10-14") + PREPARATION);
		files.set(empty, clickedNote(moved, "2026-10-16"));
		const problems = new StandingProblems();
		const first = await runOn(problems, [moved], {});
		const retitled = meeting({ summary: "Design review follow-up" });
		const renamedTo = meetingNotePath(FOLDER, "2026-10-16", retitled.summary);
		const second = await runOn(problems, [retitled], first.memory, { changeBeforeEdit: true });

		// The retry is an update in place that carries the owed correction, and the person types again.
		await runOn(problems, [retitled], second.memory, { changeBeforeEdit: true });

		// If wrong (the retry reports only the correction): the left note is dropped from the notice on this path too.
		expect(problems.standing.get(renamedTo)).toContain("changed after this run read it");
		expect(problems.standing.get(renamedTo)).toContain(`left ${empty} as it is`);
	});

	it("stands for a note the run really made, then a click's note holding words found with an empty memory (#1122 with #1125)", async () => {
		const m = meeting();
		const runMade = meetingNotePath(FOLDER, "2026-10-16", m.summary);
		const clickMade = "Meetings/2026-10-14 Design review.md";
		const problems = new StandingProblems();

		// The run itself makes the note, carrying its identity and its fingerprint, and remembers it.
		const first = await runOn(problems, [m], {});
		expect(identityInText(files.get(runMade) ?? "")).toBe(IDENTITY);
		expect(Object.keys(first.memory)).toEqual([IDENTITY]);

		// A device without that run's memory: the memory is empty, and a click's note with the person's words turns up.
		// It was made when the meeting was on the 14th, and the calendar has moved it since.
		files.set(clickMade, clickedNote(meeting({ start: new Date(2026, 9, 14, 9, 0), end: new Date(2026, 9, 14, 9, 30) }), "2026-10-14") + PREPARATION);
		const second = await runOn(problems, [m], {});
		const third = await runOn(problems, [m], second.memory);

		// If wrong (the run's note is passed over for the click's, or the notice is one run's state): no notice names the
		// click's note, or it is gone after the third run, which finds the kept note through memory.
		expect([...problems.standing.keys()]).toEqual([clickMade]);
		expect(problems.standing.get(clickMade)).toContain(`left ${runMade} as it is`);
		expect(problems.raised).toHaveLength(1);
		expect(files.get(clickMade)).toContain("My preparation");

		files.delete(runMade);
		await runOn(problems, [m], third.memory);
		expect([...problems.standing]).toEqual([]);
	});
});

describe("the notes memory's record of the notes left", () => {
	const stored = (entry: Record<string, unknown>): unknown => ({ "uid-1": { "2026-10-16": entry } });

	it("reads a list of paths, and an entry without one as it did", () => {
		const read = readNotesMemory(stored({ path: "Meetings/a.md", accounted: [], leftNotes: ["Meetings/b.md", "Meetings/c.md"] }));
		expect(read.dropped).toEqual([]);
		expect(read.notes["uid-1"]["2026-10-16"].leftNotes).toEqual(["Meetings/b.md", "Meetings/c.md"]);

		const plain = readNotesMemory(stored({ path: "Meetings/a.md", accounted: [] }));
		expect(plain.notes["uid-1"]["2026-10-16"]).toEqual({ path: "Meetings/a.md", accounted: [] });
	});

	it.each([
		["text instead of a list", "Meetings/b.md"],
		["an empty list", []],
		["a blank path", ["Meetings/b.md", "  "]],
		["a number among the paths", ["Meetings/b.md", 3]],
		["null", null],
	])("refuses the whole entry, naming it, for %s", (_name, leftNotes) => {
		// If wrong (the member is read as absent, or guessed at): the entry is kept and nothing is named.
		// The whole entry goes, as a bad `written` does: the next run finds both notes again by the identity they carry
		// and says so again, where reading only the member away would lose the notice for good.
		const read = readNotesMemory(stored({ path: "Meetings/a.md", accounted: [], leftNotes }));
		expect(read.notes).toEqual({});
		expect(read.dropped).toEqual(["uid-1 / 2026-10-16"]);
	});
});
