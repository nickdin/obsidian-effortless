import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { everyFileOnDisk, shippedSources, testFolder, withoutComments } from "./sourceGuards";

/**
 * The plugin must not ask what device it is on by reading a Node global, and
 * must not ask at all while a module is still loading.
 *
 * `process` does not exist on Obsidian mobile. Reading it as a module loads
 * throws before any feature is constructed, which takes the whole plugin down
 * rather than the one feature that cared — the failure the registry's
 * per-feature catch exists to prevent, arriving too early for it to help.
 * Obsidian's own `Platform` object is the only route, and it is asked inside
 * `readiness()`, at every plugin start.
 *
 * The walk that finds the shipped files, and the second independent listing
 * that cross-checks it, live in `./sourceGuards` — the same two functions the
 * `minAppVersion` guard in `manifest.test.ts` reads the tree with. They used to
 * be declared once in each file and exported from neither. What
 * stays here is what this file is about: the patterns.
 */

/**
 * Statements that run as the module loads. A line that starts in column zero
 * and is not an import is top level; anything indented sits inside a function
 * or a class body, which does not run until something calls it.
 *
 * Column zero is the whole test. A letter-and-`@` allowlist missed a line
 * opening with `(`, `_`, `$` or `{`, all of which run just as early.
 *
 * Comments are dropped, because a comment runs nothing. This repo writes
 * one-line doc comments in column zero as its normal idiom, so without this the
 * most natural sentence anyone could write about this guard — that `Platform`
 * is asked inside `readiness()` and nowhere else — would fail it, and the only
 * way past a correct comment would be to weaken the test.
 *
 * They are dropped by `withoutComments` in `./sourceGuards`, the one place this
 * repository answers what a guard reads. This function used to drop them line by
 * line, with its own `/^\s*(\/\/|\/\*|\*)/`, and that filter cannot see a
 * `/* … *\/` comment whose body lines sit in column zero — the sentence above,
 * written that way, reached the `Platform` assertion and failed the suite. A second answer to
 * one question is the defect these guards exist to catch, so there is now one.
 */
function topLevelStatements(source: string): string[] {
	return withoutComments(source)
		.split("\n")
		.filter((line) => /^\S/.test(line) && !line.startsWith("import "));
}

/**
 * The Node-only reads that do not exist on Obsidian mobile, and the files that
 * make them.
 *
 * Seven patterns, and four of them arrived from `icsReader.test.ts`, which kept
 * its own copy of this rule over a hand-written list of two filenames. Neither
 * guard contained the other: the four below reach an import from `node:`, any
 * `process.` member rather than three named ones, any `require(` rather than
 * `os` alone, and `__dirname`; the walk here reaches `navigator.userAgent` and
 * every shipped file rather than two. The union of both, over the whole tree,
 * is what stands now — and the two-filename list is gone, so nobody adds a
 * third name to it believing that is where the platform rule lives.
 */
const nodeGlobals = [
	/\bprocess\s*\./,
	/\brequire\(/,
	/from\s+["']node:/,
	/\b__dirname\b/,
	/\bnavigator\s*\.\s*userAgent\b/,
];

/**
 * Comments are stripped first, because a comment runs nothing. Every pattern
 * above is ordinary English somewhere — a sentence ending "… the rehaul
 * process." matches the first — so a correct note about the rule used to fail
 * the rule, and the only way past it was to weaken the test.
 */
function nodeGlobalReaders(files: Array<{ path: string; source: string }>): string[] {
	return files
		.filter(({ source }) => nodeGlobals.some((global) => global.test(withoutComments(source))))
		.map(({ path }) => path);
}

/**
 * Everything a shipped file may not write, because it arrived after the ES2018
 * floor `tsconfig.json` states. The compiler should be the one to catch these
 * and is not: `"types": ["node"]` pulls newer library declarations in behind
 * the stated `lib`, so this list stands in for it. The author decided on
 * 2026-09-07 that it stays a test rather than a compiler setting — narrowing
 * `types` costs a nine-file rewrite and a two-pass build for a guard this gives
 * cheaply.
 *
 * The list lives here, checked against the whole-tree walk rather than in one
 * module's own test file, so that a module added tomorrow is covered the day it
 * arrives.
 *
 * **Every entry but the last is a library call, and the last is syntax.** That
 * is the exception rather than the rule, and it has a reason: `target` rewrites
 * newer syntax down to the floor by itself, so syntax normally needs no guard —
 * but the contents of a regular-expression literal are a runtime value the
 * compiler never rewrites, so a lookbehind written in one ships exactly as
 * typed. It is the construct the floor exists for: Obsidian names iOS below
 * 16.4 as the version that cannot run one
 * (`docs/research/obsidian-publishing-requirements.md`, "Mobile support"), and
 * issue #68's brief cites it as the reason the floor matters at all. It was
 * guarded until issue #209 by two assertions each reading one named file, which
 * left every other shipped module free to add one — and every module added
 * afterwards free the day it arrived. No count is stated: it would be a count
 * of a tree that no longer exists, it went stale once already, and the argument
 * does not turn on it.
 *
 * **`.at(` is banned on every receiver but one named `collections`.** `Array`
 * and `String.prototype.at` are newer than the floor, and this repository
 * publishes its own `Collections.at(path)` (`src/core/collections.ts`), which
 * is unrelated. The sweep reads text rather than types, so the receiver's name
 * is the whole distinction: a call written `collections.at(` or
 * `this.collections.at(` passes, and `[1, 2].at(0)`, `"ab".at(0)`,
 * `collections.all().at(-1)` and any other receiver still fail. The cost is
 * that an array someone names `collections` is not caught; a caller of
 * `Collections.at` names it that way already, and the guard's fixture tree
 * holds one module for each case.
 *
 * **`(?<=` and `(?<!` alone, not the wider `(?<`.** The wider one also catches
 * a named capture group, `(?<name>…)`, and named groups are ES2018 themselves —
 * banning them would ban something the floor permits. The narrow pattern is the
 * honest one.
 */
const afterTheFloor = [
	/\.flat\s*\(/,
	/\.flatMap\s*\(/,
	/\.trimStart\s*\(/,
	/\.trimEnd\s*\(/,
	/\bObject\s*\.\s*fromEntries\s*\(/,
	/\.matchAll\s*\(/,
	/\bPromise\s*\.\s*allSettled\s*\(/,
	/\bglobalThis\b/,
	/\.replaceAll\s*\(/,
	/\bPromise\s*\.\s*any\s*\(/,
	// Not on a receiver named `collections`: that is this repository's own
	// `Collections.at(path)`, see the note below.
	/(?<!\bcollections)\.at\s*\(/,
	/\bObject\s*\.\s*hasOwn\s*\(/,
	/\.findLast(?:Index)?\s*\(/,
	/\.toSorted\s*\(/,
	/\.toReversed\s*\(/,
	/\.toSpliced\s*\(/,
	/\bObject\s*\.\s*groupBy\s*\(/,
	/\bPromise\s*\.\s*withResolvers\s*\(/,
	// Syntax rather than a library call — see the note above.
	/\(\?<[=!]/,
];

/**
 * Every shipped file holding a call newer than the floor, named with the call it
 * made. Comments are stripped first, for the reason
 * {@link nodeGlobalReaders} gives: `globalThis` and `.at(` are both things a
 * comment says, and `(?<=` is what a comment explaining the lookbehind ban has
 * to quote.
 */
function postFloorCalls(files: Array<{ path: string; source: string }>): string[] {
	const found: string[] = [];
	for (const { path, source } of files) {
		const code = withoutComments(source);
		for (const call of afterTheFloor) {
			const match = call.exec(code);
			if (match) found.push(`${path}: ${match[0]}`);
		}
	}
	return found;
}

/**
 * A source tree shaped like the one the feature spec expects: a feature in its own
 * folder, nested. It is the case the guard has to reach and today does not.
 */
function fixtureTree(): string {
	const root = mkdtempSync(join(tmpdir(), "effortless-platform-"));
	mkdirSync(join(root, "core"), { recursive: true });
	mkdirSync(join(root, "features", "planner"), { recursive: true });
	mkdirSync(join(root, testFolder), { recursive: true });
	writeFileSync(join(root, "main.ts"), "export const ok = 1;\n");
	writeFileSync(join(root, "core", "fine.ts"), "export const alsoOk = 2;\n");
	writeFileSync(join(root, "core", "modern.ts"), "export const flat = [[1], [2]].flatMap((n) => n);\n");
	// Issue #209. A third module, named by no lookbehind assertion ever: the ban
	// used to live in `calendarTable.test.ts` and `taskLine.test.ts`, each
	// reading its own module, so a lookbehind anywhere else shipped green.
	writeFileSync(join(root, "core", "behind.ts"), "export const hour = /(?<=\\d)h/;\n");
	writeFileSync(join(root, "features", "planner", "planner.ts"), "const here = process.platform;\n");
	// Issue #148. Three Node-only reads the guard could not see until the four
	// patterns `icsReader.test.ts` kept privately were folded into the set
	// above. Each file exercises exactly one of them, so a regression names the
	// pattern that stopped working rather than a file that broke somehow.
	writeFileSync(join(root, "features", "planner", "here.ts"), "const dir = __dirname;\n");
	writeFileSync(join(root, "features", "planner", "imported.ts"), 'import { join } from "node:path";\n');
	writeFileSync(join(root, "features", "planner", "required.ts"), 'const path = require("node:path");\n');
	// The one original pattern the four new ones do not subsume, kept in the
	// fixture so the widening cannot quietly drop it.
	writeFileSync(join(root, "features", "planner", "sniffed.ts"), "const ua = navigator.userAgent;\n");
	// Issue #243. Two modules that break no rule and say so in prose. The
	// patterns above are ordinary English in places, so a correct sentence about
	// the rule used to fail the rule, and the only way past it was to weaken the
	// test. One file per guard, so a regression names the guard that stopped
	// stripping rather than a file that broke somehow.
	writeFileSync(
		join(root, "core", "quiet-node.ts"),
		[
			"// Nothing here reads process.platform, calls require( anything, or",
			'// imports from "node:fs". There is no __dirname, and nobody asks',
			"// navigator.userAgent.",
			"export const ok = 3;",
			"",
		].join("\n"),
	);
	writeFileSync(
		join(root, "core", "quiet-floor.ts"),
		[
			"/*",
			"This module calls neither .at( nor globalThis, and writes no lookbehind",
			"(?<= of its own. Its body lines sit in column zero, which is the shape",
			"issue #211 measured.",
			"*/",
			"export const ok = 4;",
			"",
		].join("\n"),
	);
	// Issue #823. `.at(` is banned because `Array` and `String.prototype.at` are
	// newer than the floor, and this repository publishes its own
	// `Collections.at(path)`. One module for each, so a regression names which
	// of the three stopped working: the repository's own method passes, and
	// both language methods still fail.
	writeFileSync(
		join(root, "core", "own-at.ts"),
		'export const found = (collections: { at(path: string): unknown }) => collections.at("a.md");\n',
	);
	writeFileSync(join(root, "core", "array-at.ts"), "export const last = [1, 2].at(0);\n");
	writeFileSync(join(root, "core", "string-at.ts"), 'export const first = "ab".at(0);\n');
	writeFileSync(join(root, "features", "planner", "notes.md"), "not source\n");
	writeFileSync(join(root, testFolder, "planner.test.ts"), "const here = process.platform;\n");
	return root;
}

describe("the guard's own reach", () => {
	const root = fixtureTree();
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	const found = shippedSources(root).map(({ path }) => path.split(sep).join("/"));

	it("reads a file in a nested folder, at any depth", () => {
		expect(found).toContain(`${root}/features/planner/planner.ts`);
	});

	it("reads nothing under the test folder, and nothing that is not TypeScript", () => {
		expect(found.filter((path) => path.includes(`/${testFolder}/`))).toEqual([]);
		expect(found.filter((path) => !path.endsWith(".ts"))).toEqual([]);
	});

	it("fails the Node-global assertion on a nested file that reads process.platform", () => {
		expect(nodeGlobalReaders(shippedSources(root))).toContain(`${root}/features/planner/planner.ts`);
	});

	// Issue #148. Three of these four are what the widened patterns reach and
	// the old three did not: an import from `node:`, a bare `require(` of
	// anything but `os`, and `__dirname`. The fourth, `navigator.userAgent`, is
	// the original pattern that has to survive the widening.
	it("fails it on the files the old three patterns missed, and still on userAgent", () => {
		expect(nodeGlobalReaders(shippedSources(root)).sort()).toEqual([
			`${root}/features/planner/here.ts`,
			`${root}/features/planner/imported.ts`,
			`${root}/features/planner/planner.ts`,
			`${root}/features/planner/required.ts`,
			`${root}/features/planner/sniffed.ts`,
		]);
	});

	it("fails the ES2018-floor assertion on a module that is not the one the guard used to read", () => {
		expect(postFloorCalls(shippedSources(root)).sort()).toEqual([
			`${root}/core/array-at.ts: .at(`,
			`${root}/core/behind.ts: (?<=`,
			`${root}/core/modern.ts: .flatMap(`,
			`${root}/core/string-at.ts: .at(`,
		]);
	});

	// Issue #823. The three cases the narrowing has to keep apart.
	const atCallsIn = (file: string) =>
		postFloorCalls(shippedSources(root)).filter((found) => found.startsWith(`${root}/core/${file}:`));

	it("does not fire on a call to this repository's own Collections.at", () => {
		expect(atCallsIn("own-at.ts")).toEqual([]);
	});

	it("still fires on Array.prototype.at", () => {
		expect(atCallsIn("array-at.ts")).toEqual([`${root}/core/array-at.ts: .at(`]);
	});

	it("still fires on String.prototype.at", () => {
		expect(atCallsIn("string-at.ts")).toEqual([`${root}/core/string-at.ts: .at(`]);
	});

	// Issue #243. Both guards used to test their patterns against the whole file
	// text, comments included, and the patterns are ordinary English in places.
	it("passes a file whose only mention of a Node global is inside a comment", () => {
		expect(nodeGlobalReaders(shippedSources(root))).not.toContain(`${root}/core/quiet-node.ts`);
	});

	it("passes a file whose only mention of a post-floor call is inside a comment", () => {
		expect(
			postFloorCalls(shippedSources(root)).filter((found) =>
				found.startsWith(`${root}/core/quiet-floor.ts`),
			),
		).toEqual([]);
	});
});

describe("what counts as running while the module loads", () => {
	it("counts a top-level statement whatever character it opens with", () => {
		const source = [
			'import { thing } from "./thing";',
			"(function () {})();",
			"_private();",
			"$ready();",
			"{ const scoped = 1; }",
			"\tindented();",
			"  alsoIndented();",
			"// Platform is asked inside readiness() and nowhere else.",
			"/** Platform is asked inside readiness() and nowhere else. */",
			// Issue #211. The two lines below used to be an *unterminated* block
			// comment, which no valid TypeScript file can hold; the line-based
			// filter passed them only because each line happened to open with a
			// comment character. Closed, with the body in column zero, is the
			// shape #211 measured, and it is the one the filter could not see.
			"/*",
			"Platform is asked inside readiness() and nowhere else.",
			"*/",
		].join("\n");

		expect(topLevelStatements(source)).toEqual([
			"(function () {})();",
			"_private();",
			"$ready();",
			"{ const scoped = 1; }",
		]);
	});

	it("still counts a real statement that mentions Platform, so the guard is not blind", () => {
		const source = ["const mobile = Platform.isMobile;", "//const commented = Platform.isMobile;"].join("\n");

		expect(topLevelStatements(source)).toEqual(["const mobile = Platform.isMobile;"]);
	});
});

describe("asking what device this is", () => {
	const sources = shippedSources();

	it("reads every shipped source file, so a short pass cannot look green", () => {
		expect(sources.map((file) => file.path).sort()).toEqual(everyFileOnDisk());
		expect(sources.map((file) => file.path)).toContain("src/main.ts");
	});

	it("never reads a Node global, which does not exist on a phone", () => {
		expect(nodeGlobalReaders(sources)).toEqual([]);
	});

	it("writes nothing newer than the ES2018 floor tsconfig.json states, lookbehind included", () => {
		expect(postFloorCalls(sources)).toEqual([]);
	});

	it("asks nothing platform-dependent while a module is still loading", () => {
		for (const { path, source } of sources) {
			for (const statement of topLevelStatements(source)) {
				expect(`${path}: ${statement}`).not.toContain("Platform");
			}
		}
	});
});
