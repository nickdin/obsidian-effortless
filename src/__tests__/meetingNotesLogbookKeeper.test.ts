/**
 * When the logbook pass runs, one at a time: soon after a
 * meeting note changes, never two at once, a rename taken into the memory
 * before the next pass reads it, nothing once the feature has stopped, and
 * nothing while the logbook heading is refused.
 *
 * Every path is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOGBOOK_SETTLE_MS, LogbookKeeper } from "../features/meetingNotes/logbookKeeper";
import type { LogbookKeeperHost } from "../features/meetingNotes/logbookKeeper";
import type { LogbookPorts } from "../features/meetingNotes/logbook";
import type { LogbookMemory } from "../features/meetingNotes/logbookMemory";

interface Kept {
	host: LogbookKeeperHost;
	saved: LogbookMemory[];
	notices: string[];
	reads: string[];
	texts: Map<string, string>;
}

/** A vault with one collection and one meeting note naming it, behind a keeper host whose logbook line start is `lineStart`. */
function kept(heading: string | null = "## Logbook", memory: LogbookMemory = {}, lineStart: string | null = "-"): Kept {
	const texts = new Map([["Areas/Garden.md", "## Logbook\n"]]);
	const saved: LogbookMemory[] = [];
	const notices: string[] = [];
	const reads: string[] = [];
	let stored = memory;
	const ports = (start: string): LogbookPorts => ({
		caches: {
			paths: () => ["Areas/Garden.md", "M/2026-10-01 Shed.md"],
			frontmatter: (path) => (path === "M/2026-10-01 Shed.md" ? { tags: ["meeting"], effort: "[[Garden]]" } : null),
			resolve: (linkpath) => (linkpath === "Garden" ? "Areas/Garden.md" : null),
			isCollection: (path) => path === "Areas/Garden.md",
			created: () => null,
		},
		hasHeading: () => true,
		exists: (path) => texts.has(path),
		read: async (path) => {
			reads.push(path);
			return texts.get(path) ?? "";
		},
		edit: async (path, edit) => {
			const text = edit(texts.get(path) ?? "");
			texts.set(path, text);
			return text;
		},
		lineFor: (note) => `${start} [[${note.replace(/^.*\//, "").replace(/\.md$/, "")}]]`,
		linksNote: () => false,
	});
	const host: LogbookKeeperHost = {
		ready: () => true,
		heading: () => heading,
		lineStart: () => lineStart,
		template: () => ({ tag: "meeting", effortField: "effort" }),
		memory: () => stored,
		save: async (memory) => {
			stored = memory;
			saved.push(memory);
		},
		ports,
		notice: (message) => notices.push(message),
	};
	return { host, saved, notices, reads, texts };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("LogbookKeeper", () => {
	it("runs one pass a moment after a burst of changes, not one per change", async () => {
		const { host, reads, texts } = kept();
		const keeper = new LogbookKeeper(host);
		keeper.passSoon();
		keeper.passSoon();
		await vi.advanceTimersByTimeAsync(LOGBOOK_SETTLE_MS - 1);
		expect(reads).toEqual([]);
		keeper.passSoon();
		await vi.advanceTimersByTimeAsync(LOGBOOK_SETTLE_MS);
		expect(reads).toEqual(["Areas/Garden.md"]);
		expect(texts.get("Areas/Garden.md")).toBe("## Logbook\n- [[2026-10-01 Shed]]\n");
	});

	it("saves the memory a pass made, and nothing when it made no change", async () => {
		const { host, saved } = kept();
		const keeper = new LogbookKeeper(host);
		await keeper.pass();
		expect(saved).toEqual([{ "Areas/Garden.md": [{ note: "M/2026-10-01 Shed.md", line: "- [[2026-10-01 Shed]]" }] }]);
		await keeper.pass();
		expect(saved).toHaveLength(1);
	});

	it("runs nothing while the logbook heading is refused, and says nothing more than the feature already said", async () => {
		const { host, reads, saved, notices } = kept(null);
		await new LogbookKeeper(host).pass();
		expect(reads).toEqual([]);
		expect(saved).toEqual([]);
		expect(notices).toEqual([]);
	});

	it("runs nothing while the logbook line start is refused, and says nothing more than the feature already said", async () => {
		const { host, reads, saved, notices } = kept("## Logbook", {}, null);
		await new LogbookKeeper(host).pass();
		expect(reads).toEqual([]);
		expect(saved).toEqual([]);
		expect(notices).toEqual([]);
	});

	it("writes each line with the host's logbook line start", async () => {
		const { host, texts } = kept("## Logbook", {}, "- [i]");
		await new LogbookKeeper(host).pass();
		expect(texts.get("Areas/Garden.md")).toBe("## Logbook\n- [i] [[2026-10-01 Shed]]\n");
	});

	it("records a renamed meeting's line in the current line start, and keeps the old line while the start is refused", async () => {
		const memory = { "Areas/Garden.md": [{ note: "M/2026-09-01 Shed.md", line: "- [[2026-09-01 Shed]]" }] };
		const now = kept("## Logbook", memory, "- [i]");
		await new LogbookKeeper(now.host).renamed("M/2026-09-01 Shed.md", "M/2026-10-01 Shed.md");
		expect(now.saved[0]).toEqual({
			"Areas/Garden.md": [{ note: "M/2026-10-01 Shed.md", line: "- [i] [[2026-10-01 Shed]]", was: "- [[2026-09-01 Shed]]" }],
		});

		const refused = kept("## Logbook", memory, null);
		await new LogbookKeeper(refused.host).renamed("M/2026-09-01 Shed.md", "M/2026-10-01 Shed.md");
		expect(refused.saved[0]).toEqual({
			"Areas/Garden.md": [{ note: "M/2026-10-01 Shed.md", line: "- [[2026-09-01 Shed]]", was: "- [[2026-09-01 Shed]]" }],
		});
	});

	it("runs nothing while the feature is not ready", async () => {
		const { host, reads } = kept();
		await new LogbookKeeper({ ...host, ready: () => false }).pass();
		expect(reads).toEqual([]);
	});

	it("takes a rename into the memory before the pass after it, so a line the link updater rewrote stays the feature's", async () => {
		// The meeting note was renamed from 2026-09-01 to 2026-10-01 and the link
		// updater has already rewritten the feature's line to the new name. Only a
		// memory that has followed the rename knows that line as the feature's; one
		// that has not reads it as the person's and owns nothing afterwards.
		const memory = { "Areas/Garden.md": [{ note: "M/2026-09-01 Shed.md", line: "- [[2026-09-01 Shed]]" }] };
		const { host, saved, texts } = kept("## Logbook", memory);
		texts.set("Areas/Garden.md", "## Logbook\n- [[2026-10-01 Shed]]\n");
		const ports = (start: string): LogbookPorts => ({
			...host.ports(start),
			linksNote: (line, note) => line.includes(`[[${note.replace(/^.*\//, "").replace(/\.md$/, "")}]]`),
		});
		const keeper = new LogbookKeeper({ ...host, ports });
		void keeper.renamed("M/2026-09-01 Shed.md", "M/2026-10-01 Shed.md");
		await vi.advanceTimersByTimeAsync(LOGBOOK_SETTLE_MS);

		expect(saved[0]).toEqual({
			"Areas/Garden.md": [{ note: "M/2026-10-01 Shed.md", line: "- [[2026-10-01 Shed]]", was: "- [[2026-09-01 Shed]]" }],
		});
		expect(saved[saved.length - 1]).toEqual({
			"Areas/Garden.md": [{ note: "M/2026-10-01 Shed.md", line: "- [[2026-10-01 Shed]]" }],
		});
		expect(texts.get("Areas/Garden.md")).toBe("## Logbook\n- [[2026-10-01 Shed]]\n");
	});

	it("says so when the memory cannot be saved, and runs the next step", async () => {
		const { host, notices, reads } = kept();
		let fail = true;
		const keeper = new LogbookKeeper({
			...host,
			save: (memory) => (fail ? Promise.reject(new Error("disk full")) : host.save(memory)),
		});
		await keeper.pass();
		expect(notices).toEqual(["Effortless: meeting notes could not keep the logbook: disk full"]);
		fail = false;
		await keeper.pass();
		expect(reads).toHaveLength(2);
	});

	it("runs nothing once stopped, the pending pass included", async () => {
		const { host, reads } = kept();
		const keeper = new LogbookKeeper(host);
		keeper.passSoon();
		keeper.stop();
		await vi.advanceTimersByTimeAsync(LOGBOOK_SETTLE_MS);
		await keeper.pass();
		expect(reads).toEqual([]);
	});

	it("says so when a collection cannot be read, keeps the memory, and runs the next pass", async () => {
		const memory = { "Areas/Garden.md": [{ note: "M/2026-09-01 Old.md", line: "- [[2026-09-01 Old]]" }] };
		const { host, notices, saved, reads } = kept("## Logbook", memory);
		let fail = true;
		const ports = (start: string): LogbookPorts => {
			const real = host.ports(start);
			return { ...real, read: (path) => (fail ? Promise.reject(new Error("disk gone")) : real.read(path)) };
		};
		const keeper = new LogbookKeeper({ ...host, ports });
		await keeper.pass();
		expect(notices).toEqual(["Effortless: meeting notes could not keep the logbook: disk gone"]);
		expect(saved).toEqual([]);
		fail = false;
		await keeper.pass();
		expect(reads).toEqual(["Areas/Garden.md"]);
	});

	it("says once which collections it could not write", async () => {
		const { host, notices } = kept();
		const failing = (start: string): LogbookPorts => ({ ...host.ports(start), edit: () => Promise.reject(new Error("unloaded")) });
		await new LogbookKeeper({ ...host, ports: failing }).pass();
		expect(notices).toEqual([
			"Effortless: meeting notes could not write the logbook in Garden (unloaded), and tries again at its next run.",
		]);
	});
});
