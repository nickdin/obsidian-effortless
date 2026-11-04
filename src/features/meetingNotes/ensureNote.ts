/**
 * The one pure decision at the heart of meeting notes: given a meeting,
 * today's date, what is on disk at the paths that matter, this feature's own
 * memory and its template, say what to do and what to remember.
 *
 * Mirrors `~/Devbox/calendar-scaffold/src/meeting-note.ts`'s `ensureNote` and
 * `ensureNotes`, with the calendar and the vault lifted out: nothing here
 * reaches Obsidian. What the old plugin's `NoteVault` and `Ledger` gave those
 * functions arrives instead as {@link NoteLookup} — whether something is at a
 * path right now, and, separately, what its whole text is — and
 * {@link NotesMemory}, both plain data a test builds by hand.
 *
 * In this order of preference:
 *
 *  1. **Nothing to do** — the memory names a note for this meeting on this
 *     day, it exists, and either every invited name is already on its list or
 *     none of the newly invited names could be added at all — the same
 *     refusal {@link editNote} would give {@link updateInPlace} covers here.
 *  2. **Updated** — the same note, but a name the calendar has newly invited
 *     is missing from its list, or an earlier rename's correction never
 *     landed ({@link NoteMemoryEntry.pendingCorrection}); both go through
 *     {@link editNote} in one plan.
 *  3. **Renamed** — the memory names a note for this meeting on a day it no
 *     longer occurs on, or under another title; it moves to the path computed
 *     from the meeting's note date (its first day, #1013), and its heading, day link and any newly invited names are
 *     corrected in the same plan. An edit {@link editNote} refuses is
 *     reported and that one line left alone; the rename itself still stands.
 *  4. **Adopted** — something is already at the computed path and the memory
 *     has no record of it. Its content is never read, compared or corrected.
 *  5. **Created** — nothing anywhere; the text comes from {@link noteText}.
 *
 * **Identity.** A meeting is remembered under {@link meetingIdentity}: its
 * series `uid` alone, or `uid` and occurrence key joined for one occurrence
 * of a repeat. Two occurrences of one series carry two different keys, so a rescheduled
 * occurrence is found and renamed under its own key rather than confused with
 * an ordinary occurrence of the same series — the conservative fallback
 * `#701`'s spec named before the core carried occurrence identity is gone,
 * and this is the parity `#701`'s § *Named differences* row 6 reads.
 *
 * **More than one day this identity's memory names, none of them today,
 * cannot be told apart** — carried unchanged from the old plugin: guessing
 * which one the meeting is now about risks moving the wrong file. None of
 * them is renamed and a fresh note is made instead, with the abandoned paths
 * named in `refused` so a person can merge them by hand. This is rarer with
 * occurrence identity than it was under a shared series id, but the memory
 * can still accumulate more than one entry for one identity if an earlier
 * rename kept failing.
 *
 * **A name is offered at most once.** {@link NoteMemoryEntry.accounted}
 * carries every name this feature has already added or found already on the
 * note, and *whether* to offer a name again is decided against it, never
 * against the note's own current text — the guarantee the old plugin's
 * ledger gave through its own `names` field, so a name the person removes by
 * hand never comes back. The note's text is still read, through
 * {@link readParticipants}, but only to skip writing a duplicate line for a
 * name that reached the note some other way — see {@link NotesMemory}'s own
 * doc comment.
 *
 * **The day link.** {@link noteText} and the rename plan's day-link
 * correction both need the day's log's own wikilink target — its basename,
 * resolved through `src/core/vaultLayout.ts`'s naming rather than assumed to
 * equal `date` — because `date` is this feature's own `YYYY-MM-DD` memory key
 * and path date, and the day's log may be named under any pattern.
 */

import { endsAtOf } from "../../core/icsReader";
import type { Meeting } from "../../core/icsReader";
import { UNTITLED_MEETING_TITLE, meetingNoteDate, meetingNoteTitle } from "../../core/meetingName";
import { frontmatterEnd } from "../../core/markdownSections";
import { reasonOf } from "../../core/reason";
import type { VaultLayout } from "../../core/settings";
import { dailyLogPath } from "../../core/vaultLayout";
import { offeredInText, unchangedSinceWritten, withNamesOffered, withWrittenLine, withWrittenLineRefreshed } from "./noteIdentity";
import { meetingIdentity } from "./notesMemory";
import type { WrittenRecord } from "./noteRecord";
import type { NoteMemoryEntry, NotesMemory, PendingCorrection } from "./notesMemory";
import { meetingNotePath, readMeetingNotePath } from "./notePath";
import { editNote, readParticipants } from "./noteEdit";
import type { NoteEditPlan } from "./noteEdit";
import { noteText } from "./noteText";
import { participants } from "./participants";
import type { MeetingNoteTemplate } from "./types";

/**
 * Whatever is at a path in the vault right now, split into an existence
 * check and a content read so that a caller who only needs to know whether
 * something is there — adopting a note, or finding a rename's target
 * occupied — never has to read it (decision 10's own Adopt sentence: an
 * adopted note's contents are never read, compared or corrected). The
 * caller supplies both — `#762`'s wiring reads `exists` and `read` off
 * `app.vault`; a test builds them from a fixed `Record<string, string>`.
 */
export interface NoteLookup {
	/** Whether something is at `path` right now, without reading it. */
	readonly exists: (path: string) => boolean;
	/** The whole text at `path` right now, or `null` when nothing is there. */
	readonly read: (path: string) => string | null;
	/**
	 * The paths of the notes in the meeting notes folder whose name is the
	 * placeholder title on `date` — an older build's note for a meeting that
	 * then had no title. Read from the folder, not from memory, since
	 * the point is a note memory never held. Absent where a caller has no
	 * folder listing, which reads as none.
	 */
	readonly placeholderNotesOn?: (date: string) => readonly string[];
	/**
	 * The paths of the notes anywhere in the vault whose frontmatter names
	 * `identity` (`noteIdentity.ts`) — the notes a click created or a run made on the day, which memory
	 * may never have held. Absent where a caller has no way to look,
	 * which reads as none.
	 */
	readonly notesNamingIdentity?: (identity: string) => readonly string[];
}

/** What this run should remember for one meeting's identity and date, or nothing when a refusal leaves the memory as it was. */
export interface RememberedNote {
	readonly identity: string;
	readonly date: string;
	readonly path: string;
	/** Every participant name now accounted for — see {@link NoteMemoryEntry.accounted}. */
	readonly accounted: readonly string[];
	/**
	 * Never set by {@link ensureNote}; the run sets it from
	 * {@link EnsureNoteResult.owed} when a rename lands and its correction
	 * does not — see {@link NoteMemoryEntry.pendingCorrection}.
	 */
	readonly pendingCorrection?: PendingCorrection;
	/**
	 * Never set by {@link ensureNote} either; the run sets it from the write
	 * it landed — see {@link NoteMemoryEntry.written}.
	 */
	readonly written?: WrittenRecord;
	/**
	 * Set by {@link ensureNote} only while a note it left as it is still exists — see {@link NoteMemoryEntry.leftNotes}. Absent otherwise.
	 */
	readonly leftNotes?: readonly string[];
}

export interface EnsureNoteResult {
	readonly outcome: "created" | "adopted" | "updated" | "renamed" | "nothing-to-do" | "collided";
	/** Where the note is (or would be) once this run's decision is carried out. */
	readonly path: string;
	/** Where the note was before this run's decision moves it. Present only on `renamed`. */
	readonly previousPath?: string;
	/**
	 * The note's whole text once this run's decision is carried out — the
	 * caller writes it at `path`. Present on `created`, and on `updated` and
	 * `renamed` when at least one edit was applied; absent when there is
	 * nothing to write.
	 */
	readonly text?: string;
	/** Short phrases naming what was rewritten inside the note, if anything. */
	readonly applied: readonly string[];
	/**
	 * What this run deliberately did not do, and why — an edit
	 * {@link editNote} refused because the note no longer says what this
	 * feature last wrote, a collision it would otherwise have had to guess
	 * its way past, or (on `collided`) the one reason nothing was done at
	 * all.
	 */
	readonly refused: readonly string[];
	/**
	 * The correction this note still owes when `text` is not written after
	 * all — present on `renamed` whenever its plan carries a heading and
	 * day-link correction, and on `updated` or `nothing-to-do` when this run
	 * retries one an earlier rename left owing. `remember` never
	 * carries it: it says what to store once the write lands, and a landed
	 * write owes nothing. The caller stores this as
	 * {@link NoteMemoryEntry.pendingCorrection} when a rename lands and its
	 * correction does not, and keeps the problem standing, in the rename's own
	 * words, for as long as it is owed.
	 */
	readonly owed?: PendingCorrection;
	/**
	 * What the caller should write into {@link NotesMemory} once its own
	 * write (if any) succeeds, or `null` on `collided` — nothing under
	 * today's own date is added or moved. See {@link forget} for a stale
	 * entry that may still be dropped even then.
	 */
	readonly remember: RememberedNote | null;
	/**
	 * Dates under this identity the caller should drop from
	 * {@link NotesMemory} once its own write (if any) succeeds: a today's
	 * date entry whose file is gone — stale regardless of anything else this
	 * run decides, so it is always here when that happened — and, only once
	 * a rename actually goes through, the day the meeting has moved away
	 * from. Empty when nothing needs forgetting.
	 *
	 * Carried from the old plugin's own `forgetNote` calls
	 * (`calendar-scaffold/src/meeting-note.ts:263,406`), which mutated its
	 * ledger directly and immediately; this pure function hands the dates
	 * back instead, for `#762`'s wiring to drop once its own write lands.
	 */
	readonly forget: readonly string[];
}

/**
 * The day's log's own wikilink target for `date`: {@link dailyLogPath}'s
 * basename, with the folder and the `.md` extension both taken off, the way
 * {@link noteText} and a wikilink built from `meetingNoteBasename` both need.
 *
 * Throws exactly where {@link dailyLogPath} throws — a blank daily-log folder
 * or filename pattern. {@link dayLinkOrRefusal} is what a caller reaches for
 * instead of catching that itself.
 */
function dayLinkTarget(date: string, layout: VaultLayout): string {
	const path = dailyLogPath(localDateFromKey(date), layout);
	return path.replace(/^.*\//, "").replace(/\.md$/i, "");
}

/**
 * {@link dayLinkTarget}, with a blank daily-log layout turned into a
 * refusal instead of a thrown error.
 *
 * Only `created`, `renamed` and a retried correction ever call this —
 * {@link dailyLogPath}'s own thrown message already names the Effortless
 * setting to fill, so it is handed back as the refusal sentence unchanged. `nothing-to-do`, `updated` with no correction owed and `adopted`
 * never need the day link at all and never reach here, so a blank layout
 * does not stop them.
 */
export function dayLinkOrRefusal(date: string, layout: VaultLayout): { readonly target: string } | { readonly refused: string } {
	try {
		return { target: dayLinkTarget(date, layout) };
	} catch (error) {
		return { refused: reasonOf(error) };
	}
}

/**
 * `date` is always this feature's own `YYYY-MM-DD` key, so parsing it back
 * into a local `Date` — the shape {@link dailyLogPath} takes — never meets an
 * ambiguous or out-of-range value; it only ever exists to feed that one call.
 */
function localDateFromKey(date: string): Date {
	const [year, month, day] = date.split("-").map(Number);
	return new Date(year, month - 1, day);
}

/** A note this feature already remembers for one meeting on one day, and where it came from. */
interface FoundNote {
	readonly path: string;
	/** The day this note was recorded under, when that is not `date` — the day the meeting has moved away from. */
	readonly movedFrom: string | null;
	/** What is at `path` right now — {@link locateExisting} only ever hands back a note it has just read. */
	readonly content: string;
	/** Who this feature has already accounted for on this note — {@link NoteMemoryEntry.accounted}. */
	readonly accounted: readonly string[];
	/** The correction an earlier rename of this note never landed — {@link NoteMemoryEntry.pendingCorrection}. */
	readonly pending: PendingCorrection | null;
	/**
	 * Set where the note was chosen for the person's words in it: it stays where
	 * it is rather than being renamed onto a path another note occupies.
	 */
	readonly keepsItsPath?: boolean;
}

/**
 * Finds the note this feature already remembers for `identity`, the same
 * preference `~/Devbox/calendar-scaffold/src/meeting-note.ts`'s
 * `locateExistingNote` reads: today's own record first, then — because
 * `identity` already names one specific occurrence — any other day the
 * memory still names for it, which can only be a day this occurrence has
 * moved away from.
 */
function locateExisting(
	identity: string,
	date: string,
	memory: NotesMemory,
	existing: NoteLookup,
): { readonly found: FoundNote | null; readonly stranded: readonly string[]; readonly staleOwn: string | null } {
	const byDate = memory[identity] ?? {};

	const own = byDate[date];
	let staleOwn: string | null = null;
	if (own !== undefined) {
		const content = existing.read(own.path);
		if (content !== null) {
			return {
				found: { path: own.path, movedFrom: null, content, accounted: own.accounted, pending: own.pendingCorrection ?? null },
				stranded: [],
				staleOwn: null,
			};
		}
		// The note this feature was keeping for today is gone — deleted, or
		// moved somewhere of the person's own choosing. Old code forgot it at
		// once (`calendar-scaffold/src/meeting-note.ts:406`); this pure
		// function names it instead, whatever the rest of this call decides.
		staleOwn = date;
	}

	const abandoned: Array<{ recorded: string; entry: NoteMemoryEntry; content: string }> = [];
	for (const [recorded, entry] of Object.entries(byDate)) {
		if (recorded === date) continue;
		const content = existing.read(entry.path);
		if (content !== null) abandoned.push({ recorded, entry, content });
	}

	if (abandoned.length === 1) {
		const [{ recorded, entry, content }] = abandoned;
		return {
			found: {
				path: entry.path,
				movedFrom: recorded,
				content,
				accounted: entry.accounted,
				pending: entry.pendingCorrection ?? null,
			},
			stranded: [],
			staleOwn,
		};
	}

	if (abandoned.length > 1) {
		const paths = abandoned.map(({ entry }) => entry.path);
		return {
			found: null,
			stranded: [
				`this meeting has changed day more than once and this feature has ` +
					`${paths.length} earlier notes for it — ${paths.join(", ")}. It cannot ` +
					`tell which one the meeting is now about, so it renamed none of them ` +
					`and made a new note instead. Merge them by hand and delete the ones ` +
					`you do not want.`,
			],
			staleOwn,
		};
	}

	return { found: null, stranded: [], staleOwn };
}

/**
 * Whether `text` holds the person's words. A note a click made carries the
 * fingerprint of the body it wrote (`noteIdentity.ts`), and so does one the run
 * made; the run rewrites the line itself whenever its own edit changes the
 * body of a note that still matched it. Such a note holds words exactly
 * when its body is no longer what its line records, whatever the invitation or the template say
 * today. A note without a usable fingerprint, made before the click wrote
 * one, is judged by today's rule: a line below the frontmatter that is neither
 * blank, nor the note's title heading, nor a line of the template body `meeting`
 * would be given now. Frontmatter is the run's own to keep up to date and
 * never counts.
 */
export function holdsContent(text: string, meeting: Meeting, template: MeetingNoteTemplate, layout: VaultLayout): boolean {
	const unchanged = unchangedSinceWritten(text);
	if (unchanged !== null) return !unchanged;
	const bodyOf = (note: string): string[] => {
		const lines = note.split(/\r?\n/);
		return lines.slice(frontmatterEnd(lines) + 1);
	};
	const fresh = new Set(bodyOf(noteText(meeting, "", template, [], layout)));
	let titleSeen = false;
	for (const line of bodyOf(text)) {
		if (line.trim() === "") continue;
		// The first heading is the note's title, whether or not it is today's:
		// a second heading is the person's own.
		if (!titleSeen && line.startsWith("# ")) {
			titleSeen = true;
			continue;
		}
		if (fresh.has(line)) continue;
		return true;
	}
	return false;
}

/**
 * Which of several notes naming one meeting is its note: the one holding the
 * person's words, then the one at the computed `path`, then a single note
 * anywhere; `null` when none can be preferred. The one rule a run
 * ({@link locateIdentified}) and a click (`clickFill`) both choose by, so the
 * click never opens a note the run then passes over.
 */
export function chooseNamedNote(
	named: readonly string[],
	path: string,
	holdsWords: (candidate: string) => boolean,
): { readonly chosen: string; readonly byWords: boolean } | null {
	const withWords = named.filter(holdsWords);
	if (withWords.length === 1) return { chosen: withWords[0], byWords: true };
	if (named.includes(path)) return { chosen: path, byWords: false };
	if (named.length === 1) return { chosen: named[0], byWords: false };
	return null;
}

/**
 * The note a click created, or a run made on the day, for `identity`, when
 * memory holds no record of it: the one that names the identity in its own
 * frontmatter. Never a
 * path memory already holds — that note belongs to whatever entry names it.
 *
 * With several, the one holding the person's words wins, then the one at the
 * computed path; a single note anywhere is a note created before a move of
 * day or in another folder. Several notes none of which can be preferred are
 * not told apart, so none is taken and the notice names them. The run says so
 * when it passes a note over for another, so a second click's empty note never
 * quietly wins over the one holding the preparation.
 */
function locateIdentified(
	identity: string,
	path: string,
	memory: NotesMemory,
	existing: NoteLookup,
	template: MeetingNoteTemplate,
	meeting: Meeting,
	layout: VaultLayout,
): { readonly found: FoundNote | null; readonly stranded: readonly string[]; readonly left: readonly string[] } {
	const held = pathsHeldBy(memory);
	const named = (existing.notesNamingIdentity?.(identity) ?? []).filter((candidate) => !held.has(candidate));
	const choice = chooseNamedNote(named, path, (candidate) => {
		const text = existing.read(candidate);
		return text !== null && holdsContent(text, meeting, template, layout);
	});
	if (choice === null) {
		if (named.length === 0) return { found: null, stranded: [], left: [] };
		return {
			found: null,
			left: [],
			stranded: [
				`this meeting has ${named.length} notes that name it — ${named.join(", ")} — and none is at ` +
					`${path}. It cannot tell which one to keep up to date, so it used none of them. ` +
					`Delete the ones you do not want.`,
			],
		};
	}
	const { chosen, byWords } = choice;
	const content = existing.read(chosen);
	if (content === null) return { found: null, stranded: [], left: [] };
	const left = named.filter((candidate) => candidate !== chosen);
	const stranded = left.length === 0 ? [] : [keptAndLeftNoteSentence(chosen, left)];
	// The names the click offered are on the note itself (`noteIdentity.ts`), so
	// a name the person has since removed by hand stays removed. A note
	// made by a click before that was written, or one the run made (it writes no
	// offered line, #1122), has no such record; what is on it
	// now stands for what was offered, and a removed name is offered again.
	const accounted = offeredInText(content) ?? readParticipants(content, template.participantsField) ?? [];
	return {
		found: { path: chosen, movedFrom: null, content, accounted, pending: null, keepsItsPath: byWords },
		stranded,
		left,
	};
}

/**
 * The notice that names the note a run kept up to date and the ones it left as
 * they are. Said by the run that chose between them ({@link locateIdentified})
 * and by every later run that finds the kept note through memory while a left
 * note still exists, in the same words.
 */
function keptAndLeftNoteSentence(kept: string, left: readonly string[]): string {
	return (
		`this meeting has ${left.length + 1} notes made by a click. It kept up to date ${kept}, ` +
		`which holds your own words, and left ${left.join(", ")} as it is. ` +
		`Move anything you need across and delete the ones you do not want.`
	);
}

/**
 * The notes a run left as it is that are still in the vault: the ones the
 * memory entry for `keptPath` recorded, narrowed to those that exist now. The notice stands while any of them does and goes with the last.
 */
function standingLeftNotes(identity: string, keptPath: string, memory: NotesMemory, existing: NoteLookup): string[] {
	const entry = Object.values(memory[identity] ?? {}).find((candidate) => candidate.path === keptPath);
	return (entry?.leftNotes ?? []).filter((candidate) => candidate !== keptPath && existing.exists(candidate));
}

type PlaceholderNote =
	| { readonly kind: "none" }
	| { readonly kind: "one"; readonly path: string }
	| { readonly kind: "ambiguous"; readonly notice: string };

/** Every note path any memory entry names, for any meeting and any day. */
function pathsHeldBy(memory: NotesMemory): Set<string> {
	const held = new Set<string>();
	for (const byDate of Object.values(memory)) for (const entry of Object.values(byDate)) held.add(entry.path);
	return held;
}

/**
 * Whether `meeting` is over at `now`, by the core's one rule for it — an
 * all-day meeting runs to the midnight after its last day. Without a
 * clock nothing is over.
 */
function hasEnded(meeting: Meeting, now: Date | null): boolean {
	return now !== null && endsAtOf(meeting) <= now.getTime();
}

/**
 * Whether `meeting` gets as far as the placeholder step: a real title, no
 * note memory can still find for it, none at its own path, and not over. The
 * one test both {@link ensureNote} (to decide) and {@link ensureNotes} (to
 * count rivals) use, so the two cannot disagree.
 */
function reachesPlaceholderStep(
	meeting: Meeting,
	runDay: string,
	folder: string,
	existing: NoteLookup,
	memory: NotesMemory,
	now: Date | null,
): boolean {
	const identity = meetingIdentity(meeting.uid, meeting.occurrenceKey);
	const date = meetingNoteDate(meeting, runDay);
	return (
		meetingNoteTitle(meeting.summary) !== UNTITLED_MEETING_TITLE &&
		!hasEnded(meeting, now) &&
		locateExisting(identity, date, memory, existing).found === null &&
		(existing.notesNamingIdentity?.(identity) ?? []).length === 0 &&
		!existing.exists(meetingNotePath(folder, date, meeting.summary))
	);
}

/**
 * Which placeholder note, if any, a meeting with no memory takes over. Never
 * a guess: exactly one note under the placeholder name for the day, and no
 * other meeting of the day competing for it, or nothing is renamed and the
 * notice names every candidate.
 */
function placeholderNoteFor(
	title: string,
	date: string,
	existing: NoteLookup,
	memory: NotesMemory,
	rivals: number,
): PlaceholderNote {
	if (title === UNTITLED_MEETING_TITLE) return { kind: "none" };
	// A note any memory entry holds belongs to the meeting that entry names —
	// a meeting still untitled, or one whose own rename is in this same run —
	// never to a newcomer.
	const held = pathsHeldBy(memory);
	const paths = (existing.placeholderNotesOn?.(date) ?? []).filter((path) => !held.has(path));
	if (paths.length === 0) return { kind: "none" };
	if (paths.length === 1 && rivals === 0) return { kind: "one", path: paths[0] };
	return {
		kind: "ambiguous",
		notice:
			`"${title}" has no note yet, and ${paths.length === 1 ? "one note" : `${paths.length} notes`} ` +
			`from before its calendar entry had a title could be its own — ${paths.join(", ")}. ` +
			`It cannot tell which, so it renamed none of them and made a new note instead. ` +
			(paths.length === 1
				? `If it is this meeting's, rename it by hand.`
				: `Rename the right one by hand and delete the others.`),
	};
}

/**
 * The names to actually ask {@link editNote} to add: every wanted name not
 * already accounted for, and — belt and braces, since `accounted` only ever
 * grows from what was actually written — not already sitting on the note's
 * own list either, read through {@link readParticipants}. `accounted` alone
 * decides *whether* a name is ever offered again (see the module comment);
 * this second check only stops a duplicate line for a name that reached the
 * note some other way, such as the person typing it in themselves.
 */
function namesToAdd(
	content: string,
	participantsField: string,
	wanted: readonly string[],
	accounted: readonly string[],
): string[] {
	const onNote = readParticipants(content, participantsField) ?? [];
	return wanted.filter((name) => !accounted.includes(name) && !onNote.includes(name));
}

/**
 * {@link editNote}, and the names it wrote joined to the note's own offered
 * record in the same text, so a name the run added and the person then removes
 * is not added back by a device whose notes memory has no entry. A note
 * with no offered record — one a run wrote, or an old clicked one — is edited as
 * {@link editNote} alone does.
 */
function editRecordingOffered(
	content: string,
	plan: NoteEditPlan,
	template: MeetingNoteTemplate,
	layout: VaultLayout,
): ReturnType<typeof editNote> {
	const edited = editNote(content, plan, template, layout);
	return { ...edited, text: withNamesOffered(edited.text, edited.addedNames) };
}

/** Both lists, in order, with no name twice — {@link NoteMemoryEntry.accounted} only ever grows. */
function union(accounted: readonly string[], added: readonly string[]): string[] {
	const merged = [...accounted];
	for (const name of added) if (!merged.includes(name)) merged.push(name);
	return merged;
}

/**
 * Makes sure `meeting` has a note for the run's day `runDay`, dated as {@link meetingNoteDate} says, following it if the calendar
 * has moved or renamed it, and correcting the three lines {@link editNote}
 * owns. See the module comment for the full order of preference.
 */
export function ensureNote(
	meeting: Meeting,
	runDay: string,
	layout: VaultLayout,
	folder: string,
	existing: NoteLookup,
	memory: NotesMemory,
	template: MeetingNoteTemplate,
	selfEmail: string,
	placeholderRivals = 0,
	now: Date | null = null,
): EnsureNoteResult {
	// The note's own date, which on a later day of a several-day meeting is its
	// first day, not `runDay` (#1013 — see meetingNoteDate). Everything below is about
	// the note, so it reads this date.
	const date = meetingNoteDate(meeting, runDay);
	const identity = meetingIdentity(meeting.uid, meeting.occurrenceKey);
	const path = meetingNotePath(folder, date, meeting.summary);
	const title = meetingNoteTitle(meeting.summary);
	const wanted = participants(meeting, selfEmail);

	const located = locateExisting(identity, date, memory, existing);
	const { staleOwn } = located;
	let found = located.found;
	const stranded = [...located.stranded];
	// Notes this run leaves as they are beside the one it keeps: the ones a
	// choice between click-made notes just left, or, for a note memory found, the
	// ones the memory recorded when it was chosen and that are still there.
	let leftNotes: readonly string[] = [];
	if (found === null) {
		const identified = locateIdentified(identity, path, memory, existing, template, meeting, layout);
		found = identified.found;
		stranded.push(...identified.stranded);
		leftNotes = identified.left;
	} else {
		leftNotes = standingLeftNotes(identity, found.path, memory, existing);
		if (leftNotes.length > 0) stranded.push(keptAndLeftNoteSentence(found.path, leftNotes));
	}
	const forget = staleOwn !== null ? [staleOwn] : [];

	if (found !== null) {
		// Keyed on whether the computed path has changed, not on whether the
		// memory found this note under another day — the old plugin's own
		// rule (`calendar-scaffold/src/meeting-note.ts:244`, `found.path !==
		// path`). A title change on the same day moves `found.movedFrom`
		// nowhere — it stays null, this note is still today's own record —
		// but the computed path still differs, and that is what a rename
		// means.
		// The one exception: a note chosen for the person's words, with another
		// note already at the computed path, stays where it is and is kept up to
		// date there, since a rename onto an occupied path is a collision that
		// remembers nothing and adds no name.
		// A note memory found stays put too when the path it would move to is a note it
		// left as it is, which a rename onto would collide with on every run.
		const staysPut = found.keepsItsPath === true || leftNotes.includes(path);
		const result =
			found.path === path
				? updateInPlace(identity, date, path, found, title, wanted, template, layout)
				: staysPut && existing.exists(path)
					? updateInPlace(identity, date, found.path, found, title, wanted, template, layout)
					: renamed(identity, date, path, found, title, wanted, template, existing, layout, forget);
		// A note passed over for this one is said by the run, whatever became of this one,
		// and remembered, so the next run says it again while the note is there.
		const remember =
			result.remember !== null && leftNotes.length > 0 ? { ...result.remember, leftNotes } : result.remember;
		return stranded.length === 0 ? result : { ...result, remember, refused: [...result.refused, ...stranded] };
	}

	if (existing.exists(path)) {
		// Adopted. Its content is never read, compared or corrected — carried
		// unchanged from calendar-scaffold/src/meeting-note.ts:310-313. The
		// meeting's current participants are recorded as already accounted for
		// regardless of what the note actually holds, so this feature never
		// later writes into a note the person made themselves — decision 10's
		// own reason for adopting at all.
		return {
			outcome: "adopted",
			path,
			applied: [],
			refused: stranded,
			remember: { identity, date, path, accounted: wanted },
			forget,
		};
	}

	// A note an older build wrote under the placeholder title, that memory
	// holds no entry for, is this meeting's note once the calendar gives the
	// meeting a title. Only after the real path is ruled out above —
	// a note already there is adopted, never renamed over — and before a new
	// note is made beside the old one. It sits here, after `locateExisting`
	// and the adopted branch, so a change to how `ensureNote` picks a note's
	// date composes with it rather than around it.
	// A meeting that is over is history, its note included: nothing is
	// renamed once it has ended.
	const placeholder = hasEnded(meeting, now)
		? ({ kind: "none" } as const)
		: placeholderNoteFor(title, date, existing, memory, placeholderRivals);
	if (placeholder.kind === "one") {
		return {
			outcome: "renamed",
			path,
			previousPath: placeholder.path,
			// The note keeps its text as it is: nothing in it is read or corrected.
			applied: [],
			refused: stranded,
			remember: { identity, date, path, accounted: wanted },
			forget,
		};
	}
	if (placeholder.kind === "ambiguous") stranded.push(placeholder.notice);

	// The day link is only resolved here, on write, not any earlier — created
	// is the only outcome above that needs it. A blank daily-log
	// layout is refused with dailyLogPath's own sentence, which already names
	// the Effortless setting to fill, rather than left to throw.
	const day = dayLinkOrRefusal(date, layout);
	if ("refused" in day) {
		return {
			outcome: "collided",
			path,
			applied: [],
			refused: [...stranded, `"${title}" could not be created: ${day.refused}`],
			remember: null,
			forget,
		};
	}

	return {
		outcome: "created",
		path,
		text: withWrittenLine(noteText(meeting, day.target, template, wanted, layout, identity), identity),
		applied: [],
		refused: stranded,
		remember: { identity, date, path, accounted: wanted },
		forget,
	};
}

/**
 * The note is already at today's computed path: add whoever the calendar has
 * newly invited, and — when an earlier rename moved it here without its
 * heading and day-link correction landing — carry that correction out in
 * the same plan. The correction's targets are computed fresh from
 * today's title and today's day link, exactly as {@link renamed} computes
 * them; only what the note still reads comes from the memory.
 */
function updateInPlace(
	identity: string,
	date: string,
	path: string,
	found: FoundNote,
	title: string,
	wanted: readonly string[],
	template: MeetingNoteTemplate,
	layout: VaultLayout,
): EnsureNoteResult {
	const addNames = namesToAdd(found.content, template.participantsField, wanted, found.accounted);
	if (addNames.length === 0 && found.pending === null) {
		return {
			outcome: "nothing-to-do",
			path,
			applied: [],
			refused: [],
			remember: { identity, date, path, accounted: found.accounted },
			// updateInPlace is called only with found.path === path: by
			// locateExisting, which then read today's own record straight off
			// and so has no stale record, or by locateIdentified, which
			// runs after a locateExisting that found nothing and so may have
			// named today's gone record as stale. That record is under this same
			// identity and date, which this result's `remember` replaces, so nothing
			// is left to forget.
			forget: [],
		};
	}

	const plan: NoteEditPlan = { addNames };
	if (found.pending !== null) {
		// The day link is resolved only when a correction is owed, so a note
		// owing none still never needs it. Under a blank daily-log
		// layout the correction cannot be computed at all: nothing is written
		// and the memory is left as it was, so it is still owed next run.
		const day = dayLinkOrRefusal(date, layout);
		if ("refused" in day) {
			return {
				outcome: "collided",
				path,
				applied: [],
				refused: [`"${title}"'s note could not be corrected: ${day.refused}`],
				owed: found.pending,
				remember: null,
				forget: [],
			};
		}
		plan.heading = { from: found.pending.heading, to: title };
		plan.dayLink = { from: found.pending.dayLink, to: day.target };
	}

	const edited = editRecordingOffered(found.content, plan, template, layout);
	return {
		outcome: edited.applied.length > 0 ? "updated" : "nothing-to-do",
		path,
		...(edited.applied.length > 0 ? { text: withWrittenLineRefreshed(found.content, edited.text) } : {}),
		applied: edited.applied,
		refused: edited.refused,
		...(found.pending !== null ? { owed: found.pending } : {}),
		// Only a name editNote actually wrote counts as accounted for — one it
		// refused (no participants list to add it to) must stay unaccounted, or
		// it is never tried again even after the note grows a list by hand.
		// No pendingCorrection: once this plan is written the correction has
		// been carried out, and a line editNote refused is the person's own
		// edit, reported rather than retried — the same as a rename's own.
		remember: { identity, date, path, accounted: union(found.accounted, edited.addedNames) },
		forget: [],
	};
}

function renamed(
	identity: string,
	date: string,
	path: string,
	found: FoundNote,
	newTitle: string,
	wanted: readonly string[],
	template: MeetingNoteTemplate,
	existing: NoteLookup,
	layout: VaultLayout,
	forgetSoFar: readonly string[],
): EnsureNoteResult {
	if (existing.exists(path)) {
		// Two notes for one meeting: the one this feature has been keeping,
		// and one already sitting at the new name. Neither is safe to
		// overwrite and neither is safe to delete, so nothing is written and
		// the memory keeps pointing at the feature's own note (`remember:
		// null`), the same guard the old plugin's own comment explains. The
		// day this meeting moved away from is not forgotten either — the move
		// never happened — but a today entry already known stale (staleOwn,
		// carried in forgetSoFar) still is; that entry was dead before this
		// call ever started.
		return {
			outcome: "collided",
			path,
			applied: [],
			refused: [
				`the calendar renamed or rescheduled this meeting, but ${path} already exists. ` +
					`Its earlier note is still at ${found.path} and neither was changed — ` +
					`move anything you need across by hand, and this message will stop.`,
			],
			remember: null,
			forget: forgetSoFar,
		};
	}

	// The day link is resolved only once the path collision above is ruled
	// out, and a blank daily-log layout is refused the same way created's is — the file this meeting has been keeping is left exactly as it
	// was, same as any other refused rename.
	const day = dayLinkOrRefusal(date, layout);
	if ("refused" in day) {
		return {
			outcome: "collided",
			path,
			applied: [],
			refused: [`"${newTitle}" could not be renamed: ${day.refused}`],
			remember: null,
			forget: forgetSoFar,
		};
	}

	const oldName = readMeetingNotePath(found.path);
	const addNames = namesToAdd(found.content, template.participantsField, wanted, found.accounted);

	const plan: NoteEditPlan = { addNames };
	const refused: string[] = [];
	let owed: PendingCorrection | undefined;
	if (found.pending !== null) {
		// An earlier rename moved this note without its correction landing, so
		// the note still reads what it did before that rename — not what its
		// current name says.
		owed = found.pending;
		plan.heading = { from: owed.heading, to: newTitle };
		plan.dayLink = { from: owed.dayLink, to: day.target };
	} else if (oldName === null) {
		refused.push(
			`${found.path} is not in this feature's own \`YYYY-MM-DD Title\` shape, so ` +
				`its heading and day link were left as they are`,
		);
	} else {
		plan.heading = { from: oldName.title, to: newTitle };
		// The field holds the day's own resolved wikilink target, not the raw
		// `YYYY-MM-DD` key the filename carries — the two differ under any
		// daily-log pattern but the default, so the old date has to be resolved
		// the same way `day.target` (today's) already was. Never throws here:
		// `day` above already succeeded under this same layout, and only the
		// layout — never which date is asked about — decides whether
		// dailyLogPath throws.
		plan.dayLink = { from: dayLinkTarget(oldName.date, layout), to: day.target };
		owed = { heading: oldName.title, dayLink: plan.dayLink.from };
	}

	const edited = editRecordingOffered(found.content, plan, template, layout);
	return {
		outcome: "renamed",
		path,
		previousPath: found.path,
		// text's own contract: present once an edit was applied, absent when
		// there is nothing to write — the same rule updateInPlace's own
		// "updated" case already follows.
		...(edited.applied.length > 0 ? { text: withWrittenLineRefreshed(found.content, edited.text) } : {}),
		applied: edited.applied,
		refused: [...refused, ...edited.refused],
		...(owed !== undefined ? { owed } : {}),
		remember: { identity, date, path, accounted: union(found.accounted, edited.addedNames) },
		// The move actually goes through here, so the day it moved away from
		// (found.movedFrom) joins whatever was already known stale — null when
		// this rename is really a same-day title change, where there is
		// no other day to forget.
		forget: found.movedFrom !== null ? [...forgetSoFar, found.movedFrom] : forgetSoFar,
	};
}

/**
 * One meeting note per meeting in `meetings`, refusing the second of two
 * that would resolve to the same path within this one run.
 *
 * Carried from `~/Devbox/calendar-scaffold/src/meeting-note.ts`'s
 * `ensureNotes`: two meetings sharing a computed path is never a silent
 * adoption of the first one's note — its agenda and its participants would
 * never be written, and nothing would say so. Refused for the second one
 * instead, by name, before {@link ensureNote} is even asked.
 */
export function ensureNotes(
	meetings: readonly Meeting[],
	runDay: string,
	layout: VaultLayout,
	folder: string,
	existing: NoteLookup,
	memory: NotesMemory,
	template: MeetingNoteTemplate,
	selfEmail: string,
	now: Date | null = null,
): EnsureNoteResult[] {
	const results: EnsureNoteResult[] = [];
	const claimed = new Map<string, string>();

	// Meetings that could each take over the one placeholder note: the ones
	// that reach the placeholder step at all. Two of them cannot both have
	// it, and nothing here says which — so each is told it has a rival and
	// renames nothing. A meeting looks only under its own note date, so only meetings sharing that date are rivals.
	const wantsPlaceholder = meetings.filter((meeting) =>
		reachesPlaceholderStep(meeting, runDay, folder, existing, memory, now),
	);

	for (const meeting of meetings) {
		const path = meetingNotePath(folder, meetingNoteDate(meeting, runDay), meeting.summary);
		const owner = claimed.get(path);
		if (owner !== undefined) {
			results.push({
				outcome: "collided",
				path,
				applied: [],
				refused: [
					`no note for one of today's meetings: another meeting this day is ` +
						`also called "${owner}", so they want the same note. Only the ` +
						`first one has it; rename one of them in the calendar to give this ` +
						`meeting its own.`,
				],
				remember: null,
				forget: [],
			});
			continue;
		}

		const noteDate = meetingNoteDate(meeting, runDay);
		const rivals = wantsPlaceholder.includes(meeting)
			? wantsPlaceholder.filter((other) => meetingNoteDate(other, runDay) === noteDate).length - 1
			: 0;
		const result = ensureNote(meeting, runDay, layout, folder, existing, memory, template, selfEmail, rivals, now);
		claimed.set(path, meetingNoteTitle(meeting.summary));
		results.push(result);
	}
	return results;
}
