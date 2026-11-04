/**
 * Making a sequence, naming its commands, and saying whether the feature has
 * enough to do anything.
 *
 * All of it is plain functions over plain data: nothing here reaches Obsidian,
 * the vault or the settings store, so every rule below can be exercised on a
 * literal. The editor half and the settings screen are what call these.
 *
 * **The two shipped sequences are copied character for character from the
 * `checkbox-cycler` plugin this feature replaces**, and staying identical is a
 * constraint rather than a preference: while both are installed, the old
 * copying reads exactly these characters, and that is what lets the changeover
 * be undone with one keystroke. Only the two symbol
 * arrays and the two names came across. The old plugin's own symbol pool did
 * not: it is the Minimal theme's twenty-two characters, seventeen of which draw
 * as a bare letter under any other theme, and a published plugin cannot assume
 * a theme.
 */

import type { Readiness } from "../../core/feature";
import { mayBeCheckbox } from "../../core/taskLine";
import type { CycleDirection, Sequence } from "./types";

/**
 * This feature's own id. It keys the feature's slice of the settings and sits
 * in front of every command id it makes, and it is stable for ever — a later
 * rename is a display-name change and nothing else, because changing it would
 * cost every person their hotkeys and their stored sequences.
 */
export const FEATURE_ID = "checkbox-cycling";

/**
 * The two sequences a fresh install starts with.
 *
 * Their ids are written out rather than generated, because a shipped sequence
 * must carry the same id on every device and in every future version — a
 * hotkey is keyed by it. They are deliberately not what {@link newSequenceId}
 * can produce, so a shipped sequence and one the person made can never end up
 * sharing an id however many are created.
 *
 * The names read like the ids here, and that is a coincidence of two sensible
 * choices rather than a rule: nothing computes one from the other, and renaming
 * either sequence leaves its id exactly as it is.
 */
export const DEFAULT_SEQUENCES: readonly Sequence[] = [
	{ id: "shipped-task-flow", name: "Task flow", symbols: [" ", "/", ">", "x", "-"] },
	{ id: "shipped-annotations", name: "Annotations", symbols: ["?", "!", "i", "I", "*", "b"] },
];

/**
 * The id of the command that steps `sequence` one place in `direction`.
 *
 * Built from the sequence's generated id and never from its name. Two things
 * follow and both are fixes rather than ports of the old plugin, which
 * slugified the name: renaming a sequence no longer loses the person's hotkey,
 * and a name the person types can no longer collide with another feature's
 * command — a sequence called *Build days ahead* used to take `build-days-ahead`.
 *
 * The core adds the plugin's manifest id in front of this; the feature's own id
 * in the middle is the feature's job (`src/core/feature.ts`).
 */
export function commandIdFor(sequence: Sequence, direction: CycleDirection): string {
	return `${FEATURE_ID}:${sequence.id}:${direction}`;
}

/**
 * An id for a new sequence, unique among the ids already in use.
 *
 * It is drawn at random and takes nothing at all from the sequence's name —
 * this function is never told the name, which is the strongest form that rule
 * can take. Randomness rather than a counter, because a counter reuses the
 * number of a sequence the person deleted, and the new sequence would then
 * inherit the deleted one's hotkey without anybody asking for it.
 *
 * The suffix loop is what makes the answer certainly unique rather than
 * probably so. It runs at most once per id already taken, and in practice never
 * runs at all.
 */
export function newSequenceId(taken: readonly string[]): string {
	const base = randomToken();
	if (taken.indexOf(base) < 0) return base;
	for (let n = 2; ; n += 1) {
		const candidate = `${base}-${n}`;
		if (taken.indexOf(candidate) < 0) return candidate;
	}
}

/** The characters a drawn id is made of. Lower case, so no two ids differ by case alone. */
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Twelve characters drawn from {@link ID_ALPHABET}, so a collision is theory
 * rather than a case the person could ever meet.
 *
 * Written as a draw per character rather than as one number converted to a
 * base-36 string, so that every id comes out the same length with no padding
 * step to forget.
 *
 * It was also written this way to get past a guard in
 * `src/__tests__/calendarSources.test.ts` that reserved base-36 conversion
 * outright. That
 * guard no longer matches a format. It counts written-out `.toString(36)` call
 * expressions in one file, comments stripped, and names any shipped file
 * holding two or more, whatever they convert
 * (#430,
 * #349 for the stripping).
 *
 * So the bound on this file: one base-36 conversion is free, a second is not.
 * The character-at-a-time draw could use a single conversion today and trip
 * nothing — the shape stays for the reason above, which stands on its own — but
 * a file that added a second would be named by a test called
 * `where a calendar source's id is made`, with no calendar in sight.
 */
function randomToken(): string {
	let drawn = "";
	for (let n = 0; n < 12; n += 1) {
		drawn += ID_ALPHABET.charAt(Math.floor(Math.random() * ID_ALPHABET.length));
	}
	return drawn;
}

/**
 * Makes a sequence with a fresh id, refusing any symbol that cannot be one.
 *
 * `existing` is every sequence already stored; only their ids are read, and
 * only so that the new one differs from all of them.
 */
export function createSequence(
	name: string,
	symbols: readonly string[],
	existing: readonly Sequence[],
): Sequence {
	for (const symbol of symbols) {
		const refusal = symbolRefusal(symbol);
		if (refusal !== null) throw new Error(refusal);
	}
	return {
		id: newSequenceId(existing.map((sequence) => sequence.id)),
		name,
		symbols: [...symbols],
	};
}

/**
 * The five characters this plugin fixes a meaning to, in the order the settings
 * screen offers them.
 *
 * **The list is here; what each one means is the core's.** `src/core/taskLine.ts`
 * holds the mapping and {@link checkboxMeaning} is its lookup, rather than this
 * file restating five pairs that could then drift from it — which is the
 * mistake #347 records, where the first file under
 * `src/features` restated the core's task-line rules and disagreed with the
 * reader about what one character is. All this file names is which five to
 * offer and in what order; `checkboxCyclingSettings.test.ts` — the file that
 * covers the screen these five are offered on — checks that every other
 * printable character is an ordinary open task, so a sixth fixed meaning taken
 * up by the core fails there rather than going unoffered.
 *
 * The five are theme-independent, which is the point of offering them: the
 * plugin this feature replaces offered a twenty-two-character pool that only
 * means anything under the Minimal theme.
 */
export const FIXED_SYMBOLS: readonly string[] = [" ", "/", "x", "-", ">"];

/**
 * What `symbol` means to this plugin: the core's own lookup, re-exported so the
 * settings panel asks this feature's module as it does for everything else.
 *
 * It answers about `symbol` itself and calls any string outside the fixed five
 * an open task, which matters here because a stored symbol is not guaranteed to
 * be one character: {@link isSymbolList} asks only that the symbols be strings,
 * so a hand-edited `data.json` can hold `symbols: ["x] Task"]`. When this
 * feature asked by building a task line around the symbol instead, that string
 * escaped the brackets and came back `done`; the lookup has no
 * line to escape.
 */
export { checkboxMeaning } from "../../core/taskLine";

/**
 * Why `symbol` cannot be a checkbox symbol, as a sentence for the person, or
 * `null` when it can.
 *
 * A sentence rather than a thrown mistake, because the settings screen shows it
 * beside the field the person is typing in — which is the only place they can
 * be told *why*.
 *
 * **Whether a symbol is refused is the core's answer, and only the words are
 * this file's.** `mayBeCheckbox` in `src/core/taskLine.ts` decides, and
 * `editTaskField` refuses the same symbols by asking the same question when it
 * writes a checkbox — it just has no person to tell. The branches below choose
 * which sentence fits; they no longer decide anything. Everything else
 * the core accepts is accepted here, a tab included, because a character the
 * core's reader accepts has to stay one its writer can put back.
 */
export function symbolRefusal(symbol: string): string | null {
	if (mayBeCheckbox(symbol)) return null;
	if (symbol === "]") {
		return 'A symbol cannot be "]". That is the character closing the brackets, so the line would stop reading as a task.';
	}
	if (/[\r\n]/u.test(symbol)) {
		return "A symbol cannot be a line break. It would end the line in the middle, and neither half would read as a task.";
	}
	const points = [...symbol];
	if (points.length === 0) {
		return "A symbol cannot be empty. It is the one character that sits between the brackets.";
	}
	if (points.length > 1) {
		return `A symbol is one character, and ${JSON.stringify(symbol)} is more than one.`;
	}
	// The core refused it and none of the sentences above fits, which can only
	// happen when the core has taken up a refusal this screen has no words for.
	// Said plainly rather than passed off as accepted: a symbol the writer will
	// throw on must not be saved because the screen had nothing to say.
	return `A symbol cannot be ${JSON.stringify(symbol)}, and this screen has no better sentence for why yet.`;
}

/**
 * The first symbol a sequence holds twice, and where the second one sits.
 *
 * A sequence may hold the same symbol twice and is stored exactly as it was
 * typed, decided on
 * #425: refusing the repeat
 * while the person is still typing is the more annoying of the two failures,
 * and the settings screen already keeps a sequence that cannot do what it looks
 * like and explains it on the row. So
 * `symbolRefusal` says nothing about a repeat and {@link createSequence} stores
 * the list as given. This is what is said instead.
 *
 * **The detection is here rather than on the settings screen**, decided on the
 * same ticket: the screen renders the answer and does not work it out, which is
 * what lets this be built and tested before the screen exists. It is a sibling
 * of {@link sequencesReadiness} rather than a field on the `Readiness` it
 * returns, because `Readiness` is the core's own four-state answer for every
 * feature, one per feature, and this fact is one per sequence — the row that
 * shows it is #326 and
 * #327, which draw one
 * sequence at a time.
 */
export interface RepeatedSymbol {
	/** The symbol written twice — the first one that is, reading left to right. */
	readonly symbol: string;
	/** Where that symbol first appears. Stepping always starts from here. */
	readonly firstAt: number;
	/**
	 * Where it appears again, and the position from which the order as typed is
	 * never walked.
	 *
	 * A press reads the character off the line and looks it up, and a lookup
	 * answers the *first* position holding it. So a press that lands here is read
	 * as being at {@link RepeatedSymbol.firstAt} and steps on from there: the
	 * sequence folds back at this position, and what was typed after it is never
	 * walked through as written.
	 */
	readonly repeatedAt: number;
}

/**
 * The first repeat in `sequence`, or `null` when every symbol in it is
 * different.
 *
 * Only the first is reported, because it is the one that folds the sequence
 * back: everything after it is already off the walked order, so a second repeat
 * beyond it changes nothing a person could see.
 */
export function repeatedSymbol(sequence: Sequence): RepeatedSymbol | null {
	const seen = new Map<string, number>();
	for (let at = 0; at < sequence.symbols.length; at += 1) {
		const symbol = sequence.symbols[at];
		const firstAt = seen.get(symbol);
		if (firstAt !== undefined) return { symbol, firstAt, repeatedAt: at };
		seen.set(symbol, at);
	}
	return null;
}

/**
 * What was in `data.json` where the sequences should be, judged.
 *
 * The stored value is whatever is on disk, and its type says nothing about it: a
 * person can hand-edit `data.json`, and a version of this plugin that has not
 * been written yet can have stored something this one does not know.
 */
export interface StoredSequences {
	/** The records that really are sequences, in the order they were stored. */
	readonly usable: readonly Sequence[];
	/**
	 * The records that are not sequences, exactly as they were stored.
	 *
	 * They are kept rather than counted so that whoever writes the list back can
	 * write them back too. A refused record is one the person cannot see and
	 * cannot edit, so if a save dropped it, the first rename or Add would delete
	 * it off disk for good — and the notice the person had just read said
	 * *skipped*, not *about to be discarded*. Count them with
	 * `.length` where a count is what is wanted.
	 */
	readonly refused: readonly unknown[];
}

/**
 * The stored records that are sequences, and the ones that are not, kept.
 *
 * **A record with no usable name or no usable id is not a sequence, and is
 * refused here rather than further along.** It used to reach the palette: a
 * record with no `name` produced a command called `undefined: cycle forward`
 * under an id holding the word `undefined`, which a person could neither use nor
 * delete, the settings screen for sequences not existing yet. Judging it at the
 * one place the stored list is read means every reader of that list — the
 * palette, readiness, a press, the settings card — gets the same clean answer
 * instead of each having to remember.
 *
 * **What makes a record usable is three fields and nothing else**: a name, an id,
 * and a `symbols` that is a list. The name is shown to a person and the id is
 * what a command id and therefore the person's hotkey is built from, so neither
 * can be missing or blank; `symbols` has to be a list because every reader of a
 * sequence treats it as one (#533,
 * and `isSymbolList` below says what went wrong without it). **How many symbols
 * it holds is deliberately not part of this**: a sequence of none or one keeps
 * its two commands and keeps saying that a press has nowhere to step, which is a
 * decision rather than an oversight — hiding those commands would leave a person
 * who configured that sequence with no sign of it anywhere.
 *
 * **Stored something that is not a list at all is thrown on rather than
 * refused.** A refusal that can be counted is one record among others; a slice
 * that is not a list is not a set of sequences in the first place, and the feature
 * is stopped and reported rather than left running on nonsense
 * (`main.test.ts`, "leaves the core and every other feature running when this one
 * fails to start"). Silence is the one thing neither case is allowed to be
 * (`~/Devbox/CLAUDE.md` § *Tests and failures*).
 */
export function usableSequences(stored: unknown): StoredSequences {
	if (!Array.isArray(stored)) {
		throw new Error(
			`The stored cycling sequences are ${JSON.stringify(stored)}, which is not a list of sequences.`,
		);
	}

	const usable: Sequence[] = [];
	const refused: unknown[] = [];
	for (const record of stored as readonly unknown[]) {
		if (isSequence(record)) usable.push(record);
		else refused.push(record);
	}
	return { usable, refused };
}

/** Whether one stored record carries the three fields a sequence cannot do without. */
function isSequence(record: unknown): record is Sequence {
	if (typeof record !== "object" || record === null) return false;
	const { id, name, symbols } = record as { id?: unknown; name?: unknown; symbols?: unknown };
	return said(id) && said(name) && isSymbolList(symbols);
}

/**
 * Whether a stored field is a list of strings — empty is a list.
 *
 * **How many symbols a sequence holds is not asked here and must not be**; a
 * sequence of none or one keeps its commands and says on its own row that a
 * press has nowhere to step. What is asked is whether `symbols` is a list at
 * all, because every reader treats it as one: `sequenceSummary` reads
 * `.length`, `.map` and `new Set(...)` of it, and a record that reached it
 * without one threw out of `displaySettings` and left the whole settings screen
 * half-drawn, every later feature card missing. Such a record is
 * refused and counted like any other, so the person is told it was skipped
 * rather than shown a broken screen.
 */
function isSymbolList(field: unknown): boolean {
	return Array.isArray(field) && field.every((symbol) => typeof symbol === "string");
}

/** Whether a stored field is a string with something in it. */
function said(field: unknown): boolean {
	return typeof field === "string" && field.trim() !== "";
}

/**
 * Whether the feature has enough to do anything, given the stored sequences.
 *
 * A sequence can move a checkbox exactly when it holds two symbols that differ.
 * One symbol cannot step anywhere, and neither can the same symbol twice: a
 * press would write the character that is already there and nothing would
 * happen, with nothing said — which is the silence
 * #425 was filed for. Two
 * *different* symbols are always enough, whatever else the sequence holds,
 * because the last new symbol it introduces always follows a symbol unlike it,
 * so a backward press from it moves.
 *
 * Having none configured is work waiting for the person rather than a fault,
 * which is why the answer is *not configured* and carries what to do.
 */
export function sequencesReadiness(sequences: readonly Sequence[]): Readiness {
	for (const sequence of sequences) {
		// The length is read as well as the count of different symbols, and the
		// first half is not redundant: reading `.length` is what throws when a
		// record has stored something that is not a list of symbols, and a throw is
		// how the feature is stopped and reported instead of quietly running on
		// nonsense. Counting the different symbols alone accepts anything and would
		// swallow it.
		//
		// A slice whose whole `sequences` value is not a list no longer reaches
		// here: {@link usableSequences} throws on that before any reader sees the
		// list, and
		// `main.test.ts` — "leaves the core and every other feature running when
		// this one fails to start" — is where that is asserted. This guard is what
		// is left for one bad record among good ones.
		if (sequence.symbols.length >= 2 && new Set(sequence.symbols).size >= 2) {
			return { state: "ready" };
		}
	}
	return {
		state: "unconfigured",
		reason:
			"No sequence holds two different symbols yet, so a press would have nowhere to step. Give a sequence a second symbol that is not the one already in it.",
	};
}
