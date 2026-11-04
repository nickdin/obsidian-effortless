import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	UNTITLED_MEETING_TITLE,
	locationSuffix,
	meetingNoteBasename,
	meetingNoteTitle,
	meetingTitle,
	plainCellText,
} from "../core/meetingName";

describe("meetingNoteTitle", () => {
	it("drops a colon and keeps one space", () => {
		expect(meetingNoteTitle("VB: Exempelrådet för samordning")).toBe(
			"VB Exempelrådet för samordning",
		);
	});

	it("turns a slash into a space rather than joining the words", () => {
		expect(meetingNoteTitle("Provgruppering/PROV - arbetet fortsätter")).toBe(
			"Provgruppering PROV - arbetet fortsätter",
		);
	});

	it("removes every character that breaks a filename or a wikilink", () => {
		expect(meetingNoteTitle('a*b"c\\d/e<f>g:h|i?j[k]l#m^n')).toBe("a b c d e f g h i j k l m n");
	});

	it("never produces a double space", () => {
		expect(meetingNoteTitle("Möte :: två")).toBe("Möte två");
	});

	it("falls back to the placeholder when nothing usable is left", () => {
		expect(meetingNoteTitle("///")).toBe(UNTITLED_MEETING_TITLE);
	});

	it("leaves parentheses alone — a filename may hold them", () => {
		expect(meetingNoteTitle("Avstämning Informationskatalog (arbetsnamn)")).toBe(
			"Avstämning Informationskatalog (arbetsnamn)",
		);
	});
});

describe("meetingTitle", () => {
	it("gives an untitled meeting a name, so no path is built out of nothing", () => {
		expect(meetingTitle("")).toBe(UNTITLED_MEETING_TITLE);
		expect(meetingTitle("   ")).toBe(UNTITLED_MEETING_TITLE);
	});

	it("trims a summary carrying a trailing space", () => {
		expect(meetingTitle(" Provmöte ")).toBe("Provmöte");
	});
});

describe("meetingNoteBasename", () => {
	it("is the date, a space, and the cleaned title", () => {
		expect(meetingNoteBasename("2026-08-20", "Provmöte")).toBe("2026-08-20 Provmöte");
	});

	it("does not leave an untitled meeting as a bare date", () => {
		expect(meetingNoteBasename("2026-08-20", "")).toBe(`2026-08-20 ${UNTITLED_MEETING_TITLE}`);
	});

	it("carries no folder — a bare basename, never a path", () => {
		const basename = meetingNoteBasename("2026-08-20", "Provmöte");
		expect(basename).not.toContain("/");
	});

	it("gives the filename's title the same text meetingNoteTitle gives the heading, so the two can never disagree", () => {
		const summary = "VB: Exempelrådet/vidare (arbetsnamn)";
		const basename = meetingNoteBasename("2026-08-20", summary);
		expect(basename).toBe(`2026-08-20 ${meetingNoteTitle(summary)}`);
	});
});

describe("plainCellText", () => {
	it("keeps a colon and a slash — a hand-written row may carry both", () => {
		expect(plainCellText("Match: Provklubben P14 - Exempelklubben Röd")).toBe(
			"Match: Provklubben P14 - Exempelklubben Röd",
		);
	});

	it("removes a pipe, which would split the row", () => {
		expect(plainCellText("Före | efter")).toBe("Före efter");
	});

	it("removes a line break, which would end the row", () => {
		expect(plainCellText("Rad ett\nrad två")).toBe("Rad ett rad två");
	});

	it("removes a square bracket, which would swallow the next pipe", () => {
		// A row is split on `|` only after pipes inside `[[…]]` are masked, so an
		// unclosed `[[` left in a cell swallows the pipe that follows it and the
		// row reads as the wrong width.
		expect(plainCellText("Genomgång [[utkast")).toBe("Genomgång utkast");
		expect(plainCellText("Möte [A]")).toBe("Möte A");
	});
});

describe("locationSuffix", () => {
	it("is null when there is no location", () => {
		expect(locationSuffix("")).toBeNull();
		expect(locationSuffix("   ")).toBeNull();
	});

	it("is null when the location is only characters this cell cannot carry", () => {
		expect(locationSuffix("[]|")).toBeNull();
	});

	it("removes the parentheses a room number comes wrapped in", () => {
		// Left in place, a nested parenthesis would make the cell's own trailing
		// one unreadable to anything that finds a trailing parenthesis by
		// matching `\(([^)]+)\)\s*$`.
		expect(locationSuffix("K Exempelort Provgatan 1000 Provrummet (9)")).toBe(
			"K Exempelort Provgatan 1000 Provrummet 9",
		);
	});

	it("flattens a location that carries a line break", () => {
		expect(locationSuffix("Exempelbil\nProvvägen 30, 000 00 Exempelstad")).toBe(
			"Exempelbil Provvägen 30, 000 00 Exempelstad",
		);
	});

	it("removes a pipe and brackets", () => {
		expect(locationSuffix("Rum [A] | B")).toBe("Rum A B");
	});
});

describe("UNTITLED_MEETING_TITLE", () => {
	it("reads Untitled meeting", () => {
		expect(UNTITLED_MEETING_TITLE).toBe("Untitled meeting");
	});

	it("appears nowhere in Swedish in the module's own source", () => {
		const source = readFileSync(resolve(__dirname, "..", "core", "meetingName.ts"), "utf8");
		expect(source).not.toContain("Namnlös");
	});
});
