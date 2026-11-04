import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TFile } from "obsidian";
import type { Collection, Collections } from "../core/collections";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { runSweep } from "../features/taskConsistency/run";
import type { RunDeps, RunNotes, RunProblems, RunVault } from "../features/taskConsistency/run";

/**
 * `log-write-refused:<collection.path>` is cleared today
 * only by a later run over the *same* path. #963: when the collection that
 * refusal named stops being one — renamed to a different note, or removed —
 * `runOverCollection` never runs for the old path again (it returns early at
 * `run.ts:431`/`:434`), and `isReservedProblemKey` keeps the sweep's own
 * clearing pass off the key, so the report stands forever. This file drives
 * `runSweep`, the one pass that has read every current collection and can
 * tell a standing key naming a path that is no longer one of them.
 *
 * Every collection, note and path below is invented: no real task, name or
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

const COLLECTION_PATH = "Errands.md";
const REFUSED_MESSAGE = `Effortless could not add "Errands"'s task to today's log: the write was held while the log was the open note and came back stale.`;

function collectionOf(overrides: Partial<Collection> = {}): Collection {
	return { path: COLLECTION_PATH, name: "Errands", headingLine: 0, headingLevel: 2, openTasks: 0, ...overrides };
}

function fakeNotes(files: Map<string, string> = new Map()): RunNotes {
	return {
		read: async (target) => {
			const content = files.get(target.path);
			if (content === undefined) throw new Error(`fakeNotes: nothing at ${target.path}`);
			return content;
		},
		edit: async (target, edit) => {
			const next = edit(files.get(target.path) ?? "");
			files.set(target.path, next);
			return next;
		},
	};
}

function fakeVault(paths: readonly string[]): RunVault {
	return { fileAt: (path) => (paths.includes(path) ? ({ path } as TFile) : null) };
}

function fakeProblems(): RunProblems & { standing: Map<string, string> } {
	const standing = new Map<string, string>();
	return {
		standing,
		report: (key, message) => standing.set(key, message),
		clear: (key) => standing.delete(key),
		list: () => [...standing.keys()],
	};
}

function fakeCollections(all: readonly Collection[]): Collections {
	return {
		all: () => all,
		at: (path) => all.find((collection) => collection.path === path) ?? null,
	};
}

function deps(collections: Collections, vault: RunVault, problems: RunProblems): RunDeps {
	return { collections, vault, notes: fakeNotes(), problems, layout: layout(), today: TODAY };
}

describe("a standing log-write-refused report whose collection stops being one", () => {
	it("clears once the collection is renamed — the report's own path no longer resolves", async () => {
		const problems = fakeProblems();
		problems.report(`log-write-refused:${COLLECTION_PATH}`, REFUSED_MESSAGE);
		// The note that was "Errands.md" is now "Chores.md" — a different path,
		// with no open tasks so the sweep's own run over it is not what is under
		// test here.
		const renamed = collectionOf({ path: "Chores.md", name: "Chores" });
		const runDeps = deps(fakeCollections([renamed]), fakeVault([]), problems);

		await runSweep(runDeps, () => null);

		expect(problems.standing.has(`log-write-refused:${COLLECTION_PATH}`)).toBe(false);
	});

	it("clears once the collection is removed — no note answers that path at all", async () => {
		const problems = fakeProblems();
		problems.report(`log-write-refused:${COLLECTION_PATH}`, REFUSED_MESSAGE);
		const runDeps = deps(fakeCollections([]), fakeVault([]), problems);

		await runSweep(runDeps, () => null);

		expect(problems.standing.has(`log-write-refused:${COLLECTION_PATH}`)).toBe(false);
	});

	it("stays standing while the collection the report names still exists", async () => {
		const problems = fakeProblems();
		problems.report(`log-write-refused:${COLLECTION_PATH}`, REFUSED_MESSAGE);
		// Still a collection at the same path — the sweep's own clearing pass
		// must leave a report whose collection still exists exactly as it found
		// it, whatever else runs.
		const runDeps = deps(fakeCollections([collectionOf()]), fakeVault([]), problems);

		await runSweep(runDeps, () => null);

		expect(problems.standing.has(`log-write-refused:${COLLECTION_PATH}`)).toBe(true);
	});
});
