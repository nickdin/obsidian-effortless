import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
	DEFAULT_SEQUENCES,
	FEATURE_ID,
	commandIdFor,
	createSequence,
	newSequenceId,
	repeatedSymbol,
	sequencesReadiness,
	symbolRefusal,
} from "../features/checkboxCycling/sequences";
import * as barrel from "../features/checkboxCycling";
import type { Sequence } from "../features/checkboxCycling/types";
import { editTaskField, mayBeCheckbox } from "../core/taskLine";
import { repoRoot } from "./repoRoot";
import { shippedSources, statesCodePointCount, withoutComments } from "./sourceGuards";

/**
 * The sequence model: what a sequence is made of, where its id comes from, and
 * the two sequences a fresh install starts with.
 *
 * Everything under test is a plain function over plain data, so nothing here
 * builds an Obsidian stub or a registry. That is the seam spec
 * #283 asks for: every
 * decision the feature makes is testable without the application running.
 */

/** A sequence made the ordinary way, for a case that needs one. */
function someSequence(name: string, existing: readonly Sequence[] = []): Sequence {
	return createSequence(name, [" ", "x"], existing);
}

describe("what a sequence is made of", () => {
	it("carries a generated id, the typed name and the symbols in order", () => {
		const sequence = createSequence("Reading", ["?", "!", "i"], []);

		expect(sequence.name).toBe("Reading");
		expect(sequence.symbols).toEqual(["?", "!", "i"]);
		expect(sequence.id.length).toBeGreaterThan(0);
	});

	it("keeps the symbols as given rather than sharing the caller's array", () => {
		// The settings screen edits its own list in place, and a sequence that
		// held that same array would change under everything already reading it.
		const symbols = ["?", "!"];
		const sequence = createSequence("Reading", symbols, []);
		symbols.push("i");

		expect(sequence.symbols).toEqual(["?", "!"]);
	});

	it("refuses a symbol at the moment the sequence is made", () => {
		expect(() => createSequence("Broken", [" ", "]"], [])).toThrow(/"\]"/);
	});
});

describe("where a sequence's id comes from", () => {
	it("is not derived from the name: two sequences named the same differ", () => {
		// The defect this replaces. The old plugin slugified the name, so two
		// sequences called the same thing had one id between them — and one
		// hotkey.
		const first = someSequence("Task flow");
		const second = someSequence("Task flow", [first]);

		expect(second.id).not.toBe(first.id);
	});

	it("does not change when the sequence is renamed", () => {
		const sequence = someSequence("Reading");
		const renamed: Sequence = { ...sequence, name: "Annotations" };

		expect(renamed.id).toBe(sequence.id);
		expect(commandIdFor(renamed, "forward")).toBe(commandIdFor(sequence, "forward"));
	});

	it("is unique among the ids already stored, however many there are", () => {
		const made: Sequence[] = [];
		for (let n = 0; n < 200; n += 1) made.push(someSequence("Same name", made));

		const ids = made.map((sequence) => sequence.id);
		expect(new Set(ids).size).toBe(200);
	});

	it("steps past an id already taken rather than handing it out twice", () => {
		// The draw is random, so the collision has to be staged: with the draw
		// held still, every call answers the same thing and the way out is what
		// is left to see. It is the branch nothing else here can reach, because
		// in ordinary use it never runs.
		const held = vi.spyOn(Math, "random").mockReturnValue(0.5);
		try {
			const drawn = newSequenceId([]);

			expect(newSequenceId([drawn])).toBe(`${drawn}-2`);
			expect(newSequenceId([drawn, `${drawn}-2`])).toBe(`${drawn}-3`);
		} finally {
			held.mockRestore();
		}
	});

	it("never draws an id a shipped sequence already carries", () => {
		// A shipped id is written out and a drawn one is base-36 with a fixed
		// length, so the two sets cannot meet. Without that, a person creating
		// enough sequences could be handed *Task flow*'s hotkey.
		const shipped = DEFAULT_SEQUENCES.map((sequence) => sequence.id);
		for (let n = 0; n < 50; n += 1) expect(shipped).not.toContain(newSequenceId([]));
	});
});

describe("the command id a sequence produces", () => {
	it("reads checkbox-cycling:<sequence-id>:forward and :backward", () => {
		const sequence: Sequence = { id: "abc123def456", name: "Reading", symbols: [" ", "x"] };

		expect(commandIdFor(sequence, "forward")).toBe("checkbox-cycling:abc123def456:forward");
		expect(commandIdFor(sequence, "backward")).toBe("checkbox-cycling:abc123def456:backward");
	});

	it("puts the feature's own id in front, which the core does not add", () => {
		expect(FEATURE_ID).toBe("checkbox-cycling");
		expect(commandIdFor(DEFAULT_SEQUENCES[0], "forward").startsWith(`${FEATURE_ID}:`)).toBe(true);
	});

	it("gives two sequences four different command ids whatever they are named", () => {
		const first = someSequence("Task flow");
		const second = someSequence("Task flow", [first]);

		const ids = [
			commandIdFor(first, "forward"),
			commandIdFor(first, "backward"),
			commandIdFor(second, "forward"),
			commandIdFor(second, "backward"),
		];

		expect(new Set(ids).size).toBe(4);
	});

	it("gives one sequence two different ids, one per direction", () => {
		const sequence = someSequence("Reading");

		expect(commandIdFor(sequence, "forward")).not.toBe(commandIdFor(sequence, "backward"));
	});
});

describe("the two shipped sequences", () => {
	it("are exactly two, named and ordered as the old plugin had them", () => {
		// Byte-identical to `checkbox-cycler`'s own defaults, and that is a
		// constraint: while both plugins are installed the old copying reads
		// exactly these characters, which is what lets the changeover be undone
		// with one keystroke.
		expect(DEFAULT_SEQUENCES).toHaveLength(2);
		expect(DEFAULT_SEQUENCES[0].name).toBe("Task flow");
		expect(DEFAULT_SEQUENCES[0].symbols).toEqual([" ", "/", ">", "x", "-"]);
		expect(DEFAULT_SEQUENCES[1].name).toBe("Annotations");
		expect(DEFAULT_SEQUENCES[1].symbols).toEqual(["?", "!", "i", "I", "*", "b"]);
	});

	it("carry ids of their own, so a rename never costs a hotkey", () => {
		const ids = DEFAULT_SEQUENCES.map((sequence) => sequence.id);

		expect(new Set(ids).size).toBe(2);
		for (const id of ids) expect(id.length).toBeGreaterThan(0);
	});

	it("hold only symbols the feature would accept", () => {
		for (const sequence of DEFAULT_SEQUENCES) {
			for (const symbol of sequence.symbols) expect(symbolRefusal(symbol)).toBeNull();
		}
	});

	it("suggest no symbols beyond the two sequences themselves", () => {
		// The old plugin offers the Minimal theme's twenty-two characters, and
		// seventeen of them draw as a bare letter under every other theme, so no
		// pool ships here. These eleven are all the characters this feature puts
		// in front of anybody.
		const everySymbol = ([] as string[]).concat(
			...DEFAULT_SEQUENCES.map((sequence) => [...sequence.symbols]),
		);

		expect(everySymbol).toHaveLength(11);
	});
});

describe("what a symbol may be", () => {
	it("refuses a closing bracket and says which character and why", () => {
		const refusal = symbolRefusal("]");

		expect(refusal).toContain('"]"');
		expect(refusal).toContain("brackets");
	});

	it("refuses a line break, both ways of writing one, and says why", () => {
		for (const symbol of ["\n", "\r", "\r\n", "a\nb"]) {
			expect(symbolRefusal(symbol)).toContain("line break");
		}
		expect(symbolRefusal("\n")).toContain("neither half");
	});

	it("refuses nothing at all, and more than one character", () => {
		expect(symbolRefusal("")).toContain("empty");
		expect(symbolRefusal("ab")).toContain("more than one");
		expect(symbolRefusal("ab")).toContain('"ab"');
	});

	it("accepts every other single character, a tab included", () => {
		// A tab is deliberate rather than an oversight: `editTaskField` accepts it
		// because the core's reader does, and a character the reader accepts has
		// to stay one the writer can put back.
		const accepted = [" ", "\t", "x", "/", ">", "-", "?", "!", "i", "I", "*", "b", "[", "|", "%"];
		for (const symbol of accepted) expect(symbolRefusal(symbol)).toBeNull();
	});

	it("refuses exactly what the core refuses, character for character", () => {
		// The point of #348: two places used to decide this and nothing compared
		// them. A character that starts being refused on one side alone fails here
		// rather than on the day somebody presses the key.
		const table = ["]", "\n", "\r", "\t", "[", "|", "", "ab", "\u{1F525}", " ", "x"];

		for (const symbol of table) {
			expect([symbol, symbolRefusal(symbol) === null]).toEqual([symbol, mayBeCheckbox(symbol)]);
		}
	});

	it("keeps the writer and the screen agreeing about a tab and about an emoji", () => {
		for (const symbol of ["\t", "\u{1F525}"]) {
			expect(symbolRefusal(symbol)).toBeNull();
			expect(editTaskField("- [ ] Task", "checkbox", symbol)).toBe(`- [${symbol}] Task`);
		}
	});

	it("leaves the condition itself in one file under src", () => {
		// The sentences stay here, because this is the only place a person can be
		// told why. What may sit between the brackets is stated once, in the core,
		// and this file asks rather than repeats it.
		//
		// The filter was one exact spelling until
		// #417 — the spread and
		// the length read on one line, one space each side of the operator, and one
		// of two operators — so a restatement written `Array.from(s).length !== 1`,
		// or `Array.from(s.trim()).length !== 1`, or with different spacing, passed
		// it in silence. It now asks the shared matcher, which reads any such count
		// of a string's code points against the number one — the spread or
		// `Array.from` call itself must sit on one line, but the `.length`, the
		// operator and the number after it may wrap.
		//
		// `s.length > 1` is *not* on that list, and the matcher refuses it on
		// purpose: `.length` on a string counts UTF-16 units, so an emoji answers
		// two. Writing it is a wrong restatement of the rule rather than another
		// spelling of it, and this guard does not name a file for it.
		//
		// **What it still does not see: a spread bound to a name and read on a
		// later line.** `symbolRefusal` in `src/features/checkboxCycling/sequences.ts`
		// is written that way — `const points = [...symbol];`, then `points.length`
		// below — and is therefore absent from this list whichever way the
		// condition is spelled there. That is permitted by
		// #348, which left that
		// function choosing which sentence a person reads while `mayBeCheckbox`
		// decides. Reaching it needs a multi-line or syntax-tree read, which #417
		// rejected: the limit is written down instead, here and on the matcher.
		const deciders = shippedSources()
			.filter(({ source }) => statesCodePointCount(withoutComments(source)))
			.map(({ path }) => path);

		expect(deciders).toEqual(["src/core/taskLine.ts"]);
	});

	it("accepts one character that is written as two, and refuses two that are", () => {
		// A code point rather than a UTF-16 unit. An emoji is one character to
		// the person and two units to JavaScript's `length`.
		expect(symbolRefusal("\u{1F525}")).toBeNull();
		expect(symbolRefusal("\u{1F525}\u{1F525}")).toContain("more than one");
	});
});

describe("whether the feature has enough to do anything", () => {
	it("is ready when one sequence holds two symbols", () => {
		const sequences: Sequence[] = [{ id: "a", name: "Reading", symbols: [" ", "x"] }];

		expect(sequencesReadiness(sequences)).toEqual({ state: "ready" });
	});

	it("is ready on the shipped defaults, so a fresh install works at once", () => {
		expect(sequencesReadiness(DEFAULT_SEQUENCES)).toEqual({ state: "ready" });
	});

	it("is ready when only one of several sequences is long enough", () => {
		const sequences: Sequence[] = [
			{ id: "a", name: "Empty", symbols: [] },
			{ id: "b", name: "Lonely", symbols: ["x"] },
			{ id: "c", name: "Reading", symbols: [" ", "x"] },
		];

		expect(sequencesReadiness(sequences)).toEqual({ state: "ready" });
	});

	it("is not configured, with a reason, when no sequence can step anywhere", () => {
		const sequences: Sequence[] = [
			{ id: "a", name: "Empty", symbols: [] },
			{ id: "b", name: "Lonely", symbols: ["x"] },
		];
		const readiness = sequencesReadiness(sequences);

		expect(readiness.state).toBe("unconfigured");
		expect(readiness.state === "unconfigured" && readiness.reason).toContain("second symbol");
	});

	it("is not configured when there are no sequences at all", () => {
		expect(sequencesReadiness([]).state).toBe("unconfigured");
	});

	it("is not configured when a sequence holds the same symbol twice and nothing else", () => {
		// Two symbols, and a press would still write the character already there.
		// Counting the symbols called this ready and then nothing happened, with
		// nothing said.
		const sequences: Sequence[] = [{ id: "a", name: "Twice over", symbols: ["x", "x"] }];
		const readiness = sequencesReadiness(sequences);

		expect(readiness.state).toBe("unconfigured");
		expect(readiness.state === "unconfigured" && readiness.reason).toContain("second symbol");
	});

	it("is ready when a sequence repeats a symbol but holds two different ones", () => {
		// The repeat costs it the places after the repeat, not the feature: the
		// press still steps between " " and "x", so there is something to do.
		const sequences: Sequence[] = [{ id: "a", name: "Folded", symbols: [" ", "x", " ", "/"] }];

		expect(sequencesReadiness(sequences)).toEqual({ state: "ready" });
	});
});

describe("where a sequence folds back on itself", () => {
	it("has nothing to report when every symbol differs", () => {
		expect(repeatedSymbol({ id: "a", name: "Reading", symbols: [" ", "x", "/"] })).toBeNull();
		for (const shipped of DEFAULT_SEQUENCES) expect(repeatedSymbol(shipped)).toBeNull();
	});

	it("names the repeated symbol and both of its positions", () => {
		// The reproduction on #425. The row the settings screen will draw says
		// the symbols after the repeat cannot be reached, and this is what it
		// says it from.
		expect(repeatedSymbol({ id: "a", name: "Folded", symbols: [" ", "x", " ", "/"] })).toEqual({
			symbol: " ",
			firstAt: 0,
			repeatedAt: 2,
		});
	});

	it("reports the first repeat rather than a later one", () => {
		// Everything after the first repeat is already off the walked order, so a
		// second repeat beyond it changes nothing a person could see.
		expect(repeatedSymbol({ id: "a", name: "Twice twice", symbols: ["a", "b", "b", "a"] })).toEqual({
			symbol: "b",
			firstAt: 1,
			repeatedAt: 2,
		});
	});

	it("has nothing to report about a sequence too short to fold", () => {
		expect(repeatedSymbol({ id: "a", name: "Empty", symbols: [] })).toBeNull();
		expect(repeatedSymbol({ id: "b", name: "Lonely", symbols: ["x"] })).toBeNull();
	});
});

describe("what came across from the old plugin", () => {
	/** Every shipped file this feature has added, by path and by its text. */
	const featureSources = shippedSources().filter(({ path }) =>
		path.indexOf("src/features/checkboxCycling/") >= 0,
	);

	it("reads the feature's own files rather than none", () => {
		expect(featureSources.length).toBeGreaterThan(0);
	});

	it("carries no path, no person's name and no address out of that repository", () => {
		// The seventh acceptance box of #322, made checkable. The old repository
		// was read for its code alone — `constants.ts`, `types.ts` and `cycle.ts`
		// — and only the two symbol arrays and the two names were copied. Its
		// documents are unreviewed and came across not at all.
		//
		// The person's name is read from the manifest's author field rather
		// than spelled here, so this guard does not itself carry the name into
		// the public copy, and both parts of the name are checked.
		const author = JSON.parse(readFileSync(resolve(repoRoot, "manifest.json"), "utf8")).author as string;
		const names = author.split(" ");
		expect(names.length).toBeGreaterThanOrEqual(2);
		for (const { path, source } of featureSources) {
			expect(`${path}: ${source}`).not.toContain("/home/");
			for (const name of names) expect(`${path}: ${source}`).not.toContain(name);
			expect(`${path}: ${source}`).not.toContain("C:\\");
		}
	});

	it("keeps none of the old plugin's own names for things", () => {
		// Its acceptance-criterion numbers (`AC-4`), its `CheckboxSymbol` labels
		// and its `slugify` are the three shapes a copied line would show up as.
		for (const { path, source } of featureSources) {
			expect(`${path}: ${source}`).not.toContain("slugify");
			expect(`${path}: ${source}`).not.toContain("SYMBOL_POOL");
			expect(source).not.toMatch(/\bAC-\d+\b/);
		}
	});
});

describe("what the barrel hands the rest of the plugin", () => {
	/**
	 * Nothing outside this feature imports `index.ts` yet — the settings screen
	 * that will is #326 and
	 * #327 — so a function
	 * added to `sequences.ts` and forgotten in the barrel breaks no test and no
	 * build. It just cannot be reached, and the ticket that added it looks
	 * finished. `repeatedSymbol` arrived that way in wave 3 of the board run of
	 * 2026-09-08: the
	 * worker could not write the barrel line, because the file belonged to no
	 * worker that wave, and no test would have said so. This is that test.
	 *
	 * It names the exports rather than counting them, so adding one deliberately
	 * means adding it here too and a reader can see what the screen is promised.
	 */
	it("re-exports every sequence function the settings screen will need", () => {
		for (const name of [
			"DEFAULT_SEQUENCES",
			"FEATURE_ID",
			"commandIdFor",
			"createSequence",
			"newSequenceId",
			"repeatedSymbol",
			"sequencesReadiness",
			"symbolRefusal",
		] as const) {
			expect([name, name in barrel]).toEqual([name, true]);
		}
	});

	it("hands out the same function the module does, not a copy", () => {
		expect(barrel.repeatedSymbol).toBe(repeatedSymbol);
		expect(barrel.sequencesReadiness).toBe(sequencesReadiness);
	});
});
