/**
 * **The one place `GLOSSARY.md`'s `_Avoid_` lists are parsed.** A second copy of
 * this parser is a second answer to one question, so if you are about to write
 * one, import this instead.
 *
 * `GLOSSARY.md` settles one word for each thing and lists, under `_Avoid_`, the
 * words not to reach for. Two suites sweep documents and screens against that
 * list — `manifest.test.ts` over the shipped documents and
 * `settingsTab.test.ts` over the settings screen as it is drawn —
 * and each grew its own copy of the parser, because the wave that wrote them
 * gave one test file to each worker and no shared module to either. Both copies
 * carried the allowance lists below and agreed on every entry; they differed in
 * the names alone — `NOT_MATCHABLE` and `PROPER_NAMES` against `notMatchable`
 * and `properNames`. Nothing was dropped, and the two sweeps had never checked
 * different terms. Issue
 * #202 is that duplication:
 * a second copy of the parser is a second answer to one question, whatever the
 * two copies happened to agree on the day it was filed
 * (#251 is this correction).
 *
 * The term list is read out of the glossary rather than copied here, so adding
 * a word there tightens both sweeps with no change in this file.
 *
 * It lives in `src/__tests__/` and is not a `.test.ts` file, so vitest imports
 * it and runs nothing from it. Both whole-tree walks skip a folder named
 * `__tests__` and nothing else, so a helper anywhere outside it would be read
 * as shipped source.
 *
 * **What this module decides, since #69.** Which *terms* are checked, and which
 * *strings inside a TypeScript source* count as ones a person reads — see
 * {@link shownStrings}. Which *files* each sweep opens is still each suite's own
 * business: `manifest.test.ts` reads the shipped documents, the shipped settings
 * defaults and every source under `src/`; `settingsTab.test.ts` reads the
 * settings screen as it is actually drawn.
 */

import { quotedLiteral, withoutComments } from "./sourceGuards";

/** One word the glossary retires, and the entry that retired it. */
export interface Retired {
	word: string;
	term: string;
	/** The glossary annotated it `(bare — …)`: only the bare use is retired. */
	bare: boolean;
}

/** Splits an `_Avoid_` line on its commas, leaving the ones inside `(…)` alone. */
export function avoidEntries(line: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let current = "";
	for (const char of line) {
		if (char === "(") depth += 1;
		if (char === ")") depth -= 1;
		if (char === "," && depth === 0) {
			out.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	out.push(current);
	return out.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/**
 * Every word under an `_Avoid_` list in the glossary text handed in, with the
 * glossary's own note about it.
 *
 * A plain function of its argument, the way `requiredFloor` in `sourceGuards.ts`
 * is. That is what lets a test drive it with a fabricated glossary and watch a
 * term it has never seen become guarded — proof that a new word in `GLOSSARY.md`
 * tightens both sweeps, without anyone having to edit `GLOSSARY.md` to show it.
 *
 * An entry the glossary annotates `(bare — …)` says in the annotation that only
 * the bare use is retired — *calendar*, where the plugin's own *calendar table*
 * and *calendar source* are the terms to keep. Matching cannot tell one use
 * from the other, so the glossary is what excuses those two rather than a hand
 * list here.
 */
export function retiredWords(glossaryText: string): Retired[] {
	const out: Retired[] = [];
	for (const block of glossaryText.split(/\n\s*\n/)) {
		const term = /^\*\*(.+?)\*\*:/.exec(block.trim());
		const avoid = /^_Avoid_: (.+)$/m.exec(block);
		if (!term || !avoid) continue;
		for (const entry of avoidEntries(avoid[1])) {
			out.push({
				word: entry.replace(/\s*\(.*$/, "").replace(/ as one word$/, "").trim(),
				term: term[1],
				bare: /\(bare\b/.test(entry),
			});
		}
	}
	return out;
}

/**
 * The two words these sweeps cannot judge by matching, and why. Kept short on
 * purpose: every other retired word is checked, so a word added to `GLOSSARY.md`
 * is caught rather than quietly waved through. Both suites tie each key back to
 * a live glossary entry, so an allowance cannot outlive what it excuses.
 */
export const notMatchable: Record<string, string> = {
	// Effortless is itself an Obsidian plugin, and both descriptions and the
	// README say so. The glossary retires the word as a name for a *feature*.
	plugin: "Effortless is an Obsidian plugin; the retired sense is a feature.",
	// A published calendar address is a link, and so is a wiki link in a note.
	// The glossary retires the word as a name for a *pairing*.
	link: "A calendar address is a link; the retired sense is a pairing.",
};

/**
 * Why each term the glossary annotates `(bare — …)` is left unmatched.
 *
 * The annotation says the bare use is retired while the qualified uses stay
 * right — "Calendar sources" and "Add a calendar" are both correct — and
 * {@link retiredIn} cannot tell one from the other, so it lets the whole term
 * through. That is two of the glossary's terms guarded by nothing.
 *
 * The skip itself is right and stays; what this list adds is that it can no
 * longer grow in silence. `manifest.test.ts` ties this record to the glossary
 * in both directions — an annotation with no reason here fails, and a reason
 * here whose annotation has gone fails too — which is the same treatment
 * {@link notMatchable} already has.
 *
 * **Telling a bare use from a qualified one is still not done, and it is not a
 * matching problem.** *calendar*'s own reason below names "Add a calendar" as
 * right, and that sentence is the settings screen's own button — swept, and
 * asserted by name in `manifest.test.ts`. So a guard that fired on the annotated
 * word would fail the plugin's shipped text, and no rule written on the word
 * alone can tell the two uses apart. `manifest.test.ts` records that as a case,
 * beside these, so whoever tries it next meets the evidence rather than the
 * conclusion. Writing a term plainly rather than annotating it is what keeps it
 * guarded — that is why *project* went into the glossary bare-worded and
 * unannotated.
 */
export const bareReasons: Record<string, string> = {
	calendar: "A source may hold several calendars, so \"Calendar sources\" and \"Add a calendar\" are both right.",
	notice: "A `Notice` is Obsidian's one-off message; the retired sense is the report that persists.",
	// Quoted, and its reason kept off the key's line: a plain `password:` key
	// holding a string reads as a credential to the repository's secret scanner.
	["password"]:
		"An app-specific password is what a calendar account signs in with, the provider's own name for it; the retired sense is the person's own, never typed into the plugin.",
};

/** The words the glossary annotates `(bare — …)`, out of a parsed term list. */
export function bareAnnotated(words: Retired[]): string[] {
	return [...new Set(words.filter((entry) => entry.bare).map((entry) => entry.word))].sort();
}

/**
 * Phrases that survive because they are somebody's own name for their own
 * thing, not this repository's word for one of its things.
 */
export const properNames: Record<string, string> = {
	"bullet journal method": "Ryder Carroll's method, by the name its author gave it.",
};

/**
 * The retired words `text` uses, each once, in the glossary's own order.
 *
 * **A term the glossary marks `(bare — …)` is skipped, not checked.** The
 * glossary has three: *calendar*, *notice* and *password*. The annotation retires the word
 * used on its own while the qualified uses stay right — "Calendar sources" and
 * "Add a calendar" are both correct — and this function has no way to tell one
 * from the other, so it lets the whole term through rather than failing every
 * legitimate use. Three of the glossary's terms are therefore unguarded — but
 * **no longer in silence**: marking a fourth `(bare — …)` unguards it and fails,
 * because every annotation has to carry a stated reason in {@link bareReasons}
 * and `manifest.test.ts` ties the two together in both directions.
 *
 * Telling a bare use from a qualified one is still not done, and it is a
 * different question from {@link shownStrings}'s. {@link bareReasons} carries
 * why, with the evidence: it is not a matching problem.
 */
export function retiredIn(text: string, words: Retired[]): string[] {
	let readable = text;
	for (const name of Object.keys(properNames)) readable = readable.split(name).join(" ");

	const found: string[] = [];
	for (const { word, bare } of words) {
		if (bare || word in notMatchable || found.indexOf(word) >= 0) continue;
		const parts = word.split(/[\s-]+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
		if (new RegExp(`\\b${parts.join("[\\s-]+")}s?\\b`, "i").test(readable)) found.push(word);
	}
	return found;
}

/**
 * A Markdown document with its code spans, fenced blocks and link targets taken
 * out — what is left is the prose a person reads.
 *
 * Each of the three removals is there because the sweep would otherwise fail on
 * something nobody reads as a sentence: a fenced block is code, a code span is
 * an identifier or a file name, and a link's target is a URL. The link's *text*
 * stays, because that is words.
 *
 * It sat in `manifest.test.ts` as `markdownProse` and in `settingsTab.test.ts`
 * as `prose`, byte-identical bodies under two names — the same defect issue
 * #202 was filed about, one
 * helper later, and the way the two copies of the `_Avoid_` parser started. `markdownProse` is
 * the name that survived: it says what it takes, and `manifest.test.ts` uses it
 * in a table beside `descriptionOf`, where every entry is named for the shape of
 * its input.
 */
export function markdownProse(markdown: string): string {
	return markdown
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/\]\([^)]*\)/g, "] ");
}

/**
 * One string literal, in any of the three quote styles TypeScript has, as three
 * capture groups — one per style, and exactly one of them fills.
 *
 * The escape rule — a backslash swallows whatever follows it, so an escaped
 * quote does not end the literal — is not written here. It lives in
 * {@link quotedLiteral} in `./sourceGuards`, because `styles.test.ts` needs the
 * same knowledge and spelled it out its own way until issue
 * #320. This side asks for
 * the contents; that side captures nothing.
 *
 * Single quotes were missing until issue
 * #266, and the comment
 * here said "either quote style", which told a reader the coverage was complete
 * when it was not. `npm run lint` is `tsc --noEmit` alone and there is no
 * formatter in the repository, so nothing rewrites a single-quoted sentence
 * into a double-quoted one and nothing failed when one was written: the sweep
 * simply did not see it. That near-miss is why the escape rule has one home
 * now: the correction landed in one spelling and nothing said the other was
 * still short.
 */
const LITERAL = `(?:${quotedLiteral('"', '"', "capture")}|${quotedLiteral("'", "'", "capture")}|${quotedLiteral("`", "`", "capture")})`;

/**
 * The calls and properties that put text in front of a person, and how much of
 * each one is read.
 *
 * **Position, not text**, which is the rule `styles.test.ts` already works by. Reading a
 * source as text instead was measured and rejected: **20 of the 25 shipped
 * sources match a retired word**, measured on this commit. Reproduce it by
 * calling `retiredIn(withoutComments(source), retiredWords(glossary))` on every
 * entry `shippedSources()` in `./sourceGuards` returns, and counting the ones
 * that answer with something.
 *
 * The reason the ratio is that high is that the retired list is ordinary
 * English used for identifiers: the twenty match on `error`, `status`, `event`,
 * `part`, `block`, `host`, `workspace`, `cache`, `enabled`, `region` and
 * `occurrence`, and not one of those matches is a sentence anybody reads. A
 * guard that fires on four files in five says nothing, and no edit anyone could
 * make would quieten it. This is the one place in the repository that states
 * the measurement.
 *
 * **A shown call opens a region, not a slot.** Everything from the opening
 * parenthesis to its matching close is read, however many literals sit inside
 * and whatever stands between them. A slot read the first literal and nothing
 * else, so a sentence behind a ternary — which is how the calendar rows choose
 * between a link and a file — was never swept.
 *
 * Each position, and why it is one:
 *
 * - The `Setting` text setters, as regions. Everything on the settings screen is
 *   a row name, a description, a placeholder, a tooltip or a button's words.
 * - `new Notice(…)`, as a region. Obsidian's one-off message, read once and
 *   gone.
 * - `new Error(…)`, as a region. Not a programmer's message here: the entry
 *   point, the settings screen and the calendar section each catch and hand the
 *   text straight to a `Notice`, so these are sentences a person meets.
 * - `text:` — the option every `createDiv`, `createSpan` and `createEl` takes,
 *   and how the cards, the count line and the two lists are written.
 * - `name:` and `description:` — a command's name, and what a feature declares
 *   about itself. Both are drawn without anything else touching them.
 * - `reason:` — the sentence a `Readiness` answer carries, which the settings
 *   screen draws as that feature's row detail. A slot rather than a region,
 *   because the readiness object holds `state:` beside the reason and that is a
 *   stored answer, not words: a region would report `"unconfigured"` as a
 *   sentence. Three of `Readiness`'s members carry a reason and every feature
 *   after the first writes at least one, so this was a position with nothing at
 *   it.
 * - `.addOption(value, display)`, **narrow and staying narrow**. The second
 *   argument is the words in the list; the first is the stored answer and is not
 *   read by anyone. A region here would start reporting `"link"` and `"file"` as
 *   sentences.
 *
 * The last four are slots rather than regions because each is a key or an
 * argument followed by its own value, with nothing else to reach.
 */
const textSetterCall = String.raw`\.set(?:Name|Desc|Placeholder|Tooltip|ButtonText|Title)\s*\(`;
const shownConstructor = String.raw`new (?:Notice|Error)\s*\(`;

/** A call whose whole argument list is read — the region rule above. */
const shownRegions = new RegExp(`(?:${textSetterCall}|${shownConstructor})`, "g");

/** A key or an argument followed by the one literal it takes, and no more. */
const shownSlots = new RegExp(
	`(?:${[String.raw`\b(?:text|name|description|reason):\s*`, String.raw`\.addOption\([^,]*,\s*`].join("|")})${LITERAL}`,
	"g",
);

/**
 * The two positions where a sentence is built away from the call that shows it.
 *
 * `sourceStateLine` in `src/core/calendarSourcesSection.ts` is both at once: it
 * returns `"Not read yet."` and `` `Last read ${age}.` ``, and the caller writes
 * the answer with `state.textContent = sourceStateLine(…)`. A sentence in that
 * shape sat at no position at all, and neither did the drawn-screen sweep in
 * `settingsTab.test.ts` reach it, because that render has no calendar source in
 * it.
 *
 * **Lifting such a sentence into a named constant was the alternative and does
 * not work**: a `const` assigned a sentence and passed as `.setDesc(NAME)` sits
 * at no position either, so the sweep would still read nothing. That moves the
 * hole rather than closing it, which is why the reader was widened instead.
 *
 * **The declared return type is what says the answer is words, however it is
 * spelled.** `string | null` is the ordinary spelling for a function answering
 * "what is wrong with this, or nothing" — `sourceProblem` in
 * `src/core/calendarSources.ts` and `symbolRefusal` in
 * `src/features/checkboxCycling/sequences.ts` are both that shape, and both
 * write sentences a person reads beside the field they are typing in. The
 * pattern demanded a bare `string`, so neither sat at any swept position.
 *
 * **And an arrow function writes `=>` between the return type and the brace.**
 * A block-bodied arrow function uses the `return` keyword this rule reads, so
 * only that one character stood between it and being swept. An
 * expression-bodied one has no `return` and is still out of reach — see
 * {@link shownStrings}.
 */
const returnsAString = /\)\s*:\s*string\s*(?:\|\s*(?:null|undefined)\s*)*(?:=>\s*)?\{/g;
const textContentAssignment = /\.textContent\s*=\s*/g;
const returnKeyword = /\breturn\b/g;

/** Every quote character that opens a string literal in TypeScript. */
const quotes = new Set(['"', "'", "`"]);

/**
 * How far a region reaches, counting the brackets it is written with and
 * stepping over anything inside a string literal.
 *
 * A string is skipped whole because a parenthesis inside a sentence is a
 * parenthesis in prose, not one the compiler pairs — "The path to an .ics file
 * (inside your vault)." would otherwise close the call it sits in.
 *
 * `openers` and `closers` say which brackets are counted, and `until` says which
 * character ends the region once nothing is open. A call region counts
 * parentheses and ends when the one it opened closes; a statement region counts
 * every bracket and ends at the `;`.
 *
 * **The two kinds end differently, and `until` is what tells them apart.** A
 * call region starts *inside* a bracket that is already open, so the close
 * taking depth to zero is its own and ends it. A statement region starts
 * outside every bracket, at depth zero, so a close taking depth to zero is
 * merely a call it stepped over — ending there cut the region off before
 * everything written to the right of the first call, which is how
 * `state.textContent = wasRead(read) ? label(read) : "No event.";` came to be
 * swept by nothing. That line is the
 * fixture of "reads the sentence behind a ternary whose condition holds a call"
 * in `vocabulary.test.ts`, quoted as it is written there so that grepping it
 * lands on the test; its condition holds a call, which is the shape the depth
 * walk exists for.
 * Depth cannot go below zero inside a well-formed statement, so a close that
 * does go below zero is the enclosing block ending, and that ends the statement
 * as surely as its `;` would.
 */
function regionFrom(
	text: string,
	from: number,
	openers: string,
	closers: string,
	until: string | null,
): { at: number; text: string } {
	let depth = 0;
	let quote: string | null = null;

	for (let i = from; i < text.length; i++) {
		const char = text[i];
		if (quote !== null) {
			if (char === "\\") i += 1;
			else if (char === quote) quote = null;
			continue;
		}
		if (quotes.has(char)) {
			quote = char;
			continue;
		}
		if (openers.indexOf(char) >= 0) depth += 1;
		else if (closers.indexOf(char) >= 0) {
			depth -= 1;
			// A call region is inside the bracket it counts, so the close that
			// takes depth to zero is its own and ends it. A statement region
			// starts outside every bracket, so a close taking depth to zero is
			// just a call it stepped over; only a close going *below* zero is
			// the enclosing block ending, and only that ends the statement.
			if (until === null ? depth <= 0 : depth < 0) return { at: from, text: text.slice(from, i) };
		} else if (until !== null && char === until && depth === 0) {
			return { at: from, text: text.slice(from, i) };
		}
	}

	return { at: from, text: text.slice(from) };
}

/**
 * A literal the code compares something against, either way round: `kind ===
 * "file"`, `"file" === kind`.
 *
 * It is a stored answer rather than words on a screen, and a region reads
 * everything between its parentheses, so without this the condition of a ternary
 * would be read as a sentence. `.addOption`'s first argument is excluded from
 * the slot rule for the same reason, and this is that reason applied where a
 * region reaches. Measured on `src/core/calendarSourcesSection.ts`: without it
 * the sweep reports `"link"` from `source.kind === "link"` in two shown calls,
 * and `"file"` from `asLocation`'s return.
 */
const comparedBefore = /(?:===?|!==?)\s*$/;
const comparedAfter = /^\s*(?:===?|!==?)/;

/** Every string literal in a stretch of source that is not one of those, each with where it sits. */
function literalsIn(region: { at: number; text: string }): Array<{ at: number; words: string }> {
	const every = new RegExp(LITERAL, "g");
	const found: Array<{ at: number; words: string }> = [];

	for (let hit = every.exec(region.text); hit; hit = every.exec(region.text)) {
		const before = region.text.slice(0, hit.index);
		const after = region.text.slice(hit.index + hit[0].length);
		if (comparedBefore.test(before) || comparedAfter.test(after)) continue;
		found.push({ at: region.at + hit.index, words: hit[1] ?? hit[2] ?? hit[3] ?? "" });
	}

	return found;
}

/**
 * Every string in one TypeScript source that a person actually reads.
 *
 * This is #69's real work: `GLOSSARY.md` governs the words a person meets, and a
 * sweep of source code has to decide which strings those are before it can say
 * anything. {@link shownRegions}, {@link shownSlots} and the two positions above
 * them are that decision, and their doc comments carry the measurement behind
 * each.
 *
 * Comments go first — a note quoting a sentence the same commit rewrote is not
 * that sentence — and `${…}` inside a template literal is replaced by a space,
 * because what is inside it is code. Without that, `The calendar link answered
 * ${response.status}.` would fail on *status*, a word this repository retires
 * for a **feature state** and which is Obsidian's name for an HTTP field here.
 *
 * The answers come back in the order they are written, whichever rule found
 * them, and a literal found twice is counted once.
 *
 * **What the region rule reads that is not a sentence.** Nothing about a
 * returned `string` says whether it is words, so matching cannot tell one from
 * the other and the guard reads them all. Measured over the shipped tree on
 * this commit: `src/core/datePattern.ts` returns regular-expression fragments;
 * `src/core/icsOccurrences.ts` and `src/core/problems.ts` return single
 * characters and separators; `src/core/vaultLayout.ts` returns `"/"` and
 * `".md"`; `src/core/calendarTable.ts` returns the replacement fragment `"$1"`;
 * and `src/core/calendarSources.ts` returns the separator `"\u0001"` and holds
 * `"https://"` and `".ics"` inside `startsWith` and `endsWith` calls that a
 * statement region now reads past. The last four arrived with issues
 * #345 and
 * #353, which widened what
 * the rule reaches. The guard is quiet on every one of them, because none holds
 * a retired word — the cost is a false failure the day a fragment happens to
 * spell one, and the answer then is to name it here rather than to narrow the
 * rule.
 *
 * **What it does not reach**, and why the drawn-screen sweep in
 * `settingsTab.test.ts` is still needed beside it. Four shapes, each named in
 * its own terms rather than by the rule that misses it:
 *
 * - A sentence assembled at runtime out of pieces that are not literals. There
 *   is no literal to read.
 * - A badge label looked up in a table. The literal sits in the table, at no
 *   shown position, and the lookup is what reaches the screen.
 * - A shipped settings value that a box shows because nobody changed it. The
 *   calendar column named *Event* was one, and
 *   `manifest.test.ts` sweeps `defaultData()` for exactly that reason.
 * - An arrow function that returns its sentence as an **expression**, with no
 *   `return` keyword: `(read): string => "An event."`. The returned-sentence
 *   rule finds the function by its declared return type and then reads from the
 *   keyword, and there is no keyword to read from. Nothing in the shipped tree
 *   writes one. A **block-bodied** arrow function is a different shape and is
 *   read, since issue
 *   #353 — the two were run
 *   together in an earlier version of this paragraph, which told a reader
 *   checking their own shape the wrong thing.
 */
export function shownStrings(source: string): string[] {
	const text = withoutComments(source);
	const found = new Map<number, string>();

	const read = (region: { at: number; text: string }): void => {
		for (const literal of literalsIn(region)) {
			const words = literal.words.replace(/\$\{[^}]*\}/g, " ").trim();
			if (words) found.set(literal.at, words);
		}
	};

	shownRegions.lastIndex = 0;
	for (let hit = shownRegions.exec(text); hit; hit = shownRegions.exec(text)) {
		read(regionFrom(text, hit.index + hit[0].length - 1, "(", ")", null));
	}

	shownSlots.lastIndex = 0;
	for (let hit = shownSlots.exec(text); hit; hit = shownSlots.exec(text)) {
		const words = (hit[1] ?? hit[2] ?? hit[3] ?? "").replace(/\$\{[^}]*\}/g, " ").trim();
		if (words) found.set(hit.index + hit[0].length, words);
	}

	textContentAssignment.lastIndex = 0;
	for (let hit = textContentAssignment.exec(text); hit; hit = textContentAssignment.exec(text)) {
		read(regionFrom(text, hit.index + hit[0].length, "([{", ")]}", ";"));
	}

	returnsAString.lastIndex = 0;
	for (let hit = returnsAString.exec(text); hit; hit = returnsAString.exec(text)) {
		const body = regionFrom(text, hit.index + hit[0].length - 1, "{", "}", null);
		returnKeyword.lastIndex = 0;
		for (let ret = returnKeyword.exec(body.text); ret; ret = returnKeyword.exec(body.text)) {
			const at = body.at + ret.index + ret[0].length;
			read(regionFrom(text, at, "([{", ")]}", ";"));
		}
	}

	return [...found.entries()].sort(([a], [b]) => a - b).map(([, words]) => words);
}
