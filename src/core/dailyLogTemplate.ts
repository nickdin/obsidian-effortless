/**
 * Building a new day's log from the person's own template note,
 * instead of the generic frame `vaultLayout.ts`'s `dailyLogFrame` builds.
 *
 * Pure code over strings, like the modules it draws on: no vault, no app, no
 * settings storage. `noteWriter.ts`'s `createDailyLog` reads the template
 * note's own text and hands it here, and writes back whatever this returns.
 *
 * **Every refusal here throws.** This module has no feature's own
 * standing-problems channel to report a broken template through — only a
 * feature may report (`GLOSSARY.md`, **Standing problem**), and building a
 * day's log is the core's job, not a feature's. Throwing is what reaches the
 * person: `createDailyLog` has two callers, days ahead's `runDay`
 * (`src/features/daysAhead/run.ts`) and `main.ts`'s "Create today's log"
 * command. `runDay` reports whatever `createDailyLog` throws, keyed by the
 * date, through its own problems channel, so a broken template leaves that
 * day uncreated rather than created wrong, and the report stands until the
 * template is fixed — the same shape `dailyLogPath` already uses for an
 * unanswered folder or an unreadable filename pattern. The command instead
 * shows the rejection as a `Notice`.
 */

import { parseCalendarTable } from "./calendarTable";
import { compilePattern } from "./datePattern";
import type { DateNameTables } from "./datePattern";
import { clampLevel, frontmatterEnd, headingRange } from "./markdownSections";
import { reasonOf } from "./reason";
import type { VaultLayout } from "./settings";
import {
	calendarTableBlock,
	dailyLogDateNames,
	daySections,
	insertionLineForMissingSection,
	sectionRange,
} from "./vaultLayout";
import type { SectionName } from "./vaultLayout";

/** Templater's own syntax, `<% … %>`. The plugin must not rely on Templater either way (issue #907's own ticket notes). */
const TEMPLATER_MARKER = "<%";

/** The placeholder names this module understands, matching Obsidian's own Templates plugin naming. */
type PlaceholderName = "date" | "yesterday" | "tomorrow";

function isPlaceholderName(name: string): name is PlaceholderName {
	return name === "date" || name === "yesterday" || name === "tomorrow";
}

/**
 * A new day's log built from `templateText`, for `date` — the day being
 * created, never "today" ({@link fillPlaceholders}).
 *
 * Throws, naming what was wrong, for each of the three things this plugin
 * refuses to build a day from silently: Templater code (`<%`) anywhere in
 * the template, a `{{…}}` placeholder this plugin does not know, and a
 * placeholder whose `FORMAT` this plugin cannot read. See this module's own
 * comment for why throwing, rather than substituting something and carrying
 * on, is what reports it.
 */
export function dailyLogFromTemplate(templateText: string, date: Date, layout: VaultLayout): string {
	if (templateText.includes(TEMPLATER_MARKER)) {
		throw new Error(
			`The day's-log template holds Templater code ("${TEMPLATER_MARKER}"), and Effortless does not run Templater. Remove it, or write the day's log without a template.`,
		);
	}

	const names = dailyLogDateNames(layout);
	const filled = fillPlaceholders(templateText, date, names);
	const withoutBlankRows = withoutBlankCalendarRows(filled, layout);
	return withMissingSections(withoutBlankRows, layout);
}

/**
 * The text a log built from `templateText` for `date` holds under the diary
 * heading — what the person did not write, so that a feature can tell the
 * template's own words in a new day's log from the person's.
 *
 * Read from the log {@link dailyLogFromTemplate} builds, never from the template
 * as it stands, so the placeholders are filled for `date` and a diary heading the
 * template leaves out, which the build adds empty, answers the empty string. The
 * lines are joined with line feeds whatever endings the template has, and run
 * from the line below the heading to the next heading of the same or a shallower
 * level. Throws what {@link dailyLogFromTemplate} throws.
 */
export function dailyLogTemplateDiary(templateText: string, date: Date, layout: VaultLayout): string {
	return diarySectionOf(dailyLogFromTemplate(templateText, date, layout), layout);
}

/**
 * The text `log`, a day's log as {@link dailyLogFromTemplate} built it, holds
 * under the diary heading: {@link dailyLogTemplateDiary}'s answer, read off a log
 * already built, which is how the note writer keeps it at build time.
 */
export function diarySectionOf(log: string, layout: VaultLayout): string {
	const lines = log.split("\n");
	const body = lines.slice(frontmatterEnd(lines) + 1);
	const range = headingRange(body.join("\n"), layout.diaryHeading.text, layout.diaryHeading.level);
	if (range === null) return "";
	return body
		.slice(range.start, range.end)
		.map((line) => line.replace(/\r$/, ""))
		.join("\n");
}

/**
 * `text` with every `{{date:FORMAT}}`, `{{yesterday:FORMAT}}` and
 * `{{tomorrow:FORMAT}}` filled for `date` — the day being created, so a day
 * built ahead of today by days ahead reads its own date, not the date it
 * happened to be built on.
 */
function fillPlaceholders(text: string, date: Date, names: DateNameTables): string {
	const dates: Record<PlaceholderName, Date> = {
		date,
		yesterday: addDays(date, -1),
		tomorrow: addDays(date, 1),
	};

	return text.replace(/\{\{([^{}]*)\}\}/g, (whole: string, inner: string) => {
		const colon = inner.indexOf(":");
		const name = colon < 0 ? inner : inner.slice(0, colon);
		const format = colon < 0 ? null : inner.slice(colon + 1);
		if (format === null || format === "" || !isPlaceholderName(name)) {
			throw new Error(
				`The day's-log template holds a placeholder Effortless does not know: "${whole}". It understands {{date:FORMAT}}, {{yesterday:FORMAT}} and {{tomorrow:FORMAT}}.`,
			);
		}
		try {
			return formatPlaceholder(format, dates[name], names);
		} catch (error) {
			throw new Error(
				`The day's-log template's "${whole}" placeholder could not be written: ${reasonOf(error)}.`,
			);
		}
	});
}

/**
 * `format` written out for `date` under `names` — the same date-pattern
 * writer `vaultLayout.ts`'s `dailyLogPath` compiles a filename with, minus
 * the `.md` {@link compilePattern}'s own `write` always appends on the end.
 * That suffix is a filename convention and a placeholder is not a filename,
 * so it is trimmed back off. `write` documents appending it once, always,
 * after every piece of the pattern has already been written — so it is
 * always exactly those three characters, and trimming them back off
 * recovers exactly what the pattern itself wrote.
 */
function formatPlaceholder(format: string, date: Date, names: DateNameTables): string {
	const written = compilePattern(format, names).write(date);
	return written.slice(0, -3);
}

/** `date` shifted by `delta` whole days, in local time, letting `Date` carry a month or year end. */
function addDays(date: Date, delta: number): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta);
}

/**
 * `content` with every calendar-table data row whose two cells are both
 * blank removed outright — spliced out of the lines directly, never handed
 * to `writeCalendarRows`, which by its own contract deletes only a row its
 * caller names for removal (`calendarTable.ts`). The old Templater-driven day carried a blank row as
 * a visible placeholder under the calendar heading; carried through
 * unchanged it would read to days ahead as one existing, blank meeting
 * rather than as no row at all — not what a blank cell in a person's own
 * template means, and not what the generic frame's own zero-row table gives
 * days ahead either.
 *
 * Answers `content` unchanged when the table holds no schema block days
 * ahead can read, or holds one with nothing blank in it to remove: the first
 * case is days ahead's own report to make, through a channel this module has
 * no route to, and the second has nothing to change.
 */
function withoutBlankCalendarRows(content: string, layout: VaultLayout): string {
	const lines = content.split("\n");
	const outcome = parseCalendarTable(lines, layout.calendarColumns);
	if (!outcome.found) return content;

	const blank = new Set(
		outcome.table.rows
			.filter((row) => row.time.trim() === "" && row.event.trim() === "")
			.map((row) => row.line),
	);
	if (blank.size === 0) return content;
	return lines.filter((_, i) => !blank.has(i)).join("\n");
}

/**
 * `content` with every day's-log heading {@link daySections} names and the
 * template leaves out added in — never duplicated where the template already
 * carries one, matched by the layout's own text and level exactly as
 * `sectionRange` matches it, never by position — and never added at all for
 * a heading whose configured text has been emptied, the same rule
 * `dailyLogFrame` follows for the same reason: nothing could ever find an
 * empty heading again.
 *
 * Walked in {@link daySections}' own order, so a heading resolved earlier in
 * that order is already in `result` by the time a later one asks what comes
 * after it — the same ordering argument `insertionLineForMissingSection`'s
 * own doc comment makes.
 */
function withMissingSections(content: string, layout: VaultLayout): string {
	let result = content;
	for (const section of daySections()) {
		const heading = layout[section];
		if (!heading.text.trim()) continue;
		if (sectionRange(result, section, layout) !== null) continue;
		result = insertMissingSection(result, section, layout);
	}
	return result;
}

/** Whether `content` has at least one "\r\n" and no "\n" that is not part of one. */
function isCrlfThroughout(content: string): boolean {
	return content.includes("\r\n") && !/(^|[^\r])\n/.test(content);
}

/**
 * `content` with `section`'s heading inserted where
 * {@link insertionLineForMissingSection} places it. The calendar heading
 * carries the same generic table {@link calendarTableBlock} gives a fresh
 * day's frame; every other missing heading carries an empty body, ready for
 * the person to write under.
 */
function insertMissingSection(content: string, section: SectionName, layout: VaultLayout): string {
	// A template written with Windows line endings throughout gets the heading
	// in the same endings, rather than a bare "\n" among "\r\n" (issue #1107:
	// the diary heading is added to every such template that lacks it). The
	// work is done on "\n" and converted back; a template mixing the two
	// endings is left to the "\n" path, as it always was.
	if (isCrlfThroughout(content)) {
		const inserted = insertMissingSection(content.replace(/\r\n/g, "\n"), section, layout);
		return inserted.replace(/\n/g, "\r\n");
	}
	const heading = layout[section];
	let block = `${"#".repeat(clampLevel(heading.level))} ${heading.text.trim()}\n\n`;
	if (section === "calendarHeading") block += calendarTableBlock(layout.calendarColumns);
	const blockLines = block.split("\n");
	// `block` always ends in "\n\n" — one blank line separating this section
	// from what follows, exactly as `dailyLogFrame` writes between sections —
	// and splitting it leaves two trailing empty strings for that one blank
	// line. The extra one is dropped so the block carries only the one.
	blockLines.pop();

	const lines = content.split("\n");
	const insertAt = insertionLineForMissingSection(content, section, layout);
	const needsLeadingBlank = insertAt === lines.length && insertAt > 0 && lines[insertAt - 1] !== "";
	lines.splice(insertAt, 0, ...(needsLeadingBlank ? [""] : []), ...blockLines);
	return lines.join("\n");
}
