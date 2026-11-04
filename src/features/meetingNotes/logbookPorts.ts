/**
 * The logbook pass's ports over the real Obsidian: what
 * `logbook.ts` asks, answered from the vault, the metadata cache, the core's
 * collections index and the core's note writer.
 *
 * Built afresh for each pass, so a note list taken here is the vault as the
 * pass found it, and nothing read here outlives the pass that read it.
 */

import type { App, TFile } from "obsidian";
import type { Collections } from "../../core/collections";
import { linksOnLine } from "../../core/linkReading";
import { headingIs } from "../../core/markdownSections";
import type { NoteWriter } from "../../core/noteWriter";
import type { LogbookPorts } from "./logbook";

/**
 * The line a link to `note` is written as in `collection`: `start` — the
 * card's logbook line start, `-` or `- [i]` — a space, and the link
 * by the vault's own link setting; `null` when the note is gone.
 */
export function logbookLine(app: App, note: string, collection: string, start: string): string | null {
	const file = app.vault.getFileByPath(note);
	// `FileManager.generateMarkdownLink(file, sourcePath)`, `node_modules/obsidian/obsidian.d.ts:2931`:
	// a wikilink or a Markdown link, shortest path or full, as the person set it.
	return file === null ? null : `${start} ${app.fileManager.generateMarkdownLink(file, collection)}`;
}

/** The ports for one pass; `start` is the logbook line start every line it wants is written with. */
export function logbookPorts(app: App, notes: NoteWriter, collections: Collections, start: string): LogbookPorts {
	const { vault, metadataCache } = app;
	const files = new Map<string, TFile>(vault.getMarkdownFiles().map((file) => [file.path, file]));
	const at = (path: string): TFile => {
		const file = vault.getFileByPath(path);
		if (file === null) throw new Error(`Effortless: no note at ${path}.`);
		return file;
	};
	// `getFirstLinkpathDest(linkpath, sourcePath)`, `node_modules/obsidian/obsidian.d.ts:4411`.
	const resolve = (linkpath: string, sourcePath: string): string | null =>
		metadataCache.getFirstLinkpathDest(linkpath, sourcePath)?.path ?? null;

	return {
		caches: {
			paths: () => [...files.keys()],
			frontmatter: (path) => {
				const file = files.get(path);
				return (file === undefined ? null : metadataCache.getFileCache(file)?.frontmatter) ?? null;
			},
			resolve,
			isCollection: (path) => collections.at(path) !== null,
			created: (path) => files.get(path)?.stat.ctime ?? null,
		},
		hasHeading: (path, heading) => {
			const file = files.get(path);
			const headings = file === undefined ? [] : (metadataCache.getFileCache(file)?.headings ?? []);
			return headings.some((found) => headingIs({ level: found.level, text: found.heading }, heading.text, heading.level));
		},
		exists: (path) => vault.getFileByPath(path) !== null,
		read: (path) => notes.read(at(path)),
		// A background write the person did not ask for: held while they type in
		// the collection, without a notice nagging them about it.
		edit: (path, edit) => notes.edit(at(path), edit, { quietHold: true }),
		lineFor: (note, collection) => logbookLine(app, note, collection, start),
		linksNote: (line, note, collection) => linksOnLine(line).some((link) => resolve(link.path, collection) === note),
	};
}
