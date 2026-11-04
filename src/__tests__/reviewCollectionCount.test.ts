/**
 * Review's open-task count follows Migration in the two places they differed: a waiting note
 * that is a collection counts 0 open tasks, because Migration refuses every line
 * of one, and in a day's log the fence scan starts at line 0, so a fence opened
 * in the frontmatter is still open below it. In an ordinary note the scan stays
 * below the frontmatter, as before.
 *
 * Every fixture is written with `\n` and with `\r\n` line endings, once ending in
 * a line break and once not, because the count reads the text line by line.
 * The notes are invented; none is from anyone's vault.
 */

import { describe, expect, it } from "vitest";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { isFilableOpen, parseTaskLine } from "../core/taskLine";
import { filableCheck, sourceNoteOf } from "../features/migration/filable";
import { waitingNotes } from "../features/review/waitingNotes";
import type { ReviewNote } from "../features/review/waitingNotes";

const TODAY = new Date(2026, 9, 15);

function layout(change: Partial<VaultLayout> = {}): VaultLayout {
	return {
		...defaultData().core.layout,
		dailyLogFolder: "Journal",
		dailyLogFilename: "YYYY-MM-DD",
		processedField: "processed",
		dayLinkField: "day",
		...change,
	};
}

const resolveLink = (linkText: string): string | null => (/^\d{4}-\d{2}-\d{2}$/.test(linkText) ? `Journal/${linkText}.md` : null);

const DAY_LOG_PATH = "Journal/2026-10-14.md";
const PROJECT_PATH = "Projects/Garden plan.md";

/** A waiting day's log, yesterday's. */
function dayLog(text: string): ReviewNote {
	return { path: DAY_LOG_PATH, frontmatter: { processed: null }, text };
}

/** A waiting ordinary note linking to yesterday's log. */
function project(text: string): ReviewNote {
	return { path: PROJECT_PATH, frontmatter: { processed: null, day: "[[2026-10-14]]" }, text };
}

/** Review's row for `note`, with `isCollection` as the collections index answers it now. */
function row(note: ReviewNote, isCollection: (path: string) => boolean = () => false) {
	const result = waitingNotes([note], layout(), 7, TODAY, resolveLink, isCollection);
	expect(result.list).toHaveLength(1);
	return result.list[0];
}

/** What Migration lets through of `text`: its own note answer, then its own line check. */
function migrationCount(path: string, text: string, isCollection: (path: string) => boolean = () => false): number {
	const answer = sourceNoteOf(path, isCollection, layout());
	if (!answer.ok) return 0;
	const check = filableCheck(text, answer.source, layout());
	return text.split("\n").filter((line, index) => {
		const task = parseTaskLine(line);
		return task !== null && isFilableOpen(task) && check(index, line).ok;
	}).length;
}

/** The text of `lines` with each line ending, ending in a line break or not. */
function written(lines: readonly string[]): { readonly name: string; readonly text: string }[] {
	return [
		{ name: "LF, ending in a line break", text: lines.join("\n") + "\n" },
		{ name: "LF, no final line break", text: lines.join("\n") },
		{ name: "CRLF, ending in a line break", text: lines.join("\r\n") + "\r\n" },
		{ name: "CRLF, no final line break", text: lines.join("\r\n") },
	];
}

const PROJECT_LINES = ["# Tasks", "- [ ] dig the bed", "- [ ] order seed", "- [x] buy gloves", "- plain bullet"];
const isProject = (path: string): boolean => path === PROJECT_PATH;

describe("a waiting note that is a collection counts 0 open tasks", () => {
	for (const { name, text } of written(PROJECT_LINES)) {
		it(`counts 0 when the index calls it a collection, and the same text as an ordinary note counts both tasks (${name})`, () => {
			expect(row(project(text), isProject).openTasks).toBe(0);
			expect(row(project(text), () => false).openTasks).toBe(2);
		});
	}

	it("still lists the collection, with its plain bullets, instead of refusing it", () => {
		const text = PROJECT_LINES.join("\n") + "\n";
		const result = waitingNotes([project(text)], layout(), 7, TODAY, resolveLink, isProject);
		expect(result.list.map((waiting) => waiting.path)).toEqual([PROJECT_PATH]);
		expect(result.list[0].plainBullets).toBe(row(project(text)).plainBullets);
		expect(result.list[0].plainBullets).toBeGreaterThan(0);
	});

	it("decides from the index at the call and not from the note's tags", () => {
		const tagged: ReviewNote = { ...project("- [ ] a\n- [ ] b\n"), frontmatter: { processed: null, day: "[[2026-10-14]]", tags: ["collection"] } };
		expect(row(tagged, () => false).openTasks).toBe(2);
		const untagged = project("- [ ] a\n- [ ] b\n");
		expect(row(untagged, (path) => path === PROJECT_PATH).openTasks).toBe(0);
	});

	it("reads the index every time it is called and keeps no answer from before", () => {
		const note = project("- [ ] a\n- [ ] b\n");
		let collection = false;
		const asked: string[] = [];
		const index = (path: string): boolean => {
			asked.push(path);
			return collection;
		};
		expect(row(note, index).openTasks).toBe(2);
		collection = true;
		expect(row(note, index).openTasks).toBe(0);
		expect(asked).toEqual([PROJECT_PATH, PROJECT_PATH]);
	});

	it("leaves a day's log alone when the index (which never calls one a collection) answers no", () => {
		expect(row(dayLog("# Notes\n- [ ] kept\n"), () => false).openTasks).toBe(1);
	});
});

describe("in a day's log the fence scan starts at line 0, as Migration's does", () => {
	// A fence opened in the frontmatter and closed by the first fence line of the
	// body, ahead of the notes heading. From line 0 that line closes it, so the
	// heading is visible and both tasks count. From below the frontmatter the same
	// line opens a fence that runs to the end of the note, so neither counts.
	// (A header fence that nothing below closes is not a case: it hides the notes
	// heading itself from the section reader, both counts are 0 whichever line the
	// scan starts at, and a test of it could not fail.)
	const CLOSED_IN_BODY = ["---", "processed:", "note: |", "```", "---", "```", "# Notes", "- [ ] first", "- [ ] second"];

	for (const { name, text } of written(CLOSED_IN_BODY)) {
		it(`counts what Migration lets through, a header fence closed in the body (${name})`, () => {
			const migration = migrationCount(DAY_LOG_PATH, text);
			expect(migration).toBe(2);
			expect(row(dayLog(text)).openTasks).toBe(migration);
		});
	}

	for (const { name, text } of written(CLOSED_IN_BODY)) {
		it(`keeps an ordinary note's scan below the frontmatter, so the header's fence opens nothing and the body's opens one (${name})`, () => {
			const migration = migrationCount(PROJECT_PATH, text);
			expect(migration).toBe(0);
			expect(row(project(text)).openTasks).toBe(migration);
		});
	}
});

describe("Review's count and Migration's check agree on the same text", () => {
	// The two modules meet here, as #1064's composition test does, for the two
	// differences #1118 closed. The day's log has an open task under a `# Diary`
	// heading, which the layout names as the diary and not as the notes, so
	// neither counts it.
	const DAY_LINES = ["---", "processed:", "note: |", "```", "---", "```", "# Notes", "- [ ] first", "- [ ] second", "# Diary", "- [ ] under a heading outside the layout"];
	const NOTE_LINES = ["- [ ] before any heading", "# Tasks", "- [ ] one", "- [ ] two %%task-consistency:abc 0badc0de%%"];

	const cases = [
		{ label: "a day's log", note: dayLog, path: DAY_LOG_PATH, lines: DAY_LINES, isCollection: () => false, expected: 2 },
		{ label: "an ordinary note", note: project, path: PROJECT_PATH, lines: NOTE_LINES, isCollection: () => false, expected: 2 },
		{ label: "a collection", note: project, path: PROJECT_PATH, lines: NOTE_LINES, isCollection: isProject, expected: 0 },
	] as const;

	for (const { label, note, path, lines, isCollection, expected } of cases) {
		for (const { name, text } of written(lines)) {
			it(`${label}, ${name}`, () => {
				const migration = migrationCount(path, text, isCollection);
				// Migration's own answer, so a wrong fixture shows here and not in Review's number.
				expect(migration).toBe(expected);
				expect(row(note(text), isCollection).openTasks).toBe(migration);
			});
		}
	}
});
