import { describe, expect, it } from "vitest";
import { chain } from "../features/review/chain";
import { diaryDateText } from "../features/review/diaryDate";
import type { VaultLayout } from "../core/settings";
import { defaultData } from "../core/settings";
import type { ResolveLink, ReviewNote } from "../features/review/waitingNotes";

/**
 * The seam between #1109's write and #1110's reader: the diary-date field the
 * write puts into a day's log is the field the chain reads. Each test writes
 * with `diaryDateText`, reads the written line back as the frontmatter value
 * the chain is handed, and asks the chain for the day's diary mark.
 *
 * The frontmatter is read back here as text — `diary: 2026-10-12` becomes the
 * string `"2026-10-12"`, which is what Obsidian's metadata cache hands over for
 * a bare date: `docs/acceptance-shots/issue-1149-cache-date-drive.txt` read it
 * back in the test Obsidian.
 */

const layout: VaultLayout = {
	...defaultData().core.layout,
	dailyLogFolder: "Journal",
	dailyLogFilename: "YYYY-MM-DD",
	processedField: "processed",
	dayLinkField: "day",
	diaryDateField: "diary",
	diaryHeading: { text: "Diary", level: 1 },
	excludedFolders: [],
};

const resolveLink: ResolveLink = () => null;

const LOG = "---\nprocessed:\ndiary:\n---\n# Notes\n- [ ] one\n# Diary\nA walk by the harbour.\n";

/** The day's log for 2026-10-12 after the write ran on `writtenOn`, as the chain is handed it. */
function writtenLog(writtenOn: string, log = LOG): ReviewNote {
	const text = diaryDateText(log, layout.diaryHeading.text, layout.diaryHeading.level, layout.diaryDateField, writtenOn);
	if (text === null) throw new Error("the write wrote nothing");
	const line = /^diary:[ \t]*(.*)$/m.exec(text);
	if (line === null) throw new Error("the written log has no diary line");
	return { path: "Journal/2026-10-12.md", frontmatter: { processed: null, diary: line[1] }, text };
}

function diaryMarkOf12th(note: ReviewNote, today: Date) {
	return chain([note], layout, resolveLink, { year: 2026, month: 10 }, today).days[11].diary;
}

describe("the diary-date write read by the chain", () => {
	it("reads a log filled on its own day as kept, on that day and after", () => {
		const note = writtenLog("2026-10-12");
		expect(diaryMarkOf12th(note, new Date(2026, 9, 12))).toBe("kept");
		expect(diaryMarkOf12th(note, new Date(2026, 9, 14))).toBe("kept");
	});

	it("reads the same log filled the next day as missed", () => {
		expect(diaryMarkOf12th(writtenLog("2026-10-13"), new Date(2026, 9, 14))).toBe("missed");
	});
});

describe("a diary-date field holding an empty list", () => {
	// The chain reads `diary: []` as empty (an empty list in the metadata cache),
	// so the write has to fill it, or a diary written on its day reads missed.
	const EMPTY_LIST_LOG = "---\nprocessed:\ndiary: []\n---\n# Notes\n- [ ] one\n# Diary\nA walk by the harbour.\n";

	it("is filled on the log's own day and the chain reads the day as kept", () => {
		const note = writtenLog("2026-10-12", EMPTY_LIST_LOG);
		expect(note.text).toBe(EMPTY_LIST_LOG.replace("diary: []", "diary: 2026-10-12"));
		expect(diaryMarkOf12th(note, new Date(2026, 9, 12))).toBe("kept");
		expect(diaryMarkOf12th(note, new Date(2026, 9, 14))).toBe("kept");
	});

	it("is the same field the chain reads as empty before the write", () => {
		const before: ReviewNote = { path: "Journal/2026-10-12.md", frontmatter: { processed: null, diary: [] }, text: EMPTY_LIST_LOG };
		expect(diaryMarkOf12th(before, new Date(2026, 9, 14))).toBe("missed");
	});
});
