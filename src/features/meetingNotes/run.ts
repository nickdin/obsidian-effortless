/**
 * One run over today: meeting notes' whole job, joined up from the pieces
 * the earlier tickets built (spec
 * #701 decisions 4, 5
 * and 7, ticket #762).
 *
 * **This module decides nothing about what one meeting needs.** That is
 * {@link ensureNote}'s job, one layer down; this module only orders the
 * calls: refresh the calendar once, read what {@link ensureNote} asks about,
 * ask it for every meeting today, then carry out its plan — a create through
 * the core's `create`, a rename through the core's `rename`, a correction
 * through the core's `edit`, never `vault.create`, `fileManager` or
 * `vault.process` directly (decision 4).
 *
 * **The shape is building the days ahead's own run** (`daysAhead/run.ts`):
 * the Obsidian half arrives as narrow ports rather than the real `Calendar`,
 * `NoteWriter` and `FeatureProblems` themselves, so every test here exercises
 * this module against fakes of the three; `meetingNotes.ts` is the only file
 * that wires the real ones in.
 *
 * **`RunVault.read` is asked only for a path this feature's own memory
 * already names** — today's own record, or a day this identity has moved
 * away from (`ensureNote.ts`'s `locateExisting`) — or one a clicked note
 * sits at. The freshly computed path for a meeting is asked whether
 * something exists there, through `RunVault.exists`, which never reads; it is
 * read only where the frontmatter index names nothing for the meeting and a
 * file is there, to see whether a clicked note Obsidian has not indexed yet names the meeting. Whatever it holds, an adopted note's contents
 * are never compared or corrected (decision 10's own Adopt sentence, and
 * `ensureNote.ts`'s `NoteLookup` doc comment). So every path this run might
 * ask {@link ensureNote} to read is awaited once, up front, before
 * {@link ensureNotes} is called at all — `ensureNote` is pure and answers
 * synchronously, and `Vault.cachedRead` does not.
 */

import type { TFile } from "obsidian";
import type { CalendarPresence, CalendarUse } from "../../core/calendarSources";
import { endsAtOf } from "../../core/icsReader";
import type { Meeting } from "../../core/icsReader";
import { localDateKey, meetingNoteDate, meetingNoteTitle } from "../../core/meetingName";
import { fingerprintOf } from "../../core/fingerprint";
import { reasonOf } from "../../core/reason";
import type { VaultLayout } from "../../core/settings";
import { ensureNotes } from "./ensureNote";
import type { EnsureNoteResult, NoteLookup, RememberedNote } from "./ensureNote";
import { nextWritten } from "./noteRecord";
import type { LandedWrite, WrittenRecord } from "./noteRecord";
import { identityInText } from "./noteIdentity";
import { meetingIdentity } from "./notesMemory";
import type { NoteMemoryEntry, NotesMemory, PendingCorrection } from "./notesMemory";
import { meetingNotePath } from "./notePath";
import type { MeetingNoteTemplate } from "./types";

/** The calendar, narrowed to what one run needs. */
export interface RunCalendar {
	/**
	 * Reads every source again, resolving once the sources as they stood when
	 * this was called have been read (`src/core/calendarSources.ts:80-89`).
	 * Awaited exactly once per run, before a single meeting is looked at —
	 * independently of building the days ahead's own call to it, since two
	 * features may never coordinate directly.
	 */
	refresh(): Promise<void>;
	/** Every meeting on `day` whose source is switched to make notes, in start order (`src/core/icsReader.ts`'s `byWhenTheyStart`). */
	meetingsOn(day: Date, use: "notes"): readonly Meeting[];
	/**
	 * Whether the calendar can say a meeting is gone, and what is on it from
	 * today through {@link PRESENCE_REACH_DAYS} — the core's answer, asked only
	 * when a remembered note could go.
	 */
	presenceBetween(from: Date, days: number, use: CalendarUse): CalendarPresence;
}

/**
 * The vault, narrowed to what one run needs to answer {@link NoteLookup} —
 * see the module comment for which of the two this run may call for which
 * path.
 */
export interface RunVault {
	/** Whether something is at `path` right now, without reading it. */
	exists(path: string): boolean;
	/** `path`'s whole text right now, or `null` when nothing is there. */
	read(path: string): Promise<string | null>;
	/** The `TFile` already on disk at `path`, for a rename or a correction to be queued against — `null` when this run's own snapshot found nothing there. */
	fileAt(path: string): TFile | null;
	/**
	 * The paths in `folder` named for the placeholder title on `date`, read
	 * from the vault's own file list — how a note memory never held is found. Absent reads as none.
	 */
	placeholderNotes?(folder: string, date: string): readonly string[];
	/**
	 * The paths of the notes anywhere in the vault whose frontmatter names
	 * `identity` — a note a click created, which this run's memory may never
	 * have held. Absent reads as none.
	 */
	notesNamingIdentity?(identity: string): readonly string[];
}

/** The core's queued writer, narrowed to the calls this run ever reaches for. */
export interface RunNotes {
	create(path: string, text: string): Promise<TFile>;
	rename(file: TFile, newPath: string): Promise<void>;
	edit(file: TFile, edit: (content: string) => string): Promise<string>;
	/** Moves `file` to the trash when `shouldTrash` says so of its text at the front of the writer's queue; resolves whether it did. */
	trashIf(file: TFile, shouldTrash: (content: string) => boolean): Promise<boolean>;
}

/** How one run says a note is broken, and has it stop being said. */
export interface RunProblems {
	report(key: string, message: string): void;
	clear(key: string): void;
	/**
	 * Every key this feature currently has standing, so a run can tell a path
	 * it no longer visits apart from one still in front of it.
	 * `FeatureProblems` itself has no route back to what is standing — a
	 * feature may report and clear, never enumerate another feature's keys or
	 * even its own — so the real implementation keeps this list itself,
	 * beside the two calls that change it, the way building the days ahead's
	 * own `RunProblems.list` does (`daysAhead/run.ts`, issue #719/#788).
	 */
	list(): readonly string[];
}

export interface RunDeps {
	readonly calendar: RunCalendar;
	readonly vault: RunVault;
	readonly notes: RunNotes;
	readonly problems: RunProblems;
	readonly layout: VaultLayout;
	/** Meeting notes' own folder setting. Readiness already guarantees this is answered before a run starts. */
	readonly folder: string;
	readonly template: MeetingNoteTemplate;
	readonly selfEmail: string;
	/** Now, read once by the caller — never the clock inside. */
	readonly today: Date;
	/** This feature's memory of the notes it has written, before this run changes it. */
	readonly memory: NotesMemory;
	/**
	 * Persists the memory once it actually changed, awaited once at the end
	 * of the run. Never called when nothing this run decided changed what was
	 * already stored.
	 */
	commitMemory(memory: NotesMemory): Promise<void>;
}

/** The fixed key `selfEmail` blank raises a standing problem under. */
const SELF_EMAIL_PROBLEM_KEY = "self-email-unset";

/**
 * The fixed key a run's own failure is reported under — a rejection from
 * `calendar.refresh`, a vault read in {@link readExisting} or `commitMemory`,
 * none of which is any one meeting's own fault. The registry has
 * no route from a feature's timer to the core's own `failed` state today —
 * only `onload`/`readiness` throwing reaches that (`src/core/registry.ts:495-503`)
 * — and building one is core work outside this fix, so a run's own failure is
 * a standing problem instead, the way building the days ahead reports a
 * failed memory commit under its own date key
 * (`daysAhead/run.ts:166-170`). Cleared the moment a later run completes.
 */
const RUN_FAILURE_PROBLEM_KEY = "run-failed";

/**
 * How far ahead a meeting missing from today is looked for before its note
 * is taken for a cancelled meeting's: today and the 365 days after.
 * A meeting moved to another day keeps its note, which this feature then
 * renames on the day it reaches. The reach is this feature's own: building
 * the days ahead's window is that feature's setting, and #14 keeps either
 * from reading the other's. Only a meeting moved more than a year out loses
 * its untouched note, made again when its day comes. Exported so a test
 * holds a calendar account's fixed span to reach past it.
 */
export const PRESENCE_REACH_DAYS = 366;

/** Worded as the old plugin's own Notice for the same setting (`calendar-scaffold/src/main.ts:558-565`), carried rather than reinvented. */
const SELF_EMAIL_MESSAGE =
	"Your email address is not set, so you are listed as a participant in your own " +
	"meeting notes. Enter it under Your email address on the Meeting notes card; " +
	"notes already written keep the entry until you remove it.";

/**
 * Refreshes the calendar once, ensures every meeting today that wants a note,
 * carries out what each one decided, and persists the memory once at the end
 * if anything changed.
 *
 * A meeting whose write throws is reported through `problems`, keyed by its
 * computed path, and costs the other meetings nothing — the loop below moves
 * on to the next one regardless.
 *
 * **Never rejects.** A failure that is not any one meeting's own — the
 * calendar refusing to refresh, a vault read in {@link readExisting}, or
 * `commitMemory` refusing the write — is reported under
 * {@link RUN_FAILURE_PROBLEM_KEY} instead, so the feature's own
 * `void this.runOnce().finally(...)` (`meetingNotes.ts`) never drops it as an
 * unhandled rejection.
 */
export async function runMeetingNotes(deps: RunDeps): Promise<void> {
	try {
		await runOverToday(deps);
	} catch (error) {
		// Never a per-meeting write — carryOut already catches and reports
		// those under the meeting's own path, and this catch never sees them.
		// This is calendar.refresh, a vault read in readExisting or
		// commitMemory: nothing about it is any one meeting's own fault, so it
		// is reported under the run's own fixed key rather than lost as an
		// unhandled rejection.
		deps.problems.report(
			RUN_FAILURE_PROBLEM_KEY,
			`Effortless could not finish this run over today's meetings: ${reasonOf(error)}.`,
		);
		return;
	}
	deps.problems.clear(RUN_FAILURE_PROBLEM_KEY);
}

async function runOverToday(deps: RunDeps): Promise<void> {
	await deps.calendar.refresh();

	const date = localDateKey(deps.today);
	const meetings = deps.calendar.meetingsOn(deps.today, "notes");

	// A path-keyed problem is cleared, ordinarily, only when this run visits
	// the same path again and finds it in order (below). Nothing else ever
	// clears one a later run stops visiting — the day ends, the meeting
	// leaves the calendar, moves day, or changes title — so it would stand
	// until the feature unloads. Cleared here, before a single meeting is
	// touched, the way building the days ahead clears a date outside its own
	// window (`daysAhead/run.ts:145-146`, `daysAhead.ts:154-166`) — leaving
	// the fixed self-email and run-failure keys alone, since neither is a
	// path this run computes.
	const currentPaths = new Set(meetings.map((meeting) => meetingNotePath(deps.folder, meetingNoteDate(meeting, date), meeting.summary)));
	// A note kept up to date where it is, beside one a run left as it is, is reported
	// under its own path, which is not a computed one. It stays standing while the
	// left note is there, so the notice speaks once rather than once per run;
	// the sweep after the meetings are visited clears it if no meeting reports it.
	const keptBesideLeft = pathsKeptBesideLeftNotes(deps, meetings);
	for (const key of deps.problems.list()) {
		if (key === SELF_EMAIL_PROBLEM_KEY || key === RUN_FAILURE_PROBLEM_KEY) continue;
		if (!currentPaths.has(key) && !keptBesideLeft.has(key)) deps.problems.clear(key);
	}

	const existing = await readExisting(deps.vault, deps.memory, meetings, deps.folder, date);
	const results = ensureNotes(
		meetings,
		date,
		deps.layout,
		deps.folder,
		existing,
		deps.memory,
		deps.template,
		deps.selfEmail,
		deps.today,
	);

	let memory = deps.memory;
	let memoryChanged = false;
	let createdAny = false;

	// Paths more than one meeting shares in this run — a collision — always
	// carry a refusal for every meeting but the one that won it (`ensureNotes`'
	// own dedup). A key one meeting in this run reports is not cleared by
	// another later in the same run: clearing it first and reporting it again
	// right after is what raised a fresh Notice every run for as long as the
	// collision stood, since `Problems.report` only stays quiet when the key
	// is already standing at the moment it is asked.
	const reportedThisRun = new Set(results.filter((result) => result.refused.length > 0).map((result) => result.path));
	const visitedPaths = new Set(results.map((result) => result.path));
	for (const key of keptBesideLeft) if (!visitedPaths.has(key)) deps.problems.clear(key);

	for (let index = 0; index < meetings.length; index++) {
		const meeting = meetings[index];
		const result = results[index];
		const title = meetingNoteTitle(meeting.summary);
		const identity = meetingIdentity(meeting.uid, meeting.occurrenceKey);

		const outcome = await carryOut(deps, result, title, existing);
		if (!outcome.committable) continue;

		if (result.outcome === "created") createdAny = true;

		// A landed rename is remembered under the new path even when its
		// bundled correction did not apply: `result.remember`'s own accounted
		// list assumed the correction's added names would actually land, which
		// they did not, so the caller falls back to whatever this identity's
		// memory already held for the path it moved from, and
		// records the correction as still owed so a later run carries it out.
		const remembered =
			outcome.correctionPending !== undefined ? fallbackRemember(deps.memory, identity, result) : result.remember;
		const remember = remembered === null ? null : withWritten(remembered, deps.memory, identity, meeting, result, outcome, existing);

		if (remember !== null || result.forget.length > 0) {
			const next = withRemembered(memory, identity, remember, result.forget);
			if (next !== memory) {
				memory = next;
				memoryChanged = true;
			}
		}

		if (outcome.correctionPending !== undefined) {
			// The rename landed but its correction did not: the problem stands
			// until a run actually applies the correction, never the ordinary
			// clear a fully-landed plan gets. A later run that retries it and
			// fails again reports from carryOut itself, in these same words,
			// and never reaches here.
			deps.problems.report(result.path, withRefusals(outcome.correctionPending, result));
		} else if (result.refused.length > 0) {
			deps.problems.report(result.path, result.refused.join(" "));
		} else if (!reportedThisRun.has(result.path)) {
			deps.problems.clear(result.path);
		}
	}

	// Never on a run that creates nothing (decision 7); cleared once the
	// person answers it, so the line does not outlive the reason it was
	// raised — the same rule every other standing problem here keeps.
	if (deps.selfEmail.trim() === "") {
		if (createdAny) deps.problems.report(SELF_EMAIL_PROBLEM_KEY, SELF_EMAIL_MESSAGE);
	} else {
		deps.problems.clear(SELF_EMAIL_PROBLEM_KEY);
	}

	const afterRemoval = await removeGoneNotes(deps, memory, meetings, date);
	if (afterRemoval !== memory) {
		memory = afterRemoval;
		memoryChanged = true;
	}

	if (memoryChanged) await deps.commitMemory(memory);
}

/**
 * `remember` with the record of what this run leaves written in the note
 * (`noteRecord.ts`, #1036): the record the note was remembered with before —
 * under the path this run moved it from, for a rename — carried forward
 * through the write this run landed, if any.
 */
function withWritten(
	remember: RememberedNote,
	memory: NotesMemory,
	identity: string,
	meeting: Meeting,
	result: EnsureNoteResult,
	outcome: CarryOutOutcome,
	existing: NoteLookup,
): RememberedNote {
	const fromPath = result.previousPath ?? result.path;
	const previous = Object.values(memory[identity] ?? {}).find((entry) => entry.path === fromPath)?.written;
	const written = nextWritten(previous, landedWrite(result, outcome, existing), endsAtOf(meeting), result.outcome === "adopted");
	return written === undefined ? remember : { ...remember, written };
}

/** The write this run landed on the note, or `null` when it landed none — see {@link CarryOutOutcome}. */
function landedWrite(result: EnsureNoteResult, outcome: CarryOutOutcome, existing: NoteLookup): LandedWrite | null {
	if (result.text === undefined) return null;
	if (result.outcome === "created") return { before: null, after: result.text };
	if (result.outcome === "updated") return { before: existing.read(result.path), after: result.text };
	if (result.outcome === "renamed" && outcome.correctionPending === undefined) {
		return { before: existing.read(result.previousPath!), after: result.text };
	}
	return null;
}

/**
 * Deletes the note of every meeting gone from the calendar while the note is
 * still only what this feature wrote, and returns the memory without
 * the notes it deleted — `memory` itself when nothing changed.
 *
 * A note is a candidate when its entry is dated today or later, carries a
 * {@link WrittenRecord} whose meeting has not ended, and its meeting is not
 * among today's. Only then is the calendar asked, once, whether its reading
 * from today through {@link PRESENCE_REACH_DAYS} is whole; a reading that is not
 * deletes nothing. A candidate whose meeting is anywhere in that reading has
 * moved, and keeps its note. Every other one is trashed through the core's
 * writer when its text, read at the front of the writer's queue, still has
 * the recorded fingerprint, and its entry is forgotten. One whose text
 * differs, or that the vault refuses to trash, is kept and reported once,
 * naming it, and its record is dropped so no later run asks about it again. A note already gone from the vault is
 * only forgotten.
 */
async function removeGoneNotes(deps: RunDeps, memory: NotesMemory, today: readonly Meeting[], date: string): Promise<NotesMemory> {
	const todays = new Set(today.map((meeting) => meetingIdentity(meeting.uid, meeting.occurrenceKey)));
	const now = deps.today.getTime();
	const candidates: Array<{ identity: string; date: string; entry: NoteMemoryEntry; written: WrittenRecord }> = [];
	for (const [identity, byDate] of Object.entries(memory)) {
		if (todays.has(identity)) continue;
		for (const [entryDate, entry] of Object.entries(byDate)) {
			if (entryDate < date || entry.written === undefined || entry.written.endsAt <= now) continue;
			candidates.push({ identity, date: entryDate, entry, written: entry.written });
		}
	}
	if (candidates.length === 0) return memory;

	const presence = deps.calendar.presenceBetween(deps.today, PRESENCE_REACH_DAYS, "notes");
	if (!presence.whole) return memory;
	const present = new Set(presence.meetings.map((meeting) => meetingIdentity(meeting.uid, meeting.occurrenceKey)));

	let next = memory;
	for (const candidate of candidates) {
		if (present.has(candidate.identity)) continue;
		const file = deps.vault.fileAt(candidate.entry.path);
		if (file === null) {
			next = withRemembered(next, candidate.identity, null, [candidate.date]);
			continue;
		}
		let trashed: boolean;
		try {
			trashed = await deps.notes.trashIf(file, (content) => fingerprintOf(content) === candidate.written.fingerprint);
		} catch (error) {
			// Said once and given up on, like a changed note: the run clears
			// this path's problem before every run, so trying again each run
			// would raise a fresh Notice every time (#786's shape).
			deps.problems.report(
				candidate.entry.path,
				`Effortless could not remove ${candidate.entry.path}, whose meeting is no longer on the calendar: ${reasonOf(error)}. It is kept, and Effortless will not try again.`,
			);
			next = withoutRecord(next, candidate.identity, candidate.date, candidate.entry);
			continue;
		}
		if (trashed) {
			next = withRemembered(next, candidate.identity, null, [candidate.date]);
			continue;
		}
		deps.problems.report(
			candidate.entry.path,
			`The meeting behind ${candidate.entry.path} is no longer on the calendar, but the note has been changed since Effortless wrote it, so it is kept.`,
		);
		next = withoutRecord(next, candidate.identity, candidate.date, candidate.entry);
	}
	return next;
}

/** `memory` with `entry`, under `identity` and `date`, no longer carrying a {@link WrittenRecord}: a note no run will try to delete again. */
function withoutRecord(memory: NotesMemory, identity: string, date: string, entry: NoteMemoryEntry): NotesMemory {
	const { written: _dropped, ...kept } = entry;
	return { ...memory, [identity]: { ...memory[identity], [date]: kept } };
}

/**
 * Every path this run's own memory names for a meeting today, read once and
 * handed back as the synchronous {@link NoteLookup} `ensureNote` needs —
 * and the freshly computed path of a meeting only where a file is there that
 * the frontmatter index does not name, read to see whether its text names the
 * meeting; any other file at a computed path `ensureNote` only ever
 * asks {@link NoteLookup.exists} about (see the module comment).
 */
async function readExisting(
	vault: RunVault,
	memory: NotesMemory,
	meetings: readonly Meeting[],
	folder: string,
	runDay: string,
): Promise<NoteLookup> {
	const candidates = new Set<string>();
	for (const meeting of meetings) {
		const identity = meetingIdentity(meeting.uid, meeting.occurrenceKey);
		for (const entry of Object.values(memory[identity] ?? {})) candidates.add(entry.path);
		// A note a click created is read too, so `ensureNote` can see which
		// names it already holds.
		for (const path of vault.notesNamingIdentity?.(identity) ?? []) candidates.add(path);
	}

	const contents = new Map<string, string>();
	for (const path of candidates) {
		const content = await vault.read(path);
		if (content !== null) contents.set(path, content);
	}

	// A clicked note Obsidian's index has not reached yet — one that has just
	// synced in — names its meeting in its text but not yet in the index. So where the index names nothing for a meeting at the meeting's
	// own path and a file is there, its text is read, to see whether it names
	// the meeting. Only read: a note that does not is left as it is, and
	// adopted as before.
	const unindexed = new Map<string, string[]>();
	for (const meeting of meetings) {
		const identity = meetingIdentity(meeting.uid, meeting.occurrenceKey);
		const path = meetingNotePath(folder, meetingNoteDate(meeting, runDay), meeting.summary);
		if (candidates.has(path) || !vault.exists(path)) continue;
		const content = await vault.read(path);
		if (content === null || identityInText(content) !== identity) continue;
		contents.set(path, content);
		unindexed.set(identity, [...(unindexed.get(identity) ?? []), path]);
	}

	// A note's date is not always the run's day — a several-day meeting's note
	// carries its first day — so the folder is listed for whichever
	// date is asked, once per date.
	const placeholdersByDate = new Map<string, readonly string[]>();

	return {
		exists: (path) => vault.exists(path),
		read: (path) => contents.get(path) ?? null,
		notesNamingIdentity: (identity) => [...(vault.notesNamingIdentity?.(identity) ?? []), ...(unindexed.get(identity) ?? [])],
		placeholderNotesOn: (noteDate) => {
			let found = placeholdersByDate.get(noteDate);
			if (found === undefined) {
				found = vault.placeholderNotes?.(folder, noteDate) ?? [];
				placeholdersByDate.set(noteDate, found);
			}
			return found;
		},
	};
}

/**
 * What carrying out one meeting's plan decided.
 */
interface CarryOutOutcome {
	/**
	 * Whether the memory may now be updated for this meeting: `adopted`,
	 * `nothing-to-do` and `collided` need no write and always may; `created`
	 * and `updated` only once their own write actually lands; `renamed` once
	 * the rename itself lands, regardless of its bundled correction (#783,
	 * #789 — the rename is a fact about the vault the memory must not
	 * misreport, whatever happens to the correction riding along with it).
	 */
	readonly committable: boolean;
	/**
	 * Set only when a rename's own write landed but its bundled correction did
	 * not — thrown, or found stale against a note that moved again since this
	 * run's snapshot. The caller reports this instead of its ordinary
	 * refused/clear choice, so the problem stays standing until a later run
	 * actually applies the correction, rather than being cleared by a run that
	 * only moved the file.
	 */
	readonly correctionPending?: string;
}

/**
 * Carries out one meeting's plan against the core's writer — a create, a
 * rename with its correction in the same plan, or a correction in place —
 * and reports a thrown error as a standing problem rather than letting it
 * stop the meetings after it.
 */
async function carryOut(deps: RunDeps, result: EnsureNoteResult, title: string, existing: NoteLookup): Promise<CarryOutOutcome> {
	if (result.outcome === "adopted" || result.outcome === "nothing-to-do" || result.outcome === "collided") {
		return { committable: true };
	}

	if (result.outcome === "created") {
		try {
			// Present on every `created` result — `ensureNote`'s own contract.
			await deps.notes.create(result.path, result.text!);
			return { committable: true };
		} catch (error) {
			deps.problems.report(result.path, `Effortless could not write "${title}"'s note: ${reasonOf(error)}.`);
			return { committable: false };
		}
	}

	if (result.outcome === "updated") {
		// An update that carries a correction an earlier rename still owes
		// (`result.owed`, #793) fails in the rename's own words, so the line
		// the person has been reading since the rename stays the same line. The
		// memory is left as it was either way — `committable: false` — so the
		// correction is still owed on the next run.
		try {
			const file = mustFind(deps.vault, result.path);
			// Present on every `updated` result — `updateInPlace` only returns
			// `updated` once an edit actually applied.
			const stale = await editIfFresh(deps.notes, file, result.text!, existing.read(result.path));
			if (stale) {
				if (result.owed !== undefined) deps.problems.report(result.path, withRefusals(correctionStaleMessage(title), result));
				else reportStale(deps, result.path, title);
				return { committable: false };
			}
			return { committable: true };
		} catch (error) {
			deps.problems.report(
				result.path,
				result.owed !== undefined
					? withRefusals(correctionFailedMessage(title, error), result)
					: `Effortless could not write "${title}"'s note: ${reasonOf(error)}.`,
			);
			return { committable: false };
		}
	}

	// `renamed`. The rename and its bundled correction (present only when
	// `ensureNote` decided one applies, #781) are no longer one failure: once
	// the rename itself lands, the note has genuinely moved, and the memory
	// must say so whatever happens next.
	let file: TFile;
	try {
		// Present on every `renamed` result — `ensureNote`'s own contract.
		file = mustFind(deps.vault, result.previousPath!);
		await deps.notes.rename(file, result.path);
	} catch (error) {
		deps.problems.report(result.path, `Effortless could not write "${title}"'s note: ${reasonOf(error)}.`);
		return { committable: false };
	}

	if (result.text === undefined) return { committable: true };

	try {
		const stale = await editIfFresh(deps.notes, file, result.text, existing.read(result.previousPath!));
		if (stale) return { committable: true, correctionPending: correctionStaleMessage(title) };
		return { committable: true };
	} catch (error) {
		return { committable: true, correctionPending: correctionFailedMessage(title, error) };
	}
}

/**
 * `message` followed by what the plan also refused, so a correction that did
 * not land never replaces the notice naming the note a run left as it is: both stand under the one key, until the correction lands.
 */
function withRefusals(message: string, result: EnsureNoteResult): string {
	return [message, ...result.refused].join(" ");
}

/**
 * The paths a note is kept at beside a note a run left as it is, among today's
 * meetings: an entry of the memory whose note and at least one of its left notes
 * are both still in the vault.
 */
function pathsKeptBesideLeftNotes(deps: RunDeps, meetings: readonly Meeting[]): Set<string> {
	const kept = new Set<string>();
	for (const meeting of meetings) {
		for (const entry of Object.values(deps.memory[meetingIdentity(meeting.uid, meeting.occurrenceKey)] ?? {})) {
			if (entry.leftNotes?.some((path) => deps.vault.exists(path)) === true && deps.vault.exists(entry.path)) kept.add(entry.path);
		}
	}
	return kept;
}

/** A renamed note's correction skipped because the note changed after this run read it — first time or on a retry. */
function correctionStaleMessage(title: string): string {
	return `Effortless renamed "${title}"'s note, but it changed after this run read it, so its correction was not applied. It will try again on a later run.`;
}

/** A renamed note's correction that threw — first time or on a retry. */
function correctionFailedMessage(title: string, error: unknown): string {
	return `Effortless renamed "${title}"'s note but could not apply its correction: ${reasonOf(error)}. It will try again on a later run.`;
}

/**
 * Writes `text` through `notes.edit`, but only once the content the callback
 * actually receives still matches `snapshot` — the note as this run read it
 * before its loop began.
 *
 * `NoteWriter.edit` hands the callback the note as it is *now*, once a write
 * parked on the person's open note is released (`noteWriter.ts:139-144`,
 * `:322-344`); `text` was computed against `snapshot`, not against that fresh
 * content. Building the days ahead's own run recomputes its correction
 * inside the callback from the fresh content it receives
 * (`daysAhead/run.ts:257-265`); this feature's own correction is `ensureNote`'s
 * private decision, not something this module may recompute, so a note that
 * moved between the snapshot and the release is left exactly as the person
 * left it instead — a stale plan is never written over it. Returns
 * whether the write was skipped this way.
 */
async function editIfFresh(notes: RunNotes, file: TFile, text: string, snapshot: string | null): Promise<boolean> {
	let stale = false;
	await notes.edit(file, (freshContent) => {
		if (freshContent !== snapshot) {
			stale = true;
			return freshContent;
		}
		return text;
	});
	return stale;
}

function reportStale(deps: RunDeps, path: string, title: string): void {
	deps.problems.report(
		path,
		`Effortless could not correct "${title}"'s note: it changed after this run read it. It will try again on the next run.`,
	);
}

/**
 * The `TFile` this run's own snapshot found at `path`. Throws when it did
 * not: `ensureNote`'s decision rested on that file being there a moment ago,
 * and the vault changing under this run between the read and the write is
 * a real failure to report, not a silent skip.
 */
function mustFind(vault: RunVault, path: string): TFile {
	const file = vault.fileAt(path);
	if (file === null) throw new Error(`${path} was there a moment ago and is gone now`);
	return file;
}

/**
 * `memory` with `identity`'s dates in `forget` dropped and, when `remember`
 * is not null, its date set to exactly what it says. Dropping and
 * remembering can both apply in one call (a rename remembers today's new
 * entry and forgets the day moved away from in one call, spec #701
 * decision 10).
 *
 * **Returns `memory` itself, unchanged, when `identity`'s entries already
 * read exactly this way** — `remember` is non-null on `nothing-to-do` too,
 * echoing back what is already stored, and a run that decided nothing needs
 * to change must not commit a memory that only looks new (the days ahead's
 * own `withRemembered`, `daysAhead/run.ts`, keeps the identical rule for the
 * identical reason: a caller that commits by identity has to be able to
 * tell an unchanged entry from a changed one).
 */
function withRemembered(
	memory: NotesMemory,
	identity: string,
	remember: RememberedNote | null,
	forget: readonly string[],
): NotesMemory {
	const before = memory[identity] ?? {};
	const after: Record<string, NoteMemoryEntry> = {};
	for (const [entryDate, entry] of Object.entries(before)) {
		if (!forget.includes(entryDate)) after[entryDate] = entry;
	}
	if (remember !== null) {
		after[remember.date] = {
			path: remember.path,
			accounted: remember.accounted,
			...(remember.pendingCorrection !== undefined ? { pendingCorrection: remember.pendingCorrection } : {}),
			...(remember.written !== undefined ? { written: remember.written } : {}),
			...(remember.leftNotes !== undefined ? { leftNotes: remember.leftNotes } : {}),
		};
	}

	if (sameEntries(before, after)) return memory;

	if (Object.keys(after).length === 0) {
		const next: Record<string, Readonly<Record<string, NoteMemoryEntry>>> = {};
		for (const [key, value] of Object.entries(memory)) {
			if (key !== identity) next[key] = value;
		}
		return next;
	}
	return { ...memory, [identity]: after };
}

/**
 * `result.remember`, with its accounted list replaced by whatever this
 * identity's memory already held for the path the rename moved away from,
 * and the correction the note still owes (`result.owed`) recorded beside it
 * so a later run carries it out.
 *
 * Used only when a rename landed but its bundled correction did not:
 * `ensureNote` computed `result.remember.accounted` assuming the
 * correction's added names would actually be written, which they were not,
 * so committing it as-is would mark a name "accounted for" that never
 * reached the note — it would then never be offered again, even after a
 * later run successfully applies the correction.
 */
function fallbackRemember(memory: NotesMemory, identity: string, result: EnsureNoteResult): RememberedNote | null {
	if (result.remember === null) return null;
	const previous = Object.values(memory[identity] ?? {}).find((entry) => entry.path === result.previousPath);
	return {
		...result.remember,
		accounted: previous?.accounted ?? [],
		...(result.owed !== undefined ? { pendingCorrection: result.owed } : {}),
	};
}

/**
 * Whether `before` and `after` name the same dates, each with the same path,
 * the same accounted names in the same order, and the same correction owed
 * or none — a run that carries out an owed correction changes nothing else,
 * and must still commit the marker's removal.
 */
function sameEntries(
	before: Readonly<Record<string, NoteMemoryEntry>>,
	after: Readonly<Record<string, NoteMemoryEntry>>,
): boolean {
	const beforeKeys = Object.keys(before);
	const afterKeys = Object.keys(after);
	if (beforeKeys.length !== afterKeys.length) return false;
	return afterKeys.every((date) => {
		const was = before[date];
		const is = after[date];
		return (
			was !== undefined &&
			was.path === is.path &&
			sameNames(was.accounted, is.accounted) &&
			samePending(was.pendingCorrection, is.pendingCorrection) &&
			sameWritten(was.written, is.written) &&
			sameNames(was.leftNotes ?? [], is.leftNotes ?? [])
		);
	});
}

/** Whether two entries owe the same correction, or both owe none. */
function samePending(a: PendingCorrection | undefined, b: PendingCorrection | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	return a.heading === b.heading && a.dayLink === b.dayLink;
}

/** Whether two entries hold the same record of what was written, or both hold none. */
function sameWritten(a: WrittenRecord | undefined, b: WrittenRecord | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	return a.fingerprint === b.fingerprint && a.endsAt === b.endsAt;
}

/** Whether `a` and `b` hold the same names, in the same order. */
function sameNames(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((name, index) => name === b[index]);
}
