/**
 * How many finished tasks a collection holds, counted in the same read as its
 * open ones.
 *
 * The startup sweep takes a collection when either count is above zero, so a
 * ticked recurring line that is its collection's only task still gets its
 * next round. Driven from a fake metadata cache, like `collections.test.ts`;
 * every note and task here is invented.
 */

import { describe, expect, it } from "vitest";
import type { CachedMetadata, HeadingCache, ListItemCache, Pos } from "obsidian";
import { collectionIn } from "../core/collections";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";

function layout(): VaultLayout {
	return { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };
}

function at(line: number): Pos {
	return { start: { line, col: 0, offset: 0 }, end: { line, col: 0, offset: 0 } };
}

function heading(text: string, level: number, line: number): HeadingCache {
	return { heading: text, level, position: at(line) };
}

function task(state: string | undefined, line: number): ListItemCache {
	return { task: state, parent: -1, position: at(line) };
}

function cacheOf(headings: HeadingCache[], listItems: ListItemCache[]): CachedMetadata {
	return { headings, listItems };
}

describe("a collection's finished tasks", () => {
	it("counts a done and a cancelled task under the tasks heading, and leaves the open count alone", () => {
		const cache = cacheOf([heading("Tasks", 2, 0)], [task("x", 1), task("-", 2), task(" ", 3)]);

		const found = collectionIn("Rent.md", cache, layout());

		expect(found?.finishedTasks).toBe(2);
		expect(found?.openTasks).toBe(1);
	});

	it("counts a collection whose only task is a ticked one as finished 1 and open 0", () => {
		const found = collectionIn("Rent.md", cacheOf([heading("Tasks", 2, 0)], [task("x", 1)]), layout());

		expect(found?.openTasks).toBe(0);
		expect(found?.finishedTasks).toBe(1);
	});

	it("counts no task at all as finished 0 and open 0", () => {
		const found = collectionIn("Rent.md", cacheOf([heading("Tasks", 2, 0)], [task(undefined, 1)]), layout());

		expect(found?.openTasks).toBe(0);
		expect(found?.finishedTasks).toBe(0);
	});

	it("does not count a copied or a forwarded task as finished", () => {
		const cache = cacheOf([heading("Tasks", 2, 0)], [task("/", 1), task(">", 2)]);

		expect(collectionIn("Rent.md", cache, layout())?.finishedTasks).toBe(0);
	});

	it("counts only between the tasks heading and the next heading of the same size or larger", () => {
		// A done task above the heading, one under a smaller heading inside the
		// range, and one after the next same-size heading: only the middle counts.
		const cache = cacheOf(
			[heading("Tasks", 2, 1), heading("Later", 3, 3), heading("Notes", 2, 5)],
			[task("x", 0), task("x", 4), task("x", 6)],
		);

		expect(collectionIn("Rent.md", cache, layout())?.finishedTasks).toBe(1);
	});
});
