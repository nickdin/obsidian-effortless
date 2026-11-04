/**
 * Writing an accepted date into the line, as one pure function.
 *
 * A date-entry trigger and whatever the person typed after it sit somewhere on
 * the line, from `triggerAt` to `cursorAt`. Accepting a suggestion removes
 * that span and writes a stamp for `kind` and `date` in its place — this
 * module decides the whole new line and where the cursor goes in one step, so
 * the editor writes the line once and one undo restores it.
 *
 * **This module never reads the task-line format.** What the line becomes
 * once the trigger is gone decides everything: a task line, as the core's
 * `parseTaskLine` defines one, has its date set through the core's one-field
 * edit, `editTaskField`; anything else gets the stamp written back where the
 * trigger was, with nothing else on the line read or touched. Finding an
 * existing stamp on a line that is not a task line would need a second reader
 * of the format, so this module does not go looking for one — that line
 * simply gets the trigger's own spot overwritten.
 */

import {
	dateStampText,
	editTaskField,
	parseTaskLine,
	repeatStampText,
	type DateStampKind,
} from "../../core/taskLine";

export type { DateStampKind };

/** The whole new line, and where the cursor goes on it. */
export interface StampResult {
	readonly line: string;
	readonly cursor: number;
}

/** `date`, as the core's fields hold one: local year, month and day, `YYYY-MM-DD`. */
export function isoDate(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/** A space or a tab, the whitespace a stamp is separated by. */
function isBlank(character: string | undefined): boolean {
	return character === " " || character === "\t";
}

function endsInBlank(text: string): boolean {
	return isBlank(text[text.length - 1]);
}

function withoutTrailingBlanks(text: string): string {
	let end = text.length;
	while (end > 0 && isBlank(text[end - 1])) end--;
	return text.slice(0, end);
}

/**
 * Where `at` in `before` lands in `after`, when the two differ inside one
 * contiguous span and `at` sits outside it — in the text both still share
 * verbatim at the front, or in the text both still share verbatim at the
 * back. This is how the cursor is carried across `editTaskField`'s edit
 * without this module asking the core where that edit landed, which would be
 * one more thing it would have to know about the format.
 */
function trackThroughEdit(before: string, after: string, at: number): number {
	let head = 0;
	const headRoom = Math.min(before.length, after.length, at);
	while (head < headRoom && before[head] === after[head]) head++;
	if (at <= head) return at;

	let tail = 0;
	const tailRoom = Math.min(before.length - at, after.length);
	while (tail < tailRoom && before[before.length - 1 - tail] === after[after.length - 1 - tail]) {
		tail++;
	}
	return after.length - tail;
}

/**
 * What `line` is once the trigger and what followed it are gone, when that is
 * still a task line, and where the trigger was in it; `null` for any other line.
 *
 * The whitespace before the trigger separated it from the words before it only
 * when whitespace or the line's end follows it too; otherwise it is what keeps
 * those words apart from the ones after. And it goes only when the line is
 * still a task line without it — `- [ ] @tom` must not lose the space that
 * makes `- [ ]` a task.
 */
function withoutTrigger(
	line: string,
	triggerAt: number,
	cursorAt: number,
): { readonly line: string; readonly triggerAt: number } | null {
	const before = line.slice(0, triggerAt);
	const after = line.slice(cursorAt);
	if (parseTaskLine(before + after) === null) return null;

	// A bare `\r` after the trigger is the line's end, as it is for the core's
	// insertion point.
	const separated = endsInBlank(before) && (after === "" || after === "\r" || isBlank(after[0]));
	const trimmedBefore = separated ? withoutTrailingBlanks(before) : before;
	const dropsSeparator = separated && parseTaskLine(trimmedBefore + after) !== null;

	return dropsSeparator
		? { line: trimmedBefore + after, triggerAt: trimmedBefore.length }
		: { line: before + after, triggerAt };
}

/**
 * Where the cursor goes after `edited` was made from `stripped`, with the
 * trigger at `at`: where the trigger was, carried through the edit, and past
 * `written` when the core put it right there.
 */
function cursorAfter(stripped: string, edited: string, at: number, written: string): number {
	const triggerSpot = trackThroughEdit(stripped, edited, at);
	const stampedThere = [" ", ""]
		.map((gap) => gap + written)
		.find((text) => edited.startsWith(text, triggerSpot));
	return triggerSpot + (stampedThere?.length ?? 0);
}

/**
 * Writes an accepted date into `line`. `triggerAt` and `cursorAt` bound the
 * trigger and whatever query followed it; that span is removed first, and
 * what happens next depends on what removing it leaves behind.
 *
 * A task line gets `kind`'s date set with `editTaskField` — a stamp of that
 * kind already there has its date replaced where it stands, otherwise the
 * core adds one at the end of the task's words. The whitespace separating
 * the trigger from the words before it goes with it — when whitespace or the
 * line's end follows the trigger too, and the line is still a task line
 * without it — since the stamp lands wherever the core puts it rather than
 * back at the trigger's own spot, and leaving that whitespace would be a
 * stray space `editTaskField` never wrote. The cursor lands just after the stamp when the core put it
 * where the trigger was, and where the trigger was when it went elsewhere.
 *
 * Any other line gets the stamp written where the trigger was, and nothing
 * else on it is read or changed. The cursor lands just after the stamp.
 */
export function stamp(
	line: string,
	triggerAt: number,
	cursorAt: number,
	kind: DateStampKind,
	date: Date,
): StampResult {
	const value = isoDate(date);
	const stripped = withoutTrigger(line, triggerAt, cursorAt);

	if (stripped !== null) {
		const edited = editTaskField(stripped.line, kind, value);
		return {
			line: edited,
			cursor: cursorAfter(stripped.line, edited, stripped.triggerAt, dateStampText(kind, value)),
		};
	}

	const text = dateStampText(kind, value);
	return {
		line: line.slice(0, triggerAt) + text + line.slice(cursorAt),
		cursor: triggerAt + text.length,
	};
}

/**
 * Writes an accepted repeat rule into `line`, the way {@link stamp} writes a
 * date: the trigger and what followed it go, and on a task line the rule is set
 * through the core's one-field edit — added where a new date goes, or, on a
 * line that already carries a rule, replaced where it stands, nothing reordered.
 *
 * `text` is the rule as the core writes it (`every week on Monday`);
 * `repeatStampText` throws on text outside the rule's alphabet, so a string the
 * core would not read never reaches a line.
 *
 * **A first date, for a line with none.** `firstDate` (`YYYY-MM-DD`, from the
 * core's `firstRepeatDate`) is set as the scheduled date when the task line
 * carries neither a scheduled nor a due date, so a rule entered here never
 * leaves a dateless task; a line with either keeps its dates as they are, and
 * `null` writes none. It is added after the rule, so the rule's stamp comes first and the scheduled stamp after it.
 * The cursor follows the date when it lands where the trigger was.
 *
 * Any other line gets the rule's stamp written where the trigger was, no date, and
 * nothing else on it is read or changed — a line that is not a task has no
 * round to date.
 */
export function stampRepeat(
	line: string,
	triggerAt: number,
	cursorAt: number,
	text: string,
	firstDate: string | null,
): StampResult {
	const written = repeatStampText(text);
	const stripped = withoutTrigger(line, triggerAt, cursorAt);

	if (stripped === null) {
		return {
			line: line.slice(0, triggerAt) + written + line.slice(cursorAt),
			cursor: triggerAt + written.length,
		};
	}

	const reading = parseTaskLine(stripped.line);
	const dateless = reading !== null && reading.scheduled === null && reading.due === null;

	const withRule = editTaskField(stripped.line, "repeat", text);
	let cursor = cursorAfter(stripped.line, withRule, stripped.triggerAt, written);
	if (!dateless || firstDate === null) return { line: withRule, cursor };

	const withDate = editTaskField(withRule, "scheduled", firstDate);
	cursor = cursorAfter(withRule, withDate, cursor, dateStampText("scheduled", firstDate));
	return { line: withDate, cursor };
}
