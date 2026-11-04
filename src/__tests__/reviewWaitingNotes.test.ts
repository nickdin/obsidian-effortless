import { describe, expect, it } from "vitest";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { parseTaskLine, isFilableOpen } from "../core/taskLine";
import { waitingNotes } from "../features/review/waitingNotes";
import type { ResolveLink, ReviewNote } from "../features/review/waitingNotes";
import { checkLine } from "../features/migration/filable";

/** Thursday 15 October 2026, the day every case below is read on. */
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

/** The path of the day's log for `daysAgo` days before today, under the default filename. */
function logPath(daysAgo: number, folder = "Journal"): string {
	const date = new Date(2026, 9, 15 - daysAgo);
	const two = (n: number) => String(n).padStart(2, "0");
	return `${folder}/${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}.md`;
}

/** A day's log with an empty processed field. */
function log(daysAgo: number, text = "", frontmatter: Record<string, unknown> = { processed: null }): ReviewNote {
	return { path: logPath(daysAgo), frontmatter, text };
}

/** A link to the day's log `daysAgo` days back, written as the day-link field holds it. */
function dayLink(daysAgo: number): string {
	return `[[${logPath(daysAgo).slice("Journal/".length, -".md".length)}]]`;
}

/** A meeting note linking to the day's log `daysAgo` days back. */
function meeting(name: string, link: unknown, frontmatter: Record<string, unknown> = {}): ReviewNote {
	return { path: `Meetings/${name}.md`, frontmatter: { processed: null, day: link, ...frontmatter }, text: "" };
}

/**
 * An ordinary note with the given text, linking to yesterday's log. The open-task
 * cases below read a note where every section counts: in a day's log only the
 * tasks under the notes heading do, and these cases are about the
 * symbol, the fences and the frontmatter, not the section.
 */
function ordinaryNote(text: string): ReviewNote {
	return { ...meeting("Budget review", dayLink(1)), text };
}

/**
 * A resolver that knows the notes of a small vault by the text a link is written
 * with, as Obsidian's `getFirstLinkpathDest` would: a day's log by its date, one
 * ordinary note by its name, and nothing else.
 */
const resolveLink: ResolveLink = (linkText) => {
	if (/^\d{4}-\d{2}-\d{2}$/.test(linkText)) return `Journal/${linkText}.md`;
	if (linkText === "Project page") return "Projects/Project page.md";
	return null;
};

function wait(notes: ReviewNote[], change: Partial<VaultLayout> = {}, windowDays = 7, resolve: ResolveLink = resolveLink) {
	return waitingNotes(notes, layout(change), windowDays, TODAY, resolve, () => false);
}

function paths(notes: ReviewNote[], change: Partial<VaultLayout> = {}, windowDays = 7): string[] {
	return wait(notes, change, windowDays).list.map((row) => row.path);
}

describe("the processed field", () => {
	it("waits when empty, in each of the three shapes an empty field takes", () => {
		for (const empty of [null, undefined, ""]) {
			expect(paths([log(1, "", { processed: empty })]), String(empty)).toEqual([logPath(1)]);
		}
	});

	it("does not wait when it holds true, a date or a word, and not when the note has no such field", () => {
		for (const value of [true, "2026-10-14", new Date(2026, 9, 14), "done"]) {
			expect(paths([log(1, "", { processed: value })]), String(value)).toEqual([]);
		}
		expect(paths([log(1, "", {})])).toEqual([]);
		expect(paths([{ path: logPath(1), frontmatter: null, text: "" }])).toEqual([]);
	});

	it("is read under the layout's name for it, not the shipped one", () => {
		const note = log(1, "", { bearbetad: null, processed: "done" });
		expect(paths([note], { processedField: "bearbetad" })).toEqual([logPath(1)]);
		expect(paths([note])).toEqual([]);
	});
});

describe("a note's day", () => {
	it("is found for a day's log under a non-default filename pattern, by the date its name carries", () => {
		const note: ReviewNote = { path: "Days/2026/10/14 Oct 2026.md", frontmatter: { processed: null }, text: "" };
		const odd = { dailyLogFolder: "Days", dailyLogFilename: "YYYY/MM/DD MMM YYYY" };
		const rows = wait([note], odd).list;
		expect(rows.map((row) => row.path)).toEqual([note.path]);
		expect(rows[0].day).toEqual(new Date(2026, 9, 14));
		// The same note under the default pattern is not a day's log.
		expect(paths([note])).toEqual([]);
	});

	it("is none for the day's-log template, whose name is not a date and which links to no day", () => {
		const template: ReviewNote = { path: "Journal/Template.md", frontmatter: { processed: null }, text: "" };
		expect(paths([template])).toEqual([]);
	});

	it("is the day's log a meeting note's day-link field points to", () => {
		const note = meeting("Planning", "[[2026-10-13]]");
		const rows = wait([note]).list;
		expect(rows.map((row) => [row.path, row.day])).toEqual([[note.path, new Date(2026, 9, 13)]]);
	});

	it("is none when the link points nowhere, to a note that is not a day's log, or is not a link", () => {
		expect(paths([meeting("Nowhere", "[[No such note]]")])).toEqual([]);
		expect(paths([meeting("To a page", "[[Project page]]")])).toEqual([]);
		expect(paths([meeting("Plain text", "2026-10-13")])).toEqual([]);
		expect(paths([meeting("A number", 20261013)])).toEqual([]);
		expect(paths([meeting("No link at all", undefined)])).toEqual([]);
	});

	it("is read through the day-link field the layout names", () => {
		const note: ReviewNote = {
			path: "Meetings/Svenska.md",
			frontmatter: { processed: null, datum: "[[2026-10-13]]", day: "[[2026-10-12]]" },
			text: "",
		};
		expect(wait([note], { dayLinkField: "datum" }).list.map((row) => row.day)).toEqual([new Date(2026, 9, 13)]);
	});

	it("is resolved from the note's own path, as Obsidian resolves a link", () => {
		const asked: string[][] = [];
		const record: ResolveLink = (text, source) => {
			asked.push([text, source]);
			return resolveLink(text, source);
		};
		wait([meeting("Planning", "[[2026-10-13|Tuesday]]")], {}, 7, record);
		expect(asked).toEqual([["2026-10-13", "Meetings/Planning.md"]]);
	});
});

describe("the window", () => {
	it("has its oldest day at today − 6 for a window of 7: today − 6 waits, today − 7 and today − 8 do not", () => {
		// "Seven days ago" counts today as the first of the seven: today − 6 is the
		// window's oldest day and today − 7 the first one outside it.
		expect(paths([log(6)], {}, 7)).toEqual([logPath(6)]);
		expect(paths([log(7)], {}, 7)).toEqual([]);
		expect(paths([log(8)], {}, 7)).toEqual([]);
	});

	it("never takes a day after today, and takes today", () => {
		expect(paths([log(-1)])).toEqual([]);
		expect(paths([log(0)])).toEqual([logPath(0)]);
	});

	it("is the number of days the caller gives: 1 is today alone, 3 reaches back two days", () => {
		const notes = [log(0), log(1), log(2), log(3)];
		expect(paths(notes, {}, 1)).toEqual([logPath(0)]);
		expect(paths(notes, {}, 3)).toEqual([logPath(2), logPath(1), logPath(0)]);
	});

	it("is the same across a clock change: the edges hold when the window spans the US autumn change of 1 November 2026", () => {
		// The suite runs in America/New_York (vitest.config.mts), where the clocks go
		// back on 1 November 2026: 3 November is 6 days after 28 October by the
		// calendar, but 6 days and 1 hour by the clock.
		const end = new Date(2026, 10, 3);
		const waiting = (day: string): ReviewNote => ({ path: `Journal/${day}.md`, frontmatter: { processed: null }, text: "" });
		const rows = waitingNotes([waiting("2026-10-27"), waiting("2026-10-28"), waiting("2026-11-03")], layout(), 7, end, resolveLink, () => false).list;
		expect(rows.map((row) => row.path)).toEqual(["Journal/2026-10-28.md", "Journal/2026-11-03.md"]);
	});

	it("is the same across the spring change too: a span 1 hour short by the clock is still 7 days by the calendar", () => {
		// The clocks go forward on 8 March 2026: 10 March is 7 days after 3 March by
		// the calendar, but 6 days and 23 hours by the clock.
		const end = new Date(2026, 2, 10);
		const waiting = (day: string): ReviewNote => ({ path: `Journal/${day}.md`, frontmatter: { processed: null }, text: "" });
		const rows = waitingNotes([waiting("2026-03-03"), waiting("2026-03-04")], layout(), 7, end, resolveLink, () => false).list;
		expect(rows.map((row) => row.path)).toEqual(["Journal/2026-03-04.md"]);
	});

	it("takes a day's log's day from its own name, even when its day-link field points to another day", () => {
		const note: ReviewNote = {
			path: "Journal/2026-10-14.md",
			frontmatter: { processed: null, day: "[[2026-10-01]]" },
			text: "",
		};
		const row = wait([note]).list[0];
		expect(row.day).toEqual(new Date(2026, 9, 14));
	});

	it("applies to a meeting note through the day it links to, not its own name", () => {
		expect(paths([meeting("Inside", dayLink(6))])).toHaveLength(1);
		expect(paths([meeting("Outside", dayLink(7))])).toEqual([]);
		expect(paths([meeting("Tomorrow", dayLink(-1))])).toEqual([]);
	});
});

describe("excluded folders", () => {
	it("keep a meeting note out, and a folder that merely starts like an excluded one does not", () => {
		const excluded = { excludedFolders: ["Meetings/Old"] };
		const inside: ReviewNote = { ...meeting("Stale", "[[2026-10-14]]"), path: "Meetings/Old/Stale.md" };
		const lookalike: ReviewNote = { ...meeting("Kept", "[[2026-10-14]]"), path: "Meetings/Older/Kept.md" };
		expect(paths([inside, lookalike], excluded)).toEqual([lookalike.path]);
		expect(paths([inside, lookalike])).toHaveLength(2);
	});

	it("keep a day's log out when its own folder is the excluded one", () => {
		expect(paths([log(1)], { excludedFolders: ["Journal"] })).toEqual([]);
		expect(paths([log(1)], { excludedFolders: ["Elsewhere"] })).toEqual([logPath(1)]);
	});
});

describe("the list and the count", () => {
	it("holds today's log without counting it, and yesterday's in both", () => {
		const result = wait([log(0), log(1)]);
		expect(result.list.map((row) => [row.path, row.counts])).toEqual([
			[logPath(1), true],
			[logPath(0), false],
		]);
		expect(result.count).toBe(1);
		expect(wait([log(0)]).count).toBe(0);
		expect(wait([log(1)]).count).toBe(1);
	});

	it("has the oldest day first, and the notes of one day in name order", () => {
		const zebra = meeting("Zebra", "[[2026-10-13]]");
		const apple = meeting("Apple", "[[2026-10-13]]");
		const older = log(4);
		const result = wait([zebra, log(1), apple, older]);
		expect(result.list.map((row) => row.name)).toEqual(["2026-10-11", "Apple", "Zebra", "2026-10-14"]);
		// Name order is not the order the notes were given in.
		expect(wait([apple, zebra]).list.map((row) => row.name)).toEqual(["Apple", "Zebra"]);
		expect(result.count).toBe(4);
	});

	it("carries each row's name without folder or extension, and its day", () => {
		const row = wait([meeting("Budget review", "[[2026-10-12]]")]).list[0];
		expect([row.path, row.name, row.day]).toEqual(["Meetings/Budget review.md", "Budget review", new Date(2026, 9, 12)]);
	});

	it("is empty when nothing waits", () => {
		expect(wait([])).toEqual({ list: [], count: 0, todayDiaryEmpty: false });
	});
});

describe("what each row counts", () => {
	const OPEN_TASKS = [
		"---",
		"processed:",
		"- [ ] not a task, it is frontmatter",
		"---",
		"## Notes",
		"- [ ] first open",
		"- [ ] second open",
		"- [I] an idea, a symbol Migration does not file",
		"- [x] done",
		"```",
		"- [ ] inside a fence",
		"```",
	].join("\n");

	it("counts two open tasks beside one done, one fenced and one in frontmatter", () => {
		expect(wait([ordinaryNote(OPEN_TASKS)]).list[0].openTasks).toBe(2);
	});

	it("counts an open task the way Migration files it: a symbol it does not understand is no open task", () => {
		const text = ["- [ ] a", "- [I] an idea", "- [?] a question", "- [/] copied", "- [>] forwarded", "- [-] dropped"].join("\n");
		const row = wait([ordinaryNote(text)]).list[0];
		expect(row.openTasks).toBe(1);
		// The core reads an unknown symbol as an open task; only the shared rule filters it.
		const core = text.split("\n").filter((line) => parseTaskLine(line)?.meaning === "open");
		expect(core).toHaveLength(3);
	});

	it("counts three bullets, one nested, and not the one inside a fence", () => {
		const text = ["- first", "  - nested", "```", "- fenced", "```", "* third"].join("\n");
		expect(wait([log(1, text)]).list[0].plainBullets).toBe(3);
	});

	it("counts a numbered item and a bullet whose bracket has no space after it as list items without a checkbox", () => {
		const text = ["1. numbered", "- [x]glued", "- [ ] a task"].join("\n");
		const row = wait([ordinaryNote(text)]).list[0];
		expect([row.openTasks, row.plainBullets]).toEqual([1, 2]);
	});

	it("does not count task lines, frontmatter list items or the lines of the frontmatter as bullets", () => {
		const text = ["---", "processed:", "tags:", "  - project", "---", "- one", "- [ ] a task", "- [x] done"].join("\n");
		const row = wait([ordinaryNote(text)]).list[0];
		expect([row.openTasks, row.plainBullets]).toEqual([1, 1]);
	});

	it("counts the same on a note with Windows line endings, ending in a line break or not", () => {
		const body = ["- [ ] open", "- bullet", "  - nested bullet", "```", "- [ ] fenced", "```"];
		for (const ending of ["", "\r\n"]) {
			// A task line inside the frontmatter: a closing rule missed for its `\r` would count it.
			const text = ["---", "processed:", "- [ ] in frontmatter", "---", ...body].join("\r\n") + ending;
			const row = wait([ordinaryNote(text)]).list[0];
			expect([row.openTasks, row.plainBullets], JSON.stringify(ending)).toEqual([1, 2]);
		}
	});

	it("reads three backticks in the frontmatter as a value, not as a fence over the note", () => {
		const text = ["---", "processed:", "```", "---", "- [ ] open", "- bullet"].join("\n");
		const row = wait([ordinaryNote(text)]).list[0];
		expect([row.openTasks, row.plainBullets]).toEqual([1, 1]);
	});

	it("has no frontmatter to skip on a note that opens with a rule and never closes it", () => {
		const row = wait([ordinaryNote(["---", "- [ ] open", "- bullet"].join("\n"))]).list[0];
		expect([row.openTasks, row.plainBullets]).toEqual([1, 1]);
	});
});

describe("isFilableOpen, the rule Migration and Review share", () => {
	const open = (line: string) => {
		const task = parseTaskLine(line);
		return task !== null && isFilableOpen(task);
	};

	it("is true for a space and false for every other symbol, an unknown one included", () => {
		expect(open("- [ ] a")).toBe(true);
		for (const symbol of ["x", "/", "-", ">", "I", "?"]) expect(open(`- [${symbol}] a`), symbol).toBe(false);
	});

	it("agrees with Migration's line check on every symbol the core reads as an open task", () => {
		// Both read the same rule, so they cannot differ on the symbol: if either
		// stopped agreeing — the check dropping the predicate, or the predicate
		// widening — one of these lines would come out differently.
		for (const symbol of [" ", "I", "?", "!", "a"]) {
			const line = `- [${symbol}] a task`;
			const task = parseTaskLine(line);
			expect(task?.meaning, symbol).toBe("open");
			expect(checkLine(line).ok, symbol).toBe(isFilableOpen(task!));
		}
		expect(checkLine("- [ ] a task").ok).toBe(true);
		expect(checkLine("- [I] a task").ok).toBe(false);
	});
});

describe("diaryEmpty, whether a day's log has a diary section with nothing under it", () => {
	const BODY = "# Notes\n- [ ] a task\n\n";
	const EMPTY_DIARY = `${BODY}# Diary\n\n`;
	const diaryOf = (note: ReviewNote, change: Partial<VaultLayout> = {}): boolean | undefined =>
		wait([note], change).list[0]?.diaryEmpty;

	it("is true for today's log whose diary section holds nothing", () => {
		expect(diaryOf(log(0, EMPTY_DIARY))).toBe(true);
	});

	it("is false for the same log with one word under the heading", () => {
		expect(diaryOf(log(0, `${EMPTY_DIARY}Slow morning`))).toBe(false);
	});

	it("is false for a log with no diary heading", () => {
		expect(diaryOf(log(0, BODY))).toBe(false);
	});

	it("is false when the diary heading setting is blank, whatever the log holds", () => {
		const blank = { diaryHeading: { text: "", level: 1 } };
		expect(diaryOf(log(0, EMPTY_DIARY), blank)).toBe(false);
		expect(diaryOf(log(0, `${BODY}#  \n\n`), blank)).toBe(false);
	});

	it("is true for yesterday's log with an empty section: the reader answers, the list decides where to show it", () => {
		expect(diaryOf(log(1, EMPTY_DIARY))).toBe(true);
	});

	it("leaves the count the same with and without the section", () => {
		const without = wait([log(1, BODY), log(2, BODY), log(0, BODY)]);
		const withSection = wait([log(1, EMPTY_DIARY), log(2, EMPTY_DIARY), log(0, EMPTY_DIARY)]);
		expect(without.count).toBe(2);
		expect(withSection.count).toBe(without.count);
		expect(withSection.list.map((row) => row.counts)).toEqual(without.list.map((row) => row.counts));
	});

	it("reads blank lines of every kind as nothing, Windows line breaks included", () => {
		expect(diaryOf(log(0, "# Notes\r\n\r\n# Diary\r\n\r\n  \t\r\n\r\n"))).toBe(true);
		expect(diaryOf(log(0, "# Notes\r\n\r\n# Diary\r\n\r\nSlow morning"))).toBe(false);
		expect(diaryOf(log(0, "# Notes\n# Diary"))).toBe(true);
	});

	it("ends the section at the next heading of its level, so words beneath that heading are not the diary's", () => {
		expect(diaryOf(log(0, "# Diary\n\n# Elsewhere\nwords here\n"))).toBe(true);
	});

	it("counts a deeper heading, a bullet and a fenced block inside the section as words", () => {
		for (const inside of ["## Morning", "- a bullet", "```\ncode\n```"]) {
			expect(diaryOf(log(0, `# Diary\n${inside}\n`)), inside).toBe(false);
		}
	});

	it("finds the heading at the level the setting names and no other", () => {
		const second = { diaryHeading: { text: "Diary", level: 2 } };
		expect(diaryOf(log(0, "## Diary\n\n"), second)).toBe(true);
		expect(diaryOf(log(0, "# Diary\n\n"), second)).toBe(false);
	});

	it("does not take a comment line in the frontmatter for the heading", () => {
		// Two comment lines in the property block: read as headings they would make
		// an empty section, so code that reads the header answers true.
		const text = "---\nprocessed:\n# Diary\n# Other\n---\n# Notes\nwords\n";
		expect(diaryOf(log(0, text))).toBe(false);
	});

	it("is false for a note that is not a day's log, even with an empty section of that name", () => {
		const note = { ...meeting("Budget talk", dayLink(0)), text: EMPTY_DIARY };
		expect(diaryOf(note)).toBe(false);
	});
});

describe("todayDiaryEmpty, whether today's log has a diary section with nothing under it, whatever its processed field says", () => {
	const BODY = "# Notes\n- [ ] a task\n\n";
	const EMPTY_DIARY = `${BODY}# Diary\n\n`;
	const DONE = { processed: "2026-10-15" };
	const flag = (notes: ReviewNote[], change: Partial<VaultLayout> = {}): boolean => wait(notes, change).todayDiaryEmpty;

	it("is true for today's log already marked processed, though that log has no row", () => {
		const answer = wait([log(0, EMPTY_DIARY, DONE)]);
		// If the fact were only carried by a row, this log (which has none) would give false.
		expect(answer.list).toEqual([]);
		expect(answer.todayDiaryEmpty).toBe(true);
	});

	it("is true whatever shape the processed field takes: filled, absent, or no frontmatter at all", () => {
		expect(flag([log(0, EMPTY_DIARY, DONE)])).toBe(true);
		expect(flag([log(0, EMPTY_DIARY, {})])).toBe(true);
		expect(flag([{ path: logPath(0), frontmatter: null, text: EMPTY_DIARY }])).toBe(true);
	});

	it("is true for today's log that is still waiting, where its row carries the words too", () => {
		const answer = wait([log(0, EMPTY_DIARY)]);
		expect(answer.list.map((row) => row.diaryEmpty)).toEqual([true]);
		expect(answer.todayDiaryEmpty).toBe(true);
	});

	it("is false once the processed log's diary holds a word", () => {
		expect(flag([log(0, `${EMPTY_DIARY}Slow morning`, DONE)])).toBe(false);
	});

	it("is false for a processed log with no diary heading, and when the diary heading setting is blank", () => {
		expect(flag([log(0, BODY, DONE)])).toBe(false);
		expect(flag([log(0, EMPTY_DIARY, DONE)], { diaryHeading: { text: "", level: 1 } })).toBe(false);
	});

	it("is false when only another day's log has the empty section: the diary is today's or nothing", () => {
		expect(flag([log(1, EMPTY_DIARY, DONE), log(2, EMPTY_DIARY)])).toBe(false);
		expect(flag([])).toBe(false);
	});

	it("is false for a note that is not a day's log, even one linking to today with an empty section of that name", () => {
		const note = { ...meeting("Budget talk", dayLink(0), DONE), text: EMPTY_DIARY };
		expect(flag([note])).toBe(false);
	});

	it("is false for today's log in an excluded folder, as no row would be there either", () => {
		const note = { path: logPath(0, "Journal/Private"), frontmatter: DONE, text: EMPTY_DIARY };
		const inFolder = { dailyLogFolder: "Journal/Private" };
		expect(flag([note], { ...inFolder, excludedFolders: ["Journal/Private"] })).toBe(false);
		expect(flag([note], inFolder)).toBe(true);
	});

	it("reads Windows line breaks as it reads Unix ones, with and without a final line break", () => {
		expect(flag([log(0, "# Notes\r\n\r\n# Diary\r\n\r\n  \t\r\n", DONE)])).toBe(true);
		expect(flag([log(0, "# Notes\r\n\r\n# Diary", DONE)])).toBe(true);
		expect(flag([log(0, "# Notes\r\n\r\n# Diary\r\n\r\nSlow morning", DONE)])).toBe(false);
	});

	it("leaves the count and the list as they were without the fact", () => {
		const answer = wait([log(0, EMPTY_DIARY, DONE), log(1, BODY), log(2, BODY)]);
		expect(answer.count).toBe(2);
		expect(answer.list.map((row) => row.path)).toEqual([logPath(2), logPath(1)]);
	});
});
