/**
 * The collections a person filed into most recently, newest first
 * (#859, spec
 * #716 decision 4, third
 * and fourth bullets).
 *
 * Pure over lists: the list lives in this feature's own slice of `data.json`
 * (`MigrationSettings.recentlyUsed`), which the feature class reads and saves
 * through `host.settings`; nothing here touches the store, so only the core
 * ever saves. The list is kept by path, in the file that holds it for every
 * device, because what it answers is "what I have been working on" and not
 * "what I did on this machine".
 */

import type { Collection } from "../../core/collections";

/** How many paths the list keeps; the spec left the number open and this ticket sets it. */
export const RECENTLY_USED_CAP = 10;

/**
 * The list as `data.json` holds it, when it is one: an array of strings.
 * `null` for anything else — the file is hand-editable, so a value of the wrong
 * shape is refused by the caller with a notice, never replaced without saying.
 */
export function readRecentlyUsed(stored: unknown): string[] | null {
	if (!Array.isArray(stored)) return null;
	if (!stored.every((each): each is string => typeof each === "string")) return null;
	return [...stored];
}

/**
 * `list` with `path` at the front, any earlier copy of it removed, and nothing
 * kept past `cap`. A new list; `list` is never changed.
 */
export function moveToFront(list: readonly string[], path: string, cap: number = RECENTLY_USED_CAP): string[] {
	return [path, ...list.filter((each) => each !== path)].slice(0, cap);
}

/**
 * `collections` with the recently used ones first, in the list's order, and the
 * rest after them in the order they came. A path in `recent` that is not among
 * `collections` — the note deleted, renamed, or its heading gone — is left out
 * without a word; a collection named twice in `recent` is placed once.
 */
export function orderByRecent(collections: readonly Collection[], recent: readonly string[]): Collection[] {
	const byPath = new Map(collections.map((each) => [each.path, each]));
	const first: Collection[] = [];
	for (const path of recent) {
		const found = byPath.get(path);
		if (found !== undefined && !first.includes(found)) first.push(found);
	}
	return [...first, ...collections.filter((each) => !first.includes(each))];
}
