/**
 * Unit tests for `recheckDismissal`, the rule that says whether a trigger the
 * person dismissed is still dismissed, read against the line as it is now.
 *
 * The suggester asks this on every keystroke, so a test here does the same:
 * it records a dismissal against the line the popup was open on, then reads it
 * against each line text that follows, in order, the way a person's edits
 * arrive. Nothing is cleared by hand. A test that passed `null` where a cleared
 * dismissal belongs would pass whether the rule cleared anything or not, which
 * is the hole #601 found in #579's own tests.
 *
 * `suggest` is asked alongside where a case is about which trigger opens,
 * because the column this rule answers is the `dismissed` that `suggest`
 * compares with the trigger it finds. What is recorded is the trigger's column
 * together with the line's text as last read, and each reading works out where
 * the line changed since, so the cases whose
 * column moves, and the lines holding more than one trigger character, are the
 * ones that tell this rule from a bare column or a count of triggers.
 *
 * Every reading also carries where the cursor is, because an edit whose text
 * repeats what sits beside it leaves the line alone unable to say where it fell,
 * and the edit a person makes ends at the cursor. A line written
 * below marks the cursor with `|`; a line without one has the cursor at its end,
 * as `typing` in `dateEntry.test.ts` places it.
 */

import { describe, expect, it } from "vitest";

import { dismissalFor, recheckDismissal } from "../features/dateEntry/dismissal";
import type { DismissalReading, DismissedTrigger } from "../features/dateEntry/dismissal";
import { suggest } from "../features/dateEntry/suggest";

const TRIGGER = "@";
const ENGLISH = { language: "en" as const, trigger: TRIGGER };

/** Reference Thursday 2026-09-03, built from local parts, as the other date-entry suites pin it. */
const THURSDAY = new Date(2026, 8, 3);

/**
 * The dismissal the suggester records when the person dismisses the popup
 * that was open on line 0 reading `text`, for the trigger at `triggerAt`.
 */
function dismissedOn(text: string, triggerAt: number): DismissedTrigger {
	expect(text.startsWith(TRIGGER, triggerAt), "the popup was open for a trigger that is not there").toBe(
		true,
	);
	return dismissalFor(0, text, triggerAt);
}

/** Where a line written in a test puts the cursor. */
const CURSOR = "|";

/**
 * One line 0 as a test writes it: its text, and the cursor on it — at the
 * `CURSOR` mark, or at the end of the line where there is none.
 */
function read(step: string): { readonly cursor: { line: number; ch: number }; readonly text: string } {
	const mark = step.indexOf(CURSOR);
	if (mark === -1) return { cursor: { line: 0, ch: step.length }, text: step };
	expect(step.indexOf(CURSOR, mark + 1), "a line marks the cursor more than once").toBe(-1);
	return { cursor: { line: 0, ch: mark }, text: step.slice(0, mark) + step.slice(mark + 1) };
}

/**
 * Reads `recorded` against each line in turn, carrying forward what each
 * reading keeps, as the suggester does from one keystroke to the next; answers
 * the last reading.
 */
function across(recorded: DismissedTrigger, ...steps: [string, ...string[]]): DismissalReading {
	let reading: DismissalReading = { recorded, dismissed: null };
	for (const step of steps) {
		const { cursor, text } = read(step);
		// Every step here stays on line 0, so there is never a neighbouring line
		// to read (#617's `nearby`; see `across the trigger's line moving` below
		// for the cases that do read one).
		reading = recheckDismissal(reading.recorded, cursor, text, TRIGGER, []);
	}
	return reading;
}

describe("what is recorded", () => {
	it("is the trigger's line and column, with the line's text as the popup read it", () => {
		expect(dismissalFor(3, "name@example.com @tom @fri", 17)).toEqual({
			line: 3,
			at: 17,
			text: "name@example.com @tom @fri",
		});
	});
});

describe("a dismissed trigger still on the line, unchanged", () => {
	it("is kept, and names the trigger's column for suggest", () => {
		const recorded = dismissedOn("@tom", 0);

		const reading = across(recorded, "@tom");

		expect(reading.recorded).toEqual(recorded);
		expect(reading.dismissed).toBe(0);
		expect(suggest("@tom", ENGLISH, THURSDAY, reading.dismissed)).toBeNull();
	});

	it("is kept while the query after it is typed on", () => {
		const recorded = dismissedOn("task @tom", 5);

		const reading = across(recorded, "task @tomo", "task @tomor");

		expect(reading.recorded).toEqual({ line: 0, at: 5, text: "task @tomor" });
		expect(reading.dismissed).toBe(5);
		expect(suggest("task @tomor", ENGLISH, THURSDAY, reading.dismissed)).toBeNull();
	});
});

describe("a dismissed trigger whose column moves, untouched", () => {
	it("is kept when text is typed in front of it, and names where it sits now", () => {
		// Home, `a ` typed at the start of the line, End, one more character.
		const recorded = dismissedOn("task @tom", 5);

		const reading = across(recorded, "a|task @tom", "a |task @tom", "a task @tomo");

		expect(reading.recorded).toEqual({ line: 0, at: 7, text: "a task @tomo" });
		expect(reading.dismissed).toBe(7);
		expect(suggest("a task @tomo", ENGLISH, THURSDAY, reading.dismissed)).toBeNull();
	});

	it("is kept when text in front of it is deleted", () => {
		const recorded = dismissedOn("task @tom", 5);

		const reading = across(recorded, "|ask @tom", "ask @tomo");

		expect(reading.recorded).toEqual({ line: 0, at: 4, text: "ask @tomo" });
		expect(reading.dismissed).toBe(4);
		expect(suggest("ask @tomo", ENGLISH, THURSDAY, reading.dismissed)).toBeNull();
	});
});

describe("a line holding more than one trigger character", () => {
	it("is kept when a trigger character is typed in front of it, which is judged fresh", () => {
		// Home, `@x ` typed at the start of the line, End, one more character.
		const reading = across(
			dismissedOn("task @tom", 5),
			"@|task @tom",
			"@x|task @tom",
			"@x |task @tom",
			"@x task @tomo",
		);

		expect(reading.recorded).not.toBeNull();
		expect(reading.dismissed).toBe(8);
		expect(suggest("@x task @tomo", ENGLISH, THURSDAY, reading.dismissed)).toBeNull();
		expect(suggest("@x", ENGLISH, THURSDAY, reading.dismissed)).not.toBeNull();
	});

	it("is kept when a trigger character in front of it is deleted", () => {
		const reading = across(dismissedOn("@a @b", 3), "|a @b", "a @bc");

		expect(reading.recorded).not.toBeNull();
		expect(reading.dismissed).toBe(2);
		expect(suggest("a @bc", ENGLISH, THURSDAY, reading.dismissed)).toBeNull();
	});

	it("does not pass to the trigger after it when a trigger ahead of it is deleted", () => {
		const reading = across(dismissedOn("@a @b @c", 3), "|a @b @c", "a @b @cd");

		expect(reading.dismissed).toBe(2);
		expect(suggest("a @b @cd", ENGLISH, THURSDAY, reading.dismissed)?.triggerAt).toBe(5);
	});

	it("clears on its own delete with another trigger after it, so the retyped one opens", () => {
		const reading = across(dismissedOn("@tom and @fri", 0), "|tom and @fri", "@|tom and @fri");

		expect(reading.recorded).toBeNull();
		expect(reading.dismissed).toBeNull();
		expect(suggest("@", ENGLISH, THURSDAY, reading.dismissed)).not.toBeNull();
	});

	it("does not pass to the trigger after it once it is deleted", () => {
		const reading = across(dismissedOn("@tom and @fri", 0), "|tom and @fri");

		expect(reading.dismissed).toBeNull();
		expect(suggest("tom and @fri", ENGLISH, THURSDAY, reading.dismissed)?.triggerAt).toBe(8);
	});
});

describe("an edit whose text repeats what sits beside it", () => {
	it("opens a trigger typed directly in front of the dismissed one, which stays dismissed", () => {
		// Cursor to column 5, `@` typed, then `x`.
		const recorded = dismissedOn("task @tom", 5);

		const typed = across(recorded, "task @|@tom");

		expect(typed.dismissed).toBe(6);
		expect(suggest("task @", ENGLISH, THURSDAY, typed.dismissed)?.triggerAt).toBe(5);

		const typedOn = across(recorded, "task @|@tom", "task @x|@tom");

		expect(typedOn.recorded).toEqual({ line: 0, at: 7, text: "task @x@tom" });
		expect(suggest("task @x", ENGLISH, THURSDAY, typedOn.dismissed)?.triggerAt).toBe(5);
	});

	it("opens a trigger typed directly in front of a dismissed one at the start of the line", () => {
		const reading = across(dismissedOn("@tom", 0), "@|@tom");

		expect(reading.recorded).toEqual({ line: 0, at: 1, text: "@@tom" });
		expect(suggest("@", ENGLISH, THURSDAY, reading.dismissed)?.triggerAt).toBe(0);
	});

	it("clears when the first of two identical stretches is cut in one operation, and it was the dismissed one", () => {
		// `@a ` selected from the front and deleted, or taken with Ctrl+Backspace.
		const reading = across(dismissedOn("@a @a", 0), "|@a");

		expect(reading.recorded).toBeNull();
		expect(suggest("@a", ENGLISH, THURSDAY, reading.dismissed)?.triggerAt).toBe(0);
	});

	it("is kept when an identical stretch in front of it is cut in one operation", () => {
		const reading = across(dismissedOn("@tom @tom", 5), "|@tom");

		expect(reading.recorded).toEqual({ line: 0, at: 0, text: "@tom" });
		expect(suggest("@tom", ENGLISH, THURSDAY, reading.dismissed)).toBeNull();
	});

	it("is kept when a stretch in front of it that starts with the same character is cut in one operation", () => {
		const reading = across(dismissedOn("@a @b", 3), "|@b");

		expect(reading.recorded).toEqual({ line: 0, at: 0, text: "@b" });
		expect(suggest("@b", ENGLISH, THURSDAY, reading.dismissed)).toBeNull();
	});

	it("clears when it is the second of two identical stretches and that one is cut", () => {
		// ` @tom` taken from the end: the same line as `@tom ` taken from the
		// front, told apart by where the cursor is left.
		const reading = across(dismissedOn("@tom @tom", 5), "@tom|");

		expect(reading.recorded).toBeNull();
	});

	it("keeps the first of two identical stretches when the second is cut", () => {
		const reading = across(dismissedOn("@tom @tom", 0), "@tom|");

		expect(reading.recorded).toEqual({ line: 0, at: 0, text: "@tom" });
	});

	it("reads an edit the text leaves in no doubt the same wherever the cursor is", () => {
		// Tab indents the whole list item with the cursor at the end of the line,
		// so the edit is nowhere near the cursor; the line alone says where it fell.
		const reading = across(dismissedOn("- task @tom", 7), "\t- task @tom|");

		expect(reading.recorded).toEqual({ line: 0, at: 8, text: "\t- task @tom" });
	});
});

describe("the known limit", () => {
	it("holds across a paste of the same character over the dismissed trigger", () => {
		// One change that swaps `@` for `@` leaves a line that reads exactly as
		// before, so there is no delete to see.
		const recorded = dismissedOn("task @tom", 5);

		const reading = across(recorded, "task @|tom");

		expect(reading.recorded).toEqual(recorded);
		expect(reading.dismissed).toBe(5);
	});

	it("places an edit that did not end at the cursor as near the cursor as the text allows", () => {
		// `@a ` taken from the front of `@a @a` by something other than the
		// person typing at the cursor, which sits at the end of the line: the
		// line reads the same as ` @a` taken from its end, and the edit is read
		// as falling there, so the first `@a` keeps the dismissal the one cut
		// away had.
		const reading = across(dismissedOn("@a @a", 0), "@a|");

		expect(reading.recorded).toEqual({ line: 0, at: 0, text: "@a" });
	});

	it("clears when one reading finds edits on both sides of the trigger", () => {
		const reading = across(dismissedOn("a @tom b", 2), "xa @tom by");

		expect(reading.recorded).toBeNull();
	});
});

describe("a dismissed trigger deleted and retyped at the same position", () => {
	it("clears on the delete, so the retyped trigger opens", () => {
		// Backspaced away one keystroke at a time, then typed again in the same
		// place. The line after the retype reads exactly as the dismissed one
		// did; only the delete in between tells the two apart.
		const reading = across(dismissedOn("@tom", 0), "@to", "@t", "@", "", "@");

		expect(reading.recorded).toBeNull();
		expect(reading.dismissed).toBeNull();
		expect(suggest("@", ENGLISH, THURSDAY, reading.dismissed)).not.toBeNull();
	});

	it("clears on the delete itself, before anything is retyped", () => {
		const reading = across(dismissedOn("task @tom", 5), "task ");

		expect(reading.recorded).toBeNull();
		expect(reading.dismissed).toBeNull();
	});
});

describe("a different trigger on the same line", () => {
	it("is not the trigger the recorded dismissal applies to", () => {
		const line = "@tom and @tom";

		const reading = across(dismissedOn("@tom", 0), line);

		// The dismissal still names the first trigger's column, not the second's,
		// so `suggest` finds the second at the cursor and opens for it.
		expect(reading.dismissed).toBe(0);
		expect(suggest(line, ENGLISH, THURSDAY, reading.dismissed)?.triggerAt).toBe(9);
	});

	it("opens a different trigger ahead of the dismissed one", () => {
		const line = "@fri and @tom";

		const reading = across(dismissedOn(line, 9), line);

		expect(reading.dismissed).toBe(9);
		expect(suggest(line.slice(0, 4), ENGLISH, THURSDAY, reading.dismissed)?.triggerAt).toBe(0);
	});

	it("leaves the first dismissed for when the cursor goes back to it", () => {
		const line = "@tom and @tom";

		const reading = across(dismissedOn("@tom", 0), line);

		expect(reading.recorded).not.toBeNull();
		expect(suggest(line.slice(0, 4), ENGLISH, THURSDAY, reading.dismissed)).toBeNull();
	});
});

describe("what a reading answers with nothing to apply", () => {
	it("answers nothing when nothing is recorded", () => {
		expect(recheckDismissal(null, { line: 0, ch: 4 }, "@tom", TRIGGER, [])).toEqual({
			recorded: null,
			dismissed: null,
		});
	});

	it("keeps a dismissal recorded on another line, and does not apply it here", () => {
		const recorded = dismissedOn("@tom", 0);

		// Its own line reads exactly as recorded: nothing shifted, so this is a
		// second, unrelated occurrence rather than the same trigger moved here.
		const reading = recheckDismissal(recorded, { line: 1, ch: 4 }, "@tom", TRIGGER, [
			{ line: 0, text: "@tom" },
		]);

		expect(reading.recorded).toEqual(recorded);
		expect(reading.dismissed).toBeNull();
	});
});

/**
 * A line inserted or removed above the trigger's line moves it to a new line
 * number, itself untouched, so decision 4 keeps it dismissed once the cursor
 * comes back to it.
 *
 * These cases carry `nearby`, the couple of lines beside a dismissal's
 * recorded line that `recheckDismissal`'s cross-line case reads instead of
 * the whole document — see that function's own docstring. `across` above
 * never needs one: every case there stays on line 0.
 */
describe("a trigger whose line number shifts, itself untouched", () => {
	it("stays dismissed once a line is inserted well above it, and the trigger returns to view", () => {
		// `task @tom` dismissed on line 2 of `["aaa", "bbb", "task @tom"]`. A
		// split two lines above it — "aaa" becomes "a" and "aa" — pushes it to
		// line 3, and the cursor lands on the new "aa", not on it.
		const recorded = dismissalFor(2, "task @tom", 5);

		const shifted = recheckDismissal(recorded, { line: 1, ch: 2 }, "aa", TRIGGER, [
			{ line: 2, text: "bbb" },
			{ line: 3, text: "task @tom" },
		]);
		expect(shifted.recorded).toEqual({ line: 3, at: 5, text: "task @tom" });
		expect(shifted.dismissed).toBeNull();

		// Back on it, and one more character after the trigger.
		const back = recheckDismissal(shifted.recorded, { line: 3, ch: 10 }, "task @tomo", TRIGGER, []);
		expect(back.recorded).toEqual({ line: 3, at: 5, text: "task @tomo" });
		expect(back.dismissed).toBe(5);
		expect(suggest("task @tomo", ENGLISH, THURSDAY, back.dismissed)).toBeNull();
	});

	it("stays dismissed once a line above it is deleted outright", () => {
		// `task @tom` dismissed on line 2 of `["aaa", "bbb", "task @tom"]`. "bbb"
		// is deleted whole, and the cursor lands at the start of "task @tom",
		// now line 1, in the same edit.
		const recorded = dismissalFor(2, "task @tom", 5);

		const reading = recheckDismissal(recorded, { line: 1, ch: 0 }, "task @tom", TRIGGER, []);

		expect(reading.recorded).toEqual({ line: 1, at: 5, text: "task @tom" });
		expect(reading.dismissed).toBe(5);
		expect(suggest("task @tom", ENGLISH, THURSDAY, reading.dismissed)).toBeNull();
	});

	it("stays dismissed once a line above it is deleted outright, with a line still following it", () => {
		// `task @tom` dismissed on line 2 of `["aaa", "bbb", "task @tom", "zzz"]`.
		// "bbb" is deleted whole, same as above, but this time a line follows
		// the trigger too — `nearbyLines` always hands back a line that exists,
		// so a real document rarely leaves `nearby` empty the way the case
		// above does only because the trigger sat on the document's last line.
		const recorded = dismissalFor(2, "task @tom", 5);

		const reading = recheckDismissal(recorded, { line: 1, ch: 0 }, "task @tom", TRIGGER, [
			{ line: 2, text: "zzz" },
		]);

		expect(reading.recorded).toEqual({ line: 1, at: 5, text: "task @tom" });
		expect(reading.dismissed).toBe(5);
		expect(suggest("task @tom", ENGLISH, THURSDAY, reading.dismissed)).toBeNull();
	});

	it("stays dismissed when a line inserted right above it leaves a blank line at its old number", () => {
		// Pressing Enter at the end of the line right before a dismissed trigger
		// creates a blank line at the trigger's own recorded number, and the
		// cursor lands there — not a delete of the trigger's line, but the same
		// line number now holds something else entirely.
		const recorded = dismissalFor(1, "task @tom", 5);

		const shifted = recheckDismissal(recorded, { line: 1, ch: 0 }, "", TRIGGER, [
			{ line: 2, text: "task @tom" },
		]);
		expect(shifted.recorded).toEqual({ line: 2, at: 5, text: "task @tom" });
		expect(shifted.dismissed).toBeNull();

		const back = recheckDismissal(shifted.recorded, { line: 2, ch: 10 }, "task @tomo", TRIGGER, []);
		expect(back.dismissed).toBe(5);
	});

	it("does not confuse a deleted trigger elsewhere with one still recorded, when the cursor is not on its line", () => {
		// The trigger's own line has moved (nothing at line 2 or beside it reads
		// as recorded), and the cursor is on an unrelated line where the trigger
		// is plainly not there — this cannot confirm a delete, only that this
		// reading found nothing, so the dismissal stays recorded rather than
		// being lost, per the limit above.
		const recorded = dismissalFor(2, "task @tom", 5);

		const reading = recheckDismissal(recorded, { line: 1, ch: 0 }, "task ", TRIGGER, []);

		expect(reading.recorded).toEqual(recorded);
		expect(reading.dismissed).toBeNull();
	});

	it("does not confuse a deleted trigger elsewhere with one still recorded, when a nearby line reads as something else entirely", () => {
		// The same reading, but this time line 2 exists and `nearbyLines` hands
		// its content back — the shape a real document produces, rather than
		// the empty list above, which only holds because the trigger's own line
		// and its neighbours had all gone out of range.
		const recorded = dismissalFor(2, "task @tom", 5);

		const reading = recheckDismissal(recorded, { line: 1, ch: 0 }, "task ", TRIGGER, [
			{ line: 2, text: "something else" },
		]);

		expect(reading.recorded).toEqual(recorded);
		expect(reading.dismissed).toBeNull();
	});

	it("keeps a dismissal it cannot find nearby, without applying or clearing it, when it moved more than one line", () => {
		// Two lines inserted above it at once, and the cursor lands somewhere
		// else first — neither its old number nor a line beside it holds it, so
		// this reading cannot say where it went. It stays recorded rather than
		// being cleared, ready for a reading that does land on it.
		const recorded = dismissalFor(2, "task @tom", 5);

		const reading = recheckDismissal(recorded, { line: 1, ch: 3 }, "bbb", TRIGGER, [
			{ line: 2, text: "xxx" },
			{ line: 3, text: "ccc" },
		]);

		expect(reading.recorded).toEqual(recorded);
		expect(reading.dismissed).toBeNull();
	});

	it("keeps a dismissal recorded, rather than trusting a line more than one away, when it moved more than one line", () => {
		// The same two-line insertion above it, and this time the cursor lands
		// on the trigger's now-correct line directly — but that line sits two
		// away from where the dismissal was recorded, past `nearby`'s one-line
		// window, so this reading cannot tell a real shift from a different
		// trigger that merely reads the same; the dismissal is kept recorded,
		// not applied, until a reading lands within that window of it.
		const recorded = dismissalFor(2, "task @tom", 5);

		const reading = recheckDismissal(recorded, { line: 4, ch: 10 }, "task @tomo", TRIGGER, [
			{ line: 1, text: "bbb" },
			{ line: 3, text: "ccc" },
		]);

		expect(reading.recorded).toEqual(recorded);
		expect(reading.dismissed).toBeNull();
	});
});

/**
 * A line more than one away from a dismissal's recorded line can read as the
 * same trigger purely by coincidence: `findTrigger`'s arithmetic only asks
 * whether the shared prefix reaches the trigger, and two lines with a
 * different trigger character but the same words in front of it — two task
 * lines, say — pass that test without being the same occurrence at all.
 */
describe("a line sharing a prefix with the recorded one, more than one line away", () => {
	it("does not pass the dismissal to a different, never-dismissed trigger merely because their lines start the same way", () => {
		// "task @tom" dismissed on line 0. Two lines pasted above push it to
		// line 2, and the cursor lands on a different, never-dismissed trigger
		// four lines further down — "task @bob" shares "task @" with the
		// recorded line, but is not it.
		const recorded = dismissalFor(0, "task @tom", 5);

		const reading = recheckDismissal(recorded, { line: 4, ch: 9 }, "task @bob", TRIGGER, [
			{ line: 0, text: "p1" },
			{ line: 1, text: "p2" },
		]);

		expect(reading.recorded).toEqual(recorded);
		expect(reading.dismissed).toBeNull();
	});
});
