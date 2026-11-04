/**
 * The release workflow against the one thing it has to do before it publishes:
 * run the suite.
 *
 * #133 put an `npm test`
 * step into `.github/workflows/release.yml`, between the install and the build,
 * so that a red suite stops a draft release being cut. Nothing guarded that
 * step. Deleting it left every test in this repository passing, and the gap
 * would have shown at a real release — the one moment nobody is watching for it
 * and the one moment the plugin becomes installable.
 *
 * **The shape of the step, never its text.** A step renamed, or rewritten to
 * another spelling that still puts the whole suite through, has to pass here.
 * So this file reads what each step *runs* and where it sits, and never what it
 * is called. The job it reads is the one that **publishes the release**, found
 * by its publishing step rather than by its name, so a job added above it
 * changes nothing here.
 *
 * **What an edit to the workflow can fail this file with, all five of them**
 * (#310 — the sentence this
 * replaces named the first two and left three unsaid):
 *
 * - Losing the test run, or narrowing it to less than the whole suite.
 * - Moving the test run after the build, where it guards nothing.
 * - Deleting the install step. The suite needs the dependencies, and the guard
 *   needs the step to judge the ordering against.
 * - Deleting the build step. Same: it is the other end of the ordering.
 * - **Changing the number of steps at all.** The parser check below asserts a
 *   fixed length — seven steps, five of which run something — because a length
 *   that moved on its own is a parser that lost or merged a step, and every
 *   other case in this file would then be measuring a fiction. Adding a step to
 *   the release workflow is an ordinary thing to do, so it turns this file red
 *   on purpose: **a deliberate workflow edit updates the two expected counts in
 *   that test, in the same commit.** Nothing else here has to be touched.
 *
 * The workflow is read, never triggered. This machine cannot push a tag, and
 * the run itself is #133's own deferred acceptance step.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./repoRoot";

/** Where the workflow lives, relative to the repository root. */
const workflowPath = ".github/workflows/release.yml";

/** One step of a workflow job: what it is called, what action it uses, and what it runs. */
interface Step {
	readonly name: string;
	readonly uses: string;
	readonly run: string;
}

/**
 * A block scalar's header: the indicator, then a chomping or indentation
 * indicator if it carries one.
 *
 * Matched as a pattern rather than compared against `|` and `>` alone. `|-` and
 * `>-` — the dash strips the trailing newline — are the ordinary spelling in
 * GitHub Actions files, and `|+`, `|2` and their `>` forms are legal too. A
 * reader that knows only the two bare markers drops the whole body of such a
 * step and reads it as running the literal text `|-`, which then reports the
 * step as running nothing.
 */
const blockScalar = /^[|>][-+]?\d*$/;

/**
 * The jobs of a workflow, in file order, each with its steps.
 *
 * This is not a YAML parser and does not try to be one. It reads the `jobs:`
 * mapping of a GitHub Actions workflow and, inside each job, the `steps:` list
 * — a plain sequence of mappings at a fixed indent — keeping only the three
 * keys this guard asks about. A YAML parser would be the better tool and would
 * be a new dependency on a plugin heading for the community list; the workflow
 * file is ours and it is 59 lines long.
 */
function jobsOf(workflow: string): Array<{ name: string; steps: Step[] }> {
	const lines = workflow.split("\n");
	const opensJobs = lines.findIndex((line) => /^jobs:\s*$/.test(line));
	if (opensJobs === -1) return [];

	const body = lines.slice(opensJobs + 1);
	const first = body.find((line) => line.trim() !== "" && !/^\s*#/.test(line));
	if (first === undefined) return [];
	const jobIndent = indentOf(first);

	const jobs: Array<{ name: string; lines: string[] }> = [];
	for (const line of body) {
		if (line.trim() === "" || /^\s*#/.test(line)) continue;
		const indent = indentOf(line);
		if (indent < jobIndent) break;
		const opensJob = indent === jobIndent ? /^\s*([A-Za-z0-9_.-]+):\s*$/.exec(line) : null;
		if (opensJob) jobs.push({ name: opensJob[1], lines: [] });
		else if (jobs.length > 0) jobs[jobs.length - 1].lines.push(line);
	}

	return jobs.map((job) => ({ name: job.name, steps: stepsIn(job.lines) }));
}

/**
 * The steps of one job, in the order they run.
 *
 * `run: |` is a block scalar, so its body is the more-indented lines that
 * follow it. They are joined with newlines and read as one command list.
 */
function stepsIn(jobLines: string[]): Step[] {
	const opensSteps = jobLines.findIndex((line) => /^\s*steps:\s*$/.test(line));
	if (opensSteps === -1) return [];

	const listIndent = indentOf(jobLines[opensSteps]);
	const steps: Array<{ name: string; uses: string; run: string[] }> = [];
	let blockIndent: number | null = null;

	for (const line of jobLines.slice(opensSteps + 1)) {
		if (line.trim() === "" || /^\s*#/.test(line)) continue;
		const indent = indentOf(line);

		// A block scalar's body is everything indented past the key that opened
		// it, and it ends the moment the indent comes back.
		if (blockIndent !== null) {
			if (indent >= blockIndent) {
				steps[steps.length - 1].run.push(line.trim());
				continue;
			}
			blockIndent = null;
		}

		if (indent <= listIndent) break;

		const item = /^\s*-\s+(.*)$/.exec(line);
		const body = item ? item[1] : line.trim();
		if (item) steps.push({ name: "", uses: "", run: [] });
		if (steps.length === 0) continue;

		const key = /^(name|uses|run):\s*(.*)$/.exec(body);
		if (!key) continue;
		if (key[1] === "name") steps[steps.length - 1].name = key[2].trim();
		else if (key[1] === "uses") steps[steps.length - 1].uses = key[2].trim();
		else if (blockScalar.test(key[2].trim())) blockIndent = indent + 1;
		else steps[steps.length - 1].run.push(key[2].trim());
	}

	return steps.map((step) => ({ name: step.name, uses: step.uses, run: step.run.join("\n") }));
}

/**
 * Does this step publish the release?
 *
 * What makes a job *the* release job, and the reason this file does not look
 * for a job named `build`: a name is text, and this file judges shape rather
 * than text. "The job with install, test and build in it" was the other
 * candidate and it is worse — an unrelated job of that shape would satisfy the
 * guard while the job that actually publishes went unread.
 */
function publishesTheRelease(step: Step): boolean {
	return /\bgh\s+release\s+create\b/.test(step.run) || /release/i.test(step.uses);
}

/**
 * The steps of the job that publishes the release.
 *
 * **The fallback matters as much as the rule.** Where no job publishes and the
 * file holds exactly one job, that job is judged — every fixture in this file
 * is built that way, and a workflow whose publishing step has been lost still
 * has to be told what else is wrong with it. Where no job publishes and there
 * are several, there is nothing here to judge and the caller reports the
 * workflow as having no test run at all.
 */
function stepsOf(workflow: string): Step[] {
	const jobs = jobsOf(workflow);
	const publishes = jobs.filter((job) => job.steps.some(publishesTheRelease));
	if (publishes.length > 0) return publishes[0].steps;
	return jobs.length === 1 ? jobs[0].steps : [];
}

/** How many spaces a line begins with. */
function indentOf(line: string): number {
	return /^ */.exec(line)?.[0].length ?? 0;
}

/** The separate commands a `run:` block invokes, in order. */
function commandsIn(run: string): string[] {
	return run
		.split(/\n|&&|\|\||;/)
		.map((command) => command.trim())
		.filter((command) => command !== "");
}

/**
 * The flags that run part of the suite. Every one of them is disqualifying,
 * however it is spelled.
 *
 * A denylist rather than a list of acceptable flags: an allowlist would go
 * stale on every vitest release and turn an ordinary `--reporter` into a failed
 * release, while this list names the one thing the guard cares about, which is
 * narrowing.
 */
const selectorFlags = new Set([
	"-t",
	"--testNamePattern",
	"--project",
	"--shard",
	"--dir",
	"--changed",
	"--related",
]);

/**
 * Does this command put the **whole** suite through?
 *
 * A subset is not what a release has to be sure of: `vitest run styles` runs
 * one file and leaves every other guard unrun at the moment they all matter.
 * So a bare word after the verb — a path — is disqualifying, and so is a flag
 * that names which tests to run.
 *
 * **`vitest` is accepted as `run` and as `--run`.** Both put the whole suite
 * through once and exit; refusing the second reported a correct workflow as
 * having no test step at all.
 *
 * The package manager is read too, rather than only `npm`, because which one
 * the workflow calls is not what this guard is about.
 */
function runsTheWholeSuite(command: string): boolean {
	const words = command.split(/\s+/).filter((word) => word !== "npx");
	const managed = /^(?:npm|pnpm|yarn|bun)$/.test(words[0] ?? "");
	const verbAt = managed && words[1] === "run" ? 2 : managed ? 1 : 0;
	const verb = words[verbAt];
	const rest = words.slice(verbAt + 1);

	if (verb === "test") return rest.every(leavesTheSuiteWhole);
	if (verb === "vitest" && (rest[0] === "run" || rest[0] === "--run")) {
		return rest.slice(1).every(leavesTheSuiteWhole);
	}
	return false;
}

/**
 * Is this argument something a whole-suite run may carry — a flag, and not one
 * that narrows the run?
 *
 * **The word is the part before the first `=`.** A flag and its value may be
 * joined with `=` or separated by a space, and the two spellings mean the same
 * thing: `-t=badge` ran one test by name and was read as an ordinary flag, so
 * the guard reported a workflow clean while a fraction of the suite ran.
 */
function leavesTheSuiteWhole(word: string): boolean {
	const head = word.split("=")[0];
	return head.startsWith("-") && !selectorFlags.has(head);
}

/** Does this command install the dependencies the rest of the job needs? */
function installsDependencies(command: string): boolean {
	return /^(?:npm|pnpm|yarn|bun)\s+(?:ci|install|add)\b/.test(command);
}

/** Does this command build the plugin? */
function buildsThePlugin(command: string): boolean {
	return /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/.test(command);
}

/** The index of the first step whose `run` satisfies `does`, or `-1`. */
function firstStepThat(steps: Step[], does: (command: string) => boolean): number {
	return steps.findIndex((step) => commandsIn(step.run).some(does));
}

/**
 * What is wrong with this workflow, in plain sentences, or `[]` when nothing
 * is.
 *
 * A verdict rather than an assertion, so that the cases below can hand it a
 * workflow that is deliberately broken and read what it says.
 */
function faults(workflow: string): string[] {
	const steps = stepsOf(workflow);
	const tests = firstStepThat(steps, runsTheWholeSuite);
	const installs = firstStepThat(steps, installsDependencies);
	const builds = firstStepThat(steps, buildsThePlugin);
	const problems: string[] = [];

	if (tests === -1) problems.push("no step runs the whole test suite");
	if (installs === -1) problems.push("no step installs the dependencies");
	if (builds === -1) problems.push("no step builds the plugin");
	if (tests !== -1 && installs !== -1 && tests < installs) {
		problems.push("the suite runs before the dependencies are installed");
	}
	if (tests !== -1 && builds !== -1 && tests > builds) {
		problems.push("the suite runs after the build, which guards nothing");
	}

	return problems;
}

/**
 * A workflow of several jobs, each with the steps given, in the order given.
 *
 * The job a workflow publishes from is the one this file judges, so a fixture
 * with a job above the release job is the only way to prove that. A job built here
 * publishes only if its steps say so.
 */
function workflowOfJobs(...jobs: Array<readonly [name: string, steps: string[]]>): string {
	const lines = ["name: Release", "", "jobs:"];
	for (const [name, steps] of jobs) lines.push(`  ${name}:`, "    steps:", ...steps);
	return lines.join("\n");
}

/** A workflow of the shape this repository's release workflow has: one job. */
function workflowOf(...steps: string[]): string {
	return workflowOfJobs(["build", steps]);
}

const checkout = "      - uses: actions/checkout@v4";
const install = ["      - name: Install", "        run: npm ci"].join("\n");
const test = ["      - name: Test", "        run: npm test"].join("\n");
const build = ["      - name: Build", "        run: npm run build"].join("\n");
const publish = [
	"      - name: Create the draft release",
	'        run: gh release create "$tag" --title="$tag" --draft main.js manifest.json',
].join("\n");
const lint = ["      - name: Lint", "        run: npm run lint"].join("\n");

describe("the release workflow", () => {
	it("runs the whole suite after installing and before building", () => {
		const workflow = readFileSync(resolve(repoRoot, workflowPath), "utf8");
		expect(faults(workflow)).toEqual([]);
	});

	// The two failing cases the ticket names. Both were proved against the real
	// file first — deleted, red; moved, red; reverted, green.
	it("says so when the test step is deleted", () => {
		expect(faults(workflowOf(checkout, install, build))).toContain(
			"no step runs the whole test suite",
		);
	});

	it("says so when the test step moves after the build", () => {
		expect(faults(workflowOf(checkout, install, build, test))).toContain(
			"the suite runs after the build, which guards nothing",
		);
	});

	// The third case, and the reason this file reads commands rather than
	// names: a step is free to be called anything and free to be respelled, so
	// long as the whole suite still runs in the right place.
	it.each([
		["a renamed step", "      - name: Guard the release\n        run: npm test"],
		["npm run test", "      - name: Test\n        run: npm run test"],
		["npx vitest run", "      - name: Test\n        run: npx vitest run"],
		["vitest run with flags", "      - name: Test\n        run: npx vitest run --reporter=dot"],
		["pnpm test", "      - name: Test\n        run: pnpm test"],
		["a block scalar", "      - name: Test\n        run: |\n          npm test"],
		["a chained command", "      - name: Test\n        run: npm run lint && npm test"],
		// #299: a whole-suite run written the other way, and an `=`-joined flag
		// that narrows nothing.
		//
		// `npx vitest run --reporter=dot` is not a third row here. #299 asked for
		// it and the "vitest run with flags" row above already asserted that exact
		// step text, so the row written for it was one assertion under a second
		// name — a reader changing one had no signal the other was there.
		["npx vitest --run", "      - name: Test\n        run: npx vitest --run"],
		["npm test with an =-joined reporter", "      - name: Test\n        run: npm test --reporter=dot"],
		// #306: the block scalar markers GitHub Actions files really carry. The
		// dash strips the trailing newline and is the common spelling of all of
		// them; a reader that matches `|` and `>` alone drops the body and reads
		// the step as running the literal marker.
		["a stripped block scalar", "      - name: Test\n        run: |-\n          npm test"],
		["a folded block scalar", "      - name: Test\n        run: >-\n          npm test"],
		["a kept block scalar", "      - name: Test\n        run: |+\n          npm test"],
		["an indented block scalar", "      - name: Test\n        run: |2\n          npm test"],
	])("does not mind %s", (_spelling, step) => {
		expect(faults(workflowOf(checkout, install, step, build))).toEqual([]);
	});

	// The other half of reading the command: a step named `Test` that runs
	// something else is not the step this guards, and a run over one file is
	// not the whole suite.
	it.each([
		["a step called Test that runs nothing of the sort", '      - name: Test\n        run: echo "later"'],
		["a run over one test file", "      - name: Test\n        run: npx vitest run styles"],
		["a run narrowed to one test by name", '      - name: Test\n        run: npm test -t "the badge"'],
		// #299: the same narrowing joined with `=`. A word beginning with `-`
		// was read as a flag whole, so all three of these reported the workflow
		// clean while running a fraction of the suite.
		["a test named with -t=", "      - name: Test\n        run: npm test -t=badge"],
		["a run narrowed to one project", "      - name: Test\n        run: npm test --project=unit"],
		["a run narrowed to one shard", "      - name: Test\n        run: npm test --shard=1/4"],
	])("is not satisfied by %s", (_spelling, step) => {
		expect(faults(workflowOf(checkout, install, step, build))).toContain(
			"no step runs the whole test suite",
		);
	});

	// #309: the job this file judges is the one that publishes the release, not
	// whichever `steps:` list comes first in the file. With one job and no
	// publishing step — every fixture above — it falls back to that one job.
	it("judges the job that publishes the release, not the first job in the file", () => {
		const workflow = workflowOfJobs(
			["lint", [checkout, lint]],
			["release", [checkout, install, test, build, publish]],
		);
		expect(faults(workflow)).toEqual([]);
	});

	it("says so when the publishing job itself is wrong, whatever sits above it", () => {
		const workflow = workflowOfJobs(
			["lint", [checkout, install, test, build]],
			["release", [checkout, install, build, publish]],
		);
		expect(faults(workflow)).toContain("no step runs the whole test suite");
	});

	// The parser earns its keep only if it reads the real file the way a person
	// does. If it drifts, every case above is measuring a fiction. Nothing here
	// names a step: a rename must not fail this file, which is the whole point
	// of reading commands rather than names.
	it("reads the real workflow as a list of steps, one per item", () => {
		const steps = stepsOf(readFileSync(resolve(repoRoot, workflowPath), "utf8"));
		expect(steps).toHaveLength(7);
		// The first two are `uses:` steps and run nothing; every other one runs
		// something. A parser that lost a step, or merged two, fails here.
		expect(steps.filter((step) => step.run !== "")).toHaveLength(5);
	});

	// `run: |` is a block scalar and its body is the indented lines below it. A
	// parser that read only the first line would see a command list one line
	// long and could call a narrowed run a whole one.
	it("reads a block scalar's whole body, not only its first line", () => {
		const steps = stepsOf(readFileSync(resolve(repoRoot, workflowPath), "utf8"));
		const blocks = steps.filter((step) => step.run.includes("\n"));
		expect(blocks.length).toBeGreaterThan(0);
		expect(blocks.some((step) => step.run.includes("GITHUB_REF"))).toBe(true);
	});
});
