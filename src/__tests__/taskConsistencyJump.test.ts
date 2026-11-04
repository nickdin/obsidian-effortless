/**
 * The jump-to-source command.
 *
 * `locatePairedLine` and `collectionLinktextOf` are pure and tested directly.
 * The command's check callback is driven through the real feature registry,
 * the way `checkboxCycling.test.ts` drives its own commands. Most of
 * `jumpFromLine`'s own logic is tested over a hand-built `JumpTarget`, never
 * over `realJumpTarget`: the Obsidian half of this ticket (opening a leaf,
 * reading back whichever view it produced) holds no decisions of its own, the
 * same split spec #709's own Testing Decisions state for `reconcilePair` and
 * `copyIn`. **The open-view branch is the exception**: telling the log's own pane from the collection's apart needs the
 * real mock's own workspace state, so those cases are driven through the
 * registered command and `realJumpTarget`. The click is tested through the
 * feature's own listener, over real
 * DOM elements shaped as Obsidian 1.13.7 draws each mode's breadcrumb
 * (`docs/acceptance-shots/issue-811-jump-to-source.txt` step 3 and
 * `docs/acceptance-shots/issue-824-jump-click.txt`), never built from the
 * code's own selector.
 *
 * Every task, folder and collection name here is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin, Vault as ObsidianVault } from "obsidian";
import { DeferredView, MarkdownPreviewRenderer, MarkdownView, Notice, Plugin, Vault, WorkspaceLeaf, resetSettings } from "./__mocks__/obsidian";
import type { MarkdownPostProcessorContext, ViewEditor } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { Collection, Collections } from "../core/collections";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore, defaultData } from "../core/settings";
import type { TaskLine } from "../core/taskLine";
import { parseTaskLine } from "../core/taskLine";
import { FEATURE_ID, TaskConsistency } from "../features/taskConsistency";
import { collectionLinktextOf, jumpFromLine, livePreviewRowOf, locatePairedLine } from "../features/taskConsistency/jump";
import type { JumpEditor, JumpTarget } from "../features/taskConsistency/jump";

/** A raw line, parsed. Fails loudly on a fixture that stopped being a task line. */
function taskLine(raw: string): TaskLine {
	const line = parseTaskLine(raw);
	if (line === null) throw new Error(`fixture is not a task line: ${JSON.stringify(raw)}`);
	return line;
}

/** This feature's own marker, a fixed hash unless a test needs a different one. */
function markerComment(eid: string, hash = "aabbccdd"): string {
	return `%% ${FEATURE_ID}:${eid} ${hash} %%`;
}

beforeEach(() => {
	Notice.messages = [];
	resetSettings();
});

describe("locatePairedLine", () => {
	it("finds the line carrying the eid", () => {
		const text = ["## Tasks", `- [ ] Buy stamps ${markerComment("abc123")}`, "- [ ] Buy envelopes"].join("\n");
		expect(locatePairedLine(text, "abc123")).toBe(1);
	});

	it("answers null when no line carries the eid", () => {
		const text = ["## Tasks", `- [ ] Buy stamps ${markerComment("other99")}`].join("\n");
		expect(locatePairedLine(text, "abc123")).toBeNull();
	});

	it("answers the first line when two share the eid, matching setComment's own first-wins rule", () => {
		const text = [
			`- [ ] Buy stamps ${markerComment("dup1")}`,
			`- [ ] Buy stamps, copied by hand ${markerComment("dup1")}`,
		].join("\n");
		expect(locatePairedLine(text, "dup1")).toBe(0);
	});
});

describe("collectionLinktextOf", () => {
	it("reads the collection's own name off the breadcrumb", () => {
		expect(collectionLinktextOf("Buy stamps → [[Errands]]")).toBe("Errands");
	});

	it("reads the collection's own name off a breadcrumb written without an arrow", () => {
		expect(collectionLinktextOf("Buy stamps ⏳ 2026-09-22 [[Errands]] %% task-consistency:eid1 aabbccdd %%")).toBe("Errands");
	});

	it("takes the last link, so a link the person wrote in the task's words is not read as the collection", () => {
		expect(collectionLinktextOf("Ask [[Aunt Maria]] about stamps [[Errands]] %% task-consistency:eid1 aabbccdd %%")).toBe("Errands");
	});

	it("never reads a link that sits inside a comment", () => {
		expect(collectionLinktextOf("Buy stamps [[Errands]] %% task-consistency:eid1 aabbccdd %% %% see [[Elsewhere]] %%")).toBe("Errands");
	});

	it("still reads a line an earlier version wrote with the arrow, so a vault that used it keeps its jump", () => {
		expect(collectionLinktextOf("Buy stamps ⏳ 2026-09-22 → [[Errands]] %% task-consistency:eid1 aabbccdd %%")).toBe("Errands");
	});

	it("answers null when the description carries no breadcrumb", () => {
		expect(collectionLinktextOf("Buy stamps, not yet paired")).toBeNull();
	});
});

/** Just enough of an editor to answer the check callback's own two calls. */
class FakeSourceEditor {
	constructor(
		private readonly line: string,
		private readonly at = 0,
	) {}

	getCursor(): { line: number; ch: number } {
		return { line: this.at, ch: 0 };
	}

	getLine(_line: number): string {
		return this.line;
	}
}

/** What Obsidian hands `editorCheckCallback`, reduced to what this command reads. */
type JumpCheckCallback = (
	checking: boolean,
	editor: FakeSourceEditor,
	ctx: { file: { path: string } | null },
) => boolean | void;

/**
 * Every plugin a test started, unloaded after it: a feature's click listener is
 * on the shared `document`, so one left loaded hears the next test's clicks
 * through its own stale view of the world.
 */
const started: Plugin[] = [];

/**
 * The plugin loaded over an empty settings file, with `TaskConsistency`
 * registered under the core registry, as `main.ts` starts it. `collections`
 * defaults to answering "yes" for this file's one fixture collection
 * (`COLLECTION_PATH`) and "no" for everything else — a test of the #811
 * notice for a note that has stopped being one passes its own stub instead.
 */
async function startFeature(
	openFirst?: (plugin: Plugin) => void,
	collections: Collections = { all: () => [], at: (path) => (path === COLLECTION_PATH ? FIXTURE_COLLECTION : null) },
): Promise<{ plugin: Plugin; feature: TaskConsistency }> {
	const plugin = new Plugin();
	started.push(plugin);
	openFirst?.(plugin);
	plugin.seedData(defaultData());
	plugin.load();
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const notes = new NoteWriter(new Vault() as unknown as ObsidianVault, {
		path: () => null,
		onChange: () => undefined,
	});
	const calendar: Calendar = { meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} };
	const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
	const problems = new Problems();
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections, problems, device },
		notes,
		calendar,
	);
	let feature: TaskConsistency | undefined;
	registry.register(FEATURE_ID, (host) => (feature = new TaskConsistency(host)));
	registry.start();
	return { plugin, feature: feature! };
}

/** The jump command's own check callback, off the real palette Obsidian's mock keeps. */
function jumpCheckOf(plugin: Plugin): JumpCheckCallback {
	const registered = plugin.commands.find((command) => command.id === `${plugin.manifest.id}:jump-to-source`);
	expect(registered, "the jump-to-source command was not registered").toBeDefined();
	const callback = (registered as unknown as { editorCheckCallback?: JumpCheckCallback }).editorCheckCallback;
	expect(callback, "jump-to-source has no editorCheckCallback").toBeDefined();
	return callback as JumpCheckCallback;
}

describe("the command's check callback", () => {
	it("is enabled when the cursor's line carries this feature's own marker", async () => {
		const { plugin } = await startFeature();
		const check = jumpCheckOf(plugin);
		const editor = new FakeSourceEditor(`- [ ] Buy stamps ${markerComment("eid1")} → [[Errands]]`);
		expect(check(true, editor, { file: { path: "Log/some-day.md" } })).toBe(true);
	});

	it("is disabled when the cursor's line carries no marker", async () => {
		const { plugin } = await startFeature();
		const check = jumpCheckOf(plugin);
		const editor = new FakeSourceEditor("- [ ] Buy stamps, not yet paired");
		expect(check(true, editor, { file: { path: "Log/some-day.md" } })).toBe(false);
	});

	it("is disabled when the line carrying the marker has no note of its own to jump from", async () => {
		const { plugin } = await startFeature();
		const check = jumpCheckOf(plugin);
		const editor = new FakeSourceEditor(`- [ ] Buy stamps ${markerComment("eid1")} → [[Errands]]`);
		expect(check(true, editor, { file: null })).toBe(false);
	});
});

/**
 * A `JumpEditor` with real, readable state: `getValue` answers whatever text
 * it holds right now, and `getCursor` answers exactly what the last
 * `setCursor` set — never left cursor.line hardcoded to what the test expects.
 */
class FakeJumpEditor implements JumpEditor {
	private cursor = { line: -1, ch: -1 };

	constructor(private text: string) {}

	getValue(): string {
		return this.text;
	}

	setCursor(pos: { line: number; ch: number }): void {
		this.cursor = pos;
	}

	getCursor(): { line: number; ch: number } {
		return this.cursor;
	}

	/** Stands in for an edit made to the collection since an earlier moment. */
	prependLine(line: string): void {
		this.text = `${line}\n${this.text}`;
	}
}

/** A `JumpTarget` a test can override piece by piece, recording every notice. */
function fakeTarget(overrides: Partial<JumpTarget> = {}): JumpTarget & { readonly notified: string[] } {
	const notified: string[] = [];
	return {
		resolveLink: overrides.resolveLink ?? (() => "Errands.md"),
		isCollection: overrides.isCollection ?? (() => true),
		findOpenView: overrides.findOpenView ?? (() => null),
		openView: overrides.openView ?? (async () => {}),
		open: overrides.open ?? (async () => new FakeJumpEditor("")),
		notify: overrides.notify ?? ((message: string) => notified.push(message)),
		notified,
	};
}

describe("jumpFromLine", () => {
	it("places the cursor on the line the collection's text names right now, not one assumed earlier", async () => {
		const editor = new FakeJumpEditor(["## Tasks", `- [ ] Buy stamps ${markerComment("eid1")}`].join("\n"));
		// Between whatever moment the log line's own eid was first written and
		// this activation, the collection gained a line above the target — the
		// #679/#686 shape this command exists to get right.
		editor.prependLine("- [ ] A task nothing here has seen before");
		const target = fakeTarget({ open: async () => editor });
		const line = taskLine(`- [ ] Buy stamps ${markerComment("eid1")} → [[Errands]]`);

		await jumpFromLine(target, "Log/some-day.md", line);

		// Line 1 is where the marker sat before the prepend; a cached or
		// precomputed line number would still say 1. Only a fresh read of
		// `editor.getValue()` at this call finds it at 2.
		expect(editor.getCursor()).toEqual({ line: 2, ch: 0 });
		expect(target.notified).toEqual([]);
	});

	it("says the collection cannot be found, and opens nothing, when the link resolves to no note", async () => {
		const opened: string[] = [];
		const target = fakeTarget({
			resolveLink: () => null,
			open: async (path) => {
				opened.push(path);
				return new FakeJumpEditor("");
			},
		});
		const line = taskLine(`- [ ] Buy stamps ${markerComment("eid1")} → [[Ghost collection]]`);

		await jumpFromLine(target, "Log/some-day.md", line);

		expect(target.notified).toHaveLength(1);
		expect(target.notified[0]).toContain("not a collection any more");
		expect(opened).toEqual([]);
	});

	it("says the collection cannot be found when the named note is no longer one", async () => {
		const target = fakeTarget({ isCollection: () => false });
		const line = taskLine(`- [ ] Buy stamps ${markerComment("eid1")} → [[Errands]]`);

		await jumpFromLine(target, "Log/some-day.md", line);

		expect(target.notified).toHaveLength(1);
		expect(target.notified[0]).toContain("not a collection any more");
	});

	it("says no line carries the eid any more, and moves no cursor, when the collection has none", async () => {
		const editor = new FakeJumpEditor(
			["## Tasks", `- [ ] Something unrelated ${markerComment("someone-elses-eid")}`].join("\n"),
		);
		const target = fakeTarget({ open: async () => editor });
		const line = taskLine(`- [ ] Buy stamps ${markerComment("eid1")} → [[Errands]]`);

		await jumpFromLine(target, "Log/some-day.md", line);

		expect(target.notified).toHaveLength(1);
		expect(target.notified[0]).toContain("no line in");
		expect(editor.getCursor()).toEqual({ line: -1, ch: -1 });
	});
});

/* -------------------------------------------------------------------------- */
/* The click, in each mode, through the feature's own listener                 */
/* -------------------------------------------------------------------------- */

const LOG_PATH = "Journal/2031-03-04.md";
const COLLECTION_PATH = "Projects/Harbour.md";

/** What `startFeature`'s default `collections` answers for {@link COLLECTION_PATH}. */
const FIXTURE_COLLECTION: Collection = { path: COLLECTION_PATH, name: "Harbour", headingLine: 2, headingLevel: 2, openTasks: 2 };

/** The day's log: rows 5 and 7 are two paired lines naming one collection. */
const LOG_LINES = [
	"# Notes",
	"",
	"- [ ] Polish the brass lamp",
	"- [ ] Sort the rope coils",
	"- [ ] Label the crates",
	`- [/] Order the blue folders 📅 2031-03-04 → [[Harbour]] ${markerComment("eidA")}`,
	"- [ ] Fill the lamp oil",
	`- [/] Book the tug for Friday 📅 2031-03-04 → [[Harbour]] ${markerComment("eidB")}`,
	"- [ ] Wash the deck",
];

/** The collection holds the same two tasks in the opposite order, so no row number in it equals the log's. */
const COLLECTION_LINES = [
	"# Harbour",
	"",
	"## Tasks",
	"- [ ] Repaint the pier sign",
	`- [/] Book the tug for Friday 📅 2031-03-04 ${markerComment("eidB")}`,
	"- [ ] Count the mooring lines",
	"- [ ] Check the fog bell",
	"- [ ] Coil the spare line",
	`- [/] Order the blue folders 📅 2031-03-04 ${markerComment("eidA")}`,
	"- [ ] Sign the harbour log",
];
const ROW_OF_A_IN_COLLECTION = 8;
const ROW_OF_B_IN_COLLECTION = 4;

/**
 * An editor with real state, and Live Preview's own `cm.posAtDOM` answered as an
 * inference: the offset where the `.cm-line` holding `node` starts.
 * The record's one `posAtDOM` reading is the span on row 7 answering an offset
 * `offsetToPos` places on line 7 (`issue-824-jump-click.txt:47`); it gives no
 * offset, and that the offset is the line's start is this fake's own choice.
 */
class FakeNoteEditor {
	private cursor: { line: number; ch: number };
	readonly cm = { posAtDOM: (node: Node): number => this.offsetOfLineHolding(node) };

	constructor(
		private readonly lines: string[],
		cursor = { line: -1, ch: -1 },
		private readonly root: HTMLElement | null = null,
	) {
		this.cursor = cursor;
	}

	getValue(): string {
		return this.lines.join("\n");
	}

	getLine(line: number): string {
		return this.lines[line] ?? "";
	}

	getCursor(): { line: number; ch: number } {
		return this.cursor;
	}

	setCursor(pos: { line: number; ch: number }): void {
		this.cursor = pos;
	}

	offsetToPos(offset: number): { line: number; ch: number } {
		let start = 0;
		for (let line = 0; line < this.lines.length; line += 1) {
			if (offset <= start + this.lines[line].length) return { line, ch: offset - start };
			start += this.lines[line].length + 1;
		}
		throw new Error(`offset ${offset} is past the end of the fake note`);
	}

	private offsetOfLineHolding(node: Node): number {
		const element = node instanceof Element ? node : node.parentElement;
		const line = element?.closest(".cm-line") ?? null;
		if (line === null || this.root === null) throw new Error("the node is in no .cm-line of this editor");
		const row = Array.from(this.root.children).indexOf(line);
		if (row < 0) throw new Error("the .cm-line is not one of this editor's own");
		return this.lines.slice(0, row).reduce((sum, text) => sum + text.length + 1, 0);
	}
}

/** A note open in the active tab, its editor being the one given. */
function noteView(path: string, editor: ViewEditor, mode: "preview" | "source"): MarkdownView {
	const view = new MarkdownView({ path }, editor.getValue(), mode);
	view.editor = editor;
	return view;
}

/**
 * Live Preview's own shape for a log's rows, as read back from Obsidian 1.13.7:
 * one `.cm-line` per row under `.cm-content`, a wikilink drawn as
 * `span.cm-hmd-internal-link` holding `span.cm-underline`, no `href` anywhere.
 * Returns the content element and, per row that holds a link, the inner span —
 * the element a real click's `target` is.
 */
function livePreviewRows(lines: string[]): { content: HTMLElement; underline: Map<number, HTMLElement> } {
	const editor = document.body.appendChild(document.createElement("div"));
	editor.className = "cm-editor";
	const content = editor.appendChild(document.createElement("div"));
	content.className = "cm-content";
	const underline = new Map<number, HTMLElement>();
	lines.forEach((text, row) => {
		const line = content.appendChild(document.createElement("div"));
		line.className = "cm-line HyperMD-list-line HyperMD-list-line-1 HyperMD-task-line";
		const breadcrumb = /→ \[\[([^\]]+)\]\]/u.exec(text);
		if (breadcrumb === null) {
			line.textContent = text;
			return;
		}
		line.append(`${text.slice(0, breadcrumb.index)}→ `);
		const link = line.appendChild(document.createElement("span"));
		link.className = "cm-hmd-internal-link cm-list-1";
		const inner = link.appendChild(document.createElement("span"));
		inner.className = "cm-underline";
		inner.setAttribute("tabindex", "-1");
		inner.setAttribute("draggable", "true");
		inner.textContent = breadcrumb[1];
		underline.set(row, inner);
	});
	return { content, underline };
}

/**
 * Reading view's own shape, as read back from Obsidian 1.13.7: the list the
 * log's rows `from`..`to` make is one section, its `li`s carry `data-line`
 * counted from the section's own first row, and a wikilink is
 * `a.internal-link` with `href` and `data-href`. Run through every post
 * processor the plugin registered, the way reading view does, with a context
 * whose `getSectionInfo` answers what Obsidian answers for that section.
 */
function readingSection(
	lines: string[],
	from: number,
	to: number,
	sourcePath: string,
	info: boolean,
	doc: Document = document,
): { section: HTMLElement; anchors: Map<number, HTMLElement>; render: () => void } {
	const section = doc.body.appendChild(doc.createElement("div"));
	const list = section.appendChild(doc.createElement("ul"));
	list.className = "contains-task-list has-list-bullet";
	const anchors = new Map<number, HTMLElement>();
	for (let row = from; row <= to; row += 1) {
		const item = list.appendChild(doc.createElement("li"));
		item.className = "task-list-item";
		item.setAttribute("data-line", String(row - from));
		const breadcrumb = /→ \[\[([^\]]+)\]\]/u.exec(lines[row]);
		item.append(breadcrumb === null ? lines[row] : `${lines[row].slice(6, breadcrumb.index)}→ `);
		if (breadcrumb === null) continue;
		const anchor = item.appendChild(doc.createElement("a"));
		anchor.className = "internal-link";
		anchor.setAttribute("data-href", breadcrumb[1]);
		anchor.setAttribute("href", breadcrumb[1]);
		anchor.textContent = breadcrumb[1];
		anchors.set(row, anchor);
	}
	const ctx: MarkdownPostProcessorContext = {
		sourcePath,
		// `text` is the whole note and `lineStart` the section's first row in it
		// (probed in `issue-824-jump-click.txt`, step 2: a list on rows 2 to 8
		// answered lineStart 2, lineEnd 8, and the note's own ten lines).
		getSectionInfo: () => (info ? { text: lines.join("\n"), lineStart: from, lineEnd: to } : null),
	} as unknown as MarkdownPostProcessorContext;
	const render = (): void => {
		for (const postProcessor of [...MarkdownPreviewRenderer.postProcessors]) void postProcessor(section, ctx);
	};
	render();
	return { section, anchors, render };
}

function click(element: HTMLElement): void {
	element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

/**
 * The feature started, the collection known to Obsidian's link index, and the
 * collection's own editor ready for the `file-open` a click's link follows.
 */
async function clickFixture(openFirst?: (plugin: Plugin) => void): Promise<{
	plugin: Plugin;
	collectionEditor: FakeNoteEditor;
	arrive: () => void;
}> {
	const { plugin } = await startFeature(openFirst);
	plugin.app.metadataCache.caches.set(COLLECTION_PATH, {});
	const collectionEditor = new FakeNoteEditor(COLLECTION_LINES);
	const arrive = (): void => {
		plugin.app.workspace.activeView = noteView(COLLECTION_PATH, collectionEditor, "source");
		plugin.app.workspace.open(COLLECTION_PATH);
	};
	return { plugin, collectionEditor, arrive };
}

afterEach(() => {
	for (const plugin of started.splice(0)) plugin.unload();
	document.body.replaceChildren();
	MarkdownPreviewRenderer.reset();
});

describe("a click on the breadcrumb in Live Preview", () => {
	it("jumps to the task on the row that was clicked, not the row the cursor was left on", async () => {
		const { plugin, collectionEditor, arrive } = await clickFixture();
		const { content, underline } = livePreviewRows(LOG_LINES);
		// The cursor is left on row 5, a paired line naming the same collection:
		// code that trusted it would land on row 5's task, not the clicked row 7's.
		const logEditor = new FakeNoteEditor(LOG_LINES, { line: 5, ch: 0 }, content);
		plugin.app.workspace.activeView = noteView(LOG_PATH, logEditor, "source");

		click(underline.get(7)!);
		arrive();

		expect(collectionEditor.getCursor()).toEqual({ line: ROW_OF_B_IN_COLLECTION, ch: 0 });
		expect(Notice.messages).toEqual([]);
	});

	it("jumps although the cursor is on a line with no pairing at all", async () => {
		const { plugin, collectionEditor, arrive } = await clickFixture();
		const { content, underline } = livePreviewRows(LOG_LINES);
		plugin.app.workspace.activeView = noteView(LOG_PATH, new FakeNoteEditor(LOG_LINES, { line: 0, ch: 0 }, content), "source");

		click(underline.get(5)!);
		arrive();

		expect(collectionEditor.getCursor()).toEqual({ line: ROW_OF_A_IN_COLLECTION, ch: 0 });
	});

	it("does nothing for a link on a row that carries no pairing", async () => {
		const { plugin, collectionEditor, arrive } = await clickFixture();
		const lines = [...LOG_LINES];
		lines[3] = "- [ ] Sort the rope coils → [[Harbour]]";
		const { content, underline } = livePreviewRows(lines);
		plugin.app.workspace.activeView = noteView(LOG_PATH, new FakeNoteEditor(lines, { line: 5, ch: 0 }, content), "source");

		click(underline.get(3)!);
		arrive();

		expect(collectionEditor.getCursor()).toEqual({ line: -1, ch: -1 });
	});

	it("does nothing for a link on a paired row that is not the row's own collection", async () => {
		const { plugin, collectionEditor, arrive } = await clickFixture();
		const { content, underline } = livePreviewRows(LOG_LINES);
		// Row 5 names Harbour; a link to somewhere else sits on that same row.
		const elsewhere = underline.get(5)!.parentElement!.cloneNode(true) as HTMLElement;
		elsewhere.querySelector(".cm-underline")!.textContent = "Someone else";
		content.children[5].prepend(elsewhere);
		plugin.app.workspace.activeView = noteView(LOG_PATH, new FakeNoteEditor(LOG_LINES, { line: 5, ch: 0 }, content), "source");

		click(elsewhere.querySelector<HTMLElement>(".cm-underline")!);
		arrive();

		expect(collectionEditor.getCursor()).toEqual({ line: -1, ch: -1 });
	});
});

describe("livePreviewRowOf", () => {
	it("answers no row, and does not throw, when the editor cannot place the link in its own document", () => {
		// CodeMirror's posAtDOM throws a RangeError for a node outside its content.
		const editor = {
			cm: {
				posAtDOM: (): number => {
					throw new RangeError("Invalid position");
				},
			},
			getLine: (): string => "",
			offsetToPos: (): { line: number; ch: number } => ({ line: 0, ch: 0 }),
		};
		const link = document.createElement("span");
		expect(livePreviewRowOf(link, editor, LOG_PATH)).toBeNull();
	});
});

describe("a click on the breadcrumb in reading view", () => {
	it("jumps to the task on the row that was clicked, not the row the source editor's cursor was left on", async () => {
		const { plugin, collectionEditor, arrive } = await clickFixture();
		// Reading view leaves the source editor's cursor where it last was: on
		// row 5, a paired line naming the same collection.
		const logEditor = new FakeNoteEditor(LOG_LINES, { line: 5, ch: 0 });
		plugin.app.workspace.activeView = noteView(LOG_PATH, logEditor, "preview");
		const { anchors } = readingSection(LOG_LINES, 2, 8, LOG_PATH, true);

		click(anchors.get(7)!);
		arrive();

		expect(collectionEditor.getCursor()).toEqual({ line: ROW_OF_B_IN_COLLECTION, ch: 0 });
		expect(Notice.messages).toEqual([]);
	});

	it("jumps although the source editor's cursor is on a line with no pairing", async () => {
		const { plugin, collectionEditor, arrive } = await clickFixture();
		plugin.app.workspace.activeView = noteView(LOG_PATH, new FakeNoteEditor(LOG_LINES, { line: 0, ch: 0 }), "preview");
		const { anchors } = readingSection(LOG_LINES, 2, 8, LOG_PATH, true);

		click(anchors.get(5)!);
		arrive();

		expect(collectionEditor.getCursor()).toEqual({ line: ROW_OF_A_IN_COLLECTION, ch: 0 });
	});

	it("does nothing for a link on a list item that carries no pairing", async () => {
		const { plugin, collectionEditor, arrive } = await clickFixture();
		const lines = [...LOG_LINES];
		lines[3] = "- [ ] Sort the rope coils → [[Harbour]]";
		plugin.app.workspace.activeView = noteView(LOG_PATH, new FakeNoteEditor(lines, { line: 5, ch: 0 }), "preview");
		const { anchors } = readingSection(lines, 2, 8, LOG_PATH, true);

		click(anchors.get(3)!);
		arrive();

		expect(collectionEditor.getCursor()).toEqual({ line: -1, ch: -1 });
	});

	it("does nothing when Obsidian gives the section no information", async () => {
		const { plugin, collectionEditor, arrive } = await clickFixture();
		plugin.app.workspace.activeView = noteView(LOG_PATH, new FakeNoteEditor(LOG_LINES, { line: 5, ch: 0 }), "preview");
		const { anchors } = readingSection(LOG_LINES, 2, 8, LOG_PATH, false);

		click(anchors.get(7)!);
		arrive();

		expect(collectionEditor.getCursor()).toEqual({ line: -1, ch: -1 });
	});

	// Ticket #866. Obsidian draws a reading-view note when it opens, and the
	// section map fills only through the post processor the feature registers when
	// it starts, so a note open before that has no entry for its sections.
	it("jumps in a note that was already rendered before the feature started", async () => {
		// Rendered first, with no post processor registered: the section is drawn
		// and nothing has recorded its context. On d81db48 nothing draws it again,
		// `readingRowOf` finds no context and answers null, and the collection's
		// cursor is still {line: -1, ch: -1}, where the assertion below reports it.
		MarkdownPreviewRenderer.reset();
		const { anchors, render } = readingSection(LOG_LINES, 2, 8, LOG_PATH, true);
		const logView = noteView(LOG_PATH, new FakeNoteEditor(LOG_LINES, { line: 5, ch: 0 }), "preview");
		logView.previewMode.onRerender = render;
		const { collectionEditor, arrive } = await clickFixture((plugin) => {
			plugin.app.workspace.leaves.push(new WorkspaceLeaf(logView));
		});

		click(anchors.get(7)!);
		arrive();

		expect(collectionEditor.getCursor()).toEqual({ line: ROW_OF_B_IN_COLLECTION, ch: 0 });
		expect(logView.previewMode.rerenders).toEqual([true]);
	});
});

/**
 * A day's log in a popout window: the window has its own
 * document, and the click is fired there. The feature follows every open window
 * the way `checkboxCycling.test.ts` drives `windowBodies` — a second document
 * and a `window-open` event.
 */
describe("a click on the breadcrumb in a popout window", () => {
	/** A throwaway document standing in for a popout window's own. */
	function popoutDocument(): Document {
		return document.implementation.createHTMLDocument("popout");
	}

	async function popoutFixture(popout: Document, when: "before-load" | "after-load") {
		const fixture = await clickFixture(
			when === "before-load" ? (plugin) => plugin.app.workspace.openWindow(popout) : undefined,
		);
		if (when === "after-load") fixture.plugin.app.workspace.openWindow(popout);
		fixture.plugin.app.workspace.activeView = noteView(LOG_PATH, new FakeNoteEditor(LOG_LINES, { line: 5, ch: 0 }), "preview");
		return fixture;
	}

	it("jumps from a window opened after the feature started", async () => {
		// Wrong code (the listener on the main document alone) hears nothing there:
		// the collection's cursor stays {line: -1, ch: -1}.
		const popout = popoutDocument();
		const { collectionEditor, arrive } = await popoutFixture(popout, "after-load");
		const { anchors } = readingSection(LOG_LINES, 2, 8, LOG_PATH, true, popout);

		anchors.get(7)!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		arrive();

		expect(collectionEditor.getCursor()).toEqual({ line: ROW_OF_B_IN_COLLECTION, ch: 0 });
		expect(Notice.messages).toEqual([]);
	});

	it("jumps from a window that was already open when the feature started", async () => {
		const popout = popoutDocument();
		const { collectionEditor, arrive } = await popoutFixture(popout, "before-load");
		const { anchors } = readingSection(LOG_LINES, 2, 8, LOG_PATH, true, popout);

		anchors.get(5)!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		arrive();

		expect(collectionEditor.getCursor()).toEqual({ line: ROW_OF_A_IN_COLLECTION, ch: 0 });
	});

	it("still jumps from the main window when a popout is open too", async () => {
		const popout = popoutDocument();
		const { collectionEditor, arrive } = await popoutFixture(popout, "after-load");
		const { anchors } = readingSection(LOG_LINES, 2, 8, LOG_PATH, true);

		click(anchors.get(7)!);
		arrive();

		expect(collectionEditor.getCursor()).toEqual({ line: ROW_OF_B_IN_COLLECTION, ch: 0 });
	});

	it("hears nothing in a window once it has closed", async () => {
		// Wrong code (a listener never taken off) still hears the closed window's
		// document and the collection's cursor moves to row 4.
		const popout = popoutDocument();
		const { plugin, collectionEditor, arrive } = await popoutFixture(popout, "after-load");
		const { anchors } = readingSection(LOG_LINES, 2, 8, LOG_PATH, true, popout);
		plugin.app.workspace.fire("window-close", { doc: popout, win: window });

		anchors.get(7)!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		arrive();

		expect(collectionEditor.getCursor()).toEqual({ line: -1, ch: -1 });
	});

	it("hears nothing in any window once the feature is unloaded", async () => {
		const popout = popoutDocument();
		const { plugin, collectionEditor, arrive } = await popoutFixture(popout, "after-load");
		const { anchors } = readingSection(LOG_LINES, 2, 8, LOG_PATH, true, popout);
		plugin.unload();

		anchors.get(7)!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		arrive();

		expect(collectionEditor.getCursor()).toEqual({ line: -1, ch: -1 });
	});
});

/**
 * Ticket #905, the author's decision 2026-09-25: when the collection a
 * breadcrumb names is already open in a view somewhere, the click goes to
 * that view and the log's own pane is untouched — never a second view of the
 * collection opened in the log's pane (`docs/acceptance-shots/issue-872-split-pane-click.txt`).
 */
describe("a click when the collection is already open elsewhere", () => {
	it("reveals the pane already holding the collection, places the cursor there, stops Obsidian's own handling from opening it in the log's pane, and leaves the log's own pane untouched", async () => {
		// Wrong code (today's behaviour, unconditional) never calls `revealLeaf`
		// or moves this editor's cursor from a click alone — only `arrive()`,
		// simulating Obsidian's own file-open, would move a *different*
		// editor's cursor. This test never calls `arrive()`.
		const { plugin } = await clickFixture();
		const { content, underline } = livePreviewRows(LOG_LINES);
		const logEditor = new FakeNoteEditor(LOG_LINES, { line: 5, ch: 0 }, content);
		const logLeaf = new WorkspaceLeaf(noteView(LOG_PATH, logEditor, "source"));
		plugin.app.workspace.activeView = logLeaf.view as MarkdownView;
		plugin.app.workspace.leaves.push(logLeaf);

		const openCollectionEditor = new FakeNoteEditor(COLLECTION_LINES);
		const collectionLeaf = new WorkspaceLeaf(noteView(COLLECTION_PATH, openCollectionEditor, "source"));
		plugin.app.workspace.leaves.push(collectionLeaf);

		// Ticket #923: the test this replaced never checked that Obsidian's own
		// link handling — which runs on the bubble phase, after this feature's
		// capture-phase listener — was actually stopped, so it passed whether or
		// not the code called `preventDefault`/`stopPropagation`. This stand-in
		// for that handling, bound on `document` in the bubble phase like a real
		// link click's default action, replaces the log leaf's own view with a
		// second view of the collection — the #872 defect this ticket exists to
		// stop. If the capture-phase listener does not call `stopPropagation`,
		// this runs and `logLeaf.view` below is no longer the log's own.
		const obsidianDefaultOpen = (): void => {
			logLeaf.view = noteView(COLLECTION_PATH, new FakeNoteEditor(COLLECTION_LINES), "source");
		};
		document.addEventListener("click", obsidianDefaultOpen, false);
		try {
			const evt = new MouseEvent("click", { bubbles: true, cancelable: true });
			underline.get(7)!.dispatchEvent(evt);
			// `revealLeaf` is genuinely async in Obsidian; one microtask tick is
			// what the real await on it costs before the cursor is placed.
			await Promise.resolve();

			expect(evt.defaultPrevented).toBe(true);
			expect(logLeaf.view).toBeInstanceOf(MarkdownView);
			expect((logLeaf.view as MarkdownView).file.path).toBe(LOG_PATH);
			expect(openCollectionEditor.getCursor()).toEqual({ line: ROW_OF_B_IN_COLLECTION, ch: 0 });
			expect(plugin.app.workspace.revealed).toEqual([collectionLeaf]);
			expect(plugin.app.workspace.activeLeaf).toBe(collectionLeaf);
			expect(plugin.app.workspace.activeLeafFocus).toBe(true);
			expect(logEditor.getCursor()).toEqual({ line: 5, ch: 0 });
			expect(plugin.app.workspace.leaves).toHaveLength(2);
			expect(Notice.messages).toEqual([]);
		} finally {
			document.removeEventListener("click", obsidianDefaultOpen, false);
		}
	});

	// Ticket #921, the same defect as #931: the handler's own doc comment
	// (`taskConsistency.ts:436-444`) names a modifier-click into a new tab or a
	// split as exactly the case Obsidian's own handling must keep, and on
	// `216b44a` the intercept branch never looks at the click's modifiers, so
	// it swallows one and turns it into a jump to the already-open pane
	// instead. Wrong code marks `evt.defaultPrevented` true and reveals
	// `collectionLeaf`; this asserts neither happened, and that the click was
	// instead remembered as a pending jump the way an ordinary click is.
	it.each([
		["ctrlKey", { ctrlKey: true }],
		["metaKey", { metaKey: true }],
	])("leaves a %s-click to Obsidian's own handling, even with the collection already open elsewhere", async (_name, modifiers) => {
		const { plugin, collectionEditor, arrive } = await clickFixture();
		const { content, underline } = livePreviewRows(LOG_LINES);
		const logEditor = new FakeNoteEditor(LOG_LINES, { line: 5, ch: 0 }, content);
		plugin.app.workspace.activeView = noteView(LOG_PATH, logEditor, "source");

		const openCollectionEditor = new FakeNoteEditor(COLLECTION_LINES);
		const collectionLeaf = new WorkspaceLeaf(noteView(COLLECTION_PATH, openCollectionEditor, "source"));
		plugin.app.workspace.leaves.push(collectionLeaf);

		const evt = new MouseEvent("click", { bubbles: true, cancelable: true, ...modifiers });
		underline.get(7)!.dispatchEvent(evt);

		expect(evt.defaultPrevented).toBe(false);
		expect(plugin.app.workspace.revealed).toEqual([]);
		expect(plugin.app.workspace.activeLeaf).toBeNull();
		expect(openCollectionEditor.getCursor()).toEqual({ line: -1, ch: -1 });
		expect(logEditor.getCursor()).toEqual({ line: 5, ch: 0 });

		// The pending jump is remembered as before, so once Obsidian's own
		// handling opens the note (wherever it puts it — a new tab here), the
		// cursor still lands on the task's own row.
		arrive();

		expect(collectionEditor.getCursor()).toEqual({ line: ROW_OF_B_IN_COLLECTION, ch: 0 });
	});

	// Ticket #932: a collection open in a deferred (not-yet-loaded) background
	// tab is not a `MarkdownView` until it loads, so on `216b44a`
	// `findOpenCollectionView`'s `instanceof MarkdownView` check misses it and
	// the click falls through to Obsidian's own handling — the #905 defect
	// comes back. Wrong code leaves `revealed` empty and the deferred editor's
	// cursor at `{-1,-1}`.
	it("finds the collection in a deferred background tab, and loads it before placing the cursor", async () => {
		const { plugin } = await clickFixture();
		const { content, underline } = livePreviewRows(LOG_LINES);
		const logEditor = new FakeNoteEditor(LOG_LINES, { line: 5, ch: 0 }, content);
		plugin.app.workspace.activeView = noteView(LOG_PATH, logEditor, "source");

		const deferredEditor = new FakeNoteEditor(COLLECTION_LINES);
		const deferredLeaf = new WorkspaceLeaf(new DeferredView(noteView(COLLECTION_PATH, deferredEditor, "source")));
		plugin.app.workspace.leaves.push(deferredLeaf);

		click(underline.get(7)!);
		// Three real `await`s happen before the cursor is placed, one microtask
		// tick each, all because this leaf is deferred: `revealLeaf`,
		// `loadIfDeferred`, then `waitForNoteText` (a no-op wait here, since the
		// fake editor's text is there the instant the view is swapped in — but
		// still one more `await` to resume past).
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(deferredLeaf.isDeferred).toBe(false);
		expect(deferredEditor.getCursor()).toEqual({ line: ROW_OF_B_IN_COLLECTION, ch: 0 });
		expect(plugin.app.workspace.revealed).toEqual([deferredLeaf]);
		expect(plugin.app.workspace.activeLeaf).toBe(deferredLeaf);
		expect(logEditor.getCursor()).toEqual({ line: 5, ch: 0 });
	});

	// Ticket #932, driven against real Obsidian 1.13.7
	// (`docs/acceptance-shots/issue-905-jump-focus-readback.txt`): a leaf that
	// was deferred hands back a working `editor` the instant
	// `revealLeaf`/`loadIfDeferred` resolve, but the note's own text lands in
	// it a short beat later (about 18ms in the drive) — an editor that answers
	// `getValue()` with `""` for a beat, then the real text. Wrong code (no
	// wait for the text to arrive) reads the eid as not found and leaves the
	// cursor at `{-1,-1}` before the text has landed.
	it("waits for a deferred leaf's own text to arrive before placing the cursor", async () => {
		vi.useFakeTimers();
		try {
			const { plugin } = await clickFixture();
			const { content, underline } = livePreviewRows(LOG_LINES);
			const logEditor = new FakeNoteEditor(LOG_LINES, { line: 5, ch: 0 }, content);
			plugin.app.workspace.activeView = noteView(LOG_PATH, logEditor, "source");

			let cursor = { line: -1, ch: -1 };
			let reads = 0;
			const lateEditor: ViewEditor = {
				getValue: (): string => (reads++ < 2 ? "" : COLLECTION_LINES.join("\n")),
				getLine: (line: number): string => COLLECTION_LINES[line] ?? "",
				getCursor: (): { line: number; ch: number } => cursor,
				setCursor: (pos: { line: number; ch: number }): void => {
					cursor = pos;
				},
			};
			const deferredLeaf = new WorkspaceLeaf(new DeferredView(noteView(COLLECTION_PATH, lateEditor, "source")));
			plugin.app.workspace.leaves.push(deferredLeaf);

			click(underline.get(7)!);
			await vi.advanceTimersByTimeAsync(100);

			expect(cursor).toEqual({ line: ROW_OF_B_IN_COLLECTION, ch: 0 });
			expect(Notice.messages).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("with two open views of the collection, chooses the same one every time — the first iterateAllLeaves visits", async () => {
		const { plugin } = await clickFixture();
		const { content, underline } = livePreviewRows(LOG_LINES);
		plugin.app.workspace.activeView = noteView(LOG_PATH, new FakeNoteEditor(LOG_LINES, { line: 5, ch: 0 }, content), "source");

		const firstEditor = new FakeNoteEditor(COLLECTION_LINES);
		const secondEditor = new FakeNoteEditor(COLLECTION_LINES);
		const firstLeaf = new WorkspaceLeaf(noteView(COLLECTION_PATH, firstEditor, "source"));
		const secondLeaf = new WorkspaceLeaf(noteView(COLLECTION_PATH, secondEditor, "source"));
		plugin.app.workspace.leaves.push(firstLeaf, secondLeaf);

		click(underline.get(7)!);
		await Promise.resolve();

		expect(firstEditor.getCursor()).toEqual({ line: ROW_OF_B_IN_COLLECTION, ch: 0 });
		expect(secondEditor.getCursor()).toEqual({ line: -1, ch: -1 });
		expect(plugin.app.workspace.activeLeaf).toBe(firstLeaf);
	});

	it("reveals a view open in a popout window, and leaves the main window's log pane alone", async () => {
		const { plugin } = await clickFixture();
		const { content, underline } = livePreviewRows(LOG_LINES);
		const logEditor = new FakeNoteEditor(LOG_LINES, { line: 5, ch: 0 }, content);
		plugin.app.workspace.activeView = noteView(LOG_PATH, logEditor, "source");

		const popout = document.implementation.createHTMLDocument("popout");
		const popoutEditor = new FakeNoteEditor(COLLECTION_LINES);
		const popoutLeaf = new WorkspaceLeaf(noteView(COLLECTION_PATH, popoutEditor, "source"));
		popoutLeaf.doc = popout;
		popoutLeaf.win = (popout.defaultView as Window | null) ?? window;
		plugin.app.workspace.leaves.push(popoutLeaf);

		click(underline.get(5)!);
		await Promise.resolve();

		expect(popoutEditor.getCursor()).toEqual({ line: ROW_OF_A_IN_COLLECTION, ch: 0 });
		expect(plugin.app.workspace.activeLeaf).toBe(popoutLeaf);
		expect(logEditor.getCursor()).toEqual({ line: 5, ch: 0 });
	});

	it("when the collection is not open anywhere, leaves today's behaviour unchanged: nothing is revealed at the click, and the file-open that follows places the cursor", async () => {
		const { plugin, collectionEditor, arrive } = await clickFixture();
		const { content, underline } = livePreviewRows(LOG_LINES);
		plugin.app.workspace.activeView = noteView(LOG_PATH, new FakeNoteEditor(LOG_LINES, { line: 5, ch: 0 }, content), "source");

		click(underline.get(7)!);

		expect(plugin.app.workspace.revealed).toEqual([]);
		expect(plugin.app.workspace.activeLeaf).toBeNull();
		expect(collectionEditor.getCursor()).toEqual({ line: -1, ch: -1 });

		arrive();

		expect(collectionEditor.getCursor()).toEqual({ line: ROW_OF_B_IN_COLLECTION, ch: 0 });
	});
});

/**
 * Ticket #938: the command (`effortless:jump-to-source`, palette or hotkey)
 * asks the same open-view question the click handler already asks
 * before it falls back to opening a new view. Wrong code (the command wired
 * straight to `jumpFromLine`) never calls `revealLeaf` or moves the already-
 * open pane's cursor, and would instead try to open the collection through
 * the ordinary route, leaving `revealed` empty.
 */
describe("the command when the collection is already open elsewhere", () => {
	it("reveals the pane already holding the collection, places the cursor there, and leaves the log's own pane untouched", async () => {
		const { plugin } = await startFeature();
		plugin.app.metadataCache.caches.set(COLLECTION_PATH, {});
		const check = jumpCheckOf(plugin);
		const editor = new FakeSourceEditor(LOG_LINES[7]);

		const logLeaf = new WorkspaceLeaf(noteView(LOG_PATH, new FakeNoteEditor(LOG_LINES), "source"));
		// Ticket #959: without this, the assertion below that the log's own pane
		// is untouched cannot fail — the mock's `getLeaf(false).openFile` only
		// ever replaces the leaf that matches `activeView`, so a wrong code path
		// that reaches `jumpFromLine`'s "not open anywhere" fallback needs this
		// leaf to be the one it would replace.
		plugin.app.workspace.activeView = logLeaf.view as MarkdownView;
		plugin.app.workspace.leaves.push(logLeaf);
		const openCollectionEditor = new FakeNoteEditor(COLLECTION_LINES);
		const collectionLeaf = new WorkspaceLeaf(noteView(COLLECTION_PATH, openCollectionEditor, "source"));
		plugin.app.workspace.leaves.push(collectionLeaf);

		expect(check(false, editor, { file: { path: LOG_PATH } })).toBe(true);
		await Promise.resolve();

		expect(plugin.app.workspace.revealed).toEqual([collectionLeaf]);
		expect(plugin.app.workspace.activeLeaf).toBe(collectionLeaf);
		expect(plugin.app.workspace.activeLeafFocus).toBe(true);
		expect(openCollectionEditor.getCursor()).toEqual({ line: ROW_OF_B_IN_COLLECTION, ch: 0 });
		expect((logLeaf.view as MarkdownView).file.path).toBe(LOG_PATH);
	});

	it("when the collection is not open anywhere, falls back to jumpFromLine's own open-and-place path, unchanged", async () => {
		const { plugin } = await startFeature();
		plugin.app.workspace.activeView = noteView(LOG_PATH, new FakeNoteEditor(LOG_LINES), "source");
		const editor = new FakeJumpEditor(COLLECTION_LINES.join("\n"));
		const target = fakeTarget({ open: async () => editor });
		const line = taskLine(LOG_LINES[7]);

		await jumpFromLine(target, LOG_PATH, line);

		expect(plugin.app.workspace.revealed).toEqual([]);
		expect(plugin.app.workspace.activeView).not.toBeNull();
		expect((plugin.app.workspace.activeView as MarkdownView).file.path).toBe(LOG_PATH);
		expect(plugin.app.workspace.activeLeaf).toBeNull();
		expect(editor.getCursor()).toEqual({ line: ROW_OF_B_IN_COLLECTION, ch: 0 });
		expect(target.notified).toEqual([]);
	});

	// Ticket #959: no drive nor unit test previously ran the "not open
	// anywhere" fallback through the *registered command* — the test above
	// this one calls `jumpFromLine` directly. No leaf is pushed into
	// `workspace.leaves`, so `getLeaf(false).openFile` stays the disconnected
	// no-op it has always been for this case; `activeView` stands in for what
	// it holds once Obsidian's own open has run, the shortcut
	// `openNoteEditor`'s own tests use (`markedLine.test.ts`). Which pane a
	// fallback open lands in is the *other* new describe block's own question
	// (ticket #955's own tests, and the one above ticket #959 fixed).
	it("when the collection is not open anywhere, opens it through the registered command and places the cursor on the right line", async () => {
		const { plugin } = await startFeature();
		plugin.app.metadataCache.caches.set(COLLECTION_PATH, {});
		plugin.app.vault.files.push({ path: COLLECTION_PATH });
		const check = jumpCheckOf(plugin);
		const editor = new FakeSourceEditor(LOG_LINES[7]);
		const collectionEditor = new FakeNoteEditor(COLLECTION_LINES);
		plugin.app.workspace.activeView = noteView(COLLECTION_PATH, collectionEditor, "source");

		expect(check(false, editor, { file: { path: LOG_PATH } })).toBe(true);
		// This fallback nests two more `await`s than the open-view branch above
		// (`openNoteEditor`'s own `getLeaf(false).openFile`, then `jumpFromLine`'s
		// `await target.open(path)` over that): one microtask tick each to resume
		// past.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(plugin.app.workspace.revealed).toEqual([]);
		expect(plugin.app.workspace.activeLeaf).toBeNull();
		expect(collectionEditor.getCursor()).toEqual({ line: ROW_OF_B_IN_COLLECTION, ch: 0 });
		expect(Notice.messages).toEqual([]);
	});
});

/**
 * Ticket #955: `jumpFromLineOrOpenView` asked whether the collection was
 * already open *before* asking whether the named note still was one, so a
 * note that had stopped being a collection (its tasks heading renamed or
 * gone, #811) was revealed instead of getting #811's own notice, whenever
 * some pane happened to have it open — the command's answer depended on
 * whether the note was open, which #811 never asked it to. Wrong code
 * (`6c1de3b`, the open-view lookup running before `isCollection`) reveals
 * `collectionLeaf` and places the cursor there instead of saying so; this
 * asserts neither happened.
 */
describe("the command, ticket #955: the collection check comes before the open-view question", () => {
	it("says the collection cannot be found, rather than revealing it, when the open note has stopped being one", async () => {
		const { plugin } = await startFeature(undefined, { all: () => [], at: () => null });
		plugin.app.metadataCache.caches.set(COLLECTION_PATH, {});
		const check = jumpCheckOf(plugin);
		const editor = new FakeSourceEditor(LOG_LINES[7]);

		const logLeaf = new WorkspaceLeaf(noteView(LOG_PATH, new FakeNoteEditor(LOG_LINES), "source"));
		plugin.app.workspace.activeView = logLeaf.view as MarkdownView;
		plugin.app.workspace.leaves.push(logLeaf);
		const openCollectionEditor = new FakeNoteEditor(COLLECTION_LINES);
		const collectionLeaf = new WorkspaceLeaf(noteView(COLLECTION_PATH, openCollectionEditor, "source"));
		plugin.app.workspace.leaves.push(collectionLeaf);

		expect(check(false, editor, { file: { path: LOG_PATH } })).toBe(true);
		await Promise.resolve();

		expect(plugin.app.workspace.revealed).toEqual([]);
		expect(plugin.app.workspace.activeLeaf).toBeNull();
		expect(openCollectionEditor.getCursor()).toEqual({ line: -1, ch: -1 });
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("not a collection any more");
		expect((logLeaf.view as MarkdownView).file.path).toBe(LOG_PATH);
	});

	// Second half of #955: `jumpToOpenView` (through `jumpFromLine`'s own
	// `target.openView`) had no `try` around it at the command's own call
	// site, so a rejected `revealLeaf`/`loadIfDeferred` was an unhandled
	// rejection with no notice — where the "not open anywhere" path already
	// told the person (`jumpFromLine`'s own `target.open` catch). Wrong code
	// leaves `Notice.messages` empty and rejects unhandled instead.
	it("tells the person, rather than leaving an unhandled rejection, when revealing the already-open collection fails", async () => {
		const { plugin } = await startFeature();
		plugin.app.metadataCache.caches.set(COLLECTION_PATH, {});
		const check = jumpCheckOf(plugin);
		const editor = new FakeSourceEditor(LOG_LINES[7]);

		const logLeaf = new WorkspaceLeaf(noteView(LOG_PATH, new FakeNoteEditor(LOG_LINES), "source"));
		plugin.app.workspace.activeView = logLeaf.view as MarkdownView;
		plugin.app.workspace.leaves.push(logLeaf);
		const collectionLeaf = new WorkspaceLeaf(noteView(COLLECTION_PATH, new FakeNoteEditor(COLLECTION_LINES), "source"));
		plugin.app.workspace.leaves.push(collectionLeaf);
		vi.spyOn(plugin.app.workspace, "revealLeaf").mockRejectedValue(new Error("no such pane"));

		expect(check(false, editor, { file: { path: LOG_PATH } })).toBe(true);
		await Promise.resolve();
		await Promise.resolve();

		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("could not open");
	});
});
