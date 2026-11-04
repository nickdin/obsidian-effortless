/**
 * Meeting notes' memory of the lines it wrote under collections' logbook
 * headings.
 *
 * **Which lines are the feature's is remembered, never inferred from a line's
 * shape.** A line the person wrote by hand that reads exactly like one the
 * feature would write is still theirs, so it is never removed; the only lines
 * ever taken out are ones this memory names, matched by their exact text.
 *
 * Kept in the feature's slice of `data.json` as `logbook`, keyed by the
 * collection's vault path, each entry naming the meeting note it links and the
 * line written for it. The file is hand-editable, so the memory is read
 * through {@link readLogbookMemory} and an entry of the wrong shape is dropped
 * and named, the rule `readNotesMemory` keeps for the notes memory beside it.
 */

/** One line the feature wrote under a collection's logbook heading. */
export interface LogbookEntry {
	/** The vault path of the meeting note the line links. */
	readonly note: string;
	/** The line as it now reads in the collection, without its line ending. */
	readonly line: string;
	/**
	 * The line as it was written, kept while a rename this device saw may or
	 * may not have had Obsidian's link updater rewrite it into {@link line}.
	 * That with *Automatically update internal links* on the collection holds
	 * the new text, and with it off the old, is an inference from the setting's
	 * name, not a drive: `docs/acceptance-shots/issue-1260-logbook-drive.txt`
	 * did not rename. Either text is the feature's line, so neither case can
	 * lose it. Gone again the next time the feature writes the collection.
	 */
	readonly was?: string;
}

/** By collection path, the lines the feature wrote there, newest first as written. */
export type LogbookMemory = Readonly<Record<string, readonly LogbookEntry[]>>;

/** The memory as the feature can use it, and every collection key something was dropped from. */
export interface ReadLogbookMemory {
	readonly memory: LogbookMemory;
	/** Collection keys with an entry of the wrong shape, each once, in stored order; `logbook` when the whole value was. */
	readonly dropped: readonly string[];
}

/**
 * The stored `logbook` read as a memory: every entry of the right shape kept as
 * stored, every collection key that held anything else named in `dropped`.
 * Nothing stored is an empty memory and says nothing — that is a fresh install,
 * or a file from before #1260.
 */
export function readLogbookMemory(raw: unknown): ReadLogbookMemory {
	if (raw === undefined) return { memory: {}, dropped: [] };
	if (!isRecord(raw)) return { memory: {}, dropped: ["logbook"] };

	const memory: Record<string, LogbookEntry[]> = {};
	const dropped: string[] = [];
	for (const [collection, stored] of Object.entries(raw)) {
		if (!Array.isArray(stored)) {
			dropped.push(collection);
			continue;
		}
		const values: unknown[] = stored;
		const entries = values.map(readEntry).filter((entry): entry is LogbookEntry => entry !== null);
		if (entries.length < values.length) dropped.push(collection);
		if (entries.length > 0) memory[collection] = entries;
	}
	return { memory, dropped };
}

function readEntry(value: unknown): LogbookEntry | null {
	if (!isRecord(value)) return null;
	const { note, line, was } = value;
	if (!isText(note) || !isText(line)) return null;
	if (was === undefined) return { note, line };
	return isText(was) ? { note, line, was } : null;
}

/**
 * `memory` after a rename from `oldPath` to `newPath` that this device saw: a
 * renamed collection's lines move to its new key as they are, and a renamed
 * meeting note's entries name the new path, with the line `lineFor` says a
 * link to it is now written as (the old line when `lineFor` cannot say) and
 * the line first written kept beside it
 * ({@link LogbookEntry.was}). The same object comes back when nothing it holds
 * was renamed, so a caller can tell there is nothing to save.
 */
export function renamedInLogbook(
	memory: LogbookMemory,
	oldPath: string,
	newPath: string,
	lineFor: (note: string, collection: string) => string | null,
): LogbookMemory {
	let changed = false;
	const next: Record<string, readonly LogbookEntry[]> = {};
	for (const [collection, entries] of Object.entries(memory)) {
		const key = collection === oldPath ? newPath : collection;
		if (key !== collection) changed = true;
		next[key] = entries.map((entry) => {
			if (entry.note !== oldPath) return entry;
			changed = true;
			return { note: newPath, line: lineFor(newPath, key) ?? entry.line, was: entry.was ?? entry.line };
		});
	}
	return changed ? next : memory;
}

function isText(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
