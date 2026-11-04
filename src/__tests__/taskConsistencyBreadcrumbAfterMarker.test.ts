/**
 * A link the person types *after* a log copy's marker is not the copy's
 * collection (#985, found
 * against #976). The
 * breadcrumb is the last wikilink before this feature's own marker comment, on
 * a line written with the arrow or without it, and an image embed is never one.
 *
 * Three readers use the breadcrumb and each is run here: the daily sync run
 * over today's log (`checkLogFile`), the deleted-collection-line check
 * (`runOverCollection`, #848) and the jump command. Every fixture's trailing
 * link, `[[Bob]]`, resolves to a real note that is not a collection, so a
 * reader that takes it for the collection shows itself as the standing problem
 * `names "Bob", which is not a collection any more` and as a jump that says the
 * same.
 *
 * Every task, note and collection name here is invented.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorPosition, TFile } from "obsidian";
import { Notice, resetSettings } from "./__mocks__/obsidian";
import type { Collection, Collections } from "../core/collections";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { editTaskField, parseTaskLine } from "../core/taskLine";
import type { TaskLine } from "../core/taskLine";
import { dailyLogFrame, dailyLogPath } from "../core/vaultLayout";
import { copyIn } from "../features/taskConsistency/copyIn";
import { collectionLinktextOf, jumpFromLine } from "../features/taskConsistency/jump";
import type { JumpEditor, JumpTarget } from "../features/taskConsistency/jump";
import { readMarker } from "../features/taskConsistency/marker";
import { checkLogFile, runOverCollection } from "../features/taskConsistency/run";
import type { RunDeps, RunNotes, RunProblems, RunVault } from "../features/taskConsistency/run";

beforeEach(() => {
	Notice.messages = [];
	resetSettings();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(2026, 8, 22, 9, 0));
});

const TODAY = new Date(2026, 8, 22, 9, 0);
const layout: VaultLayout = { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };
const COLLECTION_PATH = "Errands.md";
const NOT_A_COLLECTION_PATH = "Bob.md";
const LOG_PATH = dailyLogPath(TODAY, layout);
const TASK = "Order the blue folders";

function file(path: string): TFile {
	return { path } as TFile;
}

function collectionOf(): Collection {
	return { path: COLLECTION_PATH, name: "Errands", headingLine: 0, headingLevel: 2, openTasks: 1 };
}

function parsed(raw: string): TaskLine {
	const task = parseTaskLine(raw);
	if (task === null) throw new Error(`expected a task line: ${JSON.stringify(raw)}`);
	return task;
}

function lineContaining(text: string, needle: string): string {
	const found = text.split("\n").find((line) => line.includes(needle));
	if (found === undefined) throw new Error(`no line of ${JSON.stringify(text)} contains ${JSON.stringify(needle)}`);
	return found;
}

/** A fresh pairing of one due task in "Errands": the collection as copy-in left it, and today's log. */
function pairing(): { collection: string; log: string; eid: string } {
	const source = `## ${layout.tasksHeading}\n- [ ] ${TASK} ⏳ 2026-09-22\n`;
	const out = copyIn(source, dailyLogFrame(layout), TODAY, layout, "Errands");
	const eid = readMarker(parsed(lineContaining(out.log, TASK)))?.eid;
	if (eid === undefined) throw new Error("copy-in wrote no marker");
	return { collection: out.collection, log: out.log, eid };
}

/**
 * The two shapes a log copy's breadcrumb can have: the one copy-in writes now
 * (` [[Errands]]`) and the one an earlier version wrote (` → [[Errands]]`).
 * Each is `line` with a link the person typed after the marker.
 */
const SHAPES: ReadonlyArray<{ name: string; arrow: boolean }> = [
	{ name: "a line written without the arrow", arrow: false },
	{ name: "a line an earlier version wrote with the arrow", arrow: true },
];

function withTrailingLink(log: string, arrow: boolean): string {
	const line = lineContaining(log, TASK);
	const shaped = arrow ? line.replace(" [[Errands]]", " → [[Errands]]") : line;
	// The fixture is only a fixture if the shapes really differ and the marker really comes last.
	expect(shaped.includes("→")).toBe(arrow);
	expect(shaped.endsWith("%%")).toBe(true);
	return log.replace(line, `${shaped} and see [[Bob]]`);
}

function fakeNotes(files: Map<string, string>): RunNotes & { editCounts: Map<string, number> } {
	const editCounts = new Map<string, number>();
	return {
		editCounts,
		read: async (target) => {
			const content = files.get(target.path);
			if (content === undefined) throw new Error(`fakeNotes: nothing at ${target.path}`);
			return content;
		},
		edit: async (target, edit) => {
			editCounts.set(target.path, (editCounts.get(target.path) ?? 0) + 1);
			const next = edit(files.get(target.path) ?? "");
			files.set(target.path, next);
			return next;
		},
	};
}

function fakeProblems(): RunProblems & { standing: Map<string, string> } {
	const standing = new Map<string, string>();
	return {
		standing,
		report: (key, message) => standing.set(key, message),
		clear: (key) => standing.delete(key),
		list: () => [...standing.keys()],
	};
}

/** Only "Errands" is a collection; "Bob" is a real note in the vault that is not one. */
function runDeps(notes: RunNotes, problems: RunProblems): RunDeps {
	const collections: Collections = {
		all: () => [collectionOf()],
		at: (path) => (path === COLLECTION_PATH ? collectionOf() : null),
	};
	const vault: RunVault = {
		fileAt: (path) => ([COLLECTION_PATH, NOT_A_COLLECTION_PATH, LOG_PATH].includes(path) ? file(path) : null),
	};
	return { collections, vault, notes, problems, layout, today: TODAY };
}

function resolveLink(linktext: string): string | null {
	if (linktext === "Errands") return COLLECTION_PATH;
	if (linktext === "Bob") return NOT_A_COLLECTION_PATH;
	return null;
}

describe("the sync run reads the breadcrumb before the marker, not a link typed after it", () => {
	for (const shape of SHAPES) {
		it(`${shape.name}: still syncs a change from its collection, and raises no "not a collection" problem`, async () => {
			const { collection, log } = pairing();
			const changedCollection = editTaskField(lineContaining(collection, TASK), "priority", "high");
			const files = new Map([
				[COLLECTION_PATH, collection.replace(lineContaining(collection, TASK), changedCollection)],
				[LOG_PATH, withTrailingLink(log, shape.arrow)],
			]);
			expect(parsed(lineContaining(files.get(LOG_PATH)!, TASK)).priority).not.toBe("high");
			const notes = fakeNotes(files);
			const problems = fakeProblems();

			await checkLogFile(runDeps(notes, problems), resolveLink, file(LOG_PATH));

			// If "Bob" were read as the collection the pair would not be visited, and the log would keep its old priority.
			expect(parsed(lineContaining(files.get(LOG_PATH)!, TASK)).priority).toBe("high");
			expect([...problems.standing.values()].filter((message) => message.includes("not a collection"))).toEqual([]);
			expect(problems.standing.has(NOT_A_COLLECTION_PATH)).toBe(false);
			// What the person typed after the marker is still there: nothing on a task line is eaten.
			expect(lineContaining(files.get(LOG_PATH)!, TASK)).toContain("and see [[Bob]]");
		});

		it(`${shape.name}: still gets the deleted-collection-line check`, async () => {
			const { collection, log, eid } = pairing();
			const collectionWithoutLine = collection
				.split("\n")
				.filter((line) => !line.includes(TASK))
				.join("\n");
			const files = new Map([
				[COLLECTION_PATH, collectionWithoutLine],
				[LOG_PATH, withTrailingLink(log, shape.arrow)],
			]);
			const notes = fakeNotes(files);
			const problems = fakeProblems();

			await runOverCollection(runDeps(notes, problems), collectionOf());

			// If "Bob" were read as the collection this log line would be skipped and nothing would be reported.
			expect(problems.standing.has(`no-collection-line:${eid}`)).toBe(true);
			expect(notes.editCounts.size).toBe(0);
		});
	}
});

/** A target that resolves both notes, calls only "Errands" a collection, and records what the jump opened. */
function jumpTarget(collectionText: string, opened: string[], cursors: EditorPosition[], notices: string[]): JumpTarget {
	const editor: JumpEditor = {
		getValue: () => collectionText,
		setCursor: (pos: EditorPosition) => cursors.push(pos),
	};
	return {
		resolveLink: (linktext) => resolveLink(linktext),
		isCollection: (path) => path === COLLECTION_PATH,
		findOpenView: () => null,
		openView: vi.fn(),
		open: async (path) => {
			opened.push(path);
			return editor;
		},
		notify: (message) => notices.push(message),
	};
}

describe("the jump opens the collection the breadcrumb names, not a link typed after the marker", () => {
	for (const shape of SHAPES) {
		it(`${shape.name}: opens the collection and puts the cursor on the task's own line`, async () => {
			const { collection, log } = pairing();
			const line = parsed(lineContaining(withTrailingLink(log, shape.arrow), TASK));
			const opened: string[] = [];
			const cursors: EditorPosition[] = [];
			const notices: string[] = [];

			await jumpFromLine(jumpTarget(collection, opened, cursors, notices), LOG_PATH, line);

			// If "Bob" were read as the collection, the notice would say it is not one and nothing would open.
			expect(notices).toEqual([]);
			expect(opened).toEqual([COLLECTION_PATH]);
			const row = collection.split("\n").findIndex((each) => each.includes(TASK));
			expect(cursors).toEqual([{ line: row, ch: 0 }]);
		});
	}
});

describe("collectionLinktextOf, with links on both sides of the marker", () => {
	const MARKER = "%% task-consistency:eid1 aabbccdd %%";

	it("does not read a wikilink after the marker", () => {
		expect(collectionLinktextOf(`ask [[Errands]] ${MARKER} see [[Bob]]`)).toBe("Errands");
	});

	it("does not read a wikilink after the marker on an arrow line", () => {
		expect(collectionLinktextOf(`ask → [[Errands]] ${MARKER} see [[Bob]]`)).toBe("Errands");
	});

	it("reads the collection, not the image, when an image embed follows the marker", () => {
		expect(collectionLinktextOf(`ask [[Errands]] ${MARKER} ![[receipt.png]]`)).toBe("Errands");
	});

	it("reads the collection, not the image, when an image embed sits between the words and the marker", () => {
		expect(collectionLinktextOf(`ask [[Errands]] ![[receipt.png]] ${MARKER}`)).toBe("Errands");
	});

	it("never takes an image embed for the breadcrumb: a line whose only link is an embed names no collection", () => {
		expect(collectionLinktextOf(`ask ![[receipt.png]] ${MARKER}`)).toBeNull();
	});

	it("still reads a link that sits between other comments, before this feature's marker", () => {
		expect(collectionLinktextOf(`ask [[Errands]] %% eid:old1 %% ${MARKER}`)).toBe("Errands");
	});

	it("answers null for a link that comes only after the marker, since the copy always writes the breadcrumb first", () => {
		expect(collectionLinktextOf(`ask ${MARKER} see [[Bob]]`)).toBeNull();
	});

	it("still reads a hand-built arrow line whose arrow and link sit after the marker, as the earlier reader did", () => {
		expect(collectionLinktextOf(`ask ${MARKER} → [[Errands]]`)).toBe("Errands");
	});

	it("prefers the link before the marker over an arrow's link after it", () => {
		expect(collectionLinktextOf(`ask [[Errands]] ${MARKER} → [[Bob]]`)).toBe("Errands");
	});
});
