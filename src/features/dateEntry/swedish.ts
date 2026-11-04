/**
 * The Swedish date parser, carried across from
 * `task-date-inserter/src/swedish-date-parser.ts` with its word tables, its
 * three weekday rules and its candidate-table row order intact (spec
 * #573 decisions 5 and 6;
 * ticket #576). The
 * tables — `WEEKDAY_NAMES`, `MONTH_NAMES`, `PARTIAL_CANDIDATES` — are data,
 * never translated: `måndag` is the thing being parsed, not a label for it.
 *
 * Hand-written rather than a Swedish locale for chrono-node, which is what the
 * English side uses: Swedish is the plugin's default, so the core path
 * carries no third-party dependency for it, and the three weekday rules below
 * are this repo's own definitions rather than a library's — a bare weekday is
 * never today, "nästa vecka" is the coming Monday, "nästa [veckodag]" always
 * skips past the nearest occurrence — which is what makes them testable and
 * changeable here.
 *
 * **Two changes from the old parser, and only two.** First, the phrase
 * answered is always the full phrase the date came from, not what was typed:
 * the old parser answered a short or partial form verbatim (`mån` came back
 * as `mån`, issue #14 in the old `task-date-inserter` plugin's own tracker),
 * which this parser fixes by resolving every input
 * against the candidate table before falling back to the input itself.
 * Second, `överi morgon` — the residue of a find-and-replace, issue #5 in that
 * same old tracker —
 * no longer parses.
 */

const WEEKDAY_NAMES: Record<string, number> = {
	måndag: 1,
	mandag: 1,
	tisdag: 2,
	onsdag: 3,
	torsdag: 4,
	fredag: 5,
	lördag: 6,
	lordag: 6,
	söndag: 0,
	sondag: 0,
	// Short forms
	mån: 1,
	man: 1,
	tis: 2,
	ons: 3,
	tor: 4,
	fre: 5,
	lör: 6,
	lor: 6,
	sön: 0,
	son: 0,
};

const MONTH_NAMES: Record<string, number> = {
	januari: 1,
	februari: 2,
	mars: 3,
	april: 4,
	maj: 5,
	juni: 6,
	juli: 7,
	augusti: 8,
	september: 9,
	oktober: 10,
	november: 11,
	december: 12,
	// Short forms
	jan: 1,
	feb: 2,
	mar: 3,
	apr: 4,
	// maj already covered
	jun: 6,
	jul: 7,
	aug: 8,
	sep: 9,
	okt: 10,
	nov: 11,
	dec: 12,
};

/**
 * Ordered list of [prefix, fullExpression] pairs, both lower-cased.
 * An input matches a row when it is the start of the row's full expression,
 * or when it equals the row's prefix exactly; the first matching row wins
 * (`findFullPhrase`). So the prefix column only ever matches on equality, and
 * some rows can never be the first match. The rows are the old plugin's, in
 * its order, and are kept as they were.
 */
const PARTIAL_CANDIDATES: ReadonlyArray<readonly [string, string]> = [
	// Exact relative keywords first
	["idag", "idag"],
	["i dag", "idag"],
	["imorgon", "imorgon"],
	["i morgon", "imorgon"],
	["övermorgon", "övermorgon"],
	["overmorgon", "övermorgon"],
	// Prefix expansions for relative keywords
	["id", "idag"],
	["im", "imorgon"],
	["ig", "igår"],
	["igå", "igår"],
	["iga", "igår"], // ascii fallback
	["i ", "idag"], // "i" + space → prefer "idag" over "i morgon"
	["i", "idag"],
	["ö", "övermorgon"],
	["o", "övermorgon"], // ascii fallback
	// "nästa vecka" and prefix
	["nästa vecka", "nästa vecka"],
	["nasta vecka", "nästa vecka"],
	["nästa v", "nästa vecka"],
	["nasta v", "nästa vecka"],
	// "nästa [veckodag]" — full forms first
	["nästa måndag", "nästa måndag"],
	["nästa mandag", "nästa måndag"],
	["nästa tisdag", "nästa tisdag"],
	["nästa onsdag", "nästa onsdag"],
	["nästa torsdag", "nästa torsdag"],
	["nästa fredag", "nästa fredag"],
	["nästa lördag", "nästa lördag"],
	["nästa lordag", "nästa lördag"],
	["nästa söndag", "nästa söndag"],
	["nästa sondag", "nästa söndag"],
	// "nästa" + prefix of weekday
	["nästa m", "nästa måndag"],
	["nästa t", "nästa tisdag"],
	["nästa on", "nästa onsdag"],
	["nästa tor", "nästa torsdag"],
	["nästa f", "nästa fredag"],
	["nästa l", "nästa lördag"],
	["nästa s", "nästa söndag"],
	["nasta m", "nästa måndag"],
	["nasta t", "nästa tisdag"],
	["nasta on", "nästa onsdag"],
	["nasta tor", "nästa torsdag"],
	["nasta f", "nästa fredag"],
	["nasta l", "nästa lördag"],
	["nasta s", "nästa söndag"],
	// Bare weekday full forms
	["måndag", "måndag"],
	["mandag", "måndag"],
	["tisdag", "tisdag"],
	["onsdag", "onsdag"],
	["torsdag", "torsdag"],
	["fredag", "fredag"],
	["lördag", "lördag"],
	["lordag", "lördag"],
	["söndag", "söndag"],
	["sondag", "söndag"],
	// Bare weekday short forms
	["mån", "måndag"],
	["man", "måndag"],
	["tis", "tisdag"],
	["ons", "onsdag"],
	["tor", "torsdag"],
	["fre", "fredag"],
	["lör", "lördag"],
	["lor", "lördag"],
	["sön", "söndag"],
	["son", "söndag"],
];

/**
 * The number `table` holds for `word`, or `undefined` — asking only the
 * table's own entries. A plain object also answers the keys every object
 * inherits, and `constructor` or `__proto__` typed after the trigger would
 * otherwise hand a function to the weekday loops below, which never end.
 */
function lookUp(table: Record<string, number>, word: string): number | undefined {
	return Object.prototype.hasOwnProperty.call(table, word) ? table[word] : undefined;
}

/** Returns a copy of a date with time set to midnight */
function midnight(date: Date): Date {
	const d = new Date(date);
	d.setHours(0, 0, 0, 0);
	return d;
}

/** Returns the next occurrence of a weekday (0=Sun, 1=Mon, ..., 6=Sat)
 *  starting from the day after reference. */
function nextWeekday(reference: Date, targetDay: number): Date {
	const d = midnight(reference);
	d.setDate(d.getDate() + 1);
	while (d.getDay() !== targetDay) {
		d.setDate(d.getDate() + 1);
	}
	return d;
}

/** Returns the next occurrence of a weekday more than 7 days from reference.
 *  Ensures "nästa [veckodag]" always skips past the nearest occurrence. */
function nextWeekdayAtLeastOneWeek(reference: Date, targetDay: number): Date {
	const d = midnight(reference);
	d.setDate(d.getDate() + 8);
	while (d.getDay() !== targetDay) {
		d.setDate(d.getDate() + 1);
	}
	return d;
}

/** Validates that a Date object represents the expected year/month/day
 *  (guards against JS Date overflow like Feb 30 → Mar 2). */
function isValidDate(d: Date, year: number, month: number, day: number): boolean {
	return (
		d.getFullYear() === year &&
		d.getMonth() === month - 1 &&
		d.getDate() === day
	);
}

/** Returns a Date for the given month/day in the current year,
 *  or next year if that date is already in the past. */
function dateThisOrNextYear(ref: Date, month: number, day: number): Date | null {
	const year = ref.getFullYear();
	const d = new Date(year, month - 1, day);
	if (!isValidDate(d, year, month, day)) return null;
	// If the date is today or in the future, use it; otherwise use next year
	if (d >= ref) return d;
	const next = new Date(year + 1, month - 1, day);
	if (!isValidDate(next, year + 1, month, day)) return null;
	return next;
}

/**
 * Resolves an already-trimmed, already-lowercased expression to a date.
 * `normalized` is expected to be a full expression, not a partial prefix.
 */
function parseExact(normalized: string, ref: Date): Date | null {
	// --- Relative keywords ---
	if (normalized === "idag" || normalized === "i dag") {
		return midnight(ref);
	}
	if (normalized === "imorgon" || normalized === "i morgon") {
		const d = midnight(ref);
		d.setDate(d.getDate() + 1);
		return d;
	}
	if (normalized === "igår" || normalized === "i går" || normalized === "igar" || normalized === "i gar") {
		const d = midnight(ref);
		d.setDate(d.getDate() - 1);
		return d;
	}
	if (normalized === "övermorgon" || normalized === "overmorgon") {
		const d = midnight(ref);
		d.setDate(d.getDate() + 2);
		return d;
	}

	// --- "om N dagar" / "om N dag" ---
	const inNDaysMatch = normalized.match(/^om\s+(\d+)\s+dag(?:ar)?$/);
	if (inNDaysMatch) {
		const n = parseInt(inNDaysMatch[1], 10);
		const d = midnight(ref);
		d.setDate(d.getDate() + n);
		// A day count past the calendar's end makes no date at all.
		return Number.isNaN(d.getTime()) ? null : d;
	}

	// --- "nästa vecka" → next Monday (nearest Monday from tomorrow) ---
	if (normalized === "nästa vecka" || normalized === "nasta vecka") {
		return nextWeekday(ref, 1);
	}

	// --- "nästa [veckodag]" → at least 7 days out ---
	const nextWeekdayMatch = normalized.match(/^nästa\s+(\S+)$/) ??
		normalized.match(/^nasta\s+(\S+)$/);
	if (nextWeekdayMatch) {
		const dayName = nextWeekdayMatch[1];
		const dayNum = lookUp(WEEKDAY_NAMES, dayName);
		if (dayNum !== undefined) {
			return nextWeekdayAtLeastOneWeek(ref, dayNum);
		}
	}

	// --- Bare weekday name → next occurrence (tomorrow or later) ---
	const bareWeekday = lookUp(WEEKDAY_NAMES, normalized);
	if (bareWeekday !== undefined) {
		return nextWeekday(ref, bareWeekday);
	}

	// --- ISO date: YYYY-MM-DD ---
	const isoMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (isoMatch) {
		const year = parseInt(isoMatch[1], 10);
		const month = parseInt(isoMatch[2], 10) - 1;
		const day = parseInt(isoMatch[3], 10);
		const d = new Date(year, month, day);
		if (isValidDate(d, year, month + 1, day)) return d;
	}

	// --- Short date: DD/M or DD-MM (no year) ---
	const shortSlashMatch = normalized.match(/^(\d{1,2})\/(\d{1,2})$/);
	if (shortSlashMatch) {
		const day = parseInt(shortSlashMatch[1], 10);
		const month = parseInt(shortSlashMatch[2], 10);
		return dateThisOrNextYear(ref, month, day);
	}

	const shortDashMatch = normalized.match(/^(\d{1,2})-(\d{2})$/);
	if (shortDashMatch) {
		const day = parseInt(shortDashMatch[1], 10);
		const month = parseInt(shortDashMatch[2], 10);
		return dateThisOrNextYear(ref, month, day);
	}

	// --- "15 april" or "15 apr" ---
	const dayMonthMatch = normalized.match(/^(\d{1,2})\s+([a-zåäö]+)$/);
	if (dayMonthMatch) {
		const day = parseInt(dayMonthMatch[1], 10);
		const monthNum = lookUp(MONTH_NAMES, dayMonthMatch[2]);
		if (monthNum !== undefined) {
			return dateThisOrNextYear(ref, monthNum, day);
		}
	}

	// --- "april 15" or "apr 15" ---
	const monthDayMatch = normalized.match(/^([a-zåäö]+)\s+(\d{1,2})$/);
	if (monthDayMatch) {
		const monthNum = lookUp(MONTH_NAMES, monthDayMatch[1]);
		const day = parseInt(monthDayMatch[2], 10);
		if (monthNum !== undefined) {
			return dateThisOrNextYear(ref, monthNum, day);
		}
	}

	return null;
}

/**
 * The full expression of the first candidate row whose full expression starts
 * with the normalized input, or whose prefix equals it — the first matching
 * row wins, which is what makes `nästa t` resolve to tisdag rather than
 * torsdag, a choice the old plugin made on purpose.
 * Returns null when no row matches, meaning no table row stands behind the
 * input at all.
 */
function findFullPhrase(normalized: string): string | null {
	for (const [prefix, fullExpression] of PARTIAL_CANDIDATES) {
		if (fullExpression.startsWith(normalized) || normalized === prefix) {
			return fullExpression;
		}
	}
	return null;
}

/**
 * Parses a Swedish date expression.
 *
 * `today` is a local-midnight `Date` the caller pins. The date answered is
 * always local midnight. The phrase answered is the full expression the date
 * came from — the candidate table's row, expanded — or, where no table row
 * stands behind the date, the input trimmed and lower-cased.
 */
export function parseSwedish(input: string, today: Date): { date: Date; phrase: string } | null {
	const ref = midnight(today);
	const normalized = input.trim().toLowerCase();
	if (!normalized) return null;

	const fullPhrase = findFullPhrase(normalized);
	if (fullPhrase !== null) {
		const date = parseExact(fullPhrase, ref);
		if (date !== null) return { date, phrase: fullPhrase };
	}

	const date = parseExact(normalized, ref);
	if (date !== null) return { date, phrase: normalized };

	return null;
}
