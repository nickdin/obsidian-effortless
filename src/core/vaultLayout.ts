/**
 * The day's log: which sections it has, where it lives, and what a new one is
 * framed with.
 *
 * Every answer is derived from the core's vault layout and from nothing else —
 * no vault, no app, no stored state — so they are imported directly rather than
 * handed to a feature through the host (`src/core/feature.ts`). Creating a
 * missing day's log is not a derivation and lives in `noteWriter.ts`.
 *
 * This module is the only one of the three that reads the layout settings. The
 * others it stands on know nothing about vaults: `datePattern.ts` writes a date
 * out under a filename pattern and reads it back, `markdownSections.ts` finds
 * the lines a heading owns inside a note, and `calendarTable.ts` lends one
 * function, `escapeCellText`, so a configured column name is escaped into a
 * table header the same way a cell's value is escaped into a row — that
 * module imports nothing of settings or vaults either, so taking its function
 * does not reopen the cycle `asVaultPath` was moved to avoid, below.
 *
 * A day's-log heading carries its level, because there the level decides where a
 * line goes. A collection's heading carries none, because there the level only
 * decides whether the note counts. The two rules differ on
 * purpose, and this file only ever deals with the first kind.
 *
 * `asVaultPath` lives here too. It is a plain text rule about a path a person
 * typed, with nothing to do with stored settings, and it sat in `settings.ts`
 * until the calendar module needed it — which made those two modules import
 * each other, a cycle whose safety rested on a property no guard checked. Here it is
 * reachable from either without one.
 */

import { getLanguage, moment, normalizePath } from "obsidian";
import { escapeCellText } from "./calendarTable";
import { compilePattern, ENGLISH_NAMES, understandsPattern } from "./datePattern";
import type { DateNames, DateNameTables } from "./datePattern";
import { clampLevel, headingRange } from "./markdownSections";
import type { SectionRange } from "./markdownSections";
import type { HeadingSetting, VaultLayout } from "./settings";

// Re-exported so a caller that wants the range a section covers needs one
// import rather than two; the type itself belongs to the scanner.
export type { SectionRange };

/** The layout's three frontmatter property names, which a note's writer and editor are handed together. */
export type LayoutFieldNames = Pick<VaultLayout, "processedField" | "dayLinkField" | "diaryDateField">;

/**
 * The names a vault answers nothing for: English, like every other shipped
 * layout default. `shippedLayout` (`settings.ts`) takes them from here so the
 * two can never differ.
 */
export const SHIPPED_FIELD_NAMES: LayoutFieldNames = {
	processedField: "processed",
	dayLinkField: "day",
	diaryDateField: "diary",
};

/**
 * Why `value` cannot be text a field holds, or `null` where it can: not text,
 * or blank. The part of the rule every field shares — a property name, a
 * heading and a tag alike — and nothing more: a colon is ordinary text in a
 * heading or a tag. `label` is the row's name on the settings
 * screen, which is also how a refusal names it.
 */
export function textFieldRefusal(label: string, value: unknown): string | null {
	if (typeof value !== "string") return `${label} must be text.`;
	if (value.trim() === "") return `${label} cannot be blank.`;
	return null;
}

/**
 * Why `value` cannot be the name of a frontmatter property the vault layout
 * keeps — the processed field, the day-link field and the diary-date field —
 * or `null` where it can: not text, blank, or carrying a colon that ends a
 * key. **A colon ends a property's name only where a space follows it or it
 * is the last character**, so `diary: ` and `diary:` would be written as a
 * different property from the one read back (spec #1049, the diary-date
 * field's box), while `review:done` is one name that Obsidian reads back
 * whole (driven, issue #1131). `label` is as in {@link textFieldRefusal}.
 *
 * **One rule, asked from every side.** The core card asks it before it stores
 * what was typed, the settings store asks it of what it reads from
 * `data.json`, and Meeting notes' card asks it of its two property names
 * (`templateFieldRefusal`), so the three can never disagree about what a
 * usable name is.
 */
export function fieldNameRefusal(label: string, value: unknown): string | null {
	const unusable = textFieldRefusal(label, value);
	if (unusable !== null) return unusable;
	if (/:(\s|$)/.test(value as string)) return `${label} cannot contain a colon.`;
	return null;
}

/**
 * A name {@link fieldNameRefusal} accepts, as it is stored: with the spaces
 * around it taken off. The core card stores what it returns, and the settings
 * store reads `data.json` through it, so a name typed and a name read back are
 * the same text.
 */
export function storedFieldName(value: string): string {
	return value.trim();
}

/**
 * A vault path as it is stored: tidied by Obsidian's own `normalizePath`, once,
 * where the person typed it. Obsidian's plugin guidelines require it of any
 * path a person supplies (`docs/research/obsidian-publishing-requirements.md`),
 * and doing it at the store rather than at each use is what stops every later
 * reader having to remember to.
 *
 * **Every stored path is normalised again as it is read**, because a settings
 * file written by an older version, or edited by hand, arrives unnormalised. The two layout paths call `normalizePath` where they are used,
 * in `parseDailyLogDate` and `dailyLogPrefix` below; a calendar's file path
 * goes through this function as `readCalendarSources` reads it. A calendar
 * *link* is the one stored address that is only ever trimmed — this rule
 * collapses the double slash in `https://` and would leave an address that
 * fetches nothing. `asLocation` in `calendarSources.ts` is the one place that
 * chooses between the two.
 *
 * It is one function rather than one per box because three of them store a
 * path — the daily-log folder, the excluded folders, and a calendar's `.ics`
 * file — and a second copy of the rule is how two of them end up disagreeing.
 *
 * A blank box stays blank. `normalizePath("")` answers `"/"`, which is the
 * vault root — a configured answer, where blank means the question has not been
 * answered yet. Turning one into the other would be a behaviour change.
 */
export function asVaultPath(value: string): string {
	const raw = value.trim();
	return raw ? normalizePath(raw) : "";
}

/**
 * The layout settings that name a section of the day's log. Derived from the
 * settings type itself, so a feature ticket that adds a day's-log section adds
 * it to the core settings group and finds this type has already followed.
 *
 * Only a `HeadingSetting` field is admitted, because only a levelled heading is
 * a section — see {@link SECTION_ORDER} for what that does and does not guard.
 */
export type SectionName = {
	[K in keyof VaultLayout]-?: VaultLayout[K] extends HeadingSetting ? K : never;
}[keyof VaultLayout];

/**
 * The order the sections are written in when the plugin builds a day.
 *
 * A `Record` rather than a list on purpose: adding a `HeadingSetting` field to
 * `VaultLayout` widens `SectionName`, and this record then fails to compile
 * until someone says where the new section goes. A list would have compiled and
 * quietly left the section out of every new day.
 *
 * **The guard reaches `HeadingSetting` fields and no others**. A
 * heading added to `VaultLayout` as a plain `string` widens nothing, so this
 * record still compiles and that heading is never written into a day. That is
 * the boundary rather than a hole: a plain-string heading is a collection's
 * heading — `tasksHeading` and `completedTasksHeading` are the two the plugin
 * ships — and a collection's heading carries no level on purpose, because there
 * the level only decides whether the note counts. Nothing
 * without a level can be one of the levelled headings a new day is framed from,
 * so it is not a section at all. Adding a *day's-log* heading means giving it a
 * level, and that is what puts it inside the guard.
 *
 * `src/__tests__/vaultLayout.test.ts` holds both halves of that claim: a
 * compile-time assertion that `SectionName` is exactly the levelled headings,
 * and a test that a new day carries neither task heading.
 *
 * **Where `diaryHeading` sits**: last, after the
 * calendar table. The diary is free writing about the day itself, written when
 * the day is over, so it takes the end of the note where a person keeps
 * writing, and nothing the plugin writes into a day later lands beneath it.
 *
 * **Where `todayHeading` and `overdueHeading` sit**: spec #709
 * decision 5 fixes only that overdue is directly above today, the placement
 * the old plugin's own `ensureDagloggSection` used for `## Försenade` above
 * `## Att göra idag` (`docs/research/effortless-code-audit.md` § 3.4). Where
 * the pair sits against notes and calendar was the worker's to place: between
 * them, so the day reads free writing, then what needs doing, then the day's
 * meetings — notes first because it is where a day starts, calendar after them
 * because it is consulted rather than acted on, and the diary heading last of
 * all (below).
 */
const SECTION_ORDER: Record<SectionName, number> = {
	notesHeading: 0,
	overdueHeading: 1,
	todayHeading: 2,
	calendarHeading: 3,
	diaryHeading: 4,
};

/** The day's-log sections, in the order a new day is written in. */
export function daySections(): SectionName[] {
	const names = Object.keys(SECTION_ORDER) as SectionName[];
	return names.sort((a, b) => SECTION_ORDER[a] - SECTION_ORDER[b]);
}

/**
 * The line a missing `section` heading is inserted at inside `content`:
 * directly above the heading line of the nearest section that comes after it
 * in {@link daySections}' order and already exists, or the end of the note
 * when none of them do.
 *
 * General over every day's-log section, so both `dailyLogTemplate.ts` (issue
 * #907, for whichever of the five a person's template leaves out) and a
 * feature adding only the two task sections it writes under call this one
 * rule rather than each keeping its own copy (`CLAUDE.md`'s rule about a rule
 * the core already holds).
 */
export function insertionLineForMissingSection(
	content: string,
	section: SectionName,
	layout: VaultLayout,
): number {
	const order = daySections();
	const index = order.indexOf(section);
	for (let i = index + 1; i < order.length; i += 1) {
		const later = sectionRange(content, order[i], layout);
		if (later !== null) return later.heading;
	}
	return content.split("\n").length;
}

/* ------------------------------------------------------------------------ */
/* The month and weekday names a day's-log pattern is written and read with. */
/* ------------------------------------------------------------------------ */

/**
 * The names {@link dailyLogPath}, {@link parseDailyLogDate},
 * {@link dailyLogPattern} and {@link everySweptDayReadsBack} compile a
 * pattern with: the app's own current language to write and read with first,
 * and, when one is recorded, the language active immediately before it last
 * changed to fall back to on the way in — so a day's log already on disk
 * under the old language is still recognised.
 *
 * The language, its recorded history and moment's own names for each are
 * all read fresh on every call, through Obsidian's own `getLanguage`
 * (`obsidian.d.ts:3365`) and its own `moment` (`obsidian.d.ts:4561`), never
 * kept from an earlier one — the core's own rule that anything a block's
 * reach reads from the world is read when used (`CLAUDE.md`). What is kept is
 * kept against the `Locale` object that was read, never against a language
 * code, so a changed language is read on the next call; a pattern with no
 * month name in it asks the `Locale` for four lists and nothing more
 * (issue #1175, issue #1189, {@link namesFromLocale}).
 */
function dailyLogNames(layout: VaultLayout): DateNameTables {
	const current = namesForLocale(getLanguage()) ?? ENGLISH_NAMES;
	const previousLanguage = layout.languageHistory.previous;
	if (previousLanguage === null) return { current };
	const previous = namesForLocale(previousLanguage);
	return previous === null ? { current } : { current, previous };
}

/**
 * {@link dailyLogNames}, exported for `dailyLogTemplate.ts`: a template's own
 * `{{date:FORMAT}}` placeholder is written in the same month and weekday
 * names the day's-log filename already is, rather than a table of its own.
 */
export function dailyLogDateNames(layout: VaultLayout): DateNameTables {
	return dailyLogNames(layout);
}

/**
 * The month and weekday names `moment` holds for `locale`, or `null` when
 * `moment` does not recognise it, read from moment's own `Locale` for that
 * code through `moment.localeData` (`moment.d.ts:705`) — never by switching
 * the app's global locale and listing the names through `moment.months()`
 * and its three siblings.
 *
 * **Why not the global route.** Each of the four global readers builds and
 * formats a moment object per month or weekday, thirty-eight per call, and
 * {@link dailyLogPath} and {@link parseDailyLogDate} call this once or
 * twice per path they are handed: a DevTools trace of the production vault
 * on 2026-10-14 spent over 20 seconds of two minutes there, the laptop at
 * its thermal limit. A `Locale`'s own `months()` and
 * siblings, called with no argument, hand back the same standalone lists
 * from the table moment already holds, at the cost of an object lookup.
 * A month that has a second form for inside a date is read from the same
 * `Locale`, by {@link namesFromLocale}.
 * Driven in Obsidian 1.14.4's own moment, 2.30.1, for all 142 languages it
 * lists, with the fallback described below read back as well
 * (`docs/acceptance-shots/issue-1175-moment-drive.txt`). The lists are
 * handed out as moment holds them, which is safe because {@link DateNames}
 * is read-only throughout.
 *
 * **Recognised, without a switch.** `moment.localeData(code)` never says
 * "not found": real moment's `getLocale` ends in `chooseLocale`, whose last
 * resort is the global locale (`node_modules/moment/moment.js:2080`, and
 * read back in the app by the same drive). So a code is recognised when
 * the `Locale` it resolves to is not the global one, or, when it is, when
 * {@link recognisesLocale} says the code names the active locale exactly or
 * as one of its regions — an active `sv` answers `sv-FI`, while `xx-yy`
 * under an active `sv` answers `null`.
 *
 * **`locale` is compared normalised, not as written.** Obsidian hands this
 * function its own language code exactly as it stores it — mixed case among
 * them, `pt-BR`, `zh-TW`, `en-GB` — while real moment's own `normalizeLocale`
 * (`node_modules/moment/moment.js:2044-2046`) lower-cases the key and turns
 * its first `_` into `-` before ever looking it up, so the active locale for
 * an Obsidian `pt-BR` is `"pt-br"`. Comparing the two as written made every
 * mixed-case Obsidian language fall through to English. Real
 * moment also falls back one region step, from `xx-yy` to `xx`, when it has
 * no locale file for the region alone (`chooseLocale`,
 * `moment.js:2051-2081`), and `localeData` does the same, so that fallback is
 * a real answer here too.
 */
function namesForLocale(locale: string): DateNames | null {
	const data = moment.localeData(locale);
	if (data !== moment.localeData()) return namesFromLocale(data);
	return recognisesLocale(normalizeLocaleKey(locale), moment.locale()) ? namesFromLocale(data) : null;
}

/** The key `locale` is looked up under, matched to real moment's own `normalizeLocale` (see {@link namesForLocale}). */
function normalizeLocaleKey(locale: string): string {
	return locale.toLowerCase().replace("_", "-");
}

/**
 * Whether `active` — the locale `moment` is active on, which
 * `moment.localeData` falls back to when nothing else resolves — is a real
 * answer for `normalized` rather than that fallback.
 *
 * An exact match is the ordinary case: the current language's names, with
 * moment already active on it. A region falling back to its language —
 * `active` naming a prefix of `normalized` up to the next `-` — is real
 * moment's own resolution (see {@link namesForLocale}) and is accepted here
 * the same way: the core Daily notes plugin asks moment for the same code
 * and gets the same fallback, so matching it is matching Daily notes, not
 * working around moment. Neither case can be faked by the fallback alone:
 * nothing asked for here shares a prefix with an unrelated locale that
 * merely happened to be active already.
 */
function recognisesLocale(normalized: string, active: string): boolean {
	return normalized === active || normalized.startsWith(`${active}-`);
}

/**
 * The format strings `Locale.months` and `Locale.monthsShort` are asked in turn
 * to find the in-date form with: a day number then the month, which moment's
 * default rule (`node_modules/moment/moment.js:963`) and most languages' own
 * take as a month inside a date, and the month then a day number, which is the
 * only order `gom-deva` and `gom-latn` carry their own rule for
 * (`node_modules/moment/locale/gom-deva.js:41`). The first that makes a month
 * read differently from its standalone word gives the in-date list. The list is
 * only what a name is *read* against: what is *written* is asked of the
 * `Locale` under the pattern itself (see {@link namesFromLocale}).
 */
const IN_DATE_PROBES = {
	months: ["D MMMM", "MMMM D"],
	monthsShort: ["D MMM", "MMM D"],
} as const;

/**
 * The names one of moment's own `Locale` objects holds — the standalone lists,
 * the in-date lists beside them, and the words a given pattern is written with. Exported so a test can hand it a real moment's
 * `Locale`.
 *
 * **Two forms, from the same `Locale`.** `months()` with no argument is the
 * standalone list; `months(m, format)` for a moment `m` and a format string is
 * the word moment writes for that month in a date written under `format`
 * (`moment.d.ts:39`, `:41`).
 *
 * **What is written is asked under the pattern itself.** `monthsWrittenUnder`
 * hands the `Locale` the whole pattern being compiled and returns what it says
 * for the twelve months, so a language whose rule is its own — `es`, `nl`, `fy`
 * give the short month without its dot only inside `-MMM-`
 * (`node_modules/moment/locale/es.js:40-48`) — is written exactly as moment
 * writes it, with no probe format guessing at the rule. **What is
 * read** is the standalone list, the in-date list found by
 * {@link IN_DATE_PROBES} and the pattern's own words.
 *
 * **Kept by the `Locale` object, and by nothing else.** The names are
 * remembered against the `Locale` they were read from, in a `WeakMap`, so a
 * call that reads the same `Locale` again finds them. The language is still
 * read on every call ({@link dailyLogNames}) and `moment.localeData` is still
 * asked for its `Locale` on every call, so a changed language, or a language
 * moment re-registers (`moment.updateLocale` makes a new `Locale`,
 * `node_modules/moment/moment.js:2012-2038`), is a different key and is read
 * on the next call; a `Locale` edited in place by `Locale.set` is the one
 * change this does not see. Within a `Locale`, the in-date lists
 * are asked on first use and not before, so the default `YYYY-MM-DD` pattern,
 * which has no month in it, never pays for them.
 *
 * **The moment handed in is a stand-in.** The default readers ask a moment for
 * its month and for nothing else (`node_modules/moment/moment.js:972-994`),
 * and building a real one per month, twenty-four a call, is the cost issue
 * #1175 took out of this path. A few languages carry readers of their own
 * (`pl` and `el` among them: `node_modules/moment/locale/pl.js:62`, `el.js:30`), so that is a measurement and
 * not a reading of one source file: `datePatternRealMoment.test.ts` hands this
 * function every language of this repository's moment, 2.29.4, and checks
 * its names against moment's own format, none thrown; and Obsidian 1.14.4's
 * own moment, 2.30.1, gave the same words for `ru`, `pl` and `ca`
 * (`docs/acceptance-shots/issue-1176-russian-drive.txt`).
 */
export function namesFromLocale(data: moment.Locale): DateNames {
	let names = NAMES_OF.get(data);
	if (names === undefined) {
		names = new LocaleNames(data);
		NAMES_OF.set(data, names);
	}
	return names;
}

/** What {@link namesFromLocale} has read from each `Locale`, held only as long as moment holds that `Locale`. */
const NAMES_OF = new WeakMap<moment.Locale, DateNames>();

/** The {@link DateNames} one `Locale` gives; see {@link namesFromLocale}. */
class LocaleNames implements DateNames {
	readonly months: readonly string[];
	readonly monthsShort: readonly string[];
	readonly weekdays: readonly string[];
	readonly weekdaysShort: readonly string[];
	private inDateMonths: readonly string[] | undefined;
	private inDateMonthsShort: readonly string[] | undefined;
	private readonly written = new Map<string, readonly string[]>();

	constructor(private readonly data: moment.Locale) {
		this.months = data.months();
		this.monthsShort = data.monthsShort();
		this.weekdays = data.weekdays();
		this.weekdaysShort = data.weekdaysShort();
	}

	get monthsInDate(): readonly string[] {
		this.inDateMonths ??= this.inDateList("months", this.months);
		return this.inDateMonths;
	}

	get monthsShortInDate(): readonly string[] {
		this.inDateMonthsShort ??= this.inDateList("monthsShort", this.monthsShort);
		return this.inDateMonthsShort;
	}

	monthsWrittenUnder = (field: "MMMM" | "MMM", format: string): readonly string[] => {
		const key = `${field}\u0000${format}`;
		let list = this.written.get(key);
		if (list === undefined) {
			const from = field === "MMMM" ? "months" : "monthsShort";
			list = this.months.map((_, month) => this.data[from](monthOf(month), format));
			this.written.set(key, list);
		}
		return list;
	};

	private inDateList(key: "months" | "monthsShort", standalone: readonly string[]): readonly string[] {
		for (const format of IN_DATE_PROBES[key]) {
			const list = standalone.map((_, month) => this.data[key](monthOf(month), format));
			if (list.some((word, month) => word !== standalone[month])) return list;
		}
		return standalone;
	}
}

/** The one thing a `Locale`'s month readers ask of a moment: its month. */
function monthOf(month: number): moment.Moment {
	return { month: () => month } as unknown as moment.Moment;
}

/**
 * A pattern compiled with both of {@link dailyLogNames}' tables, and able to
 * write with either — what {@link dailyLogPathFrom} and
 * {@link parseDailyLogDateFrom} share.
 *
 * `write` always writes under the current language, the one answer a day's
 * log is ever created with. `read` recognises a name in the current
 * language first and the previous one next, exactly as
 * `datePattern.ts`'s own `CompiledPattern.read` does. `writtenElsewhere`
 * exists for the round trip {@link parseDailyLogDateFrom} checks: every other
 * name the same date legitimately has. A date read back from a name written
 * under the previous language reproduces that same name only when it is
 * written under the previous language again — writing it under the current
 * one, as {@link dailyLogPath} always does, would legitimately give a
 * different name and wrongly refuse an old log that `read` just recognised. A month with two forms adds the other form's name, in the
 * current language and in the previous one: a log Daily notes wrote under the
 * form this plugin does not, or one this plugin wrote before it knew of two,
 * still counts.
 */
interface DailyLogPattern {
	write(date: Date): string;
	read(name: string): Date | null;
	writtenElsewhere(date: Date): readonly string[];
}

/**
 * Builds a {@link DailyLogPattern} from a raw filename pattern and the two
 * name tables it is read and written with. Compiles the pattern twice when a
 * previous language is recorded — once with both tables for `read` to try in
 * turn, and once more, current-only, purely to answer
 * {@link DailyLogPattern.writtenElsewhere} — a pattern this short costs
 * nothing to tokenise a second time next to the sweep this feeds
 * (issue #585's own measurements are about the 1,461-day sweep, not about
 * compiling a pattern once more).
 */
function compileDailyLogPattern(raw: string, names: DateNameTables): DailyLogPattern {
	const primary = compilePattern(raw, names);
	const previous = names.previous ? compilePattern(raw, { current: names.previous }) : null;
	return {
		write: (date) => primary.write(date),
		read: (name) => primary.read(name),
		writtenElsewhere: (date) => [
			...primary.writeAlso(date),
			...(previous === null ? [] : [previous.write(date), ...previous.writeAlso(date)]),
		],
	};
}

/* ------------------------------------------------------------------------ */
/* The day's log's path.                                                      */
/* ------------------------------------------------------------------------ */

/**
 * The vault path of the day's log for `date`.
 *
 * The filename setting is a date pattern in the notation Obsidian's own daily
 * notes use, so `YYYY/MM/YYYY-MM-DD` puts the day in folders of its own. Throws
 * when the vault has not been described yet, or when the pattern uses a token
 * this plugin does not understand: a wrong path would create a second file
 * beside the day the person actually writes in, which is worse than a message.
 */
export function dailyLogPath(date: Date, layout: VaultLayout): string {
	const prefix = dailyLogPrefix(layout);
	if (prefix === null) {
		throw new Error(
			"The daily-log folder is not set. Answer it on the Effortless settings screen.",
		);
	}
	return dailyLogPathFrom(date, prefix, compileDailyLogPattern(namePattern(layout), dailyLogNames(layout)));
}

/**
 * {@link dailyLogPath}, given the prefix and compiled pattern already in hand.
 * A caller writing many dates under one layout — {@link everySweptDayReadsBack}
 * chief among them — builds both once and calls this directly, rather than
 * paying to rebuild them on every date.
 */
function dailyLogPathFrom(date: Date, prefix: string, pattern: DailyLogPattern): string {
	return normalizePath(`${prefix}${pattern.write(date)}`);
}

/**
 * Whether `path` names a day's log under the configured layout.
 *
 * Total, like {@link parseDailyLogDate} it is built on: no layout and no path
 * makes it throw. A question with a yes/no answer answers no.
 */
export function isDailyLogPath(path: string, layout: VaultLayout): boolean {
	return parseDailyLogDate(path, layout) !== null;
}

/**
 * The day `path` is the log for, or `null` when it is not a day's log at all.
 *
 * The exact inverse of {@link dailyLogPath}: a path is accepted only when
 * writing the date it was read from gives that same path back. That is what
 * refuses `2026-9-06` under a `YYYY-MM-DD` pattern, and a note whose name
 * merely starts like a date.
 *
 * Answers rather than throws for every layout, including one whose filename
 * pattern the plugin cannot read at all. {@link dailyLogPath} still throws for
 * that same pattern, and the asymmetry is deliberate: writing to a guessed path
 * would create a second file beside the day the person is actually in, and
 * reading one costs nothing.
 */
export function parseDailyLogDate(path: string, layout: VaultLayout): Date | null {
	const prefix = dailyLogPrefix(layout);
	if (prefix === null) return null;
	// Both halves of the layout ship blank and the folder is answered first, so
	// a folder with no pattern beside it is what a half-answered install looks
	// like. A question with a yes/no answer answers no, where `dailyLogPath`
	// throws: writing to a guessed path is worse than a message, reading one is
	// not.
	if (!layout.dailyLogFilename.trim()) return null;

	// The settings screen saves on every keystroke and the folder row sits above
	// the filename row, so a folder answered beside a pattern half-typed — `YYY`
	// on the way to `YYYY-MM-DD`, or a `[` whose `]` has not been reached — is an
	// ordinary second of use rather than a hand-edited settings file.
	const raw = namePattern(layout);
	if (!understandsPattern(raw)) return null;

	return parseDailyLogDateFrom(path, prefix, compileDailyLogPattern(raw, dailyLogNames(layout)));
}

/**
 * {@link parseDailyLogDate}, given the prefix and compiled pattern already in
 * hand, for the same reason {@link dailyLogPathFrom} exists beside
 * {@link dailyLogPath}.
 *
 * The round trip is checked against **either** language `pattern` knows: a
 * name that came from the current language must still write back to itself
 * under it, exactly as before issue #645, and a name that came from the
 * previous one — or from the other form of a month that has two, in either
 * language — {@link DailyLogPattern.writtenElsewhere} — must write back to
 * itself in that form instead, since {@link dailyLogPathFrom} would otherwise
 * always compare against the current language's own rendering and refuse every
 * old log the read just recognised.
 */
function parseDailyLogDateFrom(path: string, prefix: string, pattern: DailyLogPattern): Date | null {
	const full = normalizePath(path);
	if (full.indexOf(prefix) !== 0) return null;

	const name = full.slice(prefix.length);
	if (!/\.md$/i.test(name)) return null;

	const date = pattern.read(name.slice(0, -3));
	if (date === null) return null;
	if (dailyLogPathFrom(date, prefix, pattern) === full) return date;

	return pattern.writtenElsewhere(date).some((written) => normalizePath(`${prefix}${written}`) === full)
		? date
		: null;
}

/**
 * {@link dailyLogPath} and {@link parseDailyLogDate}, with the prefix and
 * compiled pattern built once rather than once per call. What
 * {@link everySweptDayReadsBack} calls internally for its own sweep, exported
 * so that `vaultLayout.test.ts`'s property tests can drive the real path
 * contract over the same 1,461 days without paying to retokenise the pattern
 * on every one of them either. The test still writes and reads each day
 * itself and checks the round trip on its own — this hands it a faster way to
 * call the same two functions, not a verdict to trust.
 *
 * Throws exactly where {@link dailyLogPath} throws: when the folder is
 * unanswered, or the pattern uses a token this plugin does not understand —
 * building the compiled pattern once still has to tokenise it once.
 */
export function dailyLogPattern(layout: VaultLayout): {
	readonly write: (date: Date) => string;
	readonly read: (path: string) => Date | null;
} {
	const prefix = dailyLogPrefix(layout);
	if (prefix === null) {
		throw new Error(
			"The daily-log folder is not set. Answer it on the Effortless settings screen.",
		);
	}
	const pattern = compileDailyLogPattern(namePattern(layout), dailyLogNames(layout));
	return {
		write: (date) => dailyLogPathFrom(date, prefix, pattern),
		read: (path) => parseDailyLogDateFrom(path, prefix, pattern),
	};
}

/**
 * Everything a day's-log path begins with under `layout`: the folder tidied up
 * and the slash after it, or `""` when the day's logs sit in the vault root.
 * `null` means the folder box has not been answered yet.
 *
 * Both halves of the path contract read the folder through here, so the builder
 * and the recogniser cannot come to different conclusions about what a given
 * folder setting names. They did before: `normalizePath` answers
 * `/` for a path that reduces to nothing, so a folder typed as `/` gave the
 * recogniser a prefix of `//`, which no vault path ever starts with — the
 * plugin wrote days at the root and then refused to recognise any of them.
 *
 * A folder of `/` therefore means the vault root. That is what a person writing
 * it means: `/` is how the top of a tree is written, and the folder box asks
 * where the day's logs go, so an answer naming the top is an answer.
 *
 * The collections index resolves the same `/` the other way, and deliberately:
 * `isExcluded` (`src/core/collections.ts`) returns `false` for it, so a `/` in
 * the excluded-folders list excludes nothing. The two settings are asked
 * different questions. This one asks where to put something, and the root is a
 * real place to put it. That one asks what to leave out, and taking `/` at its
 * word there would quietly hide every note in the vault — worse than a line the
 * person can see doing nothing.
 *
 * The settings screen's closed row does not join this to the filename half
 * itself; it reads {@link dailyLogPathPattern}, whose comment is where the
 * argument for that is written out. So nothing outside this
 * module imports this function today. It stays exported: it is the folder half
 * of the path contract, and it is what a caller with a folder question to ask
 * should reach for.
 */
export function dailyLogPrefix(layout: VaultLayout): string | null {
	const raw = layout.dailyLogFolder.trim();
	if (!raw) return null;
	const folder = normalizePath(raw);
	return folder === "/" ? "" : `${folder}/`;
}

/**
 * The day's-log path with the date fields left as they were typed, and `null`
 * while either half of the layout is unanswered.
 *
 * What {@link dailyLogPath} builds for any day, one step short of filling the
 * date in. The settings screen's closed row says this rather than today's real
 * path, so that the row can be compared with the pattern in the box beside it
 * and does not change on its own at midnight.
 *
 * Here rather than on the settings screen, beside the writer it has to agree
 * with, and this comment is the one place that argument is written out. Every
 * time the row has built part of the path itself, the row and the writer have
 * come to different conclusions:
 *
 * - **The folder half.** Joining the two fields with a slash said
 *   `//YYYY-MM-DD` for a folder of `/` — the vault root, and the case #89
 *   exists for — while the plugin wrote the right path, so the first thing the
 *   person saw after answering the folder box told them the answer had not
 *   taken. A stored
 *   folder ending in a slash read `Journal//YYYY-MM-DD` the same way, and that
 *   one cannot be typed: the box stores `asVaultPath`, and `normalizePath`
 *   takes the trailing slash off before the answer is saved. It arrives from a
 *   `data.json` edited by hand, or written before the box normalised, which
 *   `migrateLayout` passes through untouched. Reading
 *   {@link dailyLogPrefix} settles all of those the way the writer settles
 *   them.
 * - **The filename half.** The row built it by hand and left the `.md` off, so
 *   a pattern typed as `YYYY-MM-DD` and one typed as `YYYY-MM-DD.md` — one
 *   file, because {@link namePattern} strips the suffix and {@link formatName}
 *   puts it back — read as two different rows, and the first of them, the
 *   shipped placeholder, named a file that never exists. That is the
 *   disagreement #139 exists to remove, surviving in the half it did not reach.
 * - **The normalising step.** The prefix half was tidied by
 *   {@link dailyLogPrefix} and the filename half by nobody: the Filename box
 *   stores a trimmed string and nothing else, so a pattern typed `/YYYY-MM-DD`
 *   read `Journal//YYYY-MM-DD.md` — the doubled slash of #139 all over again —
 *   while the writer wrote `Journal/2026-01-02.md`, and `YYYY\MM\DD` read with
 *   the backslashes the writer turns into folders. The whole
 *   joined string now goes through `normalizePath`, the way
 *   {@link dailyLogPath} sends its own. `.md` is always on the end, so the
 *   string is never empty and `normalizePath` can never answer the bare `/`
 *   that {@link dailyLogPrefix} exists to keep out of the front of a path.
 *
 * Answers rather than throws, like {@link parseDailyLogDate} and unlike
 * {@link dailyLogPath}: a summary of an unanswered layout is a sentence, not a
 * failure. The pattern is echoed whether this module can read it or not — the
 * Filename row's own line is what says a pattern is unreadable.
 */
export function dailyLogPathPattern(layout: VaultLayout): string | null {
	const prefix = dailyLogPrefix(layout);
	if (prefix === null) return null;
	if (!layout.dailyLogFilename.trim()) return null;
	return normalizePath(`${prefix}${namePattern(layout)}.md`);
}

/** The pattern for the filename without its extension; `.md` is added back. */
function namePattern(layout: VaultLayout): string {
	const raw = layout.dailyLogFilename.trim();
	if (!raw) {
		throw new Error(
			"The daily-log filename pattern is not set. Answer it on the Effortless settings screen.",
		);
	}
	return raw.replace(/\.md$/i, "");
}

/**
 * The years {@link unreadableFilenamePattern} sweeps every day of, in place of
 * the nine-day probe set this replaced.
 *
 * **Complete over this span.** Every month-and-day pair the Gregorian calendar
 * has falls inside these four years four times — the leap day once — and a
 * pattern that loses a day only for some combination of month, day or weekday
 * cannot escape a sweep that asks about all of them — unlike the nine-day
 * probe set this replaced, which asked about none of the days that pair a
 * one-digit month with a day of 30 or 31, and so missed `YYYY-M3D`,
 * `YYYYM3D` and `M3D-YYYY`. These are also the four years
 * `vaultLayout.test.ts` sweeps for its own property test, in a loop of its
 * own — two separate loops, not one computation, both built on the same
 * once-compiled pattern {@link dailyLogPattern} hands out.
 *
 * **Not complete over every year.** A two-digit year field only ever reads
 * back as one of `24`–`27` here, so a pattern whose *only* fault is a
 * different two-digit year turning over — a century boundary, say — is not
 * reached. Nothing this plugin ships or tests names a pattern that fails only
 * that way, and a filename pattern has no way to name a *specific* year in the
 * first place, so this is a span of the calendar rather than a span of years a
 * person could type around.
 */
const SWEPT_YEARS = { first: 2024, last: 2027 } as const;

/**
 * The stored filename pattern when this module cannot read a date out of it,
 * and `null` when it can.
 *
 * The yes/no question {@link parseDailyLogDate} answers silently, asked out
 * loud. That silence is the whole of issue
 * #194: a pattern that
 * makes every note unrecognisable as a day's log, for ever, and nothing said
 * so.
 *
 * **It asks the round trip and not the tokeniser.** A day's log is written
 * under the layout for every day of {@link SWEPT_YEARS} and read straight
 * back, so this function is the recogniser rather than a second opinion about
 * it. **For every layout whose folder is answered and whose filename pattern
 * is not blank**, it answers `null` only when each of those days is written
 * and read back as itself — a day read back as a *different* day counts
 * against the pattern too, because two days sharing one filename lose one of
 * them. Neither exclusion is a loophole: each is a boundary named in a
 * paragraph below, and each is real. A layout with no folder is probed at the
 * vault root instead, so this function answers about a layout it was not
 * handed, and {@link dailyLogPath} throws for the one it was. A layout with a
 * blank pattern answers `null` here while {@link dailyLogPath} throws for it as
 * well, so nothing is written and nothing is recognised, and there is no
 * recognition for that `null` to agree with. Asking
 * {@link understandsPattern} alone was that second opinion, and it was wrong
 * for every pattern the tokeniser accepts and the reader still loses: a
 * filename of `MM-DD` has no year field, so `readName` answers `null` for the
 * file the plugin has just written, and a filename of `.md` alone reaches the
 * same hole from the other side — {@link namePattern} strips the suffix, and
 * the empty pattern left behind tokenises perfectly.
 *
 * **How far that `null` reaches, said exactly.** See {@link SWEPT_YEARS} for
 * what the sweep covers and what it does not. What is claimed here is measured
 * rather than argued: `vaultLayout.test.ts` builds 1,288 generated patterns and
 * a further set that puts a literal digit between two date fields — the shape
 * #562 was filed over —
 * and checks every one of them against the same sweep this function runs, so
 * the two cannot disagree by construction.
 *
 * This used to be a nine-day probe set rather than a sweep, and three earlier
 * statements of what it covered were false, which is why the claim above is
 * written this carefully. #256 claimed it without a scope; #352 was filed
 * because that misled a later session; #398 narrowed it to answered folders
 * and non-blank patterns and it was still false, because the probe asked about
 * one day and the answer was read as the pattern's; #515's own
 * nine-day set was then found to miss every day pairing a one-digit month with
 * a day of 30 or 31, so `YYYY-M3D` and its siblings drew no complaint at all. A sweep of every day in the span cannot have a day it forgot to ask
 * about the way a hand-picked set can.
 *
 * The tokeniser is still asked first, and only because {@link dailyLogPath}
 * throws for a pattern it refuses where the reader answers. That is the
 * half-typed `YYY` case, and it is unreadable either way.
 *
 * **The folder is a different question, asked in a different box.** A layout
 * whose folder is unanswered is probed at the vault root, so answering the
 * filename first does not put a complaint about the filename on the screen for
 * want of a folder.
 *
 * That substitution is where the round-trip property stops. Nothing at all can
 * be written under a layout with no folder — {@link dailyLogPath} throws — so
 * there is no day's log to recognise and no equivalence to hold. What this
 * function answers for such a layout is the answer for the same filename at the
 * vault root, which is the useful answer and the one the screen wants.
 *
 * **A blank pattern answers `null`.** Both halves of the layout ship blank, so
 * unanswered is the ordinary state of a fresh install rather than something
 * wrong with it.
 *
 * **The cost of one answer, measured where it runs — inside the server's test
 * Obsidian, not plain `node`**.
 * `settingsTab.ts` calls this function once from a real keystroke in any
 * core-card box, not only Filename — every box's change handler runs
 * `saveLayout`, which reaches the call through `refreshCoreCard` and
 * `refreshUnreadablePattern` — and once more whenever the whole tab redraws
 * itself: two call sites, never sharing an answer.
 * For `YYYY-MM-DD`, the worst case for cost since it never loses a day and so
 * never exits the sweep early: one call measured 9.1-9.7 ms across thirteen
 * keystrokes, and the two calls together, isolated from the rest of the tab's
 * redraw, measured 9.1-9.9 ms across six runs — consecutive calls to the same
 * hot function cost little more together than one costs alone. Either way,
 * under the 16 ms one screen frame allows. A pattern that loses a day stops
 * at its first one and costs a fraction of that: `YYYY-M3D` measured
 * 0.1-0.3 ms. The full transcript is
 * `docs/acceptance-shots/issue-562-filename-sweep.txt`.
 */
export function unreadableFilenamePattern(layout: VaultLayout): string | null {
	const raw = layout.dailyLogFilename.trim();
	if (!raw) return null;
	if (!understandsPattern(namePattern(layout))) return raw;
	const probed: VaultLayout = { ...layout, dailyLogFolder: layout.dailyLogFolder.trim() || "/" };
	return everySweptDayReadsBack(probed) ? null : raw;
}

/**
 * Whether every day of {@link SWEPT_YEARS} round-trips under `layout`.
 *
 * Stops at the first day that does not, so a pattern that loses a day early in
 * the span costs one round trip rather than 1,461 of them. Most do: of the
 * 1,204 of 1,288 generated patterns that lose a day at all, 1,086 lose their
 * first one inside the sweep's first month and all 1,204 inside its first
 * year (measured against `vaultLayout.test.ts`'s own generated set) — a fault
 * in how two fields are told apart repeats every month, so it rarely takes
 * long to show up.
 */
function everySweptDayReadsBack(layout: VaultLayout): boolean {
	// `layout` here always has a folder — `unreadableFilenamePattern` stands the
	// vault root in when the box is blank — so `dailyLogPrefix` cannot answer
	// null, and `unreadableFilenamePattern` has already confirmed the pattern
	// tokenises, so `compilePattern` cannot throw either.
	const prefix = dailyLogPrefix(layout) as string;
	const pattern = compileDailyLogPattern(namePattern(layout), dailyLogNames(layout));

	for (let year = SWEPT_YEARS.first; year <= SWEPT_YEARS.last; year += 1) {
		for (let month = 0; month < 12; month += 1) {
			const daysInMonth = new Date(year, month + 1, 0).getDate();
			for (let date = 1; date <= daysInMonth; date += 1) {
				if (!readsBackAsItself(new Date(year, month, date), prefix, pattern)) return false;
			}
		}
	}
	return true;
}

/**
 * Whether the day's log for `day` under `prefix` and `pattern` is read back as
 * that same day.
 *
 * Written and read through `dailyLogPathFrom` and `parseDailyLogDateFrom` — the
 * same two functions {@link dailyLogPath} and {@link parseDailyLogDate} build
 * on — so this is still the recogniser's own answer rather than a second
 * opinion about it. `prefix` and `pattern` arrive already built:
 * {@link everySweptDayReadsBack} builds each once for the whole sweep rather
 * than once per day.
 *
 * **The day itself and not merely some day.** `parseDailyLogDateFrom` already
 * refuses a name that does not write back to the path it came from, so a name
 * it accepts is one this layout would write — but a pattern that runs an
 * unpadded month into an unpadded day writes two different days to one name,
 * and then the earlier of them is read back as the later. Under `YYYYMD`, 11
 * January and 1 November are both `2024111.md`. Answering yes to that would be
 * calling a lost day a found one.
 */
function readsBackAsItself(day: Date, prefix: string, pattern: DailyLogPattern): boolean {
	const written = dailyLogPathFrom(day, prefix, pattern);
	const read = parseDailyLogDateFrom(written, prefix, pattern);
	return read !== null && read.getTime() === day.getTime();
}

/**
 * What a new day's log is created with: every day's-log heading, at its own
 * level, in the order the sections are written in. A heading whose text has
 * been emptied is left out, since nothing could ever find it again — and so
 * is the calendar table beneath it, since a table nobody can find under a
 * heading nobody can find is worse than none.
 *
 * The calendar heading carries a fenced `schema` block: the header row and the
 * separator row built from `layout.calendarColumns`, and no data row. This is
 * what replaces the old plugin's dependency on Templater and the author's own
 * template — the shape is generic, built from the columns already on the core
 * card, so a stranger's vault needs no template of its own. A header and a
 * separator with no rows is already a table {@link parseCalendarTable} reads,
 * so there is no placeholder row to write and nothing to detect or replace
 * once the first meeting lands.
 */
export function dailyLogFrame(layout: VaultLayout): string {
	let frame = "";
	for (const section of daySections()) {
		const heading = layout[section];
		const text = heading.text.trim();
		if (!text) continue;
		frame += `${"#".repeat(clampLevel(heading.level))} ${text}\n\n`;
		if (section === "calendarHeading") frame += calendarTableBlock(layout.calendarColumns);
	}
	return frame;
}

/**
 * The fenced `schema` block a fresh day's calendar heading carries: the header
 * row named from `columns`, the separator row beneath it, and no data rows.
 * {@link parseCalendarTable} in `calendarTable.ts` reads this same shape back
 * as a table with zero rows — `vaultLayout.test.ts` holds the two to each
 * other rather than to a hand-written expectation.
 *
 * The two names are escaped with `escapeCellText`, the same function
 * `writeCell` escapes a cell's value with, before they reach the header row.
 * Unescaped, a column name carrying a pipe splits the header into more cells
 * than the separator has and `parseCalendarTable` cannot find the table.
 *
 * Exported for `dailyLogTemplate.ts`: a template whose text leaves the
 * calendar heading out entirely gets the same generic table a fresh day's
 * frame carries, built the one way this module builds it.
 */
export function calendarTableBlock(columns: { readonly time: string; readonly event: string }): string {
	const time = escapeCellText(columns.time);
	const event = escapeCellText(columns.event);
	return "```schema\n" + `| ${time} | ${event} |\n` + "| --- | --- |\n" + "```\n\n";
}

/* ------------------------------------------------------------------------ */
/* A section inside a note.                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Where `section` begins and ends inside `content`, or `null` when the note does
 * not carry that heading.
 *
 * The layout says which words and which level that section's heading is written
 * at; {@link headingRange} is what does the reading. See it for what counts as a
 * match and where a section ends.
 */
export function sectionRange(
	content: string,
	section: SectionName,
	layout: VaultLayout,
): SectionRange | null {
	const wanted = layout[section];
	return headingRange(content, wanted.text, wanted.level);
}

/**
 * The innermost day's-log section whose lines include `lineIndex`, or `null`
 * when the line sits under none of them. Innermost because two sections at
 * different levels may nest, and the one written last inside the other is the
 * heading the line is really under.
 *
 * Migration asks it to say where a line may be filed from, and Review asks it
 * to count only what sits under the notes heading, so the answer is the core's
 * and neither feature keeps its own.
 */
export function sectionOfLine(content: string, lineIndex: number, layout: VaultLayout): SectionName | null {
	let found: SectionName | null = null;
	let foundHeading = -1;
	for (const section of daySections()) {
		const range = sectionRange(content, section, layout);
		if (range === null) continue;
		if (lineIndex < range.start || lineIndex >= range.end) continue;
		if (range.heading > foundHeading) {
			found = section;
			foundHeading = range.heading;
		}
	}
	return found;
}
