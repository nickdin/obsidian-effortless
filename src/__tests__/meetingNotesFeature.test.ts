/**
 * Meeting notes as a feature: what it declares, its settings card, its memory
 * reader and its readiness (spec #701
 * decisions 1, 2, 3 and 6, #757).
 * No note is created here — the run is a later ticket — so these tests cover
 * the row a person sees, the settings they answer, and what the feature says
 * about a hand-edited `data.json`.
 *
 * **These tests drive the real feature registry, the real settings store, a
 * real `DeviceStore` and the real settings screen**, over the Obsidian stub,
 * because what they assert is where the feature meets the core — the same
 * shape `src/__tests__/daysAheadFeature.test.ts` uses for building the days
 * ahead.
 *
 * Every folder, address, series id and path here is invented.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin, Vault as ObsidianVault } from "obsidian";
import { Notice, Plugin, Vault, controlsUnder, resetSettings } from "./__mocks__/obsidian";
import type { TextComponent } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { Collections } from "../core/collections";
import type { FeatureHost } from "../core/feature";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SAVE_AFTER_TYPING_MS, SettingsStore, defaultData } from "../core/settings";
import type { EffortlessData } from "../core/settings";
import { EffortlessSettingTab } from "../core/settingsTab";
import * as meetingNotesModule from "../features/meetingNotes";
import { FEATURE_ID, MeetingNotes } from "../features/meetingNotes";

/** The settings file with `features` as this feature's slice. */
function dataWith(features: Record<string, unknown> = {}): EffortlessData {
	return { ...defaultData(), features: { [FEATURE_ID]: features } };
}

/** A slice with the folder answered and nothing else. */
const ANSWERED = { meetingNotesFolder: "Meetings" };

interface Started {
	readonly plugin: Plugin;
	readonly registry: FeatureRegistry;
	readonly device: DeviceStore;
	readonly feature: MeetingNotes;
	readonly problems: Problems;
	readonly tab: EffortlessSettingTab;
}

/**
 * The plugin loaded over `data`, the core's registry holding the feature under
 * its id and started as `main.ts` starts it, and the real settings screen
 * built over the same parts. `buildsTheDays` is set before the registry
 * starts, the way a person's own earlier answer would already be there.
 */
async function startMeetingNotes(
	data: EffortlessData = dataWith(),
	buildsTheDays = false,
	/** A calendar to read and the vault the writer creates in, for a test that has the feature create a note. */
	given: { calendar?: Calendar; writerVault?: Vault } = {},
): Promise<Started> {
	const plugin = new Plugin();
	plugin.seedData(data);
	plugin.load();
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const notes = new NoteWriter((given.writerVault ?? new Vault()) as unknown as ObsidianVault, {
		path: () => null,
		onChange: () => undefined,
	});
	const calendar: Calendar = given.calendar ?? {
		meetingsOn: () => [],
		presenceBetween: () => ({ whole: false, meetings: [] }),
		refresh: async () => {},
	};
	const collections: Collections = { all: () => [], at: () => null };
	const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
	device.save({ buildsTheDays });
	const problems = new Problems();
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections, problems, device },
		notes,
		calendar,
	);
	let feature: MeetingNotes | undefined;
	registry.register(FEATURE_ID, (host: FeatureHost) => (feature = new MeetingNotes(host)));
	registry.start();
	const tab = new EffortlessSettingTab(plugin.app as unknown as ObsidianApp, plugin as unknown as ObsidianPlugin, {
		settings,
		registry,
		device,
		collections,
		problems,
	});
	return { plugin, registry, device, feature: feature!, problems, tab };
}

/** The feature cards on a real settings screen, the core card excluded. */
function featureCards(tab: EffortlessSettingTab): HTMLElement[] {
	return Array.from(tab.containerEl.querySelectorAll(".effortless-card")).filter(
		(el) => !el.classList.contains("effortless-card-core"),
	) as HTMLElement[];
}

/** What a person reads on the feature's closed row: its name, its line and its badge. */
function closedRow(tab: EffortlessSettingTab): { name: string; line: string; badge: string } {
	tab.display();
	const cards = featureCards(tab);
	expect(cards).toHaveLength(1);
	const [card] = cards;
	return {
		name: card.querySelector(".effortless-card-name")?.textContent ?? "",
		line: card.querySelector(".effortless-card-line")?.textContent ?? "",
		badge: card.querySelector(".effortless-badge")?.textContent ?? "",
	};
}

/** Opens the feature's card on the real screen, the way a person clicks its name. */
function openCard(tab: EffortlessSettingTab): HTMLElement {
	tab.display();
	const text = featureCards(tab)[0].querySelector(".effortless-card-text") as HTMLElement;
	text.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	return featureCards(tab)[0];
}

/** One named row's box on the open card, and the sentence under it. */
function row(card: HTMLElement, name: string): { text: TextComponent; desc: () => string } {
	const text = controlsUnder(card).get(name)?.[0] as TextComponent | undefined;
	if (text === undefined) throw new Error(`the open card has no ${name} row`);
	const settingEl = Array.from(card.querySelectorAll(".setting-item")).find(
		(el) => el.querySelector(".setting-item-name")?.textContent === name,
	);
	return { text, desc: () => settingEl?.querySelector(".setting-item-description")?.textContent ?? "" };
}

/** What the last write put in this feature's slice of `data.json`. */
function lastSavedSlice(plugin: Plugin): Record<string, unknown> {
	return JSON.parse(plugin.saved[plugin.saved.length - 1]).features[FEATURE_ID];
}

/** The six template fields, their row names and their shipped defaults. */
const TEMPLATE_ROWS: ReadonlyArray<readonly [field: string, rowName: string, shipped: string]> = [
	["tag", "Tag", "meeting"],
	["effortField", "Effort field", "effort"],
	["participantsField", "Participants field", "participants"],
	["notesHeading", "Notes heading", "# Notes"],
	["agendaHeading", "Agenda heading", "## Agenda and purpose"],
	["decisionsHeading", "Decisions heading", "## Decisions and actions"],
];

/** A value each field accepts that is not its shipped default, so a save of it is visible. */
function accepted(field: string): string {
	return field.endsWith("Heading") ? "### Invented" : "invented";
}

beforeEach(() => {
	Notice.messages = [];
	resetSettings();
});

describe("what the feature declares", () => {
	it("is registered in main.ts with one line", async () => {
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const { repoRoot } = await import("./repoRoot");
		const main = readFileSync(resolve(repoRoot, "src/main.ts"), "utf8");
		const lines = main.split("\n").filter((line) => line.includes("MeetingNotes") || line.includes('"meeting-notes"'));
		expect(lines.map((line) => line.trim())).toEqual([
			'import { MeetingNotes } from "./features/meetingNotes";',
			'registry.register("meeting-notes", (host) => new MeetingNotes(host));',
		]);
	});

	it("exports the class and the id from its index and nothing else", () => {
		expect(Object.keys(meetingNotesModule).sort()).toEqual(["FEATURE_ID", "MeetingNotes"]);
		expect(FEATURE_ID).toBe("meeting-notes");
	});

	it("reports no standing problem of its own, on start, on a recheck and on a save from the card", async () => {
		vi.useFakeTimers();
		try {
			const { registry, problems, tab } = await startMeetingNotes(dataWith(ANSWERED), true);
			expect(problems.all()).toEqual([]);
			registry.recheckReadiness();
			expect(problems.all()).toEqual([]);
			row(openCard(tab), "Tag").text.change("invented");
			await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);
			expect(problems.all()).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("the closed row on the settings screen", () => {
	it("names Meeting notes and shows its description while it runs", async () => {
		const { tab } = await startMeetingNotes(dataWith(ANSWERED), true);
		expect(closedRow(tab)).toEqual({
			name: "Meeting notes",
			line: "Creates a note for each meeting whose calendar is set to make one, linked from the day.",
			badge: "Running",
		});
	});

	it("shows another device doing the job, with the Off badge, when this device does not build the days", async () => {
		const { tab } = await startMeetingNotes(dataWith(ANSWERED), false);
		expect(closedRow(tab)).toEqual({
			name: "Meeting notes",
			line: "Another device builds the days and the meeting notes.",
			badge: "Off",
		});
	});

	it("shows the folder missing, with the Not configured badge, when the folder is blank", async () => {
		const { tab } = await startMeetingNotes(dataWith(), true);
		expect(closedRow(tab)).toEqual({
			name: "Meeting notes",
			line: "The meeting notes folder is not set. Enter it under Meeting notes folder on the Meeting notes card.",
			badge: "Not configured",
		});
	});
});

describe("readiness", () => {
	it("answers standby, naming another device, with the device switch off", async () => {
		const { registry } = await startMeetingNotes(dataWith(ANSWERED), false);
		const [status] = registry.statuses();
		expect(status.state).toBe("standby");
		expect(status.detail).toBe("Another device builds the days and the meeting notes.");
	});

	it("answers unconfigured, naming the folder, with the switch on and the folder blank", async () => {
		const { registry } = await startMeetingNotes(dataWith({ meetingNotesFolder: "   " }), true);
		const [status] = registry.statuses();
		expect(status.state).toBe("unconfigured");
		expect(status.detail).toBe(
			"The meeting notes folder is not set. Enter it under Meeting notes folder on the Meeting notes card.",
		);
	});

	it("answers ready with the switch on and the folder answered", async () => {
		const { registry } = await startMeetingNotes(dataWith(ANSWERED), true);
		expect(registry.statuses()[0].state).toBe("running");
	});

	it("answers unconfigured for a stored folder that is not text, and says so once", async () => {
		const { registry } = await startMeetingNotes(dataWith({ meetingNotesFolder: 42 }), true);
		expect(registry.statuses()[0].state).toBe("unconfigured");
		expect(Notice.messages).toEqual([
			"Effortless: meeting notes cannot use the folder 42 stored in its settings, and does not run until a folder is entered on the Meeting notes card.",
		]);
	});

	it("does not change with a blank email address", async () => {
		// If the address were a readiness answer, the first case would read
		// unconfigured; the folder-blank case beside it shows the answer can move.
		const blank = await startMeetingNotes(dataWith({ ...ANSWERED, selfEmail: "" }), true);
		const set = await startMeetingNotes(dataWith({ ...ANSWERED, selfEmail: "someone@example.com" }), true);
		const blankNoFolder = await startMeetingNotes(dataWith({ selfEmail: "" }), true);
		expect(blank.registry.statuses()[0].state).toBe("running");
		expect(set.registry.statuses()[0].state).toBe("running");
		expect(blankNoFolder.registry.statuses()[0].state).toBe("unconfigured");
	});

	it("never answers unavailable, across the device switch and the folder", async () => {
		for (const buildsTheDays of [false, true]) {
			for (const slice of [{}, ANSWERED]) {
				const { registry } = await startMeetingNotes(dataWith(slice), buildsTheDays);
				expect(registry.statuses()[0].state).not.toBe("unavailable");
			}
		}
	});

	it("moves from standby to running and back through recheckReadiness alone", async () => {
		const { registry, device } = await startMeetingNotes(dataWith(ANSWERED), false);
		expect(registry.statuses()[0].state).toBe("standby");
		device.save({ buildsTheDays: true });
		registry.recheckReadiness();
		expect(registry.statuses()[0].state).toBe("running");
		device.save({ buildsTheDays: false });
		registry.recheckReadiness();
		expect(registry.statuses()[0].state).toBe("standby");
	});
});

describe("the hook a switch to ready runs", () => {
	it("is run when the feature starts ready, and not when it starts without a folder", async () => {
		const runNow = vi.spyOn(MeetingNotes.prototype as unknown as { runNow(): void }, "runNow");
		try {
			await startMeetingNotes(dataWith(), true);
			expect(runNow).not.toHaveBeenCalled();
			await startMeetingNotes(dataWith(ANSWERED), true);
			expect(runNow).toHaveBeenCalledTimes(1);
		} finally {
			runNow.mockRestore();
		}
	});

	it("is run when the device switch brings the feature out of standby", async () => {
		const runNow = vi.spyOn(MeetingNotes.prototype as unknown as { runNow(): void }, "runNow");
		try {
			const { registry, device } = await startMeetingNotes(dataWith(ANSWERED), false);
			expect(runNow).not.toHaveBeenCalled();
			device.save({ buildsTheDays: true });
			registry.recheckReadiness();
			expect(runNow).toHaveBeenCalledTimes(1);
		} finally {
			runNow.mockRestore();
		}
	});

	it("is run when the folder box is committed with a folder, and the row then reads Running", async () => {
		const runNow = vi.spyOn(MeetingNotes.prototype as unknown as { runNow(): void }, "runNow");
		try {
			const { tab } = await startMeetingNotes(dataWith(), true);
			const folder = row(openCard(tab), "Meeting notes folder");
			folder.text.change("Meetings");
			expect(runNow).not.toHaveBeenCalled();
			folder.text.inputEl.dispatchEvent(new Event("change"));
			expect(runNow).toHaveBeenCalledTimes(1);
			expect(featureCards(tab)[0].querySelector(".effortless-badge")?.textContent).toBe("Running");
		} finally {
			runNow.mockRestore();
		}
	});
});

describe("the card's rows", () => {
	it("shows the folder, the address and the six template fields, in that order, with the English defaults", async () => {
		const { tab } = await startMeetingNotes(dataWith(), true);
		const card = openCard(tab);
		const rows = controlsUnder(card);
		expect([...rows.keys()].filter((name) => name !== "")).toEqual([
			"Meeting notes folder",
			"Your email address",
			...TEMPLATE_ROWS.map(([, rowName]) => rowName),
		]);
		for (const [, rowName, shipped] of TEMPLATE_ROWS) {
			expect(row(card, rowName).text.getValue()).toBe(shipped);
		}
		expect(Notice.messages).toEqual([]);
	});

	it.each(TEMPLATE_ROWS)("stores an accepted %s typed into its row", async (field, rowName) => {
		vi.useFakeTimers();
		try {
			const { plugin, tab } = await startMeetingNotes(dataWith(ANSWERED), true);
			row(openCard(tab), rowName).text.change(accepted(field));
			await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);
			expect((lastSavedSlice(plugin).template as Record<string, unknown>)[field]).toBe(accepted(field));
		} finally {
			vi.useRealTimers();
		}
	});

	it.each(TEMPLATE_ROWS)(
		"refuses a blank %s on entry, saying so in the row, and keeps the previous value",
		async (field, rowName) => {
			vi.useFakeTimers();
			try {
				const previous = accepted(field);
				const { plugin, tab, feature } = await startMeetingNotes(
					dataWith({ ...ANSWERED, template: { [field]: previous } }),
					true,
				);
				const box = row(openCard(tab), rowName);
				box.text.change("");
				expect(box.desc()).toBe(`${rowName} cannot be blank.`);
				box.text.change("   ");
				expect(box.desc()).toBe(`${rowName} cannot be blank.`);
				await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);

				expect(plugin.saved).toEqual([]);
				expect((feature.template() as unknown as Record<string, string>)[field]).toBe(previous);
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it.each(TEMPLATE_ROWS.filter(([field]) => field.endsWith("Heading")))(
		"refuses a %s that does not start with #, and keeps the previous value",
		async (field, rowName, shipped) => {
			vi.useFakeTimers();
			try {
				const { plugin, tab, feature } = await startMeetingNotes(dataWith(ANSWERED), true);
				const box = row(openCard(tab), rowName);
				box.text.change("Invented heading");
				expect(box.desc()).toBe(`${rowName} must start with #, the way a heading is written.`);
				await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);

				expect(plugin.saved).toEqual([]);
				expect((feature.template() as unknown as Record<string, string>)[field]).toBe(shipped);
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it("accepts a blank email address, and stores it", async () => {
		vi.useFakeTimers();
		try {
			const { plugin, tab } = await startMeetingNotes(
				dataWith({ ...ANSWERED, selfEmail: "someone@example.com" }),
				true,
			);
			row(openCard(tab), "Your email address").text.change("");
			await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);
			expect(lastSavedSlice(plugin).selfEmail).toBe("");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("the day-link and processed field names are the layout's", () => {
	it("shows neither Day link field nor Processed field on the card, only the six template rows", async () => {
		const { tab } = await startMeetingNotes(dataWith(ANSWERED), true);
		const names = [...controlsUnder(openCard(tab)).keys()].filter((name) => name !== "");
		expect(names).toHaveLength(2 + 6);
		expect(names).not.toContain("Day link field");
		expect(names).not.toContain("Processed field");
	});

	it("creates a note written with the layout's two names, not the shipped ones nor the template's old keys", async () => {
		vi.useFakeTimers();
		// A fixed clock, well before the 23:00 meeting built below: on the real clock
		// "now" was the machine's hour. Run with the system time set to 23:45 the
		// test passed all the same (issue #1062 was inferred, not reproduced), so
		// this changes nothing it asserts.
		vi.setSystemTime(new Date(2026, 9, 9, 8, 0));
		try {
			const writerVault = new Vault();
			writerVault.allowReads();
			const now = new Date();
			const standup = {
				uid: "uid-1",
				summary: "Weekly sync",
				location: null,
				description: null,
				organizer: null,
				attendees: [{ name: "Alva Almgren", email: "alva.almgren@invented.test" }],
				occurrenceKey: null,
				allDay: false,
				start: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 0),
				end: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 30),
			};
			const calendar: Calendar = {
				meetingsOn: () => [standup],
				presenceBetween: () => ({ whole: false, meetings: [] }),
				refresh: async () => {},
			};
			const data = dataWith({
				...ANSWERED,
				// The template's old keys are still on disk and are read by nothing.
				template: { dayLinkField: "old-day", processedField: "old-processed" },
			});
			data.core.layout = {
				...data.core.layout,
				dailyLogFolder: "Journal",
				dailyLogFilename: "YYYY-MM-DD",
				dayLinkField: "logLink",
				processedField: "handled",
			};
			await startMeetingNotes(data, true, { calendar, writerVault });

			await vi.advanceTimersByTimeAsync(10_000);
			await vi.advanceTimersByTimeAsync(0);

			expect(writerVault.created).toHaveLength(1);
			const text = writerVault.readableContents()?.get(writerVault.created[0]) ?? "";
			expect(text).toContain('logLink: "[[');
			expect(text).toContain("\nhandled:\n");
			expect(text).not.toContain("old-day");
			expect(text).not.toContain("old-processed");
			expect(text).not.toContain("\nday:");
			expect(text).not.toContain("\nprocessed:");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("a hand-written data.json", () => {
	it("refuses a blank or non-text template field on read with a notice, and uses the English default", async () => {
		const { feature } = await startMeetingNotes(
			dataWith({
				...ANSWERED,
				template: { tag: "", effortField: 42, notesHeading: "Notes", participantsField: "invited" },
			}),
			true,
		);

		expect(Notice.messages).toEqual([
			'Effortless: meeting notes cannot use the Tag "" stored in its settings, and uses "meeting" until it is changed on the Meeting notes card.',
			'Effortless: meeting notes cannot use the Effort field 42 stored in its settings, and uses "effort" until it is changed on the Meeting notes card.',
			'Effortless: meeting notes cannot use the Notes heading "Notes" stored in its settings, and uses "# Notes" until it is changed on the Meeting notes card.',
		]);
		expect(feature.template()).toEqual({
			tag: "meeting",
			effortField: "effort",
			participantsField: "invited",
			notesHeading: "# Notes",
			agendaHeading: "## Agenda and purpose",
			decisionsHeading: "## Decisions and actions",
		});
	});

	it("shows a refused stored field as stored on its row, with the refusal beside it, and does not rewrite it", async () => {
		const { plugin, tab } = await startMeetingNotes(dataWith({ ...ANSWERED, template: { tag: 7 } }), true);
		const tag = row(openCard(tab), "Tag");
		expect(tag.text.getValue()).toBe("7");
		expect(tag.desc()).toBe('Tag must be text. The value 7 stored here is not used; "meeting" is used until this is changed.');
		expect(plugin.saved).toEqual([]);
	});

	it("refuses a template that is not an object at all, and uses every English default", async () => {
		const { feature } = await startMeetingNotes(dataWith({ ...ANSWERED, template: "Swedish" }), true);
		expect(Notice.messages).toEqual([
			'Effortless: meeting notes cannot use the template "Swedish" stored in its settings, and uses the English field names and headings until they are entered on the Meeting notes card.',
		]);
		expect(feature.template().tag).toBe("meeting");
	});

	it("drops a notes entry of the wrong shape with one notice naming its key, and keeps the rest", async () => {
		// A bare path and an object missing `accounted` used to be read back
		// silently as "nobody accounted for" — updated here to their
		// current, refused reading, alongside the shapes that were always
		// refused: a date key not in `YYYY-MM-DD`, and a value that is neither
		// a string nor an object.
		const { feature } = await startMeetingNotes(
			dataWith({
				...ANSWERED,
				notes: {
					"series-a": {
						"2026-01-05": { path: "Meetings/Invented A.md", accounted: [] },
						"5 January": "Meetings/Invented B.md",
						"2026-01-06": 7,
						"2026-01-07": "Meetings/Invented D.md",
					},
					"series-b": "not a record",
					"series-c|20260107T090000Z": { "2026-01-07": { path: "Meetings/Invented C.md" } },
				},
			}),
			true,
		);

		expect(Notice.messages).toEqual([
			'Effortless: meeting notes dropped entries of the wrong shape from its memory of the notes it has written: "series-a / 5 January", "series-a / 2026-01-06", "series-a / 2026-01-07", "series-b", "series-c|20260107T090000Z / 2026-01-07".',
		]);
		expect(feature.notes()).toEqual({
			"series-a": { "2026-01-05": { path: "Meetings/Invented A.md", accounted: [] } },
		});
	});

	it("says nothing about a memory it can read whole", async () => {
		const { feature } = await startMeetingNotes(
			dataWith({
				...ANSWERED,
				notes: { "series-a": { "2026-01-05": { path: "Meetings/Invented A.md", accounted: [] } } },
			}),
			true,
		);
		expect(Notice.messages).toEqual([]);
		// The current path-and-accounted shape, read back whole and unrefused.
		expect(feature.notes()).toEqual({
			"series-a": { "2026-01-05": { path: "Meetings/Invented A.md", accounted: [] } },
		});
	});

	it("keeps the notes memory untouched when a row on the card is saved", async () => {
		vi.useFakeTimers();
		try {
			const memory = { "series-a": { "2026-01-05": "Meetings/Invented A.md" } };
			const { plugin, tab } = await startMeetingNotes(dataWith({ ...ANSWERED, notes: memory }), true);
			row(openCard(tab), "Tag").text.change("invented");
			await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);
			expect(lastSavedSlice(plugin).notes).toEqual(memory);
		} finally {
			vi.useRealTimers();
		}
	});
});
