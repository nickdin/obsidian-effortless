/**
 * The core's queued, atomic writer for notes the user is not looking at, and
 * the one place a missing day's log is created.
 *
 * Obsidian's `Vault.process` replaces a file's contents in one step, so two
 * plugins writing the same note cannot lose each other's work. That is not
 * enough on its own: two writes started in the same tick both read the same
 * original text, and the second one's result overwrites the first. So this
 * class also queues writes per file, and every queued write sees the previous
 * one's result rather than the text as it was when it was queued.
 *
 * It also refuses to write the note the person currently has open, holding that
 * write until they leave it. ADR 0002 states that rule for keeping a task and
 * its copy in step; it lives here because every background write comes through
 * this queue and the person's typing deserves the same protection whichever
 * feature is writing.
 *
 * A held write is never lost in silence. It is let go when the person leaves the
 * note; if they stay, it says so after a while; and if the plugin unloads while
 * it waits, {@link NoteWriter.teardown} rejects it rather than leaving its
 * caller waiting for the rest of the app session.
 *
 * Before any write touches a note, a board left loaded in a background tab is
 * asked to save its own copy of it, and the write waits for that save. A stand-in
 * board that kept an edit without asking to save lost it when a held write landed
 * under it, and kept it once asked to save first
 * (`docs/acceptance-shots/issue-1197-background-save-drive.txt`, step 1; #1197).
 *
 * Work under the cursor does not come here. Obsidian's `Editor` API already
 * edits the open note correctly and keeps the user's selection and undo
 * history, which this cannot.
 */

import { Notice } from "obsidian";
import type { App, FileManager, FileView, MarkdownView, Plugin, TFile, TextFileView, Vault } from "obsidian";
import { withBuiltDiaryMark } from "./builtDiaryMark";
import { dailyLogFromTemplate, diarySectionOf } from "./dailyLogTemplate";
import { reasonOf } from "./reason";
import type { VaultLayout } from "./settings";
import { dailyLogFrame, dailyLogPath } from "./vaultLayout";

/**
 * Which note the person is looking at. A small port rather than the workspace
 * itself, so the writer can be driven from a test without an app around it;
 * `openNoteFromWorkspace` is the one Obsidian gives.
 */
export interface OpenNote {
	/** The vault path of the note on screen, or `null` when none is. */
	path(): string | null;
	/** Registers a listener called whenever that path changes. */
	onChange(listener: () => void): void;
	/**
	 * Whether `path` is shown in reading view and nowhere for editing: at least
	 * one tab shows it, and every tab showing it is in reading view. `false`
	 * when a tab shows it for editing and when no tab shows it at all.
	 *
	 * {@link NoteWriter.edit} no longer asks this: a note no tab shows cannot be
	 * typed in either, so the question it needs is {@link shownForEditing}.
	 */
	inReadingView?(path: string): boolean;
	/**
	 * Whether at least one tab shows `path` where the person could be typing: a
	 * markdown tab in source (editing) mode, or a view of another type that keeps
	 * its own copy of the note (one with `requestSave`, #1117). `false` for a note
	 * shown only in reading view and
	 * for one no tab shows at all, even when it is still the note
	 * {@link path} names.
	 *
	 * Optional, so a port built before {@link EditOptions.askedFor} existed keeps
	 * compiling and means "cannot say" — which {@link NoteWriter.edit} reads as
	 * "hold the write".
	 */
	shownForEditing?(path: string): boolean;
	/**
	 * Whether a view of another type that keeps its own copy of `path` shows it
	 * now, wherever it sits — in a split beside the active note as much as in the
	 * active tab. {@link NoteWriter} holds a write for such a view whether or not
	 * `path` is the note {@link path} names, and lets it go when this turns
	 * `false`: the view's tab closed, moved to another note, or put in the
	 * background by switching to another tab of its group — and in that
	 * last case the write first asks it to save ({@link saveBackgroundViews},
	 * #1197). A markdown tab
	 * never answers `true`: Obsidian reloads an editor whose file changed — an
	 * inference, not a drive; no record here switched a markdown tab with the
	 * file changed under it.
	 *
	 * Optional: a port without it means the hold is decided from {@link path}
	 * alone, as it was before #1164.
	 */
	shownInOtherView?(path: string): boolean;
	/**
	 * Asks every view of another type that keeps its own copy of `path` and is
	 * loaded but not on screen — a board in a background tab — to save that copy
	 * to the file, and resolves once each has. Resolves at once when there is none.
	 * {@link NoteWriter} runs it before every write that touches the note, so a
	 * board that has not saved yet keeps its edit rather than reloading the
	 * written file over it (driven on a stand-in board:
	 * `docs/acceptance-shots/issue-1197-background-save-drive.txt`, step 1).
	 * Rejects with the first view's failure.
	 *
	 * Optional: a port without it writes without asking, as before #1197.
	 */
	saveBackgroundViews?(path: string): Promise<void>;
}

/** What a caller may say of an {@link NoteWriter.edit}. */
export interface EditOptions {
	/**
	 * The person asked for this write, as with a press on *Mark as processed*.
	 * It is then let through at once when its note is shown in no tab for
	 * editing — in reading view, or in no tab at all — where nothing can be
	 * typed. Every other write stays held for the note on screen, whatever its
	 * caller says.
	 */
	askedFor?: boolean;
	/**
	 * Hold the write for the note on screen without the notice that says it is
	 * waiting ({@link HELD_WRITE_NOTICE_MS}). For a background write the person did
	 * not ask for and can do nothing about, which a daily message would only nag
	 * about (Review's diary-date write, ticket
	 * #1139; spec
	 * #1049 puts reminders
	 * of any kind out of scope).
	 *
	 * **It changes the notice and nothing else**: the writes that are held are the
	 * same with it and without it ({@link askedFor} and
	 * {@link OpenNote.shownForEditing} decide that), the write lands the moment the
	 * person leaves the note, and one still waiting when the plugin unloads is
	 * rejected with the same reason, which its caller reports. A write the person
	 * asked for keeps its notice: they are waiting on it.
	 */
	quietHold?: boolean;
}

/**
 * The open note as Obsidian reports it. Registered through the plugin, so the
 * listener detaches when the plugin unloads.
 */
export function openNoteFromWorkspace(plugin: Plugin): OpenNote {
	const listeners: Array<() => void> = [];
	const changed = () => {
		for (const listener of listeners) listener();
	};
	plugin.registerEvent(plugin.app.workspace.on("file-open", changed));
	// A tab closed fires `layout-change` (`node_modules/obsidian/obsidian.d.ts:8084`)
	// and no `file-open`, and a board closed beside another active note is what ends
	// its hold.
	plugin.registerEvent(plugin.app.workspace.on("layout-change", changed));
	// Switching to another tab of the same group fires `active-leaf-change`
	// (`:8071`), and a board left that way ends its hold. The write
	// listening for it is inferred from the d.ts; which of the three events a
	// switch fires is read in the drive record.
	plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", changed));
	return {
		path: () => plugin.app.workspace.getActiveFile()?.path ?? null,
		onChange: (listener) => {
			listeners.push(listener);
		},
		// `Workspace.getLeavesOfType` (`node_modules/obsidian/obsidian.d.ts:8015`) and
		// `MarkdownView.getMode` (`:4214`, `MarkdownViewModeType` `:4240`) are
		// published. Read when used, never kept: a tab closed or switched since is
		// not there.
		inReadingView: (path) => {
			const modes = modesShowing(plugin, path);
			return modes.length > 0 && modes.every((mode) => mode === "preview");
		},
		// `getActiveFile` is documented to answer "the most recently active file"
		// when the active view is not a file view (`:7991-7996`), so "the open note"
		// need not mean "a tab shows it": only a tab in source mode, which covers
		// Live Preview too, is somewhere to type. Inferred from that
		// wording: Obsidian 1.14.4 answered null once the tab was closed
		// (`docs/acceptance-shots/issue-1089-closed-tab-drive.txt`, step 1). A view
		// of another type that edits the same file is somewhere to type as well,
		// and it holds its own copy of the text; a pane that only names the
		// note is not.
		shownForEditing: (path) =>
			sourceModeViews(plugin.app, path).length > 0 || otherViewsShowing(plugin.app, path).length > 0,
		// Any open view of another type, not only the active tab's: a board in a split
		// beside a more recently active note still holds its own unsaved copy.
		shownInOtherView: (path) => otherViewsShowing(plugin.app, path).length > 0,
		// Read now, so a tab closed or brought back on screen since is not asked. A
		// stand-in board that had asked for its own save kept its edit even without
		// this (`docs/acceptance-shots/issue-1197-background-save-drive.txt`, step 2);
		// one that had not, lost it (step 1).
		saveBackgroundViews: async (path) => {
			await Promise.all(backgroundViewsKeeping(plugin.app, path).map(saveOf));
		},
	};
}

/**
 * Every view that is not a markdown tab, edits `path` and shows it on screen, of whatever
 * type, read now: a Kanban board or an Excalidraw drawing opens a `.md` file in a
 * view of its own, which keeps the file's text in memory and saves it later, so a
 * write to the file under it is lost or loses what the person changed there. The type is never named: every such view that shows the note holds the
 * write.
 *
 * `Workspace.iterateAllLeaves` (`node_modules/obsidian/obsidian.d.ts:8009`) walks
 * every leaf of every type, which `getLeavesOfType("markdown")` cannot. A view
 * that shows a file is a `FileView` (`:3130`) and names it in `file` (`:3138`),
 * `null` when it shows none. That is not enough: Obsidian 1.14.4's Outline,
 * Backlinks and Outgoing-links panes answer `file` too, and one open beside a note
 * in reading view held its write, which #1085 and #1089 let through (driven:
 * `docs/acceptance-shots/issue-1117-other-view-drive.txt`, step 3). What a view
 * that keeps its own copy has and those panes lack (read back there: no `data`, no
 * `requestSave`) is `requestSave` (`:7059`, on `TextFileView`, `:7046`), so only a
 * view with that function holds. A board loaded in a tab the person has switched
 * away from is not on screen and does not hold ({@link onScreen}, #1192). A markdown tab is left to {@link sourceModeViews},
 * which separates source mode from reading view; nothing can be typed in reading
 * view, so it must not hold the write here. Nothing is kept between calls: a tab
 * closed since is not there.
 */
function otherViewsShowing(app: App, path: string): FileView[] {
	return viewsKeepingOwnCopy(app, path).filter(onScreen);
}

/**
 * Every view of another type that keeps its own copy of `path` and is loaded in a
 * tab the person has switched away from, read now: it may still hold an edit it
 * has not saved.
 */
function backgroundViewsKeeping(app: App, path: string): KeepingView[] {
	return viewsKeepingOwnCopy(app, path).filter((view) => !onScreen(view));
}

/** A view of another type that keeps its own copy of a note, as {@link otherViewsShowing} describes one. */
type KeepingView = FileView & Partial<Pick<TextFileView, "requestSave" | "save">>;

/**
 * Every view that is not a markdown tab, names `path` and keeps its own copy of
 * it (`requestSave`, for the reason {@link otherViewsShowing} gives), on screen
 * or not, read now.
 */
function viewsKeepingOwnCopy(app: App, path: string): KeepingView[] {
	const views: KeepingView[] = [];
	app.workspace.iterateAllLeaves((leaf) => {
		const view = leaf.view as KeepingView;
		if (view.getViewType() !== "markdown" && view.file?.path === path && typeof view.requestSave === "function") {
			views.push(view);
		}
	});
	return views;
}

/**
 * Saves `view`'s own copy of its note to the file, through `TextFileView.save`
 * (`node_modules/obsidian/obsidian.d.ts:7081`), and resolves once it has. Its
 * `requestSave` (`:7059`) cannot stand in: it is debounced by two seconds and
 * returns nothing to wait on. A view with `requestSave` and no `save` is refused
 * by name rather than skipped, since writing under it could lose its edit.
 */
function saveOf(view: KeepingView): Promise<void> {
	if (typeof view.save !== "function") {
		return Promise.reject(
			new Error(`its view (${view.getViewType()}) keeps its own copy of the note and has no way to be asked to save it`),
		);
	}
	return view.save();
}

/**
 * Whether `view` is on screen now, not merely loaded in a tab the person has
 * switched away from. A tab group hides the elements of its unselected tabs, and
 * `HTMLElement.isShown` (`node_modules/obsidian/obsidian.d.ts:104`) is true only
 * for an element attached with no hidden ancestor, read on `View.containerEl`
 * (`:7615`). Read when used, never kept. A view that cannot answer counts as on
 * screen: holding is the safe answer, as with {@link OpenNote.shownForEditing}.
 */
function onScreen(view: FileView): boolean {
	const element = view.containerEl as Partial<Pick<HTMLElement, "isShown">> | undefined;
	return typeof element?.isShown === "function" ? element.isShown() : true;
}

/** The mode of every markdown tab showing `path`, read now. */
function modesShowing(plugin: Plugin, path: string): Array<ReturnType<MarkdownView["getMode"]>> {
	return markdownViewsShowing(plugin.app, path).map((view) => view.getMode());
}

function markdownViewsShowing(app: App, path: string): MarkdownView[] {
	return app.workspace
		.getLeavesOfType("markdown")
		.map((leaf) => leaf.view as MarkdownView)
		.filter((view) => view.file?.path === path);
}

/**
 * Every markdown tab showing `path` in source mode (which covers Live Preview),
 * read now: the one rule for "somewhere to type in this note". The writer holds
 * a write for it ({@link OpenNote.shownForEditing}) and Review writes through
 * its editor, so both ask here and cannot drift apart.
 */
export function sourceModeViews(app: App, path: string): MarkdownView[] {
	return markdownViewsShowing(app, path).filter((view) => view.getMode() === "source");
}

/**
 * How long a write may sit waiting for the person to leave the note before it
 * says so out loud.
 *
 * Thirty seconds: far longer than the second or two a person takes to move
 * between notes, so an ordinary hold never says anything; and short enough that
 * someone who has stayed in the note hears about the wait while it still
 * matters to them. The write is not cancelled when this fires — it still lands
 * the moment they leave. All this ends is the silence.
 */
const HELD_WRITE_NOTICE_MS = 30_000;

/** What a caller is told when the plugin unloaded while their write waited. */
const UNLOADED =
	"Effortless: this write did not happen. The plugin was unloaded while the write was waiting for you to leave the note.";

/** What a caller is told when the plugin unloaded while their write waited on a failed save. */
const unloadedAfterFailedSave = (path: string) =>
	`Effortless: this write did not happen. The plugin was unloaded while the write was waiting for a tab in the background to save its own changes to ${path}.`;

/**
 * A write parked because its file is the one on screen, or because a view in a
 * background tab failed to save it first. It carries both ways out — the person
 * leaving, and the plugin unloading — and the timer that makes a long wait
 * visible, so whichever comes first can clear the other.
 */
interface HeldWrite {
	release: () => void;
	refuse: (error: Error) => void;
	/**
	 * Why it is parked: `open` for the note on screen ({@link NoteWriter.untilLeft}),
	 * `save` after a view in a background tab failed to save the note, which
	 * has already said so ({@link NoteWriter.untilSaved}). It decides the reason a
	 * write refused at unload is given, and that a `save` write gets no second
	 * notice.
	 */
	cause: "open" | "save";
	/** Absent for a write held quietly ({@link EditOptions.quietHold}): there is nothing to clear. */
	sayItIsWaiting?: number;
}

export class NoteWriter {
	/**
	 * The tail of each file's queue, keyed by vault path. A tail never rejects,
	 * so one failed write does not cancel the writes queued behind it; the
	 * caller still receives the real, rejecting promise.
	 */
	private readonly queues = new Map<string, Promise<void>>();

	/** Writes waiting for the person to leave that file, keyed by vault path. */
	private readonly waiting = new Map<string, HeldWrite[]>();

	/**
	 * How many writes the person asked for, without a quiet hold of their own, are
	 * queued or running for each path. While there is one, a quiet hold on that
	 * path gives its notice, since the person is waiting behind it.
	 */
	private readonly askedPending = new Map<string, number>();

	/**
	 * Set by {@link teardown}. After it, nothing is ever parked again: the
	 * listener that would let a parked write go has detached with the plugin, so
	 * a write parked now would wait for the rest of the app session in silence.
	 */
	private unloaded = false;

	/**
	 * The tail of the one queue every folder is made on. The write queues are
	 * keyed by file path, so two days being built at once do not wait for each
	 * other — but they share the folder tree above them, and Obsidian's
	 * `createFolder` rejects when the folder is already there. Making folders on
	 * one chain means the second day looks again after the first has finished,
	 * finds the folder, and makes nothing.
	 */
	private folderWork: Promise<void> = Promise.resolve();

	/**
	 * Optional so every caller built before {@link rename} existed keeps
	 * compiling; only `rename` reaches for it, and it names the gap itself if
	 * asked to work without one. The plugin's entry point hands it
	 * `app.fileManager` once something wires `rename` in.
	 *
	 * `onDailyLogBuilt` is told, for each day's log {@link createDailyLog} builds
	 * from the day's-log template, the day it was built for and the text it holds
	 * under the diary heading — what the person did not write. The plugin's entry
	 * point keeps it in `data.json` (`builtDiaries.ts`'s `keepBuiltDiaries`,
	 * ticket #1201). Optional
	 * like `fileManager`; a writer without it keeps nothing.
	 */
	constructor(
		private readonly vault: Vault,
		private readonly openNote: OpenNote,
		private readonly fileManager?: FileManager,
		private readonly onDailyLogBuilt?: (date: Date, diary: string) => void,
	) {
		openNote.onChange(() => this.releaseLeftFiles());
	}

	/**
	 * Rewrites `file` by handing its current contents to `edit` and storing what
	 * comes back. Resolves with the new contents, and rejects with whatever
	 * `edit` threw. If the person has that note open, the write waits until they
	 * leave it rather than overwriting what they are typing.
	 *
	 * One exception, for a write the person asked for ({@link EditOptions.askedFor}):
	 * a note no tab shows for editing cannot be typed in, so the hold has nothing
	 * to protect and the write goes to disk at once. That covers reading view
	 * and a note whose tab was closed while Obsidian still names it the active
	 * file. Held, a press on *Mark as processed* in reading view left the field
	 * blank until the person left the note
	 * (`docs/acceptance-shots/fix-1079-drive.txt`, steps 5c and 6; #1085); let
	 * through, the field is on disk five seconds after the press with the note
	 * still on screen (`docs/acceptance-shots/issue-1085-reading-view-drive.txt`,
	 * steps 1 and 2; step 3 is the control, the build from before the fix, which
	 * still holds the write). With the active file standing in for a closed tab's
	 * note, the same press writes at once and the old build held it (#1089,
	 * `docs/acceptance-shots/issue-1089-closed-tab-drive.txt`, steps 3 and 4).
	 * That nothing is typed in reading view is inferred, not driven. A note shown
	 * for editing, and a port that cannot say ({@link OpenNote.shownForEditing}
	 * absent), are still held. The question is asked at the front of the note's
	 * queue, not when called, since the tab may have been switched to editing
	 * since; the write still joins that queue, so one parked ahead of it holds
	 * it too.
	 */
	edit(file: TFile, edit: (content: string) => string, options: EditOptions = {}): Promise<string> {
		const path = file.path;
		const person = options.askedFor === true && options.quietHold !== true;
		if (person) {
			this.askedPending.set(path, (this.askedPending.get(path) ?? 0) + 1);
			this.sayQuietHoldsAreWaiting(path);
		}
		const done = this.queue(path, async () => {
			const writeNow = options.askedFor === true && this.openNote.shownForEditing?.(path) === false;
			if (!writeNow) await this.untilLeft(path, options.quietHold === true);
			await this.untilSaved(path, options.quietHold === true);
			return this.vault.process(file, edit);
		});
		if (person) {
			const finished = () => {
				const left = (this.askedPending.get(path) ?? 1) - 1;
				if (left > 0) this.askedPending.set(path, left);
				else this.askedPending.delete(path);
			};
			done.then(finished, finished);
		}
		return done;
	}

	/**
	 * Reads `file`'s current text. Joins the same per-path queue {@link edit}
	 * uses, so a read issued after a queued write to that path sees the
	 * write's own result rather than a stale one.
	 *
	 * Never held for a note a write would be held for ({@link isHeld}: the note
	 * the person has open, or one a view of another type shows): reading does not
	 * conflict with their typing the way a write does, so a read of such a note
	 * reads it at once instead of joining a queue a held write to it might be
	 * parked in. The same goes for a note a write is parked on for any
	 * other reason — after a background board failed to save it, when the
	 * note itself is no longer held. Because it never parks, it also goes on answering after
	 * {@link teardown} — that only rejects what is parked, and this never is.
	 *
	 * Rejects with whatever the vault's own read threw.
	 */
	read(file: TFile): Promise<string> {
		if (this.isHeld(file.path) || this.waiting.has(file.path)) return this.vault.read(file);
		return this.queue(file.path, () => this.vault.read(file));
	}

	/**
	 * Creates a new note at `path` holding exactly `text`, making any missing
	 * folders on the way — queued on `path` the way {@link createDailyLog}
	 * queues on the day's path.
	 *
	 * `createDailyLog` stays the day's log's one creator; this is for every
	 * other note a feature builds. The meeting-notes feature is the first: by
	 * #14 it may not reach `vault.create` itself, and what an existing file at
	 * `path` means is that feature's own call to make (adoption, decision 10)
	 * — so this refuses rather than silently handing the existing file back. A
	 * quiet hand-back would take that decision away from the caller.
	 *
	 * Throws, naming `path`, if a file is already there — checked now and
	 * again once the write reaches the front of `path`'s queue, in case a call
	 * queued ahead of this one created it in the meantime. The existing file is
	 * left untouched either way.
	 */
	async create(path: string, text: string): Promise<TFile> {
		// Checked before joining the queue, in the synchronous prefix of this
		// `async` method, for the same reason as `createDailyLog`: a throw
		// here still arrives as a rejection, never a synchronous throw a
		// caller's `.catch` would miss.
		if (this.vault.getFileByPath(path) !== null) {
			throw new Error(`A note already exists at "${path}".`);
		}
		return this.queue(path, async () => {
			// Asked again inside the queue: a call queued ahead of this one may
			// have created the file in the meantime.
			if (this.vault.getFileByPath(path) !== null) {
				throw new Error(`A note already exists at "${path}".`);
			}
			await this.createFoldersFor(path);
			return this.vault.create(path, text);
		});
	}

	/**
	 * The day's log for `date`, created from the layout if it is not there yet.
	 *
	 * This is the only place in the plugin that creates a day's log. Two of the
	 * plugins being merged both had a hand in it — one created the file empty
	 * and the other then read that empty file as a day already built, and
	 * refused it for ever. One creator ends that.
	 *
	 * Built from {@link dailyLogFrame}, the generic frame, unless
	 * `layout.dailyLogTemplate` names a note — then built from that note's own
	 * text instead, through `dailyLogTemplate.ts`'s `dailyLogFromTemplate`. Reading the template happens once the queue's turn has
	 * come, the same moment the frame is otherwise built, and not before: the
	 * fast path below that answers a day already on disk must not read a
	 * template note it will not end up using.
	 */
	async createDailyLog(date: Date, layout: VaultLayout): Promise<TFile> {
		// `async` although nothing here is awaited. The path is built before
		// anything asynchronous starts, and the builder throws when the vault has
		// not been described yet — an ordinary state, since both halves of the
		// layout ship blank. A method that advertises a promise has to fail
		// through it, or a caller's `.catch` never sees the failure.
		// Nothing else moves: an async body still runs to its end in the same
		// tick, so the day already on disk is answered without joining the queue.
		const path = dailyLogPath(date, layout);
		// The day that is already there is answered at once rather than joining
		// the queue. Creating a day writes nothing to a file that exists, and the
		// queue for today's log is held for as long as the person is typing in it
		// — so joining it would leave every caller waiting on a write it has no
		// reason to wait for.
		const already = this.vault.getFileByPath(path);
		if (already !== null) return already;

		return this.queue(path, async () => {
			// Asked again inside the queue: a call queued ahead of this one may
			// have created the day in the meantime.
			const existing = this.vault.getFileByPath(path);
			if (existing !== null) return existing;
			const { frame, fromTemplate } = await this.dailyLogFrameFor(date, layout);
			await this.createFoldersFor(path);
			const created = await this.vault.create(path, frame);
			// Told once the log is on disk, so a refused create keeps nothing, and in
			// the same step, before Obsidian has indexed the note and reported it.
			if (fromTemplate) this.onDailyLogBuilt?.(date, diarySectionOf(frame, layout));
			return created;
		});
	}

	/**
	 * {@link dailyLogFrame} when `layout.dailyLogTemplate` is blank —
	 * byte-identical to it, since nothing here touches that text — or the
	 * named template note's own text run through `dailyLogFromTemplate`, carrying
	 * the mark of its diary section in its frontmatter (`builtDiaryMark.ts`, ticket
	 * #1207), with which of
	 * the two it is.
	 *
	 * Throws, naming the template path, when it does not exist or cannot be
	 * read; `dailyLogFromTemplate` throws its own, already-worded errors for
	 * the three things it refuses to build a day from (Templater code, an
	 * unknown placeholder, an unreadable `FORMAT`). Every one of those throws
	 * reaches `createDailyLog`'s callers as a rejection the same way the path
	 * builder's own throw already does — this module has no standing-problems
	 * channel of its own to report through. Days ahead's `runDay`
	 * (`src/features/daysAhead/run.ts`) reports whatever this rejects with,
	 * keyed by the date; `main.ts`'s "Create today's log" command shows it as
	 * a `Notice`.
	 */
	private async dailyLogFrameFor(date: Date, layout: VaultLayout): Promise<{ frame: string; fromTemplate: boolean }> {
		const templatePath = layout.dailyLogTemplate.trim();
		if (!templatePath) return { frame: dailyLogFrame(layout), fromTemplate: false };

		const file = this.vault.getFileByPath(templatePath);
		if (file === null) {
			throw new Error(
				`The day's-log template "${templatePath}" does not exist. Answer it again on the Effortless settings screen, or clear it to use the built-in frame.`,
			);
		}
		let text: string;
		try {
			text = await this.vault.read(file);
		} catch (error) {
			throw new Error(`The day's-log template "${templatePath}" could not be read: ${reasonOf(error)}.`);
		}
		return { frame: withBuiltDiaryMark(dailyLogFromTemplate(text, date, layout), layout), fromTemplate: true };
	}

	/**
	 * Renames `file` to `newPath`, queued on the file's current path so a
	 * rename and a pending {@link edit} on the same note cannot race. The
	 * `TFile` a caller holds is Obsidian's own object, so it reads `newPath`
	 * once this resolves — nothing here hands back a new one.
	 *
	 * Through `app.fileManager.renameFile`
	 * (`node_modules/obsidian/obsidian.d.ts:2902`), never `vault.rename`
	 * (`:7452`): only the former updates the links pointing at the note across
	 * the vault — when the person's "Automatically update internal links"
	 * setting is on, since Obsidian updates them "depending on the user's
	 * preferences" (`obsidian.d.ts:2896`); `vault.rename` never does. That is
	 * the whole reason a feature renames through the core rather than reaching
	 * `vault.rename` itself.
	 *
	 * Throws, naming both paths, if `newPath` is already occupied — checked
	 * once the rename reaches the front of the queue, so it runs after any
	 * pending edit rather than racing it. Neither file is touched when it
	 * throws. Missing folders on `newPath` are made first, as {@link create}
	 * makes them for a new note.
	 */
	async rename(file: TFile, newPath: string): Promise<void> {
		return this.queue(file.path, async () => {
			if (this.vault.getFileByPath(newPath) !== null) {
				throw new Error(`There is already a note at "${newPath}"; "${file.path}" was not renamed.`);
			}
			if (this.fileManager === undefined) {
				throw new Error("NoteWriter.rename needs a FileManager, and none was given to this writer.");
			}
			await this.createFoldersFor(newPath);
			await this.fileManager.renameFile(file, newPath);
		});
	}

	/**
	 * Moves `file` to the trash when `shouldTrash` says so of its text, and
	 * resolves whether it did — the one way a feature's note goes.
	 *
	 * Queued on the file's path and held while the person has it open, the way
	 * {@link edit} is, and the text `shouldTrash` is handed is read at the
	 * front of that queue: a line typed a moment ago, or written by a call
	 * queued ahead of this one, is in it, so a caller deciding "is this still
	 * only what I wrote?" never decides from a stale copy.
	 *
	 * Through `app.fileManager.trashFile` (`node_modules/obsidian/obsidian.d.ts:2920`,
	 * since 1.6.6), which follows the person's own "Deleted files" setting —
	 * Obsidian's trash, the system's, or gone — rather than choosing for them.
	 * Rejects with whatever the read or the trash threw, and names the gap when
	 * this writer was built without a file manager.
	 */
	async trashIf(file: TFile, shouldTrash: (content: string) => boolean): Promise<boolean> {
		return this.queue(file.path, async () => {
			if (this.fileManager === undefined) {
				throw new Error("NoteWriter.trashIf needs a FileManager, and none was given to this writer.");
			}
			await this.untilLeft(file.path);
			await this.untilSaved(file.path);
			const content = await this.vault.read(file);
			if (!shouldTrash(content)) return false;
			await this.fileManager.trashFile(file);
			return true;
		});
	}

	/**
	 * Lets go of every write this writer is holding, and holds nothing again.
	 * The plugin's entry point hands this to `Plugin.register` in `onload`
	 * (`src/main.ts`), so Obsidian runs it as the plugin unloads.
	 *
	 * Each parked write is rejected rather than left alone. The listener that
	 * releases a parked write detaches when the plugin unloads, so a promise
	 * left parked would never settle at all and the feature awaiting it would
	 * wait for the rest of the app session with nothing said. Rejecting is what
	 * `~/Devbox/CLAUDE.md` calls failing loud.
	 *
	 * Safe to call with nothing parked, and safe to call twice.
	 */
	teardown(): void {
		this.unloaded = true;
		const parked = Array.from(this.waiting.entries());
		this.waiting.clear();
		for (const [path, held] of parked) {
			for (const write of held) {
				window.clearTimeout(write.sayItIsWaiting);
				write.refuse(new Error(write.cause === "save" ? unloadedAfterFailedSave(path) : UNLOADED));
			}
		}
	}

	/** Runs `work` after everything already queued for `path`. */
	private queue<T>(path: string, work: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(path) ?? Promise.resolve();
		const running = previous.then(work);

		const tail = running.then(
			() => undefined,
			() => undefined,
		);
		this.queues.set(path, tail);
		void tail.then(() => {
			// Only drop the entry if nothing was queued behind this write.
			if (this.queues.get(path) === tail) this.queues.delete(path);
		});

		return running;
	}

	/**
	 * Creates every folder on the way to `path` that is not there yet, after any
	 * folder-making already under way for another file.
	 */
	private createFoldersFor(path: string): Promise<void> {
		const running = this.folderWork.then(() => this.makeFolders(path));
		// The tail never rejects, so one failed folder does not cancel the days
		// queued behind it; the caller still receives the real, rejecting promise.
		this.folderWork = running.then(
			() => undefined,
			() => undefined,
		);
		return running;
	}

	private async makeFolders(path: string): Promise<void> {
		const parts = path.split("/");
		parts.pop();
		let folder = "";
		for (const part of parts) {
			folder = folder ? `${folder}/${part}` : part;
			if (this.vault.getFolderByPath(folder) === null) {
				await this.vault.createFolder(folder);
			}
		}
	}

	/**
	 * Whether a write to `path` must wait: it is the note on screen, or a view of
	 * another type shows it wherever it sits. A markdown tab that is not the
	 * active file does not hold, as before.
	 */
	private isHeld(path: string): boolean {
		return this.openNote.path() === path || this.openNote.shownInOtherView?.(path) === true;
	}

	/** Resolves at once unless `path` is held (see {@link isHeld}); `quietly` holds it without the waiting notice. */
	private untilLeft(path: string, quietly = false): Promise<void> {
		// The open-note check first, and the unload check only for a write that
		// would actually have parked. `UNLOADED` says the write was waiting for
		// the person to leave the note, and that is false of a file nobody has
		// open: such a write would have resolved at once, so it goes on doing
		// that after teardown.
		if (!this.isHeld(path)) return Promise.resolve();
		if (this.unloaded) return Promise.reject(new Error(UNLOADED));
		const quiet = quietly && !this.askedPending.has(path);
		return this.park(path, "open", quiet ? undefined : this.noticeTimer(path));
	}

	/**
	 * Parks a write on `path` until {@link releaseLeftFiles} lets it go or
	 * {@link teardown} refuses it.
	 */
	private park(path: string, cause: HeldWrite["cause"], sayItIsWaiting?: HeldWrite["sayItIsWaiting"]): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const write: HeldWrite = { release: resolve, refuse: reject, cause, sayItIsWaiting };
			const held = this.waiting.get(path) ?? [];
			held.push(write);
			this.waiting.set(path, held);
		});
	}

	/**
	 * Resolves once every view in a background tab that keeps its own copy of `path`
	 * has saved it ({@link OpenNote.saveBackgroundViews}), so the write about to
	 * touch the file reads the board's edit instead of landing under it.
	 *
	 * A save that fails is said once, in a notice naming the note and the reason,
	 * and the write parks rather than landing under the unsaved edit or being
	 * dropped. It is tried again on the next change of tab, file or layout once
	 * the note is not held ({@link isHeld}); a board whose tab was closed is not
	 * there to ask, so the write then goes. One still parked at unload is refused,
	 * naming the save.
	 *
	 * A person who brings the board back on screen while it saves can type in it
	 * again, so once the save is done the write looks once more: a view of another
	 * type showing the note holds it again ({@link untilLeft}, `quietly` as for the
	 * first hold), and the board is asked to save afresh when it is left. The hold
	 * so ends only once the view has saved or been closed, never merely hidden.
	 */
	private async untilSaved(path: string, quietly = false): Promise<void> {
		let said = false;
		for (;;) {
			try {
				await this.openNote.saveBackgroundViews?.(path);
			} catch (error) {
				if (!said) {
					new Notice(
						`Effortless: a write to ${path} is waiting. A tab in the background shows the note with changes of its own, and saving them first failed: ${reasonOf(error)}. The write will be tried again at your next change of tab, and goes at once if that tab is closed.`,
					);
					said = true;
				}
				if (this.unloaded) throw new Error(unloadedAfterFailedSave(path));
				await this.park(path, "save");
				continue;
			}
			if (this.openNote.shownInOtherView?.(path) !== true) return;
			await this.untilLeft(path, quietly);
		}
	}

	/** The timer that raises the waiting notice for a write held on `path`. */
	private noticeTimer(path: string): number {
		return window.setTimeout(() => {
			new Notice(
				`Effortless: a background write to ${path} is waiting. It will happen as soon as the note's tab is closed, sent to another note or put in the background.`,
			);
		}, HELD_WRITE_NOTICE_MS);
	}

	/**
	 * A write the person asked for has joined `path`'s queue: the quiet writes
	 * already parked there start their notice now. One notice per path is enough,
	 * so only the first parked write without a timer gets one.
	 */
	private sayQuietHoldsAreWaiting(path: string): void {
		const held = this.waiting.get(path) ?? [];
		if (held.some((write) => write.sayItIsWaiting !== undefined || write.cause === "save")) return;
		const first = held[0];
		if (first !== undefined) first.sayItIsWaiting = this.noticeTimer(path);
	}

	/** Lets go of every write whose file the person is no longer in and no view of another type shows. */
	private releaseLeftFiles(): void {
		if (this.unloaded) return;
		for (const path of Array.from(this.waiting.keys())) {
			if (this.isHeld(path)) continue;
			const held = this.waiting.get(path) ?? [];
			this.waiting.delete(path);
			for (const write of held) {
				window.clearTimeout(write.sayItIsWaiting);
				write.release();
			}
		}
	}
}
