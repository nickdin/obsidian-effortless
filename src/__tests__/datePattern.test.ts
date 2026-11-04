import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type DateNames,
	type DateToken,
	compilePattern,
	ENGLISH_NAMES,
	FIELDS,
	formatField,
	formatName,
	fieldPattern,
	keyedTokens,
	readName,
} from "../core/datePattern";

/** A local date, since a day's log is named after the local day. */
const day = (y: number, m: number, d: number): Date => new Date(y, m - 1, d);

describe("the date engine's seam", () => {
	it("imports nothing from the settings or the layout", () => {
		// The point of the split: this module takes a pattern and a
		// Date, so every test in this file builds one without a layout object.
		// Reading the source is what stops the seam closing again unnoticed.
		const source = readFileSync(resolve(__dirname, "..", "core", "datePattern.ts"), "utf8");
		const imports = source.match(/^\s*(?:import|export)\s.*from\s+["'](.+)["'];?$/gm) ?? [];
		expect(imports).toEqual([]);
	});
});

describe("formatName", () => {
	it("writes the year, month and day, padded and unpadded", () => {
		expect(formatName(day(2026, 9, 6), "YYYY-MM-DD")).toBe("2026-09-06.md");
		expect(formatName(day(2026, 9, 6), "YY.M.D")).toBe("26.9.6.md");
	});

	it("writes month and weekday names, long and short", () => {
		expect(formatName(day(2026, 9, 6), "dddd D MMMM YYYY")).toBe("Sunday 6 September 2026.md");
		expect(formatName(day(2026, 9, 6), "ddd MMM D")).toBe("Sun Sep 6.md");
	});

	it("writes text inside square brackets literally", () => {
		expect(formatName(day(2026, 1, 2), "[Day] YYYY-MM-DD")).toBe("Day 2026-01-02.md");
	});

	it("lets the pattern carry folders of its own", () => {
		expect(formatName(day(2026, 9, 6), "YYYY/MM/YYYY-MM-DD")).toBe("2026/09/2026-09-06.md");
	});

	it("refuses a token it does not understand rather than writing it out raw", () => {
		expect(() => formatName(day(2026, 9, 6), "YYYY-MM-Do")).toThrow(/Do/);
		expect(() => formatName(day(2026, 9, 6), "[open")).toThrow(/\[/);
	});
});

describe("readName", () => {
	it("reads back every name it wrote", () => {
		for (const pattern of ["YYYY-MM-DD", "YYYY/MM/YYYY-MM-DD", "[Day] D MMMM YYYY", "YY.M.D"]) {
			for (const date of [day(2026, 1, 1), day(2026, 9, 6), day(2026, 12, 31)]) {
				const name = formatName(date, pattern).slice(0, -3);
				expect(readName(name, pattern)).toEqual(date);
			}
		}
	});

	it("refuses a name that does not fit the pattern exactly", () => {
		expect(readName("2026-9-06", "YYYY-MM-DD")).toBeNull();
		expect(readName("2026-09-06 notes", "YYYY-MM-DD")).toBeNull();
		expect(readName("Shopping", "YYYY-MM-DD")).toBeNull();
	});

	it("refuses a name that fits the pattern but is not a real day", () => {
		expect(readName("2026-02-31", "YYYY-MM-DD")).toBeNull();
		expect(readName("2026-13-01", "YYYY-MM-DD")).toBeNull();
	});

	it("refuses a month name it does not know", () => {
		expect(readName("6 Smarch 2026", "D MMMM YYYY")).toBeNull();
	});

	it("says nothing rather than guessing when the pattern names no year", () => {
		expect(readName("09-06", "MM-DD")).toBeNull();
	});

	it("reads a two-digit year in the same window the app's date library uses", () => {
		expect(readName("68-01-01", "YY-MM-DD")).toEqual(day(2068, 1, 1));
		expect(readName("69-01-01", "YY-MM-DD")).toEqual(day(1969, 1, 1));
	});

	it("takes a weekday name as decoration, not as a constraint", () => {
		// The weekday says nothing the date does not. It is the round trip in
		// parseDailyLogDate that refuses a name with the wrong weekday in it.
		expect(readName("Monday 6 September 2026", "dddd D MMMM YYYY")).toEqual(day(2026, 9, 6));
	});
});

/**
 * A fabricated table, not moment's real Swedish locale, to keep this file's
 * ownership of what it means — including diacritics no test elsewhere in this
 * file writes, so a fixture exists that would fail if `fieldPattern` matched
 * these names through anything narrower than their own literal characters.
 */
const OTHER_NAMES: DateNames = {
	months: [
		"Enari",
		"Tvåari",
		"Treari",
		"Fyrari",
		"Femari",
		"Sexari",
		"Sjuari",
		"Åttari",
		"Nioari",
		"Tioari",
		"Elvari",
		"Tolvari",
	],
	monthsShort: ["Ena", "Två", "Tre", "Fyr", "Fem", "Sex", "Sju", "Ått", "Nio", "Tio", "Elv", "Tol"],
	weekdays: ["Söndär", "Måndär", "Tisdär", "Onsdär", "Torsdär", "Fredär", "Lördär"],
	weekdaysShort: ["Sön", "Mån", "Tis", "Ons", "Tor", "Fre", "Lör"],
};

describe("names supplied as data", () => {
	it("writes month and weekday names from a table handed in, not the English default", () => {
		expect(formatName(day(2026, 9, 6), "dddd D MMMM YYYY", { current: OTHER_NAMES })).toBe(
			"Söndär 6 Nioari 2026.md",
		);
		expect(formatName(day(2026, 9, 6), "ddd MMM D", { current: OTHER_NAMES })).toBe("Sön Nio 6.md");
	});

	it("reads a month name back under the same table it was written with", () => {
		const name = formatName(day(2026, 9, 6), "D MMMM YYYY", { current: OTHER_NAMES }).slice(0, -3);
		expect(readName(name, "D MMMM YYYY", { current: OTHER_NAMES })).toEqual(day(2026, 9, 6));
	});

	it("does not read a name written under one table back through another with no fallback of its own", () => {
		const name = formatName(day(2026, 9, 6), "D MMMM YYYY", { current: OTHER_NAMES }).slice(0, -3);
		expect(readName(name, "D MMMM YYYY")).toBeNull();
		expect(readName(name, "D MMMM YYYY", { current: ENGLISH_NAMES })).toBeNull();
	});

	it("falls back to the previous table when the current one does not recognise the month", () => {
		// The shape `vaultLayout.ts` needs: a name written under the language
		// active before the app's own last changed still reads back once that
		// language is handed over as `previous`.
		const name = formatName(day(2026, 9, 6), "D MMMM YYYY", { current: OTHER_NAMES }).slice(0, -3);
		expect(readName(name, "D MMMM YYYY", { current: ENGLISH_NAMES, previous: OTHER_NAMES })).toEqual(
			day(2026, 9, 6),
		);
	});

	it("still refuses a month name neither table holds", () => {
		expect(
			readName("6 Smarch 2026", "D MMMM YYYY", { current: ENGLISH_NAMES, previous: OTHER_NAMES }),
		).toBeNull();
	});

	it("reads a weekday name with diacritics as decoration, not a constraint — fieldPattern matches the name's own literal characters", () => {
		expect(readName("Måndär 6 Nioari 2026", "dddd D MMMM YYYY", { current: OTHER_NAMES })).toEqual(
			day(2026, 9, 6),
		);
	});
});

/**
 * A fabricated table whose short names carry the three shapes real moment's
 * own locales write and `fieldPattern`'s old `[\p{L}]+` group could not read
 * back: a trailing dot (French `janv.`, German `So.`), a digit fused to a
 * character (Japanese `1月`, Korean `1월`), and a combining mark (Hindi's
 * vowel signs) — issue #746. `vaultLayout.test.ts` proves the same three
 * shapes again with moment's own real locale data; this table isolates the
 * fix to this module alone.
 */
const PUNCTUATED_NAMES: DateNames = {
	months: ["1月", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
	monthsShort: ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."],
	weekdays: ["रविवार", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
	weekdaysShort: ["So.", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
};

describe("a name field carrying a dot, a digit, or a combining mark", () => {
	it("reads a short month name with a trailing dot back", () => {
		const name = formatName(day(2026, 1, 6), "D MMM YYYY", { current: PUNCTUATED_NAMES }).slice(0, -3);
		expect(name).toBe("6 janv. 2026");
		expect(readName(name, "D MMM YYYY", { current: PUNCTUATED_NAMES })).toEqual(day(2026, 1, 6));
	});

	it("does not treat the dot as a wildcard standing for any character", () => {
		// A `.` that reached the regular expression unescaped would still
		// match here, because `.` matches a literal dot along with everything
		// else — proving the escape needs a name that is not actually there.
		expect(readName("6 janvX 2026", "D MMM YYYY", { current: PUNCTUATED_NAMES })).toBeNull();
	});

	it("reads a month name that fuses a digit to a character back", () => {
		const name = formatName(day(2026, 1, 6), "D MMMM YYYY", { current: PUNCTUATED_NAMES }).slice(0, -3);
		expect(name).toBe("6 1月 2026");
		expect(readName(name, "D MMMM YYYY", { current: PUNCTUATED_NAMES })).toEqual(day(2026, 1, 6));
	});

	it("reads a weekday name carrying a combining vowel sign back", () => {
		// 4 January 2026 is a Sunday, and January is where this table's fused
		// digit-and-character month name sits, so this one date exercises both
		// of the reader's other two widened shapes at once.
		const name = formatName(day(2026, 1, 4), "dddd D MMMM YYYY", { current: PUNCTUATED_NAMES }).slice(
			0,
			-3,
		);
		expect(name).toBe("रविवार 4 1月 2026");
		expect(readName(name, "dddd D MMMM YYYY", { current: PUNCTUATED_NAMES })).toEqual(day(2026, 1, 4));
	});
});

describe("every date token is handled by both switches", () => {
	// What each token writes for Sunday 6 September 2026, and the regular
	// expression group that reads it back. The test below checks this list
	// against FIELDS itself rather than trusting either to be complete, so a
	// token added to FIELDS and to neither switch fails here.
	//
	// Keyed by `DateToken` rather than by `string`, so a token added to FIELDS
	// and not to this list is a build error here too.
	// The four name fields' groups are an alternation of the default English
	// names, longest first, computed here the same way
	// `namedFieldPattern` builds it rather than copied from its output, so a
	// change to the sort or the escaping shows up as a mismatch rather than
	// agreeing with itself.
	const longestFirst = (words: readonly string[]): string => `(${[...words].sort((a, b) => b.length - a.length).join("|")})`;

	const EXPECTED: Record<DateToken, { written: string; group: string }> = {
		YYYY: { written: "2026", group: "(\\d{4})" },
		YY: { written: "26", group: "(\\d{2})" },
		MMMM: { written: "September", group: longestFirst(ENGLISH_NAMES.months) },
		MMM: { written: "Sep", group: longestFirst(ENGLISH_NAMES.monthsShort) },
		MM: { written: "09", group: "(\\d{2})" },
		M: { written: "9", group: "(\\d{1,2})" },
		DD: { written: "06", group: "(\\d{2})" },
		D: { written: "6", group: "(\\d{1,2})" },
		dddd: { written: "Sunday", group: longestFirst(ENGLISH_NAMES.weekdays) },
		ddd: { written: "Sun", group: longestFirst(ENGLISH_NAMES.weekdaysShort) },
	};

	const tokens = Object.values(FIELDS).flat();

	it("covers exactly the tokens the table holds", () => {
		expect([...tokens].sort()).toEqual(Object.keys(EXPECTED).sort());
	});

	it("writes and matches every one of them the way it does today", () => {
		for (const token of tokens) {
			expect(formatField(token, day(2026, 9, 6))).toBe(EXPECTED[token].written);
			expect(fieldPattern(token)).toBe(EXPECTED[token].group);
		}
	});

	it("round-trips every one of them through a whole filename", () => {
		for (const token of tokens) {
			const date = day(2026, 9, 6);
			const name = formatName(date, `YYYY-MM-DD [at] ${token}`).slice(0, -3);
			expect(readName(name, `YYYY-MM-DD [at] ${token}`)).toEqual(date);
		}
	});

	it("throws rather than guessing when asked for a token the table does not hold", () => {
		// The tokeniser rejects these before either function sees them, and
		// since #147 the compiler rejects them a step earlier still — hence the
		// cast, which is how `taskLine.test.ts` reaches the same branch. This
		// is the guard under both: a token that arrives at run time from a
		// pattern somebody typed fails loudly the first time it is used,
		// instead of writing a weekday abbreviation into somebody's filename.
		const unknown = "Do" as DateToken;
		expect(() => formatField(unknown, day(2026, 9, 6))).toThrow(/Do/);
		expect(() => fieldPattern(unknown)).toThrow(/Do/);
	});
});

/* ------------------------------------------------------------------------ */
/* The field table's key constraint.                */
/* ------------------------------------------------------------------------ */

/**
 * Are these two types exactly the same one?
 *
 * Assignability in both directions is not enough — `"YY"` is assignable to
 * `string` both ways round through a widened table — so this compares the two
 * as the compiler itself does, by whether a conditional type resolves the same
 * against each.
 */
type Exactly<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
	? true
	: false;

/**
 * The three rows `keyedTokens` has to keep refusing, checked by the build itself
 * rather than by the run.
 *
 * `@ts-expect-error` is an error in its own right when the line below it
 * compiles, so widening the constraint — to `readonly string[]`, or back to
 * `` `${K}${string}` `` — fails `npx tsc --noEmit` here and says which line.
 * That is the whole of issue #301: before this, the guard had nothing checking
 * it and could have been dropped while the suite stayed green. The test file is
 * inside `tsconfig.json`'s `include`, so the compiler reads these lines on
 * every `npm run lint` and every `npm run build` — no test configuration
 * changed to make that true.
 */
// @ts-expect-error a token is a run of the key it is filed under, and "ww" is not a run of "W"
keyedTokens({ W: ["ww"] } as const);
// @ts-expect-error "Mx" begins with its key and is still not a run of it
keyedTokens({ M: ["Mx"] } as const);
// @ts-expect-error four repeats is the ceiling `Run` states, and "YYYYY" is one past it
keyedTokens({ Y: ["YYYYY"] } as const);

describe("the field table's key constraint", () => {
	it("derives exactly the tokens it derives today", () => {
		// Byte for byte the union `DateToken` was before the constraint was
		// tightened. Written out rather than derived, because a derivation from
		// FIELDS would agree with itself however FIELDS changed.
		const unchanged: Exactly<
			DateToken,
			"YY" | "YYYY" | "M" | "MM" | "MMM" | "MMMM" | "D" | "DD" | "ddd" | "dddd"
		> = true;
		expect(unchanged).toBe(true);
	});

	it("accepts a run of a key the table does not hold, and passes the table through", () => {
		// The constraint's business ends here. A row like this one type-checks,
		// and it is then issue #147 that fails the build, for the three switch
		// cases the new token would be missing.
		const extra = { H: ["H", "HH"] } as const;
		expect(keyedTokens(extra)).toBe(extra);
	});
});

describe("a month with two forms", () => {
	/**
	 * A fabricated language whose months have a form of their own inside a date,
	 * as Russian's and Polish's do. The standalone word ends in `-ari`, the
	 * in-date one in `-aria`, so a name says at a glance which form it holds.
	 */
	const STANDALONE = [
		"Enari", "Tvåari", "Treari", "Fyrari", "Femari", "Sexari",
		"Sjuari", "Åttari", "Nioari", "Tioari", "Elvari", "Tolvari",
	];
	const IN_DATE = STANDALONE.map((word) => `${word}a`);
	const STANDALONE_SHORT = ["Ena", "Två", "Tre", "Fyr", "Fem", "Sex", "Sju", "Ått", "Nio", "Tio", "Elv", "Tol"];
	const IN_DATE_SHORT = STANDALONE_SHORT.map((word) => `${word}.`);

	/**
	 * moment's rule for the default case, written out here rather than imported:
	 * a day token, whitespace or a bracketed literal, then the month
	 * (`node_modules/moment/moment.js:963`). The module under test takes the
	 * rule as a function from its caller and never carries one of its own.
	 */
	const DAY_BEFORE_MONTH = /D[oD]?(\[[^\[\]]*\]|\s)+MMMM?/;
	const TWO_FORMS: DateNames = {
		...ENGLISH_NAMES,
		months: STANDALONE,
		monthsShort: STANDALONE_SHORT,
		monthsInDate: IN_DATE,
		monthsShortInDate: IN_DATE_SHORT,
		inDateForm: (_field, format) => DAY_BEFORE_MONTH.test(format),
	};

	const everyMonth = Array.from({ length: 12 }, (_, month) => day(2026, month + 1, 5));

	it("writes the in-date form when a day number comes before the month, and the standalone form otherwise, for every month", () => {
		const cases: [string, (month: number) => string][] = [
			["D MMMM", (m) => `5 ${IN_DATE[m]}`],
			["DD MMMM", (m) => `05 ${IN_DATE[m]}`],
			["D [de] MMMM", (m) => `5 de ${IN_DATE[m]}`],
			["D MMM", (m) => `5 ${IN_DATE_SHORT[m]}`],
			["MMMM D", (m) => `${STANDALONE[m]} 5`],
			["YYYY-MMMM", (m) => `2026-${STANDALONE[m]}`],
			["D-MMMM", (m) => `5-${STANDALONE[m]}`],
			["MMM D", (m) => `${STANDALONE_SHORT[m]} 5`],
		];
		for (const date of everyMonth) {
			for (const [pattern, expected] of cases) {
				expect(formatName(date, pattern, { current: TWO_FORMS })).toBe(`${expected(date.getMonth())}.md`);
			}
		}
	});

	it("writes exactly what it wrote before under a language of one form, for the same patterns", () => {
		const names = ENGLISH_NAMES.months;
		const patterns: [string, (month: number) => string][] = [
			["D MMMM", (m) => `5 ${names[m]}`],
			["DD MMMM", (m) => `05 ${names[m]}`],
			["D [de] MMMM", (m) => `5 de ${names[m]}`],
			["D MMM", (m) => `5 ${ENGLISH_NAMES.monthsShort[m]}`],
			["MMMM D", (m) => `${names[m]} 5`],
			["YYYY-MMMM", (m) => `2026-${names[m]}`],
			["D-MMMM", (m) => `5-${names[m]}`],
		];
		for (const date of everyMonth) {
			for (const [pattern, expected] of patterns) {
				expect(formatName(date, pattern)).toBe(`${expected(date.getMonth())}.md`);
			}
		}
	});

	it("reads a month word in either form, whichever form the pattern writes", () => {
		const names = { current: TWO_FORMS };
		for (const date of everyMonth) {
			const month = date.getMonth();
			// A pattern without a year reads nothing back, so each carries one.
			expect(readName(`5 ${IN_DATE[month]} 2026`, "D MMMM YYYY", names)).toEqual(date);
			expect(readName(`5 ${STANDALONE[month]} 2026`, "D MMMM YYYY", names)).toEqual(date);
			expect(readName(`${IN_DATE[month]} 5 2026`, "MMMM D YYYY", names)).toEqual(date);
			expect(readName(`${STANDALONE[month]} 5 2026`, "MMMM D YYYY", names)).toEqual(date);
			expect(readName(`5 ${IN_DATE_SHORT[month]} 2026`, "D MMM YYYY", names)).toEqual(date);
			expect(readName(`5 ${STANDALONE_SHORT[month]} 2026`, "D MMM YYYY", names)).toEqual(date);
		}
	});

	it("lists, beside the name it writes, the same date written in the other form", () => {
		const date = day(2026, 1, 5);
		const compiled = compilePattern("D MMMM", { current: TWO_FORMS });
		expect(compiled.write(date)).toBe(`5 ${IN_DATE[0]}.md`);
		expect(compiled.writeAlso(date)).toEqual([`5 ${STANDALONE[0]}.md`]);
		// A language of one form has no other form to list.
		expect(compilePattern("D MMMM").writeAlso(date)).toEqual([]);
	});
});
