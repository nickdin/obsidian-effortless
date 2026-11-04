/**
 * The two moves that write `[>]` over more than one day: rolling an
 * unfinished paired task from an old day's log into today's, and freezing
 * the line it leaves behind.
 *
 * A pure function over text, exactly like `copyIn.ts` beside it: no vault, no
 * app, no clock read from the global — `today` is handed in and every date is
 * compared as a local calendar day, never through `toISOString` (the
 * #618/#687 rule). It reuses `copyIn.ts`'s own insertion rule
 * ({@link ensureHeadingWithBody}), breadcrumb rule ({@link insertVisibleText}),
 * "is it live in the log" rule ({@link collectLogEids}, #835) and context
 * bullet ({@link contextBulletLine}, #842) rather than restating any of them —
 * this module and `copyIn.ts` share one small feature, not "nothing to do
 * with each other".
 *
 * **Freezing is one function, `freeze`, so D5 and D9 share it**
 * (spec #709 decision 11: "the same rule as D5, so there is one rule to
 * learn"). `rollOver` calls it for the day-to-day move; {@link freezeIfRescheduled}
 * is D9's own detector, for the run ticket to call once `reconcilePair`'s own
 * ordinary field edit has carried a rescheduled date to the collection — this
 * module does not decide *when* to call `reconcilePair`, since which side a
 * caller trusts as `lastSynced` is the run ticket's question to settle, not
 * this one's (`reconcile.ts`'s own doc comment).
 *
 * **What makes a task a candidate.** A paired task line in `oldLogText` whose
 * meaning is `open` or `copied` — decision 11's own "an unfinished task",
 * read as this module reads unfinished — whose collection counterpart's own
 * meaning is likewise still unfinished (#840: a collection line reading
 * `done` or `cancelled` is not "unfinished", whatever the old log's own line
 * still says), and whose collection counterpart's relevant date (scheduled,
 * or due when there is no scheduled date — `copyIn.ts`'s own rule, carried
 * rather than restated) is not missing. A pairing `oldLogText` carries with
 * no matching collection line — the collection's heading renamed, the note
 * moved out of reach — is left exactly as written: a broken pairing is
 * #29's own problem, not
 * this ticket's, and the healed-or-broken answer belongs to whichever code
 * reads the pairing next.
 *
 * **Roll and freeze on meaning alone, not on the date**: every
 * candidate's old line is frozen, whatever the collection's own date now
 * reads — decision 11 names no date clause. Only whether a *fresh copy*
 * lands under today's overdue heading depends on the date: not at all when
 * the collection's own date is in the future (the copy belongs to the day it
 * is due, which `copyIn`'s own re-copy rule picks up once the frozen line
 * leaves it live nowhere), and not again when today's log already carries
 * the eid live — one live copy per eid, whichever of `copyIn` or
 * `rollOver` ran first.
 *
 * **The collection is never edited by this function.** Roll-over changes
 * nothing about which fields the collection line carries or what its own
 * marker says; only the two logs move.
 *
 * **A rolled subtask keeps its own family shape**. A candidate whose
 * collection line is itself a subtask, and whose immediate parent is *also*
 * rolling in this same call, rolls on its own account, indented exactly as
 * its own collection line reads, directly under its still-live parent's own
 * fresh copy — the shape a still-live family already has today. A candidate
 * whose parent is *not* rolling alongside it gets the one context bullet
 * `copyIn.ts`'s own first copy would have given it, carrying the parent's own
 * words, no checkbox, no marker — never a bare indented line with nothing
 * above it, which a Markdown reader draws as an indented code block directly
 * under a heading.
 */

import { isAtxHeading } from "../../core/markdownSections";
import type { TaskLine } from "../../core/taskLine";
import { editTaskField, parseTaskLine, relevantDate } from "../../core/taskLine";
import type { VaultLayout } from "../../core/settings";
import { collectLogEids, contextBulletLine, ensureHeadingWithBody, insertVisibleText, liveCopyBase } from "./copyIn";
import type { Marker, SyncedSnapshot } from "./marker";
import { readMarker, snapshotOf, writeMarker } from "./marker";
import { reconcilePair } from "./reconcile";

/** What one call to {@link rollOver} produces. */
export interface RollOverResult {
	/** `oldLogText` again, with every rolled task's checkbox set to forwarded and every other byte identical. */
	readonly oldLog: string;
	/** `todayLogText` again, with each rolled task's fresh copy added under the overdue heading. */
	readonly todayLog: string;
	/** `collectionText` again, unchanged: roll-over moves the log's own copy, never the collection's. */
	readonly collection: string;
	/** How many tasks rolled over — every candidate frozen, whether or not a fresh copy was placed. */
	readonly rolled: number;
}

/** The two checkbox meanings decision 11 calls "still open": not finished, and not already forwarded. */
const LIVE_MEANINGS: ReadonlySet<TaskLine["meaning"]> = new Set(["open", "copied"]);

/**
 * Freezes `raw` to forwarded — the one rule
 * #709 decision 11 states
 * once for both roll-over (D5) and a date changed from the log (D9): once a
 * line reads `[>]` it is no longer the live copy, and every other byte stays
 * exactly what it was. `reconcile.ts`'s own `applyFields` is what then keeps
 * the plugin from ever rewriting it again.
 */
export function freeze(raw: string): string {
	return editTaskField(raw, "checkbox", ">");
}

/**
 * D9's own detector (#709
 * decision 11, wave 3 finding 8): runs `reconcilePair` and, when the change
 * that reached the collection came from the log side and moved the scheduled
 * or due date specifically, returns today's log line frozen — `freeze`, the
 * same one D5's own roll-over calls, so there is one rule to learn. Returns
 * `null` otherwise: the collection was the side that changed, the log
 * changed some other field, both sides already agreed, or the two clash —
 * none of those is D9's own event, and none is this function's to freeze.
 *
 * A small pure function rather than an inline comparison, so #810 does not
 * have to decide "was it the date" itself: before this existed, the only
 * test meeting #809's own criterion 3 called `freeze` by hand after
 * `reconcilePair`, with nothing in the range actually deciding to freeze.
 */
export function freezeIfRescheduled(
	collectionLine: string,
	logLine: string,
	lastSynced: SyncedSnapshot | null,
): string | null {
	const result = reconcilePair(collectionLine, logLine, lastSynced);
	if (result.collection === null) return null;

	const before = parseTaskLine(collectionLine);
	const after = parseTaskLine(result.collection);
	if (before === null || after === null) return null;
	if (before.scheduled === after.scheduled && before.due === after.due) return null;

	return freeze(logLine);
}

/** One candidate found in `oldLogText`, ready to freeze and, maybe, copy fresh. */
interface Candidate {
	readonly oldIndex: number;
	readonly collectionIndex: number;
	readonly collectionLine: TaskLine;
	readonly marker: Marker;
}

/**
 * Rolls every unfinished paired task in `oldLogText` into `todayLogText`'s
 * overdue section, freezing the line each one leaves behind. See the module
 * comment for what makes a task a candidate and what this function
 * deliberately does not do.
 */
export function rollOver(
	oldLogText: string,
	todayLogText: string,
	collectionText: string,
	today: Date,
	layout: VaultLayout,
	collectionName: string,
): RollOverResult {
	const todayKey = localDateKey(today);
	const collectionLines = splitLines(collectionText);
	const oldLines = splitLines(oldLogText);
	const todayEids = collectLogEids(todayLogText);

	const editedOldLines = [...oldLines];
	const copying: Candidate[] = [];
	let rolled = 0;

	for (let index = 0; index < oldLines.length; index += 1) {
		const parsed = parseTaskLine(oldLines[index]);
		if (parsed === null || !LIVE_MEANINGS.has(parsed.meaning)) continue;

		const marker = readMarker(parsed);
		if (marker === null) continue;

		const collectionIndex = findByEidIndex(collectionLines, marker.eid);
		if (collectionIndex === -1) continue;
		const collectionLine = parseTaskLine(collectionLines[collectionIndex]);
		if (collectionLine === null) continue;

		// #840: a collection line reading done or cancelled is finished, not
		// "unfinished". The run never reconciles
		// against an old, rolled-over log line at all — it is frozen, and
		// `reconcileAll`'s own lookup (`run.ts`) skips a forwarded line on
		// sight — so nothing ever carries a tick to it; a fresh open copy
		// stamped with the done line's own hash would only hand a later
		// `reconcilePair` a reason to reopen it.
		if (!LIVE_MEANINGS.has(collectionLine.meaning)) continue;

		const date = relevantDate(collectionLine);
		if (date === null) continue;

		// #837: roll and freeze on meaning alone — every candidate reaching
		// this point is frozen, whatever the collection's own date now reads.
		editedOldLines[index] = freeze(oldLines[index]);
		rolled += 1;

		// #837: no fresh copy for a date the collection no longer calls due —
		// copyIn's own re-copy rule picks it up the day it is due, since the
		// frozen line above leaves it live nowhere. #835: today's log may
		// already carry this eid live — copyIn's own re-copy, or an earlier
		// candidate in this same call — and a second fresh copy would leave
		// two live lines sharing one eid.
		if (date > todayKey || todayEids.has(marker.eid)) continue;

		copying.push({ oldIndex: index, collectionIndex, collectionLine, marker });
	}

	const freshLines = buildFreshLines(copying, collectionLines, collectionName);

	const todayLog = freshLines.length > 0 ? ensureHeadingWithBody(todayLogText, "overdueHeading", layout, freshLines) : todayLogText;
	const oldLog = rolled > 0 ? joinLines(editedOldLines) : oldLogText;

	return { oldLog, todayLog, collection: collectionText, rolled };
}

/**
 * The fresh lines {@link rollOver} adds under today's overdue heading, in
 * `candidates`' own order — see the module comment for the family shape: a candidate whose immediate parent is also rolling nests directly
 * under that parent's own fresh copy with no bullet; one whose parent is not
 * rolling gets one context bullet per parent, shared with any sibling doing
 * the same.
 */
function buildFreshLines(
	candidates: readonly Candidate[],
	collectionLines: readonly string[],
	collectionName: string,
): string[] {
	const rollingEids = new Set(candidates.map((candidate) => candidate.marker.eid));

	interface Segment {
		readonly order: number;
		readonly lines: string[];
	}
	const segments: Segment[] = [];
	const bulletSegmentByParent = new Map<number, Segment>();

	candidates.forEach((candidate, order) => {
		const { collectionLine, collectionIndex, marker } = candidate;
		const freshLine = buildFreshCopy(collectionLine, marker.eid, collectionName);

		if (collectionLine.indent.length === 0) {
			segments.push({ order, lines: [freshLine] });
			return;
		}

		const parent = findParent(collectionLines, collectionIndex, collectionLine.indent.length);
		const parentMarker = parent === null ? null : readMarker(parent.line);
		if (parentMarker !== null && rollingEids.has(parentMarker.eid)) {
			// The parent is rolling too, in this same call: its own fresh copy
			// carries the family, the same way a live subtask nests under its
			// still-live parent today — no bullet needed.
			segments.push({ order, lines: [freshLine] });
			return;
		}

		if (parent === null) {
			// No parent to bullet with, and no home for this indentation under
			// today's overdue heading — write it at the collection's
			// own root level rather than let a stray indent render as code.
			segments.push({ order, lines: [rootLevelCopy(freshLine, collectionLine)] });
			return;
		}

		const existing = bulletSegmentByParent.get(parent.index);
		if (existing !== undefined) {
			existing.lines.push(freshLine);
			return;
		}
		const segment: Segment = { order, lines: [contextBulletLine(parent.line), freshLine] };
		bulletSegmentByParent.set(parent.index, segment);
		segments.push(segment);
	});

	const ordered = [...segments].sort((a, b) => a.order - b.order);
	const lines: string[] = [];
	for (const segment of ordered) lines.push(...segment.lines);
	return lines;
}

/**
 * The fresh log line a roll-over places under today's overdue heading: the
 * collection's own current text — words, dates, priority and tags as they
 * read there right now, and its own indentation, never the old log's (D8:
 * indentation never travels back, so it never travels forward again either)
 * — reset to an open checkbox, given the breadcrumb `copyIn.ts`'s first copy
 * gives every log line, and marked with the pairing's existing `eid` rather
 * than a fresh one, so the pairing continues.
 *
 * **A link Migration appended back to the day's log it filed from does not
 * travel into this copy either** (#906
 * for the first copy, #929
 * for this one): `copyIn.ts`'s own `liveCopyBase` is the one place both copy
 * paths ask, so this module does not re-derive the rule and cannot miss it a
 * second time.
 */
function buildFreshCopy(collectionLine: TaskLine, eid: string, collectionName: string): string {
	const openRaw = liveCopyBase(collectionLine.raw);
	const withBreadcrumb = insertVisibleText(openRaw, `[[${collectionName}]]`);
	return writeMarker(withBreadcrumb, eid, snapshotOf(collectionLine).hash);
}

/** `freshLine`, its leading indentation (`original.indent`) stripped, for the orphan case #842 names: a subtask with no discoverable parent to bullet with. */
function rootLevelCopy(freshLine: string, original: TaskLine): string {
	return original.indent.length > 0 && freshLine.startsWith(original.indent) ? freshLine.slice(original.indent.length) : freshLine;
}

/**
 * The nearest task line above `fromIndex` in `collectionLines` whose own
 * indentation is strictly less than `indent` — `fromIndex`'s immediate
 * parent, the same "nearest shallower line above" shape `copyIn.ts`'s own
 * `buildTree` reads through a stack, asked directly here since a rolled
 * candidate is found one line at a time rather than walked as a tree. The
 * search stops at the first heading it meets, so it never wanders into an
 * unrelated section above the tasks heading.
 */
function findParent(
	collectionLines: readonly string[],
	fromIndex: number,
	indent: number,
): { readonly line: TaskLine; readonly index: number } | null {
	for (let index = fromIndex - 1; index >= 0; index -= 1) {
		if (isAtxHeading(collectionLines[index])) return null;
		const parsed = parseTaskLine(collectionLines[index]);
		if (parsed === null) continue;
		if (parsed.indent.length < indent) return { line: parsed, index };
	}
	return null;
}

/** The index in `lines` of the one task line whose marker carries `eid`, or -1 when none does. */
function findByEidIndex(lines: readonly string[], eid: string): number {
	for (let index = 0; index < lines.length; index += 1) {
		const parsed = parseTaskLine(lines[index]);
		if (parsed === null) continue;
		const marker = readMarker(parsed);
		if (marker !== null && marker.eid === eid) return index;
	}
	return -1;
}

/** `date`, read from its local year, month and day — `copyIn.ts`'s own `localDateKey`, carried rather than imported: a feature's internal modules may restate a four-line rule sooner than import across files for it alone. */
function localDateKey(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

function splitLines(text: string): string[] {
	return text === "" ? [] : text.split("\n");
}

function joinLines(lines: readonly string[]): string {
	return lines.join("\n");
}
