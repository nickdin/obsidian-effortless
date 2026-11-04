/**
 * The box that asks which collection: its list, its rows and what dismissing
 * it does. The
 * dialog comes from the Obsidian stub's `FuzzySuggestModal`, which reproduces
 * the interface and not the real fuzzy ranking, so what is asserted is the item
 * list, the row's text and the route to `onChooseItem`.
 */

import { describe, expect, it, vi } from "vitest";
import type { App as ObsidianApp } from "obsidian";
import { App } from "./__mocks__/obsidian";
import type { FuzzySuggestModal as StubFuzzySuggestModal } from "./__mocks__/obsidian";
import type { Collection } from "../core/collections";
import { CollectionChooser, folderOf } from "../features/migration/chooser";
import type { ChooserItem } from "../features/migration/chooser";

function collection(path: string): Collection {
	const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
	return { path, name, headingLine: 0, headingLevel: 2, openTasks: 0 };
}

const SHED = collection("Projects/Garden shed.md");
const KITCHEN = collection("Projects/Kitchen.md");
const OTHER_SHED = collection("Archive/Garden shed.md");

/** The stub's own extras — `chooseAt` and `isOpen` — that the published type does not have. */
function stubOf(chooser: CollectionChooser): StubFuzzySuggestModal<ChooserItem> {
	return chooser as unknown as StubFuzzySuggestModal<ChooserItem>;
}

function chooserOver(collections: Collection[], chosen: ChooserItem[] = [], notePaths: string[] = []): CollectionChooser {
	return new CollectionChooser(new App() as unknown as ObsidianApp, collections, notePaths, (each) => chosen.push(each));
}

function asItem(each: Collection): ChooserItem {
	return { path: each.path, name: each.name, isCollection: true };
}

const PLAIN_PATHS = ["Ideas/Garden party.md", "Ideas/Shed roof notes.md", "Loose.md"];

function pathsFor(chooser: CollectionChooser, query: string): string[] {
	return chooser.getSuggestions(query).map((each) => each.item.path);
}

describe("the collection chooser", () => {
	it("offers exactly the collections it was given, in the order given", () => {
		expect(chooserOver([SHED, KITCHEN]).getItems()).toEqual([asItem(SHED), asItem(KITCHEN)]);
	});

	it("filters by what is typed, by name or by folder", () => {
		const chooser = chooserOver([SHED, KITCHEN, OTHER_SHED]);

		expect(chooser.getSuggestions("kit").map((each) => each.item)).toEqual([asItem(KITCHEN)]);
		expect(chooser.getSuggestions("archive").map((each) => each.item)).toEqual([asItem(OTHER_SHED)]);
		expect(chooser.getSuggestions("").map((each) => each.item)).toEqual([SHED, KITCHEN, OTHER_SHED].map(asItem));
	});

	it("draws each row as the note's name with its folder beneath, so two notes of one name are told apart", () => {
		const chooser = chooserOver([SHED, OTHER_SHED]);
		const rows = chooser.getSuggestions("").map((match) => {
			const el = document.createElement("div");
			chooser.renderSuggestion(match, el);
			return Array.from(el.children).map((child) => child.textContent);
		});

		expect(rows).toEqual([
			["Garden shed", "Projects"],
			["Garden shed", "Archive"],
		]);
	});

	it("draws a note at the vault's root with its name alone", () => {
		const chooser = chooserOver([collection("Loose.md")]);
		const el = document.createElement("div");
		chooser.renderSuggestion(chooser.getSuggestions("")[0], el);

		expect(Array.from(el.children).map((child) => child.textContent)).toEqual(["Loose"]);
		expect(folderOf("Loose.md")).toBe("");
	});

	it("hands the collection on when one is chosen", async () => {
		const chosen: ChooserItem[] = [];
		const chooser = chooserOver([SHED, KITCHEN], chosen);
		chooser.open();

		await stubOf(chooser).chooseAt("kit", 0);

		expect(chosen).toEqual([asItem(KITCHEN)]);
		expect(stubOf(chooser).isOpen).toBe(false);
	});

	it("hands nothing on when it is dismissed", () => {
		const chosen: ChooserItem[] = [];
		const chooser = chooserOver([SHED], chosen);
		chooser.open();

		chooser.close();

		expect(chosen).toEqual([]);
	});

	// Ordinary notes: #858, user story 9. If the chooser drew notes on an empty query, the first
	// test would list all four paths; if it ranked them ahead of collections, the second would too.
	it("offers collections alone when nothing is typed, however many ordinary notes there are", () => {
		const chooser = chooserOver([SHED, KITCHEN], [], PLAIN_PATHS);

		expect(pathsFor(chooser, "")).toEqual([SHED.path, KITCHEN.path]);
		expect(pathsFor(chooser, "   ")).toEqual([SHED.path, KITCHEN.path]);
	});

	it("draws in the ordinary notes that match once something is typed, after every matching collection", () => {
		// Obsidian ranks by how well a row matches, so a note can come ahead of a collection; the
		// stub's list is made to do that here, so only the chooser's own ordering can put them right.
		const chooser = chooserOver([KITCHEN, SHED], [], PLAIN_PATHS);
		const note = (path: string): ChooserItem => ({ path, name: path, isCollection: false });
		vi.spyOn(chooser, "getItems").mockReturnValue([note("Ideas/Shed roof notes.md"), asItem(SHED), asItem(KITCHEN)]);

		expect(pathsFor(chooser, "shed")).toEqual([SHED.path, "Ideas/Shed roof notes.md"]);
		expect(pathsFor(chooser, "")).toEqual([SHED.path, KITCHEN.path]);
	});

	it("offers a note that is a collection once, as a collection", () => {
		const chooser = chooserOver([SHED], [], [SHED.path, "Loose.md"]);

		expect(chooser.getItems().filter((each) => each.path === SHED.path)).toEqual([asItem(SHED)]);
	});

	it("hands an ordinary note on as one that is not a collection", async () => {
		const chosen: ChooserItem[] = [];
		const chooser = chooserOver([SHED], chosen, PLAIN_PATHS);
		chooser.open();

		await stubOf(chooser).chooseAt("party", 0);

		expect(chosen).toEqual([{ path: "Ideas/Garden party.md", name: "Garden party", isCollection: false }]);
	});
});
