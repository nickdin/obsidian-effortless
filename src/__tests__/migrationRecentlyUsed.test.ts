/**
 * The chooser opens on the collections filed into most recently. Each test files
 * through the palette, #856's `checkFilable` and `fileInto` halves and the real
 * settings store, then opens the chooser and reads `data.json` back. The
 * composition test is "after filing into B then A, lists A, B, then the rest in
 * their own order".
 */

import { expect, it, describe, vi } from "vitest";
import { Notice } from "./__mocks__/obsidian";
import {
	ATTIC,
	KITCHEN,
	PARTY_PATH,
	PARTY_TEXT,
	SHED,
	collectionAt,
	fileInto,
	installMigrationHooks,
	lastAsk,
	lastChooser,
	pathsFor,
	run,
	startMigration,
	storedRecent,
} from "./migrationHarness";

installMigrationHooks();

describe("the chooser opens on the collections filed into most recently", () => {
	it("after filing into B then A, lists A, B, then the rest in their own order", async () => {
		const { plugin } = await startMigration();

		await fileInto(plugin, "kitchen");
		await fileInto(plugin, "shed", 3);
		run(plugin, 2);

		expect(pathsFor(lastChooser(), "")).toEqual([SHED.path, KITCHEN.path, ATTIC.path]);
		expect(await storedRecent(plugin)).toEqual([SHED.path, KITCHEN.path]);
	});

	it("moves a collection filed into again to the front without listing it twice", async () => {
		const { plugin } = await startMigration();

		await fileInto(plugin, "kitchen");
		await fileInto(plugin, "shed", 3);
		await fileInto(plugin, "kitchen");

		expect(await storedRecent(plugin)).toEqual([KITCHEN.path, SHED.path]);
	});

	it("drops the oldest at the eleventh distinct collection, and the list never passes ten", async () => {
		const many = Array.from({ length: 11 }, (_, i) => collectionAt(`Projects/Area ${String(i + 1).padStart(2, "0")}.md`, `Area ${String(i + 1).padStart(2, "0")}`));
		const { plugin } = await startMigration({ collections: many });

		for (const each of many) await fileInto(plugin, each.name);

		const expected = many.map((each) => each.path).reverse().slice(0, 10);
		expect(expected).toHaveLength(10);
		expect(await storedRecent(plugin)).toEqual(expected);
		expect(expected).not.toContain(many[0].path);
	});

	it("leaves out, without a notice, a stored path that is no longer a collection", async () => {
		const { plugin } = await startMigration({ recentlyUsed: ["Projects/Deleted.md", KITCHEN.path, SHED.path.replace("Garden shed", "Moved")] });

		run(plugin, 2);

		expect(pathsFor(lastChooser(), "")).toEqual([KITCHEN.path, ATTIC.path, SHED.path]);
		expect(Notice.messages).toEqual([]);
	});

	it.each([
		["a string", SHED.path],
		["a list holding a number", [SHED.path, 7]],
		["nothing", null],
		["an object", { 0: SHED.path }],
	])("refuses %s with a notice and opens with no recent entries", async (_name, stored) => {
		const { plugin } = await startMigration({ recentlyUsed: stored });

		run(plugin, 2);

		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("recently used");
		expect(pathsFor(lastChooser(), "")).toEqual([ATTIC.path, SHED.path, KITCHEN.path]);
	});

	it("starts the list afresh after a refused value, once a task is filed", async () => {
		const { plugin } = await startMigration({ recentlyUsed: "not a list" });

		await fileInto(plugin, "kitchen");

		expect(await storedRecent(plugin)).toEqual([KITCHEN.path]);
	});

	it("puts a note made a collection by a yes at the front", async () => {
		const { plugin } = await startMigration({ extraNotes: { [PARTY_PATH]: PARTY_TEXT } });

		run(plugin, 2);
		await lastChooser().chooseAt("party", 0);
		lastAsk().press("Yes, write the heading");
		await vi.waitFor(() => expect(Notice.messages).toHaveLength(1));

		expect(await storedRecent(plugin)).toEqual([PARTY_PATH]);
	});
});
