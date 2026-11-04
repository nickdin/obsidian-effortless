import { describe, it, expect } from "vitest";
import { readMeetingCell } from "../features/dayView/meetingCell";

/**
 * Carried from `~/Devbox/schema-render/src/__tests__/parser.test.ts`'s
 * `parseCell` suite, with the same reading and the same
 * shape, plus the day view's own `looksLikeLink` — the old plugin had no
 * such field, and a cell it read as plain text because it held one `[[` too
 * many was clickable as if it were a link (old issues #23, #30; spec #618,
 * named difference 11).
 */

describe("readMeetingCell", () => {
	it("parses plain text", () => {
		expect(readMeetingCell("Lunch")).toEqual({
			display: "Lunch",
			linktext: "Lunch",
			isWikilink: false,
			trailingParen: null,
			looksLikeLink: false,
		});
	});

	it("returns an empty cell for empty input", () => {
		expect(readMeetingCell("")).toEqual({
			display: "",
			linktext: null,
			isWikilink: false,
			trailingParen: null,
			looksLikeLink: false,
		});
	});

	it("returns an empty cell for whitespace only", () => {
		expect(readMeetingCell("   ")).toEqual({
			display: "",
			linktext: null,
			isWikilink: false,
			trailingParen: null,
			looksLikeLink: false,
		});
	});

	it("parses a whole wikilink", () => {
		expect(readMeetingCell("[[Planering]]")).toEqual({
			display: "Planering",
			linktext: "Planering",
			isWikilink: true,
			trailingParen: null,
			looksLikeLink: false,
		});
	});

	it("parses an aliased wikilink written with a bare pipe", () => {
		expect(readMeetingCell("[[Planering|Kickoff]]")).toEqual({
			display: "Kickoff",
			linktext: "Planering",
			isWikilink: true,
			trailingParen: null,
			looksLikeLink: false,
		});
	});

	it("parses an aliased wikilink written with the table-escaped pipe", () => {
		expect(readMeetingCell("[[Planering\\|Kickoff]]")).toEqual({
			display: "Kickoff",
			linktext: "Planering",
			isWikilink: true,
			trailingParen: null,
			looksLikeLink: false,
		});
	});

	it("holds a link's trailing parenthesis apart from the target", () => {
		expect(readMeetingCell("[[Avstämning]] (Teams)")).toEqual({
			display: "Avstämning",
			linktext: "Avstämning",
			isWikilink: true,
			trailingParen: "Teams",
			looksLikeLink: false,
		});
	});

	it("holds plain text's trailing parenthesis apart from the name", () => {
		// So "Avstämning (Teams)" names the note "Avstämning", not the whole string.
		expect(readMeetingCell("Avstämning (Teams)")).toEqual({
			display: "Avstämning",
			linktext: "Avstämning",
			isWikilink: false,
			trailingParen: "Teams",
			looksLikeLink: false,
		});
	});

	it("keeps a non-trailing parenthesis in the plain-text display", () => {
		expect(readMeetingCell("A (b) c")).toEqual({
			display: "A (b) c",
			linktext: "A (b) c",
			isWikilink: false,
			trailingParen: null,
			looksLikeLink: false,
		});
	});

	// A link followed by words is not a whole wikilink, and the old reader took
	// it as plain text with no signal that clicking it should do nothing. This
	// reading marks it instead, so a later ticket's click handling can refuse it
	// rather than create a junk note from the brackets (spec #618, old issues
	// #23, #30).
	it("marks a cell mixing a link with words as looking like a link", () => {
		const cell = readMeetingCell("[[Avstämning]], flyttad från igår");
		expect(cell.isWikilink).toBe(false);
		expect(cell.display).toBe("[[Avstämning]], flyttad från igår");
		expect(cell.looksLikeLink).toBe(true);
	});

	it("marks a link with two trailing parenthesis groups as looking like a link", () => {
		const cell = readMeetingCell("[[Avstämning]] (Teams) (avbokat)");
		expect(cell.isWikilink).toBe(false);
		expect(cell.looksLikeLink).toBe(true);
	});

	it("does not mark plain text with no brackets as looking like a link", () => {
		expect(readMeetingCell("Lunch").looksLikeLink).toBe(false);
	});
});
