/**
 * The conventions the test suite holds itself to.
 *
 * Every guard here is about the shape of `src/__tests__/` rather than about the
 * plugin. Each one exists because the same piece of knowledge had been written
 * down twice and the two copies disagreed, so a later worker reading one of them
 * was told the opposite of what the other said.
 *
 * ## When a test may read this repository's own source
 *
 * Several suites here read source text instead of calling code — this file,
 * `platform.test.ts`, `manifest.test.ts` and `styles.test.ts`. Nothing said when
 * that was the right answer, and two workers in one wave moved opposite ways on
 * it and both landed, so the rule is written down here.
 *
 * **A test may read this repository's own source only where the property cannot
 * be driven.** That is what decides it, and it is met in two cases:
 *
 * - the test asserts an **absence** — no such import, no second copy of a rule,
 *   no class applied — and an absence has no call to make; or
 * - the code holding the property **cannot be built in the suite**, so there is
 *   nothing to drive.
 *
 * **Where the behaviour can be driven, drive it.** A read asserting that a
 * particular expression is *present* holds the letter of a fix and not its
 * effect: the expression can be renamed, moved or made inert and the guard still
 * passes. The gate is the sentence, not the two bullets under it — a guard
 * written as an absence of *text* still fails the gate when a call would show
 * the property that text stands for.
 *
 * The two workers are the worked examples, one on each side.
 *
 * - **Permitted, #127.** It replaced a runtime assertion about a handle's shape
 *   with a source read: `problems.ts` imports one name from `obsidian` and
 *   nothing else, which is why it holds no route to a note. That is an absence,
 *   and `Problems` takes no host, so the suite can give it no vault to watch and
 *   there is nothing to assert was left untouched. Undrivable, so the read is
 *   right. It is in `problems.test.ts`, under "imports `Notice` from `obsidian`
 *   and nothing else".
 * - **Not permitted, #197.** It deleted a source read of `settingsTab.ts` that
 *   sliced the constructor and asserted two `import type` lines present and two
 *   `new` expressions absent. The hazard behind it — a second `CollectionsIndex`
 *   with a second pair of vault subscriptions — is driven in `main.test.ts`,
 *   which starts the plugin and counts one `changed` subscription and one
 *   `rename`. Drivable, so the read was wrong, and what stands in its place is a
 *   comment pointing at that test.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { quotedLiteral, withoutComments } from "./sourceGuards";

/**
 * Every `*.test.ts` in this folder, by name and by the code in it.
 *
 * **Comments are taken out first**, because both guards below search for text a
 * comment may legitimately quote. `icsReader.test.ts` opens by saying its cases
 * are real files under `__fixtures__/`; that is a sentence about the folder, not
 * a second way of finding it. `withoutComments` is the one place a comment is
 * stripped (`sourceGuards.ts`, issue #267).
 *
 * **`readdirSync` reads this one folder and does not descend.** Every `*.test.ts`
 * in the repository is in it today, so nothing is missed. The day a subfolder
 * appears, both guards stop seeing what is inside it and say nothing — that is an
 * assumption written down rather than fixed. Widening what the
 * guards reach is a different decision from making them see what they already
 * look at, and an unwritten assumption fails the same way a wrong guard does.
 */
function testFiles(): Array<{ name: string; source: string }> {
	return sourcesEndingIn(".test.ts");
}

/**
 * Every `.ts` file in this folder — the four helper modules as well as the
 * suites — by name and by the code in it, comments taken out the same way.
 *
 * The guard below has to read the helpers: `sourceGuards.ts` was one of the
 * thirteen files issue #172 converted, so a helper is exactly as able to
 * resolve a repository file from the working directory as a suite is, and a
 * sweep of `*.test.ts` alone would say nothing about it.
 *
 * The duplicate-helper guard further down now takes its own list of modules from
 * this walk for the same reason, so the two sweeps read one folder listing
 * between them.
 */
function testFolderSources(): Array<{ name: string; source: string }> {
	return sourcesEndingIn(".ts");
}

/**
 * The one walk of this folder, so the two listings above cannot part. It reads
 * this folder and does not descend, for the reason `testFiles` records.
 */
function sourcesEndingIn(suffix: string): Array<{ name: string; source: string }> {
	return readdirSync(__dirname, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
		.map((entry) => ({
			name: entry.name,
			source: withoutComments(readFileSync(resolve(__dirname, entry.name), "utf8")),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** A helper module in this folder, as code with its comments taken out. */
function helperSource(name: string): string {
	return withoutComments(readFileSync(resolve(__dirname, name), "utf8"));
}

/**
 * The fixture folder's name, wherever it is spelled and however the path around
 * it is built.
 *
 * It used to be matched as `"__fixtures__"`, the folder name **with both quotes**,
 * so `resolve(__dirname, "__fixtures__/task-lines.md")` walked past — there is no
 * closing quote straight after the name. A single-quoted string and a template
 * literal walked past for the same reason. A guard that passes for the case it
 * was written to catch is worse than none.
 */
const FIXTURE_FOLDER = /__fixtures__/;

/**
 * Resolving a repository file from the **working directory** rather than from
 * this folder, in each of the four spellings the suite has actually used.
 *
 * Issue #172 converted
 * thirty such reads across thirteen files, and left the rule written only in
 * the docstrings of `repoRoot.ts` and `fixtures.ts`, where no guard read it.
 * `npm test` from the repository root passes either way — that is how everyone
 * runs it and how the release workflow runs it — so the thirty-first read would
 * have merged green and failed only in a board wave's per-worker worktree, with
 * nothing pointing at the cause.
 *
 * **The four spellings**, all measured on the tree before #172:
 * `process.cwd()`, and `resolve`, `readFileSync` or `readdirSync` given a
 * relative string literal as its first argument. The bare relative read is the
 * commoner half — `datePattern.test.ts`, `markdownSections.test.ts`,
 * `calendarTable.test.ts` and `vaultLayout.test.ts` each carried one — so a
 * `process.cwd()` match alone would have caught the rarer one only.
 *
 * **An absolute literal is not this defect** and is let through by the `(?!/)`:
 * `resolve("/tmp/x")` answers the same thing from any directory, which is the
 * whole property. The quoted string is read by `quotedLiteral` from
 * `./sourceGuards`, so all three quote styles are seen and a template literal
 * holding a `${…}` is seen with them.
 *
 * **What it does not see**: a relative path reached through a variable, as in
 * `const name = "README.md"; readFileSync(name)`. Nothing here writes one, and
 * seeing it needs a parser rather than a match — written down rather than
 * fixed, the way #247's assumption above is.
 */
const WORKING_DIRECTORY_READ = new RegExp(
	[
		String.raw`process\.cwd\(`,
		String.raw`\b(?:resolve|readFileSync|readdirSync)\(\s*` +
			quotedLiteral(String.raw`(["'` + "`" + String.raw`])(?!/)`, String.raw`\1`, "skip"),
	].join("|"),
);

/*
 * The reads this file's own cases hand to the pattern below, each named once so
 * that the case and the exemption cannot part.
 *
 * A case proving what the pattern sees has to hold the text it is proving —
 * there is nothing else to hand it — so this file is the one file that names a
 * working-directory read on purpose. Every one of those is here.
 */
/** The `process.cwd()` half, wrapped the way the suite used to write it. */
const CWD_INSIDE_A_RESOLVE = 'readFileSync(resolve(process.cwd(), "manifest.json"), "utf8")';
/** The bare relative half, in each of the three calls that takes a path. */
const BARE_RESOLVE = 'resolve("README.md")';
const BARE_FILE_READ = 'readFileSync("README.md", "utf8")';
const BARE_FOLDER_READ = 'readdirSync("src", { withFileTypes: true })';
/** The same bare read in the other two quote styles. */
const BARE_RESOLVE_SINGLE_QUOTED = "resolve('README.md')";
const BARE_RESOLVE_IN_A_TEMPLATE = "resolve(`${name}.md`)";
/** A sentence about the form rather than the form, which the guard must ignore. */
const THE_FORM_IN_A_LINE_COMMENT = '// resolve(process.cwd(), "GLOSSARY.md")';
/**
 * The bare-file-read text again, inside a block comment that only ever meant to
 * name the form. It is the case at the end of this describe block that hands it
 * to the pattern. It holds `BARE_FILE_READ`'s own text as a substring, which
 * does not matter to the sweep: the sweep strips comments before it looks, and
 * that takes this string's block comment with it, so this sample's text never
 * reaches the sweep at all.
 */
const BARE_FILE_READ_IN_A_BLOCK_COMMENT = '/** Was readFileSync("README.md", "utf8"). */\nconst a = 1;';

/**
 * Every one of them, and **this list is the whole exemption**.
 *
 * `sweptSource` takes the *first* occurrence of each of these strings out of
 * this file's code before the sweep reads it, and takes nothing else out — so a
 * sample's text written a second time is swept like any other file's code, and
 * only the occurrence at its own definition above is excused. The exemption is
 * tied to what it excuses the way `reason.test.ts`'s allowance map is: a sample
 * that stops being handed to a case stops being written above, and stops being
 * exempt with it.
 *
 * **What first-occurrence removal relies on.** A sample's own `const` above is
 * the first place its text occurs in the file, because the constants are
 * declared before every case that uses them; that is the one spot the removal
 * excuses. Where one sample's text sits inside another's — `BARE_FILE_READ`'s
 * inside `BARE_FILE_READ_IN_A_BLOCK_COMMENT`'s — the order of the two
 * declarations decides nothing: the sweep strips comments before it looks, so
 * the containing sample's text never reaches it. Measured at #455's review —
 * no match for it in the swept text, raw or stripped.
 *
 * **Why the samples rather than the pattern's own definition.**
 * #431 was raised expecting
 * the definition to be the text this file cannot avoid holding, and its triage
 * said so. Measured on this tree, it is not. The definition is regex source —
 * `process`, a backslash, a dot — and the pattern matches none of it. Every
 * match this file produces is one of the samples above, so stripping the
 * definition would have exempted nothing and left the guard failing on its own
 * file.
 */
const SAMPLE_READS = [
	CWD_INSIDE_A_RESOLVE,
	BARE_RESOLVE,
	BARE_FILE_READ,
	BARE_FOLDER_READ,
	BARE_RESOLVE_SINGLE_QUOTED,
	BARE_RESOLVE_IN_A_TEMPLATE,
	THE_FORM_IN_A_LINE_COMMENT,
	BARE_FILE_READ_IN_A_BLOCK_COMMENT,
];

/**
 * One file's code as the working-directory sweep reads it: unchanged, except in
 * this file, where the first occurrence of each sample above is taken out first.
 *
 * Named by file rather than applied everywhere on purpose. A sample's text
 * appearing in another suite would be that suite's own working-directory read,
 * and taking it out there would be the hole this ticket closes here.
 */
function sweptSource(file: { name: string; source: string }): string {
	if (file.name !== "testConventions.test.ts") return file.source;
	return SAMPLE_READS.reduce((code, sample) => code.replace(sample, ""), file.source);
}

/**
 * A helper's name being defined at all, rather than defined with the `function`
 * keyword.
 *
 * `const retiredIn = (text, words) => …` is a second copy of the knowledge and
 * used to walk past, because the guard tested `function\s+<name>`. `const`, `let`
 * and `var` are covered here alongside `function`, with or without a type
 * annotation between the name and the `=`.
 *
 * **Two shapes are deliberately not covered**, and they are named here rather
 * than left silent:
 *
 * - A class method, `retiredIn(text, words) { … }`. Its text is a call's text,
 *   and telling the two apart needs a parser rather than a match.
 * - An object property, `{ retiredIn: (text, words) => … }`. `name:` is how this
 *   folder writes a type annotation as well — `prose: (text: string) => string`
 *   in `manifest.test.ts` is one — so matching it would fire on declarations that
 *   define nothing.
 *
 * Neither shape exists in this folder and neither is how a helper here is
 * written. If one arrives, this comment is the place that says the guard does not
 * see it.
 */
function definitionOf(helper: string): RegExp {
	return new RegExp(`(?:function\\s+${helper}\\b|\\b(?:const|let|var)\\s+${helper}\\b)`);
}

describe("fixtures are found in one place", () => {
	// Four suites built the fixture path themselves and two of them built it a
	// different way, one carrying a comment warning against the form another
	// suite's replaced comment had warned *towards*. `fixtures.ts` is now the
	// only file that names the folder, so a fifth copy fails here rather than
	// quietly picking whichever form its author read first.
	it("names the __fixtures__ folder in the helper and nowhere else", () => {
		const naming = testFiles()
			// This file names the folder because it is the guard: the string it
			// searches for has to appear in it. It reads no fixture of its own.
			.filter((file) => file.name !== "testConventions.test.ts")
			.filter((file) => FIXTURE_FOLDER.test(file.source))
			.map((file) => file.name);

		expect(naming).toEqual([]);
	});

	it("still names it in the helper, so the guard cannot pass by it vanishing", () => {
		expect(helperSource("fixtures.ts")).toMatch(FIXTURE_FOLDER);
	});

	it("sees the folder however the path is spelled", () => {
		// The three shapes the old guard walked past, each proved by making it
		// fail first. Nothing here reads a file: the guard's whole job is to
		// recognise the text, so the text is what the case hands it.
		expect(FIXTURE_FOLDER.test('resolve(__dirname, "__fixtures__/x.md")')).toBe(true);
		expect(FIXTURE_FOLDER.test("resolve(__dirname, '__fixtures__/x.md')")).toBe(true);
		expect(FIXTURE_FOLDER.test("resolve(__dirname, `__fixtures__/${name}`)")).toBe(true);
	});

	it("does not fire on a comment that merely mentions the folder", () => {
		// `icsReader.test.ts` says in its opening comment that its cases are real
		// files under `__fixtures__/`. A sentence about the folder is not a
		// second way of finding it, and the guard would be unusable if it were.
		expect(withoutComments("/** Cases live under __fixtures__/. */\nconst a = 1;")).not.toMatch(
			FIXTURE_FOLDER,
		);
		expect(withoutComments("// under __fixtures__/\nconst a = 1;")).not.toMatch(FIXTURE_FOLDER);
	});
});

describe("a repository file is found from this folder, not the working directory", () => {
	// #172 delivered the property and nothing held it. The rule lived in two
	// module docstrings, which no guard read, so the thirty-first read would
	// have passed `npm test` from the repository root and failed nowhere anyone
	// looks.
	it("is read from no file in this folder, in any of the four spellings", () => {
		const naming = testFolderSources()
			// No file is skipped, this one included. It used to skip itself
			// whole, on the strength of a sentence saying it read no repository
			// file of its own — asserted rather than checked, which left the one
			// file most likely to be written carelessly as the one file the guard
			// could not see. What is taken out now is the text its own cases hand
			// the pattern, and nothing else.
			.filter((file) => WORKING_DIRECTORY_READ.test(sweptSource(file)))
			.map((file) => file.name);

		expect(naming).toEqual([]);
	});

	it("sweeps its own file, where only the samples above are taken out", () => {
		const me = testFolderSources().find((file) => file.name === "testConventions.test.ts");
		if (!me) throw new Error("the sweep does not read its own file.");

		// Every sample this file holds is out of the swept text …
		expect(WORKING_DIRECTORY_READ.test(sweptSource(me))).toBe(false);

		// … and nothing else is. The read below is built from pieces rather than
		// written out, because writing it out would put a genuine
		// working-directory read into this file — the very thing this case says
		// the sweep would catch.
		const quote = '"';
		const notASample = `readFileSync(${quote}package.json${quote}, ${quote}utf8${quote})`;
		expect(
			WORKING_DIRECTORY_READ.test(
				sweptSource({ name: "testConventions.test.ts", source: notASample }),
			),
		).toBe(true);
	});

	it("excuses only the first occurrence of a sample, not every one", () => {
		// The defect #455 found: `split(sample).join("")` took every occurrence
		// out, so a genuine read written a second time, spelled byte-for-byte as
		// a sample, was invisible. The second copy below has to survive the sweep.
		const repeated = `${BARE_FILE_READ}\n${BARE_FILE_READ}`;
		expect(
			WORKING_DIRECTORY_READ.test(
				sweptSource({ name: "testConventions.test.ts", source: repeated }),
			),
		).toBe(true);
	});

	// An absence guard passes on an empty listing, so the listing is checked.
	// The two helper modules are the ones the sweep exists to reach.
	it("reads the helper modules as well as the suites", () => {
		const names = testFolderSources().map((file) => file.name);

		expect(names).toContain("repoRoot.ts");
		expect(names).toContain("fixtures.ts");
		expect(names).toContain("sourceGuards.ts");
		expect(names.length).toBeGreaterThan(testFiles().length);
	});

	// **No file is exempt, and that is the finding rather than an omission.**
	// The two modules that name these forms name them in prose only, and
	// `withoutComments` takes prose out before the sweep reads it — so neither
	// needs an allowance, and giving one would be a permanent exemption bought
	// for nothing. This case is the pair that keeps that true: the file as
	// written still names the form, so the documented rule cannot vanish
	// unseen, and the code of the same file does not, so neither helper is
	// quietly outside the sweep.
	it.each(["repoRoot.ts", "fixtures.ts"])(
		"still names the form in %s's prose, and never in its code",
		(name) => {
			expect(readFileSync(resolve(__dirname, name), "utf8")).toMatch(WORKING_DIRECTORY_READ);
			expect(helperSource(name)).not.toMatch(WORKING_DIRECTORY_READ);
		},
	);

	it("sees the read however it is spelled", () => {
		// The four spellings, each proved by making it fail first. Nothing here
		// reads a file: the guard's whole job is to recognise the text, so the
		// text is what the case hands it.
		expect(WORKING_DIRECTORY_READ.test(CWD_INSIDE_A_RESOLVE)).toBe(true);
		expect(WORKING_DIRECTORY_READ.test(BARE_RESOLVE)).toBe(true);
		expect(WORKING_DIRECTORY_READ.test(BARE_FILE_READ)).toBe(true);
		expect(WORKING_DIRECTORY_READ.test(BARE_FOLDER_READ)).toBe(true);

		// All three quote styles, the way the fixture guard above covers them.
		expect(WORKING_DIRECTORY_READ.test(BARE_RESOLVE_SINGLE_QUOTED)).toBe(true);
		expect(WORKING_DIRECTORY_READ.test(BARE_RESOLVE_IN_A_TEMPLATE)).toBe(true);
	});

	it("leaves the two forms the suite is meant to use alone", () => {
		// `resolve(repoRoot, name)` for a repository-root file and
		// `resolve(__dirname, "..", …)` for a source file, which is what
		// `repoRoot.ts` says the suite writes. A guard that fired on either
		// would be unusable.
		expect(WORKING_DIRECTORY_READ.test('resolve(repoRoot, "manifest.json")')).toBe(false);
		expect(WORKING_DIRECTORY_READ.test('resolve(__dirname, "..", "core", "reason.ts")')).toBe(
			false,
		);
		expect(WORKING_DIRECTORY_READ.test("readdirSync(__dirname, { withFileTypes: true })")).toBe(
			false,
		);
		expect(WORKING_DIRECTORY_READ.test('readFileSync(resolve(repoRoot, path), "utf8")')).toBe(
			false,
		);

		// An absolute literal answers the same thing from any directory, so it
		// is not this defect.
		expect(WORKING_DIRECTORY_READ.test('resolve("/tmp/absolute.md")')).toBe(false);
	});

	it("does not fire on a comment that merely names the form", () => {
		// `repoRoot.ts` and `fixtures.ts` each explain the form they replaced by
		// writing it out. A sentence about a working-directory read is not one.
		expect(withoutComments(`${THE_FORM_IN_A_LINE_COMMENT}\nconst a = 1;`)).not.toMatch(
			WORKING_DIRECTORY_READ,
		);
		expect(withoutComments(BARE_FILE_READ_IN_A_BLOCK_COMMENT)).not.toMatch(
			WORKING_DIRECTORY_READ,
		);
	});
});

describe("a shared guard helper is defined in one place", () => {
	// `avoidEntries`, `retiredWords` and `retiredIn` sat in two test files at
	// once. The two copies agreed on every allowance entry and differed only in
	// the capitalisation of the two list names, so the sweeps had never checked
	// different terms (issue #251 corrects an earlier note here that said they
	// had). Both parse the same `_Avoid_` lines out of the same `GLOSSARY.md`,
	// and that is the defect on its own: a third copy would be a third answer to
	// one question.
	//
	// `shownStrings` and `bareAnnotated` joined them with issue #69, which
	// widened the sweep to the plugin's own strings. Which strings a person
	// reads, and which terms are checked at all, are decisions two suites now
	// share; a copy of either in a test file is the same defect again.
	//
	// `withoutComments` joined with issue #267, and is why each entry carries
	// its module. It was de-duplicated into `sourceGuards.ts` and then left off
	// this list, so a copy could come back unnoticed; it cannot be moved into
	// `vocabulary.ts` to suit a hardcoded module name, because `styles.test.ts`
	// and `reason.test.ts` share it and neither has anything to do with
	// vocabulary.
	//
	// `markdownProse` joined with issue #246. It was `markdownProse` in one test
	// file and `prose` in another, byte-identical bodies under two names, which
	// is how the two copies of the parser above started. A new helper is one
	// more pair, not another restructure.
	//
	// `quotedLiteral` joined with issue #320, and is the second entry whose
	// module is `sourceGuards.ts` for the reason `withoutComments` is: how a
	// quoted string is written, escapes included, was spelled out by hand in
	// `styles.test.ts` and again in `vocabulary.ts`, and `styles.test.ts` has
	// nothing to do with vocabulary. One of the two spellings had a whole quote
	// style missing for a while and nothing said so.
	//
	// `statesPattern` and `statesCodePointCount` joined with issue #417, and are
	// the pair this registry exists for. `statesPattern` was written at the
	// bottom of `checkboxCyclingLineKind.test.ts` by the wave that fixed #416,
	// whose worker owned that file alone and could reach neither `sourceGuards.ts`
	// nor this list. #417 was the same defect against a different guard and wanted
	// a matcher from the same family: the answer was to move the first here and
	// write the second beside it, rather than let two suites each own a private
	// copy of "does this source state this rule". Registering them is what stops
	// the next such guard growing a third.
	//
	// The order matters once, and only when they are added: this guard asserts a
	// registered helper sits in **no** test file, so an entry written before its
	// helper has moved fails.
	//
	// `repoRoot` joined with issue #370, and is the third module in the column.
	// Issue #172 created it so that nine suites would stop each building the
	// repository's root folder for themselves, and gave *this guard* as the
	// reason a shared module was safe — then left the new helper off the list
	// it was relying on. `withoutComments` above is the same history word for
	// word. A tenth suite writing `const repoRoot = resolve(__dirname, "..",
	// "..")` at its top would otherwise pass in silence, and the root would
	// have two definitions free to drift.
	//
	// `shippedSources` and `everyFileOnDisk` joined with issue #372. A fourth
	// walk of the shipped tree sat in `calendarSources.test.ts` under the name
	// `shippedFiles`, byte for byte the same knowledge, and this guard never
	// saw it. **These two entries catch a same-named copy and nothing else.**
	// A copy written under a new name — which is exactly how that one was
	// missed, and how `markdownProse`/`prose` was missed before it — needs
	// matching on the body rather than the name, and this guard does not do
	// that. Do not read these entries as more cover than they give.
	//
	// **What this guard reads**: every `.ts` file directly in this folder — the
	// suites by name, and every other `.ts` file as a helper module — whether or
	// not the registry below names it.
	//
	// It grew in two steps and the second is why. Until issue #315 it read the
	// test files alone, so a second copy of `withoutComments` written into
	// `vocabulary.ts` — the one pair of files most likely to grow one — passed in
	// silence. #315 added the helper modules by taking them from the registry's
	// own module column, which left `fixtures.ts` unread, because no helper was
	// registered against it. That is the same defect one file along, and the next
	// unregistered module would have repeated it exactly, so the swept set is
	// taken from the folder instead. The registry
	// keeps its own job: saying which module *owns* each helper, so each module
	// is still skipped against its own entries.
	//
	// **What it still does not read is anything in a subfolder**: the folder walk
	// does not descend, and `helperSource` resolves a bare name in this folder, so
	// a helper written into `src/__tests__/<anything>/x.ts` is outside every sweep
	// here and says nothing when it arrives. That assumption is #247's and is
	// written down above rather than fixed; widening what the guards reach stays a
	// separate decision from making them see what they already look at.
	const helpers: Array<[helper: string, module: string]> = [
		["avoidEntries", "vocabulary.ts"],
		["retiredWords", "vocabulary.ts"],
		["retiredIn", "vocabulary.ts"],
		["shownStrings", "vocabulary.ts"],
		["bareAnnotated", "vocabulary.ts"],
		["markdownProse", "vocabulary.ts"],
		["withoutComments", "sourceGuards.ts"],
		["quotedLiteral", "sourceGuards.ts"],
		["shippedSources", "sourceGuards.ts"],
		["everyFileOnDisk", "sourceGuards.ts"],
		["statesPattern", "sourceGuards.ts"],
		["statesCodePointCount", "sourceGuards.ts"],
		["repoRoot", "repoRoot.ts"],
	];

	/**
	 * The helper modules themselves: every `.ts` file directly in this folder
	 * that is not a suite. The suites are swept by name a few lines below, so
	 * taking them out here is what stops one file being read twice.
	 *
	 * Taken from the folder rather than from the registry's module column. The
	 * column names the module each *registered* helper belongs to, and a module
	 * holding no registered helper is not in it — `fixtures.ts` was exactly that,
	 * and a copy of `withoutComments` written into it passed in silence. A module
	 * that arrives without being registered is covered here from the day the file
	 * exists rather than from the day someone remembers it
	 * (#419, correcting
	 * #315).
	 */
	const helperModules = testFolderSources()
		.map((file) => file.name)
		.filter((name) => !name.endsWith(".test.ts"));

	it.each(helpers)("is not defined in any test file (%s)", (helper) => {
		const defining = testFiles()
			// This file names the helpers because it is the guard, and it defines
			// none of them.
			.filter((file) => file.name !== "testConventions.test.ts")
			.filter((file) => definitionOf(helper).test(file.source))
			.map((file) => file.name);

		expect(defining).toEqual([]);
	});

	it.each(helpers)(
		"is not defined in a helper module that does not own it (%s)",
		(helper, module) => {
			// The sweep above reads `*.test.ts` only, so a copy of a registered
			// helper written into *another* module in this folder passed in
			// silence — the guard's own defect, in the pair of files most likely to
			// grow it. Each module is skipped against its own entries, the way this
			// file is skipped above, or every entry would fail against its own
			// module. A module that owns no registered helper is never the skipped
			// one, so every entry is checked against it.
			const defining = helperModules
				.filter((other) => other !== module)
				.filter((other) => definitionOf(helper).test(helperSource(other)));

			expect(defining).toEqual([]);
		},
	);

	it.each(helpers)("is defined in the module it belongs to (%s)", (helper, module) => {
		expect(helperSource(module)).toMatch(definitionOf(helper));
	});

	// An absence guard passes on an empty listing, so the listing is checked —
	// and this is also what says the swept set is the folder's rather than the
	// registry's. `fixtures.ts` is the case that made the difference: it owns no
	// registered helper, so the module column never named it, and a copy of
	// `withoutComments` written into it passed in silence until issue #419.
	it("sweeps every non-suite file in this folder, registered or not", () => {
		expect(helperModules).toContain("fixtures.ts");
		expect(helperModules).toContain("repoRoot.ts");
		expect(helperModules).toContain("sourceGuards.ts");
		expect(helperModules).toContain("vocabulary.ts");

		// The suites are swept by name above, so none of them is in here twice.
		expect(helperModules.filter((name) => name.endsWith(".test.ts"))).toEqual([]);

		// And nothing the registry names has fallen out of the folder's own list.
		for (const [, module] of helpers) expect(helperModules).toContain(module);
	});

	it("sees a helper defined without the function keyword", () => {
		// The shape the old guard walked past, proved by making it fail first.
		// A type annotation between the name and the `=` is the same definition
		// and has to be seen too.
		expect(definitionOf("retiredIn").test("const retiredIn = (text, words) => [];")).toBe(true);
		expect(definitionOf("retiredIn").test("let retiredIn = (text, words) => [];")).toBe(true);
		expect(
			definitionOf("retiredIn").test("const retiredIn: (t: string) => string[] = () => [];"),
		).toBe(true);
	});

	it("leaves an import and a call alone, and does not fire on a longer name", () => {
		// The guard has to tell a second definition from the many places a
		// helper is legitimately used, or every suite that imports one fails.
		expect(definitionOf("retiredIn").test('import { retiredIn } from "./vocabulary";')).toBe(false);
		expect(definitionOf("retiredIn").test("expect(retiredIn(prose, words)).toEqual([]);")).toBe(
			false,
		);
		expect(definitionOf("retiredIn").test("const retiredInDocuments = [];")).toBe(false);
	});

	it("does not fire on a comment that merely names a helper", () => {
		// True of both lists above: `testFiles` strips comments as it reads, and
		// `helperSource` is `withoutComments` over one named module, so a comment
		// naming a helper is prose in a test file and prose in a helper module
		// alike.
		expect(withoutComments("// see function retiredIn in vocabulary.ts\nconst a = 1;")).not.toMatch(
			definitionOf("retiredIn"),
		);
	});
});
