/**
 * The chooser in a vault with no collection yet (#873,
 * #874, findings against
 * #858). Each test runs the
 * command from the palette through the real chooser and the question.
 */

import { expect, it, describe, vi } from "vitest";
import { Notice } from "./__mocks__/obsidian";
import { PARTY_PATH, PARTY_TEXT, TEA, installMigrationHooks, lastAsk, lastChooser, openedChoosers, pathsFor, read, run, startMigration } from "./migrationHarness";

installMigrationHooks();

describe("a vault with no collection yet", () => {
	// Were the code wrong (the refusal before the chooser), the stub's `open` is
	// never called and `lastChooser` fails; a pass is the chooser existing at all.
	it("opens the chooser, empty until something is typed, then drawing in the ordinary note", async () => {
		const { plugin } = await startMigration({ collections: [], extraNotes: { [PARTY_PATH]: PARTY_TEXT } });

		run(plugin, 2);

		expect(openedChoosers).toHaveLength(1);
		expect(pathsFor(lastChooser(), "")).toEqual([]);
		expect(pathsFor(lastChooser(), "party")).toEqual([PARTY_PATH]);
		expect(Notice.messages).toEqual([]);
	});

	// Were the code wrong, the chooser never opens, so no question is asked and
	// the note keeps its text.
	it("yes: writes the tasks heading into the note and files the task under it", async () => {
		const { plugin } = await startMigration({ collections: [], extraNotes: { [PARTY_PATH]: PARTY_TEXT } });

		run(plugin, 2);
		await lastChooser().chooseAt("party", 0);
		lastAsk().press("Yes, write the heading");
		await vi.waitFor(() => expect(Notice.messages).toEqual(["Put this task in Garden party."]));

		const written = await read(plugin, PARTY_PATH);
		expect(written).toMatch(new RegExp(`^${PARTY_TEXT}\\n## Tasks\\n\\n${TEA.replace(/[[\]]/g, "\\$&")} \\[\\[2031-04-05\\]\\] %% migration:\\S+ \\S+ \\S+ \\S+ \\S+ %%\\n$`));
	});

	// A guard, not a red test: the refusal is right when the chooser would have
	// nothing to offer either (the day's log is never offered).
	it("still says there is no collection when there is no ordinary note to offer either", async () => {
		const { plugin } = await startMigration({ collections: [] });

		run(plugin, 2);

		expect(openedChoosers).toHaveLength(0);
		expect(Notice.messages).toEqual(["There is no collection yet. A note is a collection when it has the tasks heading."]);
	});
});
