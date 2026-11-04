/**
 * What filing writes: the marker, the two lines, where the copy lands and how
 * the day's log is left (#856,
 * spec #716 decisions 6 to
 * 8). Every assertion compares whole texts. Every name and task is invented.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultData } from "../core/settings";
import { parseTaskLine } from "../core/taskLine";
import { fileInto, freezeInLog, linesToWrite, placeInCollection } from "../features/migration/fileInto";
import { hashOfLine, headingKey, newMigrationId, readMarker } from "../features/migration/marker";

const layout = defaultData().core.layout;

const ID = "mywpiww0i0zz";
const LOG_LINK = "[[2031-04-05]]";

/** The hash the marker on both lines carries: the task's own bare words, the link back masked out the way the marker itself is. */
function hashOf(line: string): string {
	const task = parseTaskLine(line);
	if (task === null) throw new Error(`fixture is not a task line: ${line}`);
	return hashOfLine(task);
}

function marker(line: string): string {
	const checkbox = parseTaskLine(line)?.checkbox;
	return `%% migration:${ID} ${hashOf(line)} ${checkbox === " " ? "_" : checkbox} L %%`;
}

/** The collection's own copy of `line`: its own words, the link back, the marker. */
function collectionCopy(line: string): string {
	return `${line} ${LOG_LINK} ${marker(line)}`;
}

/** A day's log holding `task` as its one line under the notes heading. */
function logWith(task: string): string {
	return ["# Notes", "", task, "- Just a thought", "", "## Today", "", "- [ ] Water the plants", ""].join("\n");
}

const COLLECTION = [
	"# Garden shed",
	"",
	"## Tasks",
	"",
	"- [ ] Sweep the floor",
	"",
	"## Notes",
	"",
	"Some notes.",
	"",
].join("\n");

function filed(task: string, collectionText = COLLECTION) {
	const result = fileInto({
		logText: logWith(task),
		lineIndex: 2,
		collectionText,
		collectionLink: "[[Garden shed]]",
		logLink: LOG_LINK,
		id: ID,
		layout,
	});
	if (!result.ok) throw new Error(result.reason);
	return result;
}

describe("fileInto: where the copy lands", () => {
	it("puts an open task at the bottom of the tasks section", () => {
		const task = "- [ ] Order more tea";
		const result = filed(task);

		expect(result.collection).toBe(
			[
				"# Garden shed",
				"",
				"## Tasks",
				"",
				"- [ ] Sweep the floor",
				`${collectionCopy(task)}`,
				"",
				"## Notes",
				"",
				"Some notes.",
				"",
			].join("\n"),
		);
	});

	it("puts a done task under the completed-tasks heading, still ticked, writing the heading when it is missing", () => {
		const task = "- [x] Fix the gate";
		const result = filed(task);

		expect(result.collection).toBe(
			[
				"# Garden shed",
				"",
				"## Tasks",
				"",
				"- [ ] Sweep the floor",
				"",
				"## Completed tasks",
				"",
				`${collectionCopy(task).replace(" L %%", ` L hb/b@${headingKey("## Completed tasks")} %%`)}`,
				"",
				"## Notes",
				"",
				"Some notes.",
				"",
			].join("\n"),
		);
	});

	it("puts a done task at the bottom of a completed-tasks section that is already there", () => {
		const task = "- [x] Fix the gate";
		const collection = ["## Tasks", "", "- [ ] Sweep the floor", "", "## Completed tasks", "", "- [x] Mend the fence", ""].join("\n");

		expect(filed(task, collection).collection).toBe(
			[
				"## Tasks",
				"",
				"- [ ] Sweep the floor",
				"",
				"## Completed tasks",
				"",
				"- [x] Mend the fence",
				`${collectionCopy(task)}`,
				"",
			].join("\n"),
		);
	});

	it("puts a cancelled task under the tasks heading, still cancelled", () => {
		const task = "- [-] Paint the shed blue";
		const result = filed(task);

		expect(result.collection).toContain(`- [ ] Sweep the floor\n${collectionCopy(task)}\n\n## Notes`);
		expect(result.collection).not.toContain("Completed tasks");
	});

	it("keeps a scheduled and a due date exactly and adds none", () => {
		const task = "- [ ] Pay the water bill ⏳ 2031-04-06 📅 2031-04-09";
		const result = filed(task);

		expect(result.collection).toContain(`${collectionCopy(task)}`);
		// The collection's copy also carries the link back, whose own name is a date;
		// the log side, where no link back ever lands, still shows only the two fields.
		expect(result.collection.match(/\d{4}-\d{2}-\d{2}/g)).toEqual(["2031-04-06", "2031-04-09", "2031-04-05"]);
		expect(result.log.match(/\d{4}-\d{2}-\d{2}/g)).toEqual(["2031-04-06", "2031-04-09"]);
	});

	it("writes under an empty tasks section, blank line kept above and below", () => {
		const task = "- [ ] Order more tea";
		const collection = "# Garden shed\n\n## Tasks\n\n## Notes\n\nSome notes.\n";

		expect(filed(task, collection).collection).toBe(
			`# Garden shed\n\n## Tasks\n\n${collectionCopy(task).replace(" L %%", ` L -/b@${headingKey("## Tasks")} %%`)}\n\n## Notes\n\nSome notes.\n`,
		);
	});

	it("writes at the bottom of a tasks section that ends the note without a newline", () => {
		const task = "- [ ] Order more tea";
		const collection = "## Tasks\n\n- [ ] Sweep the floor";

		expect(filed(task, collection).collection).toBe(`## Tasks\n\n- [ ] Sweep the floor\n${collectionCopy(task)}`);
	});

	it("keeps the collection's own line endings", () => {
		const task = "- [ ] Order more tea";
		const collection = "## Tasks\r\n\r\n- [ ] Sweep the floor\r\n";

		expect(filed(task, collection).collection).toBe(
			`## Tasks\r\n\r\n- [ ] Sweep the floor\r\n${collectionCopy(task)}\r\n`,
		);
	});

	it("refuses a note that no longer has the tasks heading, changing nothing", () => {
		const result = fileInto({
			logText: logWith("- [ ] Order more tea"),
			lineIndex: 2,
			collectionText: "# Garden shed\n\nNo tasks here.\n",
			collectionLink: "[[Garden shed]]",
			logLink: LOG_LINK,
			id: ID,
			layout,
		});

		expect(result.ok).toBe(false);
	});

	it("refuses a done task while the completed-tasks heading is blank in the settings", () => {
		const blank = { ...layout, completedTasksHeading: "  " };
		const placed = placeInCollection(COLLECTION, "- [x] Fix the gate", "done", blank);

		expect(placed.ok).toBe(false);
	});
});

describe("fileInto: the two lines", () => {
	it("leaves the log line reading [>], with the link and the marker, and every other byte as it was", () => {
		const task = "- [ ] Order more tea ⏳ 2031-04-06 #errand";
		const result = filed(task);

		expect(result.log).toBe(
			logWith(`- [>] Order more tea ⏳ 2031-04-06 #errand [[Garden shed]] ${marker(task)}`),
		);
	});

	it("gives the collection line and the frozen line the same id and hash, and the copy is the original plus the link back and the marker", () => {
		const task = "- [ ]   Order  more tea\t⏳ 2031-04-06   ";
		const { collectionLine, frozenLine } = linesToWrite(task, ID, "[[Garden shed]]", LOG_LINK);

		const ofCollection = /%% migration:(\S+) (\S+) (\S+) (\S+) %%/.exec(collectionLine);
		const ofFrozen = /%% migration:(\S+) (\S+) (\S+) (\S+) %%/.exec(frozenLine);
		expect(ofCollection?.[1]).toBe(ID);
		expect(ofFrozen?.[1]).toBe(ID);
		expect(ofFrozen?.[2]).toBe(ofCollection?.[2]);
		// The marker goes in before the trailing spaces, so cutting it out gives the original back.
		expect(ofFrozen?.[3]).toBe("_");
		// The fourth word says both lines also carry a link this filing appended.
		expect(ofCollection?.[4]).toBe("L");
		expect(ofFrozen?.[4]).toBe("L");
		// The link is inserted before the task's own trailing spaces, the same
		// point `addField` uses, so cutting the marker out moves them to the end.
		expect(collectionLine.replace(/ %% migration:\S+ \S+ \S+ \S+ %%/, "")).toBe(
			`- [ ]   Order  more tea\t⏳ 2031-04-06 ${LOG_LINK}   `,
		);
	});

	it("appends the link back to the collection's copy, after the task's own words, the mirror of the frozen line's collection link", () => {
		const task = "- [ ] Order more tea";
		const { collectionLine } = linesToWrite(task, ID, "[[Garden shed]]", LOG_LINK);

		expect(collectionLine.startsWith(`${task} ${LOG_LINK} %% migration:`)).toBe(true);
	});

	it("keeps trailing whitespace the person wrote where it is: moved past the link and the marker on the collection's copy (whole line checked, not only its start and its end), and after the link alone on the frozen line", () => {
		const { frozenLine, collectionLine } = linesToWrite("- [ ] Order tea  ", ID, "[[Garden shed]]", LOG_LINK);

		expect(frozenLine.startsWith("- [>] Order tea  [[Garden shed]] %% migration:")).toBe(true);
		expect(collectionLine.startsWith(`- [ ] Order tea ${LOG_LINK} %% migration:`)).toBe(true);
		expect(collectionLine.endsWith("  ")).toBe(true);
		// The two above only pin the start and the end; this pins the whole line
		// with the marker cut out, so a byte moved between them could not slip by.
		expect(collectionLine.replace(/ %% migration:\S+ \S+ \S+ \S+ %%/, "")).toBe(`- [ ] Order tea ${LOG_LINK}  `);
	});

	it("takes the hash from the task's own bare words, the link back masked out the way the marker itself is, so neither appending it nor Obsidian later rewriting it ever makes undo read the task as touched", () => {
		const task = "- [ ] Order more tea";
		const { collectionLine } = linesToWrite(task, ID, "[[Garden shed]]", LOG_LINK);

		const rehashed = hashOfLine(parseTaskLine(task)!);
		expect(readMarker(collectionLine)?.hash).toBe(rehashed);
	});

	it("hashes the line's fields and words with any comment masked out", () => {
		const bare = parseTaskLine("- [ ] Order tea ⏳ 2031-04-06");
		const commented = parseTaskLine("- [ ] Order tea ⏳ 2031-04-06 %% some comment %%");
		const reworded = parseTaskLine("- [ ] Order coffee ⏳ 2031-04-06");
		const ticked = parseTaskLine("- [x] Order tea ⏳ 2031-04-06");

		expect(hashOfLine(commented!)).toBe(hashOfLine(bare!));
		expect(hashOfLine(reworded!)).not.toBe(hashOfLine(bare!));
		expect(hashOfLine(ticked!)).not.toBe(hashOfLine(bare!));
		expect(hashOfLine(bare!)).toMatch(/^[0-9a-f]{8}$/);
	});
});

describe("freezeInLog", () => {
	const original = "- [ ] Order more tea";
	const frozen = "- [>] Order more tea [[Garden shed]] %% migration:x 00000000 %%";

	it("finds the line again when it has moved since it was read, if it is the only one that reads the same", () => {
		const moved = ["# Notes", "", "- A new line above", original, ""].join("\n");

		expect(freezeInLog(moved, 2, original, frozen, layout)).toBe(["# Notes", "", "- A new line above", frozen, ""].join("\n"));
	});

	it("changes nothing when the line was edited meanwhile", () => {
		expect(freezeInLog("# Notes\n\n- [ ] Order oat milk\n", 2, original, frozen, layout)).toBeNull();
	});

	it("changes nothing when two lines read the same and neither is where it was", () => {
		expect(freezeInLog(`# Notes\n${original}\n${original}\n`, 5, original, frozen, layout)).toBeNull();
	});

	it("never freezes an identical line under a day's task section, which the command would have refused to file", () => {
		// The line filed sat under the notes heading and was edited before the write ran;
		// the same words under the day's tasks are a different task. On the old code the
		// fallback froze that one, so this returned text with a `[>]` line instead of null.
		const editedAbove = ["# Notes", "", "- [ ] Order more tea now", "", "## Today", "", original, ""].join("\n");

		expect(freezeInLog(editedAbove, 2, original, frozen, layout)).toBeNull();
	});

	it("keeps a carriage return the line ended in", () => {
		expect(freezeInLog(`# Notes\r\n${original}\r\n`, 1, original, frozen, layout)).toBe(`# Notes\r\n${frozen}\r\n`);
	});
});

describe("newMigrationId", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("is the time in base 36 followed by four random base-36 characters", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(1_800_000_000_000));
		const draws = [0, 0.5, 35.5 / 36, 0.999];
		vi.spyOn(Math, "random").mockImplementation(() => draws.shift() ?? 0);

		// 1_800_000_000_000 is "mywpiww0" in base 36; the draws are the characters 0, i, z, z.
		expect(newMigrationId()).toBe("mywpiww0" + "0izz");
	});
});
