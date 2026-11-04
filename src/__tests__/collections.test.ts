/**
 * Which notes are collections, and how many open tasks each holds.
 *
 * Everything here is driven from a fake metadata cache, because that is the
 * only thing the index is allowed to read: a collection is found from what
 * Obsidian has already parsed, with no file opened at all.
 *
 * The vault and the metadata cache come from the shared Obsidian stub rather
 * than from fakes of their own. The rule this
 * suite exists to prove survives the move: the stub's vault throws from every
 * reading method unless a suite opts in with `allowReads`, and it throws
 * synchronously, so an index that ever opened a file would fail here rather
 * than quietly pass on an unawaited promise.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";
// The stub is imported by path rather than as "obsidian": `tsc` checks this
// file against the real API, and only vitest redirects that name. The plugin
// is cast at the one call that wants a real Obsidian one.
import type { CachedMetadata, HeadingCache, ListItemCache, Pos, TFile } from "obsidian";
import type { Plugin as ObsidianPlugin } from "obsidian";
import { Plugin, Vault } from "./__mocks__/obsidian";
import { CollectionsIndex, collectionIn, noteCachesFrom } from "../core/collections";
import type { NoteCaches } from "../core/collections";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";

/** A layout with the day's log answered, so `isDailyLogPath` has something to say. */
function layout(change: Partial<VaultLayout> = {}): VaultLayout {
	return {
		...defaultData().core.layout,
		dailyLogFolder: "Journal",
		dailyLogFilename: "YYYY-MM-DD",
		...change,
	};
}

/** A cache position on one line. Only the line ever matters here. */
function at(line: number): Pos {
	return { start: { line, col: 0, offset: 0 }, end: { line, col: 0, offset: 0 } };
}

function heading(text: string, level: number, line: number): HeadingCache {
	return { heading: text, level, position: at(line) };
}

/** A list item. `task` is the checkbox character; `" "` is an unticked task. */
function task(state: string | undefined, line: number): ListItemCache {
	return { task: state, parent: -1, position: at(line) };
}

function cacheOf(headings: HeadingCache[], listItems: ListItemCache[] = []): CachedMetadata {
	return { headings, listItems };
}

describe("collectionIn", () => {
	it("makes a note carrying the tasks heading a collection", () => {
		const found = collectionIn("Work/Roof.md", cacheOf([heading("Tasks", 2, 3)]), layout());

		expect(found).not.toBeNull();
		expect(found?.path).toBe("Work/Roof.md");
		expect(found?.name).toBe("Roof");
	});

	it("makes a note without that heading no collection at all", () => {
		const cache = cacheOf([heading("Notes", 1, 0), heading("Ideas", 2, 5)]);

		expect(collectionIn("Work/Roof.md", cache, layout())).toBeNull();
	});

	it("counts a heading at any level, so collections may use different sizes", () => {
		for (const level of [1, 2, 3]) {
			const cache = cacheOf([heading("Tasks", level, 0)]);
			expect(collectionIn("Work/Roof.md", cache, layout())).not.toBeNull();
		}
	});

	// Meeting notes may write its logbook lines as `- [i] [[meeting]]`:
	// beside the tasks heading the range keeps them out, and nested under it the
	// `i` does, since only the space is an open task. That Obsidian lists a
	// `- [i]` line as a task carrying `i` is driven:
	// `docs/acceptance-shots/issue-1269-logbook-line-start-drive.txt`.
	it.each([
		["beside the tasks heading", 2],
		["nested under the tasks heading", 3],
	])("leaves the open-task count as it was for a - [i] logbook line %s", (_case, logbookLevel) => {
		const headings = [heading("Tasks", 2, 0), heading("Logbook", logbookLevel, 2)];
		const without = collectionIn("Work/Roof.md", cacheOf(headings, [task(" ", 1)]), layout());
		const withLine = collectionIn("Work/Roof.md", cacheOf(headings, [task(" ", 1), task("i", 3)]), layout());

		expect(without?.openTasks).toBe(1);
		expect(withLine?.openTasks).toBe(1);
	});

	it("ignores capitals", () => {
		const cache = cacheOf([heading("TASKS", 2, 0)]);

		expect(collectionIn("Work/Roof.md", cache, layout())).not.toBeNull();
	});

	it("refuses a heading with anything appended to it", () => {
		const cache = cacheOf([heading("Tasks (2026)", 2, 0)]);

		expect(collectionIn("Work/Roof.md", cache, layout())).toBeNull();
	});

	it("never makes a note under an excluded folder a collection", () => {
		const cache = cacheOf([heading("Tasks", 2, 0)]);
		const excluded = layout({ excludedFolders: ["Templates"] });

		expect(collectionIn("Templates/Project.md", cache, excluded)).toBeNull();
		expect(collectionIn("Templates/Deep/Project.md", cache, excluded)).toBeNull();
		// A folder whose name merely starts the same is a different folder.
		expect(collectionIn("Templatesque/Project.md", cache, excluded)).not.toBeNull();
	});

	it("never makes the day's log a collection, even with the heading written in it", () => {
		const cache = cacheOf([heading("Tasks", 2, 4)]);

		expect(collectionIn("Journal/2026-09-06.md", cache, layout())).toBeNull();
		expect(collectionIn("Work/2026-09-06.md", cache, layout())).not.toBeNull();
	});

	it("uses the first heading when a note carries it twice", () => {
		const cache = cacheOf(
			[heading("Tasks", 2, 1), heading("Tasks", 2, 6)],
			[task(" ", 2), task(" ", 7)],
		);

		const found = collectionIn("Work/Roof.md", cache, layout());

		expect(found?.headingLine).toBe(1);
		// The second heading closes the first one's range, so only its one task counts.
		expect(found?.openTasks).toBe(1);
	});

	it("makes a note carrying only the completed-tasks heading no collection", () => {
		const cache = cacheOf([heading("Completed tasks", 2, 0)], [task("x", 1)]);

		expect(collectionIn("Work/Roof.md", cache, layout())).toBeNull();
	});

	it("finds nothing at all while the tasks heading setting is blank", () => {
		const cache = cacheOf([heading("", 2, 0), heading("Tasks", 2, 4)]);

		expect(collectionIn("Work/Roof.md", cache, layout({ tasksHeading: "  " }))).toBeNull();
	});

	it("remembers the level the heading was written at in this note", () => {
		const cache = cacheOf([heading("Tasks", 3, 0)]);

		expect(collectionIn("Work/Roof.md", cache, layout())?.headingLevel).toBe(3);
	});

	it("says nothing about a note Obsidian has not parsed yet", () => {
		expect(collectionIn("Work/Roof.md", null, layout())).toBeNull();
	});
});

describe("counting a collection's open tasks", () => {
	it("counts the unticked ones under the tasks heading and no others", () => {
		const cache = cacheOf(
			[heading("Notes", 1, 0), heading("Tasks", 2, 3), heading("Completed tasks", 2, 9)],
			[
				// Above the heading: a checklist in the note's own prose.
				task(" ", 1),
				task(" ", 4),
				task("x", 5),
				task(" ", 6),
				task(undefined, 7),
				// Below the next heading of the same level: already finished.
				task(" ", 10),
			],
		);

		expect(collectionIn("Work/Roof.md", cache, layout())?.openTasks).toBe(2);
	});

	it("keeps a deeper heading inside the range rather than ending it", () => {
		const cache = cacheOf(
			[heading("Tasks", 2, 0), heading("This week", 3, 3)],
			[task(" ", 1), task(" ", 4)],
		);

		expect(collectionIn("Work/Roof.md", cache, layout())?.openTasks).toBe(2);
	});

	it("counts to the end of the note when nothing closes the range", () => {
		const cache = cacheOf([heading("Tasks", 2, 0)], [task(" ", 1), task(" ", 40)]);

		expect(collectionIn("Work/Roof.md", cache, layout())?.openTasks).toBe(2);
	});
});

/* ------------------------------------------------------------------------ */
/* The index, and what keeps it current.                                      */
/* ------------------------------------------------------------------------ */

/** A vault's worth of parsed notes, and the two events that change the answer. */
class FakeCaches implements NoteCaches {
	readonly notes = new Map<string, CachedMetadata>();
	private readonly listeners: (() => void)[] = [];
	/** How many times the index has asked for the vault's notes. */
	sweeps = 0;

	paths(): string[] {
		this.sweeps += 1;
		return [...this.notes.keys()];
	}

	cache(path: string): CachedMetadata | null {
		return this.notes.get(path) ?? null;
	}

	onChange(listener: () => void): void {
		this.listeners.push(listener);
	}

	/** What Obsidian's own events do: tell the index the answer may have moved. */
	fire(): void {
		for (const listener of this.listeners) listener();
	}

	// `CollectionsIndex` never calls the three below; they exist only so this
	// fake still satisfies `NoteCaches`, which `collectionRename.ts` also reads through.
	onRename(): void {}

	fileAt(path: string): TFile | null {
		return this.notes.has(path) ? ({ path } as TFile) : null;
	}

	linkedFrom(): string[] {
		return [];
	}
}

describe("CollectionsIndex", () => {
	let caches: FakeCaches;
	let layoutNow: VaultLayout;
	let index: CollectionsIndex;

	beforeEach(() => {
		caches = new FakeCaches();
		layoutNow = layout();
		index = new CollectionsIndex(caches, () => layoutNow);
	});

	it("lists every collection in the vault and nothing else", () => {
		caches.notes.set("Work/Roof.md", cacheOf([heading("Tasks", 2, 0)], [task(" ", 1)]));
		caches.notes.set("Work/Diary.md", cacheOf([heading("Notes", 1, 0)]));
		caches.notes.set("House/Garden.md", cacheOf([heading("tasks", 1, 0)]));

		expect(index.all().map((c) => c.path)).toEqual(["House/Garden.md", "Work/Roof.md"]);
	});

	it("finds one collection by its path", () => {
		caches.notes.set("Work/Roof.md", cacheOf([heading("Tasks", 2, 0)]));

		expect(index.at("Work/Roof.md")?.name).toBe("Roof");
		expect(index.at("Work/Diary.md")).toBeNull();
	});

	it("answers again from what it already worked out", () => {
		caches.notes.set("Work/Roof.md", cacheOf([heading("Tasks", 2, 0)]));

		index.all();
		index.all();

		expect(caches.sweeps).toBe(1);
	});

	it("is brought back up to date by the events, and only by them", () => {
		caches.notes.set("Work/Roof.md", cacheOf([heading("Tasks", 2, 0)]));
		expect(index.all()).toHaveLength(1);

		caches.notes.set("House/Garden.md", cacheOf([heading("Tasks", 2, 0)]));
		expect(index.all()).toHaveLength(1);

		caches.fire();

		expect(index.all()).toHaveLength(2);
	});

	it("hands back an array no caller can re-order or shorten", () => {
		caches.notes.set("Work/Roof.md", cacheOf([heading("Tasks", 2, 0)]));
		caches.notes.set("House/Garden.md", cacheOf([heading("Tasks", 2, 0)]));
		const collections = index.all();

		// Compile-time rather than runtime: the arrow is never called. The answer
		// is the index's own cached array, so a caller sorting or shortening it
		// would damage every later answer. `readonly Collection[]` offers neither
		// method, and `tsc` fails the build if that is ever loosened.
		() => {
			// @ts-expect-error — sorting in place would re-order the cache itself.
			collections.sort((a, b) => a.name.localeCompare(b.name));
			// @ts-expect-error — pushing would lengthen it.
			collections.push(collections[0]);
		};

		expect(collections.map((c) => c.path)).toEqual(["House/Garden.md", "Work/Roof.md"]);
	});

	it("hands back the very same array again while nothing has changed", () => {
		caches.notes.set("Work/Roof.md", cacheOf([heading("Tasks", 2, 0)]));

		expect(index.all()).toBe(index.all());
	});

	it("keeps its answer when a setting that cannot change it is edited", () => {
		caches.notes.set("Work/Roof.md", cacheOf([heading("Tasks", 2, 0)]));
		index.all();

		layoutNow = layout({ calendarColumns: { time: "Klockan", event: "Händelse" } });
		index.all();

		expect(caches.sweeps).toBe(1);
	});

	it("follows the tasks heading being changed on the settings screen", () => {
		caches.notes.set("Work/Roof.md", cacheOf([heading("Uppgifter", 2, 0)]));
		expect(index.all()).toHaveLength(0);

		layoutNow = layout({ tasksHeading: "Uppgifter" });

		expect(index.all()).toHaveLength(1);
	});
});

/* ------------------------------------------------------------------------ */
/* The adapter onto the real app.                                             */
/* ------------------------------------------------------------------------ */

/**
 * The stub's throwing vault is what turns "the index opens no file" from a
 * claim into a test, so the throw itself is worth a test of its own — and so is
 * the way out, for a suite that legitimately does read files. No suite needs
 * the way out today, which is why it is proved here rather than in one.
 */
describe("the shared stub's vault", () => {
	const file = { path: "Work/Roof.md" };

	it("throws from every reading method, and says which rule the caller broke", () => {
		const vault = new Vault();

		expect(() => vault.read(file)).toThrow(/allowReads/);
		expect(() => vault.cachedRead(file)).toThrow(/allowReads/);
		expect(() => vault.process(file, (data) => data)).toThrow(/allowReads/);
	});

	it("reads once the suite has said it is one that reads files", async () => {
		const vault = new Vault();
		vault.allowReads({ "Work/Roof.md": "## Tasks\n" });

		expect(await vault.cachedRead(file)).toBe("## Tasks\n");
		expect(await vault.process(file, (data) => `${data}- [ ] Mend it\n`)).toBe(
			"## Tasks\n- [ ] Mend it\n",
		);
		expect(await vault.read(file)).toBe("## Tasks\n- [ ] Mend it\n");
	});

	// **Issue #141.** An unlisted path used to read as an empty string. A test
	// that asked for the wrong path — a typo, or a path the code under test
	// built from a setting the test never set — then passed on that empty
	// string, having proved nothing about the path it meant to check.
	it("throws on a path the suite never listed, naming the paths it did list", () => {
		const vault = new Vault();
		vault.allowReads({ "Work/Roof.md": "## Tasks\n" });

		expect(() => vault.read({ path: "Work/Rooof.md" })).toThrow(/read\("Work\/Rooof\.md"\)/);
		expect(() => vault.read({ path: "Work/Rooof.md" })).toThrow(/Work\/Roof\.md/);
		expect(() => vault.cachedRead({ path: "Work/Rooof.md" })).toThrow(/cachedRead/);
		expect(() => vault.process({ path: "Work/Rooof.md" }, (data) => data)).toThrow(/process/);
	});

	it("names no listed path at all when the suite listed none", () => {
		const vault = new Vault();
		vault.allowReads();

		expect(() => vault.read(file)).toThrow(/listed no path at all/);
	});

	// The way out of the throw above, so a suite that genuinely wants an empty
	// file still has one: list the path with an empty string.
	it("reads a path listed as an empty string as an empty file", async () => {
		const vault = new Vault();
		vault.allowReads({ "Work/Roof.md": "" });

		expect(await vault.read(file)).toBe("");
	});
});

describe("noteCachesFrom", () => {
	let plugin: Plugin;
	let index: CollectionsIndex;

	beforeEach(() => {
		plugin = new Plugin();
		index = new CollectionsIndex(
			noteCachesFrom(plugin as unknown as ObsidianPlugin),
			() => layout(),
		);
	});

	it("hooks the rename event as well as the cache's own, which does not fire on a rename", () => {
		expect(plugin.app.metadataCache.names()).toContain("changed");
		expect(plugin.app.vault.names()).toContain("rename");
	});

	it("hooks the vault's delete event, which neither of the other two covers", () => {
		expect(plugin.app.vault.names()).toContain("delete");
	});

	it("puts every subscription through registerEvent, so all three come off at unload", () => {
		expect(plugin.registeredEvents).toHaveLength(3);
	});

	it("drops a deleted collection from the list and from the single-path answer", () => {
		plugin.app.vault.files.push({ path: "Work/Roof.md" });
		plugin.app.metadataCache.caches.set("Work/Roof.md", cacheOf([heading("Tasks", 2, 0)]));
		expect(index.all().map((c) => c.path)).toEqual(["Work/Roof.md"]);

		plugin.app.vault.files.splice(0, 1);
		plugin.app.metadataCache.caches.delete("Work/Roof.md");
		plugin.app.vault.fire("delete");

		expect(index.all()).toEqual([]);
		expect(index.at("Work/Roof.md")).toBeNull();
	});

	it("takes a deleted note that was never a collection in its stride", () => {
		plugin.app.vault.files.push({ path: "Work/Roof.md" }, { path: "Work/Diary.md" });
		plugin.app.metadataCache.caches.set("Work/Roof.md", cacheOf([heading("Tasks", 2, 0)]));
		expect(index.all().map((c) => c.path)).toEqual(["Work/Roof.md"]);

		plugin.app.vault.files.splice(1, 1);
		expect(() => plugin.app.vault.fire("delete")).not.toThrow();

		expect(index.all().map((c) => c.path)).toEqual(["Work/Roof.md"]);
	});

	it("notices a collection being renamed", () => {
		plugin.app.vault.files.push({ path: "Work/Roof.md" });
		plugin.app.metadataCache.caches.set("Work/Roof.md", cacheOf([heading("Tasks", 2, 0)]));
		expect(index.all().map((c) => c.name)).toEqual(["Roof"]);

		plugin.app.vault.files.splice(0, 1, { path: "Work/New roof.md" });
		plugin.app.metadataCache.caches.set("Work/New roof.md", cacheOf([heading("Tasks", 2, 0)]));

		// The cache's `changed` event is documented as staying silent here, so
		// the list is stale until the vault's rename event arrives.
		expect(index.all().map((c) => c.name)).toEqual(["Roof"]);
		plugin.app.vault.fire("rename");

		expect(index.all().map((c) => c.name)).toEqual(["New roof"]);
	});

	it("notices a note being written into a collection", () => {
		plugin.app.vault.files.push({ path: "Work/Roof.md" });
		expect(index.all()).toHaveLength(0);

		plugin.app.metadataCache.caches.set("Work/Roof.md", cacheOf([heading("Tasks", 2, 0)]));
		plugin.app.metadataCache.fire("changed");

		expect(index.all()).toHaveLength(1);
	});

	it("builds the whole list without opening a single file", () => {
		plugin.app.vault.files.push({ path: "Work/Roof.md" }, { path: "Work/Diary.md" });
		plugin.app.metadataCache.caches.set("Work/Roof.md", cacheOf([heading("Tasks", 2, 0)]));

		// The stub's vault throws from read, cachedRead and process: this suite
		// never calls allowReads.
		expect(index.all().map((c) => c.path)).toEqual(["Work/Roof.md"]);
	});
});

describe("NoteCaches — onRename, fileAt and linkedFrom", () => {
	it("onRename shares the same vault subscription onChange already uses, not a second one", () => {
		const plugin = new Plugin();
		const notes = noteCachesFrom(plugin as unknown as ObsidianPlugin);
		notes.onChange(() => undefined);
		notes.onRename(() => undefined);

		expect(plugin.app.vault.names().filter((name) => name === "rename")).toHaveLength(1);
		expect(plugin.registeredEvents).toHaveLength(3);
	});

	it("calls both an onChange listener and an onRename listener from one rename", () => {
		const plugin = new Plugin();
		const notes = noteCachesFrom(plugin as unknown as ObsidianPlugin);
		let changed = 0;
		const renamed: Array<[string, string]> = [];
		notes.onChange(() => {
			changed += 1;
		});
		notes.onRename((file, oldPath) => {
			renamed.push([file.path, oldPath]);
		});

		plugin.app.vault.fire("rename", { path: "New.md" }, "Old.md");

		expect(changed).toBe(1);
		expect(renamed).toEqual([["New.md", "Old.md"]]);
	});

	it("fileAt finds a note among the vault's markdown files, and answers null for one not there", () => {
		const plugin = new Plugin();
		plugin.app.vault.files.push({ path: "Work/Roof.md" });
		const notes = noteCachesFrom(plugin as unknown as ObsidianPlugin);

		expect(notes.fileAt("Work/Roof.md")).toEqual({ path: "Work/Roof.md" });
		expect(notes.fileAt("Work/Missing.md")).toBeNull();
	});

	it("linkedFrom answers from resolvedLinks alone, naming a source only when its count is above zero", () => {
		const plugin = new Plugin();
		plugin.app.metadataCache.resolvedLinks = {
			"Journal/2026-01-05.md": { "Projects/Old.md": 1 },
			"Journal/2026-01-06.md": { "Projects/Old.md": 0 },
			"Projects/Other.md": { "Projects/Unrelated.md": 2 },
		};
		const notes = noteCachesFrom(plugin as unknown as ObsidianPlugin);

		expect(notes.linkedFrom("Projects/Old.md")).toEqual(["Journal/2026-01-05.md"]);
	});
});

describe("the vocabulary this module speaks", () => {
	// A section is a levelled day's-log heading. A collection's tasks heading
	// carries no level, so what this module measures is that heading's *range*,
	// not a section — which is why `sectionEnd` became `headingEnd`.
	//
	// The check is on the identifier alone. A ban on the word "section" in this
	// file's prose would fail the correct comment "not a tasks section", and a
	// ban on one historical sentence would go green the moment anyone reworded
	// it. `GLOSSARY.md`'s own entries are checked in `vaultLayout.test.ts`, next
	// to the type they describe.
	it("has no sectionEnd left in it", () => {
		const source = readFileSync(resolve(__dirname, "..", "core", "collections.ts"), "utf8");
		expect(source).not.toMatch(/\bsectionEnd\b/);
	});
});
