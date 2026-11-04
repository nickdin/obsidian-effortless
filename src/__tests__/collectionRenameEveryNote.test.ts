/**
 * The collection-rename rewrite reaches every note that links to the renamed
 * collection and is not itself a collection, not only the day's logs (issue
 * #982, spec #980 decision 3, third bullet). Same harness as
 * `collectionRename.test.ts`: the real Obsidian stub, `watchCollectionRenames`
 * wired the way `main.ts` wires it.
 *
 * The frozen line in each fixture is written by hand; the filing that writes
 * one outside a day's log is issue #981's. Every path, name and line below is
 * invented.
 */

import { describe, expect, it } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin, TFile, Vault as ObsidianVault } from "obsidian";
import { Plugin } from "./__mocks__/obsidian";
import { noteCachesFrom } from "../core/collections";
import { collectionRenameResolvers, watchCollectionRenames } from "../core/collectionRename";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";

function layout(change: Partial<VaultLayout> = {}): VaultLayout {
	return { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD", ...change };
}

/** A cache holding the tasks heading, enough for `collectionIn` to call the note a collection. */
function collectionCache(): unknown {
	return { headings: [{ heading: "Tasks", level: 2, position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 0, offset: 0 } } }] };
}

function start(change: Partial<VaultLayout> = {}): Plugin {
	const plugin = new Plugin();
	const app = plugin.app as unknown as ObsidianApp;
	const notes = noteCachesFrom(plugin as unknown as ObsidianPlugin);
	const writer = new NoteWriter(app.vault as unknown as ObsidianVault, { path: () => null, onChange: () => undefined });
	const { resolveBareLink, nameIsShared } = collectionRenameResolvers(app);
	watchCollectionRenames(notes, () => layout(change), writer, new Problems().forFeature("core", "Effortless"), resolveBareLink, nameIsShared);
	return plugin;
}

async function turns(count = 6): Promise<void> {
	for (let i = 0; i < count; i += 1) await Promise.resolve();
}

const FROZEN = "- [>] Book the venue [[Old name]] %% migration:k1 abc %%\n";
const FROZEN_RENAMED = "- [>] Book the venue [[New name]] %% migration:k1 abc %%\n";

describe("watchCollectionRenames — every note that links to the collection", () => {
	it("rewrites a frozen link in an ordinary note, and leaves an ordinary note's plain link with no frozen line byte for byte", async () => {
		const plugin = start();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Meetings/Kickoff.md" }, { path: "Reading/Book.md" }, { path: "Projects/New name.md" }];
		metadataCache.caches.set("Projects/New name.md", collectionCache());
		metadataCache.resolvedLinks = {
			"Meetings/Kickoff.md": { "Projects/Old name.md": 1 },
			"Reading/Book.md": { "Projects/Old name.md": 1 },
		};
		const plain = "Background in [[Old name]] and a task:\n- [ ] Read chapter two\n\nSee also [[Old name]].\n";
		vault.allowReads({
			"Meetings/Kickoff.md": `# Kickoff\n${FROZEN}`,
			"Reading/Book.md": plain,
		});

		vault.fire("rename", { path: "Projects/New name.md" } as unknown as TFile, "Projects/Old name.md");
		await turns();

		// Wrong code (day's logs only) leaves the meeting note reading `[[Old name]]`.
		expect(await vault.cachedRead({ path: "Meetings/Kickoff.md" })).toBe(`# Kickoff\n${FROZEN_RENAMED}`);
		// Wrong code that rewrote a plain link would show `[[New name]]` in the
		// prose line here; the assertion is on the whole file's bytes.
		expect(await vault.cachedRead({ path: "Reading/Book.md" })).toBe(plain);
	});

	it("does not rewrite a link inside another collection", async () => {
		const plugin = start();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Projects/Other.md" }, { path: "Projects/New name.md" }];
		metadataCache.caches.set("Projects/New name.md", collectionCache());
		metadataCache.caches.set("Projects/Other.md", collectionCache());
		metadataCache.resolvedLinks = { "Projects/Other.md": { "Projects/Old name.md": 1 } };
		const other = `## Tasks\n${FROZEN}`;
		vault.allowReads({ "Projects/Other.md": other });

		vault.fire("rename", { path: "Projects/New name.md" } as unknown as TFile, "Projects/Old name.md");
		await turns();

		// Wrong code (no collection filter) would have rewritten it to `[[New name]]`.
		expect(await vault.cachedRead({ path: "Projects/Other.md" })).toBe(other);
	});

	it("leaves a note under an excluded folder alone — a template's example line is not a record", async () => {
		const plugin = start({ excludedFolders: ["Templates"] });
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Templates/Meeting.md" }, { path: "Projects/New name.md" }];
		metadataCache.caches.set("Projects/New name.md", collectionCache());
		metadataCache.resolvedLinks = { "Templates/Meeting.md": { "Projects/Old name.md": 1 } };
		const template = `# Template\n${FROZEN}`;
		vault.allowReads({ "Templates/Meeting.md": template });

		vault.fire("rename", { path: "Projects/New name.md" } as unknown as TFile, "Projects/Old name.md");
		await turns();

		// Wrong code (excluded folders not asked) would have rewritten it.
		expect(await vault.cachedRead({ path: "Templates/Meeting.md" })).toBe(template);
	});

	it("still finds an ordinary note through a second rename while resolvedLinks names nothing", async () => {
		const plugin = start();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Meetings/Kickoff.md" }, { path: "Projects/New name.md" }];
		metadataCache.caches.set("Projects/New name.md", collectionCache());
		metadataCache.resolvedLinks = { "Meetings/Kickoff.md": { "Projects/Old name.md": 1 } };
		vault.allowReads({ "Meetings/Kickoff.md": FROZEN });

		vault.fire("rename", { path: "Projects/New name.md" } as unknown as TFile, "Projects/Old name.md");
		await turns();
		expect(await vault.cachedRead({ path: "Meetings/Kickoff.md" })).toBe(FROZEN_RENAMED);

		metadataCache.caches.delete("Projects/New name.md");
		metadataCache.caches.set("Projects/Last name.md", collectionCache());
		metadataCache.resolvedLinks = {};
		vault.fire("rename", { path: "Projects/Last name.md" } as unknown as TFile, "Projects/New name.md");
		await turns();

		// Wrong code (the remembered half still limited to day's logs) would
		// leave `[[New name]]`, a note that no longer exists.
		expect(await vault.cachedRead({ path: "Meetings/Kickoff.md" })).toBe(FROZEN_RENAMED.replace("New name", "Last name"));
	});

	// Issue #988: in a note that is not a day's log only a frozen line is
	// rewritten, never a line the person wrote and never one in fenced text or
	// frontmatter.
	it("leaves an ordinary note's open task line byte for byte when the note has no frozen line", async () => {
		const plugin = start();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Meetings/Kickoff.md" }, { path: "Projects/New name.md" }];
		metadataCache.caches.set("Projects/New name.md", collectionCache());
		metadataCache.resolvedLinks = { "Meetings/Kickoff.md": { "Projects/Old name.md": 1 } };
		const own = "# Kickoff\n- [ ] Ask Ada about [[Old name]]\n- [x] Sent the notes for [[Old name]]\n";
		vault.allowReads({ "Meetings/Kickoff.md": own });

		vault.fire("rename", { path: "Projects/New name.md" } as unknown as TFile, "Projects/Old name.md");
		await turns();

		// Wrong code (every task line rewritten, as in a day's log) would read
		// `[[New name]]` on both lines; the assertion is on the whole file's bytes.
		expect(await vault.cachedRead({ path: "Meetings/Kickoff.md" })).toBe(own);
	});

	it("rewrites only the frozen line of an ordinary note, not an open task line beside it, nor task-shaped lines in fenced text or frontmatter", async () => {
		const plugin = start();
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Meetings/Kickoff.md" }, { path: "Projects/New name.md" }];
		metadataCache.caches.set("Projects/New name.md", collectionCache());
		metadataCache.resolvedLinks = { "Meetings/Kickoff.md": { "Projects/Old name.md": 1 } };
		const before = [
			"---",
			"- [ ] frontmatter open [[Old name]]",
			FROZEN.trimEnd().replace("Book the venue", "frontmatter frozen"),
			"---",
			"# Kickoff",
			"- [ ] Call Ada about [[Old name]]",
			FROZEN.trimEnd(),
			"```",
			"- [ ] fenced open [[Old name]]",
			FROZEN.trimEnd().replace("Book the venue", "fenced frozen"),
			"```",
			"",
		].join("\n");
		const after = before
			.split("\n")
			.map((line, at) => (at === 6 ? line.replace("Old name", "New name") : line))
			.join("\n");
		vault.allowReads({ "Meetings/Kickoff.md": before });

		vault.fire("rename", { path: "Projects/New name.md" } as unknown as TFile, "Projects/Old name.md");
		await turns();

		// Wrong code would rewrite the open line (5), and the two frozen-shaped
		// lines inside the frontmatter (2) and the fence (9), as well as line 6;
		// the assertion is on the whole file's bytes.
		expect(await vault.cachedRead({ path: "Meetings/Kickoff.md" })).toBe(after);
	});

	// Issue #989: a day's log is gathered whatever the excluded folders say; an
	// excluded note that is not a day's log is still left alone (the test above).
	it("still rewrites a day's log that sits under an excluded folder", async () => {
		const plugin = start({ excludedFolders: ["Journal"] });
		const { vault, metadataCache } = plugin.app;
		vault.files = [{ path: "Journal/2026-01-05.md" }, { path: "Projects/New name.md" }];
		metadataCache.caches.set("Projects/New name.md", collectionCache());
		metadataCache.resolvedLinks = { "Journal/2026-01-05.md": { "Projects/Old name.md": 1 } };
		vault.allowReads({ "Journal/2026-01-05.md": FROZEN });

		vault.fire("rename", { path: "Projects/New name.md" } as unknown as TFile, "Projects/Old name.md");
		await turns();

		// Wrong code (excluded folders asked of a day's log too) leaves `[[Old name]]`.
		expect(await vault.cachedRead({ path: "Journal/2026-01-05.md" })).toBe(FROZEN_RENAMED);
	});
});
