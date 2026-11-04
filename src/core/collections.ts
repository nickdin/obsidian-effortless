/**
 * Which notes in the vault are collections, and how many open tasks each holds.
 *
 * A note is a collection when it carries the configured tasks heading, and for
 * no other reason — not its folder, not its tags, anywhere in the vault
 * (ADR 0003, issue #29). The
 * heading has to exist anyway, because it is where the tasks are written, so a
 * collection declares itself by being written like one.
 *
 * The answer comes from Obsidian's own index and never from a file. Every
 * note's headings and every checkbox's state are already parsed and in memory,
 * so a rule that covers the whole vault costs no reading at all. That is what
 * replaces the plugin being carried across, which re-read every note under
 * every root folder each time the person left the day's log.
 *
 * A permissive rule is only safe while it is visible. Old notes already
 * carrying that heading become collections, which the author accepted as a
 * cleaning job — but only because the settings screen lists what was found.
 * `collectionsSection.ts` draws that list.
 */

import { normalizePath } from "obsidian";
import type { CachedMetadata, HeadingCache, ListItemCache, Plugin, TFile } from "obsidian";
import type { VaultLayout } from "./settings";
import { checkboxMeaning } from "./taskLine";
import { isDailyLogPath } from "./vaultLayout";

/** One note that counts as a collection, and what the index knows about it. */
export interface Collection {
	/** The note's vault path, exactly as Obsidian holds it. */
	path: string;
	/** The note's name, without its folder or its `.md`. What a person sees. */
	name: string;
	/**
	 * The line the tasks heading sits on, counted from zero. Serves the same
	 * need as `headingLevel` below: code that writes the completed-tasks
	 * heading into a collection has to put it beneath the tasks heading and
	 * its tasks, so
	 * it needs the line to count from.
	 *
	 * Obsidian's metadata cache is the only route to that line. The
	 * content-side pair — `sectionRange` in `vaultLayout.ts`, and the
	 * `headingRange` in `markdownSections.ts` that it calls — match a heading
	 * at an exact level, and a collection's tasks heading is matched with its
	 * level ignored, so no
	 * amount of content finds it.
	 */
	headingLine: number;
	/**
	 * The level that heading is written at *in this note*. The level is ignored
	 * when deciding whether the note counts, so it is not a setting — but code
	 * that writes the completed-tasks heading beneath it needs the size this
	 * particular collection uses.
	 */
	headingLevel: number;
	/** How many unticked tasks sit under the tasks heading. */
	openTasks: number;
	/**
	 * How many done or cancelled tasks sit under the tasks heading, counted in
	 * the same read as `openTasks`. The startup sweep takes a collection when
	 * either number is above zero: a finished recurring line is owed its next
	 * round whether or not an open task sits beside it.
	 *
	 * Optional so a collection built by hand without it reads as none; the
	 * index always fills it.
	 */
	finishedTasks?: number;
}

/**
 * The part of Obsidian the index reads: which notes exist, what the app has
 * already parsed for each of them, and a way to be told when either changes.
 *
 * A port rather than the app itself, so the rules can be driven from a fake
 * index in a test — and so that nothing here can reach a method that opens a
 * file even by mistake.
 */
export interface NoteCaches {
	/** Every Markdown note in the vault, by vault path. */
	paths(): string[];
	/** What Obsidian has already parsed for that note, or `null` if nothing yet. */
	cache(path: string): CachedMetadata | null;
	/** Called whenever something may have changed which notes are collections. */
	onChange(listener: () => void): void;
	/**
	 * Called on a vault rename, with the file at its new path and the path it
	 * had before. Shares the one `vault.on("rename")` subscription `onChange`
	 * already gets — see {@link noteCachesFrom} — so a second listener here
	 * costs no second subscription (issue
	 * #803, `main.test.ts`
	 * "builds one collections index").
	 */
	onRename(listener: (file: TFile, oldPath: string) => void): void;
	/** The vault file at that path, or `null` when none is there. */
	fileAt(path: string): TFile | null;
	/**
	 * Every note that currently shows a resolved link to `path`, from
	 * Obsidian's own link index rather than a file read —
	 * `metadataCache.resolvedLinks`
	 * (`node_modules/obsidian/obsidian.d.ts:4438`), which maps a source path to
	 * every target it resolves to. Answered with no file opened, the way
	 * everything else this port offers is.
	 */
	linkedFrom(path: string): string[];
}

/**
 * The real Obsidian one, wired to the plugin so every subscription comes off
 * again when it unloads.
 *
 * **Three events, not one.** Obsidian's own documentation says the metadata
 * cache's `changed` event is not fired for a rename, for performance, and that
 * the vault's rename event has to be hooked for those
 * (`node_modules/obsidian/obsidian.d.ts`, `MetadataCache.on('changed')`).
 * Hooking only the first leaves a renamed collection listed under its old name
 * until something unrelated happens to it.
 *
 * **Deletion is the same gap again**, and Obsidian offers two hooks for it:
 * the vault's `delete` and the metadata cache's `deleted`. The vault's is the
 * one taken, because the vault is where this index gets its list of notes from
 * in the first place — `getMarkdownFiles` above — so it is the vault's answer
 * that has moved. It also fires for a note Obsidian never managed to parse,
 * where the cache's own event can only offer a best-effort previous cache
 * (`MetadataCache.on('deleted')`). Keeping it beside the rename hook puts both
 * of the vault's invalidating events on the same object.
 */
export function noteCachesFrom(plugin: Plugin): NoteCaches {
	const { app } = plugin;
	// One list per event, so a second caller of `onChange` or the first caller
	// of `onRename` adds a listener rather than a second `registerEvent` —
	// `collections.test.ts` "puts every subscription through registerEvent, so
	// all three come off at unload" pins the count at three, whatever consumers
	// this port gets.
	const changeListeners: Array<() => void> = [];
	const renameListeners: Array<(file: TFile, oldPath: string) => void> = [];
	const fireChange = (): void => {
		for (const listener of changeListeners) listener();
	};
	plugin.registerEvent(app.metadataCache.on("changed", fireChange));
	plugin.registerEvent(
		app.vault.on("rename", (file, oldPath) => {
			fireChange();
			// Obsidian's own event names a `TAbstractFile`, a folder included, and
			// this suite's own "notices a collection being renamed" test fires it
			// with neither argument at all — so `onRename`'s listeners, typed to a
			// note, are told only about one, never a folder or a missing argument.
			if (isNoteFile(file)) for (const listener of renameListeners) listener(file, oldPath);
		}),
	);
	plugin.registerEvent(app.vault.on("delete", fireChange));
	return {
		paths: () => app.vault.getMarkdownFiles().map((file: TFile) => file.path),
		cache: (path) => app.metadataCache.getCache(path),
		onChange: (listener) => changeListeners.push(listener),
		onRename: (listener) => renameListeners.push(listener),
		fileAt: (path) => app.vault.getMarkdownFiles().find((file: TFile) => file.path === path) ?? null,
		linkedFrom: (path) => {
			const links = app.metadataCache.resolvedLinks;
			return Object.keys(links).filter((source) => (links[source]?.[path] ?? 0) > 0);
		},
	};
}

/**
 * Whether a vault rename's own argument is a Markdown note rather than a
 * folder — Obsidian's `TFolder` carries `children`, a note never does — or
 * whether it is missing altogether, which the test stub of the vault lets a test do.
 */
function isNoteFile(file: unknown): file is TFile {
	return (
		file !== null &&
		typeof file === "object" &&
		!("children" in file) &&
		"path" in file &&
		typeof file.path === "string" &&
		file.path.toLowerCase().endsWith(".md")
	);
}

/**
 * What a feature is allowed to know about the vault's collections.
 *
 * Both answers are already worked out and held, so either is cheap enough for
 * a settings-screen draw or a readiness check, and neither opens a file.
 *
 * An interface rather than the index itself, for the reason `Calendar` is one
 * (`calendarSources.ts`): how the index is built is none of a feature's
 * business. The note-cache port beneath it, the layout it keeps asking for and
 * when it throws its answer away are all constructor surface a feature would
 * otherwise see — and a feature's own test would have to build a real index
 * where two lines of object literal say everything the feature reads.
 */
export interface Collections {
	/** Every collection in the vault, in path order. Read-only; see the class. */
	all(): readonly Collection[];
	/**
	 * The collection at that path, or `null` when the note is not one.
	 *
	 * Here because spec #32
	 * § 9 exposes the index to features through the host, and two of them —
	 * keeping a task consistent, and filing one — hold a collection's path
	 * and nothing else. Asking `all()` and searching it is that lookup
	 * written out at every call site.
	 */
	at(path: string): Collection | null;
}

/**
 * The vault's collections, worked out once and worked out again when the vault
 * or the settings say the answer may have moved.
 *
 * Features reach this through the host rather than through each other: two of
 * them need it — keeping a task consistent, and filing one — and a feature may
 * never reference another feature (`feature.ts`).
 */
export class CollectionsIndex implements Collections {
	private cached: Collection[] | null = null;
	/**
	 * The settings the cached answer was worked out from, as a string.
	 *
	 * Compared by what it says rather than by which object it is, so the answer
	 * follows an edited tasks heading whether the settings store hands back the
	 * same object every time or a fresh one. Tying the memory to object identity
	 * would have made a caller's private habit load-bearing.
	 */
	private cachedFrom: string | null = null;

	constructor(
		private readonly notes: NoteCaches,
		private readonly layout: () => VaultLayout,
	) {
		notes.onChange(() => {
			this.cached = null;
		});
	}

	/**
	 * Every collection in the vault, in path order.
	 *
	 * Read-only, and that is load-bearing rather than decoration: what comes
	 * back *is* the cached array, so a caller sorting or shortening it in place
	 * would re-order or truncate the answer every later caller gets, until the
	 * next vault event. The type holds the rule so no caller has to remember it.
	 * A caller that genuinely needs a mutable list makes its own with a spread.
	 */
	all(): readonly Collection[] {
		const layout = this.layout();
		const from = signature(layout);
		if (this.cached !== null && this.cachedFrom === from) return this.cached;

		const found: Collection[] = [];
		for (const path of this.notes.paths()) {
			const collection = collectionIn(path, this.notes.cache(path), layout);
			if (collection !== null) found.push(collection);
		}
		found.sort((a, b) => a.path.localeCompare(b.path));

		this.cached = found;
		this.cachedFrom = from;
		return found;
	}

	/** The collection at that path, or `null` when the note is not one. */
	at(path: string): Collection | null {
		const wanted = normalizePath(path);
		return this.all().find((collection) => normalizePath(collection.path) === wanted) ?? null;
	}
}

/**
 * The settings that decide the answer, in one comparable string. A layout that
 * differs anywhere else — a calendar column renamed, say — leaves the list of
 * collections alone and must not throw the worked-out answer away.
 */
function signature(layout: VaultLayout): string {
	return JSON.stringify([
		layout.tasksHeading,
		layout.dailyLogFolder,
		layout.dailyLogFilename,
		layout.excludedFolders,
	]);
}

/**
 * Whether that note is a collection, and what the index knows about it if so.
 *
 * Pure over what Obsidian has already parsed, so every rule below can be
 * checked without an app, a vault or a file.
 */
export function collectionIn(
	path: string,
	cache: CachedMetadata | null,
	layout: VaultLayout,
): Collection | null {
	const wanted = layout.tasksHeading.trim().toLowerCase();
	// A blank setting marks nothing. Left unguarded it would match a note whose
	// heading line is a bare `##`, so emptying the box would start finding
	// collections instead of none.
	if (wanted === "") return null;
	if (cache === null) return null;
	// The day's log is a mirror of what the collections say, so it is never one
	// itself — however the heading happens to be written in it.
	if (isDailyLogPath(path, layout)) return null;
	if (isExcluded(path, layout.excludedFolders)) return null;

	const headings = cache.headings ?? [];
	// The first one wins. A note carrying the heading twice is one collection,
	// and the first one is the range the plugin reads.
	const heading = headings.find((found) => found.heading.trim().toLowerCase() === wanted);
	if (heading === undefined) return null;

	const line = heading.position.start.line;
	const counts = countTasks(cache.listItems ?? [], line, headingEnd(headings, heading));
	return {
		path,
		name: noteName(path),
		headingLine: line,
		headingLevel: heading.level,
		openTasks: counts.open,
		finishedTasks: counts.finished,
	};
}

/**
 * The line the tasks heading's range stops at: the next heading of the same
 * size or larger. A smaller heading is a part of that range rather than the end
 * of it, so a collection may sort its tasks under sub-headings.
 *
 * Not a section: a section is a levelled day's-log heading, and the tasks
 * heading carries no level (issue #85, GLOSSARY.md **The tasks heading**).
 */
function headingEnd(headings: HeadingCache[], heading: HeadingCache): number {
	const from = heading.position.start.line;
	let end = Number.POSITIVE_INFINITY;
	for (const found of headings) {
		const line = found.position.start.line;
		if (line > from && found.level <= heading.level && line < end) end = line;
	}
	return end;
}

/**
 * How many unticked and how many finished tasks sit between those two lines.
 *
 * Obsidian records the checkbox character itself, and documents the space as
 * the one that means unfinished. A list item that is not a task at all carries
 * no character. Finished is what {@link checkboxMeaning} in `taskLine.ts`
 * calls done or cancelled; a copied, forwarded or custom-marked task is
 * neither open nor finished here.
 */
function countTasks(items: ListItemCache[], from: number, to: number): { open: number; finished: number } {
	let open = 0;
	let finished = 0;
	for (const item of items) {
		const line = item.position.start.line;
		if (line <= from || line >= to) continue;
		if (item.task === undefined) continue;
		// Open is the space alone: `checkboxMeaning` also calls a custom
		// character open, and such a task is counted on neither side.
		if (item.task === " ") {
			open += 1;
			continue;
		}
		const meaning = checkboxMeaning(item.task);
		if (meaning === "done" || meaning === "cancelled") finished += 1;
	}
	return { open, finished };
}

/**
 * Whether the note sits under one of the folders the person has excluded.
 *
 * The list exists for templates: a template is meant to be copied, so a stray
 * one would be a permanent wrong entry rather than a one-time cleanup. Matching
 * is on whole folder names, so `Templatesque` is not under `Templates`.
 *
 * Exported for the migration chooser, which offers only notes the index could
 * ever call a collection.
 */
export function isExcluded(path: string, folders: string[]): boolean {
	const full = normalizePath(path);
	return folders.some((raw) => {
		const folder = normalizePath(raw.trim());
		// `normalizePath` answers "/" for an empty path. Neither that nor the
		// vault root excludes anything: a list that quietly hid every note would
		// be worse than a line the person can see doing nothing.
		if (folder === "/") return false;
		return full === folder || full.startsWith(`${folder}/`);
	});
}

/**
 * A note's name as a person reads it: no folder, no extension.
 *
 * Exported for `collectionRename.ts`: the old name a rename event's `oldPath`
 * carries is read the same way, so the rewrite compares like with like.
 */
export function noteName(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
	return name.replace(/\.md$/i, "");
}
