/**
 * The rows the popup offers once the person starts a repeat rule instead of a
 * date: each is a phrase in their language, the rule it means, and the exact
 * text that rule is written as.
 *
 * **Two kinds of text, kept apart.** The *phrase* (`varje måndag`, `every
 * Monday`) is this file's, in Swedish or English, and is what the person types
 * and narrows by. The *rule text* (`every week on Monday`) is never written here:
 * every row builds a {@link RepeatRule} and asks the core's `writeRepeatRule`
 * for its text, so a row cannot show or write a string the core would not read
 * back as the same rule. The first date for a line with none comes from the
 * core's `firstRepeatDate` the same way.
 *
 * **Which rules are offered.** Every interval (`every day` … `every year`, twice
 * over, and once more with a number the person typed, `3` before any), each
 * weekday alone, `every weekday`, a weekday with another after `och` / `and`,
 * the same weekdays every second or Nth week, the first of the month, a typed
 * day of the month, both together, and the last day. Each is offered with and
 * without the `when done` ending. The narrowing is by prefix on the folded
 * phrase, so a phrase that does not begin with what was typed is not shown.
 *
 * **Folding.** Case is ignored and `å`, `ä` and `ö` match `a`, `a` and `o`, so a
 * keyboard without them still narrows. Whitespace runs count as one blank; a
 * trailing blank is kept, because `var ` and `varje` start different phrases.
 *
 * **Spelled and digit forms both match.** Swedish says `var tredje vecka` and
 * `den förste varje månad`; a person who typed `var 3` or `den 1` is matched
 * against `var 3:e vecka` and `den 1:a varje månad` too, and still sees the
 * spelled phrase. Past `fjärde` the phrase is always the digit form (`var 5:e`).
 *
 * Plain functions: no editor, no Obsidian, no clock — `today` is an argument.
 */

import {
	MAX_INTERVAL,
	WEEKDAY_NAMES,
	firstRepeatDate,
	writeRepeatRule,
	type MonthDay,
	type RepeatRule,
	type RepeatUnit,
} from "../../core/repeatRule";
import { repeatStampText } from "../../core/taskLine";

export type RepeatLanguage = "sv" | "en";

/** The most rows the popup shows at once. */
export const MAX_ROWS = 7;

/** One row: what the person reads, and what accepting it writes. */
export interface RepeatRow {
	/** The phrase in the person's language, `when done` ending included. */
	readonly phrase: string;
	/** The rule as the core writes it — the text that lands after the repeat emoji. */
	readonly text: string;
	/** `text` as the line carries it, the repeat emoji first — the greyed text beside the phrase. */
	readonly stamp: string;
	readonly rule: RepeatRule;
	/** The first scheduled date for a line with none (`YYYY-MM-DD`), or `null` when the rule never lands. */
	readonly firstDate: string | null;
}

/* -------------------------------------------------------------------------- */
/* Folding and entry                                                           */
/* -------------------------------------------------------------------------- */

/** Case ignored, `å`/`ä`/`ö` as `a`/`a`/`o`, blanks collapsed, leading blanks kept out of the way. */
function fold(text: string): string {
	return text
		.toLowerCase()
		.replace(/[åä]/g, "a")
		.replace(/ö/g, "o")
		.replace(/\s+/g, " ");
}

/** A fragment that is exactly one of these is today's date placeholder, never a rule. */
const DATE_PREFIX_WORDS: readonly string[] = ["s", "d", "sch", "schema", "due"];

/** The words that start a rule, folded. The blank after `var` and `den` is part of the word. */
const RULE_WORDS: Readonly<Record<RepeatLanguage, readonly string[]>> = {
	sv: ["varje", "varannan", "vartannat", "var ", "den ", "sista"],
	en: ["every"],
};

/**
 * Whether `fragment` — what was typed after the trigger — starts a rule word,
 * from its first letter: a prefix of one, or one followed by more. A fragment
 * that is exactly a date prefix word (`s`, `d`, `sch`, `schema`, `due`) does
 * not, so `sista` becomes a rule at `si` and not at `s`.
 */
export function startsRuleWord(fragment: string, language: RepeatLanguage): boolean {
	const typed = fold(fragment);
	if (typed === "") return false;
	if (DATE_PREFIX_WORDS.includes(typed)) return false;
	return RULE_WORDS[language].some((word) => word.startsWith(typed) || typed.startsWith(word));
}

/* -------------------------------------------------------------------------- */
/* The phrase tables                                                           */
/* -------------------------------------------------------------------------- */

const UNITS: readonly RepeatUnit[] = ["day", "week", "month", "year"];

const SWEDISH_UNITS: Readonly<Record<RepeatUnit, string>> = {
	day: "dag",
	week: "vecka",
	month: "månad",
	year: "år",
};
const SWEDISH_WEEKDAYS: readonly string[] = [
	"måndag",
	"tisdag",
	"onsdag",
	"torsdag",
	"fredag",
	"lördag",
	"söndag",
];
/** The numbers Swedish says as a word in `var … vecka`; past these the digit form is the phrase. */
const SWEDISH_INTERVAL_WORDS: Readonly<Record<number, string>> = { 3: "tredje", 4: "fjärde" };
const SWEDISH_WHEN_DONE = " efter klart";

const ENGLISH_WHEN_DONE = " when done";

const MONDAY_TO_FRIDAY: readonly number[] = [0, 1, 2, 3, 4];

function isWeekdays(rule: RepeatRule): boolean {
	return (
		rule.interval === 1 &&
		rule.weekdays !== null &&
		rule.weekdays.length === MONDAY_TO_FRIDAY.length &&
		rule.weekdays.every((day, index) => day === MONDAY_TO_FRIDAY[index])
	);
}

/**
 * The weekdays of a rule in the order a person may have typed them: the rule's
 * own order is Monday first, and a person who typed `varje torsdag och` has
 * Thursday first, so a pair is also matched flipped.
 */
function inTypedOrder(weekdays: readonly number[], flipped: boolean): readonly number[] {
	return flipped ? [...weekdays].reverse() : weekdays;
}

/** `5:e`, `2:a`, `21:a`, `12:e` — Swedish writes `:a` after a 1 or a 2, except 11 and 12. */
function swedishOrdinal(n: number): string {
	const lastTwo = n % 100;
	const takesA = (n % 10 === 1 || n % 10 === 2) && lastTwo !== 11 && lastTwo !== 12;
	return `${n}${takesA ? ":a" : ":e"}`;
}

function swedishEvery(n: number, unit: RepeatUnit, spelled: boolean): string {
	const noun = SWEDISH_UNITS[unit];
	if (n === 1) return `varje ${noun}`;
	// `var 2` has to reach the interval-2 rows, so the digit spelling is matched too (never shown).
	if (n === 2) return spelled ? (unit === "year" ? "vartannat år" : `varannan ${noun}`) : `var ${swedishOrdinal(2)} ${noun}`;
	const word = spelled ? SWEDISH_INTERVAL_WORDS[n] : undefined;
	return `var ${word ?? swedishOrdinal(n)} ${noun}`;
}

function swedishDay(day: MonthDay, spelled: boolean): string {
	return spelled && day === 1 ? "förste" : swedishOrdinal(day as number);
}

function swedishPhrase(rule: RepeatRule, spelled: boolean, flipped: boolean = false): string {
	let phrase: string;
	if (rule.weekdays !== null) {
		const days = isWeekdays(rule)
			? "vardag"
			: inTypedOrder(rule.weekdays, flipped).map((day) => SWEDISH_WEEKDAYS[day]).join(" och ");
		phrase = rule.interval === 1 ? `varje ${days}` : `${swedishEvery(rule.interval, "week", spelled)} på ${days}`;
	} else if (rule.monthDays !== null) {
		phrase = rule.monthDays.includes("last")
			? "sista varje månad"
			: `den ${rule.monthDays.map((day) => swedishDay(day, spelled)).join(" och ")} varje månad`;
	} else {
		phrase = swedishEvery(rule.interval, rule.unit, spelled);
	}
	return phrase + (rule.whenDone ? SWEDISH_WHEN_DONE : "");
}

function englishOrdinal(n: number): string {
	const lastTwo = n % 100;
	if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
	const suffix = ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
	return `${n}${suffix}`;
}

function englishPhrase(rule: RepeatRule, flipped: boolean = false): string {
	let phrase: string;
	if (rule.weekdays !== null) {
		const days = isWeekdays(rule)
			? "weekday"
			: inTypedOrder(rule.weekdays, flipped).map((day) => WEEKDAY_NAMES[day]).join(" and ");
		phrase = rule.interval === 1 ? `every ${days}` : `every ${rule.interval} weeks on ${days}`;
	} else if (rule.monthDays !== null) {
		const days = rule.monthDays.map((day) => (day === "last" ? "last" : englishOrdinal(day)));
		phrase = `every month on the ${days.join(" and ")}`;
	} else {
		phrase = rule.interval === 1 ? `every ${rule.unit}` : `every ${rule.interval} ${rule.unit}s`;
	}
	return phrase + (rule.whenDone ? ENGLISH_WHEN_DONE : "");
}

/** The phrase a row shows, and every other spelling of it the narrowing also matches. */
function phrasesOf(
	rule: RepeatRule,
	language: RepeatLanguage,
	digitTyped: boolean,
): { shown: string; matched: string[] } {
	const flips = rule.weekdays !== null && rule.weekdays.length === 2 && !isWeekdays(rule) ? [false, true] : [false];
	const shown = language === "en" ? englishPhrase(rule) : swedishPhrase(rule, true);
	const matched: string[] = [];
	for (const flipped of flips) {
		if (language === "en") matched.push(englishPhrase(rule, flipped));
		else {
			matched.push(swedishPhrase(rule, true, flipped));
			// The digit spelling is matched only once a digit is typed, so `var ` still starts at `var tredje`.
			if (digitTyped) matched.push(swedishPhrase(rule, false, flipped));
		}
	}
	return { shown, matched: [...new Set(matched)] };
}

/* -------------------------------------------------------------------------- */
/* What was typed                                                              */
/* -------------------------------------------------------------------------- */

/** The numbers in `fragment`, in the order typed: digits, and the Swedish words for 1, 3 and 4. */
function numbersTyped(fragment: string, language: RepeatLanguage): number[] {
	const found: number[] = [];
	for (const word of fold(fragment).split(" ")) {
		const digits = /\d+/.exec(word);
		if (digits !== null) {
			found.push(Number(digits[0]));
			continue;
		}
		if (language !== "sv") continue;
		if (word === "forste") found.push(1);
		for (const [number, spelled] of Object.entries(SWEDISH_INTERVAL_WORDS)) {
			if (word === fold(spelled)) found.push(Number(number));
		}
	}
	return found;
}

/** The first weekday named in `fragment` (0 is Monday), or `null`. */
function weekdayTyped(fragment: string, language: RepeatLanguage): number | null {
	const typed = fold(fragment);
	const names = language === "sv" ? SWEDISH_WEEKDAYS : WEEKDAY_NAMES;
	const at = names.findIndex((name) => typed.includes(fold(name)));
	return at === -1 ? null : at;
}

/** Whether the person has started the word after a weekday that joins a second one. */
function pairRequested(fragment: string, weekday: number | null, language: RepeatLanguage): boolean {
	if (weekday === null) return false;
	const names = language === "sv" ? SWEDISH_WEEKDAYS : WEEKDAY_NAMES;
	const typed = fold(fragment);
	const name = fold(names[weekday]);
	const after = typed.slice(typed.indexOf(name) + name.length);
	const joiner = language === "sv" ? "och" : "and";
	const started = /^ (\S*)/.exec(after);
	return started !== null && started[1] !== "" && joiner.startsWith(started[1]);
}

/* -------------------------------------------------------------------------- */
/* The rules offered                                                           */
/* -------------------------------------------------------------------------- */

function intervalRule(unit: RepeatUnit, interval: number): RepeatRule {
	return { unit, interval, weekdays: null, monthDays: null, whenDone: false };
}

function weekdayRule(weekdays: readonly number[], interval: number): RepeatRule {
	return { unit: "week", interval, weekdays, monthDays: null, whenDone: false };
}

function monthDayRule(monthDays: readonly MonthDay[]): RepeatRule {
	return { unit: "month", interval: 1, weekdays: null, monthDays, whenDone: false };
}

/** The rules the popup can offer for `fragment`, before any narrowing, in the order they are shown. */
function candidates(fragment: string, language: RepeatLanguage): RepeatRule[] {
	const typed = numbersTyped(fragment, language);
	const interval = typed.filter((n) => n >= 2 && n <= MAX_INTERVAL).pop() ?? 3;
	const days = [...new Set(typed.filter((n) => n >= 1 && n <= 31))];
	const day = days.length > 0 ? days[days.length - 1] : 15;
	const weekday = weekdayTyped(fragment, language);

	const found: RepeatRule[] = [];
	for (const n of [1, 2, interval]) for (const unit of UNITS) found.push(intervalRule(unit, n));
	for (let at = 0; at < 7; at++) found.push(weekdayRule([at], 1));
	found.push(weekdayRule(MONDAY_TO_FRIDAY, 1));
	if (pairRequested(fragment, weekday, language) && weekday !== null) {
		for (let other = 0; other < 7; other++) {
			if (other !== weekday) found.push(weekdayRule([weekday, other].sort((a, b) => a - b), 1));
		}
	}
	for (const n of [2, interval]) for (let at = 0; at < 7; at++) found.push(weekdayRule([at], n));
	found.push(monthDayRule([1]));
	if (day !== 1) found.push(monthDayRule([day]));
	const pair = days.length >= 2 ? days.slice(-2).sort((a, b) => a - b) : [1, day === 1 ? 15 : day];
	found.push(monthDayRule(pair));
	found.push(monthDayRule(["last"]));

	// The same rule can come twice — `3` typed as the interval is also the default.
	const seen = new Set<string>();
	return found.filter((rule) => {
		const text = writeRepeatRule(rule);
		if (seen.has(text)) return false;
		seen.add(text);
		return true;
	});
}

/** One row for `rule`, whose phrase is `phrase`. */
function rowFor(rule: RepeatRule, phrase: string, today: string): RepeatRow {
	const text = writeRepeatRule(rule);
	return { phrase, text, stamp: repeatStampText(text), rule, firstDate: firstRepeatDate(rule, today) };
}

/**
 * The rows for what was typed after the trigger: every rule whose phrase, or
 * whose digit spelling, begins with `fragment` once both are folded. The `when
 * done` twin of a rule follows it once the rule's phrase has been typed in full
 * or the word after it has been started, and not before. At most `limit` rows;
 * nothing is reordered, so `varje må` lists `varje månad` and `varje måndag`
 * both until the next letter.
 *
 * `today` is `YYYY-MM-DD`; it is the day each row's first date counts from.
 * Asked of a fragment that does not start a rule word (see {@link startsRuleWord})
 * this still answers, with whatever the prefix leaves.
 */
export function repeatRows(
	fragment: string,
	language: RepeatLanguage,
	today: string,
	limit: number = MAX_ROWS,
): RepeatRow[] {
	const typed = fold(fragment);
	const suffix = language === "sv" ? SWEDISH_WHEN_DONE : ENGLISH_WHEN_DONE;
	const rows: RepeatRow[] = [];

	for (const rule of candidates(fragment, language)) {
		const base = phrasesOf(rule, language, /\d/.test(typed));
		if (base.matched.some((phrase) => fold(phrase).startsWith(typed))) {
			rows.push(rowFor(rule, base.shown, today));
		}
		const twin = { ...rule, whenDone: true };
		const twinShown = base.matched.some((phrase) => {
			const whole = fold(phrase);
			return typed.length >= whole.length && fold(phrase + suffix).startsWith(typed);
		});
		if (twinShown) rows.push(rowFor(twin, base.shown + suffix, today));
		if (rows.length >= limit) break;
	}
	return rows.slice(0, limit);
}
