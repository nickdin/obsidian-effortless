/**
 * The log copy's collection link and the jump command, run together: a line the
 * copy-in move writes, with its collection named as ` [[Errands]]` and no
 * arrow, is one the jump command reads back to the collection it came from.
 * Each half has its own tests; this is the composition, which neither half's
 * tests can show — were the jump command still looking for `→`, every line
 * copy-in writes would name no collection.
 *
 * Every task and collection name here is invented.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorPosition } from "obsidian";
import { Notice, resetSettings } from "./__mocks__/obsidian";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { parseTaskLine } from "../core/taskLine";
import { dailyLogFrame } from "../core/vaultLayout";
import { copyIn } from "../features/taskConsistency/copyIn";
import { jumpFromLine, locatePairedLine } from "../features/taskConsistency/jump";
import type { JumpEditor, JumpTarget } from "../features/taskConsistency/jump";
import { readMarker } from "../features/taskConsistency/marker";

beforeEach(() => {
	Notice.messages = [];
	resetSettings();
});

const TODAY = new Date(2026, 8, 22);
const layout: VaultLayout = { ...defaultData().core.layout };

/** A target that resolves only "Errands", records what the jump opened, and hands back an editor over `collectionText` that records where the cursor was put. */
function target(collectionText: string, opened: string[], cursors: EditorPosition[], notices: string[]): JumpTarget {
	const editor: JumpEditor = {
		getValue: () => collectionText,
		setCursor: (pos: EditorPosition) => cursors.push(pos),
	};
	return {
		resolveLink: (linktext) => (linktext === "Errands" ? "Errands.md" : null),
		isCollection: (path) => path === "Errands.md",
		findOpenView: () => null,
		openView: vi.fn(),
		open: async (path) => {
			opened.push(path);
			return editor;
		},
		notify: (message) => notices.push(message),
	};
}

describe("the log copy and the jump command, together", () => {
	const collection = "# Errands\n\n## Tasks\n\n- [ ] Buy stamps ⏳ 2026-09-22\n";

	it("a line copy-in writes names its collection without an arrow, and the jump command opens that collection", async () => {
		const result = copyIn(collection, dailyLogFrame(layout), TODAY, layout, "Errands");
		expect(result.copied).toBe(1);

		const logLine = result.log.split("\n").find((line) => line.includes("Buy stamps"));
		if (logLine === undefined) throw new Error("copy-in wrote no log line");
		// If the arrow were still written, or the jump still looked for one, one of these two would fail.
		expect(logLine).not.toContain("→");
		expect(logLine).toContain(" [[Errands]] %%");

		const line = parseTaskLine(logLine);
		if (line === null) throw new Error("the copied line is not a task line");
		const eid = readMarker(line)?.eid;
		if (eid === undefined) throw new Error("the copied line carries no marker");
		// The collection's own copy carries the same eid for the jump to land on.
		expect(locatePairedLine(result.collection, eid)).not.toBeNull();

		const opened: string[] = [];
		const cursors: EditorPosition[] = [];
		const notices: string[] = [];
		await jumpFromLine(target(result.collection, opened, cursors, notices), "Journal/2026-09-22.md", line);

		expect(notices).toEqual([]);
		expect(opened).toEqual(["Errands.md"]);
		// The cursor lands on the collection's own line for the task, read back from the text the editor held.
		const collectionRow = result.collection.split("\n").findIndex((each) => each.includes("Buy stamps"));
		expect(cursors).toEqual([{ line: collectionRow, ch: 0 }]);
	});
});
