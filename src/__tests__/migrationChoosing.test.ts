/**
 * Choosing an ordinary note that is not a collection yet, asked about first. Each test runs the
 * command from the palette through the real chooser, the question, #856's
 * `checkFilable` and `fileInto` halves and the real settings store, and reads both
 * notes' whole texts back. The composition test is "yes: writes the tasks heading
 * at the note's end, files the task under it, and freezes the log line".
 */

import { expect, it, describe, vi } from "vitest";
import { ConfirmationModal, Notice } from "./__mocks__/obsidian";
import { hashOfLine, headingKey } from "../features/migration/marker";
import { parseTaskLine } from "../core/taskLine";
import {
	ATTIC,
	KITCHEN,
	LOG,
	LOG_PATH,
	PARTY_PATH,
	PARTY_TEXT,
	SHED,
	TEA,
	asks,
	fileInto,
	installMigrationHooks,
	lastAsk,
	lastChooser,
	openedChoosers,
	pathsFor,
	read,
	run,
	startMigration,
	storedRecent,
} from "./migrationHarness";

installMigrationHooks();

const LOG_LINK = "[[2031-04-05]]";

describe("filing into a note that is not a collection yet", () => {
	it("draws the note in only once something is typed, after every matching collection", async () => {
		const { plugin } = await startMigration({ extraNotes: { [PARTY_PATH]: PARTY_TEXT } });

		run(plugin, 2);

		// The day's log is a Markdown note in the vault too, and is never offered.
		expect(pathsFor(lastChooser(), "")).toEqual([ATTIC.path, SHED.path, KITCHEN.path]);
		expect(pathsFor(lastChooser(), "garden")).toEqual([SHED.path, PARTY_PATH]);
	});

	it("yes: writes the tasks heading at the note's end, files the task under it, and freezes the log line", async () => {
		const { plugin } = await startMigration({ extraNotes: { [PARTY_PATH]: PARTY_TEXT } });
		// The stored hash is of the task's own bare words: the link back is masked
		// out the way the marker itself is, not folded into what is hashed.
		const hash = hashOfLine(parseTaskLine(TEA)!);

		run(plugin, 2);
		await lastChooser().chooseAt("party", 0);

		// The question is open and nothing has been written to either note yet.
		expect(lastAsk().contentEl.textContent).toContain("Garden party");
		expect(await read(plugin, PARTY_PATH)).toBe(PARTY_TEXT);
		expect(Notice.messages).toEqual([]);

		lastAsk().press("Yes, write the heading");
		await vi.waitFor(() => expect(Notice.messages).toHaveLength(1));

		const written = await read(plugin, PARTY_PATH);
		const id = /migration:(\S+) /.exec(written)?.[1];
		expect(id).toMatch(/^[0-9a-z]{9,}$/);
		expect(written).toBe(`${PARTY_TEXT}\n## Tasks\n\n${TEA} ${LOG_LINK} %% migration:${id} ${hash} _ L bhb/-@${headingKey("## Tasks")} %%\n`);
		expect(Notice.messages).toEqual(["Put this task in Garden party."]);
	});

	it.each([
		["the no button", (ask: ConfirmationModal) => ask.press("No")],
		["Escape or a click outside", (ask: ConfirmationModal) => ask.dismiss()],
	])("%s: writes nothing to either note, opens no second chooser, and says nothing was filed", async (_name, act) => {
		const { plugin } = await startMigration({ extraNotes: { [PARTY_PATH]: PARTY_TEXT } });

		run(plugin, 2);
		await lastChooser().chooseAt("party", 0);
		act(lastAsk());
		await vi.waitFor(() => expect(Notice.messages).toHaveLength(1));

		expect(Notice.messages[0]).toContain("Nothing was filed");
		expect(Notice.messages[0]).toContain("Garden party");
		expect(await read(plugin, PARTY_PATH)).toBe(PARTY_TEXT);
		expect(await read(plugin, LOG_PATH)).toBe(LOG);
		expect(openedChoosers).toHaveLength(1);
		expect(await storedRecent(plugin)).toBeUndefined();
	});

	it("never asks about a collection, and never writes a second tasks heading into one", async () => {
		const { plugin } = await startMigration();

		await fileInto(plugin, "kitchen");

		expect(asks).not.toHaveBeenCalled();
		expect(((await read(plugin, KITCHEN.path)).match(/^## Tasks$/gm) ?? []).length).toBe(1);
	});
});
