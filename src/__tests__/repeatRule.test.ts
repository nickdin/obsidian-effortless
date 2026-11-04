import { describe, expect, it } from "vitest";
import {
	daysBetween,
	firstRepeatDate,
	nextRepeatDate,
	readRepeatRule,
	shiftDate,
	writeRepeatRule,
	type RepeatRule,
} from "../core/repeatRule";

/** Reads a string that must be in the subset. */
function rule(text: string): RepeatRule {
	const read = readRepeatRule(text);
	if (read === null) throw new Error(`fixture is not a repeat rule: ${text}`);
	return read;
}

/** The next date of a rule given as text. */
function next(text: string, own: string | null, today: string): string | null {
	return nextRepeatDate(rule(text), own, today);
}

describe("reading and writing a repeat rule", () => {
	// One canonical string per family of the subset, and the odd ones inside it.
	const canonical = [
		"every day",
		"every 3 days",
		"every week",
		"every 2 weeks",
		"every month",
		"every 6 months",
		"every year",
		"every 2 years",
		"every week on Monday",
		"every week on Monday, Thursday",
		"every 2 weeks on Monday, Thursday",
		"every 3 weeks on Saturday, Sunday",
		"every week on Monday, Tuesday, Wednesday, Thursday, Friday, Saturday",
		"every weekday",
		"every month on the 1st",
		"every month on the 2nd",
		"every month on the 3rd",
		"every month on the 4th",
		"every month on the 11th",
		"every month on the 12th",
		"every month on the 13th",
		"every month on the 21st",
		"every month on the 22nd",
		"every month on the 23rd",
		"every month on the 31st",
		"every month on the 1st and 15th",
		"every 2 months on the 1st and 31st",
		"every month on the last",
		"every 3 months on the last",
		"every day when done",
		"every 3 days when done",
		"every week on Monday when done",
		"every weekday when done",
		"every month on the 1st and 15th when done",
		"every month on the last when done",
	];

	it.each(canonical)("reads %s and writes it back byte for byte", (text) => {
		const read = readRepeatRule(text);
		expect(read).not.toBeNull();
		expect(writeRepeatRule(read as RepeatRule)).toBe(text);
	});

	it("reads each family to the rule it names", () => {
		expect(rule("every 2 weeks on Monday, Thursday")).toEqual({
			unit: "week",
			interval: 2,
			weekdays: [0, 3],
			monthDays: null,
			whenDone: false,
		});
		expect(rule("every month on the 1st and 15th")).toEqual({
			unit: "month",
			interval: 1,
			weekdays: null,
			monthDays: [1, 15],
			whenDone: false,
		});
		expect(rule("every month on the last").monthDays).toEqual(["last"]);
		expect(rule("every 3 days when done")).toEqual({
			unit: "day",
			interval: 3,
			weekdays: null,
			monthDays: null,
			whenDone: true,
		});
		expect(rule("every weekday")).toMatchObject({ unit: "week", interval: 1, weekdays: [0, 1, 2, 3, 4] });
	});

	it("reads Every Week to the same rule as every week and writes every week", () => {
		expect(rule("Every Week")).toEqual(rule("every week"));
		expect(writeRepeatRule(rule("Every Week"))).toBe("every week");
		expect(rule("EVERY WEEK ON MONDAY, THURSDAY")).toEqual(rule("every week on Monday, Thursday"));
		expect(writeRepeatRule(rule("every week on monday"))).toBe("every week on Monday");
		expect(writeRepeatRule(rule("every month on the 31ST"))).toBe("every month on the 31st");
		expect(writeRepeatRule(rule("every 3 days When Done"))).toBe("every 3 days when done");
	});

	// The named refusals, then the rest of what the Tasks plugin would accept and
	// rewrite. `null` is the module's only refusal, so the name is the case.
	const refused = [
		"every month on the 31",
		"every week on Mon",
		"every week on Monday and Thursday",
		"every 1 week",
		"every week on Thursday, Monday",
		"every week until 2027-01-01",
		"every day for 3 times",
		"every month on the 2nd Wednesday",
		// More of the same kind.
		"every Monday",
		"every week on Monday,Thursday",
		"every week on Monday, Monday",
		"every week on Monday, Tuesday, Wednesday, Thursday, Friday",
		"every 2 weeks on Monday, Tuesday, Wednesday, Thursday, Friday",
		"every week on Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday",
		"every month on the first",
		"every month on the 1",
		"every month on the 1th",
		"every month on the 11st",
		"every month on the 32nd",
		"every month on the 0th",
		"every month on the 01st",
		"every month on the 15th and 1st",
		"every month on the 1st, 15th",
		"every month on the 1st and 15th and 20th",
		"every month on the 1st and 1st",
		"every month on the 1st and last",
		"every month on the last day",
		"every month on 1st",
		"every year on January 1st",
		"every year on the 1st",
		"every day on Monday",
		"every 1 day",
		"every 0 days",
		"every 01 days",
		"every +3 days",
		"every 1000 days",
		"every 3 day",
		"every days",
		"every 2 week",
		"every 2 weeks on",
		"every",
		"",
		"every  day",
		"every day ",
		" every day",
		"every day when done when done",
		"every day when  done",
		" when done",
		"when done",
		"week",
		"daily",
		"every weekday on Monday",
		"every 2 weekdays",
		// Kelvin sign for the k of "weeks": case folding must not widen the words.
		"every 2 weeKs",
	];

	it.each(refused)("refuses %j", (text) => {
		expect(readRepeatRule(text)).toBeNull();
	});

	it("throws on writing a rule the subset cannot say", () => {
		const base = rule("every week");
		expect(() => writeRepeatRule({ ...base, interval: 0 })).toThrow(RangeError);
		expect(() => writeRepeatRule({ ...base, weekdays: [3, 0] })).toThrow(RangeError);
		expect(() => writeRepeatRule({ ...base, weekdays: [] })).toThrow(RangeError);
		expect(() => writeRepeatRule({ ...base, unit: "day", weekdays: [0] })).toThrow(RangeError);
		expect(() => writeRepeatRule({ ...base, interval: 2000 })).toThrow(RangeError);
	});
});

describe("the next date of a fixed rule", () => {
	it("gives the next date on the rhythm for a tick on time", () => {
		expect(next("every 3 days", "2026-10-10", "2026-10-10")).toBe("2026-10-13");
		expect(next("every 3 days", "2026-10-10", "2026-10-09")).toBe("2026-10-13");
		expect(next("every week", "2026-10-10", "2026-10-11")).toBe("2026-10-17");
		expect(next("every 2 weeks", "2026-10-10", "2026-10-10")).toBe("2026-10-24");
		expect(next("every month", "2026-10-10", "2026-10-10")).toBe("2026-11-10");
		expect(next("every 3 months", "2026-10-10", "2026-10-10")).toBe("2027-01-10");
		expect(next("every year", "2026-10-10", "2026-10-10")).toBe("2027-10-10");
		expect(next("every week on Monday", "2026-10-26", "2026-10-26")).toBe("2026-11-02");
		expect(next("every weekday", "2026-10-30", "2026-10-30")).toBe("2026-11-02");
		expect(next("every month on the 1st and 15th", "2026-10-01", "2026-10-01")).toBe("2026-10-15");
		expect(next("every month on the 1st and 15th", "2026-10-15", "2026-10-15")).toBe("2026-11-01");
	});

	it("gives one date not before today for a late tick, on the rhythm", () => {
		// Own date 2026-10-01, ticked 2026-10-20: three days from the 1st lands on
		// the 1st, 4th, … 19th, 22nd. The 22nd, not the 4th and not the 23rd.
		expect(next("every 3 days", "2026-10-01", "2026-10-20")).toBe("2026-10-22");
		expect(next("every week", "2026-10-01", "2026-10-20")).toBe("2026-10-22");
		expect(next("every 2 weeks", "2026-10-01", "2026-10-20")).toBe("2026-10-29");
		expect(next("every month", "2026-08-10", "2026-10-20")).toBe("2026-11-10");
		expect(next("every year", "2023-05-05", "2026-10-20")).toBe("2027-05-05");
		expect(next("every week on Monday", "2026-10-05", "2026-10-21")).toBe("2026-10-26");
		expect(next("every 2 weeks on Monday", "2026-10-05", "2026-10-21")).toBe("2026-11-02");
		expect(next("every month on the 15th", "2026-07-15", "2026-10-20")).toBe("2026-11-15");
		expect(next("every month on the last", "2026-07-31", "2026-10-20")).toBe("2026-10-31");
	});

	it("gives the first date after today when the own date is today", () => {
		expect(next("every day", "2026-10-20", "2026-10-20")).toBe("2026-10-21");
		expect(next("every week on Tuesday", "2026-10-20", "2026-10-20")).toBe("2026-10-27");
		expect(next("every month on the 20th", "2026-10-20", "2026-10-20")).toBe("2026-11-20");
	});

	it("goes on from an own date that is still ahead of today", () => {
		expect(next("every 3 days", "2026-10-25", "2026-10-20")).toBe("2026-10-28");
		expect(next("every week on Monday", "2026-10-26", "2026-10-20")).toBe("2026-11-02");
	});

	it("follows the Tasks plugin across the end of a month", () => {
		expect(next("every month on the 31st", "2026-01-31", "2026-01-31")).toBe("2026-03-31");
		expect(next("every month on the last", "2026-01-31", "2026-01-31")).toBe("2026-02-28");
		expect(next("every month on the last", "2028-01-31", "2028-01-31")).toBe("2028-02-29");
		expect(next("every month on the last", "2026-02-28", "2026-02-28")).toBe("2026-03-31");
		expect(next("every month", "2026-01-31", "2026-01-31")).toBe("2026-02-28");
		expect(next("every month", "2028-01-31", "2028-01-31")).toBe("2028-02-29");
		expect(next("every 2 months", "2026-12-31", "2026-12-31")).toBe("2027-02-28");
		expect(next("every month on the 30th", "2026-01-30", "2026-01-30")).toBe("2026-03-30");
		expect(next("every year", "2028-02-29", "2028-02-29")).toBe("2029-02-28");
		expect(next("every year", "2024-02-29", "2026-10-20")).toBe("2027-02-28");
		expect(next("every 4 years", "2024-02-29", "2024-02-29")).toBe("2028-02-29");
	});

	it("counts weeks from the own date's week, Monday first", () => {
		// Wednesday 2026-10-28: two weeks on Monday is 2026-11-09, not 11-02.
		expect(next("every 2 weeks on Monday", "2026-10-28", "2026-10-28")).toBe("2026-11-09");
		// Monday 2026-10-26: Thursday of the same week, then Monday two weeks on.
		expect(next("every 2 weeks on Monday, Thursday", "2026-10-26", "2026-10-26")).toBe("2026-10-29");
		expect(next("every 2 weeks on Monday, Thursday", "2026-10-29", "2026-10-29")).toBe("2026-11-09");
		// Sunday ends the week it is in: the next Monday is the very next day.
		expect(next("every week on Monday", "2026-11-01", "2026-11-01")).toBe("2026-11-02");
	});

	it("gives null when no date can be counted", () => {
		expect(next("every week", null, "2026-10-20")).toBeNull();
		expect(next("every week", "2026-02-30", "2026-10-20")).toBeNull();
		expect(next("every week", "not a date", "2026-10-20")).toBeNull();
		// February never has a 30th, and twelve months on is February again.
		expect(next("every 12 months on the 30th", "2026-02-10", "2026-02-10")).toBeNull();
		expect(next("every 4 years", "9998-01-01", "9998-01-01")).toBeNull();
	});

	it("throws for a today that is not a day", () => {
		expect(() => next("every week", "2026-10-20", "2026-13-01")).toThrow(RangeError);
	});
});

describe("the next date of a when-done rule", () => {
	it("gives the first date strictly after today, whatever the own date", () => {
		for (const own of ["2026-01-01", "2026-10-20", "2026-12-24", null, "garbage"]) {
			expect(next("every 3 days when done", own, "2026-10-20")).toBe("2026-10-23");
		}
		expect(next("every week when done", "2026-10-10", "2026-10-20")).toBe("2026-10-27");
		expect(next("every month when done", "2026-10-10", "2026-10-20")).toBe("2026-11-20");
		expect(next("every year when done", "2026-10-10", "2026-10-20")).toBe("2027-10-20");
		expect(next("every week on Monday when done", "2026-10-10", "2026-10-26")).toBe("2026-11-02");
		expect(next("every week on Monday when done", "2026-10-10", "2026-10-22")).toBe("2026-10-26");
		expect(next("every month on the 1st when done", "2026-10-10", "2026-10-01")).toBe("2026-11-01");
	});

	it("keeps the month-end rules of a fixed rule, counted from today", () => {
		expect(next("every month when done", null, "2026-01-31")).toBe("2026-02-28");
		expect(next("every month on the last when done", null, "2026-01-31")).toBe("2026-02-28");
		expect(next("every month on the 31st when done", null, "2026-01-31")).toBe("2026-03-31");
		expect(next("every 2 weeks on Monday when done", null, "2026-10-28")).toBe("2026-11-09");
	});
});

describe("a rule whose day list is empty", () => {
	// A value the exported type allows and `readRepeatRule` never produces.
	const noWeekdays: RepeatRule = { unit: "week", interval: 1, weekdays: [], monthDays: null, whenDone: false };
	const noMonthDays: RepeatRule = { unit: "month", interval: 1, weekdays: null, monthDays: [], whenDone: false };

	// Today the empty weekday list loops for ever, and a synchronous loop cannot be
	// stopped by a test timeout, so a failing run here is a hang, not a failure.
	it("never lands: the next and the first date are null", () => {
		for (const empty of [noWeekdays, noMonthDays]) {
			expect(nextRepeatDate(empty, "2026-11-02", "2026-11-02")).toBeNull();
			expect(firstRepeatDate(empty, "2026-11-02")).toBeNull();
		}
	});

	it("is a rule the writer refuses", () => {
		expect(() => writeRepeatRule(noWeekdays)).toThrow(RangeError);
		expect(() => writeRepeatRule(noMonthDays)).toThrow(RangeError);
	});
});

describe("the first date of a line that has none", () => {
	const first = (text: string, today: string) => firstRepeatDate(rule(text), today);

	it("is today for an interval rule and for any when-done rule", () => {
		const today = "2026-10-21";
		for (const text of [
			"every 3 days",
			"every week",
			"every month",
			"every year",
			"every week when done",
			"every week on Monday when done",
			"every month on the 1st when done",
		]) {
			expect(first(text, today)).toBe(today);
		}
	});

	it("is the next named weekday, today included", () => {
		// 2026-10-21 is a Wednesday; 2026-10-26 the next Monday; 2026-10-19 the one before.
		expect(first("every week on Monday", "2026-10-21")).toBe("2026-10-26");
		expect(first("every week on Monday", "2026-10-26")).toBe("2026-10-26");
		expect(first("every week on Monday", "2026-10-25")).toBe("2026-10-26");
		expect(first("every 2 weeks on Wednesday", "2026-10-21")).toBe("2026-10-21");
		expect(first("every weekday", "2026-10-24")).toBe("2026-10-26");
	});

	it("is the next named day of the month, today included", () => {
		expect(first("every month on the 1st", "2026-10-21")).toBe("2026-11-01");
		expect(first("every month on the 1st", "2026-11-01")).toBe("2026-11-01");
		expect(first("every month on the 1st and 15th", "2026-10-02")).toBe("2026-10-15");
		expect(first("every month on the last", "2026-02-10")).toBe("2026-02-28");
		expect(first("every month on the 31st", "2026-02-10")).toBe("2026-03-31");
		// February has no 30th, but 2026-03-30 is not before today and is the 30th.
		expect(first("every 12 months on the 30th", "2026-02-10")).toBe("2026-03-30");
	});

	it("is the next named day whatever the interval, never a whole interval on", () => {
		// 2026-10-27 is a Tuesday: the next Monday is 2026-11-02, not two weeks on.
		expect(first("every 2 weeks on Monday", "2026-10-27")).toBe("2026-11-02");
		expect(first("every 2 months on the 1st", "2026-10-02")).toBe("2026-11-01");
		expect(first("every 12 months on the 1st", "2026-10-02")).toBe("2026-11-01");
		// Today itself still counts when it is a named day.
		expect(first("every 2 weeks on Tuesday", "2026-10-27")).toBe("2026-10-27");
		expect(first("every 3 months on the 2nd", "2026-10-02")).toBe("2026-10-02");
	});

	it("throws for a today that is not a day", () => {
		expect(() => first("every week", "tomorrow")).toThrow(RangeError);
	});
});

describe("shiftDate", () => {
	it("moves a date across a month end, a year end and a leap day", () => {
		expect(shiftDate("2026-01-31", 1)).toBe("2026-02-01");
		expect(shiftDate("2026-12-31", 1)).toBe("2027-01-01");
		expect(shiftDate("2028-02-28", 1)).toBe("2028-02-29");
		expect(shiftDate("2028-03-01", -1)).toBe("2028-02-29");
		expect(shiftDate("2026-09-20", 0)).toBe("2026-09-20");
	});

	it("gives null for a date that is not a real day", () => {
		expect(shiftDate("2026-02-30", 1)).toBeNull();
		expect(shiftDate("2026-9-20", 1)).toBeNull();
		expect(shiftDate("tomorrow", 1)).toBeNull();
	});

	it("gives null when either end falls outside the years 1000 to 9999", () => {
		// A year below 1000 is read nowhere in this module, so it is not shifted
		// either, even when the result would land inside the range.
		expect(shiftDate("0999-12-31", 1)).toBeNull();
		expect(shiftDate("1000-01-01", -1)).toBeNull();
		expect(shiftDate("9999-12-31", 1)).toBeNull();
		expect(shiftDate("1000-01-01", 0)).toBe("1000-01-01");
		expect(shiftDate("9999-12-30", 1)).toBe("9999-12-31");
	});
});

describe("daysBetween", () => {
	it("counts whole days from the first date to the second", () => {
		expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2);
		expect(daysBetween("2026-02-28", "2026-03-01")).toBe(1);
		expect(daysBetween("2026-09-27", "2026-09-20")).toBe(-7);
		expect(daysBetween("2026-09-20", "2026-09-20")).toBe(0);
	});

	it("gives null when either date is not a day this module reads", () => {
		expect(daysBetween("0999-12-31", "2026-09-20")).toBeNull();
		expect(daysBetween("2026-09-20", "2026-02-30")).toBeNull();
	});
});
