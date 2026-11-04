/**
 * The core's reader of person marks.
 * Every name below is invented. Each case is one that reads differently if the rule is wrong.
 */

import { describe, expect, it } from "vitest";
import { personMarksOnLine } from "../core/personMarks";

/** The people a line names, in order. */
function people(line: string): string[] {
	return personMarksOnLine(line).map((mark) => mark.person);
}

describe("personMarksOnLine: what is a mark", () => {
	it.each([
		["at the start of the line", "@[[Mikael Åkerbacke]] to send the draft", ["Mikael Åkerbacke"]],
		["mid-sentence", "Waiting for @[[Mikael Åkerbacke]] to send the draft", ["Mikael Åkerbacke"]],
		["at the end of the line", "Send the draft to @[[Mikael Åkerbacke]]", ["Mikael Åkerbacke"]],
		["on a task line, under its checkbox", "- [ ] Draft @[[Mikael Åkerbacke]] ⏳ 2026-03-02", ["Mikael Åkerbacke"]],
		[
			"twice, two people in the order written",
			"- [ ] Budget @[[Mikael Åkerbacke]] and @[[Ines Ingdal]]",
			["Mikael Åkerbacke", "Ines Ingdal"],
		],
		["with an alias: the person is the path, not the alias", "- [ ] Draft @[[Mikael Åkerbacke|Mikael]]", ["Mikael Åkerbacke"]],
		["with a heading: the person is the path without it", "- [ ] Draft @[[Mikael#Notes]]", ["Mikael"]],
		["with a block reference: the person is the path without it", "- [ ] Draft @[[Mikael#^abc123]]", ["Mikael"]],
		["with a heading and an alias", "- [ ] Draft @[[Mikael#Notes|Mikael]]", ["Mikael"]],
		["in a folder: the path as written", "- [ ] Draft @[[People/Mikael Åkerbacke]]", ["People/Mikael Åkerbacke"]],
		["with spaces inside the brackets, trimmed", "- [ ] Draft @[[ Mikael ]]", ["Mikael"]],
		["the same person twice, once per mark", "- [ ] Ask @[[Mikael]], then @[[Mikael]] again", ["Mikael", "Mikael"]],
		["on a line ending in a carriage return", "- [ ] Draft @[[Mikael]]\r", ["Mikael"]],
	])("reads a mark %s", (_name, line, expected) => {
		expect(people(line)).toEqual(expected);
	});

	it.each([
		["a bare @name", "- [ ] Draft @mikael"],
		["an email address", "- [ ] Mail mikael@example.com"],
		["@ before a markdown link", "- [ ] Draft @[Mikael](Mikael.md)"],
		["@ then a space, then a link", "- [ ] Draft @ [[Mikael]]"],
		["a link with no @", "- [ ] Draft [[Mikael]]"],
		["an embed after the @", "- [ ] Draft @![[Mikael]]"],
		["an embed with no @", "- [ ] Draft ![[Mikael]]"],
		["@ alone at the end", "- [ ] Draft @"],
		["@ and an unclosed link", "- [ ] Draft @[[Mikael"],
		["a link on a line that is only the link", "[[Mikael]]"],
		["a mark inside a comment", "- [ ] Draft %% @[[Mikael]] %%"],
		["a link whose @ stands in a comment before it", "- [ ] Draft %% a @ %%[[Mikael]]"],
	])("reads no mark in %s", (_name, line) => {
		expect(personMarksOnLine(line)).toEqual([]);
	});

	it("reads the mark outside a comment and not the one inside it", () => {
		expect(people("- [ ] Draft @[[Mikael]] %% asked @[[Ines Ingdal]] %%")).toEqual(["Mikael"]);
	});

	it("reads a mark beside an ordinary link, and not the link", () => {
		expect(people("- [ ] Draft [[Garden shed]] @[[Mikael]]")).toEqual(["Mikael"]);
	});

	it("reads no marks on an empty line", () => {
		expect(personMarksOnLine("")).toEqual([]);
	});
});

describe("personMarksOnLine: where a mark sits", () => {
	it("starts at the @ and ends one past the closing brackets", () => {
		const line = "Waiting for @[[Mikael Åkerbacke|Mikael]] today";
		const [mark] = personMarksOnLine(line);

		expect(mark).toEqual({ person: "Mikael Åkerbacke", start: 12, end: 40 });
		expect(line.slice(mark.start, mark.end)).toBe("@[[Mikael Åkerbacke|Mikael]]");
	});

	it("gives each of two marks its own span", () => {
		const line = "- [ ] Budget @[[Mikael]] and @[[Ines Ingdal]]";
		const marks = personMarksOnLine(line);

		expect(marks.map((mark) => line.slice(mark.start, mark.end))).toEqual(["@[[Mikael]]", "@[[Ines Ingdal]]"]);
		expect(marks[1].start).toBeGreaterThanOrEqual(marks[0].end);
	});

	it("measures from the original line when a comment comes before the mark", () => {
		const line = "- [ ] Draft %% a note of mine %% @[[Mikael]]";
		const [mark] = personMarksOnLine(line);

		// '- [ ] Draft ' is 12 characters, the comment 20 and the space after it 1; a comment-stripped line would put the mark at 12.
		expect(mark.start).toBe(33);
		expect(line.slice(mark.start, mark.end)).toBe("@[[Mikael]]");
	});

	it("measures in the line's own UTF-16 units after an emoji", () => {
		const line = "- [ ] 📞 @[[Mikael]]";
		const [mark] = personMarksOnLine(line);

		expect(line.slice(mark.start, mark.end)).toBe("@[[Mikael]]");
	});

	it("starts at index 0 for a mark at the start of the line", () => {
		expect(personMarksOnLine("@[[Mikael]] to answer")).toEqual([{ person: "Mikael", start: 0, end: 11 }]);
	});
});
