/**
 * The three permitted edits to an existing meeting note, and — far more of
 * this file — the cases where they are refused.
 *
 * Carried from `~/Devbox/calendar-scaffold/tests/note-edit.test.ts`, fixtures
 * replaced. The template used here deliberately answers every field with a
 * name unlike any of {@link DEFAULT_TEMPLATE}'s: a test that passed against a
 * hardcoded `daglogg`/`deltagare` literal would fail against this one, and a
 * test that passed against a hardcoded English default would too.
 *
 * The note below is what this feature's own note-creation would write for one
 * meeting,
 * built from that template. Every assertion is against the whole string, so
 * an edit that quietly changed a fourth line fails rather than passes.
 *
 * Every name and title is invented. No live calendar content is in this file.
 */

import { describe, expect, it } from "vitest";
import { editNote as editNoteWith, readParticipants } from "../features/meetingNotes/noteEdit";
import type { LayoutFieldNames } from "../core/vaultLayout";
import type { MeetingNoteTemplate } from "../features/meetingNotes/types";

const DATE = "2026-08-24";

const TEMPLATE: MeetingNoteTemplate = {
	tag: "gather",
	effortField: "load",
	participantsField: "attendees",
	notesHeading: "# My notes",
	agendaHeading: "## Purpose",
	decisionsHeading: "## Actions",
};

/** The two property names the vault layout holds, not the template: the core's, handed to the editor beside it. */
const FIELDS: LayoutFieldNames = { dayLinkField: "logLink", processedField: "handled", diaryDateField: "journal" };

/** `editNote` with the layout's two names, so each call below reads as it did when they were the template's. */
function editNote(...args: [text: string, plan: Parameters<typeof editNoteWith>[1], template: MeetingNoteTemplate]) {
	return editNoteWith(args[0], args[1], args[2], FIELDS);
}

/** A meeting note as this feature writes one, with whatever has happened to it since. */
function note(
	options: {
		title?: string;
		date?: string;
		names?: string[];
		effort?: string;
		body?: string;
		notes?: string;
	} = {},
): string {
	const {
		title = "Status check",
		date = DATE,
		names = ["Ann Adler"],
		effort = "",
		body = "We go through where things stand.",
		notes = "",
	} = options;
	return [
		"---",
		"tags:",
		`  - ${TEMPLATE.tag}`,
		effort.length > 0 ? `${TEMPLATE.effortField}: "${effort}"` : `${TEMPLATE.effortField}:`,
		`${TEMPLATE.participantsField}:`,
		...names.map((name) => `  - "[[${name}]]"`),
		`${FIELDS.dayLinkField}: "[[${date}]]"`,
		`${FIELDS.processedField}:`,
		"---",
		`# ${title}`,
		"",
		TEMPLATE.agendaHeading,
		"",
		body,
		"",
		TEMPLATE.notesHeading,
		"",
		notes,
		TEMPLATE.decisionsHeading,
		"",
	].join("\n");
}

describe("the heading follows a rename, and only the heading", () => {
	it("rewrites the meeting's own `# ` line", () => {
		const result = editNote(
			note(),
			{ heading: { from: "Status check", to: "Status check and handover" }, addNames: [] },
			TEMPLATE,
		);

		expect(result.text).toBe(note({ title: "Status check and handover" }));
		expect(result.applied).toEqual(["heading"]);
		expect(result.refused).toEqual([]);
	});

	it("leaves the notes heading alone, however the meeting is renamed", () => {
		// The notes heading is the second `# ` line in the file and it is his.
		// Taking the name off the section he types into would be the worst
		// possible way to be wrong here.
		const result = editNote(
			note({ notes: "Ann will bring the figures.\n" }),
			{ heading: { from: "Status check", to: "New name" }, addNames: [] },
			TEMPLATE,
		);

		expect(result.text).toContain(`\n${TEMPLATE.notesHeading}\n`);
		expect(result.text).toContain("Ann will bring the figures.");
	});

	it("refuses when he has retitled the heading himself, and says what it found", () => {
		const his = note({ title: "Status check — see Ann's figures" });
		const result = editNote(his, { heading: { from: "Status check", to: "New name" }, addNames: [] }, TEMPLATE);

		expect(result.text).toBe(his);
		expect(result.applied).toEqual([]);
		expect(result.refused).toEqual([
			`its heading reads "# Status check — see Ann's figures" rather than "# Status check", so it ` +
				`was left as it is — the calendar now calls this meeting "New name"`,
		]);
	});

	it("does nothing at all when the name has not changed", () => {
		const before = note();
		const result = editNote(before, { heading: { from: "Status check", to: "Status check" }, addNames: [] }, TEMPLATE);

		expect(result.text).toBe(before);
		expect(result.applied).toEqual([]);
		expect(result.refused).toEqual([]);
	});

	it("refuses when the title line no longer reads `# `, even though the old title is its own line below the agenda heading", () => {
		// #770: the title has been retitled by hand to a heading that no longer
		// starts with `# `, and a line reading `# Status check` sits in the body,
		// below the agenda heading. Before the bound at the agenda heading, the
		// unbounded scan found that line and rewrote it — his prose, not the
		// title.
		const before = note({ body: "# Status check\n\nSee background for details." }).replace(
			"# Status check",
			"## Status check",
		);
		const result = editNote(before, { heading: { from: "Status check", to: "New name" }, addNames: [] }, TEMPLATE);

		expect(result.text).toBe(before);
		expect(result.applied).toEqual([]);
		expect(result.refused).toEqual([`it has no \`# \` heading, so the meeting's name was left as it is`]);
	});

	it("leaves everything below the agenda heading untouched, even when the old title appears there too", () => {
		// The whole tail of the note — including a line that happens to repeat
		// the old title — is his, permanently (story 11).
		const before = note({ body: "See Status check from last time for background." });
		const result = editNote(
			before,
			{ heading: { from: "Status check", to: "New name" }, addNames: [] },
			TEMPLATE,
		);

		// Line 9 is the title heading itself, which this edit is expected to
		// change; everything from the blank line after it onward is his.
		const tailBefore = before.split("\n").slice(10);
		const tailAfter = result.text.split("\n").slice(10);
		expect(tailAfter).toEqual(tailBefore);
		expect(tailAfter.join("\n")).toContain("Status check");
	});

	it("leaves everything below the agenda heading untouched when all three edits run together", () => {
		const before = note({ body: "See Status check from last time for background.", names: ["Ann Adler"] });
		const result = editNote(
			before,
			{
				heading: { from: "Status check", to: "New name" },
				dayLink: { from: DATE, to: "2026-08-26" },
				addNames: ["Cee Carlsson"],
			},
			TEMPLATE,
		);

		expect(result.applied).toEqual(["heading", "day link", "1 participant(s)"]);
		// The added participant shifts every later line down by one, so the
		// agenda heading's own text — not a fixed index — anchors the
		// comparison.
		const beforeLines = before.split("\n");
		const afterLines = result.text.split("\n");
		const tailBefore = beforeLines.slice(beforeLines.indexOf(TEMPLATE.agendaHeading));
		const tailAfter = afterLines.slice(afterLines.indexOf(TEMPLATE.agendaHeading));
		expect(tailAfter).toEqual(tailBefore);
	});
});

describe("the day link follows a move", () => {
	it("rewrites the day-link field and nothing else", () => {
		const result = editNote(note(), { dayLink: { from: DATE, to: "2026-08-26" }, addNames: [] }, TEMPLATE);

		expect(result.text).toBe(note({ date: "2026-08-26" }));
		expect(result.applied).toEqual(["day link"]);
	});

	it("refuses a day-link line that does not say what this feature last wrote", () => {
		const his = note().replace(`${FIELDS.dayLinkField}: "[[${DATE}]]"`, `${FIELDS.dayLinkField}: "[[${DATE}]]" # moved?`);
		const result = editNote(his, { dayLink: { from: DATE, to: "2026-08-26" }, addNames: [] }, TEMPLATE);

		expect(result.text).toBe(his);
		expect(result.refused).toEqual([
			`its frontmatter has no line reading \`${FIELDS.dayLinkField}: "[[${DATE}]]"\`, so its day link was ` +
				`left as it is — the calendar now puts this meeting on 2026-08-26`,
		]);
	});
});

describe("the participants field is added to, and never anything else", () => {
	it("appends a newly invited name after the last one there", () => {
		const result = editNote(note({ names: ["Ann Adler"] }), { addNames: ["Cee Carlsson"] }, TEMPLATE);

		expect(result.text).toBe(note({ names: ["Ann Adler", "Cee Carlsson"] }));
		expect(result.applied).toEqual(["1 participant(s)"]);
	});

	it("adds an invited name absent from the note, and keeps one present in the note but absent from the meeting", () => {
		// The meeting no longer invites "Deb Dahl", but she stays: this edit is
		// add-only and never removes a name the person did not remove himself.
		const before = note({ names: ["Ann Adler", "Deb Dahl"] });
		const result = editNote(before, { addNames: ["Cee Carlsson"] }, TEMPLATE);

		expect(result.text).toBe(note({ names: ["Ann Adler", "Deb Dahl", "Cee Carlsson"] }));
	});

	it("adds to an empty list without disturbing the key line", () => {
		const result = editNote(note({ names: [] }), { addNames: ["Ann Adler"] }, TEMPLATE);
		expect(result.text).toBe(note({ names: ["Ann Adler"] }));
	});

	it("keeps the indent the existing entries use", () => {
		const fourSpaces = note().replace('  - "[[Ann Adler]]"', '    - "[[Ann Adler]]"');
		const result = editNote(fourSpaces, { addNames: ["Cee Carlsson"] }, TEMPLATE);
		expect(result.text).toContain('    - "[[Ann Adler]]"\n    - "[[Cee Carlsson]]"');
	});

	it("never reorders or rewrites a name already in the list", () => {
		// His own ordering and his own spelling both survive, because every
		// existing line is left where it is and untouched.
		const his = note({ names: ["Cee Carlsson", "Ann Adler"] });
		const result = editNote(his, { addNames: ["Dee Doran"] }, TEMPLATE);

		expect(result.text.split("\n").slice(0, 7)).toEqual(his.split("\n").slice(0, 7));
		expect(result.text).toContain('  - "[[Cee Carlsson]]"\n  - "[[Ann Adler]]"\n  - "[[Dee Doran]]"');
	});

	it("reads and extends a list written at column 0, which is valid YAML", () => {
		// Found by `/code-review high` on the old plugin's Phase 5, 2026-08-22. A
		// participants list with no indent parses exactly as the two-space form,
		// and reading it as *empty* would let a name be written twice and would
		// splice a new entry in above the existing ones at two-space indent,
		// leaving frontmatter that no longer parses.
		const flat = note().replace('  - "[[Ann Adler]]"', '- "[[Ann Adler]]"');

		expect(readParticipants(flat, TEMPLATE.participantsField)).toEqual(["Ann Adler"]);

		const result = editNote(flat, { addNames: ["Cee Carlsson"] }, TEMPLATE);
		expect(result.text).toBe(flat.replace('- "[[Ann Adler]]"', '- "[[Ann Adler]]"\n- "[[Cee Carlsson]]"'));
		expect(result.addedNames).toEqual(["Cee Carlsson"]);
	});

	it("does not add a name a column-0 list already holds", () => {
		const flat = note().replace('  - "[[Ann Adler]]"', '- "[[Ann Adler]]"');
		// The caller filters on what readParticipants reports, so an unreadable
		// list is how a name gets written twice.
		expect(readParticipants(flat, TEMPLATE.participantsField)).toContain("Ann Adler");
	});

	it("reports nothing added when the list could not be found", () => {
		// The caller records only `addedNames` as offered — a name it
		// remembered but never wrote would never be tried again.
		const his = note().replace(`${TEMPLATE.participantsField}:`, `${TEMPLATE.participantsField}: []`);
		const result = editNote(his, { addNames: ["Cee Carlsson"] }, TEMPLATE);

		expect(result.addedNames).toEqual([]);
		expect(result.refused).toHaveLength(1);
	});

	it("refuses an inline list rather than rewriting the line", () => {
		// An inline value is a shape this feature did not write. Extending it
		// means rewriting the line, and rewriting it could drop what is on it.
		const his = note().replace(`${TEMPLATE.participantsField}:`, `${TEMPLATE.participantsField}: []`);
		const result = editNote(his, { addNames: ["Ann Adler"] }, TEMPLATE);

		expect(result.text).toBe(his);
		expect(result.refused[0]).toContain("Ann Adler");
	});

	it("refuses when there is no participants key at all", () => {
		const his = note().replace(`${TEMPLATE.participantsField}:\n  - "[[Ann Adler]]"\n`, "");
		const result = editNote(his, { addNames: ["Ann Adler"] }, TEMPLATE);

		expect(result.text).toBe(his);
		expect(result.refused).toEqual([
			`its frontmatter has no \`${TEMPLATE.participantsField}:\` list of its own, so 1 newly invited ` +
				`participant(s) were not added: "Ann Adler"`,
		]);
	});
});

describe("a file that is not the shape this feature wrote", () => {
	it("refuses both frontmatter edits when there is no frontmatter", () => {
		const bare = "# Status check\n\nHis own notes.\n";
		const result = editNote(bare, { dayLink: { from: DATE, to: "2026-08-26" }, addNames: ["Ann Adler"] }, TEMPLATE);

		expect(result.text).toBe(bare);
		expect(result.refused).toEqual([
			`it has no frontmatter block, so its \`${FIELDS.dayLinkField}\` link and its ` +
				`\`${TEMPLATE.participantsField}\` list could not be found`,
		]);
	});

	it("refuses the heading too when there is no agenda heading to bound the search against", () => {
		// #770's fix bounds the heading scan at the agenda heading. With none in
		// the file at all, there is nothing to bound against, so the edit refuses
		// rather than falling back to the old unbounded scan — the same scan
		// that let a line below the agenda heading be rewritten.
		const bare = "# Status check\n\nHis own notes.\n";
		const result = editNote(
			bare,
			{ heading: { from: "Status check", to: "New name" }, dayLink: { from: DATE, to: "2026-08-26" }, addNames: [] },
			TEMPLATE,
		);

		expect(result.text).toBe(bare);
		expect(result.applied).toEqual([]);
		expect(result.refused).toHaveLength(2);
	});

	it("does not read a `---` in the body as frontmatter", () => {
		// A horizontal rule further down the note is prose. Reading it as
		// frontmatter would put this feature's edits into what he wrote.
		const his = `# Status check\n\nFirst this.\n\n---\n\n${FIELDS.dayLinkField}: "[[2026-08-24]]"\n`;
		const result = editNote(his, { dayLink: { from: DATE, to: "2026-08-26" }, addNames: [] }, TEMPLATE);

		expect(result.text).toBe(his);
	});
});

describe("reading the participants already in a note", () => {
	it("reads them out of the link syntax", () => {
		expect(readParticipants(note({ names: ["Ann Adler", "Cee Carlsson"] }), TEMPLATE.participantsField)).toEqual([
			"Ann Adler",
			"Cee Carlsson",
		]);
	});

	it("reads a plain name he typed without brackets", () => {
		const his = note().replace('  - "[[Ann Adler]]"', "  - Ann Adler");
		expect(readParticipants(his, TEMPLATE.participantsField)).toEqual(["Ann Adler"]);
	});

	it("is empty for a note with no participants yet", () => {
		expect(readParticipants(note({ names: [] }), TEMPLATE.participantsField)).toEqual([]);
	});

	it("is null — not empty — when there is no list it understands", () => {
		// Null and empty must not be confused: empty invites writing, null
		// forbids it.
		expect(
			readParticipants(note().replace(`${TEMPLATE.participantsField}:`, `${TEMPLATE.participantsField}: []`), TEMPLATE.participantsField),
		).toBeNull();
		expect(readParticipants("# Status check\n", TEMPLATE.participantsField)).toBeNull();
	});
});
