import { describe, expect, it } from "vitest";
import { asLocation, earnedAt, newCalendarSource, sourceProblem } from "../core/calendarSources";
import type { CalendarRead, CalendarSource } from "../core/calendarSources";

// Ticket #953: an Apple "Public Calendar" address starts `webcal://`, which
// names no transport of its own. It is taken as the same address over
// `https://`, never `http://`, so the address (which is the password) is never
// sent in the clear.

const refused = "A calendar link has to start with https://, so the address is not sent in the clear.";

function link(location: string): CalendarSource {
	return { ...newCalendarSource(), name: "Work", kind: "link", location };
}

const read = (over: Partial<CalendarRead> = {}): CalendarRead => ({
	readAt: 1_000,
	failure: null,
	...over,
});

describe("a webcal:// link", () => {
	it("is accepted as a link source", () => {
		expect(sourceProblem(link("webcal://cal.test/w.ics"))).toBeNull();
	});

	it("is accepted whatever case the scheme is spelled in", () => {
		expect(sourceProblem(link("WEBCAL://cal.test/w.ics"))).toBeNull();
		expect(sourceProblem(link("Webcal://cal.test/w.ics"))).toBeNull();
	});

	it("becomes the https:// address, trimmed", () => {
		expect(asLocation("link", " webcal://cal.test/w.ics ")).toBe("https://cal.test/w.ics");
	});

	it("keeps everything after the scheme byte for byte, mixed case included", () => {
		expect(asLocation("link", "WebCal://Cal.Test/Pub/AbC-123.ics?Key=xY")).toBe(
			"https://Cal.Test/Pub/AbC-123.ics?Key=xY",
		);
	});

	it("is never turned into http://", () => {
		expect(asLocation("link", "webcal://cal.test/w.ics").startsWith("http://")).toBe(false);
	});
});

describe("what is still refused", () => {
	it("refuses http:// with the same sentence", () => {
		expect(sourceProblem(link("http://cal.test/w.ics"))).toBe(refused);
	});

	it("refuses webcal: without the two slashes", () => {
		expect(sourceProblem(link("webcal:cal.test/w.ics"))).toBe(refused);
		expect(asLocation("link", "webcal:cal.test/w.ics")).toBe("webcal:cal.test/w.ics");
	});

	it("leaves another scheme alone, webcals:// included", () => {
		expect(asLocation("link", "webcals://cal.test/w.ics")).toBe("webcals://cal.test/w.ics");
		expect(sourceProblem(link("webcals://cal.test/w.ics"))).toBe(refused);
	});
});

describe("a read earned under either spelling", () => {
	it("belongs to a source that now names the https:// address", () => {
		expect(earnedAt(read({ readFrom: "link:webcal://cal.test/w.ics" }), link("https://cal.test/w.ics"))).toBe(
			true,
		);
	});

	it("belongs to a source that names the webcal:// address", () => {
		expect(earnedAt(read({ readFrom: "link:https://cal.test/w.ics" }), link("webcal://cal.test/w.ics"))).toBe(
			true,
		);
	});

	it("still does not belong to a different address", () => {
		expect(earnedAt(read({ readFrom: "link:webcal://cal.test/old.ics" }), link("https://cal.test/w.ics"))).toBe(
			false,
		);
	});
});

describe("the file route", () => {
	it("does not rewrite a webcal:// typed into the file box", () => {
		expect(sourceProblem({ ...link("webcal://cal.test/w.ics"), kind: "file" })).not.toBeNull();
	});
});
