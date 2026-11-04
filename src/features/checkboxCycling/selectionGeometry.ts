/**
 * Where a press leaves the person's cursor and their selection.
 *
 * Three pure functions over strings and positions: which lines a selection
 * covers, where its two ends belong on the rewritten lines, and where one
 * character position ended up when its line changed length. No Obsidian, no
 * host, no feature — the Obsidian names below are types, and a type is gone
 * at build time.
 *
 * **This is the half `cycleLines` cannot see.** That module decides what each
 * line becomes, on text alone; this one answers the question only the editor
 * poses — where the person was looking, and where they have to be looking
 * afterwards.
 *
 * They live apart from `checkboxCycling.ts` because they change for their own
 * reason — the cursor rules — and because pure functions are exercised one case
 * per test rather than through a fake editor and a registered command. Nothing outside
 * this feature imports them, so the feature's barrel does not export them.
 */

import type { EditorPosition, EditorSelection } from "obsidian";
import { splitsACharacter } from "../../core/taskLine";
import type { LineRange } from "./cycleLines";

/**
 * The lines one selection covers, as `cycleLines` wants them: `end` exclusive,
 * and an empty selection is the cursor's own line rather than no line at all.
 *
 * **A selection that stops at the very start of a line does not include that
 * line.** Holding shift and pressing down from the start of one line is how a
 * person selects that one line, and it leaves the far end sitting on the line
 * below at character zero. Counting it would give the line under the selection
 * a checkbox nobody asked for.
 */
export function rangeOf(selection: EditorSelection): LineRange {
	const { anchor, head } = selection;
	const start = Math.min(anchor.line, head.line);
	const far = anchor.line > head.line ? anchor : head;
	const last = far.line > start && far.ch === 0 ? far.line - 1 : far.line;
	return { start, end: last + 1 };
}

/**
 * One selection again, on the lines as the press leaves them.
 *
 * Both ends are answered, which is why this is worked out here rather than
 * taken from `cycleLines`. One number cannot carry two ends, so that
 * function no longer reports one at all: a selection whose
 * anchor sits on a bullet and whose head sits on a line of prose has gained
 * `[ ] ` at one end and `- [ ] ` at the other. The two versions of each end's
 * own line are both in hand here, and they answer for that end directly
 * (#325, which is where
 * #324 left the choice).
 *
 * The two ends come back as the person's own anchor and head, each moved on
 * its own line, and in the order they were given. A selection made backwards
 * — shift and up, or dragging left — stays backwards, because its direction is
 * the state the next keystroke acts on: shift-up grows it from the head, and a
 * press that swapped the two ends made the next shift-up grow it from the
 * other end.
 * #438 put the pair in
 * document order here on the reading that Obsidian's transaction wanted a
 * from-and-to; it does not — see `checkboxCycling.ts`, where the pair is
 * handed over, for the measurement.
 */
export function keptWhereItWas(
	selection: EditorSelection,
	before: readonly string[],
	written: ReadonlyMap<number, string>,
): EditorSelection {
	const moved = (at: EditorPosition): EditorPosition => {
		const after = written.get(at.line);
		if (after === undefined) return at;
		return { line: at.line, ch: shifted(before[at.line], after, at.ch) };
	};
	return { anchor: moved(selection.anchor), head: moved(selection.head) };
}

/**
 * Where character `ch` of `before` has ended up in `after`.
 *
 * The two strings differ in one place and one way — a character replaced, or a
 * checkbox written in — so the line is read as three stretches: the text in
 * front of the first character where they differ, the one stretch that was
 * rewritten, and the text behind it that both strings still share. A cursor in
 * the first stretch does not move. A cursor in the third moves by the
 * difference in the two lengths, which is what the rewrite pushed it by. A
 * cursor in the middle has nothing left to sit on, so it comes back to where
 * the rewrite starts.
 *
 * **The middle stretch is why both ends of the line have to be read, and not
 * just the front**.
 * A press that writes a checkbox in front of a bullet pushes the bullet's text
 * along, so the first character that differs is text the person can still see
 * and their cursor goes with it. A press that swaps one symbol for another
 * rewrites that character, so the first character that differs is gone and a
 * cursor on it belongs where it was. The front of the line cannot tell those
 * apart; the shared text at the back can, and it is what says whether the
 * character at the front of the difference survived the press.
 *
 * **A cursor in the front stretch only stays where it was because real,
 * unchanged text still follows it on the old line.** When `before` is a
 * strict prefix of `after` — a whitespace-only line the press turned into a
 * checkbox, or any other line that only grew, at its own end — the shared
 * prefix runs all the way to the end of `before` and there is no such text
 * left to sit in front of. The front stretch is really the same case as the
 * one at the very end of the line: the whole thing moved, so a cursor sitting
 * anywhere in it lands where the line itself now ends. That already held for
 * a truly empty line, where the front stretch is empty by construction
 * (#765: a whitespace-only
 * line's non-empty front stretch was not making that same allowance). Two
 * identical lines are excluded — there `before` is a prefix of `after` too,
 * but nothing moved at all.
 *
 * This is also the one place that answers for a symbol outside the basic plane.
 * An emoji takes two of the units an editor counts positions in, so swapping an
 * ordinary character for one moves the rest of the line by one — which
 * `cycleLines` reports as no movement, because spec decision 3 counts a symbol
 * as one character. Reading the two strings finds it. Where the rewrite
 * starts can itself fall between an emoji's two units, which is not a position
 * the editor can hold: two symbols sharing a first unit differ only at the
 * second. So a position that would land inside a character is pulled back to
 * that character's start. Back rather than forward, because a cursor between
 * the brackets belongs just after the opening bracket, where the person put it.
 */
export function shifted(before: string, after: string, ch: number): number {
	let front = 0;
	while (front < before.length && front < after.length && before[front] === after[front]) {
		front += 1;
	}

	// The shared text at the back, never reaching back into the shared text at
	// the front: a line that only gained characters shares everything with
	// itself twice over, and the two stretches would otherwise overlap.
	const shortest = Math.min(before.length, after.length);
	let back = 0;
	while (
		back < shortest - front &&
		before[before.length - 1 - back] === after[after.length - 1 - back]
	) {
		back += 1;
	}

	const rewrittenTo = before.length - back;
	// `before` is a strict prefix of `after` — the line only grew, at its own
	// end, with none of it replaced. Nothing of `before` survives past `front`
	// for a front-stretch cursor to stay in front of, so every position on such
	// a line, not only the one at its end, belongs at the end of the line the
	// press wrote. (Excluding `after.length === before.length` keeps two
	// identical lines — nothing moved at all — out of this case.)
	const wholeLineSwallowed = front === before.length && after.length > before.length;
	let moved: number;
	if (wholeLineSwallowed) moved = after.length;
	else if (ch < front) moved = ch;
	else if (ch >= rewrittenTo) moved = ch + (after.length - before.length);
	else moved = front;

	return splitsACharacter(after, moved) ? moved - 1 : moved;
}
