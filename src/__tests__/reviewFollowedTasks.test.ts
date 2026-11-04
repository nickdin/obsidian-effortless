import { beforeEach, describe, expect, it } from "vitest";
import { resetLanguage, setLanguage } from "./__mocks__/obsidian";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { followedTasks } from "../features/review/followedTasks";
import type { CollectionAt, FollowedGroup, FollowedTask } from "../features/review/followedTasks";
import type { ReviewNote } from "../features/review/waitingNotes";

function layout(change: Partial<VaultLayout> = {}): VaultLayout {
	return {
		...defaultData().core.layout,
		dailyLogFolder: "Journal",
		dailyLogFilename: "YYYY-MM-DD",
		...change,
	};
}

/** A note as the reader is handed it; its frontmatter is not read here. */
function note(path: string, ...lines: string[]): ReviewNote {
	return { path, frontmatter: null, text: lines.join("\n") };
}

/** A day's log. `Journal/` and the default filename make it one under `layout()`. */
function dayLog(date: string, ...lines: string[]): ReviewNote {
	return note(`Journal/${date}.md`, ...lines);
}

/**
 * A collection: the shipped tasks heading `Tasks` at level 2, over the given
 * lines. The index below calls exactly the notes under `Projects/` collections.
 */
function collection(name: string, ...lines: string[]): ReviewNote {
	return note(`Projects/${name}.md`, "## Tasks", ...lines);
}

const collectionAt: CollectionAt = (path) => (path.startsWith("Projects/") ? { headingLevel: 2 } : null);

function read(notes: ReviewNote[], change: Partial<VaultLayout> = {}, at: CollectionAt = collectionAt): FollowedGroup[] {
	return followedTasks(notes, layout(change), at);
}

/** Every task of every group as `person → path:line`, the shape most cases compare. */
function places(groups: FollowedGroup[]): Array<[string, string]> {
	return groups.flatMap((group) => group.tasks.map((task): [string, string] => [group.person, `${task.path}:${task.line}`]));
}

describe("where a followed task is found", () => {
	it("is under a collection's tasks heading, filed under its person", () => {
		// If wrong: a reader that skipped collections returns no groups at all.
		const groups = read([collection("Alpha", "- [ ] Chase the quote @[[Elin]]")]);
		expect(groups).toEqual([
			{
				person: "Elin",
				tasks: [{ path: "Projects/Alpha.md", name: "Alpha", line: 1, words: "Chase the quote @[[Elin]]", date: null }],
			},
		]);
	});

	it("is under the notes heading of a day's log", () => {
		// If wrong: a reader that read only collections and other notes returns nothing for the log.
		const groups = read([dayLog("2026-10-14", "# Notes", "- [ ] Ask about the budget @[[Bertil]]")]);
		expect(places(groups)).toEqual([["Bertil", "Journal/2026-10-14.md:1"]]);
	});

	it("is in any section of a note that is neither a collection nor a day's log, a meeting note included", () => {
		// If wrong: a reader that applied the day's-log rule everywhere finds nothing under `# Actions`.
		const meeting = note("Meetings/Planning.md", "---", "processed:", "---", "# Actions", "- [ ] Send the minutes @[[Cecilia]]", "# Other", "- [ ] Book a room @[[Cecilia]]");
		expect(places(read([meeting]))).toEqual([
			["Cecilia", "Meetings/Planning.md:4"],
			["Cecilia", "Meetings/Planning.md:6"],
		]);
	});

	it("is not in a day's log outside the notes heading", () => {
		// If wrong: a reader that took every section of the log lists the Overdue line too.
		const log = dayLog("2026-10-14", "# Notes", "- [ ] Kept @[[Bertil]]", "## Overdue", "- [ ] Overdue @[[Bertil]]", "# Diary", "- [ ] Diary @[[Bertil]]");
		expect(places(read([log]))).toEqual([["Bertil", "Journal/2026-10-14.md:1"]]);
	});

	it("is not in a collection above its tasks heading or below the next heading of its level", () => {
		// If wrong: a reader that took the whole collection lists all three lines.
		const text = ["- [ ] Above @[[Elin]]", "## Tasks", "- [ ] Inside @[[Elin]]", "### Sub", "- [ ] Inside a sub-heading @[[Elin]]", "## Notes", "- [ ] Below @[[Elin]]"];
		expect(places(read([note("Projects/Alpha.md", ...text)]))).toEqual([
			["Elin", "Projects/Alpha.md:2"],
			["Elin", "Projects/Alpha.md:4"],
		]);
	});

	it("is not in a folder the layout excludes", () => {
		// If wrong: a reader that ignored the excluded folders returns the template's task.
		const template = note("Templates/Meeting.md", "- [ ] Follow up @[[Elin]]");
		expect(read([template], { excludedFolders: ["Templates"] })).toEqual([]);
		expect(read([template], { excludedFolders: ["Elsewhere"] })).toHaveLength(1);
	});

	it("is not inside a fenced block or the frontmatter", () => {
		// If wrong: a reader that scanned every line lists both the fenced line and the property.
		const meeting = note("Meetings/Planning.md", "---", "- [ ] In a property @[[Elin]]", "---", "```", "- [ ] In a fence @[[Elin]]", "```", "- [ ] Outside @[[Elin]]");
		expect(places(read([meeting]))).toEqual([["Elin", "Meetings/Planning.md:6"]]);
	});

	it("never takes a day's log for a collection, whatever the index says", () => {
		// If wrong: a reader that believed the index finds no tasks heading in the log and returns nothing.
		const everythingIsOne: CollectionAt = () => ({ headingLevel: 2 });
		const log = dayLog("2026-10-14", "# Notes", "- [ ] Ask @[[Bertil]]");
		expect(places(read([log], {}, everythingIsOne))).toEqual([["Bertil", "Journal/2026-10-14.md:1"]]);
	});

	it("finds nothing in a collection whose tasks heading the text no longer carries", () => {
		// If wrong: a reader that fell back to the whole note lists the task under no heading.
		const gone = note("Projects/Alpha.md", "## Plans", "- [ ] Chase @[[Elin]]");
		expect(read([gone])).toEqual([]);
	});
});

describe("which checkbox is followed", () => {
	const marked = (box: string) => [collection("Alpha", `- [${box}] Chase @[[Elin]]`)];

	it("is open and copied, and the plugin's unknown symbols, which read as open", () => {
		// If wrong: a reader that took only the space leaves out `/` and `I`.
		expect(read(marked(" "))).toHaveLength(1);
		expect(read(marked("/"))).toHaveLength(1);
		expect(read(marked("I"))).toHaveLength(1);
	});

	it.each([
		["done", "x"],
		["cancelled", "-"],
		["forwarded", ">"],
	])("is not %s", (_meaning, box) => {
		// If wrong: a reader that ignored the checkbox lists the line.
		expect(read(marked(box))).toEqual([]);
	});

	it("keeps a copied collection line that carries a pairing comment", () => {
		// If wrong: a reader that skipped lines with a hidden comment, as the waiting-notes count does, returns nothing.
		const groups = read([collection("Alpha", "- [/] Chase the quote @[[Elin]] %% task-consistency:abc123 4f2e9a %%")]);
		expect(places(groups)).toEqual([["Elin", "Projects/Alpha.md:1"]]);
	});
});

describe("a paired task", () => {
	const pairing = "%% task-consistency:abc123 4f2e9a %%";

	it("shows once, as the collection's line, though its copy sits in today's log under Today", () => {
		// If wrong: a reader that read every section of a day's log lists the copy too, and the result holds two rows.
		const alpha = collection("Alpha", `- [/] Chase the quote @[[Elin]] ⏳ 2026-10-15 ${pairing}`);
		const today = dayLog("2026-10-15", "# Notes", "## Today", `- [ ] Chase the quote @[[Elin]] ⏳ 2026-10-15 ${pairing}`);
		expect(places(read([today, alpha]))).toEqual([["Elin", "Projects/Alpha.md:1"]]);
	});

	it("is dropped by the day's-log rule and not by its comment: the same copy under the notes heading is listed", () => {
		// If wrong: were the comment what dropped it, the copy would be absent here too and this would list nothing.
		const copy = `- [ ] Chase the quote @[[Elin]] ${pairing}`;
		expect(places(read([dayLog("2026-10-15", "# Notes", copy)]))).toEqual([["Elin", "Journal/2026-10-15.md:1"]]);
		expect(places(read([dayLog("2026-10-15", "# Notes", "## Today", copy)]))).toEqual([]);
		expect(places(read([dayLog("2026-10-15", "# Notes", "## Overdue", copy)]))).toEqual([]);
	});
});

describe("the people a line names", () => {
	it("lists a line with two marks once under each person, the same path and line", () => {
		// If wrong: a reader that took the first mark only gives one group; one that built a row per mark but a group per line gives one group of two.
		const groups = read([collection("Alpha", "- [ ] Agree the date with @[[Elin]] and @[[Bertil]]")]);
		expect(groups.map((group) => group.person)).toEqual(["Bertil", "Elin"]);
		const [bertil, elin] = groups;
		expect(bertil.tasks).toHaveLength(1);
		expect(elin.tasks).toHaveLength(1);
		expect(bertil.tasks[0]).toEqual(elin.tasks[0]);
		expect(bertil.tasks[0]).toMatchObject({ path: "Projects/Alpha.md", line: 1 });
	});

	it("lists a person named twice on one line once", () => {
		// If wrong: a reader that grouped by mark rather than by person lists the task twice under Elin.
		const groups = read([collection("Alpha", "- [ ] @[[Elin]] to ask @[[Elin|E]]")]);
		expect(groups).toHaveLength(1);
		expect(groups[0].tasks).toHaveLength(1);
	});

	it("groups a mark with an alias or a heading under the link's path", () => {
		// If wrong: a reader that grouped by the alias makes a group `Cecilia W` beside `Cecilia`.
		const groups = read([collection("Alpha", "- [ ] One @[[Cecilia]]", "- [ ] Two @[[Cecilia|Cecilia W]]", "- [ ] Three @[[Cecilia#Notes]]")]);
		expect(groups.map((group) => group.person)).toEqual(["Cecilia"]);
		expect(groups[0].tasks.map((task) => task.line)).toEqual([1, 2, 3]);
	});

	it("does not follow a task with no mark, a bare @name, an email address or a mark with a space", () => {
		// If wrong: a reader that looked for `@` rather than the core's mark reader lists all four.
		const lines = ["- [ ] No mark", "- [ ] Ask @elin", "- [ ] Mail elin@example.com", "- [ ] Ask @ [[Elin]]", "- [ ] A plain link [[Elin]]"];
		expect(read([collection("Alpha", ...lines)])).toEqual([]);
	});

	it("does not follow a mark inside a comment on a task line", () => {
		// If wrong: a reader that asked the mark reader without a task line, or on the raw text, lists Elin.
		const groups = read([collection("Alpha", "- [ ] Chase the quote %% asked @[[Elin]] %%")]);
		expect(groups).toEqual([]);
	});

	it("does not follow a mark on a line that is not a task", () => {
		// If wrong: a reader that read marks on every line lists the bullet and the plain line.
		const groups = read([collection("Alpha", "- Ask @[[Elin]]", "Ask @[[Elin]] today", "- [x]@[[Elin]] unspaced")]);
		expect(groups).toEqual([]);
	});
});

describe("a row", () => {
	it("carries the words with the comment taken out and the mark, dates and tags kept", () => {
		// If wrong: a reader that returned the raw description keeps the comment; one that stripped the mark or dates loses them.
		const line = "- [/] Chase @[[Elin|E]] ⏳ 2026-10-20 #quote %% task-consistency:abc123 4f2e9a %%";
		const [group] = read([collection("Alpha", line)]);
		expect(group.tasks[0].words).toBe("Chase @[[Elin|E]] ⏳ 2026-10-20 #quote");
	});

	it("closes up the words where a comment stood in the middle, and reads only what follows the checkbox", () => {
		// If wrong: a reader that cut only the comment's own characters leaves a double space.
		const [group] = read([collection("Alpha", "  * [ ] Ask %% note %% @[[Elin]] again")]);
		expect(group.tasks[0].words).toBe("Ask @[[Elin]] again");
	});

	it("carries the note's name without folder or extension, and the line's index counting the frontmatter", () => {
		// If wrong: a reader that counted from below the frontmatter gives 2, one that kept the path gives `Meetings/Planning.md`.
		const meeting = note("Meetings/Planning.md", "---", "processed:", "---", "- [ ] Send @[[Elin]]");
		const [group] = read([meeting]);
		expect(group.tasks[0]).toMatchObject({ name: "Planning", line: 3 });
	});

	it("is read the same from a note with Windows line endings, with and without a final line break", () => {
		// If wrong: a reader that kept the `\r` returns words ending in it, and a fence scan that missed it lists the fenced line.
		const body = ["---", "processed:", "---", "```", "- [ ] Fenced @[[Elin]]", "```", "- [ ] Send @[[Elin]] ⏳ 2026-10-20 %% x %%"];
		for (const finalBreak of ["", "\r\n"]) {
			const text = body.join("\r\n") + finalBreak;
			const [group] = read([{ path: "Meetings/Planning.md", frontmatter: null, text }]);
			expect(group.tasks, JSON.stringify(finalBreak)).toEqual([
				{ path: "Meetings/Planning.md", name: "Planning", line: 6, words: "Send @[[Elin]] ⏳ 2026-10-20", date: "2026-10-20" },
			]);
		}
	});
});

describe("the order", () => {
	const tasksOf = (groups: FollowedGroup[], person: string): FollowedTask[] => [...(groups.find((group) => group.person === person)?.tasks ?? [])];

	beforeEach(() => resetLanguage());

	it("puts the groups in alphabetical order of the link path as written, capitals and lower case together", () => {
		// If wrong: a code-point sort lists `bertil` after `Zorro`.
		const groups = read([collection("Alpha", "- [ ] One @[[Zorro]]", "- [ ] Two @[[bertil]]", "- [ ] Three @[[Anders]]", "- [ ] Four @[[Cecilia]]")]);
		expect(groups.map((group) => group.person)).toEqual(["Anders", "bertil", "Cecilia", "Zorro"]);
	});

	it("puts Å, Ä and Ö after Z, in that order, when Obsidian is displayed in Swedish", () => {
		// If wrong: a code-point sort lists Ärla before Åsa and anna after Zorro; an English collator puts Åsa and Ärla among the As.
		setLanguage("sv");
		const groups = read([collection("Alpha", "- [ ] One @[[Örjan]]", "- [ ] Two @[[Zorro]]", "- [ ] Three @[[Ärla]]", "- [ ] Four @[[Åsa]]", "- [ ] Five @[[anna]]")]);
		expect(groups.map((group) => group.person)).toEqual(["anna", "Zorro", "Åsa", "Ärla", "Örjan"]);
	});

	it("puts a task by its scheduled date, or its due date when it has no scheduled date, earliest first", () => {
		// If wrong: a reader in the order found lists Mid, Late, Early; one that read the due date before the scheduled puts Both-scheduled-late first.
		const groups = read([
			collection(
				"Alpha",
				"- [ ] Late @[[Elin]] 📅 2026-11-30",
				"- [ ] Early @[[Elin]] ⏳ 2026-10-01",
				"- [ ] Both @[[Elin]] ⏳ 2026-10-20 📅 2026-10-02",
				"- [ ] Mid @[[Elin]] 📅 2026-10-10",
			),
		]);
		expect(tasksOf(groups, "Elin").map((task) => [task.words.split(" @")[0], task.date])).toEqual([
			["Early", "2026-10-01"],
			["Mid", "2026-10-10"],
			["Both", "2026-10-20"],
			["Late", "2026-11-30"],
		]);
	});

	it("puts the undated last, in note path order and then line order", () => {
		// If wrong: a reader that sorted the undated by date puts them first; one that kept the order the notes were handed in puts Zeta before Alpha.
		const zeta = note("Meetings/Zeta.md", "- [ ] Zeta first @[[Elin]]");
		const alpha = note("Meetings/Alpha.md", "- [ ] Alpha first @[[Elin]]", "- [ ] Alpha second @[[Elin]]", "- [ ] Alpha dated @[[Elin]] ⏳ 2026-10-05");
		const groups = read([zeta, alpha]);
		expect(tasksOf(groups, "Elin").map((task) => `${task.words.split(" @")[0]}`)).toEqual(["Alpha dated", "Alpha first", "Alpha second", "Zeta first"]);
	});

	it("orders a task under each of its people by that person's group alone", () => {
		// If wrong: a reader that sorted once across groups and shared rows by position gives Bertil's group the order of Elin's.
		const groups = read([collection("Alpha", "- [ ] Shared @[[Elin]] @[[Bertil]] ⏳ 2026-10-09", "- [ ] Elin only @[[Elin]] ⏳ 2026-10-01", "- [ ] Bertil only @[[Bertil]] ⏳ 2026-10-20")]);
		expect(tasksOf(groups, "Elin").map((task) => task.line)).toEqual([2, 1]);
		expect(tasksOf(groups, "Bertil").map((task) => task.line)).toEqual([1, 3]);
	});
});
