/**
 * Day view's rename: keeping a `schema` block's own links true through a
 * rename Obsidian does not follow into a code block.
 *
 * `renameRewrite` and `isCaseInsensitiveRename` are driven directly, as the
 * pure functions they are. `rescanRenamedLinks` is driven directly too, with
 * an explicit batch and the real host the feature registry builds, so the
 * scoping and writer-routing tests need no fake timer. The batching itself —
 * two renames within 250 ms costing one pass — and the listener's
 * registration through the feature are driven through the real feature
 * registry, over the Obsidian stub, the way `dayView.test.ts` drives the rest
 * of the feature.
 *
 * Every path, meeting name and date below is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	App as ObsidianApp,
	CachedMetadata,
	Plugin as ObsidianPlugin,
	TAbstractFile,
	TFile,
	Vault as ObsidianVault,
} from "obsidian";
import { MarkdownPreviewRenderer, Notice, Plugin, Platform, resetPlatform } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { Collections } from "../core/collections";
import type { FeatureHost } from "../core/feature";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore, defaultData } from "../core/settings";
import { DayView, FEATURE_ID } from "../features/dayView";
import {
	createRenameListener,
	isCaseInsensitiveRename,
	renameRewrite,
	rescanRenamedLinks,
} from "../features/dayView/rename";
import type { RenamePair } from "../features/dayView/rename";

/** A cache holding one code section, the shape a `schema` block reports. */
function cacheWithCodeBlock(): CachedMetadata {
	return {
		sections: [{ type: "code", position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 3, col: 0, offset: 0 } } }],
	};
}

/** A cache holding no code section at all — a note nothing here should read. */
function cacheWithNoCodeBlock(): CachedMetadata {
	return {
		sections: [{ type: "heading", position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 0, offset: 0 } } }],
	};
}

/** A cache holding one callout section — the shape a `schema` block nested inside a callout reports at its root. */
function cacheWithCalloutBlock(): CachedMetadata {
	return {
		sections: [{ type: "callout", position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 3, col: 0, offset: 0 } } }],
	};
}

interface Started {
	readonly plugin: Plugin;
	readonly registry: FeatureRegistry;
	/** The real host the registry built for the day view — the same object `onload` runs with. */
	readonly host: FeatureHost;
}

/**
 * The plugin loaded and the registry started, with day view under its id — as
 * `main.ts` starts it. The note writer is wired to the plugin's own vault, not
 * a second one: this feature reads and writes the same vault, so `allowReads`
 * on one path serves both halves.
 */
async function startDayView(): Promise<Started> {
	const plugin = new Plugin();
	plugin.seedData(defaultData());
	plugin.load();
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const notes = new NoteWriter(plugin.app.vault as unknown as ObsidianVault, {
		path: () => null,
		onChange: () => undefined,
	});
	const calendar: Calendar = { meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} };
	const collections: Collections = { all: () => [], at: () => null };
	const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections, problems: new Problems(), device },
		notes,
		calendar,
	);
	let host: FeatureHost | undefined;
	registry.register(FEATURE_ID, (built: FeatureHost) => {
		host = built;
		return new DayView(built);
	});
	registry.start();
	return { plugin, registry, host: host! };
}

beforeEach(() => {
	resetPlatform();
	MarkdownPreviewRenderer.reset();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("renameRewrite", () => {
	const pair: RenamePair = { oldPath: "Old.md", newPath: "New.md" };

	it("rewrites a plain link [[Old]]", () => {
		const content = "```schema\n| Time | Meeting |\n| --- | --- |\n| 09:00–10:00 | [[Old]] |\n```";
		expect(renameRewrite(content, [pair], false)).toContain("[[New]]");
	});

	it("rewrites an aliased link [[Old|alias]], keeping the alias", () => {
		const content = "```schema\n[[Old|Kickoff]]\n```";
		expect(renameRewrite(content, [pair], false)).toBe("```schema\n[[New|Kickoff]]\n```");
	});

	it("rewrites a table-escaped aliased link [[Old\\|alias]], keeping the escape and the alias", () => {
		const content = "```schema\n[[Old\\|Kickoff]]\n```";
		expect(renameRewrite(content, [pair], false)).toBe("```schema\n[[New\\|Kickoff]]\n```");
	});

	// Was "rewrites a folder-form link [[folder/Old]] to the bare new name",
	// pinning the defect #682 fixes: triage on that ticket found #618 decision
	// 13's "become the new name" describes syntax translation, not a mandate
	// to always drop the folder, and the moment doing so lands a link on an
	// unrelated note it is the same class of correctness bug #667 already
	// fixed for matching. Rewritten again for #688: the first rewrite still
	// dropped the folder whenever the bare new name happened to be unique
	// (asserted through a stubbed `linktextFor` that just handed back the
	// wanted answer); this asserts the real choice `chooseReplacement` makes
	// from the link's own written shape and the vault's own resolution.
	it("keeps a folder-form link's [[folder/Old]] written folder, not always the bare new name", () => {
		const folderPair: RenamePair = { oldPath: "Meetings/Old.md", newPath: "Meetings/New.md" };
		const content = "```schema\n[[Meetings/Old]]\n```";
		// Nothing else in this vault answers to "Meetings/New" or to the bare
		// "New" — the bare name would have been unique — but the link keeps
		// its written folder anyway, because #688 settled that a folder-form
		// link's folder is never dropped for that reason alone.
		const renamedFile = { path: "Meetings/New.md" } as unknown as TFile;
		const resolveLink = (linktext: string): TFile | null => (linktext === "Meetings/New" ? renamedFile : null);
		expect(renameRewrite(content, [folderPair], false, resolveLink)).toBe("```schema\n[[Meetings/New]]\n```");
	});

	it("falls back to the renamed file's full path when a folder-form link's written folder no longer matches where the note lives", () => {
		const folderPair: RenamePair = { oldPath: "A/Target.md", newPath: "B/Notes.md" };
		const content = "```schema\n[[A/Target]]\n```";
		// The note moved from A/ to B/, not merely renamed in place: "A/Notes"
		// (the written folder plus the new basename) resolves to nothing, so
		// the written folder cannot be kept.
		const renamedFile = { path: "B/Notes.md" } as unknown as TFile;
		const resolveLink = (linktext: string): TFile | null => (linktext === "B/Notes" ? renamedFile : null);
		expect(renameRewrite(content, [folderPair], false, resolveLink)).toBe("```schema\n[[B/Notes]]\n```");
	});

	it("leaves a link outside a schema block untouched", () => {
		const content = "See [[Old]] for background.\n\n```schema\n[[Old]]\n```";
		const rewritten = renameRewrite(content, [pair], false);
		expect(rewritten).toContain("See [[Old]] for background.");
		expect(rewritten).toContain("```schema\n[[New]]\n```");
	});

	it("carries every pair of a batch in one pass", () => {
		const content = "```schema\n[[Old]]\n[[Second]]\n```";
		const pairs: RenamePair[] = [pair, { oldPath: "Second.md", newPath: "Third.md" }];
		expect(renameRewrite(content, pairs, false)).toBe("```schema\n[[New]]\n[[Third]]\n```");
	});
});

describe("renameRewrite — the case answer reaches the match, not just the helper", () => {
	const pair: RenamePair = { oldPath: "Old.md", newPath: "New.md" };

	it("rewrites a differently-cased link when case-insensitive matching is on", () => {
		const content = "```schema\n[[old]]\n```";
		expect(renameRewrite(content, [pair], true)).toBe("```schema\n[[New]]\n```");
	});
});

describe("renameRewrite — matching by resolution, not basename text", () => {
	it("leaves a link to a different note that shares the renamed file's basename untouched", () => {
		const pair: RenamePair = { oldPath: "A/Old.md", newPath: "A/New.md" };
		const content = "```schema\n[[B/Old]]\n```";
		// B/Old.md is a real, unrelated note: resolving its own link text still
		// finds it, so the rewrite must leave it alone even though its basename
		// matches the renamed file's.
		const resolveLink = (linktext: string): TFile | null => (linktext === "B/Old" ? ({ path: "B/Old.md" } as unknown as TFile) : null);
		expect(renameRewrite(content, [pair], false, resolveLink)).toBe(content);
	});

	it("still rewrites a link once nothing else answers to its old name", () => {
		const pair: RenamePair = { oldPath: "A/Old.md", newPath: "A/New.md" };
		const content = "```schema\n[[Old]]\n```";
		// A resolver that answers null for everything, including the renamed
		// file's own new path, would (since #690) read as "the renamed note
		// cannot be found" and leave the link untouched — a different case
		// from this test's own point. So this stub, unlike a bare `() =>
		// null`, still answers for the renamed file itself, the way a real
		// vault always can immediately after a rename.
		const renamedFile = { path: "A/New.md" } as unknown as TFile;
		const resolveLink = (linktext: string): TFile | null => (linktext === "A/New" || linktext === "New" ? renamedFile : null);
		expect(renameRewrite(content, [pair], false, resolveLink)).toBe("```schema\n[[New]]\n```");
	});
});

describe("renameRewrite — the replacement text stays a name that resolves to the renamed note", () => {
	it("keeps a bare link bare when the vault says the bare new name still resolves to the renamed note", () => {
		const pair: RenamePair = { oldPath: "A/Old.md", newPath: "A/New.md" };
		const content = "```schema\n[[Old]]\n```";
		const renamedFile = { path: "A/New.md" } as unknown as TFile;
		// No other note claims "New" here, so the bare candidate resolves to
		// the renamed file itself and is kept — the shortest form that still
		// lands correctly.
		const resolveLink = (linktext: string): TFile | null => (linktext === "A/New" || linktext === "New" ? renamedFile : null);
		expect(renameRewrite(content, [pair], false, resolveLink)).toBe("```schema\n[[New]]\n```");
	});

	it("keeps the alias and the table escape when the replacement needs the folder-qualified form", () => {
		const pair: RenamePair = { oldPath: "Meetings/Old.md", newPath: "Meetings/New.md" };
		const content = "```schema\n[[Meetings/Old\\|Kickoff]]\n```";
		const renamedFile = { path: "Meetings/New.md" } as unknown as TFile;
		const resolveLink = (linktext: string): TFile | null => (linktext === "Meetings/New" ? renamedFile : null);
		expect(renameRewrite(content, [pair], false, resolveLink)).toBe("```schema\n[[Meetings/New\\|Kickoff]]\n```");
	});
});

describe("renameRewrite — the renamed file cannot be found at rewrite time", () => {
	it("leaves the link exactly as written and reports the pair, never a bare name that might land on a namesake", () => {
		const pair: RenamePair = { oldPath: "A/Target.md", newPath: "A/Notes.md" };
		const content = "```schema\n[[A/Target]]\n```";
		// Simulates the note having moved again by the time this held edit
		// runs: nothing in the vault answers to the pair's own newPath any
		// more — #690's own scenario, not "no vault to ask".
		const resolveLink = (): TFile | null => null;
		const unresolved: RenamePair[] = [];
		const result = renameRewrite(content, [pair], false, resolveLink, (reported) => unresolved.push(reported));
		expect(result).toBe(content);
		expect(unresolved).toEqual([pair]);
	});
});

describe("rescanRenamedLinks — a pair that names no real file", () => {
	it("leaves a link to an existing namesake note untouched, even for a same-named pair with no extension", async () => {
		const { plugin, host } = await startDayView();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Notes.md" }, { path: "Meetings.md" }];
		metadataCache.caches.set("Notes.md", cacheWithCodeBlock());
		metadataCache.caches.set("Meetings.md", cacheWithCodeBlock());
		vault.allowReads({ "Notes.md": "```schema\n[[Meetings]]\n```", "Meetings.md": "```schema\nsome content\n```" });

		// A folder-shaped pair, the shape createRenameListener must never build
		// (#667 criterion 1, owned by #664+#672) — exercised directly here since
		// this ticket cannot edit that listener. Meetings.md is real and
		// untouched by the "rename", so it still resolves and the link stays put.
		const folderPair: RenamePair = { oldPath: "Meetings", newPath: "Archive" };
		await rescanRenamedLinks(host, [folderPair]);

		expect(await vault.cachedRead({ path: "Notes.md" })).toBe("```schema\n[[Meetings]]\n```");
	});

	// createRenameListener's folder filter (fb5c114, in the listener itself,
	// ahead of the cancelled and chaining logic) stops this before it ever
	// becomes a rename pair. Driven through the real listener, not
	// rescanRenamedLinks directly, so the filter is actually on this test's
	// path. Without it, nothing here names a real file called "Meetings" for
	// the rewrite's own resolve check to find — "nothing resolves" would
	// read, wrongly for a folder rename, as "this was the renamed file," and
	// the link would be rewritten.
	it("leaves a dangling link untouched when the listener sees a folder renamed, not a note", async () => {
		vi.useFakeTimers();
		const { plugin, host } = await startDayView();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Notes.md" }];
		metadataCache.caches.set("Notes.md", cacheWithCodeBlock());
		vault.allowReads({ "Notes.md": "```schema\n[[Meetings]]\n```" });

		const listener = createRenameListener(host);
		// A folder, the way Obsidian's own TFolder differs from a TFile: no
		// `extension` field at all, not merely a wrong one.
		const renamedFolder = { path: "Archive", name: "Archive", children: [] } as unknown as TAbstractFile;
		listener(renamedFolder, "Meetings");
		await vi.advanceTimersByTimeAsync(300);

		expect(await vault.cachedRead({ path: "Notes.md" })).toBe("```schema\n[[Meetings]]\n```");
	});

	// fb5c114's folder filter is `"children" in file || !file.path.endsWith(".md")`
	// — the test above already exercises the `.md` half, since "Archive" fails
	// it too. This one gives a folder stub a path that ends `.md`, so only the
	// `children` half can be what stops it becoming a pair.
	it("leaves a dangling link untouched when the listener sees a folder whose own path happens to end .md", async () => {
		vi.useFakeTimers();
		const { plugin, host } = await startDayView();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Notes.md" }];
		metadataCache.caches.set("Notes.md", cacheWithCodeBlock());
		vault.allowReads({ "Notes.md": "```schema\n[[Meetings]]\n```" });

		const listener = createRenameListener(host);
		const renamedFolder = { path: "Odd.md", name: "Odd.md", children: [] } as unknown as TAbstractFile;
		listener(renamedFolder, "Meetings");
		await vi.advanceTimersByTimeAsync(300);

		expect(await vault.cachedRead({ path: "Notes.md" })).toBe("```schema\n[[Meetings]]\n```");
	});
});

describe("rescanRenamedLinks — end to end: the replacement resolves to the renamed note, not a namesake", () => {
	it("keeps the folder part when the bare new name would resolve to a different, unrelated note", async () => {
		const { plugin, host } = await startDayView();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Log.md" }];
		metadataCache.caches.set("Log.md", cacheWithCodeBlock());
		// Notes.md and A/Notes.md are never scanned themselves — neither is in
		// vault.files — but the vault's own link resolution has to see both,
		// the way it would once Obsidian has indexed the rename: a real root
		// Notes.md already answering to the bare new name, and the renamed
		// file itself at its real new path.
		metadataCache.caches.set("Notes.md", cacheWithNoCodeBlock());
		metadataCache.caches.set("A/Notes.md", cacheWithNoCodeBlock());
		vault.allowReads({ "Log.md": "```schema\n[[A/Target]]\n```" });

		const pair: RenamePair = { oldPath: "A/Target.md", newPath: "A/Notes.md" };
		await rescanRenamedLinks(host, [pair]);

		expect(await vault.cachedRead({ path: "Log.md" })).toBe("```schema\n[[A/Notes]]\n```");
	});

	it("still writes the bare new name for a bare link when nothing else claims it", async () => {
		const { plugin, host } = await startDayView();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Log.md" }];
		metadataCache.caches.set("Log.md", cacheWithCodeBlock());
		metadataCache.caches.set("A/Notes.md", cacheWithNoCodeBlock());
		vault.allowReads({ "Log.md": "```schema\n[[Target]]\n```" });

		const pair: RenamePair = { oldPath: "A/Target.md", newPath: "A/Notes.md" };
		await rescanRenamedLinks(host, [pair]);

		expect(await vault.cachedRead({ path: "Log.md" })).toBe("```schema\n[[Notes]]\n```");
	});

	// Was "still writes the bare new name when nothing else claims it", with
	// this same folder-form input — the exact test #688 named as pinning its
	// own defect, since a folder-form link keeping the bare new name here was
	// never about a namesake, just about the bare name happening to be
	// unique. Split from the bare-link case above and rewritten to assert the
	// kept folder.
	it("keeps a folder-form link's folder even when the bare new name is unique", async () => {
		const { plugin, host } = await startDayView();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Log.md" }];
		metadataCache.caches.set("Log.md", cacheWithCodeBlock());
		metadataCache.caches.set("A/Notes.md", cacheWithNoCodeBlock());
		vault.allowReads({ "Log.md": "```schema\n[[A/Target]]\n```" });

		const pair: RenamePair = { oldPath: "A/Target.md", newPath: "A/Notes.md" };
		await rescanRenamedLinks(host, [pair]);

		expect(await vault.cachedRead({ path: "Log.md" })).toBe("```schema\n[[A/Notes]]\n```");
	});
});

describe("rescanRenamedLinks — a held rewrite whose renamed note has moved again by the time it runs", () => {
	beforeEach(() => {
		Notice.messages = [];
	});

	it("leaves the link exactly as written and shows a notice naming the note, never the bare new name a namesake could swallow", async () => {
		const { plugin, host } = await startDayView();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Log.md" }];
		metadataCache.caches.set("Log.md", cacheWithCodeBlock());
		// A root Notes.md exists — the exact note a silent bare-name fallback
		// would have wrongly landed this link on before this fix.
		metadataCache.caches.set("Notes.md", cacheWithNoCodeBlock());
		vault.allowReads({ "Log.md": "```schema\n[[A/Target]]\n```" });

		// The pair claims the note is now at A/Notes.md, but nothing answers
		// to that path — it moved again (to some third path) before this
		// held edit ran, the scenario #690's own body describes.
		const pair: RenamePair = { oldPath: "A/Target.md", newPath: "A/Notes.md" };
		await rescanRenamedLinks(host, [pair]);

		expect(await vault.cachedRead({ path: "Log.md" })).toBe("```schema\n[[A/Target]]\n```");
		expect(Notice.messages).toEqual([
			"Effortless could not find the renamed note (was A/Target.md, now A/Notes.md) to update a link to it in: Log.md",
		]);
	});
});

describe("rescanRenamedLinks — every written shape survives two renames", () => {
	it("a bare link, a folder-form link, and the full-path form a collision forces are each found again by the next rename", async () => {
		const { plugin, host } = await startDayView();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Log.md" }];
		metadataCache.caches.set("Log.md", cacheWithCodeBlock());
		// The root namesake stays in the vault throughout both renames — the
		// reason the third link needs a folder-qualified form at all.
		metadataCache.caches.set("Notes.md", cacheWithNoCodeBlock());
		vault.allowReads({
			"Log.md": "```schema\n| Bare | [[Bare]] |\n| Folder | [[A/Folder]] |\n| Collides | [[Collide]] |\n```",
		});

		metadataCache.caches.set("A/Bare2.md", cacheWithNoCodeBlock());
		metadataCache.caches.set("A/Folder2.md", cacheWithNoCodeBlock());
		metadataCache.caches.set("A/Notes.md", cacheWithNoCodeBlock());
		await rescanRenamedLinks(host, [
			{ oldPath: "A/Bare.md", newPath: "A/Bare2.md" },
			{ oldPath: "A/Folder.md", newPath: "A/Folder2.md" },
			{ oldPath: "A/Collide.md", newPath: "A/Notes.md" },
		]);
		expect(await vault.cachedRead({ path: "Log.md" })).toBe(
			"```schema\n| Bare | [[Bare2]] |\n| Folder | [[A/Folder2]] |\n| Collides | [[A/Notes]] |\n```",
		);

		metadataCache.caches.delete("A/Bare2.md");
		metadataCache.caches.delete("A/Folder2.md");
		metadataCache.caches.delete("A/Notes.md");
		metadataCache.caches.set("A/Bare3.md", cacheWithNoCodeBlock());
		metadataCache.caches.set("A/Folder3.md", cacheWithNoCodeBlock());
		metadataCache.caches.set("A/Final.md", cacheWithNoCodeBlock());
		await rescanRenamedLinks(host, [
			{ oldPath: "A/Bare2.md", newPath: "A/Bare3.md" },
			{ oldPath: "A/Folder2.md", newPath: "A/Folder3.md" },
			{ oldPath: "A/Notes.md", newPath: "A/Final.md" },
		]);
		expect(await vault.cachedRead({ path: "Log.md" })).toBe(
			"```schema\n| Bare | [[Bare3]] |\n| Folder | [[A/Folder3]] |\n| Collides | [[A/Final]] |\n```",
		);
	});
});

describe("schema block detection — tilde fences, nesting and case", () => {
	const pair: RenamePair = { oldPath: "Old.md", newPath: "New.md" };

	it("rewrites a link inside a tilde-fenced schema block", () => {
		const content = "~~~schema\n[[Old]]\n~~~";
		expect(renameRewrite(content, [pair], false)).toBe("~~~schema\n[[New]]\n~~~");
	});

	it("rewrites a link inside a schema block nested in a callout", () => {
		const content = "> [!note]\n> ```schema\n> [[Old]]\n> ```";
		expect(renameRewrite(content, [pair], false)).toBe("> [!note]\n> ```schema\n> [[New]]\n> ```");
	});

	it("rewrites a link inside a differently-cased fence label", () => {
		const content = "```Schema\n[[Old]]\n```";
		expect(renameRewrite(content, [pair], false)).toBe("```Schema\n[[New]]\n```");
	});

	it("the scoped scan reads a note whose only schema block is nested inside a callout", async () => {
		const { plugin, host } = await startDayView();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Nested.md" }];
		metadataCache.caches.set("Nested.md", cacheWithCalloutBlock());
		vault.allowReads({ "Nested.md": "> [!note]\n> ```schema\n> [[Old]]\n> ```" });

		const edit = vi.spyOn(host.notes, "edit");
		await rescanRenamedLinks(host, [pair]);

		expect(edit).toHaveBeenCalledTimes(1);
	});
});

describe("isCaseInsensitiveRename", () => {
	it("matches without regard to capitals on Windows desktop", () => {
		Platform.isDesktopApp = true;
		Platform.isWin = true;
		Platform.isMacOS = false;
		Platform.isMobile = false;
		expect(isCaseInsensitiveRename()).toBe(true);
	});

	it("matches without regard to capitals on macOS desktop", () => {
		Platform.isDesktopApp = true;
		Platform.isWin = false;
		Platform.isMacOS = true;
		Platform.isMobile = false;
		expect(isCaseInsensitiveRename()).toBe(true);
	});

	it("matches with regard to capitals on Linux desktop", () => {
		Platform.isDesktopApp = true;
		Platform.isWin = false;
		Platform.isMacOS = false;
		Platform.isMobile = false;
		expect(isCaseInsensitiveRename()).toBe(false);
	});

	it("matches with regard to capitals on a phone answering isMacOS true", () => {
		Platform.isDesktopApp = false;
		Platform.isWin = false;
		Platform.isMacOS = true;
		Platform.isMobile = true;
		expect(isCaseInsensitiveRename()).toBe(false);
	});
});

describe("rescanRenamedLinks — the scoped scan", () => {
	const pair: RenamePair = { oldPath: "Old.md", newPath: "New.md" };

	it("never reads a note whose cached sections hold no code block", async () => {
		const { plugin, host } = await startDayView();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "NoCode.md" }];
		metadataCache.caches.set("NoCode.md", cacheWithNoCodeBlock());
		// No entry for NoCode.md: a read of it would throw, proving none happened.
		vault.allowReads({});

		await rescanRenamedLinks(host, [pair]);
	});

	it("reads a note not yet in the metadata cache", async () => {
		const { plugin, host } = await startDayView();
		const { vault } = plugin.app;
		vault.files = [{ path: "Unindexed.md" }];
		// metadataCache.getCache("Unindexed.md") answers null: nothing set for it.
		vault.allowReads({ "Unindexed.md": "no schema block here" });

		const cachedRead = vi.spyOn(vault, "cachedRead");
		await rescanRenamedLinks(host, [pair]);

		expect(cachedRead).toHaveBeenCalledTimes(1);
	});

	it("reads a note with a code block but no matching link, and does not write it", async () => {
		const { plugin, host } = await startDayView();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Unrelated.md" }];
		metadataCache.caches.set("Unrelated.md", cacheWithCodeBlock());
		vault.allowReads({ "Unrelated.md": "```schema\n[[SomethingElse]]\n```" });

		const cachedRead = vi.spyOn(vault, "cachedRead");
		const process = vi.spyOn(vault, "process");
		await rescanRenamedLinks(host, [pair]);

		expect(cachedRead).toHaveBeenCalledTimes(1);
		expect(process).not.toHaveBeenCalled();
	});

	it("routes a matching rewrite through the core's note writer, never the vault directly", async () => {
		const { plugin, host } = await startDayView();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Matching.md" }];
		metadataCache.caches.set("Matching.md", cacheWithCodeBlock());
		vault.allowReads({ "Matching.md": "```schema\n[[Old]]\n```" });

		const edit = vi.spyOn(host.notes, "edit");
		const process = vi.spyOn(vault, "process");
		await rescanRenamedLinks(host, [pair]);

		expect(edit).toHaveBeenCalledTimes(1);
		expect(edit.mock.calls[0][0]).toEqual({ path: "Matching.md" });
		// process is the writer's own route to the vault; this shows the rewrite
		// reached the vault through the writer's single call, not a second one of
		// rename.ts's own.
		expect(process).toHaveBeenCalledTimes(1);
	});
});

describe("rescanRenamedLinks — starting every edit before awaiting any", () => {
	const pair: RenamePair = { oldPath: "Old.md", newPath: "New.md" };

	it("calls a later file's edit without waiting for an earlier file's held edit to resolve", async () => {
		const { plugin, host } = await startDayView();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Held.md" }, { path: "Free.md" }];
		metadataCache.caches.set("Held.md", cacheWithCodeBlock());
		metadataCache.caches.set("Free.md", cacheWithCodeBlock());
		vault.allowReads({ "Held.md": "```schema\n[[Old]]\n```", "Free.md": "```schema\n[[Old]]\n```" });

		const heldResult = "held-result";
		const freeResult = "free-result";
		let releaseHeld: (() => void) | undefined;
		const held = new Promise<string>((settle) => {
			releaseHeld = () => settle(heldResult);
		});
		const edit = vi.spyOn(host.notes, "edit").mockImplementation((file) => (file.path === "Held.md" ? held : Promise.resolve(freeResult)));

		let scanFinished = false;
		const scan = rescanRenamedLinks(host, [pair]).then(() => {
			scanFinished = true;
		});

		// Flush the microtask queue several times over without ever releasing
		// Held.md, so a sequential implementation (awaiting Held.md's edit before
		// starting Free.md's) would still be stuck here.
		for (let i = 0; i < 5; i++) await Promise.resolve();

		expect(edit.mock.calls.map((call) => call[0].path)).toContain("Free.md");
		expect(scanFinished).toBe(false);

		releaseHeld!();
		await scan;
		expect(scanFinished).toBe(true);
	});

	it("still rewrites every matching file when none is held", async () => {
		const { plugin, host } = await startDayView();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "First.md" }, { path: "Second.md" }];
		metadataCache.caches.set("First.md", cacheWithCodeBlock());
		metadataCache.caches.set("Second.md", cacheWithCodeBlock());
		// The renamed file itself, so the vault can say where it is now —
		// unrelated to what this test checks, but needed since #690 for any
		// rewrite to happen at all rather than being left as it is.
		metadataCache.caches.set("New.md", cacheWithNoCodeBlock());
		vault.allowReads({ "First.md": "```schema\n[[Old]]\n```", "Second.md": "```schema\n[[Old]]\n```" });

		await rescanRenamedLinks(host, [pair]);

		expect(await vault.cachedRead({ path: "First.md" })).toBe("```schema\n[[New]]\n```");
		expect(await vault.cachedRead({ path: "Second.md" })).toBe("```schema\n[[New]]\n```");
	});
});

describe("rescanRenamedLinks — isolating one file's failure", () => {
	const pair: RenamePair = { oldPath: "Old.md", newPath: "New.md" };

	beforeEach(() => {
		Notice.messages = [];
	});

	it("still rewrites every other matching file when one file's edit rejects", async () => {
		const { plugin, host } = await startDayView();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Failing.md" }, { path: "Ok.md" }];
		metadataCache.caches.set("Failing.md", cacheWithCodeBlock());
		metadataCache.caches.set("Ok.md", cacheWithCodeBlock());
		metadataCache.caches.set("New.md", cacheWithNoCodeBlock());
		vault.allowReads({ "Failing.md": "```schema\n[[Old]]\n```", "Ok.md": "```schema\n[[Old]]\n```" });

		// The wording NoteWriter.teardown rejects a held write with, simulating
		// the plugin unloading while this file's write was waiting.
		const unloaded = "Effortless: this write did not happen. The plugin was unloaded while the write was waiting for you to leave the note.";
		vi.spyOn(host.notes, "edit").mockImplementation(async (file, edit) => {
			if (file.path === "Failing.md") throw new Error(unloaded);
			return vault.process(file, edit);
		});

		await expect(rescanRenamedLinks(host, [pair])).resolves.toBeUndefined();

		expect(await vault.cachedRead({ path: "Ok.md" })).toBe("```schema\n[[New]]\n```");
	});

	it("shows one Notice naming the note that was not updated, and rejects nothing", async () => {
		const { plugin, host } = await startDayView();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Failing.md" }];
		metadataCache.caches.set("Failing.md", cacheWithCodeBlock());
		vault.allowReads({ "Failing.md": "```schema\n[[Old]]\n```" });

		const refused = "Effortless: this write did not happen.";
		vi.spyOn(host.notes, "edit").mockRejectedValue(new Error(refused));

		await expect(rescanRenamedLinks(host, [pair])).resolves.toBeUndefined();

		expect(Notice.messages).toEqual(["Effortless could not update this note after the rename: Failing.md"]);
	});

	it("shows no Notice when nothing fails", async () => {
		const { plugin, host } = await startDayView();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Matching.md" }];
		metadataCache.caches.set("Matching.md", cacheWithCodeBlock());
		metadataCache.caches.set("New.md", cacheWithNoCodeBlock());
		vault.allowReads({ "Matching.md": "```schema\n[[Old]]\n```" });

		await rescanRenamedLinks(host, [pair]);

		expect(Notice.messages).toEqual([]);
	});
});

describe("rescanRenamedLinks — the scan threads Platform's own answer through to the rewrite", () => {
	it("rewrites a differently-cased link end-to-end when Platform says this device matches without regard to capitals", async () => {
		Platform.isDesktopApp = true;
		Platform.isWin = true;
		Platform.isMacOS = false;
		Platform.isMobile = false;

		const { plugin, host } = await startDayView();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Matching.md" }];
		metadataCache.caches.set("Matching.md", cacheWithCodeBlock());
		metadataCache.caches.set("New.md", cacheWithNoCodeBlock());
		vault.allowReads({ "Matching.md": "```schema\n[[old]]\n```" });

		const pair: RenamePair = { oldPath: "Old.md", newPath: "New.md" };
		await rescanRenamedLinks(host, [pair]);

		expect(await vault.cachedRead({ path: "Matching.md" })).toBe("```schema\n[[New]]\n```");
	});
});

describe("createRenameListener — the batch", () => {
	it("collects two renames within 250 ms into one batch and one pass over the vault", async () => {
		vi.useFakeTimers();
		const { plugin, host } = await startDayView();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Matching.md" }];
		metadataCache.caches.set("Matching.md", cacheWithCodeBlock());
		metadataCache.caches.set("First-renamed.md", cacheWithNoCodeBlock());
		metadataCache.caches.set("Second-renamed.md", cacheWithNoCodeBlock());
		vault.allowReads({ "Matching.md": "```schema\n[[First]]\n[[Second]]\n```" });

		const getMarkdownFiles = vi.spyOn(vault, "getMarkdownFiles");
		const listener = createRenameListener(host);
		const asRenamed = (path: string): TAbstractFile => ({ path }) as unknown as TAbstractFile;

		listener(asRenamed("First-renamed.md"), "First.md");
		await vi.advanceTimersByTimeAsync(100);
		listener(asRenamed("Second-renamed.md"), "Second.md");
		await vi.advanceTimersByTimeAsync(300);

		expect(getMarkdownFiles).toHaveBeenCalledTimes(1);
		expect(await vault.cachedRead({ path: "Matching.md" })).toBe("```schema\n[[First-renamed]]\n[[Second-renamed]]\n```");
	});
});

describe("the listener's registration", () => {
	it("is registered from onload and is gone after the feature is switched off", async () => {
		const { plugin, registry } = await startDayView();
		expect(plugin.app.vault.names()).toContain("rename");

		await registry.setEnabled(FEATURE_ID, false);
		expect(plugin.app.vault.names()).not.toContain("rename");
	});
});

describe("createRenameListener — cancelling a pending batch", () => {
	const asRenamed = (path: string): TAbstractFile => ({ path }) as unknown as TAbstractFile;

	it("cancel drops a pending batch before its 250 ms timer fires", async () => {
		vi.useFakeTimers();
		const { plugin, host } = await startDayView();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Matching.md" }];
		metadataCache.caches.set("Matching.md", cacheWithCodeBlock());
		vault.allowReads({ "Matching.md": "```schema\n[[Old]]\n```" });

		const getMarkdownFiles = vi.spyOn(vault, "getMarkdownFiles");
		const listener = createRenameListener(host);

		listener(asRenamed("New.md"), "Old.md");
		(listener as unknown as { cancel: () => void }).cancel();
		await vi.advanceTimersByTimeAsync(300);

		expect(getMarkdownFiles).not.toHaveBeenCalled();
		expect(await vault.cachedRead({ path: "Matching.md" })).toBe("```schema\n[[Old]]\n```");
	});

	it("still runs the batch when cancel is never called (no regression)", async () => {
		vi.useFakeTimers();
		const { plugin, host } = await startDayView();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Matching.md" }];
		metadataCache.caches.set("Matching.md", cacheWithCodeBlock());
		metadataCache.caches.set("New.md", cacheWithNoCodeBlock());
		vault.allowReads({ "Matching.md": "```schema\n[[Old]]\n```" });

		const listener = createRenameListener(host);

		listener(asRenamed("New.md"), "Old.md");
		await vi.advanceTimersByTimeAsync(300);

		expect(await vault.cachedRead({ path: "Matching.md" })).toBe("```schema\n[[New]]\n```");
	});
});

describe("the feature ties the batch timer to its own lifecycle", () => {
	it("switching Day view off before the 250 ms timer fires stops the batch from running", async () => {
		vi.useFakeTimers();
		const { plugin, registry } = await startDayView();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Matching.md" }];
		metadataCache.caches.set("Matching.md", cacheWithCodeBlock());
		vault.allowReads({ "Matching.md": "```schema\n[[Old]]\n```" });

		const getMarkdownFiles = vi.spyOn(vault, "getMarkdownFiles");
		const renameListener = vault.listeners.find(([name]) => name === "rename")?.[1] as
			| ((file: TAbstractFile, oldPath: string) => void)
			| undefined;
		expect(renameListener).toBeDefined();

		renameListener!({ path: "New.md" } as unknown as TAbstractFile, "Old.md");
		await registry.setEnabled(FEATURE_ID, false);
		await vi.advanceTimersByTimeAsync(300);

		expect(getMarkdownFiles).not.toHaveBeenCalled();
		expect(await vault.cachedRead({ path: "Matching.md" })).toBe("```schema\n[[Old]]\n```");
	});
});

describe("createRenameListener — chaining an overlapping batch onto the one in flight", () => {
	const asRenamed = (path: string): TAbstractFile => ({ path }) as unknown as TAbstractFile;

	it("a rename and a quick rename back never leave a link to the middle name", async () => {
		vi.useFakeTimers();
		const { plugin, host } = await startDayView();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Link.md" }];
		metadataCache.caches.set("Link.md", cacheWithCodeBlock());
		// The note is back at Original.md by the time either batch's rewrite
		// actually runs, below — both renames have already happened in the
		// app before batch 1's held write is released, so this is the one
		// realistic cache state for the whole test, not just its ending.
		metadataCache.caches.set("Original.md", cacheWithNoCodeBlock());
		vault.allowReads({ "Link.md": "```schema\n[[Original]]\n```" });

		// Holds batch 1's write to Link.md open, so batch 2's own scan can be
		// made to start (or, once fixed, wait to start) while batch 1 has not
		// yet landed its rewrite — the overlap the ticket describes.
		let releaseFirstWrite: (() => void) | undefined;
		const firstWriteHeld = new Promise<void>((settle) => {
			releaseFirstWrite = settle;
		});
		let editCalls = 0;
		vi.spyOn(host.notes, "edit").mockImplementation(async (file, edit) => {
			editCalls++;
			if (editCalls === 1) await firstWriteHeld;
			return vault.process(file, edit);
		});

		const listener = createRenameListener(host);

		// Batch 1: Original.md -> Renamed.md.
		listener(asRenamed("Renamed.md"), "Original.md");
		await vi.advanceTimersByTimeAsync(250);
		// Lets batch 1 reach and stall at its held write to Link.md.
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(editCalls).toBe(1);

		// The typo fix, a few seconds later in the app but still well after
		// batch 1's own 250 ms window: Renamed.md -> Original.md, its own batch.
		listener(asRenamed("Original.md"), "Renamed.md");
		await vi.advanceTimersByTimeAsync(250);
		for (let i = 0; i < 5; i++) await Promise.resolve();

		// Batch 1's write finally lands, seeing the vault as it really is by
		// now (#690's own point): "Original" already resolves, so batch 1
		// leaves the link exactly as written rather than rewriting it to
		// "Renamed" and back — there is never a "[[Renamed]]" for batch 2 to
		// find, so only batch 1's own edit call happens. Flushed rather than
		// counted: the chain from batch 1's write settling to its own promise
		// resolving crosses several links (Promise.all, host.notes.edit,
		// vault.process), and a fixed number of microtask flushes is fragile
		// against exactly how many.
		releaseFirstWrite!();
		for (let i = 0; i < 50; i++) await Promise.resolve();
		expect(editCalls).toBe(1);

		expect(await vault.cachedRead({ path: "Link.md" })).toBe("```schema\n[[Original]]\n```");
	});

	it("two well-separated renames each still run their own full batch (no regression)", async () => {
		vi.useFakeTimers();
		const { plugin, host } = await startDayView();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Link.md" }];
		metadataCache.caches.set("Link.md", cacheWithCodeBlock());
		metadataCache.caches.set("Beta.md", cacheWithNoCodeBlock());
		vault.allowReads({ "Link.md": "```schema\n[[Alpha]]\n```" });

		const listener = createRenameListener(host);

		listener(asRenamed("Beta.md"), "Alpha.md");
		await vi.advanceTimersByTimeAsync(300);
		expect(await vault.cachedRead({ path: "Link.md" })).toBe("```schema\n[[Beta]]\n```");

		// Beta.md no longer exists once it becomes Gamma.md — matching a real
		// vault, and needed so the next rewrite's own old-name check
		// does not read Beta.md as still answering to "Beta".
		metadataCache.caches.delete("Beta.md");
		metadataCache.caches.set("Gamma.md", cacheWithNoCodeBlock());
		listener(asRenamed("Gamma.md"), "Beta.md");
		await vi.advanceTimersByTimeAsync(300);
		expect(await vault.cachedRead({ path: "Link.md" })).toBe("```schema\n[[Gamma]]\n```");
	});
});

describe("createRenameListener — a later batch is not stalled behind an earlier batch's held write to an unrelated file", () => {
	const asRenamed = (path: string): TAbstractFile => ({ path }) as unknown as TAbstractFile;

	it("rewrites a closed note the second rename touches while the first rename's write to the open note is still held", async () => {
		vi.useFakeTimers();
		const { plugin, host } = await startDayView();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "OpenLog.md" }, { path: "ClosedNote.md" }];
		metadataCache.caches.set("OpenLog.md", cacheWithCodeBlock());
		metadataCache.caches.set("ClosedNote.md", cacheWithCodeBlock());
		metadataCache.caches.set("Second-renamed.md", cacheWithNoCodeBlock());
		vault.allowReads({ "OpenLog.md": "```schema\n[[First]]\n```", "ClosedNote.md": "```schema\n[[Second]]\n```" });

		// OpenLog.md's write is never released in this test at all — the
		// person never leaves the note. ClosedNote.md's own write goes
		// through the vault for real, since nothing holds it.
		let openEditCalls = 0;
		const openHeldForever = new Promise<string>(() => {});
		vi.spyOn(host.notes, "edit").mockImplementation((file, edit) => {
			if (file.path === "OpenLog.md") {
				openEditCalls++;
				return openHeldForever;
			}
			return vault.process(file, edit);
		});

		const listener = createRenameListener(host);

		// Batch 1: renames First.md, which only OpenLog.md links to.
		listener(asRenamed("First-renamed.md"), "First.md");
		await vi.advanceTimersByTimeAsync(250);
		// Lets batch 1 reach and stall at its held write to OpenLog.md.
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(openEditCalls).toBe(1);

		// Batch 2, ten minutes later in the app: renames Second.md, which
		// only ClosedNote.md links to — a file batch 1 never touches.
		// OpenLog.md's write above is still held, and stays that way.
		listener(asRenamed("Second-renamed.md"), "Second.md");
		await vi.advanceTimersByTimeAsync(250);
		for (let i = 0; i < 20; i++) await Promise.resolve();

		expect(await vault.cachedRead({ path: "ClosedNote.md" })).toBe("```schema\n[[Second-renamed]]\n```");
	});
});
