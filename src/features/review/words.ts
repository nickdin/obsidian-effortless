/**
 * The words Review's list shows that follow Obsidian's display language
 * (ticket #1186, spec
 * #1181 implementation
 * decision 5).
 *
 * **Swedish when Obsidian answers `sv`, English for every other answer.** The
 * language is Obsidian's own `getLanguage` (`node_modules/obsidian/obsidian.d.ts:3365`),
 * the route the core's day frame reads its date names through
 * (`src/core/vaultLayout.ts`), and it is asked at every draw, never kept. A
 * change of display language goes through Obsidian's relaunch, which reloads the
 * plugin, so the table is read afresh after it.
 *
 * This module is the seam ticket
 * #1182 took over: every
 * word Review shows while it is used goes through {@link reviewWords}, so Review
 * decides its language in one place. The settings card, its closed row and every
 * `Notice` stay English. A line that carries a reason the core wrote (not set
 * up, could not read) has its lead-in here; the core's reason after the colon
 * stays as the core wrote it.
 *
 * **Date names are not in the table.** The weekday abbreviations and the month
 * name between the arrows come from Obsidian's own `moment` under its active
 * locale ({@link weekdayNames}, {@link monthName}), the way the core's day
 * frame takes its names.
 */

import { getLanguage, moment } from "obsidian";

/** What a day's mark in the chain says, before it is put into words. */
export type MarkState = "kept" | "missed" | "none";

/** The two routines the chain keeps a mark for. */
export type Routine = "diary" | "review";

/** Every word of Review that follows the display language, for one language. */
export interface ReviewWords {
	/** The ribbon icon's title and the list's tab title. */
	title: string;
	/** The list's message when no note waits. */
	nothingWaiting: string;
	/** The name of today's row when only today's diary is empty. */
	today: string;
	/** The list button's text and the palette command's name, the same words. */
	markProcessed: string;
	/** The hover label of the back and the forward arrow of the chain. */
	earlierMonth: string;
	laterMonth: string;
	/** The run count at the head of the chain, for a routine. */
	run(routine: Routine, count: number): string;
	/** What a day's mark is read out as, for a routine. */
	markLabel(routine: Routine, mark: MarkState): string;
	/** "2 open tasks" on a row. */
	tasks(count: number): string;
	/** "2 plain bullets" on a row. */
	bullets(count: number): string;
	/** The nudge on today's row when its diary is still empty. */
	diaryEmpty: string;
	/** The status bar's text for `count` waiting notes. */
	statusText(count: number): string;
	/** The status bar's hover label. */
	statusLabel: string;
	/** The heading of the followed-tasks part, carrying how many tasks are followed. */
	followedHeading(count: number): string;
	/** The line that stands in place of the followed-tasks part when reading the notes failed. */
	followedUnreadable(reason: string): string;
	/** The line for waiting notes whose text could not be read, ending in their paths. */
	unreadable(count: number, paths: string): string;
	/** The lead-in of the list's only line while Review is not set up; the core's reason follows it. */
	notSetUp(reason: string): string;
	/** The lead-in of the list's line when reading the notes failed; the reason follows it. */
	listFailed(reason: string): string;
	/** The lead-in of the chain's line when drawing it failed; the reason follows it. */
	chainFailed(reason: string): string;
	/** Review's own reason, for a failure that came with none. */
	unknownReason: string;
}

const ENGLISH: ReviewWords = {
	title: "Review",
	nothingWaiting: "Nothing waiting",
	today: "Today",
	markProcessed: "Mark as processed",
	earlierMonth: "Earlier month",
	laterMonth: "Later month",
	run: (routine, count) => `${routine === "diary" ? "Diary" : "Review"} ${count}`,
	markLabel: (routine, mark) => {
		const name = routine === "diary" ? "Diary" : "Review";
		if (mark === "kept") return `${name} kept`;
		if (mark === "missed") return `${name} missed`;
		return `${name}: no mark`;
	},
	tasks: (count) => `${count} open ${count === 1 ? "task" : "tasks"}`,
	bullets: (count) => `${count} plain ${count === 1 ? "bullet" : "bullets"}`,
	diaryEmpty: "diary empty",
	statusText: (count) => `Review: ${count} waiting`,
	statusLabel: "Notes from the last few days that you have not gone through",
	followedHeading: (count) => `Followed tasks (${count})`,
	followedUnreadable: (reason) => `Review could not read the followed tasks: ${reason}`,
	unreadable: (count, paths) =>
		`${count} waiting ${count === 1 ? "note" : "notes"} could not be read and ${count === 1 ? "is" : "are"} not shown: ${paths}`,
	notSetUp: (reason) => `Review is not set up yet. ${reason}`,
	listFailed: (reason) => `Review could not read your notes: ${reason}`,
	chainFailed: (reason) => `Review could not draw the chain: ${reason}`,
	unknownReason: "unknown reason",
};

const SWEDISH: ReviewWords = {
	title: "Granskning",
	nothingWaiting: "Inget väntar",
	today: "Idag",
	markProcessed: "Markera som behandlad",
	earlierMonth: "Föregående månad",
	laterMonth: "Nästa månad",
	run: (routine, count) => `${routine === "diary" ? "Dagbok" : "Granskning"} ${count}`,
	markLabel: (routine, mark) => {
		if (routine === "diary") {
			if (mark === "kept") return "Dagbok förd";
			if (mark === "missed") return "Dagbok missad";
			return "Dagbok: inget märke";
		}
		if (mark === "kept") return "Granskning gjord";
		if (mark === "missed") return "Granskning missad";
		return "Granskning: inget märke";
	},
	tasks: (count) => `${count} ${count === 1 ? "öppen uppgift" : "öppna uppgifter"}`,
	bullets: (count) => `${count} ${count === 1 ? "vanlig punkt" : "vanliga punkter"}`,
	diaryEmpty: "dagboken tom",
	statusText: (count) => `Granskning: ${count} väntar`,
	statusLabel: "Anteckningar från de senaste dagarna som du inte har gått igenom",
	followedHeading: (count) => `Följda uppgifter (${count})`,
	followedUnreadable: (reason) => `Granskning kunde inte läsa de följda uppgifterna: ${reason}`,
	unreadable: (count, paths) =>
		`${count} ${count === 1 ? "väntande anteckning kunde" : "väntande anteckningar kunde"} inte läsas och visas inte: ${paths}`,
	notSetUp: (reason) => `Granskning är inte inställd än. ${reason}`,
	listFailed: (reason) => `Granskning kunde inte läsa dina anteckningar: ${reason}`,
	chainFailed: (reason) => `Granskning kunde inte rita kedjan: ${reason}`,
	unknownReason: "okänd orsak",
};

/** Review's words in the language Obsidian is displayed in now. */
export function reviewWords(): ReviewWords {
	return getLanguage() === "sv" ? SWEDISH : ENGLISH;
}

/**
 * The seven weekday abbreviations, Monday first, from Obsidian's own `moment`
 * under its active locale (`node_modules/obsidian/obsidian.d.ts:4561`). A
 * `Locale`'s `weekdaysShort()` starts at Sunday, so Sunday is moved to the end.
 */
export function weekdayNames(): string[] {
	const fromSunday = moment.localeData().weekdaysShort();
	return [...fromSunday.slice(1), fromSunday[0]];
}

/** "October 2026": the month's own name under `moment`'s active locale, and its year, for `month` counted from 1. */
export function monthName(year: number, month: number): string {
	return `${moment.localeData().months()[month - 1]} ${year}`;
}
