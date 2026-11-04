/**
 * A note nobody touched is not taken for one holding the person's words, even
 * once the invitation's text or the template has changed since the click wrote it.
 *
 * The click writes a fingerprint of the body it wrote into the note's own
 * frontmatter (`effortless-written`), because a click is made on another device
 * than the run that builds the days and the notes memory is per device.
 * Every note here is the real `clickFill`'s text; every name and date is invented.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import type { Meeting } from "../core/icsReader";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { clickFill } from "../features/meetingNotes/clickFill";
import { chooseNamedNote, holdsContent } from "../features/meetingNotes/ensureNote";
import { identityInText, writtenInText } from "../features/meetingNotes/noteIdentity";
import { fingerprintOf } from "../core/fingerprint";
import { meetingNotePath } from "../features/meetingNotes/notePath";
import { runMeetingNotes } from "../features/meetingNotes/run";
import type { RunCalendar, RunNotes, RunVault } from "../features/meetingNotes/run";
import { DEFAULT_TEMPLATE } from "../features/meetingNotes/types";

const SELF = "self@invented.test";
const LINKPATH = "2026-10-14 Design review";
const LOG = "Journal/2026-10-14.md";
const COMPUTED = "Meetings/2026-10-14 Design review.md";
const WRITTEN_LINE = /^effortless-written: .*\n/m;

function layout(): VaultLayout {
	return { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };
}

function meeting(partial: Partial<Meeting> = {}): Meeting {
	return {
		uid: "uid-1",
		summary: "Design review",
		location: null,
		description: null,
		organizer: null,
		attendees: [{ name: "Alva Almgren", email: "alva.almgren@invented.test" }],
		occurrenceKey: null,
		allDay: false,
		start: new Date(2026, 9, 14, 9, 0),
		end: new Date(2026, 9, 14, 9, 30),
		...partial,
	};
}

/** The text the real click writes for `m`. */
function clickNote(m: Meeting, template = DEFAULT_TEMPLATE): string {
	const filled = clickFill(LINKPATH, LOG, {
		layout: layout(),
		meetingsOn: () => [m],
		folder: "Meetings",
		template,
		selfEmail: SELF,
	});
	if (filled === null) throw new Error("the click made no note");
	return filled.text;
}

const OLD = meeting({ description: "Old agenda: walk through the mock-ups." });
const NEW = meeting({ description: "New agenda: decide on the colour scheme." });

/** Whether the run, judging with `current`, takes `text` for a note holding the person's words. */
function holds(text: string, current: Meeting = NEW, template = DEFAULT_TEMPLATE): boolean {
	return holdsContent(text, current, template, layout());
}

/** The body of a note as the click wrote it: everything after the frontmatter's closing line. */
function bodyOf(text: string): string {
	return text.slice(text.indexOf("\n---\n", 3) + 5);
}

describe("a note nobody touched", () => {
	it("is not taken for one holding words when the invitation's text has changed since the click", () => {
		const olderClick = clickNote(OLD);
		const newerClick = clickNote(NEW);

		expect(holds(olderClick)).toBe(false);
		expect(holds(newerClick)).toBe(false);
	});

	it("is not taken for one holding words when the template's headings have changed since the click", () => {
		const note = clickNote(OLD);
		const renamedHeadings = { ...DEFAULT_TEMPLATE, agendaHeading: "# Agenda today", decisionsHeading: "# Outcomes" };

		expect(holds(note, OLD, renamedHeadings)).toBe(false);
	});

	it("leaves two untouched click notes, the computed path free, both passed over", () => {
		const named = ["Elsewhere/older.md", "Elsewhere/newer.md"];
		const texts = new Map([
			[named[0], clickNote(OLD)],
			[named[1], clickNote(NEW)],
		]);

		const choice = chooseNamedNote(named, COMPUTED, (path) => holds(texts.get(path) ?? ""));

		expect(choice).toBeNull();
	});

	it("stays untouched when the person adds a property, which is not their words", () => {
		const note = clickNote(OLD).replace("\n---\n", "\nstatus: draft\n---\n");

		expect(holds(note)).toBe(false);
	});
});

describe("a note the person has written in", () => {
	it("still counts when a line was added to its body", () => {
		expect(holds(clickNote(OLD) + "Ask about the budget.\n")).toBe(true);
	});

	it("still counts when a line of the written body was reworded", () => {
		expect(holds(clickNote(OLD).replace("walk through", "skip"))).toBe(true);
	});

	it("counts when its title line is today's title and an own heading follows (the title is never counted twice)", () => {
		const legacy = clickNote(NEW).replace(WRITTEN_LINE, "");
		const withOwnHeading = legacy + "# My own heading\n";

		expect(holds(withOwnHeading)).toBe(true);
	});
});

describe("a note with no fingerprint, made before the click wrote one", () => {
	it("keeps today's rule: unchanged against today's template, it holds no words", () => {
		const legacy = clickNote(NEW).replace(WRITTEN_LINE, "");

		expect(holds(legacy)).toBe(false);
	});

	it("keeps today's rule: against an invitation that has changed, its lines count as words", () => {
		const legacy = clickNote(OLD).replace(WRITTEN_LINE, "");

		expect(holds(legacy)).toBe(true);
	});

	it.each([
		["blank", "effortless-written:"],
		["a number", "effortless-written: 42"],
		["a list", 'effortless-written: ["1:2"]'],
		["text that is not a fingerprint", 'effortless-written: "hello"'],
	])("reads a hand-edited value that is %s as absent, so today's rule applies and the note is kept", (_name, edited) => {
		const note = clickNote(OLD).replace(WRITTEN_LINE, `${edited}\n`);

		// Against a changed invitation today's rule counts the old body's lines as
		// words: the conservative side, a note kept rather than one passed over.
		expect(holds(note)).toBe(true);
		expect(holds(note, OLD)).toBe(false);
	});
});

describe("the fingerprint the click writes", () => {
	it("is one frontmatter line, after the identity and offered lines, holding the fingerprint of the body as written", () => {
		const text = clickNote(OLD);
		const lines = text.split("\n");
		const at = lines.findIndex((line) => line.startsWith("effortless-written:"));

		expect(lines[at - 1].startsWith("effortless-offered:")).toBe(true);
		expect(lines[at - 2].startsWith("effortless-meeting:")).toBe(true);
		expect(lines[at]).toBe(`effortless-written: ${JSON.stringify(fingerprintOf(bodyOf(text).replace(/\s+$/, "")))}`);
	});

	it("leaves the body's own bytes as noteText gives them", () => {
		const text = clickNote(OLD);

		expect(text.endsWith("\n")).toBe(true);
		expect(bodyOf(text).startsWith("# Design review\n\n## Agenda and purpose\n")).toBe(true);
	});

	it.each([
		["with a final line break", (text: string) => text],
		["without a final line break", (text: string) => text.replace(/\n+$/, "")],
	])("judges a click note on a template with Windows line endings untouched by its own fingerprint, %s", (_name, ending) => {
		const windows = { ...DEFAULT_TEMPLATE, agendaHeading: "# Agenda\r", notesHeading: "# Notes\r", decisionsHeading: "# Decisions\r" };
		const note = ending(clickNote(OLD, windows));
		const crlf = note.replace(/\r?\n/g, "\r\n");

		expect(holds(note, OLD, windows)).toBe(false);
		expect(holds(crlf, OLD, windows)).toBe(false);
		expect(holds(note + "\r\nAsk about the budget.", OLD, windows)).toBe(true);
	});
});

describe("a click's note and the run's choice between several notes naming one meeting", () => {
	it("opens the note holding words, second in vault order, over two untouched notes with an older invitation", () => {
		const named = ["Elsewhere/a.md", "Elsewhere/b.md", "Elsewhere/c.md"];
		const texts = new Map([
			[named[0], clickNote(OLD)],
			[named[1], clickNote(OLD) + "Ask about the budget.\n"],
			[named[2], clickNote(NEW)],
		]);
		const filled = clickFill(LINKPATH, LOG, {
			layout: layout(),
			meetingsOn: () => [NEW],
			folder: "Meetings",
			template: DEFAULT_TEMPLATE,
			selfEmail: SELF,
			notesNamingIdentity: () => named,
			readNote: (path) => texts.get(path) ?? null,
		});

		expect(filled?.path).toBe("Elsewhere/b.md");
	});
});

/** The vault the run sees in the tests below. */
const files = new Map<string, string>();

beforeEach(() => {
	files.clear();
});

function file(path: string): TFile {
	return { path } as unknown as TFile;
}

/** One real run on 2026-10-14, with an empty notes memory, over the vault in `files`. */
async function runOver(meetings: readonly Meeting[]): Promise<void> {
	const day = new Date(2026, 9, 14);
	const calendar: RunCalendar = {
		refresh: async () => undefined,
		meetingsOn: (asked, use) => (use === "notes" && asked.getTime() === day.getTime() ? meetings : []),
		presenceBetween: () => ({ whole: false, meetings: [] }),
	};
	const vault: RunVault = {
		exists: (path) => files.has(path),
		read: async (path) => files.get(path) ?? null,
		fileAt: (path) => (files.has(path) ? file(path) : null),
		notesNamingIdentity: (identity) => [...files.entries()].filter(([, text]) => identityInText(text) === identity).map(([path]) => path),
	};
	const notes: RunNotes = {
		async create(path, text) {
			files.set(path, text);
			return file(path);
		},
		async rename(target, newPath) {
			const mutable = target as unknown as { path: string };
			files.set(newPath, files.get(mutable.path) ?? "");
			files.delete(mutable.path);
			mutable.path = newPath;
		},
		async edit(target, edit) {
			const path = (target as unknown as { path: string }).path;
			const next = edit(files.get(path) ?? "");
			files.set(path, next);
			return next;
		},
		trashIf: async () => false,
	};
	await runMeetingNotes({
		calendar,
		vault,
		notes,
		problems: { report: () => undefined, clear: () => undefined, list: () => [] },
		layout: layout(),
		folder: "Meetings",
		template: DEFAULT_TEMPLATE,
		selfEmail: SELF,
		today: day,
		memory: {},
		commitMemory: async () => undefined,
	});
}

/** `note` with Windows line endings, and with or without its final line break. */
const ENDINGS: ReadonlyArray<[string, (lf: string) => string]> = [
	["Windows endings, ending in a line break", (lf) => lf.replace(/\n/g, "\r\n")],
	["Windows endings, no final line break", (lf) => lf.replace(/\n/g, "\r\n").replace(/\r\n$/, "")],
];

/** The written line a run should leave after editing `lf` to `edited`: the fingerprint of the edited body, `\r` kept. */
function expectedWrittenLine(edited: string): string {
	return `effortless-written: ${JSON.stringify(fingerprintOf(bodyOf(edited).replace(/\s+$/, "")))}\r`;
}

describe("a note the run itself edited", () => {
	it.each(ENDINGS)("keeps counting as untouched after the run retitles it — %s", async (_name, ending) => {
		const click = clickNote(OLD);
		const retitled = meeting({ ...OLD, summary: "Design sync" });
		const oldPath = COMPUTED;
		const newPath = meetingNotePath("Meetings", "2026-10-14", retitled.summary);
		files.set(oldPath, ending(click));

		await runOver([retitled]);

		const after = files.get(newPath) ?? "";
		// If wrong (the line still fingerprints the body as the click wrote it): the retitled body differs, so the
		// untouched note reads as holding the person's words, and the line below is the click's own.
		expect(after).toContain("# Design sync");
		expect(holds(after, retitled)).toBe(false);
		expect(after).toContain(`\r\n${expectedWrittenLine(click.replace("# Design review", "# Design sync"))}\n`);
	});

	it.each(ENDINGS)("keeps counting as untouched after the run adds a name — %s", async (_name, ending) => {
		const click = clickNote(OLD);
		const invited = meeting({
			...OLD,
			attendees: [...OLD.attendees, { name: "Berit Bergman", email: "berit.bergman@invented.test" }],
		});
		files.set(COMPUTED, ending(click));

		await runOver([invited]);

		const after = files.get(COMPUTED) ?? "";
		// If wrong (the added name changes what the line is compared with): the line differs from the click's.
		expect(after).toContain("Berit Bergman");
		expect(holds(after, invited)).toBe(false);
		expect(after).toContain(`\r\n${expectedWrittenLine(click)}\n`);
	});

	it("leaves the line as it was on a note whose body the person had already written in", async () => {
		const click = clickNote(OLD);
		const retitled = meeting({ ...OLD, summary: "Design sync" });
		const newPath = meetingNotePath("Meetings", "2026-10-14", retitled.summary);
		files.set(COMPUTED, click + "Ask about the budget.\n");

		await runOver([retitled]);

		const after = files.get(newPath) ?? "";
		// If wrong (the line is refreshed whatever the body held): the person's words are fingerprinted as written
		// and the note reads as untouched.
		expect(writtenInText(after)).toBe(writtenInText(click));
		expect(holds(after, retitled)).toBe(true);
	});
});
