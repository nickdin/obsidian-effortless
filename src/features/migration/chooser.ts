/**
 * The box that asks which collection a task goes into.
 *
 * Obsidian's own type-to-filter dialog, opened directly with `new` and
 * `.open()`: it is a dialog and not an editor suggester, so it needs none of the
 * host's popup plumbing. Each row is the note's name with its folder beneath, so
 * two notes sharing a name are told apart.
 *
 * **With nothing typed only collections show**, in the order they were given
 * (the caller puts the recently used first, #859);
 * **once something is typed every other Markdown note is drawn in too**, after
 * every matching collection (#858,
 * user story 9). What choosing an ordinary note means, the question and the
 * heading, is not decided here: the chooser hands the choice on.
 *
 * **Dismissing it writes nothing**: `onChooseItem` is the only route to a
 * filing, and Escape or a click outside never reaches it.
 */

import { FuzzySuggestModal } from "obsidian";
import type { App, FuzzyMatch } from "obsidian";
import type { Collection } from "../../core/collections";

/** One row: a note, and whether it is a collection already. */
export interface ChooserItem {
	readonly path: string;
	readonly name: string;
	readonly isCollection: boolean;
}

/** The name a note is shown under: its file name without the `.md`. */
function nameOf(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
}

/** The folder a note sits in, for the line beneath its name; empty at the vault's root. */
export function folderOf(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? "" : path.slice(0, slash);
}

export class CollectionChooser extends FuzzySuggestModal<ChooserItem> {
	private readonly items: readonly ChooserItem[];

	/**
	 * `collections` in the order to show them; `notePaths` every Markdown note
	 * that may be offered once something is typed. A note that is one of the
	 * collections is offered once, as a collection.
	 */
	constructor(
		app: App,
		collections: readonly Collection[],
		notePaths: readonly string[],
		private readonly onChoose: (item: ChooserItem) => void,
	) {
		super(app);
		const asCollections = collections.map((each) => ({ path: each.path, name: each.name, isCollection: true }));
		const known = new Set(collections.map((each) => each.path));
		const others = notePaths
			.filter((path) => !known.has(path))
			.map((path) => ({ path, name: nameOf(path), isCollection: false }));
		this.items = [...asCollections, ...others];
	}

	getItems(): ChooserItem[] {
		return [...this.items];
	}

	/**
	 * Collections alone for an empty query; for a typed one, the matches with
	 * every collection ahead of every ordinary note, each group keeping the
	 * order the dialog ranked it in.
	 */
	override getSuggestions(query: string): FuzzyMatch<ChooserItem>[] {
		const matches = super.getSuggestions(query);
		const collections = matches.filter((each) => each.item.isCollection);
		if (query.trim() === "") return collections;
		return [...collections, ...matches.filter((each) => !each.item.isCollection)];
	}

	/** What the type-to-filter box matches against: the folder and the name, so either finds the note. */
	getItemText(item: ChooserItem): string {
		const folder = folderOf(item.path);
		return folder === "" ? item.name : `${item.name} ${folder}`;
	}

	override renderSuggestion(match: FuzzyMatch<ChooserItem>, el: HTMLElement): void {
		const item = match.item;
		// Obsidian's own classes for a note's name and the path beneath it, the
		// ones its file suggesters use, so the rows look like every other list of
		// notes and this feature ships no stylesheet.
		el.createDiv({ text: item.name, cls: "suggestion-title" });
		const folder = folderOf(item.path);
		if (folder !== "") el.createDiv({ text: folder, cls: "suggestion-note" });
	}

	onChooseItem(item: ChooserItem): void {
		this.onChoose(item);
	}
}
