/**
 * Whether a trigger the person dismissed is still dismissed, read against the
 * line as it is now: pure functions beside `parse`, `suggest` and `stamp`.
 *
 * **Why it is not `suggest`'s.** `suggest` keeps nothing between calls and
 * reads `dismissed` as a column it compares with the trigger it finds. It
 * answers `null` for three different reasons without saying which, so it cannot
 * tell the suggester that a dismissed trigger has gone. Something that keeps
 * the dismissal from one keystroke to the next has to decide that, and this is
 * the rule it decides by; the suggester only stores what this answers.
 */

/**
 * Which trigger the person dismissed: the line it is on, its column, and that
 * line's whole text when it was last read.
 *
 * The text is what lets the next reading tell where an edit fell, together
 * with the cursor that reading is handed. A column alone cannot: text typed or
 * deleted ahead of the trigger moves its column and leaves it the same trigger,
 * and spec #573 decision 4 does not lift a dismissal for that
 * (#608, decided by the author
 * on 2026-09-16). Nor is `line` alone reliable once a line above the trigger
 * is inserted or removed: the same trigger now sits under a different number,
 * so `recheckDismissal` reads a dismissal's recorded line and column together
 * against whichever nearby line now holds them, when the cursor's own line no
 * longer does.
 */
export interface DismissedTrigger {
	readonly line: number;
	readonly at: number;
	readonly text: string;
}

/** What one reading of a recorded dismissal comes to. */
export interface DismissalReading {
	/** The dismissal to keep recording from now on, or `null` once it is cleared. */
	readonly recorded: DismissedTrigger | null;
	/** The column to hand `suggest` as its `dismissed`, or `null` when nothing applies here. */
	readonly dismissed: number | null;
}

/**
 * The content the caller reads at one line near a dismissal's recorded line,
 * for {@link recheckDismissal} to compare against — see its own docstring,
 * "the cross-line case".
 */
export interface NearbyLine {
	readonly line: number;
	readonly text: string;
}

/**
 * The dismissal to record should the person dismiss the popup open on line
 * `cursorLine`, whose whole text is `line`, for the trigger `suggest` found at
 * column `triggerAt`.
 */
export function dismissalFor(cursorLine: number, line: string, triggerAt: number): DismissedTrigger {
	return { line: cursorLine, at: triggerAt, text: line };
}

/**
 * Where the edit that turned `before` into `after` fell: how many characters
 * the two share at the start, and how many at the end, never counting one
 * character in both.
 *
 * Mostly the text alone answers. When the edit's text repeats what sits right
 * beside it, it does not: typing `@` in front of `@tom` leaves `@@tom` whichever
 * of the two `@` was typed. Every such placement changes the same number of
 * characters, and the one taken is the one whose edit ends nearest `cursor` in
 * `after`, because an edit a person makes — a keystroke, a paste, a cut —
 * ends where the cursor is left. Where the text leaves only one placement, the
 * cursor is not asked: an edit made away from the cursor, as Tab indenting a
 * list item is, is still read where it fell.
 */
function sharedEnds(
	before: string,
	after: string,
	cursor: number,
): { readonly start: number; readonly end: number } {
	const shorter = Math.min(before.length, after.length);
	let start = 0;
	while (start < shorter && before[start] === after[start]) start++;
	let end = 0;
	while (end < shorter && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
	// What the two share, counted once; the shared start may be anything from
	// `shared - end` to `start`, which is one length unless the two overlap.
	const shared = Math.min(start + end, shorter);
	const typed = after.length - shared;
	const placed = Math.min(Math.max(cursor - typed, shared - end), start);
	return { start: placed, end: shared - placed };
}

/**
 * Reads `recorded` against `line`, the whole text of the line `cursor` is on as
 * it is now, and says whether the dismissal still holds.
 *
 * **A dismissal follows its trigger through the edits around it.** At every
 * keystroke the line is compared with the text it had at the last reading.
 * Whatever the two share at the start and at the end is untouched; the stretch
 * between is what changed. Where an edit repeats what sits beside it, so that
 * the text allows it more than one place, it is placed where it ends at the
 * cursor.
 *
 * - **The trigger sits in the shared start**: the edit fell after it, and it
 *   keeps its column.
 * - **The trigger sits in the shared end**: the edit fell ahead of it, and its
 *   column moves by however much longer or shorter the line became — whether
 *   the text typed or deleted holds a trigger character or not.
 * - **The trigger sits in the changed stretch**: it was deleted, and the
 *   dismissal is cleared. Obsidian asks on the delete itself, so a trigger
 *   deleted and retyped arrives as two changes, and the retyped one is judged
 *   fresh — spec #573's INV-1, "it opens again once deleted and retyped".
 *
 * `suggest` is handed the column the dismissed trigger holds now and compares
 * it with the trigger it finds at the cursor, so the same trigger stays closed
 * and any other — typed new, even hard against it, or one the cursor moved to —
 * is judged fresh (decision 4). No other trigger inherits the dismissal from an
 * edit that ends at the cursor.
 *
 * **The limit.** A paste of the same character over the dismissed trigger
 * reads as no change at all, and the dismissal holds. An edit that did not end
 * at the cursor — made by something other than the person typing there — and
 * repeats what sits beside it is placed as near the cursor as the text allows,
 * which can be the wrong one of two identical stretches: `@a ` taken from the
 * front of `@a @a` with the cursor at the end reads as ` @a` taken from the
 * end, and a dismissal of the first `@a` passes to the one left. A dismissal
 * also clears when one reading finds the line changed on both sides of the
 * trigger, which takes two separate edits between two readings.
 *
 * **The whole line is read, not the text before the cursor**, so that moving
 * the cursor back past a dismissed trigger does not read as the trigger having
 * gone. Only the text before the cursor decides whether the popup opens; whether
 * the dismissal still stands is about the line.
 *
 * **The cross-line case.** A line inserted or removed above the trigger's
 * line moves it to a new line number without touching it, and none of
 * decision 4's three things happened, so the dismissal must still apply once
 * the cursor comes back.
 * `nearby` is what the caller reads with `getLine` at up to three lines
 * around `recorded.line` — the line itself, the one above and the one below,
 * whichever exist and are not the line the cursor is already on — so this
 * function is not handed the document, only the couple of lines that answer
 * "did the old line move, and if so, where to". The first branch below
 * depends on `recorded.line`'s own line being among them:
 *
 * - **`recorded.line`'s own line, read among `nearby`, still reads exactly as
 *   recorded** — nothing shifted, and this is some other, unrelated line the
 *   cursor happens to be on (or to share text with). The dismissal is kept
 *   against `recorded.line`, untouched, the way it always was.
 * - **Otherwise, the cursor is at most one line from `recorded.line`, and the
 *   trigger is found in `line` itself** — the same test as the same-line case
 *   above — the dismissal moves to the cursor's line, because the old line no
 *   longer holding the recorded text is what a shift looks like from here,
 *   and this line reading as the same trigger is what confirms it. Farther
 *   than that, a shared prefix proves nothing — a different trigger can start
 *   the same way — so this step is skipped.
 * - **Otherwise, one of `nearby`'s two neighbouring lines reads exactly as
 *   recorded** — a line was inserted or removed so close to the trigger that
 *   the cursor's own line, right after the edit, coincides with
 *   `recorded.line`'s old number by coincidence (pressing Enter one line
 *   above a trigger creates exactly this: a fresh blank line at the trigger's
 *   old number, with the trigger itself now one line down). The dismissal
 *   moves there instead, kept but not applied on this reading, since the
 *   cursor is not on it yet.
 * - **None of those, and the cursor is where the trigger was last recorded**
 *   — it was deleted, and the dismissal clears, exactly as before this
 *   ticket.
 * - **None of those, and the cursor is elsewhere** — nothing here says the
 *   trigger has gone, only that this reading cannot find it, so the
 *   dismissal is kept exactly as recorded and simply not applied. A later
 *   reading, from `recorded.line` itself or from beside it, still finds it.
 *
 * **The limit.** Landing directly on the line the trigger now lives on only
 * finds it there when that line is at most one away from `recorded.line` —
 * the same window `nearby` covers. Farther than that, the arithmetic that
 * finds a trigger by a shared prefix cannot tell a real shift from an
 * unrelated line that merely starts the same way, so it is not trusted there,
 * and no other trigger inherits the dismissal from it. A trigger that
 * moved by more than one line between two readings, and that the cursor never
 * lands within that window of, keeps the dismissal recorded but not applied,
 * until a later reading lands on the right line or beside it. A `nearby` line
 * that happens to read exactly like the recorded one, without anything having
 * shifted there at all, is read as the trigger having moved to it — the same
 * kind of coincidence the paste and cut limits above already accept.
 */
export function recheckDismissal(
	recorded: DismissedTrigger | null,
	cursor: { readonly line: number; readonly ch: number },
	line: string,
	trigger: string,
	nearby: readonly NearbyLine[],
): DismissalReading {
	if (recorded === null) return { recorded: null, dismissed: null };

	if (cursor.line === recorded.line) {
		const at = findTrigger(recorded, line, cursor, trigger);
		if (at !== null) return { recorded: { line: cursor.line, at, text: line }, dismissed: at };
	} else {
		const atRecordedLine = nearby.find((candidate) => candidate.line === recorded.line);
		if (atRecordedLine !== undefined && atRecordedLine.text === recorded.text) {
			return { recorded, dismissed: null };
		}
		if (Math.abs(cursor.line - recorded.line) <= 1) {
			const at = findTrigger(recorded, line, cursor, trigger);
			if (at !== null) return { recorded: { line: cursor.line, at, text: line }, dismissed: at };
		}
	}

	for (const candidate of nearby) {
		if (candidate.line === recorded.line || candidate.text !== recorded.text) continue;
		return { recorded: { line: candidate.line, at: recorded.at, text: candidate.text }, dismissed: null };
	}

	return cursor.line === recorded.line ? { recorded: null, dismissed: null } : { recorded, dismissed: null };
}

/**
 * Where the trigger `recorded` names sits in `line` now, or `null` where the
 * edit since the last reading took it away — the arithmetic {@link recheckDismissal}
 * uses both for its own line and, since #617, for the line a dismissal may
 * have shifted to.
 */
function findTrigger(
	recorded: DismissedTrigger,
	line: string,
	cursor: { readonly ch: number },
	trigger: string,
): number | null {
	const { start, end } = sharedEnds(recorded.text, line, cursor.ch);
	if (recorded.at + trigger.length <= start) return recorded.at;
	if (recorded.at >= recorded.text.length - end) return recorded.at + line.length - recorded.text.length;
	return null;
}
