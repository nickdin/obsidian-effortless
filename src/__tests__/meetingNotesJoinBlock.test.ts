/**
 * The join block left out of a meeting note — ticket
 * #1012. Every fixture is
 * invented, in the shapes the ticket describes: a Skype block fenced by dots
 * and a SAFOS block fenced by underscores. The Teams fixture is invented from
 * Teams' published invitation format and was never seen in a real calendar.
 */

import { describe, expect, it } from "vitest";
import type { Meeting } from "../core/icsReader";
import { withoutJoinBlocks } from "../features/meetingNotes/joinBlock";
import { noteText } from "../features/meetingNotes/noteText";
import { DEFAULT_TEMPLATE } from "../features/meetingNotes/types";

const DOTS = ".".repeat(90);
const UNDERSCORES = "_".repeat(32);

const SKYPE_BLOCK = [
	DOTS,
	"Anslut till Skype-mötet https://join.example.test/abc",
	"Anslutningsproblem? Prova Skype Web App https://join.example.test/web",
	"Anslut via telefon",
	"+46 0 000 000 00 (Testort)",
	"Konferens-ID: 000000",
	DOTS,
];

const SAFOS_BLOCK = [
	UNDERSCORES,
	"SAFOS videomöte",
	"→ Anslut till mötet / Join meeting https://video.example.test/m/1",
	"Användarhandledning https://video.example.test/help",
	UNDERSCORES,
];

const TEAMS_BLOCK = [
	UNDERSCORES,
	"Microsoft Teams meeting",
	"Join the meeting now https://teams.example.test/l/abc",
	"Meeting ID: 000 000 000",
	UNDERSCORES,
];

function meeting(description: string): Meeting {
	return {
		uid: "uid-1",
		summary: "Weekly sync",
		location: null,
		description,
		organizer: null,
		attendees: [],
		occurrenceKey: null,
		allDay: false,
		start: new Date(2026, 8, 21, 9, 0),
		end: new Date(2026, 8, 21, 9, 30),
	};
}

function note(description: string): string {
	return noteText(meeting(description), "2026-09-21", DEFAULT_TEMPLATE, []);
}

describe("the join block in a meeting note", () => {
	it("keeps the text around a Skype block and holds none of its lines, fence included", () => {
		// If wrong: the note still contains "Anslut till Skype-mötet".
		const text = note(["Agenda first", "", ...SKYPE_BLOCK, "", "Closing words"].join("\n"));
		expect(text).toContain("Agenda first\n\nClosing words\n");
		expect(text).not.toContain("Anslut till Skype-mötet");
		expect(text).not.toContain("....................");
		for (const line of SKYPE_BLOCK) expect(text).not.toContain(line);
	});

	it("does the same for a SAFOS block", () => {
		// If wrong: the note still contains "SAFOS videomöte".
		const text = note(["Before", "", ...SAFOS_BLOCK, "", "After"].join("\n"));
		expect(text).toContain("Before\n\nAfter\n");
		expect(text).not.toContain("SAFOS videomöte");
		expect(text).not.toContain(UNDERSCORES);
	});

	it("does the same for a Teams-shaped block, whose wording is inferred", () => {
		// If wrong: the note still contains "Microsoft Teams".
		const text = note(["Before", "", ...TEAMS_BLOCK, "", "After"].join("\n"));
		expect(text).toContain("Before\n\nAfter\n");
		expect(text).not.toContain("Microsoft Teams");
		expect(text).not.toContain("teams.example.test");
	});

	it("removes two blocks in one invitation", () => {
		expect(withoutJoinBlocks([...SKYPE_BLOCK, "", "Middle", "", ...SAFOS_BLOCK].join("\n"))).toBe(
			"Middle\n",
		);
	});

	it("leaves one blank line where the removal brought two together", () => {
		expect(withoutJoinBlocks(["A", "", ...SKYPE_BLOCK, "", "B"].join("\n"))).toBe("A\n\nB");
	});

	it("matches the wording without regard to capitals, and the English wording too", () => {
		const block = [DOTS, "JOIN SKYPE MEETING https://join.example.test/x", DOTS];
		expect(withoutJoinBlocks(["A", ...block, "B"].join("\n"))).toBe("A\nB");
	});

	it("allows whitespace around a fence", () => {
		const block = [`  ${UNDERSCORES}  `, "SAFOS videomöte", UNDERSCORES];
		expect(withoutJoinBlocks(["A", ...block, "B"].join("\n"))).toBe("A\nB");
	});
});

describe("text that is not a join block stays whole", () => {
	const cases: Record<string, string[]> = {
		"an underscore box of the organiser's own text": [UNDERSCORES, "Bring the printed budget", UNDERSCORES],
		"a dot box of the organiser's own text": [DOTS, "Room rules apply", DOTS],
		"a boxed link that is no known service": [UNDERSCORES, "Join here https://other.example.test/j", UNDERSCORES],
		"a Teams product name without a join phrase": [UNDERSCORES, "We use Microsoft Teams for chat", UNDERSCORES],
		"a join phrase without the Teams name": [UNDERSCORES, "Join the meeting at nine", UNDERSCORES],
	};
	for (const [name, block] of Object.entries(cases)) {
		it(`keeps ${name}`, () => {
			// If wrong: the box would be gone from the note.
			const description = ["Before", ...block, "After"].join("\n");
			expect(note(description)).toContain(`${description}\n`);
		});
	}

	it("keeps a fence with no partner, even above a marker", () => {
		const description = [DOTS, "Anslut till Skype-mötet https://join.example.test/abc"].join("\n");
		expect(withoutJoinBlocks(description)).toBe(description);
	});

	it("keeps a fence shorter than twenty characters", () => {
		const short = "_".repeat(19);
		const description = [short, "SAFOS videomöte", short].join("\n");
		expect(withoutJoinBlocks(description)).toBe(description);
	});

	it("does not pair a dot fence with an underscore fence", () => {
		const description = [DOTS, "SAFOS videomöte", UNDERSCORES].join("\n");
		expect(withoutJoinBlocks(description)).toBe(description);
	});

	it("keeps the organiser's own box and removes the join block that follows it", () => {
		const own = [UNDERSCORES, "Bring the printed budget", UNDERSCORES];
		expect(withoutJoinBlocks([...own, "", ...SAFOS_BLOCK].join("\n"))).toBe(own.join("\n") + "\n");
	});
});
