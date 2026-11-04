/**
 * Undoing a filing while the collection is the note on screen
 * (#978, found driving
 * #906). The notice's *Undo
 * migration* button hands the undo no editor, and the day's log is in no tab: the
 * person jumped from the log to the collection. The collection is then the note the
 * note writer holds writes back from (ADR 0002), so a collection write queued on it
 * waits for the person to leave, while the log half, written first, lands. The undo
 * never answers, and the task is in both notes.
 *
 * The world here is the harness's, with one difference: the note writer is told the
 * collection is the note on screen, and a tab shows it. Every folder, name and task
 * is invented.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownView, Notice, WorkspaceLeaf } from "./__mocks__/obsidian";
import type { Plugin } from "./__mocks__/obsidian";
import { NoteWriter } from "../core/noteWriter";
import { undoFilings } from "../features/migration/undo";
import type { UndoWorld } from "../features/migration/undo";
import { FakeEditor, LOG, LOG_PATH, SHED, installMigrationHooks, lastChooser, read, startMigration } from "./migrationHarness";

installMigrationHooks();

const SHED_PATH = "Projects/Garden shed.md";

type CheckCallback = (checking: boolean, editor: FakeEditor, ctx: { file: { path: string } | null }) => boolean | void;

beforeEach(() => {
	Notice.messages.length = 0;
	Notice.fragments.length = 0;
});

/** Files line 2 of the log into Garden shed through the command; answers the id the frozen line carries and the texts either side of the filing. */
async function filed(): Promise<{ plugin: Plugin; id: string; collectionBefore: string; log: string; collection: string }> {
	const { plugin } = await startMigration({ log: LOG });
	const collectionBefore = await read(plugin, SHED_PATH);
	const editor = new FakeEditor(LOG, 2);
	const command = plugin.commands.find((each) => each.id === `${plugin.manifest.id}:file-task`);
	(command as unknown as { editorCheckCallback: CheckCallback }).editorCheckCallback(false, editor, { file: { path: LOG_PATH } });
	await lastChooser().chooseAt("shed", 0);
	await vi.waitFor(() => expect(Notice.messages.some((each) => each.startsWith("Put this task in"))).toBe(true));
	// The log was on screen for the filing; it is in no tab afterwards, so its text goes back into the vault.
	plugin.app.vault.readableContents()?.set(LOG_PATH, editor.getValue());
	const id = /migration:(\S+)/.exec(editor.getValue())?.[1];
	expect(id, "the frozen line carries no migration marker").toBeDefined();
	return { plugin, id: id as string, collectionBefore, log: editor.getValue(), collection: await read(plugin, SHED_PATH) };
}

/** What the undo answered, or `"parked"` when it had not answered after `ms`: a write held for the person to leave a note never does. */
async function answerOrParked(undo: Promise<string>, ms = 100): Promise<string> {
	return Promise.race([undo, new Promise<string>((settle) => setTimeout(() => settle("parked"), ms))]);
}

describe("#978: undo with the collection as the note on screen and no editor handed in", () => {
	// If wrong: the collection's write waits behind the hold on the open note, the
	// undo does not answer, and the collection still holds the task.
	it("takes the task out of the collection and puts the log line back, with no editor handed in", async () => {
		const { plugin, id, log, collection, collectionBefore } = await filed();
		expect(collection, "filing put nothing in the collection, so the test cannot fail").toContain("Order more tea");
		expect(log).toContain("[>] Order more tea");

		const collectionEditor = new FakeEditor(collection, 0);
		const view = new MarkdownView({ path: SHED_PATH }, collection);
		view.editor = collectionEditor as never;
		plugin.app.workspace.leaves.push(new WorkspaceLeaf(view));
		const world: UndoWorld = {
			app: plugin.app as never,
			notes: new NoteWriter(plugin.app.vault as never, { path: () => SHED_PATH, onChange: () => undefined }),
			collections: { all: () => [SHED] },
		};

		const said = await answerOrParked(undoFilings(world, LOG_PATH, [id], SHED_PATH, null));

		expect(said).toBe("Undone. The task is back in the day's log and no longer in Garden shed.");
		expect(await read(plugin, LOG_PATH)).toBe(LOG);
		expect(collectionEditor.getValue()).toBe(collectionBefore);
	});

	it("still undoes, through the note writer, when the collection is not the note on screen", async () => {
		const { plugin, id, collectionBefore } = await filed();
		const world: UndoWorld = {
			app: plugin.app as never,
			notes: new NoteWriter(plugin.app.vault as never, { path: () => null, onChange: () => undefined }),
			collections: { all: () => [SHED] },
		};

		const said = await answerOrParked(undoFilings(world, LOG_PATH, [id], SHED_PATH, null));

		expect(said).toBe("Undone. The task is back in the day's log and no longer in Garden shed.");
		expect(await read(plugin, LOG_PATH)).toBe(LOG);
		expect(await read(plugin, SHED_PATH)).toBe(collectionBefore);
	});

	// If wrong: an editor route that threw would show "The undo did not finish"
	// or reject the button's call; one that reported success would say "Undone",
	// and one that left the log restored while the collection kept its copy would
	// leave the task in both notes. Each fails one of the three assertions below.
	it("refuses in one Notice, and leaves the task in the day's log only, when the collection's copy changed since filing", async () => {
		const { plugin, log, collection } = await filed();
		// A copy the person has edited in the open tab and not yet saved: the vault
		// still holds the filed line, so the check before the write passes, and only
		// the editor route's own read, inside the write, sees the change.
		const edited = collection.replace("Order more tea", "Order more green tea");
		expect(edited, "the copy was not edited, so the test cannot fail").not.toBe(collection);
		const collectionEditor = new FakeEditor(edited, 0);
		const view = new MarkdownView({ path: SHED_PATH }, edited);
		view.editor = collectionEditor as never;
		plugin.app.workspace.leaves.push(new WorkspaceLeaf(view));
		Notice.messages.length = 0;

		const button = Notice.fragments[Notice.fragments.length - 1]?.querySelector("button");
		expect(button?.textContent, "the filing showed no notice with a button").toBe("Undo migration");
		button?.click();
		await vi.waitFor(() => expect(Notice.messages).not.toHaveLength(0));
		// Nothing more arrives late: one Notice for the one undo.
		await new Promise((settle) => setTimeout(settle, 50));

		expect(Notice.messages).toEqual(["The task in Garden shed was changed just now, so nothing was undone. The day's log and Garden shed are as they were."]);
		expect(await read(plugin, LOG_PATH)).toBe(log);
		expect(collectionEditor.getValue()).toBe(edited);
	});
});
