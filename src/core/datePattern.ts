/**
 * Writing a date out under a filename pattern, and reading one back.
 *
 * The notation is the one Obsidian's own daily notes use, so `YYYY/MM/YYYY-MM-DD`
 * puts the day in folders of its own. This module knows nothing about vaults,
 * layouts or settings: it takes a pattern, a `Date` and the month/weekday names
 * to write and read, so it can be exercised without building a layout or an
 * Obsidian at all. `vaultLayout.ts` is what supplies the pattern and the names,
 * reading the app's own current language and the one active immediately before
 * it last changed.
 *
 * **A month has two forms in some languages** — Russian, Polish and Catalan
 * among them: one for the month on its own (`январь`) and one for the month
 * inside a date (`января`, as in `5 января`). The core Daily notes plugin names
 * a note through moment, which by default writes the in-date form when the
 * format string has a day token, then whitespace or a bracketed literal, then
 * the month (`D MMMM` and `D [de] MMMM` do, `D-MMMM` and `MMMM D` do not;
 * `node_modules/moment/moment.js:963`), and some languages carry a rule of
 * their own in its place: `es`, `nl` and `fy` give the short month without its
 * dot inside `-MMM-` (`node_modules/moment/locale/es.js:40-48`), `ca` and
 * `gom-deva` decide by their own patterns. So this module does what moment
 * does, or the day's log would be named differently from the one Daily notes
 * names on the same pattern. **Writing** takes the words the whole pattern
 * calls for, decided once per pattern by the caller's own answer
 * ({@link DateNames.monthsWrittenUnder}, or {@link DateNames.inDateForm}
 * where only that is given); this module carries no rule of its own for it. **Reading** accepts a month word in either form, so a log written under
 * either still counts as a day's log.
 */

/**
 * The month and weekday names a pattern is written and read with — full and
 * abbreviated, in the order {@link formatField} and {@link fieldPattern}
 * index them by: `months`/`monthsShort` January-first, `weekdays`/`weekdaysShort`
 * Sunday-first, matching `Date.getMonth()` and `Date.getDay()`.
 *
 * `weekdays`/`weekdaysShort` are write-only: a weekday's word is never checked
 * against these on the way in — see {@link dateFromMatch}'s `dddd`/`ddd` case
 * for why a name's weekday is decoration rather than a constraint.
 *
 * **`months` and `monthsShort` are the standalone form of each month, the one
 * written when the month is not part of a date.** A language with a second
 * form for a month inside a date lists it in `monthsInDate` and
 * `monthsShortInDate`, and `inDateForm` says for which pattern it is written;
 * all three are left out for a language of one form, which reads and writes
 * `months` and `monthsShort` alone.
 */
export interface DateNames {
	readonly months: readonly string[];
	readonly monthsShort: readonly string[];
	readonly weekdays: readonly string[];
	readonly weekdaysShort: readonly string[];
	readonly monthsInDate?: readonly string[];
	readonly monthsShortInDate?: readonly string[];
	/**
	 * Whether `format` — a whole date pattern, such as `D MMMM` — is written
	 * with the in-date form of the full month (`field` `"MMMM"`) or of the short
	 * month (`"MMM"`). Supplied by the caller, who has the language's own
	 * answer: this module never learns the rule behind it.
	 */
	readonly inDateForm?: (field: "MMMM" | "MMM", format: string) => boolean;
	/**
	 * The twelve words, January first, the language writes for the full month
	 * (`field` `"MMMM"`) or the short one (`"MMM"`) in a date written under the
	 * whole of `format` — moment's own answer for that format, so a language whose
	 * rule looks at more than a day number before the month (`es` gives `ene`
	 * inside `DD-MMM-YYYY` and `ene.` in `D MMM`) is written and read as moment
	 * does. Takes the place of `inDateForm` where both are given.
	 */
	readonly monthsWrittenUnder?: (field: "MMMM" | "MMM", format: string) => readonly string[];
	/**
	 * What {@link compilePattern} fills in for the reader: the words
	 * `monthsWrittenUnder` gave for the pattern being read, which the reader
	 * accepts beside the standalone and in-date lists. Not for a caller to set.
	 */
	readonly readAlso?: { readonly months: readonly string[]; readonly monthsShort: readonly string[] };
}

/**
 * The names one pattern writes its months with: `names` itself when it holds
 * one form per month, and otherwise `names` with `months` and `monthsShort`
 * replaced by the words the language writes for the fields `format` uses —
 * `names.monthsWrittenUnder`'s answer for the whole pattern where it is given,
 * and otherwise the in-date lists for whichever of the two `names.inDateForm`
 * says `format` calls for. The decision is about the whole pattern, as moment's
 * own is, and not about one field in it.
 */
function namesWrittenUnder(names: DateNames, format: string, usesFull: boolean, usesShort: boolean): DateNames {
	if (names.monthsWrittenUnder !== undefined) {
		if (!usesFull && !usesShort) return names;
		return {
			...names,
			months: usesFull ? names.monthsWrittenUnder("MMMM", format) : names.months,
			monthsShort: usesShort ? names.monthsWrittenUnder("MMM", format) : names.monthsShort,
		};
	}
	if (names.inDateForm === undefined) return names;
	const months = names.monthsInDate !== undefined && names.inDateForm("MMMM", format);
	const monthsShort = names.monthsShortInDate !== undefined && names.inDateForm("MMM", format);
	if (!months && !monthsShort) return names;
	return {
		...names,
		months: months ? names.monthsInDate : names.months,
		monthsShort: monthsShort ? names.monthsShortInDate : names.monthsShort,
	};
}

/** `names` with the words `format` writes added for the reader to accept (see {@link DateNames.readAlso}). */
function namesReadUnder(names: DateNames, format: string, usesFull: boolean, usesShort: boolean): DateNames {
	if (names.monthsWrittenUnder === undefined || (!usesFull && !usesShort)) return names;
	return {
		...names,
		readAlso: {
			months: usesFull ? names.monthsWrittenUnder("MMMM", format) : [],
			monthsShort: usesShort ? names.monthsWrittenUnder("MMM", format) : [],
		},
	};
}

/** `names` with every month written in one of its two forms: the in-date lists, or the standalone ones. */
function namesInOneForm(names: DateNames, inDate: boolean): DateNames {
	return {
		...names,
		months: inDate ? (names.monthsInDate ?? names.months) : names.months,
		monthsShort: inDate ? (names.monthsShortInDate ?? names.monthsShort) : names.monthsShort,
	};
}

/**
 * The names a pattern is compiled with: the ones to write, and read with
 * first; and, optionally, a second table to fall back to on the way in when
 * the first does not recognise a month word — the language active
 * immediately before {@link current}'s last changed, so a name already
 * written under it still reads back.
 */
export interface DateNameTables {
	readonly current: DateNames;
	readonly previous?: DateNames;
}

/**
 * The names this module wrote before issue #645, and what every caller here
 * gets when it hands over none of its own — every test in this file among
 * them, so a suite that is not about language keeps reading exactly as it did
 * before that ticket.
 */
export const ENGLISH_NAMES: DateNames = {
	months: [
		"January",
		"February",
		"March",
		"April",
		"May",
		"June",
		"July",
		"August",
		"September",
		"October",
		"November",
		"December",
	],
	monthsShort: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
	weekdays: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
	weekdaysShort: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
};

const DEFAULT_NAMES: DateNameTables = { current: ENGLISH_NAMES };

/** A date pattern, taken apart: literal text and the fields between it. */
type Piece = { literal: string } | { field: DateToken };

/**
 * A pattern already taken apart and, if it reads dates back, already given its
 * one reader `RegExp` — so a caller writing or reading many dates under the
 * same pattern pays tokenising and compiling once rather than once per date.
 */
export interface CompiledPattern {
	/** The date written out under this pattern, with `.md` on the end. */
	write(date: Date): string;
	/**
	 * The same date written out with the month in each form {@link write} did
	 * not use — the standalone form where it wrote the in-date one, and the
	 * reverse — each with `.md` on the end. Empty for a language of one form,
	 * where there is no other name.
	 */
	writeAlso(date: Date): readonly string[];
	/** The date `name` holds under this pattern, or `null` when it holds none. */
	read(name: string): Date | null;
}

/**
 * Takes `pattern` apart once and builds the `RegExp` that reads a name back
 * under it, so that {@link CompiledPattern.write} and
 * {@link CompiledPattern.read} can be called many times without either cost
 * being paid again. {@link formatName} and {@link readName} are this, called
 * once for a single date or name.
 *
 * `names` defaults to {@link ENGLISH_NAMES} alone, so a caller that does not
 * care about language — every test in this file among them — keeps reading
 * exactly as it did before issue #645. `vaultLayout.ts` is the one caller that
 * hands over a real `previous` table, built from the app's own language.
 *
 * The form of each month written is decided here, once, from the whole of
 * `pattern` ({@link namesWrittenUnder}), so a `{{date:FORMAT}}` placeholder
 * compiled on its own format is written in the form that format calls for and
 * not the one a filename pattern does.
 *
 * The reading `RegExp` carries the `u` flag for the same reason every other
 * `RegExp` built from a person's own text does in this codebase: literal
 * Unicode text — a month or weekday name among them, since {@link fieldPattern}
 * now matches those literally rather than through a character class — is
 * handled correctly whether or not it needs a surrogate pair, rather than by
 * an engine mode that predates the module having any non-English text in it
 * at all.
 */
export function compilePattern(pattern: string, given: DateNameTables = DEFAULT_NAMES): CompiledPattern {
	const pieces = tokenise(pattern);
	let usesFull = false;
	let usesShort = false;
	for (const piece of pieces) {
		if (!("field" in piece)) continue;
		if (piece.field === "MMMM") usesFull = true;
		else if (piece.field === "MMM") usesShort = true;
	}
	const names: DateNameTables =
		usesFull || usesShort
			? {
					current: namesReadUnder(given.current, pattern, usesFull, usesShort),
					...(given.previous ? { previous: namesReadUnder(given.previous, pattern, usesFull, usesShort) } : {}),
				}
			: given;

	let source = "^";
	const fields: DateToken[] = [];
	for (const piece of pieces) {
		if ("literal" in piece) {
			source += escapeRegExp(piece.literal);
			continue;
		}
		fields.push(piece.field);
		source += fieldPattern(piece.field, names);
	}
	const regex = new RegExp(`${source}$`, "u");

	const render = (date: Date, writing: DateNames): string => {
		let name = "";
		for (const piece of pieces) {
			name += "literal" in piece ? piece.literal : formatField(piece.field, date, writing);
		}
		return `${name}.md`;
	};
	const writing = namesWrittenUnder(given.current, pattern, usesFull, usesShort);

	return {
		write: (date) => render(date, writing),
		writeAlso(date: Date): readonly string[] {
			if (!usesFull && !usesShort) return [];
			const written = render(date, writing);
			const others = [true, false].map((inDate) => render(date, namesInOneForm(names.current, inDate)));
			return others.filter((name, i) => name !== written && others.indexOf(name) === i);
		},
		read(name: string): Date | null {
			const match = regex.exec(name);
			return match === null ? null : dateFromMatch(match, fields, names);
		},
	};
}

/** The date written out under `pattern`, with `.md` on the end. See {@link compilePattern} for `names`. */
export function formatName(date: Date, pattern: string, names: DateNameTables = DEFAULT_NAMES): string {
	return compilePattern(pattern, names).write(date);
}

/**
 * One date field written out as text.
 *
 * Every token in {@link FIELDS} has a case of its own, and `default:` assigns
 * to `never`, so a token added to that table and not to this switch is a build
 * error rather than a filename named beside the day the person is actually
 * writing in. The throw stays underneath it for a token that
 * reaches here at run time from a pattern somebody typed. Exported so a test
 * can walk the table rather than listing the tokens by hand.
 *
 * `names` defaults to {@link ENGLISH_NAMES}, the same default
 * {@link compilePattern} uses, so a call with no names is unchanged from
 * before issue #645.
 */
export function formatField(field: DateToken, date: Date, names: DateNames = ENGLISH_NAMES): string {
	switch (field) {
		case "YYYY":
			return pad(date.getFullYear(), 4);
		case "YY":
			return pad(date.getFullYear() % 100, 2);
		case "MMMM":
			return names.months[date.getMonth()];
		case "MMM":
			return names.monthsShort[date.getMonth()];
		case "MM":
			return pad(date.getMonth() + 1, 2);
		case "M":
			return String(date.getMonth() + 1);
		case "DD":
			return pad(date.getDate(), 2);
		case "D":
			return String(date.getDate());
		case "dddd":
			return names.weekdays[date.getDay()];
		case "ddd":
			return names.weekdaysShort[date.getDay()];
		default: {
			// Every member of `DateToken` has its own case above, so nothing
			// reaches here and the assignment type-checks. Adding a token to
			// `FIELDS` breaks it, which is the point.
			const unknown: never = field;
			throw new Error(
				`Effortless cannot write "${String(unknown)}" into a daily-log filename: formatField has no case for it. A field added to FIELDS must be added to formatField, readName and fieldPattern as well.`,
			);
		}
	}
}

/**
 * Whether this module can write a date out under `pattern` and read one back.
 *
 * The settings screen saves on every keystroke, so a pattern on its way to
 * `YYYY-MM-DD` is stored as `Y`, then `YY`, then `YYY`, and {@link tokenise}
 * refuses the runs that are not whole fields. A caller with a yes/no question
 * to answer asks here rather than catching, so that the refusal it wants
 * becomes an answer and every other failure still escapes.
 *
 * The `catch` reaches the tokeniser alone. {@link formatField} and
 * {@link fieldPattern} are not called from here, so issue #88's guards — a
 * field added to {@link FIELDS} and to neither of them — still throw as loudly
 * as they did.
 */
export function understandsPattern(pattern: string): boolean {
	try {
		tokenise(pattern);
		return true;
	} catch {
		return false;
	}
}

/** The date `name` holds under `pattern`, or `null` when it holds none. See {@link compilePattern} for `names`. */
export function readName(name: string, pattern: string, names: DateNameTables = DEFAULT_NAMES): Date | null {
	return compilePattern(pattern, names).read(name);
}

/**
 * The date `match`'s captured groups spell under `fields`, in the order
 * {@link compilePattern} captured them, or `null` when they do not spell a
 * real one. `names.current` is tried first for a month word, `names.previous`
 * only when it is given and `current` did not recognise the word — the one
 * language-change step {@link DateNameTables} carries.
 */
function dateFromMatch(
	match: RegExpExecArray,
	fields: readonly DateToken[],
	names: DateNameTables,
): Date | null {
	let year: number | null = null;
	let month = 1;
	let dayOfMonth = 1;
	for (let i = 0; i < fields.length; i += 1) {
		const value = match[i + 1];
		// Held in a `const` so that the `default:` branch can be closed against
		// it; a switch on `fields[i]` narrows nothing.
		const token = fields[i];
		switch (token) {
			case "YYYY":
				year = Number(value);
				break;
			case "YY": {
				// The same two-digit window the app's own date library uses.
				const short = Number(value);
				year = short <= 68 ? 2000 + short : 1900 + short;
				break;
			}
			case "MMMM":
			case "MMM": {
				const named = monthFromName(value, names);
				if (named === null) return null;
				month = named;
				break;
			}
			case "MM":
			case "M":
				month = Number(value);
				break;
			case "DD":
			case "D":
				dayOfMonth = Number(value);
				break;
			case "dddd":
			case "ddd":
				// A weekday name says nothing the date does not; the round trip
				// in parseDailyLogDate is what checks it was the right one. It
				// is named here rather than left to `default:` so that the
				// branch below can be closed the way the other two switches are.
				break;
			default: {
				// The same guard as formatField's and fieldPattern's, and the
				// only one of the three with no test driving it. Those two are
				// exported, so a test can cast a made-up token straight into
				// them; this switch is not a function of its own and has no
				// such door. Exporting one to reach it would widen the module's
				// public surface for a test alone, and a test that cannot fail
				// would prove nothing, so the `never` assignment the compiler
				// checks is the whole of this branch's proof.
				const unknown: never = token;
				throw new Error(
					`Effortless cannot read "${String(unknown)}" back out of a daily-log filename: readName has no case for it. A field added to FIELDS must be added to formatField, readName and fieldPattern as well.`,
				);
			}
		}
	}
	if (year === null) return null;

	const date = new Date(year, month - 1, dayOfMonth);
	const real =
		date.getFullYear() === year &&
		date.getMonth() === month - 1 &&
		date.getDate() === dayOfMonth;
	return real ? date : null;
}

/**
 * The regular-expression group that reads one date field back.
 *
 * Named cases, a `never` assignment and a throw underneath it for the same
 * reason as {@link formatField}, and exported for the same test.
 *
 * `names` defaults to {@link ENGLISH_NAMES}, the same default every other
 * caller here uses, and only the four name fields read it: a numeral field's
 * group is the same whatever language is in play.
 *
 * **A month or weekday field is matched against the actual names it can be
 * written with, not a generic run of characters**. A character
 * class wide enough to admit French's trailing dot (`janv.`), a CJK name's
 * fused digit (`1月`), and an Indic name's combining marks also admits a
 * *run* of digits — and a name field sits directly against a numeral field in
 * plenty of patterns (`MMMD`, `YYYYMMM`), where a class that can eat a digit
 * eats into the next field's own digits before that field ever sees them,
 * losing names a plain letter class never had to worry about
 * (measured: widening the class this way made 12 more of
 * `vaultLayout.test.ts`'s 1,288 generated patterns lose a day, not fewer).
 * Matching the literal names instead cannot reach past where a real name
 * ends, whatever characters that name happens to be written with.
 */
export function fieldPattern(field: DateToken, names: DateNameTables = DEFAULT_NAMES): string {
	switch (field) {
		case "YYYY":
			return "(\\d{4})";
		case "YY":
		case "MM":
		case "DD":
			return "(\\d{2})";
		case "M":
		case "D":
			return "(\\d{1,2})";
		case "MMMM":
			return namedFieldPattern(names, "months");
		case "MMM":
			return namedFieldPattern(names, "monthsShort");
		case "dddd":
			return namedFieldPattern(names, "weekdays");
		case "ddd":
			return namedFieldPattern(names, "weekdaysShort");
		default: {
			const unknown: never = field;
			throw new Error(
				`Effortless cannot read "${String(unknown)}" back out of a daily-log filename: fieldPattern has no case for it. A field added to FIELDS must be added to formatField, readName and fieldPattern as well.`,
			);
		}
	}
}

/**
 * The one-based month `value` names under `names.current`, or `names.previous`
 * when `current` does not recognise it and a `previous` table was given — the
 * fallback that lets a name written under the language active immediately
 * before the app's own last changed still be read.
 */
function monthFromName(value: string, names: DateNameTables): number | null {
	return monthIndex(value, names.current) ?? (names.previous ? monthIndex(value, names.previous) : null);
}

/** The one-based month `value` names under `table`, matched against its full and its short name, in each of the month's two forms where it has two. */
function monthIndex(value: string, table: DateNames): number | null {
	const wanted = value.toLowerCase();
	for (let i = 0; i < table.months.length; i += 1) {
		const words = [
			table.months[i],
			table.monthsShort[i],
			table.monthsInDate?.[i],
			table.monthsShortInDate?.[i],
			table.readAlso?.months[i],
			table.readAlso?.monthsShort[i],
		];
		if (words.some((word) => word !== undefined && wanted === word.toLowerCase())) return i + 1;
	}
	return null;
}

/**
 * A run of one character: the key itself, or it repeated, up to the length of
 * the longest token {@link FIELDS} holds.
 *
 * Four is the ceiling because `YYYY`, `MMMM` and `dddd` are the longest rows.
 * A table that ever needs five adds one arm here, and the build says so on the
 * day rather than accepting the row silently.
 */
type Run<K extends string> = K | `${K}${K}` | `${K}${K}${K}` | `${K}${K}${K}${K}`;

/**
 * Passes a field table straight through, having held every token in it to being
 * a run of the key it is filed under.
 *
 * {@link isDateToken} looks a run of letters up by its first character alone,
 * so a row whose tokens begin with anything else declares a token no pattern
 * can reach: `W: ["ww"]` would force all three switches to gain a `ww` case
 * that no input arrives at, in the one module whose whole point is that
 * {@link FIELDS} is where the token set is decided.
 *
 * **The constraint is a run and not merely the key followed by anything**. Checking
 * the first character alone still let `M: ["Mx"]` through, and `Mx` is the same
 * defect from the other side: the compiler then demands a case for it in all
 * three switches and no pattern anyone can type reaches any of them. Measured
 * against the real table: every current row still type-checks, `W: ["ww"]` is
 * still rejected, `M: ["Mx"]` is rejected now too, and {@link DateToken} comes
 * out unchanged.
 *
 * By the compiler rather than by a test, which issue #147's own reasoning
 * prefers where it reaches, and it reaches here: the constraint was measured
 * not to disturb the `as const` inference {@link DateToken} is derived from.
 * The identity function is what makes it expressible — a `satisfies` clause
 * cannot name the keys of the object it checks, and this constraint has to say
 * each value is a `` Run<key>[] ``, so the table has to pass through a generic
 * holding the key.
 *
 * **Exported for the fixtures that hold it.** A constraint with nothing
 * checking it is one widened `string[]` away from being gone with the build
 * still green, and this module's whole point is that the compiler is what keeps
 * four places in agreement. `src/__tests__/datePattern.test.ts` carries the
 * `@ts-expect-error` lines that fail the day it stops rejecting, and the
 * assertion that {@link DateToken} is still the same union. Nothing
 * ships a call to it but {@link FIELDS} below.
 *
 * `W: ["ww"]` and `M: ["Mx"]` are rejected here. `w: ["ww"]` is not, and then
 * fails the build for the three switch cases it is missing, which is issue
 * #147 working.
 */
export const keyedTokens = <T extends { readonly [K in keyof T & string]: readonly Run<K>[] }>(
	table: T,
): T => table;

/**
 * The date fields understood, keyed by the character and how many of it.
 *
 * This table is the one the other three read from. The token set is written
 * down in four places — here, {@link formatField}'s switch, {@link readName}'s
 * inner switch and {@link fieldPattern}'s — and the compiler is what makes the
 * four agree: {@link DateToken} is derived from this object, and each of those
 * switches closes its `default:` against `never`, so a token added here and to
 * none of them fails the build.
 *
 * `as const` is what makes that derivation possible: without it the values are
 * `string[]` and the union collapses to `string`.
 *
 * The runtime guards are still here underneath. {@link tokenise} rejects any
 * run of letters not listed here, so a pattern never reaches the switches with
 * a token they do not know, and each switch still throws — the build error
 * catches the table growing, the throws catch a token arriving from a pattern
 * somebody typed.
 */
export const FIELDS = keyedTokens({
	Y: ["YY", "YYYY"],
	M: ["M", "MM", "MMM", "MMMM"],
	D: ["D", "DD"],
	d: ["ddd", "dddd"],
} as const);

/**
 * Every token {@link FIELDS} lists, as a type. Derived rather than written out,
 * so that the table stays the single place the set is decided.
 */
export type DateToken = (typeof FIELDS)[keyof typeof FIELDS][number];

/**
 * Whether a run of one repeated letter is a token this module knows.
 *
 * The one place a string from a person's pattern becomes a {@link DateToken};
 * everything downstream of {@link tokenise} is typed because this check ran.
 * The cast is the cost of asking: the run's initial may be any letter at all,
 * and {@link FIELDS} only has keys for four of them.
 */
function isDateToken(run: string): run is DateToken {
	const known: readonly string[] | undefined = FIELDS[run[0] as keyof typeof FIELDS];
	return known !== undefined && known.indexOf(run) >= 0;
}

/**
 * Splits a date pattern into literal text and fields. Text inside `[…]` is
 * literal. A run of letters the plugin does not know is an error rather than
 * something copied through, because copying it through names a file that is not
 * the day the person is looking at.
 */
function tokenise(pattern: string): Piece[] {
	const pieces: Piece[] = [];
	let i = 0;
	while (i < pattern.length) {
		const char = pattern[i];

		if (char === "[") {
			const close = pattern.indexOf("]", i + 1);
			if (close < 0) {
				throw new Error(`Unclosed "[" in the daily-log filename pattern "${pattern}".`);
			}
			pieces.push({ literal: pattern.slice(i + 1, close) });
			i = close + 1;
			continue;
		}

		if (/[A-Za-z]/.test(char)) {
			let run = i;
			while (run < pattern.length && pattern[run] === char) run += 1;
			const field = pattern.slice(i, run);
			if (!isDateToken(field)) {
				throw new Error(
					`Effortless does not understand "${field}" in the daily-log filename pattern "${pattern}".`,
				);
			}
			pieces.push({ field });
			i = run;
			continue;
		}

		let run = i;
		while (run < pattern.length && !/[A-Za-z[]/.test(pattern[run])) run += 1;
		pieces.push({ literal: pattern.slice(i, run) });
		i = run;
	}
	return pieces;
}

function pad(value: number, width: number): string {
	let text = String(Math.abs(value));
	while (text.length < width) text = `0${text}`;
	return text;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The regular-expression group {@link fieldPattern} builds for a month or
 * weekday field: every name `names.current` and, when given, `names.previous`
 * hold under `table` — a month in both its forms — escaped and tried longest
 * first.
 *
 * **Longest first**, so that one name being a leading run of another's
 * characters — nothing in {@link ENGLISH_NAMES} does this, but a table handed
 * in from elsewhere is not this module's to assume about — cannot make the
 * alternation stop at the shorter one before the text actually written goes
 * on to spell the longer name.
 */
function namedFieldPattern(names: DateNameTables, table: "months" | "monthsShort" | "weekdays" | "weekdaysShort"): string {
	const inDate = table === "months" ? "monthsInDate" : table === "monthsShort" ? "monthsShortInDate" : null;
	const alsoRead = table === "months" ? "months" : table === "monthsShort" ? "monthsShort" : null;
	const wordsOf = (held: DateNames): readonly string[] => [
		...held[table],
		...(inDate === null ? [] : (held[inDate] ?? [])),
		...(alsoRead === null ? [] : (held.readAlso?.[alsoRead] ?? [])),
	];
	const words = [...wordsOf(names.current), ...(names.previous ? wordsOf(names.previous) : [])]
		.slice()
		.sort((a, b) => b.length - a.length)
		.map(escapeRegExp);
	return `(${words.join("|")})`;
}
