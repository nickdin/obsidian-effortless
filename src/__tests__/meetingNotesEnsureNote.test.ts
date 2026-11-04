/**
 * The one pure decision at the heart of meeting notes — ticket
 * #761, carried from
 * `~/Devbox/calendar-scaffold/src/meeting-note.ts`'s `ensureNote` and
 * `ensureNotes` (`tests/meeting-note.test.ts`) with the template's English
 * field names substituted for the old Swedish ones and every fixture
 * invented.
 *
 * **§ Named differences, row 5**:
 * the old plugin's `forcedEffort`/`WORK_CALENDAR` mechanism does not come
 * across — every created note's effort field is blank, on every meeting,
 * with no per-calendar exception. Asserted directly below rather than
 * carried as its own test block, since `Meeting` has no calendar identity to
 * vary it by.
 *
 * **§ Named differences, row 6 is now parity, not a difference.** With the
 * occurrence key on `Meeting`,
 * a repeating meeting's one rescheduled occurrence is found under its own
 * identity and renamed, the same as the old plugin's per-occurrence
 * calendar id did — see *a repeating meeting's occurrence follows a
 * reschedule* below.
 *
 * No real name, address, path or calendar is in this file.
 */

import { describe, expect, it, vi } from "vitest";
import type { Meeting } from "../core/icsReader";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { ensureNote, ensureNotes } from "../features/meetingNotes/ensureNote";
import type { NoteLookup } from "../features/meetingNotes/ensureNote";
import { meetingIdentity } from "../features/meetingNotes/notesMemory";
import type { NoteMemoryEntry, NotesMemory } from "../features/meetingNotes/notesMemory";
import { meetingNotePath } from "../features/meetingNotes/notePath";
import { DEFAULT_TEMPLATE } from "../features/meetingNotes/types";
import type { MeetingNoteTemplate } from "../features/meetingNotes/types";

const DATE = "2026-09-18";
const FOLDER = "Meetings";
const SELF = "self@invented.test";

function layout(overrides: Partial<VaultLayout> = {}): VaultLayout {
	return {
		...defaultData().core.layout,
		dailyLogFolder: "Journal",
		dailyLogFilename: "YYYY-MM-DD",
		...overrides,
	};
}

function meeting(partial: Partial<Meeting> = {}): Meeting {
	return {
		uid: "uid-1",
		summary: "Weekly sync",
		location: null,
		description: null,
		organizer: null,
		attendees: [
			{ name: "Alva Almgren", email: "alva.almgren@invented.test" },
		],
		occurrenceKey: null,
		allDay: false,
		start: new Date(2026, 8, 18, 9, 0),
		end: new Date(2026, 8, 18, 9, 30),
		...partial,
	};
}

/** A vault as a plain record — a test's whole picture of "what is on disk". */
function vault(files: Record<string, string> = {}): NoteLookup {
	return {
		exists: (path) => path in files,
		read: (path) => files[path] ?? null,
	};
}

/** A memory entry, defaulting to nobody accounted for yet. */
function entry(path: string, accounted: readonly string[] = []): NoteMemoryEntry {
	return { path, accounted };
}

const PATH = meetingNotePath(FOLDER, DATE, "Weekly sync");

const CREATED_TEXT = [
	"---",
	"tags:",
	"  - meeting",
	"effort:",
	"participants:",
	'  - "[[Alva Almgren]]"',
	`day: "[[${DATE}]]"`,
	"processed:",
	'effortless-meeting: "uid-1"',
	'effortless-written: "73:1f6b3bc9f98567"',
	"---",
	"# Weekly sync",
	"",
	"## Agenda and purpose",
	"",
	"",
	"# Notes",
	"",
	"",
	"## Decisions and actions",
	"",
].join("\n");

function ensure(
	m: Meeting,
	date: string,
	files: Record<string, string>,
	memory: NotesMemory,
	template: MeetingNoteTemplate = DEFAULT_TEMPLATE,
	layoutOverride: VaultLayout = layout(),
) {
	return ensureNote(m, date, layoutOverride, FOLDER, vault(files), memory, template, SELF);
}

describe("ensureNote — the five outcomes, on outcome and whole text", () => {
	it("creates a note with the whole text noteText builds, from an empty vault and an empty memory", () => {
		const result = ensure(meeting(), DATE, {}, {});
		expect(result.outcome).toBe("created");
		expect(result.path).toBe(PATH);
		expect(result.text).toBe(CREATED_TEXT);
		expect(result.remember).toEqual({ identity: "uid-1", date: DATE, path: PATH, accounted: ["Alva Almgren"] });
	});

	it("leaves the person themselves out of a newly created note's participant list (carried over from the old plugin's suite)", () => {
		const result = ensure(
			meeting({
				attendees: [
					{ name: "Self Person", email: SELF },
					{ name: "Alva Almgren", email: "alva.almgren@invented.test" },
				],
				organizer: { name: "Self Person", email: SELF },
			}),
			DATE,
			{},
			{},
		);
		expect(result.text).toContain('participants:\n  - "[[Alva Almgren]]"\n');
		expect(result.text).not.toContain("Self Person");
	});

	it("adopts a note already at the computed path with no memory record, and returns no edit plan for it", () => {
		const his = "---\ntags:\n  - meeting\n---\n# Something else\n\nHis own text.\n";
		const result = ensure(meeting(), DATE, { [PATH]: his }, {});
		expect(result.outcome).toBe("adopted");
		expect(result.text).toBeUndefined();
		expect(result.applied).toEqual([]);
		expect(result.refused).toEqual([]);
		expect(result.remember).toEqual({ identity: "uid-1", date: DATE, path: PATH, accounted: ["Alva Almgren"] });
	});

	it("adopting a note never reads its content — only checks that it exists (code review, decision 10's own Adopt sentence)", () => {
		const his = "---\ntags:\n  - meeting\n---\n# Something else\n\nHis own text.\n";
		const read = vi.fn((path: string) => (path === PATH ? his : null));
		const lookup: NoteLookup = { exists: (path) => path === PATH, read };
		const result = ensureNote(meeting(), DATE, layout(), FOLDER, lookup, {}, DEFAULT_TEMPLATE, SELF);

		expect(result.outcome).toBe("adopted");
		expect(read).not.toHaveBeenCalled();
	});

	it("updates a matched note in place when the calendar has newly invited someone", () => {
		const his = [
			"---",
			"tags:",
			"  - meeting",
			"effort:",
			"participants:",
			`  - "[[Bea Bergsten]]"`,
			`day: "[[${DATE}]]"`,
			"processed:",
			"---",
			"# Weekly sync",
			"",
			"## Agenda and purpose",
			"",
			"",
			"# Notes",
			"",
			"",
			"## Decisions and actions",
			"",
		].join("\n");
		const memory: NotesMemory = { "uid-1": { [DATE]: entry(PATH, ["Bea Bergsten"]) } };
		const result = ensure(meeting(), DATE, { [PATH]: his }, memory);

		expect(result.outcome).toBe("updated");
		expect(result.applied).toEqual(["1 participant(s)"]);
		expect(result.text).toContain('  - "[[Bea Bergsten]]"\n  - "[[Alva Almgren]]"');
		expect(result.remember).toEqual({
			identity: "uid-1",
			date: DATE,
			path: PATH,
			accounted: ["Bea Bergsten", "Alva Almgren"],
		});
	});

	it("reports nothing-to-do when the memory names today's note and every invited name is already accounted for", () => {
		const memory: NotesMemory = { "uid-1": { [DATE]: entry(PATH, ["Alva Almgren"]) } };
		const result = ensure(meeting(), DATE, { [PATH]: CREATED_TEXT }, memory);

		expect(result.outcome).toBe("nothing-to-do");
		expect(result.text).toBeUndefined();
		expect(result.applied).toEqual([]);
	});

	it("is idempotent: repeated runs over an unchanged note stay nothing-to-do and never touch it", () => {
		const memory: NotesMemory = { "uid-1": { [DATE]: entry(PATH, ["Alva Almgren"]) } };
		for (let run = 0; run < 5; run++) {
			const result = ensure(meeting(), DATE, { [PATH]: CREATED_TEXT }, memory);
			expect(result.outcome).toBe("nothing-to-do");
			expect(result.text).toBeUndefined();
		}
	});

	it("renames a note found on a day the meeting no longer occurs on, correcting its heading and day link", () => {
		const oldPath = meetingNotePath(FOLDER, "2026-09-11", "Weekly sync");
		const his = [
			"---",
			"tags:",
			"  - meeting",
			"effort:",
			"participants:",
			'  - "[[Alva Almgren]]"',
			`day: "[[2026-09-11]]"`,
			"processed:",
			"---",
			"# Weekly sync",
			"",
			"## Agenda and purpose",
			"",
			"",
			"# Notes",
			"",
			"",
			"## Decisions and actions",
			"",
		].join("\n");
		const memory: NotesMemory = { "uid-1": { "2026-09-11": entry(oldPath, ["Alva Almgren"]) } };
		const result = ensure(meeting(), DATE, { [oldPath]: his }, memory);

		expect(result.outcome).toBe("renamed");
		expect(result.previousPath).toBe(oldPath);
		expect(result.path).toBe(PATH);
		expect(result.applied).toEqual(["day link"]);
		expect(result.text).toContain(`day: "[[${DATE}]]"`);
		expect(result.text).not.toContain("2026-09-11");
		expect(result.remember).toEqual({
			identity: "uid-1",
			date: DATE,
			path: PATH,
			accounted: ["Alva Almgren"],
		});
	});

	it("renames a note whose title also changed, correcting both the heading and the day link", () => {
		const oldPath = meetingNotePath(FOLDER, "2026-09-11", "Sync");
		const his = [
			"---",
			"tags:",
			"  - meeting",
			"effort:",
			"participants:",
			"day: \"[[2026-09-11]]\"",
			"processed:",
			"---",
			"# Sync",
			"",
			"## Agenda and purpose",
			"",
			"",
			"# Notes",
			"",
			"",
			"## Decisions and actions",
			"",
		].join("\n");
		const memory: NotesMemory = { "uid-1": { "2026-09-11": entry(oldPath) } };
		const result = ensure(meeting({ attendees: [] }), DATE, { [oldPath]: his }, memory);

		expect(result.outcome).toBe("renamed");
		expect([...result.applied].sort()).toEqual(["day link", "heading"]);
		expect(result.text).toContain("# Weekly sync");
		expect(result.text).toContain(`day: "[[${DATE}]]"`);
	});

	it("renames a note whose title changed on the same day it already occurs on", () => {
		// The old title's path and the newly computed one both carry today's
		// date, so a check keyed on "did the memory's day change" rather than
		// "did the computed path change" would route this to updateInPlace
		// instead — leaving the old file at its old title untouched while
		// claiming the (unwritten) new path as `path`.
		const oldPath = meetingNotePath(FOLDER, DATE, "Old title");
		const his = [
			"---",
			"tags:",
			"  - meeting",
			"effort:",
			"participants:",
			`day: "[[${DATE}]]"`,
			"processed:",
			"---",
			"# Old title",
			"",
			"## Agenda and purpose",
			"",
			"",
			"# Notes",
			"",
			"",
			"## Decisions and actions",
			"",
		].join("\n");
		const memory: NotesMemory = { "uid-1": { [DATE]: entry(oldPath) } };
		const result = ensure(meeting({ attendees: [], summary: "New title" }), DATE, { [oldPath]: his }, memory);

		expect(result.outcome).toBe("renamed");
		expect(result.previousPath).toBe(oldPath);
		expect(result.path).toBe(meetingNotePath(FOLDER, DATE, "New title"));
		expect(result.applied).toEqual(["heading"]);
		expect(result.text).toContain("# New title");
	});

	it("a changed meeting-notes folder is treated the same as a title change on the same day", () => {
		const oldFolder = "Old Meetings";
		const oldPath = meetingNotePath(oldFolder, DATE, "Weekly sync");
		const his = [
			"---",
			"tags:",
			"  - meeting",
			"effort:",
			"participants:",
			`day: "[[${DATE}]]"`,
			"processed:",
			"---",
			"# Weekly sync",
			"",
			"## Agenda and purpose",
			"",
			"",
			"# Notes",
			"",
			"",
			"## Decisions and actions",
			"",
		].join("\n");
		const memory: NotesMemory = { "uid-1": { [DATE]: entry(oldPath) } };
		const result = ensureNote(
			meeting({ attendees: [] }),
			DATE,
			layout(),
			FOLDER,
			vault({ [oldPath]: his }),
			memory,
			DEFAULT_TEMPLATE,
			SELF,
		);

		expect(result.outcome).toBe("renamed");
		expect(result.previousPath).toBe(oldPath);
		expect(result.path).toBe(meetingNotePath(FOLDER, DATE, "Weekly sync"));
	});
});

describe("ensureNote — what the caller should forget", () => {
	it("a rename tells the caller to forget the day the meeting has moved away from", () => {
		const oldPath = meetingNotePath(FOLDER, "2026-09-11", "Weekly sync");
		const his = [
			"---",
			"tags:",
			"  - meeting",
			"effort:",
			"participants:",
			'  - "[[Alva Almgren]]"',
			`day: "[[2026-09-11]]"`,
			"processed:",
			"---",
			"# Weekly sync",
			"",
			"## Agenda and purpose",
			"",
			"",
			"# Notes",
			"",
			"",
			"## Decisions and actions",
			"",
		].join("\n");
		const memory: NotesMemory = { "uid-1": { "2026-09-11": entry(oldPath, ["Alva Almgren"]) } };
		const result = ensure(meeting(), DATE, { [oldPath]: his }, memory);

		expect(result.outcome).toBe("renamed");
		expect(result.forget).toEqual(["2026-09-11"]);
	});

	it("a today entry whose file is gone is forgotten, even when nothing on disk replaces it", () => {
		// The memory names today's own note, but nothing is at that path any
		// more — deleted by hand outside the plugin. Nothing else is on disk
		// for this identity either, so the run makes a fresh note and still
		// says the dead entry should be dropped.
		const memory: NotesMemory = { "uid-1": { [DATE]: entry(PATH, ["Alva Almgren"]) } };
		const result = ensure(meeting(), DATE, {}, memory);

		expect(result.outcome).toBe("created");
		expect(result.forget).toEqual([DATE]);
	});

	it("does not forget anything on an ordinary nothing-to-do run", () => {
		const memory: NotesMemory = { "uid-1": { [DATE]: entry(PATH, ["Alva Almgren"]) } };
		const result = ensure(meeting(), DATE, { [PATH]: CREATED_TEXT }, memory);

		expect(result.outcome).toBe("nothing-to-do");
		expect(result.forget).toEqual([]);
	});
});

describe("ensureNote — refusals", () => {
	it("refuses the heading edit when the old line no longer says what this feature last wrote, and leaves it alone", () => {
		const oldPath = meetingNotePath(FOLDER, "2026-09-11", "Weekly sync");
		const his = [
			"---",
			"tags:",
			"  - meeting",
			"effort:",
			"participants:",
			`day: "[[2026-09-11]]"`,
			"processed:",
			"---",
			"# His own retitling",
			"",
			"## Agenda and purpose",
			"",
			"",
			"# Notes",
			"",
			"",
			"## Decisions and actions",
			"",
		].join("\n");
		const memory: NotesMemory = { "uid-1": { "2026-09-11": entry(oldPath) } };
		const result = ensure(
			meeting({ attendees: [], summary: "Weekly sync v2" }),
			DATE,
			{ [oldPath]: his },
			memory,
		);

		expect(result.outcome).toBe("renamed");
		expect(result.text).toContain("# His own retitling");
		expect(result.applied).toEqual(["day link"]);
		expect(result.refused).toEqual([
			`its heading reads "# His own retitling" rather than "# Weekly sync", so it was ` +
				`left as it is — the calendar now calls this meeting "Weekly sync v2"`,
		]);
	});

	it("a rename that applies no edit returns no text to write", () => {
		// The old path is not in this feature's own `YYYY-MM-DD Title` shape,
		// so the heading and day link are both left alone, and no participant
		// is wanted, so nothing else is applied either — applied ends up
		// empty. EnsureNoteResult.text's own contract says text is present on
		// renamed only once an edit was applied.
		const oldPath = "Meetings/Custom name.md";
		const his = [
			"---",
			"tags:",
			"  - meeting",
			"effort:",
			"participants:",
			`day: "[[2026-09-11]]"`,
			"processed:",
			"---",
			"# Custom name",
			"",
			"## Agenda and purpose",
			"",
			"",
			"# Notes",
			"",
			"",
			"## Decisions and actions",
			"",
		].join("\n");
		const memory: NotesMemory = { "uid-1": { "2026-09-11": entry(oldPath) } };
		const result = ensure(meeting({ attendees: [] }), DATE, { [oldPath]: his }, memory);

		expect(result.outcome).toBe("renamed");
		expect(result.applied).toEqual([]);
		expect(result.text).toBeUndefined();
	});

	it("refuses the rename entirely — with the memory untouched — when the target path is already occupied", () => {
		const oldPath = meetingNotePath(FOLDER, "2026-09-11", "Weekly sync");
		const memory: NotesMemory = { "uid-1": { "2026-09-11": entry(oldPath) } };
		const result = ensure(
			meeting(),
			DATE,
			{ [oldPath]: "his own text\n", [PATH]: "someone else's note, already here\n" },
			memory,
		);

		expect(result.outcome).toBe("collided");
		expect(result.remember).toBeNull();
		expect(result.refused).toHaveLength(1);
		expect(result.refused[0]).toContain(PATH);
		expect(result.refused[0]).toContain(oldPath);
	});

	it("refuses the second of two meetings that resolve to the same path within one run", () => {
		const results = ensureNotes(
			[meeting(), meeting({ uid: "uid-2", occurrenceKey: null })],
			DATE,
			layout(),
			FOLDER,
			vault({}),
			{},
			DEFAULT_TEMPLATE,
			SELF,
		);

		expect(results.map((r) => r.outcome)).toEqual(["created", "collided"]);
		expect(results[1].refused[0]).toContain("Weekly sync");
		expect(results[1].remember).toBeNull();
	});

	it("catches two titles that collide only after sanitising", () => {
		const results = ensureNotes(
			[
				meeting({ summary: "Status: part 1" }),
				meeting({ uid: "uid-2", occurrenceKey: null, summary: "Status part 1" }),
			],
			DATE,
			layout(),
			FOLDER,
			vault({}),
			{},
			DEFAULT_TEMPLATE,
			SELF,
		);

		expect(results.map((r) => r.outcome)).toEqual(["created", "collided"]);
	});

	it("still adopts an ordinary note through ensureNotes — the collision rule does not swallow it", () => {
		const results = ensureNotes([meeting()], DATE, layout(), FOLDER, vault({ [PATH]: "his text\n" }), {}, DEFAULT_TEMPLATE, SELF);
		expect(results.map((r) => r.outcome)).toEqual(["adopted"]);
	});
});

describe("ensureNote — occurrence identity", () => {
	it("a rescheduled occurrence colliding with another occurrence's own note is refused as a collision, not a rename", () => {
		// Occurrence identity, not this test, is what #778's own AC needs
		// asserted: see "a rescheduled occurrence moves to a free path...,
		// leaving the series' other occurrence untouched" below for a case
		// that can actually fail if the occurrence key were ignored. Kept
		// here for the collision itself, a legitimate but different case.
		const occurrenceA = meeting({
			uid: "series-1",
			occurrenceKey: "2026-09-11T09:00:00.000Z",
			summary: "Repeating check-in",
		});
		const occurrenceB = meeting({
			uid: "series-1",
			occurrenceKey: "2026-09-18T09:00:00.000Z",
			summary: "Repeating check-in",
		});
		const identityA = meetingIdentity("series-1", "2026-09-11T09:00:00.000Z");
		const identityB = meetingIdentity("series-1", "2026-09-18T09:00:00.000Z");

		const oldPathA = meetingNotePath(FOLDER, "2026-09-11", "Repeating check-in");
		const pathB = meetingNotePath(FOLDER, DATE, "Repeating check-in");
		const his = [
			"---",
			"tags:",
			"  - meeting",
			"effort:",
			"participants:",
			`day: "[[2026-09-11]]"`,
			"processed:",
			"---",
			"# Repeating check-in",
			"",
			"## Agenda and purpose",
			"",
			"",
			"# Notes",
			"",
			"",
			"## Decisions and actions",
			"",
		].join("\n");
		const memory: NotesMemory = {
			[identityA]: { "2026-09-11": entry(oldPathA) },
			[identityB]: { [DATE]: entry(pathB, ["Alva Almgren"]) },
		};
		const files = { [oldPathA]: his, [pathB]: CREATED_TEXT.replace("# Weekly sync", "# Repeating check-in") };

		const resultA = ensure(occurrenceA, DATE, files, memory);
		expect(resultA.outcome).toBe("collided");
		// Occurrence A's target is occupied by occurrence B's own, separate note
		// — a real collision, distinct from occurrence B being affected by A's
		// rename in any way. Confirmed below: B is still exactly where it was.
		const resultB = ensure(occurrenceB, DATE, files, memory);
		expect(resultB.outcome).toBe("nothing-to-do");
		expect(resultB.remember).toEqual({
			identity: identityB,
			date: DATE,
			path: pathB,
			accounted: ["Alva Almgren"],
		});
	});

	it("a rescheduled occurrence moves to a free path and renames under its own key, leaving the series' other occurrence on today untouched", () => {
		// If ensureNote used meeting.uid alone as the identity, ignoring
		// occurrenceKey, both calls below would look up memory["series-4"] —
		// empty, since this test's own memory is keyed by the full compound
		// identity — and A would report created instead of renamed, while B,
		// whose computed path IS already on disk, would report adopted
		// instead of nothing-to-do.
		const occurrenceA = meeting({
			uid: "series-4",
			occurrenceKey: "2026-09-11T09:00:00.000Z",
			summary: "Moved occurrence",
			attendees: [],
		});
		const occurrenceB = meeting({
			uid: "series-4",
			occurrenceKey: "2026-09-18T09:00:00.000Z",
			summary: "Anchored occurrence",
		});
		const identityA = meetingIdentity("series-4", "2026-09-11T09:00:00.000Z");
		const identityB = meetingIdentity("series-4", "2026-09-18T09:00:00.000Z");

		const oldPathA = meetingNotePath(FOLDER, "2026-09-11", "Moved occurrence");
		const pathB = meetingNotePath(FOLDER, DATE, "Anchored occurrence");
		const hisA = [
			"---",
			"tags:",
			"  - meeting",
			"effort:",
			"participants:",
			`day: "[[2026-09-11]]"`,
			"processed:",
			"---",
			"# Moved occurrence",
			"",
			"## Agenda and purpose",
			"",
			"",
			"# Notes",
			"",
			"",
			"## Decisions and actions",
			"",
		].join("\n");
		const textB = CREATED_TEXT.replace("# Weekly sync", "# Anchored occurrence");
		const memory: NotesMemory = {
			[identityA]: { "2026-09-11": entry(oldPathA) },
			[identityB]: { [DATE]: entry(pathB, ["Alva Almgren"]) },
		};
		const files = { [oldPathA]: hisA, [pathB]: textB };

		const resultA = ensure(occurrenceA, DATE, files, memory);
		expect(resultA.outcome).toBe("renamed");
		expect(resultA.previousPath).toBe(oldPathA);
		expect(resultA.path).toBe(meetingNotePath(FOLDER, DATE, "Moved occurrence"));

		const resultB = ensure(occurrenceB, DATE, files, memory);
		expect(resultB.outcome).toBe("nothing-to-do");
		expect(resultB.remember).toEqual({
			identity: identityB,
			date: DATE,
			path: pathB,
			accounted: ["Alva Almgren"],
		});
	});

	it("a rescheduled occurrence moving to a free path renames cleanly under its own identity", () => {
		const occurrence = meeting({
			uid: "series-2",
			occurrenceKey: "2026-09-11T09:00:00.000Z",
			summary: "Standalone check-in",
			attendees: [],
		});
		const identity = meetingIdentity("series-2", "2026-09-11T09:00:00.000Z");
		const oldPath = meetingNotePath(FOLDER, "2026-09-11", "Standalone check-in");
		const his = [
			"---",
			"tags:",
			"  - meeting",
			"effort:",
			"participants:",
			`day: "[[2026-09-11]]"`,
			"processed:",
			"---",
			"# Standalone check-in",
			"",
			"## Agenda and purpose",
			"",
			"",
			"# Notes",
			"",
			"",
			"## Decisions and actions",
			"",
		].join("\n");
		const memory: NotesMemory = { [identity]: { "2026-09-11": entry(oldPath) } };

		const result = ensure(occurrence, DATE, { [oldPath]: his }, memory);
		expect(result.outcome).toBe("renamed");
		expect(result.remember).toEqual({
			identity,
			date: DATE,
			path: meetingNotePath(FOLDER, DATE, "Standalone check-in"),
			accounted: [],
		});
	});

	it("two occurrences of one series on one day each get their own note and their own memory entry", () => {
		const first = meeting({
			uid: "series-3",
			occurrenceKey: "2026-09-11T09:00:00.000Z",
			summary: "Rescheduled catch-up",
		});
		const second = meeting({
			uid: "series-3",
			occurrenceKey: "2026-09-18T09:00:00.000Z",
			summary: "Regular catch-up",
		});

		const results = ensureNotes([first, second], DATE, layout(), FOLDER, vault({}), {}, DEFAULT_TEMPLATE, SELF);

		expect(results.map((r) => r.outcome)).toEqual(["created", "created"]);
		expect(results[0].path).not.toBe(results[1].path);
		expect(results[0].remember?.identity).not.toBe(results[1].remember?.identity);
	});
});

describe("ensureNote — the effort field is blank for every created note (§ Named differences row 5)", () => {
	it("starts effort blank with no calendar to vary it by", () => {
		const result = ensure(meeting({ attendees: [] }), DATE, {}, {});
		expect(result.text).toContain("\neffort:\nparticipants:");
	});
});

describe("ensureNote — the day link is resolved through the core's own day naming", () => {
	it("a non-default daily-log filename pattern reaches a created note's day link", () => {
		const custom = layout({ dailyLogFilename: "dddd D MMMM YYYY" });
		const result = ensure(meeting({ attendees: [] }), DATE, {}, {}, DEFAULT_TEMPLATE, custom);

		expect(result.text).toContain('day: "[[Friday 18 September 2026]]"');
		expect(result.text).not.toContain(`[[${DATE}]]`);
	});

	it("a non-default pattern reaches the corrected day link on a rename too", () => {
		const custom = layout({ dailyLogFilename: "dddd D MMMM YYYY" });
		const oldPath = meetingNotePath(FOLDER, "2026-09-11", "Weekly sync");
		const his = [
			"---",
			"tags:",
			"  - meeting",
			"effort:",
			"participants:",
			`day: "[[Friday 11 September 2026]]"`,
			"processed:",
			"---",
			"# Weekly sync",
			"",
			"## Agenda and purpose",
			"",
			"",
			"# Notes",
			"",
			"",
			"## Decisions and actions",
			"",
		].join("\n");
		const memory: NotesMemory = { "uid-1": { "2026-09-11": entry(oldPath) } };
		const result = ensure(meeting({ attendees: [] }), DATE, { [oldPath]: his }, memory, DEFAULT_TEMPLATE, custom);

		expect(result.outcome).toBe("renamed");
		expect(result.applied).toEqual(["day link"]);
		expect(result.text).toContain('day: "[[Friday 18 September 2026]]"');
	});
});

describe("ensureNote — a blank daily-log layout", () => {
	it("does not throw when the layout is blank and the outcome needs no day link at all", () => {
		const blank = layout({ dailyLogFolder: "", dailyLogFilename: "" });
		const memory: NotesMemory = { "uid-1": { [DATE]: entry(PATH, ["Alva Almgren"]) } };
		const result = ensure(meeting(), DATE, { [PATH]: CREATED_TEXT }, memory, DEFAULT_TEMPLATE, blank);

		expect(result.outcome).toBe("nothing-to-do");
	});

	it("does not throw when adopting under a blank layout either", () => {
		const blank = layout({ dailyLogFolder: "", dailyLogFilename: "" });
		const his = "---\ntags:\n  - meeting\n---\n# Something else\n\nHis own text.\n";
		const result = ensure(meeting(), DATE, { [PATH]: his }, {}, DEFAULT_TEMPLATE, blank);

		expect(result.outcome).toBe("adopted");
	});

	it("refuses to create a note under a blank daily-log folder, naming the setting to fix", () => {
		const blank = layout({ dailyLogFolder: "" });
		const result = ensure(meeting({ attendees: [] }), DATE, {}, {}, DEFAULT_TEMPLATE, blank);

		expect(result.outcome).toBe("collided");
		expect(result.text).toBeUndefined();
		expect(result.remember).toBeNull();
		expect(result.refused).toHaveLength(1);
		expect(result.refused[0]).toContain("The daily-log folder is not set");
		expect(result.refused[0]).toContain("Effortless settings screen");
	});

	it("refuses to create a note under a blank daily-log filename pattern too", () => {
		const blank = layout({ dailyLogFilename: "" });
		const result = ensure(meeting({ attendees: [] }), DATE, {}, {}, DEFAULT_TEMPLATE, blank);

		expect(result.outcome).toBe("collided");
		expect(result.refused[0]).toContain("The daily-log filename pattern is not set");
	});

	it("refuses a rename under a blank daily-log layout the same way, leaving the old note untouched", () => {
		const blank = layout({ dailyLogFolder: "" });
		const oldPath = meetingNotePath(FOLDER, "2026-09-11", "Weekly sync");
		const his = [
			"---",
			"tags:",
			"  - meeting",
			"effort:",
			"participants:",
			'  - "[[Alva Almgren]]"',
			`day: "[[2026-09-11]]"`,
			"processed:",
			"---",
			"# Weekly sync",
			"",
			"## Agenda and purpose",
			"",
			"",
			"# Notes",
			"",
			"",
			"## Decisions and actions",
			"",
		].join("\n");
		const memory: NotesMemory = { "uid-1": { "2026-09-11": entry(oldPath, ["Alva Almgren"]) } };
		const result = ensure(meeting(), DATE, { [oldPath]: his }, memory, DEFAULT_TEMPLATE, blank);

		expect(result.outcome).toBe("collided");
		expect(result.remember).toBeNull();
		expect(result.refused[0]).toContain("The daily-log folder is not set");
	});
});

describe("ensureNote — a custom template's field names reach the whole created text", () => {
	const custom: MeetingNoteTemplate = {
		tag: "invented-tag",
		effortField: "invented-effort",
		participantsField: "invented-participants",
		notesHeading: "# Invented notes",
		agendaHeading: "## Invented agenda",
		decisionsHeading: "## Invented decisions",
	};

	it("uses none of the English defaults when a custom template is given", () => {
		const result = ensure(
			meeting({ attendees: [] }),
			DATE,
			{},
			{},
			custom,
			layout({ dayLinkField: "invented-day", processedField: "invented-processed" }),
		);
		expect(result.text).toContain("invented-tag");
		expect(result.text).toContain("invented-day");
		expect(result.text).toContain("## Invented agenda");
		expect(result.text).not.toContain("- meeting\n");
		expect(result.text).not.toContain("## Agenda and purpose");
	});
});

describe("ensureNote — accounted: a name is offered at most once (send-back on #761)", () => {
	// The old suite has no case for this mechanism — `known`, the ledger field
	// it descends from, is exercised only through the ledger's own code, never
	// through `meeting-note.test.ts`'s `ensureNote`/`ensureNotes` cases (the
	// central parity corpus). Nearest kin: AC7's "byte-identical after many
	// runs", which this ticket's own *is idempotent* test above already
	// carries — adoption's own idempotency, not the accounted-list guarantee
	// these three add.

	const both = meeting({
		attendees: [
			{ name: "Alva Almgren", email: "alva.almgren@invented.test" },
			{ name: "Bea Bergsten", email: "bea.bergsten@invented.test" },
		],
	});
	const bothText = [
		"---",
		"tags:",
		"  - meeting",
		"effort:",
		"participants:",
		'  - "[[Alva Almgren]]"',
		`day: "[[${DATE}]]"`,
		"processed:",
		"---",
		"# Weekly sync",
		"",
		"## Agenda and purpose",
		"",
		"",
		"# Notes",
		"",
		"",
		"## Decisions and actions",
		"",
	].join("\n");

	it("(a) adopts, then on the next run with the same participants: no edit plan, no names added", () => {
		// What the code would report if accounted were not carried forward:
		// `readParticipants` finds no list at all in this hand-written text, so
		// the next run would try to add both names and refuse, rather than
		// reporting nothing-to-do outright.
		const his = "---\ntags:\n  - meeting\n---\n# Something else\n\nHis own text.\n";
		const adopted = ensure(both, DATE, { [PATH]: his }, {});
		expect(adopted.outcome).toBe("adopted");
		expect(adopted.remember).not.toBeNull();

		const memory: NotesMemory = {
			"uid-1": { [DATE]: entry(adopted.remember!.path, adopted.remember!.accounted) },
		};
		const next = ensure(both, DATE, { [PATH]: his }, memory);

		expect(next.outcome).toBe("nothing-to-do");
		expect(next.text).toBeUndefined();
		expect(next.applied).toEqual([]);
		expect(next.refused).toEqual([]);
	});

	it("(b) adopts, then a newly invited person on the next run: only that person is added, decided from accounted rather than the note's own text", () => {
		// The note's own list is empty here — on purpose. bothText already
		// lists Alva, so a text-only check (namesToAdd's own readParticipants
		// fallback, with accounted ignored entirely) would report the exact
		// same outcome, count and text as accounted does: this is the update
		// test above (line 150) again, not evidence for accounted. With an
		// empty list, the two disagree: accounted adds only Bea; text-only
		// would add both Alva and Bea, since neither is on the note.
		const emptyParticipants = [
			"---",
			"tags:",
			"  - meeting",
			"effort:",
			"participants:",
			`day: "[[${DATE}]]"`,
			"processed:",
			"---",
			"# Weekly sync",
			"",
			"## Agenda and purpose",
			"",
			"",
			"# Notes",
			"",
			"",
			"## Decisions and actions",
			"",
		].join("\n");
		const memory: NotesMemory = { "uid-1": { [DATE]: entry(PATH, ["Alva Almgren"]) } };
		const result = ensure(both, DATE, { [PATH]: emptyParticipants }, memory);

		expect(result.outcome).toBe("updated");
		expect(result.applied).toEqual(["1 participant(s)"]);
		expect(result.text).toContain('participants:\n  - "[[Bea Bergsten]]"');
		expect(result.text).not.toContain("Alva Almgren");
		expect(result.remember).toEqual({
			identity: "uid-1",
			date: DATE,
			path: PATH,
			accounted: ["Alva Almgren", "Bea Bergsten"],
		});
	});

	it("(c) a name removed from the note by hand is not re-added on the next run", () => {
		// What the code would report against the note's text alone, without
		// accounted: Bea is not on the list any more, so a text-only check would
		// offer her again — exactly the regression this send-back exists for.
		const bothAccounted: NotesMemory = {
			"uid-1": { [DATE]: entry(PATH, ["Alva Almgren", "Bea Bergsten"]) },
		};
		const handEdited = bothText; // Bea was never written here — removed by hand.
		const result = ensure(both, DATE, { [PATH]: handEdited }, bothAccounted);

		expect(result.outcome).toBe("nothing-to-do");
		expect(result.text).toBeUndefined();
		expect(result.applied).toEqual([]);
	});
});

describe("ensureNote — a rename's correction still owed", () => {
	const OLD_DATE = "2026-09-11";
	const NEW_PATH = meetingNotePath(FOLDER, DATE, "Weekly planning");
	/** The note as a rename left it: at today's path, still reading the old heading and the old day link. */
	const OWING = CREATED_TEXT.replace(`day: "[[${DATE}]]"`, `day: "[[${OLD_DATE}]]"`);
	const PENDING = { heading: "Weekly sync", dayLink: OLD_DATE };

	it("at today's path with a correction owed, plans the heading and day link fresh from today's meeting", () => {
		const memory: NotesMemory = { "uid-1": { [DATE]: { path: NEW_PATH, accounted: ["Alva Almgren"], pendingCorrection: PENDING } } };
		const result = ensure(meeting({ summary: "Weekly planning" }), DATE, { [NEW_PATH]: OWING }, memory);

		expect(result.outcome).toBe("updated");
		expect(result.path).toBe(NEW_PATH);
		expect(result.text).toBe(
			CREATED_TEXT.replace("# Weekly sync", "# Weekly planning").replace('effortless-written: "73:1f6b3bc9f98567"', 'effortless-written: "77:17b7c9b0cf51da"'),
		);
		expect(result.applied).toEqual(["heading", "day link"]);
		expect(result.refused).toEqual([]);
		expect(result.owed).toEqual(PENDING);
		// What to store once the write lands: nothing owed any more.
		expect(result.remember).toEqual({ identity: "uid-1", date: DATE, path: NEW_PATH, accounted: ["Alva Almgren"] });
	});

	it("the same note with no correction owed is nothing-to-do — the memory's marker, not the note's text, decides", () => {
		const memory: NotesMemory = { "uid-1": { [DATE]: entry(NEW_PATH, ["Alva Almgren"]) } };
		const result = ensure(meeting({ summary: "Weekly planning" }), DATE, { [NEW_PATH]: OWING }, memory);
		expect(result.outcome).toBe("nothing-to-do");
		expect(result.text).toBeUndefined();
		expect(result.owed).toBeUndefined();
	});

	it("merges a newly invited participant into the same plan as the owed correction", () => {
		const memory: NotesMemory = { "uid-1": { [DATE]: { path: NEW_PATH, accounted: ["Alva Almgren"], pendingCorrection: PENDING } } };
		const result = ensure(
			meeting({
				summary: "Weekly planning",
				attendees: [
					{ name: "Alva Almgren", email: "alva.almgren@invented.test" },
					{ name: "Bo Bergsten", email: "bo.bergsten@invented.test" },
				],
			}),
			DATE,
			{ [NEW_PATH]: OWING },
			memory,
		);

		expect(result.outcome).toBe("updated");
		expect(result.applied).toEqual(["heading", "day link", "1 participant(s)"]);
		expect(result.text).toBe(
			CREATED_TEXT.replace("# Weekly sync", "# Weekly planning")
				.replace('effortless-written: "73:1f6b3bc9f98567"', 'effortless-written: "77:17b7c9b0cf51da"')
				.replace('  - "[[Alva Almgren]]"\n', '  - "[[Alva Almgren]]"\n  - "[[Bo Bergsten]]"\n'),
		);
		expect(result.remember?.accounted).toEqual(["Alva Almgren", "Bo Bergsten"]);
	});

	it("a correction the person has since made by hand is refused and reported, and no longer owed once this plan is carried out", () => {
		const handEdited = OWING.replace("# Weekly sync", "# My own heading");
		const memory: NotesMemory = { "uid-1": { [DATE]: { path: NEW_PATH, accounted: ["Alva Almgren"], pendingCorrection: PENDING } } };
		const result = ensure(meeting({ summary: "Weekly planning" }), DATE, { [NEW_PATH]: handEdited }, memory);

		expect(result.applied).toEqual(["day link"]);
		expect(result.text).toContain("# My own heading");
		expect(result.refused).toHaveLength(1);
		expect(result.refused[0]).toContain('"# My own heading"');
		expect(result.remember?.pendingCorrection).toBeUndefined();
	});

	it("under a blank daily-log layout the owed correction cannot be computed: nothing is written and the memory is left owing it", () => {
		const memory: NotesMemory = { "uid-1": { [DATE]: { path: NEW_PATH, accounted: ["Alva Almgren"], pendingCorrection: PENDING } } };
		const result = ensure(
			meeting({ summary: "Weekly planning" }),
			DATE,
			{ [NEW_PATH]: OWING },
			memory,
			DEFAULT_TEMPLATE,
			layout({ dailyLogFolder: "" }),
		);
		expect(result.outcome).toBe("collided");
		expect(result.text).toBeUndefined();
		expect(result.remember).toBeNull();
		expect(result.owed).toEqual(PENDING);
		expect(result.refused).toHaveLength(1);
	});

	it("a rename hands back, as owed, what the note reads before its correction", () => {
		const oldPath = meetingNotePath(FOLDER, OLD_DATE, "Weekly sync");
		const memory: NotesMemory = { "uid-1": { [OLD_DATE]: entry(oldPath, ["Alva Almgren"]) } };
		const result = ensure(meeting({ summary: "Weekly planning" }), DATE, { [oldPath]: OWING }, memory);
		expect(result.outcome).toBe("renamed");
		expect(result.owed).toEqual(PENDING);
		expect(result.remember?.pendingCorrection).toBeUndefined();
	});

	it("renaming a note that still owes a correction corrects from what it still reads, not from its current name", () => {
		// Renamed once to "Weekly planning" without its correction landing, now
		// renamed again to "Weekly review": the note still reads "# Weekly sync".
		const memory: NotesMemory = { "uid-1": { [DATE]: { path: NEW_PATH, accounted: ["Alva Almgren"], pendingCorrection: PENDING } } };
		const result = ensure(meeting({ summary: "Weekly review" }), DATE, { [NEW_PATH]: OWING }, memory);

		expect(result.outcome).toBe("renamed");
		expect(result.path).toBe(meetingNotePath(FOLDER, DATE, "Weekly review"));
		expect(result.applied).toEqual(["heading", "day link"]);
		expect(result.text).toBe(
			CREATED_TEXT.replace("# Weekly sync", "# Weekly review").replace('effortless-written: "73:1f6b3bc9f98567"', 'effortless-written: "75:13c0428d01be7e"'),
		);
		expect(result.owed).toEqual(PENDING);
	});
});
