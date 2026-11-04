import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { ENGLISH_PHRASES, parseEnglish } from "../features/dateEntry/english";

/** A local date, since a day's log is named after the local day. */
const day = (y: number, m: number, d: number): Date => new Date(y, m - 1, d);

/** Reference Thursday, #578's table and #24's measurements are pinned to it. */
const THURSDAY = day(2026, 9, 3);
/** Where `monday`, `next monday` and `next week` collide, per #578. */
const MONDAY = day(2026, 9, 7);
/** Where `next week` reaches only one day out, per #578. */
const SUNDAY = day(2026, 9, 6);

const WEEKDAYS = [
	"sunday",
	"monday",
	"tuesday",
	"wednesday",
	"thursday",
	"friday",
	"saturday",
] as const;

describe("the candidate list", () => {
	it("holds exactly the phrases the ticket enumerates, in that order", () => {
		// #24's resolution and #578's own body both call this a "twenty-phrase
		// list" in prose, but each enumerates the same nineteen entries: five
		// standalone phrases, the seven weekdays, the seven `next <weekday>`s.
		// This test is built to what is enumerated, not to the rounded count —
		// see english.ts's own note above the list.
		expect(ENGLISH_PHRASES).toEqual([
			"today",
			"tomorrow",
			"day after tomorrow",
			"yesterday",
			"next week",
			"monday",
			"tuesday",
			"wednesday",
			"thursday",
			"friday",
			"saturday",
			"sunday",
			"next monday",
			"next tuesday",
			"next wednesday",
			"next thursday",
			"next friday",
			"next saturday",
			"next sunday",
		]);
	});
});

describe("only the English locale of chrono is imported", () => {
	// An absence: the property is about what ends up in the built plugin, which
	// this suite cannot drive, so it is read from source instead
	// (src/__tests__/testConventions.test.ts's own rule for when that is right).
	it("imports chrono-node/en, and no other chrono-node path", () => {
		const source = readFileSync(
			resolve(__dirname, "..", "features", "dateEntry", "english.ts"),
			"utf8",
		);
		const imports = source.match(/from\s+["']chrono-node[^"']*["']/g) ?? [];
		expect(imports).toEqual(['from "chrono-node/en"']);
	});
});

describe("the table, reference Thursday 2026-09-03", () => {
	it.each([
		["t", "today", day(2026, 9, 3)],
		["tom", "tomorrow", day(2026, 9, 4)],
		["d", "day after tomorrow", day(2026, 9, 5)],
		["y", "yesterday", day(2026, 9, 2)],
		["n", "next week", day(2026, 9, 7)],
		["next", "next week", day(2026, 9, 7)],
		["next m", "next monday", day(2026, 9, 7)],
		["next f", "next friday", day(2026, 9, 11)],
		["m", "monday", day(2026, 9, 7)],
		["mon", "monday", day(2026, 9, 7)],
		["th", "thursday", day(2026, 9, 10)],
		["thu", "thursday", day(2026, 9, 10)],
		["tue", "tuesday", day(2026, 9, 8)],
		["tues", "tuesday", day(2026, 9, 8)],
		["in 3 days", "in 3 days", day(2026, 9, 6)],
		["15 april", "15 april", day(2027, 4, 15)],
	])("%s -> %s, %s", (input, phrase, date) => {
		expect(parseEnglish(input, THURSDAY)).toEqual({ date, phrase });
	});

	it("answers nothing for xyz", () => {
		expect(parseEnglish("xyz", THURSDAY)).toBeNull();
	});
});

describe("Monday and Sunday references (#578 criteria 3, 4)", () => {
	it("gives 2026-09-14 for monday, next monday and next week on Monday 2026-09-07", () => {
		const expected = day(2026, 9, 14);
		expect(parseEnglish("monday", MONDAY)).toEqual({ date: expected, phrase: "monday" });
		expect(parseEnglish("next monday", MONDAY)).toEqual({
			date: expected,
			phrase: "next monday",
		});
		expect(parseEnglish("next week", MONDAY)).toEqual({ date: expected, phrase: "next week" });
	});

	it("gives 2026-09-07 for next week on Sunday 2026-09-06", () => {
		expect(parseEnglish("next week", SUNDAY)).toEqual({
			date: day(2026, 9, 7),
			phrase: "next week",
		});
	});
});

describe("a bare weekday never answers today", () => {
	it.each([
		["Thursday", THURSDAY],
		["Monday", MONDAY],
		["Sunday", SUNDAY],
	])("on %s, for all seven weekdays", (_label, reference) => {
		for (const weekday of WEEKDAYS) {
			const answer = parseEnglish(weekday, reference);
			expect(answer).not.toBeNull();
			expect(answer?.date).not.toEqual(localMidnightOf(reference));
		}
	});
});

/** `reference` itself, at local midnight — the shape every answer is in. */
function localMidnightOf(reference: Date): Date {
	return day(reference.getFullYear(), reference.getMonth() + 1, reference.getDate());
}

describe("next <weekday> follows chrono's following-week rule", () => {
	// The following Monday-to-Sunday week after Thursday 2026-09-03 (which
	// falls in the Mon 08-31 - Sun 09-06 week) is Mon 09-07 - Sun 09-13,
	// exactly as #24 measured chrono's own answers.
	it.each([
		["next monday", day(2026, 9, 7)],
		["next tuesday", day(2026, 9, 8)],
		["next wednesday", day(2026, 9, 9)],
		["next thursday", day(2026, 9, 10)],
		["next friday", day(2026, 9, 11)],
		["next saturday", day(2026, 9, 12)],
		["next sunday", day(2026, 9, 13)],
	])("%s -> %s", (phrase, date) => {
		expect(parseEnglish(phrase, THURSDAY)).toEqual({ date, phrase });
	});
});

describe("next m and next s never reach the fallback", () => {
	it("next m answers next monday, not chrono's misreading of a lone m as a minute", () => {
		expect(parseEnglish("next m", THURSDAY)).toEqual({
			date: day(2026, 9, 7),
			phrase: "next monday",
		});
	});

	it("next s answers next saturday, not chrono's misreading of a lone s as a second", () => {
		expect(parseEnglish("next s", THURSDAY)).toEqual({
			date: day(2026, 9, 12),
			phrase: "next saturday",
		});
	});
});

describe("an unmatched input falls to chrono, carrying the input as its phrase", () => {
	it("trims and lower-cases the input for the phrase chrono did not match against the list", () => {
		expect(parseEnglish("  In 3 Days  ", THURSDAY)).toEqual({
			date: day(2026, 9, 6),
			phrase: "in 3 days",
		});
	});
});
