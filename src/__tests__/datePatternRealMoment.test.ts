import { describe, expect, it } from "vitest";
import realMoment from "moment";
// Every locale file registers itself with moment when imported, and moment
// makes the last one registered its global locale: reset below.
import "moment/min/locales";
import { formatName, readName } from "../core/datePattern";
import { namesFromLocale } from "../core/vaultLayout";

// `namesFromLocale` is handed a real `Locale` here, so the table is built by
// the real call from moment's own data, and the names it writes are compared
// with what real moment itself writes.
realMoment.locale("en");

/**
 * The patterns the ticket names: three where moment gives the
 * in-date form of a full month, one where it gives the in-date short form, and
 * three where it gives the standalone form — among them `D-MMMM`, where a
 * hyphen between the day and the month is not the whitespace moment's rule asks
 * for.
 */
const PATTERNS = ["D MMMM", "DD MMMM", "D [de] MMMM", "D MMM", "MMMM D", "YYYY-MMMM", "D-MMMM"];

describe("the day's-log name against real moment", () => {
	// `gom-deva` is here for its own rule, the reverse of `ca`'s: it gives the
	// in-date form to a month followed by a day number, and the standalone form
	// to a day number followed by the month
	// (`node_modules/moment/locale/gom-deva.js:41`).
	for (const code of ["ru", "pl", "ca", "gom-deva"]) {
		for (const pattern of PATTERNS) {
			it(`${code}, "${pattern}": every month is named the way moment's own format names it`, () => {
				const names = { current: namesFromLocale(realMoment.localeData(code)) };
				for (let month = 0; month < 12; month += 1) {
					const date = new Date(2026, month, 5);
					expect(formatName(date, pattern, names)).toBe(
						`${realMoment(date).locale(code).format(pattern)}.md`,
					);
				}
			});
		}
	}

	it("names every month the way moment does in every language moment has, for eighteen patterns, without throwing", () => {
		// A language's own month rule can ask more of the moment handed to it than
		// the default does, and one can carry a rule the default patterns never
		// meet (`gom-deva`'s), so the check runs over all of them rather than the
		// ones the ticket was written about.
		const patterns = [
			...PATTERNS,
			"D. MMMM YYYY", "DD-MMMM", "MMMM D YYYY", "YYYY MMM D", "D MMMM YYYY",
			"MMM D", "YYYY/MMMM/DD", "D [of] MMM YYYY", "YYYY MMMM D",
			// A language's own short-month rule can look at `-MMM-` inside the format
			// (`node_modules/moment/locale/es.js:40-48`, and `nl`, `fy` the same).
			"DD-MMM-YYYY", "D-MMM-YYYY",
		];
		// Some languages write their numerals in their own script (`ar-sa`, `bn`,
		// `mr`, …) and moment's format does too; this plugin writes `0`-`9`, which
		// is no part of this ticket. Digits are compared as the numbers they are.
		const ascii = (text: string): string =>
			text.replace(/\p{Nd}/gu, (digit) => {
				let zero = digit.codePointAt(0) as number;
				while (/\p{Nd}/u.test(String.fromCodePoint(zero - 1))) zero -= 1;
				return String((digit.codePointAt(0) as number) - zero);
			});
		const wrong: string[] = [];
		for (const code of realMoment.locales()) {
			const names = { current: namesFromLocale(realMoment.localeData(code)) };
			for (const pattern of patterns) {
				for (let month = 0; month < 12; month += 1) {
					const date = new Date(2026, month, 5);
					const expected = ascii(`${realMoment(date).locale(code).format(pattern)}.md`);
					if (formatName(date, pattern, names) !== expected) wrong.push(`${code} "${pattern}" month ${month}`);
				}
			}
		}
		expect(wrong).toEqual([]);
	});

	it("reads back the names real moment writes, in both forms", () => {
		for (const code of ["ru", "pl", "ca"]) {
			const names = { current: namesFromLocale(realMoment.localeData(code)) };
			for (let month = 0; month < 12; month += 1) {
				const date = new Date(2026, month, 5);
				// A pattern without a year reads nothing back, so each carries one.
				const inDate = realMoment(date).locale(code).format("D MMMM YYYY");
				expect(readName(inDate, "D MMMM YYYY", names)).toEqual(date);
				const standalone = realMoment(date).locale(code).format("MMMM");
				expect(readName(`5 ${standalone} 2026`, "D MMMM YYYY", names)).toEqual(date);
			}
		}
	});

	it("reads back, in every language moment has, the name moment writes for DD-MMM-YYYY and D-MMM-YYYY", () => {
		// `es`, `es-do`, `es-mx`, `es-us`, `nl`, `nl-be` and `fy` write the short month
		// without its dot when the format holds `-MMM-`, and with it otherwise.
		const ascii = (text: string): string =>
			text.replace(/\p{Nd}/gu, (digit) => {
				let zero = digit.codePointAt(0) as number;
				while (/\p{Nd}/u.test(String.fromCodePoint(zero - 1))) zero -= 1;
				return String((digit.codePointAt(0) as number) - zero);
			});
		const unread: string[] = [];
		for (const code of realMoment.locales()) {
			const names = { current: namesFromLocale(realMoment.localeData(code)) };
			for (const pattern of ["DD-MMM-YYYY", "D-MMM-YYYY"]) {
				for (let month = 0; month < 12; month += 1) {
					const date = new Date(2026, month, 5);
					const written = ascii(realMoment(date).locale(code).format(pattern));
					if (readName(written, pattern, names)?.getTime() !== date.getTime()) {
						unread.push(`${code} "${pattern}" ${written}`);
					}
				}
			}
		}
		expect(unread).toEqual([]);
	});
});
