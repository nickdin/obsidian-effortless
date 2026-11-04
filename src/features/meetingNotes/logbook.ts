/**
 * The logbook pass: every collection's logbook section made to hold one line
 * linking each meeting note that names it in its effort field.
 *
 * Over ports, so the whole pass runs in a test against a map of texts.
 *
 * - **Finding the links reads no meeting note** — `logbookLinks.ts` asks only
 *   Obsidian's index of frontmatter.
 * - **A collection is read only when it might change**: one a meeting names
 *   now, or one the memory says holds a line of the feature's. Of those, one
 *   whose index shows no logbook heading and holds nothing of the feature's is
 *   not read at all, and a collection whose section already reads as wanted is
 *   read but never written.
 * - **Every write goes through the core's note writer** (`ports.edit`), so it
 *   waits while the person is typing in the collection; the edit is worked out
 *   again over the text as it is when the write lands, and the untouched-note
 *   mark is refreshed with it (`withWrittenLineRefreshed`), as every plugin
 *   write keeps it (this repository's `CLAUDE.md`).
 */

import { headingParts } from "../../core/markdownSections";
import type { HeadingParts } from "../../core/markdownSections";
import { reasonOf } from "../../core/reason";
import { meetingsNamingCollections } from "./logbookLinks";
import type { MeetingNoteCaches } from "./logbookLinks";
import type { LogbookEntry, LogbookMemory } from "./logbookMemory";
import { withLogbook } from "./logbookSection";
import type { LogbookOutcome, WantedLine } from "./logbookSection";
import { withWrittenLineRefreshed } from "./noteIdentity";
import type { MeetingNoteTemplate } from "./types";

/** What the pass reaches for, and nothing more. */
export interface LogbookPorts {
	readonly caches: MeetingNoteCaches;
	/** Whether Obsidian's index shows that heading in the note: the guess that spares a read, never the decision. */
	hasHeading(path: string, heading: HeadingParts): boolean;
	/** Whether a note is at that path. */
	exists(path: string): boolean;
	/** The note's current text, through the core's note writer. */
	read(path: string): Promise<string>;
	/** The core's note writer's `edit`: rejects when the write could not be made. */
	edit(path: string, edit: (content: string) => string): Promise<string>;
	/** The line linking `note` from `collection`, with the logbook line start and the vault's link setting, or `null` when the note is gone. */
	lineFor(note: string, collection: string): string | null;
	/** Whether `line`, written in `collection`, links `note`. */
	linksNote(line: string, note: string, collection: string): boolean;
}

/** The memory to keep after the pass, and the collections whose write failed. */
export interface LogbookPassResult {
	readonly memory: LogbookMemory;
	/** Each collection whose write failed, and why; its memory is kept as it was, so the next pass tries again. */
	readonly failed: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
}

/**
 * One pass over every collection a meeting note names or `memory` holds,
 * under the heading `heading` (`## Logbook`). A heading the core does not read
 * as one writes nothing and hands the memory back unchanged.
 */
export async function runLogbook(
	ports: LogbookPorts,
	template: Pick<MeetingNoteTemplate, "tag" | "effortField">,
	heading: string,
	memory: LogbookMemory,
): Promise<LogbookPassResult> {
	const parts = headingParts(heading);
	if (parts === null) return { memory, failed: [] };

	const named = meetingsNamingCollections(ports.caches, template);
	const visit = [...new Set([...named.keys(), ...Object.keys(memory)])];
	const next: Record<string, readonly LogbookEntry[]> = {};
	const failed: Array<{ path: string; reason: string }> = [];

	// The writes run side by side: one held for a collection the person is
	// typing in must not keep every other collection waiting with it.
	const writes = visit.map(async (collection): Promise<void> => {
		const owned = memory[collection] ?? [];
		if (!ports.exists(collection)) return;
		if (owned.length === 0 && !ports.hasHeading(collection, parts)) return;

		const wanted: WantedLine[] = [];
		for (const { note, date } of named.get(collection) ?? []) {
			const line = ports.lineFor(note, collection);
			if (line !== null) wanted.push({ note, date, line });
		}
		const rewrite = (content: string): LogbookOutcome | null =>
			withLogbook(content, parts, owned, wanted, (line, note) => ports.linksNote(line, note, collection));

		const content = await ports.read(collection);
		const outcome = rewrite(content);
		if (outcome === null) return keep(next, collection, owned);
		if (outcome.text === content) return keep(next, collection, outcome.owned);

		// What the edit worked out over the text as it was when the write landed.
		const landed: { outcome: LogbookOutcome | null } = { outcome: null };
		try {
			await ports.edit(collection, (current) => {
				landed.outcome = rewrite(current);
				return landed.outcome === null ? current : withWrittenLineRefreshed(current, landed.outcome.text);
			});
		} catch (error) {
			// Said by the caller, once for the whole pass; the old memory stays so
			// the next pass finds the same lines and tries again.
			failed.push({ path: collection, reason: reasonOf(error) });
			return keep(next, collection, owned);
		}
		keep(next, collection, landed.outcome === null ? owned : landed.outcome.owned);
	});
	await Promise.all(writes);
	return { memory: next, failed };
}

function keep(memory: Record<string, readonly LogbookEntry[]>, collection: string, entries: readonly LogbookEntry[]): void {
	if (entries.length > 0) memory[collection] = entries;
}
