import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { repoRoot } from "./repoRoot";
import {
	apiFloors,
	atLeast,
	baselineFloor,
	everyFileOnDisk,
	requiredFloor,
	shippedSources,
} from "./sourceGuards";
import {
	bareAnnotated,
	bareReasons,
	markdownProse,
	notMatchable,
	retiredIn,
	retiredWords,
	shownStrings,
} from "./vocabulary";
import { readRepeatRule } from "../core/repeatRule";
import type { RepeatRule } from "../core/repeatRule";
import { defaultData } from "../core/settings";

// The manifest is read from disk rather than imported, so the test checks the
// file the community directory will read rather than a bundler's copy of it.
// `repoRoot` is where manifest.json sits, and it is found from this folder
// rather than from the working directory, so the read holds wherever the suite
// is run from.
// The rules asserted here are Obsidian's own submission requirements for the
// `description` field — see docs/research/obsidian-publishing-requirements.md.
const manifest = JSON.parse(
	readFileSync(resolve(repoRoot, "manifest.json"), "utf8"),
) as { version: string; description: string; minAppVersion: string };

// Obsidian's plugin browser reads `versions.json`, not the manifest, to decide
// which release an app older than the current one may install. So the floor
// stated in the manifest only protects anybody if this file states it too.
const versions = JSON.parse(readFileSync(resolve(repoRoot, "versions.json"), "utf8")) as Record<
	string,
	string
>;

// A description may not open by naming itself; the directory asks for an
// action verb instead. These are the openers Obsidian's requirements rule out,
// plus the articles and demonstratives that cannot begin an imperative.
const bannedOpenings = [
	/^this is a plugin\b/i,
	/^this plugin\b/i,
	/^an? (obsidian )?plugin\b/i,
	/^obsidian plugin\b/i,
	/^the\b/i,
	/^it\b/i,
];

// Emoji live outside the Basic Multilingual Plane or in the symbol blocks;
// `\p{Extended_Pictographic}` covers both, including the older dingbats.
const emoji = /\p{Extended_Pictographic}/u;

describe("manifest description", () => {
	it("is 250 characters or fewer", () => {
		expect(manifest.description.length).toBeLessThanOrEqual(250);
	});

	it("ends with a full stop", () => {
		expect(manifest.description.endsWith(".")).toBe(true);
	});

	it("carries no emoji", () => {
		expect(emoji.test(manifest.description)).toBe(false);
	});

	it("opens with a verb rather than naming itself", () => {
		for (const opening of bannedOpenings) {
			expect(manifest.description).not.toMatch(opening);
		}
	});

	it("calls a collection a collection", () => {
		expect(manifest.description).toContain("collection");
		expect(manifest.description).not.toContain("project file");
	});
});

/*
 * Some Obsidian APIs arrived after the version this plugin claims to run on.
 * Below the version that introduced one, the call is undefined and whatever
 * uses it throws. The file that needs a version and the file that states it are
 * owned by different tickets and merge without a conflict, so a test has to tie
 * them together.
 *
 * The guard below discovers the files it reads rather than naming them, and it
 * asserts on every run. Its predecessor did neither: it read `settings.ts`
 * alone, and its only assertion sat inside an `if`, so moving the per-device
 * store into its own module would have made the test report a pass having
 * checked nothing at all (issue #58, absorbing #65).
 */

/**
 * The folder the README's map of the core is checked against. The floor guard
 * reads the whole shipped tree — `shippedSources()` and `everyFileOnDisk()`,
 * both in `./sourceGuards` — but the README table names `src/core` files only,
 * so that check keeps its own narrower root.
 */
const coreFolder = "src/core";

describe("the Obsidian version floor", () => {
	it("returns the stated baseline for a source that calls nothing newer", () => {
		expect(requiredFloor(["export function add(a: number) { return a + 1; }"], apiFloors)).toBe(
			baselineFloor,
		);
	});

	it("returns the higher floor for a source that calls a later API", () => {
		expect(requiredFloor(["if (this.app.isDarkMode()) return;"], apiFloors)).toBe("1.10.0");
	});

	it("takes the highest floor of everything the sources together call", () => {
		expect(
			requiredFloor(
				["this.app.loadLocalStorage(key);", "await this.app.secretStorage.get(name);"],
				apiFloors,
			),
		).toBe("1.11.4");
	});

	// Issue #1262. The collection question extends Obsidian's own yes-or-no dialog,
	// `@since 1.13.0` at `node_modules/obsidian/obsidian.d.ts:1961`; with no row for
	// it the guard read 1.11.4 and the manifest went on offering the plugin to apps
	// where the dialog does not exist.
	it("needs 1.13.0 for a source built on Obsidian's yes-or-no dialog", () => {
		expect(requiredFloor(["const modal = new (class extends ConfirmationModal {})(app);"], apiFloors)).toBe(
			"1.13.0",
		);
	});

	it("returns the baseline for no sources at all rather than nothing", () => {
		expect(requiredFloor([], apiFloors)).toBe(baselineFloor);
	});
});

describe("the shipped-tree walk behind the guard", () => {
	it("finds every shipped module a second, independent listing finds", () => {
		expect(shippedSources().map(({ path }) => path).sort()).toEqual(everyFileOnDisk());
	});

	it("reads more than the one file the old guard read", () => {
		expect(shippedSources().length).toBeGreaterThan(1);
	});

	// Issue #156. `src/main.ts` sits outside `src/core`, so an Obsidian API
	// called from it never raised `minAppVersion` and the manifest went on
	// claiming the 1.7.2 baseline.
	it("reads src/main.ts, which sits outside the core", () => {
		expect(shippedSources().map(({ path }) => path)).toContain("src/main.ts");
	});
});

/*
 * Issue #156 asks for the walk's new reach to be proved by adding a
 * floor-raising call to `src/main.ts` and watching the suite go red. That is
 * done here against a fabricated tree of the same shape rather than against the
 * real file, so the proof is a test that runs on every future run rather than
 * an experiment someone did once and undid.
 */
describe("a floor-raising call outside the core", () => {
	const root = mkdtempSync(join(tmpdir(), "effortless-floor-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	mkdirSync(join(root, "core"), { recursive: true });
	writeFileSync(join(root, "main.ts"), "if (this.app.isDarkMode()) return;\n");
	writeFileSync(join(root, "core", "quiet.ts"), "export const ok = 1;\n");

	it("raises the floor from a file at the root of the tree, not only from the core", () => {
		expect(
			requiredFloor(
				shippedSources(root).map(({ source }) => source),
				apiFloors,
			),
		).toBe("1.10.0");
	});

	it("would not have been seen by a walk rooted at the core", () => {
		expect(
			requiredFloor(
				shippedSources(`${root}/core`).map(({ source }) => source),
				apiFloors,
			),
		).toBe(baselineFloor);
	});
});

describe("manifest minAppVersion", () => {
	// Computed once, at the top of the block, so both assertions below are
	// checked against the same answer and neither carries a literal version.
	const floor = requiredFloor(
		shippedSources().map(({ source }) => source),
		apiFloors,
	);

	it("is high enough for every Obsidian API the core calls", () => {
		expect(atLeast(manifest.minAppVersion, floor)).toBe(true);
	});

	it("names the floor the core actually needs, in versions.json too", () => {
		expect(atLeast(versions[manifest.version], floor)).toBe(true);
	});
});

describe("versions.json", () => {
	it("carries an entry for the version the manifest names", () => {
		expect(Object.keys(versions)).toContain(manifest.version);
	});

	it("offers this release only to apps at the manifest's own floor", () => {
		expect(versions[manifest.version]).toBe(manifest.minAppVersion);
	});
});

/* -------------------------------------------------------------------------- */
/* The glossary's retired words, swept across the documents.       */
/* -------------------------------------------------------------------------- */

/*
 * `GLOSSARY.md` settles one word for each thing and lists, under `_Avoid_`, the
 * words not to reach for. The rename that made a *project file* a *collection*
 * reached `manifest.json` and two sentences of `README.md` and stopped there,
 * because the only guard was the single phrase-exact assertion near the top of
 * this file. This sweep is what makes "the rename binds the whole repository"
 * mechanical rather than something each ticket has to remember.
 *
 * The term list is read out of the glossary rather than copied here, so adding
 * a word there tightens the guard with no change in this file. The parser that
 * reads it lives in `./vocabulary`, which is the one place `GLOSSARY.md`'s
 * `_Avoid_` lines are parsed; `settingsTab.test.ts` sweeps the drawn screen
 * with the same functions.
 */

const glossary = readFileSync(resolve(repoRoot, "GLOSSARY.md"), "utf8");

/**
 * A JSON document's `description` — the one field in it written as prose.
 *
 * The two JSON files are swept by that field rather than whole, because a
 * dependency's name is somebody else's word and not this repository's word for
 * one of its own things. `ical-expander` should not be able to fail this guard.
 */
function descriptionOf(json: string): string {
	return (JSON.parse(json) as { description?: string }).description ?? "";
}

/**
 * The documents this sweep reads.
 *
 * **What it leaves out, and why each one is deliberate:**
 *
 * - `CLAUDE.md` as a whole. Its opening sentence *is* swept, by
 *   `workingRulesWords.test.ts`, a file of its own so the release export can
 *   leave it out with `CLAUDE.md` — that sentence is the plugin
 *   described in the repository's own words, and it contradicted the glossary until this commit.
 *   The rest of the file is engineering prose about the repository, and the
 *   retired list is ordinary English used there in another sense entirely:
 *   measured on this branch, the whole file matches `sync`, `deferred`,
 *   `status`, `part` and `host`, none of them about a collection. It stays out
 *   for that reason alone. The rule that let `src/` be swept does not carry
 *   here: that one reads by *position*, and a Markdown file has no call to hand
 *   a sentence to. Deciding which words a reader meets as a domain term inside
 *   ordinary prose is a different question, and nothing in the repository
 *   answers it yet.
 * - `docs/research/` records what other plugins do and what the old code did.
 *   Those documents legitimately describe other people's project files.
 * - The glossary's own `_Avoid_` lines name the retired words, and
 *   `docs/acceptance-queue.md` records a past ticket titled "Say collection,
 *   not project file". Neither is the repository using the word.
 * - `GLOSSARY.md`, for two reasons rather than one. It is engineering prose
 *   about the repository, so the ordinary-English measurement above applies to
 *   it exactly as it does to `CLAUDE.md`. And it is the glossary itself, which
 *   is the harder of the two: **9 of its 23 entries use a word that another
 *   entry retires**, measured on this commit. Reproduce it by walking the
 *   `**Term**:` blocks of `GLOSSARY.md` and calling `retiredIn()` on each block
 *   against `retiredWords(glossary)` with that block's own term filtered out,
 *   after dropping the `_Avoid_` lines — both functions from `./vocabulary`.
 *   The nine are *The completed-tasks heading*, *The day's task sections*,
 *   *Pairing*, *Migration*, *Forwarding*, *Clash*, *Feature state*, *Section*
 *   and *The calendar table*.
 *
 *   No single skip rule covers them, and in particular a rule that skipped a
 *   term's own defining entry would not silence one of the nine: **The day's
 *   task sections** reaches for words retired under *The tasks heading*, which
 *   is a different entry. That entry's use is deliberate and says so; whether any of the other eight is deliberate or untidy is a question
 *   nobody has answered, and answering it is the work widening the sweep to
 *   this file has to do first.
 * - Every TypeScript source under `src/`, **as a document**. The sources are
 *   swept, further down this same file — `the words the plugin's own strings
 *   use` reads every shipped source. It reads them by *position* rather than by
 *   text: only the strings handed to a call that shows text count. Why that is
 *   the rule, and the measurement that settled it, are recorded with the rule
 *   itself — `shownStrings`'s doc comment in `./vocabulary` — and this list is
 *   the wrong place for a second copy of a number. Reading a source as prose
 *   is what this list leaves out, and what nothing does.
 *   `src/core/settingsTab.ts`'s drawn screen is swept a third way again, by
 *   `src/__tests__/settingsTab.test.ts`.
 *
 * **`README.md` is swept here and nowhere else, and that is deliberate.**
 * `src/__tests__/settingsTab.test.ts` does not sweep it. That suite's claim is
 * the settings screen as it is actually drawn, and a Markdown file read as text
 * is not that — holding the README there made the suite carve out an exception
 * to its own subject. It carried a second copy of this assertion until issue
 * #296 removed it: the same file, through the same `markdownProse`, against the
 * same glossary, expecting the same empty list. Do not add it back there. A
 * change to how the README is swept belongs in this table.
 */
const sweptDocuments: Array<{ path: string; prose: (text: string) => string }> = [
	{ path: "package.json", prose: descriptionOf },
	{ path: "manifest.json", prose: descriptionOf },
	{ path: "README.md", prose: markdownProse },
];

describe("the words the documents use", () => {
	const words = retiredWords(glossary);

	it.each(sweptDocuments)("uses no term the glossary retires, in $path", ({ path, prose }) => {
		expect(retiredIn(prose(readFileSync(resolve(repoRoot, path), "utf8")), words)).toEqual([]);
	});

	it("finds prose to sweep in every document, rather than reading an empty string", () => {
		for (const { path, prose } of sweptDocuments) {
			expect(prose(readFileSync(resolve(repoRoot, path), "utf8")).length, path).toBeGreaterThan(
				40,
			);
		}
	});

	it("reads the glossary's own list rather than carrying a copy", () => {
		expect(words.map((entry) => entry.word)).toContain("project file");
		expect(words.length).toBeGreaterThan(20);
	});

	it("guards a term the glossary has only just gained, with no change here", () => {
		// The nonsense-term proof, kept rather than done once by hand: a word
		// this file has never seen becomes guarded because the glossary lists
		// it. Driving the parser with a fabricated glossary is what lets the
		// proof stay in the suite instead of dying with the ticket.
		const fabricated = "**Widget**:\nOne of those.\n_Avoid_: doohickey, thingummy\n";
		expect(retiredWords(fabricated).map((entry) => entry.word)).toEqual(["doohickey", "thingummy"]);
		expect(retiredIn("A thingummy sits on the screen.", retiredWords(fabricated))).toEqual([
			"thingummy",
		]);
		expect(retiredIn("A widget sits on the screen.", retiredWords(fabricated))).toEqual([]);
	});

	it("would say so if the retired word came back", () => {
		// The two sentences this ticket rewrote, as they were. A guard nobody
		// has watched fail is a guard nobody has checked. The second is why the
		// glossary now retires the bare word as well as the phrase: a
		// phrase-exact match walks straight past it.
		expect(
			retiredIn("a switchable set of features over the day's log and its project files", words),
		).toContain("project file");
		expect(retiredIn("moving a task to another day, or into a project", words)).toContain("project");
	});

	it("matches whole words only, and ignores capitals", () => {
		expect(retiredIn("A Project note.", words)).toContain("project");
		expect(retiredIn("The projection was wrong.", words)).toEqual([]);
	});

	it("excuses only words the glossary actually retires", () => {
		// Keeps the two allowances from outliving the entries they excuse: a
		// word dropped from an `_Avoid_` list fails here rather than sitting on
		// as a permission for nothing.
		const retired = words.map((entry) => entry.word);
		for (const word of Object.keys(notMatchable)) expect(retired).toContain(word);
	});

	it("lets a proper name through, and only where it is the proper name", () => {
		expect(retiredIn("It grew out of Ryder Carroll's bullet journal method.", words)).toEqual([]);
		expect(retiredIn("Where your journal is kept.", words)).toEqual(["journal"]);
	});
});

/* -------------------------------------------------------------------------- */
/* The README's map of the core.                                  */
/* -------------------------------------------------------------------------- */

/*
 * `README.md` carries a table mapping the core's files, and it is how someone
 * arriving at the repository finds their way around. It read as exhaustive
 * while naming seven of sixteen files, because the wave that added a pair of
 * files gave the README to one ticket and the files to another.
 *
 * The route taken is the complete one: a row for every source file in the core,
 * and no exclusion list to keep honest. That makes this guard the thing that
 * keeps it complete — a file added to `src/core/` fails here until it has a row,
 * and a row naming a file that has gone fails here too.
 *
 * The pairing rule is derived rather than listed: wherever the core holds both
 * `x.ts` and `xSection.ts` — a service and the settings-screen section that
 * draws it — the two rows have to sit next to each other. A pair added
 * tomorrow is checked without anyone remembering to add it here.
 */

/** One row of the README's core table: the file it names, and what it says that file owns. */
interface CoreRow {
	path: string;
	owns: string;
}

function mappedCoreRows(): CoreRow[] {
	const readme = readFileSync(resolve(repoRoot, "README.md"), "utf8");
	return Array.from(readme.matchAll(/^\|\s*`(src\/core\/[^`]+)`\s*\|([^|\n]*)\|\s*$/gm)).map(
		(match) => ({ path: match[1], owns: match[2].trim() }),
	);
}

describe("the README's map of the core", () => {
	it("reads the table rather than matching nothing", () => {
		expect(mappedCoreRows().length).toBeGreaterThan(7);
	});

	it("gives every file the core holds a row of its own", () => {
		expect(mappedCoreRows().map((row) => row.path).sort()).toEqual(everyFileOnDisk(coreFolder));
	});

	it("names no file the core does not hold", () => {
		const onDisk = everyFileOnDisk(coreFolder);
		for (const { path } of mappedCoreRows()) expect(onDisk, path).toContain(path);
	});

	it("keeps a service and the section that draws it next to each other", () => {
		const paths = mappedCoreRows().map((row) => row.path);
		const sectionOf = (path: string) => path.replace(/\.ts$/, "Section.ts");
		const services = paths.filter((path) => paths.indexOf(sectionOf(path)) >= 0);
		expect(services.length).toBeGreaterThanOrEqual(3);
		for (const service of services) {
			expect(Math.abs(paths.indexOf(service) - paths.indexOf(sectionOf(service))), service).toBe(1);
		}
	});

	it("says what each file owns, as a finished sentence", () => {
		for (const { path, owns } of mappedCoreRows()) {
			expect(owns.length, path).toBeGreaterThan(20);
			expect(owns.endsWith("."), `${path}: ${owns}`).toBe(true);
		}
	});
});

/* -------------------------------------------------------------------------- */
/* The README's repeat rules.                                    */
/* -------------------------------------------------------------------------- */

/*
 * The README tells a stranger which repeat rules are read, as concrete
 * `🔁 …` code spans, and a stranger copies them. So every such span anywhere
 * in the README must be a rule the core reads — a span the core refuses would
 * teach a rule that is reported instead of repeating. And the spans of the one
 * paragraph that lists the forms, **Which repeat rules are read.**, must
 * together show every shape of the subset, so dropping one from that list
 * fails here even where another section happens to show the same rule.
 *
 * The shapes are worked out from the parsed rules, so rewording an example to
 * another of the same shape still passes. The list they are compared with is
 * spec #1222 decision 2's subset, written out here rather than derived from
 * `repeatRule.ts`: a shape the core gains is added to it by hand, together
 * with its example in the README.
 */

/** The text after `🔁 ` of every code span in `text` that starts with it. */
function ruleSpansIn(text: string): string[] {
	return Array.from(text.matchAll(/`🔁 ([^`]+)`/g), (match) => match[1]);
}

const readmeText = (): string => readFileSync(resolve(repoRoot, "README.md"), "utf8");

/** The README's one line that lists the forms read. */
function formsParagraph(): string {
	const lines = readmeText()
		.split("\n")
		.filter((line) => line.startsWith("**Which repeat rules are read.**"));
	expect(lines).toHaveLength(1);
	return lines[0];
}

/** The shape a read rule shows, in the words the subset is described in. */
function shapesOf(rule: RepeatRule): string[] {
	const shapes: string[] = [];
	const isEveryWeekday =
		rule.interval === 1 &&
		rule.weekdays !== null &&
		rule.weekdays.length === 5 &&
		rule.weekdays.every((day, index) => day === index);
	if (isEveryWeekday) shapes.push("every weekday");
	else if (rule.weekdays !== null) shapes.push(rule.weekdays.length > 1 ? "several weekdays" : "one weekday");
	else if (rule.monthDays !== null) {
		if (rule.monthDays[0] === "last") shapes.push("the last day of the month");
		else shapes.push(rule.monthDays.length > 1 ? "two days of the month" : "one day of the month");
	} else shapes.push(rule.interval === 1 ? `every ${rule.unit}` : `every N ${rule.unit}s`);
	if (rule.interval > 1 && (rule.weekdays !== null || rule.monthDays !== null)) {
		shapes.push(`an interval on a ${rule.unit} list`);
	}
	if (rule.whenDone) shapes.push("when done");
	return shapes;
}

describe("the README's repeat rules", () => {
	it("shows only rules the core reads", () => {
		const spans = ruleSpansIn(readmeText());
		expect(spans.length).toBeGreaterThan(0);
		for (const span of spans) expect(readRepeatRule(span), span).not.toBeNull();
	});

	it("lists every shape of the subset in the paragraph that lists the forms", () => {
		const shown = new Set(
			ruleSpansIn(formsParagraph())
				.map((span) => readRepeatRule(span))
				.filter((rule): rule is RepeatRule => rule !== null)
				.flatMap(shapesOf),
		);
		const expected = [
			"every day",
			"every N days",
			"every week",
			"every N weeks",
			"every month",
			"every N months",
			"every year",
			"every N years",
			"one weekday",
			"several weekdays",
			"an interval on a week list",
			"every weekday",
			"one day of the month",
			"two days of the month",
			"the last day of the month",
			"an interval on a month list",
			"when done",
		];
		expect([...shown].sort()).toEqual([...expected].sort());
	});
});

/* -------------------------------------------------------------------------- */
/* The same words, swept across the plugin's own strings.    */
/* -------------------------------------------------------------------------- */

/*
 * The sweep above reads the shipped documents. This one reads the plugin
 * itself, which is the half both #64 and #69 were left short of.
 *
 * **Why it is not simply every string in `src/`.** Reading a source as text
 * was measured and rejected, and the measurement is kept with the rule it
 * settled rather than here: `shownStrings`'s doc comment in `./vocabulary`
 * carries it, together with how to reproduce it. The short of it is that most
 * shipped sources match a retired word on an identifier rather than on a
 * sentence, so a text sweep would fire almost everywhere and no edit would
 * quieten it. What was needed instead was a rule for which strings a person
 * actually meets, and `shownStrings` is that rule — position rather than text,
 * the same way `styles.test.ts` decides what is a class name. Its
 * own comment carries the list of positions and the reason for each.
 *
 * **Two sweeps, and both are needed.** This one reads what the sources hand to
 * a call that shows text, including the rows the settings screen's own render
 * never reaches — `calendarSourcesSection.ts` had two breaching descriptions
 * for a whole wave for exactly that reason, and a hand-written check on that one
 * file used to sit in `settingsTab.test.ts`. That check is gone: this replaces
 * it and covers every source rather than the one somebody remembered.
 *
 * What this one cannot see is a sentence assembled at runtime and a badge label
 * looked up in a table. `settingsTab.test.ts` reads the screen as it is drawn
 * and sees those. The third thing neither saw was a shipped settings value that
 * a box shows because nobody changed it — the calendar column named *Event* — and the last describe below is what closes that.
 */

describe("the words the plugin's own strings use", () => {
	const words = retiredWords(glossary);
	const sources = shippedSources();

	it("reads strings out of the sources rather than finding none", () => {
		// A sweep that matches nothing passes every test it has. Both halves
		// matter: that the walk found the sources, and that the rule found
		// sentences inside them.
		expect(sources.length).toBeGreaterThan(15);
		const shown = sources.flatMap(({ source }) => shownStrings(source));
		expect(shown.length).toBeGreaterThan(40);
		expect(shown).toContain("Add a calendar");
	});

	it.each(shippedSources())("uses no term the glossary retires, in $path", ({ source }) => {
		expect(retiredIn(shownStrings(source).join("\n"), words)).toEqual([]);
	});

	it("would say so if a retired term came back", () => {
		// The known-bad case, in the two shapes this rule has to get right: a
		// description on a settings row, and a `Notice` built as a template.
		const fabricated = [
			'new Setting(body).setDesc("Where your daily notes are kept.");',
			"new Notice(`Effortless: that event could not be saved. ${detail}`);",
		].join("\n");

		expect(retiredIn(shownStrings(fabricated).join("\n"), words)).toEqual(["daily note", "event"]);
	});

	it("reads a string a person meets and leaves an identifier alone", () => {
		// The whole of the rule, in two lines that differ only in position. The
		// second is why sweeping every string was rejected.
		expect(shownStrings('new Notice("A calendar event.");')).toEqual(["A calendar event."]);
		expect(shownStrings('const eventName = "A calendar event.";')).toEqual([]);
	});

	it("reads a comment as prose about the code and never as the code", () => {
		// A note quoting the sentence a commit has just rewritten is not that
		// sentence. Without this the guard would fail on its own history.
		expect(shownStrings('// It used to say .setDesc("your daily notes").')).toEqual([]);
	});

	it("leaves what is inside a template's ${} alone, because that is code", () => {
		// `response.status` is Obsidian's name for an HTTP field. *status* is a
		// word this repository retires, for a **feature state**, and reading the
		// interpolation as words would fail this guard on a line nobody reads.
		expect(shownStrings("new Error(`The calendar link answered ${response.status}.`)")).toEqual([
			"The calendar link answered  .",
		]);
	});
});

/* -------------------------------------------------------------------------- */
/* And across the settings the plugin ships.           */
/* -------------------------------------------------------------------------- */

/*
 * A shipped default is a string on the settings screen of everyone who has
 * never changed it, and it is neither a document nor a string handed to a call
 * that draws text — it is a value. The calendar column named *Event* survived
 * both other sweeps that way. Read as values rather than as source text, so a
 * default added tomorrow is swept without anyone teaching a regex about it.
 */

/** Every string held anywhere in the shipped defaults, at whatever depth. */
function shippedStrings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(shippedStrings);
	if (typeof value === "object" && value !== null) {
		return Object.values(value).flatMap(shippedStrings);
	}
	return [];
}

describe("the words the shipped settings use", () => {
	const words = retiredWords(glossary);

	it("reads the defaults rather than finding none", () => {
		expect(shippedStrings(defaultData()).filter((text) => text.length > 0)).toContain("Meeting");
	});

	it("uses no term the glossary retires", () => {
		expect(retiredIn(shippedStrings(defaultData()).join("\n"), words)).toEqual([]);
	});

	it("would say so if a retired term came back", () => {
		// What this column shipped as until issue #195.
		expect(retiredIn("Event", words)).toEqual(["event"]);
	});
});

/* -------------------------------------------------------------------------- */
/* The terms the glossary marks `(bare — …)`.                     */
/* -------------------------------------------------------------------------- */

describe("the terms the sweeps do not match", () => {
	const words = retiredWords(glossary);

	it("has a stated reason for every term the glossary annotates", () => {
		// The skip itself is right: "Calendar sources" and "Add a calendar" are
		// both correct, so a guard failing every *calendar* would fail on good
		// prose. What was missing is that marking a third term `(bare — …)`
		// unguarded it and nobody would have known.
		for (const word of bareAnnotated(words)) {
			expect(Object.keys(bareReasons), word).toContain(word);
		}
	});

	it("keeps no reason for a term the glossary no longer annotates", () => {
		// The other direction, the same shape as the `notMatchable` test above:
		// a permission left behind for nothing.
		expect(Object.keys(bareReasons).sort()).toEqual(bareAnnotated(words));
	});

	it("covers the three terms annotated today", () => {
		expect(bareAnnotated(words)).toEqual(["calendar", "notice", "password"]);
	});

	it("would say so if an annotation arrived with no reason", () => {
		// The known-bad case, driven with a fabricated glossary so that it does
		// not need `GLOSSARY.md` to be edited to show it.
		const fabricated = "**Widget**:\nOne of those.\n_Avoid_: doohickey (bare — sometimes right)\n";
		expect(bareAnnotated(retiredWords(fabricated))).toEqual(["doohickey"]);
		expect(Object.keys(bareReasons)).not.toContain("doohickey");
	});

	it("still lets a qualified use through, and still matches an unannotated word", () => {
		expect(retiredIn("Calendar sources", words)).toEqual([]);
		expect(retiredIn("Where your journal is kept.", words)).toEqual(["journal"]);
	});

	it("would fail the plugin's own button if the annotated word were matched", () => {
		// Why telling a bare use from a qualified one is still open, recorded
		// where whoever tries it next will meet it rather than as a conclusion
		// in a comment. The glossary's note on *calendar* says a source may
		// hold several calendars, so "Add a calendar" is right — and that
		// sentence is the settings screen's own button.
		//
		// Driven with a glossary that does not annotate the word, the same
		// sentence fails, which is what any guard written on the bare word
		// would do to shipped text. So the remainder of #204 is not a matter of
		// writing a better match: nothing about the word itself separates the
		// two uses.
		const unannotated = "**Calendar source**:\nOne of those.\n_Avoid_: calendar\n";
		expect(retiredIn("Add a calendar", retiredWords(unannotated))).toEqual(["calendar"]);

		const shown = shippedSources().flatMap(({ source }) => shownStrings(source));
		expect(shown).toContain("Add a calendar");
		expect(bareReasons.calendar).toContain("Add a calendar");
	});
});

/* -------------------------------------------------------------------------- */
/* The glossary defines the terms its own entries lean on.        */
/* -------------------------------------------------------------------------- */

/*
 * **Forwarding** turns on the heading a line sits under: that heading is what
 * says whether the task went into a collection or on to the next day. It named
 * "the task headings" for the second of those, and the glossary defined no such
 * thing — the only entries with a name like it are **The tasks heading** and
 * **The completed-tasks heading**, which both live in a collection and are
 * explicitly not sections. A reader following the sentence landed nowhere.
 *
 * Spec #32 had already
 * settled what the thing is: the day's task sections are a reserved group in
 * the vault layout whose individual names come from the feature ticket that
 * first needs one. The glossary was missing the entry, not a decision.
 *
 * These guards are about the glossary's own wiring rather than about the
 * plugin. They live in this file because it is already where `GLOSSARY.md` is
 * read.
 */

/** One glossary entry, from its bold term to the blank line that ends it. */
function glossaryEntry(term: string): string {
	const block = glossary
		.split(/\n\s*\n/)
		.find((entry) => entry.trim().startsWith(`**${term}**:`));
	return block ?? "";
}

describe("the glossary's own cross-references", () => {
	it("defines the day's task sections", () => {
		const entry = glossaryEntry("The day's task sections");

		expect(entry.length).toBeGreaterThan(200);
		// Levelled sections of the day's log, and not the two collection-side
		// headings a reader would otherwise land on.
		expect(entry).toContain("day's log");
		expect(entry).toContain("tasks heading");
		expect(entry).toContain("VaultLayout");
		// Cites spec #32 by its number, which the public copy keeps when it
		// drops the link.
		expect(entry).toMatch(/#32\b/);
	});

	it("leaves any day's task section beyond today and overdue to the feature ticket that needs one", () => {
		// Criterion 5 of #182, the ticket that wrote this entry: the entry may not invent a
		// heading's text, its level or a `VaultLayout` field name ahead of the
		// feature ticket that settles it. Issue #801 is that feature ticket for
		// exactly two of them — `todayHeading` and `overdueHeading` — so their
		// names are no longer an invention here; a third name would still be
		// one, which is what this asserts now.
		const headingNames = glossaryEntry("The day's task sections").match(/`\w*[Hh]eading`/g) ?? [];
		expect(headingNames.sort()).toEqual(["`overdueHeading`", "`todayHeading`"]);
	});

	it("makes Forwarding point at that term rather than at an undefined plural", () => {
		const entry = glossaryEntry("Forwarding");

		expect(entry).toContain("the day's task sections");
		expect(entry).not.toContain("the task headings");
	});

	it("still enumerates only the two sections that exist today, under Section", () => {
		// The reserved group is reserved. **Section** says what the day's log
		// actually has, and gaining the entry above must not quietly turn a
		// reservation into a third section.
		const entry = glossaryEntry("Section");

		expect(entry).toContain("the notes heading and the calendar heading");
	});
});
