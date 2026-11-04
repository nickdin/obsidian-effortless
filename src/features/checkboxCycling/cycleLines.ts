/**
 * The whole of what one cycling press decides, as one pure function.
 *
 * The editor half that comes later is a few lines: read the selection, call
 * this, write the result back in one transaction. Every decision — which lines
 * are touched at all, and which symbol each one gets — is made here, on text
 * alone, so all of it can be driven with no Obsidian running (spec
 * #283, Testing Decisions).
 *
 * **Where the person's selection ends up is not decided here.** Both of its ends
 * are worked out by `selectionGeometry.ts` from the two versions of that end's
 * own line, which is the only place both ends are in hand.
 *
 * **The rule the whole design exists for: every byte outside the checkbox
 * survives.** A `%% eid:… %%` bookkeeping marker another feature wrote, a
 * `[[Collection]]` reference, a due date, a priority, a tag, a recurrence rule
 * this plugin has never heard of — all identical afterwards. The way that is
 * bought is that a task line is never rebuilt from its parts: the character is
 * written with the core's one-field edit, which replaces one span and leaves
 * every other byte where it was
 * (#15 G2, G7).
 *
 * **Cycling through a character that means something is allowed.** The cycle
 * key is a typing tool and never refuses a keystroke. That one press can unpair
 * a task from its copy is the old copying code's problem and is fixed on that
 * side, on #48, not here.
 *
 * **Nothing here states the task-line format or the Markdown around it.** Which
 * lines may be touched is `lineKind.ts`'s answer, and it asks the core for both. This module knows
 * only the brackets it writes in front of a line that has none, and the order of
 * the symbols.
 */

import { editTaskField, parseTaskLine } from "../../core/taskLine";
import { refuseUnknownRange, type LineKind } from "./lineKind";
import type { CycleDirection, Sequence } from "./types";

/**
 * The lines one press touches: the selection's own lines, or the cursor's line
 * alone when nothing is selected.
 *
 * `end` is exclusive, so the lines are the ones `lines.slice(start, end)`
 * covers. That is `lineKindRange`'s convention and `SectionRange`'s in
 * `src/core/markdownSections.ts`, and stating it a second way here would be one
 * more thing to get wrong. **An empty selection is one line, not zero**: the
 * cursor still sits on a line, so the editor half hands in
 * `{ start: n, end: n + 1 }`.
 */
export interface LineRange {
	/** The first line the press touches. */
	readonly start: number;
	/** One past the last line it touches. */
	readonly end: number;
}

/** What one press produces. */
export interface CycleResult {
	/**
	 * The whole note again, with the range's lines as the press leaves them and
	 * every other line the same string it was handed in.
	 *
	 * **There is deliberately nothing here about how far anything moved.** This
	 * function used to report how many characters were written in front of the
	 * range's last line, and no caller ever read it: a selection has two ends and
	 * they may sit on lines that gained different prefixes, so one number cannot
	 * answer for both. `selectionGeometry.ts` answers each end from the two
	 * versions of that end's own line instead, and a field nothing reads is a trap
	 * for the next person to restore a cursor
	 * (#450, which removed it,
	 * and #325, which decided
	 * where the answer lives).
	 */
	readonly lines: readonly string[];
}

/**
 * Steps every line of `range` one place along `sequence`.
 *
 * Pure: it reads no editor, no vault and no clock, it changes neither `lines`
 * nor `sequence`, and the same call always answers the same thing.
 *
 * **A sequence of fewer than two symbols changes nothing.** There is nowhere to
 * step to, and a one-symbol cycle that rewrote every line with the same
 * character would be an edit the person cannot see and cannot want (spec
 * decision 6: such a sequence cannot cycle, and its row on the settings screen
 * says so).
 *
 * Throws on a range the note does not have, on `refuseUnknownRange`'s terms:
 * that is a mistake in the caller rather than something a note can be. The range is
 * refused first, and only then may a short sequence return early, so the throw
 * does not depend on how many symbols the sequence holds.
 *
 * **`noteKinds` is how a caller with several selections pays for the reading
 * once.** Working out which lines a press may touch means reading the note from
 * line zero, because a line inside a code fence cannot be recognised without
 * everything above it. A caller pressing over ten cursors would pay for that ten
 * times over; handing in one `lineKindRange` reading pays for it once.
 *
 * **The set is read from line zero and indexed by line number, and it has to
 * reach `range.end`.** It need not run to the foot of the note: a caller whose
 * lowest cursor sits on line 12 hands in twelve answers and pays for twelve
 * lines rather than for the whole note. Two sets are
 * refused rather than trusted — one claiming more lines than the note has, and
 * one stopping above the range — because the answers this function gives are
 * only as good as the kinds it was handed.
 *
 * **Handing them in is not optional.** The argument was optional for one wave
 * and no shipped caller ever left it out, so the fall-back door — read the note
 * here instead — ran only from the suite. A door nothing ships through is a
 * trap for the next reader, who has two behaviours to hold in mind and only one
 * that ever runs (#512,
 * which closed it, and #450,
 * which had removed a field nothing read for the same reason).
 */
export function cycleLines(
	lines: readonly string[],
	range: LineRange,
	sequence: Sequence,
	direction: CycleDirection,
	noteKinds: readonly LineKind[],
): CycleResult {
	// No pass over the note here at all: the caller has already made it, which is
	// what handing the kinds in buys.
	//
	// The range is refused first, and only then may a short sequence return early;
	// that order is the whole of what the range contract is worth. With the return
	// first, a range the note does not have threw against a cycle of three symbols
	// and came back quietly against a cycle of one, so the same caller mistake was
	// loud or silent depending on which key the person had pressed.
	const kinds = kindsOf(lines, range, noteKinds);

	if (sequence.symbols.length < 2) return { lines: [...lines] };

	const written = [...lines];

	for (let offset = 0; offset < kinds.length; offset += 1) {
		const at = range.start + offset;
		// The kinds were decided from the line without its carriage return, so the
		// press is decided from that same string and the carriage return goes back
		// on the written line.
		const line = splitLineEnding(lines[at]);
		written[at] = pressed(line.body, kinds[offset], sequence, direction) + line.ending;
	}

	return { lines: written };
}

/**
 * What a press may do to each line of `range`, out of the kinds the caller
 * handed in.
 *
 * The set is indexed by line number, so the range's own answers are the slice
 * at the range's own positions. That is the same array `lineKindRange` would
 * have built for the range alone, because that function always reads from line
 * zero and reports from `start` — which is also why a set that stops at the
 * lowest cursor's end still answers for every range above it.
 *
 * **The range is refused in `lineKind.ts`'s own words, by asking `lineKind.ts`.**
 * That sentence was written out a second time here for one wave, because the
 * point of a handed-in set is that `lineKindRange` is never called and so has no
 * chance to refuse anything. The answer was not a second copy but a function
 * either side can ask.
 *
 * An empty range, `start` equal to `end`, is a range every note has:
 * `refuseUnknownRange` accepts it, and a set of kinds that reaches it lets the
 * press step no lines and hand the note back. A set that stops above it is
 * refused below like any other. No press reaches either case, because `rangeOf`
 * never builds an empty range.
 */
function kindsOf(
	lines: readonly string[],
	range: LineRange,
	noteKinds: readonly LineKind[],
): readonly LineKind[] {
	// The range is refused before the kinds are, and the order is load-bearing. A
	// range running past the foot of the note is also a range no set of kinds can
	// reach, so checking the kinds first would answer a mistake about the range
	// with a complaint about the kinds — the wrong sentence for what the caller
	// actually got wrong.
	refuseUnknownRange(lines.length, range.start, range.end);
	if (noteKinds.length > lines.length) {
		// Loud rather than silently trusted. A set claiming more lines than the note
		// has is a caller whose note and whose kinds have come apart — the note
		// shrank under it — and a line read as prose could be one inside a code
		// fence, so the press would write a checkbox into somebody's sample code.
		//
		// The pair of checks here is weaker than the exact-length one it replaced,
		// and knowingly: a stale set built from a shorter revision of a note that
		// has since grown is long enough to cover the range, so it passes both.
		// The bound this ticket exists to restore cannot survive a check that
		// demands the note's exact length, and no caller can reach that state —
		// the press builds the lines, the ranges and the kinds in one synchronous
		// handler.
		throw new Error(
			`These line kinds answer for ${noteKinds.length} lines and this note has ${lines.length}.`,
		);
	}
	if (noteKinds.length < range.end) {
		// The other half of what the old exact-length check was worth: a set that
		// stops above the range has no answer for the lines this call is about, and
		// slicing it would step them on an answer that is not there. This is a
		// different caller mistake from the one above and says so.
		throw new Error(
			`These line kinds answer for ${noteKinds.length} lines and this press needs the first ${range.end}.`,
		);
	}
	return noteKinds.slice(range.start, range.end);
}

/**
 * A line as the two halves of this feature have to see it: the words a press
 * decides from, and the carriage return that has to survive it untouched.
 *
 * **A note written or synced from Windows ends every line with a carriage
 * return, and that character belongs to the note rather than to the press.**
 * `lineKind.ts` takes it off before it decides what a line is, so a press
 * decided from the raw line would be decided from a different string than the
 * kind was. It was: `- [ ]\r` was classified as a task and then rejected by the
 * task reader, whose pattern wants a space, a tab or the end of the line after
 * the closing bracket — and the two halves disagreeing is the state `stepped`
 * throws on.
 *
 * The carriage return is this feature's problem and not the task-line format's,
 * so nothing about it is pushed down into the core, which other features share.
 */
interface SplitLine {
	/** The line with any trailing carriage return taken off. */
	readonly body: string;
	/** That carriage return, or the empty string on a note with Unix endings. */
	readonly ending: string;
}

/** `line` split into the words a press acts on and the line ending it keeps. */
function splitLineEnding(line: string): SplitLine {
	if (!line.endsWith("\r")) return { body: line, ending: "" };
	return { body: line.slice(0, -1), ending: "\r" };
}

/** The line as the press leaves it, given what `lineKind` says it may do. */
function pressed(
	line: string,
	kind: LineKind,
	sequence: Sequence,
	direction: CycleDirection,
): string {
	switch (kind.kind) {
		case "task":
			return stepped(line, sequence, direction);
		// The brackets go where the item's content starts, so the marker and the
		// indentation in front of them are untouched.
		case "list-item":
			return inserted(line, kind.contentAt, `[${sequence.symbols[0]}] `);
		// A whole task head goes in front of the words, after the indentation.
		case "prose":
			return inserted(line, kind.contentAt, `- [${sequence.symbols[0]}] `);
		// Unlike `list-item` and `prose`, which always take the sequence's first
		// symbol whichever way the press went: there the line already carries
		// words the person wrote, and the checkbox is only ever an addition to
		// them. A blank line has nothing on it to anchor that choice, so the
		// press itself is what the person is saying — forward starts the
		// sequence from its beginning, backward from its end, the same two
		// places wrapping already lands a step on
		// (#751, read
		// against the plugin this feature replaces:
		// `~/Devbox/checkbox-cycler/src/cycle.ts:63` and `main.ts:180`, which
		// move the cursor to the end of the line it just wrote — bought here for
		// free by `selectionGeometry.ts`'s text diff, since this line only grew
		// at its end).
		case "blank":
			return inserted(
				line,
				kind.contentAt,
				`- [${sequence.symbols[direction === "forward" ? 0 : sequence.symbols.length - 1]}] `,
			);
		case "left-alone":
			return line;
		default: {
			// Every kind has its case above, so nothing reaches here and the
			// assignment type-checks. A kind added to `lineKind.ts` breaks it, which
			// is the point: this file has to be told what to do with it rather than
			// quietly leave the line alone.
			//
			// **This guard is checked when the code is compiled, and no test asserts
			// it on purpose**.
			// Reaching it while the code runs means handing in a kind the type does
			// not allow, and widening the type to permit that is the one thing the
			// guard exists to prevent. The gap is deliberate rather than an oversight.
			const unknown: never = kind;
			throw new Error(`unknown line kind: ${JSON.stringify(unknown)}`);
		}
	}
}

/**
 * The line again with its checkbox character one place along the sequence.
 *
 * Wrapping at both ends is what makes the key a cycle. A character the sequence
 * does not hold lands on the sequence's first symbol whichever way the press
 * went: there is no place in the order to step from (spec decision 3).
 */
function stepped(line: string, sequence: Sequence, direction: CycleDirection): string {
	const task = parseTaskLine(line);
	if (task === null) {
		// `lineKind` said this line is a task and it said so by asking the very
		// same reader, so the two cannot disagree unless one of them has changed
		// under the other. Loud rather than silently left alone.
		throw new Error(`the line kinds and the reader disagree about ${JSON.stringify(line)}`);
	}

	const count = sequence.symbols.length;
	// **A symbol the sequence holds twice steps from the first of the two, and
	// that is the decided behaviour rather than an oversight**. A press has only
	// the character on the line to go on, so two identical characters in the
	// sequence are the same character to it and it cannot know which of the two
	// places the person was at. A repeat is allowed and stored as typed, and the
	// price is that the sequence folds back there: the order written after the
	// repeat is never walked as typed. `sequences.ts` reports which symbol
	// repeats and where, so the settings screen can say so.
	const found = sequence.symbols.indexOf(task.checkbox);
	if (found === -1) return editTaskField(line, "checkbox", sequence.symbols[0]);

	const step = direction === "forward" ? 1 : count - 1;
	return editTaskField(line, "checkbox", sequence.symbols[(found + step) % count]);
}

/** The line again with `prefix` written into it at `contentAt`. */
function inserted(line: string, contentAt: number, prefix: string): string {
	return line.slice(0, contentAt) + prefix + line.slice(contentAt);
}
