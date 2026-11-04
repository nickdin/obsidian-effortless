/**
 * Task consistency: the feature itself, its (empty) settings and its
 * readiness, in the shape spec #709
 * decisions 1 and 14 ask for.
 * It copies nothing yet — the run itself, checking a changed file's paired
 * lines against its counterpart, is a later ticket's, the same split
 * #757 made for
 * #762's meeting-notes
 * run.
 *
 * **It references no other feature**. It never reads another feature's settings, and reads the
 * daily-log layout and the two collection headings from the core, never from
 * a feature.
 */

import { MarkdownPreviewRenderer, MarkdownView, Notice, Platform } from "obsidian";
import type { MarkdownPostProcessorContext } from "obsidian";
import type { Collection } from "../../core/collections";
import { Feature } from "../../core/feature";
import type { Readiness } from "../../core/feature";
import { reasonOf } from "../../core/reason";
import { parseTaskLine } from "../../core/taskLine";
import { dailyLogPath, dailyLogPrefix } from "../../core/vaultLayout";
import {
	canJumpFrom,
	findOpenCollectionView,
	jumpFromLine,
	jumpToOpenView,
	linkClickedOn,
	livePreviewRowOf,
	notFoundMessage,
	pendingJumpFor,
	placeCursorOn,
	readingRowOf,
	realJumpTarget,
	resolveCollectionPath,
} from "./jump";
import type { ClickedRow, PendingJump } from "./jump";
import { checkLogFile, runOverCollection, runSweep } from "./run";
import type { RunDeps, RunNotes, RunProblems, RunVault } from "./run";
import { renderTaskConsistencySettings } from "./settingsPanel";
import { DEFAULT_TASK_CONSISTENCY_SETTINGS, FEATURE_ID } from "./types";
import type { TaskConsistencySettings } from "./types";

/** The command's own id, prefixed by Obsidian with the plugin's manifest id. */
const JUMP_COMMAND_ID = "jump-to-source";

/** The command's name in the palette — the ticket's own words. */
const JUMP_COMMAND_NAME = "Task consistency: go to the task in its collection";

/**
 * How long a click on a collection breadcrumb is remembered while waiting for
 * the `file-open` Obsidian's own link handling produces. Long enough for a
 * note creation or a slow vault to land, short enough that an unrelated
 * navigation minutes later is never mistaken for the click that started this.
 */
const PENDING_JUMP_EXPIRY_MS = 5_000;

/** Where the daily-log folder and filename are answered, named in a readiness sentence. */
const CORE_CARD = "Your day's logs";

/**
 * Ten seconds after the feature starts, matching building the days ahead's
 * and meeting notes' own cadence (spec #709 decision 2's own periodic sweep).
 */
const FIRST_RUN_DELAY_MS = 10_000;

/** Every fifteen minutes after the first run — spec #709 decision 2's own cadence. */
const RUN_EVERY_MS = 15 * 60 * 1000;

/**
 * How long after the last edit to a relevant file its check runs — "roughly a
 * second or two" (spec #709 decision 2, #27
 * D11's own timing). Chosen, not measured: long enough that three keystrokes
 * a second apart coalesce into one check, short enough that a person moving
 * to the other file finds it already caught up.
 */
const CHECK_DEBOUNCE_MS = 2_000;

/** The fixed key a run's own failure over the whole sweep is reported under — never any one collection's own path. */
const SWEEP_FAILURE_KEY = "sweep-failed";

export class TaskConsistency extends Feature {
	readonly id = FEATURE_ID;

	readonly name = "Task consistency";

	readonly description =
		"Keeps a task's line the same in its collection and in the day's log, editing one field at a time.";

	/**
	 * Taken here and used from `onload` onwards, as the feature contract asks:
	 * the handle finds its feature when it is read, not when it is taken. The
	 * slice holds nothing today (spec #709 decision 1, ADR 0002) — taken all
	 * the same, so a later ticket that does need a keyed slice finds one
	 * already there.
	 */
	private readonly own = this.host.settings<TaskConsistencySettings>(DEFAULT_TASK_CONSISTENCY_SETTINGS);

	/**
	 * Whether this load has already started the fifteen-minute interval —
	 * reset at the top of every `onload`, the pattern building the days ahead
	 * and meeting notes both keep, so a feature that stood down and comes
	 * back gets a fresh one.
	 */
	private intervalStarted = false;

	/**
	 * The pending first-run timeout, if one is waiting — cleared and replaced
	 * on every call to {@link runNow}, the same guard meeting notes keeps for
	 * its own timer (#790's shape).
	 */
	private firstRunTimeoutId: number | null = null;

	/**
	 * The collection breadcrumb clicked most recently, waiting on the
	 * `file-open` Obsidian's own link handling produces — or null once it has
	 * been used, expired, or never happened.
	 */
	private pendingJump: PendingJump | null = null;

	/** Clears {@link pendingJump} after {@link PENDING_JUMP_EXPIRY_MS}, replaced on every new click. */
	private pendingJumpTimeoutId: number | null = null;

	/**
	 * The debounce timer for a path a relevant vault change named, keyed by
	 * that path. A second edit to the same path within {@link CHECK_DEBOUNCE_MS}
	 * clears and replaces the one already waiting, so three edits inside the
	 * window schedule one check rather than three.
	 */
	private readonly pendingChecks = new Map<string, number>();

	/**
	 * Which paths a check is running for right now — a collection's own path,
	 * or the day's log's — whether the check was scheduled by a debounce or
	 * found by the sweep. A trigger for a path already in here joins no queue
	 * and starts no second run of its own; it is remembered in
	 * {@link pendingRerun} instead, and run once, fresh, the moment this path
	 * leaves the set (#687 decision 4's own rule, spec #709 decision 2's "one
	 * run per file at a time" — a second edit is not lost, only delayed to the
	 * next chance).
	 */
	private readonly running = new Set<string>();

	/**
	 * Paths whose most recent trigger arrived while {@link running} already
	 * held that path. A run can take a long time to leave the
	 * lock: `NoteWriter.edit` parks a write to the note the person has open
	 * (`noteWriter.ts`, ADR 0002) until they leave it, and that park sits
	 * inside the very `await` this class's own lock is held across, so a
	 * second, real filing arriving during that wait used to be dropped for
	 * good, with nothing left to notice the path had changed again (#894's own
	 * log write is the case that showed this). One entry per path, not a
	 * queue: several drops while locked collapse into one rerun, which rereads
	 * the file fresh and so sees every change made while it waited, the same
	 * way {@link scheduleCheck}'s own debounce already collapses several edits
	 * into one run.
	 */
	private readonly pendingRerun = new Set<string>();

	/**
	 * Whether this load is still current — set in `onload`, cleared by the
	 * same registered cleanup that clears {@link pendingRerun} (the shape
	 * {@link intervalStarted} already keeps for its own state). {@link
	 * guardedRun}'s own replay of a remembered rerun checks this rather than
	 * only clearing {@link pendingRerun} on unload, because a nested {@link
	 * guardedRun} call from a run still in flight when unload happens — the
	 * log's own check locking a collection it names, {@link checkLogFile}'s
	 * `guard` — can still add to {@link pendingRerun} after that one clear.
	 */
	private loaded = false;

	/** Whether the periodic sweep is running right now — one at a time, the same rule every timer here keeps. */
	private sweepInFlight = false;

	/**
	 * Which keys this feature currently has standing on the settings screen —
	 * a clash by eid, a broken pairing by path. `host.problems` can be reported
	 * to and cleared but never asked what is already standing, so a run needs
	 * its own record to know what to leave alone (the same shape meeting
	 * notes' own `reportedKeys` keeps, `meetingNotes.ts`).
	 */
	private readonly reportedKeys = new Set<string>();

	/**
	 * Runs the feature at once if it starts `ready` — "a switch to `ready`
	 * will run the feature at once". Runs
	 * whenever this feature is loaded at all: `unconfigured` and `unavailable`
	 * are the only readiness answers the core will not load it for, so
	 * `onload` never has to distinguish them from `ready` itself — it asks.
	 */
	override onload(): void {
		this.intervalStarted = false;
		this.loaded = true;
		this.register(() => {
			this.loaded = false;
			this.pendingRerun.clear();
		});
		this.registerJumpCommand();
		this.watchJumpClicks();
		this.watchVaultChanges();
		if (this.readiness().state === "ready") this.runNow();
	}

	/**
	 * A relevant file changing — the day's log, or a note
	 * `host.collections.at(path)` says is a collection — schedules a check of
	 * that file alone, debounced. Every other vault
	 * change is ignored at no cost beyond the one `at()` lookup, which reads
	 * nothing: `Collections` answers from Obsidian's own parsed index.
	 */
	private watchVaultChanges(): void {
		this.registerEvent(
			this.host.app.vault.on("modify", (file) => {
				const path = (file as { path?: unknown }).path;
				if (typeof path !== "string" || !this.isRelevantPath(path)) return;
				this.scheduleCheck(path);
			}),
		);
		this.register(() => {
			for (const timeoutId of this.pendingChecks.values()) window.clearTimeout(timeoutId);
			this.pendingChecks.clear();
		});
	}

	/** Whether `path` is today's day's log, or a note the collections index calls one right now. */
	private isRelevantPath(path: string): boolean {
		const layout = this.host.core.layout;
		if (dailyLogPrefix(layout) === null || !layout.dailyLogFilename.trim()) return this.isCollectionPath(path);
		try {
			if (path === dailyLogPath(new Date(), layout)) return true;
		} catch {
			// An unreadable filename pattern throws here the same way it throws
			// for every other caller of `dailyLogPath` — not this feature's day's
			// log, then, and the collection check below still answers.
		}
		return this.isCollectionPath(path);
	}

	private isCollectionPath(path: string): boolean {
		return this.collectionAt(path) !== null;
	}

	/**
	 * `host.collections.at`, bound to a name with no `.` before "at" — the
	 * `platform.test.ts` ES-floor sweep reads source text and cannot tell
	 * `Collections.at` apart from `Array`/`String.prototype.at`, so every call
	 * site through this feature reaches it this way rather than writing
	 * `collections.at(` directly (`jump.ts`'s own `collectionAt`, same reason).
	 */
	private collectionAt(path: string): Collection | null {
		const bound = this.host.collections.at.bind(this.host.collections);
		return bound(path);
	}

	/** (Re)starts `path`'s own debounce timer, clearing whatever was already waiting for it. */
	private scheduleCheck(path: string): void {
		const existing = this.pendingChecks.get(path);
		if (existing !== undefined) window.clearTimeout(existing);
		const timeoutId = window.setTimeout(() => {
			this.pendingChecks.delete(path);
			void this.checkPath(path);
		}, CHECK_DEBOUNCE_MS);
		this.pendingChecks.set(path, timeoutId);
	}

	/**
	 * One path's own check, whether reached by debounce, by the sweep, or by
	 * {@link guardedRun} replaying a trigger it remembered — run under
	 * {@link guardedRun} itself, so a trigger arriving while this same path is
	 * already locked is remembered rather than dropped.
	 *
	 * The log branch's own failure — `checkLogFile`'s own `notes.read`
	 * rejecting, or `dailyLogPath` throwing for a filename pattern that
	 * stopped parsing between the debounce and the run — is reported under
	 * `run-failed:<path>` rather than left an unhandled rejection from
	 * `void this.checkPath(path)` in {@link scheduleCheck}. The
	 * collection branch needs no such catch here: `runOverCollection` already
	 * catches and reports its own failures under `run-failed:<collection.path>`
	 * and never throws.
	 */
	private async checkPath(path: string): Promise<void> {
		if (this.readiness().state !== "ready") return;
		await this.guardedRun(path, async () => {
			const collection = this.collectionAt(path);
			if (collection !== null) {
				await runOverCollection(this.runDeps(), collection);
				return;
			}
			try {
				const layout = this.host.core.layout;
				if (path !== dailyLogPath(new Date(), layout)) return;
				const file = this.host.app.vault.getFileByPath(path);
				if (file === null) return;
				await checkLogFile(this.runDeps(), this.resolveLink(path), file, new Set(), (p, run) => this.guardedRun(p, run));
				this.host.problems.clear(`run-failed:${path}`);
			} catch (error) {
				this.host.problems.report(`run-failed:${path}`, `Effortless could not check today's log: ${reasonOf(error)}.`);
			}
		});
	}

	/**
	 * Runs `run` for `path` under {@link running} — the same "one run per file
	 * at a time" lock {@link checkPath} and {@link runSweepNow} already keep
	 * for the path each was triggered for, extended here to a collection
	 * {@link run.checkLogFile} reaches only through its own resolution, so
	 * that path is under the lock too.
	 *
	 * A `path` already locked elsewhere is not queued and not run twice at
	 * once: this call remembers it in {@link pendingRerun} and returns at
	 * once, leaving the run already under way to finish on its own. Once that
	 * run leaves the lock, a path left standing in {@link pendingRerun} gets
	 * one fresh call to {@link checkPath} — not a second call to whatever
	 * `run` this call itself was given, since {@link checkPath} is what knows
	 * how to turn a bare path back into a collection or the log again.
	 */
	private async guardedRun(path: string, run: () => Promise<void>): Promise<void> {
		if (this.running.has(path)) {
			this.pendingRerun.add(path);
			return;
		}
		this.running.add(path);
		try {
			await run();
		} finally {
			this.running.delete(path);
			if (this.pendingRerun.delete(path) && this.loaded) void this.checkPath(path);
		}
	}

	/**
	 * The periodic sweep: every collection with an open
	 * task, checked against today's log, plus today's own paired lines —
	 * catches a task crossing into "due" purely because midnight passed, with
	 * no file touched. Delegates entirely to `run.ts`'s own {@link runSweep}: this is the shipped sweep and the tested one, one code path,
	 * rather than a second copy of its loop kept here. {@link guardedRun} is
	 * this class's own answer to "one run per file at a time" for every
	 * collection `runSweep` reaches, by its own direct pass or through
	 * today's log.
	 */
	private async runSweepNow(): Promise<void> {
		if (this.sweepInFlight) return;
		this.sweepInFlight = true;
		try {
			const deps: RunDeps = { ...this.runDeps(), guard: (path, run) => this.guardedRun(path, run) };
			await runSweep(deps, this.resolveLink(dailyLogPath(new Date(), this.host.core.layout)));
			this.host.problems.clear(SWEEP_FAILURE_KEY);
		} catch (error) {
			this.host.problems.report(
				SWEEP_FAILURE_KEY,
				`Effortless could not finish its sweep over today's tasks: ${reasonOf(error)}.`,
			);
		} finally {
			this.sweepInFlight = false;
		}
	}

	/** `deps.notes`, narrowed to the two calls a run's plan ever reaches for — always the queued writer, never the vault directly. */
	private notesPort(): RunNotes {
		return {
			read: (file) => this.host.notes.read(file),
			edit: (file, edit) => this.host.notes.edit(file, edit),
		};
	}

	/** `host.app.vault`, narrowed to resolving a computed path to the `TFile` a write goes through. */
	private vaultPort(): RunVault {
		return { fileAt: (path) => this.host.app.vault.getFileByPath(path) };
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

	private runDeps(): RunDeps {
		return {
			collections: this.host.collections,
			vault: this.vaultPort(),
			notes: this.notesPort(),
			problems: this.problemsPort(),
			layout: this.host.core.layout,
			today: new Date(),
		};
	}

	/** A breadcrumb's link text resolved from `sourcePath` — `resolveCollectionPath` (`./jump`), the same resolution a click's own jump uses. */
	private resolveLink(sourcePath: string): (linktext: string) => string | null {
		return (linktext) => resolveCollectionPath(this.host.app, linktext, sourcePath);
	}

	/**
	 * The jump-to-source command: enabled
	 * only when the cursor's line carries this feature's own marker, per the
	 * ticket's own acceptance criteria — the check callback both answers that
	 * and, on activation, hands the line to {@link jumpFromLine}. No default
	 * hotkey: the author answered spec #709's open question 5 on 2026-09-22, and
	 * `docs/research/obsidian-publishing-requirements.md` asks a community
	 * plugin to ship none.
	 *
	 * **Asks the same open-view question the click handler already asks**
	 * (ticket #938, #905's own decision), and asks it only once the collection
	 * check has already passed (ticket #955: a note that has stopped being a
	 * collection gets the #811 notice whether or not some leaf still has it
	 * open) — both live inside {@link jumpFromLine} itself now, reached
	 * through the `JumpTarget` seam `realJumpTarget` builds, rather than a
	 * second resolution here. The line the cursor is on is still this
	 * command's own input, read fresh at every activation and never kept from
	 * an earlier one — the `MeetingReach` rule this repository already states
	 * for a block's own reach into the world (`CLAUDE.md` § *The rule the
	 * merge exists to enforce*, citing #679 and #686).
	 *
	 * Registered fresh on every `onload`: the core withdraws every command a
	 * feature holds when it unloads (`registry.ts`, the rule
	 * `checkboxCycling.ts`'s own `onunload` states), so there is nothing here
	 * to guard against a second registration surviving a switch off and back on.
	 */
	private registerJumpCommand(): void {
		this.host.addCommand({
			id: JUMP_COMMAND_ID,
			name: JUMP_COMMAND_NAME,
			editorCheckCallback: (checking, editor, ctx) => {
				const line = parseTaskLine(editor.getLine(editor.getCursor().line));
				const sourcePath = ctx.file?.path ?? null;
				if (!canJumpFrom(line) || sourcePath === null) return false;
				if (checking) return true;
				void jumpFromLine(realJumpTarget(this.host.app, this.host.collections), sourcePath, line);
				return true;
			},
		});
	}

	/**
	 * The click on a collection breadcrumb: when the
	 * collection is not already open anywhere, this never intercepts the click
	 * — it only remembers which task's eid the click named, and lets Obsidian's
	 * own link handling open the note, placing the cursor once the `file-open`
	 * that follows names the same note. Kept from #811 because the alternative,
	 * opening the note itself and stopping Obsidian's handler, would fight the
	 * link handling the ticket asked not to fight: a modifier-click into a new
	 * tab or a split, the hover preview and a middle-click would each need
	 * re-implementing.
	 *
	 * **When the collection is already open in a view somewhere — any window,
	 * main or popout — this does intercept the click** (ticket #905, the author's
	 * decision 2026-09-25): it stops Obsidian's own handling before it runs
	 * (`evt.preventDefault()` and `evt.stopPropagation()`, in the capture phase
	 * so this runs before whatever element Obsidian's own handler is bound to
	 * — {@link followEveryWindow} binds `onClick` with `capture: true` for
	 * exactly this), and instead reveals that view, makes it active and puts
	 * the cursor there ({@link jumpToOpenView}). Today's split-pane defect
	 * (`docs/acceptance-shots/issue-872-split-pane-click.txt`): without this,
	 * Obsidian opens a second view of the collection in the log's own pane,
	 * replacing the log, while the collection pane that was already open keeps
	 * its old cursor.
	 *
	 * **Except a Ctrl/Cmd-click, or Ctrl/Cmd-Alt-click**:
	 * `ctrlKey`/`metaKey` mean the person asked Obsidian for a new tab or a
	 * split, exactly the case the paragraph above kept unintercepted for a
	 * plain click, on the same reasoning — re-implementing it here would still
	 * be re-implementing Obsidian's own link handling. A modifier-click is
	 * therefore never stopped, whether or not the collection is already open
	 * elsewhere: it falls through to the ordinary pending-jump path below,
	 * exactly as when no open view is found.
	 *
	 * **The row is the one clicked, never the cursor's**, and each mode gives it
	 * its own way — `jump.ts`'s `livePreviewRowOf` and `readingRowOf` say how and
	 * cite the drive
	 * (`docs/acceptance-shots/issue-824-jump-click.txt`). In reading view that
	 * takes the context each rendered section was handed, which is why a post
	 * processor is registered here: `MarkdownPreviewRenderer.registerPostProcessor`
	 * (`node_modules/obsidian/obsidian.d.ts:4042`) and `unregisterPostProcessor`
	 * (`:4047`) are published, and `FeatureHost` needs no new route for them
	 * because this only records what it is handed.
	 *
	 * **Every open window has its own document, and the click is listened for on
	 * each**: the main
	 * one, every popout the workspace already holds a leaf in
	 * (`iterateAllLeaves`, `node_modules/obsidian/obsidian.d.ts:8009`), and any
	 * opened later (`window-open`, `:8090`), the shape `checkboxCycling.ts`'s
	 * `windowBodies` and its own `window-open` listener use. A window that closes
	 * (`window-close`, `:8096`) has its listener taken off.
	 */
	private watchJumpClicks(): void {
		const sections = new WeakMap<Element, MarkdownPostProcessorContext>();
		const recordSection = (el: HTMLElement, ctx: MarkdownPostProcessorContext): void => {
			sections.set(el, ctx);
		};
		MarkdownPreviewRenderer.registerPostProcessor(recordSection);
		this.register(() => MarkdownPreviewRenderer.unregisterPostProcessor(recordSection));
		this.redrawOpenReadingViews();

		const onClick = (evt: MouseEvent): void => {
			const clicked = linkClickedOn(evt.target);
			if (clicked === null) return;
			const pending = pendingJumpFor(clicked.label, this.clickedRow(clicked.mode, clicked.element, sections));
			if (pending === null) return;

			if (!evt.ctrlKey && !evt.metaKey) {
				const path = resolveCollectionPath(this.host.app, pending.linktext, pending.sourcePath);
				const openView = path === null ? null : findOpenCollectionView(this.host.app, path);
				if (openView !== null) {
					evt.preventDefault();
					evt.stopPropagation();
					void jumpToOpenView(this.host.app, openView, pending.eid, pending.linktext);
					return;
				}
			}

			this.pendingJump = pending;
			this.clearPendingJumpTimeout();
			this.pendingJumpTimeoutId = window.setTimeout(() => {
				this.pendingJumpTimeoutId = null;
				this.pendingJump = null;
			}, PENDING_JUMP_EXPIRY_MS);
		};
		this.followEveryWindow(onClick);
		this.register(() => this.clearPendingJumpTimeout());

		this.registerEvent(
			this.host.app.workspace.on("file-open", (file) => {
				const pending = this.pendingJump;
				if (pending === null || file === null) return;
				if (resolveCollectionPath(this.host.app, pending.linktext, pending.sourcePath) !== file.path) return;
				this.pendingJump = null;
				this.clearPendingJumpTimeout();
				const view = this.host.app.workspace.getActiveViewOfType(MarkdownView);
				if (view === null) return;
				if (placeCursorOn(view.editor, pending.eid) === "not-found") {
					new Notice(notFoundMessage(pending.linktext));
				}
			}),
		);
	}

	/**
	 * Puts `onClick` on the `document` of every open window and keeps it there
	 * exactly as long as that window is open. A document is bound once however
	 * many routes name it, so a click reaches the handler once.
	 *
	 * **In the capture phase**: a document-level capture listener
	 * runs before any bubble listener nearer the clicked element, wherever
	 * Obsidian binds its own link handling — the same reason
	 * `dayView/openMeeting.ts`'s `followAnchorDocument` binds its own tap
	 * listener this way. That ordering is what lets `onClick` call
	 * `preventDefault`/`stopPropagation` and actually stop Obsidian's default
	 * open, for the already-open-elsewhere case; the ordinary case, where
	 * `onClick` calls neither, behaves exactly as it did on the bubble phase.
	 */
	private followEveryWindow(onClick: (evt: MouseEvent) => void): void {
		const bound = new Map<Document, () => void>();
		const bind = (doc: Document): void => {
			if (bound.has(doc)) return;
			doc.addEventListener("click", onClick, true);
			bound.set(doc, () => doc.removeEventListener("click", onClick, true));
		};
		const unbind = (doc: Document): void => {
			bound.get(doc)?.();
			bound.delete(doc);
		};
		bind(document);
		this.host.app.workspace.iterateAllLeaves((leaf) => bind(leaf.getContainer().doc));
		this.registerEvent(this.host.app.workspace.on("window-open", (win) => bind(win.doc)));
		this.registerEvent(this.host.app.workspace.on("window-close", (win) => unbind(win.doc)));
		this.register(() => {
			for (const doc of [...bound.keys()]) unbind(doc);
		});
	}

	/**
	 * Draws every note open in reading view again, so the post processor just
	 * registered sees sections Obsidian drew before it existed: a
	 * note open when the feature is switched on, or restored before the plugin's
	 * `onload` ran, has no entry in the section map and its clicks would do
	 * nothing until it next re-rendered. `MarkdownView.previewMode`
	 * (`node_modules/obsidian/obsidian.d.ts:4194`) is published, as is
	 * `MarkdownPreviewView.rerender` (`:4088`); `iterateAllLeaves` (`:8009`)
	 * reaches a popout window's leaves too. A note in editing mode has no
	 * reading-view sections to redraw and is left alone.
	 */
	private redrawOpenReadingViews(): void {
		this.host.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.getMode() === "preview") view.previewMode.rerender(true);
		});
	}

	/**
	 * The row `element`'s click was on, read the way its mode gives it (see
	 * {@link watchJumpClicks}). The Live Preview branch asks the active view,
	 * and that is the clicked view because Obsidian has made the clicked pane
	 * active by the time `click` fires: read back with a real mouse click for a
	 * log beside an unrelated note, beside the open collection, and in a
	 * popout window over an unrelated main-window note, the log's leaf was the
	 * active one at `mousedown` and `click` each time
	 * (`docs/acceptance-shots/issue-872-split-pane-click.txt`, steps 1-3).
	 */
	private clickedRow(
		mode: "reading" | "live-preview",
		element: Element,
		sections: WeakMap<Element, MarkdownPostProcessorContext>,
	): ClickedRow | null {
		if (mode === "reading") return readingRowOf(element, sections);
		const view = this.host.app.workspace.getActiveViewOfType(MarkdownView);
		const sourcePath = view?.file?.path ?? null;
		if (view === null || sourcePath === null) return null;
		return livePreviewRowOf(element, view.editor, sourcePath);
	}

	private clearPendingJumpTimeout(): void {
		if (this.pendingJumpTimeoutId !== null) window.clearTimeout(this.pendingJumpTimeoutId);
		this.pendingJumpTimeoutId = null;
	}

	/**
	 * Starts (or restarts) the ten-second first-run timer, and the
	 * fifteen-minute interval the first time this is called within a load —
	 * the same shape meeting notes' own `runNow` keeps, for the same reason.
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
	 * One timer's firing: the periodic sweep (spec #709 decision 2's own
	 * ten-second-then-fifteen-minute cadence). Does nothing when this feature
	 * is not `ready` right now, or when a sweep is already in flight
	 * ({@link runSweepNow}'s own guard) — the same guard building the days
	 * ahead's and meeting notes' own `tick` keep.
	 */
	private tick(): void {
		if (this.readiness().state !== "ready") return;
		void this.runSweepNow();
	}

	/**
	 * `unavailable` beats everything else, always, whatever the daily-log
	 * layout says — spec #709 decision 14 and `CLAUDE.md`'s `Platform.isMobile`
	 * rule: read here, inside the check, never at module load, so a stub
	 * flipped between two checks is seen by both (`openMeeting.ts:22,330`).
	 *
	 * Below that, `unconfigured` when the daily-log folder or filename is
	 * unanswered — `dailyLogPrefix` throws in `dailyLogPath` without a
	 * folder, so the day view and building the days ahead read it the same
	 * way this feature does. **A blank tasks heading is not `unconfigured`**:
	 * the collections index treats it as "find nothing" (`collectionIn`'s own
	 * guard), and a person with a day's log and no collections yet is a
	 * working state of this feature — it has nothing to copy.
	 *
	 * `ready` otherwise: the today and overdue headings ship with defaults
	 * (spec #709 decision 5, added by #801), so nothing else needs answering.
	 * Never `standby` — this feature is not a per-device job. `failed` is the
	 * core's.
	 */
	readiness(): Readiness {
		if (Platform.isMobile) {
			return { state: "unavailable", reason: "Task consistency does not run on a phone." };
		}

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

		return { state: "ready" };
	}

	override displaySettings(containerEl: HTMLElement): void {
		renderTaskConsistencySettings(containerEl);
	}

	/** The slice exactly as `data.json` holds it — nothing yet, so this is only ever `{}`. */
	storedSlice(): Record<string, unknown> {
		return this.own.read();
	}
}
