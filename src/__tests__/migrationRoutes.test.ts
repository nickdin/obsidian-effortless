/**
 * The two routes into filing, driven over one fixture: the palette command
 * and the right-click entry each file a task that has a sub-line into an ordinary
 * note, after the question is answered yes. Each must leave the same collection
 * text, the same frozen line in the open log and the same recently-used list.
 * Every folder, name and task is invented.
 */

import { describe, expect, it, vi } from "vitest";
import { Menu, Notice, Plugin } from "./__mocks__/obsidian";
import { parseTaskLine } from "../core/taskLine";
import { hashOfLine, headingKey } from "../features/migration/marker";
import {
	FakeEditor,
	LOG_PATH,
	PARTY_PATH,
	PARTY_TEXT,
	installMigrationHooks,
	lastAsk,
	lastChooser,
	openedChoosers,
	read,
	startMigration,
	storedRecent,
} from "./migrationHarness";
import { pressLineAwayFromCursor } from "./editorMenu";

installMigrationHooks();

const TASK = "- [ ] Order more tea";
const SUB_LINE = "  - the loose leaf kind";
const LOG_LINK = "[[2031-04-05]]";
const LOG = ["# Notes", "", TASK, SUB_LINE, "- [ ] Mend the gate", "", "## Today", "", "- [ ] Water the plants", ""].join("\n");

type CheckCallback = (checking: boolean, editor: FakeEditor, ctx: { file: { path: string } | null }) => boolean | void;

/** What one route left behind, with the filing's id replaced so two routes can be compared. */
interface Outcome {
	collection: string;
	frozenLog: string;
	recent: unknown;
	notices: string[];
}

function withoutId(text: string): string {
	return text.replace(/migration:\S+/g, "migration:<id>");
}

async function chooseThePartyNoteAndSayYes(plugin: Plugin, editor: FakeEditor): Promise<Outcome> {
	await lastChooser().chooseAt("party", 0);
	lastAsk().press("Yes, write the heading");
	await vi.waitFor(() => expect(Notice.messages.some((each) => each.startsWith("Put "))).toBe(true));
	return {
		collection: withoutId(await read(plugin, PARTY_PATH)),
		frozenLog: withoutId(editor.getValue()),
		recent: await storedRecent(plugin),
		notices: [...Notice.messages],
	};
}

async function throughTheCommand(): Promise<Outcome> {
	const { plugin } = await startMigration({ extraNotes: { [PARTY_PATH]: PARTY_TEXT }, log: LOG });
	const editor = new FakeEditor(LOG, 2);
	const command = plugin.commands.find((each) => each.id === `${plugin.manifest.id}:file-task`);
	expect(command, "the file-task command was not registered").toBeDefined();
	(command as unknown as { editorCheckCallback: CheckCallback }).editorCheckCallback(false, editor, { file: { path: LOG_PATH } });
	return chooseThePartyNoteAndSayYes(plugin, editor);
}

async function throughTheMenu(): Promise<Outcome> {
	const { plugin } = await startMigration({ extraNotes: { [PARTY_PATH]: PARTY_TEXT }, log: LOG });
	const editor = new FakeEditor(LOG, 2);
	const menu = new Menu();
	pressLineAwayFromCursor(editor, editor.getCursor().line);
	plugin.app.workspace.fire("editor-menu", menu, editor, { file: { path: LOG_PATH } });
	expect(menu.items, "the right-click entry was not added on a task line under the notes heading").toHaveLength(1);
	menu.items[0].click();
	expect(openedChoosers, "clicking the entry opened no chooser").toHaveLength(1);
	return chooseThePartyNoteAndSayYes(plugin, editor);
}

describe("filing a task with a sub-line into an ordinary note, by either route", () => {
	it("leaves the same collection text, the same frozen line and the same recently-used list", async () => {
		const hash = hashOfLine(parseTaskLine(TASK)!);
		const expected: Outcome = {
			collection: `${PARTY_TEXT}\n## Tasks\n\n${TASK} ${LOG_LINK} %% migration:<id> ${hash} _ L bhb/-@${headingKey("## Tasks")} %%\n${SUB_LINE}\n`,
			frozenLog: withoutId(LOG.replace(`${TASK}\n${SUB_LINE}`, `- [>] Order more tea [[Garden party]] %% migration:<id> ${hash} _ L %%`)),
			recent: [PARTY_PATH],
			notices: ["Put this task in Garden party."],
		};

		const viaCommand = await throughTheCommand();
		Notice.messages.length = 0;
		openedChoosers.length = 0;
		const viaMenu = await throughTheMenu();

		expect(viaCommand).toEqual(expected);
		expect(viaMenu).toEqual(expected);
	});
});
