import { describe, expect, it } from "vitest";
import { chain } from "../features/review/chain";
import type { ChainMark, ChainMonth } from "../features/review/chain";
import type { VaultLayout } from "../core/settings";
import { defaultData } from "../core/settings";
import type { ResolveLink, ReviewNote } from "../features/review/waitingNotes";

/** Thursday 15 October 2026, the day every case below is read on unless it says otherwise. */
const TODAY = new Date(2026, 9, 15);
const OCTOBER: ChainMonth = { year: 2026, month: 10 };

function layout(change: Partial<VaultLayout> = {}): VaultLayout {
	return {
		...defaultData().core.layout,
		dailyLogFolder: "Journal",
		dailyLogFilename: "YYYY-MM-DD",
		processedField: "processed",
		dayLinkField: "day",
		diaryDateField: "diary",
		diaryHeading: { text: "Diary", level: 1 },
		excludedFolders: ["Templates"],
		...change,
	};
}

const two = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` for 2026-`month`-`day`, with `day` allowed to run past the month's end. */
function iso(month: number, day: number): string {
	const date = new Date(2026, month - 1, day);
	return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

const DIARY_TEXT = "# Diary\n\nA line about the day.\n";

/** The day's log for 2026-`month`-`day`, with the given frontmatter and text. */
function log(month: number, day: number, frontmatter: Record<string, unknown> | null, text = DIARY_TEXT): ReviewNote {
	return { path: `Journal/${iso(month, day)}.md`, frontmatter, text };
}

/** A meeting note linking to the day's log for 2026-`month`-`day`. */
function meeting(name: string, month: number, day: number, processed: unknown, folder = "Meetings"): ReviewNote {
	const frontmatter: Record<string, unknown> = { day: `[[${iso(month, day)}]]` };
	if (processed !== undefined) frontmatter.processed = processed;
	return { path: `${folder}/${name}.md`, frontmatter, text: "" };
}

/** Resolves a link written with a day's name to that day's log, and nothing else. */
const resolveLink: ResolveLink = (linkText) => (/^\d{4}-\d{2}-\d{2}$/.test(linkText) ? `Journal/${linkText}.md` : null);

function read(notes: ReviewNote[], today = TODAY, month = OCTOBER, change: Partial<VaultLayout> = {}) {
	return chain(notes, layout(change), resolveLink, month, today);
}

/** The diary mark of the day `day` of October 2026. */
function diaryOn(day: number, notes: ReviewNote[], today = TODAY, change: Partial<VaultLayout> = {}): ChainMark {
	return read(notes, today, OCTOBER, change).days[day - 1].diary;
}

/** The review mark of the day `day` of October 2026. */
function reviewOn(day: number, notes: ReviewNote[], today = TODAY): ChainMark {
	return read(notes, today).days[day - 1].review;
}

describe("the chain: the diary", () => {
	it("keeps a past day whose field holds its own date", () => {
		expect(diaryOn(12, [log(10, 12, { diary: "2026-10-12" })])).toBe("kept");
	});

	it("misses a past day whose field holds the day after, as a diary written in hindsight is dated the day it was written", () => {
		expect(diaryOn(12, [log(10, 12, { diary: "2026-10-13" })])).toBe("missed");
	});

	it("leaves today pending while its field is empty, absent or has no value", () => {
		expect(diaryOn(15, [log(10, 15, { diary: null })])).toBe("pending");
		expect(diaryOn(15, [log(10, 15, {})])).toBe("pending");
		expect(diaryOn(15, [log(10, 15, null)])).toBe("pending");
		expect(diaryOn(15, [log(10, 15, { diary: "  " })])).toBe("pending");
	});

	it("keeps today once its field holds today", () => {
		expect(diaryOn(15, [log(10, 15, { diary: "2026-10-15" })])).toBe("kept");
	});

	it("is none on a day with no log", () => {
		expect(diaryOn(12, [log(10, 13, { diary: "2026-10-13" })])).toBe("none");
	});

	it("is none when the log has no diary heading", () => {
		expect(diaryOn(12, [log(10, 12, { diary: "2026-10-12" }, "# Notes\n\ntext\n")])).toBe("none");
	});

	it("is none when the only line reading like the diary heading is a comment inside the frontmatter (finding #1142)", () => {
		for (const eol of ["\n", "\r\n"]) {
			const text = ["---", "# Diary", "diary:", "---", "# Notes", "", "text", ""].join(eol);
			expect([eol, diaryOn(12, [log(10, 12, { diary: null }, text)])]).toEqual([eol, "none"]);
		}
	});

	it("still finds the diary heading below a frontmatter that holds the same comment", () => {
		const text = "---\n# Diary\ndiary:\n---\n# Diary\n\ntext\n";
		expect(diaryOn(12, [log(10, 12, { diary: null }, text)])).toBe("missed");
	});

	it("is none when the diary heading is present at another level", () => {
		expect(diaryOn(12, [log(10, 12, { diary: "2026-10-12" }, "## Diary\n\ntext\n")])).toBe("none");
	});

	it("reads a heading on Windows line endings", () => {
		expect(diaryOn(12, [log(10, 12, { diary: "2026-10-12" }, "# Diary\r\n\r\ntext\r\n")])).toBe("kept");
	});

	it("is none on every day when the diary heading setting is blank", () => {
		const notes = [log(10, 12, { diary: "2026-10-12" }), log(10, 13, { diary: null })];
		const days = read(notes, TODAY, OCTOBER, { diaryHeading: { text: "  ", level: 1 } }).days;
		expect(days.every((day) => day.diary === "none")).toBe(true);
	});

	it("keeps a past day whose field holds a value that is not a date", () => {
		expect(diaryOn(12, [log(10, 12, { diary: true })])).toBe("kept");
		expect(diaryOn(12, [log(10, 12, { diary: "done" })])).toBe("kept");
		expect(diaryOn(12, [log(10, 12, { diary: "2026-02-31" })])).toBe("kept");
	});

	it("misses a past day whose field is empty or absent", () => {
		expect(diaryOn(12, [log(10, 12, { diary: null })])).toBe("missed");
		expect(diaryOn(12, [log(10, 12, {})])).toBe("missed");
	});

	it("reads a date that carries a time by its date", () => {
		expect(diaryOn(12, [log(10, 12, { diary: "2026-10-12T21:40" })])).toBe("kept");
	});

	it("reads the field the layout names", () => {
		const notes = [log(10, 12, { journal: "2026-10-12", diary: null })];
		expect(diaryOn(12, notes, TODAY, { diaryDateField: "journal" })).toBe("kept");
		expect(diaryOn(12, notes)).toBe("missed");
	});

	it("is none for a day after today, whatever its field holds", () => {
		expect(diaryOn(16, [log(10, 16, { diary: "2026-10-16" })])).toBe("none");
		expect(diaryOn(16, [log(10, 16, { diary: null })])).toBe("none");
	});

	it("leaves today pending when its field holds another day's date", () => {
		expect(diaryOn(15, [log(10, 15, { diary: "2026-10-14" })])).toBe("pending");
	});
});

describe("the chain: the review", () => {
	it("keeps a day whose log and two meeting notes are all processed on the day after", () => {
		const notes = [
			log(10, 12, { processed: "2026-10-13" }),
			meeting("Budget", 10, 12, "2026-10-13"),
			meeting("Planning", 10, 12, "2026-10-13"),
		];
		expect(reviewOn(12, notes)).toBe("kept");
	});

	it("misses a day when one note was processed two days after", () => {
		const notes = [
			log(10, 12, { processed: "2026-10-13" }),
			meeting("Budget", 10, 12, "2026-10-13"),
			meeting("Planning", 10, 12, "2026-10-14"),
		];
		expect(reviewOn(12, notes)).toBe("missed");
	});

	it("leaves a day pending while a note is still empty and today is the day after", () => {
		const notes = [log(10, 14, { processed: "2026-10-15" }), meeting("Budget", 10, 14, null)];
		expect(reviewOn(14, notes)).toBe("pending");
	});

	it("misses the same day when today is two days after", () => {
		const notes = [log(10, 13, { processed: "2026-10-14" }), meeting("Budget", 10, 13, null)];
		expect(reviewOn(13, notes)).toBe("missed");
	});

	it("steps over a note with no processed field, as Review's list never shows it", () => {
		const notes = [log(10, 13, { processed: "2026-10-14" }), meeting("Budget", 10, 13, undefined)];
		expect(reviewOn(13, notes)).toBe("kept");
		expect(reviewOn(14, [log(10, 14, null)])).toBe("none");
	});

	it("counts a note whose field holds true as processed", () => {
		const notes = [log(10, 12, { processed: "2026-10-13" }), meeting("Budget", 10, 12, true)];
		expect(reviewOn(12, notes)).toBe("kept");
	});

	it("counts a note processed before the day after as in time", () => {
		const notes = [log(10, 12, { processed: "2026-10-12" })];
		expect(reviewOn(12, notes)).toBe("kept");
	});

	it("leaves a meeting note in an excluded folder out", () => {
		const notes = [log(10, 12, { processed: "2026-10-13" }), meeting("Budget", 10, 12, null, "Templates")];
		expect(reviewOn(12, notes)).toBe("kept");
	});

	it("is none on a day with no log even when a meeting note links to that date by name", () => {
		expect(reviewOn(12, [meeting("Budget", 10, 12, null)])).toBe("none");
		expect(reviewOn(12, [meeting("Budget", 10, 12, "2026-10-13")])).toBe("none");
	});

	it("takes a note into the day its day-link field resolves to, and into no other", () => {
		const notes = [
			log(10, 12, { processed: "2026-10-13" }),
			log(10, 13, { processed: "2026-10-14" }),
			meeting("Budget", 10, 13, null),
		];
		expect(reviewOn(12, notes)).toBe("kept");
		expect(reviewOn(13, notes)).toBe("missed");
	});

	it("keeps today when every note is already processed, and leaves it pending otherwise", () => {
		expect(reviewOn(15, [log(10, 15, { processed: "2026-10-15" })])).toBe("kept");
		expect(reviewOn(15, [log(10, 15, { processed: null })])).toBe("pending");
	});

	it("misses at once a note dated later than the day after, even while another waits", () => {
		const notes = [log(10, 14, { processed: "2026-10-30" }), meeting("Budget", 10, 14, null)];
		expect(reviewOn(14, notes)).toBe("missed");
	});

	it("reads the processed field the layout names", () => {
		const notes = [log(10, 12, { checked: "2026-10-13", processed: null })];
		expect(read(notes, TODAY, OCTOBER, { processedField: "checked" }).days[11].review).toBe("kept");
	});
});

describe("the chain: days after today", () => {
	it("are none for both routines", () => {
		const notes = [
			log(10, 16, { diary: null, processed: null }),
			log(10, 17, { diary: "2026-10-17", processed: "2026-10-18" }),
			meeting("Budget", 10, 16, null),
		];
		const { days } = read(notes);
		expect(days[15]).toMatchObject({ diary: "none", review: "none" });
		expect(days[16]).toMatchObject({ diary: "none", review: "none" });
		expect(days[30]).toMatchObject({ diary: "none", review: "none" });
	});
});

describe("the chain: the run", () => {
	/** Logs for the given October days, each with the diary kept on its own day and the review kept the day after. */
	function keptDays(...days: number[]): ReviewNote[] {
		return days.map((day) => log(10, day, { diary: iso(10, day), processed: iso(10, day + 1) }));
	}

	it("counts three kept days then today's pending diary as 3", () => {
		const notes = [...keptDays(12, 13, 14), log(10, 15, { diary: null, processed: null })];
		expect(read(notes).runs.diary).toBe(3);
	});

	it("stops at a missed day: one before three kept days answers 3", () => {
		const notes = [
			...keptDays(12, 13, 14),
			log(10, 11, { diary: null }),
			...keptDays(9, 10),
			log(10, 15, { diary: null }),
		];
		expect(read(notes).runs.diary).toBe(3);
	});

	it("steps over a none day in the middle of five kept days", () => {
		const notes = [...keptDays(9, 10, 12, 13, 14), log(10, 15, { diary: null })];
		expect(read(notes).runs.diary).toBe(5);
	});

	it("steps over a day whose log has no diary heading", () => {
		const notes = [...keptDays(12, 14), log(10, 13, { diary: null }, "# Notes\n")];
		expect(read(notes).runs.diary).toBe(2);
	});

	it("counts a run that began in the previous month when that month's notes are handed in", () => {
		const september = [
			log(9, 29, { diary: "2026-09-29" }),
			log(9, 30, { diary: "2026-09-30" }),
		];
		const october = [log(10, 1, { diary: "2026-10-01" }), log(10, 2, { diary: null })];
		const today = new Date(2026, 9, 2);
		expect(read([...september, ...october], today).runs.diary).toBe(3);
		expect(read(october, today).runs.diary).toBe(1);
	});

	it("is 0 when nothing is decided", () => {
		expect(read([]).runs).toEqual({ diary: 0, review: 0 });
	});

	it("counts the two routines apart", () => {
		const notes = [
			log(10, 12, { diary: "2026-10-12", processed: null }),
			log(10, 13, { diary: "2026-10-13", processed: "2026-10-14" }),
			log(10, 14, { diary: "2026-10-14", processed: "2026-10-15" }),
		];
		// The review of the 12th is missed (still empty two days after); the 13th and 14th are kept.
		expect(read(notes).runs).toEqual({ diary: 3, review: 2 });
	});

	it("steps over a pending review day", () => {
		const notes = [
			log(10, 12, { processed: "2026-10-13" }),
			log(10, 13, { processed: "2026-10-14" }),
			log(10, 14, { processed: null }),
		];
		expect(read(notes).runs.review).toBe(2);
	});

	it("counts a past month as it stood when the month ended", () => {
		const notes = [log(9, 28, { diary: "2026-09-28" }), log(9, 29, { diary: "2026-09-29" }), log(9, 30, { diary: "2026-09-30" })];
		expect(read(notes, TODAY, { year: 2026, month: 9 }).runs.diary).toBe(3);
	});
});

describe("the chain: the month", () => {
	it("holds every day of a 31-day month in order, each with both marks", () => {
		const { days } = read([]);
		expect(days).toHaveLength(31);
		expect(days.map((day) => day.date.getDate())).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
		for (const day of days) expect(day).toEqual({ date: day.date, diary: "none", review: "none" });
	});

	it("holds 28 days for a February of 28 and 29 for a leap one", () => {
		expect(read([], TODAY, { year: 2026, month: 2 }).days).toHaveLength(28);
		expect(read([], TODAY, { year: 2028, month: 2 }).days).toHaveLength(29);
		expect(read([], TODAY, { year: 2026, month: 4 }).days).toHaveLength(30);
	});

	it("gives each day as a local-time date at midnight", () => {
		const { days } = read([], TODAY, { year: 2026, month: 3 });
		expect(days[0].date).toEqual(new Date(2026, 2, 1));
		expect(days[30].date).toEqual(new Date(2026, 2, 31));
	});

	it("refuses a month number outside 1 to 12 rather than answering for another month", () => {
		expect(() => read([], TODAY, { year: 2026, month: 0 })).toThrow(RangeError);
		expect(() => read([], TODAY, { year: 2026, month: 13 })).toThrow(RangeError);
	});
});

describe("the chain: the run is as of today, whichever month is shown", () => {
	const SEPTEMBER: ChainMonth = { year: 2026, month: 9 };

	/** Every day from 20 September to 15 October kept in both routines, the review filled the day after. */
	function keptSince20Sep(): ReviewNote[] {
		const notes: ReviewNote[] = [];
		for (let offset = 0; offset < 26; offset += 1) {
			const date = new Date(2026, 8, 20 + offset);
			const [month, day] = [date.getMonth() + 1, date.getDate()];
			notes.push(log(month, day, { diary: iso(month, day), processed: iso(month, day + 1) }));
		}
		return notes;
	}

	it("answers the October run when the grid is on September, today being in October", () => {
		const notes = keptSince20Sep();
		const shown = read(notes, TODAY, SEPTEMBER).runs;
		expect(shown).toEqual(read(notes, TODAY, OCTOBER).runs);
		expect(shown).toEqual({ diary: 26, review: 26 });
	});

	it("counts from today, so a day missed in late September answers the October run and not 0", () => {
		// 29 September is missed in both routines; today's run starts after it, at 30 September.
		const notes = keptSince20Sep().filter((note) => !note.path.endsWith("2026-09-29.md"));
		notes.push(log(9, 29, { diary: "2026-09-30", processed: "2026-10-05" }));
		expect(read(notes, TODAY, SEPTEMBER).runs).toEqual({ diary: 16, review: 16 });
	});
});
