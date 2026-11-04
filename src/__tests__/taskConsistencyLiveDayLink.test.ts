/**
 * #952's day-link regression, driven through the feature's own live entry
 * rather than `runOverCollection` called directly.
 *
 * `migrationTaskConsistency.test.ts`'s own #952 test drives `runOverCollection`
 * over an in-memory map, with no `NoteWriter`, no open-note hold, no debounce
 * and no vault events — none of the live-only causes #952 itself named
 * ("a reconciliation path taken instead of the fresh-copy path, a stale
 * in-memory read of the collection text, or some other live-only interaction")
 * sit inside what that test can see. This test drives the real
 * `app.vault.on("modify")` event, the feature's own two-second debounce,
 * `checkPath` and `guardedRun` (`taskConsistency.ts`), and a real `NoteWriter`
 * wired the way `main.ts` wires it — `openNoteFromWorkspace`, not the
 * `{ path: () => null }` stub every other Task consistency test uses — so the
 * collection being the note on screen when the due date lands actually parks
 * the write the way it would live, the same shape
 * `taskConsistencyRunTimers.test.ts` uses for its own timer assertions.
 *
 * Every note, collection and task below is invented.
 */

import { describe, expect, it, vi } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin, Vault as ObsidianVault } from "obsidian";
import { Plugin, resetSettings } from "./__mocks__/obsidian";
import type { Collection, Collections } from "../core/collections";
import type { FeatureHost } from "../core/feature";
import { NoteWriter, openNoteFromWorkspace } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore, defaultData } from "../core/settings";
import type { EffortlessData, VaultLayout } from "../core/settings";
import { editTaskField } from "../core/taskLine";
import { dailyLogPath } from "../core/vaultLayout";
import { fileInto } from "../features/migration/fileInto";
import { FEATURE_ID, TaskConsistency } from "../features/taskConsistency";

const ANSWERED: Partial<VaultLayout> = { dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };

function dataWith(): EffortlessData {
	const data = defaultData();
	return { ...data, core: { ...data.core, layout: { ...data.core.layout, ...ANSWERED } } };
}

const layout: VaultLayout = { ...defaultData().core.layout, ...ANSWERED };

const TODAY = new Date(2027, 5, 15, 9, 0);
const TODAY_KEY = "2027-06-15";
const TODAY_PATH = dailyLogPath(TODAY, layout);
const ID = "livedaylink1";
const COLLECTION_PATH = "Toolshed.md";
const COLLECTION_LINK = "[[Toolshed]]";
const LOG_LINK = `[[${TODAY_KEY}]]`;

const COLLECTION = ["# Toolshed", "", "## Tasks", "", "## Notes", "", "Words.", ""].join("\n");
const logWith = (task: string): string => ["# Notes", "", task, "", "## Overdue", "", "## Today", ""].join("\n");

function collectionOf(): Collection {
	return { path: COLLECTION_PATH, name: "Toolshed", headingLine: 0, headingLevel: 2, openTasks: 1 };
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

/** The one line of `text` containing `needle`. */
function lineContaining(text: string, needle: string): string {
	const found = text.split("\n").find((line) => line.includes(needle));
	if (found === undefined) throw new Error(`no line of ${JSON.stringify(text)} contains ${JSON.stringify(needle)}`);
	return found;
}

interface Started {
	readonly plugin: Plugin;
	readonly registry: FeatureRegistry;
	readonly feature: TaskConsistency;
}

/**
 * Starts the plugin with `task-consistency` registered over a real
 * `NoteWriter`, wired to the vault's own `Workspace` through
 * {@link openNoteFromWorkspace} — the production route (`main.ts:82`), not the
 * `{ path: () => null }` stub every other Task consistency test builds
 * `NoteWriter` with. That is the one change from `taskConsistencyRunTimers.test.ts`'s
 * own `startTaskConsistency`, and it is the whole point: a write to the note
 * `plugin.app.workspace.open()` names is held here, and released only once the
 * workspace moves on.
 */
async function startTaskConsistency(data: EffortlessData, collections: Collections): Promise<Started> {
	const plugin = new Plugin();
	plugin.seedData(data);
	plugin.load();
	plugin.app.vault.allowReads({
		[COLLECTION_PATH]: filed.collection,
		[TODAY_PATH]: filed.log,
	});
	plugin.app.vault.files.push({ path: COLLECTION_PATH }, { path: TODAY_PATH });

	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const notes = new NoteWriter(plugin.app.vault as unknown as ObsidianVault, openNoteFromWorkspace(plugin as unknown as ObsidianPlugin));
	const calendar = { meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} };
	const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
	const problems = new Problems();
	const registry = new FeatureRegistry(plugin as unknown as ObsidianPlugin, { settings, collections, problems, device }, notes, calendar);
	let feature: TaskConsistency | undefined;
	registry.register(FEATURE_ID, (host: FeatureHost) => (feature = new TaskConsistency(host)));
	registry.start();
	return { plugin, registry, feature: feature! };
}

const TASK_NO_DATE = "- [ ] Sand the workbench";

const filed = (() => {
	const result = fileInto({
		logText: logWith(TASK_NO_DATE),
		lineIndex: 2,
		collectionText: COLLECTION,
		collectionLink: COLLECTION_LINK,
		logLink: LOG_LINK,
		id: ID,
		layout,
	});
	if (!result.ok) throw new Error(`filing was refused: ${result.reason}`);
	return result;
})();

const DEBOUNCE_MS = 2_000;

describe("a task consistency copy while the collection is the open note", () => {
	it("holds the write until the note is left, and lands with no day-link in the log's live copy", async () => {
		resetSettings();
		vi.useFakeTimers();
		vi.setSystemTime(TODAY);
		try {
			const { plugin } = await startTaskConsistency(dataWith(), {
				all: () => [collectionOf()],
				at: (p) => (p === COLLECTION_PATH ? collectionOf() : null),
			});

			// First trigger: the task carries no due date yet, so nothing is due
			// and nothing is copied. This also proves the fixture's task really
			// starts undue, so a later "still no day-link" read cannot be true
			// merely because nothing was ever copied.
			plugin.app.vault.fire("modify", { path: COLLECTION_PATH });
			await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
			expect(under(plugin.app.vault.readableContents()!.get(TODAY_PATH)!, "## Today")).toEqual([]);

			// The person opens the collection — the note on screen when the due
			// date lands, per #952's own live drive and this ticket's brief.
			plugin.app.workspace.open(COLLECTION_PATH);

			// The person adds a due date to the collection's own line, the way
			// #906's and #952's live drives added it: a separate edit, after
			// filing, through the editor — landing on disk as an ordinary
			// `modify` of the collection.
			const before = plugin.app.vault.readableContents()!.get(COLLECTION_PATH)!;
			const collectionLine = lineContaining(before, "Sand the workbench");
			const after = before.replace(collectionLine, editTaskField(collectionLine, "due", TODAY_KEY));
			plugin.app.vault.readableContents()!.set(COLLECTION_PATH, after);
			plugin.app.vault.fire("modify", { path: COLLECTION_PATH });
			await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

			// Were the write not held while the collection is the open note, the
			// task would already be copied here. The task is due and the run has
			// started (`checkPath` → `guardedRun` → `runOverCollection`), but its
			// own write to the collection is parked in `NoteWriter.edit`'s
			// `untilLeft`, so nothing has changed on disk yet, and the log write
			// that only runs once the collection's own write lands has not even
			// been attempted.
			expect(under(plugin.app.vault.readableContents()!.get(TODAY_PATH)!, "## Today")).toEqual([]);
			expect(plugin.app.vault.readableContents()!.get(COLLECTION_PATH)!).toBe(after);

			// The person leaves the collection. `file-open` fires, `NoteWriter`
			// releases the parked write, and the run finishes.
			plugin.app.workspace.open(null);
			await vi.advanceTimersByTimeAsync(0);

			const liveCopy = under(plugin.app.vault.readableContents()!.get(TODAY_PATH)!, "## Today");
			expect(liveCopy).toHaveLength(1);
			// Were `withoutAppendedLink` not stripping the link on this live call
			// path, the assertion below would fail: `liveCopy[0]` would contain
			// `LOG_LINK` the same way the collection's own copy still does.
			expect(liveCopy[0]).not.toContain(LOG_LINK);
			expect(liveCopy[0]).toContain(" [[Toolshed]] %%");
			expect(liveCopy[0]).not.toContain("→");

			const collectionCopy = lineContaining(plugin.app.vault.readableContents()!.get(COLLECTION_PATH)!, `migration:${ID}`);
			expect(collectionCopy).toContain(LOG_LINK);
		} finally {
			vi.useRealTimers();
		}
	});
});
