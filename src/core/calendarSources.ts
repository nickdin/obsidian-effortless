/**
 * Where the calendar's bytes come from, and what happens when one source fails.
 *
 * A *calendar source* is either an HTTPS `.ics` link the plugin fetches or an
 * `.ics` file sitting in the vault (ADR 0001). Both hand their bytes to the one
 * reader in `icsReader.ts`, so **nothing downstream ever learns which route
 * filled it** — that is what makes two routes a thin adapter in front of one
 * reader rather than two code paths.
 *
 * The calendar belongs to the core because two features read it — building the
 * days ahead, and meeting notes — and no feature may reference another. Features reach it through `FeatureHost`.
 *
 * Two rules here are not conveniences:
 *
 * - **A link is fetched with Obsidian's `requestUrl`**, never with `fetch`.
 *   That is the app's own route, which has no CORS to fall foul of.
 * - **A file is read as a vault path and nothing else.** Reading outside the
 *   vault would force `isDesktopOnly: true` on the whole manifest and cost
 *   every feature its mobile support to serve one.
 */

import { Component, normalizePath, requestUrl } from "obsidian";
import type { TFile, Vault } from "obsidian";
import { endsAtOf, isNotACalendar, readDayFromAll, readDayLosing, readSpanLosing, reportLoss } from "./icsReader";
import { isExpanderContractError } from "./icsOccurrences";
import type { CalendarFailure, LossGrade, Meeting } from "./icsReader";
import { reasonOf } from "./reason";
import type { DeviceStore } from "./settings";
import { asVaultPath } from "./vaultLayout";
import { sendsSafely } from "./calDav";
import { accountSpan } from "./calDavRead";
import type { Span } from "./calDavRead";

export type { Meeting };

/** How often every link is fetched again. */
export const REFRESH_EVERY_MS = 15 * 60 * 1000;

/**
 * The routes a calendar's bytes arrive by: a published link, a vault file, or
 * one calendar of a calendar account (`calendarAccounts.ts`, #1213).
 */
export type CalendarSourceKind = "link" | "file" | "account";

/**
 * One calendar the person has added.
 *
 * The two switches exist because reading sources directly is what finally lets
 * the plugin tell them apart: a birthdays calendar wants a row in the day and
 * no meeting note. Both ship on.
 */
export interface CalendarSource {
	/** Stable for the life of the row, so its read state survives an edit. */
	readonly id: string;
	/**
	 * What the person calls it. Shown on the settings screen, and in building
	 * the days ahead's report of a source that will not read.
	 */
	name: string;
	kind: CalendarSourceKind;
	/**
	 * The `https://` address, or the vault-relative path, according to `kind`;
	 * for an `account` row, the calendar's own address on its server.
	 */
	location: string;
	/** The id of the calendar account an `account` row belongs to. Absent on every other kind. */
	account?: string;
	/** Whether this calendar's meetings appear in the day's calendar table. */
	showInDay: boolean;
	/** Whether this calendar's meetings get a note of their own. */
	makeNotes: boolean;
}

/** Which switch a reader is asking about. */
export type CalendarUse = "day" | "notes";

/**
 * What a feature is allowed to know about the calendar.
 *
 * `meetingsOn` answers from the copy already in hand, so it is cheap enough for
 * a settings-screen draw or a readiness check. A feature about to write a day
 * awaits `refresh()` first.
 */
export interface Calendar {
	/**
	 * The meetings on `day`, from every source switched on for `use`.
	 *
	 * A source whose copy will not read for that day is left out of the answer
	 * and recorded as failed, rather than shortening the day in silence.
	 */
	meetingsOn(day: Date, use: CalendarUse): readonly Meeting[];
	/**
	 * Whether the calendar can say a meeting is gone from `from`'s day through
	 * the `days` days that start there, and what is on it over that span — see
	 * {@link CalendarPresence}. The one place building the days ahead and
	 * meeting notes both ask before removing anything, so neither decides for
	 * itself what a trustworthy reading is.
	 */
	presenceBetween(from: Date, days: number, use: CalendarUse): CalendarPresence;
	/**
	 * Reads every source again, and resolves once the sources **as they stood
	 * when this was called** have been read.
	 *
	 * That is the guarantee to build a day on: a calendar added a keystroke ago
	 * is in the answer. Concurrent callers never fan out into a read each.
	 *
	 * Never rejects for a source that will not read: a failure is kept per
	 * source.
	 */
	refresh(): Promise<void>;
}

/**
 * What {@link Calendar.presenceBetween} answers: the meetings over a span, and
 * whether their absence can be trusted.
 */
export interface CalendarPresence {
	/**
	 * True only when at least one source is switched on for the use asked
	 * about, and every such source has a stored copy, its last read at the
	 * address it names now stored no failure, and its copy read over the span
	 * without a throw or a lost entry. Anything else answers false, and a
	 * caller about to remove something because a meeting is missing removes
	 * nothing: a meeting missing from a reading that is not whole may only be
	 * missing from the reading. No source at all is not whole either —
	 * an emptied list says nothing about what left the calendar.
	 */
	readonly whole: boolean;
	/**
	 * Every meeting on the span from every source switched on for the use, read
	 * from the copies that could be read. **Invited people or not**, unlike
	 * `meetingsOn(day, "notes")`: a meeting whose invitations were withdrawn is
	 * still on the calendar, and its note is not to be taken for a cancelled
	 * meeting's.
	 */
	readonly meetings: readonly Meeting[];
	/**
	 * The same answer per source, one entry for every source switched on for
	 * the use, in the order the person listed them: a caller removing
	 * something on one source's word asks that source alone, so one calendar
	 * that will not read does not stop another calendar's own changes being
	 * acted on. `meetings` above is these lists joined, leaving out
	 * every source whose last read failed.
	 *
	 * **Optional only for answers written before #1211** — the test doubles
	 * of `Calendar` that predate it. {@link CalendarSources} always fills it,
	 * and a caller handed an answer without it can attribute nothing to any
	 * one source, so it falls back on `whole` alone, the rule that answer was
	 * written for.
	 */
	readonly bySource?: readonly SourcePresence[];
}

/** One source's part of a {@link CalendarPresence}. */
export interface SourcePresence {
	/** {@link CalendarSource.id}: what a caller keeps to ask about this source again. */
	readonly id: string;
	/** {@link CalendarSource.name}, for a caller that has to say which calendar failed. */
	readonly name: string;
	/**
	 * This source alone meets every condition {@link CalendarPresence.whole}
	 * names: a stored copy, earned at the address it names now, no failure
	 * stored, and read over the span without a throw or a lost entry.
	 */
	readonly whole: boolean;
	/**
	 * What this source's held copy shows over the span — the same copy
	 * `meetingsOn` draws the day from — **even when its last read failed**,
	 * so a caller can still say which source a meeting on the day came from
	 * while that source is down; `whole` says whether the copy may be
	 * trusted to show what is gone. Empty when there is no copy, or the copy
	 * throws; what could be read when it lost entries.
	 */
	readonly meetings: readonly Meeting[];
}

/**
 * How one source's last read went, kept per device.
 *
 * This is per-device on purpose. A link that failed on the laptop has not
 * failed on the phone, and the row has to say what happened *here*; `data.json`
 * syncs, so a failure written there would be shown on the machine it never
 * happened on.
 */
export interface CalendarRead {
	/** When this source was last read successfully. Null until it ever was. */
	readAt: number | null;
	/** Why the most recent attempt failed, or null when it worked. */
	failure: string | null;
	/**
	 * How much was lost, when the failure was a loss of events rather than a
	 * refusal to read at all. Absent otherwise.
	 *
	 * The sentence in `failure` cannot be told apart afterwards, and the row's
	 * own prefix and the draw-failure console line both
	 * have to. Optional in the same way `readFrom` is: a state
	 * written before this field existed still reads, and means only that nobody
	 * recorded which it was.
	 */
	loss?: LossGrade;
	/**
	 * The address `readAt` was earned at, as `addressOf` writes it.
	 *
	 * A read state is kept under the source's id, and the id survives an edit to
	 * the address. Without this the row would go on reporting a last-read time
	 * that the calendar it no longer points at earned. Absent in
	 * state written before that, which is taken to belong wherever the source
	 * points now.
	 */
	readFrom?: string;
}

/**
 * The two ways bytes reach the plugin, named narrowly so that nothing testing
 * the calendar needs a vault or a network.
 */
export interface CalendarGateway {
	/** Fetches an HTTPS `.ics` link through Obsidian's own request helper. */
	fetch(url: string): Promise<string>;
	/** Reads an `.ics` file at a vault-relative path. Never outside the vault. */
	readFile(path: string): Promise<string>;
}

/**
 * How an account row's bytes arrive: the id of the row's account, the
 * calendar's address as {@link addressIn} tidies it, this device's
 * app-specific password for the account (undefined when it holds none), and
 * the span to read over. Rejects with a sentence the row can show.
 *
 * Handed in rather than imported, because what an account row needs of its
 * account — who signs in, and whether this device can — is
 * `calendarAccounts.ts`'s to say, and that module imports this one at run
 * time. `accountReader` there is what the plugin hands in.
 */
export type AccountReader = (
	account: string | undefined,
	calendar: string,
	password: string | undefined,
	span: Span,
) => Promise<string>;

/**
 * What a calendar built without an {@link AccountReader} reads an account row
 * with: a failure saying so, on the row, rather than a read that never
 * happens. Only a test that has no account row builds one that way.
 */
const NO_ACCOUNT_READER: AccountReader = () =>
	Promise.reject(new Error("This calendar was built without a way to read calendar accounts."));

/** Only the two vault methods this file uses, so a test can supply two functions. */
type VaultReader = Pick<Vault, "getFileByPath" | "cachedRead">;

/** Only the shape of `requestUrl` this file uses, for the same reason. */
type RequestHelper = (request: {
	url: string;
	throw?: boolean;
}) => Promise<{ status: number; text: string }>;

/**
 * The real gateway: Obsidian's request helper for a link, the vault for a file.
 *
 * The status is checked here rather than left to `requestUrl`'s own throw, so
 * that the row can say what the server actually answered. A `404` on a secret
 * calendar link usually means it was revoked, and that is worth reading.
 */
export function obsidianGateway(
	vault: VaultReader,
	request: RequestHelper = requestUrl,
): CalendarGateway {
	return {
		async fetch(url: string): Promise<string> {
			const response = await request({ url, throw: false });
			if (response.status >= 400) {
				throw new Error(`The calendar link answered ${response.status}.`);
			}
			return response.text;
		},
		async readFile(path: string): Promise<string> {
			const inVault = normalizePath(path);
			const file: TFile | null = vault.getFileByPath(inVault);
			if (file === null) throw new Error(`There is no file at ${inVault} in this vault.`);
			return vault.cachedRead(file);
		},
	};
}

/** A source with nothing filled in, both switches on, and an id of its own. */
export function newCalendarSource(): CalendarSource {
	return {
		id: newCalendarSourceId(),
		name: "",
		kind: "link",
		location: "",
		showInDay: true,
		makeNotes: true,
	};
}

/**
 * Why this source cannot be read, in words the person can act on, or null when
 * there is nothing wrong with it.
 *
 * Checked before every read rather than only when it is typed, because a
 * settings file arrives from another device carrying whatever it carries.
 */
export function sourceProblem(source: CalendarSource): string | null {
	const location = addressIn(source);
	if (source.kind === "account") {
		// Filled in by *Fetch calendars*, never typed, so an address that is
		// missing or unsafe here came from a hand-edited `data.json`.
		if (location === "") return "This calendar has no address on its account.";
		return sendsSafely(location)
			? null
			: "A calendar account's calendar address has to start with https://, so the app-specific password is not sent in the clear. Only a server on this computer may use http://.";
	}
	if (location === "") return "This calendar has no link or file yet.";

	if (source.kind === "link") {
		// http:// is refused rather than upgraded. The address *is* the password:
		// anyone who sees it reads that calendar for ever, so it may not travel
		// in the clear even once.
		//
		// **An `.ics` ending is deliberately not required here**, though the
		// vault-file route below does require one. A published address does not
		// reliably end that way — Microsoft's does not always — and a query
		// string after the `.ics` would defeat a plain suffix check. Refusing a
		// working address is worse than accepting a wrong one, and a wrong one
		// is caught the moment it is fetched: `readFailure` then says the
		// address does not look like a calendar address.
		return location.toLowerCase().startsWith("https://")
			? null
			: "A calendar link has to start with https://, so the address is not sent in the clear.";
	}

	// One or two slashes after the scheme, because both forms reach here. A
	// link pasted into the file-route box is stored through `normalizePath`,
	// which collapses `https://` to `https:/`, so a test for `://` alone let
	// the pasted link through and the row then quoted an address nobody typed. The same
	// pattern still catches the Windows drive letter it was written for: `C:/`
	// and `C:\` are a one-letter scheme by this reading.
	//
	// It has to fire on the stored value rather than on the box, because a bad
	// address also arrives by sync or by hand, and because
	// #248 will start
	// collapsing stored file locations as they load. Neither ticket may assume
	// the other has landed, and this test does not care which did.
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:[\\/]/.test(location) || location.includes("://")) {
		return "The path has to stay inside the vault, so it cannot name a drive or another program.";
	}
	if (normalizePath(location).split("/").includes("..")) {
		return "The path has to stay inside the vault, so it cannot step up out of it.";
	}
	return location.toLowerCase().endsWith(".ics")
		? null
		: "A calendar file has to be an .ics file inside the vault.";
}

/**
 * Where a source's bytes come from, as one string, so that a copy and a read
 * state can be checked against the source they were earned at.
 *
 * The route is part of it because switching route empties the address, and an
 * empty address under one route is not the same address as an empty one under
 * the other.
 *
 * One definition of what an address is, rather than two that can drift. That promise used
 * to be kept by exporting this and letting the settings screen spell an address
 * for itself — which shared only the spelling, while the *rule* that used it was
 * written out in both files. `earnedAt` just
 * below is the rule, and it is what the screen calls now.
 *
 * Still exported, for one narrower reason: a test that stores a `readFrom` has
 * to spell an address the way the code does, or it pins nothing.
 */
export function addressOf(source: CalendarSource): string {
	return `${source.kind}:${addressIn(source)}`;
}

/**
 * Whether a stored read belongs to the source as it stands now.
 *
 * Two parts, and both of them are decisions rather than mechanics. A read
 * carrying no `readFrom` was written before issue #105 recorded one, and is
 * taken to belong wherever the source points now; a read carrying one has to
 * match exactly, because a read is earned at an address and the read state
 * survives an edit to it.
 *
 * **One home, called from both sides.** `readOne` asks it before it lets a row
 * keep a last-read time, and `sourceStateLine` asks it once what is wrong with
 * the source itself has been ruled out — before the row reports any *read*, and
 * not before the row says anything at all. A source with no address, or with an
 * address that cannot be one, gets `sourceProblem`'s own sentence and this is
 * never asked. The
 * two used to write the rule out separately and had already begun to disagree
 * about what an unearned read should suppress. The pair changes
 * for one reason: the day anyone revisits what an address is, or what an absent
 * one means.
 *
 * No read at all answers `true`. There is nothing to disown, and both callers
 * go on to find nothing to show.
 */
export function earnedAt(read: CalendarRead | undefined, source: CalendarSource): boolean {
	return read?.readFrom === undefined || tidiedAddress(read.readFrom) === addressOf(source);
}

/**
 * One calendar source's location, cleaned the way its route wants it.
 *
 * **This is the one place that decides which route is tidied.** A **file** goes
 * through `asVaultPath` in `vaultLayout.ts`, the same rule the daily-log folder
 * and the excluded folders go through. A **link** is
 * trimmed, with a leading `webcal://` read as `https://`, and no more:
 * `normalizePath` collapses the double slash in `https://`, and an address
 * mangled that way fetches nothing.
 *
 * Both routes trim, so an address that is nothing but whitespace becomes no
 * address at all, which is what it names. `asVaultPath` trims
 * first and answers `""` for a blank box, so that rule survives the file route.
 *
 * **Three copies of this dispatch is how the silent loss comes back.** It was
 * written out here, in the settings loader and in the settings section, and
 * `asVaultPath` being imported rather than copied did not help: what drifts is
 * the choice of route, not the vault-path rule. A stored location tidied under
 * one copy and a stored `readFrom` tidied under another stopped matching, and
 * the calendar row silently lost its last-read age. The last good copy
 * of a calendar is kept under its address as stored as well, so the two
 * spellings of one path are two keys for one file. A guard in
 * `calendarSources.test.ts` fails if a fourth copy is written.
 *
 * It lives beside `CalendarSourceKind` rather than in `vaultLayout.ts`, the
 * module `asVaultPath` is exported from, because it is about a calendar source,
 * not about vault paths, and typing its kind from anywhere else would import
 * that type back out of this file — the cycle #429 removed, put back in a new
 * place.
 */
export function asLocation(kind: CalendarSourceKind, location: string): string {
	if (kind === "file") return asVaultPath(location);
	const link = location.trim();
	// `webcal://` names no transport of its own: it is Apple's subscription
	// hint, and the address it stands for is the same one over `https://`. It
	// is rewritten here, where the address is stored, judged and read, so the
	// rest of the plugin only ever sees the `https://` form. Two cases reach
	// it. A value typed into the settings box is stored as `https://`, and the
	// box is set to the stored text at once. A `webcal://`
	// value read from `data.json` at load (`readCalendarSources` in
	// `settings.ts`) is read as its `https://` address, the file itself
	// untouched until something else saves. Neither is a silent replacement of
	// a value the code cannot use, which `CLAUDE.md` forbids for values read
	// from `data.json`: `webcal://h/p` and `https://h/p` are one address
	// written two ways, and nothing is swapped for a default. Only the
	// scheme is touched — the rest is the password and is kept byte for byte.
	// It becomes `https://`, never `http://`, so the address is never sent in
	// the clear. `webcal:` without the slashes and every other scheme are left
	// for `sourceProblem` to refuse.
	return link.toLowerCase().startsWith(WEBCAL) ? `https://${link.slice(WEBCAL.length)}` : link;
}

const WEBCAL = "webcal://";

/**
 * The address a source names, as the one string that is judged, stored and
 * read.
 *
 * There used to be two: the check trimmed and the read did not, so a stored
 * address carrying whitespace passed the check and then failed the read, and
 * the row said "There is no file at …" naming a path that looked exactly right
 * to the person. Obsidian's `normalizePath` trims slashes, not whitespace, so
 * nothing downstream rescued it. The loader now cleans a stored address as it
 * arrives, and this is the other half of the same guarantee: whatever a source
 * carries, everything here reads it through one function.
 */
function addressIn(source: CalendarSource): string {
	return asLocation(source.kind, source.location);
}

/**
 * A stored address, read back the way `addressOf` would spell one today.
 *
 * A `readFrom` in `data.json` was written by whichever version of the plugin
 * earned it, and the tidying a location receives has changed since: #248 began
 * putting a `file` source's stored location through the vault-path rule as the
 * settings load. So a `data.json` holding `location: "/Calendars/work.ics"` and
 * `readFrom: "file:/Calendars/work.ics"` came back with a tidied location and
 * an untidied address, they stopped matching, and the row lost its last-read
 * age and any recorded failure until the next read.
 *
 * Both sides of the comparison are therefore tidied, rather than one. Nothing
 * on disk is rewritten: a tidied value is written back only when something else
 * saves, so #248's own scope line still holds.
 *
 * The kind is the part before the first colon, which is where `addressOf` puts
 * it. A link's own `https://` colons all sit after that one, so splitting there
 * cannot cut an address in half.
 */
function tidiedAddress(stored: string): string {
	const cut = stored.indexOf(":");
	if (cut < 0) return stored;
	const kind = stored.slice(0, cut);
	// `link`, `file` and `account` are the only prefixes this plugin writes, so
	// they are the only ones it can read back. An unrecognised prefix is already a
	// no-match, and it is handed back untouched rather than cleaned as a link.
	// The branch is unobservable in practice: `readFrom` is written only from
	// `addressOf`, so an unrecognised prefix can only come from a hand-edited
	// `data.json`, and it fails the comparison in `earnedAt` either way. It
	// arrived on #427's commit, and this sentence is what keeps that ticket's
	// "existing behaviour is unchanged" honest. #432 was
	// closed `wontfix`; this guard is the only part of it that was taken.
	if (kind !== "link" && kind !== "file" && kind !== "account") return stored;
	return `${kind}:${asLocation(kind, stored.slice(cut + 1))}`;
}

/** One source's last good bytes, and the address they were read from. */
interface Copy {
	readonly ics: string;
	readonly from: string;
	/**
	 * The days an account's calendar was read over. Absent on a link's
	 * or a file's copy, which holds the whole calendar. A server answers a
	 * repeating meeting whole, rule and all, so the bytes alone would answer
	 * days outside it; the copy answers nothing there instead.
	 */
	readonly span?: Span;
}

/**
 * Why a read failed, in words the person can act on.
 *
 * Bytes that are not a calendar mean different things on the two routes. A vault
 * file was already checked to be an `.ics` file inside the vault, so the file
 * itself is what is wrong. A link was only checked to start `https://`, because
 * requiring `.ics` there would refuse working published addresses (see
 * `sourceProblem`) — and the easy mistake is pasting the calendar's *sharing
 * page* rather than its published address. So the link route says that first and
 * puts the reader's own reason after it.
 *
 * Only bytes that are not a calendar are worded this way, and that is asked of
 * the error rather than read off its type. One error type covers
 * both "these bytes were never a calendar" and "this really is a calendar and it
 * stops partway through" — the second is a half-finished download, whose address
 * may be perfect. A link that answered `404`, or that could not be reached at
 * all, likewise still reports exactly what it reported.
 */
function readFailure(source: CalendarSource, error: unknown): string {
	const reason = reasonOf(error);
	if (source.kind !== "link" || !isNotACalendar(error)) return reason;
	return `That address does not look like a calendar address. ${reason}`;
}

/**
 * The source list as one string, carrying only what a read depends on: which
 * calendars there are and where each one's bytes come from.
 *
 * A string rather than the array itself, because the array a caller hands over
 * may be changed in place afterwards, and a snapshot that changes underneath
 * cannot answer whether a read saw the list a caller had.
 */
function listRead(sources: readonly CalendarSource[]): string {
	return sources.map((source) => `${source.id}\u0000${addressOf(source)}`).join("\u0001");
}

/**
 * The core's calendar: it holds every source's last good copy, reads them all
 * again every fifteen minutes, and answers a day from what it has.
 *
 * It is a `Component`, so whoever adds it as a child starts the cycle and
 * whoever removes it stops it — the interval is registered rather than kept,
 * and Obsidian clears it on unload.
 */
export class CalendarSources extends Component implements Calendar {
	/**
	 * The last copy of each source that read cleanly, by source id. This is what
	 * makes a failed fetch harmless: the day is built from what was last known
	 * rather than emptied. It lives for as long as Obsidian is open and no
	 * longer — after a restart a source that will not read has nothing to fall
	 * back on, and its row says so.
	 *
	 * Each copy carries the address it was read from, because the id it is kept
	 * under outlives an edit to that address. A copy whose address no longer
	 * matches its source is dropped rather than served: it belongs to whichever
	 * calendar used to be there.
	 */
	private readonly copies = new Map<string, Copy>();

	/**
	 * The read in flight, and the source list it snapshotted when it began, so
	 * that two reads never interleave their bookkeeping and a caller can tell
	 * whether the one in flight is reading the list it is asking about.
	 */
	private running: { readonly list: string; readonly done: Promise<void> } | null = null;

	/**
	 * The one follow-up read promised to every caller that arrived while a read
	 * of some other list was in flight. Ten such callers cause two reads, not
	 * eleven.
	 */
	private queued: Promise<void> | null = null;

	/**
	 * Whether this instance is currently loaded. `Component` keeps its own
	 * loaded flag privately, so a subclass cannot read it, and the layout-ready
	 * callback below is queued on the workspace rather than on this component:
	 * it outlives an unload and must not act on a dead instance.
	 */
	private isLoaded = false;

	constructor(
		private readonly sources: () => readonly CalendarSource[],
		private readonly device: DeviceStore,
		private readonly gateway: CalendarGateway,
		/** Injected so a test can say what time it is. */
		private readonly now: () => number = Date.now,
		/**
		 * Injected so this class never has to hold an `app`. The plugin supplies
		 * `app.workspace.onLayoutReady`, which runs its callback at once when the
		 * layout is already up — the default here does the same, so a test and
		 * every construction site that does not pass one keeps today's timing.
		 */
		private readonly whenReady: (callback: () => void) => void = (callback) => callback(),
		/** Reads an account row; `calendarAccounts.ts`'s `accountReader` is the plugin's. */
		private readonly readAccount: AccountReader = NO_ACCOUNT_READER,
	) {
		super();
	}

	override onload(): void {
		this.isLoaded = true;
		this.whenReady(() => {
			if (this.isLoaded) void this.refresh();
		});
		this.registerInterval(window.setInterval(() => void this.refresh(), REFRESH_EVERY_MS));
	}

	override onunload(): void {
		this.isLoaded = false;
	}

	meetingsOn(day: Date, use: CalendarUse): readonly Meeting[] {
		const wanted = this.sources().filter((source) =>
			use === "day" ? source.showInDay : source.makeNotes,
		);
		// The source is carried alongside its copy, because `readDayFromAll`
		// names a failure by its place in the list it was handed and that place
		// only means something next to the source it came from.
		const asked = wanted
			.map((source) => ({ source, ics: this.copyOf(source, day) }))
			.filter((pair): pair is { source: CalendarSource; ics: string } => pair.ics !== undefined);
		const reading = readDayFromAll(
			asked.map((pair) => pair.ics),
			day,
		);
		// Nothing is thrown: this call is on the path that draws a day, and one
		// calendar that will not read must not stop the other ones being shown.
		// It is said out loud instead, on the row for the source it happened to.
		this.recordDrawFailures(
			asked.map((pair) => pair.source),
			reading.failures,
		);
		// **"notes" answers only a meeting with invited people, as the old
		// plugin did**: `calendar-scaffold/src/schema-table.ts:219`'s
		// `isMeeting` was `event.calendar === WORK_CALENDAR && event.attendees.length > 0`.
		// #701 moved the calendar half onto `makeNotes` above; this is the
		// attendee half, carried back. It is decided here, the one place both
		// `daysAhead` and `meetingNotes` ask (`desiredRowsFor`'s `makesNote`,
		// `meetingNotes/run.ts`'s own `meetings`), so neither feature re-derives
		// it. **The organizer alone does not count**: the old rule read
		// `attendees.length` only, never `organizer`, and `.ics` gives the two as
		// separate properties — an event can name an organizer nobody else was
		// invited to. A meeting with attendees but no named organizer still
		// counts, for the same reason read the other way.
		return use === "notes" ? reading.meetings.filter(hasInvitedPeople) : reading.meetings;
	}

	/**
	 * Asks only what is already in hand, like {@link meetingsOn}, and writes
	 * nothing: a copy that will not read here is already said on its row by
	 * the read or the draw that met it, and this is a question, not a draw.
	 */
	presenceBetween(from: Date, days: number, use: CalendarUse): CalendarPresence {
		const wanted = this.sources().filter((source) =>
			use === "day" ? source.showInDay : source.makeNotes,
		);
		const reads = this.device.read().calendarReads;
		// Each source's part, and whether its last read stored no failure: the
		// flattened `meetings` keeps only those, as it did before #1211, while
		// a part says what its held copy shows either way.
		const parts = wanted.map((source): { part: SourcePresence; readCleanly: boolean } => {
			const of = { id: source.id, name: source.name };
			const copy = this.heldCopy(source);
			if (copy === undefined) return { part: { ...of, whole: false, meetings: [] }, readCleanly: false };
			const read = reads[source.id];
			const readCleanly = read !== undefined && read.failure === null && earnedAt(read, source);
			try {
				const span = readSpanLosing(copy.ics, from, days);
				// Days reaching past the span an account was read over are not
				// known, so the part is not whole there and holds only what is inside.
				const readOver = copy.span;
				const asked = readOver === undefined || spanHoldsDays(readOver, from, days);
				const meetings = readOver === undefined ? span.meetings : span.meetings.filter((one) => insideSpan(one, readOver));
				return { part: { ...of, whole: readCleanly && span.loss === null && asked, meetings }, readCleanly };
			} catch {
				// Not reported here: a copy that throws is stored only after the
				// read that would have thrown the same, and that read said so on
				// the source's row. What matters to this answer is that the
				// source's meetings are not known, so nothing may be removed.
				return { part: { ...of, whole: false, meetings: [] }, readCleanly: false };
			}
		});
		const bySource = parts.map((one) => one.part);
		return {
			whole: bySource.length > 0 && bySource.every((one) => one.whole),
			meetings: ([] as Meeting[]).concat(...parts.filter((one) => one.readCleanly).map((one) => one.part.meetings)),
			bySource,
		};
	}

	/**
	 * The bytes stored for `source`, or undefined when none of them belong to
	 * the address it names now. A question only: it answers, and changes
	 * nothing. `dropStaleCopy` is what forgets a copy.
	 */
	private copyOf(source: CalendarSource, day: Date): string | undefined {
		const held = this.heldCopy(source);
		if (held === undefined) return undefined;
		return held.span === undefined || spanHoldsDays(held.span, day, 1) ? held.ics : undefined;
	}

	/** The copy stored for `source`, when it was read from the address it names now. */
	private heldCopy(source: CalendarSource): Copy | undefined {
		const held = this.copies.get(source.id);
		if (held === undefined) return undefined;
		return held.from === addressOf(source) ? held : undefined;
	}

	/**
	 * Forgets the copy held for `source` when it was read from an address the
	 * source has since been repointed away from.
	 *
	 * Keeping a copy through a read that failed with the address **unchanged**
	 * is what the copy is for — the network is down, the file is momentarily
	 * locked — and that is left alone.
	 *
	 * **Only a read forgets. Drawing a day deliberately does not.** `meetingsOn`
	 * asks `copyOf` whether there are bytes for the address the source names
	 * now and takes them if there are, so a calendar repointed away and back
	 * with no read between still has its copy and the day is drawn from it. The
	 * bytes really were read from the address the source names — `copyOf`
	 * compares the two and answers nothing when they differ — so they are old
	 * rather than wrong, which is the same bargain issue #105 already strikes
	 * for a failed read. Deleting on a mere question was a side effect of the
	 * shape this pair had before issue #170 split it, and nobody chose it.
	 */
	private dropStaleCopy(source: CalendarSource): void {
		const held = this.copies.get(source.id);
		if (held !== undefined && held.from !== addressOf(source)) this.copies.delete(source.id);
	}

	/**
	 * Writes what a draw found onto each source's own read state, so a copy that
	 * stops reading shows as a failed row rather than as a day with meetings
	 * missing from it. The same field `readOne` writes, and the same row draws it.
	 *
	 * **A draw where nothing failed writes nothing at all**, and a failure that
	 * has not changed since the last draw writes nothing either. That is what
	 * keeps `meetingsOn` cheap enough for a `readiness()` check and a
	 * settings-screen paint, both of which run it every time.
	 *
	 * The time of the last good read is left alone. A copy that will not read
	 * today was still read cleanly whenever it was fetched, and the row says
	 * both things at once.
	 */
	private recordDrawFailures(
		asked: readonly CalendarSource[],
		failures: readonly CalendarFailure[],
	): void {
		if (failures.length === 0) return;

		const reads = this.device.read().calendarReads;
		const changed: Record<string, CalendarRead> = {};
		for (const failure of failures) {
			const source = asked[failure.index];
			if (source === undefined) continue;
			const before = reads[source.id];
			if (before?.failure === failure.reason) continue;
			// Built one field at a time rather than spread from the previous
			// entry, so each optional field is decided on its own rather than
			// carried in and then undone. The rule both of them follow — carried
			// or left off, never an explicit undefined — is written out once, on
			// `readCalendarReads` in `src/core/settings.ts`.
			//
			// `readFrom` is carried: the address the last good read was earned at
			// must survive a draw failure, or a repointed source keeps a time it
			// never earned. The grade is not: one already stored
			// belongs to the previous failure, and this failure may not be a loss
			// at all.
			const entry: CalendarRead = {
				readAt: before?.readAt ?? null,
				failure: failure.reason,
			};
			if (before?.readFrom !== undefined) entry.readFrom = before.readFrom;
			if (failure.loss !== undefined) entry.loss = failure.loss;
			changed[source.id] = entry;
			console.warn(this.drawFailureLine(source, failure));
		}

		if (Object.keys(changed).length === 0) return;
		this.device.save({ calendarReads: { ...reads, ...changed } });
	}

	/**
	 * What the developer console is told about one source that failed a draw.
	 *
	 * **Two sentences, chosen by the grade rather than by the words**. Issue #53 widened a failure to mean "lost entries, some or all of
	 * them", and this line went on asserting the older, stronger meaning: for a
	 * calendar that lost one entry of four, both of its clauses were false — the
	 * calendar *was* read, and its meetings *are* in the day — and the reason
	 * appended after them then said the opposite, "Every other entry in it was
	 * read." `failure.loss` is the field issue #134 added so that this could be
	 * asked instead of parsing the sentence back apart.
	 *
	 * Both lines open `Effortless: the calendar "<name>"` and end with the
	 * reader's own reason. `docs/acceptance-queue.md` tells a tester to look for
	 * that opening in the console, so it is part of the contract rather than a
	 * habit.
	 */
	private drawFailureLine(source: CalendarSource, failure: CalendarFailure): string {
		const opening = `Effortless: the calendar "${source.name}"`;
		if (failure.loss === "partial") {
			return (
				`${opening} was read while a day was being drawn, but some of its entries ` +
				`were left out of it. ${failure.reason}`
			);
		}
		return (
			`${opening} could not be read while a day was being drawn, so its meetings ` +
			`are missing from it. ${failure.reason}`
		);
	}

	/**
	 * Reads every source again, and resolves once a read has finished that saw
	 * the source list **no earlier than** when this was called.
	 *
	 * De-duplicating concurrent calls is right, and joining whatever happens to
	 * be running is not: a read snapshotted its list when it began, so a caller
	 * that joins it can be answered about a list that read never saw. The
	 * settings screen writes on every keystroke, so a calendar edited a moment
	 * ago would be missing from the very next day written.
	 *
	 * So a caller joins the read in flight only when that read is reading this
	 * same list, and otherwise waits on one follow-up read that every such
	 * caller shares. Two callers in the same tick still cause one read of each
	 * source; no caller ever starts a read of its own.
	 *
	 * **A queued caller may be answered by a read of a *newer* list than the one
	 * it asked about**. The follow-up calls `refresh()` again when
	 * it starts, so it reads the list as it stands then. Where the list goes
	 * A → B → A inside one read, the caller who asked at B is answered by a read
	 * of A. That is deliberate, and stronger than it sounds: the answer is never
	 * stale, only fresher than asked for, which is what a caller wants.
	 *
	 * Carrying the queuing caller's own list instead would not hold either.
	 * There is one `queued` promise and every caller whose list differs from the
	 * read in flight joins it, so a follow-up carrying the *first* queuer's list
	 * would answer the second about a list it never asked about — the same thing,
	 * moved. Answering each caller about its own list needs one read per distinct
	 * list, and the settings screen writes on every keystroke: a read per
	 * character typed, to return an answer already older than the one given here.
	 */
	async refresh(): Promise<void> {
		const sources = this.sources();
		const list = listRead(sources);
		const inFlight = this.running;
		if (inFlight === null) return this.startReading(sources, list);
		if (inFlight.list === list) return inFlight.done;
		if (this.queued === null) {
			// Whether the read in flight failed is not the follow-up's business,
			// and letting that rejection through here would leave `queued` set
			// for ever and wedge every later call.
			this.queued = inFlight.done
				.catch(() => undefined)
				.then(() => {
					this.queued = null;
					return this.refresh();
				});
		}
		return this.queued;
	}

	/** Starts a read of `sources` and records the list it is reading. */
	private startReading(sources: readonly CalendarSource[], list: string): Promise<void> {
		const done = this.readEverySource(sources).finally(() => {
			this.running = null;
		});
		this.running = { list, done };
		return done;
	}

	private async readEverySource(sources: readonly CalendarSource[]): Promise<void> {
		const before = this.device.read().calendarReads;
		const reads: Record<string, CalendarRead> = {};

		// One read of the whole list, one console line. The calendar library
		// breaking its own contract breaks it for every source at once, and six
		// identical lines every refresh would say nothing the first one did not. A local rather than module-level state, so it resets by
		// itself on the next read.
		const contractBreak = { said: false };

		await Promise.all(
			sources.map(async (source) => {
				reads[source.id] = await this.readOne(source, before[source.id], contractBreak);
			}),
		);

		// Built from the sources there are now, so a removed source leaves no
		// read state behind for an id nothing will ever ask about again.
		for (const id of [...this.copies.keys()]) {
			if (!sources.some((source) => source.id === id)) this.copies.delete(id);
		}
		this.device.save({ calendarReads: reads });
	}

	/**
	 * One source read, as the read state to store for it.
	 *
	 * `contractBreak` is the one line the whole read is allowed to say about the
	 * calendar library breaking its own contract, threaded in from
	 * `readEverySource` so that it is said once rather than once per source.
	 */
	private async readOne(
		source: CalendarSource,
		before: CalendarRead | undefined,
		contractBreak: { said: boolean },
	): Promise<CalendarRead> {
		const address = addressOf(source);
		// Dropped first, so that the early return below cannot leave the
		// previous calendar's bytes sitting there to be served all afternoon.
		this.dropStaleCopy(source);
		// A last-read time is the previous address's if that is where it was
		// earned, and a row may not claim it once the source has been repointed.
		const lastGood = earnedAt(before, source) ? (before?.readAt ?? null) : null;
		const problem = sourceProblem(source);
		// A source that cannot be read is not asked for. Nothing is fetched and
		// nothing is opened until the person has finished typing it.
		if (problem !== null) return { readAt: lastGood, failure: problem, readFrom: address };
		try {
			const where = addressIn(source);
			// An account row is read over a span counted from today,
			// and its copy keeps the span. A row this device cannot sign in for
			// is refused by the reader before anything is sent, and lands in
			// the `catch` below like any failed fetch: its last copy stays.
			const span = source.kind === "account" ? accountSpan(new Date(this.now())) : undefined;
			const ics =
				span !== undefined
					? await this.readAccount(source.account, where, this.device.password(source.account ?? ""), span)
					: source.kind === "link"
						? await this.gateway.fetch(where)
						: await this.gateway.readFile(where);
			// Proved to be a calendar before it replaces the last good copy. An
			// expired secret link answers a sign-in page with a perfectly good
			// status code, and storing that would empty the day rather than
			// saying what went wrong.
			//
			// The read is kept rather than thrown away, because a calendar that
			// parses and then loses its events does not throw. Dropping what came
			// back stored such a calendar as a clean read, and the row said
			// `Last read just now` with nothing wrong.
			const { loss } = readDayLosing(ics, new Date(this.now()));
			this.copies.set(source.id, span === undefined ? { ics, from: address } : { ics, from: address, span });
			// The copy is stored either way: the entries that did read are still
			// this calendar's best answer for the day, and the failure says what
			// is missing from it.
			if (loss === null) return { readAt: this.now(), failure: null, readFrom: address };
			const report = reportLoss(loss);
			return {
				readAt: this.now(),
				failure: report.reason,
				loss: report.loss,
				readFrom: address,
			};
		} catch (error) {
			// The calendar library breaking its own contract is not this
			// calendar's failure, and marking a good source failed over it is
			// exactly the sentence issue #289 was written to prevent. The read
			// state is handed back as it was, so no row changes and nothing new
			// appears on screen; the console gets the message once for the whole
			// read. `isExpanderContractError` in `src/core/icsOccurrences.ts`
			// carries the reasoning and the trade-off against issue #53.
			if (isExpanderContractError(error)) {
				if (!contractBreak.said) {
					contractBreak.said = true;
					console.warn(`Effortless: ${reasonOf(error)}`);
				}
				// Nothing was learned about this source, so nothing about it is
				// written. A source with no state earned at this address gets an
				// empty one rather than a failed one: it has still never been read.
				return earnedAt(before, source) && before !== undefined
					? before
					: { readAt: null, failure: null, readFrom: address };
			}
			// The last good copy stays where it is, so the day keeps its meetings.
			return { readAt: lastGood, failure: readFailure(source, error), readFrom: address };
		}
	}
}

/** Whether `span` holds every one of the `days` calendar days starting at `from`'s own day. */
function spanHoldsDays(span: Span, from: Date, days: number): boolean {
	const first = new Date(from.getFullYear(), from.getMonth(), from.getDate());
	const after = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
	return first >= span.from && after <= span.to;
}

/** Whether `meeting` touches `span` at all. */
function insideSpan(meeting: Meeting, span: Span): boolean {
	return meeting.start < span.to && endsAtOf(meeting) > span.from.getTime();
}

/**
 * Whether a meeting has at least one invited person — the old plugin's own
 * bar for a meeting note and a link. The organizer is not
 * asked: an event can name one with nobody else invited, and that is not a
 * meeting anyone but its organizer already knows about.
 */
function hasInvitedPeople(meeting: Meeting): boolean {
	return meeting.attendees.length > 0;
}

/**
 * An id nothing else will hold. Not a UUID: this only has to be unique among
 * the handful of calendars one person has added, and it is never shown.
 *
 * Exported because the settings loader needs one too, for a stored row that
 * arrives without an id — a row without one would share its read state with
 * every other row without one. The expression was written out a second time
 * there until issue #119, and an id that ever has to be longer, prefixed or
 * collision-proof has to have one place to change it in.
 */
export function newCalendarSourceId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
