/**
 * Review's words table (ticket #1182,
 * taking over #1186's switch).
 *
 * The table is asked through one function, `reviewWords()`, which reads
 * Obsidian's `getLanguage` at every call. These cases read the words straight off
 * it, and hold the folder to one switch: no other file of `src/features/review/`
 * asks the language. Each case opens with a line beginning `If wrong:`.
 */

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { moment, registerLocale, resetLanguage, setLanguage } from "./__mocks__/obsidian";
import { monthName, reviewWords, weekdayNames } from "../features/review/words";
import { shippedSources, withoutComments } from "./sourceGuards";

beforeEach(() => {
	resetLanguage();
});

afterEach(() => {
	resetLanguage();
});

describe("the words table", () => {
	it("holds the Swedish words the ticket gave, under sv", () => {
		// If wrong: a word mistyped or left English differs from its literal here.
		setLanguage("sv");
		const words = reviewWords();
		expect({
			title: words.title,
			nothingWaiting: words.nothingWaiting,
			today: words.today,
			markProcessed: words.markProcessed,
			earlierMonth: words.earlierMonth,
			laterMonth: words.laterMonth,
			diary: [words.markLabel("diary", "kept"), words.markLabel("diary", "missed"), words.markLabel("diary", "none")],
			review: [words.markLabel("review", "kept"), words.markLabel("review", "missed"), words.markLabel("review", "none")],
			status: words.statusText(3),
			statusLabel: words.statusLabel,
		}).toEqual({
			title: "Granskning",
			nothingWaiting: "Inget väntar",
			today: "Idag",
			markProcessed: "Markera som behandlad",
			earlierMonth: "Föregående månad",
			laterMonth: "Nästa månad",
			diary: ["Dagbok förd", "Dagbok missad", "Dagbok: inget märke"],
			review: ["Granskning gjord", "Granskning missad", "Granskning: inget märke"],
			status: "Granskning: 3 väntar",
			statusLabel: "Anteckningar från de senaste dagarna som du inte har gått igenom",
		});
	});

	it("holds the English words, today's, for every language but sv", () => {
		// If wrong: a table whose English had drifted from what shipped reads differently here.
		for (const code of ["en", "de", "sv-SE", "SV", ""]) {
			setLanguage(code);
			const words = reviewWords();
			expect([code, words.title, words.nothingWaiting, words.today, words.markProcessed, words.statusText(3)]).toEqual([
				code, "Review", "Nothing waiting", "Today", "Mark as processed", "Review: 3 waiting",
			]);
		}
	});

	it("says one task and one bullet in the singular and the rest in the plural, in both languages", () => {
		// If wrong: a plural rule that treated 0 or 1 like many reads "1 open tasks" or "1 öppna uppgifter".
		expect([reviewWords().tasks(0), reviewWords().tasks(1), reviewWords().bullets(1), reviewWords().bullets(2)]).toEqual([
			"0 open tasks", "1 open task", "1 plain bullet", "2 plain bullets",
		]);
		setLanguage("sv");
		expect([reviewWords().tasks(0), reviewWords().tasks(1), reviewWords().bullets(1), reviewWords().bullets(2)]).toEqual([
			"0 öppna uppgifter", "1 öppen uppgift", "1 vanlig punkt", "2 vanliga punkter",
		]);
	});

	it("is read at each call: one language, then the other, then the first again", () => {
		// If wrong: a table kept from the first call answers the same word three times.
		const seen: string[] = [];
		for (const code of ["sv", "en", "sv"]) {
			setLanguage(code);
			seen.push(reviewWords().today);
		}
		expect(seen).toEqual(["Idag", "Today", "Idag"]);
	});
});

describe("the date names", () => {
	it("come from moment's active locale, Monday first, and read again when the locale changes", () => {
		// If wrong: a hand table reads "Mon" and "March 2026" under a locale whose names are these.
		registerLocale("sv", {
			months: ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"],
			monthsShort: [],
			weekdays: [],
			weekdaysShort: ["sön", "mån", "tis", "ons", "tors", "fre", "lör"],
		});
		expect([weekdayNames()[0], weekdayNames()[6], monthName(2026, 3)]).toEqual(["Mon", "Sun", "March 2026"]);

		moment.locale("sv");

		expect([weekdayNames(), monthName(2026, 10)]).toEqual([["mån", "tis", "ons", "tors", "fre", "lör", "sön"], "oktober 2026"]);
	});
});

describe("the one switch", () => {
	it("is words.ts: no other file of Review's folder asks Obsidian for the language, but the followed tasks' sort", () => {
		// If wrong: a second switch in listView.ts or review.ts would list its file here. `followedTasks.ts` asks it for the collator that orders people, which is no word on the screen.
		const asking = shippedSources()
			.filter(({ path }) => /features[\\/]review[\\/]/.test(path))
			.filter(({ path, source }) => !/(words|followedTasks)\.ts$/.test(path) && /\bgetLanguage\b/.test(withoutComments(source)))
			.map(({ path }) => path);
		expect(asking).toEqual([]);
	});

	it("is found in words.ts itself, so the case above is not an empty search", () => {
		// If wrong: a words.ts that no longer asked getLanguage would make the case above pass on nothing.
		const own = shippedSources().find(({ path }) => /features[\\/]review[\\/]words\.ts$/.test(path));
		expect(own).toBeDefined();
		expect(withoutComments(own!.source)).toMatch(/\bgetLanguage\(\)/);
		expect(readFileSync(own!.path, "utf8")).toContain("getLanguage");
	});
});
