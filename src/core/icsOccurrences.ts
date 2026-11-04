/**
 * Turns `.ics` bytes into the dated things they hold, and survives one bad
 * event.
 *
 * This is the only file in the plugin that knows the two calendar libraries
 * exist. `ical-expander` parses with `ical.js` underneath it, expands `RRULE`
 * and `EXDATE`, applies a `RECURRENCE-ID` override in place of the occurrence
 * it replaces, and resolves `VTIMEZONE` against a timezone table it ships. All
 * of that is work a daemon used to do for one person; a stranger with three
 * calendars needs it too, so it lives here now (ADR 0001).
 *
 * `ical.js` is a dependency of this repository as well as of `ical-expander`,
 * even though nothing imports it directly. Two reasons, and both are load-
 * bearing: `package.json` pins the two to one shared copy through `overrides`,
 * which needs a top-level entry to point at, and `ical-expander`'s own type
 * declarations resolve `ICAL.Event` against it. Importing it here as well
 * would pull a *second* copy into the bundle — 79 KB of it, measured — because
 * an `import` resolves to the ESM build while `ical-expander`'s `require`
 * resolves to the CommonJS one.
 *
 * Nothing here touches Node. `ical.js` and `ical-expander` are both pure
 * JavaScript, which is what lets the manifest stay `isDesktopOnly: false`.
 *
 * **This module is exempt from `GLOSSARY.md`'s retirement of *event*, *occurrence*
 * and *appointment* for *Meeting*.** `CalendarEvent`, `eventsOf`,
 * `hasReadableDates`, `occurrenceOf`, `expansion.events` and `Occurrence` itself
 * all name the iCalendar standard's and `ical.js`'s own vocabulary — `VEVENT` is
 * the standard's word, not this plugin's — and this file is the boundary that
 * reads that standard. The reasoning is **by analogy with**
 * `~/Devbox/CLAUDE.md § Language`, not licensed by its letter: that section is
 * about Swedish, it keeps what is *data* — an OS string the code matches on, a
 * tuned prompt, a test corpus — and it says a *name*, an identifier included,
 * is renamed rather than exempted. The analogy is the data-versus-name split,
 * applied here to a standard's vocabulary at the boundary that reads the
 * standard. **The exemption reaches the tests of this boundary too**:
 * `readableEvent` in `icsOccurrences.test.ts`, and `everyEventBroken` and
 * `ExpanderWithNoEvents` in `icsReader.test.ts`, build and mock this same
 * `.ics`/`ical-expander` layer — `ExpanderWithNoEvents` stands in for the
 * library's own `events` field above — and are not a fourth place `Meeting`
 * has drifted. Do not re-open either without a new reason.
 *
 * **The exemption also reaches `icsReader.ts`'s use of `Occurrence`, the type
 * this module exports.** `readOccurrencesBetween`'s own name, the `occurrences`
 * local it returns into, and `meetingOf(occurrence)`'s parameter all name the
 * value this boundary hands back, not a fresh naming choice of `icsReader.ts`'s
 * own — the same way a caller of a Swedish-named OS API keeps that name rather
 * than translating it at the call site. `meetingOf` itself is already named for
 * what it builds, `Meeting`; only the parameter it reads from carries the
 * exempted word. Neither is a fourth place `Meeting` has drifted.
 *
 * **What `ical-expander`'s `between()` hands through for an unmoved occurrence
 * and for a `RECURRENCE-ID` override, verified against its own source rather
 * than assumed.** Every occurrence of a repeat reaches
 * `between()` as an `occurrenceDetails` object built by `getOccurrenceDetails`
 * (`node_modules/ical.js/dist/types/types.d.ts:141-149`), whose `result` starts
 * as `{ recurrenceId: occurrence }` — the time this iteration of the repeat
 * would fall on before any override, always set
 * (`node_modules/ical.js/lib/ical/event.js:210-213`). **That function already
 * substitutes an override before `between()` ever sees the occurrence.** A
 * master relates every sibling `RECURRENCE-ID` component to itself at
 * construction, keyed by that component's own `RECURRENCE-ID`
 * (`event.js:107`, `relateException`, `this.exceptions[id] = obj` at line 124).
 * When the iterated time matches one of those keys, `getOccurrenceDetails`
 * replaces `result.item` with the override itself and reads `startDate` and
 * `endDate` off *it* rather than off the iterated time (`event.js:215-219`);
 * `recurrenceId` is left as the original, unmoved time set above. Absent a
 * match, `item` stays the master and `startDate` stays identical to
 * `recurrenceId`, both the iterated time (`event.js:264-271`).
 *
 * **`between()`'s own override lookup (`index.js:89`) therefore only ever
 * matches an override that leaves the time unmoved.** It compares a
 * candidate override's own `recurrenceId` — its `RECURRENCE-ID`, the
 * original time — against `occurrence.startDate`, which by then is already
 * the override's own start when one applied. The two agree only when the
 * override's `DTSTART` reproduces the time its `RECURRENCE-ID` names, and
 * only then is the override pushed as a whole event onto
 * `Expansion["events"]` (`index.js:97`), bypassing the `occurrenceDetails`
 * wrapping. **An override that moves the time — the case issue #908 is
 * about — fails that comparison and falls through to
 * `Expansion["occurrences"]` instead (`index.js:99`), carrying the override
 * itself as `item`, already substituted by `getOccurrenceDetails` above.**
 * So `occurrences[].item` is the series master only for a truly unoverridden
 * occurrence; for one moved by an override it is the override, and
 * `collect` below has to ask `isRecurrenceException()` of `item` itself
 * before assuming which. Either way `recurrenceIdOf` and `keyOf` read the
 * *original* time off whichever of `item` or `occurrence.recurrenceId`
 * carries it — the override's own `.recurrenceId` getter answers the same
 * original time its `RECURRENCE-ID` property names (`event.js:502-504`) —
 * so the occurrence key is unaffected by which of the two paths a move takes.
 */

import IcalExpander from "ical-expander";
import { reasonOf } from "./reason";

/**
 * How far `ical-expander` will iterate a repeat before giving up. Its own
 * default, named here so it is a decision rather than an accident.
 */
const MAX_ITERATIONS = 1000;

/**
 * Which of two different troubles an `IcsReadError` is about.
 *
 * `not-a-calendar` — these bytes were never a calendar. On a link that is
 * nearly always the wrong address, so the caller may say so.
 * `unreadable` — these bytes *are* a calendar and could not be read anyway,
 * a half-finished download being the usual cause. The address may be perfect,
 * and telling someone to change it sends them after the wrong thing.
 */
export type IcsReadTrouble = "not-a-calendar" | "unreadable";

/** A calendar that cannot be read at all, as opposed to one event that cannot. */
export class IcsReadError extends Error {
	/**
	 * Stated at every throw rather than defaulted: the two are worded very
	 * differently to the person, and a new throw site has to decide which it is.
	 */
	readonly trouble: IcsReadTrouble;

	constructor(message: string, trouble: IcsReadTrouble) {
		super(message);
		this.name = "IcsReadError";
		this.trouble = trouble;
	}
}

/**
 * Whether `error` says the bytes were never a calendar.
 *
 * Exported so that nothing outside this file has to key on the error type to
 * find out — which is what made a truncated calendar report a wrong address.
 */
export function isNotACalendar(error: unknown): boolean {
	return error instanceof IcsReadError && error.trouble === "not-a-calendar";
}

/**
 * A moment as a calendar states it. An all-day entry carries a calendar date
 * and no time, and turning it into an instant too early is exactly how an
 * all-day event ends up ending the morning after.
 */
export type IcsTime =
	| { readonly kind: "time"; readonly at: Date }
	| { readonly kind: "date"; readonly year: number; readonly month: number; readonly day: number };

/**
 * Who organised, or was invited to, a meeting — read from `ORGANIZER` or
 * `ATTENDEE`'s `CN` parameter and its `mailto:` value.
 */
export interface InvitedParty {
	/** Empty when the property carries no `CN`, never invented. */
	readonly name: string;
	/**
	 * The value past `mailto:` when it has that scheme; carried as-is otherwise,
	 * lower-cased nowhere.
	 */
	readonly email: string;
}

/** One dated thing a calendar holds, before the day's view is made of it. */
export interface Occurrence {
	/** The calendar's own id. Every occurrence of one repeat shares it. */
	readonly uid: string;
	/** Empty when the event gives none, which is a thing calendars really do. */
	readonly summary: string;
	readonly location: string | null;
	readonly description: string | null;
	/** Null when the event names no `ORGANIZER`. */
	readonly organizer: InvitedParty | null;
	/** Empty when the event carries no `ATTENDEE` line. */
	readonly attendees: readonly InvitedParty[];
	/**
	 * Names *this occurrence* of the event's series, stable across a
	 * reschedule. `null` for an event that does not repeat. For an occurrence
	 * of a repeat, the moment the repeat rule would have placed it at before
	 * any `RECURRENCE-ID` override moved it — so an occurrence moved from
	 * Tuesday to Thursday keeps Tuesday's key, and two occurrences of one
	 * series that ever land on the same day keep the two different original
	 * moments that put them there. Built from `RECURRENCE-ID` (see the module
	 * comment above for what `ical-expander` hands through for each case).
	 */
	readonly occurrenceKey: string | null;
	readonly start: IcsTime;
	/** For an all-day entry this is the exclusive end — the morning after. */
	readonly end: IcsTime;
}

/**
 * How much of a calendar was left out when it had to be read one event at a
 * time. `dropped` of `total` event groups could not be read; the rest were.
 */
export interface IcsLoss {
	readonly dropped: number;
	readonly total: number;
}

/** What one calendar says about a stretch of time, and what it lost saying it. */
export interface IcsReading {
	readonly occurrences: Occurrence[];
	/** Null when the whole calendar read, which is the ordinary case. */
	readonly loss: IcsLoss | null;
}

/**
 * Every occurrence in `ics` that overlaps `from`–`to`, with the cancelled ones
 * left out, and what the read lost.
 *
 * Throws `IcsReadError` when the bytes are not a calendar. One event the
 * libraries choke on is a different thing and never stops the rest: the read is
 * tried again event by event, the bad ones are dropped, and how many were
 * dropped comes back in `loss`.
 *
 * An entry can also be lost without anything throwing — its dates unreadable,
 * or the file stopping in the middle of it — and those count too, on the
 * whole-file read as much as on the per-entry one. A
 * read that answers with occurrences and `loss: null` is saying that every
 * entry the calendar holds was read, and it has to be able to mean it.
 *
 * **`loss` is the whole point of returning an object here.** Dropping events
 * quietly makes a calendar nobody can read look like a day with nothing on it,
 * and only the second of those is the person's to fix. The caller
 * turns a loss into something a settings row can say.
 *
 * A bad event can bring the whole-file read down at either step — reading a
 * repeat rule throws while the events are being built, and a bad date throws
 * while they are being expanded — so both are caught together and answered the
 * same way.
 */
export function readOccurrencesBetween(ics: string, from: Date, to: Date): IcsReading {
	const text = withoutByteOrderMark(ics);
	requireCalendar(text);
	try {
		const built = build(text);
		return readingOf(
			text,
			collect(built.events, built.expander.between(from, to)),
			built.dropped,
			built.total,
		);
	} catch (error) {
		// The one failure the per-entry read may not be asked to absorb: it is
		// the library that broke, not this calendar.
		if (error instanceof ExpanderContractError) throw error;
		return salvage(text, from, to, error);
	}
}

/**
 * The calendar text without the mark some exporters put in front of it.
 *
 * Outlook and Exchange write a UTF-8 byte-order mark at the head of a `.ics`
 * file. It is not part of the calendar and everything downstream reads it as if
 * it were: the `BEGIN:VCALENDAR` check anchors to the start of a line and the
 * mark sits before it, so a perfectly good calendar was reported as a wrong
 * address, and `ical-expander` falls over on the same bytes with an error of its
 * own again. It is stripped once, here, so that one text goes to
 * the check, to the whole-file parse and to the per-entry split alike.
 *
 * Only a single leading U+FEFF, and nothing else. A leading blank line already
 * passes, because the check's anchor matches at the start of any line, and
 * widening this into a trim would weaken the vCard-versus-calendar distinction
 * that check exists for.
 */
function withoutByteOrderMark(ics: string): string {
	return ics.startsWith("\uFEFF") ? ics.slice(1) : ics;
}

/**
 * Rejects bytes that are not a calendar before either library sees them.
 *
 * `ical.js` throws a clear parse error on HTML or JSON, but a vCard parses
 * happily and yields nought events — which would look exactly like a calendar
 * with nothing in it. Requiring the `BEGIN:VCALENDAR` line tells the two apart.
 */
function requireCalendar(ics: string): void {
	if (ics.trim() === "") {
		throw new IcsReadError("The calendar is empty.", "not-a-calendar");
	}
	if (!/^BEGIN:VCALENDAR[ \t\r]*$/im.test(ics)) {
		throw new IcsReadError(
			"These bytes are not a calendar: there is no BEGIN:VCALENDAR line.",
			"not-a-calendar",
		);
	}
}

type Expansion = ReturnType<IcalExpander["between"]>;
type CalendarEvent = Expansion["events"][number];
type CalendarTime = CalendarEvent["startDate"];
type CalendarProperty = CalendarEvent["attendees"][number];

/**
 * `ical-expander`'s own list of the `VEVENT`s it parsed, which its type
 * declarations do not name: they declare the constructor and the four expansion
 * calls and nothing else.
 *
 * It is reached for so that an entry whose dates cannot be read can be
 * *counted* rather than only discarded. `skipInvalidDates` runs
 * exactly the same test and keeps no record of what it threw away, so by the time the expander is handed back the evidence is gone.
 *
 * The cast is an assumption, so `eventsOf` checks it rather than trusting it.
 */
interface ParsedCalendar {
	events: CalendarEvent[];
}

/**
 * The library changed under the plugin: `ical-expander` no longer hands back
 * the field this module reads.
 *
 * **Not an `IcsReadError`, and never a loss.** The bytes are a perfectly good
 * calendar and the person has nothing to fix. `ical-expander` is pinned
 * `^3.2.0`, so any 3.x release that renames or removes `events` is accepted by
 * `npm install` — and swallowed, that would make the plugin say "None of the N
 * entries in this calendar could be read" for every calendar in the vault: a
 * confident, specific, entirely wrong sentence on the code path whose whole job
 * is telling the truth about loss. So both reads let it out.
 * `readOccurrencesBetween` and the per-entry read each rethrow it rather than
 * counting the calendar as lost, which is `~/Devbox/CLAUDE.md § Tests and
 * failures`, "fail loud", applied to a dependency instead of to a caller.
 *
 * **The class stays module-private and two callers outside this file catch it
 * anyway**, through `isExpanderContractError`. Naming them here is the point of
 * this paragraph: the sentence that stood in its place claimed nothing outside
 * caught it and that whoever met it was reading the console, and both halves
 * were false — each caller was quietly turning it into a settings-row sentence
 * against a good calendar. Only one of the two can meet it today:
 *
 * - `CalendarSources.readOne` in `src/core/calendarSources.ts` hands the
 *   source's recorded read state back exactly as it was — no failure recorded,
 *   the last-read time untouched. **This is the live protection.** It sits
 *   around the read of freshly fetched bytes, which is the only place a
 *   bundled dependency's break is ever actually met.
 * - `readDayFromAll` in `src/core/icsReader.ts` writes the message to the
 *   console and pushes **no** `CalendarFailure` for that calendar. It cannot
 *   be reached today: its only caller hands it stored copies, and a copy is
 *   stored only after the read above has already succeeded, so a break there
 *   never leaves one behind to reach this branch with. It is kept as the
 *   correct answer for a caller fed bytes some other way.
 *
 * The live one says it **once per read rather than once per calendar**: six
 * calendars in a vault meet the same broken library six times over and one
 * line is the whole of what it is worth saying. It threads a flag through its
 * own read, so it resets by itself; the module-level guard `announceLoss`
 * keeps is deliberately not reused, being a different question with open
 * findings of its own. `readDayFromAll` keeps the same
 * shape ready for the day it has a caller to say anything to.
 *
 * **The trade-off, written down so the next reader does not undo it as an
 * oversight.** A broken dependency now shows an empty day with nothing said on
 * screen, which brushes against issue #53 — an unreadable calendar must not look
 * like a quiet day. It is deliberate. Issue #289 settled that this failure's
 * audience is whoever has the console open, because the person has nothing to
 * fix and a per-calendar sentence would libel every good calendar in the vault.
 * If that is later judged wrong it is a new ticket about surfacing dependency
 * breaks to the person, not a re-opening of this one.
 */
class ExpanderContractError extends Error {}

/**
 * Whether `error` is the dependency-contract break above.
 *
 * The predicate is exported and the class is not, so a caller can recognise the
 * one failure it has to treat differently without being able to throw it. Only
 * this module knows when the contract is broken.
 */
export function isExpanderContractError(error: unknown): boolean {
	return error instanceof ExpanderContractError;
}

/**
 * `parsed`'s list of events, refused if it is not one.
 *
 * `Array.isArray` and nothing more. The field is undocumented, so the only
 * promise worth pinning is the one this module actually leans on: that there is
 * a list of parsed events here to count and to filter.
 */
function eventsOf(parsed: ParsedCalendar): CalendarEvent[] {
	if (!Array.isArray(parsed.events)) {
		throw new ExpanderContractError(
			"ical-expander no longer hands back its `events` field as an array. Effortless " +
				"reads that field to count the entries a calendar loses, so the dependency has " +
				"changed under the plugin and no count it makes can be trusted.",
		);
	}
	return parsed.events;
}

/** A calendar ready to expand, and what parsing it has already cost. */
interface BuiltCalendar {
	readonly expander: IcalExpander;
	/**
	 * Every event the calendar holds with readable dates — masters and
	 * `RECURRENCE-ID` overrides alike. `collect` below reads it to find a
	 * moved occurrence's series master by UID.
	 */
	readonly events: CalendarEvent[];
	/** Entry groups the calendar holds — one per UID, as issue #143 settled. */
	readonly total: number;
	/** How many of those hold nothing whose dates could be read at all. */
	readonly dropped: number;
}

/**
 * Parses `ics` and puts aside every entry whose start or end cannot be read.
 *
 * Setting such an entry aside is what `ical-expander`'s `skipInvalidDates` does,
 * and it is done here instead for the sake of the count. Without it, one event
 * of a hundred missing its `DTSTART` takes the whole file down — which is how
 * the pre-merge plugin once fell over. With it, that event vanished and nothing
 * anywhere said so. The filtered list is written back, so `between`
 * sees exactly what the option would have left it.
 *
 * The test is the library's own: a start and an end that both turn into a real
 * instant. It asks nothing about the days being read, so an entry that simply
 * does not fall in them is never mistaken for one that cannot be read.
 */
function build(ics: string): BuiltCalendar {
	const expander = new IcalExpander({
		ics,
		maxIterations: MAX_ITERATIONS,
		skipInvalidDates: false,
	});
	const parsed = expander as unknown as ParsedCalendar;
	const events = eventsOf(parsed);
	const readable = events.filter(hasReadableDates);
	const counted = countGroups(events, readable);
	parsed.events = readable;
	return { expander, events: readable, total: counted.total, dropped: counted.dropped };
}

/** Whether both ends of this entry turn into a real instant. */
function hasReadableDates(event: CalendarEvent): boolean {
	try {
		event.startDate.toJSDate();
		event.endDate.toJSDate();
		return true;
	} catch {
		return false;
	}
}

/**
 * How many entry groups `parsed` falls into, and how many of them `readable`
 * left with nothing in them.
 *
 * The group is the UID, so a repeat and the `RECURRENCE-ID` override that
 * replaces one of its mornings are one entry between them. An
 * entry with no UID gets a group of its own, which is what `uidKey` does for
 * the per-entry split, so the two paths count the same calendar the same way.
 *
 * **The readability test is asked of the group's master, not of any member it
 * happens to have** (issue #285's sibling, [#288]). `ical-expander` expands
 * only the events for which `isRecurrenceException()` is false — an override on
 * its own produces nothing at all. So a group whose master has no readable
 * start but whose override parses used to be counted as read, and the read
 * answered with no occurrences and `loss: null`: a whole entry gone under the
 * one sentence this module exists to be able to mean. A group of orphaned
 * overrides with no master at all reached the same answer by the same route,
 * and is a dropped entry for the same reason — it produces nothing, so nothing
 * of it was read.
 *
 * An override that will not parse beside a master that does is read **here**:
 * the master has readable dates, so this function counts the group as one
 * entry read, exactly as issue #143 counts it. That is not the answer the
 * caller gets. `ICAL.Event` relates an override to its master through the
 * parent component, so the master asks the unreadable override for a start
 * time during expansion and the expansion throws; the per-entry read that
 * follows reaches the same verdict. The read as a whole therefore answers the
 * group as one entry **dropped** — the behaviour issue #380 decided, pinned by
 * the test *"counts the group lost, which is the half of #288's box 4 the
 * counting cannot reach"* in `icsOccurrences.test.ts`.
 */
function countGroups(
	parsed: readonly CalendarEvent[],
	readable: readonly CalendarEvent[],
): { total: number; dropped: number } {
	const kept = new Set<CalendarEvent>(readable);
	const groups = new Map<string, boolean>();
	parsed.forEach((event, index) => {
		const key = event.uid ?? `#${index}`;
		const canProduceOccurrences = !event.isRecurrenceException() && kept.has(event);
		groups.set(key, (groups.get(key) ?? false) || canProduceOccurrences);
	});
	let dropped = 0;
	for (const readableMaster of groups.values()) {
		if (!readableMaster) dropped += 1;
	}
	return { total: groups.size, dropped };
}

function collect(events: readonly CalendarEvent[], expansion: Expansion): Occurrence[] {
	const masters = mastersByUid(events);
	const found: Occurrence[] = [];
	for (const event of expansion.events) {
		if (isCancelled(event)) continue;
		// `event` here is either a non-recurring event, which carries no
		// `RECURRENCE-ID` of its own, or a `RECURRENCE-ID` override that keeps
		// its master's own time — the module comment above says which is which,
		// and why an override that *moves* the time is never found here.
		found.push(
			occurrenceOf(event, event.startDate, event.endDate, recurrenceIdOf(event), masterOf(event, masters)),
		);
	}
	for (const occurrence of expansion.occurrences) {
		// `item` is the series master for an occurrence nothing has overridden,
		// and the override itself for one whose `RECURRENCE-ID` moved it to a
		// different time — the module comment above says why the moved case
		// lands here rather than in `expansion.events`. Skipping a cancelled
		// override therefore removes the occurrence rather than restoring the
		// original.
		if (isCancelled(occurrence.item)) continue;
		found.push(
			occurrenceOf(
				occurrence.item,
				occurrence.startDate,
				occurrence.endDate,
				keyOf(occurrence.recurrenceId),
				masterOf(occurrence.item, masters),
			),
		);
	}
	return found;
}

/**
 * `event`'s series master, found by UID among `masters` — `null` when `event`
 * is not itself a `RECURRENCE-ID` override, which is the only case with
 * anything to inherit.
 */
function masterOf(event: CalendarEvent, masters: ReadonlyMap<string, CalendarEvent>): CalendarEvent | null {
	return event.isRecurrenceException() ? masters.get(event.uid ?? "") ?? null : null;
}

/**
 * Every event in `events` that is not itself a `RECURRENCE-ID` override,
 * keyed by UID — the series master a moved occurrence reads its unstated
 * properties from.
 *
 * `events` only ever reaches `collect` already filtered to what `between()`
 * itself would iterate (see `build` above), so an override reaching either
 * `expansion.events` or `expansion.occurrences` (the module comment above
 * says which, and when) is guaranteed a readable master here: `ical-expander`
 * only ever produces an override by expanding a master it iterates, and a
 * master this map has dropped for being unreadable can expand nothing (the
 * `#288` case, tested in `icsOccurrences.test.ts`). An override with no
 * master at all — orphaned, or its group counted lost — never reaches either
 * expansion field to begin with, so this map is never consulted for one.
 */
function mastersByUid(events: readonly CalendarEvent[]): Map<string, CalendarEvent> {
	const masters = new Map<string, CalendarEvent>();
	for (const event of events) {
		if (!event.isRecurrenceException()) masters.set(event.uid ?? "", event);
	}
	return masters;
}

/**
 * `event` as an `Occurrence`, with whatever it does not carry itself read off
 * `master` instead — the series master it is a `RECURRENCE-ID` override of,
 * or `null` when it is not an override.
 *
 * **`SUMMARY`, `LOCATION`, `DESCRIPTION` and `ORGANIZER`: a property `event`
 * states, even as an empty one, wins.** `??` treats only `null`/`undefined`
 * as missing, so an override that states `LOCATION:` with nothing after it
 * keeps that empty location rather than the master's. **`ATTENDEE` is
 * different: an empty list is read as omitted, not as "no one invited",**
 * and inherits the master's attendees — the `.length > 0` check falls back
 * to `master` for an empty array the same way it does for a missing one.
 *
 * **What "omitted" is taken to mean, for `LOCATION` and every other property
 * here.** A file cannot say whether a property Outlook left out was left
 * unchanged or deliberately cleared; Outlook's own move — the shape this
 * vault receives — writes only what changed, so "unchanged" is the reading a
 * real export supports. Reading it as "cleared" would show a moved meeting
 * with no room and no one invited on every calendar that behaves this way.
 */
function occurrenceOf(
	event: CalendarEvent,
	start: CalendarTime,
	end: CalendarTime,
	occurrenceKey: string | null,
	master: CalendarEvent | null,
): Occurrence {
	const attendees = event.attendees;
	return {
		uid: event.uid ?? "",
		summary: event.summary ?? master?.summary ?? "",
		location: event.location ?? master?.location ?? null,
		description: event.description ?? master?.description ?? null,
		organizer: organizerOf(event) ?? (master === null ? null : organizerOf(master)),
		attendees: attendees.length > 0 ? attendees.map(partyOf) : (master?.attendees.map(partyOf) ?? []),
		occurrenceKey,
		start: timeOf(start),
		end: timeOf(end),
	};
}

/**
 * `event`'s own `RECURRENCE-ID`, `null` when it carries none.
 *
 * `event.recurrenceId` (`node_modules/ical.js/dist/types/event.d.ts:210`) is
 * declared to always answer a `Time`, but its getter is
 * `_firstProp('recurrence-id')` (`lib/ical/event.js:502-503`), the same
 * `component.getFirstPropertyValue` call `organizerOf` already works around
 * for the same reason — it answers `null` when the property is absent
 * (`component.d.ts:123`). So this reads the property directly, the way
 * `organizerOf` does, rather than trusting the getter's declared type.
 */
function recurrenceIdOf(event: CalendarEvent): string | null {
	const property = event.component.getFirstProperty("recurrence-id");
	const value = property === null ? null : property.getFirstValue();
	return isIcalTime(value) ? keyOf(value) : null;
}

/**
 * `Property.getFirstValue()` and `Component.getFirstPropertyValue()` are both
 * typed to answer one of several kinds (`property.d.ts:163`); `RECURRENCE-ID`
 * is always a date or date-time per RFC 5545, and `Time` is the only one of
 * those kinds with a `toJSDate` method
 * (`node_modules/ical.js/dist/types/time.d.ts`), which is what tells it apart
 * from the others without importing the class itself.
 */
function isIcalTime(value: unknown): value is CalendarTime {
	return typeof value === "object" && value !== null && "toJSDate" in value;
}

/**
 * A stable text form of `time`, used as an occurrence's key. `timeOf` is the
 * same conversion `start`/`end` already go through, so two equal moments
 * always produce the same key whichever of the two paths above they came from.
 */
function keyOf(time: CalendarTime): string {
	const converted = timeOf(time);
	if (converted.kind === "date") {
		const month = String(converted.month).padStart(2, "0");
		const day = String(converted.day).padStart(2, "0");
		return `${converted.year}-${month}-${day}`;
	}
	return converted.at.toISOString();
}

/**
 * The local day, as `YYYY-MM-DD`, that an occurrence key written by
 * {@link keyOf} names — the day the occurrence was on before any reschedule —
 * or `null` for a key of neither shape `keyOf` writes. The read-back of
 * `keyOf`, kept beside it so the two change together.
 *
 * A bare date, an all-day occurrence's key, is that day as it stands: read as
 * a moment it would be midnight UTC, the day before west of Greenwich. A
 * moment is converted to the local day it falls on.
 */
export function occurrenceKeyDay(key: string): string | null {
	if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return key;
	const at = new Date(key);
	if (Number.isNaN(at.getTime())) return null;
	const month = String(at.getMonth() + 1).padStart(2, "0");
	const day = String(at.getDate()).padStart(2, "0");
	return `${at.getFullYear()}-${month}-${day}`;
}

/**
 * `event.attendees` is `Property[]` (`node_modules/ical.js/dist/types/event.d.ts:172`);
 * `ORGANIZER` has no such list getter, and `event.organizer`
 * (`event.d.ts:197`) answers only the address as a plain string, with no way
 * to also ask it for `CN`. So this reads the property itself, off
 * `event.component` — the same field `isCancelled` below already reads
 * `STATUS` off — whose `getFirstProperty` is declared at
 * `node_modules/ical.js/dist/types/component.d.ts:115`.
 */
function organizerOf(event: CalendarEvent): InvitedParty | null {
	const property = event.component.getFirstProperty("organizer");
	return property === null ? null : partyOf(property);
}

/** `CN`, or an empty name when the property carries none — never invented. */
function partyOf(property: CalendarProperty): InvitedParty {
	const name = property.getParameter("cn");
	return { name: typeof name === "string" ? name : "", email: addressOf(property) };
}

/**
 * The property's value past `mailto:` when it has that scheme. A value that is
 * not a `mailto:` address is carried as the text as-is — an odd `ORGANIZER` or
 * `ATTENDEE` value is the feature reading it to decide what to do with, not
 * this reader's to judge.
 */
function addressOf(property: CalendarProperty): string {
	const value = property.getFirstValue();
	return typeof value === "string" ? value.replace(/^mailto:/i, "") : "";
}

function timeOf(time: CalendarTime): IcsTime {
	if (time.isDate) {
		return { kind: "date", year: time.year, month: time.month, day: time.day };
	}
	return { kind: "time", at: time.toJSDate() };
}

/**
 * Whether the calendar says this one is off. `EXDATE` is the tidy way to cancel
 * an occurrence and `ical-expander` handles it; Exchange and Google also send a
 * `RECURRENCE-ID` override carrying `STATUS:CANCELLED`, which nothing else here
 * would notice.
 */
function isCancelled(event: CalendarEvent): boolean {
	const status = event.component.getFirstPropertyValue("status");
	return typeof status === "string" && status.toUpperCase() === "CANCELLED";
}

/**
 * Reads the calendar again one event at a time, so that one event the libraries
 * cannot read costs only itself.
 *
 * Grouped by UID rather than split per `VEVENT`, because a `RECURRENCE-ID`
 * override only overrides anything while it sits in the same calendar as the
 * event it overrides.
 *
 * Finding no *complete* event to slice at all means the trouble was not one
 * event: the file is a calendar that stops making sense partway through — half
 * a download, usually — and that is reported rather than answered with an empty
 * day.
 */
function salvage(ics: string, from: Date, to: Date, cause: unknown): IcsReading {
	const { calendars, unclosed } = splitByUid(ics);
	if (calendars.length === 0) {
		// These bytes passed the BEGIN:VCALENDAR check, so they were a calendar
		// and the address that served them may be perfectly right. The count is of
		// complete entries on purpose: a file cut before the first whole event is
		// reported here rather than answered with a loss of one entry of one.
		throw new IcsReadError(`This calendar could not be read: ${reasonOf(cause)}`, "unreadable");
	}

	const found: Occurrence[] = [];
	// A block the file stopped in the middle of, or one the next entry's opening
	// line had to end, is an entry this read cannot have, and it is
	// counted rather than parsed. Handing half an entry to the
	// parser only brings the parser down again, which is the very thing this
	// second pass is here to get around.
	let dropped = unclosed;
	for (const calendar of calendars) {
		try {
			const built = build(calendar);
			dropped += built.dropped;
			found.push(...collect(built.events, built.expander.between(from, to)));
		} catch (error) {
			// A contract break met on this one entry, after the whole-file read
			// had already come down for some other reason — a bad repeat rule, a
			// bad date. It takes two independent failures in one file to get
			// here, which is what the test's stand-in fabricates. The claim that
			// this is what keeps a renamed upstream field from becoming "None of
			// the N entries in this calendar could be read" belongs to the
			// rethrow in `readOccurrencesBetween`, which runs first and is where
			// that failure actually stops. This one is kept because
			// it is cheap and it is the honest answer if the contract ever does
			// break per entry.
			//
			// **This count depends on the day window**, unlike the whole-file
			// read's: `between(from, to)` and the walk over its result both sit
			// in the `try` above, so the same bytes can be dropped on one day
			// and read on another. `announceLoss` knows that and says so.
			if (error instanceof ExpanderContractError) throw error;
			dropped += 1;
		}
	}
	return readingOf(ics, found, dropped, calendars.length + unclosed);
}

/**
 * A reading, with the console line that goes with a loss.
 *
 * Both reads end here, because both of them can lose an entry now: the
 * whole-file read loses one whose dates cannot be read, and the
 * per-entry read loses one that throws or one the file stopped in the middle of. That is deliberate and stays: a whole-file loss deserves the
 * line as much as a per-entry one does.
 */
function readingOf(
	ics: string,
	occurrences: Occurrence[],
	dropped: number,
	total: number,
): IcsReading {
	if (dropped === 0) return { occurrences, loss: null };

	const loss: IcsLoss = { dropped, total };
	announceLoss(ics, loss);
	return { occurrences, loss };
}

/**
 * How many calendars' losses are remembered at once.
 *
 * Far above the handful of calendars anybody has, and only a calendar that lost
 * something is ever remembered at all. Past it the oldest is forgotten, which
 * costs at worst one console line said a second time.
 */
const REMEMBERED_LOSSES = 32;

/**
 * The calendars already heard complaining, each as a print of its bytes.
 *
 * **In the shipped plugin it lasts as long as the module is loaded**, which is
 * until Obsidian re-evaluates the bundle on a re-enable — *probably* empty then,
 * because nothing here measures it. Nothing shipped calls `forgetLossesSaid`;
 * it exists for the tests, where every file that reads the console clears this
 * before each test so no test inherits another test's memory, and it is the
 * door an owner would use if one were ever wanted.
 *
 * **It is not hung off a `Component` the way the plugin's other state is**
 * (`docs/research/obsidian-publishing-requirements.md` § 1). Owning it that way
 * means handing an owner to `readOccurrencesBetween` and to the per-entry read,
 * and through them to `icsReader` — three signatures widened with an argument
 * none of them needs for anything else, so that one console line can be
 * forgotten. The exported reset clears the same state without them.
 */
const lossesSaidAlready = new Set<string>();

/**
 * Forgets every calendar heard complaining, so the next read of any of them
 * says its line again.
 *
 * This is what ends the memory above. It costs at worst one console line said a
 * second time, which is the same currency the eviction below already spends.
 *
 * Tests call it before each test that reads the console: without it the
 * outcome of a whole file depends on the order its tests ran in, because two
 * tests parsing byte-identical bytes share one fingerprint and the second would
 * see no line at all.
 */
export function forgetLossesSaid(): void {
	lossesSaidAlready.clear();
}

/**
 * Says a loss on the console the first time it appears, and then keeps quiet
 * about it.
 *
 * **The line is for whoever is looking at the code. It is not the report** —
 * `loss` is, because Obsidian's console is closed in normal use. That is why it
 * costs nothing to say it once: nobody downstream reads it, and the settings row
 * says the same thing where the person can see it.
 *
 * Saying it every time was the defect. `CalendarSources.meetingsOn`
 * re-reads every stored calendar on every call, and that call runs on every
 * day-view draw and every readiness check, so one dateless entry — the ordinary
 * issue #222 case, and one that is not going to fix itself — wrote a console
 * line continuously. The draw-failure recorder beside it in `calendarSources.ts`
 * was built to write nothing when the failure has not changed; this is the same
 * rule, kept here rather than shared with it because that recorder is handed a
 * source and this is handed a calendar.
 *
 * A calendar is told from another by a print of its bytes, so two calendars
 * losing something each get their own line.
 *
 * **The print is the identity of the loss, not merely the key it is filed
 * under**. The rule is flat: **a print met before is silent,
 * whatever it would say now.** The loss is not a pure function of the bytes on
 * the per-entry read — `salvage` counts a dropped entry from a `catch` wrapped
 * around `between(from, to)` and the walk over what it returns, both of which
 * read the day window — so one calendar can lose a different number of entries
 * on a different day and make a different sentence out of it. **What that costs
 * is that second sentence**: it is never written, and whoever has the console
 * open learns only about the first loss those bytes had. That is
 * affordable because the line is not the report — the settings row still says
 * today's loss today, and `loss` still comes back from every read unchanged.
 *
 * **A loss that clears and comes back is said again because the bytes that come
 * back are not the bytes that went**: an entry repaired and broken afresh is a
 * different file. A calendar reverted to byte-identical bytes it has already been
 * heard complaining about stays quiet, which is the one edge this costs and it
 * costs a console line.
 */
function announceLoss(ics: string, loss: IcsLoss): void {
	const key = fingerprintOf(ics);
	if (lossesSaidAlready.has(key)) return;

	if (lossesSaidAlready.size >= REMEMBERED_LOSSES) {
		// A `Set` walks its members oldest first, so this is the one least
		// recently met.
		const oldest = lossesSaidAlready.values().next().value;
		if (oldest !== undefined) lossesSaidAlready.delete(oldest);
	}
	lossesSaidAlready.add(key);
	console.warn(`Effortless: ${describeLoss(loss)}`);
}

/**
 * A short print of `ics`, the key a loss is remembered under.
 *
 * The bytes themselves are not the key, so that a copy the calendar has since
 * replaced is not held on to for as long as the plugin runs. A djb2 hash beside
 * the length is enough: two calendars colliding would cost one console line that
 * is not written, which is the same currency this whole guard spends, and only a
 * calendar that lost something is ever fingerprinted.
 */
function fingerprintOf(ics: string): string {
	let hash = 5381;
	for (let at = 0; at < ics.length; at += 1) hash = (hash * 33) ^ ics.charCodeAt(at);
	return `${ics.length}:${hash >>> 0}`;
}

/**
 * A loss as a sentence to show someone, ending in a full stop so that a
 * settings row can put it straight after `Failed:` and before the last-read age.
 *
 * **It counts entries, and says so, because that is the unit the code has**. `salvage` slices the file into one calendar per UID, so a weekly
 * stand-up is one entry however many mornings it lands on. Counting the
 * *occurrences* behind a dropped entry is not available at all: an entry is
 * dropped precisely because it will not parse, so how many times it would have
 * repeated does not exist to be counted. Saying "events" invited the number to
 * be read as a count of missing meetings, which it never was.
 *
 * Not exported. `reportLoss` below is what every caller uses, and it is the one
 * the reader module re-exports; this was public surface with no caller outside
 * this file, in a plugin whose source is read by strangers.
 */
function describeLoss(loss: IcsLoss): string {
	// Said in the sentence rather than left to the reader, because "1 of 2" is
	// otherwise read as one meeting out of two.
	const repeats = "a repeating meeting counts as one entry";
	if (loss.dropped < loss.total) {
		return (
			`${loss.dropped} of ${loss.total} entries in this calendar could not be read — ` +
			`${repeats}. Every other entry in it was read.`
		);
	}
	return loss.total === 1
		? `The only entry in this calendar could not be read — ${repeats}.`
		: `None of the ${loss.total} entries in this calendar could be read — ${repeats}.`;
}

/** Whether a calendar lost some of what it holds, or the whole of it. */
export type LossGrade = "partial" | "total";

/** A loss in the two forms a caller needs: what to say, and how bad it was. */
export interface LossReport {
	/** A whole sentence, ending in a full stop, ready to show as it is. */
	readonly reason: string;
	readonly loss: LossGrade;
}

/**
 * A loss as both a sentence and a grade.
 *
 * The sentence alone cannot be told apart afterwards: nothing downstream can
 * see whether "1 of 40 entries" or "none of the 40" is behind it, and the
 * settings row and the draw-failure console line both need to. So
 * the grade travels beside the words rather than being parsed back out of them.
 */
export function reportLoss(loss: IcsLoss): LossReport {
	return { reason: describeLoss(loss), loss: loss.dropped < loss.total ? "partial" : "total" };
}

/** A line that continues the one above it, rather than starting a property. */
function isFolded(line: string): boolean {
	return line.startsWith(" ") || line.startsWith("\t");
}

/** The line's own text, upper-cased for comparison. Empty for a folded line. */
function marker(line: string): string {
	return isFolded(line) ? "" : line.replace(/[ \t\r]+$/, "").toUpperCase();
}

/** What the per-entry split found, and what it could not make an entry of. */
interface SplitCalendar {
	/** One calendar per UID, each carrying the original's header and timezones. */
	readonly calendars: string[];
	/**
	 * Blocks that were opened and never closed, each of them one entry this read
	 * lost.
	 *
	 * Two shapes reach it. The file may stop inside a block, which is the
	 * half-download issue #207 was filed for and is always the last block if it
	 * happens at all. Or a block may run on into the next `BEGIN:VEVENT` without
	 * an `END:VEVENT` of its own, which can happen anywhere in the file and as
	 * often as the file likes. So this is a count and not a flag,
	 * and it was written as one before the code could answer more than one.
	 */
	readonly unclosed: number;
}

/**
 * One calendar per UID, each carrying the original's header and timezones, and
 * how many blocks were left open.
 *
 * This slices the text on its own `BEGIN:VEVENT` and `END:VEVENT` lines rather
 * than parsing it. RFC 5545 folds a long line by starting the next one with a
 * space or a tab, so a line beginning `BEGIN:` is always a real one.
 *
 * **The two answers are kept apart on purpose**. The list is
 * complete entries only, so nothing half-written is ever handed to the parser;
 * the count travels beside it so that a block the download cut through is one
 * entry the read lost, rather than one it silently dropped.
 *
 * **A `BEGIN:VEVENT` met while a block is open ends that block**.
 * Before that, the block stayed open and swallowed the entry below it whole:
 * the two were keyed on the first one's UID, handed to the parser as one
 * calendar with a nested `BEGIN:VEVENT` inside it, and counted as a single lost
 * entry. The second entry was perfectly readable and went missing with nothing
 * said about it, under a sentence that ends by promising every other entry was
 * read. Ending the open block keeps that entry and makes the count honest; the
 * half-written one is unusable either way, because its own text is what carries
 * the nesting.
 */
function splitByUid(ics: string): SplitCalendar {
	const shell: string[] = [];
	const groups = new Map<string, string[]>();
	let block: string[] | null = null;
	let unclosed = 0;

	for (const line of ics.split(/\r\n|\n|\r/)) {
		if (block !== null) {
			// Checked before the line is kept, so that an opening line starts the
			// fresh block rather than joining the one it just ended.
			if (marker(line) === "BEGIN:VEVENT") {
				unclosed += 1;
				block = [line];
				continue;
			}
			block.push(line);
			if (marker(line) === "END:VEVENT") {
				const key = uidKey(block, groups.size);
				const group = groups.get(key);
				if (group === undefined) groups.set(key, block);
				else group.push(...block);
				block = null;
			}
			continue;
		}
		if (marker(line) === "BEGIN:VEVENT") {
			block = [line];
			continue;
		}
		// The closing line is added back per group, and blank lines are dropped
		// so that a trailing newline does not become one inside a rebuilt file.
		if (marker(line) === "END:VCALENDAR" || line.trim() === "") continue;
		shell.push(line);
	}

	const calendars: string[] = [];
	for (const group of groups.values()) {
		calendars.push(shell.concat(group, "END:VCALENDAR", "").join("\r\n"));
	}
	// A block still open when the lines ran out is the half-downloaded case. Its
	// text goes nowhere, the same as a block ended by the next entry's opening
	// line: both are counted and dropped.
	return { calendars, unclosed: block === null ? unclosed : unclosed + 1 };
}

/**
 * What groups a `RECURRENCE-ID` override with the event it overrides. The UID
 * line is used whole: the two must write it identically, or they were never
 * about the same event. An event with no UID gets a group of its own.
 */
function uidKey(block: readonly string[], fallback: number): string {
	for (const line of block) {
		if (isFolded(line)) continue;
		const stop = line.search(/[;:]/);
		if (stop > 0 && line.slice(0, stop).toUpperCase() === "UID") {
			return marker(line);
		}
	}
	return `#${fallback}`;
}
