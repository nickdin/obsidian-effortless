/**
 * The participant list a meeting note is created with: the organiser and
 * every attendee, minus the person themselves and minus anything that is not
 * a person.
 *
 * Carried unchanged in logic from `~/Devbox/calendar-scaffold/src/names.ts`
 * (`deltagare`, `isPerson`, `flipAttendee`, `fold`), spec
 * #701 decision 13. That
 * module's own measurements were of one real calendar and are not carried —
 * what carries is the rule each measurement supports, not the count:
 *
 * - **A calendar's display name is often surname-first, with an employee
 *   number on the end** (`Surname Given (nnnn)`), and a surname can be more
 *   than one word, so "first word is the surname" is wrong; a given name can
 *   also be more than one word, so "last word is the given name" is wrong
 *   too. **The address settles the order**: its first dot-separated component
 *   is the given name, and flipping only happens when that component matches
 *   one end of the display name's words. An address that cannot settle the
 *   order leaves the name exactly as the calendar wrote it — a wrong guess
 *   would invent a plausible name for a person who does not exist, and this
 *   list is never corrected once written.
 * - **Some invited addresses are not a person at all**: a distribution list,
 *   a room system, a shared mailbox, or a bare address the calendar never
 *   attached a name to. The signal is the address's local part: a person's
 *   has a dot in it, none of the others do.
 *
 * This module joins no other feature's — nothing here is shared with another
 * one, so it stays out of `src/core/meetingName.ts`.
 */

import type { InvitedParty, Meeting } from "../../core/icsReader";

/**
 * The employee number a calendar's display name appends. Any number of
 * digits.
 */
const EMPLOYEE_NUMBER = /\s*\(\d+\)\s*$/;

/** `Surname, Given` — one shape an external attendee's display name arrives in. */
const COMMA_FORM = /^([^,]+),\s*(.+)$/;

/**
 * Characters that cannot appear inside `[[…]]` in a quoted YAML scalar.
 * `[ ] # ^ |` all change what a wikilink means; `"` would end the scalar the
 * name sits in, and a backslash starts an escape sequence inside it.
 */
const UNSAFE_IN_LINK = /["[\]#^|\\\r\n]/g;

const WHITESPACE_RUN = /\s+/g;

/**
 * The name with the employee number dropped and the words in the order the
 * vault writes them.
 *
 * The result is always safe to sit inside `[[…]]` in quoted YAML.
 *
 * Returns the name unchanged — minus the number — whenever the email cannot
 * settle the order. That covers a missing email, a display name that is
 * already `Given Surname`, and a display name carrying a suffix the address
 * knows nothing about. **Leaving it alone is the right failure**: a wrong
 * guess produces a plausible name for a person who does not exist, and the
 * list this feeds is add-only, so the plugin could never take it back out.
 */
export function flipAttendee(name: string, email: string): string {
	// Sanitised first, so the words the order is worked out from are the words
	// that will be written. Doing it afterwards looks equivalent and is not: a
	// stray bracket would still be part of a word here, no suffix would match
	// the address, and the name would come back in the calendar's order with
	// the bracket quietly removed — a wrong answer that reads like a right one.
	const withoutNumber = linkSafe(name).replace(EMPLOYEE_NUMBER, "").trim();

	const given = givenNameFromEmail(email);

	// `Surname, Given` — but only when the address says the part after the
	// comma really is the given name. An unconfirmed comma flip is not a near
	// miss: a display name like `Exempelsson Bo (0001), Example AB` would come
	// back as `Example AB Exempelsson Bo (0001)`, an employer written into a
	// list of people, with the employee number still attached, in a list that
	// can never be corrected.
	const comma = COMMA_FORM.exec(withoutNumber);
	if (comma !== null && given !== null && fold(comma[2]) === given) {
		return `${comma[2].trim()} ${comma[1].trim()}`;
	}

	const words = withoutNumber.split(WHITESPACE_RUN).filter((word) => word.length > 0);
	if (given === null || words.length < 2) return withoutNumber;

	// How many words at the end make up the given name. One in almost every
	// case, two for a two-word given name. Never all of them: a name whose
	// every word is the given name has no surname to move.
	for (let count = 1; count < words.length; count++) {
		const trailing = words.slice(words.length - count);
		if (fold(trailing.join("")) === given) {
			return [...trailing, ...words.slice(0, words.length - count)].join(" ");
		}
	}
	return withoutNumber;
}

/**
 * Whether an invited party is a person whose name belongs in the participant
 * list.
 *
 * Three tests, each excluding one shape a calendar can hand back:
 *
 *  - **no space in the display name** — an address's local part standing in
 *    for a name the calendar never learned;
 *  - **an `@` in the display name** — the same thing one step further along;
 *  - **no dot in the email's local part** — a distribution list, a shared
 *    mailbox or a room system, invited exactly like a person.
 *
 * A party with no email at all fails the third test and is left out. That is
 * the cautious direction: the list this feeds is add-only, so a name written
 * in error stays until the person removes it by hand, while a name left out
 * appears the moment the calendar supplies the address.
 */
export function isPerson(party: InvitedParty): boolean {
	const name = party.name.trim();
	if (name.length === 0) return false;
	if (!name.includes(" ")) return false;
	if (name.includes("@")) return false;

	const at = party.email.indexOf("@");
	if (at <= 0) return false;
	return party.email.slice(0, at).includes(".");
}

/**
 * The participant list a created meeting note carries: the organiser and
 * every attendee, in that order, minus `selfEmail`, minus everything that is
 * not a person, each flipped and made safe to sit inside `[[…]]`.
 *
 * Order is the calendar's, not alphabetical — the organiser first, then the
 * invitation's own order.
 *
 * Duplicates are dropped: an organiser is often also listed as an attendee,
 * and the list carries them once.
 *
 * **The list is never shortened.** A meeting with many invited people gets a
 * name for every one of them; which meeting is worth a long list is not
 * something this function can tell, and removing a name is the person's to
 * do.
 *
 * @param selfEmail The address left off the list, matched case-insensitively.
 *   The person is excluded by address rather than by name because the
 *   address is one string and the name is not. Blank leaves everyone in.
 */
export function participants(meeting: Meeting, selfEmail: string): string[] {
	const self = selfEmail.trim().toLowerCase();
	const parties: InvitedParty[] = [
		...(meeting.organizer !== null ? [meeting.organizer] : []),
		...meeting.attendees,
	];

	const names: string[] = [];
	const seen = new Set<string>();
	for (const party of parties) {
		// Guarded on a set address. Without the guard, a blank setting would
		// match every party whose address the calendar left empty — an
		// exclusion nobody asked for, arrived at by accident.
		if (self.length > 0 && party.email.trim().toLowerCase() === self) continue;
		if (!isPerson(party)) continue;

		const name = flipAttendee(party.name, party.email);
		if (name.length === 0 || seen.has(name)) continue;
		seen.add(name);
		names.push(name);
	}
	return names;
}

/**
 * The given name as the address spells it: the first dot-component of the
 * local part, with a disambiguating number dropped and accents folded away,
 * since the address has none and the display name does.
 *
 * Returns null when there is no address to read.
 */
function givenNameFromEmail(email: string): string | null {
	const at = email.indexOf("@");
	if (at <= 0) return null;
	const local = email.slice(0, at).replace(/\d+$/, "");
	const first = local.split(".")[0];
	const folded = fold(first);
	return folded.length > 0 ? folded : null;
}

/**
 * Letters an address spells with different letters rather than with the same
 * one undecorated.
 *
 * Unicode decomposition handles a letter plus a combining mark. **It does
 * not handle a letter that is not decomposable at all** — `ø`, `æ`, `ß` and
 * the others below are letters in their own right, so decomposition leaves
 * them and dropping everything non-ASCII afterwards would delete them
 * outright rather than fold them to something an address could spell.
 */
const NON_DECOMPOSING = new Map([
	["ø", "o"],
	["æ", "ae"],
	["œ", "oe"],
	["ß", "ss"],
	["ð", "d"],
	["đ", "d"],
	["ł", "l"],
	["þ", "th"],
	["ħ", "h"],
	["ı", "i"],
]);

/**
 * A string reduced to what an email address could carry: the letters above
 * rewritten, accents removed, lower-cased, and everything that is not an
 * ASCII letter or a digit dropped — so a display name and its address's
 * local part compare equal despite hyphens, accents and case.
 */
function fold(value: string): string {
	const rewritten = [...value.toLowerCase()]
		.map((character) => NON_DECOMPOSING.get(character) ?? character)
		.join("");
	return rewritten
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "")
		.replace(/[^a-z0-9]/g, "");
}

/** The name with anything that would break a `[[…]]` link removed. */
function linkSafe(name: string): string {
	return name.replace(UNSAFE_IN_LINK, " ").replace(WHITESPACE_RUN, " ").trim();
}
