import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { lineKind, lineKindRange, refuseUnknownRange } from "../features/checkboxCycling/lineKind";
import type { LeftAloneReason } from "../features/checkboxCycling/lineKind";
import { shippedSources, statesPattern, withoutComments } from "./sourceGuards";

/**
 * Which lines a cycling press may touch.
 *
 * Every case hands in a note as an array of lines and an index, and reads back
 * one answer. Nothing here builds an Obsidian stub: the whole point of the
 * function is that it decides on text alone.
 *
 * The note below is the one most cases are asked about. It is written out once
 * so that a case can say which line it means rather than restating a note, and
 * so that the fence, the frontmatter and the table sit above and below each
 * other the way they do in a real day's log.
 */
const NOTE = [
	"---", //                                        0  frontmatter opens
	"tags: [reading]", //                            1  inside frontmatter
	"- [ ] Not a task, it is a list of tags", //     2  inside frontmatter
	"---", //                                        3  frontmatter closes
	"", //                                           4  blank
	"## Meetings", //                                5  heading
	"```schema", //                                  6  fence opens
	"| Time | What |", //                            7  inside the fence
	"- [ ] Looks exactly like a task", //            8  inside the fence
	"```", //                                        9  fence closes
	"| Time | What |", //                           10  a table row of its own
	"> - [ ] Something somebody said", //           11  quoted
	"- [ ] Looks exactly like a task", //           12  the same text, and here it is one
	"- An ordinary bullet", //                      13  a list item
	"* A star bullet", //                           14  a list item
	"+ A plus bullet", //                           15  a list item
	"1. A numbered item", //                        16  numbered, no checkbox
	"1. [ ] A numbered task", //                    17  a task line
	"- [x]text", //                                 18  bracket with no space
	"Just a sentence.", //                          19  prose
	"  Indented prose", //                          20  prose, indented
	"---", //                                       21  not frontmatter down here
];

/** The reason line `index` of `NOTE` is left alone, or a note of what it was instead. */
function reasonAt(index: number): LeftAloneReason | string {
	const answer = lineKind(NOTE, index);
	return answer.kind === "left-alone" ? answer.reason : `not left alone: ${answer.kind}`;
}

describe("the lines a press leaves exactly as they are", () => {
	// One case each, which is what #323's second acceptance box asks for. Two of
	// these are recorded damage from the plugin this feature replaces: the table
	// row, which made a day's calendar table unreadable for good, and the
	// frontmatter entry, which breaks the note's own header.
	it("leaves a line inside a fenced block alone", () => {
		expect(reasonAt(7)).toBe("fenced");
	});

	it("leaves a line inside the frontmatter alone", () => {
		expect(reasonAt(1)).toBe("frontmatter");
	});

	it("leaves a table row alone", () => {
		expect(reasonAt(10)).toBe("table-row");
	});

	it("leaves a heading alone", () => {
		expect(reasonAt(5)).toBe("heading");
	});

	it("leaves a blockquote alone", () => {
		expect(reasonAt(11)).toBe("blockquote");
	});

	it("leaves a numbered item carrying no checkbox alone", () => {
		expect(reasonAt(16)).toBe("numbered-item");
	});

	it("leaves a bullet whose content opens with a bracketed character and no space", () => {
		// `- [x]text`. The core's reader wants whitespace or the end of the line
		// after the brackets, so this is not a checkbox — and the old plugin's
		// answer, `- [ ] [x]text`, is two checkboxes deep.
		expect(reasonAt(18)).toBe("unspaced-bracket");
	});

	it("counts a bracketed character outside the BMP as one character", () => {
		// `- [\u{1F525}]text`. The sequence model accepts one code point as a checkbox
		// symbol, emoji included, so this line is the ordinary near-miss: somebody
		// typed the symbol they cycle to and left out the space. The rule read
		// UTF-16 code units until [#343], an emoji is two of those, and the line
		// slipped through to gain a second checkbox.
		expect(reasonAtIn(["- [\u{1F525}]text"], 0)).toBe("unspaced-bracket");
	});

	it("leaves a horizontal rule alone, in every spelling of one", () => {
		// A press used to write `- [ ] ---` here, so the rule left the note and a
		// task nobody wrote joined the list. The spaced forms were worse: `- - -`
		// read as a bullet, and the checkbox went into the middle of the rule.
		const rules = ["---", "***", "___", "----", "- - -", "* * *", "*  *  *", "___ ___ ___"];

		for (const rule of rules) {
			expect(reasonAtIn(["", rule], 1)).toBe("thematic-break");
			expect(reasonAtIn([rule], 0)).toBe("thematic-break");
		}
	});

	it("leaves a setext underline alone, and so keeps the heading above it", () => {
		// `Notes` over `===` is a level-one heading. Once the underline reads
		// `- [ ] ===` the line above is ordinary words, so this rule reaches
		// further than the line it touches. `# Notes` was already refused.
		expect(reasonAtIn(["Notes", "==="], 1)).toBe("setext-underline");
		expect(reasonAtIn(["Notes", "---"], 1)).toBe("setext-underline");
	});

	it("counts the fence's own delimiter lines as inside it", () => {
		expect(reasonAt(6)).toBe("fenced");
		expect(reasonAt(9)).toBe("fenced");
	});

	it("counts the frontmatter's own --- lines as inside it", () => {
		expect(reasonAt(0)).toBe("frontmatter");
		expect(reasonAt(3)).toBe("frontmatter");
	});
});

/**
 * The shape guard for the describe above: every `LeftAloneReason` member
 * — read from `lineKind.ts` on disk, not named here — has at least one test
 * inside it, some carrying two. An eleventh
 * member added with no test above fails this, naming it.
 */
describe("every LeftAloneReason has a test in the describe above", () => {
	it("finds each reason asserted at least once inside it", () => {
		const lineKindSource = withoutComments(
			readFileSync(resolve(__dirname, "..", "features", "checkboxCycling", "lineKind.ts"), "utf8"),
		);
		const declaration = /export type LeftAloneReason =([^;]+);/u.exec(lineKindSource);
		expect(declaration).not.toBeNull();

		const reasons = [...(declaration?.[1] ?? "").matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
		// Nine rather than ten since issue #751: a blank line is no longer one of
		// them, and what a press does to one now is covered in "a blank line
		// gains a checkbox" below rather than in this describe block.
		expect(reasons.length).toBeGreaterThanOrEqual(9);

		const ownSource = withoutComments(readFileSync(__filename, "utf8"));
		const body = describeBody(ownSource, "the lines a press leaves exactly as they are");
		const missing = reasons.filter((reason) => !body.includes(`"${reason}"`));

		expect(missing).toEqual([]);
	});
});

describe("the same line, inside a fence and outside it", () => {
	it("is left alone inside and is a task line outside, in one note", () => {
		// The case the whole design exists for: the text is identical and only
		// what is above it differs. The old plugin has no idea a fence exists.
		expect(NOTE[8]).toBe(NOTE[12]);
		expect(reasonAt(8)).toBe("fenced");
		expect(lineKind(NOTE, 12)).toEqual({ kind: "task" });
	});

	it("closes the fence again, so lines below it are ordinary", () => {
		expect(lineKind(NOTE, 13).kind).toBe("list-item");
	});

	it("opens no fence on three backticks inside the frontmatter", () => {
		const note = ["---", "```", "---", "- A bullet below it all"];

		expect(lineKind(note, 3).kind).toBe("list-item");
	});

	it("reads a tilde fence, and does not let backticks close one", () => {
		const note = ["~~~", "- [ ] Inside", "```", "- [ ] Still inside", "~~~", "- [ ] Outside"];

		expect(reasonAtIn(note, 1)).toBe("fenced");
		expect(reasonAtIn(note, 3)).toBe("fenced");
		expect(lineKind(note, 5)).toEqual({ kind: "task" });
	});

	it("does not close a fence on a shorter run of the same character", () => {
		const note = ["````", "- [ ] Inside", "```", "- [ ] Still inside", "````", "- [ ] Outside"];

		expect(reasonAtIn(note, 3)).toBe("fenced");
		expect(lineKind(note, 5)).toEqual({ kind: "task" });
	});

	it("opens no fence on backticks carrying a backtick in what follows them", () => {
		// CommonMark's rule, and the one `headingRange` already works by: an info
		// string on a backtick fence may not itself hold a backtick. A line of
		// prose quoting `` `code` `` after three backticks is not a fence.
		const note = ["``` `not` a fence", "- [ ] A task"];

		expect(lineKind(note, 1)).toEqual({ kind: "task" });
	});
});

describe("where frontmatter is and is not", () => {
	it("is only frontmatter at the top: a --- further down starts none", () => {
		// The last line of the note is `---` and it is not frontmatter. It is the
		// underline of the prose above it, which is a heading — a different reason
		// to leave it alone, and the one a person should be told.
		expect(reasonAt(21)).toBe("setext-underline");
		expect(lineKind(NOTE, 19).kind).toBe("prose");
	});

	it("is no frontmatter at all when the opening --- is never closed", () => {
		// Obsidian reads an unclosed opener as a horizontal rule with ordinary
		// words under it, and so does this. Refusing to touch those words would
		// be refusing to do the one thing the feature is for.
		const note = ["---", "Just words", "- A bullet"];

		expect(lineKind(note, 1).kind).toBe("prose");
		expect(lineKind(note, 2).kind).toBe("list-item");
	});

	it("needs the --- on the very first line", () => {
		const note = ["", "---", "tags: [reading]", "---", "- A bullet"];

		expect(lineKind(note, 2).kind).toBe("prose");
	});
});

describe("where a rule of dashes is a rule, and where it is not", () => {
	it("wants three characters before it calls a line a rule", () => {
		// CommonMark's floor. Two dashes are not a rule, and `- -` is a bullet
		// carrying a dash, which is what it was before this rule existed.
		expect(lineKind(["--"], 0)).toEqual({ kind: "prose", contentAt: 0 });
		expect(lineKind(["- -"], 0)).toEqual({ kind: "list-item", contentAt: 2 });
	});

	it("reads a task line whose words are dashes as a task line", () => {
		// The rules are asked after the core's reader, so a checkbox already
		// written here is stepped along the sequence rather than left alone.
		expect(lineKind(["- [ ] ---"], 0)).toEqual({ kind: "task" });
	});

	it("leaves the frontmatter's --- lines alone as frontmatter, not as rules", () => {
		const note = ["---", "tags: [reading]", "---", "- A bullet"];

		expect(reasonAtIn(note, 0)).toBe("frontmatter");
		expect(reasonAtIn(note, 2)).toBe("frontmatter");
	});

	it("reads a --- opening nothing as the rule Obsidian draws for it", () => {
		// An opener with no close is not frontmatter, here or in Obsidian, which
		// draws a horizontal rule for it. So the line is a rule and is left alone
		// — it answered prose until [#355] — and the words under it are still the
		// person's own words, which the press may touch.
		const note = ["---", "Just words", "- A bullet"];

		expect(reasonAtIn(note, 0)).toBe("thematic-break");
		expect(lineKind(note, 1).kind).toBe("prose");
		expect(lineKind(note, 2).kind).toBe("list-item");
	});

	it("reads a rule inside a fenced block as fenced, not as a rule", () => {
		const note = ["```", "---", "```", "- A bullet"];

		expect(reasonAtIn(note, 1)).toBe("fenced");
	});

	it("answers the same for a half-typed bullet whichever of the three markers it uses", () => {
		// [#382]. Type a paragraph, press Enter, type "- ", press the cycle key:
		// the line was answered `setext-underline` and nothing happened, while
		// "* " and "+ " in the identical position became checkboxes. The three
		// markers now agree, and this case is written side by side so that a later
		// change making them disagree again fails here.
		const answers = ["-", "*", "+"].map((marker) => lineKind(["Groceries", `${marker} `], 1));

		expect(answers).toEqual([
			{ kind: "list-item", contentAt: 2 },
			{ kind: "list-item", contentAt: 2 },
			{ kind: "list-item", contentAt: 2 },
		]);
	});

	it("counts a trailing tab as trailing whitespace on a half-typed bullet", () => {
		expect(lineKind(["Groceries", "- \t"], 1)).toEqual({ kind: "list-item", contentAt: 3 });
	});

	it("still reads every dash run [#355] named as a setext underline", () => {
		// The rule was narrowed rather than asked later, so everything [#355] was
		// filed to stop is untouched: two or more dashes stay an underline with or
		// without trailing whitespace, and so does a lone dash with nothing after
		// it. Only the one shape a person types on the way to a bullet moved.
		for (const underline of ["-", "--", "-- ", "---", "----", "=", "= ", "==="]) {
			expect(reasonAtIn(["Groceries", underline], 1)).toBe("setext-underline");
		}
	});

	it("still reads a dash run under a blank line as the rule it is", () => {
		// What tells the two shapes apart is the line above, and that is unchanged.
		expect(reasonAtIn(["", "---"], 1)).toBe("thematic-break");
	});
});

describe("the lines a press may write to", () => {
	it("answers list item for a -, a * and a + carrying no checkbox", () => {
		for (const index of [13, 14, 15]) {
			expect(lineKind(NOTE, index)).toEqual({ kind: "list-item", contentAt: 2 });
		}
	});

	it("answers left alone for a numbered item, where the other three gain one", () => {
		expect(reasonAt(16)).toBe("numbered-item");
	});

	it("says where the brackets go, past the marker and its whitespace", () => {
		const note = ["   -   Deeply indented, loosely spaced"];

		expect(lineKind(note, 0)).toEqual({ kind: "list-item", contentAt: 7 });
	});

	it("answers task line for all four list markers, as the core's reader does", () => {
		// Asked of the reader rather than of a second pattern written here. The
		// old plugin knew `-` alone, so `* text` fell to its prose branch and came
		// out `- [ ] * text`, two markers deep.
		const note = ["- [ ] One", "* [x] Two", "+ [/] Three", "1. [>] Four", "1) [-] Five"];

		for (let index = 0; index < note.length; index += 1) {
			expect(lineKind(note, index)).toEqual({ kind: "task" });
		}
	});

	it("answers prose for a sentence, and keeps its indentation", () => {
		expect(lineKind(NOTE, 19)).toEqual({ kind: "prose", contentAt: 0 });
		expect(lineKind(NOTE, 20)).toEqual({ kind: "prose", contentAt: 2 });
	});

	it("reads a task line carrying fields the plugin has never heard of", () => {
		// What the core's reader is for. A recurrence rule, a done date and a
		// bookkeeping marker are all just words to this function.
		const note = ["- [/] Roof \u{1F4C5} 2026-09-30 #home %% eid:abc %% every week"];

		expect(lineKind(note, 0)).toEqual({ kind: "task" });
	});

	it("leaves a bullet holding a link alone as a list item, not a bracket case", () => {
		// `[[Collection]]` opens with a bracket and is not a bracketed character,
		// so the line is an ordinary bullet and gains its checkbox in place.
		const note = ["- [[Roof]] needs a decision"];

		expect(lineKind(note, 0)).toEqual({ kind: "list-item", contentAt: 2 });
	});

	it("reads only one character in brackets as the near-miss, not two and not none", () => {
		// The floor and the ceiling of the bracket rule. Two characters in
		// brackets is not a checkbox anybody could have meant, and neither is an
		// empty pair, so both lines are ordinary bullets.
		expect(lineKind(["- [ab]text"], 0)).toEqual({ kind: "list-item", contentAt: 2 });
		expect(lineKind(["- []text"], 0)).toEqual({ kind: "list-item", contentAt: 2 });
	});

	it("reads a checkbox outside the BMP with its space as an ordinary task line", () => {
		// The same symbol as the near-miss above, written correctly. The core's
		// reader has always got this one right; the rule beside it had not.
		expect(lineKind(["- [\u{1F525}] task"], 0)).toEqual({ kind: "task" });
	});
});

describe("notes that do not end in a newline the way this function is handed them", () => {
	it("reads a line that still carries its carriage return", () => {
		// A note written on Windows and split on "\n" leaves "\r" on every line.
		const note = ["---\r", "tags: [reading]\r", "---\r", "- [ ] A task\r", "\r"];

		expect(reasonAtIn(note, 1)).toBe("frontmatter");
		expect(lineKind(note, 3)).toEqual({ kind: "task" });
		// A blank line no longer leaves this alone: the "\r" strips
		// to "" before classifying, so this line answers the same as a truly
		// empty one.
		expect(lineKind(note, 4)).toEqual({ kind: "blank", contentAt: 0 });
	});

	it("leaves a heading alone when a carriage return sits inside it", () => {
		// [#406]: this reader strips a trailing "\r" before classifying, so an
		// embedded one survives to the heading rule. The core's rule refused it for
		// a while, and a press then wrote "- [ ] " at column 0 of a heading. Two
		// ways a note reaches this: carriage-return-only line endings, where the
		// split on "\n" leaves the "\r" inside the line, and a stray one pasted in.
		expect(reasonAtIn(["# Heading\rmore"], 0)).toBe("heading");
	});

	it("counts a line of nothing but tabs as blank, keeping them as its indentation", () => {
		expect(lineKind(["\t \t"], 0)).toEqual({ kind: "blank", contentAt: 3 });
	});
});

/**
 * Issue #751 reverses one item of spec #283 decision 4's "left alone" list: a
 * blank line now starts a checkbox instead. What a press writes there is
 * `cycleLines.ts`'s decision — this only checks that the line is answered
 * `blank` rather than `left-alone`, and where the checkbox goes.
 */
describe("a blank line gains a checkbox, since #751 reverses this one case", () => {
	it("answers blank rather than left alone, for an empty line", () => {
		expect(lineKind(NOTE, 4)).toEqual({ kind: "blank", contentAt: 0 });
	});

	it("puts the checkbox after whatever whitespace a line already has", () => {
		expect(lineKind(["   "], 0)).toEqual({ kind: "blank", contentAt: 3 });
	});

	it("answers differently for the frontmatter close and the blank line right after it", () => {
		// The two are adjacent in `NOTE`, so a range spanning both is where a walk
		// that carried the wrong state across the boundary would show it.
		expect(lineKindRange(NOTE, 3, 5)).toEqual([
			{ kind: "left-alone", reason: "frontmatter" },
			{ kind: "blank", contentAt: 0 },
		]);
	});
});

describe("an index that names no line", () => {
	it("says so rather than answering about a line that is not there", () => {
		expect(() => lineKind(NOTE, NOTE.length)).toThrow(/no line/);
		expect(() => lineKind(NOTE, -1)).toThrow(/no line/);
		expect(() => lineKind([], 0)).toThrow(/no line/);
	});
});

describe("asking about a range of lines in one pass", () => {
	it("gives the same answer for every line of a note as asking line by line", () => {
		// The note at the top of this file, which carries frontmatter, a fenced
		// block, a table row, a heading, a blockquote, bullets, a numbered item,
		// blank lines, prose and a setext underline. Every one of them.
		const range = lineKindRange(NOTE, 0, NOTE.length);

		expect(range).toHaveLength(NOTE.length);
		for (let index = 0; index < NOTE.length; index += 1) {
			expect(range[index]).toEqual(lineKind(NOTE, index));
		}
	});

	it("answers the same for a range that starts inside a fence or inside frontmatter", () => {
		// The walk always begins at line zero, so a range that starts halfway down
		// still knows a fence is open above it. Lines 6 to 9 are the fenced block
		// and lines 0 to 3 are the frontmatter.
		for (const [start, end] of [
			[7, 10],
			[1, 4],
			[9, 14],
		]) {
			const range = lineKindRange(NOTE, start, end);

			for (let offset = 0; offset < end - start; offset += 1) {
				expect(range[offset]).toEqual(lineKind(NOTE, start + offset));
			}
		}
	});

	it("reads each line a bounded number of times, not once per line", () => {
		// The reason this entry point exists. Asking line by line walks the note
		// from the top each time, which is quadratic — a 5000-line note took five
		// seconds that way on the machine this was written on, and the day's log
		// reaches that length without being pathological.
		//
		// This counts reads rather than timing them. Two assertions stood here
		// until issue #384: a
		// 250 ms wall and a growth ratio below eight. Both failed on this machine
		// on branches that had changed nothing, because both measured how busy the
		// machine was as much as how much work the code does. How many times the
		// note is read is the claim they stood for, and it answers the same on an
		// idle machine and a loaded one.
		const note = plainNote(5000);
		const counted = countingNote(note);

		lineKindRange(counted.lines, 0, note.length);

		expect(counted.mostReadsOfOneLine()).toBeLessThanOrEqual(READS_PER_LINE);
	});

	it("reads each line a bounded number of times for a short range low down a long note", () => {
		// The same bound over the case #410
		// is about: ten lines at the foot of a 20,000-line note. What holds here is
		// the count per line, which is what this guard claims. What #410 is about is
		// the total — the fence scan reads the whole note to answer about ten lines
		// of it — and nothing here says otherwise.
		const note = plainNote(20_000);
		const counted = countingNote(note);

		lineKindRange(counted.lines, note.length - 10, note.length);

		expect(counted.mostReadsOfOneLine()).toBeLessThanOrEqual(READS_PER_LINE);
	});

	it("puts no more lines through the fence rule than the range covers", () => {
		// [#410]. The fence scan asked the core for the whole note's fence state
		// however small the range, so asking about five lines of a 20,000-line note
		// classified 20,000 of them — the opposite direction from the reason this
		// entry point exists. The per-line bound above cannot see it: every line
		// was read once, which is within the bound.
		//
		// What is counted is reads of a line, and the scan reads a line only in
		// order to match it, so the count is the number of lines put through the
		// fence rules. It is pinned to the same answer on two notes whose lengths
		// differ by a factor of twenty. Equality rather than a ceiling, so a reader
		// that reads a little of the tail fails here too.
		//
		// This is not a bound on what the call costs, and the name no longer says it
		// is.
		// `fencedLines` still visits every line of the note and still builds an entry
		// per line, deliberately, so answers stay keyed by line number — and a
		// counter that sees only reads cannot see either.
		const short = countingNote(plainNote(1_000));
		const long = countingNote(plainNote(20_000));

		lineKindRange(short.lines, 0, 5);
		lineKindRange(long.lines, 0, 5);

		expect(long.totalReads()).toBe(short.totalReads());
	});

	it("still answers fenced for a range that ends inside an unclosed block", () => {
		// The bound cuts the scan's tail, so the two cases that depend on state
		// carried into and across the range are worth naming. A block opened above
		// the range reaches it, and one opened inside it and never closed runs to
		// the range's end rather than stopping at the bound.
		const note = ["words", "```", "in the block", "still in it", "and here"];

		expect(lineKindRange(note, 2, 4).map((answer) => answer.kind)).toEqual([
			"left-alone",
			"left-alone",
		]);
		expect(reasonAtIn(note, 3)).toBe("fenced");
		expect(lineKindRange(note, 0, 3)).toEqual([
			lineKind(note, 0),
			lineKind(note, 1),
			lineKind(note, 2),
		]);
	});

	it("reads a line far more often when the note is asked about line by line", () => {
		// The bound above is only worth having if a quadratic reader trips it, and
		// this is that reader: `lineKind` walks the note from the top for every
		// line it is asked about, which is the cost `lineKindRange` exists to
		// avoid. Asked about all 200 lines, it reads the top of the note about once
		// per line rather than a fixed few times.
		const note = plainNote(200);
		const counted = countingNote(note);

		for (let index = 0; index < note.length; index += 1) lineKind(counted.lines, index);

		expect(counted.mostReadsOfOneLine()).toBeGreaterThan(READS_PER_LINE);
	});

	it("answers exactly the same through the counter as without it", () => {
		// The count is worth nothing if the counter changes an answer, so an
		// existing correctness case is run again with its note wrapped: the note at
		// the top of this file, every line of it, both ways round.
		const counted = countingNote(NOTE);

		expect(lineKindRange(counted.lines, 0, NOTE.length)).toEqual(
			lineKindRange(NOTE, 0, NOTE.length),
		);
		for (let index = 0; index < NOTE.length; index += 1) {
			expect(lineKind(counted.lines, index)).toEqual(lineKind(NOTE, index));
		}
	});

	it("says so rather than answering about a range the note does not have", () => {
		expect(() => lineKindRange(NOTE, 0, NOTE.length + 1)).toThrow(/no line/);
		expect(() => lineKindRange(NOTE, -1, 3)).toThrow(/no line/);
		expect(() => lineKindRange(NOTE, 5, 4)).toThrow(/no line/);
		expect(() => lineKindRange(NOTE, 1.5, 4)).toThrow(/no line/);
	});

	it("answers nothing at all for an empty range", () => {
		expect(lineKindRange(NOTE, 3, 3)).toEqual([]);
		expect(lineKindRange([], 0, 0)).toEqual([]);
	});
});

describe("the one sentence a range the note does not have is refused in", () => {
	/**
	 * `refuseUnknownRange` is the sentence itself, lifted out of `lineKindRange`
	 * so that `cycleLines` can ask for it too.
	 *
	 * It was written out a second time in `cycleLines.ts` for one wave, because a
	 * press handed its kinds never calls `lineKindRange` and so never got the
	 * refusal as a side effect of reading a note. What kept the two copies equal
	 * was a case in `checkboxCyclingCycleLines.test.ts` that pressed one bad range
	 * through both and compared the words. These cases are what that one was
	 * standing in for, and the guard at the foot of this block is what stops a
	 * third copy being written.
	 */
	it("names the range asked for and the note's real length", () => {
		expect(() => refuseUnknownRange(12, 5, 99)).toThrow(
			"This note has no lines 5 to 99; it has 12.",
		);
	});

	it("refuses every shape of range a note cannot have", () => {
		expect(() => refuseUnknownRange(3, 0, 4)).toThrow(/no lines/);
		expect(() => refuseUnknownRange(3, -1, 3)).toThrow(/no lines/);
		expect(() => refuseUnknownRange(3, 2, 1)).toThrow(/no lines/);
		expect(() => refuseUnknownRange(3, 1.5, 3)).toThrow(/no lines/);
		expect(() => refuseUnknownRange(3, 0, 2.5)).toThrow(/no lines/);
	});

	it("accepts the two edges a note does have", () => {
		// `end` is exclusive, so the foot of the note is a legal `end`; and an empty
		// range is a range every note has, including a note with no lines at all.
		expect(() => refuseUnknownRange(3, 0, 3)).not.toThrow();
		expect(() => refuseUnknownRange(3, 2, 2)).not.toThrow();
		expect(() => refuseUnknownRange(0, 0, 0)).not.toThrow();
	});

	it("is written in one shipped file and nowhere else", () => {
		// The comments come off first: a correct note about the sentence must not
		// count as a second copy of it (issue #243's lesson, held to by the guards
		// at the foot of this file the same way).
		const writers = shippedSources()
			.filter(({ source }) => withoutComments(source).includes("has no lines "))
			.map(({ path }) => path);

		expect(writers).toEqual(["src/features/checkboxCycling/lineKind.ts"]);
	});
});

/**
 * The list markers, the indentation and the brackets are the core's, and this
 * file states none of them.
 *
 * The guard reads the code with its comments stripped, because every pattern
 * below is written out in the comments of this file and of that one — a correct
 * note about the rule must not fail the rule (issue #243's lesson, held to by
 * `platform.test.ts` the same way).
 */
describe("where the shape of a line is decided", () => {
	/** `lineKind.ts` as it is on disk, comments stripped. */
	const code = withoutComments(
		readFileSync(resolve(__dirname, "..", "features", "checkboxCycling", "lineKind.ts"), "utf8"),
	);

	it("states no list-marker set of its own", () => {
		expect(statesPattern(code, "[-*+]")).toBe(false);
	});

	it("states no numbered-item pattern of its own", () => {
		expect(statesPattern(code, String.raw`\d+[.)]`)).toBe(false);
	});

	it("states no bracket pattern of its own", () => {
		expect(statesPattern(code, String.raw`[^\]]`)).toBe(false);
	});

	it("states no fence pattern and no heading pattern of its own", () => {
		// The other half of the same rule, and the first knowledge a feature could
		// copy out of the core: CommonMark's fences and the ATX heading.
		//
		// Neither of these is a character class — both are repetition counts — so
		// the normaliser has nothing to reorder in them and they are matched as
		// they are written. Whether the counts themselves need the same treatment
		// is left where issue #416
		// left it: a separate question.
		expect(statesPattern(code, "`{3,}")).toBe(false);
		expect(statesPattern(code, "~{3,}")).toBe(false);
		expect(statesPattern(code, "#{1,6}")).toBe(false);
	});

	it("asks the core, so the two cannot answer differently", () => {
		expect(code).toMatch(/checkboxSlot\(/u);
		expect(code).toMatch(/fencedLines\(/u);
		expect(code).toMatch(/isAtxHeading\(/u);
	});

	// The other half of the same claim: the answers themselves come through
	// `lineKind` for every marker the core accepts, so a change to that set in
	// the core reaches this feature rather than only the reader.
	it("answers for every marker the core accepts, through the core", () => {
		expect(lineKind(["* A star bullet"], 0)).toEqual({ kind: "list-item", contentAt: 2 });
		expect(lineKind(["+ A plus bullet"], 0)).toEqual({ kind: "list-item", contentAt: 2 });
		expect(reasonAtIn(["1. A numbered item"], 0)).toBe("numbered-item");
		expect(reasonAtIn(["1) A numbered item"], 0)).toBe("numbered-item");
		expect(lineKind(["- [ ] Task"], 0)).toEqual({ kind: "task" });
		expect(lineKind(["1. [ ] Task"], 0)).toEqual({ kind: "task" });
	});
});

/** A note of ordinary bullets, `count` of them and no structure in it. */
function plainNote(count: number): readonly string[] {
	return Array.from({ length: count }, (_unused, index) => `- bullet number ${index}`);
}

/**
 * How many times one `lineKindRange` call may read any single line of the note.
 *
 * Measured at three on the reader as it stands: the frontmatter probe reads
 * the first line, the fence scan reads every line once, and the walk reads every
 * line outside the frontmatter once. The constant sits one above the measurement,
 * so one more read is a decision somebody takes rather than a test that breaks
 * under them. A quadratic reader is nowhere near it: asking line by line reads
 * the top of the note once per line, which is thousands rather than four.
 */
const READS_PER_LINE = 4;

/**
 * `note` behind a counter that tallies how many times each line is read.
 *
 * A `Proxy` around the array, so the code under test needs no change and cannot
 * tell the difference: every read is handed to the array itself, and a read of a
 * line index is counted on the way through. `length`, iteration and every method
 * are the array's own answers.
 *
 * Counting rather than timing is issue
 * #384: a count is the claim
 * these tests actually make, and it does not depend on what else the machine is
 * doing.
 *
 * Two tallies, because the guards claim two different things. The most reads of
 * any one line is #384's: it catches a reader that walks the note from the top
 * per line. The total across all lines is
 * #410's: it catches a
 * reader that touches every line once however few were asked about, which the
 * per-line bound cannot see. #410's triage asked that the second extend this
 * counter rather than build a guard of its own, and this is that.
 */
function countingNote(note: readonly string[]): {
	readonly lines: readonly string[];
	mostReadsOfOneLine(): number;
	totalReads(): number;
} {
	const reads = new Map<number, number>();
	const lines = new Proxy(note, {
		get(target, property, receiver): unknown {
			if (typeof property === "string") {
				const index = Number(property);
				if (Number.isInteger(index) && index >= 0) reads.set(index, (reads.get(index) ?? 0) + 1);
			}
			return Reflect.get(target, property, receiver);
		},
	});

	return {
		lines,
		mostReadsOfOneLine: () => Math.max(0, ...reads.values()),
		totalReads: () => [...reads.values()].reduce((sum, count) => sum + count, 0),
	};
}

/** The same as `reasonAt`, for a case that brings its own note. */
function reasonAtIn(lines: readonly string[], index: number): LeftAloneReason | string {
	const answer = lineKind(lines, index);
	return answer.kind === "left-alone" ? answer.reason : `not left alone: ${answer.kind}`;
}

/**
 * The body of the `describe(heading, ...)` call in `source`, from its `{` to
 * the matching `}` — brace-depth counting, so a nested object literal inside
 * a test does not end the scan early. Used by the shape guard above, over
 * this file's own source with comments stripped.
 */
function describeBody(source: string, heading: string): string {
	const marker = `describe(${JSON.stringify(heading)}`;
	const start = source.indexOf(marker);
	if (start === -1) throw new Error(`no describe block named ${JSON.stringify(heading)}`);

	const open = source.indexOf("{", start);
	let depth = 0;
	for (let index = open; index < source.length; index += 1) {
		if (source[index] === "{") depth += 1;
		else if (source[index] === "}") {
			depth -= 1;
			if (depth === 0) return source.slice(open + 1, index);
		}
	}
	throw new Error(`describe block named ${JSON.stringify(heading)} never closes`);
}
