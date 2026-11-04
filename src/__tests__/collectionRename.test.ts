/**
 * Rewriting a renamed collection's name on task lines in the day's logs that
 * carried it (ADR 0003's consequences, sharpened by issue #30 M12; ticket
 * #803).
 *
 * Driven over the real Obsidian stub, not a fake `NoteCaches`, because
 * criterion 3 needs the stub's own rule — every reading method throws unless
 * a suite opts in with `allowReads` — to prove no log is opened when the
 * renamed note was never a collection (`collections.test.ts`'s own header
 * names the same mechanism).
 *
 * Every path, note name and line of text below is invented.
 */

import { describe, expect, it, vi } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin, TFile, Vault as ObsidianVault } from "obsidian";
import { Plugin } from "./__mocks__/obsidian";
import { noteCachesFrom } from "../core/collections";
import { collectionRenameResolvers, rewriteCollectionLinks, watchCollectionRenames } from "../core/collectionRename";
import type { NameIsShared, ResolveBareLink } from "../core/collectionRename";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";

/** A layout with the day's log answered, so `isDailyLogPath` has something to say. */
function layout(change: Partial<VaultLayout> = {}): VaultLayout {
	return {
		...defaultData().core.layout,
		dailyLogFolder: "Journal",
		dailyLogFilename: "YYYY-MM-DD",
		...change,
	};
}

/** A cache holding one heading — enough for `collectionIn` to call the note a collection. */
function collectionCache(headingText = "Tasks"): unknown {
	return {
		headings: [{ heading: headingText, level: 2, position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 0, offset: 0 } } }],
	};
}

interface Started {
	readonly plugin: Plugin;
	readonly writer: NoteWriter;
	readonly problems: Problems;
}

/** The plugin loaded and `watchCollectionRenames` wired the way `main.ts` wires it. */
function start(): Started {
	const plugin = new Plugin();
	const app = plugin.app as unknown as ObsidianApp;
	const notes = noteCachesFrom(plugin as unknown as ObsidianPlugin);
	const writer = new NoteWriter(app.vault as unknown as ObsidianVault, { path: () => null, onChange: () => undefined });
	const problems = new Problems();
	// Issue #935: calls `collectionRenameResolvers`, the same factory `main.ts`
	// calls, so a regression in the factory itself — not only in
	// `rewriteCollectionLinks` — fails this suite. A regression in `main.ts`'s
	// own call to that factory is not covered here.
	const { resolveBareLink, nameIsShared } = collectionRenameResolvers(app);
	watchCollectionRenames(notes, () => layout(), writer, problems.forFeature("core", "Effortless"), resolveBareLink, nameIsShared);
	return { plugin, writer, problems };
}

/** Lets the microtask queue run `count` times, so a hang shows up as a hang. */
async function turns(count = 6): Promise<void> {
	for (let i = 0; i < count; i += 1) await Promise.resolve();
}

describe("rewriteCollectionLinks", () => {
	it("touches only the link, leaving every other byte of the line as it was", () => {
		const line = "  - [/] Copied [[Old name|alias]] ⏳ 2026-01-05 #tag %% eid:abc %%";
		expect(rewriteCollectionLinks(line, "Old name", "New name")).toBe(
			"  - [/] Copied [[New name|alias]] ⏳ 2026-01-05 #tag %% eid:abc %%",
		);
	});

	it("changes nothing when the link already names the new collection — the second rewrite (criterion 2)", () => {
		const line = "- [ ] Already current [[New name]]";
		expect(rewriteCollectionLinks(line, "Old name", "New name")).toBe(line);
	});

	it("leaves a line that is not a task line untouched, even one carrying the old name", () => {
		const line = "# See [[Old name]] for background";
		expect(rewriteCollectionLinks(line, "Old name", "New name")).toBe(line);
	});

	it("rewrites a forwarded line's link, the one edit GLOSSARY.md's Forwarding entry allows it", () => {
		const line = "- [>] Filed this one [[Old name]]";
		expect(rewriteCollectionLinks(line, "Old name", "New name")).toBe("- [>] Filed this one [[New name]]");
	});
});

// Issue #895: a bare tail also names any other note sharing that basename,
// wherever it sits, so it must be resolved — not rewritten on the name alone —
// before the rewriter decides its fate.
describe("rewriteCollectionLinks — a bare link that may still name another note", () => {
	const OLD = "Ideas/Garden shed.md";
	const LOG = "Journal/2026-01-05.md";
	const where = { newPath: "Ideas/Potting shed.md", logPath: LOG };
	const line = "- [ ] x [[Projects/Garden shed]] and [[Garden shed]] and [[Ideas/Garden shed]]";

	it("leaves the bare link when the resolver says its name still opens another, existing note (criterion 1)", () => {
		// Wrong code rewrites the bare tail whenever the name changed, without
		// asking the resolver at all: it would report the bare link rewritten to
		// "Potting shed" too, which this assertion would then fail.
		const resolveBareLink: ResolveBareLink = (name) => (name === "Garden shed" ? "Projects/Garden shed.md" : null);
		expect(rewriteCollectionLinks(line, OLD, "Potting shed", { ...where, resolveBareLink })).toBe(
			"- [ ] x [[Projects/Garden shed]] and [[Garden shed]] and [[Potting shed]]",
		);
	});

	it("rewrites the bare link when the resolver says its name opens nothing — the single-note case does not regress (criterion 2, #803, #819)", () => {
		// A resolver that always answers null asks the same question every call
		// and would report the bare link unrewritten if the "opens nothing ⇒
		// rewrite" half of the rule were missing — the opposite of what this
		// asserts.
		const resolveBareLink: ResolveBareLink = () => null;
		expect(rewriteCollectionLinks(line, OLD, "Potting shed", { ...where, resolveBareLink })).toBe(
			"- [ ] x [[Projects/Garden shed]] and [[Potting shed]] and [[Potting shed]]",
		);
	});

	it("rewrites the bare link as before when no resolver is given at all", () => {
		expect(rewriteCollectionLinks(line, OLD, "Potting shed", where)).toBe(
			"- [ ] x [[Projects/Garden shed]] and [[Potting shed]] and [[Potting shed]]",
		);
	});
});

// Issue #901: the new name a rename gives a collection may itself already
// belong to another note, so a bare `[[New name]]` would open whichever of the
// two Obsidian's own resolution prefers. Told the new name is shared, the
// keeper qualifies the link to the renamed note's own vault path instead.
describe("rewriteCollectionLinks — the new name is already another note's", () => {
	const OLD = "Ideas/Garden shed.md";
	const LOG = "Journal/2026-01-05.md";
	const shared: NameIsShared = (name) => name === "Tool shed";
	const unshared: NameIsShared = () => false;

	/**
	 * What a link's written text would open, the way Obsidian resolves it: a
	 * path that names a folder always opens exactly that note; a bare name
	 * opens whichever of two same-named notes Obsidian's own ambiguous-name
	 * preference names — `preferBareTo` stands in for that preference, which
	 * this suite cannot observe directly.
	 */
	function opensTo(preferBareTo: string, linktext: string): string {
		return linktext.includes("/") ? `${linktext}.md` : linktext === "Tool shed" ? preferBareTo : `${linktext}.md`;
	}

	function linktextOf(line: string): string {
		const match = /\[\[([^\]|#]+)/u.exec(line);
		if (match === null) throw new Error(`no wikilink in: ${line}`);
		return match[1];
	}

	it.each([
		["Obsidian preferring the other note for the bare name", "Projects/Tool shed.md"],
		["Obsidian preferring the renamed note for the bare name", "Ideas/Tool shed.md"],
	])("opens the renamed note however Obsidian would have resolved a bare name — %s (criteria 1, 2)", (_, preferred) => {
		const where = { newPath: "Ideas/Tool shed.md", logPath: LOG, nameIsShared: shared };
		const first = rewriteCollectionLinks("- [>] One [[Ideas/Garden shed]] %% migration:a 1 0 %%", OLD, "Tool shed", where);
		const second = rewriteCollectionLinks("- [>] Two [[Garden shed]] %% migration:b 2 0 %%", OLD, "Tool shed", where);
		// Wrong code writes the bare "[[Tool shed]]" for both, whether the link
		// was itself bare or path-qualified before the rename: resolving that
		// opens whichever note Obsidian's own preference names, failing here
		// whenever that is "Projects/Tool shed.md" rather than the renamed note.
		expect(opensTo(preferred, linktextOf(first))).toBe("Ideas/Tool shed.md");
		expect(opensTo(preferred, linktextOf(second))).toBe("Ideas/Tool shed.md");
	});

	it("keeps the bare name when no other note shares it — the #819 case is unaffected (criterion 3)", () => {
		expect(
			rewriteCollectionLinks("- [>] x [[Garden shed]] %% migration:a 1 0 %%", OLD, "Tool shed", {
				newPath: "Ideas/Tool shed.md",
				logPath: LOG,
				nameIsShared: unshared,
			}),
		).toBe("- [>] x [[Tool shed]] %% migration:a 1 0 %%");
	});

	it("keeps a markdown link's shape and %20 spelling, qualified to the renamed note's own full path, when the new name is shared (criterion 4)", () => {
		// The link carries only two of the renamed note's three path segments.
		// Unshared, that is enough (below): shared, a note could sit at
		// "Projects/Ideas/Tool shed.md" too, so only the full path is safe —
		// proving the fix writes the full path rather than just any path.
		const line = "- [>] Order tea [Garden shed](Ideas/Garden%20shed.md) %% migration:a 1 0 %%";
		const rewrite = (nameIsShared: NameIsShared): string =>
			rewriteCollectionLinks(line, "Work/Ideas/Garden shed.md", "Tool shed", {
				newPath: "Work/Ideas/Tool shed.md",
				logPath: LOG,
				nameIsShared,
			});
		expect(rewrite(unshared)).toBe("- [>] Order tea [Tool shed](Ideas/Tool%20shed.md) %% migration:a 1 0 %%");
		expect(rewrite(shared)).toBe("- [>] Order tea [Tool shed](Work/Ideas/Tool%20shed.md) %% migration:a 1 0 %%");
	});
});

// #896: since #871 the frozen link follows the
// person's link setting, so the keeper meets a markdown link and a relative one as well as a
// wikilink. A link left naming the old path opens nothing; each case below fails on the keeper
// that reads only `[[…]]` by name or by path.
describe("rewriteCollectionLinks — whatever shape the link was written in", () => {
	const OLD = "Ideas/Garden shed.md";
	const LOG = "Journal/2026-01-05.md";
	const move = { newPath: "Ideas/Potting shed.md", logPath: LOG };
	const MARK = "%% migration:k1abcd 0a1b2c3d 0 %%";
	const rewrite = (line: string): string => rewriteCollectionLinks(line, OLD, "Potting shed", move);

	it.each([
		["a markdown link, spaces written %20", `- [>] Order tea [Garden shed](Ideas/Garden%20shed.md) ${MARK}`, `- [>] Order tea [Potting shed](Ideas/Potting%20shed.md) ${MARK}`],
		["a markdown link, the path in angle brackets", `- [>] Order tea [Garden shed](<Ideas/Garden shed.md>) ${MARK}`, `- [>] Order tea [Potting shed](<Ideas/Potting shed.md>) ${MARK}`],
		["a markdown link whose text the person changed", `- [>] Order tea [the shed](Ideas/Garden%20shed.md) ${MARK}`, `- [>] Order tea [the shed](Ideas/Potting%20shed.md) ${MARK}`],
		["a markdown link with a heading and a title", `- [>] Order tea [Garden shed](Ideas/Garden%20shed.md#Seeds "tea") ${MARK}`, `- [>] Order tea [Potting shed](Ideas/Potting%20shed.md#Seeds "tea") ${MARK}`],
		["a wikilink by path", `- [>] Order tea [[Ideas/Garden shed]] ${MARK}`, `- [>] Order tea [[Potting shed]] ${MARK}`],
		["a wikilink by name", `- [>] Order tea [[Garden shed]] ${MARK}`, `- [>] Order tea [[Potting shed]] ${MARK}`],
	])("rewrites %s so it opens the renamed note", (_, line, expected) => {
		expect(rewrite(line)).toBe(expected);
	});

	it("rewrites a relative link from the day's log, keeping it relative", () => {
		expect(rewrite(`- [>] Order tea [[../Ideas/Garden shed]] ${MARK}`)).toBe(`- [>] Order tea [[../Ideas/Potting shed]] ${MARK}`);
		expect(rewrite(`- [>] Order tea [Garden shed](../Ideas/Garden%20shed.md) ${MARK}`)).toBe(
			`- [>] Order tea [Potting shed](../Ideas/Potting%20shed.md) ${MARK}`,
		);
	});

	it("leaves a link to another note of the same name, in a folder the log does not reach, alone", () => {
		const other = `- [>] Order tea [Garden shed](Projects/Garden%20shed.md) and [[../Projects/Garden shed]] ${MARK}`;
		expect(rewrite(other)).toBe(other);
	});

	it("changes nothing the second time", () => {
		const once = rewrite(`- [>] Order tea [Garden shed](Ideas/Garden%20shed.md) ${MARK}`);
		expect(rewrite(once)).toBe(once);
	});

	it("leaves a line that is not a task line alone, whatever shape its link", () => {
		const line = "See [Garden shed](Ideas/Garden%20shed.md)";
		expect(rewrite(line)).toBe(line);
	});

	it("leaves a web link alone", () => {
		const line = `- [>] Order tea [Garden shed](https://example.org/Ideas/Garden%20shed.md) ${MARK}`;
		expect(rewrite(line)).toBe(line);
	});
});

describe("watchCollectionRenames — matching the renamed note, not just its basename", () => {
	it("leaves a same-basename link to a different note untouched, rewriting only the link that named the renamed collection", async () => {
		const { plugin } = start();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Journal/2026-01-05.md" }, { path: "Work/Plans.md" }, { path: "Home/Ideas.md" }];
		metadataCache.caches.set("Work/Plans.md", collectionCache());
		metadataCache.resolvedLinks = {
			"Journal/2026-01-05.md": { "Work/Ideas.md": 1 },
		};
		vault.allowReads({
			"Journal/2026-01-05.md": "- [ ] x [[Home/Ideas]] and [[Work/Ideas]]\n",
		});

		const file = { path: "Work/Plans.md" } as unknown as TFile;
		vault.fire("rename", file, "Work/Ideas.md");
		await turns();

		// If the match were on basename alone, "Home/Ideas" — a different
		// note that only shares a basename with the renamed one — would be
		// rewritten too, the way it wrongly was before this fix.
		expect(await vault.cachedRead({ path: "Journal/2026-01-05.md" })).toBe(
			"- [ ] x [[Home/Ideas]] and [[Plans]]\n",
		);
	});

	// Overturned by #897: this test used to say a
	// move that kept the name left `[[Work/Ideas]]` untouched, which is what stranded a
	// path-qualified link on a folder that no longer holds the note. The #819 point it guarded —
	// a link that names nothing wrong must not be changed, and a qualifier must not be dropped
	// onto one — is kept by the two other links here.
	it("rewrites a path-qualified link after a move that changed no name, and leaves a bare one and another note's alone", async () => {
		const { plugin } = start();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Journal/2026-01-05.md" }, { path: "Projects/Ideas.md" }];
		metadataCache.caches.set("Projects/Ideas.md", collectionCache());
		metadataCache.resolvedLinks = {
			"Journal/2026-01-05.md": { "Work/Ideas.md": 1 },
		};
		vault.allowReads({
			"Journal/2026-01-05.md": "- [ ] x [[Work/Ideas]] and [[Ideas]] and [[Home/Ideas]] and [Ideas](Work/Ideas.md)\n",
		});

		const file = { path: "Projects/Ideas.md" } as unknown as TFile;
		vault.fire("rename", file, "Work/Ideas.md");
		await turns();

		// Only the link that names the old folder is stale: the bare one still opens
		// the note alone, and `Home/Ideas` is a different note.
		expect(await vault.cachedRead({ path: "Journal/2026-01-05.md" })).toBe(
			"- [ ] x [[Projects/Ideas]] and [[Ideas]] and [[Home/Ideas]] and [Ideas](Projects/Ideas.md)\n",
		);
	});
});

// Issue #895: the real resolver `start()` wires — the same
// `metadataCache.getFirstLinkpathDest` call `jump` and `undo` already make —
// is what tells the bare link apart from the twin's own name, not a fake one.
describe("watchCollectionRenames — a bare link left alone for its same-named twin", () => {
	it("leaves a bare link untouched when it now resolves to the twin, real resolver wired end to end", async () => {
		const { plugin } = start();
		const { vault, metadataCache } = plugin.app;
		vault.files = [
			{ path: "Journal/2026-01-05.md" },
			{ path: "Ideas/Potting shed.md" },
			{ path: "Projects/Garden shed.md" },
		];
		metadataCache.caches.set("Ideas/Potting shed.md", collectionCache());
		// Not a collection, but present so the mock's own `getFirstLinkpathDest`
		// — which answers only from the notes it has parsed — can find it.
		metadataCache.caches.set("Projects/Garden shed.md", { headings: [] });
		metadataCache.resolvedLinks = {
			"Journal/2026-01-05.md": { "Ideas/Garden shed.md": 1 },
		};
		vault.allowReads({
			"Journal/2026-01-05.md": "- [ ] x [[Garden shed]]\n",
		});

		const file = { path: "Ideas/Potting shed.md" } as unknown as TFile;
		vault.fire("rename", file, "Ideas/Garden shed.md");
		await turns();

		// If the wiring in `start()` (the way `main.ts` wires it) fell back to
		// rewriting bare links on the name alone, this would read
		// "[[Potting shed]]" instead — the twin's own link retargeted.
		expect(await vault.cachedRead({ path: "Journal/2026-01-05.md" })).toBe("- [ ] x [[Garden shed]]\n");
	});
});

// Issue #901, composed with #895 (already landed, CLAUDE.md's rule about a
// ticket that consumes another ticket's module): the same rename can create a
// shared new name while the log still carries a bare link to the old name's
// own twin. The two resolvers answer two different questions and must not
// step on each other's case.
describe("watchCollectionRenames — a shared new name and an old-name twin together (issue #901, composed with #895)", () => {
	it("leaves the old twin's bare link untouched and qualifies the renamed note's own link to its vault path", async () => {
		const { plugin } = start();
		const { vault, metadataCache } = plugin.app;
		vault.files = [
			{ path: "Journal/2026-01-05.md" },
			{ path: "Ideas/Tool shed.md" },
			{ path: "Projects/Garden shed.md" },
			{ path: "Projects/Tool shed.md" },
		];
		metadataCache.caches.set("Ideas/Tool shed.md", collectionCache());
		// Present so the mock's own `getFirstLinkpathDest` can find them — neither
		// need be a collection for issue #895's or #901's resolver to answer.
		metadataCache.caches.set("Projects/Garden shed.md", { headings: [] });
		metadataCache.caches.set("Projects/Tool shed.md", { headings: [] });
		metadataCache.resolvedLinks = {
			"Journal/2026-01-05.md": { "Ideas/Garden shed.md": 1 },
		};
		vault.allowReads({
			"Journal/2026-01-05.md": "- [>] One [[Ideas/Garden shed]] %% migration:a 1 0 %%\n- [>] Two [[Garden shed]] %% migration:b 2 0 %%\n",
		});

		const file = { path: "Ideas/Tool shed.md" } as unknown as TFile;
		vault.fire("rename", file, "Ideas/Garden shed.md");
		await turns();

		// Without issue #901 the first line would read "[[Tool shed]]" — a bare
		// name Obsidian could equally resolve to "Projects/Tool shed.md" instead
		// of the renamed note. Without issue #895 (already landed) the second
		// line would be rewritten too, stealing a link that still opens the old
		// name's own twin, "Projects/Garden shed.md".
		expect(await vault.cachedRead({ path: "Journal/2026-01-05.md" })).toBe(
			"- [>] One [[Ideas/Tool shed]] %% migration:a 1 0 %%\n- [>] Two [[Garden shed]] %% migration:b 2 0 %%\n",
		);
	});
});

// Issue #927/#934: Obsidian resolves a link's name ignoring letter case
// (`getFirstLinkpathDest`, `node_modules/obsidian/obsidian.d.ts:4411` —
// case-insensitivity is not stated on that line or its doc comment, so this
// is inferred from Obsidian's documented link-resolution behaviour, not
// read off the declaration itself), but `start()`'s own wiring for
// `nameIsShared` — the same shape `main.ts:123` wires — compared names with
// `===`. A twin differing only in letter case was answered "not shared",
// and the rewriter wrote the bare, ambiguous link #901 exists to stop
// writing.
describe("watchCollectionRenames — a same-name twin differing only in letter case", () => {
	it("qualifies the renamed note's own link when the new name is shared only by letter case", async () => {
		const { plugin } = start();
		const { vault, metadataCache } = plugin.app;
		vault.files = [
			{ path: "Journal/2026-01-05.md" },
			{ path: "Ideas/Tool shed.md" },
			{ path: "Projects/tool shed.md" },
		];
		metadataCache.caches.set("Ideas/Tool shed.md", collectionCache());
		// Present so the mock's own `getFirstLinkpathDest` can find it, the
		// same reason the #901 composition test above registers its twins.
		metadataCache.caches.set("Projects/tool shed.md", { headings: [] });
		metadataCache.resolvedLinks = {
			"Journal/2026-01-05.md": { "Ideas/Garden shed.md": 1 },
		};
		vault.allowReads({
			"Journal/2026-01-05.md": "- [>] One [[Ideas/Garden shed]] %% migration:a 1 0 %%\n",
		});

		const file = { path: "Ideas/Tool shed.md" } as unknown as TFile;
		vault.fire("rename", file, "Ideas/Garden shed.md");
		await turns();

		// Wrong code compares names with `===`: "tool shed" !== "Tool shed", so
		// `nameIsShared` answers false and the bare `[[Tool shed]]` is written,
		// which Obsidian's own case-insensitive resolution can open at
		// "Projects/tool shed.md" instead of the renamed note.
		expect(await vault.cachedRead({ path: "Journal/2026-01-05.md" })).toBe(
			"- [>] One [[Ideas/Tool shed]] %% migration:a 1 0 %%\n",
		);
	});
});

describe("watchCollectionRenames — a markdown or relative frozen link", () => {
	it("rewrites both shapes in the log that carried them, given the log's own path", async () => {
		const { plugin } = start();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Journal/2026-01-05.md" }, { path: "Ideas/Potting shed.md" }];
		metadataCache.caches.set("Ideas/Potting shed.md", collectionCache());
		metadataCache.resolvedLinks = { "Journal/2026-01-05.md": { "Ideas/Garden shed.md": 2 } };
		vault.allowReads({
			"Journal/2026-01-05.md": "- [>] One [Garden shed](Ideas/Garden%20shed.md)\n- [>] Two [[../Ideas/Garden shed]]\n",
		});

		vault.fire("rename", { path: "Ideas/Potting shed.md" } as unknown as TFile, "Ideas/Garden shed.md");
		await turns();

		expect(await vault.cachedRead({ path: "Journal/2026-01-05.md" })).toBe(
			"- [>] One [Potting shed](Ideas/Potting%20shed.md)\n- [>] Two [[../Ideas/Potting shed]]\n",
		);
	});
});

describe("watchCollectionRenames — rewriting every day's log that carried the link (criterion 1)", () => {
	it("rewrites the link on task lines across every day's log that carried it, and leaves one that never carried it untouched", async () => {
		const { plugin } = start();
		const { vault, metadataCache } = plugin.app;
		vault.files = [
			{ path: "Journal/2026-01-05.md" },
			{ path: "Journal/2026-01-06.md" },
			{ path: "Journal/2026-01-07.md" },
			{ path: "Projects/New name.md" },
		];
		metadataCache.caches.set("Projects/New name.md", collectionCache());
		metadataCache.resolvedLinks = {
			"Journal/2026-01-05.md": { "Projects/Old name.md": 1 },
			"Journal/2026-01-06.md": { "Projects/Old name.md": 1 },
			// 2026-01-07 never resolved a link to the old note at all.
		};
		vault.allowReads({
			"Journal/2026-01-05.md": "- [ ] Call about the roof [[Old name]] ⏳ 2026-01-05\n- [x] Done already [[Old name]]\n",
			"Journal/2026-01-06.md": "# Anteckningar\n- [>] Filed this one [[Old name]]\n",
			"Journal/2026-01-07.md": "- [ ] Unrelated task, no link here\n",
		});

		const file = { path: "Projects/New name.md" } as unknown as TFile;
		vault.fire("rename", file, "Projects/Old name.md");
		await turns();

		// If the rewrite were wrong — reading a full file instead of the writer's
		// one field, or rebuilding the line — this would show a mangled line
		// rather than the checkbox, the date stamp and the description surviving
		// byte for byte around the one changed link.
		expect(await vault.cachedRead({ path: "Journal/2026-01-05.md" })).toBe(
			"- [ ] Call about the roof [[New name]] ⏳ 2026-01-05\n- [x] Done already [[New name]]\n",
		);
		expect(await vault.cachedRead({ path: "Journal/2026-01-06.md" })).toBe(
			"# Anteckningar\n- [>] Filed this one [[New name]]\n",
		);
		// If the rewrite scanned every day's log rather than only the ones
		// `linkedFrom` names, this would have changed too, even though it holds
		// no link to rewrite.
		expect(await vault.cachedRead({ path: "Journal/2026-01-07.md" })).toBe(
			"- [ ] Unrelated task, no link here\n",
		);
	});
});

describe("watchCollectionRenames — a second rename before Obsidian re-resolves the log", () => {
	it("still finds the log through a second rename fired while resolvedLinks does not yet name it under the note's current path", async () => {
		const { plugin } = start();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Journal/2026-01-05.md" }, { path: "Projects/New name.md" }];
		metadataCache.caches.set("Projects/New name.md", collectionCache());
		metadataCache.resolvedLinks = {
			"Journal/2026-01-05.md": { "Projects/Old name.md": 1 },
		};
		vault.allowReads({
			"Journal/2026-01-05.md": "- [ ] Call about the roof [[Old name]] ⏳ 2026-01-05\n",
		});

		const first = { path: "Projects/New name.md" } as unknown as TFile;
		vault.fire("rename", first, "Projects/Old name.md");
		await turns();
		expect(await vault.cachedRead({ path: "Journal/2026-01-05.md" })).toBe(
			"- [ ] Call about the roof [[New name]] ⏳ 2026-01-05\n",
		);

		// The state the drive record's step 2 read back: Obsidian has not yet
		// re-resolved the log after the plugin's own rewrite, so the second
		// rename's `resolvedLinks` names nothing under "Projects/New name.md".
		// The note itself has moved, the way a real rename already has by the
		// time the event fires, so its cache entry moves with it — the mock's
		// `caches` is set by hand and does not do this on its own (issue #895's
		// bare-link resolver reads it, and a stale entry under the old path
		// would otherwise make "New name" look like it still opens something).
		metadataCache.caches.delete("Projects/New name.md");
		metadataCache.caches.set("Projects/Last name.md", collectionCache());
		metadataCache.resolvedLinks = {};

		const second = { path: "Projects/Last name.md" } as unknown as TFile;
		vault.fire("rename", second, "Projects/New name.md");
		await turns();

		// If the second rename's logs came only from `linkedFrom`, this would
		// still read "[[New name]]" — a note that no longer exists — exactly
		// the failure the drive record shows.
		expect(await vault.cachedRead({ path: "Journal/2026-01-05.md" })).toBe(
			"- [ ] Call about the roof [[Last name]] ⏳ 2026-01-05\n",
		);
	});
});

describe("watchCollectionRenames — never a collection (criterion 3)", () => {
	it("reads no log when the renamed note never carried the tasks heading", async () => {
		const { plugin, writer } = start();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Journal/2026-01-05.md" }, { path: "Notes/Shopping list.md" }];
		metadataCache.caches.set("Notes/Shopping list.md", {
			headings: [{ heading: "Groceries", level: 2, position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 0, offset: 0 } } }],
		});
		metadataCache.resolvedLinks = { "Journal/2026-01-05.md": { "Notes/Old shopping list.md": 1 } };
		// No allowReads() call: any read of the day's log would throw.

		// If the code were wrong — rewriting on every rename rather than only a
		// collection's — this spy would show the day's log's write, whether or
		// not it also threw.
		const edit = vi.spyOn(writer, "edit");
		const file = { path: "Notes/Shopping list.md" } as unknown as TFile;
		vault.fire("rename", file, "Notes/Old shopping list.md");
		await turns();

		expect(edit).not.toHaveBeenCalled();
	});
});

describe("watchCollectionRenames — one log's write fails (criterion 4)", () => {
	it("raises a standing problem naming the old path, and still rewrites the other logs", async () => {
		const { plugin, writer, problems } = start();
		const { vault, metadataCache } = plugin.app;
		vault.files = [
			{ path: "Journal/2026-01-05.md" },
			{ path: "Journal/2026-01-06.md" },
			{ path: "Projects/New name.md" },
		];
		metadataCache.caches.set("Projects/New name.md", collectionCache());
		metadataCache.resolvedLinks = {
			"Journal/2026-01-05.md": { "Projects/Old name.md": 1 },
			"Journal/2026-01-06.md": { "Projects/Old name.md": 1 },
		};
		vault.allowReads({
			"Journal/2026-01-05.md": "- [ ] First [[Old name]]\n",
			"Journal/2026-01-06.md": "- [ ] Second [[Old name]]\n",
		});

		const refused = "this write did not happen";
		vi.spyOn(writer, "edit").mockImplementation((target, edit) => {
			if (target.path === "Journal/2026-01-05.md") return Promise.reject(new Error(refused));
			return vault.process(target, edit);
		});

		const file = { path: "Projects/New name.md" } as unknown as TFile;
		vault.fire("rename", file, "Projects/Old name.md");
		await turns();

		// If the failure were not isolated — one log's rejection stopping the
		// batch — 2026-01-06 would still read its unrewritten "Old name" here.
		expect(await vault.cachedRead({ path: "Journal/2026-01-06.md" })).toBe("- [ ] Second [[New name]]\n");

		const standing = problems.all();
		expect(standing).toHaveLength(1);
		expect(standing[0].key).toBe("Projects/Old name.md");
		expect(standing[0].message).toContain(refused);
		expect(standing[0].message).toContain("Journal/2026-01-05.md");
	});
});
