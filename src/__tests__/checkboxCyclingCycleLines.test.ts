import { describe, expect, it } from "vitest";

import { reasonOf } from "../core/reason";
import { editTaskField, parseTaskLine } from "../core/taskLine";
import { cycleLines } from "../features/checkboxCycling/cycleLines";
import { lineKindRange } from "../features/checkboxCycling/lineKind";
import type { LeftAloneReason, LineKind } from "../features/checkboxCycling/lineKind";
import type { Sequence } from "../features/checkboxCycling/types";
import { fixture } from "./fixtures";
import { shippedSources } from "./sourceGuards";

/**
 * What one cycling press does to every line a selection touches.
 *
 * Every case hands text in and compares the text that comes out, byte for byte.
 * Nothing here builds an Obsidian stub and nothing reaches for a private field:
 * the whole point of `cycleLines` is that it decides on text alone.
 */

/** The cycle almost every case below is pressed with. */
const CYCLE: Sequence = { id: "s1", name: "Task flow", symbols: [" ", "/", "x"] };

/** The lines of a one-line note. */
const ONE_LINE = { start: 0, end: 1 };

/**
 * One answer per line of the whole note — what every caller of `cycleLines` has
 * to hand in.
 *
 * The reading is the real one, not a stand-in: a case that pressed a note
 * against kinds some fake had invented would prove nothing about a press. This
 * is the same call the editor half makes, bounded at the foot of the note
 * instead of at the lowest cursor.
 */
function kindsFor(lines: readonly string[]): readonly LineKind[] {
	return lineKindRange(lines, 0, lines.length);
}

/** `raw` as a one-line note, cycled once. */
function once(raw: string, direction: "forward" | "backward" = "forward"): string {
	const note = [raw];
	return cycleLines(note, ONE_LINE, CYCLE, direction, kindsFor(note)).lines[0];
}

/**
 * The line with whatever sits between its brackets swapped for one fixed
 * character, so that two lines compare equal exactly when every byte outside
 * the checkbox is identical.
 *
 * The swap is the core's own one-field edit, which is also what the function
 * under test writes with — but it is the only writer in the repository that
 * leaves the rest of a line alone by construction, and `taskLine.test.ts` is
 * where that property is established. Using it here measures the checkbox out
 * of the picture rather than restating the task-line format a second time.
 */
function withoutCheckbox(line: string): string {
	return editTaskField(line, "checkbox", " ");
}

/** The checkbox character of a line that must be a task line. */
function checkboxOf(raw: string): string {
	const task = parseTaskLine(raw);
	if (task === null) throw new Error(`expected a task line: ${JSON.stringify(raw)}`);
	return task.checkbox;
}

describe("the shape of the answer", () => {
	it("reads nothing outside its arguments and changes neither of them", () => {
		// Purity, as far as it can be seen from outside: the note handed in is the
		// same array afterwards, the sequence is unchanged, and asking twice gives
		// the same answer. There is no clock, no vault and no editor to reach for
		// in the first place — the function takes strings.
		const note = ["- [ ] Write the report", "Just a sentence."];
		const kept = [...note];
		const symbols = [...CYCLE.symbols];

		const first = cycleLines(note, { start: 0, end: 2 }, CYCLE, "forward", kindsFor(note));
		const second = cycleLines(note, { start: 0, end: 2 }, CYCLE, "forward", kindsFor(note));

		expect(note).toEqual(kept);
		expect(CYCLE.symbols).toEqual(symbols);
		expect(second.lines).toEqual(first.lines);
	});

	it("hands back the whole note, with the lines outside the range untouched", () => {
		const note = ["- [ ] Above", "- [ ] The cursor's line", "- [ ] Below"];

		const { lines } = cycleLines(note, { start: 1, end: 2 }, CYCLE, "forward", kindsFor(note));

		expect(lines).toEqual(["- [ ] Above", "- [/] The cursor's line", "- [ ] Below"]);
	});
});

describe("a task line steps along the sequence", () => {
	it("moves one place forward", () => {
		expect(once("- [ ] Write the report")).toBe("- [/] Write the report");
		expect(once("- [/] Write the report")).toBe("- [x] Write the report");
	});

	it("moves one place backward", () => {
		expect(once("- [x] Write the report", "backward")).toBe("- [/] Write the report");
		expect(once("- [/] Write the report", "backward")).toBe("- [ ] Write the report");
	});

	it("wraps at the end going forward", () => {
		expect(once("- [x] Write the report")).toBe("- [ ] Write the report");
	});

	it("wraps at the start going backward", () => {
		expect(once("- [ ] Write the report", "backward")).toBe("- [x] Write the report");
	});

	it("replaces a character the sequence does not hold with the first symbol", () => {
		// Either way round: a character outside the order has nowhere to step
		// from, so both directions land on the same place.
		expect(once("- [S] An unknown checkbox character")).toBe("- [ ] An unknown checkbox character");
		expect(once("- [S] An unknown checkbox character", "backward")).toBe(
			"- [ ] An unknown checkbox character",
		);
	});
});

describe("every byte outside the checkbox survives", () => {
	/**
	 * The core's own corpus of task lines, one case per line. Lines opening with
	 * `>` are the file's commentary rather than cases, and it carries no blank
	 * line that is a case.
	 */
	const corpus: string[] = fixture("task-lines.md")
		.split("\n")
		.filter((line) => line.length > 0 && !line.startsWith(">"));

	it("has a corpus to run over", () => {
		// Without this, a filter that matched nothing would leave the round trip
		// below passing over an empty list.
		expect(corpus.length).toBeGreaterThan(40);
	});

	it.each(corpus)("cycles %s and changes nothing else", (raw) => {
		const cycled = once(raw);

		expect(withoutCheckbox(cycled)).toBe(withoutCheckbox(raw));
		expect(checkboxOf(cycled)).not.toBe(checkboxOf(raw));
	});

	it("keeps a marker, a collection's name, a due date, a priority and a tag at once", () => {
		const raw =
			"- [ ] Everything at once \u{1F4C5} 2026-02-06 \u{23EB} #work [[Somewhere]] %% eid:m1abc2de %%";

		expect(once(raw)).toBe(
			"- [/] Everything at once \u{1F4C5} 2026-02-06 \u{23EB} #work [[Somewhere]] %% eid:m1abc2de %%",
		);
	});

	it("keeps a field this plugin has never heard of", () => {
		// A recurrence rule and a done date: two of Obsidian Tasks's stamps that
		// nothing in this repository reads. Neither is understood, so neither
		// could be rebuilt — which is why the line is never rebuilt at all.
		const raw = "- [/] A recurrence rule \u{1F501} every week and a done date \u{2705} 2026-01-07";

		expect(once(raw)).toBe(
			"- [x] A recurrence rule \u{1F501} every week and a done date \u{2705} 2026-01-07",
		);
	});
});

describe("a line with no checkbox gains one", () => {
	it("gives a dash, a star and a plus item its checkbox in place", () => {
		expect(once("- An ordinary bullet")).toBe("- [ ] An ordinary bullet");
		expect(once("* A star bullet")).toBe("* [ ] A star bullet");
		expect(once("+ A plus bullet")).toBe("+ [ ] A plus bullet");
	});

	it("keeps a list item's indentation", () => {
		expect(once("\t\t- Two tabs in")).toBe("\t\t- [ ] Two tabs in");
		expect(once("  * Two spaces in")).toBe("  * [ ] Two spaces in");
	});

	it("returns a numbered item carrying no checkbox unchanged", () => {
		// The one list marker that gains nothing. A numbered item's number is part
		// of the note's own ordering, and the plugin this feature replaces left
		// these alone too.
		expect(once("1. A numbered item")).toBe("1. A numbered item");
		expect(once("1) A numbered item")).toBe("1) A numbered item");
	});

	it("writes a whole task head in front of ordinary prose, keeping its indentation", () => {
		expect(once("Just a sentence.")).toBe("- [ ] Just a sentence.");
		expect(once("    Indented prose")).toBe("    - [ ] Indented prose");
	});
});

describe("the lines a press leaves exactly as they are", () => {
	/**
	 * A note holding one line for each of the nine reasons a line is left
	 * alone, plus the line of prose that makes the `===` under it an
	 * underline. **A blank line no longer belongs here**: issue #751 reverses
	 * that one item of spec #283 decision 4, and what a press does to one now
	 * is proved in "a blank line gains a checkbox" below.
	 */
	const NOTE = [
		"---", //                                     0  frontmatter opens
		"tags: [reading]", //                         1  inside frontmatter
		"---", //                                     2  frontmatter closes
		"## Meetings", //                             3  heading
		"```schema", //                               4  fence opens
		"- [ ] Looks exactly like a task", //         5  inside the fence
		"```", //                                     6  fence closes
		"| Time | What |", //                         7  a table row
		"> - [ ] Something somebody said", //         8  quoted
		"1. A numbered item", //                      9  numbered, no checkbox
		"- [x]text", //                               10  bracket with no space
		"***", //                                     11  a horizontal rule
		"A title", //                                 12  prose, and the line above
		"===", //                                     13  the underline that makes it a heading
	];

	const WHOLE = { start: 0, end: NOTE.length };

	/** Every reason the note is meant to cover, so a drifting note fails here. */
	const reasons: readonly LeftAloneReason[] = [
		"blockquote",
		"fenced",
		"frontmatter",
		"heading",
		"numbered-item",
		"setext-underline",
		"table-row",
		"thematic-break",
		"unspaced-bracket",
	];

	/** The reason each line of the note is left alone, or null where it is not. */
	function reasonsOfNote(): Array<LeftAloneReason | null> {
		return lineKindRange(NOTE, WHOLE.start, WHOLE.end).map((kind) =>
			kind.kind === "left-alone" ? kind.reason : null,
		);
	}

	it("covers all nine reasons", () => {
		const found = reasonsOfNote().filter((reason): reason is LeftAloneReason => reason !== null);

		expect([...new Set(found)].sort()).toEqual([...reasons].sort());
	});

	it("returns every one of them byte-identical", () => {
		const { lines } = cycleLines(NOTE, WHOLE, CYCLE, "forward", kindsFor(NOTE));
		const left = reasonsOfNote();

		const changed = NOTE.map((_line, at) => at)
			.filter((at) => left[at] !== null)
			.filter((at) => lines[at] !== NOTE[at]);

		expect(changed).toEqual([]);
	});
});

describe("a blank line gains a checkbox, since #751 reverses spec #283 decision 4", () => {
	/**
	 * The natural reading settled on for this ticket's first open point: a
	 * forward press starts the sequence from its first symbol and a backward
	 * press from its last, the same two places wrapping already lands a step
	 * on. The old plugin this feature replaces always used the first symbol
	 * regardless of direction (`~/Devbox/checkbox-cycler/src/cycle.ts:63`), and
	 * so do `list-item` and `prose` here — a blank line differs because there
	 * is no character already on the line for a direction to disagree with.
	 */
	it("takes the sequence's first symbol on a forward press", () => {
		expect(once("")).toBe("- [ ] ");
	});

	it("takes the sequence's last symbol on a backward press", () => {
		expect(once("", "backward")).toBe("- [x] ");
	});

	it("keeps a whitespace-only line's indentation, the second open point this ticket settles", () => {
		// The core's reader keeps indentation as written, so this is the answer
		// consistent with every other kind that gains a checkbox in place.
		expect(once("\t\t")).toBe("\t\t- [ ] ");
	});

	it("keeps a carriage return that was on the blank line", () => {
		expect(once("\r")).toBe("- [ ] \r");
	});

	it("gains a checkbox inside a multi-line selection, the third open point this ticket settles", () => {
		// #324's rule is one press steps every line the selection touches; a
		// blank line inside one is no longer an exception, since it is no
		// longer left alone at all.
		const note = ["- [ ] Write the report", "", "Just a sentence."];

		const { lines } = cycleLines(note, { start: 0, end: 3 }, CYCLE, "forward", kindsFor(note));

		expect(lines).toEqual(["- [/] Write the report", "- [ ] ", "- [ ] Just a sentence."]);
	});
});

describe("one press over a selection", () => {
	/** A selection running through seven kinds of line at once. */
	const NOTE = [
		"## Morning", //                       0  heading
		"", //                                 1  blank
		"- [ ] Write the report", //           2  a task line
		"- An ordinary bullet", //             3  a list item
		"Just a sentence.", //                 4  prose
		"| Time | What |", //                  5  a table row
		"```", //                              6  fence opens
		"- [ ] Looks exactly like a task", //  7  inside the fence
		"```", //                              8  fence closes
	];

	it("gives each line its own answer in one call", () => {
		const { lines } = cycleLines(NOTE, { start: 0, end: NOTE.length }, CYCLE, "forward", kindsFor(NOTE));

		expect(lines).toEqual([
			"## Morning",
			// A checkbox now, not "": #751 reverses the blank line's place on the
			// left-alone list, so this line is no longer an exception to "one
			// press steps every line the selection touches".
			"- [ ] ",
			"- [/] Write the report",
			"- [ ] An ordinary bullet",
			"- [ ] Just a sentence.",
			"| Time | What |",
			"```",
			"- [ ] Looks exactly like a task",
			"```",
		]);
	});

	it("acts on the cursor's line alone when nothing is selected", () => {
		// An empty selection is one line rather than none: the cursor still sits
		// on a line, so the range is `{ start: n, end: n + 1 }`.
		const { lines } = cycleLines(NOTE, { start: 3, end: 4 }, CYCLE, "forward", kindsFor(NOTE));

		expect(lines).toEqual([
			"## Morning",
			"",
			"- [ ] Write the report",
			"- [ ] An ordinary bullet",
			"Just a sentence.",
			"| Time | What |",
			"```",
			"- [ ] Looks exactly like a task",
			"```",
		]);
	});
});

describe("a sequence that cannot cycle", () => {
	it("changes nothing when it holds one symbol", () => {
		const note = ["- [ ] Write the report", "Just a sentence."];
		const one: Sequence = { id: "s2", name: "Half a cycle", symbols: ["x"] };

		const result = cycleLines(note, { start: 0, end: 2 }, one, "forward", kindsFor(note));

		expect(result.lines).toEqual(note);
	});

	it("changes nothing when it holds none", () => {
		const note = ["- [ ] Write the report"];
		const empty: Sequence = { id: "s3", name: "Nothing at all", symbols: [] };

		const result = cycleLines(note, ONE_LINE, empty, "forward", kindsFor(note));

		expect(result.lines).toEqual(note);
	});

	// The range is checked first, so a sequence that cannot cycle is still no
	// excuse for swallowing a caller's mistake about which lines exist. Before
	// issue #426 this call came back quietly, while the same range against the
	// three-symbol cycle threw.
	it("still throws on a range the note does not have", () => {
		const note = ["- [ ] Write the report"];
		const one: Sequence = { id: "s2", name: "Half a cycle", symbols: ["x"] };

		expect(() => cycleLines(note, { start: 5, end: 99 }, one, "forward", kindsFor(note))).toThrow(
			"This note has no lines 5 to 99; it has 1.",
		);
	});
});

describe("a sequence holding the same symbol twice", () => {
	/**
	 * The sequence from the reproduction on
	 * #425: four places, and
	 * the fourth can never be reached because the third repeats the first.
	 */
	const FOLDED: Sequence = { id: "s4", name: "Folded", symbols: [" ", "x", " ", "/"] };

	it("bounces between the first two symbols and never reaches the last", () => {
		// A press has only the character on the line to go on, so the second " "
		// is read as the first one and the order folds back there. Allowed and
		// stored as typed by the decision on #425; this pins what it costs.
		let line = "- [ ] Write the report";
		const written: string[] = [];
		for (let press = 0; press < 5; press += 1) {
			const note = [line];
			line = cycleLines(note, ONE_LINE, FOLDED, "forward", kindsFor(note)).lines[0];
			written.push(checkboxOf(line));
		}

		expect(written).toEqual(["x", " ", "x", " ", "x"]);
		expect(written).not.toContain("/");
	});

	it("steps from the first of the two, so the place after the repeat is skipped", () => {
		// "x" steps on to the second " ", and that " " is then read as the first
		// one — so the press after it goes back to "x" instead of on to "/".
		const first = ["- [x] Write the report"];
		const afterX = cycleLines(first, ONE_LINE, FOLDED, "forward", kindsFor(first)).lines[0];
		expect(checkboxOf(afterX)).toBe(" ");
		const second = [afterX];
		expect(
			checkboxOf(cycleLines(second, ONE_LINE, FOLDED, "forward", kindsFor(second)).lines[0]),
		).toBe("x");
	});

	it("changes nothing when every symbol in it is the same", () => {
		const same: Sequence = { id: "s5", name: "Twice over", symbols: ["x", "x"] };
		const note = ["- [x] Write the report"];

		const result = cycleLines(note, ONE_LINE, same, "forward", kindsFor(note));

		expect(result.lines).toEqual(note);
	});
});

describe("the loud failure paths", () => {
	/**
	 * The three places this function refuses rather than guesses. Two of them can
	 * be reached and are proved here; the third is the exhaustiveness guard in
	 * `pressed`, which the compiler checks and which a test would have to widen
	 * the type to reach. Its comment in the source says the same.
	 *
	 * The out-of-range throw against a sequence that cannot cycle is proved by
	 * "still throws on a range the note does not have" above, which belongs to
	 * the ticket that put the range check first.
	 */
	it("lets the out-of-range throw through against a sequence that can step", () => {
		const note = ["- [ ] Write the report"];

		expect(() => cycleLines(note, { start: 5, end: 99 }, CYCLE, "forward", kindsFor(note))).toThrow(
			"This note has no lines 5 to 99; it has 1.",
		);
	});

	/**
	 * `cycleLines` handed a set of kinds that calls a line a task when it is not
	 * one.
	 *
	 * The disagreement the real code guards against cannot be staged with text
	 * alone, and that is the guard working: `lineKindRange` decides what a line is
	 * by asking the very same reader `stepped` then asks, so the two agree by
	 * construction. Something outside both has to say "task" about a line that is
	 * not one, and since
	 * #512 the caller is where
	 * every set of kinds comes from — so the caller is that something, and one
	 * literal stages it.
	 *
	 * Until then this case swapped the whole `lineKind` module for a liar and
	 * pressed through the door that read the note itself. That door is gone and
	 * the module swap went with it, which is one fewer place in this file where
	 * the code under test is not the shipped code.
	 */
	function cycleWithLyingKinds(note: readonly string[]): unknown {
		return cycleLines(note, ONE_LINE, CYCLE, "forward", [{ kind: "task" }]);
	}

	it("throws when the line kinds and the task reader disagree about a line", () => {
		expect(() => cycleWithLyingKinds(["Just a sentence."])).toThrow(
			'the line kinds and the reader disagree about "Just a sentence."',
		);
	});
});

describe("a note with Windows line endings", () => {
	/**
	 * A carriage return at the end of a line never changes what a press does, and
	 * is still there afterwards.
	 *
	 * The case that sent this ticket in is the task line with nothing after its
	 * checkbox. `lineKind.ts` takes the carriage return off before it decides
	 * what a line is, so `- [ ]\r` is a task; the press was then handed the raw
	 * line, and the task reader wants a space, a tab or the end of the line after
	 * the closing bracket. `\r` is none of those, so the reader said this is not a
	 * task and the two halves' disagreement threw.
	 */
	it("steps a task line that has no description at all", () => {
		expect(once("- [ ]\r")).toBe("- [/]\r");
	});

	it("steps a description-less task line whatever its checkbox holds", () => {
		expect(once("- [/]\r")).toBe("- [x]\r");
		expect(once("- [x]\r")).toBe("- [ ]\r");
	});

	it("steps a task line that does have a description", () => {
		expect(once("- [ ] Write the report\r")).toBe("- [/] Write the report\r");
	});

	it("gives prose its task head in front of the words, carriage return kept", () => {
		expect(once("Just a sentence.\r")).toBe("- [ ] Just a sentence.\r");
		expect(once("\tJust a sentence.\r")).toBe("\t- [ ] Just a sentence.\r");
	});

	it("gives a list item its brackets in place, carriage return kept", () => {
		expect(once("- bullet\r")).toBe("- [ ] bullet\r");
		expect(once("  * bullet\r")).toBe("  * [ ] bullet\r");
	});

	it("leaves a line it may not touch byte-identical, carriage return and all", () => {
		expect(once("## Meetings\r")).toBe("## Meetings\r");
		expect(once("> quoted\r")).toBe("> quoted\r");
		// A blank line is no longer one of these since #751; "a blank line
		// gains a checkbox" above covers what a press does to "\r" now.
	});
});

describe("line kinds the caller worked out first", () => {
	/**
	 * The argument #449 added
	 * and #512 made the only
	 * way in, so that a press over ten cursors reads the note once rather than ten
	 * times.
	 *
	 * What is proved here is that a set built once for the whole note and a set
	 * bounded at the lowest cursor say the same thing about every range they both
	 * cover, and that a set of kinds which does not belong to the note is refused
	 * rather than believed. That the editor half really uses one set per press is
	 * proved where the press lives, in `checkboxCycling.test.ts`.
	 */
	const NOTE = [
		"---",
		"tags: [reading]",
		"---",
		"## Morning",
		"- [ ] Write the report",
		"- An ordinary bullet",
		"Just a sentence.",
		"| Time | What |",
		"```schema",
		"- [ ] Looks exactly like a task",
		"```",
		"- [x] Done already",
	];

	/** What the caller hands in: one answer per line of the whole note. */
	const KINDS = lineKindRange(NOTE, 0, NOTE.length);

	/**
	 * The message a call made instead of answering.
	 *
	 * The caught thing is read through `reasonOf`, which is the one place in the
	 * repository that turns a thrown thing into a sentence; `reason.test.ts`
	 * fails any file under `src` that does it itself, this one included.
	 */
	function refusal(call: () => unknown): string {
		try {
			call();
		} catch (error) {
			return reasonOf(error);
		}
		throw new Error("that call was supposed to refuse and did not");
	}

	it("answers byte for byte from a set bounded at the range what it answers from the whole note's", () => {
		// Until #512 this loop
		// pressed each range through both doors and compared the bytes. There is one
		// door now, so what it compares instead is the two sets any caller may hand
		// in: the whole note's, and the one the press actually builds, which stops
		// at the lowest cursor's end. Every range
		// and both directions, because a set indexed by line number has to answer
		// the same wherever it stops.
		for (let start = 0; start < NOTE.length; start += 1) {
			for (let end = start; end <= NOTE.length; end += 1) {
				const range = { start, end };
				const bounded = lineKindRange(NOTE, 0, end);
				for (const direction of ["forward", "backward"] as const) {
					expect(
						cycleLines(NOTE, range, CYCLE, direction, KINDS).lines,
						`lines ${start} to ${end} ${direction}`,
					).toEqual(cycleLines(NOTE, range, CYCLE, direction, bounded).lines);
				}
			}
		}
	});

	it("refuses a set of kinds claiming more lines than the note has", () => {
		// A note and its kinds that have come apart is the one way this door can be
		// worse than the other: a line read as prose could be a line inside a code
		// fence, and the press would write a checkbox into somebody's sample code.
		// A note that shrank under its caller arrives this way.
		expect(
			refusal(() =>
				cycleLines(NOTE, { start: 4, end: 5 }, CYCLE, "forward", [...KINDS, ...KINDS]),
			),
		).toBe("These line kinds answer for 24 lines and this note has 12.");
	});

	it("refuses a set of kinds that stops before the range's end", () => {
		// The other half of the old exact-length check, and a different caller
		// mistake, so a different sentence: this set has no
		// answer at all for the lines the press is about to step.
		expect(refusal(() => cycleLines(NOTE, { start: 4, end: 5 }, CYCLE, "forward", []))).toBe(
			"These line kinds answer for 0 lines and this press needs the first 5.",
		);
		expect(
			refusal(() => cycleLines(NOTE, { start: 4, end: 5 }, CYCLE, "forward", KINDS.slice(0, 4))),
		).toBe("These line kinds answer for 4 lines and this press needs the first 5.");
	});

	it("accepts a set bounded exactly at the range's end", () => {
		// This is what the press hands in now: the kinds as far as the lowest cursor
		// and no further. It has to answer byte for byte what the whole-note set
		// answers, or the bound would have bought a different press.
		const range = { start: 4, end: 5 };
		const bounded = lineKindRange(NOTE, 0, range.end);

		expect(bounded).toHaveLength(5);
		expect(cycleLines(NOTE, range, CYCLE, "forward", bounded).lines).toEqual(
			cycleLines(NOTE, range, CYCLE, "forward", KINDS).lines,
		);
	});

	it("reads a fence opened above the range from a set bounded at the range", () => {
		// The set is built from line zero however short it is, so the fence that
		// opens on line 8 is still open on line 9 — the line inside it is left alone
		// rather than stepped as the task it looks like.
		const range = { start: 9, end: 10 };
		const bounded = lineKindRange(NOTE, 0, range.end);

		expect(cycleLines(NOTE, range, CYCLE, "forward", bounded).lines).toEqual(NOTE);
	});

	it("refuses a range the note does not have in the words `lineKind.ts` uses", () => {
		// One sentence now, asked of `refuseUnknownRange` by this function and by
		// `lineKindRange` alike. It was written
		// out twice for one wave, and what kept the two copies equal was this case
		// pressing one bad range through both doors; the comparison stays, against
		// the module the sentence belongs to rather than against a door that is
		// gone.
		const bad = { start: 5, end: 99 };
		const note = ["- [ ] Write the report"];
		const kinds = kindsFor(note);

		expect(refusal(() => cycleLines(note, bad, CYCLE, "forward", kinds))).toBe(
			refusal(() => lineKindRange(note, bad.start, bad.end)),
		);
		expect(refusal(() => cycleLines(note, bad, CYCLE, "forward", kinds))).toBe(
			"This note has no lines 5 to 99; it has 1.",
		);
	});

	it("refuses that range whatever the sequence holds", () => {
		// The range is checked before the sequence is looked at through this door
		// too, so a cycle that cannot step is no excuse for swallowing the mistake.
		const note = ["- [ ] Write the report"];
		const one: Sequence = { id: "s2", name: "Half a cycle", symbols: ["x"] };

		expect(() =>
			cycleLines(note, { start: 5, end: 99 }, one, "forward", lineKindRange(note, 0, 1)),
		).toThrow("This note has no lines 5 to 99; it has 1.");
	});
});

describe("the shift nobody read is gone from the whole tree", () => {
	/**
	 * #450 took `cursorShift`
	 * out of what `cycleLines` hands back, because no shipped caller read it.
	 * `selectionGeometry.ts` then went on describing it in a docstring for the
	 * length of one wave, which is how the removal was found to be incomplete.
	 *
	 * **This guard reads comments on purpose**, unlike every other sweep in this
	 * repository, which strips them with `withoutComments` first. Those guards ask
	 * what the code does, and a comment is prose about the code rather than the
	 * code. This one asks whether a name that is gone is still being spoken of as
	 * present, and prose is exactly where that survives.
	 *
	 * A future ticket may reintroduce the concept. If it does, it changes this
	 * test and says why here — which is the point of a guard over a name.
	 */
	it("is named in no shipped source, in code or in a comment", () => {
		const speakers = shippedSources()
			.filter(({ source }) => source.includes("cursorShift"))
			.map(({ path }) => path);

		expect(speakers).toEqual([]);
	});
});
