import type { TimedMeeting } from "./types";

/**
 * Turns a day's timed meetings into a pixel grid: the span the grid covers,
 * and each meeting as a block positioned and sized inside it.
 *
 * Carried from `~/Devbox/schema-render/src/layout.ts`:
 * the algorithm is unchanged, only the names and the entry point are — the
 * old `layoutSchedule(posts, { pxPerMinute })`, which filtered an all-day post
 * out of `posts` itself, is now `layoutDay(timed, pxPerMinute)`. `readDay`
 * (built by #626) does that filtering before this module ever sees a
 * meeting, so this file has no all-day case to guard: it is arithmetic over
 * {@link TimedMeeting} alone.
 *
 * Three rules, carried as they were:
 *
 * - **The span** is at least 08:00–16:30, widened to fit every meeting handed
 *   in, then snapped out to the half hour so hour labels always land on a
 *   30-minute step.
 * - **Overlaps** are laid out by a sweep over clusters: each meeting takes
 *   the lowest free column in its cluster, and every meeting in a cluster
 *   shares that cluster's column count.
 * - **A block is at least {@link MIN_BLOCK_HEIGHT_PX} tall**, so a very short
 *   meeting stays visible instead of vanishing to a sub-pixel sliver.
 */

// Smallest block height in pixels. Kept low so a block stays honestly
// proportional to its duration at every density — a taller floor lies about
// how long a meeting ran and can push into the block below it.
export const MIN_BLOCK_HEIGHT_PX = 2;

// At least 08:00–16:30, in minutes from midnight.
const MIN_RANGE_START = 8 * 60; // 480
const MIN_RANGE_END = 16 * 60 + 30; // 990

/** The grid's vertical extent: where it starts and ends, and how tall it is. */
export type Span = {
	readonly startMin: number;
	readonly endMin: number;
	readonly totalHeightPx: number;
};

/** One timed meeting, positioned and sized in the grid. */
export type Block = TimedMeeting & {
	readonly columnIndex: number;
	readonly totalColumns: number;
	readonly topPx: number;
	readonly heightPx: number;
};

/**
 * At least 08:00–16:30. If any meeting starts earlier or ends later, the span
 * widens outwards until every meeting fits.
 *
 * The result is then snapped to the nearest multiple of 30 minutes —
 * startMin down, endMin up — so a renderer stepping in 30-minute increments
 * always lands on a whole hour, even when the first meeting starts at an odd
 * time such as 07:50. A block's own top stays exact, because it is measured
 * from the meeting's own startMin against the snapped span; snapping only
 * adds a little empty space at the grid's edges.
 */
export function computeTimeRange(meetings: readonly TimedMeeting[]): { startMin: number; endMin: number } {
	let startMin = MIN_RANGE_START;
	let endMin = MIN_RANGE_END;

	for (const meeting of meetings) {
		if (meeting.startMin < startMin) startMin = meeting.startMin;
		if (meeting.endMin > endMin) endMin = meeting.endMin;
	}

	return {
		startMin: Math.floor(startMin / 30) * 30,
		endMin: Math.ceil(endMin / 30) * 30,
	};
}

/** Where one meeting sits among those it overlaps: its column, and how many columns its cluster spans. */
export interface ColumnPlacement {
	columnIndex: number;
	totalColumns: number;
}

/**
 * Assigns a columnIndex and a totalColumns to every meeting, so overlapping
 * meetings sit side by side.
 *
 * Algorithm: a sweep line with cluster detection.
 *
 * 1. Sort meetings by startMin; ties break on the longer meeting first, which
 *    packs better.
 * 2. A cluster is a maximal set of meetings in which each one starts before
 *    at least one other in the set ends (transitively). In practice: a
 *    cluster stays open for as long as the latest end time among its
 *    meetings has not been passed by the next meeting's start time.
 * 3. Within a cluster, give each meeting the lowest free column index from a
 *    pool, where a column is free once its last meeting ends at or before the
 *    current meeting's start.
 * 4. totalColumns for a cluster is max(columnIndex) + 1 within that cluster.
 *
 * Returns an array in the SAME order as the input, not in sorted order.
 */
export function assignColumns(
	meetings: readonly TimedMeeting[]
): ColumnPlacement[] {
	if (meetings.length === 0) return [];

	// Keep the original index so the result can be returned in input order.
	const indexed = meetings.map((meeting, originalIndex) => ({ meeting, originalIndex }));

	// Sort by startMin, then by endMin descending, so the longer meeting is packed first.
	const sorted = [...indexed].sort((a, b) => {
		if (a.meeting.startMin !== b.meeting.startMin) {
			return a.meeting.startMin - b.meeting.startMin;
		}
		return b.meeting.endMin - a.meeting.endMin;
	});

	// Results in sorted order; filled in below and remapped to input order afterwards.
	const sortedResult = new Array<ColumnPlacement>(sorted.length);

	let i = 0;
	while (i < sorted.length) {
		// --- Start of a cluster ---
		// Gather every meeting belonging to this cluster. The cluster closes when
		// the next meeting's startMin is at or beyond the cluster's current
		// maximum end.
		//
		// So: keep adding meetings until none starts before the cluster's
		// horizon — the latest end time among the meetings gathered so far.
		const clusterStart = i;
		let clusterHorizon = sorted[i].meeting.endMin; // latest end time in the cluster

		let j = i + 1;
		while (j < sorted.length && sorted[j].meeting.startMin < clusterHorizon) {
			// This meeting overlaps at least one in the cluster, so widen the cluster.
			if (sorted[j].meeting.endMin > clusterHorizon) {
				clusterHorizon = sorted[j].meeting.endMin;
			}
			j++;
		}
		// The cluster runs from index i to j-1, with j exclusive.

		// Assign column indices within the cluster from a pool of columns.
		// columnEnds[k] is the end time of the last meeting assigned to column k.
		const columnEnds: number[] = [];

		for (let k = clusterStart; k < j; k++) {
			const meeting = sorted[k].meeting;

			// Find the lowest free column: one whose last meeting ends at or before this one starts.
			let col = -1;
			for (let c = 0; c < columnEnds.length; c++) {
				if (columnEnds[c] <= meeting.startMin) {
					col = c;
					break;
				}
			}

			if (col === -1) {
				// No free column, so open a new one.
				col = columnEnds.length;
				columnEnds.push(0);
			}

			columnEnds[col] = meeting.endMin;
			sortedResult[k] = { columnIndex: col, totalColumns: 0 }; // totalColumns is set below
		}

		// totalColumns for the whole cluster is max(columnIndex) + 1.
		const totalCols = columnEnds.length;
		for (let k = clusterStart; k < j; k++) {
			sortedResult[k].totalColumns = totalCols;
		}

		// The next cluster starts after this one.
		i = j;
	}

	// Remap to the input order.
	const result = new Array<ColumnPlacement>(meetings.length);
	for (let k = 0; k < sorted.length; k++) {
		result[sorted[k].originalIndex] = sortedResult[k];
	}

	return result;
}

/**
 * Combines {@link computeTimeRange} and {@link assignColumns}, then adds
 * pixel positions. The returned blocks are in the SAME order as `timed`.
 *
 * `readDay` (built by #626) is the one place that decides a row is an
 * all-day meeting; by the time a meeting reaches here it is already timed,
 * so this function never widens the span or spends a column on a bar. A day
 * of nothing but all-day meetings therefore reaches this function with an
 * empty `timed` array, and lays out the minimum 08:00–16:30 grid with no
 * blocks — deliberate, because the now-line lives on the grid, and a grid
 * that vanished and came back would be more startling than an empty one
 * (old issue #29).
 */
export function layoutDay(timed: readonly TimedMeeting[], pxPerMinute: number): { span: Span; blocks: Block[] } {
	const range = computeTimeRange(timed);
	const columns = assignColumns(timed);

	const blocks: Block[] = timed.map((meeting, i) => {
		const topPx = (meeting.startMin - range.startMin) * pxPerMinute;
		const durationPx = (meeting.endMin - meeting.startMin) * pxPerMinute;

		// Math.max is a floor for genuinely short meetings, not a repair for
		// wrong ones. `readDay` rejects a row written backwards and reports it
		// as a row error, so every TimedMeeting reaching this function has
		// endMin >= startMin; this function has no row number and no reader to
		// tell, so that check does not belong here.
		const heightPx = Math.max(durationPx, MIN_BLOCK_HEIGHT_PX);

		return {
			...meeting,
			columnIndex: columns[i].columnIndex,
			totalColumns: columns[i].totalColumns,
			topPx,
			heightPx,
		};
	});

	const totalHeightPx = (range.endMin - range.startMin) * pxPerMinute;

	return {
		span: { startMin: range.startMin, endMin: range.endMin, totalHeightPx },
		blocks,
	};
}
