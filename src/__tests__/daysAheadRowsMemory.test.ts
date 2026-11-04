import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pruneRowMemory, readRowMemory, startKeyFor } from "../features/daysAhead/rowMemory";

// Nothing under test here reads the clock — pruneRowMemory takes its today
// as an argument — but issue #696's own criterion says every date and time
// test pins it, so a later change that does read the clock cannot slip
// through unnoticed.
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(2026, 7, 20, 12, 0));
});
afterEach(() => vi.useRealTimers());

describe("startKeyFor", () => {
	it("is stable for the same start minute and differs for another", () => {
		expect(startKeyFor(600)).toBe(startKeyFor(600));
		expect(startKeyFor(600)).not.toBe(startKeyFor(780));
	});
});

describe("readRowMemory — a stored entry is validated on read", () => {
	it("reads a well-formed memory back unchanged", () => {
		const stored = {
			"uid-1": { "2026-08-20": { "600": { time: "10:00–11:00", event: "[[2026-08-20 Weekly]]", title: "Weekly" } } },
		};
		expect(readRowMemory(stored)).toEqual(stored);
	});

	it("is empty for something that is not an object at all", () => {
		expect(readRowMemory(null)).toEqual({});
		expect(readRowMemory(undefined)).toEqual({});
		expect(readRowMemory("not an object")).toEqual({});
		expect(readRowMemory(5)).toEqual({});
		expect(readRowMemory([])).toEqual({});
	});

	it("skips a meeting's memory that is not an object, keeping the rest", () => {
		const stored = {
			"uid-1": "not an object",
			"uid-2": { "2026-08-20": { "600": { time: "10:00–11:00", event: "Standup", title: "Standup" } } },
		};
		expect(readRowMemory(stored)).toEqual({
			"uid-2": { "2026-08-20": { "600": { time: "10:00–11:00", event: "Standup", title: "Standup" } } },
		});
	});

	it("skips one date's entry that is not an object, keeping the meeting's other dates", () => {
		const stored = {
			"uid-1": {
				"2026-08-20": "not an object",
				"2026-08-21": { "540": { time: "09:00–10:00", event: "Retro", title: "Retro" } },
			},
		};
		expect(readRowMemory(stored)).toEqual({
			"uid-1": { "2026-08-21": { "540": { time: "09:00–10:00", event: "Retro", title: "Retro" } } },
		});
	});

	it("skips a start's entry that is not an object, keeping the date's other starts", () => {
		const stored = {
			"uid-1": {
				"2026-08-20": {
					"540": "not an object",
					"780": { time: "13:00–13:30", event: "Retro", title: "Retro" },
				},
			},
		};
		expect(readRowMemory(stored)).toEqual({
			"uid-1": { "2026-08-20": { "780": { time: "13:00–13:30", event: "Retro", title: "Retro" } } },
		});
	});

	it("skips an entry missing one of its three string fields", () => {
		const stored = {
			"uid-1": {
				"2026-08-20": {
					"540": { time: "10:00–11:00", event: "Standup" }, // no title
					"780": { time: "10:00–11:00", event: null, title: "Standup" }, // event not a string
					"900": { time: "10:00–11:00", event: "Standup", title: "Standup" }, // valid
				},
			},
		};
		expect(readRowMemory(stored)).toEqual({
			"uid-1": { "2026-08-20": { "900": { time: "10:00–11:00", event: "Standup", title: "Standup" } } },
		});
	});

	it("drops a date left with no valid starts, and a meeting left with no valid dates, rather than an empty object", () => {
		const stored = { "uid-1": { "2026-08-20": { "540": "not an object" } } };
		expect(readRowMemory(stored)).toEqual({});
	});

	it("skips a date key that is not YYYY-MM-DD, keeping the rest — a junk key and an unpadded one", () => {
		const stored = {
			"uid-1": {
				garbage: { "600": { time: "10:00–11:00", event: "Standup", title: "Standup" } },
				"2026-9-5": { "540": { time: "09:00–10:00", event: "Retro", title: "Retro" } },
				"2026-08-20": { "600": { time: "10:00–11:00", event: "Standup", title: "Standup" } },
			},
		};
		expect(readRowMemory(stored)).toEqual({
			"uid-1": { "2026-08-20": { "600": { time: "10:00–11:00", event: "Standup", title: "Standup" } } },
		});
	});

	it("skips a start key that is not a canonical 0–1439 integer string, keeping the date's other starts", () => {
		const stored = {
			"uid-1": {
				"2026-08-20": {
					garbage: { time: "10:00–11:00", event: "Junk key", title: "Junk key" },
					"-5": { time: "10:00–11:00", event: "Negative", title: "Negative" },
					"1440": { time: "10:00–11:00", event: "Too late", title: "Too late" },
					"007": { time: "10:00–11:00", event: "Leading zero", title: "Leading zero" },
					"9.5": { time: "10:00–11:00", event: "Not an integer", title: "Not an integer" },
					"600": { time: "10:00–11:00", event: "Standup", title: "Standup" },
				},
			},
		};
		expect(readRowMemory(stored)).toEqual({
			"uid-1": { "2026-08-20": { "600": { time: "10:00–11:00", event: "Standup", title: "Standup" } } },
		});
	});

	it("keeps two meetings of one uid on one day at two different start minutes as independent entries", () => {
		const stored = {
			"uid-1": {
				"2026-08-20": {
					"540": { time: "09:00–09:30", event: "Morning sync", title: "Morning sync" },
					"780": { time: "13:00–13:30", event: "Afternoon sync", title: "Afternoon sync" },
				},
			},
		};
		expect(readRowMemory(stored)).toEqual(stored);
	});
});

describe("readRowMemory — the calendar a row came from", () => {
	const entry = { time: "09:00-09:30", event: "Standup", title: "Standup", wrote: "Standup" };

	it("keeps a source that is text", () => {
		const raw = { u1: { "2026-10-20": { "540": { ...entry, source: "work-id" } } } };
		expect(readRowMemory(raw)).toEqual(raw);
	});

	it("drops a source that is not text and keeps the entry as source-less, so it falls under the every-source rule", () => {
		for (const source of [42, null, ["work-id"], { id: "work-id" }]) {
			const raw = { u1: { "2026-10-20": { "540": { ...entry, source } } } };
			expect(readRowMemory(raw)).toEqual({ u1: { "2026-10-20": { "540": entry } } });
		}
	});

	it("reads an entry written before #1211 without a source as source-less", () => {
		const read = readRowMemory({ u1: { "2026-10-20": { "540": entry } } });
		expect(read.u1["2026-10-20"]["540"]).toEqual(entry);
		expect("source" in read.u1["2026-10-20"]["540"]).toBe(false);
	});
});

describe("pruneRowMemory", () => {
	it("drops every date before today and keeps today, carrying what a kept date holds — including every start it has — unopened", () => {
		const memory = {
			"uid-1": {
				"2026-08-19": { "540": { time: "10:00–11:00", event: "Standup", title: "Standup" } },
				"2026-08-20": {
					"540": { time: "09:00–09:30", event: "Morning sync", title: "Morning sync" },
					"780": { time: "13:00–13:30", event: "Afternoon sync", title: "Afternoon sync" },
				},
				"2026-08-21": { "540": { time: "10:00–11:00", event: "Standup", title: "Standup" } },
			},
		};
		expect(pruneRowMemory(memory, "2026-08-20")).toEqual({
			"uid-1": {
				"2026-08-20": {
					"540": { time: "09:00–09:30", event: "Morning sync", title: "Morning sync" },
					"780": { time: "13:00–13:30", event: "Afternoon sync", title: "Afternoon sync" },
				},
				"2026-08-21": { "540": { time: "10:00–11:00", event: "Standup", title: "Standup" } },
			},
		});
	});

	it("drops a meeting left with no dates on or after today", () => {
		const memory = {
			"uid-1": { "2026-08-19": { "540": { time: "10:00–11:00", event: "Standup", title: "Standup" } } },
			"uid-2": { "2026-08-20": { "540": { time: "09:00–10:00", event: "Retro", title: "Retro" } } },
		};
		expect(pruneRowMemory(memory, "2026-08-20")).toEqual({
			"uid-2": { "2026-08-20": { "540": { time: "09:00–10:00", event: "Retro", title: "Retro" } } },
		});
	});

	it("leaves an empty memory empty", () => {
		expect(pruneRowMemory({}, "2026-08-20")).toEqual({});
	});

	it("never sees a junk or unpadded date key, because readRowMemory has already dropped it", () => {
		// A junk key compares >= today as a string and would be kept for ever;
		// an unpadded key sorts wrongly against a padded one — both bugs
		// readRowMemory's own key validation exists to close off before either
		// key ever reaches this function.
		const stored = {
			"uid-1": { garbage: { "540": { time: "10:00–11:00", event: "Standup", title: "Standup" } } },
			"uid-2": { "2026-9-5": { "540": { time: "09:00–10:00", event: "Retro", title: "Retro" } } },
			"uid-3": { "2026-08-20": { "540": { time: "10:00–11:00", event: "Standup", title: "Standup" } } },
		};
		const memory = readRowMemory(stored);
		expect(pruneRowMemory(memory, "2026-08-19")).toEqual({
			"uid-3": { "2026-08-20": { "540": { time: "10:00–11:00", event: "Standup", title: "Standup" } } },
		});
	});
});
