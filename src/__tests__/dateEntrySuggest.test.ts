/**
 * Unit tests for `suggest`, the date-entry popup's whole judgement.
 *
 * All tests use a fixed reference day, Thursday 2026-09-03, the same day
 * `dateEntryEnglish.test.ts` pins for #578's own measurements, built from
 * local parts and read back the same way, never through `toISOString`.
 */

import { describe, expect, it } from "vitest";

import { suggest } from "../features/dateEntry/suggest";

/** A local date, the way a day's log is named after the local day. */
const day = (y: number, m: number, d: number): Date => new Date(y, m - 1, d);

/** Reference Thursday, shared with #578's own measurements. */
const THURSDAY = day(2026, 9, 3);

/** Formats a Date as YYYY-MM-DD from local parts, for readable assertions. */
function fmt(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${dd}`;
}

const SWEDISH = { language: "sv" as const, trigger: "@" };
const ENGLISH = { language: "en" as const, trigger: "@" };

describe("when the popup opens", () => {
	it("opens at the start of the line", () => {
		expect(suggest("@", ENGLISH, THURSDAY, null)).not.toBeNull();
	});

	it("opens after a space", () => {
		expect(suggest("do the thing @", ENGLISH, THURSDAY, null)).not.toBeNull();
	});

	it("opens after a tab", () => {
		expect(suggest("do the thing\t@", ENGLISH, THURSDAY, null)).not.toBeNull();
	});

	it("gives the trigger's position in triggerAt", () => {
		const result = suggest("do the thing @", ENGLISH, THURSDAY, null);
		expect(result?.triggerAt).toBe(13);
	});
});

describe("a trigger mid-word does not open", () => {
	// The accepted loss of the author's 2026-08-27 ruling, recorded in spec
	// #573: deliberate, not a bug — see suggest.ts's own comment at the
	// boundary check.
	it("does not open for name@example.com", () => {
		expect(suggest("name@example.com", ENGLISH, THURSDAY, null)).toBeNull();
	});

	it("does not open for task@imorgon", () => {
		expect(suggest("task@imorgon", SWEDISH, THURSDAY, null)).toBeNull();
	});
});

describe("a query holding a second trigger character does not open", () => {
	it("declines when a second trigger sits inside the query with no space before it", () => {
		expect(suggest("@ab@cd", ENGLISH, THURSDAY, null)).toBeNull();
	});

	it("still opens the later trigger when a space separates the two", () => {
		// Two independent triggers, not one query holding a second trigger
		// character — the nearer one to the cursor is the active one.
		const result = suggest("@foo @bar", ENGLISH, THURSDAY, null);
		expect(result?.triggerAt).toBe(5);
	});
});

/**
 * What `suggest` itself does with a dismissal position, and nothing more.
 *
 * Whether a dismissal still holds — cleared once its trigger is deleted, so a
 * retyped one opens, and not applied to a different trigger — is decided before
 * `suggest` is asked, by `recheckDismissal`, and proved against real line text
 * in `dateEntryDismissal.test.ts`. A test here that
 * handed in `null` to stand for a cleared dismissal would pass whether anything
 * cleared or not.
 */
describe("dismissal (#579 criteria 4 and 5)", () => {
	it("stays closed while dismissed names the trigger's own position", () => {
		const line = "@";
		const triggerAt = suggest(line, ENGLISH, THURSDAY, null)?.triggerAt as number;
		expect(suggest(line, ENGLISH, THURSDAY, triggerAt)).toBeNull();
	});

	it("answers exactly as with no dismissal when dismissed names any other position", () => {
		// `dismissed` plays no part but the one comparison: a position that is
		// not this trigger's changes nothing about the answer, before it or after.
		const line = "task @tom";
		const undismissed = suggest(line, ENGLISH, THURSDAY, null);
		expect(undismissed).not.toBeNull();
		expect(suggest(line, ENGLISH, THURSDAY, 4)).toEqual(undismissed);
		expect(suggest(line, ENGLISH, THURSDAY, 6)).toEqual(undismissed);
	});

	it("opens a different trigger on the same line even while the first stays dismissed", () => {
		const line = "@foo @bar";
		const firstTriggerAt = 0;
		const result = suggest(line, ENGLISH, THURSDAY, firstTriggerAt);
		expect(result).not.toBeNull();
		expect(result?.triggerAt).toBe(5);
	});

	it("a trigger the boundary rule declines answers no position, dismissed there or not", () => {
		// The boundary rule is judged before the dismissal, so the answer is the
		// same `null` either way, and a `null` carries no `triggerAt` a caller
		// could record a dismissal from. That the suggester records none is its
		// own test, in `dateEntry.test.ts`.
		expect(suggest("task@imorgon", SWEDISH, THURSDAY, null)).toBeNull();
		expect(suggest("task@imorgon", SWEDISH, THURSDAY, 4)).toBeNull();
	});
});

describe("the trigger is whatever the setting holds", () => {
	it("opens on the configured character", () => {
		expect(suggest("#", { language: "en", trigger: "#" }, THURSDAY, null)).not.toBeNull();
	});

	it("does not open on @ when the trigger is set to something else", () => {
		expect(suggest("@", { language: "en", trigger: "#" }, THURSDAY, null)).toBeNull();
	});
});

describe("prefix placeholders, in both languages", () => {
	it.each([
		["s", "scheduled"],
		["s ", "scheduled"],
		["sch", "scheduled"],
		["sch ", "scheduled"],
		["schema", "scheduled"],
		["schema ", "scheduled"],
		["d", "due"],
		["d ", "due"],
		["due", "due"],
		["due ", "due"],
	] as const)("%s -> %s placeholder, with its emoji, in English", (query, kind) => {
		const result = suggest(`@${query}`, ENGLISH, THURSDAY, null);
		expect(result?.kind).toBe(kind);
		expect(result?.suggestion).toBeNull();
		expect(result?.showEmoji).toBe(true);
	});

	it.each([
		["s", "scheduled"],
		["s ", "scheduled"],
		["sch", "scheduled"],
		["sch ", "scheduled"],
		["schema", "scheduled"],
		["schema ", "scheduled"],
		["d", "due"],
		["d ", "due"],
		["due", "due"],
		["due ", "due"],
	] as const)("%s -> %s placeholder, with its emoji, in Swedish", (query, kind) => {
		const result = suggest(`@${query}`, SWEDISH, THURSDAY, null);
		expect(result?.kind).toBe(kind);
		expect(result?.suggestion).toBeNull();
		expect(result?.showEmoji).toBe(true);
	});

	it("matches case-insensitively", () => {
		const result = suggest("@DUE", ENGLISH, THURSDAY, null);
		expect(result?.kind).toBe("due");
		expect(result?.suggestion).toBeNull();
		expect(result?.showEmoji).toBe(true);
	});
});

describe("a prefix word followed by a date", () => {
	it("d imorgon in Swedish gives a due date for tomorrow", () => {
		const result = suggest("@d imorgon", SWEDISH, THURSDAY, null);
		expect(result?.kind).toBe("due");
		expect(result?.suggestion?.phrase).toBe("imorgon");
		expect(result?.suggestion && fmt(result.suggestion.date)).toBe("2026-09-04");
	});

	it("s next f in English gives a scheduled date for next friday", () => {
		const result = suggest("@s next f", ENGLISH, THURSDAY, null);
		expect(result?.kind).toBe("scheduled");
		expect(result?.suggestion?.phrase).toBe("next friday");
		expect(result?.suggestion && fmt(result.suggestion.date)).toBe("2026-09-11");
	});
});

describe("the prefix check runs before either parser", () => {
	it("@d in English gives the due placeholder, not day after tomorrow", () => {
		const result = suggest("@d", ENGLISH, THURSDAY, null);
		expect(result?.kind).toBe("due");
		expect(result?.suggestion).toBeNull();
	});

	it("@da in English gives day after tomorrow", () => {
		const result = suggest("@da", ENGLISH, THURSDAY, null);
		expect(result?.suggestion?.phrase).toBe("day after tomorrow");
		expect(result?.suggestion && fmt(result.suggestion.date)).toBe("2026-09-05");
	});

	it("@s in Swedish gives the scheduled placeholder, not söndag", () => {
		const result = suggest("@s", SWEDISH, THURSDAY, null);
		expect(result?.kind).toBe("scheduled");
		expect(result?.suggestion).toBeNull();
	});

	it("@sö in Swedish gives söndag", () => {
		const result = suggest("@sö", SWEDISH, THURSDAY, null);
		expect(result?.suggestion?.phrase).toBe("söndag");
		expect(result?.suggestion && fmt(result.suggestion.date)).toBe("2026-09-06");
	});
});

describe("placeholders with no emoji", () => {
	it("the trigger alone gives the placeholder with no emoji", () => {
		const result = suggest("@", ENGLISH, THURSDAY, null);
		expect(result?.suggestion).toBeNull();
		expect(result?.showEmoji).toBe(false);
	});

	it("an unparseable query with no prefix gives the placeholder with no emoji", () => {
		const result = suggest("@xyzzy", ENGLISH, THURSDAY, null);
		expect(result?.suggestion).toBeNull();
		expect(result?.showEmoji).toBe(false);
	});
});

describe("a trigger before a bracket does not open", () => {
	// If wrong (rule missing): `@[[` has query "[[", no date parses, and the
	// placeholder opens — the result is non-null.
	it("@[[ opens nothing", () => {
		expect(suggest("@[[", ENGLISH, THURSDAY, null)).toBeNull();
	});

	// If wrong (rule asks for two brackets): `@[` still opens the placeholder.
	it("@[ opens nothing", () => {
		expect(suggest("@[", ENGLISH, THURSDAY, null)).toBeNull();
	});

	// If wrong (rule tied to `@`): with the trigger set to `!`, `![[` opens.
	it("![[ with the trigger set to ! opens nothing", () => {
		expect(suggest("![[", { language: "en", trigger: "!" }, THURSDAY, null)).toBeNull();
	});

	// If wrong (a rule that went too far and shut a plain date word): tomorrow's
	// date would no longer be offered. `@imorgon` holds no bracket; it checks
	// that the bracket rule leaves an ordinary query alone.
	it("@imorgon still opens with tomorrow's date", () => {
		const result = suggest("@imorgon", SWEDISH, THURSDAY, null);
		expect(result?.suggestion?.phrase).toBe("imorgon");
		expect(result?.suggestion && fmt(result.suggestion.date)).toBe("2026-09-04");
	});
});

describe("nothing is cached between calls", () => {
	it("the same line answers differently the moment the language does", () => {
		// "mån" is a bare Swedish weekday short form; not a phrase either
		// English candidate list entry or chrono is expected to answer.
		const swedish = suggest("@mån", SWEDISH, THURSDAY, null);
		const english = suggest("@mån", ENGLISH, THURSDAY, null);

		expect(swedish?.suggestion).not.toBeNull();
		expect(english?.suggestion).toBeNull();
	});
});
