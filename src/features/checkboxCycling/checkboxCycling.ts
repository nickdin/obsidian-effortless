/**
 * The feature itself: what the core loads, the commands it puts in the palette,
 * and the few lines of editor work that turn a keypress into an edit.
 *
 * **Every decision a press makes was made before this file.** `cycleLines` says
 * which lines are touched and what each one becomes, on text alone; this half
 * reads the selection, calls it, and writes the answer back in one
 * `editor.transaction` so that one undo puts the whole selection back. Where
 * the person's selection was and where it has to end up — the part `cycleLines`
 * cannot see — is `selectionGeometry.ts`, which this file calls and does not
 * hold.
 *
 * **It never leaves the editor.** No `Vault`, no note writer, no event handler
 * and no view — an editor edit keeps the person's selection and their undo
 * history, and a whole-file rewrite cannot. It references no
 * other feature and knows of none.
 *
 * **It saves through its own settings handle and never calls `saveData`.** Five
 * plugins are merging under one Obsidian manifest id and Obsidian gives a
 * plugin one `data.json`; `src/core/settings.ts` is the only writer of it.
 */

import { Notice } from "obsidian";
import type {
	EditorChange,
	EditorSelection,
	EditorTransaction,
} from "obsidian";
import { Feature } from "../../core/feature";
import type { Readiness, SettingsChanged } from "../../core/feature";
import { reasonOf } from "../../core/reason";
import type { SaveFailureAnnouncer } from "../../core/saveFailureAnnouncer";
import { cycleLines } from "./cycleLines";
import type { LineRange } from "./cycleLines";
import { lineKindRange } from "./lineKind";
import type { LeftAloneReason, LineKind } from "./lineKind";
import { keptWhereItWas, rangeOf } from "./selectionGeometry";
import {
	DEFAULT_SEQUENCES,
	FEATURE_ID,
	commandIdFor,
	sequencesReadiness,
	usableSequences,
} from "./sequences";
import { CHECKBOX_CYCLING_SETTING_NAMES, renderCheckboxCyclingSettings } from "./settingsPanel";
import type { CycleDirection, Sequence } from "./types";

/**
 * The part of Obsidian's `Editor` a press actually uses.
 *
 * Obsidian's own `Editor` is an abstract class of forty-odd methods that only
 * the running app can supply, and naming it here would make every test of this
 * file need one. These four are what a press asks for, and Obsidian's `Editor`
 * has all four, so the real thing is handed straight in and a test hands in
 * four functions.
 */
export interface CyclingEditor {
	/** How many lines the note has. */
	lineCount(): number;
	/**
	 * One line, without its `\n` — but **with any carriage return** a note
	 * written or synced from Windows put in front of it.
	 *
	 * Obsidian hands the `\r` straight through, so a raw line can be `- [ ]\r`
	 * rather than `- [ ]`, and anything that reads words off the end of a line
	 * sees a character that is not one.
	 * `cycleLines.ts` is where that character is taken off before a press decides
	 * and **put back on the line the press writes** — it is the only module that
	 * restores it, because it is the only one that writes. Several others strip
	 * one for their own reading and never write it back: `lineKind.ts:201` and
	 * `:301`, and `markdownSections.ts:63` and `:137`. A second reader of this
	 * port has to do its own stripping rather than assume it was already done.
	 */
	getLine(line: number): string;
	/** Every selection, including the plain cursor, which is an empty one. */
	listSelections(): EditorSelection[];
	/** One edit, so that one undo puts all of it back. */
	transaction(tx: EditorTransaction): void;
}

/** This feature's slice of `data.json`. */
export interface CheckboxCyclingSettings {
	/**
	 * The named cycles, in the order the settings screen shows them — and, after
	 * them, any stored record this version could not read.
	 *
	 * **Typed as unknown because that is what is on disk.** `data.json` is a file
	 * a person can edit and a later version of the plugin can write, so a record
	 * here may be missing a name, missing an id, or missing its list of symbols.
	 * Nothing reads this field directly: `usableSequences` in `sequences.ts` is
	 * the one door, and it hands back the records that are sequences and the ones
	 * that are not. Saying `Sequence[]` here claimed a guarantee the file cannot
	 * give, and the code that believed it wrote the refused records out of
	 * existence on the next edit.
	 */
	readonly sequences: readonly unknown[];
	/**
	 * Whether the seventeen characters outside #294's five — the widely used
	 * convention's own alternate-checkbox set, `? i I " * k b !` and `<` among
	 * them — get Effortless's own look too.
	 *
	 * On by default. Off is for someone whose theme already draws these
	 * characters itself: `styles.css`'s own rule for them is gated behind
	 * `.effortless-symbol-look` on `<body>` because it is heavy enough to beat
	 * such a theme, and beating it is exactly what turning this off avoids
	 * (issue #752, and that
	 * file's comment on the class for the measurement this rests on).
	 */
	readonly symbolLook: boolean;
}

/** Both commands a sequence produces, in the order the palette gets them. */
const DIRECTIONS: readonly CycleDirection[] = ["forward", "backward"];

/**
 * The class `styles.css`'s extended-symbol rules are gated behind, on
 * `<body>` — the whole footprint of the switch issue
 * #752 adds. It is global
 * rather than per-pane because the look has to reach every open reading view
 * and live preview at once, and CSS has no other reach that wide.
 *
 * **Put on every open window's own `<body>`, not only the main one's.** A
 * note moved to a popout window (`Move to new window`) has its own document
 * and its own `<body>`; a class added to the main window's is never mirrored
 * there.
 * {@link CheckboxCycling.windowBodies} is what finds every one of them.
 */
const SYMBOL_LOOK_CLASS = "effortless-symbol-look";

/** The shipped default for `CheckboxCyclingSettings.symbolLook`. */
const DEFAULT_SYMBOL_LOOK = true;

/**
 * `symbolLook` as the feature can actually use it: the stored value when it
 * is a boolean, the shipped default otherwise.
 *
 * **A missing key is not an unusable one.** `FeatureSettings.read()` already
 * fills a missing `symbolLook` in from the shipped default before this ever
 * runs (`src/core/settings.ts`'s `{...defaults, ...stored}` merge), which is
 * every slice saved before this ticket — so this function never sees "missing",
 * only "present and not a boolean", and only the second case is a refusal.
 *
 * **What it cannot use is refused, never trusted as if it were the type the
 * interface claims.** `data.json` sits in the vault and a person can
 * hand-edit it, so a stored `symbolLook` is not guaranteed to be one —
 * `"no"`, a number or an object are all valid JSON there, and handing one of
 * those straight to `Element.toggleClass` would coerce it to a truth value
 * that was never actually chosen. Checked the same way `usableTrigger` is
 * (`dateEntry/types.ts`, issue #607): a value this feature cannot use is
 * refused here, silently — this function only answers what can be used. The
 * notice is `onload`'s own, below, said once per load rather than once per
 * call to this function.
 */
function usableSymbolLook(stored: unknown): boolean {
	return typeof stored === "boolean" ? stored : DEFAULT_SYMBOL_LOOK;
}

/** One command this feature wants in the palette, with what it needs to run. */
interface WantedCommand {
	readonly id: string;
	readonly name: string;
	readonly sequenceId: string;
	readonly direction: CycleDirection;
}

export class CheckboxCycling extends Feature {
	readonly id = FEATURE_ID;

	readonly name = "Checkbox cycling";

	readonly description =
		"Steps the character in a checkbox through a sequence you choose, with one key.";
	override readonly settingNames = CHECKBOX_CYCLING_SETTING_NAMES;

	/**
	 * Taken here and used from `onload` onwards, which is what the feature
	 * contract asks for: the handle finds its feature when it is read, not when
	 * it is taken (`src/core/feature.ts`).
	 */
	private readonly own = this.host.settings<CheckboxCyclingSettings>({
		sequences: DEFAULT_SEQUENCES,
		symbolLook: DEFAULT_SYMBOL_LOOK,
	});

	/**
	 * The commands this feature currently holds, as command id to the name it
	 * was registered under.
	 *
	 * The name is kept as well as the id because a renamed sequence has to gain
	 * its new name in the palette while keeping its id — the id is what
	 * Obsidian keys the person's hotkey by, so re-deriving it would cost them
	 * the hotkey on every rename (spec decision 2).
	 */
	private readonly registered = new Map<string, string>();

	/**
	 * Whether the core has this feature loaded.
	 *
	 * `addCommand` refuses only while the feature is being built, so a feature
	 * the person has switched off can still reach it — and the settings screen
	 * opens a switched-off feature's own settings on purpose. Without this flag
	 * an edit made there would put commands in the palette for a feature that is
	 * not running.
	 */
	private running = false;

	/**
	 * How many refused stored records the person has already been told about.
	 *
	 * The refusal is said from three places — a load, the settling of a save of
	 * the list (immediate or deferred), and the drawing of this feature's own
	 * settings card — and each of them can run
	 * again over an unchanged `data.json`, so within one run of the feature it is
	 * said once per fact rather than once per call; across runs the
	 * same fact is repeated on purpose, see below. A different number means a
	 * different fact and is said again, and a number that has gone back to zero
	 * is remembered as zero, so a refusal that comes back is announced rather than
	 * swallowed. No
	 * shipped path changes the stored records under a running plugin — nothing
	 * re-reads `data.json` after load, and the feature's own save keeps the
	 * refused records — so the case that drives a changed number writes through
	 * the host directly.
	 *
	 * It counts what has been said in *this run* of the feature: forgotten in
	 * `onload`, so a switch back on says it again.
	 */
	private announcedRefusals = 0;

	override onload(): void {
		this.running = true;
		// Forgotten here, on the load side, so the refusal is said once per run:
		// the person who switched the feature back on is being told what it starts
		// with. It was forgotten on unload until #506, and that announced it on the
		// switch *off*, because in those days reading the list was what said the
		// refusal, and the settings screen reads every row's list after the
		// switch. Since #513 a read says nothing — `announceRefusals` is called
		// from here, from `displaySettings` and from `settle`, which both saves
		// run through, and from nowhere else — so the settings screen's reads no
		// longer come into it.
		// The side still matters: forgotten on unload, an open card would say the
		// refusal again on the switch off, because `displaySettings` announces.
		// Load is the side the first sentence above is about, so it stays here.
		this.announcedRefusals = 0;
		this.syncCommands();
		this.applySymbolLook();
		this.announceRefusals();
		// #752, the same shape as `dateEntry.ts`'s trigger/language notices: said
		// once per load, against what is actually stored, because `symbolLook()`
		// stays silent on every other read (`applySymbolLook` above included) and
		// the stored value is never rewritten by this. A missing key already
		// reads back the default through `FeatureSettings.read()`'s own merge, so
		// this only ever fires for a key that is present and not a boolean.
		const storedSymbolLook = this.own.read().symbolLook;
		if (typeof storedSymbolLook !== "boolean") {
			new Notice(
				`Effortless: checkbox cycling cannot use ${JSON.stringify(storedSymbolLook)} stored for whether the extended symbols get a look, and runs with it on instead. Change it on the Effortless settings screen.`,
			);
		}
		// The palette follows the store whenever it puts memory back, not only
		// when this feature's own write answers: the write whose refusal puts it
		// back can be any route's, queued after this feature's own had settled. Registered on
		// the component, so the switch off drops it.
		this.register(this.own.onChange(() => this.settle()));
		// A window opened after load starts with no class on its own `<body>` —
		// nothing mirrors the main window's class onto it — so the gate has to
		// be put there directly rather than waiting for the next `settle`.
		// `Workspace.on("window-open", …)`,
		// `node_modules/obsidian/obsidian.d.ts:8090`. Registered on the
		// component, so `onunload` dropping it is what stops a window opened
		// after the switch off from being touched.
		this.registerEvent(
			this.host.app.workspace.on("window-open", (win) => {
				win.doc.body.toggleClass(SYMBOL_LOOK_CLASS, this.symbolLook());
			}),
		);
	}

	override onunload(): void {
		this.running = false;
		// The core takes every command back itself, on both sides of this method
		// (`src/core/registry.ts`), so asking for that again here would be asking
		// twice. What is left is this feature's own record of what it holds:
		// emptied, so that switching the feature on again registers the set from
		// scratch rather than believing it already has it.
		this.registered.clear();
		// The class is this feature's own effect on the wider page, so it goes
		// the same place every other effect of a switched-off feature goes: away
		// — from every open window, not only the main one. A note already
		// carrying an extended symbol reads as a plain open task meanwhile, which
		// is what it already was underneath the look.
		for (const body of this.windowBodies()) body.removeClass(SYMBOL_LOOK_CLASS);
	}

	readiness(): Readiness {
		return sequencesReadiness(this.stored());
	}

	/**
	 * Draws this feature's own settings into the element the core hands over,
	 * and says whether any stored record was refused.
	 *
	 * The core has already drawn the card and the on/off switch above it
	 * (`src/core/settingsTab.ts`), so this adds neither. It hands the panel
	 * `this`, which is the whole of what the panel is allowed to reach: the two
	 * methods below, and nothing else on the feature.
	 *
	 * The card is the one place a switched-off feature can be told about a
	 * refused record, because a switched-off feature never loads. Why it is this
	 * card rather than the settings screen is on `announceRefusals`.
	 */
	override displaySettings(
		containerEl: HTMLElement,
		changed: SettingsChanged,
		announceDeferredSaveFailure?: SaveFailureAnnouncer,
	): void {
		renderCheckboxCyclingSettings(containerEl, this, changed, announceDeferredSaveFailure);
		this.announceRefusals();
	}

	/** The sequences as they are stored, for whatever draws the settings card. */
	sequences(): readonly Sequence[] {
		return this.stored();
	}

	/**
	 * The stored sequences, with anything that is not one refused.
	 *
	 * **A plain read.** It says nothing, remembers nothing, and can be called any
	 * number of times from anywhere; the refusal is said by `announceRefusals`,
	 * from the three places that know something has just happened — a load, the
	 * settling of either save, the drawing of this feature's card —. Until then the
	 * notice was raised from here, and so by whichever of the four readers of this
	 * method happened to run first — for a switched-off feature, the settings
	 * screen asking its readiness — and a fifth reader would have been a fifth
	 * place a notice could come from, with nothing in its name to say so.
	 *
	 * **Every reader of the list goes through here**, so the palette, readiness, a
	 * press and the settings card all see the same clean set and none of them has
	 * to remember that `data.json` can hold anything. What makes a
	 * record usable, and what is thrown on rather than refused, is
	 * `usableSequences` in `sequences.ts`; the words a person reads about a
	 * refusal are `announceRefusals`'s, the way the left-alone sentences below are
	 * this half's.
	 */
	private stored(): readonly Sequence[] {
		return usableSequences(this.own.read().sequences).usable;
	}

	/**
	 * The stored records this feature refused, exactly as they sit on disk.
	 *
	 * `saveSequences` writes them back beside the list it was handed. Everything
	 * the person can edit is built from `stored()`, which has already dropped
	 * these, so without this a rename or an Add would replace the whole list with
	 * the usable part of it and the refused records would be gone — deleted by an
	 * edit that had nothing to do with them, after a notice that called them
	 * *skipped*.
	 */
	private refusedRecords(): readonly unknown[] {
		return usableSequences(this.own.read().sequences).refused;
	}

	/**
	 * Says how many stored records were refused, once per fact rather than per call.
	 *
	 * **Called from three places and nowhere else**: `onload`, `displaySettings`
	 * and `settle`, which `saveSequences` and the deferred `saveSequencesSoon`
	 * both end in — the moments a load, the opening of this feature's own card,
	 * or a change to the list has just happened. Reading the list is
	 * not one of them.
	 * The list is read on every press, on every draw of the settings screen for
	 * every feature's row, and once more just before the core loads a feature, to
	 * ask whether it stands down (`src/core/registry.ts`); until #513 whichever
	 * read came first was what said the refusal, which on a plugin reload was
	 * that pre-load read and then the load again, and for a switched-off
	 * feature was the settings screen opened for some other feature.
	 *
	 * **One thing changed for a switched-off feature, on purpose.** It never
	 * loads, so before #513 it was heard from at the settings screen's first
	 * draw: the person opened Settings about something else and was told about
	 * this feature's record. Now it is heard from when its own card is opened.
	 * The card is where the list is edited, so the notice arrives at the moment
	 * the person can do something about it, and not before. A switch on after
	 * that says it once more, because `onload` forgets the count and tells the
	 * person what the feature starts with. The other order is quieter: a feature
	 * that announced at load and is switched off later hears nothing more from
	 * its card in that run, because the count is unchanged and the same fact is
	 * not said twice within a run.
	 *
	 * **It does not say which field was missing**, because there are three of them
	 * and the record can be missing any combination: a name, an id, or a list of
	 * symbols. Naming one of the three was wrong as soon as the third
	 * joined them — a record with both its names and no symbols was announced as
	 * having "no usable name or id". The records themselves are kept on disk and
	 * written back, so nothing here is the person's only copy.
	 */
	private announceRefusals(): void {
		const refused = this.refusedRecords().length;
		if (refused === this.announcedRefusals) return;
		this.announcedRefusals = refused;
		if (refused === 0) return;
		new Notice(
			refused === 1
				? "Effortless: one stored cycling sequence is not one this version can read, so it was skipped and has no commands. It is left as it is on disk."
				: `Effortless: ${refused} stored cycling sequences are not ones this version can read, so they were skipped and have no commands. They are left as they are on disk.`,
		);
	}

	/**
	 * Stores a new set of sequences and brings the palette into line with it.
	 *
	 * This is the whole of spec decision 8: the commands come from a list the
	 * person edits, so the set changes while the feature is loaded. A sequence
	 * that has gone has its command withdrawn, a new one gains a pair, and a
	 * renamed one keeps its id and gains its new name.
	 *
	 * **The palette follows a failed write too**, and the failure is still passed
	 * on for the panel to announce. The store changes what it reads before it
	 * writes the file, and after a rejected write it keeps that change whenever
	 * a write queued behind it or waiting on the typing timer will carry it to
	 * the file, so the settings list can show the new list; bringing the palette
	 * into line only after a write that landed left the two disagreeing until an
	 * unrelated save or a reload. What the store
	 * reads after a rejected write is the store's business; this follows it.
	 *
	 * **"This feature's own write answered" is not "the store has finished
	 * changing".** The store puts memory back when the last write queued is
	 * refused, and that can be a write from another route after this one has
	 * settled; `onload` registers `settle` on the store's `onChange` for that.
	 */
	async saveSequences(next: readonly Sequence[]): Promise<void> {
		try {
			await this.own.save(this.sliceHolding(next));
		} finally {
			this.settle();
		}
	}

	/**
	 * The deferred run this feature has already chained its own work onto, and
	 * `null` before any.
	 *
	 * Kept so that the work is chained once per run rather than once per
	 * keystroke. The handle answers the whole run with the same promise, so its
	 * identity is what says *same run*; a stale entry can never match, because a
	 * later run is a different promise, and so nothing here has to clear it.
	 */
	private chainedOnto: Promise<void> | null = null;

	/**
	 * The same as `saveSequences`, but for a name arriving one character at a
	 * time: the list changes straight away and the file is written once the
	 * typing has stopped. The palette is brought into line when that write has
	 * answered, once for the run, so it ends on the name the store reads then
	 * rather than on one typed halfway — whether the
	 * write landed or failed, for the reason `saveSequences` gives.
	 *
	 * **What comes back is the store's own promise for the run**, not one chained
	 * from it. The promise is the run's name, and the settings screen announces a
	 * failed write once per name. The store answers a core card box typed in the
	 * same window with that same promise, so a promise of this feature's own
	 * would be a second name for one write, and the screen's one announcer would
	 * tell that write twice.
	 *
	 * The palette work is chained onto the run before the run is handed back, so
	 * anyone awaiting what comes back finds it already done, and it runs on both
	 * branches. The rejection is not rethrown from that chain because nobody
	 * holds it: the caller hears the store's own error through the run itself,
	 * and a rethrow here would surface the one failure a second time, as an
	 * unhandled rejection with nobody to announce it.
	 */
	saveSequencesSoon(next: readonly Sequence[]): Promise<void> {
		const run = this.own.saveSoon(this.sliceHolding(next));
		if (this.chainedOnto === run) return run;
		this.chainedOnto = run;
		run.then(
			() => this.settle(),
			() => this.settle(),
		);
		return run;
	}

	/**
	 * The slice as it is written: the list the person edited, then the refused
	 * records after it. Their original places among it cannot be reconstructed
	 * once they have been filtered out, and nothing can see them anyway — what
	 * matters is that a rename does not delete them.
	 */
	private sliceHolding(next: readonly Sequence[]): CheckboxCyclingSettings {
		return {
			sequences: [...next, ...this.refusedRecords()],
			symbolLook: this.own.read().symbolLook,
		};
	}

	/**
	 * What follows a save that has answered, immediate or deferred, landed or
	 * failed — or the store putting memory back under this feature: the
	 * palette, then the refusal.
	 */
	private settle(): void {
		if (this.running) {
			this.syncCommands();
			this.applySymbolLook();
		}
		// Outside the `if` rather than inside it, because a save while the feature
		// is off syncs nothing and must still announce; `announceRefusals` reads
		// nothing `syncCommands` writes, so the order between them is free.
		this.announceRefusals();
	}

	/**
	 * Puts `styles.css`'s extended-symbol gate on every open window's
	 * `<body>` to match what this feature can use, or takes it off.
	 *
	 * Called only while `running`, from `onload` and from `settle`: a save
	 * reaching here while the feature is off changes what is stored and
	 * nothing on the page, exactly as a sequence edit would.
	 */
	private applySymbolLook(): void {
		const on = this.symbolLook();
		for (const body of this.windowBodies()) body.toggleClass(SYMBOL_LOOK_CLASS, on);
	}

	/**
	 * Every window whose `<body>` the gate has to reach: the main one always,
	 * and any popout the workspace currently holds a leaf in.
	 * `Workspace.iterateAllLeaves` is real Obsidian's own route to a popout's
	 * document — a plugin has no other way to find one
	 * (`node_modules/obsidian/obsidian.d.ts:8009`, issue
	 * #774). The main
	 * window is included directly rather than found the same way, because a
	 * workspace that holds no leaf at all — unreachable in the real app, not
	 * unreachable in a test — must still leave the main window itself
	 * gate-able.
	 */
	private windowBodies(): readonly HTMLElement[] {
		const docs = new Set<Document>([document]);
		this.host.app.workspace.iterateAllLeaves((leaf) => {
			docs.add(leaf.getContainer().doc);
		});
		return [...docs].map((doc) => doc.body);
	}

	/**
	 * Whether the extended symbols get Effortless's own look, as this feature
	 * can use it — judged, not the raw stored value (#752, {@link
	 * usableSymbolLook}). What the settings card's toggle reads and draws.
	 */
	symbolLook(): boolean {
		return usableSymbolLook(this.own.read().symbolLook);
	}

	/**
	 * Stores whether the extended symbols get Effortless's own look, and
	 * brings `<body>`'s class into line with it. One press, one write.
	 */
	async saveSymbolLook(value: boolean): Promise<void> {
		try {
			await this.own.save({ sequences: this.own.read().sequences, symbolLook: value });
		} finally {
			this.settle();
		}
	}

	/** Registers what is missing and withdraws what no longer applies. */
	private syncCommands(): void {
		const wanted = this.wantedCommands();
		const names = new Map<string, string>(wanted.map((each) => [each.id, each.name] as const));

		// Read off a copy, because the loop deletes from the map it walks. A
		// command whose name has changed goes as well as one whose sequence has:
		// re-registering under the same id is how the palette gains the new name
		// without the hotkey noticing.
		for (const [id, name] of [...this.registered]) {
			if (names.get(id) === name) continue;
			this.host.removeCommand(id);
			this.registered.delete(id);
		}

		for (const each of wanted) {
			if (this.registered.has(each.id)) continue;
			this.host.addCommand({
				id: each.id,
				name: each.name,
				// `editorCallback` rather than `callback`, so the command is
				// reachable from the mobile palette and the mobile toolbar (spec
				// decision 10).
				editorCallback: (editor) => this.press(editor, each.sequenceId, each.direction),
			});
			this.registered.set(each.id, each.name);
		}
	}

	/** Two commands per usable stored sequence, forward and backward. */
	private wantedCommands(): WantedCommand[] {
		const wanted: WantedCommand[] = [];
		for (const sequence of this.stored()) {
			for (const direction of DIRECTIONS) {
				wanted.push({
					id: commandIdFor(sequence, direction),
					name: `${sequence.name}: cycle ${direction}`,
					sequenceId: sequence.id,
					direction,
				});
			}
		}
		return wanted;
	}

	/**
	 * One press, and the one place a failure inside it is caught.
	 *
	 * Obsidian owns this callback, so anything thrown out of it is an uncaught
	 * throw during a keystroke: the person's key does nothing, nothing on screen
	 * says why, and the only record is a console line nobody is looking at. It
	 * is caught and said out loud instead, which is the announced fallback
	 * `~/Devbox/CLAUDE.md` § *Tests and failures* allows rather than the silent
	 * one it forbids. The note is left exactly as it was either way: the
	 * transaction is the last thing a press does, so anything that throws has
	 * thrown before a single character was written.
	 *
	 * **No throw reachable from a real note is known today, and the catch stays
	 * anyway.** The one that used to stand here — a task line with nothing after
	 * its checkbox in a note written or synced from Windows — was fixed by
	 * #424. What `cycleLines`
	 * still throws on is a caller's mistake: a range the note does not hold, or
	 * line kinds that disagree with the task reader. Neither can be reached
	 * through this class, because the range and the lines are read from one
	 * document inside one synchronous handler. The catch is here because the
	 * cost of being wrong about that is not a stack trace but a key that does
	 * nothing and says nothing — see
	 * #466 and
	 * #471, where the
	 * previous wording claimed a live case it did not have.
	 */
	private press(editor: CyclingEditor, sequenceId: string, direction: CycleDirection): void {
		try {
			this.cycle(editor, sequenceId, direction);
		} catch (error) {
			new Notice(`Effortless: the cycling key could not run. ${reasonOf(error)}`);
		}
	}

	/** The press itself: read, decide, write back once. */
	private cycle(editor: CyclingEditor, sequenceId: string, direction: CycleDirection): void {
		const sequence = this.sequenceWith(sequenceId);
		if (sequence === null) {
			new Notice("Effortless: that sequence has been deleted, so a press has nothing to step.");
			return;
		}

		const before = readLines(editor);
		const selections = editor.listSelections();
		const ranges = selections.map(rangeOf);
		// Once per press, however many cursors there are, and once more for nothing
		// else in the press.
		//
		// What is bounded is the classifying, which is the walk that has to look at
		// every line above the one it answers about. Reading the note's text is not
		// bounded: `readLines` above still asks the editor for every line, and the
		// fence scan inside `lineKindRange` walks to the note's length. The tests
		// for this bound count what the classifier was asked for, and that is what
		// they are counting.
		// Deciding what a press may do to a line means reading the note from line
		// zero — a line inside a code fence cannot be recognised without everything
		// above it — so a reading per cursor was thirty readings of a three-thousand
		// line log for one keystroke, and a second thirty when the press turned out
		// to change nothing. The kinds are the same for every selection because they
		// are all read from this one `before`.
		//
		// **That one reading stops at the lowest cursor's end, not at the foot of the
		// note.** The bound it is given is where the walk stops, so asking for the
		// note's length asked for the whole note however small the selection: one
		// cursor on line 12 of a three-thousand-line log classified three thousand
		// lines per keystroke, which is the cost
		// #410 removed and
		// #507 removed again.
		// The bound is folded from zero rather than taken as a maximum over the
		// ranges, because the maximum over nothing is not a number; seeded at zero,
		// a press with no ranges classifies nothing and writes nothing rather than
		// handing a nonsense bound down. CodeMirror does not hand this feature an
		// empty selection list, so that is a guard against a shape the editor
		// cannot produce rather than a case anyone has seen. The notice such a
		// press would show says no line had anywhere to step, which is true of the
		// no lines it looked at.
		let bound = 0;
		for (const range of ranges) bound = Math.max(bound, range.end);
		const kinds = lineKindRange(before, 0, bound);
		const written = new Map<number, string>();
		// Every line number this press has already answered for, so a line two
		// selections both cover is counted once as well as stepped once.
		const covered = new Set<number>();
		let stepped = 0;
		let landedBack = 0;

		for (const range of ranges) {
			const result = cycleLines(before, range, sequence, direction, kinds);
			for (let at = range.start; at < range.end; at += 1) {
				// A line two selections both cover is stepped once: every call above
				// reads the same `before`, so the second answer for that line is the
				// first one again rather than a second step.
				if (covered.has(at)) continue;
				covered.add(at);
				const same = result.lines[at] === before[at];
				// The comparison this loop already made is worth keeping, because it
				// is the only place that knows a line the press *could* act on came
				// back the character it started with. Working
				// it out again inside the sentence is not possible: by then the press
				// has thrown the two versions of the line away.
				if (kinds[at].kind !== "left-alone") {
					stepped += 1;
					if (same) landedBack += 1;
				}
				if (same) continue;
				written.set(at, result.lines[at]);
			}
		}

		if (written.size === 0) {
			new Notice(nothingChanged(kinds, ranges, sequence, { stepped, landedBack }));
			return;
		}

		const changes: EditorChange[] = [...written]
			.sort(([a], [b]) => a - b)
			.map(([at, text]) => ({
				from: { line: at, ch: 0 },
				to: { line: at, ch: before[at].length },
				text,
			}));

		// The transaction's selections are typed as a from-and-to, but Obsidian
		// hands each pair to the editor as an anchor-and-head in the order given —
		// measured in Obsidian 1.13.7, with and without changes, one selection and
		// several (`docs/acceptance-shots/issue-554-backwards-selection.txt`). So
		// `from` carries the person's anchor and `to` their head, and a selection
		// made backwards stays backwards. The warrant
		// is that one measurement: the API's declaration promises nothing about
		// order, `manifest.json` allows Obsidian back to 1.8.7, and the fake editor
		// in the tests stores the pair verbatim, so a version that sorted it would
		// show up on a screen and nowhere else.
		editor.transaction({
			changes,
			selections: selections.map((selection) => {
				const { anchor, head } = keptWhereItWas(selection, before, written);
				return { from: anchor, to: head };
			}),
		});
	}

	/** The stored sequence with this id, or `null` if it has since gone. */
	private sequenceWith(sequenceId: string): Sequence | null {
		for (const sequence of this.stored()) {
			if (sequence.id === sequenceId) return sequence;
		}
		return null;
	}
}

/**
 * The note as an array of lines, read through the editor's own line numbers.
 *
 * Asked line by line rather than split out of `getValue()`, so that a line's
 * index and a position's `ch` mean here exactly what they mean to the editor
 * this press is about to write back into — which is what makes the transaction
 * land on the line it was decided from.
 *
 * It does not spare this half a decision about line endings. A carriage return
 * arrives through `getLine` regardless, and `cycleLines.ts` is what splits it
 * off and restores it.
 */
function readLines(editor: CyclingEditor): string[] {
	const lines: string[] = [];
	const count = editor.lineCount();
	for (let at = 0; at < count; at += 1) lines.push(editor.getLine(at));
	return lines;
}

/**
 * What one press's step did to the lines it was allowed to act on.
 *
 * Two counts rather than a flag, because the sentence has to tell two different
 * answers apart: a press that worked out a step for every line it covered and
 * got each line back unchanged, and a press that never had a line to step at
 * all. A flag saying
 * "nothing moved" cannot separate them, and they are not the same news.
 *
 * Both counts are measurements the press made and not conclusions it drew, so
 * neither can be wrong about a press it did not foresee. At the one place the
 * sentence is asked — when nothing was written — every stepped line came back
 * the same, so `landedBack` always equals `stepped` there; it is kept as the
 * measurement the rule reads off rather than folded into a flag the loop would
 * have to decide early. A line the press was
 * not allowed to touch is in neither count: `kinds` already says why that line
 * was left alone, and saying it twice is the kind of second copy that drifts.
 */
interface StepOutcome {
	/** How many lines the press worked out a step for. */
	readonly stepped: number;
	/** How many of those came back holding the character they started with. */
	readonly landedBack: number;
}

/**
 * One sentence saying why a press changed nothing — one per press, never one
 * per line it passed over (spec decision 3).
 *
 * `kinds` is the same set the press itself decided from, indexed by line number
 * and reaching as far down the note as the lowest of these ranges — which is why
 * slicing it at each range's own positions answers for that range. It used to be
 * worked out again here, which meant a press that changed nothing read the note
 * twice. Reusing it is
 * also the only way this sentence is certain to name the reason the press
 * actually acted on: two readings of one note agree today, and a sentence built
 * from a second reading would be a second chance to disagree.
 *
 * `outcome` is the same argument in a second form: what the press's own step did
 * to the lines it was allowed to act on, measured by the press rather than
 * guessed at here.
 */
function nothingChanged(
	kinds: readonly LineKind[],
	ranges: readonly LineRange[],
	sequence: Sequence,
	outcome: StepOutcome,
): string {
	// The rule here is readiness's rule, and it has to be the same rule: a sequence
	// can move a checkbox exactly when it holds two symbols **that differ**. Asking for two
	// symbols alone left a gap the person read the wrong answer out of — a sequence
	// of `x` and `x` skipped this sentence, found nothing else to blame, and said
	// "none of those lines had anywhere to step". The line had somewhere to step;
	// the sequence did not.
	// **The word is *sequence*, not *cycle*.** A sequence is the named list of
	// symbols; *cycle* is the act, and it is already spent on the two command names
	// `<Sequence name>: cycle forward` and `… backward`. `GLOSSARY.md` says
	// so under *Sequence*,
	// and the vocabulary sweep in `manifest.test.ts` deliberately cannot catch this
	// one — retiring *cycle* would condemn those two command names — so it is up to
	// whoever writes the sentence.
	if (new Set(sequence.symbols).size < 2) {
		return "Effortless: nothing changed — that sequence holds fewer than two different symbols, so a press has nowhere to step.";
	}

	const reasons: string[] = [];
	for (const range of ranges) {
		for (const kind of kinds.slice(range.start, range.end)) {
			if (kind.kind !== "left-alone") continue;
			const said = LEFT_ALONE_SENTENCES[kind.reason];
			if (reasons.indexOf(said) < 0) reasons.push(said);
		}
	}
	if (reasons.length === 0) {
		// Left-alone reasons come first and this sentence never displaces one. Where
		// a press covered a mix — a fenced line and a line that came back on itself
		// — the fenced line is the one the person can do something about, so that is
		// what they are told.
		//
		// **The sentence is about the press, not the line and not the sequence.** The
		// sequence holds two symbols that differ, so it can move a checkbox; the line
		// is an ordinary task, so it could be stepped. What happened is that the step
		// came round the sequence and back to the character the line already had —
		// `["a", "b", "a"]` pressed backward from `a` finds the first `a`, steps back,
		// wraps to the last position, and that position holds `a` too. Saying "none of
		// those lines had anywhere to step" blames the line for the press's own path.
		//
		// It replaces that fallback only when the press worked out a step for at least
		// one line and every line it stepped came back unchanged. A press that stepped
		// nothing — no selection at all, so no line to step — keeps the fallback, which
		// is true of the no lines it looked at.
		if (outcome.stepped > 0 && outcome.landedBack === outcome.stepped) {
			return "Effortless: nothing changed — that press landed back on the character each line already had.";
		}
		return "Effortless: nothing changed — none of those lines had anywhere to step.";
	}
	return `Effortless: nothing changed — ${reasons.join("; ")}.`;
}

/**
 * What each left-alone line is called when the person is told about it.
 *
 * `lineKind.ts` answers in codes on purpose, because the words belong to
 * whatever puts them on screen. This is that place, and it is the only one.
 */
const LEFT_ALONE_SENTENCES: Record<LeftAloneReason, string> = {
	fenced: "a line inside a code fence is left alone",
	frontmatter: "a line in the note's frontmatter is left alone",
	"table-row": "a table row is left alone",
	heading: "a heading is left alone",
	blockquote: "a quoted line is left alone",
	"numbered-item": "a numbered item is left alone",
	"thematic-break": "a horizontal rule is left alone",
	"setext-underline": "the line that underlines a heading is left alone",
	"unspaced-bracket": "a list item whose brackets have no space after them is left alone",
};
