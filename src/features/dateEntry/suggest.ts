/**
 * The date-entry popup's whole judgement, as one pure function: given the
 * text before the cursor, the stored settings, today, and the position of a
 * trigger the person has dismissed, it says whether the popup opens, where the trigger
 * sits, which kind of date was asked for, and what the one suggestion is — a
 * date with its phrase, or the `...` placeholder. No editor and no Obsidian
 * (#573 decisions 4 and
 * 5, and its "Named differences" row 3; ticket
 * #579).
 *
 * **When it opens.** The last occurrence of `settings.trigger` in
 * `lineBeforeCursor` is the only candidate this function ever considers, and
 * it must be the first character on the line or follow a space or a tab —
 * there is no fallback to an earlier occurrence when it is not. So
 * `name@example.com` and `task@imorgon` open nothing — the author's ruling of
 * 2026-08-27, recorded in spec
 * #573 ("the popup opens
 * on every email address typed … it must stop"), whose **accepted loss is
 * `task@imorgon`: this is deliberate, not a bug to restore.** Taking only the
 * last occurrence, with no fallback, is also what keeps a query holding a
 * second trigger character from opening: `@ab@cd` fails on the second `@`'s
 * own boundary (preceded by `b`, not whitespace), which is the same check
 * every other candidate is held to, not a second rule.
 *
 * **A bracket after the trigger.** A trigger whose next character, in the
 * text before the cursor, is `[` never opens, whatever the trigger character
 * is: `@[[` is the start of a link to a person or a note, and Obsidian's link
 * chooser is the one popup that should answer it. The rule sees only that
 * text, so a trigger typed in front of an existing `[[link]]` has nothing
 * after it yet and still opens (an inference, not a drive).
 * It is decided with the boundary rule, before any date is parsed and
 * before the dismissal check, and like the boundary rule it asks the caller
 * to record nothing.
 *
 * **Dismissal.** `dismissed` is the position of a trigger the caller has
 * already recorded as dismissed, or `null`. This function only reads it: an
 * otherwise-valid trigger found at exactly that position does not open, and
 * `dismissed` plays no other part. Recording a dismissal, and clearing one
 * when a new trigger is typed, this one is deleted, or the cursor moves to a
 * different trigger, is the caller's job — a pure function keeps no memory
 * between calls to do it with, so the caller's own tracked position is what
 * changes from call to call. A trigger the boundary rule declines never
 * opens in the first place, so nothing here ever asks the caller to dismiss
 * it — that recording, too, is entirely the caller's to skip.
 *
 * **The kind**, from prefix words compared case-insensitively, longest
 * first: `schema `, `sch `, `s ` → scheduled; `due `, `d ` → due; nothing
 * typed → scheduled. A query that is exactly a prefix word, or a prefix and
 * its space and nothing more, is that kind's placeholder — `suggestion` is
 * `null` — decided **before either language parser runs**: `@d` is a due
 * placeholder even though `parseEnglish` answers `d` with day after
 * tomorrow, and `@s` is a scheduled placeholder even though `parseSwedish`
 * answers `s` with söndag.
 *
 * **The emoji.** The returned shape carries no emoji itself — a caller draws
 * `⏳`/`📅` from `kind` the way `dateStampText` does — but the two
 * placeholders still have to be told apart, since both carry the very same
 * `kind`. `showEmoji` is that telling: it is `true` whenever a date was
 * found, or a prefix word was typed and left as a placeholder, and `false`
 * for the placeholder with nothing typed at all (the trigger alone) and for
 * a query with no recognised prefix that no date came from either.
 *
 * **The date.** Whatever is left after a matched prefix is stripped — or the
 * whole query, where no prefix matched — goes to `parseSwedish` or
 * `parseEnglish` by `settings.language`. Nothing is cached between calls:
 * the same `lineBeforeCursor` answers differently the moment
 * `settings.language` does.
 *
 * **Or a repeat rule.** A query with no prefix word that starts a rule word —
 * Swedish `varje`, `varannan`, `vartannat`, `var `, `den `, `sista`, English
 * `every`, from the first letter — is not a date at all: the answer carries
 * `rules`, the rows `repeatRows` gives, and no date row beside them — or
 * `null`, no popup, when the fragment matches no rule. A query
 * that is exactly a prefix word (`s`, `d`, `sch`, `schema`, `due`) was decided
 * above and stays the date placeholder, so `sista` becomes a rule at `si`. A
 * rule answer has `suggestion: null` and `showEmoji: false`: the rows draw
 * their own emoji. The date answers are exactly the shape they always were,
 * with no `rules` field at all.
 */

import { parseEnglish } from "./english";
import { repeatRows, startsRuleWord, type RepeatRow } from "./repeatRows";
import { isoDate } from "./stamp";
import { parseSwedish } from "./swedish";

/** The answer for a query that starts a rule word: the rows to offer, narrowed by what was typed. */
export interface RuleAnswer {
	readonly triggerAt: number;
	readonly kind: "scheduled";
	readonly suggestion: null;
	readonly showEmoji: false;
	readonly rules: readonly RepeatRow[];
}

/** The answer for a query read as a date, or the placeholder. */
export interface DatePopupAnswer {
	readonly triggerAt: number;
	readonly kind: "scheduled" | "due";
	readonly suggestion: { readonly phrase: string; readonly date: Date } | null;
	readonly showEmoji: boolean;
}

/** A space or a tab, or the start of the line — the boundary a trigger must sit at. */
function isBoundary(charBefore: string | undefined): boolean {
	return charBefore === undefined || charBefore === " " || charBefore === "\t";
}

/**
 * The five prefix words, longest first. None of today's five is a true
 * prefix of another once its own trailing space is counted — `"s "` cannot
 * match where `"sch "` or `"schema "` would, since their second character is
 * never a space — so this order changes nothing they answer today; it is
 * kept for whoever adds a word that does overlap one of these.
 */
const PREFIX_WORDS: ReadonlyArray<readonly [word: string, kind: "scheduled" | "due"]> = [
	["schema", "scheduled"],
	["sch", "scheduled"],
	["due", "due"],
	["s", "scheduled"],
	["d", "due"],
];

/** A matched prefix word: its kind, and what is left of the query after it. */
interface PrefixMatch {
	readonly kind: "scheduled" | "due";
	readonly rest: string;
}

/**
 * The prefix word `query` matches, case-insensitively, and what is left
 * after it. A query equal to a word alone, or to the word plus one space and
 * nothing more, answers `rest: ""` — the placeholder case. `null` means no
 * word matches at all, so the whole query is the parser's to read.
 */
function matchPrefix(query: string): PrefixMatch | null {
	const lower = query.toLowerCase();
	for (const [word, kind] of PREFIX_WORDS) {
		if (lower === word) return { kind, rest: "" };
	}
	for (const [word, kind] of PREFIX_WORDS) {
		const withSpace = `${word} `;
		if (lower.startsWith(withSpace)) return { kind, rest: query.slice(withSpace.length) };
	}
	return null;
}

/**
 * The popup's whole judgement for one line. See the doc comment above this
 * file for what each field means and why. `null` means the popup does not
 * open at all.
 */
export function suggest(
	lineBeforeCursor: string,
	settings: { readonly language: "sv" | "en"; readonly trigger: string },
	today: Date,
	dismissed: number | null,
): DatePopupAnswer | RuleAnswer | null {
	const triggerAt = lineBeforeCursor.lastIndexOf(settings.trigger);
	if (triggerAt === -1) return null;

	// `task@imorgon` is the accepted loss of this rule, ruled on 2026-08-27
	// and recorded in spec #573: a trigger mid-word never opens, on purpose,
	// and is not to be "fixed" back into opening.
	if (!isBoundary(lineBeforeCursor[triggerAt - 1])) return null;

	// `@[[` starts a link, which is Obsidian's chooser to answer:
	// decided here, before the dismissal check and before any date is parsed.
	if (lineBeforeCursor[triggerAt + settings.trigger.length] === "[") return null;

	if (dismissed === triggerAt) return null;

	const query = lineBeforeCursor.slice(triggerAt + settings.trigger.length);
	const prefixMatch = matchPrefix(query);
	const kind = prefixMatch?.kind ?? "scheduled";

	if (prefixMatch !== null && prefixMatch.rest === "") {
		return { triggerAt, kind, suggestion: null, showEmoji: true };
	}

	if (prefixMatch === null && startsRuleWord(query, settings.language)) {
		const rules = repeatRows(query, settings.language, isoDate(today));
		// Nothing offered is no popup, as for any other query that offers nothing:
		// an empty list would make Obsidian close the popup itself, and that close
		// reaches the dismissal hook as if the person had pressed Escape.
		if (rules.length === 0) return null;
		return { triggerAt, kind: "scheduled", suggestion: null, showEmoji: false, rules };
	}

	const rest = prefixMatch !== null ? prefixMatch.rest : query;
	const parsed = settings.language === "sv" ? parseSwedish(rest, today) : parseEnglish(rest, today);

	if (parsed !== null) {
		return {
			triggerAt,
			kind,
			suggestion: { phrase: parsed.phrase, date: parsed.date },
			showEmoji: true,
		};
	}

	return { triggerAt, kind, suggestion: null, showEmoji: prefixMatch !== null };
}
