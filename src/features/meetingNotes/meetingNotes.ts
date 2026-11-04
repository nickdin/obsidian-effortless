/**
 * Meeting notes: the feature itself, its settings and its readiness, in the
 * shape spec #701
 * decisions 1, 2, 3 and 6 ask for, wired to its
 * own run (#762, `run.ts`).
 *
 * **It references no other feature**. It never reads building the days ahead's settings, its row memory or
 * the day's calendar table; whether this device builds the days is asked of
 * the core, through `FeatureHost.device`, the same question that feature asks.
 */

import { Notice } from "obsidian";
import { Feature } from "../../core/feature";
import { provideMeetingNote } from "../../core/meetingNoteFill";
import type { FilledMeetingNote } from "../../core/meetingNoteFill";
import { reasonOf } from "../../core/reason";
import type { FeatureHost, Readiness, SettingsChanged } from "../../core/feature";
import type { SaveFailureAnnouncer } from "../../core/saveFailureAnnouncer";
import { clickFill } from "./clickFill";
import { IDENTITY_FIELD, readIdentity } from "./noteIdentity";
import { readNotesMemory } from "./notesMemory";
import type { NotesMemory } from "./notesMemory";
import { placeholderNotePaths } from "./placeholderNotes";
import { runMeetingNotes } from "./run";
import type { RunNotes, RunProblems, RunVault } from "./run";
import { MEETING_NOTES_SETTING_NAMES, folderAnswered, renderMeetingNotesSettings } from "./settingsPanel";
import {
	DEFAULT_MEETING_NOTES_SETTINGS,
	DEFAULT_TEMPLATE,
	FEATURE_ID,
	TEMPLATE_FIELD_NAMES,
	readTemplate,
	storedAsWritten,
} from "./types";
import type { MeetingNoteTemplate, MeetingNotesSettings } from "./types";

/** This feature's own card, named in a readiness sentence. */
const OWN_CARD = "Meeting notes";

/**
 * Ten seconds after the feature starts, matching building the days ahead's
 * own cadence (`src/features/daysAhead/daysAhead.ts`) and `calendar-scaffold`'s
 * original combined run.
 */
const FIRST_RUN_DELAY_MS = 10_000;

/** Every fifteen minutes after the first run. */
const RUN_EVERY_MS = 15 * 60 * 1000;

export class MeetingNotes extends Feature {
	readonly id = FEATURE_ID;

	readonly name = "Meeting notes";

	readonly description = "Creates a note for each meeting whose calendar is set to make one, linked from the day.";
	override readonly settingNames = MEETING_NOTES_SETTING_NAMES;

	/**
	 * Taken here and used from `onload` onwards, as the feature contract asks:
	 * the handle finds its feature when it is read, not when it is taken.
	 */
	private readonly own = this.host.settings<MeetingNotesSettings>(DEFAULT_MEETING_NOTES_SETTINGS);

	/** A run already in flight; a second timer tick joins nothing and does nothing (decision 4's own "one run at a time"). */
	private runInFlight = false;

	/**
	 * Bumped at the top of every `onload`. A run captures its own value when
	 * it starts and checks it again before committing the memory, so a run
	 * begun under an earlier load commits nothing once that load has ended —
	 * only the plugin's own teardown, not this feature's unload, rejects a
	 * write parked on the person's open note (`noteWriter.ts:264-274`), so
	 * such a run can still land its already-parked write once released, but
	 * it must not go on to persist memory built from before the reload.
	 */
	private generation = 0;

	/**
	 * Answers the day view's click on a meeting whose note does not exist yet. Provided as the feature is built, not as it starts: a device
	 * that does not build the days leaves this feature in `standby`, never
	 * started, and the click happens on exactly such devices. Every answer is
	 * read when asked, so a switch-off, a changed folder or a changed template
	 * is met on the next click. The slot outlives a switch-off for that reason
	 * too: it declines while the feature is off, and there is nothing to take
	 * back.
	 */
	constructor(host: FeatureHost) {
		super(host);
		provideMeetingNote((linkpath, sourcePath) => {
			if (this.host.isOn?.() !== true) return null;
			if (!folderAnswered(this.storedSlice().meetingNotesFolder)) return null;
			const index = this.identityIndex();
			const unread: string[] = [];
			// `read` holds the texts this click has just read, which are the notes' real
			// text now; the cache answers for a note not changed since an earlier click.
			const fill = (read: ReadonlyMap<string, string>): FilledMeetingNote | null =>
				clickFill(linkpath, sourcePath, {
					layout: this.host.core.layout,
					meetingsOn: (day) => this.host.calendar.meetingsOn(day, "notes"),
					folder: this.folder(),
					template: this.template(),
					selfEmail: this.selfEmail(),
					// A fresh index for each click: the notes change between clicks.
					notesNamingIdentity: (identity) => index.get(identity) ?? [],
					readNote: (path) => {
						const text = read.get(path) ?? this.readKnownText(path);
						if (text === null) unread.push(path);
						return text;
					},
				});
			const first = fill(new Map());
			// The click asks a note's text only to tell several notes naming one meeting
			// apart (`clickFill`), so a note left unread here is one it could not judge:
			// the answer waits for the read and is made again over the text read.
			if (unread.length === 0) return this.noticed(first);
			return this.learnTexts(unread).then((read) => this.noticed(fill(read)));
		});
	}

	/**
	 * Only for a click that fills a note: a click on any other link in the day's
	 * log is not meeting notes' business and gets no notice.
	 */
	private noticed(filled: FilledMeetingNote | null): FilledMeetingNote | null {
		if (filled !== null) for (const message of this.unusableSettings(this.storedSlice())) new Notice(message);
		return filled;
	}

	/** The text of each note a click had to choose among, with the modified time it was read at. */
	private readonly knownTexts = new Map<string, { readonly mtime: number; readonly text: string }>();

	/** The text last read of the note at `path`, or `null` when none was read or the note has changed since. */
	private readKnownText(path: string): string | null {
		const known = this.knownTexts.get(path);
		const file = this.host.app.vault.getFileByPath(path);
		return known !== undefined && file !== null && file.stat.mtime === known.mtime ? known.text : null;
	}

	/**
	 * Reads each of `paths` and keeps what it read for the next click. Returns the
	 * texts it read; a note it could not read is said in a notice and left out.
	 */
	private async learnTexts(paths: readonly string[]): Promise<ReadonlyMap<string, string>> {
		const { vault } = this.host.app;
		const read = new Map<string, string>();
		for (const path of paths) {
			const file = vault.getFileByPath(path);
			if (file === null) continue;
			try {
				const text = await vault.cachedRead(file);
				this.knownTexts.set(path, { mtime: file.stat.mtime, text });
				read.set(path, text);
			} catch (error) {
				new Notice(`Meeting notes could not read ${path}: ${reasonOf(error)}`);
			}
		}
		return read;
	}

	/**
	 * Which keys this feature currently has standing on the settings screen.
	 * `host.problems` (`FeatureProblems`) can be reported to and cleared, but
	 * never asked what is already standing, so a run needs this feature's own
	 * record to clear a path it no longer visits — the same shape building
	 * the days ahead's own `reportedDates` keeps, for the same reason. Kept for as long as this feature instance is
	 * loaded, across a standby and back, which is exactly as long as
	 * anything could be standing under it.
	 */
	private readonly reportedKeys = new Set<string>();

	/**
	 * Whether this load has already started the fifteen-minute interval.
	 * Reset at the top of every `onload`, so a feature that stood down and
	 * comes back gets a fresh one — and set the first time {@link runNow}
	 * starts it, so a later call from {@link folderCommitted} never doubles
	 * it. The ten-second first-run timer is *not* gated by this: it restarts
	 * on every switch to `ready` within a load instead, through
	 * {@link firstRunTimeoutId}.
	 */
	private intervalStarted = false;

	/**
	 * The pending first-run timeout, if one is waiting — cleared and replaced
	 * on every call to {@link runNow}. A folder box answered, blanked and
	 * answered again within one load must get its own fresh ten seconds
	 * rather than whatever is left of an earlier answer's own countdown.
	 */
	private firstRunTimeoutId: number | null = null;

	/**
	 * Says once per load whatever stored value the feature cannot use, then
	 * runs the feature if it is ready.
	 *
	 * **The notices are `onload`'s alone**, the pattern date entry's trigger
	 * and building the days ahead's window already keep: the readers below stay
	 * silent every other time they are asked, and the stored value is never
	 * rewritten, so a notice comes back at every start until the person changes
	 * the value on the card, which shows the value the notice named.
	 *
	 * **Onload runs whenever this feature is loaded at all, `unconfigured`
	 * included** — `standby` is the only answer of this feature's the core will
	 * not load it for (`src/core/registry.ts`'s `standsDown`). So coming out of
	 * `standby` runs this again, and that is where "a switch to `ready` runs it
	 * at once" is met for the device switch; the folder box meets it for the
	 * folder through {@link folderCommitted}.
	 */
	override onload(): void {
		this.generation++;
		this.runInFlight = false;
		this.intervalStarted = false;
		const stored = this.storedSlice();

		for (const message of this.unusableSettings(stored)) new Notice(message);

		// One notice for every dropped entry at once: one report per event,
		// never one per affected item (`FeatureHost.problems`' own rule).
		const memory = readNotesMemory(stored.notes);
		if (memory.dropped.length > 0) {
			new Notice(
				`Effortless: meeting notes dropped ${memory.dropped.length === 1 ? "an entry" : "entries"} of the wrong shape from its memory of the notes it has written: ${memory.dropped.map((key) => storedAsWritten(key)).join(", ")}.`,
			);
		}

		if (this.readiness().state === "ready") this.runNow();
	}

	/**
	 * What the feature says of each stored setting it cannot use, in the order
	 * the card shows them: the folder, the address, then the template as a
	 * whole or field by field. Said at load, and again at a click that fills a
	 * note, because the click happens on devices where meeting notes stands
	 * down, never loads, and so never says it.
	 */
	private unusableSettings(stored: Record<string, unknown>): string[] {
		const messages: string[] = [];
		if (stored.meetingNotesFolder !== undefined && typeof stored.meetingNotesFolder !== "string") {
			messages.push(
				`Effortless: meeting notes cannot use the folder ${storedAsWritten(stored.meetingNotesFolder)} stored in its settings, and does not run until a folder is entered on the ${OWN_CARD} card.`,
			);
		}
		if (stored.selfEmail !== undefined && typeof stored.selfEmail !== "string") {
			messages.push(
				`Effortless: meeting notes cannot use the email address ${storedAsWritten(stored.selfEmail)} stored in its settings, and leaves it blank until it is entered on the ${OWN_CARD} card.`,
			);
		}

		const template = readTemplate(stored.template);
		if (template.wholeRefused) {
			messages.push(
				`Effortless: meeting notes cannot use the template ${storedAsWritten(stored.template)} stored in its settings, and uses the English field names and headings until they are entered on the ${OWN_CARD} card.`,
			);
		}
		for (const { field, stored: value } of template.refused) {
			messages.push(
				`Effortless: meeting notes cannot use the ${TEMPLATE_FIELD_NAMES[field]} ${storedAsWritten(value)} stored in its settings, and uses ${storedAsWritten(DEFAULT_TEMPLATE[field])} until it is changed on the ${OWN_CARD} card.`,
			);
		}
		return messages;
	}

	/**
	 * Starts (or restarts) the ten-second first-run timer, and the
	 * fifteen-minute interval the first time this is called within a load. Called from `onload` when the feature is
	 * already `ready`, and from {@link folderCommitted} when answering the
	 * folder box just made it so — either way this is a fresh moment this
	 * load could run, so the ten-second countdown starting here, rather than
	 * at `onload` itself, is what "a switch to `ready` runs it at once"
	 * means: the same shape building the days ahead's own `onload` gives
	 * coming out of `standby`.
	 *
	 * **The first-run timer restarts on every call**, clearing any timer
	 * still pending from an earlier call first — the folder box can toggle
	 * blank and answered more than once within one load, and each answer
	 * deserves its own "at once" rather than whatever is left of an earlier
	 * answer's own countdown. **The interval starts once per load**:
	 * a device switch or a failed start tears the whole feature down and
	 * `onload` runs again before this could be asked to start a second one
	 * for the same reason, and a second interval ticking alongside the first
	 * would double every run after the first.
	 */
	private runNow(): void {
		if (this.firstRunTimeoutId !== null) window.clearTimeout(this.firstRunTimeoutId);
		this.firstRunTimeoutId = window.setTimeout(() => {
			this.firstRunTimeoutId = null;
			this.tick();
		}, FIRST_RUN_DELAY_MS);
		this.register(() => {
			if (this.firstRunTimeoutId !== null) window.clearTimeout(this.firstRunTimeoutId);
		});

		if (this.intervalStarted) return;
		this.intervalStarted = true;
		this.registerInterval(window.setInterval(() => this.tick(), RUN_EVERY_MS));
	}

	/**
	 * One timer's firing. Does nothing, and says nothing, when a run is
	 * already in flight or when this feature is not `ready` right now — the
	 * same guard building the days ahead's own `tick` keeps, for the same
	 * reason: a device switch or an unanswered folder is already said on the
	 * settings screen through `readiness()` itself.
	 */
	private tick(): void {
		if (this.runInFlight) return;
		if (this.readiness().state !== "ready") return;

		this.runInFlight = true;
		const generation = this.generation;
		void this.runOnce(generation).finally(() => {
			// A newer load's own `onload` may already have reset `runInFlight`
			// and moved `generation` on by the time this stale run's promise
			// finally settles — clearing it here would then wrongly
			// cancel the newer run's own in-flight guard.
			if (generation === this.generation) this.runInFlight = false;
		});
	}

	private async runOnce(generation: number): Promise<void> {
		await runMeetingNotes({
			calendar: this.host.calendar,
			vault: this.vaultPort(),
			notes: this.notesPort(),
			problems: this.problemsPort(),
			layout: this.host.core.layout,
			folder: this.folder(),
			template: this.template(),
			selfEmail: this.selfEmail(),
			today: new Date(),
			memory: this.notes(),
			// A run begun under an earlier load commits nothing once that load
			// has ended, even though its already-parked write may still land — the memory it would commit was built from that load's
			// own pre-reload today/meetings/memory snapshot.
			commitMemory: (memory) => (generation === this.generation ? this.saveNotesMemory(memory) : Promise.resolve()),
		});
	}

	/** `host.problems` plus {@link reportedKeys}, which is what lets `list()` answer at all. */
	private problemsPort(): RunProblems {
		return {
			report: (key, message) => {
				this.reportedKeys.add(key);
				this.host.problems.report(key, message);
			},
			clear: (key) => {
				this.reportedKeys.delete(key);
				this.host.problems.clear(key);
			},
			list: () => [...this.reportedKeys],
		};
	}

	/**
	 * `host.notes` narrowed to the calls a run ever reaches for — never
	 * `vault.create`, `fileManager` or `vault.process` directly, and never the
	 * calendar table; a gone meeting's note goes
	 * through the core's `trashIf` the same way.
	 */
	private notesPort(): RunNotes {
		return {
			create: (path, text) => this.host.notes.create(path, text),
			rename: (file, newPath) => this.host.notes.rename(file, newPath),
			edit: (file, edit) => this.host.notes.edit(file, edit),
			trashIf: (file, shouldTrash) => this.host.notes.trashIf(file, shouldTrash),
		};
	}

	/**
	 * `host.app.vault` narrowed to what a run needs to answer `NoteLookup`:
	 * `getFileByPath` is Obsidian's own synchronous existence check
	 * (`node_modules/obsidian/obsidian.d.ts:7351`, `getFileByPath(path:
	 * string): TFile | null`), so `exists` never reads; `cachedRead` is
	 * asynchronous (`obsidian.d.ts:7420`, `cachedRead(file: TFile):
	 * Promise<string>`), so `read` hands the run's own pre-read snapshot back
	 * as a promise rather than reading here — `run.ts`'s module comment says
	 * which paths it is ever asked for.
	 */
	private vaultPort(): RunVault {
		const vault = this.host.app.vault;
		let identities: Map<string, string[]> | null = null;
		return {
			exists: (path) => vault.getFileByPath(path) !== null,
			read: async (path) => {
				const file = vault.getFileByPath(path);
				return file === null ? null : vault.cachedRead(file);
			},
			fileAt: (path) => vault.getFileByPath(path),
			notesNamingIdentity: (identity) => {
				identities ??= this.identityIndex();
				return identities.get(identity) ?? [];
			},
			// `getMarkdownFiles(): TFile[]`, `node_modules/obsidian/obsidian.d.ts:7543`.
			placeholderNotes: (folder, date) =>
				placeholderNotePaths(
					vault.getMarkdownFiles().map((file) => file.path),
					folder,
					date,
				),
		};
	}

	/**
	 * Every note whose frontmatter names a meeting, by that meeting's identity
	 * (`noteIdentity.ts`): read from Obsidian's index of frontmatter, so no note
	 * is opened. Built again for each run's vault port and for each click,
	 * since the index changes between them.
	 */
	private identityIndex(): Map<string, string[]> {
		const { vault, metadataCache } = this.host.app;
		const index = new Map<string, string[]>();
		for (const file of vault.getMarkdownFiles()) {
			const identity = readIdentity(metadataCache.getFileCache(file)?.frontmatter?.[IDENTITY_FIELD]);
			if (identity === null) continue;
			index.set(identity, [...(index.get(identity) ?? []), file.path]);
		}
		return index;
	}

	/** The stored folder when it is text, blank otherwise — same reading `selfEmail()` gives its own field. Asked while `ready`, where `folderAnswered` guarantees a non-blank string, and by the click's answer after it has checked `folderAnswered` itself, which may be in `standby`. */
	private folder(): string {
		const stored = this.storedSlice().meetingNotesFolder;
		return typeof stored === "string" ? stored : "";
	}

	/** Stores `notes` at once — this is the run's own commit, never a keystroke, so it never defers (the pattern building the days ahead's own `saveRowMemory` keeps). */
	private saveNotesMemory(memory: NotesMemory): Promise<void> {
		return this.own.save({ ...this.own.read(), notes: memory });
	}

	/**
	 * `standby` beats everything else, because there is nothing for a person
	 * to configure on a device that is not doing the job — the same order and
	 * the same sentence building the days ahead gives, since `GLOSSARY.md`'s
	 * *building device* names both features as one job.
	 *
	 * Below that, `unconfigured` when the folder is blank or not text. The
	 * address is never a readiness answer: blank is
	 * allowed, and only matters once a note is created.
	 *
	 * Never `unavailable`: the calendar is read on every device. `failed` is the
	 * core's.
	 */
	readiness(): Readiness {
		if (!this.host.device.buildsTheDays()) {
			return { state: "standby", reason: "Another device builds the days and the meeting notes." };
		}

		if (!folderAnswered(this.storedSlice().meetingNotesFolder)) {
			return {
				state: "unconfigured",
				reason: `The meeting notes folder is not set. Enter it under Meeting notes folder on the ${OWN_CARD} card.`,
			};
		}

		return { state: "ready" };
	}

	override displaySettings(
		containerEl: HTMLElement,
		changed: SettingsChanged,
		announceDeferredSaveFailure?: SaveFailureAnnouncer,
	): void {
		renderMeetingNotesSettings(containerEl, this, changed, announceDeferredSaveFailure);
	}

	/** The slice exactly as `data.json` holds it, unjudged — what the card draws and saves from. */
	storedSlice(): Record<string, unknown> {
		return this.own.read() as unknown as Record<string, unknown>;
	}

	/**
	 * Stores a slice from the card once the typing has stopped.
	 *
	 * Hands back the store's own promise rather than wrapping it in an `async`
	 * function: every keystroke in one run of typing must get the *same*
	 * promise, because that is how the settings screen's announcer tells one
	 * failed write from the next and says it once
	 * (`SettingsStore.handleFor`, #186).
	 */
	saveSliceSoon(next: Record<string, unknown>): Promise<void> {
		return this.own.saveSoon(next as unknown as MeetingNotesSettings);
	}

	/**
	 * The folder box was committed. When that made the feature ready, it runs
	 * at once, since the core does not load a feature a second time for
	 * leaving `unconfigured` — it is already loaded.
	 */
	folderCommitted(): void {
		if (this.readiness().state === "ready") this.runNow();
	}

	/** The template as the feature can use it: each stored field it accepts, the English default for any it refuses. */
	template(): MeetingNoteTemplate {
		return readTemplate(this.storedSlice().template).template;
	}

	/** The stored address when it is text, blank otherwise. */
	selfEmail(): string {
		const stored = this.storedSlice().selfEmail;
		return typeof stored === "string" ? stored : "";
	}

	/** The feature's memory of the notes it has written, every entry of the wrong shape left out. */
	notes(): NotesMemory {
		return readNotesMemory(this.storedSlice().notes).notes;
	}
}
