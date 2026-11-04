import { beforeEach, describe, expect, it, vi } from "vitest";
// Imported by path rather than as "obsidian", as `calendarSourcesSection.test.ts`
// does: `tsc` checks this file against the real API.
import type { App as ObsidianApp, Plugin as ObsidianPlugin } from "obsidian";
import {
	App,
	Notice,
	Plugin,
	controlsUnder,
	resetSettings,
	type TextComponent,
} from "./__mocks__/obsidian";
import { renderCalendarSources } from "../core/calendarSourcesSection";
import { createSaveFailureAnnouncer } from "../core/saveFailureAnnouncer";
import { newCalendarSource } from "../core/calendarSources";
import { DeviceStore, SettingsStore } from "../core/settings";

// Ticket #987: the address box shows what the settings store holds. Pasting
// `webcal://…` stores `https://…`, and the box has to say so at once
// rather than keep the pasted text until the screen is drawn again.

async function aCalendarWithNoAddress(kind: "link" | "file" = "link"): Promise<{
	settings: SettingsStore;
	body: HTMLElement;
	box: TextComponent;
}> {
	resetSettings();
	Notice.messages = [];
	const plugin = new Plugin(new App());
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	await settings.saveCore({
		...settings.core(),
		calendarSources: [{ ...newCalendarSource(), kind, name: "Work", location: "" }],
	});
	const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
	const body = document.createElement("div");
	resetSettings();
	renderCalendarSources(body, settings, device, createSaveFailureAnnouncer());
	const row = body.querySelector(".effortless-calendar-source") as HTMLElement;
	const found = controlsUnder(row).get("Where it comes from");
	if (!found) throw new Error('No row called "Where it comes from" was drawn.');
	return { settings, body, box: found[1] as TextComponent };
}

describe("the address box follows the store", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it("shows https:// after a webcal:// address is pasted, the same as the store holds", async () => {
		const { settings, box } = await aCalendarWithNoAddress();

		await box.change("webcal://cal.test/w.ics");

		expect(settings.core().calendarSources[0].location).toBe("https://cal.test/w.ics");
		expect(box.getValue()).toBe("https://cal.test/w.ics");
	});

	it("never rewrites the box while an https:// address is typed one character at a time", async () => {
		const { box } = await aCalendarWithNoAddress();
		const address = "https://cal.test/w.ics";
		const sets = vi.spyOn(box, "setValue");

		for (let end = 1; end <= address.length; end++) {
			const typed = address.slice(0, end);
			await box.change(typed);
			expect(box.getValue()).toBe(typed);
		}

		expect(sets).not.toHaveBeenCalled();
	});

	// Ticket #1020: a vault path is stored through `normalizePath`, which drops
	// a trailing slash, so the keystroke that types `Calendars/` is stored as
	// `Calendars`. The box must not be rewritten to that; it is only a link's
	// rewritten scheme that the box follows.
	it("keeps every slash while a vault path is typed one character at a time into a file source", async () => {
		const { settings, box } = await aCalendarWithNoAddress("file");
		const path = "Calendars/work.ics";

		for (let end = 1; end <= path.length; end++) {
			await box.change(box.getValue() + path[end - 1]);
		}

		expect(box.getValue()).toBe("Calendars/work.ics");
		expect(settings.core().calendarSources[0].location).toBe("Calendars/work.ics");
	});
});
