/**
 * The record of the names a click offered (`effortless-offered`) is read in
 * every shape Obsidian writes a list property, and within the frontmatter the
 * core finds, and kept up to date by the run that
 * adds names, all against #1100.
 *
 * Notes are the click's real text (`clickFill`), then edited the way Obsidian's
 * Properties panel rewrites frontmatter. Every name, folder and date is invented.
 */

import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import type { Meeting } from "../core/icsReader";
import { meetingNoteBasename } from "../core/meetingName";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { clickFill } from "../features/meetingNotes/clickFill";
import { ensureNote } from "../features/meetingNotes/ensureNote";
import type { NoteLookup } from "../features/meetingNotes/ensureNote";
import { readParticipants } from "../features/meetingNotes/noteEdit";
import { identityInText, offeredInText, unchangedSinceWritten } from "../features/meetingNotes/noteIdentity";
import type { NotesMemory } from "../features/meetingNotes/notesMemory";
import { runMeetingNotes } from "../features/meetingNotes/run";
import type { RunCalendar, RunNotes, RunProblems, RunVault } from "../features/meetingNotes/run";
import { DEFAULT_TEMPLATE } from "../features/meetingNotes/types";

const FOLDER = "Meetings";
const SELF = "self@invented.test";
const DAY = "2026-10-14";
const LOG = `Journal/${DAY}.md`;
const ALVA = "Alva Almgren";
const BEA = "Bea Bergsten";
const CAI = "Cai Carlsson";

function layout(): VaultLayout {
	return { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };
}

function meeting(names: readonly string[]): Meeting {
	return {
		uid: "uid-1",
		summary: "Design review",
		location: null,
		description: null,
		organizer: null,
		attendees: names.map((name) => ({ name, email: `${name.toLowerCase().replace(" ", ".")}@invented.test` })),
		occurrenceKey: null,
		allDay: false,
		start: new Date(2026, 9, 14, 9, 0),
		end: new Date(2026, 9, 14, 9, 30),
	};
}

function clickedNote(names: readonly string[]): { path: string; text: string } {
	const m = meeting(names);
	const filled = clickFill(meetingNoteBasename(DAY, m.summary), LOG, {
		layout: layout(),
		meetingsOn: () => [m],
		folder: FOLDER,
		template: DEFAULT_TEMPLATE,
		selfEmail: SELF,
	});
	if (filled === null) throw new Error("the click filled nothing");
	return filled;
}

function lookupFor(path: string, text: string): NoteLookup {
	return {
		exists: (candidate) => candidate === path,
		read: (candidate) => (candidate === path ? text : null),
		notesNamingIdentity: (identity) => (identityInText(text) === identity ? [path] : []),
	};
}

function runOn(names: readonly string[], path: string, text: string) {
	return ensureNote(meeting(names), DAY, layout(), FOLDER, lookupFor(path, text), {}, DEFAULT_TEMPLATE, SELF);
}

function withoutName(text: string, name: string): string {
	return text.replace(new RegExp(`  - "\\[\\[${name}\\]\\]"\\r?\\n`), "");
}

/** The offered line replaced by the lines Obsidian writes for a list property it has rewritten. */
function asRewrittenByObsidian(text: string, items: readonly string[]): string {
	return text.replace(/^effortless-offered: .*$/m, `effortless-offered:\n${items.map((item) => `  - ${item}`).join("\n")}`);
}

describe("the offered record in every shape Obsidian writes a list property", () => {
	const SHAPES: Array<[string, (name: string) => string]> = [
		["unquoted", (name) => name],
		["double-quoted", (name) => JSON.stringify(name)],
		["single-quoted", (name) => `'${name}'`],
	];

	for (const [shape, item] of SHAPES) {
		it(`a name removed by hand stays removed when the record is a block list with ${shape} items`, () => {
			const note = clickedNote([ALVA, BEA]);
			const rewritten = asRewrittenByObsidian(withoutName(note.text, BEA), [item(ALVA), item(BEA)]);
			expect(rewritten).toContain(`effortless-offered:\n  - ${item(ALVA)}\n  - ${item(BEA)}\n`);
			expect(readParticipants(rewritten, "participants")).toEqual([ALVA]);

			const result = runOn([ALVA, BEA], note.path, rewritten);

			expect(result.outcome).toBe("nothing-to-do");
			expect(result.text).toBeUndefined();
		});
	}

	it("reads a flow list with single quotes, a block list at column 0, and an empty list", () => {
		const lines = (record: string) => `---\neffortless-meeting: uid-1\n${record}\nparticipants: []\n---\n`;
		expect(offeredInText(lines(`effortless-offered: ['${ALVA}', '${BEA}']`))).toEqual([ALVA, BEA]);
		expect(offeredInText(lines(`effortless-offered:\n- ${ALVA}\n- "${BEA}"`))).toEqual([ALVA, BEA]);
		expect(offeredInText(lines("effortless-offered: []"))).toEqual([]);
	});

	it("reads the list exactly as Obsidian's Properties write it", () => {
		// Read back from the test Obsidian after `processFrontMatter` removed a participant
		// (docs/acceptance-shots/issue-1130-properties-drive.txt).
		const text = [
			"---",
			"effortless-meeting: uid-1",
			"effortless-offered:",
			"  - Alva Almgren",
			"  - Bea Bergsten",
			'  - "Almgren, Cai: Design"',
			"  - Dan O'Dell",
			"---",
			"",
		].join("\n");
		expect(offeredInText(text)).toEqual([ALVA, BEA, "Almgren, Cai: Design", "Dan O'Dell"]);
	});

	it("reads a block list on a note with Windows line endings", () => {
		const text = `---\r\neffortless-meeting: uid-1\r\neffortless-offered:\r\n  - ${ALVA}\r\n  - ${BEA}\r\n---\r\n`;
		expect(offeredInText(text)).toEqual([ALVA, BEA]);
	});

	it("keeps a name holding a comma or a colon whole", () => {
		const text = `---\neffortless-offered:\n  - "Almgren, Alva: Design"\n---\n`;
		expect(offeredInText(text)).toEqual(["Almgren, Alva: Design"]);
	});

	it("reads nothing from a list that holds something other than text", () => {
		expect(offeredInText(`---\neffortless-offered: [1, 2]\n---\n`)).toBeNull();
		expect(offeredInText(`---\neffortless-offered: {a: 1}\n---\n`)).toBeNull();
	});
});

describe("the offered record is read only inside the frontmatter the core finds", () => {
	it("ignores an offered line below the frontmatter", () => {
		const text = `---\neffortless-meeting: uid-1\n---\n\neffortless-offered: ["${ALVA}"]\n`;
		expect(offeredInText(text)).toBeNull();
	});

	it("ignores an offered line in frontmatter that is never closed", () => {
		expect(offeredInText(`---\neffortless-offered: ["${ALVA}"]\nbody\n`)).toBeNull();
	});

	it("reads a record above a closing line that carries a trailing carriage return", () => {
		expect(offeredInText(`---\r\neffortless-offered: ["${ALVA}"]\r\n---\r\n`)).toEqual([ALVA]);
	});
});

describe("a name the run added and the person then removed stays removed on a device with no notes memory", () => {
	const files = new Map<string, string>();

	function file(path: string): TFile {
		return { path } as unknown as TFile;
	}

	/** One run of the real feature, over the in-memory vault above, holding an empty notes memory as a device that never ran it does. */
	async function run(names: readonly string[]): Promise<void> {
		const calendar: RunCalendar = {
			refresh: async () => undefined,
			meetingsOn: (askedDay, use) => (use === "notes" && askedDay.getTime() === new Date(2026, 9, 14).getTime() ? [meeting(names)] : []),
			presenceBetween: () => ({ whole: false, meetings: [] }),
		};
		const vault: RunVault = {
			exists: (path) => files.has(path),
			read: async (path) => files.get(path) ?? null,
			fileAt: (path) => (files.has(path) ? file(path) : null),
			notesNamingIdentity: (identity) => [...files.entries()].filter(([, text]) => identityInText(text) === identity).map(([path]) => path),
		};
		const notes: RunNotes = {
			create: async (path, text) => {
				files.set(path, text);
				return file(path);
			},
			rename: async () => undefined,
			edit: async (target, edit) => {
				const path = (target as unknown as { path: string }).path;
				const next = edit(files.get(path) ?? "");
				files.set(path, next);
				return next;
			},
			trashIf: async () => false,
		};
		const problems: RunProblems = { report: () => undefined, clear: () => undefined, list: () => [] };
		const empty: NotesMemory = {};
		await runMeetingNotes({
			calendar,
			vault,
			notes,
			problems,
			layout: layout(),
			folder: FOLDER,
			template: DEFAULT_TEMPLATE,
			selfEmail: SELF,
			today: new Date(2026, 9, 14),
			memory: empty,
			commitMemory: async () => undefined,
		});
	}

	function startFrom(text: string, path: string): void {
		files.clear();
		files.set(path, text);
	}

	it("is not added back by the second run, which holds an empty memory", async () => {
		const note = clickedNote([ALVA, BEA]);
		startFrom(note.text, note.path);

		await run([ALVA, BEA, CAI]);
		expect(readParticipants(files.get(note.path) ?? "", "participants")).toEqual([ALVA, BEA, CAI]);

		files.set(note.path, withoutName(files.get(note.path) ?? "", CAI));
		const afterRemoval = files.get(note.path);
		expect(readParticipants(afterRemoval ?? "", "participants")).toEqual([ALVA, BEA]);

		await run([ALVA, BEA, CAI]);

		expect(files.get(note.path)).toBe(afterRemoval);
	});

	it("records the added name in the same write and leaves the written fingerprint matching the note", async () => {
		const note = clickedNote([ALVA, BEA]);
		startFrom(note.text, note.path);
		expect(unchangedSinceWritten(note.text)).toBe(true);

		await run([ALVA, BEA, CAI]);

		const after = files.get(note.path) ?? "";
		expect(offeredInText(after)).toEqual([ALVA, BEA, CAI]);
		expect(unchangedSinceWritten(after)).toBe(true);
	});

	it.each([
		["ending in a line break", true],
		["not ending in a line break", false],
	])("grows the record of a Windows-endings note %s, in exact bytes", async (_name, endsInBreak) => {
		const note = clickedNote([ALVA, BEA]);
		const lf = endsInBreak ? note.text : note.text.slice(0, -1);
		startFrom(lf.replace(/\n/g, "\r\n"), note.path);

		await run([ALVA, BEA, CAI]);

		const expectedLf = lf
			.replace('  - "[[Bea Bergsten]]"\n', '  - "[[Bea Bergsten]]"\n  - "[[Cai Carlsson]]"\n')
			.replace(`effortless-offered: ${JSON.stringify([ALVA, BEA])}`, `effortless-offered: ${JSON.stringify([ALVA, BEA, CAI])}`);
		expect(expectedLf).not.toBe(lf);
		expect(files.get(note.path)).toBe(expectedLf.replace(/\n/g, "\r\n"));
	});
});
