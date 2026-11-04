/**
 * The one place that understands a task line.
 *
 * A task line is one Markdown checkbox line in the Obsidian Tasks emoji format,
 * as the vault already holds it. This module reads the seven things the plugin
 * understands — the checkbox character, the scheduled date, the due date,
 * priority, tags, the repeat rule as text, and the shape of an invisible
 * `%% … %%` comment — and treats everything else on the line as text to be
 * carried untouched. A field the plugin has never heard of, a done date, a
 * trailing breadcrumb: all of it survives every edit.
 *
 * There is one operation that changes a line, and it changes one field. Nothing
 * here takes a line apart and builds it again, so no edit can normalise
 * whitespace, reorder emoji or rebuild indentation. That rule is the whole
 * point of the module: without it, every feature that writes a task would
 * re-implement it, differently.
 *
 * This is plain shared code. It touches no vault, no app and no settings
 * storage, and features import it directly rather than receive it — there is
 * one format and there will only ever be one, so a swappable seam would buy
 * nothing and add a step to every test.
 *
 * Every emoji below is written as an escape rather than as itself, so that no
 * editor, terminal or patch can alter the format by re-encoding a character.
 * No pattern uses lookbehind: it fails on iOS below 16.4, which Obsidian names
 * explicitly as a supported platform. That is held to by `afterTheFloor` in
 * `src/__tests__/platform.test.ts`, over every shipped module at once rather
 * than over this file by name.
 */

/** What a checkbox character means. Fixed by the plugin, never a setting. */
export type CheckboxMeaning = "open" | "copied" | "done" | "cancelled" | "forwarded";

/** The Obsidian Tasks priority levels, all five of them. */
export type Priority = "highest" | "high" | "medium" | "low" | "lowest";

/**
 * The five checkbox characters the plugin fixes a meaning to. Any other
 * character is an ordinary open task whose symbol is left alone, because an
 * editable mapping would be a setting nobody changes that can silently unpair a
 * task from its copy.
 */
const CHECKBOX_MEANINGS: Readonly<Record<string, CheckboxMeaning>> = {
	" ": "open",
	"/": "copied",
	x: "done",
	"-": "cancelled",
	">": "forwarded",
};

/**
 * What `character` means as a checkbox: one of the five fixed meanings, or
 * `open` for any other string, which is an ordinary open task.
 *
 * The one lookup in the table. The reader below uses it, and a feature that
 * needs a meaning asks here rather than keeping its own pairs or parsing a
 * line built around the character. Only the
 * table's own keys answer, so a name every object inherits, `constructor`
 * among them, is an open task rather than a function.
 */
export function checkboxMeaning(character: string): CheckboxMeaning {
	return Object.prototype.hasOwnProperty.call(CHECKBOX_MEANINGS, character) ? CHECKBOX_MEANINGS[character] : "open";
}

const PRIORITY_EMOJI: Readonly<Record<Priority, string>> = {
	highest: "\u{1F53A}",
	high: "\u{23EB}",
	medium: "\u{1F53C}",
	low: "\u{1F53D}",
	lowest: "\u{23EC}",
};

const SCHEDULED_EMOJI = "\u{23F3}";
const DUE_EMOJI = "\u{1F4C5}";
const REPEAT_EMOJI = "\u{1F501}";

/*
 * The pieces a task line's head is made of, written once as source text so that
 * the reader below and `checkboxSlot` are built out of the same statement of
 * them rather than out of two. A feature needing to know where a checkbox would
 * go asks `checkboxSlot`; the one feature that restated these instead disagreed
 * with the reader about what one character is, in the first file ever written
 * under `src/features/`.
 */

/** Spaces and tabs before the marker, however many, none included. */
const INDENT = "[ \\t]*";

/** The three bullet markers. */
const BULLET_MARKER = "[-*+]";

/** The two numbered markers, `1.` and `1)`. */
const NUMBERED_MARKER = "\\d+[.)]";

/** The whitespace between the marker and what follows it, at least one. */
const GAP = "[ \\t]+";

/**
 * One character in brackets, captured. Read under the `u` flag, so the class is
 * one code point rather than one UTF-16 code unit and an emoji is one character
 * here as it is to the person who typed it.
 */
const BRACKETED = "\\[([^\\]])\\]";

/**
 * Indentation, a list marker, whitespace, and one character in brackets
 * followed by whitespace, a bare `\r`, or the end of the line. All four
 * Markdown list markers are accepted and whichever one was written is kept.
 *
 * `\r` counts as an end because a line the plugin reads may carry one with no
 * following `\n`; it is never part of `GAP`, so it never
 * separates the checkbox from a description that also starts with one, and it
 * is left where it was rather than consumed here — the description still
 * begins at it.
 *
 * Assembled from the fragments above rather than written out, so that the
 * marker set, the indentation rule and the bracket rule have one statement each
 * in this file and none anywhere else.
 */
const TASK_HEAD = new RegExp(
	`^(${INDENT})(${BULLET_MARKER}|${NUMBERED_MARKER})${GAP}${BRACKETED}(?=[ \\t\\r]|$)`,
	"u",
);

/** A bullet item, up to the first character of its content. */
const BULLET_HEAD = new RegExp(`^${INDENT}${BULLET_MARKER}${GAP}`, "u");

/** A numbered item, up to the first character of its content. */
const NUMBERED_HEAD = new RegExp(`^${INDENT}${NUMBERED_MARKER}${GAP}`, "u");

/** One bracketed character opening a line's content: the `[x]` of `- [x]text`. */
const OPENS_BRACKETED = new RegExp(`^${BRACKETED}`, "u");

/** The indentation a line opens with, which every line has, empty or not. */
const INDENT_RUN = new RegExp(`^${INDENT}`, "u");

/**
 * A date stamp: its emoji, an optional presentation selector, whatever spacing
 * was written, and an ISO date. The spacing is optional on the way in because
 * one of the plugins being absorbed writes a stamp without it.
 */
const SCHEDULED = /\u{23F3}\u{FE0F}?[ \t]*(\d{4}-\d{2}-\d{2})/u;
const DUE = /\u{1F4C5}\u{FE0F}?[ \t]*(\d{4}-\d{2}-\d{2})/u;

/**
 * The text a repeat rule is made of: ASCII letters, digits, commas, `!` and runs
 * of spaces — the characters of the Obsidian Tasks plugin's own bound,
 * `[a-zA-Z0-9, !]+`, so that a date, a tag or a comment after the rule is never
 * swallowed. It differs from Tasks in where the text ends. Tasks anchors its
 * pattern at the line's end, after the other fields are taken off, so any
 * character it does not know leaves it reading no rule. Here the text ends at a
 * blank, a bare `\r`, the line's end, a comment or the next field's sign, and a
 * line where it would end inside a word, or before another word, reads no rule
 * (`REPEAT_END`); anything else may follow it, a tag or a dash for one. The value
 * is captured without trailing blanks. It is a statement of the rule's *text* only; whether the text
 * is a rule the plugin can count dates from is the repeat-rule module's to say,
 * not the reader's.
 */
const REPEAT_TEXT = "[A-Za-z0-9,!]+(?: +[A-Za-z0-9,!]+)*";

/** The rule's sign, with its optional presentation selector, as a pattern fragment. */
const REPEAT_SIGN = "\\u{1F501}\\u{FE0F}?";

/** Any field's sign — a date, a priority, a rule — as a pattern fragment. */
const NEXT_FIELD_SIGN = "\\p{Extended_Pictographic}";

/**
 * Where a rule's text, or the bare sign before it, may stop: at a blank, a bare
 * `\r`, the end of the line, a comment (masked to `%` before the search) or the
 * next field's own sign — and only where the next word is not more of the same
 * sentence. A stop inside a word (`every week p` of `every week på söndag`,
 * `every week` of `every week's`) is no stop, so such a line reads no rule
 * rather than a rule cut off in the middle of what the person wrote.
 */
const REPEAT_END = `(?=[ \\t\\r%]|$|${NEXT_FIELD_SIGN})(?![ \\t]*[\\p{L}\\p{N}])`;
const REPEAT = new RegExp(`${REPEAT_SIGN}[ \\t]*(${REPEAT_TEXT})${REPEAT_END}`, "u");
const REPEAT_VALUE = new RegExp(`^${REPEAT_TEXT}$`, "u");

/**
 * The rule's sign with nothing after it: the stamp with an empty value. It reads
 * as no rule, and an edit fills it or removes it.
 */
const BARE_REPEAT = new RegExp(`${REPEAT_SIGN}${REPEAT_END}`, "u");

/** The rule's sign alone, wherever it stands and whatever follows it. */
const ANY_REPEAT_SIGN = new RegExp(REPEAT_SIGN, "u");

/** The next field's sign, the one stop text after the rule's sign always has. */
const NEXT_FIELD = new RegExp(NEXT_FIELD_SIGN, "u");

/** One priority emoji, whichever of the five it is. */
const PRIORITY = /[\u{1F53A}\u{23EB}\u{1F53C}\u{1F53D}\u{23EC}]\u{FE0F}?/u;

/**
 * A tag: `#` at the start of the description or after whitespace, then
 * Obsidian's tag characters, of which at least one must not be a digit. The
 * leading boundary is a captured group rather than a lookbehind.
 */
const TAG = /(^|[ \t])(#[\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;

/** One inline comment, taking the nearest closing `%%` so two do not merge. */
const COMMENT = /%%[\s\S]*?%%/gu;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

/** Half-open range of UTF-16 indexes into the raw line. */
interface Span {
	readonly start: number;
	readonly end: number;
}

/** A field found on the line: the whole stamp, and the part an edit replaces. */
interface FieldMatch {
	readonly whole: Span;
	readonly value: Span;
}

/**
 * What a line that is not a task line is, for the purpose of writing a checkbox
 * on it. `contentAt` is where the line's content starts: for a bullet or a
 * numbered item that is past its marker and the whitespace after it, and for
 * anything else it is where the indentation ends.
 */
export interface CheckboxSlot {
	readonly shape: "bullet" | "numbered" | "unspaced-bracket" | "plain";
	readonly contentAt: number;
}

/** What the plugin understands about one task line. */
export interface TaskLine {
	/** The line exactly as it was handed in. */
	readonly raw: string;
	/** The whitespace before the list marker, spaces and tabs as written. */
	readonly indent: string;
	/** The list marker itself — `-`, `*`, `+`, `1.` or `1)`. */
	readonly marker: string;
	/** The single character between the brackets, whatever it is. */
	readonly checkbox: string;
	/** What that character means. Anything outside the fixed five reads as open. */
	readonly meaning: CheckboxMeaning;
	/** Everything after the checkbox, with only the separating whitespace dropped. */
	readonly description: string;
	/** The scheduled date as `YYYY-MM-DD`, or null. */
	readonly scheduled: string | null;
	/** The due date as `YYYY-MM-DD`, or null. */
	readonly due: string | null;
	/** The priority level, or null. */
	readonly priority: Priority | null;
	/** Every tag, `#` included, in the order they appear. */
	readonly tags: readonly string[];
	/**
	 * The text after `🔁`, read as text and nothing more — `every week`, or
	 * `every weekday please`, which the repeat-rule module would refuse and this
	 * reader still sees — or null when the line carries none. Trailing blanks and
	 * anything a date, a tag or a comment follows it with are not part of it.
	 */
	readonly repeat: string | null;
	/**
	 * Every `%% … %%` comment, verbatim and including its delimiters. These are
	 * bookkeeping rather than part of what the task says; what is inside one
	 * belongs to the feature that put it there, and nothing here reads it.
	 */
	readonly comments: readonly string[];
}

/**
 * The fields an edit may change. Tags are the whole set the line should carry
 * afterwards, not a single value — task consistency is the feature that asked,
 * since it copies a task's whole tag set between its two copies.
 */
export type TaskField = "checkbox" | "scheduled" | "due" | "priority" | "tags" | "repeat";

/** The two kinds of date stamp the plugin writes. */
export type DateStampKind = "scheduled" | "due";

/** What each field's new value looks like. Null removes the field. */
export interface TaskFieldValue {
	checkbox: string;
	scheduled: string | null;
	due: string | null;
	priority: Priority | null;
	tags: readonly string[];
	repeat: string | null;
}

/**
 * Whether `fragment` is exactly one invisible `%% … %%` comment, ignoring space
 * around it. This is the one general fact the core knows about the marker: that
 * it is bookkeeping rather than words the person wrote. What is inside one is
 * the business of the feature that put it there.
 */
export function isBookkeepingComment(fragment: string): boolean {
	const trimmed = fragment.trim();
	if (trimmed.length < 4) return false;
	if (!trimmed.startsWith("%%") || !trimmed.endsWith("%%")) return false;
	return !trimmed.slice(2, -2).includes("%%");
}

/**
 * Whether `task` carries a bookkeeping comment: any `%% … %%` comment on its
 * line, this plugin's own marker or not. Such a line is already handled — filed
 * by Migration, paired by Task consistency — so Migration refuses it and
 * Review does not count it.
 */
export function hasBookkeepingComment(task: TaskLine): boolean {
	return task.comments.some(isBookkeepingComment);
}

/**
 * The date a task is followed up on: its scheduled date, or its due date when it
 * has none. Scheduled wins over due when a line carries both, the old plugin's own
 * rule (`docs/research/effortless-code-audit.md`, assumption 11,
 * `computeSync.ts:140-146`). The one statement of it: Task consistency's copy-in
 * and roll-over ask it to decide whether a task is due, and Review's
 * followed-tasks reader asks it to order a person's tasks, and a feature may not
 * import another's, so the rule lives here.
 */
export function relevantDate(line: TaskLine): string | null {
	return line.scheduled ?? line.due;
}

/**
 * The text one date stamp is written as: its emoji, one space, and the date.
 * `editTaskField` uses this to add a field that is not there yet, and a
 * feature that writes a stamp onto a line the core does not recognise as a
 * task — or shows one in a popup before anything is written — uses it too, so
 * that `⏳` and `📅` are held in one place rather than copied into a second
 * file.
 */
export function dateStampText(kind: DateStampKind, date: string): string {
	if (!ISO_DATE.test(date)) {
		throw new Error(`a date must be written YYYY-MM-DD, not ${JSON.stringify(date)}`);
	}
	const emoji = kind === "scheduled" ? SCHEDULED_EMOJI : DUE_EMOJI;
	return `${emoji} ${date}`;
}

/**
 * The text a repeat rule is written as: its emoji, one space, and the rule's
 * text. `editTaskField` uses this to add a rule that is not there yet, and a
 * feature that shows a rule in a popup or writes it onto a line the core does not
 * recognise as a task uses it too, so that `🔁` is held in this file and in no
 * feature.
 */
export function repeatStampText(text: string): string {
	return `${REPEAT_EMOJI} ${repeatTextChecked(text)}`;
}

/**
 * The sign and `text` as a report quotes them, `🔁 every weekday please`, or the
 * sign alone when `text` is empty. Unlike {@link repeatStampText} it is not
 * checked: a report quotes what the person wrote, which may be no rule the
 * plugin would write, and it is never written into a note.
 */
export function repeatQuote(text: string): string {
	return text === "" ? REPEAT_EMOJI : `${REPEAT_EMOJI} ${text}`;
}

/**
 * What follows the `🔁` sign on a line that carries it outside a comment while
 * {@link TaskLine.repeat} is null — `varje måndag`, or `""` for a bare sign — or
 * null when the line carries no sign or its rule was read. The text runs to the
 * next comment, the next field's sign or the line's end, without the blanks
 * around it. A rule the person wrote by hand that the reader cannot take (a letter
 * outside A–Z, a word joined on) is no rule the line can repeat by, and this
 * names it so it can be reported rather than dropped without a word.
 *
 * A line with no sign anywhere answers before it is read a second time, so
 * asking this of every task line costs a search, not a parse.
 */
export function uncapturedRepeat(line: TaskLine): string | null {
	if (line.repeat !== null || !line.raw.includes(REPEAT_EMOJI)) return null;
	const reading = read(line.raw);
	if (reading === null) return null;
	const masked = maskComments(reading.raw, reading.comments);
	const sign = ANY_REPEAT_SIGN.exec(masked.slice(reading.descriptionStart));
	if (sign === null) return null;
	const from = reading.descriptionStart + sign.index + sign[0].length;
	// `COMMENT` finds comments left to right, so the first one past the sign is the nearest.
	let to = reading.comments.find((span) => span.start >= from)?.start ?? masked.length;
	const next = NEXT_FIELD.exec(masked.slice(from, to));
	if (next !== null) to = from + next.index;
	return reading.raw.slice(from, to).trim();
}

/** `text` itself, or a throw when it would not read back as the rule it is. */
function repeatTextChecked(text: string): string {
	if (!REPEAT_VALUE.test(text)) {
		throw new Error(
			`a repeat rule is letters, digits, commas and spaces, not ${JSON.stringify(text)}`,
		);
	}
	return text;
}

/** Everything both public functions need, indexed into the raw line. */
interface Reading {
	readonly raw: string;
	readonly indent: string;
	readonly marker: string;
	readonly checkbox: Span;
	readonly descriptionStart: number;
	readonly comments: readonly Span[];
	readonly scheduled: FieldMatch | null;
	readonly due: FieldMatch | null;
	readonly priority: FieldMatch | null;
	readonly tags: readonly Span[];
	readonly repeat: FieldMatch | null;
	/** The rule's sign when it has no text, and so no `repeat`. */
	readonly bareRepeat: FieldMatch | null;
}

/**
 * Blanks out every comment so a field search cannot reach inside one. The
 * replacement is the same length as what it covers, so every index still points
 * at the same character of `raw`. `fill` is a space unless the search is for a
 * field whose text may itself hold spaces: a rule read across a space-filled
 * comment would take the words after the comment for more of the rule.
 */
function maskComments(raw: string, comments: readonly Span[], fill = " "): string {
	let masked = raw;
	for (const span of comments) {
		masked =
			masked.slice(0, span.start) +
			fill.repeat(span.end - span.start) +
			masked.slice(span.end);
	}
	return masked;
}

/** Finds one stamp in `masked`, reporting where it sits in the raw line. */
function findField(masked: string, from: number, pattern: RegExp): FieldMatch | null {
	const match = pattern.exec(masked.slice(from));
	if (match === null) return null;

	const start = from + match.index;
	const whole = { start, end: start + match[0].length };
	const captured = match[1];
	if (captured === undefined) return { whole, value: whole };

	const valueStart = start + match[0].lastIndexOf(captured);
	return { whole, value: { start: valueStart, end: valueStart + captured.length } };
}

/** Reads a line, or returns null if it is not a task line. */
function read(raw: string): Reading | null {
	if (raw.includes("\n")) return null;

	const head = TASK_HEAD.exec(raw);
	if (head === null) return null;

	// Measured from the character the head actually captured, not from a
	// constant: `TASK_HEAD` carries the `u` flag, so the checkbox may be one
	// code point of two UTF-16 units, and a constant would land inside it.
	const checkboxEnd = head[0].length - 1;
	const checkboxStart = checkboxEnd - (head[3] ?? "").length;

	let descriptionStart = head[0].length;
	while (
		descriptionStart < raw.length &&
		(raw[descriptionStart] === " " || raw[descriptionStart] === "\t")
	) {
		descriptionStart++;
	}

	const comments: Span[] = [];
	COMMENT.lastIndex = 0;
	for (let match = COMMENT.exec(raw); match !== null; match = COMMENT.exec(raw)) {
		comments.push({ start: match.index, end: match.index + match[0].length });
	}

	const masked = maskComments(raw, comments);
	// A fill no rule's text holds, so the rule ends where a comment begins.
	const ruleMasked = maskComments(raw, comments, "%");
	const repeat = findField(ruleMasked, descriptionStart, REPEAT);

	const tags: Span[] = [];
	const region = masked.slice(descriptionStart);
	TAG.lastIndex = 0;
	for (let match = TAG.exec(region); match !== null; match = TAG.exec(region)) {
		const start = descriptionStart + match.index + (match[1] ?? "").length;
		tags.push({ start, end: start + (match[2] ?? "").length });
	}

	return {
		raw,
		indent: head[1] ?? "",
		marker: head[2] ?? "",
		checkbox: { start: checkboxStart, end: checkboxEnd },
		descriptionStart,
		comments,
		scheduled: findField(masked, descriptionStart, SCHEDULED),
		due: findField(masked, descriptionStart, DUE),
		priority: findField(masked, descriptionStart, PRIORITY),
		tags,
		repeat,
		bareRepeat: repeat === null ? findField(ruleMasked, descriptionStart, BARE_REPEAT) : null,
	};
}

function priorityOf(raw: string, match: FieldMatch | null): Priority | null {
	if (match === null) return null;
	const emoji = raw.slice(match.whole.start, match.whole.end);
	for (const level of Object.keys(PRIORITY_EMOJI) as Priority[]) {
		if (emoji.startsWith(PRIORITY_EMOJI[level])) return level;
	}
	return null;
}

/**
 * Reads one task line. Returns null for anything that is not one — a plain
 * bullet, a blockquoted checkbox, empty brackets, more than one character
 * between them, or no whitespace after them.
 */
export function parseTaskLine(raw: string): TaskLine | null {
	const reading = read(raw);
	if (reading === null) return null;

	const checkbox = raw.slice(reading.checkbox.start, reading.checkbox.end);
	const { scheduled, due } = reading;

	return {
		raw,
		indent: reading.indent,
		marker: reading.marker,
		checkbox,
		meaning: checkboxMeaning(checkbox),
		description: raw.slice(reading.descriptionStart),
		scheduled: scheduled === null ? null : raw.slice(scheduled.value.start, scheduled.value.end),
		due: due === null ? null : raw.slice(due.value.start, due.value.end),
		priority: priorityOf(raw, reading.priority),
		tags: reading.tags.map((span) => raw.slice(span.start, span.end)),
		repeat: reading.repeat === null ? null : raw.slice(reading.repeat.value.start, reading.repeat.value.end),
		comments: reading.comments.map((span) => raw.slice(span.start, span.end)),
	};
}

/**
 * Whether a task line is an open task with the space checkbox: its checkbox
 * means `open` **and** is the space itself. The core reads every symbol it has
 * no meaning for as an open task, so `- [I] an idea` comes back `open`; it is
 * not one Effortless understands, and Migration does not file it.
 *
 * This answers the symbol question only. It is not by itself "a task Migration
 * could file": Migration also refuses a task outside the notes section of a day's
 * log (`sectionOfLine` in `vaultLayout.ts`) and one carrying a hidden
 * comment (`hasBookkeepingComment`). Migration's line check and Review's
 * open-task count both read all three, so neither can drift from the other
 * (features may not import one another, #14).
 */
export function isFilableOpen(task: TaskLine): boolean {
	return task.meaning === "open" && task.checkbox === " ";
}

/**
 * What shape a line that is **not** a task line has, for the one purpose of
 * putting a checkbox on it, and where its content starts.
 *
 * Four answers, which is what the whole question has:
 *
 * - `bullet` — a `-`, `*` or `+` item. A checkbox goes in at `contentAt`.
 * - `numbered` — a `1.` or `1)` item.
 * - `unspaced-bracket` — a bullet whose content opens with one bracketed
 *   character, `- [x]text`. Nothing after the closing bracket is looked at, so a
 *   bullet task line answers this too. Writing a checkbox in front of such a
 *   line would make it `- [ ] [x]text`.
 * - `plain` — anything else. `contentAt` is where its indentation ends, so a
 *   whole `- [ ] ` written there keeps the indentation the person gave it.
 *
 * **Ask `parseTaskLine` first.** This answers about a line that is not already a
 * task line. A bullet task line comes back `unspaced-bracket`, since its own
 * checkbox is a bracketed character opening its content — a second answer that
 * happens to warn the caller off. A numbered task line comes back `numbered`,
 * because the numbered answer is returned before the bracket test is reached, so
 * there is no such warning: asking `parseTaskLine` first is the caller's **only**
 * protection against writing a second checkbox onto `1. [x] Task`. It is the
 * order any caller wants anyway: a task line is stepped rather than given a
 * second checkbox.
 *
 * It exists so that no feature has to state the marker set, the indentation rule
 * or the bracket rule a second time. Every pattern it
 * reads is assembled from the same fragments `TASK_HEAD` is, so the day the
 * accepted markers change, the reader and this answer change together.
 */
export function checkboxSlot(line: string): CheckboxSlot {
	const numbered = NUMBERED_HEAD.exec(line);
	if (numbered !== null) return { shape: "numbered", contentAt: numbered[0].length };

	const bullet = BULLET_HEAD.exec(line);
	if (bullet !== null) {
		const contentAt = bullet[0].length;
		const shape = OPENS_BRACKETED.test(line.slice(contentAt)) ? "unspaced-bracket" : "bullet";
		return { shape, contentAt };
	}

	const indent = INDENT_RUN.exec(line);
	return { shape: "plain", contentAt: indent === null ? 0 : indent[0].length };
}

/** Replaces one span and leaves every byte outside it where it was. */
function splice(raw: string, span: Span, text: string): string {
	return raw.slice(0, span.start) + text + raw.slice(span.end);
}

/**
 * Removes a stamp along with one separating whitespace character — the one
 * before it, or the one after it where the stamp opens the description. One
 * character is the least that can go without leaving a double space behind.
 */
function removeField(raw: string, whole: Span): string {
	let { start } = whole;
	let { end } = whole;

	const before = raw[start - 1];
	if (before === " " || before === "\t") {
		start--;
	} else {
		const after = raw[end];
		if (after === " " || after === "\t") end++;
	}

	return splice(raw, { start, end }, "");
}

/**
 * Where a field the line does not carry is added: at the end of what the task
 * says, which is before any trailing bookkeeping comments and before any
 * trailing whitespace. Neither of those is part of the task's words.
 */
function insertionPoint(reading: Reading): number {
	const { raw } = reading;
	const floor = reading.checkbox.end + 1;
	let at = raw.length;
	// A bare `\r` ends the line and is not part of it: a field goes before it,
	// as it does on a line with no `\r`.
	if (at > floor && raw[at - 1] === "\r") at--;

	for (;;) {
		while (at > floor && (raw[at - 1] === " " || raw[at - 1] === "\t")) at--;
		const trailing = reading.comments.find((span) => span.end === at);
		if (trailing === undefined || trailing.start < floor) break;
		at = trailing.start;
	}

	return Math.max(at, floor);
}

function addField(raw: string, reading: Reading, text: string): string {
	const at = insertionPoint(reading);
	return `${raw.slice(0, at)} ${text}${raw.slice(at)}`;
}

/**
 * {@link insertionPoint}'s answer for `raw`, exported so a feature that must
 * find that boundary — where its own visible text or a trailing comment
 * begins — asks this rather than re-deriving it by probing `setComment` for
 * where an added field landed (`src/features/taskConsistency/copyIn.ts`'s own
 * `insertVisibleText` did exactly that before this existed, and keeps doing
 * so: this export is for a second caller, not a mandate to change the first).
 * Throws when `raw` is not a task line.
 */
export function insertionPointOf(raw: string): number {
	const reading = read(raw);
	if (reading === null) throw new Error(`not a task line: ${JSON.stringify(raw)}`);
	return insertionPoint(reading);
}

/**
 * Replaces the whole tag set with `value`. An existing tag kept in `value`
 * stays exactly where it sits; one dropped is removed along with its one
 * separating space, rightmost first, so a still-valid `reading.tags` span is
 * never read after a removal has shifted the text around it. A tag in `value`
 * with no existing match on the line is appended, in the order `value` gives
 * it, at the insertion point every other added field uses — never in the slot
 * a removed tag left, which is what keeps the kept tags in their original
 * order.
 */
function editTags(raw: string, reading: Reading, value: readonly string[]): string {
	const wanted = new Set(value);
	const existing = reading.tags.map((span) => ({ span, text: raw.slice(span.start, span.end) }));
	const existingTexts = new Set(existing.map((tag) => tag.text));

	const toRemove = existing
		.filter((tag) => !wanted.has(tag.text))
		.sort((a, b) => b.span.start - a.span.start);
	const toAdd = [...new Set(value)].filter((tag) => !existingTexts.has(tag));

	let result = raw;
	for (const { span } of toRemove) result = removeField(result, span);

	if (toAdd.length === 0) return result;

	const afterRemoval = read(result);
	if (afterRemoval === null) {
		throw new Error(`removing tags left an unparseable line: ${JSON.stringify(result)}`);
	}
	return addField(result, afterRemoval, toAdd.join(" "));
}

/** Sets, replaces or removes one date stamp. */
function editDate(
	raw: string,
	reading: Reading,
	found: FieldMatch | null,
	kind: DateStampKind,
	value: string | null,
): string {
	if (value === null) return found === null ? raw : removeField(raw, found.whole);
	if (!ISO_DATE.test(value)) {
		throw new Error(`a date must be written YYYY-MM-DD, not ${JSON.stringify(value)}`);
	}
	if (found === null) return addField(raw, reading, dateStampText(kind, value));
	return splice(raw, found.value, value);
}

/** Sets, replaces or removes the repeat rule's text. */
function editRepeat(raw: string, reading: Reading, text: string | null): string {
	const { repeat, bareRepeat } = reading;
	if (text === null) {
		const stamp = repeat ?? bareRepeat;
		return stamp === null ? raw : removeField(raw, stamp.whole);
	}
	repeatTextChecked(text);
	if (repeat !== null) return splice(raw, repeat.value, text);
	// A bare sign is filled: one space, then the text, after the sign.
	if (bareRepeat !== null) return splice(raw, { start: bareRepeat.whole.end, end: bareRepeat.whole.end }, ` ${text}`);
	return addField(raw, reading, repeatStampText(text));
}

/**
 * Whether `character` may be the one character between a task line's brackets.
 *
 * **The one statement of what a checkbox may hold.** `editTaskField` throws by
 * asking it, and the settings screen refuses a symbol by asking it — the screen
 * keeps only the wording, because this file has no person to tell. Written once
 * so that tightening it tightens both, rather than leaving a screen that accepts
 * a symbol the writer then throws on.
 *
 * One character means one code point, as `TASK_HEAD` reads it, so an emoji is
 * one. `\n` and `\r` are refused for the reason `editCalendarCell` refuses them:
 * a line that ends in the middle is two lines, and neither half reads back as a
 * task. `]` is refused because it closes the brackets.
 *
 * Nothing else is refused, `\t` included. The reason is `TASK_HEAD`'s own
 * checkbox group, which is `[^\]]` — anything but a closing bracket — so
 * `- [\t] Task` parses back with `checkbox` equal to `"\t"`. That is the
 * reader's measured behaviour rather than a hope about it, and #35 settled that
 * any character the plugin does not know is a legitimate open-task marker: a
 * character the reader accepts has to stay one the writer can put back, or a
 * task the plugin can read becomes one it cannot edit. `[` and `|` are odd in
 * the same harmless way.
 *
 * #66's reproduction asked for `\t` to be rejected alongside `]`, `\n` and `\r`.
 * It was not, deliberately, for the reason above.
 *
 * One thing is unsettled and is not a reason to tighten this: whether Obsidian's
 * own renderer, and the Tasks-style plugins, treat `- [\t] Task` as a task line
 * at all. Nothing in this repository establishes that and it cannot be
 * established headless. It is
 * #328's to settle on
 * screen, and settling it is now a change to this function alone.
 */
export function mayBeCheckbox(character: string): boolean {
	return [...character].length === 1 && character !== "]" && !/[\r\n]/u.test(character);
}

/**
 * Whether position `at` in `text` falls between the two halves of one
 * character.
 *
 * A character outside the basic plane is written as two UTF-16 units, a high
 * one followed by a low one, and only the pair means anything. The position
 * between them is not one an editor can hold a cursor on, and a stretch of text
 * that starts or ends there is half an emoji rather than a character.
 *
 * **The four boundary values are written here, once.** Nothing sweeps the tree
 * for a second copy — the one-code-point rule above has such a sweep, this does
 * not — so a copy elsewhere is a defect to read for rather than one a test
 * catches. They were written
 * out both in checkbox cycling's selection geometry and in the task-line
 * suite's difference helper, which is two answers to one question about text;
 * what may be one character is the core's to say.
 *
 * The rule stays what it is: a surrogate pair, not a grapheme cluster. A flag
 * or a family emoji is several characters by this answer, and nothing here
 * pretends otherwise.
 */
export function splitsACharacter(text: string, at: number): boolean {
	const high = text.charCodeAt(at - 1);
	const low = text.charCodeAt(at);
	return at > 0 && high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

/**
 * Changes one field of `raw` and hands back a line where every other byte is
 * identical. No whitespace is normalised, nothing is reordered, and the line is
 * never rebuilt from its parts.
 *
 * Removing a field that is not there changes nothing. Anything else the caller
 * gets wrong throws: a line that is not a task line, a checkbox that is not one
 * character or that would end the line, a date that is not `YYYY-MM-DD`, a repeat
 * rule that is not letters, digits, commas and spaces, and a
 * field this function has no case for.
 */
export function editTaskField<F extends TaskField>(
	raw: string,
	field: F,
	value: TaskFieldValue[F],
): string {
	const reading = read(raw);
	if (reading === null) throw new Error(`not a task line: ${JSON.stringify(raw)}`);

	// Widened from the type parameter to the field set itself, so that the
	// compiler can narrow it case by case and see that the default is reached
	// by nothing.
	const name: TaskField = field;
	switch (name) {
		case "checkbox": {
			const character = value as string;
			// What may sit between the brackets is `mayBeCheckbox`'s to say, and it
			// says it once for this writer and for the screen that has to tell a
			// person why their symbol was refused.
			if (!mayBeCheckbox(character)) {
				throw new Error(
					`a checkbox is one character, other than "]" or a line break, not ${JSON.stringify(character)}`,
				);
			}
			return splice(raw, reading.checkbox, character);
		}
		case "scheduled":
			return editDate(raw, reading, reading.scheduled, "scheduled", value as string | null);
		case "due":
			return editDate(raw, reading, reading.due, "due", value as string | null);
		case "priority":
			return editPriority(raw, reading, value as Priority | null);
		case "tags":
			return editTags(raw, reading, value as readonly string[]);
		case "repeat":
			return editRepeat(raw, reading, value as string | null);
		default: {
			// Every member of `TaskField` has its own case above, so nothing reaches
			// here and the assignment type-checks. Adding a member breaks that
			// assignment, which is the point: the day the field set grows, the
			// compiler says so rather than this branch quietly editing priority.
			const unknown: never = name;
			throw new Error(`unknown task field: ${String(unknown)}`);
		}
	}
}

/** Sets, replaces or removes the priority emoji. */
function editPriority(raw: string, reading: Reading, level: Priority | null): string {
	if (level === null) {
		return reading.priority === null ? raw : removeField(raw, reading.priority.whole);
	}
	if (reading.priority === null) return addField(raw, reading, PRIORITY_EMOJI[level]);
	return splice(raw, reading.priority.whole, PRIORITY_EMOJI[level]);
}

/**
 * The one comment on the line whose inside starts with `id` followed by a
 * colon, or null. Comments are already in document order, so the first match
 * is the first one on the line — the same first-wins rule `setComment` keeps.
 */
function findOwnComment(raw: string, reading: Reading, id: string): Span | null {
	const prefix = `${id}:`;
	for (const span of reading.comments) {
		const inside = raw.slice(span.start + 2, span.end - 2).trim();
		if (inside.startsWith(prefix)) return span;
	}
	return null;
}

/**
 * What is inside the one `%% <id>:… %%` comment that belongs to `id` — the text
 * after the colon, without the space that pads it, which is exactly what
 * `setComment` was given to write — or null when the line carries no such
 * comment or is not a task line. The first comment wins when two share the id,
 * and a comment carrying another id is never returned. This is the one way a
 * feature reads its own bookkeeping comment, so none parses it with a second
 * pattern.
 */
export function readComment(raw: string, id: string): string | null {
	const reading = read(raw);
	if (reading === null) return null;
	const span = findOwnComment(raw, reading, id);
	if (span === null) return null;
	return raw.slice(span.start + 2, span.end - 2).trim().slice(id.length + 1);
}

/**
 * Adds, replaces or removes the one `%% <id>:… %%` comment that belongs to
 * `id`. This is the only way a feature writes its own bookkeeping comment onto
 * a task line: a comment carrying a different id is never touched, so two
 * features' comments on one line cannot collide
 * (#15 G10 — what is inside
 * a feature's own comment is that feature's alone, and the core reads only the
 * id prefix to find it).
 *
 * `content` null removes the comment and the one space before it; a line with
 * no such comment is returned unchanged. `content` not null and no such
 * comment exists adds one at the same insertion point every other added field
 * uses. `content` not null and one exists replaces only what is inside it —
 * everything else on the line, this comment's own outer spacing included,
 * stays what `insertionPoint`/`addField` would have written.
 *
 * Two comments sharing one id: the first is the one read and written, matching
 * the "first wins" precedent #29
 * set for a collection's own heading.
 *
 * `content` containing `%%` is refused, since it would close the comment
 * early and split what a feature meant as one opaque string across two.
 */
export function setComment(raw: string, id: string, content: string | null): string {
	if (content !== null && content.includes("%%")) {
		throw new Error(`a comment cannot contain "%%": ${JSON.stringify(content)}`);
	}

	const reading = read(raw);
	if (reading === null) throw new Error(`not a task line: ${JSON.stringify(raw)}`);

	const existing = findOwnComment(raw, reading, id);

	if (content === null) return existing === null ? raw : removeField(raw, existing);

	const text = `%% ${id}:${content} %%`;
	if (existing === null) return addField(raw, reading, text);
	return splice(raw, existing, text);
}
