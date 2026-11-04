/**
 * The core's way to a line a feature's hidden comment names: finding it in
 * text, placing a cursor on it, and opening a note to do so. Every fixture is
 * invented. The feature id "demo-feature" is not a real feature's.
 */

import { describe, expect, it } from "vitest";
import { App, MarkdownView } from "./__mocks__/obsidian";
import type { App as ObsidianApp } from "obsidian";
import { findMarkedLine, openNoteEditor, placeOnMarkedLine } from "../core/markedLine";
import type { PlacingEditor } from "../core/markedLine";

const ID = "demo-feature";
const carries = (want: string) => (inside: string) => inside === want;

describe("findMarkedLine", () => {
	it("finds the one line that carries the comment, counted from zero", () => {
		const text = ["## Tasks", `- [ ] Buy stamps %% ${ID}:k1 %%`, "- [ ] Water plants"].join("\n");
		expect(findMarkedLine(text, ID, carries("k1"))).toBe(1);
	});

	it("is null when no line carries it", () => {
		const text = ["- [ ] Buy stamps", `- [ ] Water plants %% ${ID}:k2 %%`].join("\n");
		expect(findMarkedLine(text, ID, carries("k1"))).toBeNull();
	});

	it("finds the first when two lines carry it", () => {
		const text = [`- [ ] Buy stamps %% ${ID}:k1 %%`, "- [ ] Water plants", `- [ ] Post letter %% ${ID}:k1 %%`].join("\n");
		expect(findMarkedLine(text, ID, carries("k1"))).toBe(0);
	});

	it("does not find a line whose comment carries another feature's id", () => {
		const text = `- [ ] Buy stamps %% other-feature:k1 %%`;
		expect(findMarkedLine(text, ID, carries("k1"))).toBeNull();
		expect(findMarkedLine(text, ID, () => true)).toBeNull();
	});

	it("skips a line that is not a task line even when it carries the comment", () => {
		expect(findMarkedLine(`Buy stamps %% ${ID}:k1 %%`, ID, () => true)).toBeNull();
	});

	it("hands the caller's test the task line as well, and the first line that passes wins", () => {
		const text = [`- [ ] Buy stamps %% ${ID}:k1 %%`, `- [x] Post letter %% ${ID}:k1 %%`].join("\n");
		expect(findMarkedLine(text, ID, (_inside, line) => line.checkbox === "x")).toBe(1);
	});
});

class FakeEditor implements PlacingEditor {
	cursor: { line: number; ch: number } | null = null;
	constructor(private text: string) {}
	getValue(): string {
		return this.text;
	}
	setCursor(pos: { line: number; ch: number }): void {
		this.cursor = pos;
	}
	edit(text: string): void {
		this.text = text;
	}
}

describe("placeOnMarkedLine", () => {
	it("puts the cursor at the start of the line found in the editor's text right now", () => {
		const editor = new FakeEditor(`- [ ] Buy stamps %% ${ID}:k1 %%`);
		editor.edit(["## Tasks", "", `- [ ] Buy stamps %% ${ID}:k1 %%`].join("\n"));
		expect(placeOnMarkedLine(editor, ID, carries("k1"))).toBe("placed");
		expect(editor.cursor).toEqual({ line: 2, ch: 0 });
	});

	it("reports not found and moves nothing", () => {
		const editor = new FakeEditor("- [ ] Buy stamps");
		expect(placeOnMarkedLine(editor, ID, carries("k1"))).toBe("not-found");
		expect(editor.cursor).toBeNull();
	});
});

describe("openNoteEditor", () => {
	function appWith(path: string | null, view: MarkdownView | null): ObsidianApp {
		const app = new App();
		if (path !== null) app.vault.files.push({ path });
		app.workspace.activeView = view;
		return app as unknown as ObsidianApp;
	}

	it("hands back the editor of the note that opened", async () => {
		const view = new MarkdownView({ path: "Harbour.md" }, "", "source");
		const editor = new FakeEditor("");
		view.editor = editor as unknown as MarkdownView["editor"];
		expect(await openNoteEditor(appWith("Harbour.md", view), "Harbour.md")).toBe(editor);
	});

	it("says the note no longer exists when the path names none", async () => {
		await expect(openNoteEditor(appWith(null, null), "Gone.md")).rejects.toThrow('"Gone.md" no longer exists');
	});

	it("says the note did not open as a note when no note view is in front", async () => {
		await expect(openNoteEditor(appWith("Harbour.md", null), "Harbour.md")).rejects.toThrow(
			'"Harbour.md" did not open as a note',
		);
	});
});
