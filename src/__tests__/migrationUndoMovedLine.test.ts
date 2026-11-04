/**
 * Undo and a filed line the person moved
 * (#1005, the remainder of
 * #998, against
 * #986).
 *
 * A task filed into an empty tasks section carries a record of the blank lines the
 * filing added around it. If the person then moves that line under another heading
 * that holds nothing else, between two blank lines of their own, the text cannot say
 * whose blank lines those are; the record has to say **where the filing put the
 * line**, so undo uses the record only while the line is still there. Otherwise only
 * the task's block comes out, and the person's blank lines stay.
 *
 * Every case compares a whole collection with the one text that is right. Every
 * folder, name and task is invented.
 */

import { describe, expect, it } from "vitest";
import { MarkdownView, WorkspaceLeaf } from "./__mocks__/obsidian";
import { NoteWriter } from "../core/noteWriter";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { fileInto } from "../features/migration/fileInto";
import { headingKey, readMarker } from "../features/migration/marker";
import { readFiled, readFrozen, removeFromCollection, undoFilings } from "../features/migration/undo";
import type { UndoWorld } from "../features/migration/undo";
import { FakeEditor, LOG_PATH, SHED, installMigrationHooks, read, startMigration } from "./migrationHarness";

installMigrationHooks();

const SHED_PATH = "Projects/Garden shed.md";
const LOG_LINK = "[[2031-04-05]]";
const ID = "abc123";

function layout(): VaultLayout {
	return { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };
}

const OPEN_LOG = ["# Notes", "", "- [ ] Order more tea", "", "## Today", ""].join("\n");
const DONE_LOG = ["# Notes", "", "- [x] Order more tea", "", "## Today", ""].join("\n");

/** Files line 2 of `logText` into `collection`; answers both texts afterwards and the collection's filed line. */
function fileOnce(collection: string, logText = OPEN_LOG): { collection: string; log: string; filedLine: string } {
	const filed = fileInto({ logText, lineIndex: 2, collectionText: collection, collectionLink: "[[Garden shed]]", logLink: LOG_LINK, id: ID, layout: layout() });
	if (!filed.ok) throw new Error(filed.reason);
	const filedLine = filed.collection.split("\n").find((each) => each.includes(ID));
	if (filedLine === undefined) throw new Error("the filed line was not found in the collection");
	return { collection: filed.collection, log: filed.log, filedLine };
}

/** Undoes the filing in `collection` the way the note writer's route does, over the text alone. */
function undoIn(collection: string, log: string): string {
	const frozen = readFrozen(log, ID);
	if (frozen === null) throw new Error("the frozen line was not found again");
	const filed = readFiled(collection, ID, frozen.hash, frozen.indent);
	if (!filed.ok) throw new Error(`the filing was not found again: ${filed.why}`);
	return removeFromCollection(collection, filed);
}

/** `line` with the marker's position word taken off, the marker an earlier build wrote: a no-op on a line that never had one. */
const withoutPosition = (line: string): string => line.replace(/@[0-9a-f]{8}( %%)/, "$1");

describe("#1005: undo does not use a filing's record once the filed line has been moved", () => {
	// If wrong: the person's blank line above the moved line and the one below it go with the block, because
	// the recorded `b/b` matches the neighbours of the line wherever it sits.
	it("leaves both blank lines the person has around a filed line they moved under another heading", () => {
		const { collection, log, filedLine } = fileOnce("## Tasks\n## Notes\n");
		expect(collection, "filing recorded no added lines, so the test cannot fail").toContain(" b/b");
		const moved = ["## Tasks", "## Notes", "", filedLine, "", ""].join("\n");

		expect(undoIn(moved, log)).toBe(["## Tasks", "## Notes", "", "", ""].join("\n"));
	});

	// If wrong: the blank line the filing wrote between the two headings goes, or the moved line's neighbours do,
	// depending on which end of the record is trusted; the text right after the undo differs from the person's.
	it("leaves the person's blank lines when the moved line sits between two of their own headings", () => {
		const { collection, log, filedLine } = fileOnce("## Tasks\n## Notes\n");
		expect(collection).toContain(" b/b");
		const moved = ["## Tasks", "## Ideas", "", filedLine, "", "## Notes", ""].join("\n");

		expect(undoIn(moved, log)).toBe(["## Tasks", "## Ideas", "", "", "## Notes", ""].join("\n"));
	});

	// If wrong: the person's own heading `## Notes` is taken out with the block, because the record says a heading
	// and a blank line sit above it, which they do, although that heading is not the one the filing wrote.
	it("leaves the person's heading and blank lines when a done task's line was moved away from the completed-tasks heading the filing wrote", () => {
		const { collection, log, filedLine } = fileOnce("## Tasks\n", DONE_LOG);
		expect(collection).toContain(" hb/b");
		const moved = ["## Tasks", "## Notes", "", filedLine, "", ""].join("\n");

		expect(undoIn(moved, log)).toBe(["## Tasks", "## Notes", "", "", ""].join("\n"));
	});

	// If wrong: the heading was renamed, so the line is not under the heading the filing chose; a record applied
	// anyway would take the blank lines around it, which the person may have kept there on purpose.
	it("takes out the task's block alone when the heading it was filed under has been renamed", () => {
		const { collection, log } = fileOnce("## Tasks\n## Notes\n");
		const renamed = collection.replace("## Tasks", "## Chores");

		expect(undoIn(renamed, log)).toBe("## Chores\n\n\n## Notes\n");
	});
});

describe("#1005: the unmoved case, and a marker with no position, keep undoing as before", () => {
	// Guard, not proof: passes on the code before the position word existed. It fails if the position check
	// refuses a line that is still exactly where the filing put it.
	// If wrong: the two blank lines the filing wrote stay behind, and the collection is not what it was.
	it.each([
		["an empty tasks section and a heading after it", "## Tasks\n## Notes\n"],
		["an empty tasks section at the end of the note", "## Tasks"],
		["a blank line under the heading and a heading after it", "## Tasks\n\n## Notes\n"],
		["a heading at a deeper level", "### Tasks\n#### Notes\n"],
	])("returns the collection byte for byte when the line is where the filing put it, %s", (_case, before) => {
		const { collection, log } = fileOnce(before);
		expect(collection, "filing wrote nothing, so the test cannot fail").not.toBe(before);

		expect(undoIn(collection, log)).toBe(before);
	});

	// If wrong: the filing writes no position, and every other test in this file passes on the marker's shape alone.
	it("writes the heading the line was put under into the fifth word, and reads it back", () => {
		const { filedLine } = fileOnce("## Tasks\n## Notes\n");

		expect(filedLine).toMatch(/ L b\/b@[0-9a-f]{8} %%$/);
		expect(readMarker(filedLine)?.added).toEqual({ above: "b", below: "b", under: headingKey("## Tasks") });
		expect(readMarker(withoutPosition(filedLine))?.added, "the position word was not taken off, so the tests below prove nothing").toEqual({ above: "b", below: "b" });
	});

	// Guard: an earlier build's marker has no position, so the record is applied as it always was.
	// If wrong: the blank lines stay although the record is intact, or a marker with no position is refused.
	it("applies the record of a marker that has no position, as an earlier build's marker is", () => {
		const { collection, log, filedLine } = fileOnce("## Tasks\n## Notes\n");
		const old = collection.replace(filedLine, withoutPosition(filedLine));
		expect(old, "the position word was not taken off").not.toBe(collection);

		expect(undoIn(old, log)).toBe("## Tasks\n## Notes\n");
	});

	// Guard, and the reason the position cannot be guessed: with no position the moved line's neighbours are
	// taken as the record says, which is what today's code does and what an old marker keeps doing.
	// If wrong: the person's blank lines are kept, which would mean an old marker was treated as one with a position.
	it("still takes the blank lines of a moved line whose marker has no position", () => {
		const { collection, log, filedLine } = fileOnce("## Tasks\n## Notes\n");
		expect(collection).toContain(" b/b");
		expect(withoutPosition(filedLine), "the position word was not taken off").not.toBe(filedLine);
		const moved = ["## Tasks", "## Notes", "", withoutPosition(filedLine), "", ""].join("\n");

		expect(undoIn(moved, log)).toBe(["## Tasks", "## Notes", ""].join("\n"));
	});
});

describe("#1005: filing, the person's edit and undo together", () => {
	const world = (plugin: Awaited<ReturnType<typeof startMigration>>["plugin"]): UndoWorld => ({
		app: plugin.app as never,
		notes: new NoteWriter(plugin.app.vault as never, { path: () => null, onChange: () => undefined }),
		collections: { all: () => [SHED] },
	});

	// If wrong: the note the person edited comes back without its two blank lines, or the notice says nothing was undone.
	it.each([
		["by the note writer", false],
		["through the collection's own tab", true],
	])("files a task, keeps the person's move of its line, and undoes to their blank lines, %s", async (_, inTab) => {
		const { log, filedLine } = fileOnce("## Tasks\n## Notes\n");
		const afterTheirMove = ["## Tasks", "## Notes", "", filedLine, "", ""].join("\n");
		const { plugin } = await startMigration({ log });
		const vault = plugin.app.vault.readableContents();
		vault?.set(LOG_PATH, log);
		vault?.set(SHED_PATH, afterTheirMove);
		const tab = new FakeEditor(afterTheirMove, 0);
		if (inTab) {
			const view = new MarkdownView({ path: SHED_PATH }, afterTheirMove);
			view.editor = tab as never;
			plugin.app.workspace.leaves.push(new WorkspaceLeaf(view));
		}

		const said = await Promise.race([undoFilings(world(plugin), LOG_PATH, [ID], SHED_PATH, null), new Promise<string>((settle) => setTimeout(() => settle("parked"), 200))]);

		expect(said).toBe("Undone. The task is back in the day's log and no longer in Garden shed.");
		expect(inTab ? tab.getValue() : await read(plugin, SHED_PATH)).toBe(["## Tasks", "## Notes", "", "", ""].join("\n"));
	});
});
