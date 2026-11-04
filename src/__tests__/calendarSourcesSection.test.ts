import { beforeEach, describe, expect, it } from "vitest";
// The stub is imported by path rather than as "obsidian": `tsc` checks this
// file against the real API, and only vitest redirects that name.
import type { App as ObsidianApp, Plugin as ObsidianPlugin } from "obsidian";
import {
	App,
	Notice,
	Plugin,
	controlsUnder,
	resetSettings,
	type ButtonComponent,
	type DropdownComponent,
	type TextComponent,
	type ToggleComponent,
} from "./__mocks__/obsidian";
import { renderCalendarSources, sourceStateLine } from "../core/calendarSourcesSection";
import { createSaveFailureAnnouncer } from "../core/saveFailureAnnouncer";
import type { CalendarRead, CalendarSource } from "../core/calendarSources";
import { addressOf, newCalendarSource } from "../core/calendarSources";
import { DeviceStore, SAVE_AFTER_TYPING_MS, SettingsStore } from "../core/settings";

const MINUTE = 60 * 1000;

/** A section drawn into a fresh screen, over a fresh settings file. */
async function drawSection(): Promise<{
	plugin: Plugin;
	settings: SettingsStore;
	device: DeviceStore;
	body: HTMLElement;
	redraw: () => void;
}> {
	const plugin = new Plugin(new App());
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
	const body = document.createElement("div");
	// One announcer for the section, the way the settings tab makes one for its
	// own lifetime and hands it down. It is kept across redraws
	// because the tab's is: a redraw is not a new screen.
	const announce = createSaveFailureAnnouncer();
	const redraw = (): void => {
		body.replaceChildren();
		resetSettings();
		renderCalendarSources(body, settings, device, announce);
	};
	redraw();
	return { plugin, settings, device, body, redraw };
}

function sourceRows(body: HTMLElement): HTMLElement[] {
	// Array.from rather than a spread: tsconfig's lib is ES2018 without
	// DOM.Iterable, so a NodeList is an array-like rather than an iterable.
	return Array.from(body.querySelectorAll(".effortless-calendar-source")) as HTMLElement[];
}

function controlsIn(row: HTMLElement, name: string): unknown[] {
	const found = controlsUnder(row).get(name);
	if (!found) throw new Error(`No row called "${name}" was drawn.`);
	return found;
}

async function pressAdd(body: HTMLElement): Promise<void> {
	await (controlsIn(body, "Add a calendar")[0] as ButtonComponent).click();
}

async function saveSources(settings: SettingsStore, sources: CalendarSource[]): Promise<void> {
	await settings.saveCore({ ...settings.core(), calendarSources: sources });
}

function linked(over: Partial<CalendarSource> = {}): CalendarSource {
	return { ...newCalendarSource(), name: "Work", location: "https://cal.test/w.ics", ...over };
}

describe("adding, editing and removing a calendar", () => {
	beforeEach(() => {
		resetSettings();
		Notice.messages = [];
	});

	it("starts with no calendars and an invitation to add one", async () => {
		const { body } = await drawSection();
		expect(sourceRows(body)).toEqual([]);
		expect(controlsIn(body, "Add a calendar").length).toBe(1);
	});

	it("adds a calendar with both switches on", async () => {
		const { body, settings } = await drawSection();

		await pressAdd(body);

		const [added] = settings.core().calendarSources;
		expect(added.showInDay).toBe(true);
		expect(added.makeNotes).toBe(true);
		expect(added.kind).toBe("link");
	});

	it("has no ceiling on how many can be added", async () => {
		const { body, settings, redraw } = await drawSection();

		for (let i = 0; i < 12; i++) {
			await pressAdd(body);
			redraw();
		}

		expect(settings.core().calendarSources.length).toBe(12);
		expect(sourceRows(body).length).toBe(12);
	});

	it("saves a name, a link and a switch as they are typed", async () => {
		const { body, settings, redraw } = await drawSection();
		await pressAdd(body);
		redraw();
		const row = sourceRows(body)[0];

		await (controlsIn(row, "Name")[0] as TextComponent).change("Work");
		await (controlsIn(row, "Where it comes from")[1] as TextComponent).change(
			"https://cal.test/w.ics",
		);
		await (controlsIn(row, "Make notes")[0] as ToggleComponent).change(false);

		const [saved] = settings.core().calendarSources;
		expect(saved.name).toBe("Work");
		expect(saved.location).toBe("https://cal.test/w.ics");
		expect(saved.makeNotes).toBe(false);
		expect(saved.showInDay).toBe(true);
	});

	it("switches a calendar between a link and a file in the vault", async () => {
		const { body, settings, redraw } = await drawSection();
		await saveSources(settings, [linked()]);
		redraw();

		await (controlsIn(sourceRows(body)[0], "Where it comes from")[0] as DropdownComponent).change(
			"file",
		);

		expect(settings.core().calendarSources[0].kind).toBe("file");
	});

	it("removes the calendar that was asked for and leaves the others", async () => {
		const { body, settings, redraw } = await drawSection();
		const [a, b, c] = [linked({ name: "A" }), linked({ name: "B" }), linked({ name: "C" })];
		await saveSources(settings, [a, b, c]);
		redraw();

		await (controlsIn(sourceRows(body)[1], "Name")[1] as ButtonComponent).click();

		expect(settings.core().calendarSources.map((s) => s.name)).toEqual(["A", "C"]);
	});

	it("keeps every other calendar's settings when one is edited", async () => {
		const { body, settings, redraw } = await drawSection();
		await saveSources(settings, [linked({ name: "A" }), linked({ name: "B", makeNotes: false })]);
		redraw();

		await (controlsIn(sourceRows(body)[0], "Show in the day")[0] as ToggleComponent).change(false);

		const [a, b] = settings.core().calendarSources;
		expect(a.showInDay).toBe(false);
		expect(b.makeNotes).toBe(false);
		expect(b.showInDay).toBe(true);
	});

	it("says so out loud when a calendar cannot be stored", async () => {
		const { body, settings, redraw } = await drawSection();
		await saveSources(settings, [linked()]);
		redraw();
		settings.saveCore = () => Promise.reject(new Error("The disk is full."));

		// A switch, because the two text boxes no longer write through
		// `saveCore`: their run of keystrokes is deferred, and the
		// failure they raise is covered further down.
		await (controlsIn(sourceRows(body)[0], "Show in the day")[0] as ToggleComponent).change(false);

		expect(Notice.messages).toEqual([
			"Effortless: that setting could not be saved. The disk is full.",
		]);
	});
});

describe("a link is a password", () => {
	beforeEach(() => resetSettings());

	it("masks the link, so it is not left sitting on a shared screen", async () => {
		const { body, settings, redraw } = await drawSection();
		await saveSources(settings, [linked()]);
		redraw();

		const field = controlsIn(sourceRows(body)[0], "Where it comes from")[1] as TextComponent;
		expect(field.inputEl.type).toBe("password");
	});

	it("leaves a vault path in plain sight, because a path is not a secret", async () => {
		const { body, settings, redraw } = await drawSection();
		await saveSources(settings, [linked({ kind: "file", location: "Calendars/work.ics" })]);
		redraw();

		const field = controlsIn(sourceRows(body)[0], "Where it comes from")[1] as TextComponent;
		expect(field.inputEl.type).not.toBe("password");
	});
});

describe("what a calendar's row says about its last read", () => {
	const source = linked();

	it("says nothing has been read yet before the first read", () => {
		expect(sourceStateLine(source, undefined, 0)).toBe("Not read yet.");
	});

	it("says how long ago it was last read", () => {
		const now = 10 * 60 * MINUTE;
		expect(sourceStateLine(source, { readAt: now - 30 * 1000, failure: null }, now)).toBe(
			"Last read just now.",
		);
		expect(sourceStateLine(source, { readAt: now - 5 * MINUTE, failure: null }, now)).toBe(
			"Last read 5 minutes ago.",
		);
		expect(sourceStateLine(source, { readAt: now - 60 * MINUTE, failure: null }, now)).toBe(
			"Last read 1 hour ago.",
		);
		expect(sourceStateLine(source, { readAt: now - 50 * 60 * MINUTE, failure: null }, now)).toBe(
			"Last read 2 days ago.",
		);
	});

	it("says a read failed, and still says when it last worked", () => {
		const now = 10 * 60 * MINUTE;
		expect(
			sourceStateLine(source, { readAt: now - 30 * MINUTE, failure: "The network is down." }, now),
		).toBe("Failed: The network is down. Last read 30 minutes ago.");
	});

	it("says a failure on its own when the calendar has never once been read", () => {
		expect(sourceStateLine(source, { readAt: null, failure: "The network is down." }, 0)).toBe(
			"Failed: The network is down.",
		);
	});

	it("says nothing has been read yet when the read was earned elsewhere", () => {
		// The read state is kept under the source's id, and the id survives an
		// edit to the address. Without this the row would go on reporting a time
		// the calendar it no longer points at earned.
		const now = 10 * 60 * MINUTE;
		const read = {
			readAt: now - 5 * MINUTE,
			failure: null,
			readFrom: "link:https://cal.test/old.ics",
		};

		expect(sourceStateLine(source, read, now)).toBe("Not read yet.");
	});

	it("still says the age of a read with no address recorded", () => {
		// State written before #105 recorded one. It means only that nobody wrote
		// down where the read happened, so it is taken to belong wherever the
		// source points now.
		const now = 10 * 60 * MINUTE;

		expect(sourceStateLine(source, { readAt: now - 5 * MINUTE, failure: null }, now)).toBe(
			"Last read 5 minutes ago.",
		);
	});

	it("says nothing has been read yet when a failure was earned elsewhere", () => {
		// The expectation this replaces was `Failed: The network is down.` — the
		// age dropped and the failure kept. That half told someone who had just
		// corrected a bad address that the calendar was broken, and named a
		// cause belonging to an address no longer in the settings. `GLOSSARY.md`
		// under **Read state** is the whole rule: a read whose address is not
		// the one the source names now is no read of this calendar, and
		// that covers its failure as well as its age.
		const now = 10 * 60 * MINUTE;
		const read = {
			readAt: now - 30 * MINUTE,
			failure: "The network is down.",
			readFrom: "link:https://cal.test/old.ics",
		};

		expect(sourceStateLine(source, read, now)).toBe("Not read yet.");
	});

	it("keeps a failure earned at the address the calendar names now", () => {
		// The other side of #236: only a read from somewhere else is dropped.
		const now = 10 * 60 * MINUTE;
		const here = addressOf(source);

		expect(
			sourceStateLine(
				source,
				{ readAt: now - 30 * MINUTE, failure: "The network is down.", readFrom: here },
				now,
			),
		).toBe("Failed: The network is down. Last read 30 minutes ago.");
		expect(
			sourceStateLine(source, { readAt: null, failure: "The network is down.", readFrom: here }, now),
		).toBe("Failed: The network is down.");
	});

	it("counts a read earned at this very address as this calendar's own", () => {
		// The other side of the comparison: one definition of an address, shared
		// with `calendarSources.ts`, so the screen asks exactly what `readOne`
		// answered when it wrote the state.
		const now = 10 * 60 * MINUTE;
		const read = {
			readAt: now - 5 * MINUTE,
			failure: null,
			readFrom: addressOf(source),
		};

		expect(sourceStateLine(source, read, now)).toBe("Last read 5 minutes ago.");
	});

	it("keeps a read earned at a path only the loader's tidying has changed", () => {
		// A `data.json` written before #248 held `/Calendars/work.ics` and a
		// `readFrom` earned at exactly that. The loader now tidies the location
		// as it arrives and the stored address stays as it was written, so the
		// two stopped matching and the row lost its age until the next read —
		// up to fifteen minutes. Both sides are tidied now, so it does not.
		const now = 10 * 60 * MINUTE;
		const tidied = linked({ kind: "file", location: "Calendars/work.ics" });
		const read = { readAt: now - 5 * MINUTE, failure: null, readFrom: "file:/Calendars/work.ics" };

		expect(sourceStateLine(tidied, read, now)).toBe("Last read 5 minutes ago.");
	});

	it("keeps a failure earned at a path only the loader's tidying has changed", () => {
		const now = 10 * 60 * MINUTE;
		const tidied = linked({ kind: "file", location: "Calendars/work.ics" });
		const read = {
			readAt: now - 30 * MINUTE,
			failure: "There is no file at Calendars/work.ics in this vault.",
			readFrom: "file:/Calendars/work.ics",
		};

		expect(sourceStateLine(tidied, read, now)).toBe(
			"Failed: There is no file at Calendars/work.ics in this vault. Last read 30 minutes ago.",
		);
	});

	it("still disowns a read earned at a genuinely different path", () => {
		// The tidying is not a licence to match loosely. This path is not the
		// one the source names, tidied or untidied, so #105's rule stands.
		const now = 10 * 60 * MINUTE;
		const tidied = linked({ kind: "file", location: "Calendars/work.ics" });
		const read = { readAt: now - 5 * MINUTE, failure: null, readFrom: "file:Calendars/old.ics" };

		expect(sourceStateLine(tidied, read, now)).toBe("Not read yet.");
	});

	it("leaves a link's stored address alone but for its whitespace", () => {
		// `normalizePath` collapses the double slash in `https://`, so a link is
		// only ever trimmed — on the stored side of the comparison as well as on
		// the source's. A read earned at the address this calendar names is kept.
		const now = 10 * 60 * MINUTE;
		const read = { readAt: now - 5 * MINUTE, failure: null };

		expect(
			sourceStateLine(source, { ...read, readFrom: "link:  https://cal.test/w.ics  " }, now),
		).toBe("Last read 5 minutes ago.");
		// The address a vault-path tidying would have left. It is not this
		// calendar's, and nothing here turns it back into one.
		expect(sourceStateLine(source, { ...read, readFrom: "link:https:/cal.test/w.ics" }, now)).toBe(
			"Not read yet.",
		);
	});

	it("says what is wrong with the source itself before anything about reading it", () => {
		const wrong = linked({ location: "http://cal.test/w.ics" });
		expect(sourceStateLine(wrong, { readAt: 5, failure: "Whatever." }, 5)).toBe(
			"A calendar link has to start with https://, so the address is not sent in the clear.",
		);
	});

	it("is drawn under the calendar it belongs to", async () => {
		const { body, settings, device, redraw } = await drawSection();
		const one = linked();
		await saveSources(settings, [one]);
		device.save({ calendarReads: { [one.id]: { readAt: null, failure: "The network is down." } } });
		redraw();

		expect(sourceRows(body)[0].querySelector(".effortless-calendar-state")?.textContent).toBe(
			"Failed: The network is down.",
		);
	});

	/**
	 * One `file` calendar stored the way a person's `data.json` held it before
	 * the loader tidied paths — the leading slash still on `location` — with
	 * the given read recorded against that same untidy address. Built fresh on
	 * every call, like the file's other helpers of this shape.
	 */
	async function anUntidyFileCalendar(
		read: CalendarRead,
	): Promise<{ row: HTMLElement; field: TextComponent }> {
		resetSettings();
		const plugin = new Plugin(new App());
		plugin.seedData({
			core: {
				calendarSources: [
					{ id: "c1", name: "Work", kind: "file", location: "/Calendars/work.ics" },
				],
			},
		});
		const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await settings.load();

		const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
		device.save({ calendarReads: { c1: read } });

		const body = document.createElement("div");
		renderCalendarSources(body, settings, device, createSaveFailureAnnouncer());

		const row = sourceRows(body)[0];
		return { row, field: controlsIn(row, "Where it comes from")[1] as TextComponent };
	}

	/*
	 * Issues #351 and
	 * #428. The two tidyings
	 * this rests on were each proved on their own and never together: the loader
	 * tidies a stored file path as it arrives (`settings.test.ts`), and the
	 * comparison tidies the address a read was earned at (the tests just above).
	 * Both could stay green while they stopped agreeing with each other, and
	 * that disagreement is exactly what #351 was filed for — a settings file
	 * written before the tidying, and a row that had lost its last-read time.
	 *
	 * So this one starts where the person's own file starts: a stored
	 * `data.json` shape, loaded through the store, drawn as a row. Nothing in it
	 * is built by hand past the file itself.
	 */
	it("keeps a read earned before the loader tidied the path, from the file in", async () => {
		const { row, field } = await anUntidyFileCalendar({
			readAt: Date.now() - 5 * MINUTE,
			failure: null,
			readFrom: "file:/Calendars/work.ics",
		});

		expect(row.querySelector(".effortless-calendar-state")?.textContent).toBe(
			"Last read 5 minutes ago.",
		);
		// The other half of the same pass, and the reason it is asserted here
		// rather than left to the loader's own test: with the loader's tidying
		// gone the age above survives — `earnedAt` tidies the source's address
		// too, so the comparison forgives an untidy stored path on either side —
		// and it is the box that stops agreeing with the file.
		expect(field.getValue()).toBe("Calendars/work.ics");
	});

	/*
	 * #351's second box, and the one the test above does not reach. That box is
	 * the same setup carrying a **recorded failure**. The row has one gate for
	 * disowning a read — `sourceStateLine` asks `earnedAt` once, and answers
	 * `Not read yet.` when it says no — and the age and the failure both sit
	 * behind it, in one branch. So an age that survives
	 * the loader's tidying is proof that a failure survives the gate too; the
	 * test above already settles that much.
	 *
	 * What this test holds that the one above does not is the failure branch's
	 * own wording under an untidy stored path: `Failed: … Last read …`, drawn
	 * from a file the loader had to tidy first. No other test in this file
	 * starts from a stored file with a failure on it, and #351's second
	 * acceptance criterion is specifically a recorded failure surviving the
	 * loader.
	 *
	 * It starts at the file for the reason written over the test above: the
	 * loader's tidying and the comparison's tidying are proved apart, and the
	 * disagreement between them is what #351 was filed for. Both tests build
	 * that file through the helper above, so each still reads on its own —
	 * what a call passes in is the whole of what it needs.
	 */
	it("keeps a failure earned before the loader tidied the path, from the file in", async () => {
		const { row, field } = await anUntidyFileCalendar({
			readAt: Date.now() - 30 * MINUTE,
			failure: "There is no file at Calendars/work.ics in this vault.",
			readFrom: "file:/Calendars/work.ics",
		});

		expect(row.querySelector(".effortless-calendar-state")?.textContent).toBe(
			"Failed: There is no file at Calendars/work.ics in this vault. Last read 30 minutes ago.",
		);
		// The same second assertion the test above carries, for the same reason:
		// `earnedAt` tidies both sides of its comparison, so the line above stays
		// green with the loader's tidying gone. Only the address box notices.
		expect(field.getValue()).toBe("Calendars/work.ics");
	});
});

describe("the line under a calendar keeps up with the address being typed", () => {
	beforeEach(() => resetSettings());

	function stateLine(row: HTMLElement): string {
		return row.querySelector(".effortless-calendar-state")?.textContent ?? "";
	}

	/** One calendar with nothing in its address box yet, drawn and ready to type into. */
	async function anEmptyCalendar(): Promise<{
		body: HTMLElement;
		row: HTMLElement;
		field: TextComponent;
	}> {
		const { body, settings, redraw } = await drawSection();
		await saveSources(settings, [linked({ location: "" })]);
		redraw();
		const row = sourceRows(body)[0];
		return { body, row, field: controlsIn(row, "Where it comes from")[1] as TextComponent };
	}

	it("stops saying the calendar has no address once one is pasted", async () => {
		const { row, field } = await anEmptyCalendar();
		expect(stateLine(row)).toBe("This calendar has no link or file yet.");

		await field.change("https://cal.test/w.ics");

		expect(stateLine(row)).toBe("Not read yet.");
	});

	it("stops claiming a last-read time as the new address is typed", async () => {
		// #108 recomposes this line on every keystroke, which is what makes the
		// stale claim visible the moment the typed address is valid — rather than
		// at the next periodic read up to fifteen minutes later.
		const { body, settings, device, redraw } = await drawSection();
		const source = linked();
		await saveSources(settings, [source]);
		device.save({
			calendarReads: {
				[source.id]: {
					readAt: Date.now() - 5 * MINUTE,
					failure: null,
					readFrom: addressOf(source),
				},
			},
		});
		redraw();
		const row = sourceRows(body)[0];
		expect(stateLine(row)).toBe("Last read 5 minutes ago.");

		const field = controlsIn(row, "Where it comes from")[1] as TextComponent;
		await field.change("https://cal.test/somewhere-else.ics");

		expect(stateLine(row)).toBe("Not read yet.");
	});

	it("says what is wrong with an address that will not do", async () => {
		const { row, field } = await anEmptyCalendar();

		await field.change("http://cal.test/w.ics");

		expect(stateLine(row)).toBe(
			"A calendar link has to start with https://, so the address is not sent in the clear.",
		);
	});

	it("goes back to saying there is no address when the box is emptied again", async () => {
		const { row, field } = await anEmptyCalendar();
		await field.change("https://cal.test/w.ics");
		expect(stateLine(row)).toBe("Not read yet.");

		await field.change("");

		expect(stateLine(row)).toBe("This calendar has no link or file yet.");
	});

	it("leaves the box being typed in exactly where it was", async () => {
		const { body, row, field } = await anEmptyCalendar();
		const input = field.inputEl;

		await field.change("https://cal.test/w.ics");

		// The same elements before and after, which is what a caret and a
		// half-typed address need in order to survive the line catching up.
		expect(field.inputEl).toBe(input);
		expect(sourceRows(body)[0]).toBe(row);
	});

	it("still draws the block again when the route is switched, masking and all", async () => {
		const { body, row, field } = await anEmptyCalendar();
		const input = field.inputEl;

		await (controlsIn(row, "Where it comes from")[0] as DropdownComponent).change("file");

		const after = controlsIn(sourceRows(body)[0], "Where it comes from")[1] as TextComponent;
		expect(after.inputEl).not.toBe(input);
		expect(after.inputEl.type).not.toBe("password");
	});
});

describe("two stored calendars that share an id", () => {
	beforeEach(() => {
		resetSettings();
		Notice.messages = [];
	});

	/*
	 * Issue #113's last criterion, which its own worker could not reach: the
	 * loader gives every calendar an id no other holds, and this is the half
	 * that proves it through the settings screen rather than through the
	 * loader. The remove path filters on `other.id !== source.id`
	 * (`calendarSourcesSection.ts`), so two rows sharing an id are removed
	 * together — one press, both gone. It fails on the old loader and passes
	 * on the one #113 landed.
	 */
	it("removes only the one asked for, even when the file gave both the same id", async () => {
		const plugin = new Plugin(new App());
		await plugin.saveData({
			core: {
				calendarSources: [
					{ id: "", name: "A", kind: "link", location: "https://cal.test/a.ics" },
					{ id: "", name: "B", kind: "link", location: "https://cal.test/b.ics" },
				],
			},
		});
		const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await settings.load();
		const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
		const body = document.createElement("div");
		renderCalendarSources(body, settings, device, createSaveFailureAnnouncer());

		await (controlsIn(sourceRows(body)[0], "Name")[1] as ButtonComponent).click();

		expect(settings.core().calendarSources.map((source) => source.name)).toEqual(["B"]);
	});
});

/*
 * **Issue #163.** When the lookup after a save came back empty, `restate` made
 * a calendar up — the draw-time copy with the change pasted on — and the block
 * drew a state line for it. The person was shown a line describing a calendar
 * that was not saved, with nothing saying so. `~/Devbox/CLAUDE.md § Tests and
 * failures`: a fallback is allowed only when it announces itself.
 *
 * The branch is reachable two ways, and both are driven here.
 */
describe("the state line when the calendar behind it cannot be found", () => {
	beforeEach(() => {
		resetSettings();
		Notice.messages = [];
	});

	function stateLine(row: HTMLElement): string {
		return row.querySelector(".effortless-calendar-state")?.textContent ?? "";
	}

	it("says so out loud when the deferred write does not land", async () => {
		const { body, plugin, settings, redraw } = await drawSection();
		await saveSources(settings, [linked({ location: "" })]);
		redraw();
		const row = sourceRows(body)[0];
		plugin.saveData = () => Promise.reject(new Error("The disk is full."));

		await (controlsIn(row, "Where it comes from")[1] as TextComponent).change(
			"https://cal.test/w.ics",
		);

		// The line answers from the settings store, which took the address on
		// the keystroke; the write is still four hundred milliseconds away. So the line moves on and the failure is announced when
		// it happens, rather than the line waiting on a write nobody awaits.
		expect(stateLine(row)).toBe("Not read yet.");
		await new Promise((resolve) => setTimeout(resolve, SAVE_AFTER_TYPING_MS + 50));
		// One announcement for the run. A second Notice for the same event is
		// noise rather than loudness.
		expect(Notice.messages).toEqual([
			"Effortless: that setting could not be saved. The disk is full.",
		]);
	});

	it("draws nothing and throws nothing when the row has left the list underneath it", async () => {
		const { body, settings, redraw } = await drawSection();
		await saveSources(settings, [linked({ location: "" })]);
		redraw();
		const row = sourceRows(body)[0];
		const before = stateLine(row);
		// The list this block was drawn from no longer holds it: removed from
		// another screen, or reloaded from a synced file underneath.
		await saveSources(settings, []);

		// Read straight off the handler: `restate` answers on the keystroke now,
		// so there is no promise here to resolve.
		expect(
			(controlsIn(row, "Where it comes from")[1] as TextComponent).change(
				"https://cal.test/w.ics",
			),
		).toBeUndefined();

		expect(stateLine(row)).toBe(before);
		expect(Notice.messages).toEqual([]);
	});
});

describe("a run of keystrokes is one write, not one per character", () => {
	beforeEach(() => {
		resetSettings();
		Notice.messages = [];
	});

	/** Waits out the debounce and lets the write it starts settle. */
	async function afterTypingStops(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, SAVE_AFTER_TYPING_MS + 50));
	}

	/** One calendar drawn, with the writes made while setting it up forgotten. */
	async function readyToType(
		over: Partial<CalendarSource> = { location: "" },
	): Promise<{ body: HTMLElement; plugin: Plugin; settings: SettingsStore; row: HTMLElement }> {
		const { body, plugin, settings, redraw } = await drawSection();
		await saveSources(settings, [linked(over)]);
		redraw();
		plugin.saved.length = 0;
		return { body, plugin, settings, row: sourceRows(body)[0] };
	}

	/** Types `text` a character at a time, without awaiting between keys. */
	async function typeInto(field: TextComponent, text: string): Promise<void> {
		for (let upto = 1; upto < text.length; upto += 1) void field.change(text.slice(0, upto));
		await field.change(text);
	}

	it("writes once for a pasted address of a hundred characters", async () => {
		const { plugin, settings, row } = await readyToType();
		const address = `https://cal.test/${"a".repeat(80)}.ics`;
		expect(address.length).toBeGreaterThan(100);

		await typeInto(controlsIn(row, "Where it comes from")[1] as TextComponent, address);
		await afterTypingStops();

		expect(plugin.saved.length).toBe(1);
		expect(settings.core().calendarSources[0].location).toBe(address);
	});

	it("writes once for a name typed a character at a time", async () => {
		const { plugin, settings, row } = await readyToType();

		await typeInto(controlsIn(row, "Name")[0] as TextComponent, "Work calendar");
		await afterTypingStops();

		expect(plugin.saved.length).toBe(1);
		expect(settings.core().calendarSources[0].name).toBe("Work calendar");
	});

	it("keeps the line under the row up to date on the keystroke, not on the write", async () => {
		const { row } = await readyToType();
		const field = controlsIn(row, "Where it comes from")[1] as TextComponent;

		await field.change("https://cal.test/w.ics");

		// Before the debounce has run: what #108 is about is that the line keeps
		// up with the typing, and the write is four hundred milliseconds behind it.
		expect(row.querySelector(".effortless-calendar-state")?.textContent).toBe("Not read yet.");
	});

	it("leaves the two toggles immediate — a switch is one event, not a run", async () => {
		const { plugin, row } = await readyToType();

		await (controlsIn(row, "Show in the day")[0] as ToggleComponent).change(false);
		expect(plugin.saved.length).toBe(1);

		await (controlsIn(row, "Make notes")[0] as ToggleComponent).change(false);
		expect(plugin.saved.length).toBe(2);
	});

	it("leaves Add and Remove immediate", async () => {
		const { body, plugin } = await readyToType();

		await pressAdd(body);
		expect(plugin.saved.length).toBe(1);

		await (controlsIn(sourceRows(body)[0], "Name")[1] as ButtonComponent).click();
		expect(plugin.saved.length).toBe(2);
	});

	it("announces a failed deferred write once for the whole run", async () => {
		const { plugin, row } = await readyToType();
		plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));

		await typeInto(controlsIn(row, "Where it comes from")[1] as TextComponent, "https://c.test/w");
		await afterTypingStops();

		expect(Notice.messages).toEqual([
			"Effortless: that setting could not be saved. the vault is read-only",
		]);
	});
});

describe("a calendar's vault path is normalised where it is stored", () => {
	beforeEach(() => {
		resetSettings();
		Notice.messages = [];
	});

	/** One file-route calendar, drawn, with its address box ready to type into. */
	async function aFileCalendar(): Promise<{ settings: SettingsStore; field: TextComponent }> {
		const { body, settings, redraw } = await drawSection();
		await saveSources(settings, [linked({ kind: "file", location: "" })]);
		redraw();
		const row = sourceRows(body)[0];
		return { settings, field: controlsIn(row, "Where it comes from")[1] as TextComponent };
	}

	it("stores a leading slash away, as the boxes above it do", async () => {
		const { settings, field } = await aFileCalendar();

		await field.change("/Calendars/work.ics");

		expect(settings.core().calendarSources[0].location).toBe("Calendars/work.ics");
	});

	it("leaves a blank box blank rather than answering the vault root", async () => {
		const { settings, field } = await aFileCalendar();
		await field.change("/Calendars/work.ics");

		await field.change("   ");

		// `normalizePath("")` answers "/", the vault root, which is a configured
		// answer. Blank means the question has not been answered yet.
		expect(settings.core().calendarSources[0].location).toBe("");
	});

	it("says a link pasted into the file route will not do, on the keystroke", async () => {
		const { body, settings, redraw } = await drawSection();
		await saveSources(settings, [linked({ kind: "file", location: "" })]);
		redraw();
		const row = sourceRows(body)[0];
		const field = controlsIn(row, "Where it comes from")[1] as TextComponent;

		await field.change("https://cal.example/basic.ics");

		// Stored collapsed, because this route normalises, and refused anyway:
		// the guard knows the collapsed scheme as well as the raw one. Before
		// #253 the row said "Not read yet." here and stayed wrong until the
		// next periodic read, which then quoted `https:/cal.example/basic.ics`.
		expect(settings.core().calendarSources[0].location).toBe("https:/cal.example/basic.ics");
		expect(row.querySelector(".effortless-calendar-state")?.textContent).toBe(
			"The path has to stay inside the vault, so it cannot name a drive or another program.",
		);
	});

	it("leaves a link alone — normalizePath would mangle the https://", async () => {
		const { body, settings, redraw } = await drawSection();
		await saveSources(settings, [linked({ location: "" })]);
		redraw();
		const field = controlsIn(sourceRows(body)[0], "Where it comes from")[1] as TextComponent;

		await field.change("https://cal.test/w.ics");

		expect(settings.core().calendarSources[0].location).toBe("https://cal.test/w.ics");
	});
});
