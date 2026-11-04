/**
 * One run over today (spec #701
 * decisions 4, 5 and 7, ticket #762):
 * `runMeetingNotes` against fakes of the calendar, the vault and the core's
 * writer — the shape `daysAheadRunParity.test.ts` uses for `runWindow`
 * (`FakeNotes`). What decides each meeting's own outcome is
 * `ensureNote`, already carried by `meetingNotesEnsureNote.test.ts`'s own
 * suite; these tests are about the orchestration around it — which of
 * `create`/`rename`/`edit` a plan reaches for, when the memory actually
 * changes, and when a standing problem is raised or cleared — not about
 * re-proving `ensureNote`'s own decisions.
 *
 * The timer, the switch-to-`ready` behaviour and the real `NoteWriter`
 * wiring are `meetingNotesRunTimers.test.ts`'s own suite.
 *
 * No real name, address, path or calendar is in this file.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import { Notice } from "./__mocks__/obsidian";
import type { Meeting } from "../core/icsReader";
import type { FeatureProblems } from "../core/problems";
import { Problems } from "../core/problems";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { meetingNotePath } from "../features/meetingNotes/notePath";
import type { NoteMemoryEntry, NotesMemory } from "../features/meetingNotes/notesMemory";
import { runMeetingNotes } from "../features/meetingNotes/run";
import type { RunCalendar, RunDeps, RunNotes, RunProblems, RunVault } from "../features/meetingNotes/run";
import { DEFAULT_TEMPLATE } from "../features/meetingNotes/types";

const DATE = "2026-09-18";
const TODAY = new Date(2026, 8, 18);
const FOLDER = "Meetings";
const SELF = "self@invented.test";

function layout(): VaultLayout {
	return {
		...defaultData().core.layout,
		dailyLogFolder: "Journal",
		dailyLogFilename: "YYYY-MM-DD",
	};
}

function meeting(partial: Partial<Meeting> = {}): Meeting {
	return {
		uid: "uid-1",
		summary: "Weekly sync",
		location: null,
		description: null,
		organizer: null,
		attendees: [{ name: "Alva Almgren", email: "alva.almgren@invented.test" }],
		occurrenceKey: null,
		allDay: false,
		start: new Date(2026, 8, 18, 9, 0),
		end: new Date(2026, 8, 18, 9, 30),
		...partial,
	};
}

function entry(path: string, accounted: readonly string[] = []): NoteMemoryEntry {
	return { path, accounted };
}

function file(path: string): TFile {
	return { path } as unknown as TFile;
}

/**
 * Records `meetingsOn`'s own arguments and answers a third, non-note-making
 * meeting whenever asked for the wrong day or the wrong use — so a run that
 * asked for tomorrow, or for `"day"`, fails rather than passing by
 * construction.
 */
function fakeCalendar(
	meetings: readonly Meeting[],
	day: Date = TODAY,
): RunCalendar & { readonly calls: Array<{ day: Date; use: "day" | "notes" }> } {
	const calls: Array<{ day: Date; use: "day" | "notes" }> = [];
	const wrongMeeting = meeting({ uid: "uid-wrong-ask", summary: "Should never be handed to this run" });
	return {
		presenceBetween: () => ({ whole: false, meetings: [] }),
		calls,
		refresh: async () => undefined,
		meetingsOn: (askedDay, use) => {
			calls.push({ day: askedDay, use });
			if (use !== "notes" || askedDay.getTime() !== day.getTime()) return [wrongMeeting];
			return meetings;
		},
	};
}

/** A vault and the writer over it, sharing one map so a create is visible to a later read in the same test. */
function fakeVaultAndNotes(
	files: Map<string, string>,
): { vault: RunVault; notes: RunNotes & { createdPaths: string[]; renamedPaths: Array<{ from: string; to: string }>; editedPaths: string[] } } {
	const createdPaths: string[] = [];
	const renamedPaths: Array<{ from: string; to: string }> = [];
	const editedPaths: string[] = [];

	const vault: RunVault = {
		exists: (path) => files.has(path),
		read: async (path) => files.get(path) ?? null,
		fileAt: (path) => (files.has(path) ? file(path) : null),
	};

	const notes: RunNotes & { createdPaths: string[]; renamedPaths: Array<{ from: string; to: string }>; editedPaths: string[] } = {
		trashIf: async () => { throw new Error("no note is deleted in this test"); },
		createdPaths,
		renamedPaths,
		editedPaths,
		async create(path, text) {
			if (files.has(path)) throw new Error(`already exists: ${path}`);
			files.set(path, text);
			createdPaths.push(path);
			return file(path);
		},
		async rename(target, newPath) {
			const mutable = target as unknown as { path: string };
			const content = files.get(mutable.path);
			if (content === undefined) throw new Error(`no fake content for ${mutable.path}`);
			files.delete(mutable.path);
			files.set(newPath, content);
			renamedPaths.push({ from: mutable.path, to: newPath });
			mutable.path = newPath;
		},
		async edit(target, edit) {
			const path = (target as unknown as { path: string }).path;
			editedPaths.push(path);
			const next = edit(files.get(path) ?? "");
			files.set(path, next);
			return next;
		},
	};

	return { vault, notes };
}

/** Bare-recording, matching `daysAheadRunParity.test.ts`'s own `fakeProblems`. */
function fakeProblems(): RunProblems & { reports: Array<{ key: string; message: string }>; cleared: string[] } {
	const reports: Array<{ key: string; message: string }> = [];
	const cleared: string[] = [];
	const standing = new Set<string>();
	return {
		reports,
		cleared,
		report: (key, message) => {
			reports.push({ key, message });
			standing.add(key);
		},
		clear: (key) => {
			cleared.push(key);
			standing.delete(key);
		},
		list: () => [...standing],
	};
}

/**
 * `channel`, tracking which keys are currently standing so it can answer
 * `RunProblems.list()` — the real `FeatureProblems` has no route back to
 * what is standing (`src/core/problems.ts`'s own doc comment), so
 * `meetingNotes.ts`'s real wiring keeps this list itself; this mirrors that
 * for tests that exercise the real `Problems` class's own dedup.
 */
function trackedProblems(channel: FeatureProblems): RunProblems {
	const standing = new Set<string>();
	return {
		report: (key, message) => {
			standing.add(key);
			channel.report(key, message);
		},
		clear: (key) => {
			standing.delete(key);
			channel.clear(key);
		},
		list: () => [...standing],
	};
}

function depsWith(overrides: Partial<RunDeps> & Pick<RunDeps, "calendar" | "vault" | "notes">): RunDeps {
	return {
		problems: fakeProblems(),
		layout: layout(),
		folder: FOLDER,
		template: DEFAULT_TEMPLATE,
		selfEmail: SELF,
		today: TODAY,
		memory: {},
		commitMemory: async () => undefined,
		...overrides,
	};
}

beforeEach(() => {
	Notice.messages = [];
});

describe("a run's own writes", () => {
	it("creates a note for each meeting whose source makes notes, at the computed path, and remembers two entries", async () => {
		const files = new Map<string, string>();
		const { vault, notes } = fakeVaultAndNotes(files);
		const standup = meeting({ uid: "uid-standup", summary: "Standup", start: new Date(2026, 8, 18, 9, 0) });
		const review = meeting({ uid: "uid-review", summary: "Review", start: new Date(2026, 8, 18, 11, 0) });

		let committed: NotesMemory | undefined;
		const calendar = fakeCalendar([standup, review]);
		await runMeetingNotes(
			depsWith({
				calendar,
				vault,
				notes,
				commitMemory: async (memory) => {
					committed = memory;
				},
			}),
		);

		// The run asked today's date and "notes", never another day or use — a
		// fake that ignored either argument would still pass every assertion
		// below, so this is what actually exercises decision 5.
		expect(calendar.calls).toEqual([{ day: TODAY, use: "notes" }]);
		expect(notes.createdPaths.sort()).toEqual(
			[meetingNotePath(FOLDER, DATE, "Standup"), meetingNotePath(FOLDER, DATE, "Review")].sort(),
		);
		expect(committed?.["uid-standup"]?.[DATE]?.path).toBe(meetingNotePath(FOLDER, DATE, "Standup"));
		expect(committed?.["uid-review"]?.[DATE]?.path).toBe(meetingNotePath(FOLDER, DATE, "Review"));
		// The third, non-note-making meeting the fake calendar would answer for
		// the wrong day or use is never written — only the two handed back for
		// today's own "notes" ask.
		expect(committed?.["uid-wrong-ask"]).toBeUndefined();
	});

	it("renames a meeting moved to today from a remembered day, rather than creating a second note", async () => {
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
		const files = new Map([[oldPath, his]]);
		const { vault, notes } = fakeVaultAndNotes(files);
		const memory: NotesMemory = { "uid-1": { "2026-09-11": entry(oldPath, ["Alva Almgren"]) } };

		let committed: NotesMemory | undefined;
		await runMeetingNotes(
			depsWith({
				calendar: fakeCalendar([meeting()]),
				vault,
				notes,
				memory,
				commitMemory: async (next) => {
					committed = next;
				},
			}),
		);

		expect(notes.createdPaths).toEqual([]);
		expect(notes.renamedPaths).toEqual([{ from: oldPath, to: meetingNotePath(FOLDER, DATE, "Weekly sync") }]);
		expect(committed?.["uid-1"]?.[DATE]?.path).toBe(meetingNotePath(FOLDER, DATE, "Weekly sync"));
		expect(committed?.["uid-1"]?.["2026-09-11"]).toBeUndefined();
	});

	it("carries out a rename with a correction in the same plan through the writer's edit, not a second write of its own", async () => {
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
		const files = new Map([[oldPath, his]]);
		const { vault, notes } = fakeVaultAndNotes(files);
		const memory: NotesMemory = { "uid-1": { "2026-09-11": entry(oldPath) } };

		await runMeetingNotes(
			depsWith({ calendar: fakeCalendar([meeting()]), vault, notes, memory }),
		);

		const newPath = meetingNotePath(FOLDER, DATE, "Weekly sync");
		expect(notes.renamedPaths).toEqual([{ from: oldPath, to: newPath }]);
		expect(notes.editedPaths).toEqual([newPath]);
		expect(files.get(newPath)).toContain(`day: "[[${DATE}]]"`);
	});

	it("renames without a following edit when the plan applies no correction", async () => {
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
		const files = new Map([[oldPath, his]]);
		const { vault, notes } = fakeVaultAndNotes(files);
		const memory: NotesMemory = { "uid-1": { "2026-09-11": entry(oldPath) } };

		await runMeetingNotes(
			depsWith({ calendar: fakeCalendar([meeting({ attendees: [] })]), vault, notes, memory }),
		);

		expect(notes.renamedPaths).toHaveLength(1);
		expect(notes.editedPaths).toEqual([]);
	});

	it("writes nothing, and commits no memory, on a second run over an already-current note", async () => {
		const files = new Map<string, string>();
		const { vault, notes } = fakeVaultAndNotes(files);
		let memory: NotesMemory = {};
		let commits = 0;

		await runMeetingNotes(
			depsWith({
				calendar: fakeCalendar([meeting()]),
				vault,
				notes,
				commitMemory: async (next) => {
					memory = next;
					commits++;
				},
			}),
		);
		expect(notes.createdPaths).toHaveLength(1);
		expect(commits).toBe(1);

		await runMeetingNotes(
			depsWith({
				calendar: fakeCalendar([meeting()]),
				vault,
				notes,
				memory,
				commitMemory: async () => {
					commits++;
				},
			}),
		);

		// Nothing-to-do: the note this feature made a moment ago already
		// matches, so the second run's own plan reaches for no write at all.
		expect(notes.createdPaths).toHaveLength(1);
		expect(notes.renamedPaths).toEqual([]);
		expect(notes.editedPaths).toEqual([]);
		expect(commits).toBe(1);
	});
});

describe("a correction released while the person was typing", () => {
	it("never overwrites the fresh content a parked write is released against with the pre-loop snapshot", async () => {
		const path = meetingNotePath(FOLDER, DATE, "Weekly sync");
		const original = [
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
		].join("\n");
		const files = new Map([[path, original]]);
		const { vault, notes: baseNotes } = fakeVaultAndNotes(files);

		const typedLine = "a line the person typed while the write was parked on their open note";
		const notes: RunNotes = {
			trashIf: async () => { throw new Error("no note is deleted in this test"); },
			create: baseNotes.create,
			rename: baseNotes.rename,
			// `NoteWriter.edit` hands the callback the note as it is *now* — here,
			// with the person's own typing added between this run's pre-loop read
			// and the moment the parked write is finally released.
			async edit(target, edit) {
				const targetPath = (target as unknown as { path: string }).path;
				const withTyping = `${files.get(targetPath) ?? ""}\n${typedLine}`;
				files.set(targetPath, withTyping);
				const next = edit(withTyping);
				files.set(targetPath, next);
				return next;
			},
		};

		const memory: NotesMemory = { "uid-1": { [DATE]: entry(path, []) } };
		const problems = fakeProblems();

		await runMeetingNotes(depsWith({ calendar: fakeCalendar([meeting()]), vault, notes, memory, problems }));

		expect(files.get(path)).toContain(typedLine);
	});
});

describe("a run's own rejection, never an unhandled one", () => {
	it("reports a standing problem under a fixed key when the calendar refresh rejects", async () => {
		const calendar: RunCalendar = {
			presenceBetween: () => ({ whole: false, meetings: [] }),
			refresh: async () => {
				throw new Error("calendar source unreachable");
			},
			meetingsOn: () => [],
		};
		const files = new Map<string, string>();
		const { vault, notes } = fakeVaultAndNotes(files);
		const problems = fakeProblems();

		await runMeetingNotes(depsWith({ calendar, vault, notes, problems }));

		expect(problems.reports).toHaveLength(1);
		const [report] = problems.reports;
		expect(report.message).toContain("calendar source unreachable");
	});

	it("reports a standing problem under a fixed key when reading a remembered note rejects", async () => {
		const path = meetingNotePath(FOLDER, "2026-09-11", "Weekly sync");
		const memory: NotesMemory = { "uid-1": { "2026-09-11": entry(path) } };
		const { vault: baseVault, notes } = fakeVaultAndNotes(new Map());
		const vault: RunVault = {
			...baseVault,
			read: async () => {
				throw new Error("vault read refused");
			},
		};
		const problems = fakeProblems();

		await runMeetingNotes(depsWith({ calendar: fakeCalendar([meeting()]), vault, notes, memory, problems }));

		expect(problems.reports).toHaveLength(1);
		const [report] = problems.reports;
		expect(report.message).toContain("vault read refused");
	});

	it("reports a standing problem under a fixed key when committing the memory rejects, and clears it on a later run that completes", async () => {
		const files = new Map<string, string>();
		const { vault, notes } = fakeVaultAndNotes(files);
		const problems = fakeProblems();

		await runMeetingNotes(
			depsWith({
				calendar: fakeCalendar([meeting()]),
				vault,
				notes,
				problems,
				commitMemory: async () => {
					throw new Error("data.json refused");
				},
			}),
		);
		expect(problems.reports).toHaveLength(1);
		const [report] = problems.reports;
		const failureKey = report.key;
		expect(report.message).toContain("data.json refused");

		// The notes were created on disk in the first run even though the
		// memory naming them was not; a later run over an empty calendar
		// changes nothing and completes cleanly, which is what clears the key.
		await runMeetingNotes(depsWith({ calendar: fakeCalendar([]), vault, notes, problems }));
		expect(problems.cleared).toContain(failureKey);
	});
});

describe("a rename that lands but its bundled correction does not", () => {
	it("tells the memory the note moved even though the correction failed, and the next run retries the correction rather than adopting", async () => {
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
		const files = new Map([[oldPath, his]]);
		const { vault, notes: baseNotes } = fakeVaultAndNotes(files);
		// The rename lands; the follow-up correction throws — the shape a
		// parked edit takes when the plugin unloads while it waits
		// (`noteWriter.ts:264-274`).
		const notes: RunNotes = {
			trashIf: async () => { throw new Error("no note is deleted in this test"); },
			create: baseNotes.create,
			rename: baseNotes.rename,
			edit: async () => {
				throw new Error("this write did not happen: the plugin was unloaded while it waited");
			},
		};
		const memory: NotesMemory = { "uid-1": { "2026-09-11": entry(oldPath) } };
		const problems = fakeProblems();
		let committed: NotesMemory | undefined;

		await runMeetingNotes(
			depsWith({
				calendar: fakeCalendar([meeting()]),
				vault,
				notes,
				memory,
				problems,
				commitMemory: async (next) => {
					committed = next;
				},
			}),
		);

		const newPath = meetingNotePath(FOLDER, DATE, "Weekly sync");
		// The file genuinely moved; the memory must say so, not still name the
		// old path (`~/Devbox/CLAUDE.md`: the store is the one truth).
		expect(files.has(oldPath)).toBe(false);
		expect(files.has(newPath)).toBe(true);
		expect(committed?.["uid-1"]?.[DATE]?.path).toBe(newPath);
		expect(committed?.["uid-1"]?.["2026-09-11"]).toBeUndefined();
		// The failed correction is a standing problem under the new path, and
		// it must not be the ordinary clear a landed plan gets.
		expect(problems.reports.some((report) => report.key === newPath)).toBe(true);
		expect(problems.cleared).not.toContain(newPath);

		// A second run, over the memory the first run actually committed,
		// finds the note by its new path and retries the correction through
		// `updateInPlace` — an adopted note is never read or corrected at all,
		// so a second `edit` call is what tells the two apart.
		const { notes: secondNotes } = fakeVaultAndNotes(files);
		await runMeetingNotes(
			depsWith({ calendar: fakeCalendar([meeting()]), vault, notes: secondNotes, memory: committed! }),
		);
		expect(secondNotes.editedPaths).toEqual([newPath]);
	});
});

/**
 * A note renamed and moved by one run whose heading and day link never
 * landed: every name already on it and accounted for, so the only thing a
 * later run could possibly write is the correction the rename still owes.
 */
const PENDING_OLD_DATE = "2026-09-11";
const PENDING_OLD_PATH = meetingNotePath(FOLDER, PENDING_OLD_DATE, "Weekly sync");
const PENDING_NEW_PATH = meetingNotePath(FOLDER, DATE, "Weekly planning");
const PENDING_TEXT = [
	"---",
	"tags:",
	"  - meeting",
	"effort:",
	"participants:",
	'  - "[[Alva Almgren]]"',
	`day: "[[${PENDING_OLD_DATE}]]"`,
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

/** The writer over `files`, with every `edit` throwing the way a parked write does when the plugin unloads (`noteWriter.ts:264-274`). */
function notesWhoseEditThrows(files: Map<string, string>): RunNotes & { editedPaths: string[] } {
	const { notes } = fakeVaultAndNotes(files);
	const editedPaths: string[] = [];
	return {
		trashIf: async () => { throw new Error("no note is deleted in this test"); },
		editedPaths,
		create: notes.create,
		rename: notes.rename,
		edit: async (target) => {
			editedPaths.push((target as unknown as { path: string }).path);
			throw new Error("this write did not happen: the plugin was unloaded while it waited");
		},
	};
}

/**
 * The first run of every #793 test: the meeting has moved from
 * {@link PENDING_OLD_DATE} to today and been renamed "Weekly planning"; the
 * rename lands and its bundled correction throws. Returns the memory that
 * run committed and the problems it left standing.
 */
async function renameWhoseCorrectionThrows(files: Map<string, string>): Promise<{
	memory: NotesMemory;
	problems: ReturnType<typeof fakeProblems>;
}> {
	const { vault } = fakeVaultAndNotes(files);
	const problems = fakeProblems();
	let committed: NotesMemory | undefined;
	await runMeetingNotes(
		depsWith({
			calendar: fakeCalendar([meeting({ summary: "Weekly planning" })]),
			vault,
			notes: notesWhoseEditThrows(files),
			memory: { "uid-1": { [PENDING_OLD_DATE]: entry(PENDING_OLD_PATH, ["Alva Almgren"]) } },
			problems,
			commitMemory: async (next) => {
				committed = next;
			},
		}),
	);
	expect(files.get(PENDING_NEW_PATH)).toBe(PENDING_TEXT);
	expect(problems.reports.map((report) => report.key)).toEqual([PENDING_NEW_PATH]);
	return { memory: committed!, problems };
}

describe("a rename's correction that failed is retried on a later run", () => {
	it("the next run, with nothing else changed, applies the heading and day-link correction and only then clears the problem", async () => {
		const files = new Map([[PENDING_OLD_PATH, PENDING_TEXT]]);
		const first = await renameWhoseCorrectionThrows(files);
		expect(first.problems.cleared).not.toContain(PENDING_NEW_PATH);

		const { vault, notes } = fakeVaultAndNotes(files);
		const problems = fakeProblems();
		// The problem the first run raised is still standing when the second
		// starts, the way the real FeatureProblems keeps it between runs.
		problems.report(PENDING_NEW_PATH, first.problems.reports[0].message);
		problems.reports.length = 0;
		await runMeetingNotes(
			depsWith({
				calendar: fakeCalendar([meeting({ summary: "Weekly planning" })]),
				vault,
				notes,
				memory: first.memory,
				problems,
			}),
		);

		expect(notes.editedPaths).toEqual([PENDING_NEW_PATH]);
		const text = files.get(PENDING_NEW_PATH)!;
		expect(text).toContain("\n# Weekly planning\n");
		expect(text).not.toContain("# Weekly sync");
		expect(text).toContain(`day: "[[${DATE}]]"`);
		expect(text).not.toContain(`day: "[[${PENDING_OLD_DATE}]]"`);
		expect(problems.reports).toEqual([]);
		expect(problems.cleared).toContain(PENDING_NEW_PATH);
	});

	it("keeps the problem standing, in the same words, on a run that finds the correction still owed and cannot apply it — and clears it only on the run where it lands", async () => {
		const files = new Map([[PENDING_OLD_PATH, PENDING_TEXT]]);
		const first = await renameWhoseCorrectionThrows(files);
		const firstMessage = first.problems.reports[0].message;
		expect(firstMessage).toContain("It will try again on a later run.");

		// Second run: the retry throws too.
		const { vault } = fakeVaultAndNotes(files);
		const second = fakeProblems();
		let commits = 0;
		const failing = notesWhoseEditThrows(files);
		await runMeetingNotes(
			depsWith({
				calendar: fakeCalendar([meeting({ summary: "Weekly planning" })]),
				vault,
				notes: failing,
				memory: first.memory,
				problems: second,
				commitMemory: async () => {
					commits++;
				},
			}),
		);
		expect(failing.editedPaths).toEqual([PENDING_NEW_PATH]);
		expect(second.reports).toEqual([{ key: PENDING_NEW_PATH, message: firstMessage }]);
		expect(second.cleared).not.toContain(PENDING_NEW_PATH);
		// The memory is left as it was, so the correction is still owed.
		expect(commits).toBe(0);
		expect(files.get(PENDING_NEW_PATH)).toBe(PENDING_TEXT);

		// Third run: the note changed after the run read it — still owed, still
		// reported in the rename's own words for that case.
		const typed = `${PENDING_TEXT}typed a moment ago\n`;
		const { notes: base } = fakeVaultAndNotes(files);
		const third = fakeProblems();
		await runMeetingNotes(
			depsWith({
				calendar: fakeCalendar([meeting({ summary: "Weekly planning" })]),
				vault,
				notes: { ...base, edit: async (_file, edit) => edit(typed) },
				memory: first.memory,
				problems: third,
				commitMemory: async () => {
					commits++;
				},
			}),
		);
		expect(third.reports).toEqual([
			{
				key: PENDING_NEW_PATH,
				message:
					'Effortless renamed "Weekly planning"\'s note, but it changed after this run read it, so its correction was not applied. It will try again on a later run.',
			},
		]);
		expect(third.cleared).not.toContain(PENDING_NEW_PATH);
		expect(commits).toBe(0);

		// Fourth run: it lands, and only now is the problem cleared.
		const { notes } = fakeVaultAndNotes(files);
		const fourth = fakeProblems();
		await runMeetingNotes(
			depsWith({
				calendar: fakeCalendar([meeting({ summary: "Weekly planning" })]),
				vault,
				notes,
				memory: first.memory,
				problems: fourth,
			}),
		);
		expect(files.get(PENDING_NEW_PATH)).toContain("\n# Weekly planning\n");
		expect(fourth.reports).toEqual([]);
		expect(fourth.cleared).toContain(PENDING_NEW_PATH);
	});

	it("once the correction lands, the memory no longer owes it, and a later run with nothing changed writes nothing and reports nothing", async () => {
		const files = new Map([[PENDING_OLD_PATH, PENDING_TEXT]]);
		const first = await renameWhoseCorrectionThrows(files);
		expect(first.memory["uid-1"]?.[DATE]?.pendingCorrection).toEqual({ heading: "Weekly sync", dayLink: PENDING_OLD_DATE });

		const { vault, notes } = fakeVaultAndNotes(files);
		let landed: NotesMemory | undefined;
		await runMeetingNotes(
			depsWith({
				calendar: fakeCalendar([meeting({ summary: "Weekly planning" })]),
				vault,
				notes,
				memory: first.memory,
				commitMemory: async (next) => {
					landed = next;
				},
			}),
		);
		expect(notes.editedPaths).toEqual([PENDING_NEW_PATH]);
		expect(landed).toEqual({ "uid-1": { [DATE]: { path: PENDING_NEW_PATH, accounted: ["Alva Almgren"] } } });

		const afterLanding = files.get(PENDING_NEW_PATH);
		const { notes: laterNotes } = fakeVaultAndNotes(files);
		const later = fakeProblems();
		let commits = 0;
		await runMeetingNotes(
			depsWith({
				calendar: fakeCalendar([meeting({ summary: "Weekly planning" })]),
				vault,
				notes: laterNotes,
				memory: landed!,
				problems: later,
				commitMemory: async () => {
					commits++;
				},
			}),
		);
		expect(laterNotes.editedPaths).toEqual([]);
		expect(laterNotes.renamedPaths).toEqual([]);
		expect(files.get(PENDING_NEW_PATH)).toBe(afterLanding);
		expect(later.reports).toEqual([]);
		expect(commits).toBe(0);
	});

	it("adds a participant the calendar newly invited alongside the correction, in the same run that finally applies it", async () => {
		const files = new Map([[PENDING_OLD_PATH, PENDING_TEXT]]);
		const first = await renameWhoseCorrectionThrows(files);

		const { vault, notes } = fakeVaultAndNotes(files);
		let landed: NotesMemory | undefined;
		await runMeetingNotes(
			depsWith({
				calendar: fakeCalendar([
					meeting({
						summary: "Weekly planning",
						attendees: [
							{ name: "Alva Almgren", email: "alva.almgren@invented.test" },
							{ name: "Bo Bergsten", email: "bo.bergsten@invented.test" },
						],
					}),
				]),
				vault,
				notes,
				memory: first.memory,
				commitMemory: async (next) => {
					landed = next;
				},
			}),
		);

		expect(notes.editedPaths).toEqual([PENDING_NEW_PATH]);
		const text = files.get(PENDING_NEW_PATH)!;
		expect(text).toContain("\n# Weekly planning\n");
		expect(text).toContain(`day: "[[${DATE}]]"`);
		expect(text).toContain('participants:\n  - "[[Alva Almgren]]"\n  - "[[Bo Bergsten]]"\n');
		expect(landed).toEqual({
			"uid-1": { [DATE]: { path: PENDING_NEW_PATH, accounted: ["Alva Almgren", "Bo Bergsten"] } },
		});
	});
});

describe("a write that throws", () => {
	it("reports a standing problem keyed by the note's path, naming the reason, rather than stopping the run", async () => {
		const vault: RunVault = { exists: () => false, read: async () => null, fileAt: () => null };
		const notes: RunNotes = {
			trashIf: async () => { throw new Error("no note is deleted in this test"); },
			create: async () => {
				throw new Error("disk is full");
			},
			rename: async () => undefined,
			edit: async (_file, edit) => edit(""),
		};
		const problems = fakeProblems();

		await runMeetingNotes(depsWith({ calendar: fakeCalendar([meeting()]), vault, notes, problems }));

		const path = meetingNotePath(FOLDER, DATE, "Weekly sync");
		expect(problems.reports).toEqual([{ key: path, message: expect.stringContaining("disk is full") }]);
	});

	it("costs the meetings after it nothing", async () => {
		const files = new Map<string, string>();
		const { vault, notes } = fakeVaultAndNotes(files);
		const brokenNotes: RunNotes = {
			trashIf: async () => { throw new Error("no note is deleted in this test"); },
			create: async (path) => {
				if (path.includes("First")) throw new Error("refused");
				return notes.create(path, "text");
			},
			rename: notes.rename,
			edit: notes.edit,
		};

		await runMeetingNotes(
			depsWith({
				calendar: fakeCalendar([
					meeting({ uid: "uid-1", summary: "First", start: new Date(2026, 8, 18, 9, 0) }),
					meeting({ uid: "uid-2", summary: "Second", start: new Date(2026, 8, 18, 10, 0) }),
				]),
				vault,
				notes: brokenNotes,
			}),
		);

		expect(notes.createdPaths).toEqual([meetingNotePath(FOLDER, DATE, "Second")]);
	});
});

describe("a collision", () => {
	it("raises one standing problem keyed by the shared path, and a later run without the collision clears it", async () => {
		const problems = new Problems();
		const runProblems = trackedProblems(problems.forFeature("meeting-notes", "Meeting notes"));
		const files = new Map<string, string>();
		const { vault, notes } = fakeVaultAndNotes(files);

		const first = meeting({ uid: "uid-a", summary: "Standup", start: new Date(2026, 8, 18, 9, 0) });
		const second = meeting({ uid: "uid-b", summary: "Standup", start: new Date(2026, 8, 18, 9, 30) });

		await runMeetingNotes(
			depsWith({ calendar: fakeCalendar([first, second]), vault, notes, problems: runProblems }),
		);

		const path = meetingNotePath(FOLDER, DATE, "Standup");
		expect(problems.all().some((problem) => problem.key === path)).toBe(true);

		// Only the meeting that won the path still occurs; the run over it
		// alone adopts the note already at that path — this call passes no
		// `memory`, so `depsWith`'s default `{}` names nothing for it — and
		// clears the path either way, since an adopted result refuses nothing.
		await runMeetingNotes(
			depsWith({
				calendar: fakeCalendar([first]),
				vault,
				notes: fakeVaultAndNotes(files).notes,
				problems: runProblems,
			}),
		);

		expect(problems.all().some((problem) => problem.key === path)).toBe(false);
	});

	it("raises the Notice only once across repeated runs of the same colliding pair, carrying the sentence", async () => {
		const problems = new Problems();
		const runProblems = trackedProblems(problems.forFeature("meeting-notes", "Meeting notes"));
		const files = new Map<string, string>();
		const { vault, notes } = fakeVaultAndNotes(files);

		const first = meeting({ uid: "uid-a", summary: "Standup", start: new Date(2026, 8, 18, 9, 0) });
		const second = meeting({ uid: "uid-b", summary: "Standup", start: new Date(2026, 8, 18, 9, 30) });

		await runMeetingNotes(depsWith({ calendar: fakeCalendar([first, second]), vault, notes, problems: runProblems }));

		const path = meetingNotePath(FOLDER, DATE, "Standup");
		const noticesAfterFirst = Notice.messages.length;
		expect(noticesAfterFirst).toBeGreaterThan(0);
		const standing = problems.all().find((problem) => problem.key === path);
		expect(standing).toBeDefined();
		// AC4's own "with the carried sentence" — asserting the key alone
		// cannot tell this from a report whose message is anything at all.
		expect(standing!.message).toContain("another meeting this day is also called");

		// The winner's own visit must not clear a key the loser is about to
		// report again in the same run — that clear-then-report is what raises
		// a fresh Notice every fifteen minutes for as long as the collision
		// stands, `Problems.report` only staying quiet when a key is already
		// standing at the moment it is asked.
		await runMeetingNotes(
			depsWith({
				calendar: fakeCalendar([first, second]),
				vault,
				notes: fakeVaultAndNotes(files).notes,
				problems: runProblems,
			}),
		);

		expect(Notice.messages.length).toBe(noticesAfterFirst);
	});
});

describe("a problem for a path this run no longer visits", () => {
	it("is cleared when a later run's calendar no longer includes that meeting", async () => {
		const vault: RunVault = { exists: () => false, read: async () => null, fileAt: () => null };
		const notes: RunNotes = {
			trashIf: async () => { throw new Error("no note is deleted in this test"); },
			create: async () => {
				throw new Error("disk is full");
			},
			rename: async () => undefined,
			edit: async (_file, edit) => edit(""),
		};
		const problems = fakeProblems();
		const path = meetingNotePath(FOLDER, DATE, "Weekly sync");

		await runMeetingNotes(depsWith({ calendar: fakeCalendar([meeting()]), vault, notes, problems }));
		expect(problems.reports.some((report) => report.key === path)).toBe(true);
		expect(problems.list()).toContain(path);

		// The meeting is gone from today's calendar on the next run — the
		// ordinary "found in order, so clear" path (`run.ts:225-229`) never
		// runs for a path nothing visits any more, so nothing but a fresh
		// sweep at the top of the run can retire it.
		await runMeetingNotes(depsWith({ calendar: fakeCalendar([]), vault, notes, problems }));

		expect(problems.cleared).toContain(path);
		expect(problems.list()).not.toContain(path);
	});
});

describe("a note for a meeting that no longer has invited people", () => {
	it("leaves the note exactly as it was: nothing deleted, renamed or edited", async () => {
		// A meeting the calendar answered "notes" for on an earlier run, whose
		// own note this feature already made and remembered. `fakeCalendar([])`
		// stands in for the core's own answer once #909's rule takes an
		// attendee-less meeting out of `meetingsOn(day, "notes")` — this run
		// never sees the meeting at all, the same as if it had been deleted
		// from the calendar outright.
		const path = meetingNotePath(FOLDER, DATE, "Weekly sync");
		const original = [
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
		].join("\n");
		const files = new Map([[path, original]]);
		const { vault, notes } = fakeVaultAndNotes(files);
		const memory: NotesMemory = { "uid-1": { [DATE]: entry(path, ["Alva Almgren"]) } };

		let committed: NotesMemory | undefined;
		await runMeetingNotes(
			depsWith({
				calendar: fakeCalendar([]),
				vault,
				notes,
				memory,
				commitMemory: async (next) => {
					committed = next;
				},
			}),
		);

		expect(notes.createdPaths).toEqual([]);
		expect(notes.renamedPaths).toEqual([]);
		expect(notes.editedPaths).toEqual([]);
		// Read back from the fake vault's own store, not asserted by name: a
		// test that only checked `editedPaths` would still pass if the run
		// wrote the file through some other route.
		expect(files.get(path)).toBe(original);
		// Nothing committed at all — `commitMemory` is called only when the
		// loop this run drives changes something, and a meeting outside
		// `meetings` never reaches that loop (`run.ts:227-268`).
		expect(committed).toBeUndefined();
	});
});

describe("the self-email standing problem", () => {
	it("raises nothing on a run that creates no note", async () => {
		const files = new Map<string, string>();
		const { vault, notes } = fakeVaultAndNotes(files);
		const memory: NotesMemory = {
			"uid-1": { [DATE]: entry(meetingNotePath(FOLDER, DATE, "Weekly sync"), ["Alva Almgren"]) },
		};
		files.set(meetingNotePath(FOLDER, DATE, "Weekly sync"), "content");
		const problems = fakeProblems();

		await runMeetingNotes(
			depsWith({ calendar: fakeCalendar([meeting()]), vault, notes, memory, selfEmail: "", problems }),
		);

		expect(problems.reports.some((report) => report.key === "self-email-unset")).toBe(false);
	});

	it("raises one problem on the first run that creates a note, and not a second Notice on a later run that also creates one", async () => {
		const problems = new Problems();
		const runProblems = trackedProblems(problems.forFeature("meeting-notes", "Meeting notes"));
		const files = new Map<string, string>();
		const { vault, notes } = fakeVaultAndNotes(files);

		await runMeetingNotes(
			depsWith({
				calendar: fakeCalendar([meeting({ uid: "uid-a", summary: "First", start: new Date(2026, 8, 18, 9, 0) })]),
				vault,
				notes,
				selfEmail: "",
				problems: runProblems,
			}),
		);
		const noticesAfterFirst = Notice.messages.length;
		expect(problems.all().some((problem) => problem.key === "self-email-unset")).toBe(true);
		expect(noticesAfterFirst).toBeGreaterThan(0);

		await runMeetingNotes(
			depsWith({
				calendar: fakeCalendar([meeting({ uid: "uid-b", summary: "Second", start: new Date(2026, 8, 18, 11, 0) })]),
				vault,
				notes,
				selfEmail: "",
				problems: runProblems,
			}),
		);

		// The channel's own dedup — the mechanism every other standing problem
		// in this codebase relies on (`src/core/problems.ts`'s `report`) — is
		// what keeps a second qualifying run quiet, not bookkeeping of this
		// run's own.
		expect(Notice.messages.length).toBe(noticesAfterFirst);
	});

	it("clears once the address is answered, so the line does not outlive the reason it was raised", async () => {
		const files = new Map<string, string>();
		const { vault, notes } = fakeVaultAndNotes(files);
		const problems = fakeProblems();

		await runMeetingNotes(
			depsWith({ calendar: fakeCalendar([meeting()]), vault, notes, selfEmail: "", problems }),
		);
		expect(problems.reports.some((report) => report.key === "self-email-unset")).toBe(true);

		await runMeetingNotes(
			depsWith({ calendar: fakeCalendar([]), vault, notes, selfEmail: "self@invented.test", problems }),
		);
		expect(problems.cleared).toContain("self-email-unset");
	});
});
