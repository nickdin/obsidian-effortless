/**
 * One collection's logbook section rewritten: the feature's
 * own lines taken out, the wanted ones put back newest first at the top of the
 * section, every other byte left as it was.
 *
 * Every note name here is invented.
 */

import { describe, expect, it } from "vitest";
import { withLogbook } from "../features/meetingNotes/logbookSection";
import type { WantedLine } from "../features/meetingNotes/logbookSection";

const HEADING = { level: 2, text: "Logbook" };

/** Whether `line` links `note`, by the note's name: the resolver the pass hands in, made plain. */
const linksNote = (line: string, note: string): boolean =>
	line.includes(`[[${note.replace(/^.*\//, "").replace(/\.md$/, "")}]]`);

function wanted(note: string, date: string | null): WantedLine {
	return { note, date, line: `- [[${note.replace(/^.*\//, "").replace(/\.md$/, "")}]]` };
}

const SHED = wanted("M/2026-10-01 Shed.md", "2026-10-01");
const FENCE = wanted("M/2026-10-08 Fence.md", "2026-10-08");

describe("withLogbook", () => {
	it("writes one line for one meeting under the heading, and owns it", () => {
		const before = "# Garden\n\n## Tasks\n- [ ] Dig\n\n## Logbook\n\n## Later\n";
		expect(withLogbook(before, HEADING, [], [SHED], linksNote)).toEqual({
			text: "# Garden\n\n## Tasks\n- [ ] Dig\n\n## Logbook\n- [[2026-10-01 Shed]]\n\n## Later\n",
			owned: [{ note: SHED.note, line: SHED.line }],
		});
	});

	it("puts two meetings newest first, above a hand-written line, after the blank line under the heading", () => {
		const before = "## Logbook\n\n- 2026-05-24: First go, by hand.\n";
		const result = withLogbook(before, HEADING, [], [SHED, FENCE], linksNote);
		expect(result?.text).toBe(
			"## Logbook\n\n- [[2026-10-08 Fence]]\n- [[2026-10-01 Shed]]\n- 2026-05-24: First go, by hand.\n",
		);
		expect(result?.owned.map((entry) => entry.note)).toEqual([FENCE.note, SHED.note]);
	});

	it("puts a meeting with no known date after every dated one", () => {
		const undated = wanted("Elsewhere/Talk.md", null);
		const result = withLogbook("## Logbook\n", HEADING, [], [undated, SHED], linksNote);
		expect(result?.text).toBe("## Logbook\n- [[2026-10-01 Shed]]\n- [[Talk]]\n");
	});

	it("takes out its own line when the meeting is no longer wanted, and leaves the hand-written lines", () => {
		const before = "## Logbook\n- [[2026-10-08 Fence]]\n- [[2026-10-01 Shed]]\n- by hand\n";
		const owned = [
			{ note: FENCE.note, line: FENCE.line },
			{ note: SHED.note, line: SHED.line },
		];
		expect(withLogbook(before, HEADING, owned, [SHED], linksNote)).toEqual({
			text: "## Logbook\n- [[2026-10-01 Shed]]\n- by hand\n",
			owned: [{ note: SHED.note, line: SHED.line }],
		});
	});

	it("never takes out a hand-written line identical to one it would write, and does not add a second", () => {
		const before = "## Logbook\n- [[2026-10-01 Shed]]\n";
		expect(withLogbook(before, HEADING, [], [SHED], linksNote)).toEqual({ text: before, owned: [] });
		expect(withLogbook(before, HEADING, [], [], linksNote)).toEqual({ text: before, owned: [] });
	});

	it("takes out the line it wrote under its old name or its new one after a rename, and writes the new one", () => {
		const renamed = wanted("M/2026-10-02 Shed.md", "2026-10-02");
		const owned = [{ note: renamed.note, line: renamed.line, was: SHED.line }];
		for (const before of ["## Logbook\n- [[2026-10-01 Shed]]\n", "## Logbook\n- [[2026-10-02 Shed]]\n"]) {
			expect(withLogbook(before, HEADING, owned, [renamed], linksNote)).toEqual({
				text: "## Logbook\n- [[2026-10-02 Shed]]\n",
				owned: [{ note: renamed.note, line: renamed.line }],
			});
		}
	});

	it("puts its lines back where they were, so a blank line the person left between them and their own stays put", () => {
		const before = "## Logbook\n- [[2026-10-01 Shed]]\n\n- by hand\n";
		const owned = [{ note: SHED.note, line: SHED.line }];
		expect(withLogbook(before, HEADING, owned, [SHED], linksNote)?.text).toBe(before);
		expect(withLogbook(before, HEADING, owned, [SHED, FENCE], linksNote)?.text).toBe(
			"## Logbook\n- [[2026-10-08 Fence]]\n- [[2026-10-01 Shed]]\n\n- by hand\n",
		);
	});

	it("forgets a line of its own the person took out", () => {
		const before = "## Logbook\n- by hand\n";
		expect(withLogbook(before, HEADING, [{ note: SHED.note, line: SHED.line }], [], linksNote)).toEqual({
			text: before,
			owned: [],
		});
	});

	it("writes nothing into a note without the heading, and reads a heading at another level as another heading", () => {
		expect(withLogbook("# Garden\n## Tasks\n", HEADING, [], [SHED], linksNote)).toBeNull();
		expect(withLogbook("### Logbook\n", HEADING, [], [SHED], linksNote)).toBeNull();
	});

	it("gives the same bytes back when nothing has changed", () => {
		const before = "## Logbook\n\n- [[2026-10-08 Fence]]\n- [[2026-10-01 Shed]]\n- by hand\n\n## Later";
		const owned = [
			{ note: FENCE.note, line: FENCE.line },
			{ note: SHED.note, line: SHED.line },
		];
		expect(withLogbook(before, HEADING, owned, [SHED, FENCE], linksNote)?.text).toBe(before);
	});
});

describe("withLogbook on a note with Windows line endings", () => {
	it("writes a line into a note ending in a line break", () => {
		const before = "# Garden\r\n## Logbook\r\n\r\n- by hand\r\n";
		expect(withLogbook(before, HEADING, [], [SHED], linksNote)?.text).toBe(
			"# Garden\r\n## Logbook\r\n\r\n- [[2026-10-01 Shed]]\r\n- by hand\r\n",
		);
	});

	it("writes a line into a note not ending in a line break, under a heading on its last line", () => {
		const before = "# Garden\r\n## Logbook";
		expect(withLogbook(before, HEADING, [], [SHED], linksNote)?.text).toBe("# Garden\r\n## Logbook\r\n- [[2026-10-01 Shed]]");
	});

	it("writes a line into a note not ending in a line break, above the hand-written last line", () => {
		const before = "## Logbook\r\n- by hand";
		expect(withLogbook(before, HEADING, [], [SHED], linksNote)?.text).toBe("## Logbook\r\n- [[2026-10-01 Shed]]\r\n- by hand");
	});

	it("takes a line out of a note ending in a line break", () => {
		const before = "## Logbook\r\n- [[2026-10-01 Shed]]\r\n- by hand\r\n";
		expect(withLogbook(before, HEADING, [{ note: SHED.note, line: SHED.line }], [], linksNote)?.text).toBe(
			"## Logbook\r\n- by hand\r\n",
		);
	});

	it("takes the last line out of a note not ending in a line break, leaving no line ending behind", () => {
		const before = "## Logbook\r\n- [[2026-10-01 Shed]]";
		expect(withLogbook(before, HEADING, [{ note: SHED.note, line: SHED.line }], [], linksNote)?.text).toBe("## Logbook");
	});
});
