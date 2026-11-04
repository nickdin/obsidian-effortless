/**
 * The one owner of the plugin's stored data, and the one owner of what stays
 * on this device.
 *
 * Obsidian gives a plugin a single `data.json`, so five formerly separate
 * plugins merging under one manifest id cannot each write the whole file with
 * only their own settings in it — the first to save would erase the rest. The
 * fix is that nothing but this module ever calls `saveData`: a feature is handed
 * a handle onto its own slice and cannot reach anyone else's.
 *
 * The stored shape is three tiers:
 *
 *     { "core": { … }, "features": { "<feature-id>": { … } } }
 *
 * `data.json` lives in the vault and syncs, so anything whose answer is this
 * device's alone must never be written into it. That is what `DeviceStore` at
 * the foot of this file is for.
 */

import { getLanguage, Notice } from "obsidian";
import type { App, Plugin } from "obsidian";
import { reasonOf } from "./reason";
// Value imports, unlike the types around them, and the one route between these
// two modules that survives compilation: `calendarSources.ts` imports this
// module back, but only for a type, so nothing here is part of a runtime cycle. That sentence was false for a while — the calendar module took
// `asVaultPath` from here as a value, and the two modules imported each other
// in earnest. Moving the vault-path rule to `vaultLayout.ts` is what made it
// true again.
import { asLocation, newCalendarSourceId } from "./calendarSources";
import type { CalendarRead, CalendarSource } from "./calendarSources";
// A type only, and erased: `calendarAccounts.ts` imports the calendar module,
// never this one, so nothing here becomes part of a runtime cycle.
import type { CalendarAccount } from "./calendarAccounts";
// A type only, and erased: `feature.ts` imports this module's types back, and
// neither import survives compilation.
import type { SettingsChanged } from "./feature";
// `vaultLayout.ts` imports this module back, but only for `HeadingSetting` and
// `VaultLayout` as types, so this stays the same one-way value import the
// comment above `asLocation` describes for `calendarSources.ts`.
import { asVaultPath, fieldNameRefusal, SHIPPED_FIELD_NAMES, storedFieldName } from "./vaultLayout";
// `builtDiaries.ts` imports this module back, but only for types, so this stays
// one-way at run time like the two imports above.
import { isBuiltDiaryDay, readBuiltDiaries } from "./builtDiaries";
import type { BuiltDiaries } from "./builtDiaries";
// `unrecognisedKeys.ts` imports this module back, but only for a type, so this
// stays one-way at run time like the imports above.
import { unrecognisedIn, withUnrecognised } from "./unrecognisedKeys";
import type { Unrecognised } from "./unrecognisedKeys";
/** A section heading in the daily log, with the level it is written at. */
export interface HeadingSetting {
	/** The heading text, without its leading hashes. */
	text: string;
	/** 1 for `# Heading`, 2 for `## Heading`, and so on. */
	level: number;
}

/**
 * The day's-log filename's month and weekday names, tracked across a change
 * to Obsidian's own display language (`getLanguage`, `obsidian.d.ts:3365`):
 * the language active now, and the one active immediately before it last
 * changed, so a name already written under the old language still reads back
 * after the switch. No further back than that one step — recognising a name
 * from further back would mean carrying an open-ended history of every
 * language a vault has ever run under, for a case (two language switches with
 * nobody reading the intervening logs) nothing here depends on.
 */
export interface LanguageHistory {
	/** Obsidian's display language as of the last time {@link SettingsStore.load} checked it against this. */
	current: string;
	/** What {@link current} held immediately before it last changed, or `null` before any change has been seen. */
	previous: string | null;
}

/**
 * Where the daily log lives and how it is written. Owned by the core rather
 * than by any feature, because several features must agree on it exactly.
 *
 * A day's-log heading carries its level, because there the level decides where
 * a line goes. A collection's headings carry none, because there the level only
 * decides whether the note counts and is deliberately ignored — different
 * collections may use different heading sizes.
 */
export interface VaultLayout {
	/** Vault-relative folder holding the daily logs. Blank until the user answers. */
	dailyLogFolder: string;
	/** Date pattern for a daily log's filename, e.g. `YYYY-MM-DD`. Blank until answered. */
	dailyLogFilename: string;
	/**
	 * The vault path of the note a new day's log is built from, blank until
	 * answered. Blank means unchanged behaviour: `createDailyLog`
	 * (`noteWriter.ts`) builds the day from {@link dailyLogFrame} exactly as it
	 * always has. Answered, it builds the day from that note's own text
	 * instead, with `{{date:FORMAT}}`, `{{yesterday:FORMAT}}` and
	 * `{{tomorrow:FORMAT}}` filled for the day being created
	 * (`dailyLogTemplate.ts`, issue #907).
	 */
	dailyLogTemplate: string;
	/** The section a day's captured tasks are written under. */
	notesHeading: HeadingSetting;
	/** The section holding the day's calendar table. */
	calendarHeading: HeadingSetting;
	/**
	 * The section a person writes about the day itself under, last in a new
	 * day's log (`GLOSSARY.md`, **Diary**; issue #1107). Blank leaves it out of
	 * new days. Shipped as `Diary` for a fresh install, but read as blank from a
	 * settings file written before this setting existed, so no existing
	 * install's new days grow a section nobody asked for ({@link migrateLayout}).
	 */
	diaryHeading: HeadingSetting;
	/** The section a copied task lands under when it is due today, not before. */
	todayHeading: HeadingSetting;
	/** The section a rolled-over task reappears under, directly above {@link todayHeading}. */
	overdueHeading: HeadingSetting;
	/**
	 * The frontmatter property whose empty value says a note has not been gone
	 * through yet and whose any value says it has, named once for the whole
	 * vault. Meeting notes writes it blank on every
	 * note it makes; Review reads it. Moved here from Meeting notes' template.
	 */
	processedField: string;
	/**
	 * The frontmatter property that links a note other than a day's log to the
	 * day's log it belongs to, named once for the whole vault. Meeting notes
	 * writes it; Review reads it. Moved here from Meeting notes' template.
	 */
	dayLinkField: string;
	/**
	 * The frontmatter property the plugin fills with the date it first saw text
	 * under the diary heading, named once for the whole vault (ADR 0005, spec
	 * #1049). Review writes it and reads it; the core only holds the name, and a
	 * file without it simply answers the shipped `diary`.
	 */
	diaryDateField: string;
	/** The one heading, named once for the whole vault, that marks a collection. */
	tasksHeading: string;
	/** Where a collection's finished tasks are moved to. The plugin writes this one. */
	completedTasksHeading: string;
	/**
	 * The calendar table's two column names, matched case-insensitively.
	 * Matching by name rather than by column count is what stops the plugin
	 * mangling an unrelated two-column table.
	 */
	calendarColumns: { time: string; event: string };
	/**
	 * Folders whose notes are never collections, shipped empty. It exists for
	 * templates: a template is meant to be copied, so a stray one would be a
	 * permanent wrong entry rather than a one-time cleanup.
	 */
	excludedFolders: string[];
	/** See {@link LanguageHistory}. */
	languageHistory: LanguageHistory;
}

export interface CoreSettings {
	layout: VaultLayout;
	/** Which features the user has switched on. Absent means on: every feature ships on. */
	enabled: Record<string, boolean>;
	/**
	 * The calendars the plugin reads, in the order they were added. Unbounded,
	 * and owned by the core rather than by a feature because two features read
	 * the calendar and neither may ask the other (ADR 0001).
	 */
	calendarSources: CalendarSource[];
	/**
	 * The calendar accounts the person has added: each one's server address
	 * and user name, which travel with the vault. **Never its app-specific
	 * password**, which stays on the device it was typed on
	 * in Obsidian's keychain ({@link DeviceStore.password}, spec #1212
	 * decision 1, #1216). The
	 * calendars on an account are rows of `calendarSources`, of kind `account`.
	 */
	calendarAccounts: CalendarAccount[];
	/**
	 * The day (`YYYY-MM-DD`) → the diary section that day's log was built with,
	 * kept by the note writer at build time so that an untouched log is never taken
	 * for a written one after the template is reworded (`builtDiaries.ts`, ticket
	 * #1201). Written only
	 * through {@link SettingsStore.keepBuiltDiary}, and replaced whole each time, so
	 * a snapshot may share it.
	 */
	builtDiaries: BuiltDiaries;
}

/** The key `core.builtDiaries` is stored under, which also stands in `droppedBuilt` for the whole record. */
const BUILT_DIARIES = "builtDiaries";
/** How a notice names the whole of `core.builtDiaries`. */
const BUILT_DIARIES_NAME = "The diary sections days were built with";

export interface EffortlessData {
	core: CoreSettings;
	features: Record<string, unknown>;
}

/**
 * The shipped vault layout. English throughout: another person's vault must not
 * inherit this vault's Swedish words, which are settings he enters instead.
 *
 * The two daily-log answers are blank on purpose: the plugin ships knowing
 * nothing about the vault and asks one question above the feature list. A
 * feature that needs an answer reports itself not configured until it has one,
 * which is a normal state rather than an error.
 */
export function shippedLayout(): VaultLayout {
	return {
		dailyLogFolder: "",
		dailyLogFilename: "",
		dailyLogTemplate: "",
		notesHeading: { text: "Notes", level: 1 },
		calendarHeading: { text: "Calendar", level: 2 },
		// English defaults, matching every other layout default: the author's own
		// `Att göra idag` and `Försenade` are values entered by hand, not defaults a
		// stranger's vault inherits (issue #801, decision 5 on issue #709).
		todayHeading: { text: "Today", level: 2 },
		overdueHeading: { text: "Overdue", level: 2 },
		// At the notes heading's level, so the diary sits beside the notes a
		// person writes, not nested under them.
		diaryHeading: { text: "Diary", level: 1 },
		...SHIPPED_FIELD_NAMES,
		tasksHeading: "Tasks",
		completedTasksHeading: "Completed tasks",
		// *Meeting*, not *Event*: `GLOSSARY.md` retires *event* under **Meeting**,
		// and a shipped default is a string on the settings screen of every
		// install that has never changed it. The field name stays `event` —
		// renaming that is a `data.json` migration with nothing a person would
		// see for it (issue #195; issue #69's brief draws the same line).
		calendarColumns: { time: "Time", event: "Meeting" },
		excludedFolders: [],
		// No change has been seen yet, so there is nothing to fall back to —
		// `reconcileLanguageHistory` is what starts recording one, the first
		// time `load()` finds the app's language has moved since this ran.
		languageHistory: { current: getLanguage(), previous: null },
	};
}

/** Shipped defaults for the whole file. */
export function defaultData(): EffortlessData {
	return {
		core: { layout: shippedLayout(), enabled: {}, calendarSources: [], calendarAccounts: [], builtDiaries: {} },
		features: {},
	};
}

/** A feature's view of its own stored settings. It can reach nothing else. */
export interface FeatureSettings<T> {
	/**
	 * The slice as the store holds it now, the feature's defaults filled in.
	 *
	 * After `save` or `saveSoon` has rejected, this reads what `data.json`
	 * holds unless another write is still going to carry the change — the
	 * store's contract, written out on `SettingsStore.queueWrite`.
	 */
	read(): T;
	/** Stores the slice and writes the file now. One press, one write. */
	save(next: T): Promise<void>;
	/**
	 * The same as `save`, but for an answer that arrives once per keystroke.
	 *
	 * The slice changes straight away, so a redraw shows what was typed; only
	 * the write waits, until the typing has stopped for `SAVE_AFTER_TYPING_MS`.
	 * Every call in one run of typing is answered by the same promise, which
	 * fails if the write fails, and the write it defers is the one the unload
	 * drains — a name typed just before Obsidian closes is written, not lost.
	 * The contract is `SettingsStore.saveCoreSoon`'s exactly, because it is the
	 * same machinery: one pending write for the whole file, whichever route
	 * asked for it.
	 */
	saveSoon(next: T): Promise<void>;
	/**
	 * Asks to be told whenever the store puts its memory back to what
	 * `data.json` holds, and hands back the one way to stop being told.
	 *
	 * For a feature that keeps something of its own in step with `read()` — a
	 * command palette built from a list. After its own `save` or `saveSoon`
	 * answers, the feature can bring that into line itself; but the store puts
	 * memory back when *the last* write queued is refused, and that can be
	 * another route's write, long after this feature's own has answered. Nothing
	 * else tells the feature that `read()` has changed under it.
	 *
	 * The store's `onChange`, not a signal of this slice's own: a restore puts
	 * the whole of memory back at once, and it says nothing about whose slice
	 * differs. Register it from `onload` through `Component.register`, so the
	 * switch off drops it.
	 */
	onChange(listener: SettingsChanged): () => void;
}

/**
 * How long the typing has to stop before a debounced save writes the file.
 *
 * Long enough that a run of characters at any ordinary typing speed is one
 * write, short enough that nobody notices it. Exported so a test can wait
 * exactly this long rather than guess.
 */
export const SAVE_AFTER_TYPING_MS = 400;

/**
 * What every route into the settings file answers once the plugin has
 * unloaded. One string, because a caller telling the person apart from any
 * other failed write matches on it, and two routes wording it differently
 * would be two things to match.
 */
const UNLOADED = "The plugin has unloaded.";

/**
 * What a write answers when `data.json`, read back straight after it, does not
 * hold what was written — the one sign of a failed write to disk this store can
 * see. The settings
 * screen shows it after "that setting could not be saved."
 */
const NOT_STORED = "The settings file does not hold what was just written to it.";

/**
 * The settings as they stand now, copied deeply enough that nothing which
 * changes them afterwards can reach the copy.
 *
 * {@link SettingsStore.waiting}'s `write` takes one of these instead of the
 * live object, at the moment it runs — and does so for every starter that
 * empties the slot alike: the debounce timer firing, {@link
 * SettingsStore.flush}, and {@link SettingsStore.teardown}. `teardown`'s own
 * comment says why a copy is needed at all: a route refused after the unload
 * has its call stopped and its change already made, and the deferred write
 * would otherwise carry that change into the file. It took two of
 * the three starters copying before it took all of them: `flush` and
 * `teardown` each copied for a while, because either can be the one that
 * empties the deferred slot and the other then has nothing left to copy — and the timer
 * went on handing over the live settings until the same argument was made for
 * it and the copy moved into `write` itself, where no starter can miss it.
 *
 * **A shallow copy is not enough**, because two of the three things inside are
 * changed in place rather than replaced: `core.enabled`, which `setEnabled`
 * writes one key of, and `features`, where a feature's handle writes its own
 * slice into the record. Each therefore gets a copy of its own.
 * `calendarSources` is copied a row at a time as well — nothing edits a row in
 * place today, every route rebuilds the list, but the copy costs a row and the
 * first caller to edit one would leak in silence. `layout` is only ever
 * replaced whole, by `saveCore` and `saveCoreSoon`, so the copy shares it.
 *
 * **It is the copy in the other direction as well.** The store keeps what the
 * last landed write carried as one of these, and a write that rejects with
 * nothing behind it puts memory back to a fresh copy of that one, never to the
 * kept copy itself — `setEnabled` edits `core.enabled` in place, and would
 * otherwise edit the kept copy with it.
 *
 * Written out field by field rather than cloned by some general rule: a field
 * added to `CoreSettings` and forgotten here is a compiler error, where a
 * spread would have quietly carried the live object through. The one thing it
 * does not reach is the inside of a feature's own slice, which is stored as it
 * was handed over — a feature that keeps its saved object and edits it later
 * changes what a snapshot holds, and no route in this file does that.
 */
function snapshotOf(data: EffortlessData): EffortlessData {
	return {
		core: {
			layout: data.core.layout,
			enabled: { ...data.core.enabled },
			calendarSources: data.core.calendarSources.map((source) => ({ ...source })),
			calendarAccounts: data.core.calendarAccounts.map((account) => ({ ...account })),
			builtDiaries: data.core.builtDiaries,
		},
		features: { ...data.features },
	};
}

/**
 * A parsed `data.json`, read the way {@link SettingsStore.load} and
 * {@link SettingsStore.reloadExternal} both need it: every layer validated and
 * the layout migrated, with what each step found alongside, so the caller
 * decides what a refused value costs.
 */
function readFile(
	raw: unknown,
	held: readonly CalendarSource[] = [],
	heldAccounts: readonly CalendarAccount[] = [],
): {
	data: EffortlessData;
	/** What {@link readCalendarAccounts} could not use in `core.calendarAccounts`. */
	accounts: AccountsRefused;
	language: ReturnType<typeof reconcileLanguageHistory>;
	migrated: MigratedLayout;
	/** The keys of `core.builtDiaries` that could not be used, or `builtDiaries` itself when it was not a table. */
	droppedBuilt: string[];
	/** Whether the file has no `core.builtDiaries` at all, `core` itself missing included: what an older build's save leaves. */
	builtAbsent: boolean;
	/** What the file holds under `core` and `core.layout` that this build does not recognise. */
	unrecognised: Unrecognised;
} {
	const stored = asRecord(raw);
	const core = asRecord(stored.core);
	const storedLayout = asRecord(core.layout);
	const language = reconcileLanguageHistory(storedLayout.languageHistory);
	const features = asRecord(stored.features);
	const migrated = migrateLayout(core.layout, language.history, features, holdsNothing(raw));
	const built = readBuiltDiaries(core.builtDiaries, BUILT_DIARIES, isBuiltDiaryDay);
	const accounts = readCalendarAccounts(core.calendarAccounts, heldAccounts, core.calendarSources);
	return {
		accounts: accounts.refused,
		language,
		migrated,
		droppedBuilt: built.dropped,
		builtAbsent: core.builtDiaries === undefined,
		unrecognised: { core: unrecognisedIn(core, CORE_KEYS), layout: migrated.unrecognised },
		data: {
			core: {
				layout: migrated.layout,
				enabled: readSwitches(core.enabled),
				calendarSources: readCalendarSources(core.calendarSources, held),
				calendarAccounts: accounts.accounts,
				builtDiaries: built.sections,
			},
			features,
		},
	};
}

/**
 * Whether `raw`, what `loadData` handed over, holds no stored settings at all:
 * no file (`null`, or `undefined` where it could not be read), a value that is
 * not a record, or a record with no keys. This is the one place a fresh install
 * is told from an upgrade, and it is the whole file that is judged, not the
 * layout: a file carrying anything at all — a layout, a feature's slice, a
 * switch — was written by a version of the plugin that had no diary heading,
 * and {@link migrateLayout} reads its heading as blank.
 */
function holdsNothing(raw: unknown): boolean {
	return !isRecord(raw) || Object.keys(raw).length === 0;
}

/** Whether a parsed value is a plain record, which is what every layer of `data.json` is. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The name a person knows each layout field by, which is what a notice about
 * that field says. Every field but `languageHistory`, which is no person's
 * answer and has no row: a field added to {@link VaultLayout} and forgotten
 * here is a compiler error, so no notice can fall back to a key's code name.
 */
const LAYOUT_ROW_NAMES: { readonly [K in Exclude<keyof VaultLayout, "languageHistory">]: string } = {
	dailyLogFolder: "Folder",
	dailyLogFilename: "Filename",
	dailyLogTemplate: "Day's-log template",
	notesHeading: "Notes heading",
	calendarHeading: "Calendar heading",
	diaryHeading: "Diary heading",
	todayHeading: "Today heading",
	overdueHeading: "Overdue heading",
	processedField: "Processed field",
	dayLinkField: "Day link field",
	diaryDateField: "Diary date field",
	tasksHeading: "Tasks heading",
	completedTasksHeading: "Completed tasks heading",
	calendarColumns: "Calendar table columns",
	excludedFolders: "Excluded folders",
};

/** The layout fields a person answers, in the order a notice names them. */
const NAMED_LAYOUT_KEYS = Object.keys(LAYOUT_ROW_NAMES) as Array<keyof typeof LAYOUT_ROW_NAMES>;

/** Every key of {@link VaultLayout}: what this build reads under `core.layout`. */
const LAYOUT_KEYS: ReadonlySet<string> = new Set<string>([...NAMED_LAYOUT_KEYS, "languageHistory"]);

/**
 * Every key of {@link CoreSettings}: what this build reads under `core`. Typed
 * so that a field added to `CoreSettings` and forgotten here is a compiler
 * error rather than a key this build would carry as unknown and write twice.
 */
const CORE_KEYS: ReadonlySet<string> = new Set(
	Object.keys({ layout: true, enabled: true, calendarSources: true, calendarAccounts: true, builtDiaries: true } satisfies {
		[K in keyof CoreSettings]: true;
	}),
);

/**
 * The layout fields {@link readFile} reads with a plain default, and the row
 * name a person knows each by. A value present in the file but not text is
 * refused on a reload; the headings, template and property names have their
 * own refusal in {@link migrateLayout}.
 */
const REFUSED_TEXT_FIELDS = (["dailyLogFolder", "dailyLogFilename", "tasksHeading", "completedTasksHeading"] as const).map(
	(key) => [LAYOUT_ROW_NAMES[key], key] as const,
);

/**
 * Which layers of a reloaded file are there but not a record, and so refused
 * whole: {@link refuseUnusable} puts this device's answer in for each, and
 * {@link SettingsStore.reloadExternal} keeps what it held of the keys this build
 * does not recognise under each. One answer, so the two cannot disagree.
 */
function refusedLayers(raw: Record<string, unknown>): { core: boolean; layout: boolean } {
	const core = raw.core !== undefined && !isRecord(raw.core);
	return { core, layout: core || (isRecord(raw.core) && raw.core.layout !== undefined && !isRecord(raw.core.layout)) };
}

/**
 * What a reload found in the file that the code cannot use and {@link readFile}
 * would silently have replaced — a switch that is not true or false, a calendar
 * list that is not a list, a folder, filename or heading that is not text, a
 * layer that is not a record — put back to this device's answer in `theirs`,
 * which {@link readFile} has just built from the file, so that it merges and
 * lands as "no change from the file". Returns the row name of each, for the
 * notice. A value simply absent is the ordinary "never answered" case and is not
 * refused (`CLAUDE.md`: a value read from `data.json` is refused with a notice,
 * never silently replaced; findings #1087).
 */
function refuseUnusable(
	raw: Record<string, unknown>,
	theirs: EffortlessData,
	ours: EffortlessData,
): string[] {
	const names: string[] = [];
	if (raw.features !== undefined && !isRecord(raw.features)) {
		names.push("Feature settings");
		theirs.features = ours.features;
	}
	if (raw.core === undefined) return names;
	const layers = refusedLayers(raw);
	if (layers.core) {
		names.push("Core settings");
		theirs.core = ours.core;
		return names;
	}
	const core = asRecord(raw.core);
	if (layers.layout) {
		names.push("Layout");
		theirs.core.layout = ours.core.layout;
	} else {
		const layout = asRecord(core.layout);
		const theirLayout = theirs.core.layout as unknown as Record<string, unknown>;
		const ourLayout = ours.core.layout as unknown as Record<string, unknown>;
		for (const [name, key] of REFUSED_TEXT_FIELDS) {
			if (key in layout && typeof layout[key] !== "string") {
				names.push(name);
				theirLayout[key] = ourLayout[key];
			}
		}
		const columns = layout.calendarColumns;
		if (
			columns !== undefined &&
			(!isRecord(columns) ||
				(columns.time !== undefined && typeof columns.time !== "string") ||
				(columns.event !== undefined && typeof columns.event !== "string"))
		) {
			names.push(LAYOUT_ROW_NAMES.calendarColumns);
			theirs.core.layout.calendarColumns = ours.core.layout.calendarColumns;
		}
		if (layout.excludedFolders !== undefined && !Array.isArray(layout.excludedFolders)) {
			names.push(LAYOUT_ROW_NAMES.excludedFolders);
			theirs.core.layout.excludedFolders = ours.core.layout.excludedFolders;
		}
	}
	if (core.enabled !== undefined && !isRecord(core.enabled)) {
		names.push("Feature switches");
		theirs.core.enabled = { ...ours.core.enabled };
	} else {
		for (const [id, on] of Object.entries(asRecord(core.enabled))) {
			if (typeof on === "boolean") continue;
			names.push(`The "${id}" switch`);
			if (Object.prototype.hasOwnProperty.call(ours.core.enabled, id)) {
				theirs.core.enabled[id] = ours.core.enabled[id];
			} else {
				delete theirs.core.enabled[id];
			}
		}
	}
	if (core.calendarSources !== undefined && !Array.isArray(core.calendarSources)) {
		names.push("Calendar list");
		theirs.core.calendarSources = ours.core.calendarSources;
	}
	if (core.calendarAccounts !== undefined && !Array.isArray(core.calendarAccounts)) {
		names.push(CALENDAR_ACCOUNTS_NAME);
		theirs.core.calendarAccounts = ours.core.calendarAccounts;
	}
	return names;
}

/** How a notice names the entries of `core.builtDiaries` that could not be used. */
function builtDiariesNames(dropped: readonly string[]): string[] {
	if (dropped.length === 0) return [];
	if (dropped.includes(BUILT_DIARIES)) return [BUILT_DIARIES_NAME];
	return [`The diary section kept for ${dropped.map((day) => `"${day}"`).join(", ")}`];
}

/** Says at load which entries of `core.builtDiaries` could not be used; without them those logs are compared with the template as it reads. */
function tellBuiltDiariesDropped(dropped: readonly string[]): void {
	const names = builtDiariesNames(dropped);
	if (names.length === 0) return;
	new Notice(`Effortless: ${names.join(", ")} could not be used and was left out. Those days' logs are compared with the day's-log template as it reads now.`);
}

/**
 * The file's `core.builtDiaries` on a reload, with this device's answer standing
 * in for each entry the file holds but the code cannot use, and for the whole
 * record when it is not a table: refused, not replaced, so it merges and lands as
 * "no change from the file", the way {@link refuseUnusable} treats a setting.
 */
function refuseUnusableBuilt(dropped: readonly string[], theirs: BuiltDiaries, ours: BuiltDiaries): BuiltDiaries {
	if (dropped.includes(BUILT_DIARIES)) return ours;
	const kept: Record<string, string> = { ...theirs };
	for (const day of dropped) {
		if (Object.prototype.hasOwnProperty.call(ours, day)) kept[day] = ours[day];
	}
	return kept;
}

function tellLanguageHistoryReset(): void {
	new Notice(
		"Effortless: the day's-log language history stored in its settings could not be used and was reset. Nothing to do — this repairs itself as Obsidian runs.",
	);
}

/** Whether two settings values are the same, as `data.json` would hold them. */
function sameValue(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A three-way merge of one record, key by key: a key this device has not
 * changed since `base` takes the file's answer (`theirs`) — gone from the file
 * means gone — and a key it has changed keeps `ours`.
 */
function mergeRecord<T>(
	base: Readonly<Record<string, T>>,
	theirs: Readonly<Record<string, T>>,
	ours: Readonly<Record<string, T>>,
): Record<string, T> {
	const merged: Record<string, T> = {};
	const has = (record: Readonly<Record<string, T>>, key: string): boolean =>
		Object.prototype.hasOwnProperty.call(record, key);
	for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
		const touched = has(ours, key) !== has(base, key) || !sameValue(ours[key], base[key]);
		const source = touched ? ours : theirs;
		if (has(source, key)) merged[key] = source[key];
	}
	return merged;
}

export class SettingsStore {
	private data: EffortlessData = defaultData();

	/**
	 * The write in flight, or a settled promise when there is none. Every save
	 * chains onto it, so two writes of `data.json` are never open at once.
	 *
	 * Obsidian's vault adapter does not queue writes to one path, so two that
	 * overlap can land in either order and the file keeps whichever finished
	 * last. `persist` writes `this.data` as it stands when its turn comes, so a
	 * queued write carries the newest answers rather than the ones it was
	 * issued with — which is what makes the file end on the last thing typed.
	 *
	 * **Every write reassigns this field, so anything waiting for the store to
	 * go quiet has to re-read it after each await rather than hold the promise
	 * it read first.** `flush` is the one place that does; reading it once let
	 * it answer while a save started during its own wait was still open.
	 */
	private writing: Promise<void> = Promise.resolve();

	/**
	 * What `data.json` holds, as far as this store knows: the settings the last
	 * write to land carried, copied as that write was handed to `saveData`, or
	 * what `load` read when nothing has landed since.
	 *
	 * It is what memory is put back to when a write fails and no other write
	 * is going to carry the change — {@link queueWrite} says when that is. Kept
	 * rather than read from the file at the restore, because the copy is the
	 * file: a write replaces it only once the file has been read back holding
	 * exactly what was written.
	 */
	private landed: EffortlessData = defaultData();

	/**
	 * What `data.json` holds that this build does not recognise, as the file
	 * last read held it: replaced by every {@link load} and
	 * {@link reloadExternal}, never by this device, and spread back into every
	 * write by {@link queueWrite}. Held beside the settings rather than in
	 * them, so no feature and no screen ever sees it ({@link Unrecognised}).
	 */
	private unrecognised: Unrecognised = { core: {}, layout: {} };

	/**
	 * The debounced write that has been asked for and not yet started, if any.
	 * One for the whole store: every caller that arrives while it is waiting
	 * pushes the write further out and is answered by the same promise.
	 *
	 * **One slot, not one per route.** The core's `saveCoreSoon` and a feature
	 * handle's `saveSoon` both defer into it, because they defer a write of the
	 * same file: a second slot per feature would be two timers racing to write
	 * `data.json`, and `flush` and `teardown` would have to drain each of them.
	 */
	private waiting: {
		timer: number;
		done: Promise<void>;
		/**
		 * Runs the held write now, taking its own snapshot of the settings
		 * rather than trusting whichever starter emptied this slot to bring one.
		 * The timer firing, `flush`, and `teardown` all call this and nothing
		 * else, so the copy happens exactly once, at the moment this starter
		 * runs, whichever of the three that is. Before
		 * this, the timer handed over the live settings object and `flush` and
		 * `teardown` each took their own copy as they emptied the slot; the two
		 * copies collapsed into this one so a fourth starter could not reopen
		 * the same door by forgetting to take its own.
		 */
		write: () => void;
	} | null = null;

	/**
	 * Set by {@link teardown}. After it, nothing is ever deferred again: the
	 * timer a deferral arms belongs to the window rather than to the plugin, so
	 * one armed now would fire on an unloaded plugin and write this instance's
	 * settings over whatever the next instance has since stored.
	 *
	 * **Read by the write itself, in {@link persist}, so that every route
	 * answers alike.** It was read at one door only — `saveCoreSoon`'s — while
	 * `setEnabled` and the handle a feature is given went straight to the queue,
	 * so the same overwrite was still reachable through either of them. The one write
	 * the flag does not refuse is the deferred one, which has its own route in:
	 * {@link persistDeferred}, and {@link teardown} says why. Its two doors —
	 * `saveCoreSoon` and a feature handle's `saveSoon` — read the flag
	 * themselves, in {@link persistSoon}, before anything is deferred.
	 *
	 * The same field, for the same reason, as `NoteWriter.unloaded`.
	 */
	private unloaded = false;

	/** Everyone waiting to be told that memory was put back. See {@link onChange}. */
	private readonly listeners = new Set<SettingsChanged>();

	/** Told first when a reload changed memory. See {@link onReloaded}. */
	private readonly reloadListeners = new Set<SettingsChanged>();

	/** Set once {@link load} has read the file; a reload before it has nothing to merge into. */
	private loaded = false;

	/**
	 * Set when {@link reloadExternal} was asked for before {@link load} had
	 * finished, and cleared when `load` starts: the first read may have answered
	 * with the file from before an outside write, so `load` reloads once it holds
	 * memory (finding #1091).
	 */
	private reloadWhenLoaded = false;

	/**
	 * How many writes have been handed to `saveData` and not yet landed or
	 * failed. A reload that finds one open writes again after it, because the
	 * open write carries the copy from before the reload.
	 */
	private handedOver = 0;

	/**
	 * Everyone waiting to be told that the core settings changed — on every
	 * successful {@link saveCore} or {@link saveCoreSoon}, not only a restore.
	 * See {@link onCoreChange}.
	 */
	private readonly coreListeners = new Set<SettingsChanged>();

	constructor(private readonly plugin: Plugin) {}

	async load(): Promise<void> {
		this.reloadWhenLoaded = false;
		const { data, language, migrated, droppedBuilt, unrecognised, accounts } = readFile(await this.plugin.loadData());
		this.data = data;
		this.unrecognised = unrecognised;
		this.landed = snapshotOf(this.data);
		this.loaded = true;
		// An outside change reported while that read was in flight may not be in
		// what it returned, and nothing else would take it before this device's
		// next save wrote the older copy over it (finding #1086's defect, in the
		// start-up window). Taken here, before the write below is started, so
		// that write carries the merged settings; a failed read is reported out
		// loud and does not fail the load.
		if (this.reloadWhenLoaded) {
			this.reloadWhenLoaded = false;
			await this.reloadExternal().catch((error: unknown) => {
				queueMicrotask(() => {
					throw error;
				});
			});
		}
		// The one write this method starts rather than only answers for. A real
		// language change is worth keeping even if nothing else is ever saved
		// again this session — the next `load()` otherwise re-derives the same
		// history from the still-stale file and the step in between is lost; the same is true of a fresh install's first-ever
		// history and of a stored value this store just repaired, or nothing
		// ever gets a chance to write either of those either.
		// Not awaited, and a failure does not fail `load()` itself: the
		// reconciled history above is already in `this.data` for this session
		// regardless of whether the write lands, and a load that misses it here
		// runs the same reconciliation again next time (self-healing). The
		// failure is still reported rather than swallowed, on a microtask of
		// its own — the same shape `tellRestored` and `tellCoreChanged` use
		// below for a listener that throws — except for the plugin's own
		// "unloaded" refusal, which `persist` throws when this write's turn on
		// the queue comes after `teardown` has already run: a plugin disabled
		// within the same tick this method is still resuming in is ordinary,
		// not a failure worth an uncaught error over.
		if (language.changed) this.persistInBackground();
		if (language.unusable) tellLanguageHistoryReset();
		// One notice per load naming every heading that needed it, not one per
		// heading: a hand-edited file broken in several places at once should
		// not fire a Notice for each (issue #801, `CLAUDE.md`'s rule after
		// #606/#607). The settings screen shows what is stored now, including the
		// shipped default this fell back to, so "change it here" points at a
		// screen that already carries the answer.
		if (migrated.unusableFields.length > 0) {
			new Notice(
				`Effortless: ${migrated.unusableFields.join(", ")} could not be used and the shipped default was used instead. Change it on the settings screen to keep your own answer.`,
			);
		}
		tellBuiltDiariesDropped(droppedBuilt);
		tellAccountsBlanked(accountsRefusedNames(accounts));
	}

	/**
	 * Starts a write nobody awaits and reports its failure out loud, on a
	 * microtask of its own — the shape {@link load}'s language-history write
	 * had, now shared with {@link reloadExternal}'s. The plugin's own
	 * "unloaded" refusal is not a failure: a plugin disabled within the tick
	 * this was started in is ordinary.
	 */
	private persistInBackground(): void {
		this.persist().catch((error: unknown) => {
			if (reasonOf(error) === UNLOADED) return;
			queueMicrotask(() => {
				throw error;
			});
		});
	}

	/**
	 * Takes what `data.json` says now, because something other than this store
	 * wrote it — what Obsidian calls `onExternalSettingsChange` for, which is
	 * how another device's save arrives through Sync
	 * (`node_modules/obsidian/obsidian.d.ts:5085`, issue
	 * #1086). Without it
	 * every save wrote the copy loaded at start, whole, and the building
	 * device's row memory and notes memory were lost at the next save from
	 * another device.
	 *
	 * **It merges; it does not wait for a write and then read.** Waiting is
	 * wrong for a change this device has typed and not yet written: the write
	 * that is waited for carries this device's older copy of everything else,
	 * so the outside change is gone before the read. Instead, memory is merged
	 * three ways against {@link landed}, the file as this store last knew it:
	 * a setting this device has not touched since then takes the file's
	 * answer, and a setting it has touched keeps this device's. The unit of a
	 * setting is one layout field, one feature switch or one feature's whole
	 * slice, and the calendar list as one value. **Where both changed the same
	 * one, this device's wins** — its write is the one about to happen, and a
	 * feature's slice cannot hold two answers. That is the "two devices within
	 * seconds" window the ticket leaves out, narrowed to one slice rather than
	 * the whole file.
	 *
	 * **A write already open in the file is the one case that needs a second
	 * write.** It was handed the older copy and will land it over the outside
	 * change, and nothing queued behind it can undo that unless it carries the
	 * merge. A queued write reads memory when its turn comes and needs nothing
	 * more; a typed one whose timer has already fired carries the snapshot taken
	 * then (`persistSoon`), so it is covered only because it queues behind the
	 * open write, and the second write this starts follows both.
	 *
	 * **A value the code cannot use is refused, not replaced.** Unlike
	 * {@link load}, which has no earlier answer to fall back on and uses the
	 * shipped default, a reload keeps the answer this device holds for that
	 * field and says which field in a notice. The next save from here writes
	 * that answer back, which is what repairs the file. The language history
	 * is reconciled with the app's language exactly as at load, but unlike at
	 * load no write is started for it alone (see the comment at the write below).
	 *
	 * Asked for before {@link load} has finished, it is remembered and `load`
	 * runs it once memory holds the first read (finding #1091). Does nothing
	 * after the unload, and nothing for a file that is gone or unreadable beyond saying so — memory is then the
	 * only copy, and the next save writes it.
	 *
	 * The order of what is told is the point: the registry's listeners first,
	 * so a feature switched on or off in the file has started or stopped
	 * before any screen draws its row, then the core listeners if the core
	 * settings changed, then every {@link onChange} listener, once. Nobody is
	 * told when the file holds nothing this store does not already hold, which
	 * is what Obsidian's call for this plugin's own write amounts to.
	 */
	async reloadExternal(): Promise<void> {
		if (!this.loaded) {
			this.reloadWhenLoaded = true;
			return;
		}
		const raw: unknown = await this.plugin.loadData();
		// Checked after the read, not before it: a plugin unloaded while the
		// file was being read must not take it. Everything from here to the end
		// is synchronous, so memory cannot change between being read and being
		// replaced.
		if (this.unloaded) return;
		if (raw === null || raw === undefined) {
			new Notice(
				raw === null
					? "Effortless: the settings file was removed from outside Obsidian. This device keeps what it holds and writes it again at the next change."
					: "Effortless: the settings file was changed from outside Obsidian but could not be read. This device keeps what it holds.",
			);
			return;
		}
		if (!isRecord(raw)) {
			new Notice(
				"Effortless: the settings file was changed from outside Obsidian but does not hold settings this plugin can read. This device keeps what it holds and writes it again at the next change.",
			);
			return;
		}
		const ours = this.data;
		const file = readFile(raw, ours.core.calendarSources, ours.core.calendarAccounts);
		const theirs = file.data;
		// The file's own answer for a field it cannot use is the default
		// `readFile` put there; this device's answer stands in for it, so it
		// both merges and lands as "no change from the file".
		const refused = refuseUnusable(raw, theirs, ours);
		// An account's unusable address or user name the same way, one account
		// at a time: this device's copy of that account stands in for it. An
		// account this device does not hold has no answer here to stand in, so
		// it stays blank, as at load, and is said as at load.
		const blanked: AccountRefused[] = [];
		for (const one of file.accounts.unusable) {
			const mine = ours.core.calendarAccounts.find((account) => account.id === one.id);
			if (mine === undefined) {
				blanked.push(one);
				continue;
			}
			theirs.core.calendarAccounts = theirs.core.calendarAccounts.map((account) =>
				account.id === one.id ? { ...mine } : account,
			);
			refused.push(one.name);
		}
		const theirLayout: Record<string, unknown> = { ...theirs.core.layout };
		for (const key of file.migrated.unusableKeys) theirLayout[key] = ours.core.layout[key];
		// A field the file has no key for was written by a build that does not
		// know it: such a build reads the layout field by field and writes back
		// only what it read, so its save drops every newer field. Read as absent,
		// the field would take the upgraded-file answer — a Diary heading the
		// person filled in becomes blank on every device, in silence. So this device's answer stands in for it, like an unusable
		// field's, and is named and written back. Where this device's answer is
		// what the absence reads anyway — the start-up reload of the same
		// upgraded file `load` just read — there is nothing to keep or say.
		const kept: string[] = [];
		for (const key of file.migrated.absentKeys) {
			if (sameValue(theirLayout[key], ours.core.layout[key])) continue;
			theirLayout[key] = ours.core.layout[key];
			kept.push(LAYOUT_ROW_NAMES[key]);
		}
		// The record is one more field such a build drops: it was added after them. Read as absent it merges as every landed day removed, and
		// the days this device has written are forgotten. A record
		// that is there but unusable is refused instead, one entry at a time.
		let theirBuilt = refuseUnusableBuilt(file.droppedBuilt, theirs.core.builtDiaries, ours.core.builtDiaries);
		if (file.builtAbsent && !sameValue(theirBuilt, ours.core.builtDiaries)) {
			theirBuilt = ours.core.builtDiaries;
			kept.push(BUILT_DIARIES_NAME);
		}
		const theirCore: CoreSettings = {
			...theirs.core,
			layout: theirLayout as unknown as VaultLayout,
			builtDiaries: theirBuilt,
		};

		const merged: EffortlessData = {
			core: {
				layout: mergeRecord(
					this.landed.core.layout as unknown as Record<string, unknown>,
					theirCore.layout as unknown as Record<string, unknown>,
					ours.core.layout as unknown as Record<string, unknown>,
				) as unknown as VaultLayout,
				enabled: mergeRecord(this.landed.core.enabled, theirCore.enabled, ours.core.enabled),
				calendarSources: sameValue(ours.core.calendarSources, this.landed.core.calendarSources)
					? theirCore.calendarSources
					: ours.core.calendarSources,
				// One value, like the calendar list: an account and the rows that
				// name it are added together.
				calendarAccounts: sameValue(ours.core.calendarAccounts, this.landed.core.calendarAccounts)
					? theirCore.calendarAccounts
					: ours.core.calendarAccounts,
				// One day at a time, like the switches: the device that builds the days
				// and the device that runs Review each add days the other has not seen.
				builtDiaries: mergeRecord(this.landed.core.builtDiaries, theirCore.builtDiaries, ours.core.builtDiaries),
			},
			features: mergeRecord(this.landed.features, theirs.features, ours.features),
		};
		// The file's copy of what this build does not recognise wins: this device
		// never changes it. A core or layout that is there but not a record was
		// refused whole above, and what was held for it stays.
		const layers = refusedLayers(raw);
		const unrecognised: Unrecognised = {
			core: layers.core ? this.unrecognised.core : file.unrecognised.core,
			layout: layers.layout ? this.unrecognised.layout : file.unrecognised.layout,
		};
		const unrecognisedChanged = !sameValue(unrecognised, this.unrecognised);
		this.unrecognised = unrecognised;
		// A day kept by another device is no change to the core's settings: nothing
		// draws from it, and telling every core listener would redraw every day view
		// each time a day is built elsewhere. It is still a change to write.
		const coreChanged = !sameValue({ ...merged.core, builtDiaries: null }, { ...ours.core, builtDiaries: null });
		const changed = coreChanged || !sameValue(merged.core.builtDiaries, ours.core.builtDiaries) || !sameValue(merged.features, ours.features);
		this.data = merged;
		this.landed = snapshotOf({ core: theirCore, features: theirs.features });

		if (file.language.unusable) tellLanguageHistoryReset();
		const unusable = [...file.migrated.unusableFields, ...refused, ...builtDiariesNames(file.droppedBuilt)];
		if (unusable.length > 0) {
			new Notice(
				`Effortless: ${unusable.join(", ")} in the settings file, changed from outside Obsidian, could not be used. This device kept its own answer. Change it on the settings screen to replace what the file holds.`,
			);
		}
		tellAccountsBlanked([...blanked.map((one) => one.name), ...file.accounts.rows]);
		if (kept.length > 0) {
			new Notice(
				`Effortless: the settings file, changed from outside Obsidian, has no ${kept.join(", ")}. An older version of Effortless most likely wrote it, on a device not yet updated. This device kept its own answer and writes it back to the file.`,
			);
		}
		// What the file holds is not what memory now holds when a write is open
		// and about to land the older copy; a write that is only queued or
		// waiting reads memory itself. **The language history is not a reason to
		// write.** It is one field in a file every device shares, reconciled
		// with each device's own app language, so a reload that wrote the
		// reconciled answer back would have a Swedish device and an English one
		// each correct what the other just wrote, for ever. The reconciled
		// answer is held in memory and goes out with the next ordinary save.
		// **A kept field is a reason to write**, unlike the history: until the
		// file holds it again, every other device on a current build reads it
		// as absent too. It cannot go on for ever between current builds, which
		// all write every field; an older build drops it again only on a save
		// of its own, and each such round is one write here and one notice,
		// which is the news that a device lags.
		if (kept.length > 0 || ((changed || unrecognisedChanged) && this.handedOver > 0)) this.persistInBackground();

		if (!changed) return;
		this.tell(this.reloadListeners);
		if (coreChanged) this.tellCoreChanged();
		this.tellRestored();
	}

	/**
	 * Asks to be told when {@link reloadExternal} has put new answers in
	 * memory, before {@link onCoreChange} and {@link onChange} listeners are.
	 * Only the registry listens: it brings the features into line with the
	 * switches the file now holds, and that has to be over before a screen
	 * redraws a row from what the registry says.
	 */
	onReloaded(listener: SettingsChanged): () => void {
		this.reloadListeners.add(listener);
		return () => {
			this.reloadListeners.delete(listener);
		};
	}

	core(): Readonly<CoreSettings> {
		return this.data.core;
	}

	async saveCore(next: CoreSettings): Promise<void> {
		this.data.core = next;
		this.tellCoreChanged();
		await this.persist();
	}

	/**
	 * The same as `saveCore`, but for an answer that arrives once per keystroke.
	 *
	 * The core settings change straight away, so a redraw between the keystroke
	 * and the write shows what was typed. Only the write waits: it starts once
	 * the typing has stopped for `SAVE_AFTER_TYPING_MS`, and every keystroke in
	 * between pushes it further out. Typing `Journal` into the folder box is one
	 * whole-file write rather than seven.
	 *
	 * Every caller in one run gets the same promise, and it fails if the write
	 * fails — the settings screen has nowhere else to learn that, and a
	 * swallowed failure leaves the box showing text the next reload will drop. That includes a write that fails on disk: Obsidian's
	 * `saveData` resolves even then, so the store reads the file back after the
	 * write and fails the run when it does not hold what was written
	 * (#589; `queueWrite`
	 * has the window that check leaves open).
	 */
	saveCoreSoon(next: CoreSettings): Promise<void> {
		return this.persistSoon(() => {
			this.data.core = next;
			this.tellCoreChanged();
		});
	}

	/**
	 * Keeps `section` as the diary section the log for `day` was built with, and
	 * writes the file now (`builtDiaries.ts`, ticket
	 * #1201). The record is
	 * replaced, not edited in place, so a snapshot taken before still holds the
	 * old one. **The core's listeners are not told**: nothing draws from the
	 * record, and a feature that reads it reads it when it decides.
	 */
	async keepBuiltDiary(day: string, section: string): Promise<void> {
		if (this.data.core.builtDiaries[day] === section) return;
		this.data.core.builtDiaries = { ...this.data.core.builtDiaries, [day]: section };
		await this.persist();
	}

	/**
	 * Applies a change to the in-memory settings now and writes the file once
	 * the typing has stopped. The one deferred route into the file: `saveCoreSoon`
	 * and a feature handle's `saveSoon` are each one line onto it, so the two
	 * cannot drift apart in what they promise.
	 *
	 * `apply` is the change, made against `this.data` in place, and it is made
	 * only once the refusal below has been passed: a change made and then
	 * refused would be the leak #385 closed, arriving through a new door.
	 */
	private persistSoon(apply: () => void): Promise<void> {
		// Refused rather than deferred once the plugin has unloaded, and the
		// settings are left alone: there is no screen left to read them back
		// and no owner left for the timer this would otherwise arm. The caller
		// is told, because every caller announces a failed write and a change
		// dropped in silence is the failure this store exists to prevent (issue
		// #188; `~/Devbox/CLAUDE.md` calls it failing loud).
		if (this.unloaded) {
			return Promise.reject(new Error(UNLOADED));
		}

		apply();
		const waiting = this.waiting;
		if (waiting !== null) {
			window.clearTimeout(waiting.timer);
			waiting.timer = window.setTimeout(waiting.write, SAVE_AFTER_TYPING_MS);
			return waiting.done;
		}

		let write = (): void => undefined;
		const done = new Promise<void>((resolve, reject) => {
			write = () => {
				this.waiting = null;
				// `persistDeferred`, not `persist`: this is the one write the
				// unload does not refuse, and `teardown` says why. What it writes
				// is a snapshot taken here, at the moment this starter runs, not
				// the store's live settings.
				this.persistDeferred(snapshotOf(this.data)).then(resolve, reject);
			};
		});
		this.waiting = {
			timer: window.setTimeout(write, SAVE_AFTER_TYPING_MS),
			done,
			write,
		};
		return done;
	}

	/**
	 * Writes a change that is still waiting on its timer, now, and answers when
	 * that write has landed.
	 *
	 * Before this, `waiting` was emptied by its own timer alone. So a change
	 * typed within `SAVE_AFTER_TYPING_MS` of the plugin unloading was lost in
	 * silence — the box went on showing it, because `saveCoreSoon`
	 * changes the core settings straight away and defers only the write. `main.ts`
	 * awaits this in its `onunload`.
	 *
	 * Safe to call with nothing pending, and safe to call twice: the first call
	 * empties `waiting`, so the second finds nothing of its own to write. The
	 * same is true of {@link teardown}, which drains it the same way at unload
	 * and may run either side of this one.
	 *
	 * **Awaiting this means every write this store started has landed**, not
	 * just the deferred one. A call that finds the timer empty still waits for
	 * whatever write is open, so a second `flush` during the first's write
	 * answers after that write rather than before it — and a save
	 * that starts while this one is waiting is waited for as well, rather than
	 * being the one write the sentence above quietly did not cover.
	 *
	 * **It never rejects, and that is not a swallowed failure.** A failed write
	 * still reaches whoever asked for it, through the promise `saveCoreSoon` or
	 * a feature handle's `saveSoon` handed back — and every deferred write in
	 * this plugin was asked for by the settings screen, which is the one thing
	 * that can say so out loud. Rejecting here as well would
	 * announce one failure twice, which is what #186 has just finished taking
	 * off the screen. A write that fails on disk reaches that promise too, by
	 * the read-back in `queueWrite` rather than by `saveData`, which resolves
	 * even when the write never lands.
	 *
	 * There is deliberately no maximum wait capping the deferral. Reaching the
	 * unbounded case needs minutes of unbroken typing into one settings box
	 * with no gap longer than 400 ms, and this flush closes the only way the
	 * deferral actually costs anything.
	 */
	async flush(): Promise<void> {
		const waiting = this.waiting;
		if (waiting !== null) {
			window.clearTimeout(waiting.timer);
			// Empties `waiting` and starts the write, exactly as the timer
			// would. `write` takes its own copy of the settings as it runs, so
			// this and `teardown` no longer race to be the one that hands it a
			// snapshot before the other finds the slot already empty.
			//
			// It costs the plugin nothing while it is alive. The copy is taken in
			// the same synchronous step that starts the write, so there is no
			// moment between reading the settings and handing them over in which
			// they could change, and the write still carries the newest answers.
			waiting.write();
			// Takes the deferred write's own failure, so that nothing is left
			// rejecting with nobody listening. The waiting itself is the loop's
			// below, which covers this write along with every other.
			await waiting.done.catch(() => undefined);
		}
		// Nothing on the timer does not mean nothing is happening: a toggle
		// saved through `setEnabled` writes straight away, so a click a
		// millisecond before unload leaves `waiting` null and a write wide open.
		// Returning without waiting for that answered before it had landed.
		//
		// Re-read after every await rather than once. Every write reassigns
		// `writing`, so a save that starts while this is waiting chains onto a
		// promise this method has already stopped looking at — and awaiting the
		// one it read first answered with that save still open.
		// The loop ends when a whole await goes by without the field changing,
		// which is the store having nothing left open. `writing` cannot reject,
		// so awaiting it keeps this method's no-rejection rule with no `catch`
		// added.
		let awaited: Promise<void> | undefined;
		while (awaited !== this.writing) {
			awaited = this.writing;
			await awaited;
		}
	}

	/**
	 * Gives up the deferred write's timer, having first run the write it was
	 * holding. `main.ts` hands this to `Plugin.register`, which is what makes
	 * the plugin's own `Component` own it.
	 *
	 * The timer was the one handle in `src/core/` that nothing owned. It was
	 * armed with a bare `window.setTimeout` and emptied only by its own firing,
	 * so a plugin unloaded inside the typing window left it armed: it fired on
	 * a dead plugin and called `saveData` there, writing this instance's
	 * settings over the file a re-enabled instance had since written. Obsidian's
	 * plugin guidelines make owned cleanup a requirement rather than a tidy-up
	 * (`docs/research/obsidian-publishing-requirements.md` § 1), and this was
	 * the last place here that broke it.
	 *
	 * **Running the write is what makes cancelling safe.** Clearing the timer
	 * alone would turn the fix into deliberate data loss — the change is only
	 * on that timer, and #187's flush is what lands it. So this does what the
	 * timer would have done, at once, and clears the handle by running it.
	 * When this runs first, `flush` then finds nothing of its own and waits for
	 * the write this started; when `flush` runs first the roles swap, and the
	 * paragraph below says why either order is safe.
	 *
	 * Sync, because `Component.register` is: the write is *started* here and
	 * awaited by `main.ts`'s `onunload`, which is the half `flush` owns.
	 *
	 * **The flag it sets refuses every other route into the file from here on**,
	 * including a save that was asked for before this ran and is still queued
	 * behind an open write — that one would otherwise reach `saveData` after the
	 * unload and overwrite what a re-enabled instance had since stored. The write this
	 * method runs is exempt by the route it takes rather than by the order of
	 * these two lines: `waiting.write` goes through `persistDeferred`, which
	 * does not read the flag. Ordering could not have done it, because the
	 * refusal is checked when a write's turn comes and this one's turn comes
	 * after this method has returned.
	 *
	 * **What that write carries is a copy taken as it starts, not the settings
	 * as they stand when its turn finally comes.** A refused route stops the
	 * call and not the change: `setEnabled` and a feature's handle each alter
	 * the store's in-memory settings before their write is refused, and this
	 * write queues behind whatever is open — so handing it the live object
	 * would carry those changes into `data.json` anyway, which is the overwrite
	 * the refusal exists to stop. `waiting.write`
	 * takes the copy, not this method — {@link snapshotOf} says how deep it has
	 * to be, and why.
	 *
	 * **`flush` runs the same `write`, and that is what makes the paragraph
	 * above true in either order rather than in one.** Both methods drain the
	 * same slot by calling it, so whichever runs first is the one whose call
	 * takes the copy; the other then finds the slot already empty and does
	 * nothing. While `write` took its copy as a parameter instead of taking one
	 * itself, only one of its two callers passed it — a `flush` arriving first
	 * left that write holding the live object and this method found nothing to
	 * copy, and a caller refused afterwards got its change into the file
	 * exactly as it did before #385. The timer
	 * firing was the same gap once more, closed the same way: all three
	 * starters now call the one `write` that copies for itself, so none of them
	 * can be the door that reopens it.
	 *
	 * Safe to call with nothing pending, and safe to call twice. The same shape
	 * as `NoteWriter.teardown`, and registered on the line beside it.
	 */
	teardown(): void {
		this.unloaded = true;
		const waiting = this.waiting;
		if (waiting === null) return;
		window.clearTimeout(waiting.timer);
		// Empties `waiting`, so nothing is left holding a cleared handle, and
		// hands the write's outcome to whoever asked for it. `write` takes its
		// own copy of the settings as it runs, which is what keeps a refused
		// caller's change out of the file.
		waiting.write();
	}

	/**
	 * Asks to be told whenever this store puts its memory back to what
	 * `data.json` holds, and hands back the one way to stop being told. Whoever
	 * registers owns that call: nothing here drops a listener by itself.
	 *
	 * **A restore is the one way memory changes without its reader having asked
	 * for the change**, and it is the whole of what this says. Every route in
	 * changes memory itself, in the caller's own step, so the caller already
	 * knows; a write that lands changes nothing in memory, which held the change
	 * before the write began. But {@link queueWrite} puts memory back when the
	 * write it was asked to make is refused and it is the last one queued — and
	 * that write need not belong to whoever drew from memory last. A box beside
	 * a refused run of typing, a press drawn while a typed change waited and
	 * then undone by the timer's refusal, a palette brought into line after its
	 * own write: each went on showing memory as it was before the restore, and
	 * a save from beside the box carried the stored value back into the file
	 * while the box showed another.
	 *
	 * **When it fires.** Once per restore, after memory has been put back, so a
	 * listener that reads `core()`, `isEnabled` or a handle's `read()` reads what
	 * the file holds. It runs on the queue's own branch, which is chained before
	 * the refused caller's, so it runs before that caller hears the refusal. It
	 * never fires while a run of typing waits on its timer or another write is
	 * queued, because memory is not put back then; and never after the unload.
	 *
	 * The shape is `SettingsChanged`, the feature contract's word for "what is
	 * stored has changed", because this is that same news arriving from the
	 * store rather than from a feature's own panel.
	 */
	onChange(listener: SettingsChanged): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Asks to be told whenever the core settings change — the vault layout, the
	 * calendar columns — and hands back the one way to stop being told.
	 *
	 * **Unlike {@link onChange}, this fires on every {@link saveCore} or
	 * {@link saveCoreSoon} call, not only a restore — including one that saves
	 * the same core settings again.** `onChange`
	 * is deliberately silent on a landing write (issue #588's "tells nobody when
	 * a write lands"): a feature that owns the write already knows what it just
	 * stored. The core settings are different — a feature reads them without
	 * ever writing them, so nothing else tells it they changed under it. This is
	 * that signal, fired the moment memory holds the new answer, matching the
	 * rule that the store is the one truth for what a screen shows.
	 *
	 * **Not fired on a restore.** A restore already tells every {@link onChange}
	 * listener, core-owning or not, and a feature that cares about the core
	 * surviving its own settings being restored — as this one does, for its
	 * density — already holds that subscription for that reason. Firing this
	 * one too would only be the same redraw twice.
	 */
	onCoreChange(listener: SettingsChanged): () => void {
		this.coreListeners.add(listener);
		return () => {
			this.coreListeners.delete(listener);
		};
	}

	/**
	 * Tells every listener that memory was put back.
	 *
	 * Over a copy, so a listener that stops listening from inside the round
	 * does not change who is told in it.
	 *
	 * **A listener that throws is caught here and thrown again on a microtask
	 * of its own**, because this runs on the queue's branch, and that branch
	 * must never reject: a rejection there wedges every later write and `flush`
	 * with it. Every other listener is still told. The error is not swallowed —
	 * thrown where nothing awaits it, it is reported as uncaught.
	 */
	private tellRestored(): void {
		this.tell(this.listeners);
	}

	/** Tells every {@link onCoreChange} listener that the core settings changed, the same way {@link tellRestored} tells its own. */
	private tellCoreChanged(): void {
		this.tell(this.coreListeners);
	}

	/** The loop behind every `tell…` above, over a copy and with a throwing listener rethrown on its own microtask. */
	private tell(listeners: ReadonlySet<SettingsChanged>): void {
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch (error) {
				queueMicrotask(() => {
					throw error;
				});
			}
		}
	}

	/** Every feature ships on, so an id nobody has switched off reads as enabled. */
	isEnabled(featureId: string): boolean {
		return this.data.core.enabled[featureId] !== false;
	}

	async setEnabled(featureId: string, on: boolean): Promise<void> {
		this.data.core.enabled[featureId] = on;
		await this.persist();
	}

	/**
	 * A handle onto one feature's slice. Reading merges the feature's defaults
	 * over whatever is stored, so a feature that gains a setting in a later
	 * release finds it present rather than undefined.
	 */
	handleFor<T extends object>(featureId: string, defaults: T): FeatureSettings<T> {
		return {
			read: () => ({ ...defaults, ...(this.data.features[featureId] as Partial<T>) }),
			save: async (next: T) => {
				this.data.features[featureId] = next;
				await this.persist();
			},
			// Handed back as the store's own promise rather than wrapped in an
			// `async` function: every caller in one run of typing must get the
			// *same* promise, because that promise is how the settings screen
			// tells one failed write from the next and announces it once
			// (`saveFailureAnnouncer.ts`, #186).
			saveSoon: (next: T) =>
				this.persistSoon(() => {
					this.data.features[featureId] = next;
				}),
			onChange: (listener: SettingsChanged) => this.onChange(listener),
		};
	}

	/**
	 * Writes the file, waiting for whatever write is already open first, and
	 * refuses once the plugin has unloaded.
	 *
	 * Every immediate route in — `saveCore`, `setEnabled` and the `save` of the
	 * handle a feature is given — comes through here, which is what makes them
	 * all answer alike. The deferred routes read the flag at their own door,
	 * in {@link persistSoon}, and write through {@link persistDeferred}.
	 * The refusal used to sit at one door only, so a feature's own save or the
	 * settings screen's toggle still reached `saveData` on a dead plugin.
	 *
	 * **The flag is read when the write's turn comes, not when it was asked
	 * for.** A write queues behind whatever is already open, so a save asked
	 * for a moment before the unload can reach `saveData` a moment after it —
	 * and write this instance's whole `data` over the file a re-enabled
	 * instance has since stored. Reading the flag at the door would let exactly
	 * that one through.
	 *
	 * Refused rather than silently skipped, for the reason `saveCoreSoon` gives:
	 * a change dropped in silence is the failure this store exists to prevent.
	 *
	 * The caller is handed the write's own outcome, so a failure still reaches
	 * the settings screen.
	 */
	private persist(): Promise<void> {
		return this.queueWrite(() => {
			if (this.unloaded) throw new Error(UNLOADED);
			return this.data;
		});
	}

	/**
	 * The deferred write's own route to the file, which the unload does not
	 * refuse.
	 *
	 * {@link teardown} runs the write the timer was holding, and that write has
	 * to land: it is the change the person just made, and dropping it would
	 * turn #188's fix into deliberate data loss. It cannot come through
	 * `persist`, because a queued write is refused at the moment its turn comes
	 * and teardown's turn comes after teardown has set the flag.
	 *
	 * **It writes what it is handed rather than the store's live settings**, and
	 * that is what the exemption above costs. Every route into the file changes
	 * those settings before its write is attempted or refused, so a caller
	 * refused after the unload has had its call stopped and its change made —
	 * and this write, queueing behind whatever is open, would put that change
	 * in the file if it were handed the live object. What it is
	 * handed is a snapshot, and {@link SettingsStore.waiting}'s `write` is what
	 * takes it, at the moment it runs — not this method, and not whichever of
	 * the three starters called it. That is what lets all three share one
	 * answer: `flush` and `teardown` each took their own copy for a while, so
	 * whichever of them emptied the deferred slot first was the one that copied
	 * and the other found nothing left to; the timer went
	 * on handing over the live settings after that, on the argument that a live
	 * plugin's queued write is meant to carry the newest answers —
	 * true of the *file*, but not of what this one write carries, and a
	 * sequence where the timer fires before either half of the unload measured
	 * the difference: a caller refused after the unload reached `data.json`
	 * through the timer's write exactly as it did before #385. Moving the
	 * copy into `write` itself is what closed that door without reopening
	 * either of the other two.
	 *
	 * No route reaches this one after the unload. The deferred write is already
	 * guarded at its own door: `persistSoon` — behind both `saveCoreSoon` and a
	 * feature handle's `saveSoon` — refuses once the plugin has unloaded, and
	 * `teardown` clears the timer, so the only call left is teardown's own.
	 */
	private persistDeferred(data: EffortlessData): Promise<void> {
		return this.queueWrite(() => data);
	}

	/**
	 * Chains one write onto whatever is already open, and hands the caller that
	 * write's own outcome. `payload` is asked for what to write when the write's
	 * turn comes, and may throw to refuse it.
	 *
	 * The queue itself is kept on a branch that can never reject: one failed
	 * write must not wedge every later one, and `flush` waits on this branch
	 * rather than on the caller's.
	 *
	 * **A failed save is one of two things, and the store treats them alike.**
	 * `saveData` rejects, or `saveData` resolves and the file read back straight
	 * after does not hold what was written — the read fails, the file is gone,
	 * or its content differs ({@link readBack}). The second is the one the real
	 * application produces: Obsidian's `saveData` swallows a failed write to
	 * disk and resolves, so a full disk or a read-only `data.json` is detected
	 * here or nowhere.
	 * Every sentence below that says "rejected" means either. It costs one read
	 * per write this queue makes — a run of typing is still one write and one
	 * read — and a second, immediate read only when the first fails, is gone or
	 * differs ({@link readBack},
	 * #600). It is not closed: **a sync tool or another program that
	 * rewrites `data.json` in the instant between the write failing and the
	 * read-back, with exactly the payload this store wrote, makes a failed save
	 * read as a landing**; one that rewrites it with anything else after a write
	 * that did land makes a landing read as a failure, on both reads. The write
	 * itself is never retried.
	 *
	 * **What a caller may assume about the store once its write has rejected.**
	 * This is the contract for every route in — a feature handle's `save` and
	 * `saveSoon`, `setEnabled`, `saveCore` and `saveCoreSoon` — because every one
	 * of them changes memory before its write is attempted, and this is where
	 * each of those writes ends:
	 *
	 * - **When no other write is going to carry the change, memory is put back
	 *   to what `data.json` holds.** That is when the rejected write is the last
	 *   one queued, nothing is waiting on the typing timer, and the plugin has
	 *   not unloaded. Then `read()`, `core()` and `isEnabled` answer what the
	 *   file holds — the settings the last landed write carried, {@link landed}
	 *   — by the time the caller hears the rejection, so a section that redraws
	 *   on it draws what is stored. The restore runs on the queue's own branch,
	 *   which is chained before the caller's, and that ordering is what the
	 *   last clause rests on. **Everyone registered through {@link onChange}
	 *   is told, in the same step**, because the refused write need not be
	 *   theirs: a run of typing refused here changes what a box beside it
	 *   shows, and a timer's refusal undoes a press that was refused earlier
	 *   and already drawn.
	 * - **When another write is queued behind it, or a deferred write is
	 *   waiting, memory is left as it is.** That write carries memory as it
	 *   stands when its turn comes, so the file ends holding the
	 *   newest answers; rolling memory back first would undo them, and a run of
	 *   typing started since holds its keystrokes in memory with only the timer
	 *   to carry them. For a feature handle's `save`/`saveSoon` and for
	 *   `saveCore`/`saveCoreSoon`, the rejected caller's notice is then the one
	 *   thing that was wrong, and a later redraw shows the value that landed.
	 *   `setEnabled` used to be worse: `registry.setEnabled` awaits this call
	 *   before it reaches `load` or `unload`, so a rejection skipped that step
	 *   and a feature that should have stopped kept running until the next
	 *   reload. Since #591
	 *   the registry catches the rejection, waits for the queue to drain and
	 *   brings the feature into line with whatever the stored answer settled
	 *   to; the caller still hears the rejection. A rejected
	 *   write can even have had its change carried by a snapshot write queued
	 *   after it, which is the same rule seen from the other side — or by an
	 *   immediate write queued before it: two `setEnabled` calls in one tick
	 *   each change `this.data` synchronously, so the first write's payload is
	 *   read at its own turn and already holds both.
	 * - **After the unload memory is left as it is.** Nothing reads it again,
	 *   and the one write still allowed through carries a snapshot of its own,
	 *   so a restore would buy nothing.
	 *
	 * "The last one queued" is read off the queue itself: the branch this call
	 * stored in `writing` is still the one there, so no later call has chained
	 * behind it. The copy kept on a landing is taken as the write is handed to
	 * `saveData`, because memory can change while the write is out.
	 */
	private queueWrite(payload: () => EffortlessData): Promise<void> {
		const mine = this.writing.then(async () => {
			const data = payload();
			const carried = snapshotOf(data);
			// What this build does not recognise goes out with every write, as the
			// file last read held it, so a save from here never removes a newer
			// build's settings.
			const file = withUnrecognised(data, this.unrecognised);
			// Serialised in the same synchronous step that hands `file` over,
			// which is when Obsidian's `Vault.writeJson` serialises it too, so
			// the two cannot see different settings.
			const written = JSON.stringify(file);
			this.handedOver += 1;
			try {
				await this.plugin.saveData(file);
				await this.readBack(written);
			} finally {
				this.handedOver -= 1;
			}
			this.landed = carried;
		});
		const branch: Promise<void> = mine.then(
			() => undefined,
			() => {
				const lastQueued = this.writing === branch;
				if (lastQueued && this.waiting === null && !this.unloaded) {
					const before = this.data;
					this.data = snapshotOf(this.landed);
					// The registry follows `onReloaded` alone, so memory put back to
					// a copy that differs from the one it held is told to it as well:
					// a reload's follow-up write that fails lands here, and the
					// features the reload started or stopped would otherwise run what
					// the store no longer says (finding #1090). Idempotent for a
					// rollback that changed no switch.
					if (!sameValue(before, this.data)) this.tell(this.reloadListeners);
					this.tellRestored();
				}
			},
		);
		this.writing = branch;
		return mine;
	}

	/**
	 * Reads `data.json` back through the plugin's own reader and throws unless
	 * it holds exactly `written`, the payload the write just handed over,
	 * serialised. A read that fails to match — it rejects, or it resolves to
	 * something else — is given one immediate second try before that counts as
	 * a failed save: a sync tool or antivirus can hold the file for an instant
	 * right after a write that did land, and that instant should not be read as
	 * the write itself having failed. No timer, and
	 * never a third attempt: a lock still held after the retry is treated the
	 * same as one held after a single read always was.
	 *
	 * **This is the only way this store learns that a write failed on disk.**
	 * Obsidian's `saveData` resolves when the write does not land:
	 * `Vault.writeJson` wraps the adapter's write in a `catch` that swallows
	 * the error, so a full disk, a read-only file or a folder nobody may write
	 * all answer exactly as a landing does. Read back
	 * through `loadData` rather than the vault adapter, so the store has no
	 * second path to the file.
	 *
	 * Anything but a match is a failed save. A read that rejects, on its final
	 * try, hands on its own error. `loadData` itself answers `null` for a file
	 * that is not there and `undefined` for one it could not read or parse —
	 * Obsidian's `Vault.readJson` logs that error and resolves — and neither
	 * serialises to a payload this store writes. Compared as JSON text
	 * re-serialised from what was parsed, so the indentation Obsidian writes
	 * with does not count, and key order is kept by both the write and the
	 * parse.
	 */
	private async readBack(written: string): Promise<void> {
		let failure: unknown = new Error(NOT_STORED);
		for (let tries = 0; tries < 2; tries++) {
			try {
				const found: unknown = await this.plugin.loadData();
				if (JSON.stringify(found) === written) {
					return;
				}
				failure = new Error(NOT_STORED);
			} catch (error) {
				failure = error;
			}
		}
		throw failure;
	}
}

/* ------------------------------------------------------------------------ */
/* Reading a file an older version wrote.                                     */
/* ------------------------------------------------------------------------ */

/*
 * Obsidian never tells anyone what changed when a plugin updates, so a release
 * that needs a manual step silently breaks the vault of everyone who did not go
 * and read about it. Every reshaping therefore happens here, on load, without a
 * word: a value that is missing takes its default, and a value that has been
 * dropped is simply not read. Nothing about it reaches a release note.
 *
 * Not reading a key is not the same as removing it. A key under `core` or
 * `core.layout` this build does not recognise may be a newer build's setting on
 * another device, so it is carried and written back unchanged
 * ({@link Unrecognised}, issue #1209).
 */

/**
 * Whatever was stored, read as a record — and nothing else read as one.
 *
 * An array is excluded as well as `null` and every primitive, because
 * `typeof [] === "object"`: without the check, a stored `calendarReads` of
 * `[{ readAt: 5, failure: null }]` was walked by `Object.entries` and came back
 * as `{ "0": { … } }`, a read state belonging to a calendar whose id is `"0"`. This is
 * every layer's reader — the whole file, the core, the features, each calendar
 * source, the layout, the columns and the per-device store — so the guard
 * belongs here rather than at any one call site.
 */
function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function readText(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

/**
 * The day's-log template path, read as an input boundary the way a heading's
 * text is by {@link readHeading} just below: a value present but not a string
 * is refused and reported rather than silently replaced (`CLAUDE.md`'s rule
 * after #606/#607; issue #911). A string is passed through `asVaultPath`, the
 * same normalisation the settings card's Day's-log template row applies on
 * entry (`settingsTab.ts`), so a hand-edited value with stray whitespace or a
 * trailing slash reads back the way it would if typed there.
 *
 * `present` distinguishes a field simply absent from the file — the ordinary
 * "never answered" case, which takes the default without comment — from one
 * that is there but unusable.
 */
function readTemplatePath(
	value: unknown,
	present: boolean,
	fallback: string,
): { value: string; unusable: boolean } {
	if (typeof value === "string") {
		return { value: asVaultPath(value), unusable: false };
	}
	return { value: fallback, unusable: present };
}

/**
 * A stored heading, read one field at a time like everything else here, and
 * whether the stored value could actually be used.
 *
 * A field simply absent from the file is the ordinary "never answered" case
 * and takes its default without comment — the same as every other layout
 * field. A field that *is* present but unusable — a non-text `text`, a
 * `level` that is not a finite number — is different: something was written
 * and the plugin cannot read it, so the caller is told, rather than the
 * default arriving indistinguishable from an answer nobody gave
 * (`CLAUDE.md`'s rule after #606/#607; issue #801).
 *
 * A blank `text` is not that case: it is #39's documented way to leave a
 * day's-log section out (`dailyLogFrame`, `sectionRange`), so it is a usable
 * value in its own right and is kept rather than refused.
 */
function readHeading(
	value: unknown,
	fallback: HeadingSetting,
): { value: HeadingSetting; unusable: boolean } {
	const stored = asRecord(value);
	const textUsable = typeof stored.text === "string";
	const levelUsable = typeof stored.level === "number" && Number.isFinite(stored.level);
	return {
		value: {
			text: textUsable ? (stored.text as string) : fallback.text,
			level: levelUsable ? (stored.level as number) : fallback.level,
		},
		unusable: ("text" in stored && !textUsable) || ("level" in stored && !levelUsable),
	};
}

/**
 * The diary heading, read as an input boundary like {@link readHeading}, with
 * the one difference that decides whether anything changes in a vault on the
 * day this setting ships:
 *
 * - **Stored and usable** — kept as stored, blank included.
 * - **Stored and not a heading** — anything but a record whose `text` is text
 *   and whose `level`, where present, is a finite number — refused: the shipped
 *   default is used and the caller is told, never a silent replacement. That
 *   includes a record with no `text` (`{}` among them) and a value that is not
 *   a record at all, where {@link readHeading} would fill the member in or read
 *   it as an absent one.
 * - **Stored with usable text and no `level`** — the level is the notes
 *   heading's, the same as the absent case, and nothing is said: a level is a
 *   default, not a replacement.
 * - **Absent from a file with settings in it** — blank. The file was written
 *   before the setting existed, so no existing day's log grows a section
 *   nobody asked for; the level is the notes heading's, so typing a name on
 *   the settings screen lands at the level the notes sit at.
 * - **Absent from no file at all** (`freshInstall`, {@link holdsNothing}) — the
 *   shipped `Diary`, so a new install has the feature without a settings visit.
 *
 * The rule is decided by `freshInstall` rather than by the layout alone because
 * a fresh install and an upgraded file can both lack a layout: a file holding
 * only feature settings is an upgrade.
 */
function readDiaryHeading(
	value: unknown,
	present: boolean,
	freshInstall: boolean,
	shipped: HeadingSetting,
	notesLevel: number,
): { value: HeadingSetting; unusable: boolean } {
	if (!present) {
		return { value: freshInstall ? shipped : { text: "", level: notesLevel }, unusable: false };
	}
	if (!isRecord(value) || typeof value.text !== "string") return { value: shipped, unusable: true };
	// Usable text with no level: the level is a default, not a replacement, so it
	// is the one the absent case gives and nothing is said.
	if (value.level === undefined) return { value: { text: value.text, level: notesLevel }, unusable: false };
	return readHeading(value, shipped);
}

function readSwitches(value: unknown): Record<string, boolean> {
	const switches: Record<string, boolean> = {};
	for (const [id, on] of Object.entries(asRecord(value))) {
		if (typeof on === "boolean") switches[id] = on;
	}
	return switches;
}

/**
 * The stored calendars, read one field at a time like everything else here: a
 * row missing a field takes its default rather than arriving half-made, and a
 * field this version does not know about is dropped instead of written back.
 *
 * A row whose id is missing, blank, or already held by an earlier row is given
 * a fresh one. Ids only started when the list did, but a file hand-edited in
 * the vault is a real thing, and two rows sharing an id share one entry in the
 * calendar's in-memory copies and one in the per-device read state — and the
 * settings screen matches rows by id, so editing or removing one would do it to
 * both.
 */
function readCalendarSources(stored: unknown, held: readonly CalendarSource[] = []): CalendarSource[] {
	if (!Array.isArray(stored)) return [];
	const taken = new Set<string>();
	return stored.map((entry, index) => {
		const source = asRecord(entry);
		const kind = source.kind === "file" || source.kind === "account" ? source.kind : "link";
		const location = readText(source.location, "");
		// An account row's account, kept only as text. One that is not text is
		// no account at all: the row is kept, says on the settings screen that
		// its account is no longer there, and is named in a notice at load
		// (`readCalendarAccounts`, which reads the same rows for that).
		const account = kind === "account" ? { account: readText(source.account, "") } : {};
		return {
			...account,
			id: readSourceId(source.id, taken, held[index]?.id),
			name: readText(source.name, ""),
			kind,
			// Cleaned as it arrives, because a settings file lives in the vault
			// and syncs, so it can carry whitespace no settings screen ever put
			// there, and one written before #190 — or edited by hand — keeps
			// `/Calendars/work.ics` for ever otherwise.
			// Which route is tidied and which is only trimmed is `asLocation`'s
			// to say. Nothing is migrated on disk: the tidied value is written
			// back only when something else saves.
			location: asLocation(kind, location),
			showInDay: readFlag(source.showInDay, true),
			makeNotes: readFlag(source.makeNotes, true),
		};
	});
}

/** How a notice names the whole of `core.calendarAccounts`. */
const CALENDAR_ACCOUNTS_NAME = "Calendar accounts";

/** One account whose server address or user name could not be used, and how a notice names it. */
interface AccountRefused {
	readonly id: string;
	readonly name: string;
}

/** What {@link readCalendarAccounts} could not use. */
interface AccountsRefused {
	/** Each account with an address, user name or id that is missing or not text, or an id that cannot name a password ({@link passwordSecretId}). */
	readonly unusable: readonly AccountRefused[];
	/** Whether `core.calendarAccounts` is there but not a list. */
	readonly notAList: boolean;
	/** How a notice names each calendar row of kind `account` whose account is not text. */
	readonly rows: readonly string[];
}

/**
 * The stored calendar accounts, read one field at a time, as an input
 * boundary. A server address or user name that is missing or not text
 * is **refused, not replaced**: it is read as blank — never as the iCloud
 * address a new account is prefilled with, which would send this person's
 * user name to a server they never chose — and named, so the caller can say
 * so. A blank account asks nothing of any server. Ids are read the way a
 * calendar's are ({@link readSourceId}), since an account's rows and its
 * password hang on its id; an id that is missing, blank, not text or already
 * taken is named too, because the rows and the password it held are no
 * longer this account's.
 *
 * `sources` is the stored calendar list, read here only to name each row of
 * kind `account` whose account is not text, which `readCalendarSources`
 * keeps as a row with no account.
 */
function readCalendarAccounts(
	stored: unknown,
	held: readonly CalendarAccount[] = [],
	sources: unknown = [],
): { accounts: CalendarAccount[]; refused: AccountsRefused } {
	const rows = (Array.isArray(sources) ? sources : [])
		.map(asRecord)
		.filter((row) => row.kind === "account" && typeof row.account !== "string")
		.map((row) => `The calendar "${readText(row.name, "")}"'s account`);
	if (stored === undefined) return { accounts: [], refused: { unusable: [], notAList: false, rows } };
	if (!Array.isArray(stored)) return { accounts: [], refused: { unusable: [], notAList: true, rows } };
	const taken = new Set<string>();
	const unusable: AccountRefused[] = [];
	const accounts = stored.map((entry, index): CalendarAccount => {
		const account = asRecord(entry);
		// An id that cannot name its password in the keychain is kept, since
		// its rows hang on it, and named, since no password can be typed for
		// it on any device.
		const idUsable =
			typeof account.id === "string" && account.id.trim() !== "" && !taken.has(account.id) && passwordSecretId(account.id) !== null;
		const id = readSourceId(account.id, taken, held[index]?.id);
		const address = typeof account.address === "string" ? account.address : null;
		const user = typeof account.user === "string" ? account.user : null;
		const fields = [
			address === null ? "server address" : null,
			user === null ? "user name" : null,
			idUsable ? null : "id",
		].filter((field): field is string => field !== null);
		if (fields.length > 0) {
			unusable.push({ id, name: `The calendar account "${user ?? address ?? id}"'s ${fields.join(" and ")}` });
		}
		return { id, address: address ?? "", user: user ?? "" };
	});
	return { accounts, refused: { unusable, notAList: false, rows } };
}

/** How a notice names what {@link readCalendarAccounts} could not use. */
function accountsRefusedNames(refused: AccountsRefused): string[] {
	return [...(refused.notAList ? [CALENDAR_ACCOUNTS_NAME] : refused.unusable.map((one) => one.name)), ...refused.rows];
}

/** Says which calendar accounts' answers could not be used; nothing is asked of a calendar server for them. */
function tellAccountsBlanked(names: readonly string[]): void {
	if (names.length === 0) return;
	new Notice(
		`Effortless: ${names.join(", ")} in the settings file could not be used, so nothing is asked of a calendar server for it. Put it right on the settings screen.`,
	);
}

function readFlag(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

/**
 * One calendar's id, kept only when it is a name no earlier row in this same
 * load has taken. A stored id is kept exactly as written rather than trimmed,
 * because an id is what a calendar's read state hangs on and changing one loses
 * that state. Blankness is judged on the trimmed text all the same: `" "` names
 * nothing.
 *
 * `taken` is the row's memory of the rows before it, so the first row to claim
 * an id keeps it and every later claimant is moved aside.
 *
 * `heldId` is the id the caller already holds for the row at this position. A
 * reload reads the same hand-edited file again and again, and a fresh random id
 * each time made every reload look like a change and orphaned the row's read
 * state, which hangs on the id; a row that needs a new id takes the one it was
 * already given, when no earlier row has taken it, and only otherwise a fresh
 * one.
 */
function readSourceId(value: unknown, taken: Set<string>, heldId?: string): string {
	let id = typeof value === "string" ? value : "";
	if ((id.trim() === "" || taken.has(id)) && heldId !== undefined && !taken.has(heldId)) id = heldId;
	while (id.trim() === "" || taken.has(id)) id = newCalendarSourceId();
	taken.add(id);
	return id;
}

/**
 * Meeting notes' feature id, as the stored `features` record keys its slice.
 * Named here, not imported, because the core may not reach into a feature: it
 * is the one place the migration of the two field names below needs it.
 */
const MEETING_NOTES_SLICE = "meeting-notes";

/**
 * One of the layout's three property names, read as an input boundary: the
 * layout's own stored name when it is usable; else, when the layout carries
 * none, the name the Meeting notes slice carries under `sliceKey` when that
 * is usable (the migration that moves the name into the layout, spec #1048
 * decision 4); else the shipped default. A usable name is stored the way the
 * core card stores it, with the spaces around it taken off
 * ({@link storedFieldName}, issue #1061). A name that is present but fails
 * {@link fieldNameRefusal} is refused — `unusable` — and the shipped default
 * used in its place, never a silent replacement (`CLAUDE.md`'s rule after
 * #606/#607). The slice's old key is only read, never removed.
 */
function readFieldName(
	own: unknown,
	slice: Record<string, unknown>,
	sliceKey: string,
	fallback: string,
): { value: string; unusable: boolean } {
	const stored = own !== undefined ? own : slice[sliceKey];
	if (stored === undefined) return { value: fallback, unusable: false };
	return fieldNameRefusal("", stored) === null
		? { value: storedFieldName(stored as string), unusable: false }
		: { value: fallback, unusable: true };
}

/**
 * `migrateLayout`'s own field, given already resolved: {@link SettingsStore.load}
 * builds it with {@link reconcileLanguageHistory} before this runs, because
 * that step needs to know whether it changed anything worth a write, which is
 * not a question the rest of this function's fields ever ask.
 */
/**
 * {@link migrateLayout}'s two answers: the layout itself, and the row name of
 * every field in it that was present but unusable — {@link readHeading}'s
 * headings, {@link readTemplatePath}'s template and {@link readFieldName}'s three
 * property names — empty on the ordinary path, where every one of them was
 * either absent or usable.
 */
interface MigratedLayout {
	layout: VaultLayout;
	unusableFields: string[];
	/** The layout key of each name in `unusableFields`, same order. */
	unusableKeys: Array<keyof VaultLayout>;
	/**
	 * Each layout field a person answers that the stored layout has no key for,
	 * the whole layout or core being absent included. On a first load that is
	 * the ordinary "never answered" case and nothing reads this; on a reload it
	 * is a field the build that wrote the file did not know (issue #1209,
	 * {@link SettingsStore.reloadExternal}).
	 */
	absentKeys: Array<keyof typeof LAYOUT_ROW_NAMES>;
	/** The stored layout's keys this build does not recognise, as stored ({@link Unrecognised}). */
	unrecognised: Record<string, unknown>;
}

/**
 * The stored layout read field by field as an input boundary. One choice in it
 * is easy to get wrong: the diary heading is `Diary` on a fresh install and
 * blank in a file that predates it, decided by `freshInstall` and not by the
 * layout. {@link holdsNothing} says which is which, and {@link readDiaryHeading}
 * applies it.
 */
function migrateLayout(
	stored: unknown,
	languageHistory: LanguageHistory,
	features: Record<string, unknown>,
	freshInstall: boolean,
): MigratedLayout {
	const shipped = shippedLayout();
	const layout = asRecord(stored);
	const columns = asRecord(layout.calendarColumns);
	const oldTemplate = asRecord(asRecord(features[MEETING_NOTES_SLICE]).template);
	const processedField = readFieldName(
		layout.processedField,
		oldTemplate,
		"processedField",
		shipped.processedField,
	);
	const dayLinkField = readFieldName(
		layout.dayLinkField,
		oldTemplate,
		"dayLinkField",
		shipped.dayLinkField,
	);
	// No slice to migrate from: the field is new, so a file without it answers
	// the shipped name and a field name alone writes nothing.
	const diaryDateField = readFieldName(layout.diaryDateField, {}, "diaryDateField", shipped.diaryDateField);
	const excluded = layout.excludedFolders;
	const notesHeading = readHeading(layout.notesHeading, shipped.notesHeading);
	const calendarHeading = readHeading(layout.calendarHeading, shipped.calendarHeading);
	const todayHeading = readHeading(layout.todayHeading, shipped.todayHeading);
	const overdueHeading = readHeading(layout.overdueHeading, shipped.overdueHeading);
	const diaryHeading = readDiaryHeading(
		layout.diaryHeading,
		"diaryHeading" in layout,
		freshInstall,
		shipped.diaryHeading,
		notesHeading.value.level,
	);
	const dailyLogTemplate = readTemplatePath(
		layout.dailyLogTemplate,
		"dailyLogTemplate" in layout,
		shipped.dailyLogTemplate,
	);
	const refused = (
		[
			["notesHeading", notesHeading],
			["calendarHeading", calendarHeading],
			["todayHeading", todayHeading],
			["overdueHeading", overdueHeading],
			["diaryHeading", diaryHeading],
			["dailyLogTemplate", dailyLogTemplate],
			["processedField", processedField],
			["dayLinkField", dayLinkField],
			["diaryDateField", diaryDateField],
		] as const
	).filter(([, read]) => read.unusable);
	return {
		unusableFields: refused.map(([key]) => LAYOUT_ROW_NAMES[key]),
		unusableKeys: refused.map(([key]) => key),
		// A layout that is there but not a record has every key missing here; a
		// reload has already put this device's whole layout in for it
		// (`refuseUnusable`), so none of them differs and none is named.
		absentKeys: NAMED_LAYOUT_KEYS.filter((key) => !(key in layout)),
		unrecognised: unrecognisedIn(layout, LAYOUT_KEYS),
		layout: {
			dailyLogFolder: readText(layout.dailyLogFolder, shipped.dailyLogFolder),
			dailyLogFilename: readText(layout.dailyLogFilename, shipped.dailyLogFilename),
			dailyLogTemplate: dailyLogTemplate.value,
			notesHeading: notesHeading.value,
			calendarHeading: calendarHeading.value,
			todayHeading: todayHeading.value,
			overdueHeading: overdueHeading.value,
			diaryHeading: diaryHeading.value,
			processedField: processedField.value,
			dayLinkField: dayLinkField.value,
			diaryDateField: diaryDateField.value,
			tasksHeading: readText(layout.tasksHeading, shipped.tasksHeading),
			completedTasksHeading: readText(
				layout.completedTasksHeading,
				shipped.completedTasksHeading,
			),
			// Named one column at a time, which is what silently discards the third
			// one an older file still carries: a name not read here does not survive
			// the load, and so is never written back.
			calendarColumns: {
				time: readText(columns.time, shipped.calendarColumns.time),
				event: readText(columns.event, shipped.calendarColumns.event),
			},
			excludedFolders: Array.isArray(excluded)
				? excluded.filter((folder): folder is string => typeof folder === "string")
				: shipped.excludedFolders,
			languageHistory,
		},
	};
}

/**
 * The stored `languageHistory`, typed on the way in like every other field
 * `migrateLayout` reads — a value of the wrong shape is not trusted.
 *
 * `unusable` says whether *something* was stored that could not be used as it
 * stood — the field itself not being a record at all (a hand-edited string or
 * number where the `{current, previous}` shape belongs), or `current` or
 * `previous` inside it holding the wrong type — as against the field being
 * simply absent, which is the ordinary shape of a vault that has never
 * recorded one yet and is not a defect to say anything about.
 *
 * **A record's two fields are read independently of each other's shape**: a `current` that cannot be used does not by itself make a
 * usable `previous` unreadable too, since a hand-edited `data.json` can have
 * broken one field and left the other exactly as this store wrote it.
 * {@link reconcileLanguageHistory} is what decides what to do with a
 * `previous` recovered this way while `current` is unusable; this function's
 * job is only to say honestly what was there.
 */
function readStoredLanguageHistory(value: unknown): {
	current: string | null;
	previous: string | null;
	unusable: boolean;
} {
	if (value === undefined) {
		return { current: null, previous: null, unusable: false };
	}
	const isRecord = typeof value === "object" && value !== null && !Array.isArray(value);
	const stored = isRecord ? (value as Record<string, unknown>) : {};
	const currentOk = stored.current === undefined || typeof stored.current === "string";
	const previousOk =
		stored.previous === undefined || stored.previous === null || typeof stored.previous === "string";
	return {
		current: typeof stored.current === "string" ? stored.current : null,
		previous: typeof stored.previous === "string" ? stored.previous : null,
		unusable: !isRecord || !currentOk || !previousOk,
	};
}

/**
 * Reconciles the stored language history against Obsidian's own language
 * right now. Three cases: nothing usable was stored under `current` — a
 * fresh install, or a hand-edited value this store cannot use — so there is
 * nothing of its own to fall back to and none is started until a real change
 * is seen, though a `previous` that was itself usable survives rather than
 * being dropped alongside the `current` that was not; the
 * language matches what was last recorded, so nothing has changed and the
 * history is kept exactly as stored; or the language has moved on since the
 * last time this ran, so the stored `current` becomes `previous` and the live
 * language becomes the new `current` — the one point in the plugin's life
 * where one language turns into the next, because this runs once, from
 * {@link SettingsStore.load}, rather than on every read the way the rest of
 * the layout is.
 *
 * `changed` says whether `load` needs to write the result: always in the
 * first and third cases, since what is decided there never agrees with what
 * was actually on disk — nothing, something unusable, or a language that has
 * since moved on — and in the second case only when something stored was
 * unusable and is being corrected in memory, or the file would go on
 * announcing the same reset on every launch until something unrelated
 * happened to save.
 */
function reconcileLanguageHistory(value: unknown): {
	history: LanguageHistory;
	changed: boolean;
	unusable: boolean;
} {
	const stored = readStoredLanguageHistory(value);
	const live = getLanguage();
	if (stored.current === null) {
		return {
			history: { current: live, previous: stored.previous },
			changed: true,
			unusable: stored.unusable,
		};
	}
	if (stored.current === live) {
		return {
			history: { current: stored.current, previous: stored.previous },
			changed: stored.unusable,
			unusable: stored.unusable,
		};
	}
	return { history: { current: live, previous: stored.current }, changed: true, unusable: stored.unusable };
}

/* ------------------------------------------------------------------------ */
/* What never leaves this device.                                             */
/* ------------------------------------------------------------------------ */

/**
 * The key the per-device store writes under. Obsidian's `loadLocalStorage` and
 * `saveLocalStorage` are already scoped to one vault, so this only has to be
 * unique among the plugins in it.
 */
const DEVICE_KEY = "effortless:device";

/** The answers that belong to this device alone and must never sync. */
export interface DeviceSettings {
	/**
	 * Whether this device is the one that creates the days ahead. Ships off: a
	 * device nobody has asked must not start writing into the vault, and two
	 * devices that both said yes would create the same day and fight over it.
	 */
	buildsTheDays: boolean;
	/**
	 * How each calendar source's last read went here, by source id. Per-device
	 * for the same reason as everything else in this store: a link that failed
	 * on the laptop has not failed on the phone, and a row that said otherwise
	 * would be showing the other machine's trouble.
	 */
	calendarReads: Record<string, CalendarRead>;
	/**
	 * Where each calendar account's app-specific password was kept on this
	 * device, by the account's id, before it moved to Obsidian's keychain. Read now
	 * only by {@link DeviceStore.movePasswordsToKeychain}, which empties it.
	 *
	 * Still read and written whole like the other fields, rather than dropped
	 * from this record: a field `read` no longer returned would be erased by
	 * the next `save` of anything, and with it a password the move could not
	 * carry.
	 */
	accountPasswords: Record<string, string>;
}

export function defaultDeviceSettings(): DeviceSettings {
	return { buildsTheDays: false, calendarReads: {}, accountPasswords: {} };
}

/** The stored app-specific passwords, keeping only an entry that is text and not empty. */
function readAccountPasswords(value: unknown): Record<string, string> {
	const passwords: Record<string, string> = {};
	for (const [id, stored] of Object.entries(asRecord(value))) {
		if (typeof stored === "string" && stored !== "") passwords[id] = stored;
	}
	return passwords;
}

/**
 * The per-source read state, read one entry at a time. An entry that is not a
 * record is dropped, and a field inside one that is not the shape it should be
 * takes null. Nothing is lost by being strict here: the next refresh reads the
 * calendar again and writes the state back.
 *
 * Four fields are read, and the last two are optional in a way the first two are
 * not. `readFrom` is the address a `readAt` was earned at, and an entry with no
 * `readFrom` means "earned wherever this source points now" — which is what
 * every entry written before that field existed means. `loss` says whether a
 * failure was a partial or a total loss of entries, and is absent when the
 * failure was not a loss at all. So either key is carried or left
 * off; writing an explicit `undefined` would be a third state the calendar does
 * not have.
 *
 * The other rule above still holds: a name this version does not read is not
 * returned. `readFrom` is a name this version now reads.
 */
function readCalendarReads(value: unknown): Record<string, CalendarRead> {
	const reads: Record<string, CalendarRead> = {};
	for (const [id, stored] of Object.entries(asRecord(value))) {
		if (typeof stored !== "object" || stored === null || Array.isArray(stored)) continue;
		const read = stored as Record<string, unknown>;
		const readAt = read.readAt;
		const entry: CalendarRead = {
			readAt: typeof readAt === "number" && Number.isFinite(readAt) ? readAt : null,
			failure: typeof read.failure === "string" ? read.failure : null,
		};
		if (typeof read.readFrom === "string") entry.readFrom = read.readFrom;
		// The rule both optional fields follow is in this function's own doc
		// comment. This line applies it to the grade: without it the grade is
		// written by the calendar and then dropped by every read of the store,
		// silently.
		if (read.loss === "partial" || read.loss === "total") entry.loss = read.loss;
		reads[id] = entry;
	}
	return reads;
}

/** What Obsidian's keychain takes as a secret's id, read from the test Obsidian 1.14.4's own `validateId` (`docs/acceptance-shots/issue-1216-keychain-id-rule.txt`). */
const SECRET_ID = /^[a-z0-9-]{1,64}$/;

/** A password {@link DeviceStore.movePasswordsToKeychain} left in the per-device store, and the reason. */
export interface PasswordLeftBehind {
	accountId: string;
	reason: string;
}

/**
 * The id a calendar account's app-specific password is kept under in
 * Obsidian's keychain, `effortless-calendar-<account id>`, or null when the
 * account's id cannot make one. An id the plugin made always can
 * (`newCalendarSourceId`); one typed into `data.json` by hand may be any text,
 * and is refused here rather than altered, because two altered ids could
 * name the same secret.
 */
export function passwordSecretId(accountId: string): string | null {
	const id = `effortless-calendar-${accountId}`;
	return accountId !== "" && SECRET_ID.test(id) ? id : null;
}

/**
 * The per-device store. Separate from `SettingsStore` on purpose, and holding
 * no reference to the plugin, so there is no route from here to `saveData` at
 * all — a device's answer cannot reach the synced file even by mistake.
 *
 * It also reaches Obsidian's keychain, `app.secretStorage`, for the calendar
 * accounts' app-specific passwords. The keychain
 * is not a vault file, so Obsidian Sync never carries it, and on a desktop it
 * is encrypted with the operating system's key store where one runs.
 * The password stays on the device it was typed on.
 */
export class DeviceStore {
	constructor(private readonly app: App) {}

	/**
	 * The account's app-specific password on this device, or undefined when
	 * there is none. The keychain publishes no way to delete a secret
	 * (`node_modules/obsidian/obsidian.d.ts:5635-5664`, class `SecretStorage`,
	 * obsidian 1.13.1), so a forgotten password is an
	 * empty one, and empty reads as none, as does missing.
	 */
	password(accountId: string): string | undefined {
		const id = passwordSecretId(accountId);
		if (id === null) return undefined;
		const secret = this.app.secretStorage.getSecret(id);
		return secret === null || secret === "" ? undefined : secret;
	}

	/**
	 * Keeps `value` as the account's app-specific password on this device, or
	 * forgets it when `value` is blank. Throws, with a sentence to show, when
	 * the account's id cannot name a secret; Obsidian's own `setSecret` throws
	 * where it has no secure storage at all.
	 *
	 * A password the move left in the per-device store for this account is
	 * given up once this lands: the person's own answer is the newer one, and
	 * the next start's move would otherwise write the old one over it.
	 */
	keepPassword(accountId: string, value: string): void {
		this.writeSecret(accountId, value);
		const { accountPasswords } = this.read();
		if (!(accountId in accountPasswords)) return;
		const rest = { ...accountPasswords };
		delete rest[accountId];
		this.save({ accountPasswords: rest });
	}

	/** Writes the account's secret, throwing as {@link keepPassword} says. */
	private writeSecret(accountId: string, value: string): void {
		const id = passwordSecretId(accountId);
		if (id === null) {
			throw new Error(
				`The calendar account "${accountId}" cannot hold a password on this device: ` +
					"its id in the settings file is not lowercase letters, digits and dashes. Remove the account and add it again.",
			);
		}
		this.app.secretStorage.setSecret(id, value);
	}

	/**
	 * Moves each password kept in {@link DeviceSettings.accountPasswords} into
	 * the keychain. An entry leaves the per-device store only once the keychain
	 * has taken it and reads back exactly what was written; one that it refuses,
	 * or that reads back otherwise, stays where it was. Answers each account
	 * whose password stayed and why, for the caller to say so; a store with
	 * nothing to move is not written at all.
	 *
	 * What the read-back can and cannot catch, read from Obsidian 1.14.4's own
	 * code (`docs/acceptance-shots/issue-1216-keychain-id-rule.txt`):
	 * `getSecret` answers from memory, so in practice the check that matters is
	 * `setSecret` not throwing. On a desktop that is enough for nothing to be
	 * lost, because there `setSecret` writes the keychain into Obsidian's local
	 * storage before it returns, and the per-device store lives in the same
	 * local storage, so the entry's removal is written after the keychain
	 * write, never before it. The phone's keychain was not read; that it holds
	 * the same order there is an inference.
	 */
	movePasswordsToKeychain(): PasswordLeftBehind[] {
		const left = { ...this.read().accountPasswords };
		if (Object.keys(left).length === 0) return [];
		const stayed: PasswordLeftBehind[] = [];
		for (const [accountId, password] of Object.entries(left)) {
			try {
				this.writeSecret(accountId, password);
			} catch (error) {
				stayed.push({ accountId, reason: reasonOf(error) });
				continue;
			}
			if (this.password(accountId) === password) delete left[accountId];
			else stayed.push({ accountId, reason: "The keychain did not read back what was written." });
		}
		this.save({ accountPasswords: left });
		return stayed;
	}

	/**
	 * Built one field at a time, like every read of the synced file above, and
	 * for the same two reasons. A value of the wrong shape takes its default
	 * instead of being trusted — a build switch stored as the string `"false"`
	 * is truthy, and would quietly make this the device that writes the days.
	 * And a name this version does not read is not returned, so the next `save`
	 * does not write it back either.
	 */
	read(): DeviceSettings {
		const stored = asRecord(this.app.loadLocalStorage(DEVICE_KEY));
		const shipped = defaultDeviceSettings();
		return {
			buildsTheDays: readFlag(stored.buildsTheDays, shipped.buildsTheDays),
			calendarReads: readCalendarReads(stored.calendarReads),
			accountPasswords: readAccountPasswords(stored.accountPasswords),
		};
	}

	/**
	 * Writes the answers named in `change` and leaves the rest alone. A merge
	 * rather than a replacement, because unrelated things live here — the
	 * build switch, the calendar's read state and the calendar accounts'
	 * app-specific passwords — and each is written by code that knows nothing
	 * about the others.
	 */
	save(change: Partial<DeviceSettings>): void {
		this.app.saveLocalStorage(DEVICE_KEY, { ...this.read(), ...change });
	}
}
