/**
 * Review: the feature, its card and the count in the status bar.
 *
 * It shows and never decides: it writes into a note in two cases only.
 * *Mark as processed* ({@link Review.markProcessed}, ticket
 * #1056) is the person's
 * press. The diary-date field of a day's log is the one write it makes
 * unasked ({@link Review.recordDiaryDate}, ticket
 * #1109, ADR 0005). The count says how many **waiting notes** of the days
 * just past have not been gone through, today's log not counted.
 *
 * **It references no other feature**. Which notes wait is `waitingNotes.ts`'s answer, fed from Obsidian's
 * metadata cache; the layout's field names, the daily-log folder and filename
 * are the core's.
 *
 * **Nothing about which notes wait is kept from an earlier read.** Every
 * recompute asks the vault again, so a note edited, renamed or deleted since is
 * seen as it is now. The one thing kept is the *date* the count was last drawn
 * for, which is how a day passing is noticed.
 *
 * **One place recomputes: {@link Review.refresh}.** Every trigger — a note's
 * metadata, a rename, a delete, the date changing, a setting changing —
 * comes to it, so no trigger can redraw the count and forget to. It reads the
 * vault once,
 * draws the count, keeps the closed row's line ({@link Review.liveLine}, ticket
 * #1057) from that read,
 * and hands the same read to every open list ({@link redrawOpenLists}, ticket
 * #1055), whose rows and
 * chain read the texts they need on top of it. The vault's own events reach it
 * after a short quiet period ({@link Review.watchVault}); every other trigger
 * at once.
 */

import { getLinkpath, Notice, Platform } from "obsidian";
import type { TFile } from "obsidian";
import { isExcluded } from "../../core/collections";
import { Feature } from "../../core/feature";
import type { Readiness, SettingsChanged } from "../../core/feature";
import { dailyLogTemplateDiary } from "../../core/dailyLogTemplate";
import { localDateKey } from "../../core/meetingName";
import { reasonOf } from "../../core/reason";
import { dailyLogPrefix, fieldNameRefusal, isDailyLogPath, parseDailyLogDate, unreadableFilenamePattern } from "../../core/vaultLayout";
import {
	REVIEW_LIST_ICON,
	REVIEW_VIEW_TYPE,
	ReviewListView,
	adoptStandIns,
	openList,
	openFile,
	openNote,
	redrawOpenLists,
} from "./listView";
import type { ReviewChain, ReviewList, ReviewRead } from "./listView";
import { reviewWords } from "./words";
import { chain as readChain, chainDiaryMissed } from "./chain";
import { followedTasks } from "./followedTasks";
import type { FollowedGroup } from "./followedTasks";
import type { ChainMonth } from "./chain";
import { diaryDateText, diaryIsTemplates } from "./diaryDate";
import type { DiaryContext } from "./diaryDate";
import { coreBuiltDiary } from "../../core/builtDiaries";
import { builtDiaryMarkIn } from "../../core/builtDiaryMark";
import type { ReadBuiltDiaries } from "../../core/builtDiaries";
import { readReviewBuiltDiaries, settingsApartFromBuilt, storedBuiltDiaries, withBuiltDiaries, without } from "./builtDiaries";
import { readDiaryDays, storedDiaryDays, withDiaryDays } from "./diaryDays";
import type { DiaryDays, ReadDiaryDays } from "./diaryDays";
import { editorOn, markInEditor } from "./editorRoute";
import { isEmptyPropertyValue, markProcessedText } from "./markProcessed";
import { REVIEW_SETTING_NAMES, renderReviewSettings } from "./settingsPanel";
import {
	DEFAULT_REVIEW_SETTINGS,
	storedAsWritten,
	usableWindowDays,
	windowDaysRefusal,
} from "./types";
import type { ReviewSettings } from "./types";
import { isTodaysLog, waitingNotes } from "./waitingNotes";
import type { ReviewNote, WaitingNotes } from "./waitingNotes";
import { readVaultNotes } from "./vaultNotes";
import type { VaultNotes } from "./vaultNotes";

/** Stable for ever: it keys this feature's slice of `data.json`. */
export const FEATURE_ID = "review";

/** The palette command's id; Obsidian puts the plugin's own id in front of it. */
const MARK_PROCESSED_COMMAND = "mark-as-processed";

/** Where the daily-log folder, the filename and the two field names are answered, named in a readiness sentence. */
const CORE_CARD = "Your day's logs";

/**
 * How often the local date is looked at. A minute, as the day view's now-line
 * is: a
 * tick lands within a minute of midnight whatever the clock did in between —
 * a laptop asleep over midnight, a clock changed — which a single timeout set
 * for the next midnight would not survive.
 */
const DATE_CHECK_EVERY_MS = 60 * 1000;

/**
 * How long the vault has to stay quiet after an event before Review recomputes. Obsidian
 * re-indexes the note being typed in at every pause and fires `changed` and then
 * `resolved` for it, and each recompute reads the whole vault; half a second
 * folds a burst into one, short enough that the list follows a pause in typing.
 * Task consistency waits two seconds after an edit (its `CHECK_DEBOUNCE_MS`),
 * but it writes into the note; this only redraws. Exported so a test steps past it
 * by name.
 */
export const VAULT_QUIET_MS = 500;

/**
 * One read of the vault as {@link Review.refresh} uses it: what a list draws
 * from ({@link ReviewRead}), plus the one thing only the refresh asks for, the
 * count's answer from the same frontmatter.
 */
interface RefreshRead extends ReviewRead {
	/** The waiting-notes reader's answer from the frontmatter alone: the count, and which notes the rows read the text of. */
	waitingBare(): WaitingNotes;
}

export class Review extends Feature {
	readonly id = FEATURE_ID;

	readonly name = "Review";

	readonly description =
		"Counts the notes of the last few days that you have not gone through yet, in Obsidian's bottom bar (a phone has none), and lists them from the ribbon.";
	override readonly settingNames = REVIEW_SETTING_NAMES;

	/**
	 * Taken here and used from `onload` onwards, as the feature contract asks:
	 * the handle finds its feature when it is read, not when it is taken.
	 */
	private readonly own = this.host.settings<ReviewSettings>(DEFAULT_REVIEW_SETTINGS);

	/** The status-bar item, from `onload` until the feature is switched off; `null` on the phone, which has no status bar. The core removes the element itself. */
	private statusItem: HTMLElement | null = null;

	/** Whether `onload` has run and `onunload` has not: what lets a late call stop, with or without an item. */
	private loaded = false;

	/** The local day (`YYYY-MM-DD`) the count was last drawn for — what a new day is noticed against. */
	private drawnOn: string | null = null;

	/** The slice, apart from the built-section record, as it stood when the screen was last drawn: a restore that leaves it alone changes nothing to draw. */
	private drawnFrom = "";

	/**
	 * The stored `windowDays`, as written, that the last notice was raised for,
	 * or `null` while the stored value is usable. What makes the notice once per
	 * new unusable value rather than once per refresh.
	 */
	private noticedWindow: string | null = null;

	/** Whether the vault's events are subscribed to; see {@link watchVault}. */
	private watching = false;

	/** The recompute a vault event has scheduled and the quiet period still holds back, or `null`; see {@link refreshSoon}. */
	private pendingRefresh: number | null = null;

	/** The line the closed row shows, kept from the last {@link refresh} so the row and the count can never disagree. */
	private line: string | null = null;

	/**
	 * Counts the loads of this feature. A diary-date write handed to the note
	 * writer carries the number it was made under, and its edit does nothing under
	 * another: a write held across a switch-off and a switch-on is the earlier
	 * load's, and must not land under the later one.
	 */
	private generation = 0;

	/**
	 * Adds the status-bar item, subscribes to what can change the answer,
	 * and draws the count; that draw also says, once, whether the stored
	 * `windowDays` is unusable ({@link noticeUnusableWindow}).
	 *
	 * **Onload runs whenever this feature is loaded at all, `unconfigured`
	 * included**, so {@link refresh} asks `readiness()` itself and draws
	 * nothing while it is not `ready`.
	 *
	 * **An absent status-bar route is a defect, not a quiet case.**
	 * `FeatureHost.addStatusBarItem` is optional in the type so hosts built by
	 * hand before it existed still compile; the registry's host always supplies
	 * it, so a host without it is not one this feature can run on, and it says
	 * so by throwing, which the registry shows as *failed*.
	 *
	 * The subscriptions go through `register` and `registerInterval` on the
	 * feature itself (`Feature extends Component`), which is what makes
	 * switching it off drop every one; the vault's own are {@link watchVault}'s.
	 */
	override onload(): void {
		// On the phone Obsidian has no status bar (`Plugin.addStatusBarItem` is
		// "Not available on mobile", `node_modules/obsidian/obsidian.d.ts:4941`),
		// so Review asks for no item there and draws no count; everything else
		// runs as on the computer (#1054: on the phone there is no status-bar
		// count and the feature says nothing about it; its settings row still
		// shows the count, #1057).
		if (!Platform.isMobile) {
			if (this.host.addStatusBarItem === undefined) {
				throw new Error(
					"Review cannot draw its count: the addStatusBarItem route was not supplied to it.",
				);
			}
			this.statusItem = this.host.addStatusBarItem();
		}
		this.addList();
		this.addMarkProcessed();
		this.loaded = true;
		// Reading the memory is what names the entries it cannot use.
		this.storedDays();

		// The store puts a refused write back and the slice changes under us. A
		// refused save of the built-section record changes nothing the screen draws,
		// so it starts no refresh of its own (ticket #1202, against #1177's quiet
		// period): days ahead's first run builds up to eight logs, one save each.
		this.register(
			this.own.onChange(() => {
				if (settingsApartFromBuilt(this.own.read()) !== this.drawnFrom) this.refresh();
			}),
		);
		// The folder, the filename and the two field names are the core's.
		if (this.host.onCoreChange !== undefined) this.register(this.host.onCoreChange(() => this.refresh()));
		this.registerInterval(window.setInterval(() => this.checkDate(), DATE_CHECK_EVERY_MS));

		this.refresh();
	}

	/**
	 * The element is the core's to take off the bar, and Obsidian drops the
	 * subscriptions; this only lets go of the element, so a late call draws
	 * nowhere, and forgets that it was watching, so the next switch-on watches
	 * again.
	 */
	override onunload(): void {
		this.statusItem = null;
		this.loaded = false;
		this.generation += 1;
		this.drawnOn = null;
		this.drawnFrom = "";
		this.noticedWindow = null;
		this.watching = false;
		this.recording.clear();
		this.noticedDays.clear();
		this.builtLooked.clear();
		// Switched off by the person, Review stops recording the diary: a write
		// dropped for that reason is not a day to remember for later. The plugin
		// unloading, or the feature standing down, leaves the memory for the next
		// start.
		if (this.host.isOn?.() === false) void this.forgetDiaryDays();
		// A switched-off feature's row is the core's `off`, but a late reader
		// still gets no count that is already over.
		this.line = null;
	}

	/**
	 * Subscribes to everything in the vault that can change which notes wait,
	 * once, and only from the first time the feature is `ready`.
	 *
	 * **Not before**: while the daily-log folder or the filename is blank no
	 * note has a day, so a listener on every note's metadata would do the
	 * vault-wide work of looking for nothing. The core loads an `unconfigured`
	 * feature and does not load it again when it becomes `ready`, so the
	 * subscription waits for {@link refresh}, which the core's change signal
	 * ({@link FeatureHost.onCoreChange}) calls the moment the layout is
	 * answered.
	 *
	 * **A vault event does not recompute at once**: it schedules
	 * one {@link refresh} after {@link VAULT_QUIET_MS} of quiet
	 * ({@link refreshSoon}), so a burst of events while the person types costs one
	 * read of the vault rather than one per event. **The diary-date write does not
	 * wait** ({@link recordDiaryDate}): it runs on every `changed` event at once,
	 * with that event's own note and text, because a burst folded into one would
	 * hand it one note for several.
	 *
	 * **A keystroke holds a pending recompute back**: an
	 * `editor-change` restarts the quiet period when a recompute is pending and
	 * does nothing when none is, since it is the vault's events that ask for a
	 * recompute and a keystroke is only a reason to wait.
	 *
	 * Through `registerEvent` on the feature itself, which is what makes
	 * switching it off drop every one; the pending recompute is cleared through
	 * `register` the same way, so a recompute scheduled before a switch-off never
	 * runs after it, not even under the next switch-on.
	 */
	private watchVault(): void {
		if (this.watching) return;
		this.watching = true;
		this.applyRememberedDays();

		const { vault, metadataCache, workspace } = this.host.app;
		this.registerEvent(
			metadataCache.on("changed", (file, data) => {
				this.refreshSoon();
				void this.recordBuiltDiary(file.path, data);
				this.recordDiaryDate(file, data);
			}),
		);
		// A link that resolves only once the note it points at has been indexed
		// changes a meeting note's day without that note's own metadata changing.
		this.registerEvent(metadataCache.on("resolved", () => this.refreshSoon()));
		// Obsidian does not fire `changed` for a rename or a delete.
		this.registerEvent(
			vault.on("rename", (file, oldPath) => {
				this.refreshSoon();
				void this.moveBuiltDiary(oldPath, file.path);
			}),
		);
		this.registerEvent(
			vault.on("delete", (file) => {
				this.refreshSoon();
				void this.forgetBuiltDiary(file.path);
			}),
		);
		// A keystroke holds a pending recompute back. Obsidian
		// re-indexes the note some seconds after the keys stop (an inference: no
		// drive in `docs/acceptance-shots/` records the delay), so the quiet period
		// that follows its `changed` often ends while the person has begun to type
		// again, and the recompute stalls the typing. A keystroke never *starts* a
		// recompute: Obsidian has not re-indexed yet, and the read would see the old
		// note. `editor-change`, `obsidian.d.ts:8134`.
		this.registerEvent(
			workspace.on("editor-change", () => {
				if (this.pendingRefresh !== null) this.refreshSoon();
			}),
		);
		this.register(() => {
			if (this.pendingRefresh !== null) window.clearTimeout(this.pendingRefresh);
			this.pendingRefresh = null;
		});
	}

	/** (Re)starts the quiet period: one {@link refresh} when it ends, however many events restarted it. */
	private refreshSoon(): void {
		if (this.pendingRefresh !== null) window.clearTimeout(this.pendingRefresh);
		this.pendingRefresh = window.setTimeout(() => {
			this.pendingRefresh = null;
			this.refresh();
		}, VAULT_QUIET_MS);
	}

	/**
	 * Redraws when the local date is not the one the count was drawn for. The
	 * date moving is the one change nothing in the vault announces.
	 */
	private checkDate(): void {
		if (localDateKey(new Date()) !== this.drawnOn) this.refresh();
	}

	/**
	 * Recomputes from the vault and draws. The one place every trigger comes to,
	 * and the owner of the one read of the vault each recompute makes
	 * ({@link read}, ticket
	 * #1177): the count, the
	 * closed row's line and every open list's rows and chain are drawn from it,
	 * and the next call reads the vault again. Synchronous for the count and the
	 * line; the lists draw after it.
	 *
	 * The count needs no note's text, so it reads none: it asks the reader with
	 * the frontmatter alone, and the reader decides which notes wait. A
	 * list that shows each note's open tasks and bullets needs the text, and
	 * reads it for the waiting notes only.
	 */
	refresh(): void {
		if (!this.loaded) return;

		this.noticeUnusableWindow();
		this.drawnFrom = settingsApartFromBuilt(this.own.read());
		const today = new Date();
		this.drawnOn = localDateKey(today);
		// Asked once for the whole refresh: the read carries the answer to every
		// list it redraws.
		const readiness = this.readiness();
		const ready = readiness.state === "ready";
		if (ready) this.watchVault();
		// The count is read once, whenever the feature is ready, phone included:
		// the closed row's line says it on the phone too, and the status bar
		// draws the same number where there is a bar. It reads
		// frontmatter only, so the phone pays no note's text for it.
		const read = this.read(today, readiness);
		const count = ready ? read.waitingBare().count : null;
		this.setLine(count === null ? null : lineFor(count));
		if (this.statusItem !== null) drawCount(this.statusItem, count ?? 0);
		redrawOpenLists(this.host.app.workspace, read);
	}

	/**
	 * Opens the day's log for `date` in the active pane, the note writer
	 * creating it first when the day has none. The layout is
	 * read now, at the click. A creation that fails is said in a `Notice`, worded
	 * like *Create today's log*'s in `main.ts`, and nothing opens; so is an open
	 * that fails.
	 */
	private async openDay(date: Date): Promise<void> {
		let file: TFile;
		try {
			file = await this.host.notes.createDailyLog(date, this.host.core.layout);
		} catch (error: unknown) {
			new Notice(`Effortless: the log for ${localDateKey(date)} was not created. ${reasonOf(error)}`);
			return;
		}
		try {
			await openFile(this.host.app, file);
		} catch (error: unknown) {
			// The click is `void`ed by the day cell, so a rejection here would be unhandled and unsaid.
			new Notice(`Effortless: the log for ${localDateKey(date)} was not opened. ${reasonOf(error)}`);
		}
	}

	/**
	 * Adds the ribbon icon and the list's view type, on the computer and the
	 * phone alike, and gives a tab of the type that was opened while the feature
	 * was off its view back ({@link adoptStandIns}). Like the status-bar item,
	 * an absent route is a defect and says so by throwing.
	 */
	private addList(): void {
		const { host } = this;
		if (host.addRibbonIcon === undefined || host.registerView === undefined) {
			throw new Error("Review cannot draw its list: the addRibbonIcon or registerView route was not supplied to it.");
		}
		const { app } = host;
		const source = {
			readiness: () => this.readiness(),
			read: () => this.read(),
			open: (path: string, line?: number) => openNote(app, path, line),
			openDay: (date: Date) => this.openDay(date),
			markProcessed: (path: string) => this.markProcessed(path),
		};
		host.registerView(REVIEW_VIEW_TYPE, (leaf) => new ReviewListView(leaf, source));
		host.addRibbonIcon(REVIEW_LIST_ICON, reviewWords().title, () => {
			openList(app.workspace).catch((error: unknown) => {
				new Notice(`Effortless could not open the Review list: ${reasonOf(error)}`);
			});
		});
		adoptStandIns(app.workspace).catch((error: unknown) => {
			new Notice(`Effortless could not restore an open Review list: ${reasonOf(error)}`);
		});
	}

	/**
	 * Registers *Mark as processed* for the note that is open. `checkCallback`
	 * asks the vault again each time the palette does, so the command is offered
	 * on a waiting note and on no other: not on a processed one, a note without
	 * the field, a note outside the window, or when no note is open. No hotkey
	 * ships.
	 */
	private addMarkProcessed(): void {
		this.host.addCommand({
			id: MARK_PROCESSED_COMMAND,
			name: reviewWords().markProcessed,
			checkCallback: (checking: boolean): boolean => {
				const path = this.openWaitingNote();
				if (path === null) return false;
				if (!checking) void this.markProcessed(path);
				return true;
			},
		});
	}

	/**
	 * The path of the open note when it is waiting now, otherwise `null`. Asks
	 * the reader about that one note with its frontmatter as the cache holds it
	 * this moment, so the answer is the same one the count and the list give.
	 */
	private openWaitingNote(): string | null {
		if (!this.loaded || this.readiness().state !== "ready") return null;
		const { workspace, metadataCache } = this.host.app;
		const file = workspace.getActiveFile();
		if (file === null) return null;
		const note: ReviewNote = {
			path: file.path,
			frontmatter: metadataCache.getCache(file.path)?.frontmatter ?? null,
			text: "",
		};
		return this.waitingFrom([note], new Date()).list.length === 1 ? file.path : null;
	}

	/**
	 * Writes today's date into the processed field of the note at `path`. The one
	 * route the list's button and the command both take. A note an editor shows
	 * for editing is written through that editor at once, in one undo step
	 * ({@link markInEditor}, ticket #1079);
	 * any other goes through the core's `NoteWriter.edit` as a write the person
	 * asked for. It is written at once when the note is not the one on screen,
	 * when every tab showing it is in reading view, and when no
	 * tab shows it at all (Review's list is not a note, so the last note stays
	 * Obsidian's active file after its tab closes;
	 * #1089, `shownForEditing`
	 * in `src/core/noteWriter.ts`). It is held until the person leaves the note
	 * only when it is the one on screen and a markdown tab shows it in source
	 * mode or a view of another type that keeps its own copy shows it, or the app
	 * cannot say which mode a tab is in.
	 *
	 * **Nothing is redrawn here on success**: the write makes Obsidian report the
	 * note's metadata changed, and that calls {@link refresh}. A refusal, though,
	 * changes nothing in the vault, so no such report comes; it says so with a
	 * notice and calls {@link refresh}, which reads the metadata cache again, so
	 * the screen shows what the cache holds and not what the press assumed. The
	 * date is read now, at the press.
	 */
	async markProcessed(path: string): Promise<void> {
		// A press on a note whose press is still running does nothing more: the
		// metadata cache says the note waits until the write lands, so the button
		// and the command are both still offered.
		if (this.marking.has(path)) return;
		this.marking.add(path);
		try {
			await this.writeProcessed(path);
		} finally {
			this.marking.delete(path);
		}
	}

	/** The paths whose {@link markProcessed} is running now. */
	private readonly marking = new Set<string>();

	private async writeProcessed(path: string): Promise<void> {
		const file = this.host.app.vault.getFileByPath(path);
		if (file === null) {
			new Notice(`Effortless could not mark "${path}" as processed: the note is gone.`);
			this.refresh();
			return;
		}
		const { processedField } = this.host.core.layout;
		const date = localDateKey(new Date());
		try {
			const editor = editorOn(this.host.app, path);
			if (editor !== null) {
				markInEditor(editor, processedField, date);
				this.ownWrites.set(path, lineFeedsOnly(editor.getValue()));
			} else {
				await this.host.notes.edit(
					file,
					(text) => {
						const marked = markProcessedText(text, processedField, date);
						this.ownWrites.set(path, lineFeedsOnly(marked));
						return marked;
					},
					{ askedFor: true },
				);
			}
		} catch (error) {
			// The core's own refusals begin "Effortless: "; the notice already says it once.
			new Notice(`Effortless could not mark "${path}" as processed: ${reasonOf(error).replace(/^Effortless: /, "")}`);
			this.refresh();
		}
	}

	/**
	 * For each note *Mark as processed* has just written, the text that write left
	 * it with, line endings as line feeds.
	 * The change Obsidian reports for the press carries exactly that text, which
	 * is how {@link recordDiaryDate} tells it from a change to the diary: *Mark as
	 * processed* ignores the diary section, so the press must not date the diary.
	 * An entry is dropped the first time a change reports other text.
	 */
	private readonly ownWrites = new Map<string, string>();

	/** The paths whose {@link recordDiaryDate} write is waiting or running now. */
	private readonly recording = new Set<string>();
	/** The names of the unusable kept days already said in a notice during this load, so each is said once. */
	private readonly noticedDays = new Set<string>();
	/** The logs whose first change this load has already looked at for the section they were built with ({@link recordBuiltDiary}). */
	private readonly builtLooked = new Set<string>();

	/**
	 * The one write Review makes unasked (ticket
	 * #1109, ADR 0005): when a
	 * day's log has text under the diary heading and its diary-date field is absent
	 * or empty, a date goes into that field and nothing else changes. A field
	 * that holds any value is never touched, so the metadata change this write
	 * itself causes finds it filled and writes nothing: there is no loop.
	 *
	 * **Decided from `data`, the note's text as the change reports it**
	 * (`node_modules/obsidian/obsidian.d.ts:4453`: `changed` passes `(file, data,
	 * cache)`). That `data` is the file's text was driven in Obsidian 1.14.4 on
	 * 2026-10-13, on the desktop: the two reports for a log whose text then grew by
	 * the eleven characters of the value written carried strings of 81 and 92
	 * characters (the record is `docs/acceptance-shots/issue-1109-drive.txt`, which
	 * the wave commits). The phone is inferred, not driven. The log's own text is
	 * never read from the vault, but since #1136 a text that holds diary words is
	 * compared with the day's-log template, so the template note is read, and the
	 * log's text is passed over twice, when one is answered; a vault without a
	 * template still costs one pass. The write itself runs
	 * {@link diaryDateText} again on the note's text as it is when the write lands,
	 * so a field filled by hand in between is left alone.
	 *
	 * **The date is bound here, when the change is reported**, not when the write
	 * lands: the note writer holds an unasked write while its note is on screen, so
	 * a log left open past midnight lands after it, and still records the day the
	 * text was seen. **And it is kept** ({@link rememberDay}) from that moment until
	 * the write has landed, because a write still held when the plugin unloads or
	 * the app is killed is lost, and the next change would otherwise stamp a later
	 * day: a change that finds a day kept for its log uses that day, not today.
	 *
	 * **Through the host's note writer, with no `askedFor`, never the editor
	 * route**: the change is the plugin's, not the person's. The writer holds it
	 * while the log is on screen and lets it go when the person leaves the note; an
	 * undo in the editor therefore cannot pull it out, and the plugin offers none.
	 *
	 * **One write per note at a time.** While a write for `path` is waiting or
	 * running, later changes to it add none: the waiting one already carries the
	 * date the text was first seen. A refused write is reported once, naming the
	 * note, through the standing-problem channel; the next change to that note tries
	 * again, and a write that lands, or a log that no longer needs one, clears it.
	 */
	private recordDiaryDate(file: TFile, data: string): void {
		if (!this.loaded || this.readiness().state !== "ready") return;
		const { layout } = this.host.core;
		if (!isDailyLogPath(file.path, layout)) return;
		const { path } = file;
		// The change *Mark as processed* itself caused says nothing about the diary.
		const own = this.ownWrites.get(path);
		if (own !== undefined) {
			if (lineFeedsOnly(data) === own) return;
			this.ownWrites.delete(path);
		}
		const kept = this.keptDay(path);
		const day = kept ?? localDateKey(new Date());
		void this.decideDiaryDate(file, data, day, kept);
	}

	/**
	 * Decides, for a change to the day's log `file` reporting `data`, whether the
	 * diary-date write is due, and hands it on when it is. The log's own day
	 * is known from its path and settles a log ahead of `day` at once; the
	 * day's-log template is read only when the text has passed that, and only when a
	 * template is answered, so a vault without one decides in the same turn as
	 * before. Never rejects.
	 */
	private async decideDiaryDate(file: TFile, data: string, day: string, kept: string | null): Promise<void> {
		const { path } = file;
		const { text, level } = this.host.core.layout.diaryHeading;
		const field = this.host.core.layout.diaryDateField;
		const generation = this.generation;
		let context: DiaryContext = this.ownDay(path);
		if (diaryDateText(data, text, level, field, day, context) !== null && this.templateApplies(path, data)) {
			const read = await this.withTemplateDiary(file, context);
			// A load that ended while the template was being read decides nothing.
			if (!this.ranReady(generation)) return;
			if (read === null) {
				// Nothing is stamped while the template is unreadable, but the day the
				// text was seen is kept, so the stamp made once it reads again is that day's.
				await this.keepDayUnread(path, day, kept);
				return;
			}
			context = read;
		}
		if (diaryDateText(data, text, level, field, day, context) === null) {
			// A field the cache shows filled settles the day that was kept for it, and so
			// does a section that turns out to be only the template's own words.
			if (kept !== null && (this.fieldFilled(path, field) || this.holdsOnlyTemplate(data, context))) void this.forgetDiaryDays([path]);
			this.host.problems.clear(path);
			return;
		}
		void this.writeDiaryDate(file, day, kept === null, context);
	}

	/** What the path alone says of the log: its own day. */
	private ownDay(path: string): DiaryContext {
		const own = parseDailyLogDate(path, this.host.core.layout);
		return { logDay: own === null ? null : localDateKey(own) };
	}

	/**
	 * Keeps `day` for the log at `path` while the day's-log template cannot be read, the way a
	 * write that is lost keeps it, unless a day is already kept. A day that
	 * cannot be stored is reported and nothing else is done. Never rejects.
	 */
	private async keepDayUnread(path: string, day: string, kept: string | null): Promise<void> {
		if (kept !== null) return;
		try {
			await this.rememberDay(path, day);
		} catch (error) {
			this.host.problems.report(path, `Effortless could not keep the day for the diary in "${path}", so it may be dated the day the day's-log template reads again: ${reasonOf(error).replace(/^Effortless: /, "")}`);
		}
	}

	/** Whether `data`'s diary section is exactly the one it was built with: by the mark it carries, or the template's, which `context` carries once the template was read. */
	private holdsOnlyTemplate(data: string, context: DiaryContext): boolean {
		const { text, level } = this.host.core.layout.diaryHeading;
		return diaryIsTemplates(data, text, level, context.templateDiary ?? null);
	}

	private templateIsAnswered(): boolean {
		return this.host.core.layout.dailyLogTemplate.trim() !== "";
	}

	/**
	 * Whether the log at `path`, holding `text`, is compared with a built section read
	 * from outside it: the template is answered, or the section it was built with is
	 * kept. Never for a log carrying the mark of that section in its own frontmatter:
	 * the diary decision reads the mark from the text, whatever the template says now
	 * and whether or not it reads. The log's day is read off its path
	 * (`dayOf`) only when the core keeps any section at all: the waiting list asks
	 * this for every note, and a count holds what that costs
	 * (`reviewWaitingTodaysLog.test.ts`, #1189).
	 */
	private templateApplies(path: string, text: string, dayOf = this.dayReader(path)): boolean {
		if (builtDiaryMarkIn(text) !== null) return false;
		if (this.templateIsAnswered() || this.storedBuilt().sections[path] !== undefined) return true;
		const { builtDiaries } = this.host.core;
		return keepsAny(builtDiaries) && coreBuiltDiary(dayOf(), builtDiaries) !== undefined;
	}

	/**
	 * The day of the log at `path`, read off the path the first time it is asked
	 * for and never again: one read shared by {@link templateApplies} and
	 * {@link templateDiaryOf} for the same note, which is what the count in
	 * `reviewWaitingTodaysLog.test.ts` holds.
	 */
	private dayReader(path: string): () => Date | null {
		let read: { day: Date | null } | undefined;
		return () => (read ??= { day: parseDailyLogDate(path, this.host.core.layout) }).day;
	}

	/**
	 * `context` with the text the day's-log template puts under the diary heading,
	 * read now and built by the core for the log's own day. `null`, with the reason
	 * said through the standing-problem channel for the log, when the template
	 * cannot be read or built: Review then writes nothing, because a date wrongly
	 * written is never overwritten, and the caller keeps the day the text was seen
	 * ({@link keepDayUnread}) so the date written once the template reads again is
	 * that day's, not the day of the change that finds it readable.
	 */
	private async withTemplateDiary(file: TFile, context: DiaryContext): Promise<DiaryContext | null> {
		try {
			const templateDiary = await this.templateDiaryOf(file.path);
			return templateDiary === null ? context : { ...context, templateDiary };
		} catch (error) {
			this.host.problems.report(file.path, `Effortless could not tell the day's-log template's words from yours in "${file.path}", so the diary's date is not recorded yet: ${reasonOf(error).replace(/^Effortless: /, "")}`);
			return null;
		}
	}

	/**
	 * The diary section the log at `path` was built with, when it was kept
	 * ({@link keptBuiltDiary}): whatever the template says now, an untouched log
	 * still holds that. Otherwise the section the day's-log template makes for it,
	 * read from the template note now; `null` when `path` has no day of its own.
	 * Throws when there is no kept section and the template cannot be read or
	 * built.
	 */
	private async templateDiaryOf(path: string, dayOf = this.dayReader(path)): Promise<string | null> {
		const built = this.keptBuiltDiary(path, dayOf());
		if (built !== undefined) return built;
		return this.currentTemplateDiaryOf(dayOf());
	}

	/**
	 * The diary section the log at `path` was built with, as the core kept it when
	 * it built the log (`core.builtDiaries`, ticket
	 * #1201), or else as
	 * Review kept it the first time it saw the log change ({@link recordBuiltDiary},
	 * ticket #1171), which is
	 * there only for a log built before the core kept one. The core's comes first:
	 * it was taken from the text written, whatever Review's state then. `undefined`
	 * when neither was kept. `own` is the log's day, read off `path`.
	 */
	private keptBuiltDiary(path: string, own: Date | null): string | undefined {
		return coreBuiltDiary(own, this.host.core.builtDiaries) ?? this.storedBuilt().sections[path];
	}

	/** The diary section the template makes for the log of the day `own` (`null`: a path with no day), read from the template note now, never kept. */
	private async currentTemplateDiaryOf(own: Date | null): Promise<string | null> {
		const { layout } = this.host.core;
		const templatePath = layout.dailyLogTemplate.trim();
		const template = this.host.app.vault.getFileByPath(templatePath);
		if (template === null) throw new Error(`the day's-log template "${templatePath}" does not exist`);
		if (own === null) return null;
		return dailyLogTemplateDiary(await this.host.notes.read(template), own, layout);
	}

	/**
	 * Hands the diary-date write for `file`, carrying `day`, to the note writer.
	 * `keep` says the day was not kept yet: it is stored first, so a write that is
	 * lost still leaves the day behind. The write is **held silently** while the log
	 * is on screen ({@link EditOptions.quietHold}, ticket
	 * #1139): the person did not
	 * ask for it and can do nothing about it, so the writer's "a background write is
	 * waiting" notice would only nag, every day. A write that is refused is still
	 * said, once, through the standing-problem channel.
	 *
	 * A day that cannot be stored is reported and the write goes on without it;
	 * the log is then dated the way it was before the day was kept. Never rejects.
	 */
	private async writeDiaryDate(file: TFile, day: string, keep: boolean, context: DiaryContext): Promise<void> {
		const { path } = file;
		if (this.recording.has(path)) return;
		this.recording.add(path);
		const generation = this.generation;
		try {
			if (keep) await this.rememberDay(path, day);
		} catch (error) {
			this.host.problems.report(path, `Effortless could not keep the day for the diary in "${path}", so a write that is lost will not be made on the next start: ${reasonOf(error).replace(/^Effortless: /, "")}`);
		}
		try {
			let settled = false;
			await this.host.notes.edit(file, (current) => {
				const next = this.diaryDateEdit(current, day, generation, context);
				// Landed, or found the field filled, settles the day. An edit that
				// handed the text back because Review was not ready, or this load had
				// ended, did nothing, and the day stays for the next chance.
				settled = next !== current || (this.ranReady(generation) && this.fieldFilled(path, this.host.core.layout.diaryDateField));
				return next;
			}, { quietHold: true });
			// A load that has ended since keeps the day, for the next one.
			if (settled && this.loaded && generation === this.generation) await this.forgetDiaryDays([path]);
			this.host.problems.clear(path);
		} catch (error) {
			this.host.problems.report(path, `Effortless could not record the diary's date in "${path}": ${reasonOf(error).replace(/^Effortless: /, "")}`);
		} finally {
			// A later load's write for this note has its own marker: this one's end
			// must not clear it (the load that ended already cleared its own).
			if (generation === this.generation) this.recording.delete(path);
		}
	}

	/**
	 * The edit the note writer runs on the note's text when the held write is let
	 * go: the
	 * text as it is, unchanged, unless this load of the feature is still the one
	 * that made the write and Review is still ready. The heading, its level and the
	 * field's name are read from the layout now, not from when the change was
	 * reported, so a field renamed while the write was held gets the new name or
	 * nothing. Only `day` was bound earlier, on purpose.
	 */
	/** Whether the load that made a write is still the running one and Review is ready. */
	private ranReady(generation: number): boolean {
		return this.loaded && generation === this.generation && this.readiness().state === "ready";
	}

	private diaryDateEdit(current: string, day: string, generation: number, context: DiaryContext): string {
		if (!this.loaded || generation !== this.generation || this.readiness().state !== "ready") return current;
		const { diaryHeading, diaryDateField } = this.host.core.layout;
		if (diaryDateField.trim() === "") return current;
		return diaryDateText(current, diaryHeading.text, diaryHeading.level, diaryDateField, day, context) ?? current;
	}

	/**
	 * Makes, now, the diary-date write for every log whose day was kept by an
	 * earlier session and never landed: the next start writes the day the text was
	 * seen, with no change to the log needed to prompt it. Held, silently, for a
	 * log that is on screen like any other unasked write. A kept day whose log is
	 * not in the vault is forgotten only once it is older than the days Review looks at.
	 */
	private applyRememberedDays(): void {
		const generation = this.generation;
		// Obsidian loads the plugin while it is still listing the vault's files, so
		// at start a log can be missing from the list that is on disk: asking now
		// would forget a day whose log is simply not listed yet. The layout is ready
		// once the list is complete, and at once when it already is (drive of
		// 2026-10-13, `docs/acceptance-shots/issue-1137-drive.txt`).
		this.host.app.workspace.onLayoutReady(() => {
			if (!this.loaded || generation !== this.generation) return;
			const { days } = this.storedDays();
			const gone: string[] = [];
			for (const [path, day] of Object.entries(days)) {
				const file = this.host.app.vault.getFileByPath(path);
				if (file === null) {
					// Its log may simply not have synced here yet, and a forgotten day
					// syncs back as a deletion on the device that kept it: it stays
					// until the log is seen and written, or the day falls outside the
					// days Review looks at.
					if (day < this.windowStart()) gone.push(path);
				} else void this.applyRememberedDay(file, day);
			}
			if (gone.length > 0) void this.forgetDiaryDays(gone);
			void this.pruneBuiltDiaries();
		});
	}

	/** The oldest day Review looks at, as `YYYY-MM-DD`: `windowDays` before today. */
	private windowStart(): string {
		const now = new Date();
		return localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - this.windowDays()));
	}

	private async applyRememberedDay(file: TFile, day: string): Promise<void> {
		const { layout } = this.host.core;
		// Nothing will ever be written to a path that is no longer a day's log.
		if (!isDailyLogPath(file.path, layout)) {
			void this.forgetDiaryDays([file.path]);
			return;
		}
		let text: string;
		try {
			text = await this.host.notes.read(file);
		} catch (error) {
			this.host.problems.report(file.path, `Effortless could not read "${file.path}" to record the diary's date: ${reasonOf(error).replace(/^Effortless: /, "")}`);
			return;
		}
		const { diaryHeading, diaryDateField } = this.host.core.layout;
		if (!this.loaded) return;
		let context: DiaryContext | null = this.ownDay(file.path);
		if (diaryDateText(text, diaryHeading.text, diaryHeading.level, diaryDateField, day, context) !== null && this.templateApplies(file.path, text)) {
			context = await this.withTemplateDiary(file, context);
			if (context === null || !this.loaded) return;
		}
		if (diaryDateText(text, diaryHeading.text, diaryHeading.level, diaryDateField, day, context) === null) {
			// A field already filled (synced from another device, typed by hand), or a section that is only
			// the template's own words, leaves nothing to write.
			if (this.fieldFilled(file.path, diaryDateField) || this.holdsOnlyTemplate(text, context)) void this.forgetDiaryDays([file.path]);
			return;
		}
		await this.writeDiaryDate(file, day, false, context);
	}

	/**
	 * Keeps the diary section of the day's log at `path` the first time Review sees
	 * it change, when `data` holds exactly the section the template makes now.
	 * Obsidian reports a note it has just indexed through `changed` ("Called when a
	 * file has been indexed", `node_modules/obsidian/obsidian.d.ts:4447`), and days
	 * ahead builds a log days before its day, so this is long before the template
	 * can have been reworded. A log first seen with other words under the diary
	 * heading is not recorded: either the person wrote them, or the template was
	 * reworded before Review saw the log, and then there is nothing to tell which.
	 * It is looked at once for each log and each load, so a log that is typed in
	 * does not read the template on every change. A log the core kept the section
	 * of when it built it needs no entry here, and neither
	 * does one that carries the mark of it in its own frontmatter: this is for a
	 * log built before the core kept one. Never rejects.
	 */
	private async recordBuiltDiary(path: string, data: string): Promise<void> {
		if (!this.loaded || this.readiness().state !== "ready" || !this.templateIsAnswered()) return;
		const { layout } = this.host.core;
		if (!isDailyLogPath(path, layout) || this.builtLooked.has(path) || builtDiaryMarkIn(data) !== null) return;
		const own = parseDailyLogDate(path, layout);
		if (this.keptBuiltDiary(path, own) !== undefined) return;
		this.builtLooked.add(path);
		const generation = this.generation;
		let templateDiary: string | null;
		try {
			templateDiary = await this.currentTemplateDiaryOf(own);
		} catch {
			// Looked at again on the next change. An unreadable template is said by the
			// stamp, the first time a diary is written in a log, not by every change.
			this.builtLooked.delete(path);
			return;
		}
		if (!this.ranReady(generation) || templateDiary === null) return;
		const { text: heading, level } = layout.diaryHeading;
		if (!diaryIsTemplates(data, heading, level, templateDiary)) return;
		try {
			await this.saveBuilt((sections) => ({ ...sections, [path]: templateDiary }));
		} catch (error) {
			// Without a record the log is compared with the template as it reads, as before.
			this.builtLooked.delete(path);
			this.host.problems.report(path, `Effortless could not keep the diary section "${path}" was built with: ${reasonOf(error).replace(/^Effortless: /, "")}`);
		}
	}

	/** The sections logs were built with, judged now; entries Review cannot use are said once. */
	private storedBuilt(): ReadBuiltDiaries {
		const read = readReviewBuiltDiaries(storedBuiltDiaries(this.own.read()));
		this.noticeDroppedBuilt(read.dropped);
		return read;
	}

	/** Stores the record `change` makes of the one stored now, doing nothing when it changes nothing. */
	private async saveBuilt(change: (sections: Readonly<Record<string, string>>) => Readonly<Record<string, string>>): Promise<void> {
		const { sections } = this.storedBuilt();
		const next = change(sections);
		const same = Object.keys(next).length === Object.keys(sections).length && Object.entries(next).every(([path, section]) => sections[path] === section);
		if (same) return;
		await this.own.save(withBuiltDiaries(this.own.read(), next));
	}

	/** The section kept for a log that was deleted goes with it; a record that cannot be saved is said, naming the log. */
	private async forgetBuiltDiary(path: string): Promise<void> {
		try {
			await this.saveBuilt((sections) => without(sections, [path]));
		} catch (error) {
			this.host.problems.report(path, `Effortless could not forget the diary section "${path}" was built with after the note was deleted: ${reasonOf(error).replace(/^Effortless: /, "")}`);
		}
	}

	/**
	 * The section kept for a log that was renamed follows it, so the new name is still known to be untouched.
	 * A rename that makes the note no day's log ends the entry instead: nothing is stamped there.
	 */
	private async moveBuiltDiary(oldPath: string, newPath: string): Promise<void> {
		try {
			await this.saveBuilt((sections) => {
				const section = sections[oldPath];
				if (section === undefined) return sections;
				if (!isDailyLogPath(newPath, this.host.core.layout)) return without(sections, [oldPath]);
				return { ...without(sections, [oldPath]), [newPath]: section };
			});
		} catch (error) {
			this.host.problems.report(newPath, `Effortless could not follow the rename of "${oldPath}" with the diary section it was built with: ${reasonOf(error).replace(/^Effortless: /, "")}`);
		}
	}

	/**
	 * Drops the sections of paths that are no day's log, so the record does not keep
	 * a note the stamp will never act on. **Not by age, and
	 * not by the log being unlisted**: the stamp has no window, so an old log still
	 * needs its section, and a log that has not synced here yet is not gone, while a
	 * section forgotten here syncs back as a deletion on the device that kept it
	 * (the reason {@link applyRememberedDays} gives for the days). A log that is
	 * deleted loses its entry in the `delete` handler. Does nothing while Review is
	 * not ready: with the folder or filename blank no path is a day's log.
	 */
	private async pruneBuiltDiaries(): Promise<void> {
		if (this.readiness().state !== "ready") return;
		const { layout } = this.host.core;
		try {
			await this.saveBuilt((sections) => without(sections, Object.keys(sections).filter((path) => !isDailyLogPath(path, layout))));
		} catch (error) {
			new Notice(`Effortless could not tidy the diary sections it keeps: ${reasonOf(error).replace(/^Effortless: /, "")}`);
		}
	}

	/** Says, once for each entry, that Review cannot use an entry of the diary sections it keeps: refused with a notice, never silently replaced. */
	private noticeDroppedBuilt(dropped: readonly string[]): void {
		const fresh = dropped.filter((name) => !this.noticedDays.has(`built:${name}`));
		if (fresh.length === 0) return;
		for (const name of fresh) this.noticedDays.add(`built:${name}`);
		new Notice(`Effortless: Review dropped ${fresh.length === 1 ? "an entry" : "entries"} it cannot use from the diary sections it keeps for each day's log: ${fresh.map((name) => storedAsWritten(name)).join(", ")}.`);
	}

	/** The days kept in `data.json`, judged now. */
	private storedDays(): ReadDiaryDays {
		const today = localDateKey(new Date());
		const { layout } = this.host.core;
		const read = readDiaryDays(storedDiaryDays(this.own.read()), (path) => {
			const own = parseDailyLogDate(path, layout);
			return own === null ? today : localDateKey(own);
		});
		this.noticeDroppedDays(read.dropped);
		return read;
	}

	/** The day kept for the log at `path`, or `null` when none is. */
	private keptDay(path: string): string | null {
		return this.storedDays().days[path] ?? null;
	}

	/** Stores `day` for the log at `path`, now rather than after a delay: the app may be killed a moment later. */
	private rememberDay(path: string, day: string): Promise<void> {
		const days: DiaryDays = { ...this.storedDays().days, [path]: day };
		return this.own.save(withDiaryDays(this.own.read(), days));
	}

	/**
	 * Forgets the day kept for each of `paths`, or for every log when none are
	 * named. A failure to store is said with a notice: an entry left behind only
	 * means a write the next start makes again, and finds nothing to do.
	 */
	private async forgetDiaryDays(paths?: readonly string[]): Promise<void> {
		const { days } = this.storedDays();
		const rest: Record<string, string> = paths === undefined ? {} : { ...days };
		for (const path of paths ?? []) delete rest[path];
		if (Object.keys(rest).length === Object.keys(days).length) return;
		try {
			await this.own.save(withDiaryDays(this.own.read(), rest));
		} catch (error) {
			new Notice(`Effortless could not forget the days it kept for the diary: ${reasonOf(error).replace(/^Effortless: /, "")}`);
		}
	}

	/** Whether the cache shows a value in the note's `field`, as the person left it. */
	private fieldFilled(path: string, field: string): boolean {
		const value: unknown = this.host.app.metadataCache.getCache(path)?.frontmatter?.[field];
		return !isEmptyPropertyValue(value);
	}

	/**
	 * Says, once for each entry of the memory of the days diaries were first seen
	 * and each load, that Review cannot use it: a value refused with a notice, never
	 * silently replaced. Runs from every read of the memory, so it covers an entry
	 * that broke after load (a hand edit, Obsidian Sync) before the next save leaves
	 * it out of what is stored.
	 */
	private noticeDroppedDays(dropped: readonly string[]): void {
		const fresh = dropped.filter((name) => !this.noticedDays.has(name));
		if (fresh.length === 0) return;
		for (const name of fresh) this.noticedDays.add(name);
		const names = fresh.map((name) => storedAsWritten(name)).join(", ");
		new Notice(`Effortless: Review dropped ${fresh.length === 1 ? "an entry" : "entries"} it cannot use from its memory of the days diaries were first seen: ${names}.`);
	}

	/** What the closed row says now: how many notes wait, or `null` while the feature is not ready. */
	override liveLine(): string | null {
		return this.line;
	}

	/** Keeps `line` and tells the open settings screen, once per change and never for a recompute that read the same. */
	private setLine(line: string | null): void {
		if (line === this.line) return;
		this.line = line;
		this.liveLineChanged();
	}

	/**
	 * Says, once for each new value, that the stored `windowDays` is one Review
	 * cannot use. Runs from every {@link refresh}, so it covers the value at
	 * start and one that reaches the settings file afterwards (Obsidian Sync, a
	 * hand edit while Obsidian runs): a value the code cannot use is refused
	 * with a notice, never silently replaced by the default.
	 */
	private noticeUnusableWindow(): void {
		const stored = this.storedWindowDays();
		const refusal = windowDaysRefusal(stored);
		if (refusal === null) {
			this.noticedWindow = null;
			return;
		}
		const written = storedAsWritten(stored);
		if (written === this.noticedWindow) return;
		this.noticedWindow = written;
		new Notice(`Effortless: ${refusal}`);
	}

	/**
	 * Every waiting note, today's included, with what the list shows of each,
	 * from a read of the vault of its own: the answer for a caller outside a
	 * refresh, which today is the tests. The list draws from the read its
	 * refresh made instead ({@link waitingIn}): the frontmatter of every note
	 * decides which wait, and the text of those that do, read with `cachedRead`,
	 * gives their task and bullet counts.
	 *
	 * **Each note is read on its own.** A note deleted between the listing and
	 * the read rejects its `cachedRead`; that note is left out and its path
	 * named in `unreadable`, so the list says so, and the other rows still draw.
	 *
	 * **Today's log is read whatever its processed field says**, because its
	 * *diary empty* words outlive its row. Such a log that cannot be
	 * read is left out silently: it is not waiting, so `unreadable` would name
	 * a waiting note that is not one, and a log deleted between the listing and
	 * the read has no diary left to remind about.
	 *
	 * **The reader is handed the waiting notes and today's log, and no other**
	 * ({@link waitingIn}, ticket #1178).
	 */
	async waiting(): Promise<ReviewList> {
		return this.read().waiting();
	}

	/**
	 * {@link waiting} from `read`, which the frontmatter-only answer `waitingBare`
	 * was drawn from: which notes wait decides which texts are read. **The reader
	 * is handed those notes and today's log, and no other**: whether a note
	 * waits, and on which day, is read from its frontmatter and its path alone
	 * (`hasEmptyField`, `isExcluded` and `dayOf` in `waitingNotes.ts`), which the
	 * frontmatter pass has already answered, so a second pass over every note
	 * could add only the text of the notes that wait.
	 */
	private async waitingIn(read: VaultNotes, waitingBare: WaitingNotes): Promise<ReviewList> {
		const { today, files: byPath, notes: bare } = read;
		const waitingPaths = new Set(waitingBare.list.map((note) => note.path));
		const withText: ReviewNote[] = [];
		const unreadable: string[] = [];
		const { layout } = this.host.core;
		for (const note of bare) {
			const file = byPath.get(note.path);
			const waits = waitingPaths.has(note.path);
			// A waiting note is read whatever its name is, so the name is parsed for
			// today's log only for a note that does not wait.
			if (!waits && !isTodaysLog(note.path, layout, today)) continue;
			if (file === undefined) {
				withText.push(note);
				continue;
			}
			try {
				withText.push({ ...note, text: await this.host.app.vault.cachedRead(file) });
			} catch {
				if (waits) unreadable.push(note.path);
				else withText.push(note);
			}
		}
		return { ...this.waitingFrom(withText, today, await this.templateDiaries(withText)), unreadable };
	}

	/**
	 * For each day's log among `notes` that has text, the diary section the
	 * day's-log template makes for it, read now: the *diary empty*
	 * sign reads a log that holds only that as empty. Empty when no template is
	 * answered; a log that carries the mark of the section it was built with is left
	 * out, since the sign reads that mark from the log's own text. A template that cannot be read leaves the sign as it was before
	 * the template was considered; the standing problem is the stamp's to report,
	 * which it does the first time a diary is written in a log.
	 */
	private async templateDiaries(notes: readonly ReviewNote[]): Promise<ReadonlyMap<string, string>> {
		const found = new Map<string, string>();
		const { layout } = this.host.core;
		for (const note of notes) {
			if (note.text === "" || !isDailyLogPath(note.path, layout)) continue;
			const dayOf = this.dayReader(note.path);
			if (!this.templateApplies(note.path, note.text, dayOf)) continue;
			try {
				const diary = await this.templateDiaryOf(note.path, dayOf);
				if (diary !== null) found.set(note.path, diary);
			} catch {
				// Said by the stamp, not by every draw of the list.
			}
		}
		return found;
	}

	/**
	 * The chain for `month`, from a read of the vault of its own, for a caller
	 * outside a refresh, which today is the tests. The list draws
	 * from the read its refresh made instead ({@link chainIn}), whose files and
	 * frontmatter are the ones the count and the rows used. The grid needs the text of every day's log in
	 * `month` (is the diary heading there). The runs are as of today, whichever
	 * month is shown, so the logs are also read newest first from today back to
	 * the first day whose diary is *missed*; nothing older can change the diary
	 * run, and the review run needs frontmatter alone. A note of any other kind
	 * is handed over with its frontmatter alone. A log that cannot be read fails
	 * the read and says which, because a log read as empty would silently drop its
	 * diary mark. Nothing is kept: the texts are read again on the next call.
	 */
	async chain(month: ChainMonth): Promise<ReviewChain> {
		return this.read().chain(month);
	}

	/** {@link chain} from `read`: the files and the frontmatter are the read's, the logs' texts are read here. */
	private async chainIn(month: ChainMonth, read: VaultNotes): Promise<ReviewChain> {
		const { layout } = this.host.core;
		const { vault, metadataCache } = this.host.app;
		const { today, files: byPath, notes: bare } = read;
		const first = new Date(month.year, month.month - 1, 1);
		const last = new Date(month.year, month.month, 0);
		const texts = new Map<string, string>();
		const readText = async (note: ReviewNote): Promise<void> => {
			const file = byPath.get(note.path);
			if (file === undefined || texts.has(note.path)) return;
			try {
				texts.set(note.path, await vault.cachedRead(file));
			} catch (error) {
				throw new Error(`${note.path} could not be read (${reasonOf(error)})`);
			}
		};
		// The logs the chain reads, as it reads them: outside the excluded folders,
		// the first log of a day taking it, newest day first.
		const logs = new Map<number, { note: ReviewNote; date: Date }>();
		for (const note of bare) {
			if (isExcluded(note.path, layout.excludedFolders)) continue;
			const date = parseDailyLogDate(note.path, layout);
			if (date === null) continue;
			const dayNumber = date.getFullYear() * 10_000 + date.getMonth() * 100 + date.getDate();
			if (!logs.has(dayNumber)) logs.set(dayNumber, { note, date });
		}
		const newestFirst = [...logs.values()].sort((a, b) => b.date.getTime() - a.date.getTime());
		for (const { note, date } of newestFirst) {
			if (date >= first && date <= last) await readText(note);
		}
		// With no diary heading there is no diary run to read back for.
		if (layout.diaryHeading.text.trim() !== "") {
			for (const { note, date } of newestFirst) {
				if (date > today) continue;
				await readText(note);
				if (chainDiaryMissed({ ...note, text: texts.get(note.path) ?? "" }, date, today, layout)) break;
			}
		}
		const notes = bare.map((note) => (texts.has(note.path) ? { ...note, text: texts.get(note.path) ?? "" } : note));
		const answer = readChain(
			notes,
			layout,
			(linkText, sourcePath) => metadataCache.getFirstLinkpathDest(getLinkpath(linkText), sourcePath)?.path ?? null,
			month,
			today,
		);
		return { ...answer, diaryOn: layout.diaryHeading.text.trim() !== "" };
	}

	/**
	 * One read of the vault: the files
	 * listed once and every note's frontmatter taken once, the first time any of
	 * its answers is asked for, so a refresh while the feature is not `ready`
	 * lists nothing. The count ({@link RefreshRead.waitingBare}), the list's rows and
	 * the chain all draw from it, and the frontmatter-only answer of the
	 * waiting-notes reader is computed once for the count and the rows alike.
	 * Nothing is kept past it: the next read lists the vault again. `today` is
	 * the day all of it is reckoned from: the refresh's own, so the count and the
	 * date the refresh records can never be two days. The readiness answer is
	 * asked once and carried with it, so no list asks again.
	 */
	private read(today: Date = new Date(), readiness: Readiness = this.readiness()): RefreshRead {
		const { vault, metadataCache } = this.host.app;
		let notes: VaultNotes | null = null;
		let bare: WaitingNotes | null = null;
		const vaultNotes = (): VaultNotes => (notes ??= readVaultNotes(vault, metadataCache, today));
		const waitingBare = (): WaitingNotes => {
			const found = vaultNotes();
			return (bare ??= this.waitingFrom(found.notes, found.today));
		};
		return {
			readiness,
			waitingBare,
			waiting: () => this.waitingIn(vaultNotes(), waitingBare()),
			chain: (month: ChainMonth) => this.chainIn(month, vaultNotes()),
			followed: () => this.followedIn(vaultNotes()),
		};
	}

	/**
	 * The followed tasks, from `read`: the files are the read's, the text of each
	 * candidate note is read here with `cachedRead`, and the rule is
	 * {@link followedTasks}'s. A person mark is
	 * `@` directly followed by a link, so a note whose metadata cache lists no link
	 * (`CachedMetadata.links`, `obsidian.d.ts:1406`, asked with `getFileCache`, `:4417`, so the frontmatter's one read per note stays one) cannot hold a followed task and
	 * its text is not read. On a vault of
	 * 2,000 notes of which 3 hold a followed task that is 3 reads, where reading
	 * every note cost 24 to 52 ms for the reader alone over 2,089 notes. A note the
	 * cache has no entry for yet, one just created, is read: the cache cannot answer
	 * for it, and a task in it must not be missed. The read is a piece of its own,
	 * behind its own yield to the screen. A note that cannot be read fails the read
	 * and says which, as the chain does: a task silently left out of the part would
	 * be a followed task the person believes is not there.
	 */
	private async followedIn(read: VaultNotes): Promise<readonly FollowedGroup[]> {
		const { layout } = this.host.core;
		const { files: byPath, notes: bare } = read;
		const { metadataCache, vault } = this.host.app;
		const notes: ReviewNote[] = [];
		for (const note of bare) {
			const file = byPath.get(note.path);
			if (file === undefined || isExcluded(note.path, layout.excludedFolders)) continue;
			const cache = metadataCache.getFileCache(file);
			if (cache !== null && (cache.links === undefined || cache.links.length === 0)) continue;
			try {
				notes.push({ ...note, text: await vault.cachedRead(file) });
			} catch (error) {
				throw new Error(`${note.path} could not be read (${reasonOf(error)})`);
			}
		}
		return followedTasks(notes, layout, (path) => this.host.collections.at(path));
	}

	/** The reader, given the layout, the window and Obsidian's own link resolver as they stand now. */
	private waitingFrom(notes: readonly ReviewNote[], today: Date, templateDiaries: ReadonlyMap<string, string> = new Map()): WaitingNotes {
		const { metadataCache } = this.host.app;
		return waitingNotes(notes, this.host.core.layout, this.windowDays(), today, (linkText, sourcePath) => {
			return metadataCache.getFirstLinkpathDest(getLinkpath(linkText), sourcePath)?.path ?? null;
		}, (path) => this.host.collections.at(path) !== null, (path) => templateDiaries.get(path) ?? null);
	}

	/**
	 * `unconfigured` while the daily-log folder or the filename pattern is
	 * blank, or the pattern is one the core cannot read: no note has a day without them, so Review would run and show
	 * nothing, silently. Migration and Task consistency answer the same
	 * situation the same way, in the same sentences
	 * (`migration.ts:77-91`, in Migration's folder under `src/features`; ticket
	 * #1054 comment of
	 * 2026-10-09). Then `unconfigured` again when either field name is one the
	 * core's rule refuses; the settings store already replaces such a name on
	 * read, so this is the check that holds if a host hands over a layout that
	 * skipped it. `ready` otherwise.
	 *
	 * **Never `unavailable`**: it runs on a phone with no status-bar count, so this does
	 * not read `Platform.isMobile`. **Never `standby`**: it is not a per-device
	 * job.
	 */
	readiness(): Readiness {
		const layout = this.host.core.layout;

		if (dailyLogPrefix(layout) === null) {
			return {
				state: "unconfigured",
				reason: `The daily-log folder is not set. Enter it under Folder on the ${CORE_CARD} card.`,
			};
		}
		if (!layout.dailyLogFilename.trim()) {
			return {
				state: "unconfigured",
				reason: `The daily-log filename pattern is not set. Enter it under Filename on the ${CORE_CARD} card.`,
			};
		}
		// A pattern the core cannot read gives no note a day, so the count would
		// never appear: the same silent case as a blank one. The core holds the
		// check and its sentence; it costs about 9 ms, which is why a refresh asks it
		// once and carries the answer to the lists it redraws, and no list asks again.
		const unreadable = unreadableFilenamePattern(layout);
		if (unreadable !== null) {
			return {
				state: "unconfigured",
				reason: `Effortless cannot read “${unreadable}”, so no note is recognised as a day's log. Change it under Filename on the ${CORE_CARD} card.`,
			};
		}
		for (const [label, value] of [
			["Processed field", layout.processedField],
			["Day link field", layout.dayLinkField],
		] as const) {
			const refusal = fieldNameRefusal(label, value);
			if (refusal !== null) {
				return { state: "unconfigured", reason: `${refusal} Enter it under ${label} on the ${CORE_CARD} card.` };
			}
		}

		return { state: "ready" };
	}

	/**
	 * `changed` is unused: {@link renderReviewSettings}'s own doc comment says
	 * why this card never calls it.
	 */
	override displaySettings(containerEl: HTMLElement, _changed: SettingsChanged): void {
		renderReviewSettings(containerEl, this);
	}

	/** The `windowDays` field exactly as `data.json` holds it, unjudged — what the card shows. */
	storedWindowDays(): unknown {
		return (this.own.read() as { windowDays?: unknown }).windowDays;
	}

	/** How many days are looked at: the stored value when usable, the shipped default otherwise. */
	windowDays(): number {
		return usableWindowDays(this.storedWindowDays()) ?? DEFAULT_REVIEW_SETTINGS.windowDays;
	}

	/**
	 * Stores `windowDays` once the typing that asked for it has stopped, and
	 * redraws the count at once: `saveSoon` changes the slice straight away and
	 * only defers the write, so the count shows what was typed. A write the
	 * store then refuses puts the slice back and tells `own.onChange`, which
	 * redraws again, so the bar is never left showing a window nobody stored.
	 */
	async saveWindowDaysSoon(windowDays: number): Promise<void> {
		const saving = this.own.saveSoon({ ...this.own.read(), windowDays });
		this.refresh();
		await saving;
	}
}

/** `text` with every line ending a line feed and no byte-order mark: the form an editor holds a note in, so two reads of one note compare equal. */
function lineFeedsOnly(text: string): string {
	return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/** The closed row's sentence for `count` waiting notes. */
function lineFor(count: number): string {
	if (count === 0) return "Nothing waiting";
	return count === 1 ? "1 note waiting" : `${count} notes waiting`;
}

/**
 * Draws `count` into the status-bar item: text and a hover label while some
 * notes wait, and nothing at all — no text, and the item hidden — when none do.
 * The `hidden` attribute is set, but it is not what takes the item off the bar:
 * Obsidian 1.14.4 gives `.status-bar-item` `display: inline-flex`, which beats
 * `[hidden]`, and hides it by `.status-bar-item:empty { display: none }`
 * because the text is emptied too (the standards review of wave 3 read this
 * in the app's stylesheet). So the empty text is what keeps the bar from
 * leaving a gap.
 */
function drawCount(item: HTMLElement, count: number): void {
	if (count === 0) {
		item.hidden = true;
		item.setText("");
		item.removeAttribute("aria-label");
		return;
	}
	item.hidden = false;
	const words = reviewWords();
	item.setText(words.statusText(count));
	item.setAttribute("aria-label", words.statusLabel);
}

/** Whether `record` keeps any entry, without listing them. */
function keepsAny(record: Readonly<Record<string, string>>): boolean {
	for (const _ in record) return true;
	return false;
}
