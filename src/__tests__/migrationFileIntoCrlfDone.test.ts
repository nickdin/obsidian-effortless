/**
 * Filing a done task into a note with Windows line endings, under a completed-tasks
 * heading the filing has to write. Every line break
 * of the result is `\r\n`: no lone `\r`, no bare `\n`. Every note and task is invented.
 */

import { describe, expect, it } from "vitest";
import { defaultData } from "../core/settings";
import { placeInCollection } from "../features/migration/fileInto";

const layout = defaultData().core.layout;

const DONE = "- [x] Fix the gate";
const OPEN = "- [ ] Fix the gate";

/** A collection with no completed-tasks heading, in Windows line endings. */
const WITH_FINAL_BREAK = "# Garden party\r\n\r\n## Tasks\r\n\r\n- [ ] Bring chairs\r\n";
const WITHOUT_FINAL_BREAK = "# Garden party\r\n\r\n## Tasks\r\n\r\n- [ ] Bring chairs";

const NOTES: readonly [string, string][] = [
	["a note ending with a final line break", WITH_FINAL_BREAK],
	["a note ending without a final line break", WITHOUT_FINAL_BREAK],
];

/** Every `\n` is preceded by `\r`, and every `\r` is followed by `\n`. */
function allWindows(text: string): boolean {
	return !/(?<!\r)\n/.test(text) && !/\r(?!\n)/.test(text);
}

describe("#1025: a done task filed with its heading into a Windows-endings note", () => {
	// If wrong: the text ends in a lone `\r` and the note's last empty line has none, so allWindows is false.
	it.each(NOTES)("keeps every line break \\r\\n, %s", (_name, note) => {
		const placed = placeInCollection(note, DONE, "done", layout);
		expect(placed.ok).toBe(true);
		const text = placed.ok ? placed.text : "";
		expect(text, "the filing wrote no heading, so the test cannot fail").toContain(`## ${layout.completedTasksHeading}`);
		expect(text).toContain(DONE);
		expect(allWindows(text), JSON.stringify(text)).toBe(true);
	});

	// If wrong: a bare `\n` or a lone `\r` shows in the quoted bytes, so toBe fails.
	it.each([
		[WITH_FINAL_BREAK, `${WITH_FINAL_BREAK}\r\n## ${layout.completedTasksHeading}\r\n\r\n${DONE}\r\n`],
		[WITHOUT_FINAL_BREAK, `${WITHOUT_FINAL_BREAK}\r\n\r\n## ${layout.completedTasksHeading}\r\n\r\n${DONE}`],
	])("writes exactly these bytes into %j", (note, expected) => {
		expect(placeInCollection(note, DONE, "done", layout)).toEqual({ ok: true, text: expected });
	});

	// The open-task branch goes through another path and is the control, over the note it was reported sound for.
	it("an open task is the control and keeps every line break \\r\\n in a note with a final line break", () => {
		const placed = placeInCollection(WITH_FINAL_BREAK, OPEN, "open", layout);
		expect(placed.ok && allWindows(placed.text)).toBe(true);
	});
});
