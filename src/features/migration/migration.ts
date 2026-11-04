/**
 * Migration: the feature itself, its switch, its settings slice and its
 * readiness.
 * #856 gave it its first
 * act: the command that files the task lines of the selection, or with none
 * the line the cursor is on, into a collection. `start()` is also what the
 * right-click entry runs, so both routes end in the same place.
 *
 * **It references no other feature**, and reads the daily-log layout and the tasks heading from the core.
 */

import { Notice } from "obsidian";
import type { Editor, TFile } from "obsidian";
import { isExcluded, noteName } from "../../core/collections";
import type { Collection } from "../../core/collections";
import { Feature } from "../../core/feature";
import type { Readiness } from "../../core/feature";
import { reasonOf } from "../../core/reason";
import { dailyLogPrefix, isDailyLogPath } from "../../core/vaultLayout";
import { CollectionChooser } from "./chooser";
import type { ChooserItem } from "./chooser";
import { askToMakeCollection } from "./confirmation";
import { linesToWrite, lineToFreeze, placeInCollection } from "./fileInto";
import { freezeInEditor } from "./editorFreeze";
import type { FiledLines } from "./fileInto";
import { newMigrationId } from "./marker";
import { frozenLineAt } from "./frozenLine";
import { jumpFromCursor } from "./jump";
import { fileEntry, jumpEntry, undoEntry } from "./menu";
import { PressedLineReader } from "./pressedLine";
import { RECENTLY_USED_CAP, moveToFront, orderByRecent, readRecentlyUsed } from "./recentlyUsed";
import { collectionBlock, planFiling, sameSubtree, selectedLineRange, skippedNotice } from "./selection";
import type { FilingItem } from "./selection";
import { sourceNoteOf } from "./filable";
import type { SourceNote } from "./filable";
import { withTasksHeading } from "./tasksHeading";
import { noticeWithUndo, undoFilings } from "./undo";
import { DEFAULT_MIGRATION_SETTINGS, FEATURE_ID } from "./types";
import type { MigrationSettings } from "./types";

/** The core card the settings named in the readiness sentences live on. */
const CORE_CARD = "Your day's logs";

const FILE_COMMAND_ID = "file-task";
const FILE_COMMAND_NAME = "Migration: file this task into a collection";

const JUMP_COMMAND_ID = "jump-filed";
const JUMP_COMMAND_NAME = "Migration: go to this task in its collection";

export class Migration extends Feature {
	readonly id = FEATURE_ID;

	readonly name = "Migration";

	readonly description = "Files a task into the collection it belongs to, from the notes heading of a day's log or from any note that is not a collection, and marks the original.";

	/**
	 * Taken here and used from `onload` onwards, as the feature contract asks.
	 * Holds the recently-used list, read when the chooser opens and written
	 * after a filing.
	 */
	private readonly own = this.host.settings<MigrationSettings>(DEFAULT_MIGRATION_SETTINGS);

	/**
	 * `unconfigured` when the daily-log folder or filename is blank, **or the
	 * tasks heading is blank**. That last check is the difference from Task
	 * consistency, which treats a blank tasks heading as a working state
	 * because it can run with nothing to copy: this feature has nothing to
	 * offer without a heading to file under.
	 *
	 * `ready` otherwise. **Never `unavailable`**: it runs on a phone, so this
	 * does not read `Platform.isMobile`. **Never `standby`**: it does nothing
	 * in the background, so it is not a per-device job. `failed` is the core's.
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
		if (!layout.tasksHeading.trim()) {
			return {
				state: "unconfigured",
				reason: `The tasks heading is not set. Enter it under Tasks heading on the ${CORE_CARD} card.`,
			};
		}

		return { state: "ready" };
	}

	/**
	 * Registers the command, with **no default hotkey**: Obsidian's plugin
	 * guidelines forbid one (`docs/research/obsidian-publishing-requirements.md:53`).
	 * Its check callback is only "there is a note", so a refusal is a `Notice`
	 * that says why rather than a command that is missing from the palette.
	 */
	override onload(): void {
		this.host.addCommand({
			id: FILE_COMMAND_ID,
			name: FILE_COMMAND_NAME,
			editorCheckCallback: (checking, editor, ctx) => {
				const file = ctx.file;
				if (file === null) return false;
				if (!checking) this.start(editor, file);
				return true;
			},
		});
		const jump = jumpFromCursor(this.host);
		this.host.addCommand({
			id: JUMP_COMMAND_ID,
			name: JUMP_COMMAND_NAME,
			editorCheckCallback: (checking, editor, ctx) => {
				const file = ctx.file;
				if (file === null || frozenLineAt(editor, file, this.host.core.layout, (path) => this.host.collections.at(path) !== null) === null) return false;
				if (!checking) jump(editor, file);
				return true;
			},
		});
		const reader = new PressedLineReader();
		this.register(reader.follow(this.host.app.workspace));
		const pressed = reader.lineOf;
		this.registerEvent(this.host.app.workspace.on("editor-menu", fileEntry(() => this.host.core.layout, (editor, file, lineIndex) => this.start(editor, file, lineIndex), pressed, (path) => this.host.collections.at(path) !== null)));
		this.registerEvent(this.host.app.workspace.on("editor-menu", jumpEntry(jump, () => this.host.core.layout, pressed, (path) => this.host.collections.at(path) !== null)));
		this.registerEvent(this.host.app.workspace.on("editor-menu", undoEntry(() => this.host.core.layout, (editor, file, id, lineIndex) => void this.undo(file, [id], null, editor, lineIndex), pressed, (path) => this.host.collections.at(path) !== null)));
	}

	/**
	 * What the command does up to the chooser: ask whether the cursor's line (or
	 * `lineIndex`, the line a right-click entry was pressed on) may be filed, and open the chooser only if it may. Every refusal is a `Notice`
	 * and changes nothing. Everything about the vault is read here, when the
	 * command runs, and never kept from an earlier run.
	 *
	 * The note first: a day's log, or any other note that is neither a
	 * collection, by the index as it stands now, nor under an excluded folder.
	 * The note a task comes from is called the source note below; in a day's log
	 * it is the day's log.
	 */
	private start(editor: Editor, file: TFile, lineIndex?: number): void {
		const readiness = this.readiness();
		if (readiness.state !== "ready") {
			new Notice("reason" in readiness ? `This is not set up yet. ${readiness.reason}` : "This is not set up yet.");
			return;
		}

		const layout = this.host.core.layout;
		const note = sourceNoteOf(file.path, (path) => this.host.collections.at(path) !== null, layout);
		if (!note.ok) {
			new Notice(note.reason);
			return;
		}
		const source = note.source;

		// The line the right-click entry was pressed on, else a selection, or with none the line the cursor is on: the same range.
		const { first, last } = lineIndex === undefined ? selectedLineRange(editor.getCursor("from"), editor.getCursor("to")) : { first: lineIndex, last: lineIndex };
		const plan = planFiling(editor.getValue(), first, last, layout, source);
		if (plan.skipped.length > 0) {
			// One line pressed on says its own reason; several are named in one notice.
			new Notice(plan.examined === 1 ? plan.skipped[0].reason : skippedNotice(plan.skipped));
		}
		if (plan.items.length === 0) return;

		const collections = this.host.collections.all();
		const recent = this.recentlyUsed(true);
		// A note the index would never call a collection (the day's log, or one
		// under an excluded folder) is not offered: a yes could write the heading
		// into it and leave it no collection. Read now, from the layout as it is.
		// Nor is the source note: filing into itself would make it a collection
		// holding a copy of its own frozen line.
		const notePaths = this.host.app.vault
			.getMarkdownFiles()
			.map((each) => each.path)
			.filter((path) => path !== file.path && !isDailyLogPath(path, layout) && !isExcluded(path, layout.excludedFolders));

		// With no collection the chooser still opens, so the first one can be made
		// by choosing a note; only a vault with nothing to offer is refused.
		if (collections.length === 0 && notePaths.length === 0) {
			new Notice("There is no collection yet. A note is a collection when it has the tasks heading.");
			return;
		}

		new CollectionChooser(this.host.app, orderByRecent(collections, recent), notePaths, (item) => {
			void this.fileChosen(editor, file, source, plan.items, item).catch((error: unknown) => {
				// Obsidian owns the chooser's callback, so a rejection escaping it
				// would surface nowhere a person looks.
				const said = plan.items.length === 1 ? "the task was not" : `the ${plan.items.length} tasks were not`;
				new Notice(`Effortless: ${said} put in ${item.name}. ${reasonOf(error)}`);
			});
		}).open();
	}

	/**
	 * What choosing a row does. A collection is filed into at once. **An
	 * ordinary note is asked about once, before any line is written**, and only a
	 * yes writes anything: the tasks heading goes in with every item, in the
	 * note's one write, so a selection gets one heading. No, Escape
	 * and a click outside all leave both files as they were, open nothing, and
	 * say so in a `Notice`.
	 *
	 * Whether the note is a collection is asked of the index now, not of the
	 * row: a note that became one while the chooser was open is filed into
	 * without a question.
	 */
	private async fileChosen(editor: Editor, log: TFile, source: SourceNote, items: readonly FilingItem[], item: ChooserItem): Promise<void> {
		if (item.isCollection || this.host.collections.at(item.path) !== null) {
			await this.file(editor, log, source, items, item, false);
			return;
		}

		const layout = this.host.core.layout;
		const yes = await askToMakeCollection(this.host.app, item.name, layout.tasksHeading);
		if (!yes) {
			new Notice(`Nothing was filed. ${item.name} was not made a collection, so the task stays where it is.`);
			return;
		}
		await this.file(editor, log, source, items, item, true);
	}

	/**
	 * The recently-used list as `data.json` holds it, read now. A value that is
	 * not a list of paths is refused: the list starts empty, and with `announce`
	 * a `Notice` says why. It is never replaced without saying (`CLAUDE.md`'s
	 * rule for a value read from `data.json`).
	 */
	private recentlyUsed(announce: boolean): string[] {
		const stored = this.own.read().recentlyUsed as unknown;
		const list = readRecentlyUsed(stored);
		if (list !== null) return list;
		if (announce) {
			new Notice("The list of recently used collections in the settings file is not a list of note paths, so the chooser starts without it.");
		}
		return [];
	}

	/** Moves `path` to the front of the list and saves it; a failed save is a `Notice`, never a failed filing. */
	private async remember(path: string): Promise<void> {
		try {
			const next = moveToFront(this.recentlyUsed(false), path, RECENTLY_USED_CAP);
			await this.own.save({ ...this.own.read(), recentlyUsed: next });
		} catch (error) {
			new Notice(`The task is filed, but the list of recently used collections could not be saved. ${reasonOf(error)}`);
		}
	}

	/**
	 * The writes, collection first: a refusal or a failure there leaves both
	 * files as they were, where writing the log first could leave a frozen line
	 * pointing at a collection that never got the task. **All the items go into
	 * the collection in one edit, in the log's order, each with its own id.**
	 *
	 * `log` is the source note: the day's log, or since #981 any other note the
	 * command was allowed to run in, and `source` says which. Both halves are the
	 * same for either — the link back names that note, and the frozen lines are
	 * written through the editor on it — and only the sentences differ.
	 *
	 * **The collection goes through `host.notes.edit`; the frozen lines go
	 * through the `editor` the command was run in.** The source note is the note
	 * on screen, and the core's writer would hold a write to it until the person
	 * left the note (`NoteWriter.edit`, whose head says work under the cursor
	 * does not come there). In that time the line would still read as a task
	 * that can be filed, and a second press would file it again (spec #716: the
	 * line changes on the press). So the log's lines change at once, last one
	 * first so the lines above keep their numbers, and the `Notice` "Put this
	 * task in X." comes after both halves. If the log's half cannot be written,
	 * the `Notice` says the collection has the task and the line was not marked.
	 */
	private async file(
		editor: Editor,
		log: TFile,
		source: SourceNote,
		items: readonly FilingItem[],
		chosen: Pick<Collection, "path" | "name">,
		writeHeading: boolean,
	): Promise<void> {
		const target = this.host.app.vault.getFileByPath(chosen.path);
		if (target === null) {
			new Notice(`${chosen.name} is not in the vault any more, so the task was not put there.`);
			return;
		}

		// The link is asked of the vault, not built from the name: two collections may
		// share one, and the frozen line must open the one the person chose. The
		// vault writes it as the person's link settings say — a wikilink or a
		// markdown link, its path "shortest", "relative" or "absolute"; only
		// "shortest" is the shortest link that is unambiguous (`obsidian.d.ts:2931`).
		const link = this.host.app.fileManager.generateMarkdownLink(target, log.path);
		// The mirror, back to the day's log: settled by the author on #906. Read
		// afresh here, the same as `link`, never guessed at from the collection's name.
		const logLink = this.host.app.fileManager.generateMarkdownLink(log, target.path);
		const filed = items.map((item) => linesToWrite(item.line, newMigrationId(), link, logLink));
		const landed = await this.addToCollection(target, items, filed, writeHeading);
		const placed = items.map((_, at) => at).filter((at) => landed[at]);
		if (placed.length === 0) return;
		await this.remember(chosen.path);

		const layout = this.host.core.layout;
		const reasons = new Set<string>();
		let notMarked = 0;
		const marked: string[] = [];
		for (const at of [...placed].reverse()) {
			try {
				const item = items[at];
				const lineAt = lineToFreeze(editor.getValue(), item.lineIndex, item.line, layout, source);
				if (lineAt === null || !sameSubtree(editor.getValue(), lineAt, item.subtree)) {
					notMarked += 1;
					reasons.add("The line was changed while you chose.");
					continue;
				}
				freezeInEditor(editor, lineAt, item.subtree.length, filed[at].frozenLine);
				marked.push(filed[at].id);
			} catch (error) {
				notMarked += 1;
				reasons.add(reasonOf(error));
			}
		}

		// The notice carries "Undo migration" whenever at least one line was marked:
		// only a marked line can be put back, and the button undoes exactly those
		// (the ids in `marked`, the last item first as they were written). A line
		// that was not marked has nothing in the day's log to restore, so a filing
		// where none was marked offers no button. The button runs the function the
		// right-click entry runs.
		const undo = marked.length === 0 ? null : (): void => void this.undo(log, [...marked].reverse(), chosen.path, null);
		const where = source.kind === "dailyLog" ? "the day's log" : noteName(log.path);
		let said: string;
		if (notMarked === 0) {
			said = placed.length === 1 ? `Put this task in ${chosen.name}.` : `Put ${placed.length} tasks in ${chosen.name}.`;
		} else {
			const why = [...reasons].join(" ");
			said =
				placed.length === 1
					? `The task is in ${chosen.name}, but its line in ${where} was not marked. ${why}`
					: `${placed.length} tasks are in ${chosen.name}, but ${notMarked} of their lines in ${where} ${notMarked === 1 ? "was" : "were"} not marked. ${why}`;
		}
		if (undo === null) new Notice(said);
		else noticeWithUndo(said, undo);
	}

	/**
	 * Undoes filings, whichever route asked: the notice's button (no editor: one on
	 * the source note is looked for, and the collection just written to is `hintPath`)
	 * or the right-click entry (the editor it was opened in, and the line pressed, the
	 * only one written: #995). Says in one `Notice`
	 * what happened; a failure is that notice too, never a rejection nobody sees.
	 */
	private async undo(log: Pick<TFile, "path">, ids: readonly string[], hintPath: string | null, editor: Editor | null, lineIndex?: number): Promise<void> {
		try {
			const layout = this.host.core.layout;
			// The note's kind is the rule filing and the menu entries ask, not a second reading of the path.
			const note = sourceNoteOf(log.path, (path) => this.host.collections.at(path) !== null, layout);
			if (!note.ok) {
				new Notice(`The undo did not finish. ${note.reason}`);
				return;
			}
			const said = await undoFilings(this.host, log.path, ids, hintPath, editor, note.source, { layout, lineIndex });
			new Notice(said);
		} catch (error) {
			new Notice(`The undo did not finish. ${reasonOf(error)}`);
		}
	}

	/**
	 * Writes the collection's half, one item after another over the text the
	 * last one left; with `writeHeading` the tasks heading is written once first,
	 * in the same edit. Answers, per item, whether it landed; an item the collection
	 * refuses is named in a `Notice` and left in the day's log.
	 */
	private async addToCollection(
		target: TFile,
		items: readonly FilingItem[],
		filed: readonly FiledLines[],
		writeHeading: boolean,
	): Promise<boolean[]> {
		const landed = items.map(() => false);
		const refusals: string[] = [];
		await this.host.notes.edit(target, (text) => {
			let current = writeHeading ? withTasksHeading(text, this.host.core.layout.tasksHeading) : text;
			// The first task to land is the one directly under the heading just written, so its marker records the heading too:
			// it is given the note as it was before the heading, and records everything filing added around it.
			let noteBefore: string | undefined = writeHeading ? text : undefined;
			landed.fill(false);
			refusals.length = 0;
			items.forEach((item, at) => {
				const placed = placeInCollection(current, collectionBlock(item, filed[at]), filed[at].meaning, this.host.core.layout, noteBefore);
				if (placed.ok) {
					current = placed.text;
					landed[at] = true;
					noteBefore = undefined;
				} else if (!refusals.includes(placed.reason)) {
					refusals.push(placed.reason);
				}
			});
			// Nothing landed: the note is left exactly as it was, heading included.
			return landed.some(Boolean) ? current : text;
		});
		if (refusals.length > 0) new Notice(refusals.join(" "));
		return landed;
	}

	/** The slice exactly as `data.json` holds it. */
	storedSlice(): Record<string, unknown> {
		return this.own.read() as unknown as Record<string, unknown>;
	}
}
