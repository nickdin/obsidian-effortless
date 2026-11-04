/**
 * The collections list on the settings screen.
 *
 * The list is not decoration. A note becomes a collection just by carrying the
 * tasks heading, anywhere in the vault, and that permissive rule was only
 * accepted because the list makes every note it catches visible. So the counts
 * and the plain-words empty line are asserted here as behaviour.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { resetSettings } from "./__mocks__/obsidian";
import type { Collection } from "../core/collections";
import { renderCollections } from "../core/collectionsSection";

function collection(path: string, name: string, openTasks: number): Collection {
	return { path, name, headingLine: 0, headingLevel: 2, openTasks };
}

/** The name and count of every row drawn, in the order they were drawn. */
function rows(root: HTMLElement): string[] {
	// `Array.from` rather than a spread: tsconfig targets ES2018, where a
	// NodeList is not yet iterable.
	return Array.from(root.querySelectorAll(".effortless-collection")).map(
		(row) => row.textContent ?? "",
	);
}

describe("renderCollections", () => {
	let body: HTMLElement;
	let opened: string[];

	beforeEach(() => {
		resetSettings();
		document.body.innerHTML = "";
		body = document.createElement("div");
		document.body.appendChild(body);
		opened = [];
	});

	it("lists every collection with its count of open tasks", () => {
		renderCollections(
			body,
			[collection("House/Garden.md", "Garden", 3), collection("Work/Roof.md", "Roof", 0)],
			(path) => opened.push(path),
		);

		expect(rows(body)).toEqual(["Garden3 open tasks", "Roof0 open tasks"]);
	});

	it("says one open task rather than 1 open tasks", () => {
		renderCollections(body, [collection("Work/Roof.md", "Roof", 1)], (path) =>
			opened.push(path),
		);

		expect(rows(body)).toEqual(["Roof1 open task"]);
	});

	it("says 0 collections found in plain words when there are none", () => {
		renderCollections(body, [], (path) => opened.push(path));

		expect(rows(body)).toEqual([]);
		expect(body.textContent).toContain("0 collections found");
	});

	it("opens the note behind the name that was clicked", () => {
		renderCollections(
			body,
			[collection("House/Garden.md", "Garden", 3), collection("Work/Roof.md", "Roof", 0)],
			(path) => opened.push(path),
		);

		const links = body.querySelectorAll<HTMLAnchorElement>(".effortless-collection-name");
		links[1].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

		expect(opened).toEqual(["Work/Roof.md"]);
	});

	it("draws its own heading, so the list is not mistaken for another setting", () => {
		renderCollections(body, [], (path) => opened.push(path));

		expect(body.querySelector(".setting-item-heading")?.textContent).toContain("Collections");
	});
});
