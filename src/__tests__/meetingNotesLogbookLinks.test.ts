/**
 * Which meeting notes name which collections in their effort field, read from what
 * Obsidian has already parsed of each note's frontmatter.
 *
 * Every path, tag and field name here is invented.
 */

import { describe, expect, it } from "vitest";
import { meetingsNamingCollections } from "../features/meetingNotes/logbookLinks";
import type { MeetingNoteCaches } from "../features/meetingNotes/logbookLinks";

/** A vault of notes with these frontmatters, links resolved by note name, and these paths as collections. */
function caches(
	notes: Record<string, Record<string, unknown> | null>,
	collections: readonly string[],
	created: Record<string, number> = {},
): MeetingNoteCaches {
	const paths = [...Object.keys(notes), ...collections.filter((path) => !(path in notes))];
	return {
		paths: () => paths,
		frontmatter: (path) => notes[path] ?? null,
		resolve: (linkpath) => paths.find((path) => path.replace(/^.*\//, "").replace(/\.md$/, "") === linkpath) ?? null,
		isCollection: (path) => collections.includes(path),
		created: (path) => created[path] ?? null,
	};
}

const FIELDS = { tag: "gathering", effortField: "work" };

describe("meetingsNamingCollections", () => {
	it("gives a meeting naming one collection one entry under it, dated by the note's name", () => {
		const found = meetingsNamingCollections(
			caches({ "M/2026-10-01 Shed.md": { tags: ["gathering"], work: "[[Garden]]" } }, ["Areas/Garden.md"]),
			FIELDS,
		);
		expect(found).toEqual(new Map([["Areas/Garden.md", [{ note: "M/2026-10-01 Shed.md", date: "2026-10-01" }]]]));
	});

	it("gives a meeting naming a list of collections one entry in each", () => {
		const found = meetingsNamingCollections(
			caches({ "M/2026-10-01 Shed.md": { tags: "gathering", work: ["[[Garden]]", "[[Kitchen|the kitchen]]"] } }, [
				"Areas/Garden.md",
				"Areas/Kitchen.md",
			]),
			FIELDS,
		);
		expect([...found.keys()]).toEqual(["Areas/Garden.md", "Areas/Kitchen.md"]);
		expect(found.get("Areas/Kitchen.md")).toEqual([{ note: "M/2026-10-01 Shed.md", date: "2026-10-01" }]);
	});

	it("counts one entry when a meeting names the same collection twice", () => {
		const found = meetingsNamingCollections(
			caches({ "M/2026-10-01 Shed.md": { tags: ["gathering"], work: ["[[Garden]]", "[[Garden]]"] } }, ["Areas/Garden.md"]),
			FIELDS,
		);
		expect(found.get("Areas/Garden.md")).toHaveLength(1);
	});

	it("takes a hand-made meeting note carrying the tag, dated by when it was made when its name has no date", () => {
		const made = new Date(2026, 8, 14, 10, 0).getTime();
		const found = meetingsNamingCollections(
			caches({ "Elsewhere/Talk with Bo.md": { tags: ["#Gathering"], work: "[[Garden]]" } }, ["Areas/Garden.md"], {
				"Elsewhere/Talk with Bo.md": made,
			}),
			FIELDS,
		);
		expect(found.get("Areas/Garden.md")).toEqual([{ note: "Elsewhere/Talk with Bo.md", date: "2026-09-14" }]);
	});

	it("ignores a note without the tag, a link to a note that is not a collection, and a link that resolves nowhere", () => {
		const found = meetingsNamingCollections(
			caches(
				{
					"M/2026-10-01 Shed.md": { tags: ["other"], work: "[[Garden]]" },
					"M/2026-10-02 Fence.md": { tags: ["gathering"], work: ["[[Plain note]]", "[[Nowhere]]"] },
					"Notes/Plain note.md": {},
				},
				["Areas/Garden.md"],
			),
			FIELDS,
		);
		expect(found).toEqual(new Map());
	});

	it("reads the effort field the template names and no other", () => {
		const found = meetingsNamingCollections(
			caches({ "M/2026-10-01 Shed.md": { tags: ["gathering"], effort: "[[Garden]]" } }, ["Areas/Garden.md"]),
			FIELDS,
		);
		expect(found).toEqual(new Map());
	});
});
