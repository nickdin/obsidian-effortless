/**
 * The wave's composition test for #986
 * and #994, which met in `undo.ts`
 * and in the marker: #986 gives a filing into an empty tasks section a fifth marker
 * word, and #994's scan of today's log reads the collection copy's comments through
 * `isMarkerShapedComment`. Each ticket's own tests ran its half alone. This one runs
 * both in one undo: a task dated today is filed from a meeting note into a collection
 * whose tasks section is empty, Task consistency's `copyIn` puts its live copy in
 * today's log, and the undo is chosen from the meeting note's right-click entry.
 *
 * If wrong: with #986's half missing the collection keeps a blank line or two; with
 * #994's half missing today's log keeps the live copy. Either way one of the three
 * whole-text comparisons below differs. Shown to fail on exactly those: `undo.ts` from
 * #986's branch alone left today's log with the live copy, and `undo.ts` from #994's
 * branch alone left the collection with blank lines. (The scan strips Migration's own
 * marker before it compares, so a five-word marker does not blind it; with
 * `markerLink.ts` as of `3308a03` a half-merged undo fails on the "changed or ticked"
 * notice instead.)
 *
 * Every note, collection and task is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Menu, Notice } from "./__mocks__/obsidian";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { UNDO_ENTRY_TITLE } from "../features/migration/menu";
import { copyIn } from "../features/taskConsistency/copyIn";
import { FakeEditor, LOG_PATH, SHED, installMigrationHooks, lastChooser, read, startMigration } from "./migrationHarness";
import { pressLineAwayFromCursor } from "./editorMenu";

installMigrationHooks();

const TODAY = new Date(2031, 3, 5);
const MEETING_PATH = "Meetings/Lantern committee.md";
const TASK = "- [ ] Varnish the spare oars 📅 2031-04-05";
const MEETING = ["# Lantern committee", "", "Present: [[Ada Fenwick]]", "", TASK, ""].join("\n");
const EMPTY_SHED = "# Garden shed\n\n## Tasks\n## Notes\n\nWords.\n";
const LOG_BEFORE = ["# Notes", "", "- [ ] Mend the gate", "", "## Overdue", "", "## Today", ""].join("\n");
const layout: VaultLayout = { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };

type CheckCallback = (checking: boolean, editor: FakeEditor, ctx: { file: { path: string } | null }) => boolean | void;

beforeEach(() => {
	Notice.messages.length = 0;
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(TODAY);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("#986 × #994: undo from a meeting note, after a filing into an empty tasks section and Task consistency's copy", () => {
	it("gives the collection, today's log and the meeting note back byte for byte", async () => {
		const { plugin } = await startMigration({ log: LOG_BEFORE, extraNotes: { [MEETING_PATH]: MEETING } });
		plugin.app.vault.readableContents()?.set(SHED.path, EMPTY_SHED);
		expect(await read(plugin, SHED.path), "the empty collection was not in place, so the test cannot fail").toBe(EMPTY_SHED);

		const editor = new FakeEditor(MEETING, MEETING.split("\n").indexOf(TASK));
		const command = plugin.commands.find((each) => each.id === `${plugin.manifest.id}:file-task`);
		(command as unknown as { editorCheckCallback: CheckCallback }).editorCheckCallback(false, editor, { file: { path: MEETING_PATH } });
		await lastChooser().chooseAt("shed", 0);
		await vi.waitFor(() => expect(Notice.messages.some((each) => each.startsWith("Put this task in"))).toBe(true));

		const filed = await read(plugin, SHED.path);
		expect(filed, "the filing wrote no fifth marker word, so #986's half is not exercised").toMatch(/%% migration:\S+ \S+ \S+ L \S+\/\S+ %%/);
		const copied = copyIn(filed, LOG_BEFORE, TODAY, layout, "Garden shed");
		expect(copied.log, "Task consistency copied nothing into today's log, so #994's half is not exercised").toContain("task-consistency:");
		const contents = plugin.app.vault.readableContents();
		contents?.set(LOG_PATH, copied.log);
		contents?.set(SHED.path, copied.collection);

		const source = editor.getValue();
		const frozen = new FakeEditor(source, source.split("\n").findIndex((each) => each.startsWith("- [>]")));
		const menu = new Menu();
		pressLineAwayFromCursor(frozen, frozen.getCursor().line);
		plugin.app.workspace.fire("editor-menu", menu, frozen, { file: { path: MEETING_PATH } });
		Notice.messages.length = 0;
		menu.items.find((each) => each.title === UNDO_ENTRY_TITLE)?.click();
		await vi.waitFor(() => expect(Notice.messages.length).toBeGreaterThan(0));

		expect(Notice.messages[Notice.messages.length - 1]).toBe("Undone. The task is back in the note and no longer in Garden shed.");
		expect(await read(plugin, SHED.path)).toBe(EMPTY_SHED);
		expect(await read(plugin, LOG_PATH)).toBe(LOG_BEFORE);
		expect(frozen.getValue()).toBe(MEETING);
	});
});
