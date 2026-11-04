/**
 * The one place a caught thrown thing is turned into a sentence.
 *
 * `catch` in TypeScript hands back `unknown`, so every place that has something
 * to say about a failure has to answer the same question first: is this an
 * `Error` with a message, or is it something else entirely? **Six sites
 * answered it** separately and **five of the six answered it worse** — an
 * `Error` whose message is empty read as an empty sentence, so the person was
 * told the name of what failed and then nothing at all. Sites that
 * answered the question is six; sites that answered it worse is five. Each
 * count says which it is, because this file and `src/core/reason.ts` used to
 * carry three numbers between them and no two counted the same thing.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { reasonOf } from "../core/reason";
import { shippedSources, sourceRoot, testFolder, withoutComments } from "./sourceGuards";
import { repoRoot } from "./repoRoot";

describe("reasonOf", () => {
	it("says what an Error says", () => {
		expect(reasonOf(new Error("The file was not there."))).toBe("The file was not there.");
	});

	it("falls back to the thrown thing itself when the message is empty", () => {
		// This is the whole of what the five worse copies got wrong. An `Error` with
		// no message is thrown by code that threw a bare `new Error()`, and a
		// sentence ending in nothing tells the person less than the type name
		// does.
		expect(reasonOf(new Error(""))).toBe("Error");
	});

	it("describes a thrown thing that is not an Error at all", () => {
		expect(reasonOf("no network")).toBe("no network");
		expect(reasonOf(undefined)).toBe("undefined");
	});
});

/**
 * The shapes that answer "what does this thrown thing say", any one of which is
 * a seventh site.
 *
 * **The shape rather than one spelling of it.** The guard used to look for the
 * literal words `instanceof Error` alone, and three plausible sixth copies
 * walked past it — `String(error)`, `(error as Error).message` and
 * `error?.message ?? String(error)` — each producing a different sentence from
 * `reasonOf` for the same thrown thing, which is the defect #171 was filed for
 * (#280, with
 * #276 closed into it).
 *
 * **A bare `.message` is deliberately not here.** It hits `src/core/problems.ts`
 * and `src/core/problemsSection.ts`, where `message` is a field on this
 * plugin's own problem type and has nothing to do with a caught thrown thing.
 * That is the difference between a guard that says something and one that fires
 * on every file.
 *
 * A wrapped line — `instanceof` on one line and `Error` on the next — would slip
 * through, and is out of scope: `npm run lint` is `tsc --noEmit` and there is no
 * formatter in this repository, so nothing rewraps it. A formatter arriving
 * would break more than this guard.
 */
const answeringExpressions = ["instanceof Error", "as Error", "String(error", "?.message"];

/**
 * The one file that has to contain the expressions, excluded by its own name —
 * the way `testConventions.test.ts` excludes itself from its own guards. Without
 * the exclusion the guard fails on the list above.
 */
const theGuardsOwnFile = `${sourceRoot}/${testFolder}/reason.test.ts`;

/**
 * The test files that name a caught thrown thing's message to **assert** on it
 * rather than to build a sentence for anyone, and why each is left alone.
 *
 * Short on purpose, and each entry is tied to a live match below, so an
 * allowance cannot outlive what it excuses — the same treatment `bareReasons`
 * in `./vocabulary` has.
 *
 * **It is empty, and that is the finished state rather than an unwritten one.**
 * It held `registry.test.ts` and `noteWriter.test.ts` — the waiting room for a
 * move that #280 described and did not make. Both now ask `reasonOf` for the
 * message they assert on, which is what the one-place rule means, so both
 * entries went with the move. Every path but
 * the guard's own file is now inside the guard, which is what #280's criterion
 * asked for.
 *
 * **The map is kept empty rather than deleted**, with the tie below still live
 * over it. The tie is what stops the next allowance rotting: an entry written
 * here expires by itself the day the line it excuses goes. Deleting the map
 * means whoever needs the next allowance writes one with no expiry, which is
 * the mechanism #204 and #280 each paid for once already.
 */
const assertingOnAThrownMessage: Record<string, string> = {};

/** Every `.ts` file under `src`, the test folder included — see the guard below. */
function everySourceIncludingTests(): Array<{ path: string; source: string }> {
	return [...shippedSources(), ...shippedSources(`${sourceRoot}/${testFolder}`)];
}

/**
 * The files that answer the question, out of the files handed in.
 *
 * A plain function of its two arguments, the way `requiredFloor` in
 * `./sourceGuards` is. That is what lets the tests below drive it with a
 * fabricated sixth copy and watch it fail — proof the guard bites, without
 * planting the expression in a real file and taking it out again.
 */
function sitesAnswering(
	files: Array<{ path: string; source: string }>,
	expressions: string[],
): string[] {
	return files
		.filter(({ path }) => path !== theGuardsOwnFile && !(path in assertingOnAThrownMessage))
		.filter(({ source }) => {
			const code = withoutComments(source);
			return expressions.some((expression) => code.includes(expression));
		})
		.map(({ path }) => path);
}

// The finding this ticket was filed for is that the expression spreads. Sites
// that answered the question: six by the time the ticket was taken, the sixth
// having arrived in `src/main.ts` while it sat. A guard rather than a promise,
// so the seventh fails here on the day it is written.
describe("the expression lives in one file", () => {
	it("is written in src/core/reason.ts and nowhere else under src", () => {
		expect(sitesAnswering(everySourceIncludingTests(), answeringExpressions)).toEqual([
			"src/core/reason.ts",
		]);
	});

	// Issue #280. `shippedSources()` skips any folder named `__tests__` whole, so
	// a copy written into a test helper or fixture used to pass. The criterion
	// #171 was written against read all of `src`.
	it("reads the test folder too, which the shipped-source walk skips", () => {
		const paths = everySourceIncludingTests().map(({ path }) => path);

		expect(paths).toContain(theGuardsOwnFile);
		expect(paths).toContain("src/core/reason.ts");
		expect(paths.length).toBeGreaterThan(shippedSources().length);
	});

	// Issue #280. The three sixth copies the old one-spelling needle walked past.
	// Fabricated rather than planted, so the proof runs on every future run.
	it.each([
		["String(error)", "const detail = String(error);"],
		["(error as Error).message", "const detail = (error as Error).message;"],
		["error?.message", "const detail = error?.message ?? String(error);"],
	])("fails on a sixth copy written as %s, in a shipped source", (_name, line) => {
		const files = [
			{ path: "src/core/reason.ts", source: "export const canonical = 1;" },
			{ path: "src/core/sixth.ts", source: line },
		];

		expect(sitesAnswering(files, answeringExpressions)).toEqual(["src/core/sixth.ts"]);
	});

	it.each([
		["String(error)", "const detail = String(error);"],
		["(error as Error).message", "const detail = (error as Error).message;"],
		["error?.message", "const detail = error?.message ?? String(error);"],
	])("fails on the same written as %s into a test file that is not this one", (_name, line) => {
		const files = [
			{ path: theGuardsOwnFile, source: line },
			{ path: `${sourceRoot}/${testFolder}/helper.ts`, source: line },
		];

		expect(sitesAnswering(files, answeringExpressions)).toEqual([
			`${sourceRoot}/${testFolder}/helper.ts`,
		]);
	});

	// Issue #356. The two files the allowance excused whole, until both moved to
	// `reasonOf` and their entries went. Named rather than folded into the case
	// above: "a test file that is not this one" was true of `helper.ts` while
	// these two were the exception it did not cover, so the proof that the
	// exception is gone has to name them. Fabricated through the same plain
	// function, so no real file is edited and put back.
	it.each([
		[`${sourceRoot}/${testFolder}/registry.test.ts`],
		[`${sourceRoot}/${testFolder}/noteWriter.test.ts`],
	])("fails on a sixth copy written into %s, which the allowance once excused", (path) => {
		const files = [{ path, source: "const detail = (error as Error).message;" }];

		expect(sitesAnswering(files, answeringExpressions)).toEqual([path]);
	});

	// The needle set's one deliberate omission. `message` is a field on this
	// plugin's own problem type in both of these, and a bare `.message` would
	// report them for having one.
	it("leaves the two files whose own type has a message field alone", () => {
		const answering = sitesAnswering(everySourceIncludingTests(), answeringExpressions);

		expect(answering).not.toContain("src/core/problems.ts");
		expect(answering).not.toContain("src/core/problemsSection.ts");
	});

	// The tie that stops an allowance outliving its reason.
	it.each(Object.keys(assertingOnAThrownMessage))("still needs its allowance for %s", (path) => {
		const file = everySourceIncludingTests().find((candidate) => candidate.path === path);

		expect(file, `${path} is allowed here but is no longer in the walk`).toBeDefined();
		expect(
			sitesAnswering([{ path: "src/core/stand-in.ts", source: file?.source ?? "" }], answeringExpressions),
			`${path} no longer names a thrown thing's message — delete its entry`,
		).toEqual(["src/core/stand-in.ts"]);
	});
});

/**
 * The comments of a source file and nothing else, so a guard over what a
 * comment says does not also read the code that guards it.
 *
 * `withoutComments` in `sourceGuards.ts` answers the other half of the same
 * question, and the one-file rule above uses it. This is its complement. It
 * lives here rather than beside it because nothing else needs it yet.
 */
function commentsOf(source: string): string {
	const blocks = source.match(/\/\*[\s\S]*?\*\//g) ?? [];
	const lines = source.split("\n").filter((line) => line.trim().startsWith("//"));
	return [...blocks, ...lines].join("\n");
}

// What the module comment says is the first thing anyone reads before deciding
// whether another copy may be written, so every place it names has to be one a
// reader can open. It named the first of the six by a label that reads as
// `src/core/icsReader.ts`, which is a different file and one the expression was
// never in.
describe("the comment names each place it lists", () => {
	const shipped = shippedSources();

	// The two assertions below read different things, and that is the point.
	//
	// The list is a claim about **the module comment alone**: it is what a
	// reader opens before deciding whether another copy may be written, so a
	// place it stops naming is the defect, whatever any other file happens to
	// say. Pooling this file's comments into it made it pass on the test file's
	// evidence — and this file already names `src/main.ts` in a comment of its
	// own, so the list check stayed green with that path taken out of the
	// module comment.
	//
	// The borrowed-label check is a claim about **both files at once**: neither
	// may carry one of the two labels, and which one would is irrelevant. So it
	// keeps the pool. Do not put these back together.
	const moduleComment = commentsOf(
		shipped.find((file) => file.path === "src/core/reason.ts")?.source ?? "",
	);
	const prose = [
		moduleComment,
		commentsOf(readFileSync(resolve(repoRoot, "src/__tests__/reason.test.ts"), "utf8")),
	].join("\n");

	// Five paths, one of them counted twice, which is the six sites the list
	// stands for. What the counts around them should say is issue #278's, not
	// this guard's: it reads the list, never the number.
	const places = [
		"src/core/icsOccurrences.ts",
		"src/core/registry.ts",
		"src/core/settingsTab.ts",
		"src/core/calendarSourcesSection.ts",
		"src/main.ts",
	];

	it("names every place by its path, and every path is a shipped file", () => {
		for (const place of places) {
			expect(moduleComment, place).toContain(`\`${place}\``);
			expect(
				shipped.map((file) => file.path),
				place,
			).toContain(place);
		}
	});

	it("borrows no other file's name for one of them", () => {
		// The two labels are in code rather than in a comment on purpose. The
		// sweep above reads comments, so a comment carrying one of them would
		// be the very thing this guard forbids.
		for (const label of ["ICS reader", "calendar reader"]) {
			expect(prose.toLowerCase()).not.toContain(label.toLowerCase());
		}
	});
});
