import { describe, expect, it } from "vitest";
import type { Plugin as ObsidianPlugin } from "obsidian";
import { Notice, Plugin } from "./__mocks__/obsidian";
import { SettingsStore } from "../core/settings";
import { fieldNameRefusal } from "../core/vaultLayout";
import { readTemplate, templateFieldRefusal } from "../features/meetingNotes/types";

/**
 * Issue #1131: #1108's colon refusal sat in the check every field shares, so a
 * heading or a tag with a colon in it was refused too. A colon is plain text in
 * a heading; in a property name it matters only where it ends a frontmatter
 * key, which is a colon followed by a space or one at the end.
 */

async function loaded(stored: unknown): Promise<SettingsStore> {
	const plugin = new Plugin();
	plugin.seedData(stored);
	Notice.messages = [];
	const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await store.load();
	return store;
}

describe("a heading or a tag with a colon in it", () => {
	it.each([
		["agendaHeading", "## Agenda: today"],
		["decisionsHeading", "## Beslut: vem gör vad"],
		["notesHeading", "# Notes: the day"],
		["tag", "meeting:weekly"],
		["tag", "meeting: weekly"],
	] as const)("%s %j is kept when typed on the Meeting notes card", (field, typed) => {
		expect(templateFieldRefusal(field, typed)).toBeNull();
	});

	it("is kept when stored, with nothing reported refused", () => {
		const read = readTemplate({ agendaHeading: "## Agenda: today", tag: "meeting: weekly" });
		expect(read.refused).toEqual([]);
		expect(read.template.agendaHeading).toBe("## Agenda: today");
		expect(read.template.tag).toBe("meeting: weekly");
	});

	it("still refuses a heading that is blank, not text or has no #", () => {
		expect(templateFieldRefusal("agendaHeading", "")).toBe("Agenda heading cannot be blank.");
		expect(templateFieldRefusal("agendaHeading", 7)).toBe("Agenda heading must be text.");
		expect(templateFieldRefusal("agendaHeading", "Agenda: today")).toBe(
			"Agenda heading must start with #, the way a heading is written.",
		);
	});
});

describe("a property name with a colon in it", () => {
	it.each(["review:done", "a:b:c", ":lead"])("%j is a usable name, since no space follows the colon", (name) => {
		expect(fieldNameRefusal("Processed field", name)).toBeNull();
	});

	it.each(["diary:", "diary: ", "when: written", "written: on", "a:\tb"])(
		"%j is refused, since the colon ends a frontmatter key",
		(name) => {
			expect(fieldNameRefusal("Processed field", name)).toBe("Processed field cannot contain a colon.");
		},
	);

	it("is judged the same for the Meeting notes effort and participants fields", () => {
		expect(templateFieldRefusal("effortField", "review:done")).toBeNull();
		expect(templateFieldRefusal("participantsField", "who: ")).toBe("Participants field cannot contain a colon.");
	});

	it("keeps a stored processed field `review:done` with no notice", async () => {
		const store = await loaded({ core: { layout: { processedField: "review:done" } } });
		expect(store.core().layout.processedField).toBe("review:done");
		expect(Notice.messages).toEqual([]);
	});

	it.each(["diary:", "diary: "])("refuses a stored diary date field %j with one notice", async (stored) => {
		const store = await loaded({ core: { layout: { diaryDateField: stored } } });
		expect(store.core().layout.diaryDateField).toBe("diary");
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("Diary date field");
	});
});
