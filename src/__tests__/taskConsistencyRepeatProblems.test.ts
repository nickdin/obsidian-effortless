import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TFile } from "obsidian";
import type { Collection, Collections } from "../core/collections";
import { defaultData } from "../core/settings";
import { editTaskField } from "../core/taskLine";
import type { VaultLayout } from "../core/settings";
import { dailyLogFrame, dailyLogPath } from "../core/vaultLayout";
import { runOverCollection, runSweep } from "../features/taskConsistency/run";
import type { RunDeps, RunNotes, RunProblems, RunVault } from "../features/taskConsistency/run";

/**
 * The three standing problems a repeat rule can raise: a
 * recurring line with no date, a rule Effortless cannot read, and a collection
 * whose completed-tasks heading is blank. Every test drives `run.ts` — so the
 * round step runs inside the run, as it does in the plugin — against a fake
 * `Collections`, a fake `NoteWriter` and a fake `FeatureProblems`, the shape
 * `taskConsistencyRun.test.ts` uses.
 *
 * Every collection, note and task below is invented: no real task, name or
 * path from any vault.
 */

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(2026, 8, 22, 9, 0));
});
afterEach(() => vi.useRealTimers());

const TODAY = new Date(2026, 8, 22, 9, 0);

function layout(overrides: Partial<VaultLayout> = {}): VaultLayout {
	return {
		...defaultData().core.layout,
		dailyLogFolder: "Journal",
		dailyLogFilename: "YYYY-MM-DD",
		...overrides,
	};
}

/** A collection in a nested folder, so a path in a message would show. */
const COLLECTION_PATH = "Hem/Sysslor/Hushåll.md";
const COLLECTION_NAME = "Hushåll";
const TODAY_LOG_PATH = dailyLogPath(TODAY, layout());

function collectionOf(): Collection {
	return { path: COLLECTION_PATH, name: COLLECTION_NAME, headingLine: 0, headingLevel: 2, openTasks: 1 };
}

/** A collection note: the tasks heading with `lines` under it, then the completed-tasks heading, empty. */
function collectionText(lines: readonly string[], eol = "\n"): string {
	return [`## ${layout().tasksHeading}`, ...lines, "", `## ${layout().completedTasksHeading}`, ""].join(eol);
}

/** The run's world for one collection under `withLayout`: both notes, the fakes, and the deps to run with. */
function world(text: string, withLayout: VaultLayout = layout(), all: readonly Collection[] = [collectionOf()]) {
	const files = new Map([
		[COLLECTION_PATH, text],
		[TODAY_LOG_PATH, dailyLogFrame(withLayout)],
	]);
	const standing = new Map<string, string>();
	const problems: RunProblems = {
		report: (key, message) => standing.set(key, message),
		clear: (key) => standing.delete(key),
		list: () => [...standing.keys()],
	};
	const notes: RunNotes = {
		read: async (target) => {
			const content = files.get(target.path);
			if (content === undefined) throw new Error(`no note at ${target.path}`);
			return content;
		},
		edit: async (target, edit) => {
			const next = edit(files.get(target.path) ?? "");
			files.set(target.path, next);
			return next;
		},
	};
	const vault: RunVault = {
		fileAt: (path) => (files.has(path) ? ({ path } as TFile) : null),
	};
	const collections: Collections = {
		all: () => all,
		at: (path) => all.find((collection) => collection.path === path) ?? null,
	};
	const runDeps: RunDeps = { collections, vault, notes, problems, layout: withLayout, today: TODAY };
	return { files, standing, runDeps };
}

const NO_DATE_KEY = `repeat-no-date:${COLLECTION_PATH}:Vattna blommorna 🔁 every week`;
const UNREADABLE_KEY = `repeat-unreadable:${COLLECTION_PATH}:Städa 🔁 every weekday please`;
const HEADING_KEY = `repeat-no-completed-heading:${COLLECTION_PATH}`;
const BLANK_HEADING = { completedTasksHeading: "" } as const;

describe("a readable rule on a dateless line", () => {
	it("raises the no-date key and message exactly, and leaves both notes byte-identical", async () => {
		// If the report were missing, worded otherwise or keyed otherwise this
		// fails; if the run wrote anything, one of the two byte checks does.
		const text = collectionText(["- [ ] Vattna blommorna 🔁 every week"]);
		const { files, standing, runDeps } = world(text);

		await runOverCollection(runDeps, collectionOf());

		expect([...standing.keys()]).toEqual([NO_DATE_KEY]);
		expect(standing.get(NO_DATE_KEY)).toBe(
			'a task in "Hushåll" repeats but has no date, so no round can be planned: "Vattna blommorna 🔁 every week". The line is untouched; give it a ⏳ or 📅 date.',
		);
		expect(files.get(COLLECTION_PATH)).toBe(text);
		expect(files.get(TODAY_LOG_PATH)).toBe(dailyLogFrame(layout()));
	});

	it("reports a ticked dateless line too, and the line stays under the tasks heading", async () => {
		const text = collectionText(["- [x] Vattna blommorna 🔁 every week"]);
		const { files, standing, runDeps } = world(text);

		await runOverCollection(runDeps, collectionOf());

		expect([...standing.keys()]).toEqual([NO_DATE_KEY]);
		expect(files.get(COLLECTION_PATH)).toBe(text);
	});
});

describe("an unreadable rule", () => {
	it("raises the unreadable key and message exactly, quoting the rule, and leaves both notes byte-identical", async () => {
		// If the rule were not quoted, or the line were reported as a dateless
		// one, the message or the key list differs.
		const text = collectionText(["- [ ] Städa 🔁 every weekday please"]);
		const { files, standing, runDeps } = world(text);

		await runOverCollection(runDeps, collectionOf());

		expect([...standing.keys()]).toEqual([UNREADABLE_KEY]);
		expect(standing.get(UNREADABLE_KEY)).toBe(
			'a task in "Hushåll" has a repeat rule Effortless cannot read, "🔁 every weekday please", so it is treated as a task that does not repeat: "Städa 🔁 every weekday please". The line is untouched.',
		);
		expect(files.get(COLLECTION_PATH)).toBe(text);
		expect(files.get(TODAY_LOG_PATH)).toBe(dailyLogFrame(layout()));
	});

	it("still copies into today's log as a task that does not repeat, and the report never names the pairing", async () => {
		// If the unreadable rule held the line back from copy-in, the log would
		// stay empty; if the pairing marker leaked into the words, the message
		// would carry it.
		const text = collectionText(["- [ ] Städa 🔁 every weekday please ⏳ 2026-09-22"]);
		const { files, standing, runDeps } = world(text);

		await runOverCollection(runDeps, collectionOf());

		const log = files.get(TODAY_LOG_PATH)!;
		expect(log).toContain("Städa 🔁 every weekday please");
		expect(log).toContain("Hushåll");
		expect(files.get(COLLECTION_PATH)).toContain("%%");
		const key = `repeat-unreadable:${COLLECTION_PATH}:Städa 🔁 every weekday please`;
		expect([...standing.keys()]).toEqual([key]);

		// The second run reads the line with its pairing marker on it; the key
		// and the message are the same words, or the notice would be raised
		// twice, once before the copy and once after.
		await runOverCollection(runDeps, collectionOf());

		expect([...standing.keys()]).toEqual([key]);
		expect(standing.get(key)).not.toContain("%%");
		expect(standing.get(key)).toContain('"Städa 🔁 every weekday please ⏳ 2026-09-22"');
	});

	it("finishes as a task that does not repeat: ticked in today's log, it moves under the completed-tasks heading with no fresh round, and the report clears", async () => {
		// If the run read the rule as a round, a fresh open line would appear
		// under the tasks heading; if it left the line there, nothing would move.
		const { files, standing, runDeps } = world(collectionText(["- [ ] Städa 🔁 every weekday please ⏳ 2026-09-22"]));
		await runOverCollection(runDeps, collectionOf());
		files.set(TODAY_LOG_PATH, files.get(TODAY_LOG_PATH)!.replace("- [ ] Städa", "- [x] Städa"));

		await runOverCollection(runDeps, collectionOf());
		await runOverCollection(runDeps, collectionOf());

		const lines = files.get(COLLECTION_PATH)!.split("\n");
		const completedAt = lines.indexOf(`## ${layout().completedTasksHeading}`);
		const tasksAt = lines.indexOf(`## ${layout().tasksHeading}`);
		expect(lines.filter((line) => line.includes("Städa"))).toHaveLength(1);
		expect(lines.findIndex((line) => line.includes("Städa"))).toBeGreaterThan(completedAt);
		expect(completedAt).toBeGreaterThan(tasksAt);
		expect(standing.size).toBe(0);
	});
});

describe("a recurring task under a blank completed-tasks heading", () => {
	const blank = layout(BLANK_HEADING);

	it("raises the collection key once however many recurring lines the collection holds, and writes nothing", async () => {
		// If the key were raised per line, two more keys would stand; if the
		// message differs the exact check fails; a write would change the bytes.
		const text = [
			`## ${blank.tasksHeading}`,
			"- [ ] Vattna blommorna 🔁 every week ⏳ 2026-10-06",
			"- [x] Byta filter 🔁 every month ⏳ 2026-09-01",
			"- [ ] Torka fönstren 🔁 every 2 weeks ⏳ 2026-10-20",
			"",
		].join("\n");
		const { files, standing, runDeps } = world(text, blank);

		await runOverCollection(runDeps, collectionOf());

		expect([...standing.keys()]).toEqual([HEADING_KEY]);
		expect(standing.get(HEADING_KEY)).toBe(
			'a task in "Hushåll" repeats, but the completed-tasks heading is blank, so no round can be planned. Name one in the collections settings.',
		);
		expect(files.get(COLLECTION_PATH)).toBe(text);
	});

	it("is raised for an open dated line before anything is ticked", async () => {
		const text = [`## ${blank.tasksHeading}`, "- [ ] Vattna blommorna 🔁 every week ⏳ 2026-10-06", ""].join("\n");
		const { standing, runDeps } = world(text, blank);

		await runOverCollection(runDeps, collectionOf());

		expect([...standing.keys()]).toEqual([HEADING_KEY]);
	});

	it("is not raised for a collection without a recurring task, or one whose only rule cannot be read", async () => {
		const text = [`## ${blank.tasksHeading}`, "- [ ] Handla ⏳ 2026-10-06", "- [ ] Städa 🔁 every weekday please", ""].join("\n");
		const { standing, runDeps } = world(text, blank);

		await runOverCollection(runDeps, collectionOf());

		expect([...standing.keys()]).toEqual([UNREADABLE_KEY]);
	});
});

describe("a standing report clears by itself", () => {
	it("clears the no-date key once the line gained a date", async () => {
		const { files, standing, runDeps } = world(collectionText(["- [ ] Vattna blommorna 🔁 every week"]));
		await runOverCollection(runDeps, collectionOf());
		expect(standing.has(NO_DATE_KEY)).toBe(true);

		files.set(COLLECTION_PATH, collectionText(["- [ ] Vattna blommorna 🔁 every week ⏳ 2026-10-06"]));
		await runOverCollection(runDeps, collectionOf());

		expect(standing.size).toBe(0);
	});

	it("clears the unreadable key once the rule was corrected", async () => {
		const { files, standing, runDeps } = world(collectionText(["- [ ] Städa 🔁 every weekday please"]));
		await runOverCollection(runDeps, collectionOf());
		expect(standing.has(UNREADABLE_KEY)).toBe(true);

		files.set(COLLECTION_PATH, collectionText(["- [ ] Städa 🔁 every weekday ⏳ 2026-10-06"]));
		await runOverCollection(runDeps, collectionOf());

		// The corrected rule is a dated, readable one: nothing is wrong with it.
		expect(standing.size).toBe(0);
	});

	it("clears either key once the line was removed", async () => {
		const { files, standing, runDeps } = world(
			collectionText(["- [ ] Vattna blommorna 🔁 every week", "- [ ] Städa 🔁 every weekday please"]),
		);
		await runOverCollection(runDeps, collectionOf());
		expect([...standing.keys()].sort()).toEqual([NO_DATE_KEY, UNREADABLE_KEY].sort());

		files.set(COLLECTION_PATH, collectionText([]));
		await runOverCollection(runDeps, collectionOf());

		expect(standing.size).toBe(0);
	});

	it("clears the collection key once the heading was named", async () => {
		const text = ["## Tasks", "- [ ] Vattna blommorna 🔁 every week ⏳ 2026-10-06", ""].join("\n");
		const blankWorld = world(text, layout(BLANK_HEADING));
		await runOverCollection(blankWorld.runDeps, collectionOf());
		expect(blankWorld.standing.has(HEADING_KEY)).toBe(true);

		const named = world(collectionText(["- [ ] Vattna blommorna 🔁 every week ⏳ 2026-10-06"]));
		blankWorld.files.set(COLLECTION_PATH, named.files.get(COLLECTION_PATH)!);
		await runOverCollection({ ...blankWorld.runDeps, layout: layout() }, collectionOf());

		expect(blankWorld.standing.size).toBe(0);
	});

	it("clears the collection key once the last recurring line left the collection", async () => {
		const blank = layout(BLANK_HEADING);
		const text = [`## ${blank.tasksHeading}`, "- [ ] Vattna blommorna 🔁 every week ⏳ 2026-10-06", ""].join("\n");
		const { files, standing, runDeps } = world(text, blank);
		await runOverCollection(runDeps, collectionOf());
		expect(standing.has(HEADING_KEY)).toBe(true);

		files.set(COLLECTION_PATH, [`## ${blank.tasksHeading}`, "- [ ] Handla ⏳ 2026-10-06", ""].join("\n"));
		await runOverCollection(runDeps, collectionOf());

		expect(standing.size).toBe(0);
	});

	it("retires the old key and raises a new one with the new words when a faulty line is reworded", async () => {
		// If the key were the line's position, the old key would survive the
		// rewording; if the old key were not retired, two would stand.
		const { files, standing, runDeps } = world(collectionText(["- [ ] Vattna blommorna 🔁 every week"]));
		await runOverCollection(runDeps, collectionOf());
		expect([...standing.keys()]).toEqual([NO_DATE_KEY]);

		files.set(COLLECTION_PATH, collectionText(["- [ ] Vattna alla blommor 🔁 every week"]));
		await runOverCollection(runDeps, collectionOf());

		const reworded = `repeat-no-date:${COLLECTION_PATH}:Vattna alla blommor 🔁 every week`;
		expect([...standing.keys()]).toEqual([reworded]);
		expect(standing.get(reworded)).toContain('"Vattna alla blommor 🔁 every week"');
	});

	it("keeps a faulty line's key when the line only moves", async () => {
		const { files, standing, runDeps } = world(collectionText(["- [ ] Vattna blommorna 🔁 every week"]));
		await runOverCollection(runDeps, collectionOf());

		files.set(COLLECTION_PATH, collectionText(["- [ ] Handla ⏳ 2026-10-06", "- [ ] Vattna blommorna 🔁 every week"]));
		await runOverCollection(runDeps, collectionOf());

		expect([...standing.keys()]).toEqual([NO_DATE_KEY]);
	});

	it("leaves another collection's keys alone", async () => {
		const { standing, runDeps } = world(collectionText(["- [ ] Vattna blommorna 🔁 every week"]));
		standing.set("repeat-no-date:Andra/Lista.md:Plocka 🔁 every day", "another collection's report");

		await runOverCollection(runDeps, collectionOf());

		expect(standing.get("repeat-no-date:Andra/Lista.md:Plocka 🔁 every day")).toBe("another collection's report");
	});
});

describe("the sweep that clears a collection's keys when it stops being one", () => {
	const blank = layout(BLANK_HEADING);
	const text = [
		`## ${blank.tasksHeading}`,
		"- [ ] Vattna blommorna 🔁 every week",
		"- [ ] Städa 🔁 every weekday please",
		"",
	].join("\n");
	const resolveLink = () => null;

	it("clears all three keys of a path that is no longer a collection, and keeps them while it is one", async () => {
		// The control half fails if the sweep clears every repeat key; the
		// second half fails if it clears none.
		const { standing, runDeps } = world(text, blank);
		await runOverCollection(runDeps, collectionOf());
		expect([...standing.keys()].sort()).toEqual([NO_DATE_KEY, UNREADABLE_KEY, HEADING_KEY].sort());

		await runSweep(runDeps, resolveLink);
		expect(standing.size).toBe(3);

		await runSweep({ ...runDeps, collections: { all: () => [], at: () => null } }, resolveLink);
		expect(standing.size).toBe(0);
	});
});

describe("what the messages never carry", () => {
	it("holds no path and no line number, against a collection in a nested folder", async () => {
		// The faulty lines stand at line numbers 3, 4 and 5 of a note in
		// "Hem/Sysslor/": a message carrying either would show a digit or a path.
		const blank = layout(BLANK_HEADING);
		const text = [
			`## ${blank.tasksHeading}`,
			"- [ ] Handla ⏳ 2026-10-06",
			"- [ ] Handla mer ⏳ 2026-10-06",
			"- [ ] Vattna blommorna 🔁 every week",
			"- [ ] Städa 🔁 every weekday please",
			"",
		].join("\n");
		const { standing, runDeps } = world(text, blank);

		await runOverCollection(runDeps, collectionOf());

		expect(standing.size).toBe(3);
		for (const [key, message] of standing) {
			expect(message, key).not.toMatch(/Hem|Sysslor|\.md|\//u);
			expect(message, key).not.toMatch(/\d/u);
			expect(message, key).not.toMatch(/%%|eid|marker/iu);
		}
	});

	it("reads a note with Windows line endings, ending in a line break and not, without a carriage return in a key or a message", async () => {
		for (const final of ["\r\n", ""]) {
			const text = collectionText(["- [ ] Vattna blommorna 🔁 every week", "- [ ] Städa 🔁 every weekday please"], "\r\n") + final;
			const { files, standing, runDeps } = world(text);

			await runOverCollection(runDeps, collectionOf());

			expect([...standing.keys()].sort()).toEqual([NO_DATE_KEY, UNREADABLE_KEY].sort());
			for (const [key, message] of standing) {
				expect(key).not.toContain("\r");
				expect(message).not.toContain("\r");
			}
			expect(files.get(COLLECTION_PATH)).toBe(text);
		}
	});
});

describe("a pairing the run holds untouched keeps its repeat keys", () => {
	/** Pairs `line` through one run, then edits its priority on both sides differently, so the next run finds the pairing clashing and holds it. */
	async function clashed(line: string, withLayout: VaultLayout) {
		const made = world(collectionText([line]), withLayout);
		await runOverCollection(made.runDeps, collectionOf());
		const collectionLine = made.files.get(COLLECTION_PATH)!.split("\n").find((candidate) => candidate.includes("🔁"))!;
		const logLine = made.files.get(TODAY_LOG_PATH)!.split("\n").find((candidate) => candidate.includes("🔁"))!;
		made.files.set(COLLECTION_PATH, made.files.get(COLLECTION_PATH)!.replace(collectionLine, editTaskField(collectionLine, "priority", "high")));
		made.files.set(TODAY_LOG_PATH, made.files.get(TODAY_LOG_PATH)!.replace(logLine, editTaskField(logLine, "priority", "low")));
		return made;
	}

	it("keeps the unreadable-rule key while the clash stands", async () => {
		// If a held line's key were cleared with the keys of lines the round
		// step looked at, the list would hold only the clash's own key.
		const { files, standing, runDeps } = await clashed("- [ ] Städa 🔁 every weekday please ⏳ 2026-09-22", layout());
		expect([...standing.keys()].filter((key) => key.startsWith("repeat-"))).toHaveLength(1);

		await runOverCollection(runDeps, collectionOf());

		// The priority the test added is part of the line's words as it now
		// stands, so the key names the line with it.
		expect(standing.size).toBe(2);
		expect([...standing.keys()].filter((key) => key.startsWith("repeat-"))).toEqual([
			`repeat-unreadable:${COLLECTION_PATH}:Städa 🔁 every weekday please ⏫`,
		]);
		expect([...standing.keys()].filter((key) => !key.startsWith("repeat-"))).toHaveLength(1);
		expect(files.get(COLLECTION_PATH)).toContain("⏫");
	});

	it("keeps the blank-heading key while a held recurring line is the collection's only one", async () => {
		// If the held line did not count toward the heading, the key would clear.
		const blank = layout(BLANK_HEADING);
		const { standing, runDeps } = await clashed("- [ ] Vattna blommorna 🔁 every week ⏳ 2026-09-22", blank);
		expect(standing.has(HEADING_KEY)).toBe(true);

		await runOverCollection(runDeps, collectionOf());

		expect(standing.has(HEADING_KEY)).toBe(true);
	});
});

describe("the unreadable-rule key stands while the task's date moves", () => {
	it("keeps the same key when the log copy's date moves and the run carries it to the collection line, and still quotes the line as it stands", async () => {
		// If the key held the line's dates, the second run would retire the first
		// key and raise another; the message is the only place a date may stay.
		const { files, standing, runDeps } = world(collectionText(["- [ ] Städa 🔁 every weekday please ⏳ 2026-09-22"]));
		await runOverCollection(runDeps, collectionOf());
		const first = [...standing.keys()];
		expect(first).toHaveLength(1);

		files.set(TODAY_LOG_PATH, files.get(TODAY_LOG_PATH)!.replace("⏳ 2026-09-22", "⏳ 2026-09-23"));
		await runOverCollection(runDeps, collectionOf());

		expect(files.get(COLLECTION_PATH)).toContain("⏳ 2026-09-23");
		expect([...standing.keys()]).toEqual(first);
		expect(standing.get(first[0])).toContain("⏳ 2026-09-23");
	});

	it("keys the line by its words alone: no date and no pairing marker in the key", async () => {
		const { standing, runDeps } = world(collectionText(["- [ ] Städa 🔁 every weekday please 📅 2026-10-01 ⏳ 2026-09-22"]));
		await runOverCollection(runDeps, collectionOf());
		await runOverCollection(runDeps, collectionOf());

		expect([...standing.keys()]).toEqual([UNREADABLE_KEY]);
	});
});

describe("a finished unreadable-rule line is not reported as untouched", () => {
	it("clears the key in the same run that moves the finished line under the completed-tasks heading", async () => {
		// If the report were made from the answer taken before the finishing
		// move, one run later the key would still stand and say "The line is
		// untouched" about a line that run has just moved.
		const { files, standing, runDeps } = world(collectionText(["- [ ] Städa 🔁 every weekday please ⏳ 2026-09-22"]));
		await runOverCollection(runDeps, collectionOf());
		expect(standing.size).toBe(1);
		files.set(TODAY_LOG_PATH, files.get(TODAY_LOG_PATH)!.replace("- [ ] Städa", "- [x] Städa"));

		await runOverCollection(runDeps, collectionOf());

		const lines = files.get(COLLECTION_PATH)!.split("\n");
		expect(lines.findIndex((line) => line.includes("Städa"))).toBeGreaterThan(lines.indexOf(`## ${layout().completedTasksHeading}`));
		expect([...standing.keys()]).toEqual([]);
	});

	it("raises no notice for a line that arrives ticked and is moved in its first run", async () => {
		// The paired, already ticked line is the case where the key was not
		// standing yet, so the old report was a fresh notice about a line that
		// had just finished normally.
		const notices: string[] = [];
		const { files, standing, runDeps } = world(collectionText(["- [ ] Städa 🔁 every weekday please ⏳ 2026-09-22"]));
		const spy = { ...runDeps.problems, report: (key: string, message: string) => { notices.push(key); runDeps.problems.report(key, message); } };
		await runOverCollection({ ...runDeps, problems: runDeps.problems }, collectionOf());
		standing.clear();
		files.set(TODAY_LOG_PATH, files.get(TODAY_LOG_PATH)!.replace("- [ ] Städa", "- [x] Städa"));

		await runOverCollection({ ...runDeps, problems: spy }, collectionOf());

		expect(notices).toEqual([]);
	});
});

describe("a note read without a final line break", () => {
	/** `lines` joined with Windows endings and no ending after the last one. */
	const unended = (lines: readonly string[]) => lines.join("\r\n");

	it.each([
		["a dateless recurring line", layout(), [`## ${layout().tasksHeading}`, "- [ ] Vattna blommorna 🔁 every week"], NO_DATE_KEY],
		["an unreadable rule", layout(), [`## ${layout().tasksHeading}`, "- [ ] Städa 🔁 every weekday please"], UNREADABLE_KEY],
		[
			"a blank completed-tasks heading",
			layout(BLANK_HEADING),
			[`## ${layout().tasksHeading}`, "- [ ] Vattna blommorna 🔁 every week ⏳ 2026-10-06"],
			HEADING_KEY,
		],
	])("raises %s's exact key from a last line with no line break after it, with no carriage return anywhere", async (_name, withLayout, lines, key) => {
		// If the key or the message took a `\r` from a last line that has no
		// line break after it, the key would differ from the exact words or the
		// message would hold the character.
		const text = unended(lines);
		const { files, standing, runDeps } = world(text, withLayout);

		await runOverCollection(runDeps, collectionOf());

		expect([...standing.keys()]).toEqual([key]);
		for (const [standingKey, message] of standing) {
			expect(standingKey).not.toContain("\r");
			expect(message).not.toContain("\r");
		}
		expect(files.get(COLLECTION_PATH)).toBe(text);
	});
});

describe("an unreadable-rule task rolls over as a task that does not repeat", () => {
	it("rolls an open line from yesterday's log into today's overdue section, with no fresh round in the collection and the key still standing", async () => {
		// If the rule were read as a round, the collection would gain a second
		// line; if it held the line back, today's log would lack the rolled copy
		// and yesterday's line would stay open.
		const yesterday = new Date(2026, 8, 21, 9, 0);
		const yesterdayPath = dailyLogPath(yesterday, layout());
		const { files, standing, runDeps } = world(collectionText(["- [ ] Städa 🔁 every weekday please ⏳ 2026-09-21"]));
		files.set(yesterdayPath, dailyLogFrame(layout()));
		await runOverCollection({ ...runDeps, today: yesterday }, collectionOf());
		expect(files.get(yesterdayPath)).toContain("- [ ] Städa");
		expect(files.get(TODAY_LOG_PATH)).not.toContain("Städa");

		await runOverCollection(runDeps, collectionOf());

		const today = files.get(TODAY_LOG_PATH)!;
		const overdueAt = today.split("\n").indexOf(`## ${layout().overdueHeading.text}`);
		const rolledAt = today.split("\n").findIndex((line) => line.includes("- [ ] Städa"));
		expect(overdueAt).toBeGreaterThanOrEqual(0);
		expect(rolledAt).toBe(overdueAt + 1);
		expect(files.get(yesterdayPath)).toContain("- [>] Städa");
		expect(files.get(yesterdayPath)).not.toContain("- [ ] Städa");
		expect(files.get(COLLECTION_PATH)!.split("\n").filter((line) => line.includes("Städa"))).toHaveLength(1);
		expect([...standing.keys()]).toEqual([UNREADABLE_KEY]);
	});
});

describe("a rule the reader does not capture is reported as unreadable", () => {
	const SWEDISH_KEY = `repeat-unreadable:${COLLECTION_PATH}:Vattna blommorna 🔁 varje måndag`;
	const BARE_KEY = `repeat-unreadable:${COLLECTION_PATH}:Byta filter 🔁`;

	it("raises a key each for a rule with a Swedish letter and a bare sign, quoting what follows the sign", async () => {
		// If the scan still skipped a line whose rule the reader did not take, no
		// key would stand; if the message checked the rule as one the plugin
		// writes, the run would throw on "varje måndag".
		const text = collectionText(["- [ ] Vattna blommorna 🔁 varje måndag ⏳ 2026-09-22", "- [ ] Byta filter 🔁"]);
		const { standing, runDeps } = world(text);

		await runOverCollection(runDeps, collectionOf());

		expect([...standing.keys()].sort()).toEqual([SWEDISH_KEY, BARE_KEY].sort());
		expect(standing.get(SWEDISH_KEY)).toBe(
			'a task in "Hushåll" has a repeat rule Effortless cannot read, "🔁 varje måndag", so it is treated as a task that does not repeat: "Vattna blommorna 🔁 varje måndag ⏳ 2026-09-22". The line is untouched.',
		);
		expect(standing.get(BARE_KEY)).toBe(
			'a task in "Hushåll" has a repeat rule Effortless cannot read, "🔁", so it is treated as a task that does not repeat: "Byta filter 🔁". The line is untouched.',
		);
	});

	it("raises nothing for a line with no sign or a readable dated rule", async () => {
		const text = collectionText(["- [ ] Handla ⏳ 2026-09-22", "- [ ] Kratta löv 🔁 every week ⏳ 2026-09-22"]);
		const { standing, runDeps } = world(text);

		await runOverCollection(runDeps, collectionOf());

		expect([...standing.keys()]).toEqual([]);
	});

	it("reports each line once: the second run, reading the pairing marker the first wrote, raises no new key", async () => {
		// If the key took the pairing marker, or the date the run carries, the
		// second run would raise a second key for the same line.
		const text = collectionText(["- [ ] Vattna blommorna 🔁 varje måndag ⏳ 2026-09-22", "- [ ] Byta filter 🔁"]);
		const { files, standing, runDeps } = world(text);
		const raised = new Set<string>();
		const report = runDeps.problems.report;
		const counted: RunDeps = {
			...runDeps,
			problems: { ...runDeps.problems, report: (key, message) => (raised.add(key), report(key, message)) },
		};

		await runOverCollection(counted, collectionOf());
		expect(files.get(COLLECTION_PATH)).toContain("%%");
		await runOverCollection(counted, collectionOf());

		expect([...raised].sort()).toEqual([SWEDISH_KEY, BARE_KEY].sort());
		expect([...standing.keys()].sort()).toEqual([SWEDISH_KEY, BARE_KEY].sort());
	});

	it("reads a note with Windows line endings, ending in a line break and not, leaving both notes byte-identical", async () => {
		// The dated rule is dated after today, so nothing is copied in and the
		// run writes nothing. The bare sign is the note's last line, so it is
		// read once with "\r\n" after it and once with nothing: a carriage return
		// taken into the quoted text, or a write the report made, would show in
		// a key, a message or the bytes.
		for (const final of ["\r\n", ""]) {
			const text =
				[
					`## ${layout().completedTasksHeading}`,
					"",
					`## ${layout().tasksHeading}`,
					"- [ ] Vattna blommorna 🔁 varje måndag ⏳ 2026-10-06",
					"- [ ] Byta filter 🔁",
				].join("\r\n") + final;
			const { files, standing, runDeps } = world(text);

			await runOverCollection(runDeps, collectionOf());

			expect([...standing.keys()].sort(), JSON.stringify(final)).toEqual([SWEDISH_KEY, BARE_KEY].sort());
			for (const [key, message] of standing) {
				expect(key).not.toContain("\r");
				expect(message).not.toContain("\r");
			}
			expect(files.get(COLLECTION_PATH)).toBe(text);
			expect(files.get(TODAY_LOG_PATH)).toBe(dailyLogFrame(layout()));
			expect(text.endsWith(`\r\n- [ ] Byta filter 🔁${final}`)).toBe(true);
		}
	});
});
