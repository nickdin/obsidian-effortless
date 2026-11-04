/**
 * Date entry's own settings body: the language dropdown and the trigger box.
 *
 * The card is driven the way a person drives it — choose from the dropdown,
 * type in the box — through the Obsidian stub's `Setting`, so what is asserted
 * is what ends up stored and on screen rather than which function was called.
 *
 * **One test reads the drawn card rather than the source**: that nothing on it
 * can be dragged. HTML5 drag never fires from a touch screen, and this feature
 * is meant to work on a phone;
 * `checkboxCyclingSettings.test.ts` already sweeps every file under
 * `src/features` for a drag handler, so what is left to say here is about the
 * elements this card actually puts on the screen.
 *
 * What a trigger may be is `triggerRefusal`'s answer and is checked on the
 * function as well, since the card only chooses where the sentence goes.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { App, Command, Plugin as ObsidianPlugin } from "obsidian";
import { Notice, Plugin, controlsUnder, resetSettings } from "./__mocks__/obsidian";
import type { DropdownComponent, TextComponent } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { Collections } from "../core/collections";
import { Feature } from "../core/feature";
import type { FeatureHost } from "../core/feature";
import type { NoteWriter } from "../core/noteWriter";
import type { FeatureProblems } from "../core/problems";
import type { CoreSettings } from "../core/settings";
import { SettingsStore } from "../core/settings";
import { DateEntry } from "../features/dateEntry/dateEntry";
import { renderDateEntrySettings } from "../features/dateEntry/settingsPanel";
import { triggerRefusal } from "../features/dateEntry/types";
import type { DateEntrySettings } from "../features/dateEntry/types";

/**
 * A host member the settings screen must never reach, which says so by throwing
 * with the member's own name in the message.
 */
function offLimits<T extends object>(what: string): T {
	return new Proxy({} as T, {
		get(_target, name) {
			throw new Error(`the settings screen reached the ${what} (${String(name)})`);
		},
	});
}

/** What a test holds onto after drawing the card. */
interface Card {
	readonly feature: DateEntry;
	/** The element the core hands the feature, with the card drawn into it. */
	readonly body: HTMLElement;
	/** The feature's slice of `data.json`, as its last save left it. */
	stored(): Partial<DateEntrySettings>;
	/** How many times the card has said that what it stores has changed. */
	reports(): number;
}

/** A loaded feature over a slice of `data.json`, with nothing drawn yet. */
function loadedFeature(seed: Partial<DateEntrySettings>): {
	feature: DateEntry;
	stored(): Partial<DateEntrySettings>;
} {
	let slice = seed;
	const host: FeatureHost = {
		// The suggester is made in `onload` and handed over; it is the one host
		// member this half legitimately reaches, and it does nothing here.
		app: {} as App,
		core: offLimits<CoreSettings>("core settings"),
		notes: offLimits<NoteWriter>("note writer"),
		calendar: offLimits<Calendar>("calendar"),
		collections: offLimits<Collections>("collections index"),
		problems: offLimits<FeatureProblems>("problem channel"),
		device: offLimits<FeatureHost["device"]>("device"),
		registerEditorSuggest: () => undefined,
		registerMarkdownCodeBlockProcessor: () => {
			throw new Error("the settings screen reached the code-block renderer");
		},
		addCommand: (_command: Command) => {
			throw new Error("the settings screen put a command in the palette");
		},
		removeCommand: () => undefined,
		settings: <T extends object>(defaults: T) => {
			const save = async (next: T): Promise<void> => {
				slice = next as Partial<DateEntrySettings>;
			};
			return {
				read: () => ({ ...defaults, ...slice }) as T,
				save,
				saveSoon: save,
				onChange: () => () => undefined,
			};
		},
	};

	const feature = new DateEntry(host);
	feature.load();
	return { feature, stored: () => slice };
}

/**
 * A loaded feature with its settings body drawn exactly as the core draws it:
 * `src/core/settingsTab.ts` makes an empty `div` inside the card and calls
 * `displaySettings` with it and with the way to say something changed.
 */
function cardOn(seed: Partial<DateEntrySettings> = {}): Card {
	const loaded = loadedFeature(seed);
	const body = document.createElement("div");
	let reports = 0;
	// Through the base class, because that is what the core holds.
	const drawn: Feature = loaded.feature;
	drawn.displaySettings(body, () => {
		reports += 1;
	});
	return { ...loaded, body, reports: () => reports };
}

/** The language dropdown. */
function languageBox(card: Card): DropdownComponent {
	return controlsUnder(card.body).get("Language")?.[0] as DropdownComponent;
}

/** The trigger box. */
function triggerBox(card: Card): TextComponent {
	return controlsUnder(card.body).get("Trigger character")?.[0] as TextComponent;
}

/** What the card says about a character it will not take, or "". */
function refusalIn(card: Card): string {
	return card.body.querySelector(".effortless-date-entry-refusal")?.textContent ?? "";
}

/** The sentence under one row of the card. */
function descriptionOf(card: Card, row: string): string {
	const named = Array.from(card.body.querySelectorAll<HTMLElement>(".setting-item")).filter(
		(item) => item.querySelector(".setting-item-name")?.textContent === row,
	);
	return named[0]?.querySelector(".setting-item-description")?.textContent ?? "";
}

/**
 * Lets the saves a press set off finish.
 *
 * Obsidian ignores what an `onChange` handler answers, so the panel starts its
 * write and returns; a test that asserted straight after the press would be
 * asking before the store had been told. A handful of turns rather than one,
 * because the write goes through the feature and the store and each hop is a
 * turn of its own.
 */
async function settled(): Promise<void> {
	for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

beforeEach(() => {
	resetSettings();
	Notice.messages = [];
});

describe("the language dropdown", () => {
	it("offers Svenska and English, and shows what is stored", () => {
		const card = cardOn({ language: "sv" });

		expect([...languageBox(card).options.entries()]).toEqual([
			["sv", "Svenska"],
			["en", "English"],
		]);
		expect(languageBox(card).getValue()).toBe("sv");
	});

	it("shows English where nothing is stored", () => {
		expect(languageBox(cardOn()).getValue()).toBe("en");
	});

	it("shows a stored language it does not know in its description, with the control on English", () => {
		// `data.json` is in the vault and can be hand-edited; the dropdown itself
		// can never produce anything but "sv" or "en".
		const card = cardOn({ language: "nb" as unknown as "sv" });

		expect(languageBox(card).getValue()).toBe("en");
		expect(descriptionOf(card, "Language")).toContain('"nb"');
		expect(card.feature.settings().language).toBe("en");
	});

	it("takes the problem line back once a language is chosen", async () => {
		const card = cardOn({ language: "nb" as unknown as "sv" });
		expect(descriptionOf(card, "Language")).toContain('"nb"');

		await languageBox(card).change("sv");
		await settled();

		expect(descriptionOf(card, "Language")).not.toContain('"nb"');
		expect(descriptionOf(card, "Language")).toContain("never follows Obsidian's own");
	});

	it("stores a language chosen, and the feature reads it at once", async () => {
		const card = cardOn();

		await languageBox(card).change("sv");
		await settled();

		expect(card.stored().language).toBe("sv");
		// What the next keystroke would read. No reload happened between these
		// two lines, which is the whole of spec #573's "both take effect at the
		// next keystroke".
		expect(card.feature.settings().language).toBe("sv");
	});

	it("says once that what it stores has changed", async () => {
		const card = cardOn();

		await languageBox(card).change("sv");
		await settled();

		expect(card.reports()).toBe(1);
	});
});

describe("the trigger box", () => {
	it("shows the stored trigger", () => {
		expect(triggerBox(cardOn({ trigger: "/" })).getValue()).toBe("/");
	});

	it("shows a stored trigger the card refuses, with the refusal sentence beside it, while the feature runs on @", () => {
		// The load notice sends the person here; the box has to show the
		// value the notice named, not the fallback the feature is running on.
		const card = cardOn({ trigger: "ab" });

		expect(triggerBox(card).getValue()).toBe("ab");
		expect(refusalIn(card)).toContain("one character");
		expect(card.feature.settings().trigger).toBe("@");
	});

	it("shows @ where nothing is stored, and offers it as the placeholder", () => {
		const card = cardOn();

		expect(triggerBox(card).getValue()).toBe("@");
		expect(triggerBox(card).placeholder).toBe("@");
	});

	it("says what the trigger does, and that @ is a symbol-layer character on a phone", () => {
		const said = descriptionOf(cardOn(), "Trigger character");

		expect(said).toContain("open the date popup");
		expect(said).toContain("symbol layer");
	});

	it.each([["/"], ["§"], ["!"], ["·"]])("takes the punctuation %s", async (typed) => {
		const card = cardOn();

		await triggerBox(card).change(typed);
		await settled();

		expect(card.stored().trigger).toBe(typed);
		expect(card.feature.settings().trigger).toBe(typed);
		expect(refusalIn(card)).toBe("");
	});

	it("says once that what it stores has changed", async () => {
		const card = cardOn();

		await triggerBox(card).change("/");
		await settled();

		expect(card.reports()).toBe(1);
	});
});

describe("a trigger the card refuses", () => {
	// One case each, the five spec #573 decision 2 names. Each one names the
	// character it refused and why, the stored trigger is left as it was, and
	// nothing is reported as changed.
	it.each([
		["an empty box", "", "empty"],
		["two characters", "ab", "one character"],
		["a letter", "d", "letter"],
		["a digit", "7", "digit"],
		["a space", " ", "whitespace"],
	])("refuses %s with a sentence saying why", async (_what, typed, because) => {
		const card = cardOn({ trigger: "/" });

		await triggerBox(card).change(typed);
		await settled();

		expect(refusalIn(card)).toContain(because);
		expect(card.stored().trigger).toBe("/");
		expect(card.feature.settings().trigger).toBe("/");
		expect(card.reports()).toBe(0);
	});

	it.each([
		["two characters", "ab"],
		["a letter", "d"],
		["a digit", "7"],
		["a space", " "],
	])("names the character it refused (%s)", async (_what, typed) => {
		const card = cardOn();

		await triggerBox(card).change(typed);
		await settled();

		expect(refusalIn(card)).toContain(JSON.stringify(typed));
	});

	it("takes the sentence back once a usable character is typed", async () => {
		const card = cardOn();

		await triggerBox(card).change("d");
		await settled();
		expect(refusalIn(card)).not.toBe("");

		await triggerBox(card).change("/");
		await settled();

		expect(refusalIn(card)).toBe("");
		expect(card.stored().trigger).toBe("/");
	});

	it("leaves what was typed in the box, so it can be fixed where it is", async () => {
		const card = cardOn();

		await triggerBox(card).change("d");
		await settled();

		expect(triggerBox(card).getValue()).toBe("d");
	});
});

describe("what a trigger may be, on the rule itself", () => {
	it.each([["@"], ["/"], ["§"], ["!"], ["#"], ["€"]])("accepts %s", (character) => {
		expect(triggerRefusal(character)).toBeNull();
	});

	it.each([[""], ["ab"], ["d"], ["å"], ["7"], [" "], ["\t"], ["\n"]])(
		"refuses %j",
		(character) => {
			expect(triggerRefusal(character)).not.toBeNull();
		},
	);

	it("counts a single-code-point emoji as one character", () => {
		// Code points rather than the units a string is stored in, which is
		// checkbox cycling's convention. Not graphemes: an emoji built of
		// several code points is more than one character to this rule.
		expect(triggerRefusal("\u{1F4CC}")).toBeNull();
		expect(triggerRefusal("❤️")).toContain("more than one");
	});
});

describe("choosing English explicitly, where it is already the shown fallback", () => {
	/**
	 * A mouse pick of the option already shown: `mousedown` opens the list
	 * (the moment the card disarms the shown value, per the doc comment on
	 * `settingsPanel.ts`'s dropdown), then the person picks English from it.
	 * Nothing dispatches `blur` — the point of #648/#649 is that the write
	 * happens at the pick, not when focus later leaves.
	 */
	it("a mouse pick of the already-shown English commits at once, with no blur", async () => {
		const card = cardOn({ language: "nb" as unknown as "sv" });
		// The load this card was drawn under already gave its own notice, for the
		// stored "nb"; only the fresh start below is under test here.
		Notice.messages = [];

		const dropdown = languageBox(card);
		dropdown.selectEl.dispatchEvent(new Event("mousedown"));
		await dropdown.change("en");
		await settled();

		expect(card.stored().language).toBe("en");
		expect(descriptionOf(card, "Language")).not.toContain('"nb"');
		expect(card.reports()).toBe(1);

		loadedFeature(card.stored());
		expect(Notice.messages).toEqual([]);
	});

	/**
	 * The same pick, but arrived at by keyboard: no `mousedown` ever fires,
	 * only the `keydown` a person uses to open a focused, closed `<select>`. Again no `blur` — the criterion is "commits immediately".
	 */
	it("a keyboard pick of the already-shown English commits at once, with no mousedown and no blur", async () => {
		const card = cardOn({ language: "nb" as unknown as "sv" });
		Notice.messages = [];

		const dropdown = languageBox(card);
		dropdown.selectEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		await dropdown.change("en");
		await settled();

		expect(card.stored().language).toBe("en");
		expect(descriptionOf(card, "Language")).not.toContain('"nb"');
		expect(card.reports()).toBe(1);

		loadedFeature(card.stored());
		expect(Notice.messages).toEqual([]);
	});

	/**
	 * Opening the list and abandoning it — no pick at all — must never write,
	 * however the stored value looks. The one existing test below already
	 * pinned this for a usable stored `sv`; #646/#650 is that the unusable
	 * case, the only one an abandoned open could actually change, was never
	 * pinned and the merged code gets it wrong.
	 */
	it("does not write on an opened-and-abandoned dropdown for an unusable stored language either", async () => {
		const card = cardOn({ language: "nb" as unknown as "sv" });
		Notice.messages = [];

		const select = languageBox(card).selectEl;
		select.dispatchEvent(new Event("mousedown"));
		select.dispatchEvent(new Event("blur"));
		await settled();

		expect(card.reports()).toBe(0);
		expect(card.stored().language).toBe("nb");
		expect(descriptionOf(card, "Language")).toContain('"nb"');
		// Abandoning the open must not leave the control looking blank.
		expect(languageBox(card).getValue()).toBe("en");
	});

	it("the same abandoned open, reached by keyboard, does not write either", async () => {
		const card = cardOn({ language: "nb" as unknown as "sv" });
		Notice.messages = [];

		const select = languageBox(card).selectEl;
		select.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		select.dispatchEvent(new Event("blur"));
		await settled();

		expect(card.reports()).toBe(0);
		expect(card.stored().language).toBe("nb");
	});

	it("still stores sv when Swedish is explicitly chosen instead", async () => {
		const card = cardOn({ language: "nb" as unknown as "sv" });

		await languageBox(card).change("sv");
		await settled();

		expect(card.stored().language).toBe("sv");
	});

	it("does not repair the stored value merely by drawing the card", () => {
		const card = cardOn({ language: "nb" as unknown as "sv" });

		expect(card.stored().language).toBe("nb");
	});

	it("does not write on an opened-and-abandoned dropdown for an already-usable stored language", async () => {
		const card = cardOn({ language: "sv" });

		const select = languageBox(card).selectEl;
		select.dispatchEvent(new Event("mousedown"));
		select.dispatchEvent(new Event("blur"));
		await settled();

		expect(card.reports()).toBe(0);
		expect(card.stored().language).toBe("sv");
	});
});

describe("the two #620 criteria a review found backed only by argument", () => {
	it("typing a usable trigger into the box stores it, clears the problem line, and the next start shows no notice", async () => {
		const card = cardOn({ trigger: "ab" });
		// The load this card was drawn under already gave its own notice, for the
		// stored "ab"; only the fresh start below is under test here.
		Notice.messages = [];

		await triggerBox(card).change("/");
		await settled();

		expect(card.stored().trigger).toBe("/");
		expect(refusalIn(card)).toBe("");

		loadedFeature(card.stored());
		expect(Notice.messages).toEqual([]);
	});

	it("with a usable stored trigger and language, reads exactly as it did before this change", () => {
		const card = cardOn({ trigger: "/", language: "sv" });

		expect(triggerBox(card).getValue()).toBe("/");
		expect(languageBox(card).getValue()).toBe("sv");
		expect(descriptionOf(card, "Language")).toBe(
			"Which language a date you type is read in. It never follows Obsidian's own.",
		);
		expect(refusalIn(card)).toBe("");
	});
});

describe("a card whose stored trigger and language are both unusable", () => {
	it("saving one leaves the other's bad stored value exactly as it was, rather than repairing it", async () => {
		// Choosing a language must not silently launder a bad stored trigger it
		// never touched — the store is the one truth, not `feature.settings()`'s
		// judged view of it (Ticket #620, #588's rule).
		const card = cardOn({ trigger: "ab", language: "nb" as unknown as "sv" });

		await languageBox(card).change("sv");
		await settled();

		expect(card.stored()).toEqual({ trigger: "ab", language: "sv" });
		expect(refusalIn(card)).toContain("one character");
	});
});

describe("the card as a whole", () => {
	it("holds no draggable element", () => {
		const card = cardOn();

		expect(card.body.querySelectorAll("[draggable]")).toHaveLength(0);
	});

	it("draws two rows and nothing else", () => {
		const card = cardOn();

		expect([...controlsUnder(card.body).keys()]).toEqual(["Language", "Trigger character"]);
	});

	it("puts every class it applies inside the element the core handed over", () => {
		const card = cardOn();

		expect(card.body.querySelector(".effortless-date-entry-settings")).not.toBeNull();
		expect(card.body.querySelector(".effortless-date-entry-refusal")).not.toBeNull();
	});
});

describe("a settings write that fails", () => {
	/**
	 * The real store, so that a failed write travels the whole way a real one
	 * does — the queue, the restore, the notice — rather than being refused by a
	 * plain object that never touched what it holds. Each test below decides how
	 * the write fails by replacing `saveData` itself.
	 */
	async function overARealStore(): Promise<{ plugin: Plugin; card: Card }> {
		const plugin = new Plugin();
		plugin.load();
		const store = new SettingsStore(plugin as unknown as ObsidianPlugin);
		await store.load();
		// A fresh install's own languageHistory write starts here and is not
		// awaited by `load()` itself; settled before the test
		// below replaces `saveData` and writes its own, or that replacement
		// can land on this write instead of the one the test means to fail.
		await store.flush();
		plugin.saved.length = 0;
		const handle = store.handleFor<DateEntrySettings>("date-entry", {
			language: "en",
			trigger: "@",
		});
		let reports = 0;
		const body = document.createElement("div");
		renderDateEntrySettings(
			body,
			{
				stored: () => handle.read(),
				saveSettings: (next) => handle.save(next),
			},
			() => {
				reports += 1;
			},
		);
		const card: Card = {
			feature: null as unknown as DateEntry,
			body,
			stored: () => handle.read(),
			reports: () => reports,
		};
		return { plugin, card };
	}

	it("says out loud that the setting was not stored, and reports no change", async () => {
		const { plugin, card } = await overARealStore();
		plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));

		await triggerBox(card).change("/");
		await settled();

		expect(Notice.messages.join("\n")).toContain("could not be saved");
		expect(card.reports()).toBe(0);
	});
});
