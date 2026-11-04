/**
 * The open-task number on a Review row follows Migration's place and comment
 * rules (#1064, the author's
 * answer of 2026-10-11): in a day's log only the open tasks under the notes
 * heading count, in an ordinary note every section counts, and a task carrying
 * a hidden `%% … %%` comment counts nowhere, because something else already
 * handles it.
 *
 * Every fixture is a day's log whose notes heading is level 1 and whose Today,
 * Overdue and Calendar headings are level 2, so Today is *inside* the notes
 * heading's range: a count that only asked "is the line below the notes
 * heading" would count the Today tasks, and only the innermost section tells
 * them apart.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { isFilableOpen, parseTaskLine } from "../core/taskLine";
import { DAY_LOG, filableCheck, ORDINARY_NOTE } from "../features/migration/filable";
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

/** A waiting day's log, yesterday's, with the given text. */
function dayLog(text: string): ReviewNote {
	return { path: "Journal/2026-10-14.md", frontmatter: { processed: null }, text };
}

/** A waiting ordinary note linking to yesterday's log, with the given text. */
function ordinary(text: string): ReviewNote {
	return { path: "Meetings/Budget review.md", frontmatter: { processed: null, day: "[[2026-10-14]]" }, text };
}

const resolveLink = (linkText: string): string | null => (/^\d{4}-\d{2}-\d{2}$/.test(linkText) ? `Journal/${linkText}.md` : null);

function openTasks(note: ReviewNote, change: Partial<VaultLayout> = {}): number {
	const result = waitingNotes([note], layout(change), 7, TODAY, resolveLink, () => false);
	expect(result.list).toHaveLength(1);
	return result.list[0].openTasks;
}

/** The ticket's day's log: one open task under Notes, a commented one under Notes, two under Today. */
const LOG_LINES = ["# Notes", "- [ ] a note task", "- [ ] already paired %%x%%", "## Today", "- [ ] rolled over one", "- [ ] rolled over two"];

describe("a day's log counts the open tasks under the notes heading only", () => {
	it("counts the one plain task under Notes, not the two under Today nor the commented one", () => {
		expect(openTasks(dayLog(LOG_LINES.join("\n") + "\n"))).toBe(1);
	});

	it("counts the same on Windows line endings, ending in a line break or not", () => {
		for (const ending of ["", "\r\n"]) {
			expect(openTasks(dayLog(LOG_LINES.join("\r\n") + ending)), JSON.stringify(ending)).toBe(1);
		}
	});

	it("counts nothing under Overdue, Calendar, above the notes heading or in a log with no notes heading", () => {
		const text = ["- [ ] above everything", "## Overdue", "- [ ] late", "## Calendar", "- [ ] odd", "# Notes", "- [ ] counted"].join("\n");
		expect(openTasks(dayLog(text))).toBe(1);
		expect(openTasks(dayLog("## Today\n- [ ] one\n- [ ] two\n"))).toBe(0);
	});

	it("stops counting where a heading of the notes heading's level ends it", () => {
		const text = ["# Notes", "- [ ] first", "## Today", "- [ ] today one", "# Elsewhere", "- [ ] outside Notes"].join("\n");
		expect(openTasks(dayLog(text))).toBe(1);
	});

	it("reads the notes heading from the layout, in its words and at its level", () => {
		const text = ["## Anteckningar", "- [ ] counted", "# Notes", "- [ ] not counted now"].join("\n");
		expect(openTasks(dayLog(text), { notesHeading: { text: "Anteckningar", level: 2 } })).toBe(1);
	});

	it("still leaves out a fenced task and a frontmatter task under the notes heading", () => {
		const text = ["---", "processed:", "- [ ] in frontmatter", "---", "# Notes", "- [ ] open", "```", "- [ ] fenced", "```"].join("\n");
		expect(openTasks(dayLog(text))).toBe(1);
	});
});

describe("an ordinary note counts every section", () => {
	it("counts the tasks under Notes, under Today and under no heading, but not the commented one", () => {
		expect(openTasks(ordinary(LOG_LINES.join("\n")))).toBe(3);
		expect(openTasks(ordinary("- [ ] before any heading\n- [ ] second\n"))).toBe(2);
	});

	it("counts the same on Windows line endings, ending in a line break or not", () => {
		for (const ending of ["", "\r\n"]) {
			expect(openTasks(ordinary(LOG_LINES.join("\r\n") + ending)), JSON.stringify(ending)).toBe(3);
		}
	});
});

describe("a task carrying a hidden comment is not counted", () => {
	it("leaves out Task consistency's pairing marker and any other %% … %% comment", () => {
		const text = ["- [ ] paired %%task-consistency:abc 0badc0de%%", "- [ ] filed %% migration:abc 0badc0de %%", "- [ ] plain"].join("\n");
		expect(openTasks(ordinary(text))).toBe(1);
	});

	it("counts a task whose %% is not a closed comment", () => {
		expect(openTasks(ordinary("- [ ] ten %% off, no end\n"))).toBe(1);
	});
});

describe("Review's count and Migration's answer agree", () => {
	// The two modules meet here: for every open task with the space checkbox the
	// count adds one exactly when Migration's own check, asked of the same text,
	// lets the line through.
	const TEXT = [
		"- [ ] before any heading",
		"# Notes",
		"- [ ] plain note",
		"- [ ] paired %%task-consistency:abc 0badc0de%%",
		"- [I] an idea",
		"## Today",
		"- [ ] rolled over",
		"## Overdue",
		"- [ ] late",
		"# Notes again",
		"- [ ] outside",
	];

	for (const [name, note, source, filed] of [
		["a day's log", dayLog, DAY_LOG, 1],
		["an ordinary note", ordinary, ORDINARY_NOTE, 5],
	] as const) {
		for (const ending of ["\n", "\r\n"]) {
			it(`${name}, lines ended with ${JSON.stringify(ending)}`, () => {
				const text = TEXT.join(ending) + ending;
				const check = filableCheck(text, source, layout());
				const expected = text.split("\n").filter((line, index) => {
					const task = parseTaskLine(line);
					return task !== null && isFilableOpen(task) && check(index, line).ok;
				}).length;
				// Migration's own answer, so a wrong fixture shows here and not in Review's number.
				expect(expected).toBe(filed);
				expect(openTasks(note(text))).toBe(expected);
			});
		}
	}
});

describe("the reader keeps to the core", () => {
	it("imports nothing from src/features/migration", () => {
		// Imports only: `review.ts` names a Migration file in a comment, which is no import.
		const dir = join(__dirname, "..", "features", "review");
		for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
			expect(readFileSync(join(dir, file), "utf8"), file).not.toMatch(/(?:from|import\()\s*["'][^"']*features\/migration/);
		}
	});
});
