/**
 * A name the person removed by hand from a note a click made stays removed
 * when the run on the day updates that note.
 *
 * The note is the click's real text (`clickFill`), edited as a person would
 * edit it, then given to the real `ensureNote` with an empty memory — the
 * device that builds the days received nothing from the click. Every name,
 * folder and date is invented.
 */

import { describe, expect, it } from "vitest";
import type { Meeting } from "../core/icsReader";
import { meetingNoteBasename } from "../core/meetingName";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { clickFill } from "../features/meetingNotes/clickFill";
import { ensureNote } from "../features/meetingNotes/ensureNote";
import type { NoteLookup } from "../features/meetingNotes/ensureNote";
import { readParticipants } from "../features/meetingNotes/noteEdit";
import { IDENTITY_FIELD } from "../features/meetingNotes/noteIdentity";
import { DEFAULT_TEMPLATE } from "../features/meetingNotes/types";

const FOLDER = "Meetings";
const SELF = "self@invented.test";
const DAY = "2026-10-14";
const LOG = `Journal/${DAY}.md`;

function layout(): VaultLayout {
	return { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };
}

function meeting(names: readonly string[]): Meeting {
	return {
		uid: "uid-1",
		summary: "Design review",
		location: null,
		description: null,
		organizer: null,
		attendees: names.map((name) => ({ name, email: `${name.toLowerCase().replace(" ", ".")}@invented.test` })),
		occurrenceKey: null,
		allDay: false,
		start: new Date(2026, 9, 14, 9, 0),
		end: new Date(2026, 9, 14, 9, 30),
	};
}

/** The note a click on the meeting creates, as the click's own code writes it. */
function clickedNote(names: readonly string[]): { path: string; text: string } {
	const m = meeting(names);
	const filled = clickFill(meetingNoteBasename(DAY, m.summary), LOG, {
		layout: layout(),
		meetingsOn: () => [m],
		folder: FOLDER,
		template: DEFAULT_TEMPLATE,
		selfEmail: SELF,
	});
	if (filled === null) throw new Error("the click filled nothing");
	return filled;
}

/** The run on the day: an empty memory, and a vault holding just this note. */
function runOn(names: readonly string[], path: string, text: string) {
	const lookup: NoteLookup = {
		exists: (candidate) => candidate === path,
		read: (candidate) => (candidate === path ? text : null),
		notesNamingIdentity: (identity) => (text.includes(`${IDENTITY_FIELD}: ${JSON.stringify(identity)}`) ? [path] : []),
	};
	return ensureNote(meeting(names), DAY, layout(), FOLDER, lookup, {}, DEFAULT_TEMPLATE, SELF);
}

function withoutName(text: string, name: string): string {
	return text.replace(new RegExp(`  - "\\[\\[${name}\\]\\]"\\r?\\n`), "");
}

describe("a name removed by hand from a note a click made", () => {
	it("is not added back on the day when the invitation is unchanged", () => {
		const note = clickedNote(["Alva Almgren", "Bea Bergsten"]);
		expect(readParticipants(note.text, "participants")).toEqual(["Alva Almgren", "Bea Bergsten"]);
		const edited = withoutName(note.text, "Bea Bergsten");
		expect(readParticipants(edited, "participants")).toEqual(["Alva Almgren"]);

		const result = runOn(["Alva Almgren", "Bea Bergsten"], note.path, edited);

		expect(result.outcome).toBe("nothing-to-do");
		expect(result.text).toBeUndefined();
	});

	it("stays removed while a name invited after the click is added", () => {
		const note = clickedNote(["Alva Almgren", "Bea Bergsten"]);
		const edited = withoutName(note.text, "Bea Bergsten");

		const result = runOn(["Alva Almgren", "Bea Bergsten", "Cai Carlsson"], note.path, edited);

		expect(result.outcome).toBe("updated");
		expect(readParticipants(result.text ?? "", "participants")).toEqual(["Alva Almgren", "Cai Carlsson"]);
		expect(result.remember?.accounted).toEqual(expect.arrayContaining(["Alva Almgren", "Bea Bergsten", "Cai Carlsson"]));
	});

	it("stays removed on a note with Windows line endings and no final line break", () => {
		const note = clickedNote(["Alva Almgren", "Bea Bergsten"]);
		const crlf = withoutName(note.text.replace(/\n/g, "\r\n"), "Bea Bergsten").replace(/\r\n$/, "");
		expect(crlf.endsWith("\n")).toBe(false);

		const result = runOn(["Alva Almgren", "Bea Bergsten", "Cai Carlsson"], note.path, crlf);

		expect(result.outcome).toBe("updated");
		expect(readParticipants(result.text ?? "", "participants")).toEqual(["Alva Almgren", "Cai Carlsson"]);
		expect(result.text).not.toMatch(/(^|[^\r])\n/);
	});

	it("stays removed on a note with Windows line endings that ends in a line break, in exact bytes", () => {
		const note = clickedNote(["Alva Almgren", "Bea Bergsten"]);
		const lf = withoutName(note.text, "Bea Bergsten");
		const crlf = lf.replace(/\n/g, "\r\n");
		expect(crlf.endsWith("\r\n")).toBe(true);

		const result = runOn(["Alva Almgren", "Bea Bergsten", "Cai Carlsson"], note.path, crlf);

		// The record grows with the name the run adds.
		const expectedLf = lf
			.replace('  - "[[Alva Almgren]]"\n', '  - "[[Alva Almgren]]"\n  - "[[Cai Carlsson]]"\n')
			.replace('effortless-offered: ["Alva Almgren","Bea Bergsten"]', 'effortless-offered: ["Alva Almgren","Bea Bergsten","Cai Carlsson"]');
		expect(expectedLf).not.toBe(lf);
		expect(result.outcome).toBe("updated");
		expect(result.text).toBe(expectedLf.replace(/\n/g, "\r\n"));
	});

	it("a clicked note with no record of what was offered takes the names on it as accounted for, so none is added a second time", () => {
		const note = clickedNote(["Alva Almgren", "Bea Bergsten"]);
		const legacy = note.text
			.split("\n")
			.filter((line) => !line.startsWith("effortless-offered:"))
			.join("\n");
		expect(readParticipants(legacy, "participants")).toEqual(["Alva Almgren", "Bea Bergsten"]);

		const result = runOn(["Alva Almgren", "Bea Bergsten"], note.path, legacy);

		expect(result.outcome).toBe("nothing-to-do");
		expect(result.remember?.accounted).toEqual(["Alva Almgren", "Bea Bergsten"]);
	});

	it("a clicked note with no record of what was offered (made before #1100) is read as today: the removed name is added back", () => {
		const note = clickedNote(["Alva Almgren", "Bea Bergsten"]);
		const legacy = note.text
			.split("\n")
			.filter((line) => !line.startsWith("effortless-offered:"))
			.join("\n");
		const edited = withoutName(legacy, "Bea Bergsten");
		expect(edited).toContain(`${IDENTITY_FIELD}: "uid-1"`);

		const result = runOn(["Alva Almgren", "Bea Bergsten"], note.path, edited);

		expect(result.outcome).toBe("updated");
		expect(readParticipants(result.text ?? "", "participants")).toEqual(["Alva Almgren", "Bea Bergsten"]);
	});

	it("records the names it offered in the note's own frontmatter, next to its identity", () => {
		const note = clickedNote(["Alva Almgren", "Bea Bergsten"]);
		expect(note.text).toContain('effortless-offered: ["Alva Almgren","Bea Bergsten"]');
	});

	it("is not added back to the note the run chooses among two click-made notes, the one holding the person's words", () => {
		// The first click, when only Alva was invited, left an empty note at the
		// computed path; a second click left the note the person then wrote in.
		const empty = clickedNote(["Alva Almgren"]);
		const worded = clickedNote(["Alva Almgren", "Bea Bergsten"]);
		const wordedPath = `${FOLDER}/Elsewhere/${DAY} Design review.md`;
		const wordedText = `${withoutName(worded.text, "Bea Bergsten").trimEnd()}\n\nMy own preparation.\n`;
		const notes = new Map([
			[empty.path, empty.text],
			[wordedPath, wordedText],
		]);
		const lookup: NoteLookup = {
			exists: (candidate) => notes.has(candidate),
			read: (candidate) => notes.get(candidate) ?? null,
			notesNamingIdentity: () => [empty.path, wordedPath],
		};

		const result = ensureNote(meeting(["Alva Almgren", "Bea Bergsten"]), DAY, layout(), FOLDER, lookup, {}, DEFAULT_TEMPLATE, SELF);

		expect(result.path).toBe(wordedPath);
		expect(result.outcome).toBe("nothing-to-do");
		expect(result.text).toBeUndefined();
	});
});
