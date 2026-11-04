/**
 * This feature's own memory of what it last wrote into a day's calendar
 * table: enough to find a row again after its calendar's title changes.
 *
 * Keyed by the meeting's `uid`, then by the date, then by the meeting's own
 * clamped start minute (`DesiredRow.startMin`, via {@link startKeyFor}).
 * `uid` and date alone are not enough: a multi-day all-day meeting holds a
 * row on more than one day at once, which is what the date level is for
 * (carried from `~/Devbox/calendar-scaffold/src/ledger.ts:15-18`'s own
 * reasoning for keying its `rows` by uid and date) — and a repeating
 * meeting's `uid` is shared by every meeting of that repeat
 * (`icsReader.ts:33`), so a repeat firing twice on one day needs the start
 * minute as a third part before the date alone can tell them apart. Built and compared the same way on the write path
 * (`mergeMeetings`) and the read path (`mergeMeetings`'s `findRow`, and
 * `run.ts`'s `withRemembered`).
 *
 * **A stored entry is validated on read.** `rows` lives in `data.json`, which
 * a person can hand-edit, so every reader of it is an input boundary
 * (`CLAUDE.md`; issue #606, issue #607): an entry of the wrong shape is
 * skipped rather than trusted or thrown on. An entry written under the
 * two-part `uid → date → entry` shape this memory held before #715 added the
 * start-minute level is exactly such a wrong-shape entry here: its "entry"
 * is a plain object of three strings rather than a record of start keys, so
 * nothing inside it is a valid start key, and the whole date is dropped
 * rather than migrated. Losing an entry is the safe failure the same way
 * losing the whole memory is — the row is matched by title instead on the
 * next run, and a duplicate row is the worst case, never a lost one.
 */

import { meetingNoteBasename, UNTITLED_MEETING_TITLE } from "../../core/meetingName";

/** What this feature last wrote for one meeting, on one day, at one start minute. */
export interface RowMemoryEntry {
	/** The `Tid` cell exactly as written. */
	readonly time: string;
	/**
	 * The event cell as the row held it after the last run — what a row is
	 * found by. It is the text this feature wrote, or the person's own text
	 * where the cell was left alone (a link the person made), so it does not
	 * say who wrote it; {@link wrote} does.
	 */
	readonly event: string;
	/** The meeting's title as it stood when this feature last wrote for it. */
	readonly title: string;
	/**
	 * Who wrote the event cell, kept apart from {@link event} so a cell the
	 * person made is never mistaken for the plugin's: the text this
	 * feature itself wrote, or `null` where it kept the cell as the person's.
	 * Absent only in an entry stored before this record existed —
	 * {@link isPluginsOwnCell} then judges the cell by the shape this feature
	 * writes. A kept cell must record `null` rather than leave it out, or the
	 * next run would take the entry for an older build's and judge a person's
	 * link of the plugin's own shape to be the plugin's. What a feature asking
	 * "did the plugin write this row?" reads, and nothing else.
	 */
	readonly wrote?: string | null;
	/**
	 * The id of the calendar source the row's meeting came from
	 * (`CalendarSource.id`): only that source's own whole reading may remove
	 * the row, so a source that will not read does not stop another source's
	 * moves being tidied. Absent in an entry stored before
	 * that, and wherever no single source could be named — a meeting two
	 * sources both hold. A source whose last read failed is still named from
	 * the copy it holds, so a dead link does not strip its rows of their
	 * source. An entry without one is removed only on a run where every
	 * source read whole.
	 */
	readonly source?: string;
}

/** `uid` → date (`YYYY-MM-DD`) → start minute (as a key, see {@link startKeyFor}) → what was written that day. */
export type RowMemory = Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, RowMemoryEntry>>>>>>;

/** What a successful write should record — `mergeMeetings`'s report to its caller. */
export interface RowMemoryUpdate {
	readonly uid: string;
	/** The meeting's clamped start minute — the third key part, see {@link startKeyFor}. */
	readonly startMin: number;
	readonly time: string;
	readonly meetingCell: string;
	readonly title: string;
	/** The cell text this run itself wrote, `null` for a cell kept as the person's, left out where there is nothing to record; see {@link RowMemoryEntry.wrote}. */
	readonly wrote?: string | null;
	/** The source the meeting came from, left out where none could be named; see {@link RowMemoryEntry.source}. */
	readonly source?: string;
}

/** Where one entry sits under a uid and a date: what a removed row's memory is dropped by. */
export interface RowMemoryKey {
	readonly uid: string;
	/** The entry's start minute — the third key part, see {@link startKeyFor}. */
	readonly startMin: number;
}

/**
 * The third key part: a meeting's clamped start minute (`DesiredRow.startMin`)
 * as a memory key. `desiredRowsFor` computes the same start minute for one
 * meeting on one day every run, so this is stable across runs for as long
 * as the calendar keeps that meeting at that start, and differs between two
 * meetings of one uid that start at different times on the same day. A meeting the calendar *moves* gets a different key on the next
 * run, so a lookup at this key alone misses; when it does, `findRow`
 * (`mergeMeetings.ts`) copes by also trying every other entry remembered for
 * that uid and date that is not itself another meeting's own current key
 * this run, matched by its own recorded text rather than by this key, so the
 * meeting is still found through memory rather than falling straight to the
 * title match.
 */
export function startKeyFor(startMin: number): string {
	return String(startMin);
}

/**
 * Reads `rows` out of whatever `data.json` held.
 *
 * Anything that is not the expected shape is dropped rather than repaired:
 * a non-object at any level, an entry missing one of its three string
 * fields, a date key that is not `YYYY-MM-DD`, or a start key that is not a
 * canonical `0`–`1439` integer string, is skipped and the rest of the memory
 * is kept. A `source` that is not text is the one exception: it is dropped
 * and its entry kept as source-less. The date key matters as much as the entry: `pruneRowMemory`
 * compares it against `today` as a plain string, so a key of the wrong shape
 * either never prunes (`"garbage"` compares `>= today` for ever) or prunes
 * at the wrong moment (`"2026-9-5"` sorts before a zero-padded `"2026-09-05"`).
 */
export function readRowMemory(raw: unknown): RowMemory {
	if (!isRecord(raw)) return {};

	const memory: Record<string, Record<string, Record<string, RowMemoryEntry>>> = {};
	for (const [uid, byDate] of Object.entries(raw)) {
		if (!isRecord(byDate)) continue;

		const dates: Record<string, Record<string, RowMemoryEntry>> = {};
		for (const [date, byStart] of Object.entries(byDate)) {
			if (!isDateKey(date)) continue;
			if (!isRecord(byStart)) continue;

			const starts: Record<string, RowMemoryEntry> = {};
			for (const [start, entry] of Object.entries(byStart)) {
				if (!isStartKey(start)) continue;
				const parsed = readEntry(entry);
				if (parsed !== null) starts[start] = parsed;
			}
			if (Object.keys(starts).length > 0) dates[date] = starts;
		}
		if (Object.keys(dates).length > 0) memory[uid] = dates;
	}
	return memory;
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Is this a `YYYY-MM-DD` key, the shape `pruneRowMemory`'s string comparison needs? */
function isDateKey(date: string): boolean {
	return DATE_KEY.test(date);
}

const START_KEY = /^\d{1,4}$/;

/** Is this a canonical `0`–`1439` integer string, the shape {@link startKeyFor} always builds? */
function isStartKey(key: string): boolean {
	if (!START_KEY.test(key)) return false;
	const minutes = Number(key);
	return String(minutes) === key && minutes >= 0 && minutes <= 1439;
}

function readEntry(raw: unknown): RowMemoryEntry | null {
	if (!isRecord(raw)) return null;
	const { time, event, title, wrote, source } = raw;
	if (typeof time !== "string" || typeof event !== "string" || typeof title !== "string") {
		return null;
	}
	// The record is optional, but one that is present and neither text nor
	// `null` is a wrong shape like any other: the entry is skipped, never
	// trusted.
	if (wrote !== undefined && typeof wrote !== "string" && wrote !== null) return null;
	// A source that is not text is dropped and the entry kept: without one the
	// entry falls under the every-source rule, which is the stricter of the
	// two, so nothing is removed on a source the file did not really name.
	return {
		time,
		event,
		title,
		...(wrote === undefined ? {} : { wrote }),
		...(typeof source === "string" ? { source } : {}),
	};
}

/**
 * The provenance record the entries naming `cell` hold: `cell` itself when one
 * records that this feature wrote exactly that text, `null` when one records
 * anything else — the cell kept as the person's, or a different text written
 * — and `undefined` when no entry naming the cell carries a record at all.
 * `entries` are the ones remembered for one meeting's uid on one day.
 */
export function recordFor(cell: string, entries: Iterable<RowMemoryEntry>): string | null | undefined {
	let record: null | undefined;
	for (const entry of entries) {
		if (entry.event !== cell || entry.wrote === undefined) continue;
		if (entry.wrote === cell) return cell;
		record = null;
	}
	return record;
}

/**
 * Did this feature itself write `cell` — as opposed to the person making it?
 * `entries` are the ones remembered for one meeting's uid on `date`.
 *
 *  1. Where an entry naming the cell carries a record ({@link recordFor}),
 *     the record decides it: the cell is the plugin's own exactly when the
 *     record says this feature wrote that text.
 *  2. Where entries name the cell and none carries a record, they were
 *     stored before the record existed: the cell is the plugin's own only
 *     when it is exactly the shape this feature writes — the link to the
 *     meeting note's own name for `date` with the placeholder title or an
 *     entry's title, a location in parentheses allowed. The link is built
 *     through the core's name function, never matched by a pattern of its
 *     own; only the location's parentheses are checked here.
 *  3. A cell no entry names is judged the same way against the placeholder
 *     title alone: it is a row an older build wrote that memory lost, the
 *     row `findPlaceholderRow` hands to this meeting.
 *
 * Anything else is the person's. A plain-text cell is not a link and is the
 * caller's to rewrite either way.
 */
export function isPluginsOwnCell(cell: string, date: string, entries: Iterable<RowMemoryEntry>): boolean {
	const list = [...entries];
	const record = recordFor(cell, list);
	if (record !== undefined) return record === cell;

	const titles = [UNTITLED_MEETING_TITLE, ...list.filter((entry) => entry.event === cell).map((entry) => entry.title)];
	return titles.some((title) => isWrittenShape(cell, `[[${meetingNoteBasename(date, title)}]]`));
}

/** `link`, or `link` followed by a ` (location)` — the two shapes `meetingCellFor` writes for a note's link. */
function isWrittenShape(cell: string, link: string): boolean {
	if (cell === link) return true;
	return cell.startsWith(`${link} (`) && cell.endsWith(")");
}

/**
 * Drops every date recorded before `today`, keeping `today` itself.
 *
 * Carried from `~/Devbox/calendar-scaffold/src/ledger.ts:261-282`'s
 * `pruneLedger`, minus its `notes` half — this feature has none. A row for a
 * past day is dead weight: a day before today is never created or touched
 * again, so nothing will ever look the entry up.
 *
 * **Compares dates only, and carries whatever a kept date holds beneath it
 * unopened.** The start-minute level #715 added sits inside a date, not
 * beside it, so this function's own date-level pruning needed no change to
 * add it.
 *
 * **Returns `memory` itself, unchanged, when nothing was actually dropped.**
 * The caller commits by identity — a run whose memory
 * holds nothing before `today` must not look, to that caller, as though
 * pruning changed anything.
 */
export function pruneRowMemory(memory: RowMemory, today: string): RowMemory {
	let changed = false;
	const pruned: Record<string, Record<string, Readonly<Record<string, RowMemoryEntry>>>> = {};
	for (const [uid, byDate] of Object.entries(memory)) {
		const dates: Record<string, Readonly<Record<string, RowMemoryEntry>>> = {};
		for (const [date, byStart] of Object.entries(byDate)) {
			if (date >= today) dates[date] = byStart;
			else changed = true;
		}
		if (Object.keys(dates).length > 0) pruned[uid] = dates;
	}
	return changed ? pruned : memory;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
