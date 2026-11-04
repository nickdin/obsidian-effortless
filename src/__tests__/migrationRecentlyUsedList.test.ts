/**
 * The recently-used list's three pure rules: what counts as a
 * list, how a path moves to the front, and how the collections are ordered by it.
 */

import { describe, expect, it } from "vitest";
import type { Collection } from "../core/collections";
import { RECENTLY_USED_CAP, moveToFront, orderByRecent, readRecentlyUsed } from "../features/migration/recentlyUsed";

function collection(path: string): Collection {
	return { path, name: path, headingLine: 0, headingLevel: 2, openTasks: 0 };
}

describe("readRecentlyUsed", () => {
	it("reads an array of strings, empty included, as a copy", () => {
		const stored = ["A.md", "B.md"];
		expect(readRecentlyUsed(stored)).toEqual(stored);
		expect(readRecentlyUsed(stored)).not.toBe(stored);
		expect(readRecentlyUsed([])).toEqual([]);
	});

	it.each([["a string", "A.md"], ["a number", 3], ["null", null], ["an object", {}], ["a list with a number", ["A.md", 1]], ["a list with null", [null]]])(
		"refuses %s",
		(_name, stored) => {
			expect(readRecentlyUsed(stored)).toBeNull();
		},
	);
});

describe("moveToFront", () => {
	it("puts the path first and every other one after it, in order", () => {
		expect(moveToFront(["B.md", "C.md"], "A.md")).toEqual(["A.md", "B.md", "C.md"]);
	});

	it("moves a path already there instead of listing it twice", () => {
		expect(moveToFront(["A.md", "B.md", "C.md"], "C.md")).toEqual(["C.md", "A.md", "B.md"]);
	});

	it("keeps ten, and drops the oldest", () => {
		const ten = Array.from({ length: 10 }, (_, i) => `N${i}.md`);
		const next = moveToFront(ten, "New.md");
		expect(RECENTLY_USED_CAP).toBe(10);
		expect(next).toHaveLength(10);
		expect(next[0]).toBe("New.md");
		expect(next).not.toContain("N9.md");
	});

	it("does not change the list it was given", () => {
		const list = ["A.md"];
		moveToFront(list, "B.md");
		expect(list).toEqual(["A.md"]);
	});
});

describe("orderByRecent", () => {
	const [A, B, C] = ["A.md", "B.md", "C.md"].map(collection);

	it("puts the recent ones first in the list's order and the rest after in their own", () => {
		expect(orderByRecent([A, B, C], ["C.md", "B.md"])).toEqual([C, B, A]);
	});

	it("leaves out a path that is not a collection, and places a repeated one once", () => {
		expect(orderByRecent([A, B, C], ["Gone.md", "B.md", "B.md"])).toEqual([B, A, C]);
	});

	it("keeps the given order when nothing is recent", () => {
		expect(orderByRecent([A, B, C], [])).toEqual([A, B, C]);
	});
});
