/**
 * The two pieces the source-reading guards share and read source *with*: the
 * comment stripper, and the quoted-string sub-pattern they splice into their
 * own matchers.
 *
 * Both are tested on their own because a hole in either is invisible in every
 * suite that uses them: the sweep reports clean on text it never read, and a
 * green run is what a hole looks like from the outside. Issue
 * #264 was exactly that —
 * `withoutComments` cut a line at the first `//` wherever it sat, so a string
 * holding one was halved and every string after it on that line was lost.
 *
 * Every guard that reads this repository's own source depends on the stripper,
 * and two of them now depend on the sub-pattern as well, which is why both are
 * driven here rather than through whichever guard someone happened to open.
 * How many there are is deliberately not written down — see the module's own
 * docstring, and issue
 * #312.
 */

import { describe, expect, it } from "vitest";
import {
	apiFloors,
	baselineFloor,
	quotedLiteral,
	requiredFloor,
	statesCodePointCount,
	statesPattern,
	withoutComments,
} from "./sourceGuards";

describe("withoutComments keeps string literals whole", () => {
	it("leaves a `//` inside a string, and every string after it on the line", () => {
		const source = 'new Notice("Use // for a comment.");\nnew Notice("A calendar event.");';

		expect(withoutComments(source)).toBe(source);
	});

	it("reads all three quote styles", () => {
		const source = ['const a = "a // b";', "const b = 'c // d';", "const c = `e // f`;"].join("\n");

		expect(withoutComments(source)).toBe(source);
	});

	it("keeps a literal open across an escaped quote of its own kind", () => {
		// Without the escape rule the literal would be read as closing at the
		// `\"`, and the `//` after it as the start of a comment.
		const source = 'const a = "she said \\" // and meant it";';

		expect(withoutComments(source)).toBe(source);
	});

	it("leaves a URL in a string alone, which is what the old colon rule was for", () => {
		const source = 'const home = "https://obsidian.md/plugins";';

		expect(withoutComments(source)).toBe(source);
	});
});

describe("withoutComments still removes comments", () => {
	it("cuts a real comment at the end of a line of code", () => {
		expect(withoutComments("const a = 1; // why\nconst b = 2;")).toBe("const a = 1; \nconst b = 2;");
	});

	it("cuts a whole-line comment, URL and all", () => {
		expect(withoutComments("// see https://obsidian.md\nconst a = 1;")).toBe("\nconst a = 1;");
	});

	it("takes a block comment whole", () => {
		expect(withoutComments("const a = 1;\n/**\n * A note.\n */\nconst b = 2;")).toBe(
			"const a = 1;\n\nconst b = 2;",
		);
	});

	it("takes a block comment out of the middle of a line", () => {
		expect(withoutComments("const a = 1; /* a note */ const b = 2;")).toBe(
			"const a = 1;  const b = 2;",
		);
	});
});

/*
 * Issue #243. `requiredFloor` used to run each `apiFloors` pattern over the raw
 * text it was handed, so a comment naming a floored API raised `minAppVersion`
 * and `manifest.test.ts` then demanded a floor the code does not need. It strips
 * inside itself rather than at its call sites: it is a plain function of its two
 * arguments and stays one, and every caller gets the rule without repeating it.
 */
describe("the version floor is read off code, not off prose", () => {
	it("stays at the baseline when the only mention of a floored API is a comment", () => {
		const prose = [
			"// This module does not use secretStorage, and never calls isDarkMode()",
			"// either. renderContext is another one it leaves alone.",
			"export const ok = 1;",
		].join("\n");

		expect(requiredFloor([prose], apiFloors)).toBe(baselineFloor);
	});

	it("stays at the baseline for a block comment whose body sits in column zero", () => {
		const prose = ["/*", "secretStorage is not called here.", "*/", "export const ok = 1;"].join("\n");

		expect(requiredFloor([prose], apiFloors)).toBe(baselineFloor);
	});

	it("still raises the floor for the same API in code, so the strip is not blindness", () => {
		expect(requiredFloor(["await this.app.secretStorage.get(name); // secretStorage"], apiFloors)).toBe(
			"1.11.4",
		);
	});
});

describe("what withoutComments still cannot see", () => {
	// Both of these are named in the function's own doc comment. They are
	// tested so the next reader meets the limit as behaviour rather than as a
	// promise, and so a future widening has something to turn green.
	it("cuts a `//` on the second line of a template literal, because it reads one line at a time", () => {
		const source = "const a = `first\nsecond // third`;";

		expect(withoutComments(source)).toBe("const a = `first\nsecond ");
	});

	it("starts a block comment on a string that holds its opener", () => {
		const source = 'const a = "/*";\nconst b = 2;\nconst c = "*/";';

		expect(withoutComments(source)).toBe('const a = "";');
	});
});

describe("quotedLiteral is the one home for the escape rule", () => {
	// Two guards need the same small piece of knowledge — how a quoted string is
	// written, escapes included — and each spelled it out its own way until this
	// helper. The escape handling is the part that is easy to get subtly
	// different, and one of the two had a whole quote style missing until issue
	// #266 with nothing to say so. It is driven here, on its own, for the reason
	// `withoutComments` above is: a hole in it is a guard reading less than it
	// reports.
	const contentsOf = (quote: string, source: string): string | undefined =>
		new RegExp(quotedLiteral(quote, quote, "capture")).exec(source)?.[1];

	it("reads all three quote styles and hands back the contents", () => {
		expect(contentsOf('"', 'new Notice("A calendar event.");')).toBe("A calendar event.");
		expect(contentsOf("'", "new Notice('A calendar event.');")).toBe("A calendar event.");
		expect(contentsOf("`", "new Notice(`A calendar event.`);")).toBe("A calendar event.");
	});

	it("reads a literal whole across an escaped quote of its own style", () => {
		// Without the escape rule each of these is cut in half at the escape, and
		// the sweep reads a sentence that was never written.
		expect(contentsOf('"', 'new Notice("she said \\" and meant it");')).toBe(
			'she said \\" and meant it',
		);
		expect(contentsOf("'", "new Notice('she said \\' and meant it');")).toBe(
			"she said \\' and meant it",
		);
		expect(contentsOf("`", "new Notice(`she said \\` and meant it`);")).toBe(
			"she said \\` and meant it",
		);
	});

	it("stops at the closing quote rather than running on to the next literal", () => {
		expect(contentsOf('"', 'addClass("effortless-a", "effortless-b");')).toBe("effortless-a");
	});

	it("captures nothing when asked to skip, so a caller's group numbers hold", () => {
		// This is the stylesheet guard's need: it reads its own groups by number,
		// so a group added inside this sub-pattern would silently shift them. The
		// quote is captured by the caller's own class, and referred to by the
		// caller's own number.
		const anyQuote = new RegExp(
			String.raw`\(\s*` + quotedLiteral(String.raw`(["'\`])`, String.raw`\1`, "skip"),
		);
		const hit = anyQuote.exec("addClass('effortless-a')");

		expect(hit?.[0]).toBe("('effortless-a'");
		expect(hit).toHaveLength(2);
	});

	it("still works when the caller's backreference is not group 1", () => {
		// The stylesheet guard's is group 3. A backreference is why `close` is
		// spliced in as text rather than derived from `open`.
		const pattern = new RegExp(
			String.raw`(a)(b)` + quotedLiteral(String.raw`(["'\`])`, String.raw`\3`, "skip"),
		);

		expect(pattern.exec('ab"she said \\" and meant it"')?.[0]).toBe(
			'ab"she said \\" and meant it"',
		);
	});
});

/**
 * `statesPattern` is only worth having if it recognises the rule rather than
 * the characters that spell it.
 *
 * Each case hands it a scrap of source rather than a real file, because a
 * guard that says "this file is clean" cannot show what it would catch. The
 * scraps are written the way a copy of the format would arrive: as a regex
 * somebody wrote out for themselves.
 */
describe("a character class is judged by its members, not by the order they were typed in", () => {
	it("sees the marker set in every order its three members can be written", () => {
		// Four orders, not six: a dash is a member only at one end of the class or
		// the other, and in the middle it is a range. `[*-+]` is the range from
		// `*` to `+`, which is a different rule and is checked below.
		for (const spelling of ["[-*+]", "[-+*]", "[*+-]", "[+*-]"]) {
			expect(statesPattern(`const MARKER = /^\\s*${spelling}\\s/u;`, "[-*+]")).toBe(true);
		}
	});

	it("reads a dash in the middle of a class as the range it is", () => {
		// So the guard does not fire on a class that only looks like the marker
		// set: `[*-+]` holds `*` and `+` and no dash at all.
		expect(statesPattern("const M = /[*-+]/u;", "[-*+]")).toBe(false);
		expect(statesPattern("const L = /[a-z]/u;", "[-az]")).toBe(false);
	});

	it("sees the numbered-item pattern with its two members either way round", () => {
		expect(statesPattern(String.raw`const N = /^\s*\d+[.)]\s/u;`, String.raw`\d+[.)]`)).toBe(true);
		expect(statesPattern(String.raw`const N = /^\s*\d+[).]\s/u;`, String.raw`\d+[.)]`)).toBe(true);
	});

	it("sees the bracket pattern whether the bracket is escaped or bare", () => {
		expect(statesPattern(String.raw`const B = /\[[^\]]*\]/u;`, String.raw`[^\]]`)).toBe(true);
		expect(statesPattern(String.raw`const B = /\[[^]]*\]/u;`, String.raw`[^\]]`)).toBe(true);
	});

	it("sees the fence and heading counts, which are repetitions rather than classes", () => {
		expect(statesPattern("const F = /^ {0,3}(`{3,}|~{3,})/u;", "`{3,}")).toBe(true);
		expect(statesPattern("const F = /^ {0,3}(`{3,}|~{3,})/u;", "~{3,}")).toBe(true);
		expect(statesPattern("const H = /^ {0,3}#{1,6}(\\s|$)/u;", "#{1,6}")).toBe(true);
	});

	it("does not fire on a class that is a different rule", () => {
		expect(statesPattern("const M = /[-*]/u;", "[-*+]")).toBe(false);
		expect(statesPattern("const M = /[-*+=]/u;", "[-*+]")).toBe(false);
		expect(statesPattern(String.raw`const B = /[^)]/u;`, String.raw`[^\]]`)).toBe(false);
		expect(statesPattern(String.raw`const N = /\d+[.,]/u;`, String.raw`\d+[.)]`)).toBe(false);
	});

	it("tells a negated class from the class it negates", () => {
		expect(statesPattern(String.raw`const B = /[\]]/u;`, String.raw`[^\]]`)).toBe(false);
		expect(statesPattern(String.raw`const B = /[^\]]/u;`, String.raw`[\]]`)).toBe(false);
	});

	it("leaves a comment naming the rule alone, because comments are stripped first", () => {
		// Issue #243's lesson,
		// and the reason a guard reading real source strips comments with
		// `withoutComments(...)` before matching, rather than reading the file as
		// it stands: a correct note about the rule must not fail the rule. Every
		// spelling in this suite sits in a comment somewhere.
		expect(statesPattern(withoutComments("// the marker set is [-+*]\nconst a = 1;"), "[-*+]")).toBe(
			false,
		);
	});

	it("does not read an array type as a class", () => {
		// `readonly LineKind[]` and `= []` are the two shapes that would otherwise
		// open a class and swallow the rest of the line, taking a real restatement
		// on that line down with them.
		//
		// Both cases go through `statesPattern`: the normaliser it wraps,
		// `normalisedClasses`, is private to `sourceGuards.ts`, so `statesPattern`
		// is the only way in. The claim is unchanged and the second case is the
		// stronger reading of it: the restatement sits on the same line as the
		// array type, so a normaliser that swallowed the array type would take
		// the restatement with it and this would answer `false`.
		expect(statesPattern("const answers: LineKind[] = []; const M = /[-+*]/u;", "[-*+]")).toBe(
			true,
		);
		expect(statesPattern("const answers: LineKind[] = [];\nconst M = /[-+*]/u;", "[-*+]")).toBe(true);
		expect(statesPattern("const answers: LineKind[] = [];", "[-*+]")).toBe(false);
	});
});

/**
 * The one-code-point condition, recognised however it is spelled on one line.
 *
 * Every case hands the matcher a scrap of source rather than a real file,
 * because a guard that says "the tree is clean" cannot show what it would
 * catch. The scraps are written the way a restatement would actually arrive:
 * somebody counting a string's characters for themselves.
 */
describe("a code-point count is recognised however it is written", () => {
	it("sees the spelling the guard was keyed to before it was widened", () => {
		expect(statesCodePointCount("if ([...s].length !== 1) return null;")).toBe(true);
		expect(statesCodePointCount("if ([...s].length === 1) return null;")).toBe(true);
	});

	it("sees it with no whitespace around the operator, and with plenty", () => {
		// The old filter wanted exactly one space each side. Neither of these is
		// a different rule; both were invisible to it.
		expect(statesCodePointCount("if ([...s].length!==1) return null;")).toBe(true);
		expect(statesCodePointCount("if ([...s].length  >  1) return null;")).toBe(true);
	});

	it("sees the other way a string is taken apart into code points", () => {
		expect(statesCodePointCount("if (Array.from(s).length !== 1) return null;")).toBe(true);
		expect(statesCodePointCount("const n = Array.from(symbol).length;\nif (n > 1) {}")).toBe(false);
	});

	it("sees every comparison operator, not the two it was keyed to", () => {
		for (const operator of ["===", "!==", "==", "!=", "<", "<=", ">", ">="]) {
			expect(statesCodePointCount(`if ([...s].length ${operator} 1) {}`)).toBe(true);
		}
	});

	it("does not fire on a length that is not a code-point count", () => {
		// The whole value of the guard this feeds is that it names one file. A
		// count of something else, or of a string by UTF-16 units, is a different
		// rule and is not this one.
		expect(statesCodePointCount("if (points.length > 1) return null;")).toBe(false);
		expect(statesCodePointCount("if (symbol.length !== 1) return null;")).toBe(false);
		expect(statesCodePointCount("const all = [...seen];\nif (all.length > 1) {}")).toBe(false);
	});

	it("does not read a count against a name as a count against a number", () => {
		// The rule is one code point, and the number is what says so. A comparison
		// against something else is a different claim.
		expect(statesCodePointCount("if ([...s].length !== limit) {}")).toBe(false);
	});

	it("does not let the spread or the call run past its own expression", () => {
		// Neither half may cross a newline, so a spread on one line and a length
		// read further down the file cannot be glued into a false match.
		expect(statesCodePointCount("const points = [...symbol];\nif (points.length > 1) {}")).toBe(
			false,
		);
	});

	it("reads a call or an index inside the spread or the brackets", () => {
		// The contents used to stop at the first bracket of any kind, so a
		// restatement that took the string apart from a call or an index passed in
		// silence. One level of nesting is now read.
		expect(statesCodePointCount("if (Array.from(symbol.trim()).length !== 1) {}")).toBe(true);
		expect(statesCodePointCount("if (Array.from(new Set(x)).length > 1) {}")).toBe(true);
		expect(statesCodePointCount("if ([...symbol[0]].length !== 1) {}")).toBe(true);
	});

	it("stops at one level of nesting, which is the limit its docstring states", () => {
		// Two levels deep is not read. The limit is written down beside the
		// multi-line one rather than chased.
		expect(statesCodePointCount("if (Array.from(new Set(codePointsOf(x))).length > 1) {}")).toBe(
			false,
		);
	});

	it("does not read a count against a number that is not one", () => {
		// The rule is *one* code point, and the number is what says so. Spreading
		// an array and reading its length is the same shape and a different claim.
		expect(statesCodePointCount("if ([...lines].length > 0) {}")).toBe(false);
		expect(statesCodePointCount("const n = [...x].length >= 2;")).toBe(false);
		expect(statesCodePointCount("const n = [...this.own.read().sequences].length >= 2;")).toBe(
			false,
		);
		expect(statesCodePointCount("if ([...s].length !== 10) {}")).toBe(false);
		expect(statesCodePointCount("if ([...s].length > 1.5) {}")).toBe(false);
	});
});
