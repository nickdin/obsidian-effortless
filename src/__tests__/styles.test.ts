/**
 * The stylesheet against the class names the plugin actually applies.
 *
 * `styles.css` was owned by no worker for four waves, so the gap between the
 * two grew by a class name or two per wave and nothing added it up. This is the sum:
 * every class name the plugin source applies has to have a rule behind it, and
 * the eleventh one arrives as a failing test rather than as a plain stacked
 * list somebody notices six weeks later.
 *
 * Only the plugin's own source is read. `src/__tests__` is left out on purpose:
 * a test may name a class that no longer exists in order to prove it is gone,
 * and `platform.test.ts` builds a temporary directory whose name begins
 * `effortless-platform-`, which is not a class name at all.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// A class name is one the code applies, not one a comment mentions: without
// this, `settingsTab.ts`'s note about the container class that #107 removed
// would itself be read as a class name with no rule behind it. The stripper is
// shared rather than copied — every guard that reads this repository's source
// answers for comments the same way. So is what counts as a quoted string:
// `quotedLiteral` in the same module is the one home for the escape rule, and
// this file derives its literal-matching from it rather than spelling it again.
import { DEFAULT_SEQUENCES } from "../features/checkboxCycling/sequences";
import { cssRules, everyFileOnDisk, quotedLiteral, sourceRoot, testFolder, withoutComments } from "./sourceGuards";
import { repoRoot } from "./repoRoot";

/**
 * The eleven ways this plugin puts a class on an element, each followed by the
 * string literals it is given. Everything before the literals is the applying
 * position; group 2 is the arguments themselves.
 *
 * The group numbering is load-bearing: the collector reads group 2 and the run
 * of literals closes on the backreference `\3`. A branch added here must be
 * non-capturing, or every index after it moves and the collector reads the
 * wrong thing.
 *
 * Obsidian accepts more than a bare literal in each of these places, and a
 * spelling the pattern cannot see is a class name that goes unchecked rather
 * than one that fails.
 * Three shapes are therefore allowed between the applying position and the
 * literals:
 *
 * - **An array** — `DomElementInfo.cls` is `string | string[]`, so
 *   `cls: ["effortless-a", "effortless-b"]` is legal. The optional `[` lets the
 *   run of literals start inside it; the run already handles the commas.
 * - **A condition** — `cls: open ? "effortless-a" : "effortless-b"`. The
 *   condition is skipped up to its `?`, and `:` joins the two arms inside the
 *   run, so both are collected. The condition may hold no quote, brace,
 *   bracket, comma, colon or newline, which keeps the skip from reaching past
 *   its own property into the next one.
 * - **The string shorthand** — `createDiv("effortless-a")`,
 *   `createSpan("effortless-a")`, `createEl("div", "effortless-a")` and
 *   `createSvg("svg", "effortless-a")`. The first three are all of the
 *   element-creating calls Obsidian declares with a `DomElementInfo | string`
 *   argument;
 *   `createSvg` is a fourth call with the same tag-then-class shorthand, but it
 *   takes `SvgElementInfo | string`, which is why counting the `DomElementInfo`
 *   ones left it out. `createDiv` and
 *   `createSpan` take the class first; `createEl` and `createSvg` take the tag
 *   first and share one arm of the pattern, so their own quoted argument is
 *   consumed by the position rather than collected. The object form of
 *   `createSvg` needs no arm of its own: `SvgElementInfo` carries `cls` the way
 *   `DomElementInfo` does, and `cls:` above already reaches it.
 *
 * `TooltipOptions.classes` is read at the same position as `cls:` and shares
 * its tail. It is Obsidian's fourth declared way of naming a class in an object
 * literal (`node_modules/obsidian/obsidian.d.ts:7208`), it is always an array,
 * and `setTooltip(el, "text", { classes: ["effortless-a"] })` is the shape the
 * `cls:` array bullet above already describes — so it joined the pattern rather
 * than the limits below, the way `createSvg` did. The plugin calls
 * no tooltip API today; the arm is here so that the first one to be written is
 * checked rather than the eleventh
 * (#297 is where counting
 * the declared spellings started).
 *
 * `classList.add(...)`, `.toggleClass(...)` and `.addClasses([...])` take more
 * than one name, so a run of comma-separated literals is captured rather than
 * only the first. `addClasses` is the array-taking spelling of `addClass` and
 * is read at the same position.
 *
 * A class name held in a variable or built by a helper is still not read, and
 * neither is a condition written across several lines. Those two are the file's
 * whole stated limit, and both are shapes a static reader genuinely cannot
 * follow rather than ones left out. A spelling that is a literal in the source —
 * `classes:` was the last of them — belongs in the pattern instead.
 *
 * What the pattern reaches is the list of applying positions above and the
 * three shapes named here, and nothing else — it is not claimed to
 * reach every spelling Obsidian declares, because that claim was made once and
 * `createSvg` falsified it. A spelling missing from this list is a class
 * name that goes unchecked rather than one that fails, so a new one is added
 * here with a sibling row in the table that names each form.
 */
const applyingPositions = new RegExp(
	String.raw`(?:\b(?:cls|classes)\s*:|\.(?:addClass(?:es)?|setClass|toggleClass)\s*\(|\.classList\s*\.\s*add\s*\(|\bcreate(?:Div|Span)\s*\(|\bcreate(?:El|Svg)\s*\(\s*(["'\`])[^"'\`]*\1\s*,)\s*(?:[^"'\`{}()\[\],:;\n]*\?\s*)?\[?\s*` +
		String.raw`((?:${quotedLiteral(String.raw`(["'\`])`, String.raw`\3`, "skip")}\s*[,:]?\s*)+)`,
	"g",
);

/**
 * Every `effortless-…` name the source applies, including the ones the source
 * only writes the front of.
 *
 * **Position, not text.** A name counts only where it is handed to one of the
 * applying calls above. Reading the whole file instead would fail this test on
 * any `effortless-`-prefixed string that was never a class — a command id, a
 * settings key, a plugin folder in a path — and no rule anyone could add to
 * `styles.css` would fix it, because the string is not a class name. Excluding such
 * strings one by one was rejected in the same ticket: a list of names to ignore
 * drifts exactly the way the gap this file measures did.
 *
 * A name ending in `-` is one the code builds from a variable — the badge is
 * written `effortless-badge-${status.state}`, so the source holds
 * `effortless-badge-` and never the whole name. It is carried through as the
 * prefix it is and matched as one below. `$` is outside the character class,
 * so widening it to capitals below does not swallow the interpolation.
 *
 * Capitals are in the class because the states are camelCase and reach the
 * stylesheet that way: `.effortless-badge-notStarted` has a rule today. A
 * lowercase-only matcher read an applied `effortless-countBadgeXyz` as
 * `effortless-count`, found that rule, and passed a name with none behind it —
 * the exact failure this file exists to catch.
 */
function appliedClasses(source: string): string[] {
	const text = withoutComments(source);
	const names: string[] = [];

	applyingPositions.lastIndex = 0;
	for (let hit = applyingPositions.exec(text); hit; hit = applyingPositions.exec(text)) {
		names.push(...(hit[2].match(/effortless-[A-Za-z-]*/g) ?? []));
	}

	return [...new Set(names)].sort();
}

/** Every class name `styles.css` has a rule for. Capitals count: `notStarted`. */
function styledClasses(css: string): string[] {
	return [...new Set((css.match(/\.effortless-[A-Za-z-]+/g) ?? []).map((hit) => hit.slice(1)))];
}

/**
 * The applied names with no rule behind them.
 *
 * A whole name needs its own rule. A prefix — the variable-built one — needs a
 * rule for at least one name that starts with it, because the states it is
 * completed with are not knowable from the text of the source.
 */
function unstyledClasses(source: string, css: string): string[] {
	const styled = styledClasses(css);
	return appliedClasses(source).filter((applied) =>
		applied.endsWith("-")
			? !styled.some((rule) => rule.startsWith(applied) && rule.length > applied.length)
			: !styled.includes(applied),
	);
}

/**
 * Every `.ts` file under `src` except the tests: the paths it visited, and
 * their text joined into one string for the reader below.
 *
 * **The paths are returned so that the walk can be checked**, which until issue
 * #379 it could not be.
 * `unstyledClasses("", css)` is `[]`, so a walk that read nothing at all was a
 * pass, and this was the one whole-tree walk in the suite with neither a floor
 * nor a second listing to disagree with it. The known-bad case below hands the
 * reader a fabricated one-line source, so it proves the *reader* and never the
 * *walk*.
 *
 * It stays a walk of its own rather than becoming `shippedSources()` from
 * `./sourceGuards`: this one joins the files into one string, and a class name
 * applied across a line break would be read differently if they were kept
 * apart. That is a change to what this guard reports, not a rename, so the
 * copy is deliberate — see that module's docstring. What it no longer does is
 * spell `src` and `__tests__` for itself; both come from there.
 */
function pluginSource(): { paths: string[]; source: string } {
	const read = (dir: string): string[] =>
		readdirSync(resolve(repoRoot, dir), { withFileTypes: true }).flatMap((entry) => {
			const path = `${dir}/${entry.name}`;
			if (entry.isDirectory()) return entry.name === testFolder ? [] : read(path);
			return entry.name.endsWith(".ts") ? [path] : [];
		});

	const paths = read(sourceRoot).sort();
	return {
		paths,
		source: paths.map((path) => readFileSync(resolve(repoRoot, path), "utf8")).join("\n"),
	};
}

describe("every class name the plugin applies", () => {
	it("has a rule in styles.css", () => {
		const css = readFileSync(resolve(repoRoot, "styles.css"), "utf8");
		expect(unstyledClasses(pluginSource().source, css)).toEqual([]);
	});

	// Issue #379. The case above passes on an empty walk, so the walk needs a
	// second answer to disagree with it. `everyFileOnDisk` is that answer:
	// Node's own recursive listing rather than this recursion, which is the
	// point of using it. A walk that stops descending, or stops matching `.ts`,
	// or grows a skip that swallows a real folder fails here **by naming the
	// files it missed**, which a count against a fixed number could not do.
	//
	// It says nothing about whether the reader recognises every way Obsidian
	// applies a class — that is a different question, answered by the
	// pattern above and the case below, not here.
	it("reads every file the plugin ships, checked against a listing made another way", () => {
		expect(pluginSource().paths).toEqual(everyFileOnDisk());
	});

	// The known-bad case. Without it this file could pass by finding no class
	// names at all, which is what a broken reader does.
	it("would say so if a class name were applied with no rule behind it", () => {
		const source = 'parent.createDiv({ cls: "effortless-nope" });';
		expect(unstyledClasses(source, ".effortless-card { margin: 0; }")).toEqual([
			"effortless-nope",
		]);
	});

	// One sibling per applying form the reader supports, so that a form dropped
	// from `applyingPositions` fails here rather than going quietly unread.
	it.each([
		["addClass", 'row.addClass("effortless-nope");'],
		["setClass", 'new Setting(parent).setClass("effortless-nope");'],
		["toggleClass", 'row.toggleClass("effortless-nope", open);'],
		["classList.add", 'row.classList.add("effortless-card", "effortless-nope");'],
		["a cls array", 'parent.createDiv({ cls: ["effortless-nope"] });'],
		["the createDiv shorthand", 'parent.createDiv("effortless-nope");'],
		["the bare createDiv shorthand", 'createDiv("effortless-nope");'],
		["the createSpan shorthand", 'parent.createSpan("effortless-nope");'],
		["the bare createSpan shorthand", 'createSpan("effortless-nope");'],
		// The form all four live `createSpan` calls are written in today, so a
		// pattern that gained the shorthand by losing this one fails here.
		["a createSpan cls object", 'parent.createSpan({ cls: "effortless-nope" });'],
		["the createEl shorthand", 'parent.createEl("div", "effortless-nope");'],
		["the bare createEl shorthand", 'createEl("div", "effortless-nope");'],
		// `createSvg` takes the tag first exactly as `createEl` does, and Obsidian
		// declares the same string shorthand for it
		// (`node_modules/obsidian/obsidian.d.ts:190` and `:195`). Before #401 the
		// pattern had no arm for it, so a class applied this way shipped with no
		// rule behind it and the suite stayed green.
		["the createSvg shorthand", 'parent.createSvg("svg", "effortless-nope");'],
		["the bare createSvg shorthand", 'createSvg("svg", "effortless-nope");'],
		// The object form needs nothing of its own: `SvgElementInfo` carries `cls`
		// the way `DomElementInfo` does, so the `cls:` arm already reached it and
		// this row guards against losing that while gaining the shorthand.
		["a createSvg cls object", 'parent.createSvg("svg", { cls: "effortless-nope" });'],
		["addClasses", 'row.addClasses(["effortless-nope"]);'],
		// `TooltipOptions.classes` is an array of class names on an options object
		// (`node_modules/obsidian/obsidian.d.ts:7208`). It is read at the `cls:`
		// position and shares its tail, so this row is what would fail if that
		// sharing were undone.
		["a tooltip classes option", 'setTooltip(el, "Copy", { classes: ["effortless-nope"] });'],
	])("would say so for a name applied with %s and no rule behind it", (_form, source) => {
		expect(unstyledClasses(source, ".effortless-card { margin: 0; }")).toEqual([
			"effortless-nope",
		]);
	});

	// The tooltip option is always an array, so the same two things the `cls:`
	// array needs are needed here: every name in it, and nothing from the
	// property that follows. `placement` is a real neighbour — Obsidian declares
	// it right beside `classes` — and reading its value as a class name would
	// report `top` as unstyled.
	it("names every class in a tooltip classes array and nothing beside it", () => {
		const source =
			'setTooltip(el, "Copy", { classes: ["effortless-card", "effortless-nope"], placement: "top" });';
		expect(appliedClasses(source)).toEqual(["effortless-card", "effortless-nope"]);
		expect(unstyledClasses(source, ".effortless-card { margin: 0; }")).toEqual([
			"effortless-nope",
		]);
	});

	// A cls array holds more than one name, and neither of them is the first
	// thing after `cls:` — before #214 the `[` stopped the pattern dead and
	// *both* went unchecked rather than one of them failing.
	it("names every class in a cls array, not just the first", () => {
		const source = 'parent.createDiv({ cls: ["effortless-card", "effortless-nope"] });';
		expect(unstyledClasses(source, ".effortless-card { margin: 0; }")).toEqual([
			"effortless-nope",
		]);
	});

	// Both arms of a condition are applied, one run of the plugin or another,
	// so a rule is needed for each. Reporting only the arm that happens to be
	// written first would let the other rot.
	it("names both arms of a conditional class, not only the first", () => {
		const source = 'parent.createDiv({ cls: open ? "effortless-nope" : "effortless-badge" });';
		expect(unstyledClasses(source, ".effortless-card { margin: 0; }")).toEqual([
			"effortless-badge",
			"effortless-nope",
		]);
		expect(unstyledClasses(source, ".effortless-nope { margin: 0 } .effortless-badge { top: 0 }")).toEqual(
			[],
		);
	});

	// `createEl` takes the tag first, so the shorthand class is its *second*
	// argument. The tag is not a class name and must not be collected as one —
	// a rule for `.div` is not a thing anyone could add to `styles.css`.
	it("does not read the createEl tag as a class name", () => {
		const source = 'parent.createEl("div", "effortless-card");';
		expect(appliedClasses(source)).toEqual(["effortless-card"]);
	});

	// The condition is skipped only as far as its own `?`. Without that bound
	// the skip would run on past this property and collect the *next* one's
	// string, reporting a title or an aria-label as a class with no rule.
	it("does not reach past its own property into the next one", () => {
		const source = 'parent.createDiv({ cls: name, attr: { title: "effortless-nope" } });';
		expect(appliedClasses(source)).toEqual([]);
	});

	// The condition-skip's character class excludes a newline, so a `?` that
	// sits on a later line is never reached and the property is not read as a
	// condition at all — "a condition written across several lines" (the doc
	// comment above) is a real limit of the pattern, not an unpinned hedge.
	it("does not read a condition whose `?` sits on the next line", () => {
		const source = [
			"parent.createDiv({ cls: open",
			'  ? "effortless-nope"',
			'  : "effortless-badge" });',
		].join("\n");
		expect(appliedClasses(source)).toEqual([]);
	});

	it("keeps the capitals a camelCase state reaches the stylesheet with", () => {
		const source = 'parent.createDiv({ cls: "effortless-badge-notStarted" });';
		expect(unstyledClasses(source, ".effortless-badge-notStarted { color: grey }")).toEqual([]);
		expect(unstyledClasses(source, ".effortless-badge { color: grey }")).toEqual([
			"effortless-badge-notStarted",
		]);
	});

	it("reads what the code applies, not what a comment mentions", () => {
		const source = [
			"// effortless-nope was removed here, and nothing draws it any more.",
			'parent.createDiv({ cls: "effortless-card" });',
		].join("\n");
		expect(unstyledClasses(source, ".effortless-card { margin: 0 }")).toEqual([]);
	});

	it("counts a name built from a variable as styled once any of its states is", () => {
		const source = "cls: `effortless-badge effortless-badge-${status.state}`";
		const css = ".effortless-badge { padding: 0 } .effortless-badge-running { color: red }";
		expect(unstyledClasses(source, css)).toEqual([]);
	});

	it("ignores an effortless- string that is not applied as a class", () => {
		const source = [
			'const fixtures = mkdtempSync(join(tmpdir(), "effortless-platform-"));',
			'const commandId = "effortless-open-today";',
			'const dataPath = ".obsidian/plugins/effortless-plugin/data.json";',
			"const effortlessCounter = 0;",
		].join("\n");
		expect(unstyledClasses(source, ".effortless-card { margin: 0 }")).toEqual([]);
	});

	it("still reports a name built from a variable when nothing starts with it", () => {
		const source = "cls: `effortless-badge-${status.state}`";
		expect(unstyledClasses(source, ".effortless-badge { padding: 0 }")).toEqual([
			"effortless-badge-",
		]);
	});
});

/**
 * The five checkbox states, and the seventeen more behind a switch, against
 * the stylesheet that draws them.
 *
 * The author asked for the states the cycling feature steps through to look
 * different from each other whatever theme is installed, and settled the
 * question that forces: where Effortless and a theme disagree, Effortless wins. The rules that do
 * it live in `styles.css` and are ordinary CSS, so nothing in the suite would
 * notice them going wrong. This is what notices.
 *
 * #752 gives a look to
 * the widely used convention's seventeen more characters, and settles the
 * opposite question for them: Minimal draws these seventeen itself, and
 * Effortless must not beat it, so their rules are switch-gated behind
 * `.effortless-symbol-look` on `<body>` rather than unconditional.
 *
 * Four things are checked and each one is a way a promise has actually been
 * lost: a state losing its rule, a rule reaching only one of Obsidian's two
 * views, a rule too light to beat the theme that loads after it, and — new
 * with #752 — a rule for the seventeen that is not gated, or a gate that
 * covers the wrong characters.
 */
describe("the checkbox states styles.css draws", () => {
	/** The class the checkbox-cycling settings card toggles on `<body>`. */
	const SYMBOL_LOOK_GATE = ".effortless-symbol-look";

	/**
	 * The widely used convention's seventeen characters outside #294's five —
	 * the Minimal theme's own alternate-checkbox set, measured from its
	 * released CSS (`kepano/obsidian-minimal` 9.1.0) rather than guessed, and
	 * the same seventeen `styles.css`'s own comment names.
	 */
	const EXTENDED_SYMBOLS = ["<", "?", "!", '"', "*", "l", "i", "S", "I", "f", "k", "u", "d", "w", "p", "c", "b"];

	/**
	 * Every rule in `styles.css` whose selector mentions `data-task`, with its
	 * declarations.
	 *
	 * Comments are stripped first, and that is load-bearing rather than tidy:
	 * the section's own comment quotes Minimal's `input[data-task=">"]:checked`
	 * to say what it resets, and reading that as a rule would report a selector
	 * this file never wrote.
	 */
	function checkboxRules(css: string): { selectors: string[]; body: string }[] {
		const rules: { selectors: string[]; body: string }[] = [];
		for (const rule of cssRules(css)) {
			const selectors = rule.selector
				.split(",")
				.map((one) => one.trim())
				.filter(Boolean);
			if (selectors.some((one) => one.includes("data-task"))) {
				rules.push({ selectors, body: rule.body });
			}
		}
		return rules;
	}

	/**
	 * The characters those rules name, with the two spellings of the empty
	 * state read as one.
	 *
	 * Obsidian writes it `data-task=""` on a reading view's list item and
	 * `data-task=" "` on a live preview's checkbox — measured in the running
	 * application on 2026-09-08, not taken from documentation — so both have to
	 * appear in the stylesheet and both mean *to do* here.
	 *
	 * **A selector gated behind the extended-symbol switch is not one of
	 * these.** #752 gives seventeen more characters a look, but only while
	 * `.effortless-symbol-look` is on `<body>`, and that promise is a
	 * different one from this file's — it is checked on its own below, by
	 * {@link SYMBOL_LOOK_GATE}. Counting a gated selector here would make an
	 * unrelated character arrive as if it were unconditional, which is exactly
	 * the drift this function exists to catch.
	 */
	function styledStates(css: string): string[] {
		const found = new Set<string>();
		for (const rule of checkboxRules(css)) {
			for (const selector of rule.selectors) {
				if (selector.includes(SYMBOL_LOOK_GATE)) continue;
				for (const hit of selector.matchAll(/\[data-task="([^"]*)"\]/g)) {
					found.add(hit[1] === "" ? " " : hit[1]);
				}
			}
		}
		return [...found].sort();
	}

	/**
	 * The middle number of a selector's specificity — its classes, attributes
	 * and pseudo-classes added up.
	 *
	 * Only the middle number, because only the middle number decides the
	 * question this file asks. The heaviest checkbox rule in the themes #294
	 * names is Minimal's `li[data-task=">"] > p > input:checked` at (0,2,3), and
	 * a selector with three class-level parts beats it whatever its element
	 * count, since 3 is more than 2.
	 *
	 * Attributes are counted and then removed before the classes are, so that a
	 * `.` inside an attribute's value could never be read as a class. The
	 * pseudo-*element* is removed too: `::after` weighs an element, not a class,
	 * and both of this section's marks are drawn on one.
	 */
	function classLevelParts(selector: string): number {
		const attributes = selector.match(/\[[^\]]*\]/g) ?? [];
		const rest = selector.replace(/\[[^\]]*\]/g, " ").replace(/::[a-zA-Z-]+/g, " ");
		return (
			attributes.length +
			(rest.match(/\.[A-Za-z][\w-]*/g) ?? []).length +
			(rest.match(/:[a-zA-Z-]+/g) ?? []).length
		);
	}

	const css = readFileSync(resolve(repoRoot, "styles.css"), "utf8");

	// The five are the shipped Task flow sequence's own symbols rather than a
	// list written out again here, so that a sixth symbol added to that
	// sequence arrives as a missing rule rather than as a state that quietly
	// looks like every other one.
	it("draws every character the shipped Task flow sequence steps through", () => {
		expect(styledStates(css)).toEqual([...DEFAULT_SEQUENCES[0].symbols].sort());
	});

	/**
	 * The characters named by a selector gated behind
	 * {@link SYMBOL_LOOK_GATE} — the mirror of {@link styledStates}, which
	 * skips exactly these.
	 */
	function gatedSymbols(rules: ReturnType<typeof checkboxRules>): Set<string> {
		const gated = new Set<string>();
		for (const rule of rules) {
			for (const selector of rule.selectors) {
				if (!selector.includes(SYMBOL_LOOK_GATE)) continue;
				for (const hit of selector.matchAll(/\[data-task=(?:"([^"]*)"|'([^']*)')\]/g)) {
					gated.add((hit[1] ?? hit[2]) === "" ? " " : (hit[1] ?? hit[2]));
				}
			}
		}
		return gated;
	}

	// #752 reverses this promise for the seventeen characters outside the
	// five. It is still a look and never a meaning: nothing
	// here changes what a reader, the sync or the cycling makes of them, only
	// what they look like — and only while the switch is on.
	it("draws every extended symbol behind the switch, and no other character there", () => {
		expect([...gatedSymbols(checkboxRules(css))].sort()).toEqual([...EXTENDED_SYMBOLS].sort());
	});

	// #771. The shared `::after` frame for the seventeen resets
	// `background-image`, `mask-image` and `transform` — #294's own block for
	// the five does the same, plus `background-color: transparent`
	// (`styles.css:796`), which this one dropped. Obsidian's own
	// `:checked::after` sets `background-color: var(--checkbox-marker-color)`
	// to draw its tick, so without this reset the box behind the glyph fills
	// solid in that colour on any page darker than it.
	it("resets background-color on the extended symbols' shared frame, the way #294's does for the five", () => {
		const frame = checkboxRules(css).find(
			(rule) =>
				rule.selectors.some(
					(selector) => selector.startsWith(SYMBOL_LOOK_GATE) && selector.includes("::after"),
				) && rule.body.includes("position: absolute"),
		);
		expect(frame, "the extended symbols' shared ::after frame").toBeDefined();
		expect(frame?.body ?? "").toMatch(/background-color:\s*transparent/);
	});

	// The shipped Annotations sequence is the case the old promise named
	// explicitly as the one that would go wrong first; the new promise keeps
	// naming it, the other way round — every one of its six characters is in
	// the chosen set, so a shipped default is never left looking like a plain
	// box once the switch is on.
	//
	// #767: this used to compare `EXTENDED_SYMBOLS` — a literal in this file —
	// against `DEFAULT_SEQUENCES`, never reading `styles.css` at all, so it
	// would pass even against a stylesheet gutted of every gated rule. Reading
	// the rules themselves, the way the test above this one does, is what
	// makes it able to fail.
	it("includes every character the shipped Annotations sequence steps through", () => {
		const gated = gatedSymbols(checkboxRules(css));
		for (const symbol of DEFAULT_SEQUENCES[1].symbols) {
			expect(gated, symbol).toContain(symbol);
		}
	});

	// Obsidian writes the state in two different places, exactly as it does
	// for the five — driven and screenshotted for #294 at
	// `docs/acceptance-shots/issue-294-default-live.png` and
	// `…-default-reading.png`, `data-task` on the editor line in one and on
	// the list item in the other — and a rule reaching only one of them is
	// styling half the application whether or not it is gated.
	it.each(EXTENDED_SYMBOLS)("reaches both views for the extended symbol `[%s]`, gated", (symbol) => {
		const selectors = checkboxRules(css).flatMap((rule) => rule.selectors);
		const reading = `.task-list-item[data-task=${symbol === '"' ? `'"'` : `"${symbol}"`}]`;
		const live = `.HyperMD-task-line[data-task=${symbol === '"' ? `'"'` : `"${symbol}"`}]`;
		expect(selectors.some((one) => one.startsWith(SYMBOL_LOOK_GATE) && one.includes(reading))).toBe(true);
		expect(selectors.some((one) => one.startsWith(SYMBOL_LOOK_GATE) && one.includes(live))).toBe(true);
	});

	// What the rule looks like off (spec's open point, and the plan's
	// comment): every extended symbol's rule needs `.effortless-symbol-look`
	// as its leading ancestor, so without that class on `<body>` — the switch
	// off — nothing below can match, and the theme (Minimal, or none) draws
	// the character exactly as it always did. This is what would fail if a
	// rule for one of the seventeen were ever written unconditionally.
	it("never draws an extended symbol without the switch's gate", () => {
		for (const rule of checkboxRules(css)) {
			for (const selector of rule.selectors) {
				const extended = [...selector.matchAll(/\[data-task=(?:"([^"]*)"|'([^']*)')\]/g)].some((hit) =>
					EXTENDED_SYMBOLS.includes((hit[1] ?? hit[2]) === "" ? " " : (hit[1] ?? hit[2])),
				);
				if (extended) expect(selector.startsWith(SYMBOL_LOOK_GATE)).toBe(true);
			}
		}
	});

	// Obsidian writes the state in two different places, so a rule that reads
	// only one of them styles half the application. Reading view puts
	// `data-task` on the list item; live preview puts it on the editor line.
	it.each([" ", "/", "x", "-", ">"])("reaches both views for `[%s]`", (symbol) => {
		const selectors = checkboxRules(css).flatMap((rule) => rule.selectors);
		const reading = symbol === " " ? '.task-list-item[data-task=""]' : `.task-list-item[data-task="${symbol}"]`;
		const live = `.HyperMD-task-line[data-task="${symbol}"]`;
		expect(selectors.some((one) => one.startsWith(reading))).toBe(true);
		expect(selectors.some((one) => one.startsWith(live))).toBe(true);
	});

	// The measurement behind the whole section, kept honest. A theme's
	// stylesheet loads after a plugin's, so a rule here that dropped a class
	// from its selector would still be valid CSS, still apply on a bare
	// Obsidian, and lose the moment anyone installed Minimal — which is the
	// exact complaint #294 was filed about.
	it("keeps every checkbox selector heavy enough to beat a theme", () => {
		const tooLight = checkboxRules(css)
			.flatMap((rule) => rule.selectors)
			.filter((one) => classLevelParts(one) < 3);
		expect(tooLight).toEqual([]);
	});

	// `!important` was rejected rather than forgotten. Snippets load last of
	// all, so an ordinary rule here still leaves the person able to overrule
	// this file from their own snippet without matching its force; and against
	// a theme that used `!important` it would lose anyway.
	it("wins on specificity rather than on !important", () => {
		const forced = checkboxRules(css).filter((rule) => rule.body.includes("!important"));
		expect(forced.map((rule) => rule.selectors[0])).toEqual([]);
	});
});
