/**
 * The participant list — ticket
 * #758, carried from
 * `~/Devbox/calendar-scaffold/tests/names.test.ts`. Every case is a shape the
 * old suite measured against a real calendar, rewritten with invented people:
 * no real name, address or meeting is in this file.
 */

import { describe, expect, it } from "vitest";
import type { InvitedParty, Meeting } from "../core/icsReader";
import { flipAttendee, isPerson, participants } from "../features/meetingNotes/participants";

function meeting(partial: Partial<Meeting>): Meeting {
	return {
		uid: "uid-1",
		summary: "Weekly sync",
		location: null,
		description: null,
		organizer: null,
		attendees: [],
		occurrenceKey: null,
		allDay: false,
		start: new Date(2026, 8, 21, 9, 0),
		end: new Date(2026, 8, 21, 10, 0),
		...partial,
	};
}

describe("flipAttendee — the order and the employee number", () => {
	it("turns `Surname Given (nnnn)` into `Given Surname`", () => {
		expect(flipAttendee("Exempelsson Bo (0001)", "bo.exempelsson@invented.test")).toBe(
			"Bo Exempelsson",
		);
	});

	it("drops an employee number of any length", () => {
		expect(flipAttendee("Exempelsson Bo (001)", "bo.exempelsson@invented.test")).toBe(
			"Bo Exempelsson",
		);
		expect(flipAttendee("Exempelsson Bo (00012)", "bo.exempelsson@invented.test")).toBe(
			"Bo Exempelsson",
		);
	});

	it("keeps a two-word surname together, moving only the given name", () => {
		expect(
			flipAttendee("Almqvist Nerell Karin (0002)", "karin.nerell.almqvist@invented.test"),
		).toBe("Karin Almqvist Nerell");
	});

	it("moves a two-word given name, which the last word alone would split", () => {
		expect(flipAttendee("Ek Lund Jon Erik (0003)", "jonerik.ek.lund@invented.test")).toBe(
			"Jon Erik Ek Lund",
		);
	});

	it("leaves a name that is already `Given Surname` alone", () => {
		expect(flipAttendee("Bo Exempelsson", "bo.exempelsson@invented.test")).toBe(
			"Bo Exempelsson",
		);
	});

	it("flips an external `Surname Given` that carries no employee number", () => {
		expect(flipAttendee("Exempelsson Bo", "bo.exempelsson@invented.test")).toBe("Bo Exempelsson");
	});

	it("reads `Surname, Given` from the comma", () => {
		expect(flipAttendee("Exempelsson, Bo", "bo.exempelsson@invented.test")).toBe(
			"Bo Exempelsson",
		);
	});

	it("does not flip on a comma the address does not confirm", () => {
		expect(
			flipAttendee("Exempelsson Bo (0001), Example AB", "bo.exempelsson@invented.test"),
		).toBe("Exempelsson Bo (0001), Example AB");
	});

	it("does not flip on a comma when there is no address to confirm it", () => {
		expect(flipAttendee("Exempelsson, Bo", "")).toBe("Exempelsson, Bo");
	});

	it("flips a letter the address spells with a different letter", () => {
		expect(flipAttendee("Ødegård Bjørn (0006)", "bjorn.odegard@invented.test")).toBe(
			"Bjørn Ødegård",
		);
	});

	it("flips the other non-decomposing letters too", () => {
		expect(flipAttendee("Straße Jürgen (0007)", "jurgen.strasse@invented.test")).toBe(
			"Jürgen Straße",
		);
		expect(flipAttendee("Sæther Åge (0008)", "age.saether@invented.test")).toBe("Åge Sæther");
		expect(flipAttendee("Łukasz Nowak", "lukasz.nowak@invented.test")).toBe("Łukasz Nowak");
	});

	it("matches across accents, hyphens and a disambiguating digit", () => {
		expect(
			flipAttendee("Åkerström Anna-Lena (0004)", "anna-lena.akerstrom4@invented.test"),
		).toBe("Anna-Lena Åkerström");
	});

	it("leaves the name alone when the address settles nothing", () => {
		expect(flipAttendee("Exempelsson Bo - EXT", "bo.exempelsson@invented.test")).toBe(
			"Exempelsson Bo - EXT",
		);
	});

	it("leaves the name alone when there is no address at all", () => {
		expect(flipAttendee("Exempelsson Bo (0001)", "")).toBe("Exempelsson Bo");
	});

	it("does not correct a spelling the calendar and the address agree on", () => {
		expect(flipAttendee("Bergstrom Johan (0005)", "johan.bergstrom@invented.test")).toBe(
			"Johan Bergstrom",
		);
	});
});

describe("isPerson — what is not a person", () => {
	it("accepts a colleague", () => {
		expect(
			isPerson({ name: "Exempelsson Bo (0001)", email: "bo.exempelsson@invented.test" }),
		).toBe(true);
	});

	it("rejects a display name that is an address", () => {
		expect(
			isPerson({
				name: "bo.exempelsson@invented.test",
				email: "bo.exempelsson@invented.test",
			}),
		).toBe(false);
	});

	it("rejects a display name that is an address's local part", () => {
		expect(isPerson({ name: "bo.exempelsson", email: "bo.exempelsson@invented.test" })).toBe(
			false,
		);
	});

	it("rejects a distribution list", () => {
		expect(isPerson({ name: "D EX Alla", email: "dexalla@invented.test" })).toBe(false);
	});

	it("rejects a room or conference system", () => {
		expect(
			isPerson({ name: "Pexip Scheduling Example Prod", email: "pexip_scheduling@invented.test" }),
		).toBe(false);
	});

	it("rejects a shared mailbox", () => {
		expect(isPerson({ name: "Exempel kansli", email: "exempelkansli@invented.test" })).toBe(
			false,
		);
	});

	it("rejects a party with no address, because nothing can be checked", () => {
		expect(isPerson({ name: "Exempelsson Bo", email: "" })).toBe(false);
	});

	it("rejects an empty name", () => {
		expect(isPerson({ name: "", email: "bo.exempelsson@invented.test" })).toBe(false);
	});
});

describe("participants — the list as a whole", () => {
	const SELF = "ulla.anvandarsson@invented.test";

	function party(name: string, email: string): InvitedParty {
		return { name, email };
	}

	it("puts the organiser first, then the invitation's own order", () => {
		const list = participants(
			meeting({
				organizer: party("Arrangörsson Ada (0001)", "ada.arrangorsson@invented.test"),
				attendees: [
					party("Bergman Bo (0002)", "bo.bergman@invented.test"),
					party("Cedergren Cia (0003)", "cia.cedergren@invented.test"),
				],
			}),
			SELF,
		);
		expect(list).toEqual(["Ada Arrangörsson", "Bo Bergman", "Cia Cedergren"]);
	});

	it("leaves the self address out, matched by address rather than by name", () => {
		const list = participants(
			meeting({
				organizer: party("Bergman Bo (0002)", "bo.bergman@invented.test"),
				attendees: [
					party("Användarsson Ulla (0000)", SELF),
					party("Cedergren Cia (0003)", "cia.cedergren@invented.test"),
				],
			}),
			SELF,
		);
		expect(list).toEqual(["Bo Bergman", "Cia Cedergren"]);
	});

	it("matches the self address whatever its case", () => {
		const list = participants(
			meeting({
				attendees: [party("Användarsson Ulla (0000)", "Ulla.Anvandarsson@Invented.Test")],
			}),
			SELF,
		);
		expect(list).toEqual([]);
	});

	it("lists the organiser once when they are also an attendee", () => {
		const same = party("Bergman Bo (0002)", "bo.bergman@invented.test");
		expect(participants(meeting({ organizer: same, attendees: [same] }), SELF)).toEqual([
			"Bo Bergman",
		]);
	});

	it("has no organiser to list when the calendar names none", () => {
		const list = participants(
			meeting({
				organizer: null,
				attendees: [party("Bergman Bo (0002)", "bo.bergman@invented.test")],
			}),
			SELF,
		);
		expect(list).toEqual(["Bo Bergman"]);
	});

	it("leaves the self address in when the setting is unset, rather than guessing", () => {
		const list = participants(
			meeting({ attendees: [party("Användarsson Ulla (0000)", SELF)] }),
			"",
		);
		expect(list).toEqual(["Ulla Användarsson"]);
	});

	it("does not shorten a long list", () => {
		const many = Array.from({ length: 73 }, (_unused, index) =>
			party(`Exempelsson Bo${index} (0001)`, `bo${index}.exempelsson@invented.test`),
		);
		expect(participants(meeting({ attendees: many }), SELF)).toHaveLength(73);
	});

	it("drops every non-person from a mixed invitation", () => {
		const list = participants(
			meeting({
				organizer: party("Arrangörsson Ada (0001)", "ada.arrangorsson@invented.test"),
				attendees: [
					party("D EX Alla", "dexalla@invented.test"),
					party("bo.bergman@invented.test", "bo.bergman@invented.test"),
					party("cia.cedergren", "cia.cedergren@invented.test"),
					party("Davidsson David", "david.davidsson@invented.test"),
				],
			}),
			SELF,
		);
		expect(list).toEqual(["Ada Arrangörsson", "David Davidsson"]);
	});

	it("strips a backslash, which would break the frontmatter rather than the link", () => {
		const list = participants(
			meeting({
				attendees: [
					party("EXAMPLE\\Exempelsson Bo (0001)", "bo.exempelsson@invented.test"),
				],
			}),
			SELF,
		);
		expect(list).toEqual(["Bo EXAMPLE Exempelsson"]);
		expect(list[0]).not.toContain("\\");
	});

	it("strips what would break the wikilink or the quoted YAML, then flips", () => {
		const list = participants(
			meeting({
				attendees: [
					party('Exempelsson [Bo] "" (0001)', "bo.exempelsson@invented.test"),
				],
			}),
			SELF,
		);
		expect(list).toEqual(["Bo Exempelsson"]);
		expect(list[0]).not.toMatch(/["[\]#^|]/);
	});
});
