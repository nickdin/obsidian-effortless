/**
 * The logbook pass over a whole vault: every
 * collection a meeting note names gets its line, every line the feature wrote
 * that is no longer wanted goes, and nothing else in any note changes.
 *
 * The vault here is a map of texts and frontmatters behind the pass's ports;
 * every path and name is invented. Links are resolved by note name and written
 * as `[[name]]`, the vault's shortest-path wikilink setting.
 */

import { describe, expect, it } from "vitest";
import { headingParts } from "../core/markdownSections";
import { linksOnLine } from "../core/linkReading";
import { runLogbook } from "../features/meetingNotes/logbook";
import type { LogbookPorts } from "../features/meetingNotes/logbook";
import type { LogbookMemory } from "../features/meetingNotes/logbookMemory";
import { bodyFingerprintWritten, unchangedSinceWritten, writtenLine } from "../features/meetingNotes/noteIdentity";

const TEMPLATE = { tag: "gathering", effortField: "work" };
const HEADING = "## Logbook";

interface FakeVault {
	texts: Map<string, string>;
	frontmatters: Map<string, Record<string, unknown>>;
	collections: Set<string>;
	reads: string[];
	writes: string[];
	ports: LogbookPorts;
	/** What `lineFor` starts each line with from now on, as the card's logbook line start does; `-` until set. */
	setLineStart(start: string): void;
}

function nameOf(path: string): string {
	return path.replace(/^.*\//, "").replace(/\.md$/, "");
}

function fakeVault(): FakeVault {
	const texts = new Map<string, string>();
	const frontmatters = new Map<string, Record<string, unknown>>();
	const collections = new Set<string>();
	const reads: string[] = [];
	const writes: string[] = [];
	let lineStart = "-";
	const paths = () => [...new Set([...texts.keys(), ...frontmatters.keys()])];
	const resolve = (linkpath: string) => paths().find((path) => nameOf(path) === linkpath) ?? null;
	const ports: LogbookPorts = {
		caches: {
			paths,
			frontmatter: (path) => frontmatters.get(path) ?? null,
			resolve,
			isCollection: (path) => collections.has(path),
			created: () => null,
		},
		hasHeading: (path, heading) =>
			(texts.get(path) ?? "")
				.split("\n")
				.some((line) => {
					const parts = headingParts(line.replace(/\r$/, ""));
					return parts !== null && parts.level === heading.level && parts.text.toLowerCase() === heading.text.toLowerCase();
				}),
		exists: (path) => texts.has(path) || frontmatters.has(path),
		read: async (path) => {
			reads.push(path);
			const text = texts.get(path);
			if (text === undefined) throw new Error(`no note at ${path}`);
			return text;
		},
		edit: async (path, edit) => {
			const text = edit(texts.get(path) ?? "");
			writes.push(path);
			texts.set(path, text);
			return text;
		},
		lineFor: (note) => (paths().includes(note) ? `${lineStart} [[${nameOf(note)}]]` : null),
		linksNote: (line, note) => linksOnLine(line).some((link) => resolve(link.path) === note),
	};
	const setLineStart = (start: string): void => {
		lineStart = start;
	};
	return { texts, frontmatters, collections, reads, writes, ports, setLineStart };
}

/** A collection at `path` with `body` after its tasks heading. */
function collection(vault: FakeVault, path: string, body: string): void {
	vault.texts.set(path, `# ${nameOf(path)}\n## Tasks\n- [ ] Dig\n${body}`);
	vault.collections.add(path);
}

/** A meeting note at `path` whose effort field holds `work`; its text is a stand-in the pass must never read. */
function meeting(vault: FakeVault, path: string, work: unknown): void {
	vault.frontmatters.set(path, { tags: ["gathering"], work });
}

async function pass(vault: FakeVault, memory: LogbookMemory = {}, heading: string = HEADING) {
	return runLogbook(vault.ports, TEMPLATE, heading, memory);
}

describe("runLogbook", () => {
	it("gives a collection one line for a meeting naming it, and one in each of two named", async () => {
		const vault = fakeVault();
		collection(vault, "Areas/Garden.md", "## Logbook\n");
		collection(vault, "Areas/Kitchen.md", "## Logbook\n");
		meeting(vault, "M/2026-10-01 Shed.md", "[[Garden]]");
		meeting(vault, "M/2026-10-02 Pantry.md", ["[[Garden]]", "[[Kitchen]]"]);

		const { memory, failed } = await pass(vault);

		expect(vault.texts.get("Areas/Garden.md")).toBe(
			"# Garden\n## Tasks\n- [ ] Dig\n## Logbook\n- [[2026-10-02 Pantry]]\n- [[2026-10-01 Shed]]\n",
		);
		expect(vault.texts.get("Areas/Kitchen.md")).toBe("# Kitchen\n## Tasks\n- [ ] Dig\n## Logbook\n- [[2026-10-02 Pantry]]\n");
		expect(memory).toEqual({
			"Areas/Garden.md": [
				{ note: "M/2026-10-02 Pantry.md", line: "- [[2026-10-02 Pantry]]" },
				{ note: "M/2026-10-01 Shed.md", line: "- [[2026-10-01 Shed]]" },
			],
			"Areas/Kitchen.md": [{ note: "M/2026-10-02 Pantry.md", line: "- [[2026-10-02 Pantry]]" }],
		});
		expect(failed).toEqual([]);
	});

	it("reads no meeting note's text to find the links, only the collections it writes", async () => {
		const vault = fakeVault();
		collection(vault, "Areas/Garden.md", "## Logbook\n");
		meeting(vault, "M/2026-10-01 Shed.md", "[[Garden]]");
		vault.texts.set("M/2026-10-01 Shed.md", "---\nwork: \"[[Garden]]\"\n---\n# Notes\n");

		await pass(vault);

		expect(vault.reads).toEqual(["Areas/Garden.md"]);
	});

	it("removes its line when the meeting stops naming the collection, while an identical hand-written line in another collection stays", async () => {
		const vault = fakeVault();
		collection(vault, "Areas/Garden.md", "## Logbook\n");
		collection(vault, "Areas/Kitchen.md", "## Logbook\n- [[2026-10-01 Shed]]\n");
		meeting(vault, "M/2026-10-01 Shed.md", ["[[Garden]]", "[[Kitchen]]"]);
		const first = await pass(vault);
		expect(first.memory["Areas/Kitchen.md"]).toBeUndefined();

		meeting(vault, "M/2026-10-01 Shed.md", []);
		const second = await pass(vault, first.memory);

		expect(vault.texts.get("Areas/Garden.md")).toBe("# Garden\n## Tasks\n- [ ] Dig\n## Logbook\n");
		expect(vault.texts.get("Areas/Kitchen.md")).toBe("# Kitchen\n## Tasks\n- [ ] Dig\n## Logbook\n- [[2026-10-01 Shed]]\n");
		expect(second.memory).toEqual({});
	});

	it("removes its line when the meeting note is deleted", async () => {
		const vault = fakeVault();
		collection(vault, "Areas/Garden.md", "## Logbook\n- by hand\n");
		meeting(vault, "M/2026-10-01 Shed.md", "[[Garden]]");
		const first = await pass(vault);

		vault.frontmatters.delete("M/2026-10-01 Shed.md");
		const second = await pass(vault, first.memory);

		expect(vault.texts.get("Areas/Garden.md")).toBe("# Garden\n## Tasks\n- [ ] Dig\n## Logbook\n- by hand\n");
		expect(second.memory).toEqual({});
	});

	it("rewrites its line to a renamed meeting note's new name", async () => {
		const vault = fakeVault();
		collection(vault, "Areas/Garden.md", "## Logbook\n");
		meeting(vault, "M/2026-10-01 Shed.md", "[[Garden]]");
		await pass(vault);

		vault.frontmatters.delete("M/2026-10-01 Shed.md");
		meeting(vault, "M/2026-10-03 Shed.md", "[[Garden]]");
		// What the feature's rename handler makes of the memory (`renamedInLogbook`).
		const renamed: LogbookMemory = {
			"Areas/Garden.md": [{ note: "M/2026-10-03 Shed.md", line: "- [[2026-10-03 Shed]]", was: "- [[2026-10-01 Shed]]" }],
		};
		const { memory } = await pass(vault, renamed);

		expect(vault.texts.get("Areas/Garden.md")).toBe("# Garden\n## Tasks\n- [ ] Dig\n## Logbook\n- [[2026-10-03 Shed]]\n");
		expect(memory).toEqual({ "Areas/Garden.md": [{ note: "M/2026-10-03 Shed.md", line: "- [[2026-10-03 Shed]]" }] });
	});

	it("rewrites only its own lines when the line start changes from - to - [i], leaving hand-written ones byte-for-byte", async () => {
		const vault = fakeVault();
		collection(vault, "Areas/Garden.md", "## Logbook\n");
		meeting(vault, "M/2026-10-01 Shed.md", "[[Garden]]");
		meeting(vault, "M/2026-10-02 Fence.md", "[[Garden]]");
		const first = await pass(vault);
		expect(vault.texts.get("Areas/Garden.md")).toBe(
			"# Garden\n## Tasks\n- [ ] Dig\n## Logbook\n- [[2026-10-02 Fence]]\n- [[2026-10-01 Shed]]\n",
		);

		// The person adds two lines of their own: a plain one for a meeting that
		// names the garden, and a marked one for a meeting that does not.
		meeting(vault, "M/2026-09-01 Pond.md", "[[Garden]]");
		const handWritten = "- [[2026-09-01 Pond]]\n- [i] [[2026-08-01 Well]]\n";
		vault.texts.set("Areas/Garden.md", `${vault.texts.get("Areas/Garden.md")}${handWritten}`);
		vault.setLineStart("- [i]");
		const { memory } = await pass(vault, first.memory);

		expect(vault.texts.get("Areas/Garden.md")).toBe(
			"# Garden\n## Tasks\n- [ ] Dig\n## Logbook\n- [i] [[2026-10-02 Fence]]\n- [i] [[2026-10-01 Shed]]\n- [[2026-09-01 Pond]]\n- [i] [[2026-08-01 Well]]\n",
		);
		expect(memory).toEqual({
			"Areas/Garden.md": [
				{ note: "M/2026-10-02 Fence.md", line: "- [i] [[2026-10-02 Fence]]" },
				{ note: "M/2026-10-01 Shed.md", line: "- [i] [[2026-10-01 Shed]]" },
			],
		});
	});

	it.each([
		["ending in a line break", "\r\n"],
		["not ending in a line break", ""],
	])("rewrites its line from one start to the other in a note with Windows line endings %s, exact bytes", async (_case, last) => {
		const vault = fakeVault();
		const garden = "Areas/Garden.md";
		vault.collections.add(garden);
		meeting(vault, "M/2026-10-01 Shed.md", "[[Garden]]");
		const memory: LogbookMemory = { [garden]: [{ note: "M/2026-10-01 Shed.md", line: "- [[2026-10-01 Shed]]" }] };
		const before = `# Garden\r\n## Tasks\r\n- [ ] Dig\r\n## Logbook\r\n- [[2026-10-01 Shed]]\r\n- [i] [[2026-08-01 Well]]${last}`;
		vault.texts.set(garden, before);

		vault.setLineStart("- [i]");
		const there = await pass(vault, memory);
		expect(vault.texts.get(garden)).toBe(
			`# Garden\r\n## Tasks\r\n- [ ] Dig\r\n## Logbook\r\n- [i] [[2026-10-01 Shed]]\r\n- [i] [[2026-08-01 Well]]${last}`,
		);

		vault.setLineStart("-");
		await pass(vault, there.memory);
		expect(vault.texts.get(garden)).toBe(before);
	});

	it.each([
		["ending in a line break", "\r\n"],
		["not ending in a line break", ""],
	])("rewrites its line as the last line of a note with Windows line endings %s, exact bytes", async (_case, last) => {
		const vault = fakeVault();
		const garden = "Areas/Garden.md";
		vault.collections.add(garden);
		meeting(vault, "M/2026-10-01 Shed.md", "[[Garden]]");
		const memory: LogbookMemory = { [garden]: [{ note: "M/2026-10-01 Shed.md", line: "- [[2026-10-01 Shed]]" }] };
		const before = `# Garden\r\n## Logbook\r\n- [[2026-10-01 Shed]]${last}`;
		vault.texts.set(garden, before);

		vault.setLineStart("- [i]");
		const there = await pass(vault, memory);
		expect(vault.texts.get(garden)).toBe(`# Garden\r\n## Logbook\r\n- [i] [[2026-10-01 Shed]]${last}`);

		vault.setLineStart("-");
		await pass(vault, there.memory);
		expect(vault.texts.get(garden)).toBe(before);
	});

	it("neither reads nor writes a collection without the logbook heading", async () => {
		const vault = fakeVault();
		collection(vault, "Areas/Garden.md", "## Notes\n");
		const before = vault.texts.get("Areas/Garden.md");
		meeting(vault, "M/2026-10-01 Shed.md", "[[Garden]]");

		const { memory } = await pass(vault);

		expect(vault.texts.get("Areas/Garden.md")).toBe(before);
		expect(vault.reads).toEqual([]);
		expect(vault.writes).toEqual([]);
		expect(memory).toEqual({});
	});

	it("does not write a collection whose section already reads as wanted", async () => {
		const vault = fakeVault();
		collection(vault, "Areas/Garden.md", "## Logbook\n");
		meeting(vault, "M/2026-10-01 Shed.md", "[[Garden]]");
		const first = await pass(vault);
		vault.writes.length = 0;

		await pass(vault, first.memory);

		expect(vault.writes).toEqual([]);
	});

	it("forgets a collection that is gone", async () => {
		const vault = fakeVault();
		const { memory } = await pass(vault, {
			"Areas/Gone.md": [{ note: "M/2026-10-01 Shed.md", line: "- [[2026-10-01 Shed]]" }],
		});
		expect(memory).toEqual({});
		expect(vault.reads).toEqual([]);
	});

	it("refreshes the untouched-note mark through the edit as every plugin write does", async () => {
		const vault = fakeVault();
		collection(vault, "Areas/Garden.md", "## Logbook\n");
		meeting(vault, "M/2026-10-01 Shed.md", "[[Garden]]");
		const edits: Array<(content: string) => string> = [];
		const edit = vault.ports.edit;
		vault.ports.edit = (path, change) => {
			edits.push(change);
			return edit(path, change);
		};
		await pass(vault);
		// A collection carrying the mark over an untouched body is still untouched
		// after the feature's own line: the mark now fingerprints the new body.
		const body = "## Logbook\n";
		const marked = `---\n${writtenLine(bodyFingerprintWritten(`---\n---\n${body}`) ?? "")}\n---\n${body}`;
		expect(unchangedSinceWritten(marked)).toBe(true);
		expect(edits).toHaveLength(1);
		const after = edits[0](marked);
		expect(after).toContain("- [[2026-10-01 Shed]]");
		expect(unchangedSinceWritten(after)).toBe(true);
	});

	it("keeps the old memory for a collection whose write failed, and names it", async () => {
		const vault = fakeVault();
		collection(vault, "Areas/Garden.md", "## Logbook\n");
		meeting(vault, "M/2026-10-01 Shed.md", "[[Garden]]");
		vault.ports.edit = () => Promise.reject(new Error("unloaded"));
		const old: LogbookMemory = {
			"Areas/Garden.md": [{ note: "M/2026-09-01 Old.md", line: "- [[2026-09-01 Old]]" }],
		};
		const { memory, failed } = await pass(vault, old);
		expect(memory).toEqual(old);
		expect(failed).toEqual([{ path: "Areas/Garden.md", reason: "unloaded" }]);
	});

	it("writes nothing when the heading is not one", async () => {
		const vault = fakeVault();
		collection(vault, "Areas/Garden.md", "## Logbook\n");
		meeting(vault, "M/2026-10-01 Shed.md", "[[Garden]]");
		const { memory } = await pass(vault, {}, "Logbook");
		expect(vault.writes).toEqual([]);
		expect(memory).toEqual({});
	});
});
