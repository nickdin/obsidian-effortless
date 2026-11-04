/**
 * The collections list, drawn at the foot of the core card on the settings
 * screen.
 *
 * It is not decoration. A note becomes a collection just by carrying the tasks
 * heading, anywhere in the vault, and that rule was only accepted because this
 * list makes every note it catches visible — old notes included, which is the
 * cleaning job the author took on with it (ADR 0003). The count beside each name
 * is the cheap check: a collection you expect to be busy showing zero means the
 * heading is written wrong.
 *
 * A section of its own file rather than more of `settingsTab.ts`, so the screen
 * calls one function and the list can be tested without drawing the screen.
 */

import { Setting } from "obsidian";
import type { Collection } from "./collections";

/**
 * The one fixed row name this section draws, for the settings search. A collection is
 * listed by its note's name in a link, not as a row.
 */
export const COLLECTIONS_SETTING_NAMES: readonly string[] = ["Collections"];

/**
 * Draws the list under `parent`.
 *
 * `openNote` is how a name becomes a link the person can follow — the caller
 * supplies it, because reaching the workspace is the settings screen's job and
 * not this list's.
 *
 * Issue #42 puts the
 * standing-problems section immediately above this one: a problem found by
 * scrolling forty-seven rows is not a notice.
 */
export function renderCollections(
	parent: HTMLElement,
	collections: readonly Collection[],
	openNote: (path: string) => void,
): void {
	new Setting(parent)
		.setName("Collections")
		.setDesc("Every note carrying your tasks heading. Nothing else makes one.")
		.setHeading();

	if (collections.length === 0) {
		parent.createDiv({
			cls: "effortless-collections-empty",
			text: "0 collections found. A note becomes one when you write your tasks heading in it.",
		});
		return;
	}

	const list = parent.createDiv({ cls: "effortless-collections" });
	for (const collection of collections) {
		const row = list.createDiv({ cls: "effortless-collection" });
		const link = row.createEl("a", {
			cls: "effortless-collection-name",
			text: collection.name,
			href: "#",
		});
		link.onClickEvent((event) => {
			// The href is there so the name looks and behaves like a link; the
			// navigation is Obsidian's, not the browser's.
			event.preventDefault();
			openNote(collection.path);
		});
		row.createSpan({
			cls: "effortless-collection-count",
			text: openTasksLine(collection.openTasks),
		});
	}
}

/** The count beside a name, written the way a person would say it. */
function openTasksLine(openTasks: number): string {
	return openTasks === 1 ? "1 open task" : `${openTasks} open tasks`;
}
