/**
 * Meeting notes' own memory of the notes it has written: for each meeting, for
 * each day, the path of the note it made and the participant names already
 * accounted for on it.
 *
 * **`accounted` is what makes add-only actually add-only.** *Whether* a
 * name is offered again is decided against `accounted`, never against what
 * the note currently holds: once a name is in `accounted`, ensuring a note never asks for
 * it again, even if the person has since deleted it from the note by hand —
 * the same guarantee the old plugin's ledger gave through its own `names`
 * field. Reading the note's own text still happens, but only to avoid
 * writing a duplicate line for a name that reached the note some other way.
 *
 * **Kept for ever, never pruned by date**, unlike building the days ahead's
 * row memory (`src/features/daysAhead/rowMemory.ts`): a note's path has to be
 * found long after its day, to follow a rename or a move to another day. The
 * old plugin kept its notes ledger without bound for the same reason.
 *
 * **Keyed by the meeting's identity as a plain string.** With the calendar's
 * own occurrence key now on `Meeting`,
 * that identity is the series `uid` alone for a meeting that does not repeat,
 * and the `uid` joined to the occurrence key for one occurrence of a repeat —
 * {@link meetingIdentity} is the one place that joins them, so ensuring a
 * note and every
 * test agree on the shape. The joined string is opaque: nothing reads a `uid`
 * or an occurrence key back out of it, so the separator carries no promise
 * beyond keeping the two apart.
 *
 * **Validated on read.** `notes` lives in `data.json`, which a person can
 * edit by hand, so every reader of it is an input boundary (`CLAUDE.md`,
 * #606,
 * #607): an entry of the
 * wrong shape is dropped and named, never trusted and never thrown on.
 *
 * **What meeting notes last wrote into a note** rides on its entry as
 * {@link NoteMemoryEntry.written}, so a note whose meeting left the
 * calendar can be deleted while it is still only the plugin's.
 */

import type { WrittenRecord } from "./noteRecord";

/** The note written for one meeting on one day, and who has already been accounted for on it. */
export interface NoteMemoryEntry {
	readonly path: string;
	/** Participant names already offered — added, or found already on the note. Never shrinks. */
	readonly accounted: readonly string[];
	/**
	 * Present only while a rename has moved this note but its bundled
	 * heading and day-link correction has not landed — the edit threw, or
	 * the note changed after the run read it. Nothing on
	 * disk can tell a note that still owes its correction from one that is
	 * already right, so this is what makes a later run try it again. Gone
	 * from the entry once a run carries the correction out.
	 */
	readonly pendingCorrection?: PendingCorrection;
	/**
	 * What meeting notes last wrote into the note and when its meeting ends
	 * (`noteRecord.ts`, #1036). Absent on a note made before this record
	 * existed, on one meeting notes adopted, and on one a run has already
	 * said it keeps as the person's — all of them never deleted.
	 */
	readonly written?: WrittenRecord;
	/**
	 * The other notes naming this meeting that a run chose not to keep up to
	 * date and left exactly as they were — the paths the notice "kept
	 * up to date this one and left that one" names. Kept so a later run, which
	 * finds the kept note through this memory and never looks at the others,
	 * can say it again for as long as any of them is still in the vault. Never
	 * empty: absent when there is no left note, and narrowed to the ones still
	 * there on every run.
	 */
	readonly leftNotes?: readonly string[];
}

/**
 * What a note that still owes a rename's correction reads right now: the
 * text of its `# ` heading and its day link's target, both exactly as the
 * note was last written before the rename. A later run corrects each only
 * if the note still says this (`noteEdit.ts`'s own rule), and computes what
 * each should become fresh from today's meeting, never from here.
 */
export interface PendingCorrection {
	/** The title the note's heading still reads, without the leading `# `. */
	readonly heading: string;
	/** The day-link target the note's day-link field still reads, without the brackets. */
	readonly dayLink: string;
}

/** Identity → date (`YYYY-MM-DD`) → what this feature remembers about the note it made that day. */
export type NotesMemory = Readonly<Record<string, Readonly<Record<string, NoteMemoryEntry>>>>;

/** The memory as far as it could be read, and every key whose entry was dropped. */
export interface ReadNotesMemory {
	readonly notes: NotesMemory;
	/**
	 * One name per dropped entry, as the person would find it in `data.json`:
	 * the identity alone where the whole meeting's entry was unusable,
	 * `identity / date` where one day under it was. `notes` itself when the
	 * stored value was not a memory at all.
	 */
	readonly dropped: string[];
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The identity a meeting is remembered under: its series `uid` alone for a
 * meeting that does not repeat, `uid` and occurrence key joined with `::`
 * for one occurrence of a repeat — two different keys for two occurrences of
 * one series (`Meeting.occurrenceKey`'s own doc comment, `src/core/icsReader.ts`).
 * `::` is not read back by anything; it only has to keep the two apart, and a
 * calendar's `uid` is not this memory's own separator by convention.
 */
export function meetingIdentity(uid: string, occurrenceKey: string | null): string {
	return occurrenceKey === null ? uid : `${uid}::${occurrenceKey}`;
}

/**
 * Reads `notes` out of whatever `data.json` held.
 *
 * Dropped, and named in {@link ReadNotesMemory.dropped}: a blank identity, an
 * identity whose value is not an object, a date key that is not `YYYY-MM-DD`,
 * and a day's entry of the wrong shape (see {@link readEntry}). The rest of
 * the memory is kept. A meeting stored with no days at all is dropped under
 * its identity, since it records nothing. Nothing stored means an empty
 * memory and nothing dropped.
 */
export function readNotesMemory(raw: unknown): ReadNotesMemory {
	if (raw === undefined) return { notes: {}, dropped: [] };
	if (!isRecord(raw)) return { notes: {}, dropped: ["notes"] };

	const notes: Record<string, Record<string, NoteMemoryEntry>> = {};
	const dropped: string[] = [];
	for (const [identity, byDate] of Object.entries(raw)) {
		if (identity.trim() === "" || !isRecord(byDate)) {
			dropped.push(identity);
			continue;
		}

		const dates: Record<string, NoteMemoryEntry> = {};
		for (const [date, value] of Object.entries(byDate)) {
			const entry = DATE_KEY.test(date) ? readEntry(value) : null;
			if (entry !== null) dates[date] = entry;
			else dropped.push(`${identity} / ${date}`);
		}
		if (Object.keys(dates).length > 0) notes[identity] = dates;
		else if (Object.keys(byDate).length === 0) dropped.push(identity);
	}
	return { notes, dropped };
}

/**
 * One day's stored entry as this feature can use it, or `null` when it is
 * unusable.
 *
 * **Only the current `{ path, accounted }` shape is accepted**, where `path`
 * is non-blank text and `accounted` is an array of strings, with an
 * optional `pendingCorrection` whose `heading` and `dayLink` are both
 * non-blank text, and an optional `written` whose `fingerprint` is non-blank
 * text and whose `endsAt` is a finite number, and an optional `leftNotes`
 * that is a non-empty array of non-blank text. A `pendingCorrection` present
 * in any other shape drops the whole entry, the same as a bad `accounted`:
 * reading it as absent would silently give up a correction the note still
 * owes, and reading a guess into it could rewrite a heading the note never had. A `written` of
 * the wrong shape drops the entry the same way: read as absent it
 * would quietly keep a note the plugin should delete, and a guessed one could
 * delete a note the person wrote in. A `leftNotes` of the wrong shape, or empty,
 * drops the entry the same way, and the cost is the one the other two
 * carry: the entry's `accounted` goes with it. What it saves is the notice —
 * read as absent, the notes a run left would be forgotten for good, where with
 * the entry gone the next run finds both notes again by the identity each
 * carries and says so again. The names a click offered are on the note itself
 * (`noteIdentity.ts`), so a name the person removed by hand stays removed from
 * a note a click made; a note the run made has no such line, so a removed name
 * is offered again from what the note lists now.
 * #757 shipped a bare
 * non-blank string before `accounted` existed, and this used to read that,
 * and an object missing `accounted` outright, as "nobody accounted for" —
 * silently, with nothing in {@link ReadNotesMemory.dropped}. That is the
 * validate-on-read rule's own failure (`CLAUDE.md`,
 * #606): a value this
 * code cannot use has to be refused and named, never guessed at, the same as
 * an `accounted` that is present but the wrong shape already was. A
 * hand-edited entry that lost `accounted` this way lost the guarantee it
 * exists for too — send-back #761 closes on
 * #777 rather than
 * carrying the gap forward.
 */
function readEntry(value: unknown): NoteMemoryEntry | null {
	if (!isRecord(value)) return null;

	const { path, accounted, pendingCorrection, written, leftNotes } = value;
	if (typeof path !== "string" || path.trim() === "") return null;
	if (!Array.isArray(accounted) || !accounted.every((name) => typeof name === "string")) return null;

	const pending = pendingCorrection === undefined ? undefined : readPendingCorrection(pendingCorrection);
	if (pending === null) return null;
	const record = written === undefined ? undefined : readWritten(written);
	if (record === null) return null;
	const left = leftNotes === undefined ? undefined : readLeftNotes(leftNotes);
	if (left === null) return null;
	return {
		path,
		accounted,
		...(pending === undefined ? {} : { pendingCorrection: pending }),
		...(record === undefined ? {} : { written: record }),
		...(left === undefined ? {} : { leftNotes: left }),
	};
}

/** A stored `leftNotes` as this feature can use it, or `null` when it is unusable — see {@link readEntry}. */
function readLeftNotes(value: unknown): readonly string[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const paths: unknown[] = value;
	return paths.every((path): path is string => typeof path === "string" && path.trim() !== "") ? paths : null;
}

/** A stored `written` as this feature can use it, or `null` when it is unusable — see {@link readEntry}. */
function readWritten(value: unknown): WrittenRecord | null {
	if (!isRecord(value)) return null;
	const { fingerprint, endsAt } = value;
	if (typeof fingerprint !== "string" || fingerprint.trim() === "") return null;
	if (typeof endsAt !== "number" || !Number.isFinite(endsAt)) return null;
	return { fingerprint, endsAt };
}

/** A stored `pendingCorrection` as this feature can use it, or `null` when it is unusable — see {@link readEntry}. */
function readPendingCorrection(value: unknown): PendingCorrection | null {
	if (!isRecord(value)) return null;
	const { heading, dayLink } = value;
	if (typeof heading !== "string" || heading.trim() === "") return null;
	if (typeof dayLink !== "string" || dayLink.trim() === "") return null;
	return { heading, dayLink };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
