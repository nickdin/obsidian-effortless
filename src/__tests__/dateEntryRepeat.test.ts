/**
 * The popup offering repeat rules in the person's language and writing the
 * English text.
 *
 * Three layers, each against the one below it and none against a copy of it:
 * `repeatRows` and `suggest` judge what is offered, `stampRepeat` decides the
 * line, and `DateSuggester` accepts a row end to end through the core's
 * repeat-rule module and the task-line reader. Every date is counted from the
 * reference Thursday the other date-entry tests use, 2026-09-03.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App, EditorPosition, EditorTransaction, TFile } from "obsidian";
import { EditorSuggest } from "./__mocks__/obsidian";
import { readRepeatRule, writeRepeatRule } from "../core/repeatRule";
import { repeatStampText } from "../core/taskLine";
import { DateSuggester } from "../features/dateEntry/dateEntry";
import { MAX_ROWS, repeatRows, startsRuleWord } from "../features/dateEntry/repeatRows";
import type { RepeatRow } from "../features/dateEntry/repeatRows";
import { stamp, stampRepeat } from "../features/dateEntry/stamp";
import { suggest } from "../features/dateEntry/suggest";
import type { DateEntryEditor, DateEntrySettings } from "../features/dateEntry/types";

/** The reference Thursday, 2026-09-03; the next Monday is 2026-09-07. */
const THURSDAY = new Date(2026, 8, 3);
const TODAY = "2026-09-03";

const SWEDISH = { language: "sv" as const, trigger: "@" };
const ENGLISH = { language: "en" as const, trigger: "@" };

/** The rows `suggest` offers for what was typed after the trigger, or a failure saying what it answered. */
function offered(typed: string, settings: typeof SWEDISH | typeof ENGLISH): readonly RepeatRow[] {
	const answer = suggest(`@${typed}`, settings, THURSDAY, null);
	if (answer === null || !("rules" in answer)) {
		throw new Error(`@${typed} did not offer rules: ${JSON.stringify(answer)}`);
	}
	return answer.rules;
}

const phrases = (rows: readonly RepeatRow[]): string[] => rows.map((row) => row.phrase);
const texts = (rows: readonly RepeatRow[]): string[] => rows.map((row) => row.text);

describe("a rule word switches the rows from dates to rules", () => {
	it.each([
		["v", SWEDISH],
		["va", SWEDISH],
		["var", SWEDISH],
		["var ", SWEDISH],
		["var 5", SWEDISH],
		["varje", SWEDISH],
		["varannan", SWEDISH],
		["vartannat", SWEDISH],
		["de", SWEDISH],
		["den", SWEDISH],
		["den ", SWEDISH],
		["den 20", SWEDISH],
		["si", SWEDISH],
		["sista", SWEDISH],
		["Varje", SWEDISH],
		["e", ENGLISH],
		["ev", ENGLISH],
		["every", ENGLISH],
		["every ", ENGLISH],
		["EVERY monday", ENGLISH],
	])("reads %j as the start of a rule", (typed, settings) => {
		const answer = suggest(`@${typed}`, settings, THURSDAY, null);

		expect(answer).not.toBeNull();
		expect(answer !== null && "rules" in answer).toBe(true);
		// No date row beside the rules: nothing here is a date.
		expect(answer?.suggestion).toBeNull();
		expect(answer?.showEmoji).toBe(false);
	});

	it.each([["s"], ["d"], ["sch"], ["schema"], ["due"], ["S"], ["DUE"]])(
		"keeps %j as today's date placeholder, not a rule",
		(typed) => {
			const answer = suggest(`@${typed}`, SWEDISH, THURSDAY, null);

			expect(answer).not.toBeNull();
			expect(answer !== null && "rules" in answer).toBe(false);
			expect(answer?.suggestion).toBeNull();
			expect(answer?.showEmoji).toBe(true);
		},
	);

	it.each([["s"], ["d"], ["sch"], ["schema"], ["due"], ["S"], ["Due"]])(
		"does not call %j the start of a rule word, whatever suggest does with it first",
		(typed) => {
			// `s` begins `sista` and `d` begins `den `: only the exception keeps them dates.
			expect(startsRuleWord(typed, "sv")).toBe(false);
			expect(startsRuleWord(typed, "en")).toBe(false);
		},
	);

	it("gives rules at si, one letter past s, where s alone is the placeholder", () => {
		expect("rules" in (suggest("@s", SWEDISH, THURSDAY, null) ?? {})).toBe(false);
		expect(phrases(offered("si", SWEDISH))).toEqual(["sista varje månad"]);
	});

	it("reads a date word that is not a rule word as a date", () => {
		const answer = suggest("@imorgon", SWEDISH, THURSDAY, null);

		expect(answer !== null && "rules" in answer).toBe(false);
		expect(answer?.suggestion?.phrase).toBe("imorgon");
	});

	it("reads a rule word of the other language as a date, so each language has its own", () => {
		expect(startsRuleWord("varje", "en")).toBe(false);
		expect(startsRuleWord("every", "sv")).toBe(false);
		expect(suggest("@every", SWEDISH, THURSDAY, null)).toMatchObject({ suggestion: null });
		expect("rules" in (suggest("@every", SWEDISH, THURSDAY, null) ?? {})).toBe(false);
	});

	it("does not read a prefix word followed by more as a rule", () => {
		// `d` and a space is today's due prefix, so `d den` is a due date's text.
		const answer = suggest("@d den", SWEDISH, THURSDAY, null);

		expect(answer !== null && "rules" in answer).toBe(false);
		expect(answer?.kind).toBe("due");
	});

	it("opens no popup for a rule fragment nothing matches, rather than an empty one", () => {
		// An empty list would make Obsidian close the popup itself, and that close is
		// read as the person dismissing this trigger, so backspacing the typo would not reopen it.
		expect(suggest("@varje xyz", SWEDISH, THURSDAY, null)).toBeNull();
		expect(suggest("@every xyz", ENGLISH, THURSDAY, null)).toBeNull();
		expect(suggest("@varje m", SWEDISH, THURSDAY, null)).not.toBeNull();
	});
});

describe("every row's greyed text is the core module's, read back", () => {
	// A row that held text of its own would be a string the core refuses, or reads
	// as another rule: both are caught by reading the row's text back.
	const SWEDISH_FRAGMENTS = [
		"v",
		"var 5",
		"var 12",
		"var 21",
		"var 100",
		"den 20",
		"den 2",
		"den 31",
		"den förste och 20",
		"sista",
		"varje måndag och",
		"varje onsdag och",
		"varje söndag och",
	];
	const ENGLISH_FRAGMENTS = [
		"e",
		"every 5",
		"every 12",
		"every 100",
		"every month on the 20",
		"every month on the 2",
		"every month on the 22",
		"every month on the 1st and 20",
		"every Monday and",
		"every Sunday and",
	];

	const every = (fragments: readonly string[], language: "sv" | "en"): RepeatRow[] =>
		fragments.flatMap((fragment) => repeatRows(fragment, language, TODAY, Infinity));

	it.each([
		["Swedish", "sv" as const, SWEDISH_FRAGMENTS],
		["English", "en" as const, ENGLISH_FRAGMENTS],
	])("reads every %s row back to a rule that writes the same text", (_name, language, fragments) => {
		const rows = every(fragments, language);
		expect(rows.length).toBeGreaterThan(60);

		for (const row of rows) {
			const read = readRepeatRule(row.text);
			expect(read, `the core refuses "${row.text}" (row "${row.phrase}")`).not.toBeNull();
			expect(writeRepeatRule(read!), `"${row.text}" is not the core's own text`).toBe(row.text);
			expect(row.rule, `"${row.phrase}" holds a rule other than the one its text reads`).toEqual(read);
			expect(row.text).toBe(writeRepeatRule(row.rule));
			expect(row.stamp).toBe(repeatStampText(row.text));
		}
	});

	it("shows each row's stamp beside the phrase, and the stamp is what the line will carry", () => {
		const [row] = offered("varje måndag", SWEDISH);

		expect(row.phrase).toBe("varje måndag");
		expect(row.text).toBe("every week on Monday");
		expect(row.stamp).toBe(repeatStampText("every week on Monday"));
	});
});

describe("the phrases the spec names, in both languages", () => {
	const SWEDISH_PHRASES: Array<[string, string]> = [
		["varje dag", "every day"],
		["varje vecka", "every week"],
		["varje månad", "every month"],
		["varje år", "every year"],
		["varannan vecka", "every 2 weeks"],
		["vartannat år", "every 2 years"],
		["var tredje vecka", "every 3 weeks"],
		["var 5:e vecka", "every 5 weeks"],
		["varje måndag", "every week on Monday"],
		["varje måndag och torsdag", "every week on Monday, Thursday"],
		["varje vardag", "every weekday"],
		["varannan vecka på måndag", "every 2 weeks on Monday"],
		["den förste varje månad", "every month on the 1st"],
		["den 15:e varje månad", "every month on the 15th"],
		["den förste och 15:e varje månad", "every month on the 1st and 15th"],
		["sista varje månad", "every month on the last"],
	];
	const ENGLISH_PHRASES: Array<[string, string]> = [
		["every day", "every day"],
		["every week", "every week"],
		["every month", "every month"],
		["every year", "every year"],
		["every 2 weeks", "every 2 weeks"],
		["every Monday", "every week on Monday"],
		["every Monday and Thursday", "every week on Monday, Thursday"],
		["every weekday", "every weekday"],
		["every 2 weeks on Monday", "every 2 weeks on Monday"],
		["every month on the 1st", "every month on the 1st"],
		["every month on the 15th", "every month on the 15th"],
		["every month on the last", "every month on the last"],
		["every month on the 1st and 15th", "every month on the 1st and 15th"],
	];

	it.each(SWEDISH_PHRASES)("offers the Swedish phrase %j and writes %j", (phrase, text) => {
		const rows = repeatRows(phrase, "sv", TODAY);
		expect(rows.find((row) => row.phrase === phrase)?.text).toBe(text);
	});

	it.each(ENGLISH_PHRASES)("offers the English phrase %j and writes %j", (phrase, text) => {
		const rows = repeatRows(phrase, "en", TODAY);
		expect(rows.find((row) => row.phrase === phrase)?.text).toBe(text);
	});

	it.each([...SWEDISH_PHRASES.map((p) => ["sv", ...p]), ...ENGLISH_PHRASES.map((p) => ["en", ...p])] as Array<
		["sv" | "en", string, string]
	>)("offers the when-done twin of the %s phrase %j once it is typed in full", (language, phrase, text) => {
		const suffix = language === "sv" ? " efter klart" : " when done";
		const twin = repeatRows(phrase, language, TODAY).find((row) => row.phrase === phrase + suffix);

		expect(twin?.text).toBe(`${text} when done`);
	});
});

describe("narrowing", () => {
	it("lists both varje månad and varje måndag at varje må, and each alone once the words differ", () => {
		expect(phrases(offered("varje må", SWEDISH))).toEqual(["varje månad", "varje måndag"]);
		// `mån` is shared by månad and måndag, so one letter more does not part them.
		expect(phrases(offered("varje mån", SWEDISH))).toEqual(["varje månad", "varje måndag"]);
		expect(phrases(offered("varje månd", SWEDISH))).toEqual(["varje måndag"]);
		expect(phrases(offered("varje måna", SWEDISH))).toEqual(["varje månad"]);
	});

	it("lists both every month and every Monday at every mon, and one alone with one more letter", () => {
		// Nothing is reordered: the two words come first, in the order the rules are offered.
		// `every month on the 1st` and the rest begin with `every month` too, so they follow.
		expect(phrases(offered("every mon", ENGLISH)).slice(0, 2)).toEqual(["every month", "every Monday"]);
		const month = phrases(offered("every mont", ENGLISH));
		expect(month[0]).toBe("every month");
		expect(month.every((each) => each.startsWith("every month"))).toBe(true);
		expect(phrases(offered("every mond", ENGLISH))).toEqual(["every Monday"]);
	});

	it("does not offer the when-done twin while the base phrase is partial", () => {
		expect(phrases(offered("varje da", SWEDISH))).toEqual(["varje dag"]);
		expect(phrases(offered("every da", ENGLISH))).toEqual(["every day"]);
	});

	it("offers the twin once the base phrase is typed in full", () => {
		expect(phrases(offered("varje dag", SWEDISH))).toEqual(["varje dag", "varje dag efter klart"]);
		expect(phrases(offered("every day", ENGLISH))).toEqual(["every day", "every day when done"]);
		expect(texts(offered("every day", ENGLISH))).toEqual(["every day", "every day when done"]);
	});

	it("offers the twin once the suffix word is started, and hides the base", () => {
		expect(phrases(offered("varje dag e", SWEDISH))).toEqual(["varje dag efter klart"]);
		expect(phrases(offered("varje dag efter", SWEDISH))).toEqual(["varje dag efter klart"]);
		expect(phrases(offered("every day w", ENGLISH))).toEqual(["every day when done"]);
		expect(phrases(offered("every day when", ENGLISH))).toEqual(["every day when done"]);
	});

	it("ignores case", () => {
		expect(phrases(offered("VARJE MÅN", SWEDISH))).toEqual(["varje månad", "varje måndag"]);
		expect(phrases(offered("Every MON", ENGLISH)).slice(0, 2)).toEqual(["every month", "every Monday"]);
	});

	it("treats a as matching å and ä, and o as matching ö", () => {
		expect(phrases(offered("varje man", SWEDISH))).toEqual(["varje månad", "varje måndag"]);
		expect(phrases(offered("var fjarde", SWEDISH)).slice(0, 4)).toEqual([
			"var fjärde dag",
			"var fjärde vecka",
			"var fjärde månad",
			"var fjärde år",
		]);
		expect(phrases(offered("varje lord", SWEDISH))).toEqual(["varje lördag"]);
		// The typed å and ä still match, of course.
		expect(phrases(offered("varje månad", SWEDISH))[0]).toBe("varje månad");
		expect(phrases(offered("var fjärde v", SWEDISH))[0]).toBe("var fjärde vecka");
	});

	it("keeps the blank after var, so var and varje start different phrases", () => {
		expect(phrases(offered("var ", SWEDISH))).not.toContain("varje dag");
		expect(phrases(offered("var ", SWEDISH))[0]).toBe("var tredje dag");
		expect(phrases(offered("var", SWEDISH))[0]).toBe("varje dag");
	});

	it("never offers more than seven rows, the first being the highlighted one", () => {
		const rows = offered("v", SWEDISH);

		expect(MAX_ROWS).toBe(7);
		expect(rows).toHaveLength(7);
		// No twin yet: `v` has typed no base phrase in full.
		expect(phrases(rows)).toEqual([
			"varje dag",
			"varje vecka",
			"varje månad",
			"varje år",
			"varannan dag",
			"varannan vecka",
			"varannan månad",
		]);
		// A rule and its twin arrive together, so a cap that lands between them still holds.
		expect(repeatRows("varje dag", "sv", TODAY, 1)).toHaveLength(1);
		// More than seven exist for the same fragment: the cap is what cut them.
		expect(repeatRows("v", "sv", TODAY, Infinity).length).toBeGreaterThan(7);
		expect(offered("e", ENGLISH)).toHaveLength(7);
	});
});

describe("a number typed fills the interval or the day of the month", () => {
	it("var 5 offers var 5:e dag, vecka, månad and år, each with the English text beside", () => {
		const rows = offered("var 5", SWEDISH).slice(0, 4);

		expect(phrases(rows)).toEqual(["var 5:e dag", "var 5:e vecka", "var 5:e månad", "var 5:e år"]);
		expect(texts(rows)).toEqual(["every 5 days", "every 5 weeks", "every 5 months", "every 5 years"]);
		expect(rows.map((row) => row.stamp)).toEqual(texts(rows).map(repeatStampText));
	});

	it("var 2 offers the interval-2 rows, phrased varannan and vartannat, with every 2 beside", () => {
		const rows = offered("var 2", SWEDISH).slice(0, 4);

		expect(phrases(rows)).toEqual(["varannan dag", "varannan vecka", "varannan månad", "vartannat år"]);
		expect(texts(rows)).toEqual(["every 2 days", "every 2 weeks", "every 2 months", "every 2 years"]);
		expect(rows.map((row) => row.stamp)).toEqual(texts(rows).map(repeatStampText));
	});

	it("den 20 offers den 20:e varje månad, with every month on the 20th beside", () => {
		const rows = offered("den 20", SWEDISH);

		expect(phrases(rows)).toEqual(["den 20:e varje månad"]);
		expect(texts(rows)).toEqual(["every month on the 20th"]);
	});

	it("every 5 offers every 5 days, weeks, months and years", () => {
		const rows = offered("every 5", ENGLISH).slice(0, 4);

		expect(phrases(rows)).toEqual(["every 5 days", "every 5 weeks", "every 5 months", "every 5 years"]);
		expect(texts(rows)).toEqual(phrases(rows));
	});

	it("on the 20 offers every month on the 20th", () => {
		const rows = offered("every month on the 20", ENGLISH);

		expect(phrases(rows)).toEqual(["every month on the 20th"]);
		expect(texts(rows)).toEqual(["every month on the 20th"]);
	});

	it("matches a spelled number by its digits too, and still shows the spelled phrase", () => {
		expect(phrases(offered("var 3", SWEDISH)).slice(0, 4)).toEqual([
			"var tredje dag",
			"var tredje vecka",
			"var tredje månad",
			"var tredje år",
		]);
		expect(phrases(offered("den 1", SWEDISH))).toEqual([
			"den förste varje månad",
			"den förste och 15:e varje månad",
		]);
		expect(phrases(offered("var tredje", SWEDISH)).slice(0, 2)).toEqual([
			"var tredje dag",
			"var tredje vecka",
		]);
	});

	it("writes the right Swedish ordinal ending for 2, 21, 22 and 12", () => {
		expect(phrases(offered("den 2", SWEDISH))).toEqual(["den 2:a varje månad"]);
		expect(phrases(offered("den 22", SWEDISH))).toEqual(["den 22:a varje månad"]);
		expect(phrases(offered("den 12", SWEDISH))).toEqual(["den 12:e varje månad"]);
		expect(phrases(offered("den 21", SWEDISH))).toEqual(["den 21:a varje månad"]);
	});

	it("offers two typed days of the month together", () => {
		expect(phrases(offered("den förste och 20", SWEDISH))).toEqual([
			"den förste och 20:e varje månad",
		]);
		expect(texts(offered("every month on the 1st and 20", ENGLISH))).toEqual([
			"every month on the 1st and 20th",
		]);
	});
});

describe("a weekday followed by och or and offers the pairs", () => {
	it("varje måndag och offers Monday first with each other weekday", () => {
		const rows = offered("varje måndag och", SWEDISH);

		expect(phrases(rows)).toEqual([
			"varje måndag och tisdag",
			"varje måndag och onsdag",
			"varje måndag och torsdag",
			"varje måndag och fredag",
			"varje måndag och lördag",
			"varje måndag och söndag",
		]);
		expect(texts(rows)[2]).toBe("every week on Monday, Thursday");
	});

	it("every Monday and offers the same pairs in English", () => {
		const rows = offered("every Monday and", ENGLISH);

		expect(phrases(rows)).toEqual([
			"every Monday and Tuesday",
			"every Monday and Wednesday",
			"every Monday and Thursday",
			"every Monday and Friday",
			"every Monday and Saturday",
			"every Monday and Sunday",
		]);
		expect(texts(rows)[2]).toBe("every week on Monday, Thursday");
	});

	it("offers the pair whose second weekday is earlier in the week, written Monday first", () => {
		expect(texts(offered("varje torsdag och m", SWEDISH))).toEqual(["every week on Monday, Thursday"]);
		expect(texts(offered("every Thursday and M", ENGLISH))).toEqual(["every week on Monday, Thursday"]);
	});

	it("varje söndag och and every Sunday and offer each other weekday as a pair", () => {
		const expected = [
			"every week on Monday, Sunday",
			"every week on Tuesday, Sunday",
			"every week on Wednesday, Sunday",
			"every week on Thursday, Sunday",
			"every week on Friday, Sunday",
			"every week on Saturday, Sunday",
		];

		expect(texts(offered("varje söndag och", SWEDISH))).toEqual(expected);
		expect(texts(offered("every Sunday and", ENGLISH))).toEqual(expected);
	});

	it("narrows the pairs by the second weekday typed", () => {
		expect(texts(offered("varje måndag och t", SWEDISH))).toEqual([
			"every week on Monday, Tuesday",
			"every week on Monday, Thursday",
		]);
		expect(texts(offered("every monday and th", ENGLISH))).toEqual(["every week on Monday, Thursday"]);
	});

	it("starts offering them at the first letter of och and of and", () => {
		expect(phrases(offered("varje måndag o", SWEDISH))).toContain("varje måndag och tisdag");
		expect(phrases(offered("every monday a", ENGLISH))).toContain("every Monday and Tuesday");
		// Before the joining word is started, the weekday is offered alone.
		expect(phrases(offered("varje måndag", SWEDISH))).toEqual(["varje måndag", "varje måndag efter klart"]);
	});

	it("puts a pair in the written text Monday-first, as the core reads it", () => {
		const row = offered("varje onsdag och söndag", SWEDISH)[0];

		expect(row.text).toBe("every week on Wednesday, Sunday");
		expect(readRepeatRule(row.text)?.weekdays).toEqual([2, 6]);
	});
});

describe("each row carries the first date the core gives", () => {
	it("is today for every week and for any when done rule, the next Monday for every Monday", () => {
		const first = (typed: string, text: string): string | null =>
			repeatRows(typed, "en", TODAY, Infinity).find((row) => row.text === text)?.firstDate ?? "absent";

		expect(first("every week", "every week")).toBe("2026-09-03");
		expect(first("every week", "every week when done")).toBe("2026-09-03");
		expect(first("every Monday", "every week on Monday")).toBe("2026-09-07");
		expect(first("every month on the 1st", "every month on the 1st")).toBe("2026-10-01");
		expect(first("every month on the last", "every month on the last")).toBe("2026-09-30");
	});
});

/** The editor the popup writes to: one text change at a time, with the origin it was given. */
class FakeEditor implements DateEntryEditor {
	readonly received: Array<{ tx: EditorTransaction; origin: string | undefined }> = [];

	constructor(
		readonly lines: string[],
		private cursor: EditorPosition,
	) {}

	getCursor(_which: "from" | "to"): EditorPosition {
		return this.cursor;
	}

	getLine(line: number): string {
		return this.lines[line];
	}

	lineCount(): number {
		return this.lines.length;
	}

	transaction(tx: EditorTransaction, origin?: string): void {
		this.received.push({ tx, origin });
		for (const change of tx.changes ?? []) {
			const line = this.lines[change.from.line];
			const to = change.to ?? change.from;
			this.lines[change.from.line] = line.slice(0, change.from.ch) + change.text + line.slice(to.ch);
		}
		const moved = (tx.selections ?? [])[0];
		if (moved) this.cursor = moved.from;
	}

	/** The person types `more` at the cursor. */
	type(more: string): void {
		const { line, ch } = this.cursor;
		this.lines[line] = this.lines[line].slice(0, ch) + more + this.lines[line].slice(ch);
		this.cursor = { line, ch: ch + more.length };
	}

	at(): EditorPosition {
		return this.cursor;
	}
}

type Popup = DateSuggester & EditorSuggest<unknown>;

function popupFor(settings: DateEntrySettings): Popup {
	return new DateSuggester({} as App, () => settings) as Popup;
}

/** A line with the cursor at `cursorAt`, the end of the typing — before a carriage return, if the line has one. */
function typingAt(line: string, cursorAt: number = line.replace(/\r$/, "").length): FakeEditor {
	return new FakeEditor([line], { line: 0, ch: cursorAt });
}

function keystroke(popup: Popup, editor: FakeEditor): boolean {
	return popup.trigger(editor, null as TFile | null, true);
}

/** The shown row whose phrase is `phrase`. */
function rowShown(popup: Popup, phrase: string): unknown {
	const found = (popup.shown as Array<{ rules?: readonly RepeatRow[] }>).find(
		(each) => each.rules?.[0]?.phrase === phrase,
	);
	if (found === undefined) {
		const shown = (popup.shown as Array<{ rules?: readonly RepeatRow[] }>).map((each) => each.rules?.[0]?.phrase);
		throw new Error(`no row "${phrase}" among ${JSON.stringify(shown)}`);
	}
	return found;
}

function choose(popup: Popup, phrase: string): void {
	popup.selectSuggestion(rowShown(popup, phrase), new KeyboardEvent("keydown"));
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(THURSDAY);
});

describe("accepting a rule writes the rule and, where the line has none, its first date", () => {
	const accept = (line: string, typed: string, language: "sv" | "en" = "sv"): string => {
		const trigger = line.indexOf("@");
		const result = stampRepeat(
			line,
			trigger,
			trigger + 1 + typed.length,
			(language === "sv" ? repeatRows(typed, "sv", TODAY, Infinity) : repeatRows(typed, "en", TODAY, Infinity))[0].text,
			null,
		);
		return result.line;
	};

	it("puts the rule and a first date on a task line with neither, trigger and fragment gone", () => {
		const line = "- [ ] Vattna blommorna @varje måndag";
		const row = offered("varje måndag", SWEDISH)[0];
		const result = stampRepeat(line, line.indexOf("@"), line.length, row.text, row.firstDate);

		expect(result.line).toBe("- [ ] Vattna blommorna 🔁 every week on Monday ⏳ 2026-09-07");
		expect(result.cursor).toBe(result.line.length);
	});

	it("gives today as the first date for every week", () => {
		const line = "- [ ] Vattna blommorna @varje vecka";
		const row = offered("varje vecka", SWEDISH)[0];

		expect(stampRepeat(line, line.indexOf("@"), line.length, row.text, row.firstDate).line).toBe(
			"- [ ] Vattna blommorna 🔁 every week ⏳ 2026-09-03",
		);
	});

	it("puts the rule alone on a line already carrying ⏳, and on one carrying 📅", () => {
		const row = offered("varje dag", SWEDISH)[0];
		const scheduled = "- [ ] Vattna ⏳ 2026-10-01 @varje dag";
		const due = "- [ ] Vattna 📅 2026-10-01 @varje dag";

		expect(stampRepeat(scheduled, scheduled.indexOf("@"), scheduled.length, row.text, row.firstDate).line).toBe(
			"- [ ] Vattna ⏳ 2026-10-01 🔁 every day",
		);
		expect(stampRepeat(due, due.indexOf("@"), due.length, row.text, row.firstDate).line).toBe(
			"- [ ] Vattna 📅 2026-10-01 🔁 every day",
		);
	});

	it("lands the rule after a date already there and reorders nothing", () => {
		const line = "- [ ] Vattna 📅 2026-10-01 #hem @varje dag";
		const row = offered("varje dag", SWEDISH)[0];

		expect(stampRepeat(line, line.indexOf("@"), line.length, row.text, row.firstDate).line).toBe(
			"- [ ] Vattna 📅 2026-10-01 #hem 🔁 every day",
		);
	});

	it("replaces a rule the line already carries, in place, and nothing else moves", () => {
		const line = "- [ ] Vattna 🔁 every week ⏳ 2026-10-01 #hem @varje dag";
		const row = offered("varje dag", SWEDISH)[0];

		expect(stampRepeat(line, line.indexOf("@"), line.length, row.text, row.firstDate).line).toBe(
			"- [ ] Vattna 🔁 every day ⏳ 2026-10-01 #hem",
		);
	});

	it("replaces a rule on a line with no date, and gives that line its first date", () => {
		const line = "- [ ] Vattna 🔁 every week @varje måndag";
		const row = offered("varje måndag", SWEDISH)[0];

		expect(stampRepeat(line, line.indexOf("@"), line.length, row.text, row.firstDate).line).toBe(
			"- [ ] Vattna 🔁 every week on Monday ⏳ 2026-09-07",
		);
	});

	it("goes before a trailing hidden comment, as a date does", () => {
		const line = "- [ ] Ring mamma @varje måndag %% note %%";
		const row = offered("varje måndag", SWEDISH)[0];
		const trigger = line.indexOf("@");
		const result = stampRepeat(line, trigger, trigger + "@varje måndag".length, row.text, row.firstDate);

		expect(result.line).toBe("- [ ] Ring mamma 🔁 every week on Monday ⏳ 2026-09-07 %% note %%");
	});

	it("writes the text where the trigger was on a line that is not a task, and adds no date", () => {
		const line = "Ring mamma @varje måndag";
		const row = offered("varje måndag", SWEDISH)[0];
		const result = stampRepeat(line, line.indexOf("@"), line.length, row.text, row.firstDate);

		expect(result.line).toBe("Ring mamma 🔁 every week on Monday");
		expect(result.cursor).toBe(result.line.length);
		expect(stampRepeat("a @x b", 2, 4, "every day", "2026-09-03").line).toBe("a 🔁 every day b");
	});

	it("writes no date when the core gives none", () => {
		const line = "- [ ] Vattna @varje dag";

		expect(stampRepeat(line, line.indexOf("@"), line.length, "every day", null).line).toBe(
			"- [ ] Vattna 🔁 every day",
		);
		expect(accept(line, "varje dag")).toBe("- [ ] Vattna 🔁 every day");
	});

	it("closes the gap the trigger leaves mid-description", () => {
		const line = "- [ ] Vattna @varje dag blommorna";
		const trigger = line.indexOf("@");
		const result = stampRepeat(line, trigger, trigger + "@varje dag".length, "every day", "2026-09-03");

		expect(result.line).toBe("- [ ] Vattna blommorna 🔁 every day ⏳ 2026-09-03");
	});

	it("refuses text outside the rule alphabet, so nothing odd reaches a line", () => {
		expect(() => stampRepeat("- [ ] a @x", 6, 8, "every day; rm", null)).toThrow();
		// A line that is not a task never reaches the task-line edit, which also checks the
		// text: only `stampRepeat`'s own check stands between this text and the line.
		expect(() => stampRepeat("a @x", 2, 4, "every day; rm", null)).toThrow();
	});

	it("leaves the date stamp as it was: the same line and trigger give the same date as before", () => {
		const line = "- [ ] Vattna @imorgon";

		expect(stamp(line, line.indexOf("@"), line.length, "scheduled", new Date(2026, 8, 4)).line).toBe(
			"- [ ] Vattna ⏳ 2026-09-04",
		);
	});
});

describe("accepting a row end to end: the popup, the core's text and first date, the task-line edit", () => {
	it("writes the rule and the next Monday for varje måndag, in one transaction", () => {
		const popup = popupFor(SWEDISH);
		const editor = typingAt("- [ ] Vattna blommorna @varje må");

		expect(keystroke(popup, editor)).toBe(true);
		editor.type("ndag");
		expect(keystroke(popup, editor)).toBe(true);
		choose(popup, "varje måndag");

		expect(editor.lines[0]).toBe("- [ ] Vattna blommorna 🔁 every week on Monday ⏳ 2026-09-07");
		expect(editor.received).toHaveLength(1);
		expect(editor.received[0].tx.changes).toHaveLength(1);
		expect(editor.received[0].origin).toBe("input.complete");
		expect(editor.at()).toEqual({ line: 0, ch: editor.lines[0].length });
	});

	it("writes every week and today for varje vecka", () => {
		const popup = popupFor(SWEDISH);
		const editor = typingAt("- [ ] Vattna @varje vecka");

		keystroke(popup, editor);
		choose(popup, "varje vecka");

		expect(editor.lines[0]).toBe("- [ ] Vattna 🔁 every week ⏳ 2026-09-03");
	});

	it("writes the English text through the English popup too", () => {
		const popup = popupFor(ENGLISH);
		const editor = typingAt("- [ ] Water the plants @every Monday and Th");

		keystroke(popup, editor);
		choose(popup, "every Monday and Thursday");

		// Today is a Thursday and the rule names Thursday, so the first date is today.
		expect(editor.lines[0]).toBe("- [ ] Water the plants 🔁 every week on Monday, Thursday ⏳ 2026-09-03");
	});

	it("writes the when-done twin, with today as its first date", () => {
		const popup = popupFor(ENGLISH);
		const editor = typingAt("- [ ] Clean the filter @every 3 days when done");

		keystroke(popup, editor);
		choose(popup, "every 3 days when done");

		expect(editor.lines[0]).toBe("- [ ] Clean the filter 🔁 every 3 days when done ⏳ 2026-09-03");
	});

	it("draws each row as its phrase with the greyed text it writes beside it", () => {
		const popup = popupFor(SWEDISH);
		keystroke(popup, typingAt("- [ ] Vattna @varje må"));
		const el = document.createElement("div");

		popup.renderSuggestion(rowShown(popup, "varje måndag"), el);

		expect(el.querySelector(".effortless-date-entry-phrase")?.textContent).toBe("varje måndag");
		expect(el.querySelector(".effortless-date-entry-date")?.textContent).toBe(
			repeatStampText("every week on Monday"),
		);
	});

	it("shows one row per rule, and the date popup keeps its one row", () => {
		const popup = popupFor(SWEDISH);

		keystroke(popup, typingAt("- [ ] Vattna @varje må"));
		expect(popup.shown).toHaveLength(2);

		keystroke(popup, typingAt("- [ ] Vattna @imorgon"));
		expect(popup.shown).toHaveLength(1);
	});

	it("writes the row chosen when a raced character narrowed the rows but kept it", () => {
		const popup = popupFor(SWEDISH);
		const editor = typingAt("- [ ] Vattna @varje må");
		keystroke(popup, editor);
		const shown = rowShown(popup, "varje måndag");

		// A character typed after the popup last looked and before Enter landed.
		editor.type("n");
		popup.selectSuggestion(shown, new KeyboardEvent("keydown"));

		expect(editor.lines[0]).toBe("- [ ] Vattna 🔁 every week on Monday ⏳ 2026-09-07");
	});

	it("writes nothing when a raced character took the chosen row out of the rows", () => {
		const popup = popupFor(SWEDISH);
		const editor = typingAt("- [ ] Vattna @varje må");
		keystroke(popup, editor);
		const shown = rowShown(popup, "varje månad");

		editor.type("nd");
		popup.selectSuggestion(shown, new KeyboardEvent("keydown"));

		expect(editor.lines[0]).toBe("- [ ] Vattna @varje månd");
		expect(editor.received).toHaveLength(0);
	});
});

describe("one undo puts the line back, on Windows line endings with and without a final break", () => {
	/**
	 * Applies the inverse of the one change a transaction made, as one undo does: what the
	 * change wrote is replaced by the `expected` text it replaced. `expected` is a literal,
	 * never rebuilt from the line that was typed, so a change that spanned the wrong range
	 * restores the wrong bytes and fails.
	 */
	function undo(lines: string[], tx: EditorTransaction, expected: string): void {
		const [change] = tx.changes ?? [];
		const to = change.to ?? change.from;
		const now = lines[change.from.line];
		lines[change.from.line] =
			now.slice(0, change.from.ch) + expected.slice(change.from.ch, to.ch) + now.slice(change.from.ch + change.text.length);
	}

	it.each([
		[
			"a line ending in a carriage return",
			"- [ ] Vattna @varje dag\r",
			"- [ ] Vattna 🔁 every day ⏳ 2026-09-03\r",
			"- [ ] Vattna @varje dag\r",
		],
		[
			"the last line, with no final break",
			"- [ ] Vattna @varje dag",
			"- [ ] Vattna 🔁 every day ⏳ 2026-09-03",
			"- [ ] Vattna @varje dag",
		],
	])("restores %s byte for byte", (_name, line, written, restored) => {
		const popup = popupFor(SWEDISH);
		const editor = typingAt(line);

		keystroke(popup, editor);
		choose(popup, "varje dag");

		// The carriage return stays the last byte and no blank is left before it.
		expect(editor.lines[0]).toBe(written);
		expect(editor.received).toHaveLength(1);
		const [change] = editor.received[0].tx.changes ?? [];
		expect(change.from).toEqual({ line: 0, ch: 0 });
		expect(change.to).toEqual({ line: 0, ch: line.length });

		undo(editor.lines, editor.received[0].tx, restored);
		expect(editor.lines[0]).toBe(restored);
	});

	it("leaves no blank before the carriage return on the date path either, exact bytes", () => {
		const line = "- [ ] Vattna @imorgon\r";

		expect(stamp(line, line.indexOf("@"), line.indexOf("\r"), "scheduled", new Date(2026, 8, 4)).line).toBe(
			"- [ ] Vattna ⏳ 2026-09-04\r",
		);
	});

	it("puts the rule where the date path puts a date on the same line", () => {
		const line = "- [ ] Vattna @imorgon\r";
		const dateWritten = stamp(line, line.indexOf("@"), line.indexOf("\r"), "scheduled", new Date(2026, 8, 4)).line;
		const ruleWritten = stampRepeat(line, line.indexOf("@"), line.indexOf("\r"), "every day", null).line;

		expect(dateWritten.replace("⏳ 2026-09-04", "")).toBe(ruleWritten.replace("🔁 every day", ""));
	});
});
