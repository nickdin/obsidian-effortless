/**
 * The calendar reader at the level where a loss is counted, rather than at the
 * level where a day's meetings come out.
 *
 * `icsReader.test.ts` drives the same code through `readDay`, which answers with
 * meetings and throws the count away. Everything here is about the count itself
 * — how many entries a calendar holds, how many of them could not be read, and
 * whether a read that says it lost nothing is telling the truth — so it calls
 * `readOccurrencesBetween` and looks straight at `loss`.
 *
 * Six defects are pinned here, and they are one contract between them: the
 * mark some exporters put in front of a calendar, a file that stops in
 * the middle of an entry, an entry with no `END:VEVENT` of its own that
 * used to swallow the entry below it, a UID group whose master will not
 * read while one of its overrides does, an entry whose dates cannot be
 * read at all, and the sentence-making helper no longer being public
 * surface. One guard is pinned here too, against the plugin's reach into
 * an undocumented `ical-expander` field.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { fixture } from "./fixtures";
import * as occurrences from "../core/icsOccurrences";
import * as reader from "../core/icsReader";
import { IcsReadError, forgetLossesSaid, readOccurrencesBetween, reportLoss } from "../core/icsOccurrences";

/**
 * The UTF-8 byte-order mark, written as its code point rather than as itself.
 * As itself it is invisible, and a test whose subject cannot be seen in the
 * source is a test the next reader deletes by accident.
 */
const MARK = "\uFEFF";

/** The whole of 8 September 2026, local time, which is what the fixtures sit in. */
const from = new Date(2026, 8, 8, 0, 0, 0);
const to = new Date(2026, 8, 8, 23, 59, 59);

/** A day the fixtures hold nothing on. */
const emptyFrom = new Date(2026, 8, 20, 0, 0, 0);
const emptyTo = new Date(2026, 8, 20, 23, 59, 59);

/**
 * The reader remembers which calendars it has already said a loss about, and
 * that memory is module-level: without this every test in the file would
 * inherit what the tests before it had read. Two tests parsing
 * byte-identical bytes would then have their outcome decided by which one ran
 * first, and the second would see no console line at all.
 */
beforeEach(() => forgetLossesSaid());

function read(ics: string): occurrences.IcsReading {
	return readOccurrencesBetween(ics, from, to);
}

function summaries(reading: occurrences.IcsReading): string[] {
	return reading.occurrences.map((one) => one.summary);
}

/** A calendar of the given `VEVENT` bodies, each already a list of lines. */
function calendarOf(...events: string[][]): string {
	const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Effortless//Test//EN"];
	for (const event of events) lines.push("BEGIN:VEVENT", ...event, "END:VEVENT");
	lines.push("END:VCALENDAR", "");
	return lines.join("\r\n");
}

const readableEvent = [
	"UID:readable@effortless.test",
	"DTSTAMP:20260901T120000Z",
	"DTSTART:20260908T090000Z",
	"DTEND:20260908T093000Z",
	"SUMMARY:Morning review",
];

/** An entry whose start is there and is not a date. `ical.js` parses it happily. */
const malformedStart = [
	"UID:malformed-start@effortless.test",
	"DTSTAMP:20260901T120000Z",
	"DTSTART:NOTADATE",
	"DTEND:NOTADATE",
	"SUMMARY:Starts at no time anyone can read",
];

/** An entry with no start at all, which is what a real export sometimes sends. */
const noStart = [
	"UID:no-start@effortless.test",
	"DTSTAMP:20260901T120000Z",
	"SUMMARY:Never says when it happens",
];

/** An entry that brings the parser down when its repeat rule is expanded. */
const badRule = [
	"UID:bad-rule@effortless.test",
	"DTSTAMP:20260901T120000Z",
	"DTSTART:20260908T090000Z",
	"DTEND:20260908T093000Z",
	"RRULE:FREQ=NONSENSE;COUNT=3",
	"SUMMARY:Repeats by a rule nobody can read",
];

/** An entry that reads perfectly and happens nowhere near the days being read. */
const farAway = [
	"UID:far-away@effortless.test",
	"DTSTAMP:20260901T120000Z",
	"DTSTART:20270301T090000Z",
	"DTEND:20270301T093000Z",
	"SUMMARY:Next March",
];

/** A repeat that never says when it starts, so nothing can expand it. */
const masterWithNoStart = [
	"UID:same@effortless.test",
	"DTSTAMP:20260901T120000Z",
	"RRULE:FREQ=DAILY;COUNT=3",
	"SUMMARY:A repeat that never says when it starts",
];

/** The override that replaces one morning of `masterWithNoStart`, and reads. */
const overrideOfNoStart = [
	"UID:same@effortless.test",
	"DTSTAMP:20260901T120000Z",
	"RECURRENCE-ID:20260908T090000Z",
	"DTSTART:20260908T090000Z",
	"DTEND:20260908T093000Z",
	"SUMMARY:The morning that moved",
];

/** A repeat that reads perfectly, landing on 7, 8 and 9 September. */
const repeatingMaster = [
	"UID:weekly@effortless.test",
	"DTSTAMP:20260901T120000Z",
	"DTSTART:20260907T090000Z",
	"DTEND:20260907T093000Z",
	"RRULE:FREQ=DAILY;COUNT=3",
	"SUMMARY:Stand-up",
];

/** The override that moves `repeatingMaster`'s 8 September, and reads. */
const repeatingOverride = [
	"UID:weekly@effortless.test",
	"DTSTAMP:20260901T120000Z",
	"RECURRENCE-ID:20260908T090000Z",
	"DTSTART:20260908T100000Z",
	"DTEND:20260908T103000Z",
	"SUMMARY:Stand-up, moved",
];

/** The same override with dates nothing can read. */
const unreadableOverride = [
	"UID:weekly@effortless.test",
	"DTSTAMP:20260901T120000Z",
	"RECURRENCE-ID:20260908T090000Z",
	"DTSTART:NOTADATE",
	"DTEND:NOTADATE",
	"SUMMARY:Moved to no time anyone can read",
];

/** A weekly series with a title, a location and two attendees. */
const seriesWithDetails = [
	"UID:weekly-detailed@effortless.test",
	"DTSTAMP:20260901T120000Z",
	"DTSTART:20260901T090000Z",
	"DTEND:20260901T093000Z",
	"RRULE:FREQ=WEEKLY;COUNT=4",
	"SUMMARY:Fixture planning",
	"LOCATION:Fixture room",
	"ORGANIZER;CN=Alex Example:mailto:alex@effortless.test",
	"ATTENDEE;CN=Bramble Test:mailto:bramble@effortless.test",
	"ATTENDEE;CN=Casey Sample:mailto:casey@effortless.test",
];

/**
 * The override that moves `seriesWithDetails`'s 8 September occurrence to 10
 * September, carrying only what Outlook's own move carries: `UID`,
 * `RECURRENCE-ID`, `DTSTART` and `DTEND` — no `SUMMARY`, `LOCATION`,
 * `ORGANIZER` or `ATTENDEE` of its own.
 */
const movedOccurrenceNoDetails = [
	"UID:weekly-detailed@effortless.test",
	"DTSTAMP:20260901T120000Z",
	"RECURRENCE-ID:20260908T090000Z",
	"DTSTART:20260910T100000Z",
	"DTEND:20260910T103000Z",
];

/** The same move, carrying its own `SUMMARY`, which must win over the series'. */
const movedOccurrenceOwnSummary = [
	"UID:weekly-detailed@effortless.test",
	"DTSTAMP:20260901T120000Z",
	"RECURRENCE-ID:20260908T090000Z",
	"DTSTART:20260910T100000Z",
	"DTEND:20260910T103000Z",
	"SUMMARY:Fixture planning, renamed on the move",
];

/** The whole of 10 September 2026, local time — the day the two overrides above move to. */
const movedDayFrom = new Date(2026, 8, 10, 0, 0, 0);
const movedDayTo = new Date(2026, 8, 10, 23, 59, 59);

/**
 * The developer console line `readingOf` writes beside a loss. It is not the
 * report — `loss` is — and Obsidian's console is closed in normal use, so every
 * test that makes a loss silences it rather than reading it.
 */
function silenceTheConsole(): void {
	beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
	afterEach(() => vi.restoreAllMocks());
}

describe("a calendar that begins with a byte-order mark", () => {
	// Outlook and Exchange write one. The `BEGIN:VCALENDAR` check anchors to the
	// start of a line and the mark sits before it, so the person was told to
	// change an address that was right all along.

	it("keeps the mark in the fixture, whatever loads it", () => {
		// The byte is the whole point of the fixture, and a loader that strips it
		// would leave every test below passing against a calendar without one.
		expect(fixture("bom-one-day.ics").charCodeAt(0)).toBe(0xfeff);
		expect(fixture("one-day.ics").charCodeAt(0)).not.toBe(0xfeff);
	});

	it("reads its events rather than throwing", () => {
		expect(summaries(read(fixture("bom-one-day.ics")))).toEqual([
			"Morning review",
			"Afternoon call",
		]);
	});

	it("reads exactly as the same calendar without the mark does", () => {
		expect(read(fixture("bom-one-day.ics"))).toEqual(read(fixture("one-day.ics")));
	});

	it.each([
		["nothing at all", ""],
		["HTML", "<!doctype html>\n<html><body>Not here any more</body></html>\n"],
		["JSON", '{"events": [{"summary": "Morning review"}]}\n'],
		["a vCard", fixture("vcard.ics")],
	])("still refuses %s, mark or no mark", (_name, bytes) => {
		for (const candidate of [bytes, `${MARK}${bytes}`]) {
			let thrown: unknown;
			try {
				read(candidate);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(IcsReadError);
			expect((thrown as IcsReadError).trouble).toBe("not-a-calendar");
		}
	});

	describe("whose one entry cannot be parsed", () => {
		silenceTheConsole();

		it("reaches the per-entry read and reports the loss, rather than giving up", () => {
			// Stripping the mark only for the check would move the failure from
			// "not a calendar" to "unreadable" — a different wrong sentence, not
			// a fix. The stripped text has to be the text that is parsed.
			const reading = read(`${MARK}${calendarOf(badRule)}`);

			expect(reading.occurrences).toEqual([]);
			expect(reading.loss).toEqual({ dropped: 1, total: 1 });
		});
	});
});

describe("a calendar that stops in the middle of an entry", () => {
	silenceTheConsole();

	it("counts the unfinished block as one entry it could not read", () => {
		const reading = read(fixture("truncated-after-one.ics"));

		expect(summaries(reading)).toEqual(["Read before the cut"]);
		expect(reading.loss).toEqual({ dropped: 1, total: 2 });
	});

	it("says so in the sentence a settings row shows", () => {
		const reading = read(fixture("truncated-after-one.ics"));

		expect(reportLoss(reading.loss as occurrences.IcsLoss).reason).toBe(
			"1 of 2 entries in this calendar could not be read — a repeating meeting counts " +
				"as one entry. Every other entry in it was read.",
		);
	});

	it("still gives up on a file cut before the first whole entry", () => {
		// `truncated.ics` holds no complete event, so there is nothing to fall
		// back on and an empty day would be a lie about what the calendar says.
		// The guard fires on the count of *complete* entries, which is why this
		// file is untouched by the change above.
		let thrown: unknown;
		try {
			read(fixture("truncated.ics"));
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(IcsReadError);
		expect((thrown as IcsReadError).trouble).toBe("unreadable");
	});
});

describe("an entry with no END:VEVENT of its own", () => {
	silenceTheConsole();

	/**
	 * `bodies` as one calendar, with the closing line left off the entry at
	 * each index in `open`.
	 *
	 * Written as an omission rather than as a fixture per shape, because the
	 * defect is exactly the missing line and a fixture hides which line that is.
	 */
	function missingItsEnd(bodies: string[][], open: readonly number[]): string {
		const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Effortless//Test//EN"];
		bodies.forEach((body, index) => {
			lines.push("BEGIN:VEVENT", ...body);
			if (!open.includes(index)) lines.push("END:VEVENT");
		});
		lines.push("END:VCALENDAR", "");
		return lines.join("\r\n");
	}

	const second = [
		"UID:second@effortless.test",
		"DTSTAMP:20260901T120000Z",
		"DTSTART:20260908T110000Z",
		"DTEND:20260908T113000Z",
		"SUMMARY:Second",
	];
	const third = [
		"UID:third@effortless.test",
		"DTSTAMP:20260901T120000Z",
		"DTSTART:20260908T130000Z",
		"DTEND:20260908T133000Z",
		"SUMMARY:Third",
	];

	it("loses itself and keeps the entry it used to swallow", () => {
		// The reproduction filed on the issue. The unclosed first entry used to
		// absorb `Second` whole, so the read answered with `Third` alone and a
		// loss of one of two — one entry gone with nothing said, under a
		// sentence promising every other entry was read.
		const reading = read(missingItsEnd([readableEvent, second, third], [0]));

		expect(summaries(reading)).toEqual(["Second", "Third"]);
		expect(reading.loss).toEqual({ dropped: 1, total: 3 });
	});

	it("counts two unclosed entries in a row as two entries lost", () => {
		const reading = read(missingItsEnd([readableEvent, second, third], [0, 1]));

		expect(summaries(reading)).toEqual(["Third"]);
		expect(reading.loss).toEqual({ dropped: 2, total: 3 });
	});

	it("leaves the file that simply stops part-way exactly as issue #207 left it", () => {
		// The last block being open is the half-download, and nothing above may
		// change what it answers: one entry lost of two, the other one read.
		const reading = read(fixture("truncated-after-one.ics"));

		expect(summaries(reading)).toEqual(["Read before the cut"]);
		expect(reading.loss).toEqual({ dropped: 1, total: 2 });
	});
});

describe("an entry whose dates cannot be read", () => {
	silenceTheConsole();

	it("counts as lost on the whole-file read, which nothing brought down", () => {
		const reading = read(calendarOf(readableEvent, malformedStart));

		expect(summaries(reading)).toEqual(["Morning review"]);
		expect(reading.loss).toEqual({ dropped: 1, total: 2 });
	});

	it("counts as lost beside one that threw, so the sentence stops excusing itself", () => {
		// Before this, the entry that threw was counted and the entry that was
		// discarded was not, so a calendar that produced no meeting at all still
		// ended its sentence "Every other entry in it was read."
		const reading = read(calendarOf(badRule, noStart));

		expect(reading.occurrences).toEqual([]);
		expect(reading.loss).toEqual({ dropped: 2, total: 2 });
		expect(reportLoss(reading.loss as occurrences.IcsLoss).reason).toBe(
			"None of the 2 entries in this calendar could be read — a repeating meeting counts " +
				"as one entry.",
		);
	});

	it("leaves the whole-file read standing when one entry of many is unreadable", () => {
		// The reason `skipInvalidDates` was turned on in the first place: one
		// event of a hundred missing its DTSTART must not take the file down.
		const reading = read(calendarOf(readableEvent, noStart, farAway));

		expect(summaries(reading)).toEqual(["Morning review"]);
		expect(reading.loss).toEqual({ dropped: 1, total: 3 });
	});
});

describe("a UID group whose master will not read", () => {
	silenceTheConsole();

	it("counts the entry as lost even though its override parses", () => {
		// The expander expands the master and never an override on its own, so
		// this group produces nothing. It used to be counted as read anyway —
		// any readable member did — and the calendar answered with no
		// occurrences and `loss: null`, which is the one thing that answer may
		// never mean.
		const reading = read(calendarOf(masterWithNoStart, overrideOfNoStart));

		expect(reading.occurrences).toEqual([]);
		expect(reading.loss).toEqual({ dropped: 1, total: 1 });
	});

	it("counts an override with no master at all as a lost entry", () => {
		const reading = read(calendarOf(overrideOfNoStart));

		expect(reading.occurrences).toEqual([]);
		expect(reading.loss).toEqual({ dropped: 1, total: 1 });
	});

	it("reaches the same verdict on the per-entry read as on the whole-file one", () => {
		// The bad repeat rule brings the whole-file read down, so the group
		// above is counted by the per-entry read instead. Two entries, both
		// lost: the group whose master will not read, and the one that throws.
		const reading = read(calendarOf(masterWithNoStart, overrideOfNoStart, badRule));

		expect(reading.occurrences).toEqual([]);
		expect(reading.loss).toEqual({ dropped: 2, total: 2 });
	});
});

describe("the same calendar down both reads", () => {
	silenceTheConsole();

	it("drives one calendar down both the whole-file read and the per-entry salvage, and reaches the same reading either way", async () => {
		const ics = calendarOf(readableEvent, noStart);
		const { default: RealIcalExpander } = await import("ical-expander");

		/**
		 * Throws a plain, non-contract error on the first construction made
		 * while `armed`, and behaves exactly as the real library does on every
		 * other construction, before or after.
		 *
		 * `armed` is what forces the per-entry read: the whole-file read makes
		 * exactly one construction, so arming before it throws there and sends
		 * `readOccurrencesBetween` into `salvage` — which is already back to
		 * seeing `armed` as `false`, because the throw below clears it before
		 * it fires, so `salvage`'s own constructions, one per entry, run
		 * unmocked in every way that matters.
		 */
		let armed = false;
		class ArmableExpander extends RealIcalExpander {
			constructor(options: ConstructorParameters<typeof RealIcalExpander>[0]) {
				if (armed) {
					armed = false;
					throw new Error("Forcing the per-entry read over the very same bytes.");
				}
				super(options);
			}
		}

		vi.resetModules();
		vi.doMock("ical-expander", () => ({ default: ArmableExpander }));
		try {
			const module = await import("../core/icsOccurrences");

			const wholeFile = module.readOccurrencesBetween(ics, from, to);
			armed = true;
			const perEntry = module.readOccurrencesBetween(ics, from, to);

			// Not trivially empty on either side: one entry reads and one is
			// lost, so an equality that only held because both sides answered
			// nothing would not pass unnoticed.
			expect(wholeFile.occurrences.map((one) => one.summary)).toEqual(["Morning review"]);
			expect(wholeFile.loss).toEqual({ dropped: 1, total: 2 });

			expect(perEntry).toEqual(wholeFile);
		} finally {
			vi.doUnmock("ical-expander");
			vi.resetModules();
		}
	});
});

describe("a UID group whose master reads (issue #143, unchanged by #288)", () => {
	silenceTheConsole();

	it("is one entry read, master and override together", () => {
		const reading = read(calendarOf(repeatingMaster, repeatingOverride));

		expect(summaries(reading)).toEqual(["Stand-up, moved"]);
		expect(reading.loss).toBeNull();
	});
});

describe("a moved occurrence that carries only what changed", () => {
	it("inherits the series' title, location, organizer and attendees on the day it moved to", () => {
		const reading = readOccurrencesBetween(
			calendarOf(seriesWithDetails, movedOccurrenceNoDetails),
			movedDayFrom,
			movedDayTo,
		);

		expect(reading.occurrences).toHaveLength(1);
		const moved = reading.occurrences[0];
		expect(moved.summary).toBe("Fixture planning");
		expect(moved.location).toBe("Fixture room");
		expect(moved.organizer).toEqual({ name: "Alex Example", email: "alex@effortless.test" });
		expect(moved.attendees).toEqual([
			{ name: "Bramble Test", email: "bramble@effortless.test" },
			{ name: "Casey Sample", email: "casey@effortless.test" },
		]);
	});

	it("keeps an override's own SUMMARY rather than the series'", () => {
		// Pins the other half of the rule: inheriting must not overwrite a real
		// change. This already passed before the fix, because the override read
		// its own SUMMARY regardless — it is the fixture above the fix changes,
		// not this one.
		const reading = readOccurrencesBetween(
			calendarOf(seriesWithDetails, movedOccurrenceOwnSummary),
			movedDayFrom,
			movedDayTo,
		);

		expect(reading.occurrences).toHaveLength(1);
		expect(reading.occurrences[0].summary).toBe("Fixture planning, renamed on the move");
	});
});

// This group is deliberately not in the block above. That block says
// *unchanged by #288*, and the entry here is counted **lost** — a name and a
// block that both read as no-loss would hide the one assertion this test
// makes.
describe("a UID group whose master reads but whose override will not parse", () => {
	silenceTheConsole();

	it("counts the group lost, which is the half of #288's box 4 the counting cannot reach", () => {
		// **The decided behaviour, not a limitation.** An override says a
		// meeting moved, and the override itself will not parse. The day shows
		// nothing for that group and the person is told one entry was lost.
		// The author chose that on 2026-09-08, on issue
		// #380, over showing the
		// master's own occurrence instead: a meeting drawn at an hour it is
		// known to have moved away from is a wrong answer presented as a right
		// one, where the loss message is at least honest about not knowing.
		//
		// **So a red here is not #380 landing.** #380 asked for no code change
		// and #288's fourth acceptance box was amended to match this answer.
		// If this test ever goes red, either the decision was reversed or
		// something detached the override by accident — read #380 before
		// changing the assertion.
		//
		// The group is one entry rather than two, which is the half of #288's
		// fourth box the counting *can* reach. How the loss comes about:
		// `ICAL.Event` relates an override to its master out of the parent
		// component when it is constructed, so taking the override out of the
		// expander's own list does not detach it. The master asks it for a
		// start time while it is being expanded, the expansion throws, and the
		// per-entry read counts the group dropped. Measured on `bc935a6` as
		// well as here — `{ dropped: 1, total: 1 }` either way — so it is older
		// than #288's change.
		//
		// Detaching the override, or rebuilding the master with an explicit
		// `exceptions` list, is the rejected option: either is what would put
		// the master's original occurrence on the day.
		const reading = read(calendarOf(repeatingMaster, unreadableOverride));

		// Both halves of #380's box 4 are asserted, not just the loss below,
		// because a test that pins only half of a decision is one the next
		// reader has to reconstruct. On today's salvage path the two are not
		// reached independently: a group counted wholly dropped cannot also
		// have contributed an occurrence, so this line cannot fail on its own
		// while the loss assertion passes. It stops being redundant the
		// moment the master's occurrence can survive the group being counted
		// dropped — the rejected #380 option above, of detaching the override
		// or rebuilding the master with an explicit `exceptions` list.
		expect(reading.occurrences).toEqual([]);
		expect(reading.loss).toEqual({ dropped: 1, total: 1 });
	});
});

describe("an entry that reads perfectly and has nothing to say", () => {
	it("is not counted as lost merely for falling outside the days being read", () => {
		const reading = read(calendarOf(farAway));

		expect(reading.occurrences).toEqual([]);
		expect(reading.loss).toBeNull();
	});

	it("leaves a whole calendar reporting no loss on a day it holds nothing on", () => {
		const reading = readOccurrencesBetween(fixture("one-day.ics"), emptyFrom, emptyTo);

		expect(reading.occurrences).toEqual([]);
		expect(reading.loss).toBeNull();
	});

	it("leaves a calendar every entry of which reads cleanly reporting no loss", () => {
		const reading = read(fixture("one-day.ics"));

		expect(summaries(reading)).toEqual(["Morning review", "Afternoon call"]);
		expect(reading.loss).toBeNull();
	});
});

describe("the undocumented ical-expander field this module reads", () => {
	/**
	 * A stand-in for `ical-expander` that never sets the `events` field.
	 *
	 * It also brings down any calendar holding more than one entry, which is how
	 * a read is pushed onto the per-entry path — the path where a missing field
	 * used to be laundered into "None of the N entries in this calendar could be
	 * read", for every calendar in the vault.
	 */
	class ExpanderWithNoEvents {
		constructor(options: { ics: string }) {
			if ((options.ics.match(/BEGIN:VEVENT/g) ?? []).length > 1) {
				throw new Error("This whole-file read is down, so the per-entry one runs.");
			}
		}
	}

	/** `readOccurrencesBetween` with that stand-in in place of the real library. */
	async function readWithBrokenExpander(ics: string): Promise<unknown> {
		vi.resetModules();
		vi.doMock("ical-expander", () => ({ default: ExpanderWithNoEvents }));
		try {
			const module = await import("../core/icsOccurrences");
			return module.readOccurrencesBetween(ics, from, to);
		} finally {
			vi.doUnmock("ical-expander");
			vi.resetModules();
		}
	}

	it("is there, and is a list, on a freshly built expander", async () => {
		// The point of this one is the clock it runs on: it fails at `npm
		// install`, when the dependency changes, rather than in someone's vault.
		const { default: IcalExpander } = await import("ical-expander");
		const expander = new IcalExpander({ ics: fixture("one-day.ics"), maxIterations: 1000 });

		expect(Array.isArray((expander as unknown as { events: unknown }).events)).toBe(true);
	});

	it("throws an error naming the library and the field when it is gone", async () => {
		await expect(readWithBrokenExpander(calendarOf(readableEvent))).rejects.toThrow(
			/ical-expander.*`events`/,
		);
	});

	it("lets that throw out of the per-entry read rather than calling it a loss", async () => {
		// Two entries, so the whole-file read comes down and the per-entry read
		// takes over. Every entry would throw the same way there, and counting
		// them would answer a loss report that is entirely wrong.
		await expect(readWithBrokenExpander(calendarOf(readableEvent, farAway))).rejects.toThrow(
			/ical-expander/,
		);
	});

	it("leaves an ordinary calendar reading exactly as it did", () => {
		const reading = read(fixture("one-day.ics"));

		expect(summaries(reading)).toEqual(["Morning review", "Afternoon call"]);
		expect(reading.loss).toBeNull();
	});
});

describe("the console line beside a loss", () => {
	let warn: MockInstance<typeof console.warn>;

	beforeEach(() => {
		warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => vi.restoreAllMocks());

	/**
	 * A calendar of one entry that never says when it happens, told apart from
	 * every other calendar in this block by `name`.
	 *
	 * The bytes have to differ, because that is exactly what the reader keys its
	 * memory of a loss on. Two calendars sharing a name here would share a line.
	 */
	function datelessCalendar(name: string, entries = 1): string {
		const bodies = [];
		for (let n = 0; n < entries; n += 1) {
			bodies.push([`UID:${name}-${n}@effortless.test`, "DTSTAMP:20260901T120000Z", `SUMMARY:${name} ${n}`]);
		}
		return calendarOf(...bodies);
	}

	it("says a loss once, however many times the same calendar is read", () => {
		// `CalendarSources.meetingsOn` re-reads every stored calendar on every
		// day-view draw and every readiness check, so this line used to be
		// written continuously for one dateless entry.
		const ics = datelessCalendar("said-once");

		for (let n = 0; n < 5; n += 1) read(ics);

		expect(warn.mock.calls).toHaveLength(1);
	});

	it("says it again when the loss changes", () => {
		const one = datelessCalendar("changing");
		const two = datelessCalendar("changing-again", 2);

		read(one);
		read(two);
		read(one);

		expect(warn.mock.calls).toHaveLength(2);
	});

	it("gives two calendars losing the same amount a line each", () => {
		// Both lose one entry of one, so the sentences are identical. They are
		// two calendars and each of them deserves saying once.
		const first = datelessCalendar("first-calendar");
		const second = datelessCalendar("second-calendar");

		read(first);
		read(second);
		read(first);
		read(second);

		expect(warn.mock.calls).toHaveLength(2);
	});

	it("says it again when a loss clears and comes back", () => {
		// The bytes that come back are not the bytes that went — an entry
		// repaired and then broken afresh is a different file, which is what
		// makes this work without the reader knowing which source it is reading.
		const broken = datelessCalendar("comes-back");
		const mended = calendarOf(readableEvent);
		const brokenAfresh = datelessCalendar("comes-back-afresh");

		read(broken);
		read(mended);
		read(brokenAfresh);

		expect(warn.mock.calls).toHaveLength(2);
	});

	it("leaves the loss it answers exactly as it was", () => {
		// The line is for whoever has the console open. `loss` is the report, and
		// it may not change because the line has stopped repeating.
		const ics = datelessCalendar("loss-unchanged");

		const first = read(ics);
		const second = read(ics);

		expect(first.loss).toEqual({ dropped: 1, total: 1 });
		expect(second.loss).toEqual(first.loss);
		expect(warn.mock.calls).toHaveLength(1);
	});
});

describe("how many calendars' losses are remembered at once", () => {
	let warn: MockInstance<typeof console.warn>;

	beforeEach(() => {
		warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => vi.restoreAllMocks());

	/**
	 * `REMEMBERED_LOSSES` in the module under test, written out here because it
	 * is not part of what that module hands out and should not become so for a
	 * test's sake. The pair of tests below pin the number from both sides: one
	 * calendar short of it the oldest is still remembered, one past it the
	 * oldest is gone. Changing the constant fails them, which is the point.
	 */
	const BOUND = 32;

	/** A calendar of one entry that never says when it happens, told apart from every other by `name`. */
	function losing(name: string): string {
		return calendarOf([`UID:${name}@effortless.test`, "DTSTAMP:20260901T120000Z", `SUMMARY:${name}`]);
	}

	/** Reads `count` calendars nothing has read before, each of them losing its only entry. */
	function readNewcomers(count: number): void {
		for (let n = 0; n < count; n += 1) read(losing(`newcomer-${n}`));
	}

	it("keeps the oldest while fewer calendars than the bound have been heard since", () => {
		read(losing("first"));
		// One short of the bound, so nothing has been evicted and the memory is
		// exactly full with `first` at the front of it.
		readNewcomers(BOUND - 1);
		warn.mockClear();

		read(losing("first"));

		expect(warn.mock.calls).toEqual([]);
	});

	it("forgets the oldest past the bound, so its calendar says its line again", () => {
		read(losing("first"));
		// The last of these is the one that has to make room, and `first` is the
		// least recently met, so it is the one that goes.
		readNewcomers(BOUND);
		warn.mockClear();

		read(losing("first"));

		expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
			"Effortless: The only entry in this calendar could not be read — a repeating " +
				"meeting counts as one entry.",
		]);
	});
});

describe("a loss whose size depends on the day it is read on", () => {
	/**
	 * **This is the test `announceLoss`'s docstring used to call impossible.**
	 *
	 * It claimed the loss was a pure function of the bytes, so one print could
	 * only ever have one sentence, so comparing print against sentence "would be
	 * a test that can never fail". That holds on the whole-file read and not on
	 * the per-entry one, where the dropped count is taken from a `catch` wrapped
	 * around `between(from, to)`. Here the same bytes lose two entries on one day
	 * and one on another — two different sentences — and only the first is said.
	 */

	/** The day the fragile entry will not expand on. */
	const badDayFrom = new Date(2026, 8, 8, 0, 0, 0);
	const badDayTo = new Date(2026, 8, 8, 23, 59, 59);
	/** A day it expands on perfectly well. */
	const goodDayFrom = new Date(2026, 8, 9, 0, 0, 0);
	const goodDayTo = new Date(2026, 8, 9, 23, 59, 59);

	const alwaysBad = "UID:always-bad@effortless.test";
	const badOnOneDay = "UID:bad-on-one-day@effortless.test";

	/**
	 * A stand-in for `ical-expander` that decides per day window.
	 *
	 * Its constructor brings down any calendar of more than one entry, which is
	 * how the read is pushed onto the per-entry path — the path this ticket is
	 * about. There each entry arrives as a calendar of its own, still carrying
	 * its `UID` line, so `between` can tell the three apart by their bytes.
	 *
	 * Real bytes that behave this way have not been found; two probes on issue
	 * #459 failed to build any. That does not matter to what is being pinned:
	 * the count is read out of a `catch` over window-dependent work, so the
	 * docstring's reason is false whatever the real library does.
	 */
	class ExpanderDecidingPerDay {
		events: unknown[] = [];
		private readonly ics: string;

		constructor(options: { ics: string }) {
			this.ics = options.ics;
			if ((options.ics.match(/BEGIN:VEVENT/g) ?? []).length > 1) {
				throw new Error("This whole-file read is down, so the per-entry one runs.");
			}
		}

		between(from: Date, _to: Date): { events: unknown[]; occurrences: unknown[] } {
			if (this.ics.includes(alwaysBad)) {
				throw new Error("This entry cannot be expanded on any day.");
			}
			if (this.ics.includes(badOnOneDay) && from.getTime() === badDayFrom.getTime()) {
				throw new Error("This entry cannot be expanded on this day.");
			}
			return { events: [], occurrences: [] };
		}
	}

	/** Three entries under three UIDs: one always bad, one bad on one day, one sound. */
	const calendar = calendarOf(
		[alwaysBad, "DTSTAMP:20260901T120000Z", "DTSTART:20260908T090000Z", "SUMMARY:Always bad"],
		[badOnOneDay, "DTSTAMP:20260901T120000Z", "DTSTART:20260908T100000Z", "SUMMARY:Bad on one day"],
		[
			"UID:steady@effortless.test",
			"DTSTAMP:20260901T120000Z",
			"DTSTART:20260908T110000Z",
			"SUMMARY:Steady",
		],
	);

	/**
	 * Runs `use` against one freshly loaded copy of the module with that stand-in
	 * in place. **One copy, because the memory of what has been said is
	 * module-level** — two loads would each start with an empty one, and both
	 * lines would be written whatever the guard does.
	 */
	async function withDayDependentExpander<T>(
		use: (module: typeof occurrences) => T,
	): Promise<T> {
		vi.resetModules();
		vi.doMock("ical-expander", () => ({ default: ExpanderDecidingPerDay }));
		try {
			return use(await import("../core/icsOccurrences"));
		} finally {
			vi.doUnmock("ical-expander");
			vi.resetModules();
		}
	}

	let warn: MockInstance<typeof console.warn>;

	beforeEach(() => {
		warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => vi.restoreAllMocks());

	it("says the first of two different sentences over identical bytes, and only it", async () => {
		const { badDay, goodDay, sentences } = await withDayDependentExpander((module) => {
			const first = module.readOccurrencesBetween(calendar, badDayFrom, badDayTo);
			const second = module.readOccurrencesBetween(calendar, goodDayFrom, goodDayTo);
			return {
				badDay: first.loss,
				goodDay: second.loss,
				sentences: [first.loss, second.loss].map((loss) =>
					loss === null ? null : module.reportLoss(loss).reason,
				),
			};
		});

		// The same bytes, counted twice, disagreeing. This is the comparison the
		// old docstring said could never fail.
		expect(badDay).toEqual({ dropped: 2, total: 3 });
		expect(goodDay).toEqual({ dropped: 1, total: 3 });
		expect(sentences[0]).not.toEqual(sentences[1]);

		// And what the guard actually keeps: one print, one line, whatever the
		// second sentence would have been.
		expect(warn.mock.calls).toHaveLength(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("2 of 3 entries");
	});
});

describe("the loss-describing helper", () => {
	// It had two callers, both inside its own module, in a plugin whose source
	// strangers read. `reportLoss` is what every caller outside it uses.
	it("is not part of what this module hands out", () => {
		expect(Object.keys(occurrences)).not.toContain("describeLoss");
	});

	it("has not taken the reporting function down with it", () => {
		expect(typeof occurrences.reportLoss).toBe("function");
		expect(typeof reader.reportLoss).toBe("function");
		expect(Object.keys(reader)).not.toContain("describeLoss");
	});

	it("leaves the sentences it makes exactly as they were", () => {
		expect(reportLoss({ dropped: 1, total: 4 })).toEqual({
			reason:
				"1 of 4 entries in this calendar could not be read — a repeating meeting counts " +
				"as one entry. Every other entry in it was read.",
			loss: "partial",
		});
		expect(reportLoss({ dropped: 1, total: 1 })).toEqual({
			reason:
				"The only entry in this calendar could not be read — a repeating meeting counts " +
				"as one entry.",
			loss: "total",
		});
		expect(reportLoss({ dropped: 3, total: 3 })).toEqual({
			reason:
				"None of the 3 entries in this calendar could be read — a repeating meeting " +
				"counts as one entry.",
			loss: "total",
		});
	});
});
