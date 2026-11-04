/**
 * Which meeting notes name which collections in their effort field.
 *
 * **From Obsidian's index of frontmatter alone; no meeting note's text is
 * read.** Every note's frontmatter is already parsed and in memory, so finding
 * every meeting that names a collection costs no reading, the same reason the
 * collections index itself reads only the metadata cache (`collections.ts`).
 *
 * A meeting note is any note whose frontmatter `tags` carries the template's
 * tag — one the calendar run created and one the person made by hand alike.
 * Its effort field may hold one link or a list of them, written as Obsidian
 * writes a link in a property (`"[[Garden]]"`); each is read with the core's
 * link reader (`linkReading.ts`) and resolved the way Obsidian resolves a link
 * from that note. A link counts only where it lands on a note the core calls a
 * collection.
 */

import { localDateKey } from "../../core/meetingName";
import { linksOnLine } from "../../core/linkReading";
import { readMeetingNotePath } from "./notePath";
import type { MeetingNoteTemplate } from "./types";

/** What is read of the vault: every note, its parsed frontmatter, and how a link from it resolves. */
export interface MeetingNoteCaches {
	/** Every Markdown note's vault path. */
	paths(): readonly string[];
	/** The note's frontmatter as Obsidian parsed it, or `null` when it has none or is not parsed yet. */
	frontmatter(path: string): Readonly<Record<string, unknown>> | null;
	/** The vault path a link written in `sourcePath` lands on, or `null` when it lands nowhere. */
	resolve(linkpath: string, sourcePath: string): string | null;
	/** Whether the core's collections index calls that note a collection. */
	isCollection(path: string): boolean;
	/** When the note was made, in milliseconds, or `null` when that is not known. */
	created(path: string): number | null;
}

/** One meeting note naming a collection, and the date its logbook line sorts by. */
export interface MeetingLink {
	readonly note: string;
	/** `YYYY-MM-DD`: the date the note's name starts with, else the day it was made; `null` when neither is known. */
	readonly date: string | null;
}

/**
 * By collection path, every meeting note naming that collection, in the order
 * the notes were listed; each note at most once per collection however many
 * times its field names it. A collection no meeting names has no key.
 */
export function meetingsNamingCollections(
	caches: MeetingNoteCaches,
	template: Pick<MeetingNoteTemplate, "tag" | "effortField">,
): Map<string, MeetingLink[]> {
	const found = new Map<string, MeetingLink[]>();
	for (const note of caches.paths()) {
		const frontmatter = caches.frontmatter(note);
		if (!carriesTag(frontmatter, template.tag)) continue;

		const named = new Set<string>();
		for (const value of textsOf(frontmatter[template.effortField])) {
			for (const link of linksOnLine(value)) {
				const target = caches.resolve(link.path, note);
				if (target !== null && target !== note && caches.isCollection(target)) named.add(target);
			}
		}
		if (named.size === 0) continue;

		const date = dateOf(note, caches.created(note));
		for (const collection of named) found.set(collection, [...(found.get(collection) ?? []), { note, date }]);
	}
	return found;
}

/** Whether a note with this frontmatter is a meeting note: its `tags` carry `tag`, `#` and capitals aside. */
export function carriesTag(frontmatter: Readonly<Record<string, unknown>> | null | undefined, tag: string): frontmatter is Readonly<Record<string, unknown>> {
	return frontmatter !== null && frontmatter !== undefined && tagsOf(frontmatter.tags).includes(bareTag(tag));
}

/** The date the note's name starts with, else the local day it was made. */
function dateOf(note: string, created: number | null): string | null {
	const named = readMeetingNotePath(note);
	if (named !== null) return named.date;
	return created === null ? null : localDateKey(new Date(created));
}

/**
 * A `tags` property's tags, each without a leading `#` and in lower case: a
 * list of them, or one text holding several separated by commas or spaces.
 * That Obsidian reads the property this way — and ignores capitals and the
 * `#` when it matches a tag — is an inference, not a drive; the shape the
 * calendar run writes, a list of bare tags (`noteText.ts`), is read either way.
 */
function tagsOf(value: unknown): string[] {
	const tags: string[] = [];
	for (const text of textsOf(value)) {
		for (const part of text.split(/[,\s]+/)) {
			const tag = bareTag(part);
			if (tag !== "") tags.push(tag);
		}
	}
	return tags;
}

function bareTag(tag: string): string {
	return tag.trim().replace(/^#/, "").toLowerCase();
}

/** A property's value as the texts it holds: one text, or the texts in a list; anything else holds none. */
function textsOf(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	return [];
}
