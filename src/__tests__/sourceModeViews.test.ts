/**
 * Issue #1116. The core's `NoteWriter` port and Review's editor route both ask
 * "does a markdown tab show this note in source mode?", and must get the same
 * answer: a press that took the writer route while a tab is editable could
 * overwrite what the person is typing, and one that took the editor route with
 * no editable tab would have nowhere to write. Both callers run here over one
 * workspace, through the real code each uses.
 */

import { describe, expect, it } from "vitest";
import type { App, Plugin } from "obsidian";
import { MarkdownView, WorkspaceLeaf } from "./__mocks__/obsidian";
import { openNoteFromWorkspace } from "../core/noteWriter";
import { editorOn } from "../features/review/editorRoute";

const PATH = "Journal/2026-10-04.md";
const OTHER = "Journal/2026-10-05.md";

type Tab = ["source" | "preview", string?];

/** A workspace whose markdown tabs are `tabs`, each showing `PATH` unless it names another note. */
function workspaceOver(...tabs: Tab[]): { app: App; plugin: Plugin; editors: unknown[] } {
	const editors: unknown[] = [];
	const leaves = tabs.map(([mode, path]) => {
		const view = new MarkdownView({ path: path ?? PATH } as never, "", mode);
		const editor = { tab: editors.length };
		editors.push(editor);
		(view as unknown as { editor: unknown }).editor = editor;
		return new WorkspaceLeaf(view);
	});
	const workspace = {
		getActiveFile: () => null,
		getLeavesOfType: (type: string) => leaves.filter((leaf) => leaf.view.getViewType() === type),
		iterateAllLeaves: (callback: (leaf: WorkspaceLeaf) => void) => leaves.forEach(callback),
		on: () => null,
	};
	const app = { workspace } as unknown as App;
	return { app, plugin: { app, registerEvent: () => undefined } as unknown as Plugin, editors };
}

/** What each caller says of `PATH`: the writer's port, and whether Review's route found an editor. */
function bothAnswers(...tabs: Tab[]): { writer: boolean; route: boolean } {
	const { app, plugin } = workspaceOver(...tabs);
	return {
		writer: openNoteFromWorkspace(plugin).shownForEditing?.(PATH) ?? false,
		route: editorOn(app, PATH) !== null,
	};
}

describe("the writer's shownForEditing and Review's editorOn agree on a note's tabs", () => {
	it("a note in reading view is shown for editing to neither", () => {
		expect(bothAnswers(["preview"])).toEqual({ writer: false, route: false });
	});

	it("a note in source mode is shown for editing to both, and the route gets that tab's editor", () => {
		const { app, plugin, editors } = workspaceOver(["source"]);
		expect(openNoteFromWorkspace(plugin).shownForEditing?.(PATH)).toBe(true);
		expect(editorOn(app, PATH)).toBe(editors[0]);
	});

	it("a note in two tabs, one of each mode, is shown for editing to both, with the source tab's editor", () => {
		const { app, plugin, editors } = workspaceOver(["preview"], ["source"]);
		expect(openNoteFromWorkspace(plugin).shownForEditing?.(PATH)).toBe(true);
		expect(editorOn(app, PATH)).toBe(editors[1]);
	});

	it("a note no tab shows is shown for editing to neither, even with another note in source mode", () => {
		expect(bothAnswers(["source", OTHER])).toEqual({ writer: false, route: false });
		expect(bothAnswers()).toEqual({ writer: false, route: false });
	});
});
