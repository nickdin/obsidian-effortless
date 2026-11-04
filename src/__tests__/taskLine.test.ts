import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fixture } from "./fixtures";
import { shippedSources, withoutComments } from "./sourceGuards";
import {
	checkboxMeaning,
	checkboxSlot,
	dateStampText,
	editTaskField,
	isBookkeepingComment,
	mayBeCheckbox,
	parseTaskLine,
	readComment,
	repeatQuote,
	repeatStampText,
	setComment,
	splitsACharacter,
	uncapturedRepeat,
	type Priority,
	type TaskField,
	type TaskLine,
} from "../core/taskLine";

// The corpus is read through `fixture`, which resolves from the test folder's
// own directory and carries the reason for that form. The source path is built
// the same way, one folder sideways rather than through the repository root.
const sourcePath = resolve(__dirname, "..", "core", "taskLine.ts");

/** Every line of the corpus that is a case rather than commentary. */
const corpus: string[] = fixture("task-lines.md")
	.split("\n")
	.filter((line) => line.length > 0 && !line.startsWith(">"));

/** Parses `raw`, failing the test rather than returning null. */
function parsed(raw: string): TaskLine {
	const task = parseTaskLine(raw);
	if (task === null) throw new Error(`expected a task line: ${JSON.stringify(raw)}`);
	return task;
}

/**
 * The one region in which `after` differs from `before`, with both ends pulled
 * off a surrogate pair so an emoji is never reported as half of itself.
 *
 * What a surrogate pair is, is `splitsACharacter`'s answer in the core rather
 * than this file's.
 */
function soleDifference(before: string, after: string): { removed: string; inserted: string } {
	let head = 0;
	while (head < before.length && head < after.length && before[head] === after[head]) head++;
	if (splitsACharacter(before, head)) head--;

	let tail = 0;
	const room = Math.min(before.length, after.length) - head;
	while (
		tail < room &&
		before[before.length - 1 - tail] === after[after.length - 1 - tail]
	) {
		tail++;
	}
	if (splitsACharacter(before, before.length - tail)) tail--;

	return {
		removed: before.slice(head, before.length - tail),
		inserted: after.slice(head, after.length - tail),
	};
}

describe("soleDifference", () => {
	it("reports a whole emoji rather than half of one", () => {
		expect(soleDifference("a 🔼 b", "a 🔽 b")).toEqual({ removed: "🔼", inserted: "🔽" });
	});
});

describe("checkboxMeaning", () => {
	it("gives the five fixed characters their meanings", () => {
		expect(checkboxMeaning(" ")).toBe("open");
		expect(checkboxMeaning("/")).toBe("copied");
		expect(checkboxMeaning("x")).toBe("done");
		expect(checkboxMeaning("-")).toBe("cancelled");
		expect(checkboxMeaning(">")).toBe("forwarded");
	});

	it("calls every other string an open task", () => {
		expect(checkboxMeaning("X")).toBe("open");
		expect(checkboxMeaning("?")).toBe("open");
		expect(checkboxMeaning("")).toBe("open");
		expect(checkboxMeaning("x] Task")).toBe("open");
	});

	it("calls a name an ordinary object answers to an open task, not that object's answer", () => {
		// A table lookup without an own-property check hands back what every
		// object inherits under these names, which is a function, not a meaning.
		expect(checkboxMeaning("constructor")).toBe("open");
		expect(checkboxMeaning("toString")).toBe("open");
		expect(checkboxMeaning("__proto__")).toBe("open");
	});
});

describe("parseTaskLine", () => {
	it("reads the five fixed checkbox meanings", () => {
		expect(parsed("- [ ] Task").meaning).toBe("open");
		expect(parsed("- [/] Task").meaning).toBe("copied");
		expect(parsed("- [x] Task").meaning).toBe("done");
		expect(parsed("- [-] Task").meaning).toBe("cancelled");
		expect(parsed("- [>] Task").meaning).toBe("forwarded");
	});

	it("reads any other checkbox character as an ordinary open task, symbol kept", () => {
		const task = parsed("- [S] Task");
		expect(task.meaning).toBe("open");
		expect(task.checkbox).toBe("S");
	});

	it("keeps the indentation and the list marker exactly as written", () => {
		const task = parsed("\t\t* [ ] Task");
		expect(task.indent).toBe("\t\t");
		expect(task.marker).toBe("*");
	});

	it("accepts all four list markers", () => {
		for (const marker of ["-", "*", "+", "1.", "1)"]) {
			expect(parseTaskLine(`${marker} [ ] Task`)).not.toBeNull();
		}
	});

	it("reads the scheduled and due dates", () => {
		const task = parsed("- [ ] Task ⏳ 2026-01-05 📅 2026-02-06");
		expect(task.scheduled).toBe("2026-01-05");
		expect(task.due).toBe("2026-02-06");
	});

	it("reads a date written without a space after its emoji", () => {
		expect(parsed("- [ ] Task ⏳2026-01-05").scheduled).toBe("2026-01-05");
	});

	it("reads all five priority levels, not three", () => {
		const levels: Array<[string, Priority]> = [
			["🔺", "highest"],
			["⏫", "high"],
			["🔼", "medium"],
			["🔽", "low"],
			["⏬", "lowest"],
		];
		for (const [emoji, level] of levels) {
			expect(parsed(`- [ ] Task ${emoji}`).priority).toBe(level);
		}
	});

	it("reads tags, including nested ones", () => {
		expect(parsed("- [ ] Task #work/admin and #errand").tags).toEqual(["#work/admin", "#errand"]);
	});

	it("does not read a fragment inside an address as a tag", () => {
		expect(parsed("- [ ] Task https://example.com/page#section").tags).toEqual([]);
	});

	it("does not read a heading inside a link as a tag", () => {
		expect(parsed("- [ ] Task [[Somewhere#A heading]]").tags).toEqual([]);
	});

	it("keeps every bookkeeping comment verbatim", () => {
		const task = parsed("- [ ] Task %% eid:m1abc2de %% words %% note:kept %%");
		expect(task.comments).toEqual(["%% eid:m1abc2de %%", "%% note:kept %%"]);
	});

	it("treats what is inside a comment as bookkeeping rather than as fields", () => {
		const task = parsed("- [ ] Task %% eid:x ⏳ 2026-01-05 #work ⏫ %%");
		expect(task.scheduled).toBeNull();
		expect(task.priority).toBeNull();
		expect(task.tags).toEqual([]);
	});

	it("hands back the description with the separating whitespace removed and nothing else", () => {
		expect(parsed("-   [ ]   Task ⏳ 2026-01-05").description).toBe("Task ⏳ 2026-01-05");
		expect(parsed("- [x]").description).toBe("");
	});

	it("treats a bare carriage return right after the checkbox as the end of it", () => {
		const task = parsed("- [ ]\r");
		expect(task.checkbox).toBe(" ");
		expect(task.description).toBe("\r");
	});

	it("keeps reading a checkbox followed by a space, text or nothing exactly as before", () => {
		expect(parsed("- [ ] \r").description).toBe("\r");
		expect(parsed("- [ ] a\r").description).toBe("a\r");
		expect(parsed("- [ ]").description).toBe("");
	});

	it("returns null for anything that is not a task line", () => {
		for (const line of [
			"",
			"Not a task at all",
			"- just a bullet",
			"- [] empty brackets",
			"- [ab] two characters",
			"- [x]no space after the box",
			"> - [ ] inside a blockquote",
			"- [ ] two\n- [ ] lines",
		]) {
			expect(parseTaskLine(line)).toBeNull();
		}
	});
});

describe("parseTaskLine, the repeat rule", () => {
	it("reads the rule beside a date, a tag and a comment, each in its own field", () => {
		const task = parsed("- [ ] Vattna 🔁 every week ⏳ 2026-11-03 #hem %% note %%");
		expect(task.repeat).toBe("every week");
		expect(task.scheduled).toBe("2026-11-03");
		expect(task.tags).toEqual(["#hem"]);
		expect(task.comments).toEqual(["%% note %%"]);
	});

	it("reads the same rule with the rule last on the line", () => {
		const task = parsed("- [ ] Vattna ⏳ 2026-11-03 #hem %% note %% 🔁 every week");
		expect(task.repeat).toBe("every week");
		expect(task.scheduled).toBe("2026-11-03");
		expect(task.tags).toEqual(["#hem"]);
		expect(task.comments).toEqual(["%% note %%"]);
	});

	it("reads a rule the grammar would refuse as text all the same", () => {
		const task = parsed("- [ ] Vattna 🔁 every weekday please ⏳ 2026-11-03 #hem %% note %%");
		expect(task.repeat).toBe("every weekday please");
		expect(task.scheduled).toBe("2026-11-03");
		expect(task.tags).toEqual(["#hem"]);
		expect(task.comments).toEqual(["%% note %%"]);
	});

	it("reads null when the line carries no rule, or a bare emoji with no text", () => {
		expect(parsed("- [ ] Vattna ⏳ 2026-11-03 #hem").repeat).toBeNull();
		expect(parsed("- [ ] Vattna 🔁 ⏳ 2026-11-03").repeat).toBeNull();
	});

	it("leaves trailing blanks out of the rule", () => {
		expect(parsed("- [ ] Vattna 🔁 every week   ").repeat).toBe("every week");
		expect(parsed("- [ ] Vattna 🔁 every week \t").repeat).toBe("every week");
	});

	it("stops the rule at a comment rather than reading the words after the comment as more of it", () => {
		expect(parsed("- [ ] Vattna 🔁 every week %% note %% soon").repeat).toBe("every week");
	});

	it("does not read a rule that sits inside a comment", () => {
		expect(parsed("- [ ] Vattna %% 🔁 every week %%").repeat).toBeNull();
	});

	it("reads a rule with commas and digits, and one written without a space after the emoji", () => {
		expect(parsed("- [ ] Vattna 🔁 every week on Monday, Thursday").repeat).toBe(
			"every week on Monday, Thursday",
		);
		expect(parsed("- [ ] Vattna 🔁every 3 days").repeat).toBe("every 3 days");
	});
});

describe("isBookkeepingComment", () => {
	it("recognises one inline comment, with or without surrounding space", () => {
		expect(isBookkeepingComment("%% eid:m1abc2de %%")).toBe(true);
		expect(isBookkeepingComment("  %%eid:m1abc2de%%  ")).toBe(true);
		expect(isBookkeepingComment("%%%%")).toBe(true);
	});

	it("refuses anything that is not exactly one comment", () => {
		expect(isBookkeepingComment("eid:m1abc2de")).toBe(false);
		expect(isBookkeepingComment("%% one %% and %% two %%")).toBe(false);
		expect(isBookkeepingComment("%% unclosed")).toBe(false);
		expect(isBookkeepingComment("%%%")).toBe(false);
		expect(isBookkeepingComment("words %% eid:x %%")).toBe(false);
	});
});

describe("editTaskField", () => {
	it("changes the checkbox character and no other byte", () => {
		const before = "\t- [ ] Task ⏳ 2026-01-05 %% eid:m1abc2de %%";
		const after = editTaskField(before, "checkbox", "x");
		expect(soleDifference(before, after)).toEqual({ removed: " ", inserted: "x" });

		const withRule = "\t- [ ] Task 🔁 every week ⏳ 2026-01-05 %% eid:m1abc2de %%";
		expect(editTaskField(withRule, "checkbox", "x")).toBe(
			"\t- [x] Task 🔁 every week ⏳ 2026-01-05 %% eid:m1abc2de %%",
		);
	});

	it("changes a date's digits and leaves the emoji and its spacing alone", () => {
		const before = "- [ ] Task ⏳2026-01-05 📅 2026-02-06";
		expect(editTaskField(before, "scheduled", "2026-03-09")).toBe(
			"- [ ] Task ⏳2026-03-09 📅 2026-02-06",
		);
		expect(editTaskField("- [ ] Task 🔁 every week ⏳2026-01-05 📅 2026-02-06", "scheduled", "2026-03-09")).toBe(
			"- [ ] Task 🔁 every week ⏳2026-03-09 📅 2026-02-06",
		);
	});

	it("adds a missing field before a trailing bookkeeping comment", () => {
		expect(editTaskField("- [ ] Task %% eid:m1abc2de %%", "due", "2026-02-06")).toBe(
			"- [ ] Task 📅 2026-02-06 %% eid:m1abc2de %%",
		);
		expect(editTaskField("- [ ] Task 🔁 every week %% eid:m1abc2de %%", "due", "2026-02-06")).toBe(
			"- [ ] Task 🔁 every week 📅 2026-02-06 %% eid:m1abc2de %%",
		);
	});

	it("adds a missing field before trailing whitespace", () => {
		expect(editTaskField("- [ ] Task  ", "scheduled", "2026-01-05")).toBe(
			"- [ ] Task ⏳ 2026-01-05  ",
		);
	});

	it("adds a field to a task with no description at all", () => {
		expect(editTaskField("- [ ]", "priority", "high")).toBe("- [ ] ⏫");
	});

	it("removes a field along with one separating space and nothing more", () => {
		expect(editTaskField("- [ ] Task ⏳ 2026-01-05 📅 2026-02-06", "scheduled", null)).toBe(
			"- [ ] Task 📅 2026-02-06",
		);
		expect(editTaskField("- [ ] Task  ⏳ 2026-01-05", "scheduled", null)).toBe("- [ ] Task ");
	});

	it("does nothing when asked to remove a field that is not there", () => {
		const before = "- [ ] Task";
		expect(editTaskField(before, "due", null)).toBe(before);
	});

	it("replaces a priority emoji in place", () => {
		const before = "- [ ] Task 🔺 #work";
		expect(soleDifference(before, editTaskField(before, "priority", "lowest"))).toEqual({
			removed: "🔺",
			inserted: "⏬",
		});

		const withRule = "- [ ] Task 🔁 every week 🔺 #work";
		expect(editTaskField(withRule, "priority", "lowest")).toBe("- [ ] Task 🔁 every week ⏬ #work");
	});

	it("never touches what is inside a bookkeeping comment", () => {
		const before = "- [ ] Task %% eid:x ⏳ 2026-01-05 ⏫ %%";
		const after = editTaskField(before, "scheduled", "2026-03-09");
		expect(after).toContain("%% eid:x ⏳ 2026-01-05 ⏫ %%");
		expect(parsed(after).scheduled).toBe("2026-03-09");
	});

	it("refuses a line that is not a task line", () => {
		expect(() => editTaskField("not a task", "checkbox", "x")).toThrow();
	});

	it("refuses a checkbox that is not one character", () => {
		expect(() => editTaskField("- [ ] Task", "checkbox", "xy")).toThrow();
		expect(() => editTaskField("- [ ] Task", "checkbox", "")).toThrow();
		expect(() => editTaskField("- [ ] Task", "checkbox", "]")).toThrow();
	});

	it("refuses a checkbox character that would end the line", () => {
		expect(() => editTaskField("- [ ] Task", "checkbox", "\n")).toThrow();
		expect(() => editTaskField("- [ ] Task", "checkbox", "\r")).toThrow();
	});

	it("still accepts a character that reads back, however odd it is", () => {
		// #66's reproduction listed `\t` among the characters to reject and the
		// shipped guard rejects two of the four. That is deliberate under #35, and
		// this case is what holds it: `TASK_HEAD`'s checkbox group is `[^\]]`, so a
		// tab written into the brackets parses back as a tab.
		for (const character of ["\t", "[", "|"]) {
			expect(parsed(editTaskField("- [ ] Task", "checkbox", character)).checkbox).toBe(character);
		}
	});

	it("refuses a field it has no case for, rather than treating it as priority", () => {
		const unknown = "tag" as TaskField;
		expect(() => editTaskField("- [ ] Task", unknown, null as never)).toThrow(/tag/u);
	});

	it("refuses a date that is not YYYY-MM-DD", () => {
		expect(() => editTaskField("- [ ] Task", "scheduled", "2026-3-5")).toThrow();
	});

	it("keeps a trailing carriage return through a checkbox edit and a re-parse", () => {
		const after = editTaskField("- [ ]\r", "checkbox", "x");
		expect(after.endsWith("\r")).toBe(true);
		expect(parsed(after).description).toBe("\r");
	});
});

describe("editTaskField with tags", () => {
	it("appends a tag to a line with none, before a trailing bookkeeping comment", () => {
		expect(editTaskField("- [ ] Task %% eid:m1abc2de %%", "tags", ["#work"])).toBe(
			"- [ ] Task #work %% eid:m1abc2de %%",
		);
		expect(editTaskField("- [ ] Task 🔁 every week %% eid:m1abc2de %%", "tags", ["#work"])).toBe(
			"- [ ] Task 🔁 every week #work %% eid:m1abc2de %%",
		);
	});

	it("removes the middle tag of three and keeps the others in order with single spacing", () => {
		const before = "- [ ] Task #a #b #c";
		expect(editTaskField(before, "tags", ["#a", "#c"])).toBe("- [ ] Task #a #c");
	});

	it("keeps existing tags where they were and appends only the new ones when the order changes", () => {
		const before = "- [ ] Task #a #b";
		expect(editTaskField(before, "tags", ["#b", "#a", "#c"])).toBe("- [ ] Task #a #b #c");
	});

	it("leaves a `#` that is not a tag untouched by a tag edit", () => {
		const before = "- [ ] Task https://example.com/page#section [[Somewhere#A heading]]";
		expect(editTaskField(before, "tags", ["#work"])).toBe(
			"- [ ] Task https://example.com/page#section [[Somewhere#A heading]] #work",
		);
	});

	it("removes every tag and the one space each carried, leaving no double space", () => {
		expect(editTaskField("- [ ] Task #work", "tags", [])).toBe("- [ ] Task");
		expect(editTaskField("- [ ] Task #a #b #c", "tags", [])).toBe("- [ ] Task");
	});

	it("does nothing when the set already matches, in a different order", () => {
		const before = "- [ ] Task #a #b";
		expect(editTaskField(before, "tags", ["#b", "#a"])).toBe(before);
	});

	it("round-trips over a table of lines each carrying every other field but the description", () => {
		const table = [
			"- [ ] Task ⏳ 2026-01-05 📅 2026-02-06 ⏫ #a #b %% eid:m1abc2de %%",
			"\t* [x] Two tabs, one tag, no comment #solo",
			"1) [/] Ordered marker, no tags, a comment %% note:kept %%",
			"- [-] Cancelled, three tags #a #b/nested #c",
			"- [>] Forwarded, priority and due only 🔽 📅 2026-03-01",
		];
		for (const raw of table) {
			const was = parsed(raw);
			const value = ["#new-one", ...[...was.tags].reverse()];
			const after = parsed(editTaskField(raw, "tags", value));

			expect(new Set(after.tags)).toEqual(new Set(value));
			expect(after.checkbox).toBe(was.checkbox);
			expect(after.indent).toBe(was.indent);
			expect(after.marker).toBe(was.marker);
			expect(after.scheduled).toBe(was.scheduled);
			expect(after.due).toBe(was.due);
			expect(after.priority).toBe(was.priority);
			expect(after.comments).toEqual(was.comments);
		}
	});
});

describe("editTaskField with the repeat rule", () => {
	it("adds a rule where a new date goes, before a trailing comment, and asserts every byte", () => {
		expect(editTaskField("- [ ] Vattna %% eid:m1abc2de %%", "repeat", "every week")).toBe(
			"- [ ] Vattna 🔁 every week %% eid:m1abc2de %%",
		);
		expect(editTaskField("- [ ] Vattna ⏳ 2026-11-03  ", "repeat", "every week")).toBe(
			"- [ ] Vattna ⏳ 2026-11-03 🔁 every week  ",
		);
		// The same point a date is added at, on the same line.
		const line = "- [ ] Vattna #hem %% eid:m1abc2de %%";
		expect(editTaskField(line, "repeat", "every week")).toBe(
			editTaskField(line, "due", "2026-11-03").replace("📅 2026-11-03", "🔁 every week"),
		);
	});

	it("replaces the text of an existing rule in place and moves nothing else", () => {
		const before = "\t- [ ] Vattna  🔁 every week ⏳ 2026-11-03 #hem %% note %%";
		const after = editTaskField(before, "repeat", "every 3 days when done");
		expect(after).toBe("\t- [ ] Vattna  🔁 every 3 days when done ⏳ 2026-11-03 #hem %% note %%");
		expect(soleDifference(before, after)).toEqual({
			removed: "week",
			inserted: "3 days when done",
		});
	});

	it("replaces a rule that is last, leaving the blanks after it where they were", () => {
		expect(editTaskField("- [ ] Vattna 🔁 every week  ", "repeat", "every day")).toBe(
			"- [ ] Vattna 🔁 every day  ",
		);
	});

	it("removes the rule and the blank that separated it, bytes asserted", () => {
		expect(editTaskField("- [ ] Vattna 🔁 every week ⏳ 2026-11-03", "repeat", null)).toBe(
			"- [ ] Vattna ⏳ 2026-11-03",
		);
		expect(editTaskField("- [ ] Vattna ⏳ 2026-11-03 🔁 every week #hem", "repeat", null)).toBe(
			"- [ ] Vattna ⏳ 2026-11-03 #hem",
		);
		expect(editTaskField("- [ ] Vattna 🔁 every week %% note %%", "repeat", null)).toBe(
			"- [ ] Vattna %% note %%",
		);
		expect(parsed(editTaskField("- [ ] Vattna 🔁 every week", "repeat", null)).repeat).toBeNull();
	});

	it("does nothing when asked to remove a rule that is not there", () => {
		const before = "- [ ] Vattna ⏳ 2026-11-03";
		expect(editTaskField(before, "repeat", null)).toBe(before);
	});

	it("refuses text that would not read back as the rule it is", () => {
		const message = /a repeat rule is letters, digits, commas and spaces/u;
		for (const text of ["", " every week", "every week ", "every week ⏳", "a\nb", "#hem", "every week %%"]) {
			expect(() => editTaskField("- [ ] Vattna", "repeat", text)).toThrow(message);
			expect(() => editTaskField("- [ ] Vattna 🔁 every day", "repeat", text)).toThrow(message);
		}
	});

	it.each(["", "\r"])(
		"replaces, removes and restores a rule on a line ending in %j, asserting the bytes",
		(end) => {
			const before = `- [ ] Vattna 🔁 every week ⏳ 2026-11-03${end}`;
			const replaced = editTaskField(before, "repeat", "every 3 days when done");
			expect(replaced).toBe(`- [ ] Vattna 🔁 every 3 days when done ⏳ 2026-11-03${end}`);
			expect(editTaskField(replaced, "repeat", "every week")).toBe(before);

			expect(editTaskField(before, "repeat", null)).toBe(`- [ ] Vattna ⏳ 2026-11-03${end}`);

			const last = `- [ ] Vattna ⏳ 2026-11-03 🔁 every week${end}`;
			expect(editTaskField(last, "repeat", null)).toBe(`- [ ] Vattna ⏳ 2026-11-03${end}`);
			expect(editTaskField(last, "repeat", "every day")).toBe(
				`- [ ] Vattna ⏳ 2026-11-03 🔁 every day${end}`,
			);
			expect(parsed(last).repeat).toBe("every week");
		},
	);

	it.each(["", "\r"])(
		"adds a rule exactly where a new date goes on a line ending in %j",
		(end) => {
			// Where that is, on a line with a bare carriage return at its end, is the
			// shared insertion point's answer: before the `\r`, as on a line without
			// one. This
			// test holds the rule to that one point rather than to a second opinion.
			const before = `- [ ] Vattna${end}`;
			const withDue = editTaskField(before, "due", "2026-11-03");
			expect(editTaskField(before, "repeat", "every week")).toBe(
				withDue.replace("\u{1F4C5} 2026-11-03", "\u{1F501} every week"),
			);
			expect(editTaskField(before, "repeat", "every week")).toBe(
				`- [ ] Vattna 🔁 every week${end}`,
			);
		},
	);

	it("reads back what it wrote, with every other field where it was", () => {
		const before = "- [ ] Vattna ⏳ 2026-11-03 #hem ⏫ %% note %%";
		const task = parsed(editTaskField(before, "repeat", "every month on the 1st"));
		expect(task.repeat).toBe("every month on the 1st");
		expect(task.scheduled).toBe("2026-11-03");
		expect(task.tags).toEqual(["#hem"]);
		expect(task.priority).toBe("high");
		expect(task.comments).toEqual(["%% note %%"]);
	});
});

describe("every other edit on a line carrying a repeat rule", () => {
	const rule = "🔁 every week";

	it("changes the checkbox and no other byte", () => {
		const before = `- [ ] Vattna ${rule} ⏳ 2026-11-03 %% note %%`;
		expect(editTaskField(before, "checkbox", "x")).toBe(
			`- [x] Vattna ${rule} ⏳ 2026-11-03 %% note %%`,
		);
	});

	it("replaces, adds and removes a scheduled date without moving the rule's bytes", () => {
		expect(editTaskField(`- [ ] Vattna ${rule} ⏳ 2026-11-03`, "scheduled", "2026-11-10")).toBe(
			`- [ ] Vattna ${rule} ⏳ 2026-11-10`,
		);
		expect(editTaskField(`- [ ] Vattna ${rule} %% note %%`, "scheduled", "2026-11-10")).toBe(
			`- [ ] Vattna ${rule} ⏳ 2026-11-10 %% note %%`,
		);
		expect(editTaskField(`- [ ] Vattna ⏳ 2026-11-03 ${rule}`, "scheduled", null)).toBe(
			`- [ ] Vattna ${rule}`,
		);
	});

	it("replaces, adds and removes a due date without moving the rule's bytes", () => {
		expect(editTaskField(`- [ ] Vattna ${rule} 📅 2026-11-03`, "due", "2026-11-10")).toBe(
			`- [ ] Vattna ${rule} 📅 2026-11-10`,
		);
		expect(editTaskField(`- [ ] Vattna ${rule}`, "due", "2026-11-10")).toBe(
			`- [ ] Vattna ${rule} 📅 2026-11-10`,
		);
		expect(editTaskField(`- [ ] Vattna 📅 2026-11-03 ${rule} #hem`, "due", null)).toBe(
			`- [ ] Vattna ${rule} #hem`,
		);
	});

	it("replaces, adds and removes a priority without moving the rule's bytes", () => {
		expect(editTaskField(`- [ ] Vattna ${rule} ⏫`, "priority", "lowest")).toBe(
			`- [ ] Vattna ${rule} ⏬`,
		);
		expect(editTaskField(`- [ ] Vattna ${rule} %% note %%`, "priority", "high")).toBe(
			`- [ ] Vattna ${rule} ⏫ %% note %%`,
		);
		expect(editTaskField(`- [ ] Vattna ⏫ ${rule}`, "priority", null)).toBe(`- [ ] Vattna ${rule}`);
	});

	it("adds and removes tags without moving the rule's bytes", () => {
		expect(editTaskField(`- [ ] Vattna ${rule}`, "tags", ["#hem"])).toBe(`- [ ] Vattna ${rule} #hem`);
		expect(editTaskField(`- [ ] Vattna #hem ${rule} #ute`, "tags", ["#ute"])).toBe(
			`- [ ] Vattna ${rule} #ute`,
		);
	});

	it("adds, replaces and removes a feature's comment without moving the rule's bytes", () => {
		expect(setComment(`- [ ] Vattna ${rule}`, "eid", "m1abc2de")).toBe(
			`- [ ] Vattna ${rule} %% eid:m1abc2de %%`,
		);
		expect(setComment(`- [ ] Vattna ${rule} %% eid:m1abc2de %%`, "eid", "zz")).toBe(
			`- [ ] Vattna ${rule} %% eid:zz %%`,
		);
		expect(setComment(`- [ ] Vattna ${rule} %% eid:m1abc2de %%`, "eid", null)).toBe(
			`- [ ] Vattna ${rule}`,
		);
	});
});

describe("repeatStampText", () => {
	it("writes the rule's own emoji, one space, and the text", () => {
		expect(repeatStampText("every week")).toBe("\u{1F501} every week");
		expect(repeatStampText("every month on the 1st and 15th")).toBe(
			"\u{1F501} every month on the 1st and 15th",
		);
	});

	it("is what editTaskField adds a missing rule as", () => {
		const before = "- [ ] Task";
		expect(editTaskField(before, "repeat", "every 3 days")).toBe(
			`${before} ${repeatStampText("every 3 days")}`,
		);
	});

	it("is the only place in shipped code that holds the rule's emoji", () => {
		// The emoji spelled three ways a feature might hold it: itself, its
		// escape, and its two UTF-16 halves. Comments are dropped, since prose
		// about the emoji is not a string a feature writes.
		const spellings = new RegExp(
			["\u{1F501}", String.raw`\\u\{1F501\}`, String.raw`\\uD83D\\uDD01`].join("|"),
			"iu",
		);
		const holders = shippedSources()
			.filter(({ source }) => spellings.test(withoutComments(source)))
			.map(({ path }) => path);
		expect(holders).toEqual(["src/core/taskLine.ts"]);
	});

	it("is the text the reader finds a rule after", () => {
		expect(parsed(`- [ ] Task ${repeatStampText("every week")}`).repeat).toBe("every week");
	});

	it("refuses text that would not read back, with the message editTaskField throws", () => {
		expect(() => repeatStampText("every week ⏳")).toThrow(
			'a repeat rule is letters, digits, commas and spaces, not "every week ⏳"',
		);
	});
});

describe("setComment", () => {
	it("adds a comment where none exists, before trailing whitespace and after every visible field", () => {
		expect(setComment("- [ ] Task #work  ", "task-consistency", "abc123 9f2e")).toBe(
			"- [ ] Task #work %% task-consistency:abc123 9f2e %%  ",
		);
	});

	it("replaces an existing comment's inside and leaves the rest of the line byte-identical", () => {
		const before = "- [ ] Task %% task-consistency:abc123 9f2e %% #work";
		const after = setComment(before, "task-consistency", "abc123 aa11");
		expect(after).toBe("- [ ] Task %% task-consistency:abc123 aa11 %% #work");
		expect(soleDifference(before, after)).toEqual({ removed: "9f2e", inserted: "aa11" });
	});

	it("leaves a different feature's comment untouched by add, replace and remove", () => {
		const withOther = "- [ ] Task %% other-feature:xyz %%";

		expect(setComment(withOther, "task-consistency", "abc123 9f2e")).toBe(
			"- [ ] Task %% task-consistency:abc123 9f2e %% %% other-feature:xyz %%",
		);

		const withBoth = "- [ ] Task %% task-consistency:abc123 9f2e %% %% other-feature:xyz %%";
		expect(setComment(withBoth, "task-consistency", "abc123 aa11")).toBe(
			"- [ ] Task %% task-consistency:abc123 aa11 %% %% other-feature:xyz %%",
		);
		expect(setComment(withBoth, "task-consistency", null)).toBe(
			"- [ ] Task %% other-feature:xyz %%",
		);
	});

	it("removes the comment and its one leading space; a line without one is returned unchanged", () => {
		expect(setComment("- [ ] Task %% task-consistency:abc123 9f2e %%", "task-consistency", null)).toBe(
			"- [ ] Task",
		);
		const before = "- [ ] Task #work";
		expect(setComment(before, "task-consistency", null)).toBe(before);
	});

	it("round-trips through parseTaskLine, reading the new comment and leaving every other field alone", () => {
		const before = "- [ ] Task ⏳ 2026-01-05 #work";
		const was = parsed(before);
		const after = parsed(setComment(before, "task-consistency", "abc123 9f2e"));

		expect(after.comments).toEqual(["%% task-consistency:abc123 9f2e %%"]);
		expect(after.checkbox).toBe(was.checkbox);
		expect(after.scheduled).toBe(was.scheduled);
		expect(after.due).toBe(was.due);
		expect(after.priority).toBe(was.priority);
		expect(after.tags).toEqual(was.tags);
		expect(after.description.startsWith("Task ⏳ 2026-01-05 #work")).toBe(true);
	});

	it("refuses content carrying %%, naming the content in the message", () => {
		expect(() => setComment("- [ ] Task", "task-consistency", "abc %% def")).toThrow(
			'a comment cannot contain "%%": "abc %% def"',
		);
	});

	it("refuses to set a comment on a line that is not a task line", () => {
		expect(() => setComment("not a task", "task-consistency", "x")).toThrow(/not a task line/u);
	});

	it("first wins when two comments share one id", () => {
		const before = "- [ ] Task %% task-consistency:first x %% %% task-consistency:second y %%";
		expect(setComment(before, "task-consistency", "first z")).toBe(
			"- [ ] Task %% task-consistency:first z %% %% task-consistency:second y %%",
		);
	});
});

describe("dateStampText", () => {
	it("writes each kind's own emoji, one space, and the date", () => {
		expect(dateStampText("scheduled", "2026-09-04")).toBe("⏳ 2026-09-04");
		expect(dateStampText("due", "2026-09-04")).toBe("\u{1F4C5} 2026-09-04");
	});

	it("is what editTaskField adds a missing field as", () => {
		const before = "- [ ] Task";
		expect(editTaskField(before, "scheduled", "2026-09-04")).toBe(
			`${before} ${dateStampText("scheduled", "2026-09-04")}`,
		);
	});

	it("refuses a date that is not YYYY-MM-DD, with the message editTaskField throws", () => {
		expect(() => dateStampText("scheduled", "2026-3-5")).toThrow(
			'a date must be written YYYY-MM-DD, not "2026-3-5"',
		);
	});
});

describe("the corpus round trip", () => {
	it("has cases to run", () => {
		expect(corpus.length).toBeGreaterThan(30);
	});

	it("parses every line in the corpus", () => {
		for (const raw of corpus) expect(parseTaskLine(raw)).not.toBeNull();
	});

	it("changes the checkbox and changes it back, byte for byte", () => {
		for (const raw of corpus) {
			const was = parsed(raw).checkbox;
			const ticked = editTaskField(raw, "checkbox", "x");

			// One character in place: the line cannot change length, and the one
			// position that may differ is the box itself.
			expect(ticked.length).toBe(raw.length);
			const moved = [...raw].map((_, at) => at).filter((at) => raw[at] !== ticked[at]);
			expect(moved.length).toBe(was === "x" ? 0 : 1);
			if (moved.length === 1) expect(ticked[moved[0] as number]).toBe("x");

			expect(editTaskField(ticked, "checkbox", was)).toBe(raw);
		}
	});

	it("changes each field and changes it back, byte for byte", () => {
		for (const raw of corpus) {
			const was = parsed(raw);

			expect(editTaskField(editTaskField(raw, "scheduled", "2026-11-30"), "scheduled", was.scheduled)).toBe(raw);
			expect(editTaskField(editTaskField(raw, "due", "2026-11-30"), "due", was.due)).toBe(raw);
			expect(editTaskField(editTaskField(raw, "priority", "lowest"), "priority", was.priority)).toBe(raw);
			expect(editTaskField(editTaskField(raw, "repeat", "every day"), "repeat", was.repeat)).toBe(raw);
		}
	});

	it("carries every other field untouched when one of them changes", () => {
		for (const raw of corpus) {
			const was = parsed(raw);
			const after = parsed(editTaskField(raw, "scheduled", "2026-11-30"));

			expect(after.checkbox).toBe(was.checkbox);
			expect(after.indent).toBe(was.indent);
			expect(after.marker).toBe(was.marker);
			expect(after.due).toBe(was.due);
			expect(after.priority).toBe(was.priority);
			expect(after.tags).toEqual(was.tags);
			expect(after.repeat).toBe(was.repeat);
			expect(after.comments).toEqual(was.comments);
		}
	});

	it("carries every other field untouched when the repeat rule changes", () => {
		for (const raw of corpus) {
			const was = parsed(raw);
			const after = parsed(editTaskField(raw, "repeat", "every 2 weeks"));

			expect(after.repeat).toBe("every 2 weeks");
			expect(after.checkbox).toBe(was.checkbox);
			expect(after.indent).toBe(was.indent);
			expect(after.marker).toBe(was.marker);
			expect(after.scheduled).toBe(was.scheduled);
			expect(after.due).toBe(was.due);
			expect(after.priority).toBe(was.priority);
			expect(after.tags).toEqual(was.tags);
			expect(after.comments).toEqual(was.comments);
		}
	});

	it("leaves the rule's bytes alone through a checkbox edit, on every line that has one", () => {
		const withRule = corpus.filter((raw) => parsed(raw).repeat !== null);
		expect(withRule.length).toBeGreaterThanOrEqual(5);
		for (const raw of withRule) {
			const after = editTaskField(raw, "checkbox", "x");
			expect(parsed(after).repeat).toBe(parsed(raw).repeat);
			expect(after.length).toBe(raw.length);
		}
	});

	it("never writes a line break into a checkbox, and reads back what went in", () => {
		for (const raw of corpus) {
			for (const character of [" ", "x", "/", "-", ">", "<"]) {
				const after = editTaskField(raw, "checkbox", character);
				expect(after).not.toMatch(/[\r\n]/u);
				expect(parsed(after).checkbox).toBe(character);
			}
		}
	});

	it("leaves a field the plugin has never heard of exactly where it was", () => {
		const raw = "- [ ] Task 🪐 rings ✅ 2026-01-07 🔁 every week ⏳ 2026-01-05";
		const after = editTaskField(raw, "checkbox", "x");
		expect(after).toBe("- [x] Task 🪐 rings ✅ 2026-01-07 🔁 every week ⏳ 2026-01-05");
	});
});

// A checkbox character is whatever the person's theme uses, and several
// popular Obsidian themes ship emoji ones. An emoji is two UTF-16 units, so
// any index counted back from the end of the head by a constant lands inside
// the character rather than in front of it.
describe("a checkbox character outside the Basic Multilingual Plane", () => {
	it("is read whole rather than as its second half", () => {
		expect(parsed("- [\u{1F600}] do it").checkbox).toBe("\u{1F600}");
	});

	it("is an ordinary open task, as the module promises", () => {
		expect(parsed("- [\u{1F600}] do it").meaning).toBe("open");
	});

	it("leaves the rest of the line identical when it is replaced", () => {
		expect(editTaskField("- [\u{1F600}] do it", "checkbox", "x")).toBe("- [x] do it");
	});

	it("can be written as well as read", () => {
		expect(editTaskField("- [ ] do it", "checkbox", "\u{1F600}")).toBe("- [\u{1F600}] do it");
	});

	it("does not move the fields that follow it", () => {
		const raw = "- [\u{1F600}] do it \u{23F3} 2026-01-05 \u{1F4C5} 2026-01-07";
		const task = parsed(raw);
		expect(task.scheduled).toBe("2026-01-05");
		expect(task.due).toBe("2026-01-07");
		expect(editTaskField(raw, "due", "2026-09-08")).toBe(
			"- [\u{1F600}] do it \u{23F3} 2026-01-05 \u{1F4C5} 2026-09-08",
		);
	});
});

/**
 * What may sit between the brackets, stated once.
 *
 * The settings screen has to tell a person why a symbol was refused, so the
 * sentences live there; the condition lives here, and `symbolRefusal` asks it.
 * `checkboxCyclingSequences.test.ts` is where the two are held to the same
 * answer, character for character.
 */
describe("mayBeCheckbox", () => {
	it("accepts one character, whatever it is, a tab and an emoji included", () => {
		for (const character of ["x", " ", "\t", "[", "|", "/", "\u{1F525}"]) {
			expect([character, mayBeCheckbox(character)]).toEqual([character, true]);
		}
	});

	it("refuses the bracket that would close the brackets", () => {
		expect(mayBeCheckbox("]")).toBe(false);
	});

	it("refuses a line break, which would leave two half lines", () => {
		expect(mayBeCheckbox("\n")).toBe(false);
		expect(mayBeCheckbox("\r")).toBe(false);
	});

	it("refuses nothing at all, and more than one character", () => {
		expect(mayBeCheckbox("")).toBe(false);
		expect(mayBeCheckbox("ab")).toBe(false);
		expect(mayBeCheckbox("\u{1F525}\u{1F525}")).toBe(false);
	});

	it("is what editTaskField throws by, with the message it always threw", () => {
		expect(() => editTaskField("- [ ] Task", "checkbox", "]")).toThrow(
			'a checkbox is one character, other than "]" or a line break, not "]"',
		);
	});
});

/**
 * The one answer to what a surrogate pair is. `a 🔥 b` holds the
 * fire emoji as two units at 2 and 3, so 3 is the position that splits it.
 */
describe("splitsACharacter", () => {
	it("says so of the position between an emoji's two halves", () => {
		expect(splitsACharacter("a 🔥 b", 3)).toBe(true);
	});

	it("leaves both ends of that emoji alone", () => {
		expect(splitsACharacter("a 🔥 b", 2)).toBe(false);
		expect(splitsACharacter("a 🔥 b", 4)).toBe(false);
	});

	it("sees an emoji that opens the text, where the split is position one", () => {
		expect(splitsACharacter("🔥x", 1)).toBe(true);
		expect(splitsACharacter("🔥x", 0)).toBe(false);
		expect(splitsACharacter("🔥x", 2)).toBe(false);
	});

	it("says no anywhere in text of ordinary characters", () => {
		for (const at of [0, 1, 2, 3]) {
			expect([at, splitsACharacter("abc", at)]).toEqual([at, false]);
		}
	});

	it("says no at either edge, where one of the two units is missing", () => {
		expect(splitsACharacter("🔥", 0)).toBe(false);
		expect(splitsACharacter("🔥", 2)).toBe(false);
	});
});

/**
 * Where a checkbox would go on a line that is not a task line yet.
 *
 * The one feature that needs this used to state the marker set, the indentation
 * rule and the bracket rule again in three patterns of its own, and its bracket
 * pattern disagreed with the reader about what one character is. The answer is the
 * reader's now, out of the same fragments `TASK_HEAD` is built from.
 */
describe("checkboxSlot", () => {
	it("reads a bullet, and says where the brackets would go", () => {
		expect(checkboxSlot("- An ordinary bullet")).toEqual({ shape: "bullet", contentAt: 2 });
	});

	it("reads all three bullet markers, which is the set the reader accepts", () => {
		for (const marker of ["-", "*", "+"]) {
			expect(checkboxSlot(`${marker} words`).shape).toBe("bullet");
		}
	});

	it("counts the indentation and the whitespace after the marker into contentAt", () => {
		expect(checkboxSlot("  -   words")).toEqual({ shape: "bullet", contentAt: 6 });
		expect(checkboxSlot("\t-\twords")).toEqual({ shape: "bullet", contentAt: 3 });
	});

	it("reads a numbered item, in both spellings the reader accepts", () => {
		expect(checkboxSlot("1. words")).toEqual({ shape: "numbered", contentAt: 3 });
		expect(checkboxSlot("12) words")).toEqual({ shape: "numbered", contentAt: 4 });
	});

	it("wants whitespace after the marker before it calls a line an item at all", () => {
		expect(checkboxSlot("-words").shape).toBe("plain");
		expect(checkboxSlot("1.words").shape).toBe("plain");
	});

	it("reads a bullet whose content opens with one bracketed character and no space", () => {
		expect(checkboxSlot("- [x]text")).toEqual({ shape: "unspaced-bracket", contentAt: 2 });
	});

	it("counts that bracketed character as one code point, not as two code units", () => {
		// The divergence #343 was filed for: an emoji is two UTF-16 code units and
		// one code point, and the reader has always counted code points.
		expect(checkboxSlot("- [\u{1F525}]text").shape).toBe("unspaced-bracket");
	});

	it("reads two characters in brackets, and none, as an ordinary bullet", () => {
		expect(checkboxSlot("- [ab]text").shape).toBe("bullet");
		expect(checkboxSlot("- []text").shape).toBe("bullet");
	});

	it("reads anything else as plain, and says where its indentation ends", () => {
		expect(checkboxSlot("Just a sentence.")).toEqual({ shape: "plain", contentAt: 0 });
		expect(checkboxSlot("  Indented prose")).toEqual({ shape: "plain", contentAt: 2 });
		expect(checkboxSlot("")).toEqual({ shape: "plain", contentAt: 0 });
	});

	it("answers about a line the reader has already refused, which is the order to ask in", () => {
		// A bullet task line comes back `unspaced-bracket`, since its own checkbox
		// is a bracketed character opening its content. That is the documented
		// precondition rather than an answer about a task line: ask `parseTaskLine`
		// first, which every caller wants to do anyway.
		expect(parseTaskLine("- [x] Task")).not.toBeNull();
		expect(checkboxSlot("- [x] Task").shape).toBe("unspaced-bracket");
	});

	it("answers `numbered` for a numbered task line, where a bullet warns with the bracket", () => {
		// The docstring said every task line came back `unspaced-bracket`. A
		// numbered one does not: the numbered answer is returned before the bracket
		// test is reached, so it says nothing about a checkbox the line already
		// carries. The
		// bullet answer below doubles as a warning that the numbered answer cannot
		// give, so the caller's ordering is its only protection.
		expect(parseTaskLine("1. [ ] Task")).not.toBeNull();
		expect(checkboxSlot("1. [ ] Task")).toEqual({ shape: "numbered", contentAt: 3 });
		expect(checkboxSlot("1) [x] Task").shape).toBe("numbered");
		expect(checkboxSlot("- [x] Task").shape).toBe("unspaced-bracket");
	});
});

// The lookbehind ban is not here either. It is one of `afterTheFloor`'s
// patterns in `platform.test.ts`, run over every shipped module rather than
// over the two that happened to have a test file saying so.
describe("the module itself", () => {
	it("has a named case for every member of TaskField, and a default that throws", () => {
		const source = readFileSync(sourcePath, "utf8");

		const declaration = /export type TaskField =([^;]+);/u.exec(source);
		expect(declaration).not.toBeNull();
		const members = [...(declaration?.[1] ?? "").matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
		expect(members).toContain("checkbox");
		expect(members.length).toBeGreaterThanOrEqual(4);

		for (const member of members) expect(source).toContain(`case "${member}":`);

		// The default branch must reach a `never`-typed local, so that adding a
		// member to `TaskField` fails the type check here rather than writing a
		// priority emoji onto the line.
		expect(source).toMatch(/default: \{[^}]*: never = /u);
	});
});

describe("readComment", () => {
	it("returns the inside of the feature's own comment, without its padding", () => {
		expect(readComment("- [ ] Task %% task-consistency:abc123 9f2e %%", "task-consistency")).toBe("abc123 9f2e");
	});

	it("returns null when the line carries no comment of that id", () => {
		expect(readComment("- [ ] Task #work", "task-consistency")).toBeNull();
	});

	it("never returns a comment carrying another id, even one that shares the prefix", () => {
		expect(readComment("- [ ] Task %% other-feature:xyz %%", "task-consistency")).toBeNull();
		expect(readComment("- [ ] Task %% task-consistency-2:xyz %%", "task-consistency")).toBeNull();
	});

	it("returns the first when two comments share the id, and skips another id before it", () => {
		expect(
			readComment("- [ ] Task %% other:o %% %% task-consistency:first %% %% task-consistency:second %%", "task-consistency"),
		).toBe("first");
	});

	it("reads back exactly what setComment was given", () => {
		expect(readComment(setComment("- [ ] Task #work", "task-consistency", "abc123 9f2e"), "task-consistency")).toBe("abc123 9f2e");
	});

	it("is null for a line that is not a task line", () => {
		expect(readComment("Plain words %% task-consistency:abc %%", "task-consistency")).toBeNull();
	});
});

describe("the repeat rule ends at a word's end, never inside one", () => {
	it.each([
		"- [ ] Vattna 🔁 every week på söndag",
		"- [ ] Vattna 🔁 every week's",
		"- [ ] Vattna 🔁 every weekday på",
	])("reads no rule on %j", (line) => {
		expect(parsed(line).repeat).toBeNull();
	});

	it.each([
		["- [ ] Vattna 🔁 every week på söndag", "- [ ] Vattna 🔁 every week på söndag 🔁 every month"],
		["- [ ] Vattna 🔁 every week's", "- [ ] Vattna 🔁 every week's 🔁 every month"],
	])("a replace on %j eats no byte the person wrote", (line, expected) => {
		expect(editTaskField(line, "repeat", "every month")).toBe(expected);
		expect(editTaskField(line, "repeat", "every month").startsWith(line)).toBe(true);
	});

	it("keeps the Tasks plugin's trailing `!` in the rule's text", () => {
		expect(parsed("- [ ] Vattna 🔁 every week!").repeat).toBe("every week!");
		expect(parsed("- [ ] Vattna 🔁 every week! ⏳ 2026-11-03 #hem").repeat).toBe("every week!");
		expect(editTaskField("- [ ] Vattna 🔁 every week! ⏳ 2026-11-03", "repeat", "every month")).toBe(
			"- [ ] Vattna 🔁 every month ⏳ 2026-11-03",
		);
		expect(editTaskField("- [ ] Vattna 🔁 every week! ⏳ 2026-11-03", "repeat", null)).toBe(
			"- [ ] Vattna ⏳ 2026-11-03",
		);
		expect(parsed(`- [ ] Vattna ${repeatStampText("every week!")}`).repeat).toBe("every week!");
	});

	it.each(["", "\r", "  ", "  \r"])("still ends a rule at a line end written as %j", (end) => {
		expect(parsed(`- [ ] Vattna 🔁 every week${end}`).repeat).toBe("every week");
		expect(parsed(`- [ ] Vattna 🔁 every week%% note %%${end}`).repeat).toBe("every week");
	});

	it("still ends a rule at a tag, a comment and each date sign that follows a blank", () => {
		for (const after of ["#hem", "%% note %%", "⏳ 2026-11-03", "📅 2026-11-03", "⏫"]) {
			expect(parsed(`- [ ] Vattna 🔁 every week ${after}`).repeat).toBe("every week");
		}
	});
});

describe("a bare repeat sign is the rule's stamp with an empty value", () => {
	it.each([
		["- [ ] Vattna 🔁", "- [ ] Vattna 🔁 every week"],
		["- [ ] Vattna 🔁\r", "- [ ] Vattna 🔁 every week\r"],
		["- [ ] Vattna 🔁  ", "- [ ] Vattna 🔁 every week  "],
		["- [ ] Vattna 🔁 ⏳ 2026-11-03", "- [ ] Vattna 🔁 every week ⏳ 2026-11-03"],
		["- [ ] Vattna 🔁 #hem %% note %%", "- [ ] Vattna 🔁 every week #hem %% note %%"],
		["- [ ] Vattna 🔁\u{FE0F}", "- [ ] Vattna 🔁\u{FE0F} every week"],
	])("setting a rule on %j fills the sign, asserting the bytes", (line, expected) => {
		expect(editTaskField(line, "repeat", "every week")).toBe(expected);
		expect(parsed(expected).repeat).toBe("every week");
	});

	it.each([
		["- [ ] Vattna 🔁", "- [ ] Vattna"],
		["- [ ] Vattna 🔁\r", "- [ ] Vattna\r"],
		["- [ ] Vattna 🔁 ⏳ 2026-11-03", "- [ ] Vattna ⏳ 2026-11-03"],
		["- [ ] Vattna ⏳ 2026-11-03 🔁 #hem", "- [ ] Vattna ⏳ 2026-11-03 #hem"],
	])("removing the rule from %j takes the bare sign and its blank", (line, expected) => {
		expect(editTaskField(line, "repeat", null)).toBe(expected);
	});

	it("still reads no rule from a bare sign, and does not fill a sign inside a comment", () => {
		expect(parsed("- [ ] Vattna 🔁").repeat).toBeNull();
		expect(editTaskField("- [ ] Vattna %% 🔁 %%", "repeat", "every week")).toBe(
			"- [ ] Vattna 🔁 every week %% 🔁 %%",
		);
	});
});

describe("a repeat sign whose rule the reader did not capture", () => {
	it.each([
		["- [ ] Vattna 🔁 varje måndag ⏳ 2026-09-22", "varje måndag"],
		["- [ ] Vattna 🔁 varje måndag", "varje måndag"],
		["- [ ] Vattna 🔁 varje måndag\r", "varje måndag"],
		["- [ ] Vattna 🔁 varje måndag #hem %% note %%", "varje måndag #hem"],
		["- [ ] Vattna 🔁\u{FE0F} på söndag 📅 2026-09-22", "på söndag"],
		["- [ ] Vattna 🔁 every week på söndag", "every week på söndag"],
		["- [ ] Vattna 🔁", ""],
		["- [ ] Vattna 🔁\r", ""],
		["- [ ] Vattna 🔁 ⏳ 2026-09-22", ""],
	])("answers what follows the sign on %j", (line, expected) => {
		expect(parsed(line).repeat).toBeNull();
		expect(uncapturedRepeat(parsed(line))).toBe(expected);
	});

	it("answers null for a captured rule, a line with no sign, and a sign inside a comment", () => {
		// If the sign were looked for inside comments, the third would answer "";
		// if a captured rule answered too, the first two would be reported twice.
		expect(uncapturedRepeat(parsed("- [ ] Vattna 🔁 every week ⏳ 2026-09-22"))).toBeNull();
		expect(uncapturedRepeat(parsed("- [ ] Städa 🔁 every weekday please"))).toBeNull();
		expect(uncapturedRepeat(parsed("- [ ] Vattna %% 🔁 varje måndag %%"))).toBeNull();
		expect(uncapturedRepeat(parsed("- [ ] Vattna ⏳ 2026-09-22 #hem"))).toBeNull();
	});

	it("quotes the sign with what followed it, unchecked, and the sign alone for nothing", () => {
		expect(repeatQuote("varje måndag")).toBe("🔁 varje måndag");
		expect(repeatQuote("every weekday please")).toBe("🔁 every weekday please");
		expect(repeatQuote("")).toBe("🔁");
	});
});

describe("a field is added before a trailing line ending, whichever field it is", () => {
	it.each(["", "\r"])("adds each field before the end of a line ending in %j", (end) => {
		const base = `- [ ] Vattna${end}`;
		expect(editTaskField(base, "scheduled", "2026-11-03")).toBe(`- [ ] Vattna ⏳ 2026-11-03${end}`);
		expect(editTaskField(base, "due", "2026-11-03")).toBe(`- [ ] Vattna 📅 2026-11-03${end}`);
		expect(editTaskField(base, "priority", "high")).toBe(`- [ ] Vattna ⏫${end}`);
		expect(editTaskField(base, "tags", ["#hem"])).toBe(`- [ ] Vattna #hem${end}`);
		expect(editTaskField(base, "repeat", "every week")).toBe(`- [ ] Vattna 🔁 every week${end}`);
		expect(setComment(base, "x", "y")).toBe(`- [ ] Vattna %% x:y %%${end}`);
	});

	it.each(["", "\r"])("adds before trailing blanks and a trailing comment on a line ending in %j", (end) => {
		expect(editTaskField(`- [ ] Vattna  \t${end}`, "due", "2026-11-03")).toBe(
			`- [ ] Vattna 📅 2026-11-03  \t${end}`,
		);
		expect(editTaskField(`- [ ] Vattna %% note %%${end}`, "due", "2026-11-03")).toBe(
			`- [ ] Vattna 📅 2026-11-03 %% note %%${end}`,
		);
	});

	it.each(["", "\r"])("undoes an added field to the exact bytes on a line ending in %j", (end) => {
		const base = `- [ ] Vattna${end}`;
		expect(editTaskField(editTaskField(base, "due", "2026-11-03"), "due", null)).toBe(base);
		expect(editTaskField(editTaskField(base, "tags", ["#hem"]), "tags", [])).toBe(base);
		expect(editTaskField(editTaskField(base, "repeat", "every week"), "repeat", null)).toBe(base);
	});

	it("adds a field to a task whose line is only a checkbox and a line ending", () => {
		expect(editTaskField("- [ ]\r", "due", "2026-11-03")).toBe("- [ ] 📅 2026-11-03\r");
	});
});
