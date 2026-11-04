/**
 * Migration and Task consistency run over one task: the README's
 * paragraph *A task dated today shows up twice* and what it leaves out. Files
 * through Migration's pure `fileInto`, then runs Task consistency's `copyIn`
 * over the same two texts, then asks Migration's undo what it makes of the
 * result. Every note, collection and task is invented.
 */

import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import type { Collection, Collections } from "../core/collections";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { editTaskField } from "../core/taskLine";
import { fileInto } from "../features/migration/fileInto";
import { echoesOf, readFiled, readFrozen, removeFromCollection, restoreInLog, restoredLines } from "../features/migration/undo";
import { copyIn } from "../features/taskConsistency/copyIn";
import { runOverCollection } from "../features/taskConsistency/run";
import type { RunDeps, RunNotes, RunProblems, RunVault } from "../features/taskConsistency/run";

const TODAY = new Date(2031, 3, 5);
const TODAY_KEY = "2031-04-05";
const ID = "abc123";

const layout: VaultLayout = { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };

const COLLECTION = ["# Garden shed", "", "## Tasks", "", "- [ ] Sweep the floor", "", "## Notes", "", "Words.", ""].join("\n");
const logWith = (task: string): string => ["# Notes", "", task, "", "## Overdue", "", "## Today", ""].join("\n");
const LOG_LINK = "[[2031-04-05]]";

/** Files the task on line 2 of a log holding `task`, then lets Task consistency copy the collection into the log. */
function fileThenCopyIn(task: string) {
	const filed = fileInto({ logText: logWith(task), lineIndex: 2, collectionText: COLLECTION, collectionLink: "[[Garden shed]]", logLink: LOG_LINK, id: ID, layout });
	if (!filed.ok) throw new Error(`filing was refused: ${filed.reason}`);
	const copied = copyIn(filed.collection, filed.log, TODAY, layout, "Garden shed");
	return { filed, copied };
}

/**
 * Migration's undo over two texts, as `undoFilings` does it over the vault: the
 * frozen line read from the log, the collection's copy found and checked, then
 * both texts written back. `ok: false` is a refusal, both texts as they were.
 */
function undoOver(collectionText: string, logText: string): { ok: true; log: string; collection: string } | { ok: false; why: "gone" | "touched" } {
	const frozen = readFrozen(logText, ID);
	if (frozen === null) throw new Error("the log has no frozen line for this filing");
	const found = readFiled(collectionText, ID, frozen.hash, frozen.indent);
	if (!found.ok) return { ok: false, why: found.why };
	const echoes = echoesOf(logText, frozen.at, found.line);
	return { ok: true, log: restoreInLog(logText, frozen, restoredLines(found, echoes.comments), echoes.at), collection: removeFromCollection(collectionText, found) };
}

/** The lines of `text` from `heading` to the next heading, blank lines dropped. */
function under(text: string, heading: string): string[] {
	const lines = text.split("\n");
	const start = lines.indexOf(heading);
	if (start < 0) throw new Error(`no heading ${heading}`);
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => line.startsWith("#"));
	return (end < 0 ? rest : rest.slice(0, end)).filter((line) => line.trim() !== "");
}

const TASK = `- [ ] Order more tea 📅 ${TODAY_KEY}`;

describe("a task dated today, filed by Migration and then copied in by Task consistency", () => {
	const { filed, copied } = fileThenCopyIn(TASK);

	it("shows the frozen [>] line under the notes heading and a live copy under the today heading of the same log", () => {
		// Were Task consistency to skip the filed task, `copied` would be 0 and the today section empty.
		expect(copied.copied).toBe(1);
		const frozen = under(copied.log, "# Notes");
		expect(frozen).toHaveLength(1);
		expect(frozen[0]).toMatch(/^- \[>\] Order more tea 📅 2031-04-05 \[\[Garden shed\]\] /);
		expect(frozen[0]).toContain(`migration:${ID}`);
		const live = under(copied.log, "## Today");
		expect(live).toHaveLength(1);
		expect(live[0]).toMatch(/^- \[ \] Order more tea 📅 2031-04-05 /);
		expect(under(copied.log, "## Overdue")).toEqual([]);
	});

	it("leaves the frozen line exactly as Migration wrote it", () => {
		// Task consistency does not read the frozen line: the notes section is byte-identical.
		expect(under(copied.log, "# Notes")).toEqual(under(filed.log, "# Notes"));
	});

	it("keeps the link back on the collection's copy but leaves it off the live copy Task consistency puts in the log", () => {
		// Were the link back not written at all, or were it copied along with the task, either assertion below would fail.
		const collectionLine = copied.collection.split("\n").find((line) => line.includes(`migration:${ID}`)) ?? "";
		expect(collectionLine).toContain(LOG_LINK);

		const live = under(copied.log, "## Today")[0];
		expect(live).not.toContain(LOG_LINK);
		expect(live).toContain(" [[Garden shed]] %%");
		expect(live).not.toContain("→");
	});

	it("marks the collection's copy [/], and Migration's undo still puts both files back as they were", () => {
		// Were the mark counted as a touch, undo would answer "touched" and both files would stay as filed.
		const collectionLine = copied.collection.split("\n").find((line) => line.includes(`migration:${ID}`)) ?? "";
		expect(collectionLine).toMatch(/^- \[\/\] Order more tea/);

		const undone = undoOver(copied.collection, copied.log);

		expect(undone.ok).toBe(true);
		if (!undone.ok) return;
		expect(undone.collection).toBe(COLLECTION);
		// The live copy under the today heading goes with it: the whole log is its text before filing.
		expect(undone.log.split("\n").filter((line) => line.includes(" [[Garden shed]] %% task-consistency:"))).toEqual([]);
		expect(undone.log).toBe(logWith(TASK));
	});

	it("restores the checkbox the task was filed with, not the [/] Task consistency wrote", () => {
		// Were the restored line built from the collection's copy as it stands, the frozen line would come back `[/]`.
		const undone = undoOver(copied.collection, copied.log);
		expect(undone.ok && under(undone.log, "# Notes")).toEqual([TASK]);
	});

	it("still refuses a copy the person reworded after Task consistency marked it", () => {
		const reworded = copied.collection.replace("Order more tea", "Order much more tea");
		expect(reworded).not.toBe(copied.collection);
		expect(undoOver(reworded, copied.log)).toEqual({ ok: false, why: "touched" });
	});

	it("still refuses a copy the person ticked after Task consistency marked it", () => {
		const ticked = copied.collection.replace("- [/] Order more tea", "- [x] Order more tea");
		expect(ticked).not.toBe(copied.collection);
		expect(undoOver(ticked, copied.log)).toEqual({ ok: false, why: "touched" });
	});

	it("still refuses a copy the person ticked before Task consistency ran", () => {
		// A person's `[x]` on the copy of a task filed open is not the plugin's `[/]`.
		const ticked = filed.collection.replace("- [ ] Order more tea", "- [x] Order more tea");
		expect(ticked).not.toBe(filed.collection);
		expect(undoOver(ticked, filed.log)).toEqual({ ok: false, why: "touched" });
	});

	it("refuses, as before, a `[/]` copy whose marker an earlier build wrote without the checkbox", () => {
		// An earlier build's marker is `id hash`. Its filing checkbox is unknown, so a `[/]` copy is not guessed to be Task consistency's.
		// An earlier build wrote neither the checkbox word nor the link back
		// (#906, which came later still), so both come off: the marker down to its
		// two-word shape, and the collection's own appended link with it.
		const oldMarker = (text: string): string =>
			text.replace(` ${LOG_LINK}`, "").replace(/(%% migration:\S+ \S+)(?: \S+){1,2} %%/, "$1 %%");
		const oldCollection = oldMarker(copied.collection);
		const oldLog = oldMarker(copied.log);
		expect(oldCollection).not.toBe(copied.collection);
		expect(readFrozen(oldLog, ID)).not.toBeNull();
		expect(undoOver(oldCollection, oldLog)).toEqual({ ok: false, why: "touched" });
	});

	it("still undoes a copy of a marker an earlier build wrote, while nothing has touched it", () => {
		// An earlier build wrote neither the checkbox word nor the link back
		// (#906, which came later still), so both come off: the marker down to its
		// two-word shape, and the collection's own appended link with it.
		const oldMarker = (text: string): string =>
			text.replace(` ${LOG_LINK}`, "").replace(/(%% migration:\S+ \S+)(?: \S+){1,2} %%/, "$1 %%");
		const undone = undoOver(oldMarker(filed.collection), oldMarker(filed.log));
		expect(undone.ok && undone.log).toBe(logWith(TASK));
	});
});

describe("a task filed as [/], which Task consistency never copies", () => {
	const inProgress = `- [/] Order more tea 📅 ${TODAY_KEY}`;
	const { filed } = fileThenCopyIn(inProgress);

	it("is undone with its [/] as the person wrote it", () => {
		const undone = undoOver(filed.collection, filed.log);
		expect(undone.ok && undone.log).toBe(logWith(inProgress));
		expect(undone.ok && undone.collection).toBe(COLLECTION);
	});

	it("is undone when the person set the copy to [/] themselves, which it already was", () => {
		// The one difference undo ignores is a `[/]` on a copy filed open; here the person's `[/]` is what was filed, so nothing differs.
		const set = filed.collection.replace(/^- \[.\] Order more tea/m, "- [/] Order more tea");
		expect(set).toContain("- [/] Order more tea");
		const undone = undoOver(set, filed.log);
		expect(undone.ok && undone.log).toBe(logWith(inProgress));
	});

	it("is refused when the person ticked the copy", () => {
		const ticked = filed.collection.replace("- [/] Order more tea", "- [x] Order more tea");
		expect(ticked).not.toBe(filed.collection);
		expect(undoOver(ticked, filed.log)).toEqual({ ok: false, why: "touched" });
	});
});

describe("a task dated earlier than today", () => {
	it("is copied under the overdue heading instead", () => {
		const { copied } = fileThenCopyIn("- [ ] Order more tea 📅 2031-04-01");
		expect(under(copied.log, "## Overdue")[0]).toMatch(/^- \[ \] Order more tea 📅 2031-04-01 /);
		expect(under(copied.log, "## Today")).toEqual([]);
	});
});

describe("a filed task that is in progress", () => {
	it("is never copied in, because only an unmarked open task is", () => {
		// The README's "open task" limit: a `[/]` task filed by Migration stays out of the day's log.
		const { copied } = fileThenCopyIn(`- [/] Order more tea 📅 ${TODAY_KEY}`);
		expect(copied.copied).toBe(0);
		expect(under(copied.log, "## Today")).toEqual([]);
	});
});

/** The one line of `text` containing `needle`, failing the test rather than returning undefined. */
function lineContaining(text: string, needle: string): string {
	const found = text.split("\n").find((line) => line.includes(needle));
	if (found === undefined) throw new Error(`no line of ${JSON.stringify(text)} contains ${JSON.stringify(needle)}`);
	return found;
}

/** A minimal in-memory `RunVault`/`RunNotes`/`RunProblems`, for driving `runOverCollection` itself — the live call path #952 asks a regression test to exercise, not only `copyIn` called directly. */
function fakeRunDeps(files: Map<string, string>, collectionPath: string, collectionName: string): RunDeps {
	const vault: RunVault = { fileAt: (path) => (files.has(path) ? ({ path } as TFile) : null) };
	const notes: RunNotes = {
		read: async (file) => files.get(file.path) ?? "",
		edit: async (file, edit) => {
			const next = edit(files.get(file.path) ?? "");
			files.set(file.path, next);
			return next;
		},
	};
	const problems: RunProblems = { report: () => undefined, clear: () => undefined, list: () => [] };
	const collections: Collections = {
		all: () => [{ path: collectionPath, name: collectionName, headingLine: 0, headingLevel: 2, openTasks: 1 }],
		at: (path) => (path === collectionPath ? { path: collectionPath, name: collectionName, headingLine: 0, headingLevel: 2, openTasks: 1 } : null),
	};
	return { collections, vault, notes, problems, layout, today: TODAY };
}

describe("a task given a due date in a later run than the one that filed it", () => {
	it("still leaves the day-link off the live copy runOverCollection puts in the log", async () => {
		// The reporter's own drive added the due date after filing, in a
		// separate edit, rather than a collection line that already carried
		// both fields at copy time — this test runs `runOverCollection` itself
		// (Task consistency's whole live call path, `checkPath`'s own entry
		// point), not `copyIn` called directly, across two separate runs, the
		// shape a live filing followed by a live edit actually takes.
		const TASK_NO_DATE = "- [ ] Prune the apple tree";
		const filed = fileInto({
			logText: logWith(TASK_NO_DATE),
			lineIndex: 2,
			collectionText: COLLECTION,
			collectionLink: "[[Garden shed]]",
			logLink: LOG_LINK,
			id: ID,
			layout,
		});
		if (!filed.ok) throw new Error(`filing was refused: ${filed.reason}`);

		const files = new Map([
			["Garden shed.md", filed.collection],
			["Journal/2031-04-05.md", filed.log],
		]);
		const deps = fakeRunDeps(files, "Garden shed.md", "Garden shed");
		const collection: Collection = { path: "Garden shed.md", name: "Garden shed", headingLine: 0, headingLevel: 2, openTasks: 1 };

		// First run: no due date yet, so the task is not due and nothing is copied.
		const first = await runOverCollection(deps, collection);
		expect(first.eids.size).toBe(0);
		expect(under(files.get("Journal/2031-04-05.md")!, "## Today")).toEqual([]);

		// A due date is added on the collection's own line, in a run of its own —
		// a real, later vault change, not part of the run that just finished.
		const collectionLine = lineContaining(files.get("Garden shed.md")!, "Prune the apple tree");
		files.set("Garden shed.md", files.get("Garden shed.md")!.replace(collectionLine, editTaskField(collectionLine, "due", TODAY_KEY)));

		// Second run: now due, so it is copied — through runOverCollection's own
		// orchestration, the same call `checkPath` makes live.
		const second = await runOverCollection(deps, collection);
		expect(second.eids.size).toBe(1);

		const live = under(files.get("Journal/2031-04-05.md")!, "## Today")[0];
		expect(live).not.toContain(LOG_LINK);
		expect(live).toContain(" [[Garden shed]] %%");
		expect(live).not.toContain("→");

		const collectionCopy = files.get("Garden shed.md")!.split("\n").find((line) => line.includes(`migration:${ID}`)) ?? "";
		expect(collectionCopy).toContain(LOG_LINK);
	});
});
