import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	clampLevel,
	closesFence,
	fencedLines,
	headingRange,
	isAtxHeading,
	openingFence,
} from "../core/markdownSections";
import type { Fence } from "../core/markdownSections";
import { shippedSources, testFolder, withoutComments } from "./sourceGuards";

describe("the section scanner's seam", () => {
	it("imports nothing from the settings or the layout", () => {
		// The point of the split: this module is given the note's
		// text and the heading to look for, so every test in this file drives it
		// with a string and a number rather than a layout object. Reading the
		// source is what stops the seam closing again unnoticed.
		const source = readFileSync(resolve(__dirname, "..", "core", "markdownSections.ts"), "utf8");
		const imports = source.match(/^\s*(?:import|export)\s.*from\s+["'](.+)["'];?$/gm) ?? [];
		expect(imports).toEqual([]);
	});
});

describe("headingRange", () => {
	const note = [
		"# Notes", // 0
		"", // 1
		"- a thought", // 2
		"", // 3
		"## Calendar", // 4
		"", // 5
		"| Time | Event |", // 6
		"", // 7
		"### Later", // 8
		"still the calendar", // 9
		"", // 10
		"# Something else", // 11
		"tail", // 12
	].join("\n");

	it("finds the heading, its body, and where the body ends", () => {
		expect(headingRange(note, "Calendar", 2)).toEqual({ heading: 4, start: 5, end: 11 });
	});

	it("lets a deeper heading stay inside the section and a shallower one end it", () => {
		expect(headingRange(note, "Notes", 1)).toEqual({ heading: 0, start: 1, end: 11 });
	});

	it("runs to the end of the note when no heading follows", () => {
		expect(headingRange("# Notes\nonly this\n", "Notes", 1)).toEqual({
			heading: 0,
			start: 1,
			end: 3,
		});
	});

	it("gives an empty body when the next heading follows straight away", () => {
		expect(headingRange("# Notes\n# Next\n", "Notes", 1)).toEqual({
			heading: 0,
			start: 1,
			end: 1,
		});
	});

	it("ignores capitals and blanks around the wanted text", () => {
		expect(headingRange("# NOTES\nbody", "  notes  ", 1)?.heading).toBe(0);
	});

	it("does not match a heading with anything appended", () => {
		expect(headingRange("# Notes for later\nbody", "Notes", 1)).toBeNull();
	});

	it("does not match the same words at another level", () => {
		expect(headingRange("## Notes\nbody", "Notes", 1)).toBeNull();
	});

	it("does not read hashes without a space as a heading", () => {
		expect(headingRange("#Notes\nbody", "Notes", 1)).toBeNull();
	});

	it("does not see a heading inside a fenced block, and such a fence does not end a section", () => {
		const fenced = ["# Notes", "```schema", "# Calendar", "```", "after"].join("\n");
		expect(headingRange(fenced, "Calendar", 1)).toBeNull();
		expect(headingRange(fenced, "Notes", 1)?.end).toBe(5);
	});

	it("survives Windows line endings", () => {
		expect(headingRange("# Notes\r\nbody\r\n# Next\r\n", "Notes", 1)).toEqual({
			heading: 0,
			start: 1,
			end: 2,
		});
	});

	it("says nothing rather than guessing when the heading is absent", () => {
		expect(headingRange("just prose", "Notes", 1)).toBeNull();
	});

	it("matches nothing when the wanted text is blank", () => {
		// A heading nobody could ever find again is not a heading.
		expect(headingRange("# Notes\nbody", "   ", 1)).toBeNull();
	});

	it("reads a level outside 1..6 the way a heading would be written", () => {
		expect(headingRange("# Notes\nbody", "Notes", 0)?.heading).toBe(0);
		expect(headingRange("###### Notes\nbody", "Notes", 9)?.heading).toBe(0);
	});

	it("keeps a carriage return that sits inside a heading's text", () => {
		// The level-and-text half of [#406]. The "\r" is part of the name here, not
		// line-ending noise, so the section is found by a name carrying it and by
		// nothing else. `.trim()` takes one off either end and leaves this one.
		expect(headingRange("# Heading\rmore\nbody", "Heading\rmore", 1)).toEqual({
			heading: 0,
			start: 1,
			end: 2,
		});
		expect(headingRange("# Heading\rmore\nbody", "Headingmore", 1)).toBeNull();
	});

	it("reports a heading's text with no carriage return left in it", () => {
		// [#407]'s other half: the rule now tolerates a carriage return after the
		// heading's text, and the text it reports must not carry it — a lookup is
		// by name, and a name with an invisible character in it matches nothing.
		//
		// The doubled carriage return is what makes this reachable from outside.
		// This scanner strips one trailing "\r" from every line before asking the
		// rule, so a plain Windows line never reaches the tolerance; a line whose
		// text really does end in a stray "\r" does.
		expect(headingRange("# Head\r\r\nbody", "Head", 1)).toEqual({
			heading: 0,
			start: 1,
			end: 2,
		});
	});
});

describe("clampLevel", () => {
	it("keeps a level a heading can actually be written at", () => {
		expect(clampLevel(3)).toBe(3);
		expect(clampLevel(0)).toBe(1);
		expect(clampLevel(9)).toBe(6);
		expect(clampLevel(2.4)).toBe(2);
		expect(clampLevel(Number.NaN)).toBe(1);
	});
});

/**
 * What a fenced block is, asked for a whole note at once.
 */
describe("fencedLines", () => {
	const note = [
		"Words above", //        0
		"```schema", //          1  opens
		"| Time | What |", //    2  inside
		"```", //                3  closes
		"Words below", //        4
	];

	it("counts the block's own delimiter lines as inside it", () => {
		expect(fencedLines(note)).toEqual([false, true, true, true, false]);
	});

	it("reads nothing above the line it is told to start at", () => {
		// How a caller skips a note's frontmatter: three backticks written inside
		// the header are a value there and open nothing over the words below.
		expect(fencedLines(["```", "still ordinary words"], 2)).toEqual([false, false]);
		expect(fencedLines(["```", "inside the block"], 0)).toEqual([true, true]);
	});

	it("does not let a backtick run close a tilde fence, or a shorter run close a longer", () => {
		expect(fencedLines(["~~~", "```", "~~~", "after"])).toEqual([true, true, true, false]);
		expect(fencedLines(["````", "```", "````", "after"])).toEqual([true, true, true, false]);
	});

	it("opens nothing on backticks carrying a backtick in what follows them", () => {
		expect(fencedLines(["``` `js", "words"])).toEqual([false, false]);
	});

	it("runs to the end of the note when the block is never closed", () => {
		expect(fencedLines(["```", "a", "b"])).toEqual([true, true, true]);
	});

	it("survives Windows line endings", () => {
		expect(fencedLines(["```\r", "a\r", "```\r", "b\r"])).toEqual([true, true, true, false]);
	});

	it("reads nothing at or past the line it is told to stop at", () => {
		// [#410]: the upper bound is exclusive, so a caller asking about lines 0 to
		// 2 gets the fence state of lines 0 and 1 and `false` for everything below.
		// The array keeps the note's own length, so the answers stay keyed by line
		// number and a caller reads them back by the index it asked about.
		expect(fencedLines(note, 0, 3)).toEqual([false, true, true, false, false]);
		expect(fencedLines(note, 0, 2)).toEqual([false, true, false, false, false]);
		expect(fencedLines(note, 0, 0)).toEqual([false, false, false, false, false]);
	});

	it("answers exactly as it does without a bound when the bound is the note's length", () => {
		// The bound is optional and adding it changed nothing for callers that do
		// not pass one. This pins the two answers to each other rather than
		// restating the expected array, and a bound past the end is not an error.
		expect(fencedLines(note, 0, note.length)).toEqual(fencedLines(note));
		expect(fencedLines(note, 0, 500)).toEqual(fencedLines(note));
	});

	it("still carries a fence opened above the bound into the lines below it", () => {
		// The bound cuts the tail off the scan, not the head. A block opened at
		// line 1 is still open at line 2, which is what a caller asking about a
		// range low down a note depends on.
		expect(fencedLines(["a", "```", "b", "c", "d"], 0, 4)).toEqual([
			false,
			true,
			true,
			true,
			false,
		]);
	});

	it("answers nothing at all for a note with no lines", () => {
		expect(fencedLines([])).toEqual([]);
	});
});

/** The yes-or-no half of the heading rule ([#346]). */
describe("isAtxHeading", () => {
	it("reads a heading at every level a heading has", () => {
		expect(isAtxHeading("# One")).toBe(true);
		expect(isAtxHeading("###### Six")).toBe(true);
		expect(isAtxHeading("   ## Indented up to three spaces")).toBe(true);
	});

	it("reads hashes with nothing after them as a heading, as the scanner does", () => {
		expect(isAtxHeading("##")).toBe(true);
		expect(isAtxHeading("#\tTabbed")).toBe(true);
	});

	it("reads hashes without a space, seven hashes and deep indentation as no heading", () => {
		expect(isAtxHeading("#hashtag")).toBe(false);
		expect(isAtxHeading("####### Seven")).toBe(false);
		expect(isAtxHeading("    # Four spaces in")).toBe(false);
		expect(isAtxHeading("words # hash")).toBe(false);
	});

	it("survives Windows line endings, as the fence scanner above it does", () => {
		// This is the direct-caller contract, not something a real note exercises
		// ([#489]): both of this rule's callers — `headingRange` below and the
		// checkbox feature's line classifier — strip one trailing "\r" from a
		// line before asking it, so a plain Windows line never reaches this
		// tolerance. The one line that does is a doubled "\r", and the
		// `headingRange` case above drives it. `fencedLines` has its own trailing
		// "\r" cases further down, for its own reason.
		expect(isAtxHeading("# Head\r")).toBe(true);
		expect(isAtxHeading("###### Six\r")).toBe(true);
	});

	it("reads a heading whose text carries a carriage return in the middle", () => {
		// [#406]: a note written with carriage returns alone, split on "\n", keeps
		// the "\r" inside the line, and so does a stray one pasted mid-line. Only a
		// trailing "\r" is stripped before the rule is asked, so this one reaches
		// it. CommonMark reads a bare "\r" as a line ending, which makes this a
		// heading followed by a line; recognising the heading is closer to that
		// than refusing it, and refusing it let a cycling press write a checkbox
		// into a heading.
		expect(isAtxHeading("# Heading\rmore")).toBe(true);
	});

	it("still refuses hashes with nothing but a carriage return after them", () => {
		// The one line where the carriage return is not trailing noise: nothing
		// separates it from the hashes, and the rule wants whitespace or the end
		// of the line there. `#` on its own is a heading and `#\r` is not, which is
		// the answer this rule gave before [#407] and still gives.
		expect(isAtxHeading("#\r")).toBe(false);
		expect(isAtxHeading("#")).toBe(true);
	});
});

/**
 * The fence rule itself, now that both halves are exported ([#412]).
 *
 * `fencedLines` above answers one boolean per line and throws the info string
 * away. A caller that needs the info string — the calendar-table reader, which
 * has to know which blocks the person marked `schema` — asks these two instead,
 * so the rule is stated once and read two ways. These cases pin the answers the
 * calendar reader used to compute for itself.
 */
describe("openingFence and closesFence", () => {
	it("reports the marker, the run length and the info string of an opening line", () => {
		expect(openingFence("```")).toEqual({ marker: "`", length: 3, info: "" });
		expect(openingFence("~~~~~")).toEqual({ marker: "~", length: 5, info: "" });
		expect(openingFence("   ```schema json  ")).toEqual({
			marker: "`",
			length: 3,
			info: "schema json",
		});
	});

	it("opens nothing on a line that is not a fence", () => {
		expect(openingFence("``")).toBeNull();
		expect(openingFence("~~")).toBeNull();
		expect(openingFence("    ```")).toBeNull();
		expect(openingFence("words ```")).toBeNull();
	});

	it("refuses a backtick in a backtick fence's info string, and allows it in a tilde's", () => {
		// The clause that keeps an inline code span written on a line of its own
		// from opening a block. It is applied inside the reader, so no caller
		// repeats it.
		expect(openingFence("``` `js")).toBeNull();
		expect(openingFence("~~~ `js")).toEqual({ marker: "~", length: 3, info: "`js" });
	});

	it("tells a tilde fence and a backtick fence apart", () => {
		const tilde = openingFence("~~~") as Fence;
		const backtick = openingFence("```") as Fence;
		expect(closesFence("```", tilde)).toBe(false);
		expect(closesFence("~~~", tilde)).toBe(true);
		expect(closesFence("~~~", backtick)).toBe(false);
		expect(closesFence("```", backtick)).toBe(true);
	});

	it("closes on a run at least as long as the opening one, and not on a shorter one", () => {
		const long = openingFence("`````") as Fence;
		expect(closesFence("````", long)).toBe(false);
		expect(closesFence("`````", long)).toBe(true);
		expect(closesFence("``````", long)).toBe(true);
	});

	it("closes on a run followed by blanks, and not on one followed by anything else", () => {
		// Spaces, tabs and both together are each pinned, because the class that
		// decides them is the one [#505] settled and it must not drift. A trailing
		// carriage return is the fourth accepted case and is pinned below, where
		// the reason it is accepted is written out.
		const fence = openingFence("```") as Fence;
		expect(closesFence("```", fence)).toBe(true);
		expect(closesFence("```   ", fence)).toBe(true);
		expect(closesFence("```\t\t", fence)).toBe(true);
		expect(closesFence("   ```  \t", fence)).toBe(true);
		expect(closesFence("```js", fence)).toBe(false);
		expect(closesFence("    ```", fence)).toBe(false);
	});

	it("leaves the block open on a blank after the run that is not a space or a tab", () => {
		// A deliberate difference from the calendar reader's pre-#412 `\s*`
		// reading, kept on purpose — ADR 0004
		// (docs/adr/0004-commonmark-decides-what-may-follow-a-closing-fence-run.md),
		// #505. Pinned as a set
		// so the class cannot drift again in either direction.
		const fence = openingFence("```") as Fence;
		const refused = {
			"non-breaking space U+00A0": "\u00A0",
			"ideographic space U+3000": "\u3000",
			"byte-order mark U+FEFF": "\uFEFF",
			"form feed U+000C": "\f",
			"vertical tab U+000B": "\v",
			"en quad U+2000": "\u2000",
			"hair space U+200A": "\u200A",
		};

		const closed = Object.entries(refused)
			.filter(([, blank]) => closesFence(`\`\`\`${blank}`, fence))
			.map(([name]) => name);
		expect(closed).toEqual([]);

		// And each of them really is whitespace, so the difference from the old
		// `\s*` rule is this class and nothing else.
		const notBlank = Object.entries(refused)
			.filter(([, blank]) => !/^\s$/u.test(blank))
			.map(([name]) => name);
		expect(notBlank).toEqual([]);
	});

	it("closes on a line still carrying the carriage return a Windows note leaves", () => {
		// CommonMark reads a bare carriage return as the end of a line, which is
		// the reading [#407] settled for the heading rule beside this one. This
		// case pins the rule itself. Nothing could reach it while `openingFence`
		// refused such a line, and the calendar reader's block walk reaches it now
		// that `openingFence` strips too — that caller
		// is driven end to end in `calendarTable.test.ts`, not here.
		const fence = openingFence("```") as Fence;
		expect(closesFence("```\r", fence)).toBe(true);
	});

	it("opens on a line still carrying the carriage return a Windows note leaves", () => {
		// The defect #503 was
		// filed for: a note synced or written on Windows and split on "\n" alone
		// hands this rule "```schema\r", and until this test it opened nothing at
		// all, so such a note had no schema block in it anywhere.
		expect(openingFence("```schema\r")).toEqual(openingFence("```schema"));
		expect(openingFence("```schema\r")).toEqual({ marker: "`", length: 3, info: "schema" });
		expect(openingFence("~~~schema\r")).toEqual({ marker: "~", length: 3, info: "schema" });
	});

	it("gives both rules the same answer about a trailing carriage return", () => {
		// Asserted as one property over both rules rather than as two cases, so
		// they cannot part again the way [#503] found them parted: they are handed
		// the same lines, so they have to answer the same about them. Every line
		// the cases above pin an answer for is run through here, opening lines and
		// closing lines alike, because either rule may be asked about either.
		const fence = openingFence("```") as Fence;
		const lines = [
			"```",
			"~~~~~",
			"   ```schema json  ",
			"``",
			"~~",
			"    ```",
			"words ```",
			"``` `js",
			"~~~ `js",
			"   ```  \t",
			"```js",
		];

		for (const line of lines) {
			expect(openingFence(`${line}\r`)).toEqual(openingFence(line));
			expect(closesFence(`${line}\r`, fence)).toBe(closesFence(line, fence));
		}
	});
});

/**
 * The rule has one home.
 *
 * The first feature written under `src/features/` carried a verbatim copy of
 * both fence scanners, and nothing failed while the two could drift. This is the
 * test that fails on the next copy. It reads every source that ships, the core
 * included, because the file a duplicate-rule guard most needs to read is the
 * one holding the original.
 *
 * **It does not read this folder, and the name below says so**. `shippedSources()`
 * skips `__tests__` whole, so the one home this guard keeps is a home in the
 * code that ships. A test may quote the fence run as a fixture and one already
 * does — `checkboxCyclingLineKind.test.ts` writes both runs out as the very
 * thing it asserts the feature does not state — and a run quoted in a test
 * cannot reach the plugin. Widening the guard to read this folder would need a
 * per-file exception list, which is the shape `shippedSources()` refuses in its
 * own doc, and which would go stale in silence.
 *
 * Comments are stripped first: this file and that one both write the run out in
 * prose, and a correct note about a rule must not fail the rule.
 */
describe("where a fenced block is decided", () => {
	it("is the shipped sources this list names, and no others", () => {
		const writers = shippedSources()
			.filter(({ source }) => /`\{3,\}|~\{3,\}/u.test(withoutComments(source)))
			.map(({ path }) => path);

		// One, and no exception. `calendarTable.ts` stated the rule a third time
		// until [#412]: it asks a wider question with it — which fenced blocks
		// carry a `schema` info string, and where the outermost of those end — and
		// was listed here rather than left out so that the day it was folded in
		// this test would say so by failing. That day came. It now asks
		// `openingFence` and `closesFence` for the rule and keeps only the wider
		// question, so the list has no exception left to go stale.
		expect(writers).toEqual(["src/core/markdownSections.ts"]);
	});

	it("the pattern the list above is built from is still written in this module", () => {
		// The guard above reads a list; this one proves the pattern it reads by is
		// the one actually written, so the list cannot go empty unnoticed.
		const source = readFileSync(resolve(__dirname, "..", "core", "markdownSections.ts"), "utf8");
		expect(withoutComments(source)).toMatch(/`\{3,\}/u);
	});

	// The reach the guard above actually has, pinned so the sentences describing
	// it cannot drift again ([#524]). It was described as the whole of `src` in
	// three places and is not. Deliberately narrow: `reason.test.ts` is the guard
	// in this repo that does read the tests folder, by walking it a second time, and this one does not follow it.
	it("reads the shipped sources only, so this folder is outside its reach", () => {
		const paths = shippedSources().map(({ path }) => path);

		expect(paths.some((path) => path.split("/").includes(testFolder))).toBe(false);
		expect(paths).toContain("src/core/markdownSections.ts");
	});
});
