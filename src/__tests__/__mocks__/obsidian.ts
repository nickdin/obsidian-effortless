/**
 * A stub of the parts of Obsidian's API the core touches, because the real
 * `obsidian` module only exists inside the running app. `vitest.config.ts`
 * points every `import … from "obsidian"` at this file.
 *
 * `Component` is the one piece written faithfully rather than minimally: the
 * core's on/off switch is `addChild`/`removeChild`, so the tests are worth
 * little unless the stub loads, unloads and propagates errors the way Obsidian
 * documents. The DOM helpers and `Setting` are written faithfully for the same
 * reason: the settings screen is drawn with them, so a stub that only records
 * the calls would prove nothing about what the person ends up looking at.
 * Everything else here exists only so a module can be imported.
 */

/**
 * What `Events.on` hands back: one subscription, and the way to take it off.
 *
 * Obsidian's own `EventRef` is opaque and is undone through the register it
 * came from. This one carries that route with it, which is all `registerEvent`
 * needs and keeps the stub's `Component` from having to know whose event it is.
 */
export interface EventRef {
	/** The event subscribed to. For a test to read; Obsidian's ref has no name. */
	readonly name: string;
	/** Takes this one subscription off the register it came from. */
	detach(): void;
}

export class Component {
	loaded = false;
	/**
	 * Public so a test can see what is still attached. Obsidian keeps the same
	 * list privately; a component left attached after a failed load is exactly
	 * the kind of disagreement these tests exist to catch.
	 */
	readonly children: Component[] = [];
	private readonly cleanups: (() => void)[] = [];

	load(): void {
		if (this.loaded) return;
		this.loaded = true;
		this.onload();
		for (const child of [...this.children]) child.load();
	}

	onload(): void {}

	unload(): void {
		if (!this.loaded) return;
		this.loaded = false;
		for (const child of [...this.children]) this.removeChild(child);
		for (const cleanup of this.cleanups.splice(0)) cleanup();
		this.onunload();
	}

	onunload(): void {}

	addChild<T extends Component>(component: T): T {
		this.children.push(component);
		if (this.loaded) component.load();
		return component;
	}

	removeChild<T extends Component>(component: T): T {
		const index = this.children.indexOf(component);
		if (index >= 0) this.children.splice(index, 1);
		component.unload();
		return component;
	}

	register(cleanup: () => void): void {
		this.cleanups.push(cleanup);
	}

	/**
	 * Every ref handed to `registerEvent`, in order, so a test can see that a
	 * subscription went through the component — which is what makes it come off
	 * again at unload.
	 */
	readonly registeredEvents: EventRef[] = [];

	/**
	 * Obsidian's own: it keeps the ref and takes the subscription off when the
	 * component unloads. The cleanup goes through `register`, the same list
	 * `registerInterval` uses, so unload order is unchanged.
	 *
	 * A no-op here until issue
	 * #81, which meant the
	 * wrapper could be deleted from a module's wiring with no test noticing.
	 */
	registerEvent(eventRef: EventRef): void {
		this.registeredEvents.push(eventRef);
		this.register(() => eventRef.detach());
	}

	/**
	 * Obsidian clears the interval when the component unloads, so the stub does
	 * the same: a component that repeats on a timer must stop repeating the
	 * moment it is switched off.
	 */
	registerInterval(id: number): number {
		this.register(() => window.clearInterval(id));
		return id;
	}

	/**
	 * Obsidian's own: an ordinary `addEventListener`, taken off again through
	 * the same `register` list every other cleanup here uses, so a component
	 * that adds one and unloads stops hearing it — the route ticket
	 * #811's jump-to-source
	 * click needs, added here because nothing before it did
	 * (`node_modules/obsidian/obsidian.d.ts:1892-1904`).
	 */
	registerDomEvent(el: EventTarget, type: string, callback: EventListener): void {
		el.addEventListener(type, callback);
		this.register(() => el.removeEventListener(type, callback));
	}
}

export interface Command {
	id: string;
	name: string;
	callback?: () => void;
}

export interface TFile {
	path: string;
}

export interface DataWriteOptions {
	mtime?: number;
}

/**
 * Obsidian's own event register: a name, and the callbacks hung on it.
 *
 * One base for the vault and the metadata cache, because a test that drives
 * either drives them the same way — `fire` in place of the thing happening in
 * the app, and `names` to see what a module subscribed to.
 */
export class Events {
	/** Every `on` subscription, as `[eventName, callback]`, in order. */
	readonly listeners: [string, (...args: unknown[]) => void][] = [];

	/** Which subscription each handed-out ref stands for. */
	private readonly held = new Map<EventRef, [string, (...args: unknown[]) => void]>();

	on(name: string, callback: (...args: unknown[]) => void): EventRef {
		const entry: [string, (...args: unknown[]) => void] = [name, callback];
		// The ref is the entry's identity, not its name: the same event
		// subscribed to twice gives two refs, and detaching one leaves the other.
		const ref: EventRef = { name, detach: () => this.offref(ref) };
		this.listeners.push(entry);
		this.held.set(ref, entry);
		return ref;
	}

	/**
	 * Obsidian's own name for taking one subscription off again.
	 *
	 * A ref that is not on this register — already detached, or never here — is
	 * ignored rather than refused, as Obsidian's is, so unloading twice is safe.
	 */
	offref(ref: EventRef): void {
		const entry = this.held.get(ref);
		if (entry === undefined) return;
		this.held.delete(ref);
		const index = this.listeners.indexOf(entry);
		if (index >= 0) this.listeners.splice(index, 1);
	}

	/**
	 * What the app does when the thing happens: calls everyone hung on it, with
	 * whatever it carries — `workspace.on("window-open", (win, window) => …)`
	 * among them, which is why this takes more than a name.
	 */
	fire(name: string, ...args: unknown[]): void {
		// Over a copy: a listener may detach itself, or another, as it runs.
		for (const [hung, callback] of [...this.listeners]) {
			if (hung === name) callback(...args);
		}
	}

	/** The event names subscribed to, in order. */
	names(): string[] {
		return this.listeners.map(([name]) => name);
	}
}

export class Vault extends Events {
	/**
	 * The notes this vault reports. Empty by default: a test that needs files
	 * fills it, and one that does not gets an empty vault rather than a throw.
	 */
	files: TFile[] = [];

	/**
	 * What a read hands back, by path — `null` until a test opts in.
	 *
	 * Reading is off by default and every reading method throws, because most
	 * of this plugin is not allowed to open a file at all: the collections
	 * index answers from Obsidian's parsed metadata, and a stub that quietly
	 * handed back a string would turn that rule from a test into a claim.
	 */
	private contents: Map<string, string> | null = null;

	/**
	 * Says this suite is one that legitimately reads files, and what it finds
	 * when it does. Only the paths listed here can be read; a path not listed
	 * throws, naming the ones that were. A suite that
	 * wants an empty file lists the path with an empty string.
	 */
	allowReads(contents: Record<string, string> = {}): void {
		this.contents = new Map(Object.entries(contents));
	}

	/** The folders this vault reports. A test fills it, or `createFolder` does. */
	readonly folders = new Set<string>();

	/** Every path handed to `create`, in order — so a second creation shows up. */
	readonly created: string[] = [];

	getMarkdownFiles(): TFile[] {
		return this.files;
	}

	getFolderByPath(path: string): unknown | null {
		return this.folders.has(path) ? { path } : null;
	}

	/** Obsidian's own rejects when the folder is already there, so this does. */
	async createFolder(path: string): Promise<unknown> {
		await Promise.resolve();
		if (this.folders.has(path)) throw new Error(`Folder already exists: ${path}`);
		this.folders.add(path);
		return { path };
	}

	/**
	 * Creates a note, as Obsidian's own does, rejecting on a path already there.
	 *
	 * Writing is not reading, so this needs no `allowReads`. What it wrote is
	 * only readable back in a suite that has opted in; everywhere else the file
	 * exists and `created` records it, which is what a test of the caller wants.
	 */
	async create(path: string, data: string): Promise<TFile> {
		await Promise.resolve();
		if (this.getFileByPath(path) !== null) throw new Error(`already exists: ${path}`);
		this.created.push(path);
		this.files.push({ path });
		this.contents?.set(path, data);
		return { path };
	}

	getFileByPath(path: string): TFile | null {
		return this.files.find((file) => file.path === path) ?? null;
	}

	/**
	 * The map `allowReads()` filled, or `null` when the suite never called it.
	 * `FileManager.renameFile`'s own way to find the other notes it might need
	 * to rewrite a link in, without teaching it `contents`'s private shape. A
	 * suite that never opted into reading has nothing for it to rewrite either.
	 */
	readableContents(): Map<string, string> | null {
		return this.contents;
	}

	read(file: TFile): Promise<string> {
		return Promise.resolve(this.contentsOf(file, "read"));
	}

	cachedRead(file: TFile): Promise<string> {
		return Promise.resolve(this.contentsOf(file, "cachedRead"));
	}

	process(file: TFile, fn: (data: string) => string): Promise<string> {
		const changed = fn(this.contentsOf(file, "process"));
		this.contents?.set(file.path, changed);
		return Promise.resolve(changed);
	}

	/**
	 * Not `async`, so the throw is thrown rather than handed back as a rejected
	 * promise. A caller that never awaits — the collections index would be one,
	 * if it ever read a file — has to fail there and then.
	 */
	private contentsOf(file: TFile, method: string): string {
		if (this.contents === null) {
			throw new Error(
				`${method}("${file.path}") opened a file through the obsidian stub's Vault. ` +
					"Nothing may read a file unless the suite says so with allowReads().",
			);
		}
		const found = this.contents.get(file.path);
		if (found === undefined) {
			const listed = [...this.contents.keys()];
			throw new Error(
				`${method}("${file.path}") asked the obsidian stub's Vault for a path this suite ` +
					`never listed. ${
						listed.length === 0
							? "It listed no path at all."
							: `It listed ${listed.map((path) => `"${path}"`).join(", ")}.`
					} ` +
					"Add the path to allowReads(), with an empty string if the file is meant to be empty.",
			);
		}
		return found;
	}
}

/**
 * What Obsidian has already parsed for each note. A plain map, so a test says
 * what the cache holds rather than parsing anything.
 */
export class MetadataCache extends Events {
	readonly caches = new Map<string, unknown>();

	/**
	 * Obsidian's own link index: which source notes currently resolve a link to
	 * which target, with a count — `resolvedLinks` in
	 * `node_modules/obsidian/obsidian.d.ts:4438`. A plain object a test sets
	 * directly, the way `caches` is a plain map, rather than derived from it: the
	 * real one is a separate, already-computed answer, and `collectionRename.ts` is what
	 * first needed it here.
	 */
	resolvedLinks: Record<string, Record<string, number>> = {};

	getCache(path: string): unknown | null {
		return this.caches.get(path) ?? null;
	}

	/** `getFileCache(file)`, `node_modules/obsidian/obsidian.d.ts:4417`: the same entry as {@link getCache}, asked by file. Reads the map itself, so a test counting `getCache` counts only the callers that ask by path. */
	getFileCache(file: { path: string }): unknown | null {
		return this.caches.get(file.path) ?? null;
	}
}

/**
 * The part of Obsidian's workspace the note writer depends on: which note is on
 * screen, and a way to be told when that changes. A test asserts on `listeners`
 * to see that the plugin actually subscribed.
 */
/** What the stub's editors read of the right-click that opens their menu. */
export interface PressableEditor {
	getValue(): string;
	getCursor(): EditorPosition;
	/**
	 * The line the right-click lands on. A test that opens the editor menu must set
	 * it: left unset, the stub throws ({@link UNNAMED_PRESSED_LINE_MESSAGE}).
	 * `null` is a menu opened with no mouse event at all.
	 */
	pressedLine?: number | null;
	/** Present-but-`null` is an editor that has no such call; absent, the stub supplies one. */
	cm?: { posAtCoords(coords: { x: number; y: number }): number } | null;
	offsetToPos?(offset: number): EditorPosition;
}

/** What the stub says when a test opens the editor menu without naming the line pressed: the rule from `CLAUDE.md`, quoted. */
export const UNNAMED_PRESSED_LINE_MESSAGE =
	"This test opens the editor menu without naming the pressed line. CLAUDE.md: \"An editor-menu entry decides from the line that was pressed, never the cursor's line, and offers itself only on a line where its action can run.\" " +
	"Set `pressedLine` on the editor (a number, or null for a menu with no mouse event) — see `pressLine` and `pressCursorLine` in `src/__tests__/editorMenu.ts`. A test that presses the cursor's own line gives its reason as `pressCursorLine`'s argument.";

/** Height the stub gives every line of an editor, so a line and a pixel row answer each other. */
export const EDITOR_LINE_HEIGHT = 20;

/**
 * What Obsidian does before it fires `editor-menu`: a real `contextmenu` event
 * reaches the document, carrying where the pointer is
 * (`docs/acceptance-shots/issue-881-rightclick-line.txt`). Gives the editor the
 * two calls that turn those coordinates into a line, `editor.cm.posAtCoords`
 * and `editor.offsetToPos` (`node_modules/obsidian/obsidian.d.ts:2571`), unless
 * a test set `cm` itself. Obsidian moves the cursor only after the event, so the
 * stub never moves it.
 */
function pressLine(editor: PressableEditor): void {
	const lines = editor.getValue().split("\n");
	if (!("cm" in editor)) editor.cm = {
		posAtCoords: ({ y }) => {
			const line = Math.min(Math.max(Math.floor(y / EDITOR_LINE_HEIGHT), 0), lines.length - 1);
			return lines.slice(0, line).reduce((offset, each) => offset + each.length + 1, 0);
		},
	};
	editor.offsetToPos ??= (offset) => {
		let line = 0;
		let start = 0;
		while (line < lines.length - 1 && offset >= start + lines[line].length + 1) start += lines[line++].length + 1;
		return { line, ch: offset - start };
	};
	const pressed = editor.pressedLine;
	if (pressed === undefined) throw new Error(UNNAMED_PRESSED_LINE_MESSAGE);
	if (pressed === null) return;
	document.dispatchEvent(new MouseEvent("contextmenu", { clientX: 40, clientY: pressed * EDITOR_LINE_HEIGHT + EDITOR_LINE_HEIGHT / 2, bubbles: true }));
}

export class Workspace extends Events {
	/** The note reported as open, or `null` when none is. */
	activeFile: TFile | null = null;

	/** Obsidian fires `editor-menu` from a right-click, so the stub does the right-click first ({@link pressLine}). */
	override fire(name: string, ...args: unknown[]): void {
		if (name === "editor-menu") pressLine(args[1] as PressableEditor);
		super.fire(name, ...args);
	}

	getActiveFile(): TFile | null {
		return this.activeFile;
	}

	/**
	 * Opens `path` (or nothing) and fires every `file-open` listener, handing
	 * each the file the way Obsidian's own event does
	 * (`node_modules/obsidian/obsidian.d.ts:8078`, `TFile | null`).
	 */
	open(path: string | null): void {
		this.activeFile = path === null ? null : { path };
		this.fire("file-open", this.activeFile);
	}

	/**
	 * The note view Obsidian would answer `getActiveViewOfType(MarkdownView)`
	 * with, set by a test. `null` when no note is in front.
	 */
	activeView: MarkdownView | null = null;

	/** Obsidian's own (`node_modules/obsidian/obsidian.d.ts:7989`): the active view when it is one of `type`, otherwise `null`. */
	getActiveViewOfType<T>(type: abstract new (...args: never[]) => T): T | null {
		return this.activeView instanceof type ? this.activeView : null;
	}

	/**
	 * Obsidian runs `callback` once the vault's index and layout are built, at
	 * once when they already are. A test's vault is ready from the start, so
	 * this answers at once; `CalendarSources` tests that need a cold start hand
	 * the class a readiness function of their own.
	 */
	onLayoutReady(callback: () => void): void {
		callback();
	}

	/** The tabs open now. A test pushes a {@link WorkspaceLeaf} here to open one. */
	readonly leaves: WorkspaceLeaf[] = [];

	/** The view types `Plugin.registerView` was given, by type: what a leaf from {@link getRightLeaf} can be set to. */
	readonly viewCreators = new Map<string, (leaf: WorkspaceLeaf) => ItemView>();

	/**
	 * (`node_modules/obsidian/obsidian.d.ts:7967`.) A new, empty tab in the right
	 * sidebar, open at once. The real answer is `null` when the sidebar cannot
	 * give one; a test that wants that sets {@link rightLeafAvailable} to false.
	 */
	rightLeafAvailable = true;
	getRightLeaf(_split: boolean): WorkspaceLeaf | null {
		if (!this.rightLeafAvailable) return null;
		const leaf = new WorkspaceLeaf(new EmptyView(null));
		leaf.viewCreators = this.viewCreators;
		this.leaves.push(leaf);
		return leaf;
	}

	getLeavesOfType(viewType: string): WorkspaceLeaf[] {
		return this.leaves.filter((leaf) => leaf.view.getViewType() === viewType);
	}

	/**
	 * Obsidian's own (`node_modules/obsidian/obsidian.d.ts:8021`): closes every
	 * tab holding `viewType`. The types asked for are kept in order, so a test
	 * can see that a switch-off asked for the right one.
	 */
	readonly detachedTypes: string[] = [];
	detachLeavesOfType(viewType: string): void {
		this.detachedTypes.push(viewType);
		for (let at = this.leaves.length - 1; at >= 0; at--) {
			if (this.leaves[at].view.getViewType() === viewType) this.leaves.splice(at, 1);
		}
	}

	/**
	 * Obsidian's own route to every open leaf, across every open window
	 * (`node_modules/obsidian/obsidian.d.ts:8009`) — the one a plugin has to
	 * find a popout's document through, since a class it adds to the main
	 * window's `<body>` is not mirrored to one opened later.
	 */
	iterateAllLeaves(callback: (leaf: WorkspaceLeaf) => void): void {
		for (const leaf of this.leaves) callback(leaf);
	}

	/**
	 * Opens a second window holding `doc`, the way `Move to new window` does,
	 * and fires `window-open` the way Obsidian's own workspace does
	 * (`node_modules/obsidian/obsidian.d.ts:8090`) — so a test can drive the
	 * event a feature registered for, not only read the leaf back afterwards.
	 *
	 * `doc` is kept as given rather than reached through `defaultView`: a
	 * document a test built with `document.implementation.createHTMLDocument`
	 * has no `defaultView` of its own, which is exactly the plain popout stand-in
	 * this exists to accept.
	 */
	openWindow(doc: Document): WorkspaceLeaf {
		const leaf = new WorkspaceLeaf(new EmptyView(null));
		leaf.win = (doc.defaultView as Window | null) ?? window;
		leaf.doc = doc;
		this.leaves.push(leaf);
		this.fire("window-open", leaf.getContainer(), leaf.win);
		return leaf;
	}

	/** Every leaf `revealLeaf` was asked to bring forward, in the order it was asked. */
	readonly revealed: WorkspaceLeaf[] = [];

	/** Obsidian's own (`node_modules/obsidian/obsidian.d.ts:8029`): resolves once the leaf is brought forward. */
	async revealLeaf(leaf: WorkspaceLeaf): Promise<void> {
		this.revealed.push(leaf);
	}

	/** The leaf `setActiveLeaf` last made active, and the `focus` it was asked for. */
	activeLeaf: WorkspaceLeaf | null = null;
	activeLeafFocus: boolean | undefined;

	/**
	 * Obsidian's own (`node_modules/obsidian/obsidian.d.ts:7922`): the
	 * published doc comment there says only "Sets the active leaf" and names
	 * no side effect on `activeView`. This double mirrors `activeView` to
	 * `leaf`'s note as a convenience for a test that then reads
	 * `getActiveViewOfType` to see the result — the test double's own
	 * assumption about what would be convenient, not a recorded fact about
	 * what the real workspace does.
	 */
	setActiveLeaf(leaf: WorkspaceLeaf, params?: { focus?: boolean }): void {
		this.activeLeaf = leaf;
		this.activeLeafFocus = params?.focus;
		if (leaf.view instanceof MarkdownView) this.activeView = leaf.view;
	}
}

/** What a tab shows: its view type, and for a note the note and its mode. */
export interface ViewState {
	type: string;
	state?: Record<string, unknown>;
}

/**
 * An open tab. `setViewState` replaces the view inside it, as Obsidian's does:
 * a `markdown` state builds a new {@link MarkdownView} over the same note and
 * text, anything else an empty view. `events` is the log a test reads to see
 * what was done to the tab, and in what order.
 */
export class WorkspaceLeaf {
	readonly events: string[] = [];
	private ephemeral: Record<string, unknown> = { cursor: { line: 0, ch: 0 } };
	/**
	 * The window and document this leaf's tab sits in — the main ones unless
	 * {@link Workspace.openWindow} gave it a popout's. Held
	 * independently rather than one derived from the other, because a document
	 * a test built with `createHTMLDocument` has no `defaultView` to derive it
	 * from.
	 */
	win: Window = window;
	doc: Document = document;

	/**
	 * The view types the plugin registered, handed to a leaf by
	 * {@link Workspace.getRightLeaf} so its `setViewState` can make a plugin's
	 * own view as Obsidian does. A leaf a test built by hand has none and makes
	 * only the empty view, as before.
	 */
	viewCreators: ReadonlyMap<string, (leaf: WorkspaceLeaf) => ItemView> | null = null;

	constructor(public view: MarkdownView | EmptyView | DeferredView | ItemView) {
		if (view instanceof MarkdownView) view.leaf = this;
	}

	/** Real Obsidian's own route from a leaf to its window and document. */
	getContainer(): { win: Window; doc: Document } {
		return { win: this.win, doc: this.doc };
	}

	getViewState(): ViewState {
		const view = this.view;
		if (view instanceof MarkdownView) return { type: "markdown", state: { file: view.file.path, mode: view.mode } };
		if (view instanceof DeferredView) {
			return { type: "markdown", state: { file: view.resolvesTo.file.path, mode: view.resolvesTo.mode } };
		}
		return { type: view.getViewType() };
	}

	/** Obsidian's own (`node_modules/obsidian/obsidian.d.ts:8279`): true while this leaf's view is a `DeferredView` stand-in rather than the real one. */
	get isDeferred(): boolean {
		return this.view instanceof DeferredView;
	}

	/**
	 * Obsidian's own (`node_modules/obsidian/obsidian.d.ts:8285`): loads a
	 * deferred view and waits for it. A no-op once loaded, or if this leaf was
	 * never deferred — real Obsidian's own contract, ticket #932.
	 */
	async loadIfDeferred(): Promise<void> {
		if (!(this.view instanceof DeferredView)) return;
		const loaded = this.view.resolvesTo;
		this.view = loaded;
		loaded.leaf = this;
	}

	getEphemeralState(): Record<string, unknown> {
		return this.ephemeral;
	}

	async setViewState(state: ViewState, eState?: Record<string, unknown>): Promise<void> {
		this.events.push(`view:${state.type}`);
		const previous = this.view;
		if (state.type === "markdown" && previous instanceof EmptyView && previous.was !== null) {
			const was = previous.was;
			const mode = state.state?.mode === "preview" ? "preview" : "source";
			this.view = new MarkdownView(was.file, was.data, mode);
			this.view.leaf = this;
		} else if (state.type === "markdown" && previous instanceof MarkdownView) {
			return;
		} else if (state.type !== "empty" && this.viewCreators?.has(state.type)) {
			const made = this.viewCreators.get(state.type)!(this);
			this.view = made;
			await made.onOpen();
		} else {
			this.view = new EmptyView(previous instanceof MarkdownView ? previous : null);
		}
		if (eState !== undefined) this.ephemeral = eState;
	}
}

/**
 * Stands in for Obsidian's own `DeferredView` (unpublished as a type;
 * `WorkspaceLeaf.isDeferred`'s own doc comment,
 * `node_modules/obsidian/obsidian.d.ts:8274`, names it): the view a leaf holds
 * before it has loaded, in a background tab Obsidian has not shown since
 * start-up. Holds only the real view {@link WorkspaceLeaf.loadIfDeferred}
 * swaps in, since a test builds that view the ordinary way (`noteView`) and
 * this only delays handing it over.
 */
export class DeferredView {
	constructor(readonly resolvesTo: MarkdownView) {}

	getViewType(): string {
		return "markdown";
	}
}

/**
 * A plugin's own view, as `Plugin.registerView`'s creator returns it. Only
 * what the core and its tests touch: the tab it sits in and its type.
 */
export abstract class ItemView {
	readonly containerEl: HTMLElement = document.createElement("div");
	/** (`node_modules/obsidian/obsidian.d.ts:3590`, `contentEl`.) Where a view draws. */
	readonly contentEl: HTMLElement = this.containerEl.createDiv();
	constructor(public leaf: WorkspaceLeaf) {}
	abstract getViewType(): string;
	abstract getDisplayText(): string;
	/** (`obsidian.d.ts:7674`.) */
	getIcon(): string {
		return "document";
	}
	/** (`obsidian.d.ts:7639`, `:7644`.) The stub's `setViewState` calls `onOpen` once it has made the view. */
	async onOpen(): Promise<void> {}
	async onClose(): Promise<void> {}
}

/** The view a tab holds while it shows nothing. It remembers the note it replaced. */
export class EmptyView {
	constructor(readonly was: MarkdownView | null) {}

	getViewType(): string {
		return "empty";
	}
}

/** What the code under test asks of a note's editor here; a test's own fake supplies it. */
export interface ViewEditor {
	getValue(): string;
	getLine(line: number): string;
	getCursor(): EditorPosition;
	setCursor(pos: EditorPosition): void;
	/** `Editor.transaction` (`node_modules/obsidian/obsidian.d.ts:2556`); only a fake that takes an edit answers it. */
	transaction?(tx: { changes?: { from: EditorPosition; to?: EditorPosition; text: string }[] }, origin?: string): void;
}

/**
 * An editor over a note's text that really changes when a transaction lands
 * and can put the last one back, as Obsidian's undo does: one transaction is
 * one undo step. Lines are split on `\n` only, the way a test states what the
 * editor holds; a test that wants the editor to hand `\r` back puts it in `text`.
 */
export class FakeNoteEditor implements ViewEditor {
	readonly transactions: { changes?: { from: EditorPosition; to?: EditorPosition; text: string }[] }[] = [];

	private readonly undoStack: string[] = [];

	constructor(public text: string) {}

	getValue(): string {
		return this.text;
	}

	getLine(line: number): string {
		return this.text.split("\n")[line] ?? "";
	}

	getCursor(): EditorPosition {
		return { line: 0, ch: 0 };
	}

	setCursor(): void {}

	transaction(tx: { changes?: { from: EditorPosition; to?: EditorPosition; text: string }[] }): void {
		this.transactions.push(tx);
		this.undoStack.push(this.text);
		const lines = this.text.split("\n");
		for (const change of tx.changes ?? []) {
			const line = lines[change.from.line];
			const to = change.to ?? change.from;
			lines[change.from.line] = line.slice(0, change.from.ch) + change.text + line.slice(to.ch);
		}
		this.text = lines.join("\n");
	}

	/** Puts back the text before the last transaction: one undo. */
	undo(): void {
		const was = this.undoStack.pop();
		if (was !== undefined) this.text = was;
	}
}

/**
 * A note open in a tab, in reading mode (`preview`) or editing mode (`source`,
 * which is live preview unless the person chose source mode). `data` is the
 * note's text as the view holds it; `save` records itself on the tab's log.
 */
export class MarkdownView {
	leaf: WorkspaceLeaf | null = null;
	saves = 0;
	/**
	 * The note's editor (`node_modules/obsidian/obsidian.d.ts:4191`). Only a test
	 * that drives an editor-side route sets one, to a fake of its own that
	 * answers the calls the code under test makes; it is left unset otherwise.
	 */
	editor!: ViewEditor;
	/**
	 * The note's reading-view renderer (`node_modules/obsidian/obsidian.d.ts:4194`,
	 * `MarkdownPreviewView`). `rerender` is Obsidian's own
	 * (`obsidian.d.ts:4088`): it draws the note's sections again through every
	 * post processor registered now. Here it records its argument and runs
	 * `onRerender`, which a test sets to draw the sections it built.
	 */
	readonly previewMode = {
		rerenders: [] as (boolean | undefined)[],
		onRerender: null as (() => void) | null,
		rerender(full?: boolean): void {
			this.rerenders.push(full);
			this.onRerender?.();
		},
	};
	/**
	 * Set by a test to hold `save()` open until this resolves, so a second call
	 * reaching the same tab can be made to land while the first is still
	 * writing — Obsidian's own `save()` writes to disk and does not resolve at
	 * once either.
	 */
	saveGate: Promise<void> | null = null;

	constructor(
		readonly file: TFile,
		public data: string,
		readonly mode: "preview" | "source" = "source",
	) {}

	getViewType(): string {
		return "markdown";
	}

	getMode(): "preview" | "source" {
		return this.mode;
	}

	getViewData(): string {
		return this.data;
	}

	async save(): Promise<void> {
		this.saves += 1;
		this.leaf?.events.push("save");
		if (this.saveGate) await this.saveGate;
	}
}

export type Modifier = "Mod" | "Ctrl" | "Meta" | "Shift" | "Alt";

/** What a key press is matched on: the modifiers held, joined by commas, and the key. */
export interface KeymapInfo {
	modifiers: string | null;
	key: string | null;
}

export type KeymapEventListener = (evt: KeyboardEvent, ctx: KeymapInfo) => false | unknown;

export interface KeymapEventHandler extends KeymapInfo {
	scope: Scope;
	func: KeymapEventListener;
}

/**
 * A set of key bindings, written from Obsidian 1.13.7's own code, read off the
 * running application through the debugging door on 2026-09-17 for issue
 * #598.
 *
 * `obsidian.d.ts` declares only the constructor, `register` and `unregister`
 * (`:5537-5552`). `keys`, `parent` and `handleKey` are Obsidian's but
 * unpublished; they are
 * here because they decide which binding a key reaches. `handleKey` tries this
 * scope's own bindings in the order they were registered. The first that
 * matches runs; what it returns ends the search unless that is `undefined` from
 * a binding that matches every key and modifier (`null` for both). Only when
 * none ended it does the key go on to `parent`, and nowhere else.
 */
export class Scope {
	readonly keys: KeymapEventHandler[] = [];

	constructor(public parent?: Scope) {}

	register(modifiers: Modifier[] | null, key: string | null, func: KeymapEventListener): KeymapEventHandler {
		const handler = { scope: this, modifiers: modifiers ? modifiers.join(",") : null, key, func };
		this.keys.push(handler);
		return handler;
	}

	unregister(handler: KeymapEventHandler): void {
		const at = this.keys.indexOf(handler);
		if (at >= 0) this.keys.splice(at, 1);
	}

	handleKey(evt: KeyboardEvent, info: KeymapInfo): unknown {
		for (const handler of this.keys) {
			const matches =
				(handler.modifiers === null || handler.modifiers === info.modifiers) &&
				(handler.key === null || handler.key === info.key);
			if (!matches) continue;
			const answer = handler.func(evt, info);
			if (answer !== undefined) return answer;
			if (handler.key !== null || handler.modifiers !== null) return answer;
		}
		return this.parent?.handleKey(evt, info);
	}
}

/**
 * The stack of scopes Obsidian asks about a key, as 1.13.7 keeps it for one
 * window: a key goes to the scope on top, and only to that one (and whatever
 * parents it has). `pushScope` of the scope already on top does nothing;
 * `popScope` of one on top uncovers the one below, of one further down takes it
 * out, and of one not on the stack at all does nothing.
 *
 * `press` is not Obsidian's: a test calls it to stand in for a key pressed in
 * the window, and reads what Obsidian's key listener would have — `false` for a
 * key a binding took.
 */
export class Keymap {
	private readonly below: Scope[] = [];
	private top: Scope;

	constructor(private readonly root: Scope) {
		this.top = root;
	}

	pushScope(scope: Scope): void {
		if (this.top === scope) return;
		this.below.push(this.top);
		this.top = scope;
	}

	popScope(scope: Scope): void {
		if (scope === this.root) return;
		if (this.top === scope) {
			this.top = this.below.pop() ?? this.root;
			return;
		}
		const at = this.below.indexOf(scope);
		if (at >= 0) this.below.splice(at, 1);
	}

	press(key: string, modifiers: Modifier[] = []): unknown {
		return this.top.handleKey(new KeyboardEvent("keydown", { key }), { modifiers: modifiers.join(","), key });
	}
}

/**
 * Obsidian's keychain, `app.secretStorage`, as a plain map. Its id rule is the
 * one the test Obsidian 1.14.4 runs, read from its own `validateId`
 * (`docs/acceptance-shots/issue-1216-keychain-id-rule.txt`): lowercase letters,
 * digits and dashes, at most 64 characters, and anything else throws. Only the
 * three published methods are here (`obsidian.d.ts`, class `SecretStorage`).
 */
export class SecretStorage {
	readonly secrets = new Map<string, string>();

	setSecret(id: string, secret: string): void {
		if (!/^[a-z0-9-]+$/.test(id) || id.length > 64) {
			throw new Error("Secret ID is invalid. Use only lowercase letters, numbers and dashes. 64 characters max.");
		}
		this.secrets.set(id, secret);
	}

	getSecret(id: string): string | null {
		return this.secrets.get(id) ?? null;
	}

	listSecrets(): string[] {
		return [...this.secrets.keys()];
	}
}

export class App {
	/** The scope at the bottom of the keymap's stack, which Obsidian also hands out as `app.scope`. */
	readonly scope = new Scope();
	readonly keymap = new Keymap(this.scope);
	vault = new Vault();
	readonly workspace = new Workspace();
	readonly metadataCache = new MetadataCache();
	/**
	 * Obsidian's per-vault `localStorage`, which never syncs between devices.
	 * A plain map here, so a test can look at exactly what a device kept.
	 */
	readonly localStorage = new Map<string, unknown>();
	readonly secretStorage = new SecretStorage();

	loadLocalStorage(key: string): unknown | null {
		return this.localStorage.has(key) ? this.localStorage.get(key) : null;
	}

	saveLocalStorage(key: string, data: unknown | null): void {
		if (data === null) this.localStorage.delete(key);
		// Round-tripped through JSON, as the real store is, so a test cannot
		// pass by sharing an object reference with the code under test.
		else this.localStorage.set(key, JSON.parse(JSON.stringify(data)));
	}
}

export interface EditorPosition {
	line: number;
	ch: number;
}

export interface EditorSuggestTriggerInfo {
	start: EditorPosition;
	end: EditorPosition;
	query: string;
}

export interface EditorSuggestContext extends EditorSuggestTriggerInfo {
	editor: StubEditor;
	file: TFile | null;
}

/** The one thing Obsidian's suggester asks of an editor before `onTrigger`. */
export interface StubEditor {
	getCursor(which: "from" | "to"): EditorPosition;
}

/**
 * The popup that offers something as you type, written from Obsidian 1.13.7's
 * own code, read off the running application through the debugging door on
 * 2026-09-15 for issue #574:
 * the constructor sets `context` to null and `limit` to 100; `close()` sets
 * `context` to null and then closes the popup, and is harmless on one that was
 * never open; `trigger` asks `onTrigger`, keeps the answer as `context`, and
 * only when the popup is open or being forced open asks for suggestions and
 * shows them; showing none closes it, and showing more than `limit` cuts the
 * list.
 *
 * `trigger` and `isOpen` are Obsidian's but not in `obsidian.d.ts`: the editor
 * calls `trigger` on every keystroke, and a test calls it to stand in for one.
 * Only a synchronous `getSuggestions` is shown here.
 *
 * **Its keys**, read the same way on 2026-09-17 for issue
 * #598: the constructor
 * builds `scope` with the app's scope as its parent, and on it registers the
 * list's navigation keys — ArrowUp, ArrowDown, PageUp, PageDown, Home, End,
 * Ctrl+P, Ctrl+N, Enter — each bound to *this* popup's own list, then Escape.
 * `open()` pushes that scope onto the keymap; every `close()` pops it, open or
 * not. `selected` is the list's highlighted row; Enter chooses it. An app a
 * test built as a bare object has no keymap, and then nothing is pushed or
 * popped.
 */
export abstract class EditorSuggest<T> {
	context: EditorSuggestContext | null = null;
	limit = 100;
	isOpen = false;
	/** What the popup is showing now. Obsidian draws them; a test reads them. */
	shown: T[] = [];
	/** The row the popup's list has highlighted, which Enter chooses. */
	selected = 0;
	scope: Scope;

	constructor(public app: App) {
		const scope = (this.scope = new Scope(app.scope));
		const move = (to: (at: number) => number) => (): false => {
			this.selected = Math.max(0, Math.min(this.shown.length - 1, to(this.selected)));
			return false;
		};
		scope.register([], "ArrowUp", move((at) => at - 1));
		scope.register([], "ArrowDown", move((at) => at + 1));
		scope.register([], "PageUp", move(() => 0));
		scope.register([], "PageDown", move(() => this.shown.length - 1));
		scope.register([], "Home", move(() => 0));
		scope.register([], "End", move(() => this.shown.length - 1));
		scope.register(["Ctrl"], "P", move((at) => at - 1));
		scope.register(["Ctrl"], "N", move((at) => at + 1));
		scope.register([], "Enter", (evt) => {
			if (this.selected < this.shown.length) this.selectSuggestion(this.shown[this.selected], evt);
			return false;
		});
		scope.register([], "Escape", () => {
			this.close();
			return false;
		});
	}

	open(): void {
		if (this.isOpen) return;
		this.isOpen = true;
		this.app.keymap?.pushScope(this.scope);
	}

	close(): void {
		this.context = null;
		this.app.keymap?.popScope(this.scope);
		this.isOpen = false;
		this.shown = [];
	}

	setInstructions(_instructions: { command: string; purpose: string }[]): void {}

	abstract onTrigger(
		cursor: EditorPosition,
		editor: StubEditor,
		file: TFile | null,
	): EditorSuggestTriggerInfo | null;
	abstract getSuggestions(context: EditorSuggestContext): T[] | Promise<T[]>;
	abstract renderSuggestion(value: T, el: HTMLElement): void;
	abstract selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void;

	trigger(editor: StubEditor, file: TFile | null, force: boolean): boolean {
		const info = this.onTrigger(editor.getCursor("from"), editor, file);
		if (!info) {
			this.context = null;
			return false;
		}
		const context = (this.context = { editor, file, ...info });
		if (force || this.isOpen) {
			const found = this.getSuggestions(context);
			if (Array.isArray(found)) this.showSuggestions(found);
		}
		return true;
	}

	showSuggestions(values: T[]): void {
		if (values.length === 0) {
			this.close();
			return;
		}
		this.shown = this.limit > 0 && values.length > this.limit ? values.slice(0, this.limit) : values;
		this.selected = 0;
		this.open();
	}
}

/**
 * A dialog over the workspace (`node_modules/obsidian/obsidian.d.ts:4477`).
 * Written for issue #856,
 * the first feature to open one, and only as far as a test needs: it has its
 * elements and its two hooks, `open()` runs `onOpen` once and `close()` runs
 * `onClose` once and is harmless on a dialog that is not open. Nothing is
 * drawn. A later dialog — the confirmation modal of issue
 * #858 — extends this.
 */
export class Modal {
	isOpen = false;
	readonly containerEl = document.createElement("div");
	readonly modalEl = this.containerEl.appendChild(document.createElement("div"));
	readonly titleEl = this.modalEl.appendChild(document.createElement("div"));
	readonly contentEl = this.modalEl.appendChild(document.createElement("div"));
	readonly scope: Scope;

	constructor(public app: App) {
		this.scope = new Scope(app.scope);
	}

	open(): void {
		if (this.isOpen) return;
		this.isOpen = true;
		this.onOpen();
	}

	close(): void {
		if (!this.isOpen) return;
		this.isOpen = false;
		this.onClose();
	}

	onOpen(): void {}

	onClose(): void {}
}

/**
 * Obsidian's yes-or-no dialog (`obsidian.d.ts:1963`'s `ConfirmationModal`,
 * since 1.13.0): a {@link Modal} with a row of buttons. As in Obsidian, a
 * button closes the dialog after its handler unless the handler answers
 * something truthy, and the cancel button only closes it. `press` and `dismiss`
 * are stub-only: a person pressing a button by its text, and Escape or a click
 * outside, which both reach `close`. The rest of the published members
 * (`addClass`, `addCheckbox`) are here only as far as a caller needs them.
 */
export class ConfirmationModal extends Modal {
	readonly buttonContainerEl = this.modalEl.appendChild(document.createElement("div"));
	/** The buttons added, in the order they were added, cancel included. */
	readonly buttons: ButtonComponent[] = [];

	addClass(cls: string): this {
		this.modalEl.classList.add(cls);
		return this;
	}

	addButton(cb: (btn: ButtonComponent) => unknown): this {
		const button = new ButtonComponent();
		const onClick = button.onClick.bind(button);
		button.onClick = (each) => {
			return onClick((event) => {
				const answer = each(event);
				if (!answer) this.close();
				return answer;
			});
		};
		cb(button);
		this.buttons.push(button);
		return this;
	}

	addCancelButton(text = "Cancel"): this {
		return this.addButton((btn) => btn.setButtonText(text).onClick(() => undefined));
	}

	/** A person pressing the button that reads `text`. */
	press(text: string): void {
		const button = this.buttons.find((each) => each.text === text);
		if (button === undefined) throw new Error(`no button reads ${JSON.stringify(text)}`);
		button.click();
	}

	/** Escape, or a click outside the dialog. */
	dismiss(): void {
		this.close();
	}
}

/**
 * The type-to-filter dialog (`obsidian.d.ts:6861`'s `SuggestModal`): a
 * {@link Modal} that asks its subclass for the suggestions a query gives, how
 * to draw one, and what choosing one does. Choosing closes the dialog first and
 * then hands the suggestion over — the order this stub keeps; that Obsidian
 * keeps it too is an inference, not driven. `chooseAt` stands in for the person
 * picking a row.
 */
export abstract class SuggestModal<T> extends Modal {
	abstract getSuggestions(query: string): T[] | Promise<T[]>;
	abstract renderSuggestion(value: T, el: HTMLElement): void;
	abstract onChooseSuggestion(item: T, evt: MouseEvent | KeyboardEvent): void;

	/** What choosing the row at `index` of the suggestions `query` gives does. */
	async chooseAt(query: string, index: number): Promise<void> {
		const suggestions = await this.getSuggestions(query);
		this.close();
		this.onChooseSuggestion(suggestions[index], new KeyboardEvent("keydown", { key: "Enter" }));
	}
}

/** Obsidian's `FuzzyMatch<T>` (`obsidian.d.ts:3277`): an item with how well it matched. */
export interface FuzzyMatch<T> {
	item: T;
	match: { score: number; matches: [number, number][] };
}

/**
 * {@link SuggestModal} over a list of items (`obsidian.d.ts:3294`): the three
 * abstract members are `getItems`, `getItemText` and `onChooseItem`. Obsidian's
 * own fuzzy scoring is not reproduced. An empty query gives every item in the
 * order `getItems` gave them, and a typed query keeps the items whose text
 * holds the query's letters in order, which is all a test of what a person
 * would be offered needs; how the real one ranks them is for a drive.
 */
export abstract class FuzzySuggestModal<T> extends SuggestModal<FuzzyMatch<T>> {
	abstract getItems(): T[];
	abstract getItemText(item: T): string;
	abstract onChooseItem(item: T, evt: MouseEvent | KeyboardEvent): void;

	getSuggestions(query: string): FuzzyMatch<T>[] {
		const wanted = query.toLowerCase().replace(/\s+/g, "");
		return this.getItems().flatMap((item) => {
			const text = this.getItemText(item).toLowerCase();
			let at = 0;
			for (const letter of wanted) {
				at = text.indexOf(letter, at);
				if (at === -1) return [];
				at += 1;
			}
			return [{ item, match: { score: 0, matches: [] } }];
		});
	}

	renderSuggestion(value: FuzzyMatch<T>, el: HTMLElement): void {
		el.createDiv({ text: this.getItemText(value.item) });
	}

	onChooseSuggestion(item: FuzzyMatch<T>, evt: MouseEvent | KeyboardEvent): void {
		this.onChooseItem(item.item, evt);
	}
}

/** What Obsidian hands a code-block handler beside the block. */
export interface MarkdownPostProcessorContext {
	docId: string;
	sourcePath: string;
	frontmatter: unknown;
	/**
	 * Obsidian's: attaches a child to the rendered section, so it unloads when
	 * the section is thrown away — a re-render, the note closed. Required in
	 * Obsidian and optional here only so the registry's tests, which never
	 * reach a feature that calls it, can go on handing a three-field context.
	 * The day view's tests hand one that loads the child at once and keep it,
	 * so they can unload it to stand in for the section going away.
	 */
	addChild?(child: Component): void;
}

/**
 * Obsidian's component for something drawn inside a rendered section: a
 * `Component` holding the element it drew into. The day view hangs one on each
 * block it draws so that it hears when Obsidian throws that block away.
 */
export class MarkdownRenderChild extends Component {
	constructor(public containerEl: HTMLElement) {
		super();
	}
}

/**
 * Obsidian's Markdown renderer, reduced to what a test can read back: every
 * call is recorded, and the Markdown handed in is put into the element as
 * text, inside a `div.stub-markdown`, so a test can see what was drawn where.
 * Obsidian's own draws the Markdown as HTML; nothing here parses it. A test
 * that reads `rendered` clears it first.
 */
export class MarkdownRenderer {
	static rendered: { markdown: string; sourcePath: string; el: HTMLElement }[] = [];

	static async render(
		_app: App,
		markdown: string,
		el: HTMLElement,
		sourcePath: string,
		_component: Component,
	): Promise<void> {
		MarkdownRenderer.rendered.push({ markdown, sourcePath, el });
		const drawn = el.ownerDocument.createElement("div");
		drawn.className = "stub-markdown";
		drawn.textContent = markdown;
		el.appendChild(drawn);
	}
}

export type CodeBlockHandler = (
	source: string,
	el: HTMLElement,
	ctx: MarkdownPostProcessorContext,
) => Promise<unknown> | void;

export interface MarkdownPostProcessor {
	(el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<unknown> | void;
	sortOrder?: number;
}

/**
 * The two lists Obsidian draws a Markdown code block from, as Obsidian 1.13.7
 * keeps them. Read off the running application's own code through the
 * debugging door on 2026-09-17 (#622,
 * `docs/acceptance-shots/issue-622-withdrawal-does-not-free-the-language.txt`):
 *
 * - `postProcessors` is what reading mode runs over a rendered note. The two
 *   published statics add to it and take from it, and nothing else.
 * - `codeBlockPostProcessors`, keyed by language, is what live preview asks to
 *   draw a block, and it refuses a second claim on a language by throwing
 *   `Code block postprocessor for language <x> is already registered`. It is
 *   not in `obsidian.d.ts`: only a plugin's own unload clears an entry.
 *
 * Both are here, the unpublished one included, because a stub that let
 * `unregisterPostProcessor` free a language would pass a core that withdraws
 * its renderer while the real application kept the language held — the shape
 * of #551. Statics are
 * shared by every plugin in a test file, as they are in the application, so a
 * test that registers one calls {@link MarkdownPreviewRenderer.reset} first.
 */
export class MarkdownPreviewRenderer {
	static postProcessors: MarkdownPostProcessor[] = [];
	static codeBlockPostProcessors: Record<string, CodeBlockHandler> = {};

	static registerPostProcessor(postProcessor: MarkdownPostProcessor, sortOrder?: number): void {
		postProcessor.sortOrder = sortOrder;
		this.postProcessors.push(postProcessor);
		this.postProcessors.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
	}

	static unregisterPostProcessor(postProcessor: MarkdownPostProcessor): void {
		const at = this.postProcessors.indexOf(postProcessor);
		if (at >= 0) this.postProcessors.splice(at, 1);
	}

	/** Not published. Obsidian's `Plugin.registerMarkdownCodeBlockProcessor` calls it. */
	static registerCodeBlockPostProcessor(language: string, handler: CodeBlockHandler): void {
		if (Object.prototype.hasOwnProperty.call(this.codeBlockPostProcessors, language)) {
			throw new Error(`Code block postprocessor for language ${language} is already registered`);
		}
		this.codeBlockPostProcessors[language] = handler;
	}

	/** Not published. Only a plugin's unload reaches it. */
	static unregisterCodeBlockPostProcessor(language: string): void {
		delete this.codeBlockPostProcessors[language];
	}

	/**
	 * Obsidian's: finds every `code.language-<x>` in a rendered section, puts a
	 * `div.block-language-<x>` where its `<pre>` was, and hands the handler the
	 * code's text and that div.
	 */
	static createCodeBlockPostProcessor(language: string, handler: CodeBlockHandler): MarkdownPostProcessor {
		return (el, ctx) => {
			for (const code of Array.from(el.querySelectorAll(`code.language-${language}`))) {
				const pre = code.parentElement;
				if (pre === null) continue;
				const div = el.ownerDocument.createElement("div");
				div.className = `block-language-${language}`;
				pre.replaceWith(div);
				void handler(code.textContent ?? "", div, ctx);
			}
		};
	}

	/** For a test: forgets every registration, as a fresh application would. */
	static reset(): void {
		this.postProcessors = [];
		this.codeBlockPostProcessors = {};
	}

	/**
	 * For a test: draws a block the way reading mode does — a section holding
	 * `<pre><code class="language-<x>">`, run through every post processor —
	 * and hands back the section.
	 */
	static renderReading(language: string, source: string, ctx: MarkdownPostProcessorContext): HTMLElement {
		const section = document.createElement("div");
		const code = section.appendChild(document.createElement("pre")).appendChild(document.createElement("code"));
		code.className = `language-${language}`;
		code.textContent = source;
		for (const postProcessor of [...this.postProcessors]) void postProcessor(section, ctx);
		return section;
	}

	/**
	 * For a test: draws a block the way live preview does. With a handler held
	 * for the language, the handler is given a fresh `div.block-language-<x>` and
	 * that div comes back; with none, live preview shows the block's lines as
	 * text and this answers `null`.
	 */
	static renderLivePreview(
		language: string,
		source: string,
		ctx: MarkdownPostProcessorContext,
	): HTMLElement | null {
		if (!Object.prototype.hasOwnProperty.call(this.codeBlockPostProcessors, language)) return null;
		const div = document.createElement("div");
		div.className = `block-language-${language}`;
		void this.codeBlockPostProcessors[language](source, div, ctx);
		return div;
	}
}

export class Plugin extends Component {
	manifest = { id: "effortless" };
	/**
	 * The palette: the commands registered right now, in the order they were
	 * added, each carrying the prefixed id Obsidian gave it.
	 *
	 * A live set rather than a log. It used to keep every command ever handed to
	 * `addCommand` and never drop one, which is why no test could see that this
	 * plugin's withdrawals removed nothing in the real application.
	 */
	readonly commands: Command[] = [];
	/**
	 * Every id passed to removeCommand, in order, **exactly as the caller wrote
	 * it** — this stub does not prefix what it records.
	 *
	 * That is the choice a test reading this list has to know about, and it is
	 * deliberate: real Obsidian's `removeCommand` adds the manifest prefix
	 * itself, so the short id is the one a caller is supposed to hand over. A
	 * record of the prefixed id would show every caller as correct, which is the
	 * whole of #548. What is
	 * left standing in `commands` is the state; this is the call log.
	 */
	readonly removedCommands: string[] = [];
	/** Everything ever handed to saveData, in order, as it was serialised. */
	readonly saved: string[] = [];
	private stored: unknown = null;

	/**
	 * Held open until the release handed back is called, if a test asked for it.
	 *
	 * Obsidian's write to `data.json` takes real time; this stub's takes none,
	 * so without a way to hold one open a test cannot tell a flush that waited
	 * for the write from one that answered while it was still running. That
	 * difference is the whole of issue #212.
	 */
	private saveGate: Promise<void> | null = null;

	constructor(public app: App = new App()) {
		super();
	}

	/**
	 * The status-bar items handed out and still in the document. Obsidian
	 * removes one only when the whole plugin unloads
	 * (`node_modules/obsidian/obsidian.d.ts:4947`), so a test that sees one gone
	 * after a feature's switch-off is seeing the core's `remove()`, nothing else.
	 */
	get statusBarItems(): HTMLElement[] {
		return this.statusBar.filter((el) => el.isConnected);
	}
	private readonly statusBar: HTMLElement[] = [];
	private readonly statusBarRoot: HTMLElement = document.body.appendChild(document.createElement("div"));

	/** Added to the document like Obsidian's, and likewise only gone when removed. */
	addStatusBarItem(): HTMLElement {
		const item = this.statusBarRoot.appendChild(document.createElement("div"));
		this.statusBar.push(item);
		return item;
	}

	/**
	 * Obsidian's left ribbon keeps its own list of items, and `onChange` redraws
	 * the bar from every item that still has a `buttonEl`: `o.toggle(!r.hidden)`,
	 * then `setChildrenInPlace`. Read off the running application on 2026-10-09. `removeRibbonAction` is the only thing that drops an item, and the
	 * plugin does not reach it before it unloads, so an item stays in this list
	 * for the whole session.
	 */
	readonly ribbonItems: { icon: string; title: string; el: HTMLElement; hidden: boolean }[] = [];
	private readonly ribbonRoot: HTMLElement = document.body.appendChild(document.createElement("div"));

	/**
	 * The ribbon icons a person would see: in the document and not hidden by a
	 * style. Reads the computed style, so a test that wants an answer from it
	 * loads `styles.css` into the document first.
	 */
	get ribbonIcons(): { icon: string; title: string; el: HTMLElement }[] {
		return this.ribbonItems.filter((r) => r.el.isConnected && getComputedStyle(r.el).display !== "none");
	}

	/**
	 * (`node_modules/obsidian/obsidian.d.ts:4938`.) Nothing takes it back before
	 * the plugin unloads. Adding an item redraws the whole bar, as `onChange(false)`
	 * does: every item's element is shown again (`toggle(true)` sets the inline
	 * `display` back to its default) and put back in the bar, one that was removed
	 * from the document included.
	 */
	addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement {
		const el = document.createElement("div");
		el.addEventListener("click", (evt) => void callback(evt));
		this.ribbonItems.push({ icon, title, el, hidden: false });
		for (const item of this.ribbonItems) {
			item.el.style.display = item.hidden ? "none" : "";
			this.ribbonRoot.appendChild(item.el);
		}
		return el;
	}

	/**
	 * The view types registered, each with its creator. A second registration
	 * of one type throws (inferred from Obsidian's behaviour, not driven), and
	 * `obsidian.d.ts` offers no route that withdraws a type: the only unregister it declares is
	 * `MarkdownPreviewRenderer.unregisterPostProcessor` (`:4047`) and
	 * `Scope.unregister` (`:5550`), neither of them for a view. So nothing here
	 * takes one back either, which is the point.
	 */
	readonly views = new Map<string, (leaf: WorkspaceLeaf) => ItemView>();

	/** (`node_modules/obsidian/obsidian.d.ts:4974`.) */
	registerView(type: string, viewCreator: (leaf: WorkspaceLeaf) => ItemView): void {
		if (this.views.has(type)) throw new Error(`Attempting to register an existing view type "${type}"`);
		this.views.set(type, viewCreator);
		this.app.workspace.viewCreators.set(type, viewCreator);
	}

	/** Every suggester registered and not yet taken back, in the order registered. */
	readonly editorSuggests: EditorSuggest<unknown>[] = [];

	/**
	 * Registers a suggester, as Obsidian 1.13.7 does:
	 * `function(e){ ... this.app.workspace.editorSuggest.addSuggest(e),
	 * this.register(function(){ return ...removeSuggest(e) }) }`, read off the
	 * running application on 2026-09-15.
	 *
	 * So nothing takes one back before the plugin itself unloads, and
	 * `obsidian.d.ts` offers no method that would. A stub with a removal the
	 * application lacks would let a core that registers afresh on every switch-on
	 * pass while the real one stacks suggesters — the shape of
	 * #551.
	 */
	registerEditorSuggest(suggest: EditorSuggest<unknown>): void {
		this.editorSuggests.push(suggest);
		this.register(() => {
			if (suggest.isOpen) suggest.close();
			this.editorSuggests.splice(this.editorSuggests.indexOf(suggest), 1);
		});
	}

	/**
	 * Registers a code-block renderer, as Obsidian 1.13.7 does:
	 * `function(e,t,n){ var r=AW.createCodeBlockPostProcessor(e,t); return
	 * AW.registerPostProcessor(r,n), AW.registerCodeBlockPostProcessor(e,t),
	 * this.app.workspace.trigger("post-processor-change"), this.register(function(){
	 * AW.unregisterCodeBlockPostProcessor(e), AW.unregisterPostProcessor(r), ... }), r }`,
	 * read off the running application on 2026-09-17.
	 *
	 * So a language another registration holds throws **after** the reading-mode
	 * processor was added, which stays; and the processor handed back is the
	 * reading-mode one alone, so unregistering it leaves the language held. The
	 * workspace event is not modelled: nothing in this repository listens to it.
	 */
	registerMarkdownCodeBlockProcessor(
		language: string,
		handler: CodeBlockHandler,
		sortOrder?: number,
	): MarkdownPostProcessor {
		const processor = MarkdownPreviewRenderer.createCodeBlockPostProcessor(language, handler);
		MarkdownPreviewRenderer.registerPostProcessor(processor, sortOrder);
		MarkdownPreviewRenderer.registerCodeBlockPostProcessor(language, handler);
		this.register(() => {
			MarkdownPreviewRenderer.unregisterCodeBlockPostProcessor(language);
			MarkdownPreviewRenderer.unregisterPostProcessor(processor);
		});
		return processor;
	}

	/**
	 * Registers a command, as Obsidian 1.13.7 does: the id is rewritten in place
	 * to the manifest id, a colon, then the id the caller gave, and the same
	 * object is handed back carrying the prefixed id.
	 *
	 * Read off the running application through the debugging door during the
	 * #328 drive — `function(e){ ... e.id = this.manifest.id + ":" + e.id; ...
	 * return e }` — and recorded in
	 * `docs/acceptance-shots/issue-328-commands-not-withdrawn.txt`.
	 */
	addCommand(command: Command): Command {
		command.id = `${this.manifest.id}:${command.id}`;
		this.commands.push(command);
		return command;
	}

	/**
	 * Withdraws a command, as Obsidian 1.13.7 does: it adds the manifest prefix
	 * to the id it is given and removes the command registered under that
	 * prefixed id. So the id a caller must hand over is the **short** one.
	 *
	 * Also read off the running application — `function(e){
	 * this.app.commands.removeCommand(this.manifest.id + ":" + e) }` — and proved
	 * by probe: `removeCommand("effortless:…")` left the command in the palette
	 * and `removeCommand("…")` took it out.
	 *
	 * An id nothing is registered under removes nothing and is not an error, as
	 * in the real application.
	 */
	removeCommand(commandId: string): void {
		this.removedCommands.push(commandId);
		const registeredAs = `${this.manifest.id}:${commandId}`;
		const at = this.commands.findIndex((command) => command.id === registeredAs);
		if (at < 0) return;
		this.commands.splice(at, 1);
	}

	/**
	 * Puts data in the store as if an earlier session had saved it there.
	 *
	 * Not `saveData`: that method belongs to `src/core/settings.ts` alone (repo
	 * `CLAUDE.md`), and `saved` is what a test reads to see it was called. A
	 * suite that just needs a starting `data.json` says so here instead.
	 */
	seedData(data: unknown): void {
		this.stored = JSON.parse(JSON.stringify(data));
	}

	/**
	 * Answers a fresh copy of what the store holds, as Obsidian does by parsing
	 * `data.json` on every call. Handing back the stored object itself let the
	 * settings store's in-memory edits reach this stub's "file" through the
	 * reference `load` kept, so a read-back after a write that never landed
	 * could match what memory held rather than what was stored.
	 */
	async loadData(): Promise<unknown> {
		return JSON.parse(JSON.stringify(this.stored)) as unknown;
	}

	/** Set by {@link swallowSaves}. */
	private savesSwallowed = false;

	/**
	 * Makes every `saveData` from here on resolve while leaving the stored data
	 * as it was, until the returned restore runs.
	 *
	 * That is what Obsidian does when the write to disk fails: `Vault.writeJson`
	 * catches the adapter's error and resolves, so `saveData` never rejects for
	 * a full disk or a read-only file. The call is
	 * still recorded in `saved`, because it was made; `loadData` goes on
	 * answering what was there before.
	 */
	swallowSaves(): () => void {
		this.savesSwallowed = true;
		return () => {
			this.savesSwallowed = false;
		};
	}

	/**
	 * Holds every `saveData` from here on open until the returned release runs.
	 *
	 * Nothing is recorded in `saved` while a write is held, so a test can see
	 * the difference between a write that has started and one that has landed.
	 */
	holdSaves(): () => void {
		let release = (): void => undefined;
		this.saveGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		return () => {
			this.saveGate = null;
			release();
		};
	}

	async saveData(data: unknown): Promise<void> {
		// Round-tripped through JSON, as Obsidian's own data.json is, so a test
		// cannot accidentally pass by sharing an object reference with the store.
		// Serialised as the call is made and not once a held write is released:
		// Obsidian's `Vault.writeJson` serialises in the same synchronous step,
		// and serialising late wrote settings changed during the hold, which the
		// real file never holds and the store's read-back rightly refuses.
		const serialised = JSON.stringify(data);
		if (this.saveGate !== null) await this.saveGate;
		this.saved.push(serialised);
		if (this.savesSwallowed) return;
		this.stored = JSON.parse(serialised);
	}

	/** Every tab handed to `addSettingTab`, in order. */
	readonly settingTabs: PluginSettingTab[] = [];

	/** Keeps the tab and stores its definitions, as Obsidian's `addSettingTab` does by calling `update()`. */
	addSettingTab(tab: PluginSettingTab): void {
		this.settingTabs.push(tab);
		tab.update();
	}
}

/**
 * Obsidian's answer to "what device is this", as four flags a test sets.
 *
 * Nothing in this repository reads it yet. It is here, settable, because the
 * two day view tickets after #627 do: the bubble shows on a tap where
 * `isMobile` is true,
 * and a rename matches without regard to capitals where `isDesktopApp` holds
 * together with `isWin` or `isMacOS`. Adding it once,
 * with #627, is what lets neither of them touch this file. The defaults are a
 * desktop that is neither Windows nor macOS; a test that changes a flag puts
 * it back with {@link resetPlatform}.
 */
export const Platform = {
	isMobile: false,
	isDesktopApp: true,
	isWin: false,
	isMacOS: false,
};

/** Puts every {@link Platform} flag back to its default. */
export function resetPlatform(): void {
	Platform.isMobile = false;
	Platform.isDesktopApp = true;
	Platform.isWin = false;
	Platform.isMacOS = false;
}

export class Notice {
	/**
	 * Every message shown, for tests to assert on. Reset it in beforeEach. For a
	 * message that is a `DocumentFragment` (`node_modules/obsidian/obsidian.d.ts:4637`)
	 * it holds the fragment's own text, the words outside any element, so a test
	 * reads what a person is told apart from what they can press; the elements
	 * are in {@link Notice.fragments}.
	 */
	static messages: string[] = [];
	/** Every fragment message shown, for a test to find and press its buttons. Reset it in beforeEach. */
	static fragments: DocumentFragment[] = [];
	/** How many notices were hidden, by `hide()`. */
	static hidden = 0;
	constructor(message: string | DocumentFragment) {
		if (typeof message === "string") {
			Notice.messages.push(message);
			return;
		}
		Notice.fragments.push(message);
		const words = Array.from(message.childNodes).filter((node) => node.nodeType === 3).map((node) => node.textContent ?? "");
		Notice.messages.push(words.join("").trim());
	}
	hide(): void {
		Notice.hidden += 1;
	}
}

/**
 * The part of a setting definition this stub draws: a `render` row
 * (`obsidian.d.ts` `SettingDefinitionRender`, line 6265). A definition with no
 * `render` gets its row and nothing in it.
 */
interface StubDefinition {
	name: string;
	aliases?: string[];
	searchable?: boolean | (() => boolean);
	render?: (setting: Setting, group: unknown) => void | (() => void);
}

/** One row the stub has drawn, kept so a later render reuses its element. */
interface StubRenderedRow {
	readonly key: string;
	readonly setting: Setting;
	cleanup: (() => void) | null;
}

/**
 * Obsidian 1.13's settings tab, declarative route included, modelled on what
 * the test app's own code does — read 2026-11-04 from `app://obsidian.md/app.js`
 * in the server's test Obsidian 1.15.0 for issue
 * #1266:
 *
 * - `update()` stores `getSettingDefinitions()` in `settingItems`
 *   (`update(){this.settingItems=this.getSettingDefinitions(),…}`);
 * - `display()` renders them. The first render empties the container and
 *   builds one row per definition inside a group; every later render, the
 *   next visit included, calls each row's cleanup and its `render` again on
 *   the same row element, keyed by the definition's name (`cue`'s
 *   `r.length===0&&t.empty()` and `FDe`'s `"name:"+e.name`);
 * - `hide()` does nothing (`hide(){}`).
 *
 * That reading is of minified code, so it is an inference about behaviour; the
 * part the screen depends on most — every row's `render` run again on the same
 * row element, after its cleanup — was driven in
 * `docs/acceptance-shots/issue-1265-drive.txt` § 3. That the rows are kept
 * between visits, rather than the container emptied, is the reading alone.
 *
 * A test's `tab.display()` therefore stands for Obsidian opening the tab, and
 * the stub, unlike Obsidian, asks for the definitions again each time, which
 * the declaration says it does ("Called on every display()", line 6578).
 */
export class PluginSettingTab {
	containerEl = document.createElement("div");
	settingItems: StubDefinition[] = [];
	/** How many times `update()` was called, for a test that says it never is. */
	updates = 0;
	private rendered: StubRenderedRow[] = [];
	constructor(
		public app: App,
		public plugin: Plugin,
	) {}
	getSettingDefinitions(): StubDefinition[] {
		return [];
	}
	update(): void {
		this.updates += 1;
		this.settingItems = this.getSettingDefinitions();
	}
	display(): void {
		this.settingItems = this.getSettingDefinitions();
		if (this.rendered.length === 0) {
			this.containerEl.empty();
			const group = this.containerEl.createDiv({ cls: "setting-group" });
			const items = group.createDiv({ cls: "setting-items" });
			this.rendered = this.settingItems.map((def) => ({ key: `name:${def.name}`, setting: new Setting(items), cleanup: null }));
		}
		for (const def of this.settingItems) {
			const row = this.rendered.find((candidate) => candidate.key === `name:${def.name}`);
			if (row === undefined) throw new Error(`The stub tab has no row for "${def.name}": its definitions changed between renders.`);
			row.cleanup?.();
			row.cleanup = null;
			row.setting.setName(def.name);
			const cleanup = def.render?.(row.setting, null);
			if (typeof cleanup === "function") row.cleanup = cleanup;
		}
	}
	hide(): void {}
}

/* ------------------------------------------------------------------------ */
/* Obsidian's DOM helpers, which it adds to every element at runtime.        */
/* ------------------------------------------------------------------------ */

interface DomInfo {
	cls?: string | string[];
	text?: string;
	attr?: Record<string, string | number | boolean | null>;
	title?: string;
	value?: string;
	type?: string;
	placeholder?: string;
	href?: string;
}

function applyInfo(el: HTMLElement, o?: DomInfo | string): void {
	if (o === undefined) return;
	if (typeof o === "string") {
		el.className = o;
		return;
	}
	if (o.cls !== undefined) el.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
	if (o.text !== undefined) el.textContent = o.text;
	if (o.title !== undefined) el.title = o.title;
	if (o.type !== undefined) el.setAttribute("type", o.type);
	if (o.value !== undefined) el.setAttribute("value", o.value);
	if (o.placeholder !== undefined) el.setAttribute("placeholder", o.placeholder);
	if (o.href !== undefined) el.setAttribute("href", o.href);
	for (const [name, value] of Object.entries(o.attr ?? {})) {
		if (value !== null) el.setAttribute(name, String(value));
	}
}

const domHelpers = {
	createEl(this: HTMLElement, tag: string, o?: DomInfo | string, cb?: (el: HTMLElement) => void) {
		const el = document.createElement(tag);
		applyInfo(el, o);
		this.appendChild(el);
		cb?.(el);
		return el;
	},
	createDiv(this: HTMLElement, o?: DomInfo | string, cb?: (el: HTMLElement) => void) {
		return domHelpers.createEl.call(this, "div", o, cb);
	},
	createSpan(this: HTMLElement, o?: DomInfo | string, cb?: (el: HTMLElement) => void) {
		return domHelpers.createEl.call(this, "span", o, cb);
	},
	empty(this: HTMLElement) {
		while (this.firstChild) this.removeChild(this.firstChild);
	},
	addClass(this: HTMLElement, ...classes: string[]) {
		this.classList.add(...classes);
	},
	removeClass(this: HTMLElement, ...classes: string[]) {
		this.classList.remove(...classes);
	},
	toggleClass(this: HTMLElement, classes: string | string[], value: boolean) {
		for (const cls of Array.isArray(classes) ? classes : [classes]) {
			this.classList.toggle(cls, value);
		}
	},
	setText(this: HTMLElement, text: string) {
		this.textContent = text;
	},
	onClickEvent(this: HTMLElement, listener: (ev: MouseEvent) => unknown) {
		this.addEventListener("click", listener as EventListener);
	},
	/** Obsidian 1.13.7's own, read from the running app: `style.setProperty` per key (`docs/acceptance-shots/issue-1263-drive.txt` § 3). */
	setCssProps(this: HTMLElement, props: Record<string, string>) {
		for (const [name, value] of Object.entries(props)) this.style.setProperty(name, value);
	},
};

Object.assign(HTMLElement.prototype as unknown as Record<string, unknown>, domHelpers);

/**
 * Obsidian's global `createEl` and `createFragment` (`obsidian.d.ts:192`,
 * `:196`): an element made in the main document and attached to nothing, and
 * an empty fragment, each handed to `callback` first — as Obsidian 1.13.7's
 * own are, read from the running app (`docs/acceptance-shots/issue-1263-drive.txt`
 * § 3), attached to the `parent` it is given, as Obsidian's is.
 */
Object.assign(globalThis, {
	createEl(tag: string, o?: (DomInfo & { parent?: Node }) | string, cb?: (el: HTMLElement) => void): HTMLElement {
		const el = document.createElement(tag);
		applyInfo(el, o);
		if (typeof o === "object") o.parent?.appendChild(el);
		cb?.(el);
		return el;
	},
	createFragment(cb?: (fragment: DocumentFragment) => void): DocumentFragment {
		const fragment = document.createDocumentFragment();
		cb?.(fragment);
		return fragment;
	},
});

/**
 * `doc`/`win`: the document and window a node belongs to, or the global ones
 * — real Obsidian puts both on every `Node` (`obsidian.d.ts` lines 68, 72),
 * so code can tell a block drawn in a popout window from one drawn in the
 * main window. A getter, not an assigned value, so it answers for
 * whatever document actually owns the node — including one made with
 * `document.implementation.createHTMLDocument()`, which a popout test stands
 * in for the popout's own document.
 */
Object.defineProperties(Node.prototype, {
	doc: {
		configurable: true,
		get(this: Node): Document {
			return this.ownerDocument ?? document;
		},
	},
	win: {
		configurable: true,
		get(this: Node): Window {
			return (this.ownerDocument?.defaultView as Window | null) ?? window;
		},
	},
});

/* ------------------------------------------------------------------------ */
/* Setting, and the form controls it hands to a callback.                    */
/* ------------------------------------------------------------------------ */

class ValueComponent<T> {
	protected changed?: (value: T) => unknown;
	disabled = false;

	constructor(protected value: T) {}

	getValue(): T {
		return this.value;
	}

	setValue(value: T): this {
		this.value = value;
		return this;
	}

	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		return this;
	}

	onChange(cb: (value: T) => unknown): this {
		this.changed = cb;
		return this;
	}

	/**
	 * What a person typing or clicking does. Tests call this, not `setValue`.
	 *
	 * A disabled control refuses it, as the real one does — the click never
	 * reaches the callback and the value does not move. Without that, the stub
	 * could produce a sequence Obsidian cannot: driving the switch on a row
	 * badged "Not available here" would fire `onChange`, ask the registry to
	 * enable the feature and write to `data.json`. Refusing here is what lets a
	 * test press that switch and prove nothing was stored.
	 *
	 * Every component built on this one inherits the guard, which is intended.
	 */
	change(value: T): unknown {
		if (this.disabled) return undefined;
		this.value = value;
		return this.changed?.(value);
	}
}

export class TextComponent extends ValueComponent<string> {
	placeholder = "";
	/**
	 * The real component's own input element. Present here because masking a
	 * field is done by setting its `type`, and a test has to be able to see
	 * that a link is not sitting on screen in plain sight.
	 */
	readonly inputEl: HTMLInputElement = document.createElement("input");
	constructor() {
		super("");
	}
	/** The box shows what it holds, as the real one does. */
	override setValue(value: string): this {
		super.setValue(value);
		this.inputEl.value = value;
		return this;
	}
	override change(value: string): unknown {
		if (!this.disabled) this.inputEl.value = value;
		return super.change(value);
	}
	setPlaceholder(placeholder: string): this {
		this.placeholder = placeholder;
		return this;
	}
}

export class TextAreaComponent extends TextComponent {}

export class ToggleComponent extends ValueComponent<boolean> {
	constructor() {
		super(false);
	}
}

export class DropdownComponent extends ValueComponent<string> {
	readonly options = new Map<string, string>();
	/**
	 * The real component's own `<select>` element, published at
	 * `obsidian.d.ts:2304`. Present so a feature can listen on it directly —
	 * the route `settingsPanel.ts` uses to catch a choice a `<select>`'s own
	 * `change` event stays silent on: reselecting the option it already shows
	 * fires no `change` at all.
	 */
	readonly selectEl: HTMLSelectElement = document.createElement("select");
	constructor() {
		super("");
	}
	addOption(value: string, display: string): this {
		this.options.set(value, display);
		const option = document.createElement("option");
		option.value = value;
		option.textContent = display;
		this.selectEl.appendChild(option);
		return this;
	}
	addOptions(options: Record<string, string>): this {
		for (const [value, display] of Object.entries(options)) this.addOption(value, display);
		return this;
	}
	override setValue(value: string): this {
		super.setValue(value);
		this.selectEl.value = value;
		return this;
	}
	/**
	 * A real `<select>` fires `change` only when the shown option differs
	 * from the one already selected — picking the same one again fires
	 * nothing. This stub has to refuse it too, or a test calling `change`
	 * with the value already shown could not reproduce that.
	 */
	override change(value: string): unknown {
		if (this.disabled) return undefined;
		const fired = value !== this.value;
		this.value = value;
		this.selectEl.value = value;
		return fired ? this.changed?.(value) : undefined;
	}
}

export class ButtonComponent {
	disabled = false;
	text = "";
	icon = "";
	tooltip = "";
	private clicked?: (event: MouseEvent) => unknown;

	setButtonText(text: string): this {
		this.text = text;
		return this;
	}
	setIcon(icon: string): this {
		this.icon = icon;
		return this;
	}
	setTooltip(tooltip: string): this {
		this.tooltip = tooltip;
		return this;
	}
	setDestructive(): this {
		return this;
	}
	setCta(): this {
		return this;
	}
	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		return this;
	}
	onClick(cb: (event: MouseEvent) => unknown): this {
		this.clicked = cb;
		return this;
	}
	/** What a person pressing the button does. Tests call this. */
	click(): unknown {
		return this.clicked?.(new MouseEvent("click"));
	}
}

export class Setting {
	readonly settingEl: HTMLElement;
	readonly infoEl: HTMLElement;
	readonly nameEl: HTMLElement;
	readonly descEl: HTMLElement;
	readonly controlEl: HTMLElement;
	/** Every control added to this row, in the order they were added. */
	readonly components: unknown[] = [];

	constructor(public containerEl: HTMLElement) {
		settings.push(this);
		this.settingEl = document.createElement("div");
		this.settingEl.className = "setting-item";
		containerEl.appendChild(this.settingEl);

		this.infoEl = document.createElement("div");
		this.infoEl.className = "setting-item-info";
		this.settingEl.appendChild(this.infoEl);

		this.nameEl = document.createElement("div");
		this.nameEl.className = "setting-item-name";
		this.infoEl.appendChild(this.nameEl);

		this.descEl = document.createElement("div");
		this.descEl.className = "setting-item-description";
		this.infoEl.appendChild(this.descEl);

		this.controlEl = document.createElement("div");
		this.controlEl.className = "setting-item-control";
		this.settingEl.appendChild(this.controlEl);
	}

	setName(name: string): this {
		this.nameEl.textContent = name;
		return this;
	}

	setDesc(desc: string): this {
		this.descEl.textContent = desc;
		return this;
	}

	setHeading(): this {
		this.settingEl.classList.add("setting-item-heading");
		return this;
	}

	setClass(cls: string): this {
		this.settingEl.classList.add(cls);
		return this;
	}

	addText(cb: (component: TextComponent) => unknown): this {
		return this.add(new TextComponent(), cb);
	}

	addTextArea(cb: (component: TextAreaComponent) => unknown): this {
		return this.add(new TextAreaComponent(), cb);
	}

	addToggle(cb: (component: ToggleComponent) => unknown): this {
		return this.add(new ToggleComponent(), cb);
	}

	addDropdown(cb: (component: DropdownComponent) => unknown): this {
		return this.add(new DropdownComponent(), cb);
	}

	addButton(cb: (component: ButtonComponent) => unknown): this {
		return this.add(new ButtonComponent(), cb);
	}

	/**
	 * A control with an element of its own — a text box's `inputEl`, a
	 * dropdown's `selectEl` — has it put in the row's control area, where
	 * Obsidian draws it, so a test can focus it and read the caret.
	 */
	private add<T>(component: T, cb: (component: T) => unknown): this {
		this.components.push(component);
		const own = component as { inputEl?: HTMLElement; selectEl?: HTMLElement };
		const el = own.inputEl ?? own.selectEl;
		if (el !== undefined) this.controlEl.appendChild(el);
		cb(component);
		return this;
	}
}

/** Every Setting made since the last reset, in the order they were made. */
const settings: Setting[] = [];

/** Empties that list. Call it in `beforeEach`, or one test sees another's rows. */
export function resetSettings(): void {
	settings.length = 0;
}

/**
 * Every control drawn under `root`, keyed by its row's name, so a test can
 * drive the settings screen the way a person does — type in the box, click the
 * switch — rather than reaching inside the tab.
 */
export function controlsUnder(root: HTMLElement): Map<string, unknown[]> {
	const rows = new Map<string, unknown[]>();
	for (const setting of settings) {
		if (root.contains(setting.settingEl)) {
			rows.set(setting.nameEl.textContent ?? "", setting.components);
		}
	}
	return rows;
}

/* ------------------------------------------------------------------------ */
/* The app's display language, and its own locale-aware `moment`.           */
/* ------------------------------------------------------------------------ */

/**
 * The four calendar-name arrays one locale holds — what a `Locale`'s own `months()` and its three siblings answer.
 *
 * A language whose months have two forms (Russian, Polish, Catalan) also gives
 * `monthsInDate` and `monthsShortInDate`, the form moment writes for a month
 * inside a date; left out, the language has one form and `months(m, format)`
 * answers the same word for every format.
 */
export interface LocaleNames {
	months: string[];
	monthsShort: string[];
	weekdays: string[];
	weekdaysShort: string[];
	monthsInDate?: string[];
	monthsShortInDate?: string[];
	/**
	 * A locale's own rule for which formats get the in-date full month, in
	 * place of moment's default (`node_modules/moment/moment.js:963`) — what
	 * `ca` carries as `months.isFormat`. It is read for `months` only:
	 * `monthsShort` always uses the default (`moment.js:991`).
	 */
	monthsIsFormat?: RegExp;
}

/** The English names `datePattern.ts`'s own `ENGLISH_NAMES` held before issue #645, so `"en"` needs no test to register it. */
const ENGLISH_LOCALE: LocaleNames = {
	months: [
		"January",
		"February",
		"March",
		"April",
		"May",
		"June",
		"July",
		"August",
		"September",
		"October",
		"November",
		"December",
	],
	monthsShort: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
	weekdays: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
	weekdaysShort: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
};

/**
 * What a `Locale`'s month readers ask of the moment they are handed: its
 * month. Real moment's `localeMonths` reads nothing else of it
 * (`node_modules/moment/moment.js:972-978`).
 */
export interface MockMoment {
	month(): number;
}

/**
 * The stand-in for one of real moment's `Locale` objects
 * (`node_modules/moment/moment.d.ts:24`): the four calendar-name readers
 * called with no argument — the standalone lists — and the month readers
 * called with a moment and a format, which answer the in-date form where the
 * language has one.
 */
export interface MockLocale {
	months(): string[];
	months(m: MockMoment, format?: string): string;
	monthsShort(): string[];
	monthsShort(m: MockMoment, format?: string): string;
	weekdays(): string[];
	weekdaysShort(): string[];
}

/**
 * Real moment's `MONTHS_IN_FORMAT` (`node_modules/moment/moment.js:963`): a
 * day token, then whitespace or a bracketed literal, then `MMM` or `MMMM`.
 */
const MONTHS_IN_FORMAT = /D[oD]?(\[[^\[\]]*\]|\s)+MMMM?/;

function localeObject(names: LocaleNames): MockLocale {
	// Real moment's `localeMonths` and `localeMonthsShort`
	// (`moment.js:972-994`): with no moment, the standalone list; with one, the
	// word for its month, in the in-date list when the format string matches
	// the rule and the language has two forms. `monthsShort` never reads a
	// locale's own rule.
	const monthReader = (
		standalone: string[],
		inDate: string[] | undefined,
		rule: RegExp,
	): MockLocale["months"] =>
		((m?: MockMoment, format?: string) => {
			if (m === undefined) return standalone;
			const list = inDate !== undefined && rule.test(format ?? "") ? inDate : standalone;
			return list[m.month()];
		}) as MockLocale["months"];
	return {
		months: monthReader(names.months, names.monthsInDate, names.monthsIsFormat ?? MONTHS_IN_FORMAT),
		monthsShort: monthReader(names.monthsShort, names.monthsShortInDate, MONTHS_IN_FORMAT),
		weekdays: () => names.weekdays,
		weekdaysShort: () => names.weekdaysShort,
	};
}

/**
 * Every registered locale, one object each, built when it is registered and
 * kept until it is registered again or reset: real moment's `localeData`
 * hands back the same `Locale` object for the same code every time, and
 * `vaultLayout.ts` tells a recognised code from moment's fallback by that
 * identity.
 */
const locales = new Map<string, MockLocale>([["en", localeObject(ENGLISH_LOCALE)]]);
let activeLocale = "en";
let displayLanguage = "en";

/**
 * For a test: gives the stub's {@link moment} a locale it did not hold
 * before, or replaces one it did. Real moment's own locale files are not
 * read here — a suite says exactly the words it is checking against, rather
 * than depending on what moment's locale for a language holds this week.
 */
export function registerLocale(code: string, names: LocaleNames): void {
	locales.set(code, localeObject(names));
}

/** For a test: what {@link getLanguage} answers from here on. Does not by itself change {@link moment}'s own active locale — Obsidian keeps the two in step; a suite proving that does the same, through `moment.locale`. */
export function setLanguage(code: string): void {
	displayLanguage = code;
}

/** Puts the language and every registered locale back to just `"en"`. Call it in `beforeEach`. */
export function resetLanguage(): void {
	locales.clear();
	locales.set("en", localeObject(ENGLISH_LOCALE));
	activeLocale = "en";
	displayLanguage = "en";
}

/** Obsidian's own: the app's current display language (`obsidian.d.ts:3365`). */
export function getLanguage(): string {
	return displayLanguage;
}

/**
 * The key a locale is registered and looked up under, matched to real
 * moment's own `normalizeLocale` (`node_modules/moment/moment.js:2044-2046`):
 * lower-cased, and its first `_` (only the first — `String.replace` with a
 * string needle is not global) turned into `-`. Without this, asking the
 * mock for `"pt-BR"` never matched a locale registered as `"pt-br"`.
 */
function normalizeLocaleKey(key: string): string {
	return key.toLowerCase().replace("_", "-");
}

/**
 * The registered key `normalized` resolves to, or `null` when nothing does —
 * matched to real moment's own `chooseLocale`
 * (`node_modules/moment/moment.js:2051-2081`): an exact match first, and
 * failing that, one step back to the part before the first `-` (`"de-xx"`
 * falls back to `"de"` when only `"de"` is registered). Real moment tries
 * every shorter prefix in turn; this mock's fixtures never register a locale
 * three segments deep, so one step back is the whole of what a test here can
 * exercise.
 */
function resolveLocale(normalized: string): string | null {
	if (locales.has(normalized)) return normalized;
	const dash = normalized.indexOf("-");
	if (dash > 0) {
		const prefix = normalized.slice(0, dash);
		if (locales.has(prefix)) return prefix;
	}
	return null;
}

/**
 * A stand-in for Obsidian's own locale-aware `moment` (`obsidian.d.ts:4561`),
 * reduced to the locale switch and the per-locale table `vaultLayout.ts`
 * calls. Real moment's global `months()` and its three siblings are left
 * out on purpose: `vaultLayout.ts` stopped calling them, and a
 * call to them here now throws rather than quietly answering. `locale` is
 * written the way real moment's own
 * `getSetGlobalLocale` behaves, read off this repository's own
 * `node_modules/moment/moment.js:2116-2139`: the key is normalised and
 * resolved the way {@link resolveLocale} says before it is looked up, and
 * asking for a locale nothing resolves to leaves the active one unchanged and
 * hands back whichever that still is, rather than forcing English.
 */
export const moment = {
	locale(language?: string): string {
		if (language !== undefined) {
			const resolved = resolveLocale(normalizeLocaleKey(language));
			if (resolved !== null) activeLocale = resolved;
		}
		return activeLocale;
	},
	/**
	 * Real moment's `localeData`, which is its `getLocale`
	 * (`node_modules/moment/moment.js:2241-2262`): the `Locale` a code
	 * resolves to, normalised and with the one-step region fallback
	 * {@link resolveLocale} copies; the active locale's own object when called
	 * with no code, or with one nothing resolves to — real moment's
	 * `chooseLocale` ends in the global locale (`moment.js:2080`).
	 * Never changes the active locale.
	 */
	localeData(language?: string): MockLocale {
		const resolved = language === undefined ? null : resolveLocale(normalizeLocaleKey(language));
		const object = locales.get(resolved ?? activeLocale);
		if (object === undefined) throw new Error(`mock moment: no locale object for "${resolved ?? activeLocale}"`);
		return object;
	},
};

/**
 * Obsidian's own path tidier, written the way the app writes it: slashes of
 * either kind collapse to one forward slash, leading and trailing slashes go,
 * the two non-breaking spaces become ordinary ones, and the result is composed
 * (NFC) so that a typed "å" and a decomposed "å" name the same file.
 *
 * A faithful copy rather than a shortcut, because code under test calls this on
 * every vault path a person typed into the settings screen; a laxer stub would
 * let a path through that the real app would have rejected.
 */
export function normalizePath(path: string): string {
	const tidy = path
		.replace(/([\\/])+/g, "/")
		.replace(/(^\/+|\/+$)/g, "")
		.replace(/\u00A0|\u202F/g, " ")
		.normalize("NFC");
	return tidy === "" ? "/" : tidy;
}

/* ------------------------------------------------------------------------ */
/* Obsidian's own HTTP helper.                                              */
/* ------------------------------------------------------------------------ */

/**
 * The sanctioned way a plugin reaches the network — it goes through the app
 * rather than through the page, so there is no CORS to fall foul of.
 *
 * The stub answers from `requestUrlReplies` and records every address it was
 * given, which is how a test proves a link was fetched through Obsidian rather
 * than through a direct `fetch`. An address nobody has prepared a reply for is
 * a thrown error, not an empty answer: a test that forgot to set one up should
 * fail loudly rather than look like a calendar with no events in it.
 */
export const requestedUrls: string[] = [];

/** What `requestUrl` answers, keyed by address. Fill it in the test. */
export const requestUrlReplies = new Map<string, { status: number; text: string }>();

/** Empties both. Call it in `beforeEach`, or one test answers another's request. */
export function resetRequests(): void {
	requestedUrls.length = 0;
	requestUrlReplies.clear();
}

export function requestUrl(request: { url: string } | string): Promise<{
	status: number;
	text: string;
}> {
	const url = typeof request === "string" ? request : request.url;
	requestedUrls.push(url);
	const reply = requestUrlReplies.get(url);
	if (reply === undefined) {
		return Promise.reject(new Error(`No reply was prepared for ${url}.`));
	}
	return Promise.resolve(reply);
}

// ─── Opening and creating a note ───
//
// What the day view needs to open a meeting's note, raise its page preview,
// and create the note where Obsidian puts new ones. Kept in this one block,
// added to the classes above by declaration merging rather than by editing
// them, because #629 is changing the metadata cache in the same wave.
//
// `openLinkText` and `trigger` do nothing here: a test that wants to see them
// called spies on them, which is also how it sees their order against a
// write.

/**
 * Obsidian's: splits a wikilink's inside text into the note it names and any
 * `#heading` or `#^block` part, held together as one subpath. Splits at the
 * first `#`, which is also where a block reference's own `^` sits. Mirrors
 * the published contract's description; a TestVault drive is what would
 * confirm it against the running app (Ticket #654, folded from #666).
 */
export function parseLinktext(linktext: string): { path: string; subpath: string } {
	const index = linktext.indexOf("#");
	if (index === -1) return { path: linktext, subpath: "" };
	return { path: linktext.slice(0, index), subpath: linktext.slice(index) };
}

/** Obsidian's: the note path alone, `parseLinktext(linktext).path`. */
export function getLinkpath(linktext: string): string {
	return parseLinktext(linktext).path;
}

export interface Workspace {
	/** Obsidian's: opens `linktext` resolved from `sourcePath`, in the pane `newLeaf` names. A no-op here. */
	openLinkText(linktext: string, sourcePath: string, newLeaf?: "tab" | "split" | "window" | boolean): Promise<void>;
	/** Obsidian's `Events.trigger`, with data — how a `hover-link` reaches Page preview. A no-op here. */
	trigger(name: string, ...data: unknown[]): void;
	/**
	 * Obsidian's: a leaf to open a known note in, one for the caller to call
	 * `openFile` on. When `newLeaf` asks for the current pane and
	 * a leaf in {@link Workspace.leaves} holds {@link Workspace.activeView},
	 * that leaf is handed back and its `openFile` really replaces its own view
	 * — ticket #959, so a test can tell which pane a fallback open landed in,
	 * the log's own or another's. Otherwise this hands back the same
	 * unconnected stub leaf whatever `newLeaf` asks for, as before; a test that
	 * wants to see that stub's `openFile` called spies on it, the same way as
	 * `openLinkText`.
	 */
	getLeaf(newLeaf?: "tab" | "split" | "window" | boolean): OpenableLeaf;
}

/** What `getLeaf` hands back — Obsidian's own `WorkspaceLeaf.openFile`. */
export interface OpenableLeaf {
	openFile(file: TFile): Promise<void>;
}

Workspace.prototype.openLinkText = async function (): Promise<void> {};
Workspace.prototype.trigger = function (): void {};

const workspaceLeaves = new WeakMap<Workspace, OpenableLeaf>();

/** A working, empty editor for a note `openFile` has just swapped in — nothing here was ever asked for a real fixture's text. */
function emptyOpenedEditor(): ViewEditor {
	let cursor: EditorPosition = { line: -1, ch: -1 };
	return {
		getValue: (): string => "",
		getLine: (): string => "",
		getCursor: (): EditorPosition => cursor,
		setCursor: (pos: EditorPosition): void => {
			cursor = pos;
		},
	};
}

Workspace.prototype.getLeaf = function (this: Workspace, newLeaf?: "tab" | "split" | "window" | boolean): OpenableLeaf {
	if (!newLeaf) {
		const active = this.leaves.find((candidate) => candidate.view === this.activeView);
		if (active !== undefined) {
			const workspace = this;
			return {
				openFile: async (file: TFile): Promise<void> => {
					const view = new MarkdownView(file, "", "source");
					view.editor = emptyOpenedEditor();
					view.leaf = active;
					active.view = view;
					workspace.activeView = view;
				},
			};
		}
	}
	let leaf = workspaceLeaves.get(this);
	if (leaf === undefined) {
		leaf = { openFile: async (): Promise<void> => {} };
		workspaceLeaves.set(this, leaf);
	}
	return leaf;
};

export interface MetadataCache {
	/**
	 * Obsidian's: the note a link names, or `null` when it names none. Answered
	 * from the notes the cache has parsed — `caches`' paths — as Obsidian's is
	 * answered from its own index, so a test says a note exists for a link by
	 * giving it a cache entry. A link names a note by its whole path without
	 * `.md`, or by its name alone wherever it sits.
	 */
	getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null;
}

MetadataCache.prototype.getFirstLinkpathDest = function (this: MetadataCache, linkpath: string): TFile | null {
	for (const path of this.caches.keys()) {
		if (path === `${linkpath}.md` || path.endsWith(`/${linkpath}.md`)) return { path };
	}
	return null;
};

/**
 * Obsidian's file manager, reduced to where a new note goes and to renaming.
 *
 * Built with the `Vault` it belongs to, so `renameFile` can find and rewrite
 * the other notes a rename touches — the real `App` gives every plugin the
 * one `fileManager` for its one `vault`, and the two were never going to
 * disagree about which vault they mean.
 */
export class FileManager {
	constructor(private readonly vault: Vault) {}

	/** The folder `getNewFileParent` answers — Obsidian's "Default location for new notes". `/` is the vault's root, as Obsidian names it. */
	newFileFolder = "/";

	getNewFileParent(_sourcePath: string, _newFilePath?: string): { path: string } {
		return { path: this.newFileFolder };
	}

	/** The person's "Use [[Wikilinks]]" setting, off: `generateMarkdownLink` writes `[name](path.md)`. A test sets it; the real value is `getConfig("useMarkdownLinks")`. */
	useMarkdownLinks = false;

	/** The person's "New link format" setting, `getConfig("newLinkFormat")`. */
	newLinkFormat: "shortest" | "relative" | "absolute" = "shortest";

	/**
	 * Obsidian's `FileManager.generateMarkdownLink` (`obsidian.d.ts:2931`), over the
	 * notes `vault.files` lists now, in the format the two settings above say: a
	 * wikilink or a markdown link (`.md` on, spaces written `%20`), its path the note's
	 * name alone while no other note has it and its whole path once another does
	 * ("shortest" — the real rule is Obsidian's own and only this much of it is
	 * emulated), always the whole path ("absolute"), or reached from the folder of
	 * `sourcePath` ("relative", `../Ideas/Garden shed`). `subpath` and `alias` are not
	 * emulated. The real function's output is what `docs/acceptance-shots/issue-896-link-shapes.txt`
	 * and `issue-871-frozen-link.txt` read back.
	 */
	generateMarkdownLink(file: { path: string }, sourcePath: string): string {
		const stem = (path: string): string => path.replace(/\.md$/u, "");
		const name = stem(file.path.slice(file.path.lastIndexOf("/") + 1));
		let path: string;
		if (this.newLinkFormat === "absolute") {
			path = stem(file.path);
		} else if (this.newLinkFormat === "relative") {
			const from = sourcePath.split("/").slice(0, -1);
			const to = stem(file.path).split("/");
			let shared = 0;
			while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared += 1;
			path = [...from.slice(shared).map(() => ".."), ...to.slice(shared)].join("/");
		} else {
			const sameName = this.vault.files.filter((each) => stem(each.path) === name || stem(each.path).endsWith(`/${name}`));
			path = sameName.length > 1 ? stem(file.path) : name;
		}
		if (!this.useMarkdownLinks) return `[[${path}]]`;
		return `[${name}](${path.split("/").map(encodeURIComponent).join("/")}.md)`;
	}

	/**
	 * Moves `file` to `newPath` and rewrites the wikilinks in every other note
	 * this suite lets be read — the one difference from `Vault.rename` that
	 * `noteWriter.ts` relies on (`node_modules/obsidian/obsidian.d.ts:2902`
	 * against `:7452`). It always rewrites them, as Obsidian does only while
	 * the person's "Automatically update internal links" setting is on
	 * (`obsidian.d.ts:2896`, "depending on the user's preferences"); the
	 * setting itself is not simulated.
	 *
	 * Simulates only what the writer's own tests need: a bare `[[Name]]` or
	 * `[[Name|alias]]` link naming the old note by its filename without the
	 * folder or the `.md`, the way `getFirstLinkpathDest` above already
	 * resolves one. It does not simulate a link by full path, a link inside a
	 * fenced block, an embed, or any format besides a wikilink — a suite
	 * needing one of those has to extend this, not assume it already works.
	 */
	async renameFile(file: TFile, newPath: string): Promise<void> {
		await Promise.resolve();
		const oldPath = file.path;
		const contents = this.vault.readableContents();
		if (contents !== null) {
			const oldName = basenameWithoutExtension(oldPath);
			const newName = basenameWithoutExtension(newPath);
			for (const [path, text] of contents) {
				if (path === oldPath) continue;
				contents.set(path, rewriteWikilinksTo(text, oldName, newName));
			}
			const body = contents.get(oldPath);
			if (body !== undefined) {
				contents.delete(oldPath);
				contents.set(newPath, body);
			}
		}
		file.path = newPath;
	}
}

function basenameWithoutExtension(path: string): string {
	const slash = path.lastIndexOf("/");
	const name = slash >= 0 ? path.slice(slash + 1) : path;
	return name.endsWith(".md") ? name.slice(0, -".md".length) : name;
}

/** Rewrites a `[[oldName]]` or `[[oldName|alias]]` wikilink target to `newName`. */
function rewriteWikilinksTo(text: string, oldName: string, newName: string): string {
	const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`\\[\\[${escaped}(\\|[^\\]]*)?\\]\\]`, "g");
	return text.replace(pattern, (_match, alias: string | undefined) => `[[${newName}${alias ?? ""}]]`);
}

export interface App {
	/** One per app, made the first time it is asked for. */
	readonly fileManager: FileManager;
}

const fileManagers = new WeakMap<App, FileManager>();

Object.defineProperty(App.prototype, "fileManager", {
	get(this: App): FileManager {
		let manager = fileManagers.get(this);
		if (manager === undefined) {
			manager = new FileManager(this.vault);
			fileManagers.set(this, manager);
		}
		return manager;
	},
});

/** One entry of a {@link Menu}, holding what the caller set on it. */
export class MenuItem {
	title = "";
	icon: string | null = null;
	private clicked: (() => unknown) | null = null;

	setTitle(title: string): this {
		this.title = title;
		return this;
	}

	setIcon(icon: string | null): this {
		this.icon = icon;
		return this;
	}

	onClick(callback: () => unknown): this {
		this.clicked = callback;
		return this;
	}

	/** Stub only: what choosing the entry does. */
	click(): void {
		this.clicked?.();
	}
}

/**
 * Obsidian's context menu (`node_modules/obsidian/obsidian.d.ts:4245`), reduced
 * to `addItem`, which builds an item and hands it to the caller. Stub only:
 * `items` reads back what was added.
 */
export class Menu {
	readonly items: MenuItem[] = [];

	addItem(cb: (item: MenuItem) => unknown): this {
		const item = new MenuItem();
		cb(item);
		this.items.push(item);
		return this;
	}
}
