/**
 * The plugin's own bookkeeping properties against the stylesheet rule that
 * keeps them out of sight.
 *
 * Four properties are written into notes for the plugin's own use — which
 * meeting a note belongs to, whether it was offered, whether the person has
 * written in it, which diary section built a day's log. They stay in the
 * frontmatter, read and written as before, and `styles.css` hides their rows
 * in Obsidian's properties box by exact name. A stylesheet
 * cannot import a constant, so this suite is what ties the two together: a
 * fifth bookkeeping property declared later fails here until it has a rule,
 * and a rule that matches on a prefix would hide a property the person named
 * `effortless-notes` themselves.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILT_DIARY_FIELD } from "../core/builtDiaryMark";
import { IDENTITY_FIELD, OFFERED_FIELD, WRITTEN_FIELD } from "../features/meetingNotes/noteIdentity";
import { repoRoot } from "./repoRoot";
import { cssRules, quotedLiteral, shippedSources, withoutComments } from "./sourceGuards";

const BOOKKEEPING = [IDENTITY_FIELD, OFFERED_FIELD, WRITTEN_FIELD, BUILT_DIARY_FIELD].sort();

const stylesheet = readFileSync(resolve(repoRoot, "styles.css"), "utf8");

const shipped = shippedSources().map((file) => file.source);

/**
 * One `[data-property-key…]` attribute test. CSS lets the value be written in
 * double quotes, single quotes or none, and a prefix match is a prefix match
 * in all three, so all three are read: group 1 is the operator, group 3 a
 * quoted value (group 2 its quote, for the backreference), group 4 a bare one.
 * A trailing case flag (`i` or `s`) is allowed and ignored.
 */
const PROPERTY_KEY_TEST = new RegExp(
	String.raw`\[data-property-key\s*([~|^$*]?=)\s*(?:` +
		quotedLiteral(`(["'])`, String.raw`\2`, "capture") +
		String.raw`|([^\]\s"']+))\s*(?:[iIsS]\s*)?\]`,
	"g",
);

/** Every `data-property-key` test in `selector`, with its operator. */
function propertyKeyTests(selector: string): Array<{ operator: string; key: string }> {
	return [...selector.matchAll(PROPERTY_KEY_TEST)].map((m) => ({ operator: m[1], key: m[3] ?? m[4] }));
}

const hides = (body: string): boolean => /display\s*:\s*none/.test(body);

/**
 * The keys whose rows the stylesheet hides: every selector, among those of a
 * rule setting `display: none`, that is a `.metadata-property` with one
 * exact-key test and nothing else. A container rule that merely mentions a
 * key is not read here.
 */
function hiddenRowKeys(css: string): string[] {
	const keys = new Set<string>();
	for (const rule of cssRules(css)) {
		if (!hides(rule.body)) continue;
		for (const selector of rule.selector.split(/,(?![^(]*\))/)) {
			const whole = /^\.metadata-property(\[[^\]]*\])$/.exec(selector.trim());
			const tests = whole ? propertyKeyTests(whole[1]) : [];
			if (tests.length === 1 && tests[0].operator === "=") keys.add(tests[0].key);
		}
	}
	return [...keys].sort();
}

/** Every `data-property-key` test in the stylesheet that is not an exact match. */
function inexactKeyTests(css: string): string[] {
	return cssRules(css).flatMap((rule) =>
		propertyKeyTests(rule.selector)
			.filter((test) => test.operator !== "=")
			.map((test) => `${test.operator}${test.key}`),
	);
}

/**
 * The two lists of the rule that hides the whole properties box: the keys the
 * box must hold one of, before `:not(:has(`, and the keys every row in it must
 * be one of, after. Either list missing a key is a different defect — a box
 * with only that row left drawn empty, or a box holding it hidden with the
 * person's rows — so each is read on its own.
 */
function boxRuleLists(css: string): { holds: string[]; onlyOf: string[] } | undefined {
	const rule = cssRules(css).find((one) => one.selector.startsWith(".metadata-container") && hides(one.body));
	if (rule === undefined) return undefined;
	const [holds, onlyOf = ""] = rule.selector.split(":not(:has(");
	const keys = (part: string) => propertyKeyTests(part).map((test) => test.key).sort();
	return { holds: keys(holds), onlyOf: keys(onlyOf) };
}

/**
 * Every bookkeeping property the shipped source declares. All four are
 * declared the same way — `export const <NAME>_FIELD = "effortless-…"` — so a
 * fifth written in that shape is found here without anyone adding it to a
 * list.
 */
function declaredBookkeepingKeys(sources: string[]): string[] {
	const keys = new Set<string>();
	for (const source of sources) {
		for (const m of withoutComments(source).matchAll(/export\s+const\s+\w+_FIELD\s*=\s*"(effortless-[^"]*)"/g)) {
			keys.add(m[1]);
		}
	}
	return [...keys].sort();
}

/** The declared bookkeeping properties the stylesheet has no row rule for. */
function withoutHideRule(css: string, sources: string[]): string[] {
	const hidden = new Set(hiddenRowKeys(css));
	return declaredBookkeepingKeys(sources).filter((key) => !hidden.has(key));
}

describe("the plugin's bookkeeping properties", () => {
	// The scan below is what catches a fifth; this is what shows it still sees
	// the four, so an empty scan cannot pass for a clean one.
	it("are the four the shipped source declares, found by a scan of it", () => {
		expect(declaredBookkeepingKeys(shipped)).toEqual(BOOKKEEPING);
	});

	it("each have a rule hiding their row by exact name, and no other row is hidden", () => {
		expect(withoutHideRule(stylesheet, shipped)).toEqual([]);
		expect(hiddenRowKeys(stylesheet)).toEqual(BOOKKEEPING);
	});

	it("would report a fifth declared without a rule", () => {
		const fifth = 'export const SEEN_FIELD = "effortless-seen";';
		expect(withoutHideRule(stylesheet, [...shipped, fifth])).toEqual(["effortless-seen"]);
	});

	it("would report one of the four whose rule was taken out", () => {
		const css = stylesheet.replace(/^\.metadata-property\[data-property-key="effortless-offered"\],\n/m, "");
		expect(css).not.toEqual(stylesheet);
		expect(withoutHideRule(css, shipped)).toEqual([OFFERED_FIELD]);
	});

	it("are never matched by prefix, suffix or substring", () => {
		expect(inexactKeyTests(stylesheet)).toEqual([]);
	});

	it("would report a prefix rule however its value is quoted", () => {
		const css = [
			'.metadata-property[data-property-key^="effortless-"] { display: none; }',
			".metadata-property[data-property-key^='effortless-'] { display: none; }",
			".metadata-property[data-property-key^=effortless-] { display: none; }",
		].join("\n");
		expect(inexactKeyTests(css)).toEqual(["^=effortless-", "^=effortless-", "^=effortless-"]);
	});

	it("are each named in both lists of the rule that hides the whole box", () => {
		expect(boxRuleLists(stylesheet)).toEqual({ holds: BOOKKEEPING, onlyOf: BOOKKEEPING });
	});

	it("would report a box rule whose second list is missing one", () => {
		const css = stylesheet.replace(/^\t\[data-property-key="effortless-written"\],\n/m, "");
		expect(css).not.toEqual(stylesheet);
		expect(boxRuleLists(css)?.onlyOf).toEqual(BOOKKEEPING.filter((key) => key !== WRITTEN_FIELD));
	});
});
