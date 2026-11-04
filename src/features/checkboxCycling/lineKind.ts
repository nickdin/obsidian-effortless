/**
 * What a cycling press is allowed to do to one line of a note.
 *
 * **This is where the feature deliberately stops matching the plugin it
 * replaces, and the difference is the reason the feature exists.** The old
 * plugin turns whatever line the cursor is on into a checkbox. A calendar-table
 * row became `- [ ] | 09:00-10:00 | ... |`, after which that day's table was
 * refused for ever, and a meeting note's participant entry became a checkbox
 * and broke the list it was in. Both are damage that happened.
 *
 * **It has to see the whole note, not just the line.** Whether a line sits
 * inside a fenced block or inside the note's YAML frontmatter is decided
 * entirely by what is above it, and the same text is an ordinary task line in
 * one place and untouchable in the other.
 *
 * **A task line is whatever the core's reader says one is, and so is where a
 * checkbox would go.** `parseTaskLine` in `src/core/taskLine.ts` is asked
 * whether a line already is one, and `checkboxSlot` beside it is asked what
 * shape a line that is not one has and where its content starts. Nothing here
 * re-states the format, the list markers or the brackets. The Markdown
 * *around* a line is asked for the same way: `fencedLines` and `isAtxHeading` in
 * `src/core/markdownSections.ts` say what a fenced block and a heading are, and
 * this module states neither rule. What is left here
 * is the rest of that surrounding Markdown — the note's frontmatter, tables,
 * blockquotes, horizontal rules and setext underlines — and the order the whole
 * lot is asked in.
 *
 * Pure: it takes strings and returns an answer, so every rule below can be
 * exercised on a literal with no Obsidian running.
 */

import { fencedLines, isAtxHeading } from "../../core/markdownSections";
import { checkboxSlot, parseTaskLine } from "../../core/taskLine";

/**
 * Why a line is left exactly as it is. Codes rather than sentences: the words a
 * person reads belong to whatever puts them on screen, and one press over a
 * selection has to gather several of these before it can say anything at all —
 * which is what `lineKindRange` is for.
 */
export type LeftAloneReason =
	/** Inside a fenced block, delimiter lines included. */
	| "fenced"
	/** Inside the note's YAML frontmatter, its `---` lines included. */
	| "frontmatter"
	/** A table row. The calendar table is the one this rule was written for. */
	| "table-row"
	/** An ATX heading, `#` through `######`. */
	| "heading"
	/** Quoted with `>`. */
	| "blockquote"
	/** A numbered item carrying no checkbox. */
	| "numbered-item"
	/**
	 * A horizontal rule — `---`, `***`, `___`, and the spaced forms `- - -` and
	 * `* * *`. A press that wrote a checkbox here would take the rule out of the
	 * note and put a task nobody wrote into the list.
	 */
	| "thematic-break"
	/**
	 * The `===` or `---` under a line of words, which is what makes that line a
	 * heading. Writing a checkbox here demotes the line above to ordinary words,
	 * so this reaches further than the line it touches — and `heading` is already
	 * a reason, so refusing `# Notes` and rewriting `Notes` over `===` would be
	 * refusing one spelling of a heading and accepting the other.
	 */
	| "setext-underline"
	/**
	 * A `-`, `*` or `+` item whose content opens with one character in brackets
	 * and no space after them — `- [x]text`. The core's reader wants whitespace
	 * or the end of the line there, so this is not a checkbox here, and giving it
	 * one would produce `- [ ] [x]text`.
	 *
	 * One character means one code point, emoji included, because the core is
	 * what counts it.
	 */
	| "unspaced-bracket";

/** What a press may do to a line, and where it would write if it may. */
export type LineKind =
	/** Already a task line: its checkbox character steps along the sequence. */
	| { readonly kind: "task" }
	/**
	 * A `-`, `*` or `+` item with no checkbox: it gains one in place, after its
	 * marker. `contentAt` is where the item's content starts, which is where the
	 * brackets go.
	 */
	| { readonly kind: "list-item"; readonly contentAt: number }
	/**
	 * Ordinary prose: it gains a whole `- [ ] ` in front, keeping its
	 * indentation. `contentAt` is the first character after that indentation.
	 */
	| { readonly kind: "prose"; readonly contentAt: number }
	/**
	 * Empty, or nothing but spaces and tabs: it gains a whole checkbox head
	 * after whatever whitespace it already has, so a whitespace-only line keeps
	 * its indentation the way `prose` does (#751
	 * decision, and spec #283
	 * decision 4 before it reversed one item of the "left alone" list). Kept
	 * apart from `prose` because which symbol it gets depends on the press's
	 * direction, where `prose` and `list-item` do not — see `cycleLines.ts`.
	 * `contentAt` is where that whitespace ends, which is where the checkbox
	 * goes.
	 */
	| { readonly kind: "blank"; readonly contentAt: number }
	/** Nothing happens to it, and this is why. */
	| { readonly kind: "left-alone"; readonly reason: LeftAloneReason };

/** Nothing but spaces and tabs, or nothing at all. */
const BLANK = /^[ \t]*$/;

/**
 * A horizontal rule, by CommonMark's rule: three or more of `-`, `*` or `_`,
 * all the same character, spaces and tabs allowed between and after them, up to
 * three spaces of indentation, and nothing else on the line.
 *
 * Three is the floor, so `--` and `- -` are not rules and are answered as they
 * were before.
 */
const THEMATIC_BREAK = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;

/**
 * The shape of a setext heading's underline: only `=` or only `-`, one or more
 * of them, trailing whitespace allowed, up to three spaces of indentation —
 * with one shape carved out of the dash branch.
 *
 * The shape alone does not make one. It is an underline only when the line
 * above it is a paragraph, which is why the rule that uses this pattern asks
 * for the line above as well — `---` under a line of words is an underline, and
 * the same line under a blank is a horizontal rule.
 *
 * **A single `-` followed by whitespace is not this shape**. It is somebody
 * halfway through typing a bullet, and `* ` and `+ ` in the same position have
 * always reached the bullet rule and become checkboxes; leaving `- ` behind made
 * the three markers disagree about one line. CommonMark is on the old code's
 * side — an empty list item may not interrupt a paragraph — but it says the same
 * of `* ` and `+ `, so the spec explains neither half of the disagreement. A
 * press is the person saying what they meant, and nobody presses a checkbox key
 * on a heading's underline.
 *
 * The rule is narrowed here rather than asked after the bullet rule. Reordering
 * would let `--`, `---` and `- - -` reach the bullet rule too, which is the
 * damage #355 exists to
 * stop. A lone `-` with nothing after it is still an underline, and so is every
 * run of two or more; `=` is untouched, having no bullet marker to collide with.
 */
const SETEXT_UNDERLINE = /^ {0,3}(?:=+[ \t]*|-{2,}[ \t]*|-)$/;

/**
 * Refuses a range the note does not have, in the one sentence this feature says
 * it in.
 *
 * `start` is inclusive and `end` is exclusive, so `end` may equal `lineCount`,
 * and an empty range — `start` equal to `end` — is a range every note has.
 * Anything outside that is a mistake in the caller rather than something a note
 * can be, which is why this throws rather than answering.
 *
 * **It is a function, and exported, because two callers need the same
 * sentence.** `lineKindRange` below asks it before it reads a note, and
 * `cycleLines` asks it before it slices the kinds its caller handed in — that
 * call reads no note, so it cannot have the refusal as a side effect of reading
 * one. The sentence was written out a second time in `cycleLines.ts` instead,
 * and kept in step by a test that pressed one bad range through both copies and
 * compared the words; this function is what that test was standing in for.
 */
export function refuseUnknownRange(lineCount: number, start: number, end: number): void {
	if (
		!Number.isInteger(start) ||
		!Number.isInteger(end) ||
		start < 0 ||
		start > end ||
		end > lineCount
	) {
		throw new Error(`This note has no lines ${start} to ${end}; it has ${lineCount}.`);
	}
}

/**
 * What a press may do to every line from `start` up to but not including `end`,
 * one answer per line, in order. `end` is exclusive so that the range is the one
 * `lines.slice(start, end)` covers, which is what `headingRange` in
 * `src/core/markdownSections.ts` means by the word too.
 *
 * **This is the entry point a press over a selection should use.** The note is
 * always read from line zero, because two of the rules cannot be answered by a
 * line on its own — whether a fenced block is open above it, and whether the
 * line above it is the paragraph it underlines — and both are carried down the
 * note as the walk goes. So the work is one pass whatever the range covers.
 * Asking line by line instead repeats that walk per line and is quadratic.
 *
 * Throws on a range the note does not have, on the same terms as `lineKind`:
 * that is a mistake in the caller rather than something a note can be.
 */
export function lineKindRange(
	lines: readonly string[],
	start: number,
	end: number,
): readonly LineKind[] {
	refuseUnknownRange(lines.length, start, end);

	const frontmatter = frontmatterEnd(lines);
	// What a fenced block is belongs to the core, and it answers for a whole run
	// of lines in one pass. The scan starts below the frontmatter, because three
	// backticks written inside a note's header are a value in that header and
	// open nothing over the words below it.
	//
	// It stops at `end`. The range is half-open: the walk below runs while
	// `i < end`, so the last line this call answers about is `end - 1`. Fence state
	// matters only for the lines that walk reports on, so a bound of `end`
	// covers all of them.
	// The bound is for a caller asking about part of a note: without it the scan
	// would read to the foot of the note however short the range is. The editor's
	// own press is that caller. It asks down to its lowest cursor's end
	// (`checkboxCycling.ts`'s `lineKindRange(before, 0, bound)`, where `bound` is
	// folded from zero over the press's ranges), so one cursor on line 12 of a
	// three-thousand-line log classifies twelve lines rather than three thousand. What the bound
	// saves is the lines at or past `end`, never the lines above `start` — the
	// walk still starts at line zero for the two reasons in the docstring above —
	// so the saving depends on where the range sits, not on how long it is: the
	// same one-line press near the foot of that log saves almost nothing. It is the only
	// caller that asks for part of a note. `cycleLines` used to be a second one,
	// reading the note itself when it was handed no kinds; since
	// #512 every caller of it
	// hands the kinds in and that door is gone.
	const fenced = fencedLines(lines, frontmatter + 1, end);
	const answers: LineKind[] = [];
	let previous: LineKind | null = null;

	for (let i = 0; i < end; i += 1) {
		let answer: LineKind;
		if (i <= frontmatter) {
			answer = leftAlone("frontmatter");
		} else if (fenced[i]) {
			answer = leftAlone("fenced");
		} else {
			answer = classify(lines[i].replace(/\r$/, ""), previous);
		}
		previous = answer;
		if (i >= start) answers.push(answer);
	}
	return answers;
}

/**
 * What a press may do to `lines[index]`.
 *
 * The order the rules are asked in is the answer to lines that could match two
 * of them. A task line is asked for before every left-alone rule but the two
 * that are decided above it, so `- [ ] | 09:00 | ... |` is a task whose words
 * contain pipes rather than a table row, and `- [ ] ---` is a task whose words
 * are dashes rather than a horizontal rule.
 *
 * The rules themselves are stated once, in `lineKindRange`, and this is the
 * one-line question asked of it. A caller with more than one line to ask about
 * should ask the range instead: this reads the note from the top every time.
 *
 * No shipped code calls this today — only the tests do. It stays as the
 * module's stated one-line question. The fence-scan bound above does not depend
 * on it either way: the editor's press pays for that bound on every keystroke.
 *
 * Throws when `index` names no line, because that is a mistake in the caller
 * rather than something a note can be.
 */
export function lineKind(lines: readonly string[], index: number): LineKind {
	if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
		throw new Error(`This note has no line ${index}; it has ${lines.length}.`);
	}

	return lineKindRange(lines, index, index + 1)[0];
}

/**
 * What a press may do to one line, given what the walk above already knows: the
 * line is not in frontmatter and not in a fenced block, and `previous` is the
 * answer for the line above it, or `null` where there is no line above.
 */
function classify(line: string, previous: LineKind | null): LineKind {
	// Reversed by issue #751: the old plugin this feature replaces starts a
	// checkbox on an empty or whitespace-only line, and the person who reports
	// against this plugin relies on it.
	// `contentAt` is the line's own length, so a whitespace-only line's
	// indentation sits in front of the checkbox rather than being replaced by
	// it — the same answer `checkboxSlot`'s `plain` shape would give this line,
	// stated directly here because `BLANK` already knows the line has nothing
	// else on it.
	if (BLANK.test(line)) return { kind: "blank", contentAt: line.length };
	// The core's reader, and no second opinion about the format. It answers for
	// all four list markers, and it is what decides that `- [x]text` is not one.
	if (parseTaskLine(line) !== null) return { kind: "task" };
	// Asked before the bullet rule, so that `- - -` reaches it instead of being
	// read as a bullet and given a checkbox in the middle of the rule. The
	// underline is asked for first of the two, because a line of dashes is both
	// shapes and what tells them apart is the line above.
	if (SETEXT_UNDERLINE.test(line) && previous !== null && previous.kind === "prose") {
		return leftAlone("setext-underline");
	}
	if (THEMATIC_BREAK.test(line)) return leftAlone("thematic-break");
	if (isAtxHeading(line)) return leftAlone("heading");
	// Deliberately more cautious than Markdown, which stops allowing indentation
	// at four spaces: any line whose first character that is not a space or a tab
	// is `>` is quoted, and a press leaves quoted words alone.
	if (/^[ \t]*>/.test(line)) return leftAlone("blockquote");
	// A leading pipe. A table written without one reads as prose here, and that
	// is the honest limit: nothing separates `a | b` from a sentence.
	if (/^[ \t]*\|/.test(line)) return leftAlone("table-row");
	// The marker set, the indentation rule and the bracket rule are the core's,
	// and this asks for all three at once rather than restating any of them. It is asked
	// after `parseTaskLine`, which is the order it wants: a line that already
	// carries a checkbox is stepped rather than given a second one.
	const slot = checkboxSlot(line);
	switch (slot.shape) {
		case "numbered":
			return leftAlone("numbered-item");
		case "unspaced-bracket":
			return leftAlone("unspaced-bracket");
		case "bullet":
			return { kind: "list-item", contentAt: slot.contentAt };
		case "plain":
			return { kind: "prose", contentAt: slot.contentAt };
		default: {
			// Every shape has its case above, so nothing reaches here and the
			// assignment type-checks. A shape added to the core breaks it, which is
			// the point: this file has to be told rather than quietly answer prose.
			const unknown: never = slot.shape;
			throw new Error(`unknown checkbox slot: ${String(unknown)}`);
		}
	}
}

function leftAlone(reason: LeftAloneReason): LineKind {
	return { kind: "left-alone", reason };
}

/**
 * The index of the note's closing frontmatter line, or `-1` when it has none.
 *
 * **Frontmatter is only frontmatter at the very top.** A `---` further down a
 * note is a horizontal rule and starts nothing, which is why this reads line
 * zero and then looks for the close rather than scanning for a pair.
 *
 * An opener with no close is not frontmatter either. Obsidian reads it as
 * ordinary text with a rule above it, and so does this: the lines below it are
 * words the person wrote, and refusing to touch them would be refusing to do
 * the one thing the feature is for.
 */
function frontmatterEnd(lines: readonly string[]): number {
	if (lines.length === 0 || lines[0].replace(/\r$/, "") !== "---") return -1;
	for (let i = 1; i < lines.length; i += 1) {
		if (lines[i].replace(/\r$/, "") === "---") return i;
	}
	return -1;
}
