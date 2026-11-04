import { describe, expect, it } from "vitest";
// By path rather than as "obsidian": the real one has no `registerLocale`,
// `resetLanguage` or `setLanguage`, which are this stub's own doors for a suite
// to drive a language and a locale's names.
import { registerLocale, resetLanguage, setLanguage } from "./__mocks__/obsidian";
import { dailyLogFromTemplate } from "../core/dailyLogTemplate";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";

/**
 * The shipped layout with the two blank answers filled in, plus any
 * overrides. The shipped headings, in the level a fresh day's frame writes
 * them at: `# Notes`, `## Overdue`, `## Today`, `## Calendar`.
 */
function layout(overrides: Partial<VaultLayout> = {}): VaultLayout {
	return {
		...defaultData().core.layout,
		dailyLogFolder: "Journal",
		dailyLogFilename: "YYYY-MM-DD",
		...overrides,
	};
}

/** A local date, since a day's log is built for the local day. */
const day = (y: number, m: number, d: number): Date => new Date(y, m - 1, d);

describe("dailyLogFromTemplate — filling the three placeholders", () => {
	it("fills date, yesterday and tomorrow for the day being created, not for today", () => {
		// The day handed in is not "today" by any clock — nothing here reads
		// one — which is the whole of the ticket's own criterion: a day built
		// ahead of when it is built reads its own date.
		const text = dailyLogFromTemplate(
			"# {{date:dddd D MMMM}}\n\n← [[{{yesterday:YYYY-MM-DD}}]] | [[{{date:YYYY-MM}}]] | [[{{tomorrow:YYYY-MM-DD}}]] →\n\n# Notes\n\n## Overdue\n\n## Today\n\n## Calendar\n\n```schema\n| Time | Meeting |\n| --- | --- |\n```\n",
			day(2026, 9, 24),
			layout(),
		);

		expect(text).toContain("Thursday 24 September");
		expect(text).toContain("[[2026-09-23]]");
		expect(text).toContain("[[2026-09]]");
		expect(text).toContain("[[2026-09-25]]");
	});

	it("carries a month or year end the way Date itself does", () => {
		const text = dailyLogFromTemplate(
			"{{yesterday:YYYY-MM-DD}} {{date:YYYY-MM-DD}} {{tomorrow:YYYY-MM-DD}}",
			day(2027, 1, 1),
			layout(),
		);
		expect(text.startsWith("2026-12-31 2027-01-01 2027-01-02")).toBe(true);
	});

	it("throws naming an unknown placeholder, rather than dropping it silently", () => {
		expect(() => dailyLogFromTemplate("{{nextWeek:YYYY-MM-DD}}", day(2026, 9, 24), layout())).toThrow(
			'a placeholder Effortless does not know: "{{nextWeek:YYYY-MM-DD}}"',
		);
	});

	it("throws naming a recognised placeholder with a FORMAT it cannot read", () => {
		expect(() => dailyLogFromTemplate("{{date:QQQQ}}", day(2026, 9, 24), layout())).toThrow(
			'"{{date:QQQQ}}" placeholder could not be written',
		);
	});

	it("throws for a bare {{date}} with no FORMAT, rather than guessing one", () => {
		expect(() => dailyLogFromTemplate("{{date}}", day(2026, 9, 24), layout())).toThrow(
			'a placeholder Effortless does not know: "{{date}}"',
		);
	});
});

describe("dailyLogFromTemplate — Templater code", () => {
	it("throws naming the marker, rather than running or stripping it", () => {
		expect(() =>
			dailyLogFromTemplate("# Day\n\n<% tp.date.now() %>\n", day(2026, 9, 24), layout()),
		).toThrow('Templater code ("<%")');
	});
});

describe("dailyLogFromTemplate — frontmatter", () => {
	it("is written as it stands, a placeholder inside it filled the same way", () => {
		const text = dailyLogFromTemplate(
			"---\ntags: day\nlogged: {{date:YYYY-MM-DD}}\n---\n\n# Notes\n\n## Overdue\n\n## Today\n\n## Calendar\n\n```schema\n| Time | Meeting |\n| --- | --- |\n```\n",
			day(2026, 9, 24),
			layout(),
		);
		expect(text.startsWith("---\ntags: day\nlogged: 2026-09-24\n---\n\n")).toBe(true);
	});
});

describe("dailyLogFromTemplate — missing headings", () => {
	it("adds a heading the template lacks, at its own level, keeping the template's own order for the rest", () => {
		const text = dailyLogFromTemplate(
			"# Notes\n\nWrite here.\n\n## Calendar\n\n```schema\n| Time | Meeting |\n| --- | --- |\n```\n",
			day(2026, 9, 24),
			layout(),
		);

		// Nothing about the template's own two headings moved.
		const notesAt = text.indexOf("# Notes");
		const calendarAt = text.indexOf("## Calendar");
		expect(notesAt).toBe(0);
		expect(calendarAt).toBeGreaterThan(notesAt);

		// Overdue and Today are missing, so daySections()' own order says
		// where they land: directly above the nearest later section that
		// already exists — here, Calendar — overdue above today.
		const overdueAt = text.indexOf("## Overdue");
		const todayAt = text.indexOf("## Today");
		expect(overdueAt).toBeGreaterThan(notesAt);
		expect(overdueAt).toBeLessThan(calendarAt);
		expect(todayAt).toBeGreaterThan(overdueAt);
		expect(todayAt).toBeLessThan(calendarAt);
	});

	it("never duplicates a heading the template already carries", () => {
		const text = dailyLogFromTemplate(
			"# Notes\n\n## Overdue\n\n## Today\n\n## Calendar\n\n```schema\n| Time | Meeting |\n| --- | --- |\n```\n",
			day(2026, 9, 24),
			layout(),
		);
		expect(text.match(/^# Notes$/m)?.length).toBe(1);
		expect(text.match(/## Overdue/g)?.length).toBe(1);
		expect(text.match(/## Today/g)?.length).toBe(1);
		expect(text.match(/## Calendar/g)?.length).toBe(1);
	});

	it("adds a missing calendar heading with the same generic table a fresh day's frame carries", () => {
		const text = dailyLogFromTemplate("# Notes\n\nWrite here.\n", day(2026, 9, 24), layout());
		expect(text).toContain("## Calendar\n\n```schema\n| Time | Meeting |\n| --- | --- |\n```\n");
	});

	it("finds a heading by the layout's own text and level, never by position", () => {
		// Written at level 2 where the layout wants level 1 for Notes: not a
		// match, so the configured heading is still added, and the level-2
		// line stands as ordinary prose beside it rather than being read as
		// the section.
		const text = dailyLogFromTemplate("## Notes\n\nWrite here.\n", day(2026, 9, 24), layout());
		expect(text.match(/^# Notes$/m)).not.toBeNull();
		expect(text).toContain("## Notes");
	});

	it("adds the diary heading last when the template lacks it, after the calendar table", () => {
		const template = "# Notes\n\n## Overdue\n\n## Today\n\n## Calendar\n\n```schema\n| Time | Meeting |\n| --- | --- |\n```\n";
		const text = dailyLogFromTemplate(template, day(2026, 9, 24), layout());
		expect(text).toBe(template + "\n# Diary\n");
	});

	it("adds the diary heading after the calendar table the same call adds, when the template has neither", () => {
		const text = dailyLogFromTemplate("# Notes\n\nWrite here.\n", day(2026, 9, 24), layout());
		expect(text).toBe(
			"# Notes\n\nWrite here.\n\n## Overdue\n\n## Today\n\n## Calendar\n\n```schema\n| Time | Meeting |\n| --- | --- |\n```\n\n# Diary\n",
		);
	});

	it("leaves a template that already carries the diary heading as written, text under it included", () => {
		const template = "# Notes\n\n## Overdue\n\n## Today\n\n## Calendar\n\n```schema\n| Time | Meeting |\n| --- | --- |\n```\n\n# Diary\n\nWent for a long walk.\n";
		expect(dailyLogFromTemplate(template, day(2026, 9, 24), layout())).toBe(template);
	});

	// A heading written into a note is tested on Windows line endings, once ending
	// in a line break and once not (`CLAUDE.md`). A day's creation has no undo:
	// `createDailyLog` is called only by days ahead and the create-today command
	// and nothing takes its file back out.
	it.each([
		["with a final line break", "\r\n"],
		["without a final line break", ""],
	])("adds the diary heading in Windows line endings to a template that has them, %s", (_name, ending) => {
		const template =
			"# Notes\r\n\r\n## Overdue\r\n\r\n## Today\r\n\r\n## Calendar\r\n\r\n```schema\r\n| Time | Meeting |\r\n| --- | --- |\r\n```" +
			ending;
		const text = dailyLogFromTemplate(template, day(2026, 9, 24), layout());
		expect(text).toBe(template + (ending === "" ? "\r\n" : "") + "\r\n# Diary\r\n");
		expect(text.replace(/\r\n/g, "")).not.toContain("\n");
	});

	it("never adds the diary heading when its configured text is blank", () => {
		const template = "# Notes\n\n## Overdue\n\n## Today\n\n## Calendar\n\n```schema\n| Time | Meeting |\n| --- | --- |\n```\n";
		expect(dailyLogFromTemplate(template, day(2026, 9, 24), layout({ diaryHeading: { text: " ", level: 1 } }))).toBe(
			template,
		);
	});

	it("never adds a heading whose configured text has been emptied", () => {
		const text = dailyLogFromTemplate(
			"Just a line.\n",
			day(2026, 9, 24),
			layout({ notesHeading: { text: "", level: 1 } }),
		);
		// The other four, unemptied, are still added — only Notes is left out.
		expect(text).not.toMatch(/^#{1,6} Notes$/m);
		expect(text).toContain("## Overdue");
		expect(text).toContain("## Today");
		expect(text).toContain("## Calendar");
	});
});

describe("dailyLogFromTemplate — the calendar table's blank data row", () => {
	/** All five headings present, so nothing about missing-section insertion is in play here. */
	function withAllHeadings(calendarBody: string): string {
		return `# Notes\n\n## Overdue\n\n## Today\n\n## Calendar\n\n${calendarBody}\n# Diary\n`;
	}

	it("drops a blank data row rather than reading it as a meeting", () => {
		const text = dailyLogFromTemplate(
			withAllHeadings("```schema\n| Time | Meeting |\n| --- | --- |\n|  |  |\n```\n"),
			day(2026, 9, 24),
			layout(),
		);
		expect(text).toBe(withAllHeadings("```schema\n| Time | Meeting |\n| --- | --- |\n```\n"));
	});

	it("leaves a row that holds real text alone", () => {
		const template = withAllHeadings(
			"```schema\n| Time | Meeting |\n| --- | --- |\n| 09:00 | Standup |\n```\n",
		);
		expect(dailyLogFromTemplate(template, day(2026, 9, 24), layout())).toBe(template);
	});

	it("leaves the table untouched when the template names no schema block at all", () => {
		const template = withAllHeadings("Nothing here yet.\n");
		expect(dailyLogFromTemplate(template, day(2026, 9, 24), layout())).toBe(template);
	});
});

describe("dailyLogFromTemplate — a language whose months have two forms", () => {
	// A fabricated language: the standalone word ends in `-ari`, the word moment
	// writes for a month inside a date in `-aria`.
	const TWO_FORM_LOCALE = {
		months: [
			"Enari", "Tvåari", "Treari", "Fyrari", "Femari", "Sexari",
			"Sjuari", "Åttari", "Nioari", "Tioari", "Elvari", "Tolvari",
		],
		monthsShort: ["Ena", "Två", "Tre", "Fyr", "Fem", "Sex", "Sju", "Ått", "Nio", "Tio", "Elv", "Tol"],
		weekdays: ["Söndär", "Måndär", "Tisdär", "Onsdär", "Torsdär", "Fredär", "Lördär"],
		weekdaysShort: ["Sön", "Mån", "Tis", "Ons", "Tor", "Fre", "Lör"],
		monthsInDate: [
			"Enaria", "Tvåaria", "Trearia", "Fyraria", "Femaria", "Sexaria",
			"Sjuaria", "Åttaria", "Nioaria", "Tioaria", "Elvaria", "Tolvaria",
		],
		monthsShortInDate: ["Ena.", "Två.", "Tre.", "Fyr.", "Fem.", "Sex.", "Sju.", "Ått.", "Nio.", "Tio.", "Elv.", "Tol."],
	};

	it("writes each placeholder in the form its own format calls for, not the filename pattern's", () => {
		resetLanguage();
		registerLocale("xx", TWO_FORM_LOCALE);
		setLanguage("xx");
		try {
			// The filename pattern has no month word at all, so nothing about the
			// filename could decide the form: only the placeholder's own format.
			const text = dailyLogFromTemplate(
				"{{date:D MMMM}} | {{date:MMMM D}} | {{tomorrow:D MMM}} | {{yesterday:YYYY-MMMM}}",
				day(2026, 1, 5),
				layout({ dailyLogFilename: "YYYY-MM-DD" }),
			);
			expect(text.slice(0, "5 Enaria | Enari 5 | 6 Ena. | 2026-Enari".length)).toBe(
				"5 Enaria | Enari 5 | 6 Ena. | 2026-Enari",
			);
		} finally {
			resetLanguage();
		}
	});
});
