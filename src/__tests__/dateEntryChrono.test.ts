import * as chronoEnglish from "chrono-node/en";
import { describe, expect, it } from "vitest";

/**
 * The answers `chrono` 2.9.0 gets wrong, pinned on purpose.
 *
 * The date-entry feature's English parser falls back on `chrono` for anything
 * it does not answer itself, and it answers these five phrases itself because
 * the library's answers to them are wrong (spec #573, decisions 7 and 10;
 * measured in #22 and #24). Every expectation below is the library's wrong
 * answer, not the right one. Do not "fix" them: an upgrade that changes one of
 * them fails here, which is the point — the English parser's routing was
 * decided against exactly these answers, and a changed answer has to be looked
 * at before it silently changes a date someone types.
 *
 * Only the English locale is imported, by path, so the other eleven locales stay
 * out of the built plugin. Dates are built and read from local
 * parts, so the test means the same in every time zone.
 */

/** Thursday 2026-09-03, noon local time. */
const reference = new Date(2026, 8, 3, 12, 0, 0);

/** The date `chrono` answers for `text`, as `YYYY-MM-DD` from local parts, or `null` when it answers nothing. */
function chronoAnswer(text: string): string | null {
	const answer = chronoEnglish.parseDate(text, reference, { forwardDate: true });
	if (answer === null) return null;
	const month = String(answer.getMonth() + 1).padStart(2, "0");
	const day = String(answer.getDate()).padStart(2, "0");
	return `${answer.getFullYear()}-${month}-${day}`;
}

describe("chrono 2.9.0's wrong answers, pinned so an upgrade that changes one fails here", () => {
	it("is asked on a Thursday", () => {
		expect(reference.getDay()).toBe(4);
	});

	it("answers tomorrow for 'day after tomorrow' — wrong, it is the day after", () => {
		expect(chronoAnswer("day after tomorrow")).toBe("2026-09-04");
	});

	it("answers today for 'next m' — wrong, it is next Monday", () => {
		expect(chronoAnswer("next m")).toBe("2026-09-03");
	});

	it("answers today for 'thursday' on a Thursday — wrong, it is a week on", () => {
		expect(chronoAnswer("thursday")).toBe("2026-09-03");
	});

	it("answers the same weekday a week on for 'next week'", () => {
		expect(chronoAnswer("next week")).toBe("2026-09-10");
	});

	it("answers nothing for 'tues' — wrong, it is Tuesday", () => {
		expect(chronoAnswer("tues")).toBeNull();
	});
});
