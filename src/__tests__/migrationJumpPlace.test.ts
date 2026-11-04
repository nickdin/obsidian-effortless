/**
 * Where the jump is offered
 * (#877, found against
 * #861; the same defect as
 * #879): on the frozen line
 * in a day's log, that is a task line marked `[>]` carrying this feature's
 * marker outside a fenced block, and nowhere else. The copy a filing writes
 * into the collection carries the same marker and no link, so a jump offered
 * there answers "names no collection", or, with a link in the task's own words,
 * files a standing problem for a filing that is not broken.
 *
 * Run through the real registry: the right-click entry is what `Menu` receives
 * from the `editor-menu` event, the command is what the palette asks. Every
 * folder, name and task is invented.
 */

import { describe, expect, it } from "vitest";
import { Menu } from "./__mocks__/obsidian";
import type { Plugin } from "./__mocks__/obsidian";
import { canJumpFrom } from "../features/migration/jump";
import { JUMP_ENTRY_TITLE } from "../features/migration/menu";
import { FakeEditor, LOG_PATH, installMigrationHooks, startMigration } from "./migrationHarness";
import { pressLine } from "./editorMenu";

installMigrationHooks();

const SHED_PATH = "Projects/Garden shed.md";
const MARKER = "%% migration:k1abcd 0a1b2c3d %%";
const FROZEN = `- [>] Order more tea [[Garden shed]] ${MARKER}`;
const COPY = `- [ ] Order more tea ${MARKER}`;
const COPY_WITH_LINK = `- [ ] Ask [[Aunt Maria]] about tea ${MARKER}`;

const LOG = ["# Notes", "", FROZEN, "", "## Today", ""].join("\n");
const COLLECTION = (line: string): string => ["# Garden shed", "", "## Tasks", "", line, ""].join("\n");
const FENCED = ["# Notes", "", "```", FROZEN, "```", ""].join("\n");

type CheckCallback = (checking: boolean, editor: FakeEditor, ctx: { file: { path: string } | null }) => boolean | void;

/** The titles the right-click menu holds when it opens on `line` of `text`, in the note at `path`. */
function entriesAt(plugin: Plugin, text: string, line: number, path: string): string[] {
	const menu = new Menu();
	plugin.app.workspace.fire("editor-menu", menu, pressLine(new FakeEditor(text, line === 0 ? 1 : 0), line), { file: { path } });
	return menu.items.map((each) => each.title);
}

/** Whether the palette would list the jump command with the cursor on `line` of `text`, in the note at `path`. */
function commandEnabledAt(plugin: Plugin, text: string, line: number, path: string): boolean {
	const command = plugin.commands.find((each) => each.id === `${plugin.manifest.id}:jump-filed`);
	if (command === undefined) throw new Error("the jump command was not registered");
	return (command as unknown as { editorCheckCallback: CheckCallback }).editorCheckCallback(true, new FakeEditor(text, line), { file: { path } }) === true;
}

describe("canJumpFrom", () => {
	// The copy in the collection is the same text with the checkbox open; a `canJumpFrom`
	// that asked only for the marker answers true for it, as a95f199's does.
	it("is true for the frozen line and false for the collection's own copy of the task", () => {
		expect(canJumpFrom(FROZEN)).toBe(true);
		expect(canJumpFrom(COPY)).toBe(false);
		expect(canJumpFrom(COPY_WITH_LINK)).toBe(false);
	});
});

describe("the jump entry and command", () => {
	// The frozen line in a day's log is the one place both are offered; without it the
	// rest of this file would pass for a gate that offers nothing anywhere.
	it("are offered on the frozen line in a day's log", async () => {
		const { plugin } = await startMigration({ log: LOG });
		expect(entriesAt(plugin, LOG, 2, LOG_PATH)).toContain(JUMP_ENTRY_TITLE);
		expect(commandEnabledAt(plugin, LOG, 2, LOG_PATH)).toBe(true);
	});

	it.each([
		["the copy in the collection, with no link", COPY],
		["the copy in the collection, with a link in the task's own words", COPY_WITH_LINK],
		["a frozen-looking line in a note that is not a day's log", FROZEN],
	])("are not offered on %s", async (_, line) => {
		const { plugin } = await startMigration({ log: LOG });
		const text = COLLECTION(line);

		expect(entriesAt(plugin, text, 4, SHED_PATH)).not.toContain(JUMP_ENTRY_TITLE);
		expect(commandEnabledAt(plugin, text, 4, SHED_PATH)).toBe(false);
	});

	it("are not offered on the copy even when it sits in a day's log", async () => {
		const { plugin } = await startMigration({ log: LOG });
		const text = ["# Notes", "", COPY, ""].join("\n");

		expect(entriesAt(plugin, text, 2, LOG_PATH)).not.toContain(JUMP_ENTRY_TITLE);
		expect(commandEnabledAt(plugin, text, 2, LOG_PATH)).toBe(false);
	});

	it("are not offered inside a fenced block of a day's log", async () => {
		const { plugin } = await startMigration({ log: LOG });

		expect(entriesAt(plugin, FENCED, 3, LOG_PATH)).not.toContain(JUMP_ENTRY_TITLE);
		expect(commandEnabledAt(plugin, FENCED, 3, LOG_PATH)).toBe(false);
	});
});
