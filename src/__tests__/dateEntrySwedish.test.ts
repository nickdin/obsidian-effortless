/**
 * Unit tests for `parseSwedish`.
 *
 * Ported from `task-date-inserter/src/swedish-date-parser.test.ts` (56
 * tests), unchanged except the one the ticket names: the parser's two
 * old exported functions are now one, `parseSwedish`, answering `{ date,
 * phrase }` instead of a bare `Date` or a bare `Date` + `label`, so every
 * ported test now reads its expectation off that shape.
 *
 * All tests use a fixed reference day, `2026-03-31` (a Tuesday), built from
 * local parts — `new Date(2026, 2, 31)` — and every date is read back
 * through `getFullYear`/`getMonth`/`getDate`, never `toISOString`, so the
 * suite means the same thing regardless of the machine's time zone.
 */

import { describe, expect, it } from "vitest";
import { parseSwedish } from "../features/dateEntry/swedish";

// Fixed reference: Tuesday, 31 March 2026
const REF = new Date(2026, 2, 31);

/** Formats a Date as YYYY-MM-DD from local parts, for readable assertions. */
function fmt(d: Date | null): string | null {
	if (d === null) return null;
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

/** The date `parseSwedish` answers for `input` against `ref`, as `YYYY-MM-DD`, or null. */
function dateOf(input: string, ref: Date = REF): string | null {
	return fmt(parseSwedish(input, ref)?.date ?? null);
}

// ---------------------------------------------------------------------------
// Ported: basic relative expressions, weekdays, "nästa …", "om N dagar",
// specific dates, edge cases — dates unchanged from the old parser.
// ---------------------------------------------------------------------------

describe("parseSwedish — basic relative expressions", () => {
	it("idag → 2026-03-31", () => {
		expect(dateOf("idag")).toBe("2026-03-31");
	});
	it("i dag → 2026-03-31", () => {
		expect(dateOf("i dag")).toBe("2026-03-31");
	});
	it("imorgon → 2026-04-01", () => {
		expect(dateOf("imorgon")).toBe("2026-04-01");
	});
	it("i morgon → 2026-04-01", () => {
		expect(dateOf("i morgon")).toBe("2026-04-01");
	});
	it("igår → 2026-03-30", () => {
		expect(dateOf("igår")).toBe("2026-03-30");
	});
	it("övermorgon → 2026-04-02", () => {
		expect(dateOf("övermorgon")).toBe("2026-04-02");
	});
});

describe("parseSwedish — weekdays (ref = Tuesday 31 March)", () => {
	// nextWeekday starts from tomorrow (Wednesday 1 April) and seeks forward

	it("måndag → 2026-04-06 (the coming Monday, 6 days from tomorrow)", () => {
		expect(dateOf("måndag")).toBe("2026-04-06");
	});
	it("tisdag → 2026-04-07 (never today; searching from tomorrow, 6 days to Tuesday)", () => {
		expect(dateOf("tisdag")).toBe("2026-04-07");
	});
	it("onsdag → 2026-04-01 (tomorrow is Wednesday)", () => {
		expect(dateOf("onsdag")).toBe("2026-04-01");
	});
	it("fredag → 2026-04-03", () => {
		expect(dateOf("fredag")).toBe("2026-04-03");
	});
	it("torsdag → 2026-04-02", () => {
		expect(dateOf("torsdag")).toBe("2026-04-02");
	});
	it("lördag → 2026-04-04", () => {
		expect(dateOf("lördag")).toBe("2026-04-04");
	});
	it("söndag → 2026-04-05", () => {
		expect(dateOf("söndag")).toBe("2026-04-05");
	});

	// Short forms
	it("mån → 2026-04-06 (short form of måndag)", () => {
		expect(dateOf("mån")).toBe("2026-04-06");
	});
	it("tis → 2026-04-07 (short form of tisdag)", () => {
		expect(dateOf("tis")).toBe("2026-04-07");
	});
	it("ons → 2026-04-01", () => {
		expect(dateOf("ons")).toBe("2026-04-01");
	});
	it("tor → 2026-04-02", () => {
		expect(dateOf("tor")).toBe("2026-04-02");
	});
	it("fre → 2026-04-03", () => {
		expect(dateOf("fre")).toBe("2026-04-03");
	});
});

describe('parseSwedish — "nästa vecka"', () => {
	it("nästa vecka (ref=Tuesday) → 2026-04-06 (nearest Monday ahead)", () => {
		// nextWeekday(Tuesday, Monday) starts from Wednesday and searches forward → Monday 6 April
		expect(dateOf("nästa vecka")).toBe("2026-04-06");
	});

	it("nästa vecka (ref=Monday 30 March) → 2026-04-06 (nearest Monday = 7 days ahead)", () => {
		const refMonday = new Date(2026, 2, 30); // Monday
		expect(dateOf("nästa vecka", refMonday)).toBe("2026-04-06");
	});

	it("nästa vecka (ref=Sunday 29 March) → 2026-03-30 (tomorrow is Monday)", () => {
		const refSunday = new Date(2026, 2, 29); // Sunday
		expect(dateOf("nästa vecka", refSunday)).toBe("2026-03-30");
	});
});

describe('parseSwedish — "nästa [veckodag]"', () => {
	// nextWeekdayAtLeastOneWeek: d = ref + 8, then searches forward
	// Ensures "nästa [veckodag]" always skips past the nearest occurrence

	it("nästa måndag (ref=Tuesday) → 2026-04-13", () => {
		// ref+8 = Wednesday 8 April → search forward → Monday 13 April
		expect(dateOf("nästa måndag")).toBe("2026-04-13");
	});

	it("nästa onsdag (ref=Tuesday) → 2026-04-08", () => {
		// ref+8 = Wednesday 8 April → matches directly
		expect(dateOf("nästa onsdag")).toBe("2026-04-08");
	});

	it("nästa tisdag (ref=Tuesday) → 2026-04-14", () => {
		// ref+8 = Wednesday 8 April → search forward → Tuesday 14 April
		// "nästa tisdag" must always skip past the nearest Tuesday (7 days away)
		expect(dateOf("nästa tisdag")).toBe("2026-04-14");
	});

	it("nästa fredag (ref=Tuesday) → 2026-04-10", () => {
		// 7 April = Tuesday → Wed, Thu, Fri = 10 April
		expect(dateOf("nästa fredag")).toBe("2026-04-10");
	});
});

describe('parseSwedish — "om N dagar"', () => {
	it("om 1 dagar → 2026-04-01", () => {
		expect(dateOf("om 1 dagar")).toBe("2026-04-01");
	});
	it("om 7 dagar → 2026-04-07", () => {
		expect(dateOf("om 7 dagar")).toBe("2026-04-07");
	});
	it("om 30 dagar → 2026-04-30", () => {
		expect(dateOf("om 30 dagar")).toBe("2026-04-30");
	});
	it("om 1 dag → 2026-04-01 (singular)", () => {
		expect(dateOf("om 1 dag")).toBe("2026-04-01");
	});
});

describe("parseSwedish — specific dates", () => {
	it("15 april → 2026-04-15", () => {
		expect(dateOf("15 april")).toBe("2026-04-15");
	});
	it("apr 15 → 2026-04-15", () => {
		expect(dateOf("apr 15")).toBe("2026-04-15");
	});
	it("2026-04-15 → 2026-04-15 (ISO)", () => {
		expect(dateOf("2026-04-15")).toBe("2026-04-15");
	});
	it("15 mars → 2027-03-15 (already past at ref 2026-03-31)", () => {
		// 15 March 2026 < 31 March 2026 → next year
		expect(dateOf("15 mars")).toBe("2027-03-15");
	});
	it("1 april → 2026-04-01 (still ahead this year)", () => {
		expect(dateOf("1 april")).toBe("2026-04-01");
	});
});

describe("parseSwedish — edge cases", () => {
	it("29 februari (ref=2026, not a leap year) → null", () => {
		expect(parseSwedish("29 februari", REF)).toBeNull();
	});
	it("30 februari → null", () => {
		expect(parseSwedish("30 februari", REF)).toBeNull();
	});
	it("empty string → null", () => {
		expect(parseSwedish("", REF)).toBeNull();
	});
	it("nonsens → null", () => {
		expect(parseSwedish("nonsens", REF)).toBeNull();
	});
	it("  idag   → 2026-03-31 (trimmed)", () => {
		expect(dateOf("  idag  ")).toBe("2026-03-31");
	});
	it("IDAG → 2026-03-31 (case-insensitive)", () => {
		expect(dateOf("IDAG")).toBe("2026-03-31");
	});
});

// ---------------------------------------------------------------------------
// Ported: prefix matching against the candidate table — now asserted through
// `phrase` (the old parser called this a "label").
// ---------------------------------------------------------------------------

describe("parseSwedish — prefix matching", () => {
	it('"i" → phrase: "idag", date: 2026-03-31', () => {
		const result = parseSwedish("i", REF);
		expect(result).not.toBeNull();
		expect(result!.phrase).toBe("idag");
		expect(fmt(result!.date)).toBe("2026-03-31");
	});

	it('"im" → phrase: "imorgon", date: 2026-04-01', () => {
		const result = parseSwedish("im", REF);
		expect(result).not.toBeNull();
		expect(result!.phrase).toBe("imorgon");
		expect(fmt(result!.date)).toBe("2026-04-01");
	});

	it('"ö" → phrase: "övermorgon", date: 2026-04-02', () => {
		const result = parseSwedish("ö", REF);
		expect(result).not.toBeNull();
		expect(result!.phrase).toBe("övermorgon");
		expect(fmt(result!.date)).toBe("2026-04-02");
	});

	it('"mån" → phrase: "måndag" (the full phrase, not what was typed), date: 2026-04-06', () => {
		// Old parser's line 218 asserted label "mån" here — the exact match was
		// delegated straight back to the input. Issue #14 in the old
		// task-date-inserter plugin's tracker: the phrase is now always the full
		// phrase the date came from.
		const result = parseSwedish("mån", REF);
		expect(result).not.toBeNull();
		expect(result!.phrase).toBe("måndag");
		expect(fmt(result!.date)).toBe("2026-04-06");
	});

	it('"nästa m" → phrase: "nästa måndag", date: 2026-04-13', () => {
		const result = parseSwedish("nästa m", REF);
		expect(result).not.toBeNull();
		expect(result!.phrase).toBe("nästa måndag");
		expect(fmt(result!.date)).toBe("2026-04-13");
	});

	it('"nästa v" → phrase: "nästa vecka", date: 2026-04-06', () => {
		const result = parseSwedish("nästa v", REF);
		expect(result).not.toBeNull();
		expect(result!.phrase).toBe("nästa vecka");
		expect(fmt(result!.date)).toBe("2026-04-06");
	});

	it('"" → null', () => {
		expect(parseSwedish("", REF)).toBeNull();
	});

	it('"xyz" → null', () => {
		expect(parseSwedish("xyz", REF)).toBeNull();
	});

	// Partial matching on "igår": "ig", "igå" and the ASCII fallback "iga" all
	// offer "igår", dated yesterday.
	it('"ig" → phrase: "igår", date: 2026-03-30', () => {
		const result = parseSwedish("ig", REF);
		expect(result).not.toBeNull();
		expect(result!.phrase).toBe("igår");
		expect(fmt(result!.date)).toBe("2026-03-30");
	});

	it('"igå" → phrase: "igår", date: 2026-03-30', () => {
		const result = parseSwedish("igå", REF);
		expect(result).not.toBeNull();
		expect(result!.phrase).toBe("igår");
		expect(fmt(result!.date)).toBe("2026-03-30");
	});

	it('"iga" → phrase: "igår", date: 2026-03-30 (ASCII fallback)', () => {
		const result = parseSwedish("iga", REF);
		expect(result).not.toBeNull();
		expect(result!.phrase).toBe("igår");
		expect(fmt(result!.date)).toBe("2026-03-30");
	});

	// Regression test: "id" must not collide with the "ig" rows
	it('"id" → phrase: "idag", date: 2026-03-31 (regression after the "ig" rows were added)', () => {
		const result = parseSwedish("id", REF);
		expect(result).not.toBeNull();
		expect(result!.phrase).toBe("idag");
		expect(fmt(result!.date)).toBe("2026-03-31");
	});
});

describe("parseSwedish — input already the full phrase", () => {
	it('"idag" → phrase: "idag", date: 2026-03-31', () => {
		const result = parseSwedish("idag", REF);
		expect(result).not.toBeNull();
		expect(result!.phrase).toBe("idag");
		expect(fmt(result!.date)).toBe("2026-03-31");
	});

	it('"måndag" → phrase: "måndag", date: 2026-04-06', () => {
		const result = parseSwedish("måndag", REF);
		expect(result).not.toBeNull();
		expect(result!.phrase).toBe("måndag");
		expect(fmt(result!.date)).toBe("2026-04-06");
	});

	it('"nästa vecka" → phrase: "nästa vecka", date: 2026-04-06', () => {
		const result = parseSwedish("nästa vecka", REF);
		expect(result).not.toBeNull();
		expect(result!.phrase).toBe("nästa vecka");
		expect(fmt(result!.date)).toBe("2026-04-06");
	});

	it('"om 3 dagar" → phrase: "om 3 dagar" (no table row stands behind it), date: 2026-04-03', () => {
		const result = parseSwedish("om 3 dagar", REF);
		expect(result).not.toBeNull();
		expect(result!.phrase).toBe("om 3 dagar");
		expect(fmt(result!.date)).toBe("2026-04-03");
	});
});

// ---------------------------------------------------------------------------
// New for #576: the full-phrase answer for other short forms, and the one
// input that must stop parsing.
// ---------------------------------------------------------------------------

describe("parseSwedish — full phrase for other short and ASCII forms", () => {
	it('"nästa tor" → phrase: "nästa torsdag", date: 2026-04-09', () => {
		const result = parseSwedish("nästa tor", REF);
		expect(result).not.toBeNull();
		expect(result!.phrase).toBe("nästa torsdag");
		expect(fmt(result!.date)).toBe("2026-04-09");
	});

	it('"overmorgon" (ASCII) → phrase: "övermorgon", date: 2026-04-02', () => {
		const result = parseSwedish("overmorgon", REF);
		expect(result).not.toBeNull();
		expect(result!.phrase).toBe("övermorgon");
		expect(fmt(result!.date)).toBe("2026-04-02");
	});

	it('"nästa t" → phrase: "nästa tisdag" (row order: tisdag before torsdag), date: 2026-04-14', () => {
		const result = parseSwedish("nästa t", REF);
		expect(result).not.toBeNull();
		expect(result!.phrase).toBe("nästa tisdag");
		expect(fmt(result!.date)).toBe("2026-04-14");
	});

	it('"15 april" → phrase: "15 april" (no table row stands behind it), date: 2026-04-15', () => {
		const result = parseSwedish("15 april", REF);
		expect(result).not.toBeNull();
		expect(result!.phrase).toBe("15 april");
		expect(fmt(result!.date)).toBe("2026-04-15");
	});

	it('"överi morgon" → null (find-and-replace residue, issue #5 in the old task-date-inserter tracker; not Swedish)', () => {
		expect(parseSwedish("överi morgon", REF)).toBeNull();
	});
});

describe("parseSwedish — input that names no table entry", () => {
	// Every keystroke after the trigger reaches the parser on Obsidian's one
	// thread, so an input must answer promptly with a date or with nothing.
	// These are the lower-case keys every plain object inherits (input is
	// lower-cased before any lookup); looked up in a word table, they used to
	// hand a function to the weekday loop, which never ended.
	it.each(["constructor", "__proto__", "nästa constructor", "nästa __proto__", "nasta constructor"])(
		'"%s" → null, and answers at once',
		(input) => {
			expect(parseSwedish(input, REF)).toBeNull();
		},
		1000,
	);

	it.each(["15 constructor", "constructor 15", "15 __proto__"])('"%s" → null', (input) => {
		expect(parseSwedish(input, REF)).toBeNull();
	});

	it('"om 99999999 dagar" → null: a day count past the calendar is no date', () => {
		expect(parseSwedish("om 99999999 dagar", REF)).toBeNull();
	});

	it('"om 400 dagar" still answers, four hundred days out', () => {
		const result = parseSwedish("om 400 dagar", REF);
		expect(result).not.toBeNull();
		expect(fmt(result!.date)).toBe("2027-05-05");
	});
});
