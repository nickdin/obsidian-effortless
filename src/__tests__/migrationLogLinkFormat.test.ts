/**
 * The link back on the collection's copy, under each of the person's own link
 * settings. Mirrors
 * `migrationFrozenLink.test.ts`'s "a uniquely named collection, under each
 * link setting", the same pattern read back for the mirror link: the collection's
 * copy is read from the vault, never assumed, so a wrong format on the log's own
 * link shows here even where the frozen line's own link is right. Every folder,
 * name and task is invented.
 */

import { describe, expect, it, vi } from "vitest";
import { Notice } from "./__mocks__/obsidian";
import type { Plugin } from "./__mocks__/obsidian";
import { ATTIC, FakeEditor, LOG, LOG_PATH, installMigrationHooks, lastChooser, read, startMigration } from "./migrationHarness";

installMigrationHooks();

type CheckCallback = (checking: boolean, editor: FakeEditor, ctx: { file: { path: string } | null }) => boolean | void;
type LinkSettings = Parameters<typeof startMigration>[0] extends infer S ? (S extends { linkSettings?: infer L } ? L : never) : never;

interface Filed {
	plugin: Plugin;
	editor: FakeEditor;
}

/** Files line 2 of the day's log into `ATTIC` through the command, over a real `FakeEditor` kept in scope. */
async function fileIntoAttic(linkSettings: LinkSettings): Promise<Filed> {
	const { plugin } = await startMigration({ collections: [ATTIC], linkSettings });
	const editor = new FakeEditor(LOG, 2);
	const command = plugin.commands.find((each) => each.id === `${plugin.manifest.id}:file-task`);
	expect(command, "the file-task command was not registered").toBeDefined();
	(command as unknown as { editorCheckCallback: CheckCallback }).editorCheckCallback(false, editor, { file: { path: LOG_PATH } });
	await lastChooser().chooseAt("attic", 0);
	await vi.waitFor(() => expect(Notice.messages.length).toBeGreaterThan(0));
	return { plugin, editor };
}

const LINK_SETTING_CASES: [string, LinkSettings][] = [
	["wikilinks, shortest (the default)", {}],
	["markdown links, shortest", { useMarkdownLinks: true }],
	["wikilinks, absolute", { newLinkFormat: "absolute" }],
	["wikilinks, relative", { newLinkFormat: "relative" }],
];

describe("the link back on the collection's copy, under each link setting", () => {
	it.each(LINK_SETTING_CASES)("is written the shape %s asks, its expected shape computed from the setting the code itself reads back — not typed out by hand", async (_, linkSettings) => {
		const { plugin } = await fileIntoAttic(linkSettings);

		// The two fields `generateMarkdownLink` itself reads — the stub's own
		// stand-in for `getConfig` (`__mocks__/obsidian.ts`'s own doc comment)
		// — read back rather than assumed from the object this test just set:
		// were the write path to consult a different `fileManager`, or none,
		// this would no longer match what `linkSettings` asked for.
		expect({
			useMarkdownLinks: plugin.app.fileManager.useMarkdownLinks,
			newLinkFormat: plugin.app.fileManager.newLinkFormat,
		}).toEqual({
			useMarkdownLinks: linkSettings.useMarkdownLinks ?? false,
			newLinkFormat: linkSettings.newLinkFormat ?? "shortest",
		});

		// What the same accessor says the link back should look like, computed
		// fresh from the day's log path and the collection's own path — never a
		// string typed out by hand — so a build that read a different setting,
		// or none at all, writes something this does not expect.
		const expectedLink = plugin.app.fileManager.generateMarkdownLink({ path: LOG_PATH }, ATTIC.path);

		const collectionText = await read(plugin, ATTIC.path);
		const line = collectionText.split("\n").find((each) => each.includes("Order more tea"));
		expect(line, "the collection must carry the filed line").toBeDefined();
		expect(line as string).toContain(` ${expectedLink} %% migration:`);
	});

	it("writes the frozen line's own link to the collection in the same format, independently of the link back", async () => {
		const { editor } = await fileIntoAttic({ useMarkdownLinks: true });

		expect(editor.getValue()).toContain("[Attic](Attic.md) %% migration:");
	});
});
