/**
 * The diary-date write function: a day's log's text in, its text out, the
 * diary-date field's line the only change (ticket
 * #1109, ADR 0005).
 *
 * Every expectation is the exact text, so a stray line ending, a lost final
 * line break or a tidied property would show as a different string. Every note,
 * name and date here is invented.
 */

import { describe, expect, it } from "vitest";
import { dailyLogFromTemplate, dailyLogTemplateDiary } from "../core/dailyLogTemplate";
import { defaultData } from "../core/settings";
import { diaryDateText } from "../features/review/diaryDate";

const TODAY = "2026-03-18";
const HEADING = "Diary";

/** Lines joined with `eol`, ending in a line break when `final` is true. */
function joined(lines: readonly string[], eol: string, final: boolean): string {
	return lines.join(eol) + (final ? eol : "");
}

/** A day's log with `frontmatter` lines (or none) above a body that has text under its `# Diary`. */
function log(frontmatter: readonly string[] | null, eol: string, final: boolean, diary: readonly string[] = ["Walked by the harbour."]): string {
	const head = frontmatter === null ? [] : ["---", ...frontmatter, "---"];
	return joined([...head, "# Notes", "- [ ] send the notes", "# Diary", ...diary], eol, final);
}

const write = (text: string, field = "diary"): string | null => diaryDateText(text, HEADING, 1, field, TODAY);

describe("a day's log with text under the diary heading and an empty field", () => {
	it.each([
		["Unix endings, ending in a line break", "\n", true],
		["Unix endings, with no final line break", "\n", false],
		["Windows endings, ending in a line break", "\r\n", true],
		["Windows endings, with no final line break", "\r\n", false],
	])("fills the field's line and nothing else, on %s", (_name, eol, final) => {
		const before = log(["title: Weekly sync", "diary:", "processed:"], eol, final);
		const after = log(["title: Weekly sync", `diary: ${TODAY}`, "processed:"], eol, final);
		expect(write(before)).toBe(after);
	});

	it("changes exactly one line, as these literal bytes show", () => {
		expect(write("---\r\ntitle: Weekly sync\r\ndiary:\r\n---\r\n# Diary\r\nRain all day.")).toBe(
			"---\r\ntitle: Weekly sync\r\ndiary: 2026-03-18\r\n---\r\n# Diary\r\nRain all day.",
		);
		expect(write("---\ndiary:\n---\n# Diary\nRain all day.\n")).toBe("---\ndiary: 2026-03-18\n---\n# Diary\nRain all day.\n");
	});

	it("writes the date bare, with no quotes", () => {
		expect(write(log(["diary:"], "\n", true))).toBe(log([`diary: ${TODAY}`], "\n", true));
		expect(write(log(["diary:"], "\n", true))).not.toContain('"');
	});

	it("treats a quoted empty value as empty and keeps the person's trailing comment", () => {
		expect(write(log(['diary: "" # not yet'], "\n", true))).toBe(log([`diary: ${TODAY} # not yet`], "\n", true));
	});

	it("fills the field the layout names, not the shipped one", () => {
		const before = log(["dagbok:", "diary: keep"], "\n", true);
		expect(write(before, "dagbok")).toBe(log([`dagbok: ${TODAY}`, "diary: keep"], "\n", true));
	});

	it("finds the heading in other capitals and at the level it is given", () => {
		const before = "---\ndiary:\n---\n## DIARY\ntext\n";
		expect(diaryDateText(before, "diary", 2, "diary", TODAY)).toBe(`---\ndiary: ${TODAY}\n---\n## DIARY\ntext\n`);
	});

	it("counts text in a sub-heading's section as the diary's own", () => {
		const before = "---\ndiary:\n---\n# Diary\n## Morning\nrain\n";
		expect(write(before)).toBe(`---\ndiary: ${TODAY}\n---\n# Diary\n## Morning\nrain\n`);
	});

	it("reads a note whose only line endings are carriage returns", () => {
		expect(write("---\rdiary:\r---\r# Diary\rtext\r")).toBe(`---\rdiary: ${TODAY}\r---\r# Diary\rtext\r`);
	});

	it("keeps a byte-order mark first", () => {
		expect(write("﻿---\ndiary:\n---\n# Diary\ntext\n")).toBe(`﻿---\ndiary: ${TODAY}\n---\n# Diary\ntext\n`);
	});
});

describe("a day's log with text and no such field", () => {
	it.each([
		["Unix endings, ending in a line break", "\n", true],
		["Unix endings, with no final line break", "\n", false],
		["Windows endings, ending in a line break", "\r\n", true],
		["Windows endings, with no final line break", "\r\n", false],
	])("adds the line as the block's last, on %s", (_name, eol, final) => {
		const before = log(["title: Weekly sync", "processed:"], eol, final);
		const after = log(["title: Weekly sync", "processed:", `diary: ${TODAY}`], eol, final);
		expect(write(before)).toBe(after);
	});

	it("adds it to an empty block", () => {
		expect(write("---\n---\n# Diary\ntext\n")).toBe(`---\ndiary: ${TODAY}\n---\n# Diary\ntext\n`);
	});

	it("does not take a similar key for the field", () => {
		expect(write(log(["diary-entry: x", "mydiary:", "  diary: nested"], "\n", true))).toBe(
			log(["diary-entry: x", "mydiary:", "  diary: nested", `diary: ${TODAY}`], "\n", true),
		);
	});
});

describe("a day's log with no frontmatter", () => {
	it("gets exactly this block, in these bytes", () => {
		expect(write("# Diary\r\nRain all day.")).toBe("---\r\ndiary: 2026-03-18\r\n---\r\n# Diary\r\nRain all day.");
		expect(write("# Diary\nRain all day.\n")).toBe("---\ndiary: 2026-03-18\n---\n# Diary\nRain all day.\n");
	});

	it.each([
		["Unix endings, ending in a line break", "\n", true],
		["Unix endings, with no final line break", "\n", false],
		["Windows endings, ending in a line break", "\r\n", true],
		["Windows endings, with no final line break", "\r\n", false],
	])("gets a block carrying the one field, on %s", (_name, eol, final) => {
		const after = log([`diary: ${TODAY}`], eol, final);
		expect(write(log(null, eol, final))).toBe(after);
	});

	it("puts the block after a byte-order mark", () => {
		expect(write("﻿# Diary\ntext\n")).toBe(`﻿---\ndiary: ${TODAY}\n---\n# Diary\ntext\n`);
	});

	it("takes an opening rule with no close for text, not for frontmatter", () => {
		expect(write("---\n# Diary\ntext\n")).toBe(`---\ndiary: ${TODAY}\n---\n---\n# Diary\ntext\n`);
	});
});

describe("no change", () => {
	it("when the section holds only blank lines, a carriage return and a tab among them", () => {
		expect(write(log(["diary:"], "\n", true, ["", "  ", "\t", ""]))).toBeNull();
		expect(write(log(["diary:"], "\r\n", true, ["", "  ", ""]))).toBeNull();
	});

	it("when the heading is absent", () => {
		expect(write("---\ndiary:\n---\n# Notes\ntext\n")).toBeNull();
	});

	it("when the heading is present at another level", () => {
		expect(write("---\ndiary:\n---\n## Diary\ntext\n")).toBeNull();
		expect(diaryDateText("---\ndiary:\n---\n# Diary\ntext\n", HEADING, 2, "diary", TODAY)).toBeNull();
	});

	it.each([
		["a date", "diary: 2026-03-10"],
		["true", "diary: true"],
		["a word", "diary: yesterday"],
		["a quoted date", 'diary: "2026-03-10"'],
		["today's own date", `diary: ${TODAY}`],
		["a list", "diary:\n  - one"],
	])("when the field already holds %s", (_name, field) => {
		expect(write(`---\n${field}\n---\n# Diary\ntext\n`)).toBeNull();
	});

	it("when the field holds a value, on Windows endings too", () => {
		expect(write(log(["diary: 2026-03-10"], "\r\n", false))).toBeNull();
	});

	it("when the only text is inside the heading line itself", () => {
		expect(write("---\ndiary:\n---\n# Diary of a quiet day\n")).toBeNull();
		expect(write("---\ndiary:\n---\n# Diary\n")).toBeNull();
		expect(write("---\ndiary:\n---\n# Diary")).toBeNull();
	});

	it("when the text sits under the next heading of the same level rather than under the diary's", () => {
		expect(write("---\ndiary:\n---\n# Diary\n\n# Evening\ntext\n")).toBeNull();
	});

	it("when the text sits under a shallower heading after it", () => {
		expect(diaryDateText("---\ndiary:\n---\n## Diary\n\n# Evening\ntext\n", HEADING, 2, "diary", TODAY)).toBeNull();
	});

	it("when the heading is blank", () => {
		expect(diaryDateText("---\ndiary:\n---\n# Diary\ntext\n", "", 1, "diary", TODAY)).toBeNull();
		expect(diaryDateText("---\ndiary:\n---\n# Diary\ntext\n", "  ", 1, "diary", TODAY)).toBeNull();
	});

	it("when the heading is inside a fenced block", () => {
		expect(write("---\ndiary:\n---\n```\n# Diary\ntext\n```\n")).toBeNull();
	});

	it("when the heading is a comment line inside the frontmatter, not in the body", () => {
		expect(write("---\n# Diary\ndiary:\n---\n# Notes\ntext\n")).toBeNull();
	});
});

describe("the field's name", () => {
	it("is refused when blank, loudly, rather than writing a nameless line", () => {
		expect(() => write("---\n---\n# Diary\ntext\n", "  ")).toThrow(/no name/);
	});
});

describe("a field holding an empty list", () => {
	it.each([
		["Unix endings, ending in a line break", "\n", true],
		["Unix endings, with no final line break", "\n", false],
		["Windows endings, ending in a line break", "\r\n", true],
		["Windows endings, with no final line break", "\r\n", false],
	])("is filled and nothing else changes, on %s", (_name, eol, final) => {
		for (const spelling of ["[]", "[ ]", "[\t]"]) {
			const before = log(["title: Weekly sync", `diary: ${spelling}`, "processed:"], eol, final);
			const after = log(["title: Weekly sync", `diary: ${TODAY}`, "processed:"], eol, final);
			expect(write(before)).toBe(after);
		}
	});

	it("keeps a trailing comment after the date", () => {
		expect(write(log(["diary: [] # not yet"], "\r\n", false))).toBe(log([`diary: ${TODAY} # not yet`], "\r\n", false));
	});

	it("is left alone when the list holds an item", () => {
		expect(write(log(["diary: [2026-03-10]"], "\n", true))).toBeNull();
		expect(write(log(["diary: [", "2026-03-10", "]"], "\n", true))).toBeNull();
	});

	it("is filled as one line when it is spread over two, as the chain reads it", () => {
		expect(write(log(["diary: [", "]"], "\n", true))).toBe(log([`diary: ${TODAY}`], "\n", true));
	});
});

describe("a log whose own day is after the day being recorded", () => {
	const text = log(["diary:"], "\n", true);
	const stamp = (logDay: string | null): string | null => diaryDateText(text, HEADING, 1, "diary", TODAY, { logDay });

	it("is never stamped: days ahead builds it, and nobody has written in it", () => {
		expect(stamp("2026-03-21")).toBeNull();
		expect(stamp("2026-03-19")).toBeNull();
	});

	it("is stamped on its own day, and a past day's log is stamped with the day its text was seen (a diary written in hindsight)", () => {
		expect(stamp(TODAY)).toBe(log([`diary: ${TODAY}`], "\n", true));
		expect(stamp("2026-03-10")).toBe(log([`diary: ${TODAY}`], "\n", true));
	});

	it("is stamped as before when the log's day is not known", () => {
		expect(stamp(null)).toBe(log([`diary: ${TODAY}`], "\n", true));
	});
});

describe("text under the diary heading that the day's-log template put there", () => {
	const template = "- What did I learn today?\n- What will I change?";
	const withDiary = (lines: readonly string[], eol = "\n", final = true): string => log(["diary:"], eol, final, lines);
	const stamp = (text: string, templateDiary: string | null = template): string | null =>
		diaryDateText(text, HEADING, 1, "diary", TODAY, { templateDiary });

	it("is not the person's words while the section is exactly the template's", () => {
		expect(stamp(withDiary(["- What did I learn today?", "- What will I change?"]))).toBeNull();
	});

	it("counts as the person's once a line is added, changed or removed", () => {
		const filled = (lines: readonly string[]): string => log([`diary: ${TODAY}`], "\n", true, lines);
		const added = ["- What did I learn today?", "- What will I change?", "Rain."];
		expect(stamp(withDiary(added))).toBe(filled(added));
		const changed = ["- What did I learn today? Very little.", "- What will I change?"];
		expect(stamp(withDiary(changed))).toBe(filled(changed));
		const removed = ["- What did I learn today?"];
		expect(stamp(withDiary(removed))).toBe(filled(removed));
	});

	it.each([
		["Windows endings, ending in a line break", "\r\n", true],
		["Windows endings, with no final line break", "\r\n", false],
		["Unix endings, with no final line break", "\n", false],
	])("is not the person's words on a log with %s, and is after one line is added", (_name, eol, final) => {
		const untouched = withDiary(["- What did I learn today?", "- What will I change?"], eol, final);
		expect(stamp(untouched)).toBeNull();
		const added = withDiary(["- What did I learn today?", "- What will I change?", "Rain."], eol, final);
		expect(stamp(added)).toBe(log([`diary: ${TODAY}`], eol, final, ["- What did I learn today?", "- What will I change?", "Rain."]));
	});

	it("ignores blank lines after the template's text, which the person did not write either", () => {
		expect(stamp(withDiary(["- What did I learn today?", "- What will I change?", "", ""]))).toBeNull();
	});

	it("counts any text as the person's when there is no template", () => {
		expect(stamp(withDiary(["- What did I learn today?", "- What will I change?"]), null)).not.toBeNull();
	});
});

describe("the diary section the core's template code would produce", () => {
	const layout = defaultData().core.layout;
	const day = new Date(2026, 2, 21, 12, 0, 0);

	it("is the text under the diary heading of the log built from the template, placeholders filled for that day", () => {
		const template = "---\ndiary:\n---\n# Notes\n# Diary\n- On {{date:YYYY-MM-DD}}: what did I learn?\n# Later\nx\n";
		expect(dailyLogTemplateDiary(template, day, layout)).toBe("- On 2026-03-21: what did I learn?");
	});

	it("is what dailyLogFromTemplate itself puts under the heading, line endings as line feeds", () => {
		const template = "# Notes\r\n# Diary\r\nOne.\r\nTwo.\r\n";
		const built = dailyLogFromTemplate(template, day, layout);
		expect(built).toContain("One.");
		// The final line break of the built log leaves an empty last line, which the comparison ignores.
		expect(dailyLogTemplateDiary(template, day, layout)).toBe("One.\nTwo.\n");
	});

	it("is empty when the template has no diary heading, the heading the core adds being empty", () => {
		expect(dailyLogTemplateDiary("# Notes\n- x\n", day, layout)).toBe("");
	});
});
