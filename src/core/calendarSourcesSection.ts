/**
 * The calendar sources on the settings screen: one block per calendar, and a
 * button to add another.
 *
 * It is its own file rather than another method on the settings tab because it
 * is a whole section with its own rules — what a link may look like, what a
 * path may look like, what a row says when a read failed — and the tab should
 * not grow a second job. The tab calls `renderCalendarSources` and knows
 * nothing else about it.
 *
 * **The read state is read from the per-device store, not from a live
 * calendar.** How long ago a calendar was last read, and whether the last try
 * failed, is this device's own business: `data.json` syncs and the other
 * machine's failure is not this row's news. Keeping it there is also what lets
 * this section be drawn without holding the running calendar.
 */

import { Setting } from "obsidian";
import { obsidianDavRequest } from "./calDav";
import type { DavRequest } from "./calDav";
import { accountProblem } from "./calendarAccounts";
import type { CalendarAccount } from "./calendarAccounts";
import { CALENDAR_ACCOUNTS_SETTING_NAMES, drawCalendarAccounts } from "./calendarAccountsSection";
import type { FetchedCalendars } from "./calendarAccountsSection";
import { asLocation, earnedAt, newCalendarSource, sourceProblem } from "./calendarSources";
import type { CalendarRead, CalendarSource, CalendarSourceKind } from "./calendarSources";
import type { LossGrade } from "./icsReader";
import { announceFailedSave } from "./saveFailureAnnouncer";
import type { SaveFailureAnnouncer } from "./saveFailureAnnouncer";
import type { CoreSettings, DeviceStore, SettingsStore } from "./settings";

/**
 * The fixed names of the rows this section draws, its accounts part included,
 * for the settings search.
 * A calendar's own name is typed into its Name box, never drawn as a row's
 * name, so nothing here comes from data.
 */
export const CALENDAR_SOURCES_SETTING_NAMES: readonly string[] = [
	"Calendar sources",
	"Name",
	"Where it comes from",
	"Show in the day",
	"Make notes",
	"Add a calendar",
	...CALENDAR_ACCOUNTS_SETTING_NAMES,
];

/**
 * Draws the section into `parent`, and draws it again by itself whenever the
 * list changes shape — a calendar added, removed, or switched between a link
 * and a file, which changes whether its address is masked.
 *
 * `announceDeferredSaveFailure` is the settings screen's own announcer, shared
 * with every other section on that screen so that one failed deferred write is
 * said once however many sections joined it.
 *
 * **Required, with no default, and that is the point of it.** A default would
 * build this section a private announcer, which is the very shape #254 exists to
 * remove: a second announcer behind the module boundary, finding its own slot
 * unset and announcing a run the settings screen has already announced. It
 * shipped as a default for one wave and the review caught it — a second caller
 * that forgot the argument would have brought the double announcement back with
 * no compiler error and no failing test. A caller that genuinely has no screen
 * to share with says so by building its own and passing it.
 */
export function renderCalendarSources(
	parent: HTMLElement,
	settings: SettingsStore,
	device: DeviceStore,
	announceDeferredSaveFailure: SaveFailureAnnouncer,
	/**
	 * What *Fetch calendars* signs in through: Obsidian's own request helper,
	 * unless a test plays the server.
	 */
	request: DavRequest = obsidianDavRequest,
): void {
	const section = parent.createDiv({ cls: "effortless-calendar-sources" });
	// Each account's last *Fetch calendars*, kept across the redraws a tick
	// causes, so the list stays on screen while calendars are ticked.
	const fetched: FetchedCalendars = new Map();
	// The state line of every account row drawn, so a password or user name
	// typed below brings them up to date without drawing anything again.
	let accountRows: Array<() => void> = [];

	const draw = (): void => {
		section.empty();
		accountRows = [];
		const sources = settings.core().calendarSources;

		new Setting(section)
			.setName("Calendar sources")
			.setDesc(
				"A calendar is a published link, an .ics file in your vault, or a calendar on one of the calendar accounts below. " +
					"Treat a link like a password: anyone who has it can read that calendar " +
					"for ever without signing in, and it is stored inside your vault.",
			)
			.setHeading();

		for (const source of sources) {
			const account = source.kind === "account" ? accountOf(source) : null;
			const shown = drawSource(section, source, () => device.read().calendarReads[source.id], account, {
				save: (change) => saveOne(source.id, change),
				saveTyped: (change) => saveOneSoon(source.id, change),
				restate: (change) => {
					saveOneSoon(source.id, change);
					// Answered with nothing rather than with a copy plus the change
					// pasted on. Such a calendar exists nowhere, and drawing a line
					// for it describes a calendar that was never saved.
					return settings.core().calendarSources.find((other) => other.id === source.id);
				},
				redraw: async (change) => {
					await saveOne(source.id, change);
					draw();
				},
				remove: async () => {
					await save(settings.core().calendarSources.filter((other) => other.id !== source.id));
					draw();
				},
			});
			if (source.kind === "account") accountRows.push(shown);
		}

		new Setting(section)
			.setName("Add a calendar")
			.setDesc("A new calendar starts empty, shown in the day and making notes.")
			.addButton((button) =>
				button
					.setButtonText("Add")
					.setCta()
					.onClick(async () => {
						await save([...settings.core().calendarSources, newCalendarSource()]);
						draw();
					}),
			);

		drawCalendarAccounts(section, {
			settings,
			device,
			request,
			announceDeferredSaveFailure,
			fetched,
			saveCore,
			redraw: draw,
			refreshRows: () => {
				for (const show of accountRows) show();
			},
		});
	};

	/**
	 * What an account row needs to know of its account, asked afresh each time
	 * the row is brought up to date, so a user name or password typed below is
	 * what the row says: the account as the store holds it now, and whether
	 * this device holds its app-specific password.
	 */
	const accountOf = (source: CalendarSource): AccountOfRow => {
		const now = (): CalendarAccount | undefined =>
			settings.core().calendarAccounts.find((one) => one.id === source.account);
		return {
			problem: () => accountProblem(now(), device.password(source.account ?? "")),
			describe: () => {
				const on = now();
				return on === undefined
					? "A calendar on a calendar account that is no longer in the settings."
					: `A calendar on the calendar account "${on.user}" at ${on.address}.`;
			},
		};
	};

	/**
	 * Changes one calendar in the list as it stands **now**, found by its id.
	 *
	 * Not by its place in the list the block was drawn from: a block is drawn
	 * once and then edited several times, so writing back a copy taken at draw
	 * time would undo whatever was typed into the row before it. The id is what
	 * the row and the stored calendar have in common between edits.
	 */
	const saveOne = async (id: string, change: Partial<CalendarSource>): Promise<void> => {
		await save(withChange(id, change));
	};

	/** The same change, on the debounced route. */
	const saveOneSoon = (id: string, change: Partial<CalendarSource>): void => {
		saveSoon(withChange(id, change));
	};

	/** The list as it stands now, with one calendar's change folded into it. */
	const withChange = (id: string, change: Partial<CalendarSource>): CalendarSource[] =>
		settings.core().calendarSources.map((source) =>
			source.id === id ? { ...source, ...change } : source,
		);

	/**
	 * Writes the whole list back through the core's own store, which is the one
	 * caller of `saveData` in the plugin.
	 *
	 * Every helper above that calls this one awaits what it returns: `saveOne`,
	 * `remove`, and the Add button's own handler. The promise is dropped one step
	 * further out, in Obsidian's handlers, which have nowhere to put one — a
	 * row's `onChange` and the Remove button's `onClick` reach here through
	 * `saveOne` and `remove`, and the Add button's `onClick` calls here directly.
	 *
	 * So a failure is announced here or nowhere: the box would go on showing
	 * what was typed and the next reload would quietly drop it.
	 */
	const save = async (next: CalendarSource[]): Promise<void> => {
		await saveCore({ calendarSources: next });
	};

	/**
	 * `save`'s own route for any change to the core settings, answering whether
	 * the write landed: the accounts part writes the account list as well as
	 * the calendar list, and forgets what this device keeps for a row only once
	 * the row is gone from the store.
	 */
	const saveCore = async (change: Partial<CoreSettings>): Promise<boolean> => {
		try {
			await settings.saveCore({ ...settings.core(), ...change });
			return true;
		} catch (error) {
			announceFailedSave(error);
			return false;
		}
	};

	/**
	 * The same as `save`, for a change that arrives once per keystroke.
	 *
	 * A published address runs well past a hundred characters and `save` writes
	 * the whole of `data.json` every time it is called, so pasting one used to
	 * be a write per character. Only the write
	 * waits: `saveCoreSoon` changes the core settings straight away, so `restate`
	 * reads back what was just typed and the line under the row keeps up with
	 * the keystroke rather than with the write.
	 *
	 * Nothing awaits what this asks for — that is the whole point of it — so the
	 * failure is announced from in here, once for the run rather than once for
	 * each keystroke that joined it.
	 *
	 * The announcer is the settings screen's own and is shared with the rest of
	 * the screen, because the store's pending write is shared too: a run of
	 * typing that started in the card's boxes and ended in a calendar row is one
	 * write, and a flag held privately here announced its failure a second time. The promise is
	 * the run's own name, which is #186's mechanism and is unchanged.
	 */
	const saveSoon = (next: CalendarSource[]): void => {
		const write = settings.saveCoreSoon({ ...settings.core(), calendarSources: next });
		void write.catch((error: unknown) => announceDeferredSaveFailure(write, error));
	};

	draw();
}

/** What an account row knows of its account. */
interface AccountOfRow {
	/** Why the account cannot be read from this device now, or null. */
	problem(): string | null;
	/** The sentence naming the account the row's calendar is on. */
	describe(): string;
}

/** What one calendar's block can do to the list it sits in. */
interface SourceActions {
	/** Stores a change and leaves the screen as it is. */
	save(change: Partial<CalendarSource>): Promise<void>;
	/**
	 * The same, for a box typed into a character at a time: the whole run of
	 * keystrokes is one write, made once the typing has stopped.
	 *
	 * Answers nothing. A deferred write has not happened yet, so there is
	 * nothing to hand back and nothing to await; a failure announces itself.
	 */
	saveTyped(change: Partial<CalendarSource>): void;
	/**
	 * Stores a change and answers with the calendar as it now stands, so the
	 * block can bring its own state line up to date.
	 *
	 * The whole section is deliberately not drawn again: redrawing on every
	 * keystroke would replace the box being typed in and take the caret out of
	 * it, along with whatever is half typed.
	 *
	 * **Answers `undefined` when the calendar is no longer in the list**, which
	 * is the row having been removed underneath the block, and nothing else. It
	 * never invents one to answer with: a line drawn from a calendar nobody
	 * stored describes something that exists nowhere, and says nothing about
	 * that. The caller leaves the line as it was.
	 *
	 * **A failed write is not one of those cases, and this comment used to say
	 * it was**.
	 * `saveCore` puts the new list in the store before it awaits the write, and
	 * `saveSoon` catches a rejection into a `Notice` rather than rethrowing, so
	 * a call made before the write's outcome is known still finds the calendar
	 * here and is answered with the new copy. That holds only until the
	 * rejection is heard: with nothing else queued to carry the change,
	 * `queueWrite`'s restore puts the store back to the last landed copy, and a call
	 * made after that finds the calendar as the file holds it, not as it was
	 * typed. This line does not follow the restore itself. The settings screen
	 * does: the store tells it that memory was put back, and it draws this
	 * section again from the store, so the row's boxes and this line show what
	 * the file holds rather than a value no later write would carry. A failed
	 * write is still announced once for the run of keystrokes — the paragraph
	 * below, reached from the other side.
	 *
	 * **"As it now stands" is the settings store, not the file.** The write is
	 * deferred like `saveTyped`'s, so this answers on the keystroke
	 * with what the store now holds, and a write that fails afterwards is
	 * announced rather than shown here. Awaiting the write instead would leave
	 * the line four hundred milliseconds behind the typing, which is the thing
	 * issue #108 exists to prevent.
	 */
	restate(change: Partial<CalendarSource>): CalendarSource | undefined;
	/** Stores a change that alters the block itself, then draws it again. */
	redraw(change: Partial<CalendarSource>): Promise<void>;
	remove(): Promise<void>;
}

/**
 * Draws one calendar's block and hands back what writes its state line, so the
 * caller can write it again when something the line reads changes.
 *
 * `read` is asked each time the line is written rather than once at draw, so
 * a read state changed on this device since — a password typed for an
 * account — is what the line says. `account` is null for every row
 * that is not a calendar on an account.
 */
function drawSource(
	section: HTMLElement,
	source: CalendarSource,
	read: () => CalendarRead | undefined,
	account: AccountOfRow | null,
	actions: SourceActions,
): () => void {
	const block = section.createDiv({ cls: "effortless-calendar-source" });

	new Setting(block)
		.setName("Name")
		.setDesc("What you call this calendar. It is shown here and nowhere else.")
		.addText((text) =>
			text
				.setPlaceholder("Work")
				.setValue(source.name)
				// Typed a character at a time, so the write waits for the typing to
				// stop rather than happening once per key.
				.onChange((value) => actions.saveTyped({ name: value.trim() })),
		)
		.addButton((button) =>
			button
				.setButtonText("Remove")
				.setDestructive()
				.setTooltip("Remove this calendar")
				.onClick(() => actions.remove()),
		);

	// Where an account's calendar comes from is not typed: *Fetch calendars*
	// filled it in, and unticking it there is how it changes.
	const origin = account === null ? null : new Setting(block).setName("Where it comes from").setDesc(account.describe());
	if (account === null) {
		new Setting(block)
			.setName("Where it comes from")
			.setDesc(
				source.kind === "link"
					? "The published address of the calendar, starting with https://."
					: "The path to an .ics file inside your vault.",
			)
			.addDropdown((dropdown) => {
				dropdown.addOption("link", "A link");
				dropdown.addOption("file", "A file in the vault");
				dropdown
					.setValue(source.kind)
					// Redrawn rather than saved quietly: the address below changes
					// from masked to plain, and the description above it changes too.
					.onChange((value) => actions.redraw({ kind: asKind(value), location: "" }));
			})
			.addText((text) => {
				text
					.setPlaceholder(
						source.kind === "link" ? "https://calendar.example/basic.ics" : "Calendars/work.ics",
					)
					.setValue(source.location)
					// Not a quiet save: the line below is the one confirmation that
					// the settings store took the address, and it is composed from
					// the calendar as it was at draw time. Without this it would go
					// on saying the calendar has no address while one is being typed.
					//
					// **The store is what it confirms, not the file.** The store
					// takes the address on the keystroke and the write follows about
					// four hundred milliseconds later; the store keeps it unless that
					// write rejects with nothing else queued and nothing else
					// waiting, in which case `queueWrite`'s restore puts the store
					// back to the last landed copy and
					// the settings screen draws this row again from it, box and line
					// together.
					// Either way a failed write is announced by a Notice and never by
					// this line.
					// `restate`'s contract above says why it cannot be otherwise.
					//
					// **The box is set from the store in place, not by drawing the
					// row again.** After a rollback the settings screen draws this
					// section from the store, so the box then reads the stored value
					// there; here, on the keystroke, only the one box is set, and
					// only when the store rewrote what was typed.
					.onChange((value) => {
						const saved = actions.restate({ location: asLocation(source.kind, value) });
						// Nothing to say about a calendar that is not there. A failed
						// save has already raised its own Notice, and a removed row is
						// on its way out with the section being drawn again behind it,
						// so a second announcement here would be noise.
						if (saved === undefined) return;
						showState(saved);
						// The box shows what the store holds: a pasted `webcal://…` is
						// stored as `https://…`, and leaving the pasted text in
						// the box would have box and store disagree until the screen
						// is next drawn. It is set only when the store's text
						// is not just the typed text with its edges trimmed, so a
						// keystroke the store keeps as typed never touches the box
						// and the caret stays where it is; trimming is not this
						// box's to undo. It runs for the link kind only: a vault
						// path is stored through `normalizePath`, which drops the
						// trailing `/` of `Calendars/` mid-typing, and writing that
						// back would delete every slash as it is typed.
						if (source.kind === "link" && saved.location !== value.trim()) {
							text.setValue(saved.location);
						}
					});
				// A published link is a bearer credential, so it is masked like the
				// password it is. A vault path is not a secret and stays readable —
				// masking it would only make it hard to check.
				if (source.kind === "link") text.inputEl.type = "password";
			});
	}

	new Setting(block)
		.setName("Show in the day")
		.setDesc("Put this calendar's meetings in the day's calendar table.")
		.addToggle((toggle) =>
			toggle.setValue(source.showInDay).onChange((value) => actions.save({ showInDay: value })),
		);

	new Setting(block)
		.setName("Make notes")
		.setDesc("Give each of this calendar's meetings a note of its own.")
		.addToggle((toggle) =>
			toggle.setValue(source.makeNotes).onChange((value) => actions.save({ makeNotes: value })),
		);

	const state = block.createDiv({ cls: "effortless-calendar-state" });

	/**
	 * Writes the line under this calendar from the calendar as it stands now.
	 *
	 * Called again as the address is typed, rather than the block being drawn
	 * again around it: only the text of this one element changes, so nothing the
	 * person is typing into is replaced.
	 */
	function showState(current: CalendarSource): void {
		// What is wrong with the row's own address comes first, then what is
		// wrong with its account on this device, then how its last read went.
		const problem = account === null ? null : (sourceProblem(current) ?? account.problem());
		state.textContent = problem ?? sourceStateLine(current, read(), Date.now());
	}

	showState(source);
	return () => {
		if (account !== null) origin?.setDesc(account.describe());
		showState(source);
	};
}

/**
 * The one line under a calendar saying where it stands.
 *
 * A last-read age is here because a hand-dropped file goes stale in silence,
 * and that is a configuration problem rather than a note problem: nothing else
 * on the screen would ever say that the calendar being read is three weeks old.
 */
export function sourceStateLine(
	source: CalendarSource,
	read: CalendarRead | undefined,
	now: number,
): string {
	// What is wrong with the source itself comes first. There is no point
	// telling someone a read failed when the address was never one.
	const problem = sourceProblem(source);
	if (problem !== null) return problem;

	// A read is earned at an address, not at a calendar: the read state is kept
	// under the source's id and the id survives an edit to the address. So a
	// read whose `readFrom` names somewhere else is no read of this calendar at
	// all, and the
	// whole of it goes — the failure as well as the age. Keeping the
	// failure told someone who had just corrected a bad address that the
	// calendar was broken, and named a cause belonging to an address no longer
	// in the settings. Nothing is lost by dropping it: `readOne` works the
	// failure out again against the new address on its next read.
	//
	// The question itself is `earnedAt`'s, beside the address it is asked about,
	// so that this line and `readOne`'s cannot drift apart.
	if (!earnedAt(read, source)) return "Not read yet.";

	const age =
		read?.readAt === null || read?.readAt === undefined ? null : timeSince(now - read.readAt);
	if (read?.failure != null) {
		const opening = lossPrefix(read.loss);
		return age === null ? `${opening} ${read.failure}` : `${opening} ${read.failure} Last read ${age}.`;
	}
	return age === null ? "Not read yet." : `Last read ${age}.`;
}

/**
 * The two or three words in front of a failure's own sentence.
 *
 * Issue #53 widened what a failure means, from "this calendar would not read"
 * to "this calendar lost entries, some or all of them", and this line kept one
 * opening for both. So a calendar missing one entry of four drew as `Failed:`
 * while the day below it showed that calendar's meetings, and the person could
 * not tell from the screen whether they were looking at a good calendar missing
 * one meeting or a broken one whose meetings came from somewhere else.
 *
 * **The grade is read, never the sentence.** `loss` is the field issue #134 put
 * on the read state for exactly this, and matching on the words of `failure`
 * instead would tie the screen to wording that is written to be changed.
 *
 * A read state carrying no grade is a state written before that field existed,
 * or a calendar that would not read at all — neither is a partial loss, and
 * both keep the stronger opening. The unit is entries rather than meetings
 * because that is what the sentence after it counts.
 */
function lossPrefix(loss: LossGrade | undefined): string {
	return loss === "partial" ? "Read, with entries left out:" : "Failed:";
}

/** How long ago, in the words someone would use out loud. */
function timeSince(elapsed: number): string {
	const minutes = Math.floor(elapsed / 60000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return count(minutes, "minute");
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return count(hours, "hour");
	return count(Math.floor(hours / 24), "day");
}

function count(n: number, unit: string): string {
	return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

/** Anything that is not the file route is the link route, which is the default. */
function asKind(value: string): CalendarSourceKind {
	return value === "file" ? "file" : "link";
}
