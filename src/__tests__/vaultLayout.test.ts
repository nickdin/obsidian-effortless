import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { repoRoot } from "./repoRoot";
// By path rather than as "obsidian", the way settings.test.ts does: `tsc`
// checks this file against the real Obsidian API, which the real one has no
// `registerLocale`, `resetLanguage` or `setLanguage` on — those are this
// stub's own doors for a suite to drive a language and a locale's names.
import { moment, registerLocale, resetLanguage, setLanguage } from "./__mocks__/obsidian";
import { parseCalendarTable } from "../core/calendarTable";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import {
	calendarTableBlock,
	dailyLogFrame,
	dailyLogDateNames,
	dailyLogPath,
	dailyLogPathPattern,
	dailyLogPattern,
	daySections,
	insertionLineForMissingSection,
	isDailyLogPath,
	parseDailyLogDate,
	sectionRange,
	unreadableFilenamePattern,
} from "../core/vaultLayout";
import type { SectionName } from "../core/vaultLayout";

/**
 * `true` only when `A` and `B` are the same type, checked both ways round. A
 * value annotated with it fails to compile the moment the two drift apart, so
 * `npm run lint` is what enforces the assertion below.
 */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
	? true
	: false;

/** The shipped layout with the two blank answers filled in, plus any overrides. */
function layout(overrides: Partial<VaultLayout> = {}): VaultLayout {
	return {
		...defaultData().core.layout,
		dailyLogFolder: "Journal",
		dailyLogFilename: "YYYY-MM-DD",
		...overrides,
	};
}

/** A local date, since a day's log is named after the local day. */
const day = (y: number, m: number, d: number): Date => new Date(y, m - 1, d);

describe("dailyLogPath", () => {
	it("joins the folder, the formatted date and the .md extension", () => {
		expect(dailyLogPath(day(2026, 9, 6), layout())).toBe("Journal/2026-09-06.md");
	});

	it("lets the pattern carry folders of its own", () => {
		const path = dailyLogPath(day(2026, 9, 6), layout({ dailyLogFilename: "YYYY/MM/YYYY-MM-DD" }));
		expect(path).toBe("Journal/2026/09/2026-09-06.md");
	});

	it("writes text inside square brackets literally", () => {
		const path = dailyLogPath(day(2026, 1, 2), layout({ dailyLogFilename: "[Day] YYYY-MM-DD" }));
		expect(path).toBe("Journal/Day 2026-01-02.md");
	});

	it("writes month and weekday names, and the short forms", () => {
		const long = dailyLogPath(day(2026, 9, 6), layout({ dailyLogFilename: "dddd D MMMM YYYY" }));
		expect(long).toBe("Journal/Sunday 6 September 2026.md");

		const short = dailyLogPath(day(2026, 9, 6), layout({ dailyLogFilename: "ddd MMM D" }));
		expect(short).toBe("Journal/Sun Sep 6.md");
	});

	it("writes a two-digit year and unpadded numbers", () => {
		expect(dailyLogPath(day(2026, 9, 6), layout({ dailyLogFilename: "YY.M.D" }))).toBe(
			"Journal/26.9.6.md",
		);
	});

	it("does not add a second extension when the pattern already ends in .md", () => {
		expect(dailyLogPath(day(2026, 9, 6), layout({ dailyLogFilename: "YYYY-MM-DD.md" }))).toBe(
			"Journal/2026-09-06.md",
		);
	});

	it("tidies a folder typed with backslashes or a trailing slash", () => {
		expect(dailyLogPath(day(2026, 9, 6), layout({ dailyLogFolder: "Journal\\Days/" }))).toBe(
			"Journal/Days/2026-09-06.md",
		);
	});

	it("says so rather than guessing when the vault has not been described yet", () => {
		expect(() => dailyLogPath(day(2026, 9, 6), layout({ dailyLogFolder: "  " }))).toThrow(
			/folder/i,
		);
		expect(() => dailyLogPath(day(2026, 9, 6), layout({ dailyLogFilename: "" }))).toThrow(
			/filename/i,
		);
	});

	it("refuses a date pattern it does not understand rather than writing it out raw", () => {
		expect(() => dailyLogPath(day(2026, 9, 6), layout({ dailyLogFilename: "YYYY-MM-Do" }))).toThrow(
			/Do/,
		);
		expect(() => dailyLogPath(day(2026, 9, 6), layout({ dailyLogFilename: "[open" }))).toThrow(
			/\[/,
		);
	});
});

describe("following the app's language", () => {
	/** A fabricated locale, not moment's real Swedish, so this file owns exactly what it means. */
	const OTHER_LOCALE = {
		months: [
			"Enari", "Tvåari", "Treari", "Fyrari", "Femari", "Sexari",
			"Sjuari", "Åttari", "Nioari", "Tioari", "Elvari", "Tolvari",
		],
		monthsShort: ["Ena", "Två", "Tre", "Fyr", "Fem", "Sex", "Sju", "Ått", "Nio", "Tio", "Elv", "Tol"],
		weekdays: ["Söndär", "Måndär", "Tisdär", "Onsdär", "Torsdär", "Fredär", "Lördär"],
		weekdaysShort: ["Sön", "Mån", "Tis", "Ons", "Tor", "Fre", "Lör"],
	};

	it("writes a month name in the app's own current language", () => {
		resetLanguage();
		registerLocale("xx", OTHER_LOCALE);
		setLanguage("xx");
		try {
			const path = dailyLogPath(day(2026, 9, 6), layout({ dailyLogFilename: "D MMMM YYYY" }));
			expect(path).toBe("Journal/6 Nioari 2026.md");
		} finally {
			resetLanguage();
		}
	});

	it("reads a name written under the app's own current language back", () => {
		resetLanguage();
		registerLocale("xx", OTHER_LOCALE);
		setLanguage("xx");
		try {
			const settings = layout({ dailyLogFilename: "D MMMM YYYY" });
			const path = dailyLogPath(day(2026, 9, 6), settings);
			expect(parseDailyLogDate(path, settings)).toEqual(day(2026, 9, 6));
		} finally {
			resetLanguage();
		}
	});

	it("still recognises a name written under the language active immediately before the app's own last changed", () => {
		resetLanguage();
		registerLocale("xx", OTHER_LOCALE);
		// The literal name the write test above pins, so this test does not
		// depend on dailyLogPath to write it under "xx".
		const written = "Journal/6 Nioari 2026.md";
		try {
			// The app's language has since moved to English, and moment's own
			// active locale has moved with it — the stored history records
			// "xx" as the language active right before that.
			setLanguage("en");
			moment.locale("en");
			const settings = layout({ dailyLogFilename: "D MMMM YYYY" });
			const afterChange = { ...settings, languageHistory: { current: "en", previous: "xx" } };
			expect(parseDailyLogDate(written, afterChange)).toEqual(day(2026, 9, 6));
		} finally {
			resetLanguage();
		}
	});

	it("does not fall back to a language that is not the one actually recorded as previous", () => {
		resetLanguage();
		registerLocale("xx", OTHER_LOCALE);
		setLanguage("xx");
		const settings = layout({ dailyLogFilename: "D MMMM YYYY" });
		const written = dailyLogPath(day(2026, 9, 6), settings);
		try {
			// "xx" is not the history's own `previous` here — a different,
			// unrelated language change is what the history actually records —
			// so a name written under "xx" is not recognised.
			setLanguage("en");
			const afterChange = { ...settings, languageHistory: { current: "en", previous: "sv" } };
			expect(parseDailyLogDate(written, afterChange)).toBeNull();
		} finally {
			resetLanguage();
		}
	});

	it("falls back to English when the app's own reported language is not one moment holds", () => {
		resetLanguage();
		setLanguage("nowhere");
		try {
			const path = dailyLogPath(day(2026, 9, 6), layout({ dailyLogFilename: "D MMMM YYYY" }));
			expect(path).toBe("Journal/6 September 2026.md");
		} finally {
			resetLanguage();
		}
	});

	it("round-trips a full sweep under a non-English language — unreadableFilenamePattern stays null", () => {
		resetLanguage();
		registerLocale("xx", OTHER_LOCALE);
		setLanguage("xx");
		try {
			expect(unreadableFilenamePattern(layout({ dailyLogFilename: "YYYY MMMM DD" }))).toBeNull();
		} finally {
			resetLanguage();
		}
	});

	it("does not change moment's own active locale once it is done building the previous language's names", () => {
		resetLanguage();
		registerLocale("xx", OTHER_LOCALE);
		setLanguage("en");
		try {
			const settings = {
				...layout({ dailyLogFilename: "D MMMM YYYY" }),
				languageHistory: { current: "en", previous: "xx" },
			};
			// A name the current table ("en") does not recognise but the
			// previous one ("xx") does makes the previous language's names
			// load — which once switched moment's global locale and restored
			// it, and since #1175 reads moment's own table for "xx" without a
			// switch. Asserted right here, with no other layout call in between
			// to put the locale back on its own by asking for the current
			// language again, which is what let a missing restore go unnoticed.
			parseDailyLogDate("Journal/6 Nioari 2026.md", settings);
			expect(moment.locale()).toBe("en");
		} finally {
			resetLanguage();
		}
	});

	it("reads both languages' names without ever switching moment's own global locale", () => {
		resetLanguage();
		registerLocale("xx", OTHER_LOCALE);
		setLanguage("en");
		const spy = vi.spyOn(moment, "locale");
		try {
			const settings = {
				...layout({ dailyLogFilename: "D MMMM YYYY" }),
				languageHistory: { current: "en", previous: "xx" },
			};
			// Every exported route into the day's-log names, each asking for
			// the previous language's table as well as the current one's —
			// `unreadableFilenamePattern` is the route into the private
			// `everySweptDayReadsBack`. Before #1175 each one switched moment's
			// global locale to "xx" and back.
			expect(dailyLogPath(day(2026, 9, 6), settings)).toBe("Journal/6 September 2026.md");
			expect(parseDailyLogDate("Journal/6 Nioari 2026.md", settings)).toEqual(day(2026, 9, 6));
			expect(dailyLogPattern(settings).read("Journal/6 Nioari 2026.md")).toEqual(day(2026, 9, 6));
			expect(unreadableFilenamePattern(settings)).toBeNull();
			expect(dailyLogDateNames(settings).previous?.months[8]).toBe("Nioari");
			const switches = spy.mock.calls.filter((args) => args.length > 0 && args[0] !== undefined);
			expect(switches).toEqual([]);
		} finally {
			spy.mockRestore();
			resetLanguage();
		}
	});

	it("answers each call from the language, its history and moment's names as they stand at that call, keeping nothing", () => {
		resetLanguage();
		registerLocale("xx", OTHER_LOCALE);
		registerLocale("yy", { ...OTHER_LOCALE, months: OTHER_LOCALE.months.map((name) => `Y${name}`) });
		const settings = layout({ dailyLogFilename: "D MMMM YYYY" });
		try {
			setLanguage("xx");
			expect(dailyLogPath(day(2026, 9, 6), settings)).toBe("Journal/6 Nioari 2026.md");
			// The app's language changes while it runs.
			setLanguage("yy");
			expect(dailyLogPath(day(2026, 9, 6), settings)).toBe("Journal/6 YNioari 2026.md");
			// The same code now holds different names: a table kept from the
			// first call above would still answer "Nioari".
			setLanguage("xx");
			registerLocale("xx", { ...OTHER_LOCALE, months: OTHER_LOCALE.months.map((name) => `Z${name}`) });
			expect(dailyLogPath(day(2026, 9, 6), settings)).toBe("Journal/6 ZNioari 2026.md");
			// The recorded previous language is read afresh as well.
			const afterYy = { ...settings, languageHistory: { current: "xx", previous: "yy" } };
			expect(parseDailyLogDate("Journal/6 YNioari 2026.md", afterYy)).toEqual(day(2026, 9, 6));
			const afterEn = { ...settings, languageHistory: { current: "xx", previous: "en" } };
			expect(parseDailyLogDate("Journal/6 YNioari 2026.md", afterEn)).toBeNull();
			expect(parseDailyLogDate("Journal/6 September 2026.md", afterEn)).toEqual(day(2026, 9, 6));
		} finally {
			resetLanguage();
		}
	});

	it("reads the language moment is already active on, and a region of it, as that language's own names", () => {
		resetLanguage();
		registerLocale("xx", OTHER_LOCALE);
		// The ordinary case in the app: Obsidian keeps moment active on its
		// own language — read back on a Swedish Obsidian as
		// `window.moment.locale() = "sv"` in
		// `docs/acceptance-shots/issue-645-swedish-drive.txt` — so
		// `moment.localeData("xx")` is the very object `moment.localeData()`
		// is, the shape an unrecognised code also has.
		moment.locale("xx");
		const settings = layout({ dailyLogFilename: "D MMMM YYYY" });
		try {
			setLanguage("xx");
			expect(dailyLogPath(day(2026, 9, 6), settings)).toBe("Journal/6 Nioari 2026.md");
			setLanguage("xx-YY");
			expect(dailyLogPath(day(2026, 9, 6), settings)).toBe("Journal/6 Nioari 2026.md");
		} finally {
			resetLanguage();
		}
	});

	it("gives English for a current language moment does not hold, and drops such a previous one, even while moment is active on another language", () => {
		resetLanguage();
		registerLocale("xx", OTHER_LOCALE);
		// Moment active on "xx": an unrecognised code resolves to this
		// active locale's own table, which must not be taken as the answer.
		moment.locale("xx");
		const settings = layout({ dailyLogFilename: "D MMMM YYYY" });
		try {
			setLanguage("nowhere");
			expect(dailyLogPath(day(2026, 9, 6), settings)).toBe("Journal/6 September 2026.md");
			setLanguage("en");
			const afterNowhere = { ...settings, languageHistory: { current: "en", previous: "nowhere" } };
			expect(dailyLogDateNames(afterNowhere).previous).toBeUndefined();
			expect(parseDailyLogDate("Journal/6 Nioari 2026.md", afterNowhere)).toBeNull();
			expect(parseDailyLogDate("Journal/6 September 2026.md", afterNowhere)).toEqual(day(2026, 9, 6));
		} finally {
			resetLanguage();
		}
	});

	it("resolves a mixed-case Obsidian language code the way real moment normalises it before looking it up", () => {
		resetLanguage();
		// Registered lower-cased, the way a real moment locale file names
		// itself (`node_modules/moment/locale/pt-br.js:14`,
		// `moment.defineLocale('pt-br', …)`) — Obsidian's own language code for
		// the same language is mixed-case, `pt-BR`.
		registerLocale("pt-br", OTHER_LOCALE);
		setLanguage("pt-BR");
		try {
			const path = dailyLogPath(day(2026, 9, 6), layout({ dailyLogFilename: "MMMM" }));
			expect(path).toBe("Journal/Nioari.md");
		} finally {
			resetLanguage();
		}
	});

	it("falls back one step from a mixed-case region code to the language it has no region file for", () => {
		resetLanguage();
		// Real moment resolves `de-XX` to `de` the same way when it has no
		// `de-xx` locale file of its own (`chooseLocale`,
		// `node_modules/moment/moment.js:2051-2081`); the mock's own
		// `resolveLocale` copies that one-step fallback.
		registerLocale("de", OTHER_LOCALE);
		setLanguage("de-XX");
		try {
			const path = dailyLogPath(day(2026, 9, 6), layout({ dailyLogFilename: "MMMM" }));
			expect(path).toBe("Journal/Nioari.md");
		} finally {
			resetLanguage();
		}
	});
});

describe("a name field carrying a dot, a digit, or a combining mark, in moment's own real locale data", () => {
	it("round-trips French short month names, which carry a trailing dot", () => {
		resetLanguage();
		// node_modules/moment/locale/fr.js:36-51
		registerLocale("fr", {
			months:
				"janvier_février_mars_avril_mai_juin_juillet_août_septembre_octobre_novembre_décembre".split(
					"_",
				),
			monthsShort: "janv._févr._mars_avr._mai_juin_juil._août_sept._oct._nov._déc.".split("_"),
			weekdays: "dimanche_lundi_mardi_mercredi_jeudi_vendredi_samedi".split("_"),
			weekdaysShort: "dim._lun._mar._mer._jeu._ven._sam.".split("_"),
		});
		setLanguage("fr");
		try {
			const settings = layout({ dailyLogFilename: "YYYY MMM D" });
			expect(unreadableFilenamePattern(settings)).toBeNull();
			const path = dailyLogPath(day(2026, 1, 6), settings);
			expect(path).toBe("Journal/2026 janv. 6.md");
			expect(parseDailyLogDate(path, settings)).toEqual(day(2026, 1, 6));
		} finally {
			resetLanguage();
		}
	});

	it("round-trips a Japanese short month name that fuses a digit to a character", () => {
		resetLanguage();
		// node_modules/moment/locale/ja.js:76-81
		registerLocale("ja", {
			months: "1月_2月_3月_4月_5月_6月_7月_8月_9月_10月_11月_12月".split("_"),
			monthsShort: "1月_2月_3月_4月_5月_6月_7月_8月_9月_10月_11月_12月".split("_"),
			weekdays: "日曜日_月曜日_火曜日_水曜日_木曜日_金曜日_土曜日".split("_"),
			weekdaysShort: "日_月_火_水_木_金_土".split("_"),
		});
		setLanguage("ja");
		try {
			const settings = layout({ dailyLogFilename: "YYYY MMM DD" });
			expect(unreadableFilenamePattern(settings)).toBeNull();
			const path = dailyLogPath(day(2026, 9, 6), settings);
			expect(path).toBe("Journal/2026 9月 06.md");
			expect(parseDailyLogDate(path, settings)).toEqual(day(2026, 9, 6));
		} finally {
			resetLanguage();
		}
	});

	it("round-trips a Hindi weekday name carrying combining vowel signs", () => {
		resetLanguage();
		// node_modules/moment/locale/hi.js:68-79 (the "standalone" months, for
		// this fixture's own months field; the ticket is about the weekday
		// names, which carry no such split).
		registerLocale("hi", {
			months: "जनवरी_फरवरी_मार्च_अप्रैल_मई_जून_जुलाई_अगस्त_सितंबर_अक्टूबर_नवंबर_दिसंबर".split("_"),
			monthsShort: "जन._फ़र._मार्च_अप्रै._मई_जून_जुल._अग._सित._अक्टू._नव._दिस.".split("_"),
			weekdays: "रविवार_सोमवार_मंगलवार_बुधवार_गुरूवार_शुक्रवार_शनिवार".split("_"),
			weekdaysShort: "रवि_सोम_मंगल_बुध_गुरू_शुक्र_शनि".split("_"),
		});
		setLanguage("hi");
		try {
			const settings = layout({ dailyLogFilename: "dddd D MMMM YYYY" });
			expect(unreadableFilenamePattern(settings)).toBeNull();
			// 6 September 2026 is a Sunday.
			const path = dailyLogPath(day(2026, 9, 6), settings);
			expect(parseDailyLogDate(path, settings)).toEqual(day(2026, 9, 6));
		} finally {
			resetLanguage();
		}
	});
});

describe("dailyLogPathPattern", () => {
	// The settings screen's closed row. Its whole job is to end in the same
	// characters as the path the writer produces: a row that disagrees tells the
	// person their answer did not take, which is the defect #139 exists to
	// remove and #274 closed only the folder half of. These tests live beside
	// the writer's rather than only in the settings-screen suite, because the
	// contract is between these two functions.
	it.each([
		["Journal", "/YYYY-MM-DD", "Journal/YYYY-MM-DD.md", "Journal/2026-01-02.md"],
		["Journal", "YYYY//MM-DD", "Journal/YYYY/MM-DD.md", "Journal/2026/01-02.md"],
		["Journal", "YYYY\\MM\\DD", "Journal/YYYY/MM/DD.md", "Journal/2026/01/02.md"],
	])(
		"says for %s + %s exactly what the writer writes",
		(dailyLogFolder, dailyLogFilename, row, written) => {
			const settings = layout({ dailyLogFolder, dailyLogFilename });
			expect(dailyLogPathPattern(settings)).toBe(row);
			expect(dailyLogPath(day(2026, 1, 2), settings)).toBe(written);
			// The row and the writer, side by side: the same string with the date
			// left standing. That is what this helper's doc comment claims, and
			// before #329 it was only true while the pattern held no separator the
			// normaliser would have tidied.
			expect(written.replace("2026", "YYYY").replace("01", "MM").replace("02", "DD")).toBe(row);
		},
	);

	it("puts nothing in front of a day's log kept at the vault root", () => {
		// `normalizePath` answers `/` for a path that reduces to nothing, which is
		// the trap issue #89 fell into. Nothing can reduce to nothing here: `.md`
		// is always on the end.
		expect(dailyLogPathPattern(layout({ dailyLogFolder: "/" }))).toBe("YYYY-MM-DD.md");
	});

	it("reads a folder typed with a trailing slash as one slash", () => {
		expect(dailyLogPathPattern(layout({ dailyLogFolder: "Journal/" }))).toBe(
			"Journal/YYYY-MM-DD.md",
		);
	});

	it("is one row for a pattern typed with .md and one typed without", () => {
		expect(dailyLogPathPattern(layout({ dailyLogFilename: "YYYY-MM-DD.md" }))).toBe(
			"Journal/YYYY-MM-DD.md",
		);
	});

	it("answers rather than throwing for a half-answered layout", () => {
		// The deliberate asymmetry with `dailyLogPath`, which throws for both of
		// these: a summary of an unanswered layout is a sentence, not a failure.
		expect(dailyLogPathPattern(layout({ dailyLogFolder: "  " }))).toBeNull();
		expect(dailyLogPathPattern(layout({ dailyLogFilename: "  " }))).toBeNull();
	});
});

describe("parseDailyLogDate", () => {
	it("reads back every date it wrote", () => {
		for (const pattern of ["YYYY-MM-DD", "YYYY/MM/YYYY-MM-DD", "[Day] D MMMM YYYY", "YY.M.D"]) {
			const settings = layout({ dailyLogFilename: pattern });
			for (const date of [day(2026, 1, 1), day(2026, 9, 6), day(2026, 12, 31)]) {
				const path = dailyLogPath(date, settings);
				const read = parseDailyLogDate(path, settings);
				expect(read && dailyLogPath(read, settings)).toBe(path);
			}
		}
	});

	it("is not fooled by a note somewhere else in the vault", () => {
		expect(parseDailyLogDate("Notes/2026-09-06.md", layout())).toBeNull();
		expect(parseDailyLogDate("Journal/Archive/2026-09-06.md", layout())).toBeNull();
	});

	it("refuses a name that does not fit the pattern exactly", () => {
		expect(parseDailyLogDate("Journal/Shopping.md", layout())).toBeNull();
		expect(parseDailyLogDate("Journal/2026-9-06.md", layout())).toBeNull();
		expect(parseDailyLogDate("Journal/2026-09-06 notes.md", layout())).toBeNull();
	});

	it("refuses a name only the pattern's own spelling would have written", () => {
		const named = layout({ dailyLogFilename: "dddd D MMMM YYYY" });
		expect(parseDailyLogDate("Journal/Sunday 6 September 2026.md", named)).not.toBeNull();
		// The 6th was a Sunday, so this is a note somebody named by hand.
		expect(parseDailyLogDate("Journal/Monday 6 September 2026.md", named)).toBeNull();
		// Vault paths are case-sensitive, so this is a different file.
		expect(parseDailyLogDate("Journal/Sunday 6 september 2026.md", named)).toBeNull();
	});

	it("refuses a name that fits the pattern but is not a real day", () => {
		expect(parseDailyLogDate("Journal/2026-02-31.md", layout())).toBeNull();
		expect(parseDailyLogDate("Journal/2026-13-01.md", layout())).toBeNull();
	});

	it("answers whether a path is a day's log", () => {
		expect(isDailyLogPath("Journal/2026-09-06.md", layout())).toBe(true);
		expect(isDailyLogPath("Journal/2026-09-06.md", layout({ dailyLogFolder: "" }))).toBe(false);
		expect(isDailyLogPath("Projects/Roof.md", layout())).toBe(false);
	});

	it("answers no while the filename pattern is still blank", () => {
		// Both settings ship blank and the folder row sits above the filename
		// row, so a folder answered and a pattern not yet answered is the
		// ordinary state of a fresh install rather than an edge.
		const half = layout({ dailyLogFilename: "" });
		expect(isDailyLogPath("Journal/2026-09-06.md", half)).toBe(false);
		expect(parseDailyLogDate("Journal/2026-09-06.md", half)).toBeNull();
	});

	// The same reasoning one keystroke further on. The settings screen saves on
	// every keystroke, so on the way to `YYYY-MM-DD` the stored pattern passes
	// through `Y`, `YY`, `YYY`, `YYYY-`, … and the ones that are not whole
	// fields are patterns the tokeniser refuses. A vault-event handler asking
	// during those seconds must get an answer, not an exception.
	it("answers no while the filename pattern is half-typed, rather than throwing", () => {
		for (const pattern of ["Y", "YY", "YYY", "YYYY-", "YYYY-M"]) {
			const typing = layout({ dailyLogFilename: pattern });
			expect(() => isDailyLogPath("Journal/2026-09-06.md", typing)).not.toThrow();
			expect(isDailyLogPath("Journal/2026-09-06.md", typing)).toBe(false);
			expect(parseDailyLogDate("Journal/2026-09-06.md", typing)).toBeNull();
		}
	});

	it("answers no for a pattern whose [ has no ] yet", () => {
		const typing = layout({ dailyLogFilename: "[Day YYYY-MM-DD" });
		expect(() => isDailyLogPath("Journal/2026-09-06.md", typing)).not.toThrow();
		expect(isDailyLogPath("Journal/2026-09-06.md", typing)).toBe(false);
		expect(parseDailyLogDate("Journal/2026-09-06.md", typing)).toBeNull();
	});

	// The asymmetry is the point of the ticket, so it is asserted rather than
	// left to the builder's own tests: reading a guessed path costs nothing and
	// writing one creates a second file beside the day the person is in.
	it("leaves the path builder throwing for the same patterns, with its own message", () => {
		expect(() => dailyLogPath(day(2026, 9, 6), layout({ dailyLogFilename: "YYY" }))).toThrow(
			/does not understand "YYY"/,
		);
		expect(() =>
			dailyLogPath(day(2026, 9, 6), layout({ dailyLogFilename: "[Day YYYY-MM-DD" })),
		).toThrow(/Unclosed "\["/);
	});
});

// The settings screen's unreadable-pattern line asks here, and it asked
// the tokeniser: whether `tokenise` accepted the string, which is a weaker
// question than the one the recogniser above answers. Every pattern that
// tokenises and still loses the round trip passed it, and the plugin then wrote
// every day's log at a path it would never recognise again, in the silence #194
// exists to remove.
describe("unreadableFilenamePattern", () => {
	/** The question the Filename row's line asks, with the folder answered. */
	const complainsAbout = (dailyLogFilename: string): string | null =>
		unreadableFilenamePattern(layout({ dailyLogFilename }));

	it("reports a pattern with no year field, which writes a day nothing reads back", () => {
		// `MM-DD` tokenises perfectly and writes `Journal/11-23.md`. `readName`
		// gives up on that name — there is no year in it to build a date from —
		// so the file the plugin has just written is not a day's log to it.
		expect(complainsAbout("MM-DD")).toBe("MM-DD");
	});

	it("reports a filename of .md alone, which leaves no pattern at all", () => {
		// The same hole from the other side: `namePattern` strips the suffix and
		// the empty pattern left behind is one the tokeniser is happy with.
		expect(complainsAbout(".md")).toBe(".md");
	});

	it("still reports a pattern the tokeniser refuses", () => {
		expect(complainsAbout("YYY")).toBe("YYY");
		expect(complainsAbout("[Day YYYY-MM-DD")).toBe("[Day YYYY-MM-DD");
	});

	it("still says nothing about a whole pattern, folders of its own included", () => {
		expect(complainsAbout("YYYY-MM-DD")).toBeNull();
		expect(complainsAbout("YYYY/MM/YYYY-MM-DD")).toBeNull();
		// The typed `.md` the writer strips and puts back: one pattern, not two.
		expect(complainsAbout("YYYY-MM-DD.md")).toBeNull();
	});

	it("says nothing about a blank filename, which is unanswered rather than broken", () => {
		expect(complainsAbout("")).toBeNull();
		expect(complainsAbout("   ")).toBeNull();
		// And the equivalence genuinely does not hold there: nothing can be
		// written under a layout with no filename pattern, so nothing is recognised.
		expect(recognisesEveryDay(layout({ dailyLogFilename: "" }))).toBe(false);
		expect(recognisesEveryDay(layout({ dailyLogFilename: "   " }))).toBe(false);
	});

	// This is the boundary the round-trip property below stops at, and the two
	// read as one rule rather than two: the property holds for every layout whose
	// folder is answered, and a layout with no folder is a filename question asked
	// at the vault root.
	it("asks about the filename alone, so an unanswered folder complains about nothing", () => {
		// Both boxes ship blank and the folder is the one above, so answering the
		// filename first is an ordinary order to answer them in. The probe stands
		// the missing folder in with the vault root rather than reporting the
		// filename for want of it.
		const unanswered = { dailyLogFolder: "" };
		expect(unreadableFilenamePattern(layout({ ...unanswered, dailyLogFilename: "YYYY-MM-DD" }))).toBeNull();
		expect(unreadableFilenamePattern(layout({ ...unanswered, dailyLogFilename: "MM-DD" }))).toBe("MM-DD");
	});

	/**
	 * The first day of 2024 to 2027 whose day's log is not read back as that
	 * same day under `candidate`, or `null` when every one of them is.
	 *
	 * The recogniser's own answer, over 1,461 days rather than the one the
	 * helper probes with. **A sweep and not a single day, because readability
	 * varies by day** — that is the whole of
	 * #515. `YYYYMD` was
	 * read back correctly on the day this fixture used to ask about, and of
	 * these 1,461 days it loses 697 to nothing and 72 more to the wrong day — so
	 * the table below passed while the helper was wrong.
	 *
	 * **Read back as *that day*, not merely as some day.** Under `YYYYMD` the
	 * name `2024111.md` is 11 January and 1 November both, and the recogniser
	 * hands back the later of them. Counting that as a recognition would call a
	 * lost day a found one.
	 *
	 * A pattern the writer throws for is not recognisable either: that throw is
	 * the deliberate asymmetry of #78, and a path that cannot be written is not
	 * one that can be read.
	 *
	 * Returns the day rather than a boolean so that a failing row names the day
	 * it failed on. Four years, one of them a leap year, is the span the sweep
	 * covers; it stops at the first loss, so a lossy pattern costs almost
	 * nothing.
	 */
	function firstDayNotReadBack(candidate: VaultLayout): string | null {
		// `dailyLogPattern` throws exactly where `dailyLogPath` does, and does it
		// at once rather than on the first day written — the pattern is what
		// fails to tokenise, not any particular date — so this still names the
		// first day of the sweep, matching what writing and reading it one day
		// at a time through `dailyLogPath`/`parseDailyLogDate` would have found.
		let pattern: ReturnType<typeof dailyLogPattern>;
		try {
			pattern = dailyLogPattern(candidate);
		} catch {
			return "2024-1-1";
		}

		for (let year = 2024; year <= 2027; year += 1) {
			for (let month = 1; month <= 12; month += 1) {
				const lastDate = new Date(year, month, 0).getDate();
				for (let date = 1; date <= lastDate; date += 1) {
					const wanted = day(year, month, date);
					const written = pattern.write(wanted);
					const read = pattern.read(written);
					if (read === null || read.getTime() !== wanted.getTime()) {
						return `${year}-${month}-${date}`;
					}
				}
			}
		}
		return null;
	}

	/** Whether every day of 2024 to 2027 round-trips under `candidate`. */
	const recognisesEveryDay = (candidate: VaultLayout): boolean =>
		firstDayNotReadBack(candidate) === null;

	// The property, asserted directly rather than case by case: the line appears
	// exactly when the plugin cannot read its own day's log back. The two must
	// not be able to disagree — that is what the helper's own doc comment
	// promises — and asking the tokeniser is how they did.
	//
	// **For every layout whose folder is answered and whose filename pattern is
	// not blank.** That scope is the property's real one and used to go
	// unwritten, so a later session read an equivalence here that the table's own
	// rows did not test. A layout with no
	// folder is a filename question asked at the vault root: the helper probes
	// there while `dailyLogPath` throws for the layout it was handed, so nothing
	// is written, nothing is recognised, and the equivalence cannot hold. The
	// blank-folder rows are therefore asserted just below, against the vault-root
	// behaviour that is actually promised, rather than folded into this table
	// where they would read as the equivalence and fail.
	//
	// A blank filename pattern is the second boundary: the helper answers null
	// for it while `dailyLogPath` throws, so nothing is written and nothing
	// recognised there either. The table below carries no blank-filename row, and
	// the blank case is asserted on its own above.
	//
	// **This table is not what catches a pattern that loses only some days, and
	// a later session should not expect it to be**. Measured: with
	// the helper still probing one day, every row here passed against the
	// four-year sweep, because no row's readability varies by day. Rows are
	// chosen by hand and the fault is that nobody thinks of the pattern that
	// breaks. The generated space below is what caught it, and adding a row here
	// is not a substitute for adding to that.
	it.each([
		["Journal", "YYYY-MM-DD"],
		["Journal", "YYYY-MM-DD.md"],
		["Journal", "YYYY/MM/YYYY-MM-DD"],
		["Journal", "[Day] YYYY-MM-DD"],
		["Journal", "dddd D MMMM YYYY"],
		["Journal", "YY-MM-DD"],
		["Journal", "MM-DD"],
		["Journal", "DD"],
		["Journal", "dddd"],
		["Journal", ".md"],
		["Journal", "YYY"],
		["Journal", "[Day YYYY-MM-DD"],
		// A filename pattern carrying a slash, which `normalizePath` collapses on
		// the way out and the reader never sees
		// (#329 /
		// #332). Asserted as
		// the equivalence rather than as an answer, so whichever way that pair is
		// settled this row stays true.
		["Journal", "/YYYY-MM-DD"],
		["/", "YYYY-MM-DD"],
		["/", "MM-DD"],
		["Journal/", "YYYY-MM-DD"],
	])("answers about %s + %s exactly as the recogniser does", (dailyLogFolder, dailyLogFilename) => {
		const candidate = layout({ dailyLogFolder, dailyLogFilename });
		expect(unreadableFilenamePattern(candidate) === null).toBe(recognisesEveryDay(candidate));
	});

	// The boundary row the table above stops at, asserted as what it really is:
	// a layout with no folder gets the answer for that filename at the vault
	// root. Written as a comparison rather than as a fixed string so that the
	// pair cannot drift — whatever `/` answers for a pattern, a blank folder
	// answers the same.
	it.each([["YYYY-MM-DD"], ["MM-DD"], [".md"], ["YYY"], ["YYYY/MM/YYYY-MM-DD"]])(
		"answers about a blank folder + %s as it does at the vault root",
		(dailyLogFilename) => {
			const blank = layout({ dailyLogFolder: "", dailyLogFilename });
			const root = layout({ dailyLogFolder: "/", dailyLogFilename });
			expect(unreadableFilenamePattern(blank)).toBe(unreadableFilenamePattern(root));
			// And the equivalence genuinely does not hold there: nothing can be
			// written under a layout with no folder, so nothing is recognised.
			expect(recognisesEveryDay(blank)).toBe(false);
		},
	);

	// #515. The three rows the single probe day could not answer for, asserted
	// as answers rather than as the equivalence, so that they say what a person
	// meets on the settings screen and not only that two functions agree.
	it("reports a pattern that loses some days and not others", () => {
		// `YYYYMD` writes 10 January 2024 as `Journal/2024110.md`, and the reader
		// takes the `11` as the month and is left with a day of `0`. 697 of the
		// 1,461 days of 2024 to 2027 go that way and 72 more come back as another
		// day, and until #515 nothing was said about any of it: the day the probe
		// used to ask about, 23 November, is written with two digits in both
		// fields and reads back perfectly.
		expect(complainsAbout("YYYYMD")).toBe("YYYYMD");
		expect(firstDayNotReadBack(layout({ dailyLogFilename: "YYYYMD" }))).toBe("2024-1-10");
	});

	// #562. The three patterns the nine-day probe set could not answer for,
	// because no day in it paired a one-digit month with a day of 30 or 31.
	it("reports a one-digit month run into a day of 30 or 31 by a literal digit", () => {
		// `YYYY-M3D` writes 31 January 2024 as `Journal/2024-1331.md`: month `1`,
		// the literal `3`, day `31`. The reader cannot tell that `3` from the one
		// the day itself starts with, so it loses every day of 30 or 31 whose
		// month is one digit — 52 of the 1,461 days of 2024 to 2027.
		expect(complainsAbout("YYYY-M3D")).toBe("YYYY-M3D");
		expect(complainsAbout("YYYYM3D")).toBe("YYYYM3D");
		expect(complainsAbout("M3D-YYYY")).toBe("M3D-YYYY");
	});

	it("still reports a pattern that loses nearly every day", () => {
		// The mirror of the row above, and the one the single probe day did catch:
		// a weekday name carries no date, so only the days whose weekday happens
		// to match the one the name is read back as survive.
		expect(complainsAbout("YYYYdddd")).toBe("YYYYdddd");
	});

	// Every filename pattern this repo uses as a working layout — the fixture
	// default, the ones its own tests store, and the ones its comments hold up as
	// examples. A pattern this list drops silently is a pattern a person could be
	// told to stop using, so the sweep is what confirms each one rather than the
	// helper's own opinion of it.
	//
	// The patterns the repo uses as *broken* examples are deliberately not here:
	// `MM-DD`, `DD`, `dddd`, `ddd MMM D` and `.md` have no year field or no
	// pattern at all, `YYY` and `[Day YYYY-MM-DD` are half-typed, and `QQ` is a
	// token this plugin does not know. Each is asserted above as the complaint it
	// is.
	it.each([
		["YYYY-MM-DD"],
		["YYYY-MM-DD.md"],
		["YYYY/MM/YYYY-MM-DD"],
		["YYYY/YYYY-MM-DD"],
		["[Day] YYYY-MM-DD"],
		["dddd D MMMM YYYY"],
		["YY-MM-DD"],
		["YY.M.D"],
	])("says nothing about %s, and no day of four years is lost under it", (dailyLogFilename) => {
		const candidate = layout({ dailyLogFilename });
		expect(firstDayNotReadBack(candidate)).toBeNull();
		expect(unreadableFilenamePattern(candidate)).toBeNull();
	});

	/**
	 * Every filename pattern that can be built from a pair of date fields with
	 * one separator between them, and every one built from three run together
	 * with none. 1,288 patterns after duplicates.
	 *
	 * The second half is where #515 lives: three fields with nothing between
	 * them is exactly the shape whose readability depends on how many digits the
	 * day happens to need. The first half is the floor under it — no pattern of
	 * two fields can name a day at all, and none of these is accepted.
	 */
	function generatedPatterns(): string[] {
		const fields = ["YYYY", "YY", "MMMM", "MMM", "MM", "M", "DD", "D", "dddd", "ddd"];
		const separators = ["", "-", "/", " ", ".", "_"];
		const built = new Set<string>();
		for (const first of fields) {
			for (const second of fields) {
				for (const separator of separators) built.add(first + separator + second);
				for (const third of fields) built.add(first + second + third);
			}
		}
		return [...built];
	}

	// The property, over a generated space rather than a hand-written table: the
	// helper's answer agrees with what a four-year sweep actually finds, for
	// every one of those patterns. This is the test the helper's doc comment
	// cites, and it is what makes that comment's claim a measurement rather than
	// an argument.
	//
	// One `it` rather than 1,288 of them, because the point is the count: a table
	// of that size would bury the two numbers that say whether the space was worth
	// sweeping at all.
	// Vitest's 5s default is tight for a sweep this size on a shared machine
	// under load; 20s leaves headroom well beyond quiet-machine
	// duration (under 1s here) without masking a real regression.
	it("answers about 1,288 generated patterns exactly as a four-year sweep does", () => {
		const patterns = generatedPatterns();
		const disagreed: string[] = [];
		let lossy = 0;
		for (const dailyLogFilename of patterns) {
			const candidate = layout({ dailyLogFilename });
			const sweptClean = firstDayNotReadBack(candidate) === null;
			if (!sweptClean) lossy += 1;
			if ((unreadableFilenamePattern(candidate) === null) !== sweptClean) {
				disagreed.push(dailyLogFilename);
			}
		}
		expect(patterns).toHaveLength(1288);
		// The space is worth sweeping only if most of it is lossy; a space of
		// patterns that all work would agree with anything.
		expect(lossy).toBe(1204);
		expect(disagreed).toEqual([]);
	}, 20_000);

	/**
	 * Every filename pattern built by running two of the four numeral fields —
	 * `M`, `MM`, `D`, `DD` — together with a single literal digit between them,
	 * `YYYY` joined on either side so each has a year field and is not refused
	 * for that alone (see the `MM-DD` row above). 240 patterns after duplicates.
	 *
	 * This is the shape the nine-day probe set never asked about, and the whole
	 * of #562: a one-digit field's numeral can be mistaken for a literal digit
	 * sitting next to it, and no day in that set paired a one-digit month with a
	 * day of 30 or 31, so `YYYY-M3D` lost 52 days a year in silence. Generated
	 * rather than the three named patterns alone, so that a class of pattern and
	 * not three specific strings is what the helper is checked against.
	 */
	function digitJoinedPatterns(): string[] {
		const fields = ["M", "MM", "D", "DD"];
		const digits = "0123456789".split("");
		const built = new Set<string>();
		for (const first of fields) {
			for (const second of fields) {
				if (first === second) continue;
				for (const digit of digits) {
					built.add(`YYYY-${first}${digit}${second}`);
					built.add(`${first}${digit}${second}-YYYY`);
				}
			}
		}
		return [...built];
	}

	// The property, over the digit-joined space rather than the three named
	// patterns: the helper's answer agrees with what the four-year sweep finds
	// for every one of them, by construction rather than by luck, because the
	// helper now runs that same sweep.
	// Same headroom as the generated-pattern test above, and for the same
	// reason: 20s against a quiet-machine duration under 1.5s.
	it("answers about 240 digit-joined patterns exactly as a four-year sweep does", () => {
		const patterns = digitJoinedPatterns();
		const disagreed: string[] = [];
		let lossy = 0;
		for (const dailyLogFilename of patterns) {
			const candidate = layout({ dailyLogFilename });
			const sweptClean = firstDayNotReadBack(candidate) === null;
			if (!sweptClean) lossy += 1;
			if ((unreadableFilenamePattern(candidate) === null) !== sweptClean) {
				disagreed.push(dailyLogFilename);
			}
		}
		expect(patterns).toHaveLength(240);
		// The space is worth sweeping only if a good share of it is lossy; a
		// space of patterns that all work would agree with anything.
		expect(lossy).toBe(88);
		expect(disagreed).toEqual([]);
	}, 20_000);
});

describe("sectionRange", () => {
	const note = [
		"# Notes", // 0
		"", // 1
		"- a thought", // 2
		"", // 3
		"## Calendar", // 4
		"", // 5
		"| Time | Event |", // 6
		"", // 7
		"### Later", // 8
		"still the calendar", // 9
		"", // 10
		"# Something else", // 11
		"tail", // 12
	].join("\n");

	it("finds the heading, its body, and where the body ends", () => {
		expect(sectionRange(note, "calendarHeading", layout())).toEqual({
			heading: 4,
			start: 5,
			end: 11,
		});
	});

	it("lets a deeper heading stay inside the section and a shallower one end it", () => {
		expect(sectionRange(note, "notesHeading", layout())).toEqual({
			heading: 0,
			start: 1,
			end: 11,
		});
	});

	it("runs to the end of the note when no heading follows", () => {
		const short = "# Notes\nonly this\n";
		expect(sectionRange(short, "notesHeading", layout())).toEqual({
			heading: 0,
			start: 1,
			end: 3,
		});
	});

	it("gives an empty body when the next heading follows straight away", () => {
		const range = sectionRange("# Notes\n# Next\n", "notesHeading", layout());
		expect(range).toEqual({ heading: 0, start: 1, end: 1 });
	});

	it("ignores capitals", () => {
		expect(sectionRange("# NOTES\nbody", "notesHeading", layout())?.heading).toBe(0);
	});

	it("does not match a heading with anything appended", () => {
		expect(sectionRange("# Notes for later\nbody", "notesHeading", layout())).toBeNull();
	});

	it("does not match the same words at another level", () => {
		expect(sectionRange("## Notes\nbody", "notesHeading", layout())).toBeNull();
	});

	it("does not read hashes without a space as a heading", () => {
		expect(sectionRange("#Notes\nbody", "notesHeading", layout())).toBeNull();
	});

	it("does not see a heading inside a fenced block, and such a fence does not end a section", () => {
		const fenced = [
			"# Notes", // 0
			"```schema", // 1
			"# Calendar", // 2
			"```", // 3
			"after", // 4
		].join("\n");
		expect(sectionRange(fenced, "calendarHeading", layout({ calendarHeading: { text: "Calendar", level: 1 } }))).toBeNull();
		expect(sectionRange(fenced, "notesHeading", layout())?.end).toBe(5);
	});

	it("survives Windows line endings", () => {
		expect(sectionRange("# Notes\r\nbody\r\n# Next\r\n", "notesHeading", layout())).toEqual({
			heading: 0,
			start: 1,
			end: 2,
		});
	});

	it("says nothing rather than guessing when the heading is absent", () => {
		expect(sectionRange("just prose", "notesHeading", layout())).toBeNull();
	});
});

describe("the day's frame", () => {
	it("lists the day's-log sections in the order they are written, overdue directly above today and the diary last", () => {
		expect(daySections()).toEqual(["notesHeading", "overdueHeading", "todayHeading", "calendarHeading", "diaryHeading"]);
	});

	it("writes every day's-log heading at its own level, the calendar's with its table", () => {
		expect(dailyLogFrame(layout())).toBe(
			"# Notes\n\n## Overdue\n\n## Today\n\n## Calendar\n\n```schema\n| Time | Meeting |\n| --- | --- |\n```\n\n# Diary\n\n",
		);
	});

	it("leaves out a heading whose text has been emptied", () => {
		expect(dailyLogFrame(layout({ notesHeading: { text: " ", level: 1 } }))).toBe(
			"## Overdue\n\n## Today\n\n## Calendar\n\n```schema\n| Time | Meeting |\n| --- | --- |\n```\n\n# Diary\n\n",
		);
	});

	it("leaves out the calendar table along with a calendar heading whose text has been emptied", () => {
		expect(dailyLogFrame(layout({ calendarHeading: { text: " ", level: 2 } }))).toBe(
			"# Notes\n\n## Overdue\n\n## Today\n\n# Diary\n\n",
		);
	});

	it("ends with the diary heading, after the calendar table, when every heading is named", () => {
		const settings = layout({
			notesHeading: { text: "Notes", level: 1 },
			overdueHeading: { text: "Overdue", level: 2 },
			todayHeading: { text: "Today", level: 2 },
			calendarHeading: { text: "Calendar", level: 2 },
			diaryHeading: { text: "About the day", level: 3 },
		});
		const frame = dailyLogFrame(settings);

		expect(frame).toBe(
			"# Notes\n\n## Overdue\n\n## Today\n\n## Calendar\n\n```schema\n| Time | Meeting |\n| --- | --- |\n```\n\n### About the day\n\n",
		);
		expect(frame.lastIndexOf("### About the day")).toBeGreaterThan(frame.lastIndexOf("```\n"));
	});

	it.each([[""], [" "], ["\t"]])(
		"carries no diary section for a blank diary heading %j, and is byte-identical to the frame before the diary existed",
		(text) => {
			const frame = dailyLogFrame(layout({ diaryHeading: { text, level: 1 } }));

			expect(frame).toBe(
				"# Notes\n\n## Overdue\n\n## Today\n\n## Calendar\n\n```schema\n| Time | Meeting |\n| --- | --- |\n```\n\n",
			);
		},
	);

	it("writes a heading found by sectionRange, and finds a heading it wrote", () => {
		const settings = layout();
		for (const section of daySections()) {
			expect(sectionRange(dailyLogFrame(settings), section, settings)).not.toBeNull();
		}
	});

	it("writes no placeholder row — a header and a separator is a table with zero rows to parseCalendarTable", () => {
		const settings = layout();
		const lines = dailyLogFrame(settings).split("\n");
		const outcome = parseCalendarTable(lines, settings.calendarColumns);

		expect(outcome.found).toBe(true);
		if (!outcome.found) return;
		expect(outcome.table.rows).toEqual([]);
		expect(outcome.table.columnCount).toBe(2);
	});

	it("names the header from layout.calendarColumns, so a renamed column produces a renamed header", () => {
		const settings = layout({ calendarColumns: { time: "Start", event: "Session" } });

		expect(dailyLogFrame(settings)).toBe(
			"# Notes\n\n## Overdue\n\n## Today\n\n## Calendar\n\n```schema\n| Start | Session |\n| --- | --- |\n```\n\n# Diary\n\n",
		);

		const outcome = parseCalendarTable(dailyLogFrame(settings).split("\n"), settings.calendarColumns);
		expect(outcome.found).toBe(true);
		if (!outcome.found) return;
		expect(outcome.table.rows).toEqual([]);
	});

	it("escapes a pipe in a configured column name so the header parseCalendarTable reads back is still two cells", () => {
		// Start/Session, above, cannot fail this way: neither name can turn the
		// header into a row of the wrong width. A column name carrying a pipe
		// can, and does if the pipe reaches the header unescaped.
		const settings = layout({ calendarColumns: { time: "Ti|me", event: "Meeting" } });

		expect(dailyLogFrame(settings)).toBe(
			"# Notes\n\n## Overdue\n\n## Today\n\n## Calendar\n\n```schema\n| Ti\\|me | Meeting |\n| --- | --- |\n```\n\n# Diary\n\n",
		);

		const outcome = parseCalendarTable(dailyLogFrame(settings).split("\n"), settings.calendarColumns);
		expect(outcome.found).toBe(true);
		if (!outcome.found) return;
		expect(outcome.table.columnCount).toBe(2);
		expect(outcome.table.rows).toEqual([]);
	});
});

describe("insertionLineForMissingSection and calendarTableBlock, exported for dailyLogTemplate.ts", () => {
	it("places a missing section directly above the next one that already exists", () => {
		const settings = layout();
		// Notes and Calendar exist; Overdue and Today do not. Today comes
		// after Overdue in daySections()' own order, so Overdue's insertion
		// line is the heading line of the next section that already
		// exists after it — here, Calendar's.
		const content = "# Notes\n\nWrite here.\n\n## Calendar\n\n```schema\n| Time | Meeting |\n| --- | --- |\n```\n";
		const lines = content.split("\n");
		expect(insertionLineForMissingSection(content, "overdueHeading", settings)).toBe(
			lines.indexOf("## Calendar"),
		);
	});

	it("places a missing section at the end of the note when nothing later already exists", () => {
		const settings = layout();
		const content = "# Notes\n\nWrite here.\n";
		expect(insertionLineForMissingSection(content, "calendarHeading", settings)).toBe(
			content.split("\n").length,
		);
	});

	it("builds the same header, separator and zero rows dailyLogFrame's own calendar section carries", () => {
		const settings = layout();
		expect(calendarTableBlock(settings.calendarColumns)).toBe(
			"```schema\n| Time | Meeting |\n| --- | --- |\n```\n\n",
		);
	});
});

describe("what the section-order guard covers", () => {
	// The record in vaultLayout.ts fails to compile when a heading typed
	// HeadingSetting is added to VaultLayout and not given a place in it. These
	// three say where that guard stops, so the comment above the record and the
	// code cannot drift apart again without a check going red.

	it("admits the levelled headings and nothing else", () => {
		// A compile-time assertion, not a runtime one: if SectionName ever
		// widens or narrows, this annotation stops type-checking and both
		// `npm run lint` and `npm run build` fail on this line.
		const covered: Equals<
			SectionName,
			"notesHeading" | "calendarHeading" | "todayHeading" | "overdueHeading" | "diaryHeading"
		> = true;
		expect(covered).toBe(true);
	});

	it("names exactly the shipped layout fields that carry a level", () => {
		const levelled = Object.entries(defaultData().core.layout)
			.filter(([, value]) => typeof value === "object" && value !== null && "level" in value)
			.map(([key]) => key);
		expect(daySections().slice().sort()).toEqual(levelled.slice().sort());
	});

	it("leaves the plain-string headings out of a new day, on purpose", () => {
		// tasksHeading and completedTasksHeading are a collection's headings,
		// matched at any level wherever they appear. They are
		// outside the guard because they are not sections of the day's log —
		// which is what the record's comment now says, rather than promising a
		// guard over every heading.
		const settings = layout();
		const frame = dailyLogFrame(settings);
		expect(frame).toBe(
			"# Notes\n\n## Overdue\n\n## Today\n\n## Calendar\n\n```schema\n| Time | Meeting |\n| --- | --- |\n```\n\n# Diary\n\n",
		);
		expect(frame).not.toContain(settings.tasksHeading);
		expect(frame).not.toContain(settings.completedTasksHeading);
	});
});

describe("the daily-log folder setting", () => {
	// The same folder typed the ways a person actually types it. `/` and a
	// leading, trailing or doubled slash all name the same place; the builder
	// and the recogniser must agree on which place that is.
	const folders = ["/", "Journal", "/Journal", "Journal/", "Journal//2026", "Journal/2026"];

	it("recognises every day it writes, whichever way the folder was typed", () => {
		for (const dailyLogFolder of folders) {
			const settings = layout({ dailyLogFolder });
			for (const date of [day(2026, 1, 1), day(2026, 9, 6), day(2026, 12, 31)]) {
				const path = dailyLogPath(date, settings);
				expect(parseDailyLogDate(path, settings)).toEqual(date);
			}
		}
	});

	it("refuses a path one character away from one it wrote", () => {
		for (const dailyLogFolder of folders) {
			const settings = layout({ dailyLogFolder });
			const path = dailyLogPath(day(2026, 9, 6), settings);
			expect(isDailyLogPath(path, settings)).toBe(true);
			expect(isDailyLogPath(path.replace("-06.md", "-6.md"), settings)).toBe(false);
		}
	});

	it("puts the day at the vault root when the folder is a single slash", () => {
		// `normalizePath` answers `/` for a path that reduces to nothing, so this
		// is the folder box left at its most natural way of saying "the root".
		const root = layout({ dailyLogFolder: "/" });
		expect(dailyLogPath(day(2026, 9, 6), root)).toBe("2026-09-06.md");
		expect(parseDailyLogDate("2026-09-06.md", root)).toEqual(day(2026, 9, 6));
	});

	it("does not take a note at the root for a day's log when the folder is named", () => {
		expect(isDailyLogPath("2026-09-06.md", layout())).toBe(false);
	});

	it("does not take a note in a subfolder for a day's log when the folder is the root", () => {
		expect(isDailyLogPath("Notes/2026-09-06.md", layout({ dailyLogFolder: "/" }))).toBe(false);
	});

	it("still means 'not answered yet' when the folder box is blank", () => {
		const blank = layout({ dailyLogFolder: "  " });
		expect(() => dailyLogPath(day(2026, 9, 6), blank)).toThrow(/folder/i);
		expect(parseDailyLogDate("2026-09-06.md", blank)).toBeNull();
		expect(isDailyLogPath("2026-09-06.md", blank)).toBe(false);
	});
});

describe("GLOSSARY.md and the section vocabulary", () => {
	// The glossary is meant to be the one place a word is defined, so it may not
	// name a category the type refuses. `SectionName` admits only the levelled
	// headings; these tests are what stop the entry drifting back to naming the
	// task headings among them.
	const glossary = readFileSync(resolve(repoRoot, "GLOSSARY.md"), "utf8");

	/**
	 * One glossary entry's body: its definition and its `_Avoid_` line, without
	 * the bold term itself. Entries are separated by a blank line, so splitting
	 * on those is what bounds one — and it needs no escaping of the term.
	 */
	function entry(term: string): string {
		const head = `**${term}**:`;
		const block = glossary.split(/\n{2,}/).find((part) => part.startsWith(`${head}\n`));
		expect(block, `GLOSSARY.md has no **${term}** entry`).toBeDefined();
		return (block as string).slice(head.length).trim();
	}

	it("defines a section by naming the levelled headings and no others", () => {
		// The first sentence is the definition by enumeration, and it is where
		// the mismatch sat: it listed the task headings as sections.
		const definition = entry("Section").split(". ")[0];
		expect(definition).toContain("notes heading");
		expect(definition).toContain("calendar heading");
		expect(definition).not.toMatch(/tasks? headings?/i);
	});

	/** The claim both halves of the split have to carry, emphasis markers and all. */
	const saysNotASection = /not\s+(a\s+)?\**sections?/i;

	it("says in the Section entry that a task heading is not one", () => {
		expect(entry("Section")).toMatch(saysNotASection);
	});

	it("gives each task heading a term of its own, with an Avoid line", () => {
		for (const term of ["The tasks heading", "The completed-tasks heading"]) {
			expect(entry(term), `**${term}** should say it is not a section`).toMatch(
				saysNotASection,
			);
			expect(entry(term), `**${term}** needs an _Avoid_ line`).toContain("_Avoid_:");
		}
	});

	it("names the heading, not the section, as what tells the two forwardings apart", () => {
		expect(entry("Forwarding")).not.toContain("the section is the disambiguator");
	});

	// Wave 3's shared line. Issue #79 made a standby feature constructed but not
	// loaded, and the glossary was the only place that said otherwise — by saying
	// nothing. The worker that made the change could not write this sentence,
	// because another worker owned the file; this is the check that says it
	// arrived, so a later reader is not told a standby feature is running.
	it("says a standby feature is constructed but not loaded", () => {
		const state = entry("Feature state");
		expect(state).toMatch(/constructed but not loaded/i);
		expect(state).toMatch(/nothing of it runs here/i);
	});

	// Applied by the wave at merge: #92 added a seventh state and the worker that
	// added it was not allowed to write this file.
	it("counts the seventh state and places it", () => {
		const state = entry("Feature state");
		expect(state).toMatch(/Seven members/);
		expect(state).not.toMatch(/Six members/);
		expect(state).toMatch(/\*not configured\*, \*not started\*, \*running\*/);
	});
});

describe("a language whose months have two forms", () => {
	/**
	 * A fabricated language: the standalone word ends in `-ari`, the word moment
	 * writes for a month inside a date in `-aria`. Not moment's real Russian, so
	 * this file owns exactly what it means.
	 */
	const TWO_FORM_LOCALE = {
		months: [
			"Enari", "Tvåari", "Treari", "Fyrari", "Femari", "Sexari",
			"Sjuari", "Åttari", "Nioari", "Tioari", "Elvari", "Tolvari",
		],
		monthsShort: ["Ena", "Två", "Tre", "Fyr", "Fem", "Sex", "Sju", "Ått", "Nio", "Tio", "Elv", "Tol"],
		weekdays: ["Söndär", "Måndär", "Tisdär", "Onsdär", "Torsdär", "Fredär", "Lördär"],
		weekdaysShort: ["Sön", "Mån", "Tis", "Ons", "Tor", "Fre", "Lör"],
		monthsInDate: [
			"Enaria", "Tvåaria", "Trearia", "Fyraria", "Femaria", "Sexaria",
			"Sjuaria", "Åttaria", "Nioaria", "Tioaria", "Elvaria", "Tolvaria",
		],
		monthsShortInDate: ["Ena.", "Två.", "Tre.", "Fyr.", "Fem.", "Sex.", "Sju.", "Ått.", "Nio.", "Tio.", "Elv.", "Tol."],
	};

	/** The language set as the app's own, with the pattern `D MMMM`. */
	function twoFormLayout(overrides: Partial<VaultLayout> = {}): VaultLayout {
		resetLanguage();
		registerLocale("xx", TWO_FORM_LOCALE);
		setLanguage("xx");
		return layout({ dailyLogFilename: "D MMMM YYYY", ...overrides });
	}

	it("names the day's log with the in-date form, as moment's own format would", () => {
		const settings = twoFormLayout();
		try {
			expect(dailyLogPath(day(2026, 1, 5), settings)).toBe("Journal/5 Enaria 2026.md");
			// A pattern with the month ahead of the day gets the standalone form.
			const monthFirst = { ...settings, dailyLogFilename: "MMMM D YYYY" };
			expect(dailyLogPath(day(2026, 1, 5), monthFirst)).toBe("Journal/Enari 5 2026.md");
		} finally {
			resetLanguage();
		}
	});

	it("recognises a log named in either form as that day's log", () => {
		const settings = twoFormLayout();
		try {
			for (const path of ["Journal/5 Enaria 2026.md", "Journal/5 Enari 2026.md"]) {
				expect(parseDailyLogDate(path, settings)).toEqual(day(2026, 1, 5));
				expect(parseDailyLogDate(path, settings)?.getMonth()).toBe(0);
				expect(parseDailyLogDate(path, settings)?.getDate()).toBe(5);
				expect(isDailyLogPath(path, settings)).toBe(true);
			}
			// Still not any word: a month the language does not hold is no day's log.
			expect(isDailyLogPath("Journal/5 Enarix 2026.md", settings)).toBe(false);
		} finally {
			resetLanguage();
		}
	});

	it("recognises a log written under the previous language in either of that language's forms", () => {
		const settings = twoFormLayout();
		try {
			// The app has since moved to English; "xx" is the recorded previous.
			setLanguage("en");
			const afterChange = { ...settings, languageHistory: { current: "en", previous: "xx" } };
			for (const path of ["Journal/5 Enaria 2026.md", "Journal/5 Enari 2026.md"]) {
				expect(parseDailyLogDate(path, afterChange)?.getMonth()).toBe(0);
				expect(parseDailyLogDate(path, afterChange)?.getDate()).toBe(5);
				expect(isDailyLogPath(path, afterChange)).toBe(true);
			}
			// The current language's own name is written as English writes it.
			expect(dailyLogPath(day(2026, 1, 5), afterChange)).toBe("Journal/5 January 2026.md");
		} finally {
			resetLanguage();
		}
	});

	it("builds the table from the Locale's own month readers, reading the language on every call", () => {
		const settings = twoFormLayout();
		const spy = vi.spyOn(moment, "locale");
		try {
			expect(dailyLogPath(day(2026, 1, 5), settings)).toBe("Journal/5 Enaria 2026.md");
			// The language changes between two calls; nothing was kept from the first.
			setLanguage("en");
			expect(dailyLogPath(day(2026, 1, 5), settings)).toBe("Journal/5 January 2026.md");
			const switches = spy.mock.calls.filter((args) => args.length > 0 && args[0] !== undefined);
			expect(switches).toEqual([]);
		} finally {
			spy.mockRestore();
			resetLanguage();
		}
	});
});

describe("what reading the month names asks of a Locale", () => {
	/** How many times the spied month readers were asked for a word under a format. */
	function formatCalls(spies: readonly { mock: { calls: unknown[][] } }[]): number {
		return spies.reduce((sum, spy) => sum + spy.mock.calls.filter((args) => args.length > 0).length, 0);
	}

	it("asks the Locale for no month word at all when the pattern has no month name in it", () => {
		resetLanguage();
		const data = moment.localeData("en");
		const spies = [vi.spyOn(data, "months"), vi.spyOn(data, "monthsShort")];
		try {
			const settings = layout({ dailyLogFilename: "YYYY-MM-DD" });
			expect(parseDailyLogDate(dailyLogPath(day(2026, 1, 5), settings), settings)).toEqual(day(2026, 1, 5));
			expect(formatCalls(spies)).toBe(0);
		} finally {
			spies.forEach((spy) => spy.mockRestore());
			resetLanguage();
		}
	});

	it("asks a Locale for its words under a pattern once, however many days are written and read after", () => {
		resetLanguage();
		const data = moment.localeData("en");
		const spies = [vi.spyOn(data, "months"), vi.spyOn(data, "monthsShort")];
		try {
			const settings = layout({ dailyLogFilename: "D MMMM YYYY" });
			const roundTrip = (): void => {
				expect(parseDailyLogDate(dailyLogPath(day(2026, 1, 5), settings), settings)).toEqual(day(2026, 1, 5));
			};
			roundTrip();
			const afterFirst = formatCalls(spies);
			expect(afterFirst).toBeGreaterThan(0);
			roundTrip();
			roundTrip();
			expect(formatCalls(spies)).toBe(afterFirst);
		} finally {
			spies.forEach((spy) => spy.mockRestore());
			resetLanguage();
		}
	});
});
