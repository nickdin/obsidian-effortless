import { describe, expect, it } from "vitest";
import type { EditorSelection } from "obsidian";

import {
	keptWhereItWas,
	rangeOf,
	shifted,
} from "../features/checkboxCycling/selectionGeometry";

/**
 * Where a cycling press leaves the cursor and the selection.
 *
 * These three functions take strings and positions and hand positions back, so
 * every case below calls one of them and reads the answer. Nothing here builds
 * an editor, registers a command or presses a key — that half is
 * `checkboxCycling.test.ts`, and it still drives the same rules through a real
 * press. What this file adds is the one case per line the other file cannot
 * write without a note, a palette and a transaction around it.
 *
 * **#446 moved this code and changed none of it, so the file began by
 * describing two known faults rather than asserting about them.** Both are now
 * fixed and both are asserted below: a selection made backwards keeps its two
 * characters and
 * its direction,
 * and a position is never left inside a symbol outside the basic plane.
 */

/** A cursor: an empty selection, which is what Obsidian hands over for one. */
function cursor(line: number, ch: number): EditorSelection {
	return { anchor: { line, ch }, head: { line, ch } };
}

/** A selection running from one position to another. */
function from(
	anchorLine: number,
	anchorCh: number,
	headLine: number,
	headCh: number,
): EditorSelection {
	return { anchor: { line: anchorLine, ch: anchorCh }, head: { line: headLine, ch: headCh } };
}

describe("the lines a selection covers", () => {
	it("gives a plain cursor its own line", () => {
		// An empty selection is one line, never none: pressing the key with no
		// selection is the ordinary way the feature is used.
		expect(rangeOf(cursor(3, 7))).toEqual({ start: 3, end: 4 });
	});

	it("gives a selection inside one line that one line", () => {
		expect(rangeOf(from(2, 4, 2, 9))).toEqual({ start: 2, end: 3 });
	});

	it("counts every line a selection runs through, with the end exclusive", () => {
		expect(rangeOf(from(0, 0, 2, 5))).toEqual({ start: 0, end: 3 });
	});

	it("does not count a line the selection merely stops at the start of", () => {
		// Shift and down from the start of one line is how a person selects that
		// one line, and it leaves the far end on the line below at character zero.
		// Counting it would give the line underneath a checkbox nobody asked for.
		expect(rangeOf(from(0, 0, 1, 0))).toEqual({ start: 0, end: 1 });
	});

	it("still counts the cursor's own line when the cursor sits at character zero", () => {
		// The rule above is about the *far* end of a selection that has length.
		// A cursor at the start of a line has not stopped there on the way down.
		expect(rangeOf(cursor(4, 0))).toEqual({ start: 4, end: 5 });
	});

	it("reads a selection made upwards the same way as one made downwards", () => {
		// Which end the person started from is not a fact about which lines they
		// covered, so the two answers are identical.
		expect(rangeOf(from(4, 6, 1, 2))).toEqual(rangeOf(from(1, 2, 4, 6)));
		expect(rangeOf(from(4, 0, 1, 2))).toEqual(rangeOf(from(1, 2, 4, 0)));
	});
});

describe("where one character position ended up", () => {
	it("leaves a position alone when one character was swapped for another", () => {
		// The line is the same length, so nothing after the swap moved. `ch` 9
		// is the `t` of `Write`.
		expect(shifted("- [ ] Write it up", "- [/] Write it up", 9)).toBe(9);
	});

	it("moves a position by the whole prefix a line of prose gained", () => {
		// `- [ ] ` is six characters and the line had none of them, so everything
		// on the line moved six along. `ch` 9 is the `w` that starts `words`.
		expect(shifted("Ordinary words", "- [ ] Ordinary words", 9)).toBe(15);
	});

	it("moves a position by the shorter prefix a bullet gained", () => {
		// A bullet keeps its marker and gains `[ ] ` — four characters, not six.
		// `ch` 2 is the `A` of `A bullet`.
		expect(shifted("- A bullet", "- [ ] A bullet", 2)).toBe(6);
	});

	it("leaves a position in front of the change exactly where it was", () => {
		// The brackets are written where the content starts, so a cursor in the
		// indentation has nothing in front of it that moved. `ch` 2 is the third
		// of the four leading spaces.
		expect(shifted("    - A bullet", "    - [ ] A bullet", 2)).toBe(2);
	});

	it("leaves every position alone when the two lines are identical", () => {
		// `ch` 0 is the bullet's `-`; `ch` 3 is the space between the brackets;
		// `ch` 10 is the end of the line, right after `Same`.
		for (const at of [0, 3, 10]) {
			expect(shifted("- [ ] Same", "- [ ] Same", at)).toBe(at);
		}
	});

	it("pulls a position back when the line grew shorter", () => {
		// Nothing in the feature shortens a line today, but the arithmetic is the
		// difference in lengths and says so in both directions. `ch` 8 is the
		// `r` of `Words`.
		expect(shifted("- [ ] Words", "Words", 8)).toBe(2);
	});
});

describe("putting a selection back on the rewritten lines", () => {
	it("hands back an anchor and a head, the person's own two ends", () => {
		expect(keptWhereItWas(from(0, 2, 0, 5), ["- A bullet"], new Map())).toEqual({
			anchor: { line: 0, ch: 2 },
			head: { line: 0, ch: 5 },
		});
	});

	it("leaves both ends alone on a line the press did not write", () => {
		// A line nobody wrote is not in the map, so neither end of a selection on
		// it has anything to move by.
		const written = new Map<number, string>([[1, "- [/] Written"]]);

		expect(keptWhereItWas(cursor(0, 4), ["Untouched", "- [ ] Written"], written)).toEqual({
			anchor: { line: 0, ch: 4 },
			head: { line: 0, ch: 4 },
		});
	});

	it("answers each end from its own line, when the two gained different prefixes", () => {
		// The case one number cannot describe, and the reason this is worked out
		// here rather than taken from `cycleLines`: the anchor's line gains `[ ] `
		// and the head's gains `- [ ] `.
		const before = ["- A bullet", "Ordinary words"];
		const written = new Map<number, string>([
			[0, "- [ ] A bullet"],
			[1, "- [ ] Ordinary words"],
		]);

		expect(keptWhereItWas(from(0, 2, 1, 9), before, written)).toEqual({
			anchor: { line: 0, ch: 6 },
			head: { line: 1, ch: 15 },
		});
	});

	it("moves the written end and leaves the untouched end where it was", () => {
		const before = ["Ordinary words", "# A heading"];
		const written = new Map<number, string>([[0, "- [ ] Ordinary words"]]);

		expect(keptWhereItWas(from(0, 9, 1, 4), before, written)).toEqual({
			anchor: { line: 0, ch: 15 },
			head: { line: 1, ch: 4 },
		});
	});

	it("changes neither the note it read nor the map of written lines", () => {
		const before = ["- A bullet"];
		const kept = [...before];
		const written = new Map<number, string>([[0, "- [ ] A bullet"]]);

		keptWhereItWas(from(0, 2, 0, 4), before, written);

		expect(before).toEqual(kept);
		expect([...written]).toEqual([[0, "- [ ] A bullet"]]);
	});
});

describe("a selection made backwards", () => {
	// The direction of a selection is the state the next keystroke acts on:
	// shift-up grows it from the head. A press that handed the two ends back in
	// document order swapped them, so the next shift-up grew the selection from
	// the other end.
	// Each end still comes back on its own character, which is what
	// #438 asserted.

	it("stays backwards on one line, each end on its own character", () => {
		// The person dragged left: the anchor is the later character, and it is
		// still the anchor afterwards.
		const written = new Map<number, string>([[0, "- [ ] A bullet"]]);

		expect(keptWhereItWas(from(0, 5, 0, 2), ["- A bullet"], written)).toEqual({
			anchor: { line: 0, ch: 9 },
			head: { line: 0, ch: 6 },
		});
	});

	it("stays backwards across lines that gained different prefixes", () => {
		// Shift and up from the words on line 1 to the bullet on line 0. Line 0
		// gains `[ ] ` and line 1 gains `- [ ] `, so each end moves by its own
		// amount, and the anchor is still the one on line 1.
		const before = ["- A bullet", "Ordinary words"];
		const written = new Map<number, string>([
			[0, "- [ ] A bullet"],
			[1, "- [ ] Ordinary words"],
		]);

		expect(keptWhereItWas(from(1, 9, 0, 2), before, written)).toEqual({
			anchor: { line: 1, ch: 15 },
			head: { line: 0, ch: 6 },
		});
	});

	it("keeps the ticket's own case: three task lines selected upwards", () => {
		// The measurement #554 was filed from: the cursor at the end of the last
		// of three task lines, shift-up twice, then a press that steps all three.
		// The anchor stays on the last line and the head two lines up.
		const before = ["- [ ] first", "- [ ] second", "- [ ] third"];
		const written = new Map<number, string>([
			[0, "- [/] first"],
			[1, "- [/] second"],
			[2, "- [/] third"],
		]);

		expect(keptWhereItWas(from(2, 11, 0, 11), before, written)).toEqual({
			anchor: { line: 2, ch: 11 },
			head: { line: 0, ch: 11 },
		});
	});

	it("covers the same two characters as the same selection made forwards", () => {
		// Which end the person started from is not a fact about what they
		// selected, so the two answers name the same two positions — with the
		// names swapped, because the direction is kept.
		const before = ["- A bullet", "Ordinary words"];
		const written = new Map<number, string>([
			[0, "- [ ] A bullet"],
			[1, "- [ ] Ordinary words"],
		]);
		const forwards = keptWhereItWas(from(0, 2, 1, 9), before, written);

		expect(keptWhereItWas(from(1, 9, 0, 2), before, written)).toEqual({
			anchor: forwards.head,
			head: forwards.anchor,
		});
	});

	it("answers each of several selections in its own direction", () => {
		// One selection dragged left on line 0 and one dragged right on line 1:
		// each is answered from its own two ends, so neither takes the other's
		// direction.
		const before = ["- [ ] One", "- [ ] Two"];
		const written = new Map<number, string>([
			[0, "- [/] One"],
			[1, "- [/] Two"],
		]);

		expect(
			[from(0, 9, 0, 6), from(1, 6, 1, 9)].map((each) => keptWhereItWas(each, before, written)),
		).toEqual([
			{ anchor: { line: 0, ch: 9 }, head: { line: 0, ch: 6 } },
			{ anchor: { line: 1, ch: 6 }, head: { line: 1, ch: 9 } },
		]);
	});
});

describe("a symbol outside the basic plane", () => {
	// An emoji is one character to a reader and two of the units an editor counts
	// positions in, so a press that writes one moves the rest of the line by one
	// more than the symbol count suggests — and a position landing between the two
	// units is not a position the editor can hold.

	it("leaves a cursor on the checkbox, not inside the emoji", () => {
		// The person put the cursor between the brackets. It comes back between the
		// brackets, in front of the emoji rather than halfway through it.
		expect(shifted("- [ ] task", "- [🔥] task", 3)).toBe(3);
	});

	it("still moves the text after the emoji by the whole difference", () => {
		// `task` began at 6 and the line grew by one unit, so it now begins at 7.
		expect(shifted("- [ ] task", "- [🔥] task", 6)).toBe(7);
	});

	it("still moves a bullet's text with the prefix that was written in front of it", () => {
		// The cursor was on `A`; the bullet gained `[🔥] `, five units. It is on `A`.
		expect(shifted("- A bullet", "- [🔥] A bullet", 2)).toBe(7);
	});

	it("leaves a position already sitting at the emoji's start where it is", () => {
		// `ch` 1 in `[ ] task` is the space right after `[`, which is exactly
		// where the emoji's first unit lands in `[🔥] task`. The guard pulls a
		// position back out of a character; it must not pull one that was
		// never inside one.
		expect(shifted("[ ] task", "[🔥] task", 1)).toBe(1);
	});

	it("moves a position already past the emoji by the whole difference", () => {
		// `ch` 5 in `[ ] task` is the `a` of `task`, already past the emoji, so
		// it moves by the one-unit difference the line gained.
		expect(shifted("[ ] task", "[🔥] task", 5)).toBe(6);
	});

	it("keeps both ends of a selection out of the emoji", () => {
		const written = new Map<number, string>([[0, "- [🔥] task"]]);

		expect(keptWhereItWas(from(0, 3, 0, 4), ["- [ ] task"], written)).toEqual({
			anchor: { line: 0, ch: 3 },
			head: { line: 0, ch: 5 },
		});
	});
	it("leaves a cursor on the checkbox when the emoji is taken away", () => {
		// The shrinking direction ([#482]). The press writes the empty box back
		// over the emoji, and the cursor the person left between the brackets
		// belongs between the brackets — it must not fall in front of the `[`.
		expect(shifted("- [🔥] task", "- [ ] task", 3)).toBe(3);
		expect(shifted("- [🔥] task", "- [x] task", 3)).toBe(3);
	});

	it("still moves the text after the emoji back by the whole difference", () => {
		// The mirror of the growing case above: `task` began at 7 and the line
		// lost one unit, so it now begins at 6.
		expect(shifted("- [🔥] task", "- [ ] task", 7)).toBe(6);
	});

	it("keeps both ends of a selection in place when the emoji is taken away", () => {
		const written = new Map<number, string>([[0, "- [ ] task"]]);

		expect(keptWhereItWas(from(0, 3, 0, 5), ["- [🔥] task"], written)).toEqual({
			anchor: { line: 0, ch: 3 },
			head: { line: 0, ch: 4 },
		});
	});

	it("answers a position inside the emoji rather than handing one back", () => {
		// `ch` 4 in `- [🔥] task` is the emoji's second unit, the low half of
		// its surrogate pair — squarely inside the character. Cycling from one
		// symbol to another that shares its first unit leaves the two strings
		// differing at the *second* unit, so the character's own start is a
		// position inside it. An editor never hands over such a position; if
		// one arrives, the answer is the character's start rather than its middle.
		expect(shifted("- [🔥] task", "- [🔤] task", 4)).toBe(3);
	});
});
