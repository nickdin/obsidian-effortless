/**
 * What every guard that reads this repository's own source needs: a way to find
 * the shipped files, a way to drop their comments, and the table of Obsidian
 * APIs that raise the version floor.
 *
 * It lives in `src/__tests__/` rather than in a folder of its own on purpose.
 * Both whole-tree walks skip a folder named `__tests__` and nothing else, so a
 * helper anywhere outside it would be read as shipped source and would fail
 * the platform guard on its own `node:fs` import. It is not a
 * `.test.ts` file, so vitest imports it and runs nothing from it.
 *
 * **Who imports it**: every suite that reads this repository's own `.ts` files,
 * whether it wants the walk, the stripper or the floor table. Neither a count
 * nor a roll-call is written here. Such a census went stale twice inside one
 * wave, and `grep -rl 'from "./sourceGuards"' src/__tests__` answers the
 * question in a second and cannot go stale. What a reader
 * changing this module needs is the kind of caller rather than the tally: every
 * one of them reads shipped source, so a change here changes what all of them
 * see. Before this module the walk was declared twice and exported neither
 * time.
 *
 * **Every guard that reads this repository's own source now reads it
 * comment-free**, and the rule is written once here rather than four times
 * across two files. `requiredFloor` strips inside itself, the three guards in
 * `platform.test.ts` strip at their call sites, and `topLevelStatements` no
 * longer keeps a line-based stripper of its own.
 *
 * **Three walks of the shipped tree remain, and each one is deliberate.**
 * {@link shippedSources} and {@link everyFileOnDisk} are two answers to one
 * question on purpose — found different ways and cross-checked against each
 * other in `manifest.test.ts`, so a walk that stops short fails by name rather
 * than by a count. The third is `pluginSource()` in `styles.test.ts`, which
 * joins every file into one string instead of keeping them apart; merging it
 * into {@link shippedSources} would change what that guard reports rather than
 * rename anything, so it stays where it is. **It is cross-checked against
 * {@link everyFileOnDisk} too** since issue
 * #379 — it was the one
 * walk here that could read nothing and still pass, because its caller's
 * answer for an empty source is an empty list of complaints.
 *
 * A fourth lived in `calendarSources.test.ts` as `shippedFiles()` until issue
 * #372. It differed from
 * {@link shippedSources} in nothing at all, so it went rather than earning a
 * paragraph here. **This paragraph said "a third copy" for as long as that
 * fourth existed**, which is how it was missed: a count kept by hand is worth
 * what the last hand to edit it was worth, and the one-place guard in
 * `testConventions.test.ts` could not help, because it matches a helper's
 * **name** and that copy had a different one. Issues #185 and #202 are the
 * same shape of duplication.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { repoRoot } from "./repoRoot";

/**
 * A TypeScript source with its comments taken out.
 *
 * Every guard that reads this repository's own source has to answer for
 * comments, and each one answers the same way: a comment is prose *about* the
 * code and never the code. Without this, `styles.test.ts` read a note about a
 * class that was removed as a class name still being applied, and the sweep of
 * the plugin's own strings would read a comment quoting a sentence it had just
 * rewritten as the sentence itself.
 *
 * **A string literal is not a comment, and this reads them.** All three quote
 * styles, with a backslash escape keeping the literal open, so
 * `new Notice("Use // for a comment.")` survives whole. Until issue
 * #264 the line was cut at
 * the first `//` wherever it sat, and every string after it on that line was
 * lost to whichever sweep was reading — a guard reporting clean on text it
 * never saw. Eight test files hold such a string — `PRODID:-//Effortless`
 * among them — and no shipped source does, which is the only reason the hole
 * stayed quiet.
 *
 * **One line at a time**, and the quote is dropped at the line end. Two of the
 * three styles cannot legally span a line anyway, and the third — the backtick
 * — cannot be carried across lines here: a regex literal holding an odd number
 * of backticks is ordinary code in this repository, and carrying its state
 * forward read the five lines after it as one string.
 *
 * The example is the inline-code pattern ``/`[^`]*`/`` inside `markdownProse`,
 * in `./vocabulary` — the function that takes the Markdown out of a document
 * before the retired-word sweep reads it. Find it by searching for
 * `markdownProse`, not by a line number: this reference was a file and a line
 * until issue #313, and it
 * had already stopped pointing at the pattern when issue
 * #246 moved the function
 * into that module. It is **not** the README table matcher in
 * `manifest.test.ts`, which is the repository's other backtick-holding regex.
 *
 * The cost is that a `//` on the second line of a template literal is still
 * cut. Nothing here has one.
 *
 * The old carve-out for a `//` following a colon is gone. It was there to keep
 * `https://` whole, and every `https://` sits inside a string or inside a
 * comment; both are now answered by something else. Measured over every `.ts`
 * file under `src`: keeping it and dropping it strip the same characters.
 *
 * Block comments go first and go whole. That pass does not read strings, so a
 * string holding a block-comment opener would still start one. No source here
 * holds one, and the fix is a scanner rather than a regex; it is written down
 * rather than done.
 */
export function withoutComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.map(withoutLineComment)
		.join("\n");
}

/** One line, cut at the first `//` that is not inside a string literal. */
function withoutLineComment(line: string): string {
	let quote: string | null = null;

	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (quote !== null) {
			if (char === "\\") i += 1;
			else if (char === quote) quote = null;
		} else if (char === '"' || char === "'" || char === "`") {
			quote = char;
		} else if (char === "/" && line[i + 1] === "/") {
			return line.slice(0, i);
		}
	}

	return line;
}

/**
 * One string literal in TypeScript source, as a sub-pattern to splice into a
 * larger one.
 *
 * **The escape rule is the whole point, and it is written here once.** A
 * backslash swallows whatever follows it, so a quote escaped inside a literal
 * does not end it and a sentence holding one is read whole rather than cut in
 * half at the escape. Two guards need that knowledge and each used to spell it
 * out its own way — the stylesheet guard's applying positions and the
 * vocabulary sweep's `LITERAL` — which is exactly the drift the shared-helper
 * registry exists to stop. One of the two had a whole quote style missing for a
 * while and nothing said so.
 *
 * A string rather than a compiled `RegExp`, because neither caller wants this
 * on its own: each splices it into a bigger pattern.
 *
 * `open` and `close` are how the caller spells the quote, and they need not be
 * the same text. Pass a quote character for both to match one style, or a
 * capturing class and a backreference to match any style and remember which:
 *
 * - `quotedLiteral('"', '"', "capture")` — double quotes, contents in a group.
 * - ``quotedLiteral(String.raw`(["'\`])`, String.raw`\3`, "skip")`` — any of
 *   the three styles, the quote itself captured by the caller's class, and
 *   nothing else captured.
 *
 * **`contents` is not a convenience.** The vocabulary sweep reads the literal's
 * text out of a capture group, and the stylesheet guard reads its own groups by
 * number — so a group added here would silently shift the group it reads. Ask
 * for `"capture"` only where the contents are wanted.
 */
export function quotedLiteral(open: string, close: string, contents: "capture" | "skip"): string {
	// `(?!close)` rather than a negated character class, so `close` may be a
	// backreference as well as a single character. For a single character the
	// two are the same thing.
	const body = `(?:\\\\[\\s\\S]|(?!${close})[^\\\\])*`;
	return `${open}${contents === "capture" ? `(${body})` : body}${close}`;
}

/**
 * The rules of a stylesheet, each as its selector text and its declarations.
 *
 * A stylesheet's only comment is `/* … *\/`, and those are dropped first: a
 * comment quoting a selector to say what it resets would otherwise be read as
 * a rule this repository never wrote. A selector never holds a brace, so a
 * rule is everything up to `{` and then its body up to `}`. `styles.css`
 * holds no at-rule, so every rule found is a top-level one. Two guards read
 * the stylesheet this way — the checkbox states and the bookkeeping
 * properties — and share this rather than each keeping a copy.
 */
export function cssRules(css: string): Array<{ selector: string; body: string }> {
	return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((hit) => ({
		selector: hit[1].trim(),
		body: hit[2],
	}));
}

/** The folder the plugin's shipped source lives in. */
export const sourceRoot = "src";

/** The one folder inside it that is not shipped, and is therefore never walked. */
export const testFolder = "__tests__";

/**
 * Every TypeScript file that is bundled into the plugin, at whatever depth it
 * sits, found by walking rather than by naming. A module added tomorrow is
 * guarded the day it arrives, which a hand-written list of filenames cannot
 * promise. The test folder is skipped whole; naming the folders to *include*
 * would leave a feature in its own folder outside the guard the moment one
 * arrives, which is the file the guard most needs to read.
 *
 * The root is `src` rather than `src/core`, so `src/main.ts` is inside the
 * floor check. It was outside it, which meant an Obsidian API called from
 * `main.ts` never raised `minAppVersion` and the manifest went on claiming the
 * 1.7.2 baseline.
 */
export function shippedSources(root = sourceRoot): Array<{ path: string; source: string }> {
	const files: Array<{ path: string; source: string }> = [];

	const walk = (dir: string): void => {
		for (const entry of readdirSync(resolve(repoRoot, dir), { withFileTypes: true })) {
			const path = `${dir}/${entry.name}`;
			if (entry.isDirectory()) {
				if (entry.name !== testFolder) walk(path);
			} else if (entry.isFile() && entry.name.endsWith(".ts")) {
				files.push({ path, source: readFileSync(resolve(repoRoot, path), "utf8") });
			}
		}
	};

	walk(root);
	return files;
}

/**
 * The same files found a second, independent way — Node's own recursive listing
 * rather than the walk above. A walk that stops short then fails by name, which
 * a count against a fixed number could not do.
 *
 * The root is an argument because two guards need two different answers: the
 * floor guard reads the whole shipped tree, and the README's map of the core
 * reads `src/core` alone, since that is the table it is checked against.
 */
export function everyFileOnDisk(root = sourceRoot): string[] {
	return readdirSync(resolve(repoRoot, root), { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => relative(repoRoot, join(entry.parentPath, entry.name)).split(sep).join("/"))
		.filter((path) => !path.split("/").includes(testFolder))
		.sort();
}

/**
 * The lowest floor the plugin could ever claim: `Plugin.removeCommand`, which
 * every version of it calls. The table below can only raise it, and the floor
 * it reaches is what `README.md` and `docs/releasing.md` name.
 */
export const baselineFloor = "1.7.2";

/** One Obsidian API with a version floor, and the version it arrived in. */
export interface ApiFloor {
	pattern: RegExp;
	since: string;
}

/**
 * Every `since` here is the `@since` tag on that member in
 * `node_modules/obsidian/obsidian.d.ts`, read rather than remembered.
 *
 * Adding a floor is one row. A row for an API the repository does not call yet
 * costs nothing and is what makes the guard catch it the day someone does.
 */
export const apiFloors: ApiFloor[] = [
	{ pattern: /\bremoveCommand\b/, since: "1.7.2" },
	{ pattern: /\bloadLocalStorage\b|\bsaveLocalStorage\b/, since: "1.8.7" },
	{ pattern: /\bvault\s*\.\s*copy\s*\(/i, since: "1.8.7" },
	{ pattern: /\bisDarkMode\s*\(/, since: "1.10.0" },
	{ pattern: /\brenderContext\b/, since: "1.10.0" },
	{ pattern: /\bsecretStorage\b/, since: "1.11.4" },
	{ pattern: /\bConfirmationModal\b/, since: "1.13.0" },
];

/** Whether `version` is at or above `floor`, comparing the three number parts. */
export function atLeast(version: string, floor: string): boolean {
	const a = version.split(".").map(Number);
	const b = floor.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
	}
	return true;
}

/**
 * The lowest Obsidian version that could run these sources: the highest floor
 * of every row that matched, or the baseline when none did.
 *
 * A plain function of its two arguments on purpose. That is what lets a test
 * drive it with fabricated sources and see it return an answer — the failure
 * its predecessor had, a guard that quietly checks nothing, cannot be caught by
 * a test that can only run the guard against the real tree.
 *
 * Comments go first, and inside here rather than at the call sites, which keeps
 * that promise: {@link withoutComments} is a function of the string it is
 * handed, so this still reads nothing but its two arguments. A comment naming a
 * floored API used to raise the floor from prose — `secretStorage` and
 * `isDarkMode(` are both things a note about a module says — and
 * `manifest.test.ts` would then demand a `minAppVersion` the code does not need.
 */
export function requiredFloor(sources: string[], floors: ApiFloor[]): string {
	const code = sources.map(withoutComments);

	let floor = baselineFloor;
	for (const { pattern, since } of floors) {
		if (code.some((source) => pattern.test(source)) && !atLeast(floor, since)) floor = since;
	}
	return floor;
}

/**
 * Whether `source` states `pattern`, whatever order a character class in it was
 * typed in.
 *
 * The guards that call this hold the rule that a feature never restates the
 * task-line format. Until issue
 * #416 each of them matched
 * one exact spelling — the literal text `[-*+]`, and nothing else — so the same
 * rule written `[-+*]` or `[*+-]` was a second place the format was decided and
 * every guard passed in silence. A character class is its member set; the order
 * the members were typed in says nothing.
 *
 * Both sides are normalised and then compared as text, so a `pattern` with no
 * character class in it is matched exactly as it is written. That is what keeps
 * the fence and heading counts — `` `{3,} `` and `#{1,6}` — working here: they
 * are repetitions rather than classes, and normalising a class does not reach
 * them.
 *
 * **Shared, and registered as shared.** It was written at the bottom of
 * `checkboxCyclingLineKind.test.ts` by the wave that built #416, which owned
 * that file alone and could not reach this module or the registry in
 * `testConventions.test.ts`. #417
 * is the same defect against a different guard and needed the same helper, so
 * the helper moved here rather than being written a second time.
 */
export function statesPattern(source: string, pattern: string): boolean {
	return normalisedClasses(source).includes(normalisedClasses(pattern));
}

/**
 * `text` with every character class in it rewritten to one canonical spelling:
 * escapes taken off, duplicates dropped, members sorted, and a leading `^` kept
 * so a negated class never reads as the class it negates.
 *
 * A backslash escape outside a class is copied through whole, so `\[` stays the
 * literal bracket it is and opens nothing. Inside a class, a backslash before a
 * letter or a digit is a shorthand and stays — `\d` and `\s` are members in
 * their own right — while a backslash before anything else is an escape and
 * comes off, which is what makes `[^\]]` and `[^]]` the same class.
 *
 * Two things bound the damage where this reads TypeScript rather than a regex.
 * A class that runs to the end of the line without closing is not a class, and
 * an immediately closing `[]` is not one either: both are array types, and
 * swallowing them would eat the rest of the line.
 */
function normalisedClasses(text: string): string {
	let out = "";
	let index = 0;

	while (index < text.length) {
		if (text[index] === "\\") {
			out += text.slice(index, index + 2);
			index += 2;
			continue;
		}
		if (text[index] !== "[") {
			out += text[index];
			index += 1;
			continue;
		}

		const read = readClass(text, index);
		if (read === null) {
			out += text[index];
			index += 1;
			continue;
		}
		out += read.canonical;
		index = read.after;
	}

	return out;
}

/**
 * The character class opening at `open`, canonically spelled, and the index
 * just past it — or `null` where what opens there is not a class.
 *
 * A `]` in the first member position is a member rather than the close, which
 * is the spelling `[^]]` uses. The exception is the unnegated `[]`, which is an
 * array type in every file this reads.
 */
function readClass(text: string, open: number): { canonical: string; after: number } | null {
	let index = open + 1;
	const negated = text[index] === "^";
	if (negated) index += 1;
	if (!negated && text[index] === "]") return null;

	const members: string[] = [];
	let first = true;

	while (index < text.length && text[index] !== "\n") {
		const char = text[index];
		if (char === "]" && !first) {
			return { canonical: `[${negated ? "^" : ""}${sortedMembers(members).join("")}]`, after: index + 1 };
		}
		first = false;

		if (char === "\\") {
			const escaped = text[index + 1];
			if (escaped === undefined) return null;
			members.push(/[A-Za-z0-9]/u.test(escaped) ? `\\${escaped}` : escaped);
			index += 2;
			continue;
		}

		members.push(char);
		index += 1;
	}

	return null;
}

/**
 * The members of one class, sorted and de-duplicated, with a range kept whole.
 *
 * A `-` between two members is a range and joins them; a `-` at either end of
 * the class is the character itself, which is how the marker set writes it.
 */
function sortedMembers(members: readonly string[]): string[] {
	const tokens: string[] = [];

	for (let index = 0; index < members.length; index += 1) {
		if (members[index] === "-" && tokens.length > 0 && index + 1 < members.length) {
			tokens[tokens.length - 1] = `${tokens[tokens.length - 1]}-${members[index + 1]}`;
			index += 1;
			continue;
		}
		tokens.push(members[index]);
	}

	return [...new Set(tokens)].sort();
}

/**
 * Whether `source` states a count of a string's code points against the
 * number one. The spread or `Array.from` call itself must sit on one line;
 * the `.length`, the comparison operator and the `1` after it may be split
 * across lines.
 *
 * The condition `[...symbol].length !== 1` and every other way of writing it:
 * the spread or `Array.from`, then `.length`, then any comparison operator with
 * any spacing around it — a newline included — then `1`. It is the rule that
 * one character means one code point rather than one UTF-16 unit — an emoji is
 * one character to the person who typed it and two units to JavaScript — and it is decided
 * in `src/core/taskLine.ts` and nowhere else.
 *
 * **What it does not reach, written down rather than chased**:
 *
 * - **A spread bound to a name on one line and its length read on another.**
 *   `symbolRefusal` in `src/features/checkboxCycling/sequences.ts` is written
 *   exactly that way — it writes `const points = [...symbol];` and reads
 *   `points.length` below — so this helper answers `false` for that file. That
 *   is permitted by #348, which left `symbolRefusal` choosing which sentence a
 *   person is shown while `mayBeCheckbox` decides, and it is the reason a guard
 *   built on this must not be read as a complete sweep.
 * - **Two levels of nesting inside the spread or the call.** One level is read,
 *   so `Array.from(symbol.trim()).length !== 1` and `[...symbol[0]].length !== 1`
 *   are seen; `Array.from(new Set(codePointsOf(x))).length > 1` is not.
 *
 * Widening to a multi-line or syntax-tree read was rejected: an unwritten
 * assumption fails the same way a wrong guard does, so the limits are
 * stated here instead.
 *
 * A count against any number other than `1`, or against a name, is not a limit
 * but the point: the rule is *one* code point, and a different number is a
 * different claim.
 *
 * The sibling of `statesPattern` above and from the same family: one shared
 * answer to "does this source state this rule", so that no guard grows its own.
 */
export function statesCodePointCount(source: string): boolean {
	return CODE_POINT_COUNT.test(source);
}

/**
 * What may sit inside a spread's brackets or inside an `Array.from` call:
 * anything but a newline, with one level of nested parentheses or brackets, so
 * that a call or an index in there is read rather than cutting the match short.
 *
 * Written once and used for both halves of `CODE_POINT_COUNT`, because both
 * halves mean the same thing by "its own expression".
 */
const NESTED_ONE_LEVEL = String.raw`(?:[^()\[\]\n]|\([^()\[\]\n]*\)|\[[^()\[\]\n]*\])*`;

/**
 * A code-point count compared against the number one. Only the spread or
 * `Array.from` call and its own contents are held to one line; the `.length`,
 * the comparison operator and the number after it may wrap.
 *
 * The two ways a string is taken apart into code points, `[...x]` and
 * `Array.from(x)`; `.length`; then `===`, `!==`, `==`, `!=`, `<`, `<=`, `>` or
 * `>=` with any whitespace, none included, on either side; then the literal `1`
 * and nothing that would make it a longer number, name or decimal.
 *
 * The contents stop at the closing bracket or parenthesis that balances the
 * opening one, one level of nesting deep, and may not cross a newline — so
 * neither half can run past its own expression.
 */
const CODE_POINT_COUNT = new RegExp(
	String.raw`(?:\[\s*\.\.\.${NESTED_ONE_LEVEL}\]|Array\.from\(${NESTED_ONE_LEVEL}\))` +
		String.raw`\.length\s*(?:[!=]==?|[<>]=?)\s*1(?![\w.])`,
	"u",
);
