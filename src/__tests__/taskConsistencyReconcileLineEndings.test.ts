import { describe, expect, it } from "vitest";
import { parseTaskLine, type TaskLine } from "../core/taskLine";
import { snapshotOf, writeMarker } from "../features/taskConsistency/marker";
import { reconcilePair } from "../features/taskConsistency/reconcile";

// Every line below is invented: no real task, name or path from any vault.

/** Parses `raw`, failing the test rather than returning null. */
function parsed(raw: string): TaskLine {
	const task = parseTaskLine(raw);
	if (task === null) throw new Error(`expected a task line: ${JSON.stringify(raw)}`);
	return task;
}

const EID = "m1abc2de";

/**
 * The task as a collection holds it, paired and in step with its log copy: no
 * due date yet, and the marker carrying the hash of exactly that content.
 */
const collectionBase = "- [ ] Read report #work";
const pairedBase = writeMarker(collectionBase, EID, snapshotOf(parsed(collectionBase)).hash);

/** What the collection line must read after the log copy's due date has travelled to it. */
const withDue = `${collectionBase} 📅 2026-11-05`;
const pairedAfter = writeMarker(withDue, EID, snapshotOf(parsed(withDue)).hash);

describe("reconcilePair on a collection with Windows line endings", () => {
	it.each([
		["ending in a line break", "\r\n"],
		["with no final line break", ""],
	])("a due date that gained on the log copy lands before the \\r, the collection %s", (_name, tail) => {
		// The lines `run.ts` hands over after it splits the file's text on `\n`:
		// the first keeps its `\r`, and the last keeps one only when a line break
		// follows it. The second line is a task this pair never touches.
		const untouched = "- [ ] Water plants #home";
		const collectionText = `${pairedBase}\r\n${untouched}${tail}`;
		const lines = collectionText.split("\n");
		const lastSynced = snapshotOf(parsed(pairedBase));

		const logLine = `${collectionBase} 📅 2026-11-05 → [[Work]]`;
		const result = reconcilePair(lines[0] as string, logLine, lastSynced);

		expect(result.clash).toBe(false);
		expect(result.log).toBeNull();
		expect(result.collection).not.toBeNull();

		lines[0] = result.collection as string;
		expect(lines.join("\n")).toBe(`${pairedAfter}\r\n${untouched}${tail}`);
	});

	it("the last line's own \\r survives, and the pair's due date lands before it", () => {
		const text = `- [ ] Water plants #home\r\n${pairedBase}\r`;
		const lines = text.split("\n");
		const result = reconcilePair(
			lines[1] as string,
			`${collectionBase} 📅 2026-11-05 → [[Work]]`,
			snapshotOf(parsed(pairedBase)),
		);

		lines[1] = result.collection as string;
		expect(lines.join("\n")).toBe(`- [ ] Water plants #home\r\n${pairedAfter}\r`);
	});
});
