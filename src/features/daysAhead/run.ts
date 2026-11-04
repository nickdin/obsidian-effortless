/**
 * One run over the window: building the days ahead's whole job, joined up
 * from the pieces the earlier tickets built (spec
 * #687 decision 10,
 * mirroring `~/Devbox/calendar-scaffold/src/run.ts`'s
 * `runWindow`/`buildDay`/`fillDay` shape, adjusted for the core doing the
 * creating).
 *
 * **This module decides nothing about which rows belong.** That is
 * {@link mergeMeetings}'s job, one layer down; this module only orders the
 * calls: refresh the calendar once, then fill each day of the window, oldest
 * first, independently of the others — a day that throws is reported and
 * costs the others nothing.
 *
 * **The Obsidian half holds no decisions**, so it arrives here as three
 * narrow ports — {@link RunCalendar}, {@link RunNotes}, {@link RunProblems} —
 * rather than the real `Calendar`, `NoteWriter` and `FeatureProblems`
 * themselves. Every test in `daysAheadRun*.test.ts` exercises this module
 * against fakes of the three; `daysAhead.ts` is the only file that wires the
 * real ones in.
 */

import type { TFile } from "obsidian";
import type { CalendarPresence, CalendarUse } from "../../core/calendarSources";
import type { Meeting } from "../../core/icsReader";
import type { CalendarTableAbsence } from "../../core/calendarTable";
import { parseCalendarTable, writeCalendarRows } from "../../core/calendarTable";
import type { ColumnNames } from "../../core/calendarTable";
import { reasonOf } from "../../core/reason";
import type { VaultLayout } from "../../core/settings";
import { desiredRowsFor, localDateKey } from "./desiredRows";
import { mergeMeetings } from "./mergeMeetings";
import { removalReadingFrom } from "./removalReading";
import type { RemovalReading } from "./removalReading";
import { pruneRowMemory, startKeyFor } from "./rowMemory";
import type { RowMemory, RowMemoryEntry, RowMemoryKey, RowMemoryUpdate } from "./rowMemory";
import { windowDates } from "./window";

/** The calendar, narrowed to what one run needs. */
export interface RunCalendar {
	/**
	 * Reads every source again, resolving once the sources as they stood when
	 * this was called have been read — "the guarantee to build a day on"
	 * (`src/core/calendarSources.ts:74-89`). Awaited exactly once per run,
	 * before any day is touched.
	 */
	refresh(): Promise<void>;
	meetingsOn(day: Date, use: CalendarUse): readonly Meeting[];
	/**
	 * Whether the calendar can say a meeting is gone over the window — the
	 * core's answer, asked once per run after `refresh`. Read per
	 * source: a row goes on its own source's whole reading, so one
	 * source that failed pauses only its own rows' removals, and those of rows
	 * remembered with no source; see `removalReading.ts`.
	 */
	presenceBetween(from: Date, days: number, use: CalendarUse): CalendarPresence;
}

/**
 * The vault, narrowed to what one run needs.
 *
 * `read` is not `NoteWriter`'s own — nothing there answers a file's text
 * without also committing a write to it — so the caller supplies both from
 * the one vault behind them. It exists so this run can tell, before touching
 * the write queue at all, whether a day already reads exactly as it would be
 * written: reading is what lets that check happen without ever asking
 * {@link edit} to do it, which is the whole point of decision 10's rule 7 —
 * an unwritten day never joins {@link edit}'s queue, so it never waits behind
 * a note the person is typing in for a change that was never coming.
 */
export interface RunNotes {
	/** The day's log for `date`, created from `layout` if it is not there yet. */
	createDailyLog(date: Date, layout: VaultLayout): Promise<TFile>;
	/** `file`'s current text, without joining the write queue. */
	read(file: TFile): Promise<string>;
	/** Rewrites `file` by handing its current text to `edit` and storing what comes back. */
	edit(file: TFile, edit: (content: string) => string): Promise<string>;
}

/** How one run says a day is broken, and has it stop being said. */
export interface RunProblems {
	report(key: string, message: string): void;
	clear(key: string): void;
	/**
	 * Every key this feature currently has standing, so a run can tell a date
	 * it no longer visits apart from one still in front of it. `FeatureProblems`
	 * itself has no route back to what is standing — a feature may report and
	 * clear, never enumerate another feature's keys or even its own — so the
	 * real implementation keeps this list itself, beside the two calls that
	 * change it.
	 */
	list(): readonly string[];
}

export interface RunDeps {
	readonly calendar: RunCalendar;
	readonly notes: RunNotes;
	readonly problems: RunProblems;
	readonly layout: VaultLayout;
	/** How many days ahead to keep ready, today included. */
	readonly windowDays: number;
	/** Now, read once by the caller — never the clock inside. */
	readonly today: Date;
	/** This feature's memory of what it last wrote, before this run prunes or reads it. */
	readonly memory: RowMemory;
	/**
	 * Persists the memory once it actually changes. Never called for a day
	 * that failed, and never called when a day succeeded but remembered
	 * nothing new or different from what is already stored — and
	 * always awaited before the next day starts, so an app closed or crashed
	 * mid-run has already saved every change it got to (decision 10, rule 8:
	 * the memory never runs ahead of the file). `runWindow` may call this once
	 * more after every day is done, if pruning changed something that no
	 * day's own commit already carried.
	 */
	commitMemory(memory: RowMemory): Promise<void>;
}

/**
 * The one key this feature reports under that is not a date: a calendar
 * source switched on for the day did not read whole, so none of its rows is
 * removed until it reads again. The channel says a key once, so a
 * report on every run while the source stays dead raises one popup; the
 * standing line follows the message, and the first run on which every
 * source reads whole clears it.
 */
export const CALENDAR_READING_KEY = "calendar-reading";

/** What a caller says on the day's own row when its table cannot be located or read. */
const ABSENCE_MESSAGE: Record<CalendarTableAbsence, string> = {
	"no-schema-block": "there is no calendar table for this feature to fill",
	"no-table-in-block": "the calendar block here holds no table this feature can read",
	"column-name-blank": "one of the two configured calendar column names is blank",
	"column-names-alike": "the two configured calendar column names read as the same name",
	"column-named-twice": "this table names one of the calendar columns twice",
};

/**
 * Refreshes the calendar once, then fills every day of the window, oldest
 * first, and returns the memory as it stands once the window is done.
 *
 * A day that fails — its table cannot be found, or its write rejects — is
 * reported through `problems`, keyed by that date, and costs the other days
 * nothing (decision 10, rules 6 and 7).
 *
 * **Commits by identity, not by day.** `deps.commitMemory` is wrapped so this
 * function always knows which reference it last landed; `runDay` only calls
 * it when a day's own memory actually changed, and if the
 * window ends holding a memory that reference never reached — pruning
 * dropped something and no day's own commit happened to carry it forward —
 * this function commits it once itself, so a run in which no day fills still
 * persists the prune.
 *
 * **Clears a standing report for a date this run no longer visits**, before
 * a single day is touched: a date behind the window's start, or beyond how
 * far `windowDays` now reaches, will never be visited again to clear its own
 * report otherwise, and a standing problem stands until cleared. A date still in the window is left exactly as it stands — the loop
 * below reports or clears it the normal way once it is actually visited.
 */
export async function runWindow(deps: RunDeps): Promise<RowMemory> {
	await deps.calendar.refresh();
	const reading = removalReadingFrom(deps.calendar.presenceBetween(deps.today, deps.windowDays, "day"));

	const window = windowDates(deps.today, deps.windowDays);
	const windowKeys = new Set(window.map((date) => localDateKey(date)));
	for (const key of deps.problems.list()) {
		if (key !== CALENDAR_READING_KEY && !windowKeys.has(key)) deps.problems.clear(key);
	}
	reportCalendarReading(deps.problems, reading);

	const todayKey = localDateKey(deps.today);

	let lastCommitted = deps.memory;
	const trackedDeps: RunDeps = {
		...deps,
		commitMemory: async (nextMemory) => {
			await deps.commitMemory(nextMemory);
			lastCommitted = nextMemory;
		},
	};

	let memory = pruneRowMemory(deps.memory, todayKey);
	for (const date of window) {
		memory = await runDay(trackedDeps, date, memory, reading);
	}

	if (memory !== lastCommitted) {
		try {
			await trackedDeps.commitMemory(memory);
		} catch (error) {
			deps.problems.report(todayKey, `Effortless could not remember what it wrote across this window: ${reasonOf(error)}.`);
		}
	}

	return memory;
}

/**
 * Says, under {@link CALENDAR_READING_KEY}, which day sources did not read
 * whole this run, or clears it when none failed. A source that failed is said
 * on its own settings row as well; this is what reaches the person without
 * opening settings, since what it stops — a moved meeting's old row being
 * removed — is otherwise seen only as a row that stays.
 */
function reportCalendarReading(problems: RunProblems, reading: RemovalReading): void {
	if (reading.failing.length === 0) {
		if (problems.list().includes(CALENDAR_READING_KEY)) problems.clear(CALENDAR_READING_KEY);
		return;
	}
	const names = reading.failing.map((source) => (source.name.trim() === "" ? "(no name)" : `"${source.name.trim()}"`));
	const one = names.length === 1;
	problems.report(
		CALENDAR_READING_KEY,
		`Effortless could not read the calendar source${one ? "" : "s"} ${listed(names)}, so no row from ${one ? "it" : "them"} is removed from the days ahead until ${one ? "it reads" : "they read"} again.`,
	);
}

/** `a`, `a and b`, `a, b and c`. */
function listed(names: readonly string[]): string {
	if (names.length <= 1) return names.join("");
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** What computing one day's write needs beyond its current text. */
interface DayComputation {
	readonly onTheDay: readonly Meeting[];
	readonly makingNotes: readonly Meeting[];
	readonly columns: ColumnNames;
	/** The moment the caller read once for this run, so a row whose meeting has ended is left as written. */
	readonly now: Date;
	/** What this run's reading of the calendar vouches for, per source, so a gone meeting's row may be removed. */
	readonly reading: RemovalReading;
}

type ComputedDay =
	| {
			readonly ok: true;
			readonly lines: readonly string[];
			readonly remember: readonly RowMemoryUpdate[];
			readonly forget: readonly RowMemoryKey[];
	  }
	| { readonly ok: false; readonly absence: CalendarTableAbsence };

/**
 * What `content`'s table would become for `date`: parses it, decides which
 * rows belong (`desiredRowsFor`/`mergeMeetings`), and writes them back
 * (`writeCalendarRows`) — every step this run's own decision, none of it the
 * caller's.
 *
 * Called twice for a day that changes: once against the text this run
 * peeked at, to decide whether {@link RunNotes.edit} is worth calling at all,
 * and once more inside that call against the text `edit` actually hands
 * over. The second call is what keeps a race safe — a person's own edit
 * landing between the peek and the write is not overwritten with a stale
 * answer, because the write recomputes from what is really there.
 *
 * `dayDate` is the local-midnight `Date` `windowDates` built for this day —
 * never rebuilt from `date` with `new Date(date)`, which parses the
 * ISO date-only form as UTC midnight and lands on the wrong local day at a
 * negative UTC offset.
 */
function computeDay(content: string, date: string, dayDate: Date, memory: RowMemory, what: DayComputation): ComputedDay {
	const lines = content.split("\n");
	const table = parseCalendarTable(lines, what.columns);
	if (!table.found) return { ok: false, absence: table.absence };

	const desired = desiredRowsFor(what.onTheDay, what.makingNotes, dayDate);
	const existingRows = table.table.rows.map((row) => ({ time: row.time, meetingCell: row.event }));
	const merged = mergeMeetings(existingRows, desired, memory, date, what.now, what.reading);

	const written = writeCalendarRows(lines, what.columns, merged.rows, merged.remove);
	// The same lookup `parseCalendarTable` just ran successfully; nothing
	// between the two calls can make it answer a different reason.
	if (!written.found) return { ok: false, absence: written.absence };

	return { ok: true, lines: written.lines, remember: merged.remember, forget: merged.forget };
}

/**
 * Fills one day, and reports what actually went wrong when it cannot: a day
 * whose log could not be created never had a table to fail at, and a table
 * that landed but whose memory failed to store is not a table problem
 * either — only a read, a parse or a write rejecting is (wording finding,
 * wave 3 of the 2026-09-20 board run).
 */
async function runDay(deps: RunDeps, date: Date, memory: RowMemory, reading: RemovalReading): Promise<RowMemory> {
	const key = localDateKey(date);
	const what: DayComputation = {
		onTheDay: deps.calendar.meetingsOn(date, "day"),
		makingNotes: deps.calendar.meetingsOn(date, "notes"),
		columns: deps.layout.calendarColumns,
		now: deps.today,
		reading,
	};

	let file: TFile;
	try {
		file = await deps.notes.createDailyLog(date, deps.layout);
	} catch (error) {
		deps.problems.report(key, `Effortless could not create this day's log: ${reasonOf(error)}.`);
		return memory;
	}

	try {
		const peekedContent = await deps.notes.read(file);
		const peeked = computeDay(peekedContent, key, date, memory, what);
		if (!peeked.ok) {
			deps.problems.report(key, `Effortless could not fill the calendar table for ${key}: ${ABSENCE_MESSAGE[peeked.absence]}.`);
			return memory;
		}

		let remember = peeked.remember;
		let forget = peeked.forget;

		if (peeked.lines.join("\n") !== peekedContent) {
			// Widened by `as`, not annotated: the callback below assigns it, which
			// TypeScript cannot see, so an annotated `null` would read as `never` after it.
			let failure = null as CalendarTableAbsence | null;
			await deps.notes.edit(file, (freshContent) => {
				const computed = computeDay(freshContent, key, date, memory, what);
				if (!computed.ok) {
					failure = computed.absence;
					return freshContent;
				}
				remember = computed.remember;
				forget = computed.forget;
				return computed.lines.join("\n");
			});
			if (failure !== null) {
				deps.problems.report(key, `Effortless could not fill the calendar table for ${key}: ${ABSENCE_MESSAGE[failure]}.`);
				return memory;
			}
		}

		deps.problems.clear(key);
		const nextMemory = withRemembered(withForgotten(memory, key, forget), key, remember);
		if (nextMemory === memory) return memory;

		try {
			await deps.commitMemory(nextMemory);
		} catch (error) {
			deps.problems.report(key, `Effortless filled this day's calendar table, but could not remember it: ${reasonOf(error)}.`);
			return memory;
		}
		return nextMemory;
	} catch (error) {
		deps.problems.report(key, `Effortless could not fill the calendar table for ${key}: ${reasonOf(error)}.`);
		return memory;
	}
}

/**
 * `memory` with, for each uid `updates` names, `date`'s start-keyed entries
 * replaced by exactly what `updates` says for that uid — a start key stored
 * under `date` that no update names is dropped, not kept, so a meeting the
 * calendar reschedules loses its old start key rather than leaving it behind
 * to be found by a later occurrence of the same uid. Two updates
 * for the same uid on `date` at different start minutes still
 * land as two independent entries, neither dropping the other. A uid
 * `updates` never names, and every other date for every uid, is left exactly
 * as it was.
 *
 * **Returns `memory` itself, unchanged, when every uid `updates` names
 * already holds, under `date`, exactly the start keys and entries `updates`
 * says.** An unwritten day still calls this with the full set of meetings the
 * merge decided belong there (decision 10, rule 8's "a day that needed no
 * write records what the merge said"), so identity here is the one place
 * that tells an unchanged calendar apart from a changed one — the caller
 * commits by identity, never unconditionally.
 */
function withRemembered(memory: RowMemory, date: string, updates: readonly RowMemoryUpdate[]): RowMemory {
	if (updates.length === 0) return memory;

	const byUid = new Map<string, RowMemoryUpdate[]>();
	for (const update of updates) {
		const forUid = byUid.get(update.uid);
		if (forUid) forUid.push(update);
		else byUid.set(update.uid, [update]);
	}

	let changed = false;
	const next: Record<string, Record<string, Record<string, RowMemoryEntry>>> = {};
	for (const [uid, byDate] of Object.entries(memory)) next[uid] = { ...byDate };

	for (const [uid, uidUpdates] of byUid) {
		const starts: Record<string, RowMemoryEntry> = {};
		for (const update of uidUpdates) {
			starts[startKeyFor(update.startMin)] = {
				time: update.time,
				event: update.meetingCell,
				title: update.title,
				...(update.wrote === undefined ? {} : { wrote: update.wrote }),
				...(update.source === undefined ? {} : { source: update.source }),
			};
		}
		if (!sameStarts(memory[uid]?.[date], starts)) changed = true;
		next[uid] = { ...next[uid], [date]: starts };
	}
	return changed ? next : memory;
}

/**
 * `memory` without the entries `forget` names under `date` — a removed row's — and without a date or a uid left holding nothing. **Returns
 * `memory` itself when `forget` names nothing stored**, so a day that removed
 * nothing commits by identity exactly as before.
 */
function withForgotten(memory: RowMemory, date: string, forget: readonly RowMemoryKey[]): RowMemory {
	const stored = forget.filter((key) => memory[key.uid]?.[date]?.[startKeyFor(key.startMin)] !== undefined);
	if (stored.length === 0) return memory;

	const next: Record<string, Record<string, Readonly<Record<string, RowMemoryEntry>>>> = {};
	for (const [uid, byDate] of Object.entries(memory)) next[uid] = { ...byDate };
	for (const key of stored) {
		const starts = { ...next[key.uid][date] };
		delete starts[startKeyFor(key.startMin)];
		if (Object.keys(starts).length > 0) next[key.uid][date] = starts;
		else delete next[key.uid][date];
		if (Object.keys(next[key.uid]).length === 0) delete next[key.uid];
	}
	return next;
}

/** Do `date`'s previously stored start keys already hold exactly what `next` says? */
function sameStarts(stored: Readonly<Record<string, RowMemoryEntry>> | undefined, next: Readonly<Record<string, RowMemoryEntry>>): boolean {
	if (stored === undefined) return false;
	const storedKeys = Object.keys(stored);
	const nextKeys = Object.keys(next);
	if (storedKeys.length !== nextKeys.length) return false;
	return nextKeys.every((key) => {
		const entry = stored[key];
		const wanted = next[key];
		return entry !== undefined && entry.time === wanted.time && entry.event === wanted.event && entry.title === wanted.title && entry.wrote === wanted.wrote && entry.source === wanted.source;
	});
}
