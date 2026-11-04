/**
 * Undoing a filing while the filed task is untouched, over the
 * shared harness: the real registry, settings store and note writer over the
 * Obsidian stub. The log is the note on screen (a `FakeEditor`), the collection
 * is a file the vault holds, and every assertion compares whole texts. Every
 * folder, name and task is invented.
 *
 * **The composition** — files through #856's pure `fileInto` and undoes through
 * this ticket's functions over the same two texts — is "puts the log and the
 * collection back exactly as they were, over the texts #856's fileInto wrote";
 * the same over the real command and both routes is "undoes what the command
 * filed, byte for byte, for an open task, a done task and a task with a
 * subtree".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Menu, MarkdownView, Notice, Plugin, WorkspaceLeaf } from "./__mocks__/obsidian";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { fileInto, linesToWrite } from "../features/migration/fileInto";
import { JUMP_ENTRY_TITLE, UNDO_ENTRY_TITLE } from "../features/migration/menu";
import { canUndo, readFiled, readFrozen, readMarker, removeFromCollection, restoreInLog, restoredLines } from "../features/migration/undo";
import { FakeEditor, LOG_PATH, installMigrationHooks, lastChooser, read, startMigration } from "./migrationHarness";
import { pressLineAwayFromCursor } from "./editorMenu";

installMigrationHooks();

const SHED_PATH = "Projects/Garden shed.md";
const TEA = "- [ ] Order more tea";
const GATE = "- [ ] Mend the gate";
const SUB_LINE = "  - the loose leaf kind";

const LOG_LINK = "[[2031-04-05]]";
const LOG = ["# Notes", "", TEA, GATE, "", "## Today", "", "- [ ] Water the plants", ""].join("\n");
const LOG_WITH_SUBTREE = ["# Notes", "", TEA, SUB_LINE, GATE, "", "## Today", "", "- [ ] Water the plants", ""].join("\n");
const LOG_WITH_DONE = ["# Notes", "", "- [x] Order more tea", GATE, "", "## Today", "", "- [ ] Water the plants", ""].join("\n");

beforeEach(() => {
	Notice.fragments.length = 0;
	Notice.hidden = 0;
});

/** A log on screen where the cursor, or a selection, is on lines `from` to `to`. */
class RangeEditor extends FakeEditor {
	constructor(
		text: string,
		private readonly from: number,
		private readonly to: number = from,
	) {
		super(text, from);
	}
	override getCursor(which?: string): { line: number; ch: number } {
		return which === "to" ? { line: this.to, ch: 1 } : { line: this.from, ch: 0 };
	}
}

/** An editor whose writes are refused, so a filing's log half fails after the collection's landed. */
class RefusingEditor extends FakeEditor {
	override setLine(): void {
		throw new Error("the editor is read-only");
	}
}

function layout(): VaultLayout {
	const data = defaultData();
	return { ...data.core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };
}

type CheckCallback = (checking: boolean, editor: FakeEditor, ctx: { file: { path: string } | null }) => boolean | void;

/** Puts the note on screen, the way Obsidian's own workspace holds an open note. */
function showOnScreen(plugin: Plugin, editor: FakeEditor): void {
	const view = new MarkdownView({ path: LOG_PATH }, editor.getValue());
	view.editor = editor as never;
	plugin.app.workspace.leaves.push(new WorkspaceLeaf(view));
}

interface Filed {
	plugin: Plugin;
	editor: FakeEditor;
	/** The collection's text before the filing. */
	collectionBefore: string;
}

/** Files what the editor's selection holds into the Garden shed collection, through the command, and waits for the notice. */
async function fileThroughTheCommand(log: string, editor: FakeEditor): Promise<Filed> {
	const { plugin } = await startMigration({ log });
	const collectionBefore = await read(plugin, SHED_PATH);
	const command = plugin.commands.find((each) => each.id === `${plugin.manifest.id}:file-task`);
	expect(command, "the file-task command was not registered").toBeDefined();
	(command as unknown as { editorCheckCallback: CheckCallback }).editorCheckCallback(false, editor, { file: { path: LOG_PATH } });
	await lastChooser().chooseAt("shed", 0);
	await vi.waitFor(() => expect(Notice.messages.length).toBeGreaterThan(0));
	return { plugin, editor, collectionBefore };
}

/** Right-clicks the frozen line the editor's cursor is on and chooses the undo entry. */
function undoThroughTheMenu(plugin: Plugin, editor: FakeEditor): void {
	const menu = new Menu();
	pressLineAwayFromCursor(editor, editor.getCursor().line);
	plugin.app.workspace.fire("editor-menu", menu, editor, { file: { path: LOG_PATH } });
	const entry = menu.items.find((each) => each.title === "Undo migration");
	expect(entry, "the undo entry was not added on the frozen line").toBeDefined();
	entry?.click();
}

/** Presses the button of the last filing notice. */
function undoThroughTheNotice(): void {
	const notice = Notice.fragments[Notice.fragments.length - 1];
	expect(notice, "the filing showed no notice with a button").toBeDefined();
	const button = notice.querySelector("button");
	expect(button?.textContent).toBe("Undo migration");
	button?.click();
}

const undidOrRefused = (): boolean => Notice.messages.some((each) => each.startsWith("Undone") || each.includes("nothing was undone") || each.includes("did not finish"));

describe("canUndo", () => {
	const filed = linesToWrite(TEA, "abc123", "[[Garden shed]]", LOG_LINK).collectionLine;
	const hash = readMarker(filed)?.hash ?? "";

	it("is true for the line as it was filed", () => {
		// A canUndo that always answered false would fail here; one that always answered true, on the next two.
		expect(hash).not.toBe("");
		expect(canUndo(filed, hash)).toBe(true);
	});

	it("is false for a reworded line", () => {
		expect(canUndo(filed.replace("tea", "coffee"), hash)).toBe(false);
	});

	it("is false for a ticked line", () => {
		expect(canUndo(filed.replace("[ ]", "[x]"), hash)).toBe(false);
	});

	it("is still true when the link back's own text has changed, as Obsidian rewrites it renaming the day's log", () => {
		// Nothing the person did: the hash covers the link back masked out the same
		// way the marker itself is, so a link Obsidian rewrote never reads as touched.
		const renamed = filed.replace(LOG_LINK, "[[2031-04-06]]");
		expect(renamed).not.toBe(filed);
		expect(canUndo(renamed, hash)).toBe(true);
	});
});

describe("restoredLines takes the link back off", () => {
	it("removes the link back along with the marker, giving the bare original line", () => {
		const line = "- [ ] Order more tea [[2031-04-05]] %% migration:abc123 00000000 _ L %%";

		expect(restoredLines({ line, subtree: [], prefix: "" })).toEqual(["- [ ] Order more tea"]);
	});

	it("leaves a person's own link earlier on the line alone, dropping only the one right before the marker", () => {
		const line = "- [ ] Call Bob [[Bob]] and then [[2031-04-05]] %% migration:abc123 00000000 _ L %%";

		expect(restoredLines({ line, subtree: [], prefix: "" })).toEqual(["- [ ] Call Bob [[Bob]] and then"]);
	});

	it("leaves a person's own trailing link alone when the marker does not record one: a filing made before that marker word existed", () => {
		const line = "- [ ] Call Bob [[Bob]] %% migration:abc123 00000000 _ %%";

		expect(restoredLines({ line, subtree: [], prefix: "" })).toEqual(["- [ ] Call Bob [[Bob]]"]);
	});
});

describe("undoing over the texts #856's fileInto wrote", () => {
	// The one test that runs both modules together: #856's `fileInto` writes the two
	// texts, this ticket's functions put them back. Were the undo to read the log
	// wrongly, the restored text would differ from `LOG`; were `fileInto` a no-op the
	// first assertion would say so.
	it("puts the log and the collection back exactly as they were", () => {
		const collection = ["# Garden shed", "", "## Tasks", "", "- [ ] Sweep the floor", "", "## Notes", "", "Words.", ""].join("\n");
		const filed = fileInto({ logText: LOG, lineIndex: 2, collectionText: collection, collectionLink: "[[Garden shed]]", logLink: LOG_LINK, id: "abc123", layout: layout() });
		if (!filed.ok) throw new Error(filed.reason);
		expect(filed.log).not.toBe(LOG);
		expect(filed.collection).not.toBe(collection);

		const frozen = readFrozen(filed.log, "abc123");
		expect(frozen?.collectionName).toBe("Garden shed");
		const inCollection = readFiled(filed.collection, "abc123", frozen?.hash ?? "", frozen?.indent ?? "");
		if (frozen === null || !inCollection.ok) throw new Error("the filing was not found again");

		expect(restoreInLog(filed.log, frozen, restoredLines(inCollection))).toBe(LOG);
		expect(removeFromCollection(filed.collection, inCollection)).toBe(collection);
	});
});

describe("the log line comes back byte for byte, whatever the line carried", () => {
	// Each shape is one a person writes and a naive rebuild would change: indentation the
	// collection's copy does not keep, dates, a tag and a priority, trailing spaces, a tab.
	it.each([
		["indentation", "  - [ ] Order more tea"],
		["a tab for indentation", "\t- [ ] Order more tea"],
		["dates, a tag and a priority", "- [ ] Order more tea \u23EB #home \u23F3 2031-04-06 \ud83d\udcc5 2031-04-08"],
		["trailing spaces", "- [ ] Order more tea  "],
		["a cancelled checkbox", "- [-] Order more tea"],
		["a starred bullet", "* [ ] Order more tea"],
	])("with %s", (_, task) => {
		const log = ["# Notes", "", task, ""].join("\n");
		const collection = ["# Garden shed", "", "## Tasks", "", "- [ ] Sweep the floor", ""].join("\n");
		const filed = fileInto({ logText: log, lineIndex: 2, collectionText: collection, collectionLink: "[[Garden shed]]", logLink: LOG_LINK, id: "abc123", layout: layout() });
		if (!filed.ok) throw new Error(filed.reason);
		expect(filed.log).not.toBe(log);

		const frozen = readFrozen(filed.log, "abc123");
		const inCollection = readFiled(filed.collection, "abc123", frozen?.hash ?? "", frozen?.indent ?? "");
		if (frozen === null || !inCollection.ok) throw new Error(`the filing was not found again: ${JSON.stringify(inCollection)}`);

		expect(restoreInLog(filed.log, frozen, restoredLines(inCollection))).toBe(log);
	});
});

describe("undoing what the command filed, through the right-click entry", () => {
	it("restores an open task byte for byte", async () => {
		const { plugin, editor, collectionBefore } = await fileThroughTheCommand(LOG, new FakeEditor(LOG, 2));
		// Filed: the log and the collection both differ, so an undo that wrote nothing would fail below.
		expect(editor.getValue()).not.toBe(LOG);
		expect(await read(plugin, SHED_PATH)).not.toBe(collectionBefore);

		undoThroughTheMenu(plugin, editor);
		await vi.waitFor(() => expect(undidOrRefused()).toBe(true));

		expect(editor.getValue()).toBe(LOG);
		expect(await read(plugin, SHED_PATH)).toBe(collectionBefore);
		expect(Notice.messages[Notice.messages.length - 1]).toBe("Undone. The task is back in the day's log and no longer in Garden shed.");
	});

	it("restores an indented task with a subtree byte for byte, though the collection's copy lost the indentation", async () => {
		const log = ["# Notes", "", "  - [ ] Order more tea", "    - the loose leaf kind", GATE, ""].join("\n");
		const { plugin, editor, collectionBefore } = await fileThroughTheCommand(log, new FakeEditor(log, 2));
		// The copy is written without the top line's indentation, so the hash must be read with it given back.
		expect(await read(plugin, SHED_PATH)).toContain("\n- [ ] Order more tea [[2031-04-05]] %% migration:");

		undoThroughTheMenu(plugin, editor);
		await vi.waitFor(() => expect(undidOrRefused()).toBe(true));

		expect(editor.getValue()).toBe(log);
		expect(await read(plugin, SHED_PATH)).toBe(collectionBefore);
	});

	it("restores a done task byte for byte, and takes it out of the completed-tasks heading", async () => {
		const { plugin, editor } = await fileThroughTheCommand(LOG_WITH_DONE, new FakeEditor(LOG_WITH_DONE, 2));
		expect(editor.getValue()).not.toBe(LOG_WITH_DONE);
		expect(await read(plugin, SHED_PATH)).toContain("- [x] Order more tea [[2031-04-05]] %% migration:");

		undoThroughTheMenu(plugin, editor);
		await vi.waitFor(() => expect(undidOrRefused()).toBe(true));

		expect(editor.getValue()).toBe(LOG_WITH_DONE);
		expect(await read(plugin, SHED_PATH)).not.toContain("Order more tea");
	});

	it("restores a task with a subtree byte for byte, and takes the subtree out of the collection", async () => {
		const { plugin, editor, collectionBefore } = await fileThroughTheCommand(LOG_WITH_SUBTREE, new FakeEditor(LOG_WITH_SUBTREE, 2));
		expect(editor.getValue()).not.toContain("the loose leaf kind");
		expect(await read(plugin, SHED_PATH)).toContain(`\n${SUB_LINE}\n`);

		undoThroughTheMenu(plugin, editor);
		await vi.waitFor(() => expect(undidOrRefused()).toBe(true));

		expect(editor.getValue()).toBe(LOG_WITH_SUBTREE);
		expect(await read(plugin, SHED_PATH)).toBe(collectionBefore);
	});
});

describe("a refused undo", () => {
	/** Files the tea, then lets `change` alter the collection's text, and undoes through the menu. */
	async function refusedAfter(change: (collection: string) => string): Promise<{ log: string; collection: string; before: { log: string; collection: string }; said: string }> {
		const { plugin, editor } = await fileThroughTheCommand(LOG, new FakeEditor(LOG, 2));
		plugin.app.vault.readableContents()?.set(SHED_PATH, change(await read(plugin, SHED_PATH)));
		const before = { log: editor.getValue(), collection: await read(plugin, SHED_PATH) };

		undoThroughTheMenu(plugin, editor);
		await vi.waitFor(() => expect(undidOrRefused()).toBe(true));
		return { log: editor.getValue(), collection: await read(plugin, SHED_PATH), before, said: Notice.messages[Notice.messages.length - 1] };
	}

	it.each([
		["reworded", (text: string) => text.replace("Order more tea", "Order more coffee")],
		["ticked", (text: string) => text.replace("- [ ] Order more tea", "- [x] Order more tea")],
		["gone", (text: string) => text.replace(/- \[ \] Order more tea[^\n]*\n/, "")],
	])("leaves both files byte-identical and names the collection when the task was %s", async (_, change) => {
		const { log, collection, before, said } = await refusedAfter(change);

		expect(log).toBe(before.log);
		expect(collection).toBe(before.collection);
		expect(said).toContain("Garden shed");
		expect(said).toContain("nothing was undone");
		// The frozen line is still frozen: the refusal did not half-restore it.
		expect(log).toContain("[>] Order more tea [[Garden shed]]");
	});
});

describe("the notice and the entry run the same function", () => {
	// Two fresh runs of one filing, undone once by each route: the notice's button (the
	// log open on screen, found by the function itself) and the right-click entry (the
	// editor the menu was opened in). Both end with the log and the collection as they
	// were and the same sentence, and each is first shown to differ from that.
	it("leaves the same log, the same collection and the same notice by either route", async () => {
		const viaNotice = await fileThroughTheCommand(LOG, new FakeEditor(LOG, 2));
		showOnScreen(viaNotice.plugin, viaNotice.editor);
		expect(viaNotice.editor.getValue()).not.toBe(LOG);
		undoThroughTheNotice();
		await vi.waitFor(() => expect(undidOrRefused()).toBe(true));
		const noticeOutcome = {
			log: viaNotice.editor.getValue(),
			collection: await read(viaNotice.plugin, SHED_PATH),
			said: Notice.messages[Notice.messages.length - 1],
		};

		Notice.messages.length = 0;
		Notice.fragments.length = 0;
		const viaMenu = await fileThroughTheCommand(LOG, new FakeEditor(LOG, 2));
		expect(viaMenu.editor.getValue()).not.toBe(LOG);
		undoThroughTheMenu(viaMenu.plugin, viaMenu.editor);
		await vi.waitFor(() => expect(undidOrRefused()).toBe(true));
		const menuOutcome = {
			log: viaMenu.editor.getValue(),
			collection: await read(viaMenu.plugin, SHED_PATH),
			said: Notice.messages[Notice.messages.length - 1],
		};

		expect(noticeOutcome).toEqual({ log: LOG, collection: viaNotice.collectionBefore, said: "Undone. The task is back in the day's log and no longer in Garden shed." });
		expect(menuOutcome).toEqual(noticeOutcome);
	});

	it("hides the notice when its button is pressed", async () => {
		const { plugin, editor } = await fileThroughTheCommand(LOG, new FakeEditor(LOG, 2));
		showOnScreen(plugin, editor);
		expect(Notice.hidden).toBe(0);
		undoThroughTheNotice();
		expect(Notice.hidden).toBe(1);
	});
});

describe("which editor the log half is written through", () => {
	it("goes through the editor of a tab showing the day's log, and never through the note writer", async () => {
		const { plugin, editor } = await fileThroughTheCommand(LOG, new FakeEditor(LOG, 2));
		showOnScreen(plugin, editor);
		const vaultLogBefore = await read(plugin, LOG_PATH);

		undoThroughTheNotice();
		await vi.waitFor(() => expect(undidOrRefused()).toBe(true));

		// The editor holds the restored text; the file on disk was not written by the writer.
		expect(editor.getValue()).toBe(LOG);
		expect(await read(plugin, LOG_PATH)).toBe(vaultLogBefore);
	});

	it("falls back to the note writer when no tab shows the day's log", async () => {
		const { plugin, editor } = await fileThroughTheCommand(LOG, new FakeEditor(LOG, 2));
		// The log was saved with the frozen line and then closed: only the file holds it now.
		plugin.app.vault.readableContents()?.set(LOG_PATH, editor.getValue());
		const editorBefore = editor.getValue();

		undoThroughTheNotice();
		await vi.waitFor(() => expect(undidOrRefused()).toBe(true));

		expect(await read(plugin, LOG_PATH)).toBe(LOG);
		expect(editor.getValue()).toBe(editorBefore);
	});
});

describe("the notice a filing ends with", () => {
	it("undoes every task of a selection with one press", async () => {
		const { plugin, editor, collectionBefore } = await fileThroughTheCommand(LOG, new RangeEditor(LOG, 2, 3));
		expect(Notice.messages[0]).toBe("Put 2 tasks in Garden shed.");
		showOnScreen(plugin, editor);

		undoThroughTheNotice();
		await vi.waitFor(() => expect(undidOrRefused()).toBe(true));

		expect(editor.getValue()).toBe(LOG);
		expect(await read(plugin, SHED_PATH)).toBe(collectionBefore);
		expect(Notice.messages[Notice.messages.length - 1]).toBe("Undone for 2 tasks.");
	});

	it("carries no button when the day's log line could not be marked, since there is nothing to put back", async () => {
		await fileThroughTheCommand(LOG, new RefusingEditor(LOG, 2));

		expect(Notice.messages[0]).toContain("was not marked");
		expect(Notice.fragments).toHaveLength(0);
	});
});

describe("the right-click entry", () => {
	function menuOn(plugin: Plugin, editor: FakeEditor): Menu {
		const menu = new Menu();
		pressLineAwayFromCursor(editor, editor.getCursor().line);
		plugin.app.workspace.fire("editor-menu", menu, editor, { file: { path: LOG_PATH } });
		return menu;
	}
	const titles = (menu: Menu): string[] => menu.items.map((each) => each.title);

	it("is offered on a frozen line and not on a task that was never filed", async () => {
		const { plugin, editor } = await fileThroughTheCommand(LOG, new FakeEditor(LOG, 2));
		expect(titles(menuOn(plugin, editor))).toContain("Undo migration");

		// The gate, on line 3, was never filed: it carries no marker.
		expect(titles(menuOn(plugin, new FakeEditor(editor.getValue(), 3)))).not.toContain("Undo migration");
	});

	it("sits beside the jump entry on a frozen line, once each, as Migration.onload registers both", async () => {
		// The wave's composition of #861 and #862 in one menu handler: with either
		// registration line missing, or one doubled, the titles differ. The filing
		// entry is not offered there: the command would refuse a frozen line.
		const { plugin, editor } = await fileThroughTheCommand(LOG, new FakeEditor(LOG, 2));
		expect(titles(menuOn(plugin, editor))).toEqual([JUMP_ENTRY_TITLE, UNDO_ENTRY_TITLE]);
	});

	it("is not offered on a frozen line whose marker has gone", async () => {
		const { plugin, editor } = await fileThroughTheCommand(LOG, new FakeEditor(LOG, 2));
		const unmarked = editor.getValue().replace(/ %% migration:\S+ \S+ \S+ \S+ %%/, "");

		expect(titles(menuOn(plugin, new FakeEditor(unmarked, 2)))).not.toContain("Undo migration");
	});

	it("is not offered inside a fenced block", async () => {
		const { plugin, editor } = await fileThroughTheCommand(LOG, new FakeEditor(LOG, 2));
		const frozenLine = editor.getValue().split("\n")[2];
		const fenced = ["# Notes", "", "```", frozenLine, "```", ""].join("\n");

		expect(titles(menuOn(plugin, new FakeEditor(fenced, 3)))).not.toContain("Undo migration");
	});
});
