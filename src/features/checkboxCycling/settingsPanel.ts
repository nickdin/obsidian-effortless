/**
 * The feature's own settings body: the list of sequences, adding, renaming and
 * removing one, and the symbols inside each one.
 *
 * **The core draws the card and the on/off switch; this file draws neither.**
 * `src/core/settingsTab.ts` makes one card per feature, puts the switch on its
 * closed row, and hands the feature an empty `div` inside it. Everything below
 * goes into that `div` and nothing above it is this feature's business.
 *
 * **Nothing here is dragged.** Not one handler, and that is the reason this
 * panel is written rather than ported: the plugin it replaces orders its
 * symbols by dragging them, HTML5 drag does not fire from a touch screen, and
 * somebody whose only device is a phone could therefore install that plugin and
 * never configure it.
 * Its panel is 622 lines and about half of them are the dragging machinery,
 * which is the half that does not come across. A test reads this folder's source
 * and says so.
 *
 * **It saves through the feature's own settings handle and calls `saveData`
 * nowhere.** Five plugins are merging under one Obsidian manifest id and
 * Obsidian gives a plugin one `data.json`, so `src/core/settings.ts` is the one
 * writer of that file. The plugin this feature replaces writes the whole file
 * with only its own settings in it; carried across unchanged, the first feature
 * to save would erase every other feature's.
 *
 * A file of its own rather than more of `checkboxCycling.ts`, for the reason
 * `calendarSourcesSection.ts` is one: the screen has its own rules — what a row
 * says about a sequence that cannot cycle, what happens when the name is emptied
 * — and the class that turns a keypress into an edit should not grow a second
 * job.
 */

import { Setting } from "obsidian";
import type { SettingsChanged } from "../../core/feature";
import { announceFailedSave, createSaveFailureAnnouncer } from "../../core/saveFailureAnnouncer";
import type { SaveFailureAnnouncer } from "../../core/saveFailureAnnouncer";
import { protectWhileFocused } from "../../core/settingsTab";
import type { CheckboxMeaning } from "../../core/taskLine";
import {
	FIXED_SYMBOLS,
	checkboxMeaning,
	createSequence,
	repeatedSymbol,
	symbolRefusal,
} from "./sequences";
import type { Sequence } from "./types";

/**
 * What this panel needs from the feature, and the whole of it.
 *
 * Two methods rather than the feature itself, so the panel can be drawn in a
 * test against a plain object and so that nothing here can reach the palette,
 * the editor or the settings file directly. `CheckboxCycling` already has both
 * and is handed in as itself.
 */
export interface SequenceStore {
	/** The stored sequences, with anything that is not one already refused. */
	sequences(): readonly Sequence[];
	/** Stores a new list now and brings the palette into line with it. One press, one write. */
	saveSequences(next: readonly Sequence[]): Promise<void>;
	/**
	 * Stores a new list once the typing has stopped, and brings the palette into
	 * line when that write has answered, landed or failed. For the name box, which changes once per
	 * character; every call in one run of typing is answered by the same promise.
	 */
	saveSequencesSoon(next: readonly Sequence[]): Promise<void>;
	/**
	 * Whether the seventeen characters outside #294's five get Effortless's own
	 * look too — the judged value, not the raw stored one. A stored value that
	 * is not a boolean is refused and this answers the shipped default instead
	 * (`checkboxCycling.ts:521-524`, `usableSymbolLook`).
	 *
	 * Added for #752: the
	 * switch that ticket's plan left to the implementer, because Effortless's
	 * rule for those seventeen is heavy enough to beat a theme that already
	 * draws them (Minimal), and this is what a person on such a theme turns
	 * off.
	 */
	symbolLook(): boolean;
	/** Stores it and brings the switch's effect into line. One press, one write. */
	saveSymbolLook(value: boolean): Promise<void>;
}

/** What a fresh sequence is called until the person types something else. */
const NEW_SEQUENCE_NAME = "New sequence";

/**
 * The fixed names of the rows this card draws, for Obsidian's settings search. A sequence's own name is typed into its Name box, not drawn as a row's name. `settingsSearchAliases.test.ts`
 * holds the list to what the card draws.
 */
export const CHECKBOX_CYCLING_SETTING_NAMES: readonly string[] = ["Sequences", "Look for symbols outside the five", "Name", "Add a symbol", "Add a sequence"];

/**
 * Draws the body into `parent`, and draws it again by itself whenever the list
 * changes shape — a sequence added or removed.
 *
 * **A rename does not redraw**, and that is deliberate: redrawing would replace
 * the box being typed in and take the caret out of it, which is the failure
 * `calendarSourcesSection.ts` records as issue #108. The cost is that the
 * `Sequence` a row was drawn from is a snapshot: after a rename its `name` is
 * the old one. Only one sentence on the row is built from the name — the refusal
 * a blank box draws — and it reads the stored name through `storedName()` rather
 * than from that snapshot, because it printed a name the sequence no longer had. Anything else added
 * here that names the sequence has to do the same.
 *
 * **`changed` is how this panel reaches the card around it**, and the only way
 * it can. The badge, the closed row's sentence and the "N of M features running"
 * count are drawn by the core from what the feature's readiness answers, so
 * every edit here that changes that answer — a sequence removed, one added, any
 * symbol edit — reports through it after the save. Drawn without one,
 * the panel behaves exactly as it did before the hook existed.
 */
export function renderCheckboxCyclingSettings(
	parent: HTMLElement,
	store: SequenceStore,
	changed?: SettingsChanged,
	announceDeferredSaveFailure?: SaveFailureAnnouncer,
): void {
	const panel = parent.createDiv({ cls: "effortless-cycling-sequences" });

	/** Stores a list now, saying out loud if the write failed. Answers whether it was stored. */
	const save = async (next: readonly Sequence[]): Promise<boolean> => {
		try {
			await store.saveSequences(next);
			return true;
		} catch (error) {
			// Obsidian's own handlers have nowhere to put a rejected promise, so a
			// failed write is announced here or nowhere: the box would go on showing
			// what was typed and the next reload would quietly drop it.
			announceFailedSave(error);
			return false;
		}
	};

	/**
	 * Says a failed deferred write out loud, once for the run of typing that
	 * asked for it rather than once per character that joined it.
	 *
	 * **The screen's announcer, not one of this panel's own.** A run of
	 * keystrokes is one write, and that write's promise is the run's name
	 * (`saveFailureAnnouncer.ts`, #186). The store answers every deferred caller
	 * inside the window with that one promise whichever route it came by, so a
	 * run that crosses a core card box and this panel's name box is the core
	 * card's run as well — and while this panel built its own announcer, one
	 * failed write was told twice. So the settings
	 * screen hands its one announcer down, beside `changed`.
	 *
	 * Drawn with none — a test, or anything drawing this panel outside the
	 * settings tab — the panel builds its own, and a failed run is still told
	 * exactly once, because every deferred write this panel asks for comes
	 * through {@link saveSoon} below.
	 */
	const announceDeferredFailure = announceDeferredSaveFailure ?? createSaveFailureAnnouncer();

	/**
	 * Stores a list once the typing has stopped, saying out loud if the write
	 * failed. For the name box alone: the other edits here are presses, and a
	 * press is one write already.
	 */
	const saveSoon = async (next: readonly Sequence[]): Promise<void> => {
		const run = store.saveSequencesSoon(next);
		try {
			await run;
		} catch (error) {
			announceDeferredFailure(run, error);
		}
	};

	/**
	 * Says that the stored list has changed, so the screen around this panel is
	 * drawn again.
	 *
	 * **Only after a save that actually happened**, because asking for the badge
	 * and the count to be rebuilt on a save that did not happen would be
	 * reporting a change nobody made.
	 *
	 * **After a failed press the store already reads what the file holds.** It
	 * writes this feature's slice into memory before it writes the file, and when
	 * that write rejects with no other write queued or waiting it puts memory
	 * back before the rejection reaches `save` above
	 * (`SettingsStore.queueWrite`,
	 * #558). So the panel's
	 * own `draw()` below, which runs either way, draws the list `data.json`
	 * holds, and the badge and the count are left as they were, which is right.
	 *
	 * **A restore this panel's own write did not set off is not this panel's to
	 * follow.** A press refused while a name waits on the typing timer keeps its
	 * change, and the timer's own refusal later puts memory back past it; the
	 * store tells the settings screen, which draws this panel again from the
	 * store. Drawn outside
	 * that screen, nothing redraws the panel then.
	 *
	 * Called after the panel has drawn its own body, not instead of it: a caller
	 * that owns no screen — a test, and anything drawing this panel outside the
	 * settings tab — passes nothing, and then this panel's own redraw is the
	 * whole of what happens, exactly as it was before the hook existed.
	 */
	const report = (): void => changed?.();

	const draw = (): void => {
		panel.empty();

		new Setting(panel)
			.setName("Sequences")
			.setDesc(
				"Each sequence gets two commands of its own, forward and backward, " +
					"so you can give it a hotkey. Renaming one keeps its hotkey.",
			)
			.setHeading();

		panel.createDiv({ cls: "effortless-cycling-legend", text: FIXED_MEANINGS_LINE });

		// #752. A look only, never a meaning — the sentence above already says
		// what the five mean, and this changes nothing there or anywhere else a
		// symbol is read; it only says whether these seventeen more look like
		// themselves instead of a plain box.
		new Setting(panel)
			.setName("Look for symbols outside the five")
			.setDesc(
				'Colours the widely used extra symbols too — ? i I " * k b among them, and the ' +
					"rest of the Minimal theme's own alternate checkboxes — so they read apart " +
					"from a plain open box and from each other. Turn this off if your own theme " +
					"already draws them: Effortless's look would otherwise beat it.",
			)
			.addToggle((toggle) =>
				toggle.setValue(store.symbolLook()).onChange(async (value) => {
					try {
						await store.saveSymbolLook(value);
					} catch (error) {
						// The same reason every other write on this card is wrapped
						// (`save` above, `saveSoon`): Obsidian's own handler has nowhere
						// to put a rejected promise. The store has already put memory
						// back by the time this runs, so the toggle is set to what it
						// now reads rather than to the value the refused write tried.
						announceFailedSave(error);
						toggle.setValue(store.symbolLook());
					}
				}),
			);

		for (const sequence of store.sequences()) {
			drawSequence(panel, sequence, {
				// A rename deliberately reports nothing. It is the one edit here
				// that readiness never reads — a sequence can step or not step
				// whatever it is called — so there is nothing above the card for a
				// redraw to correct, and the redraw would replace the box being
				// typed in and take the caret out of it, which is #108's failure.
				//
				// And it is the one edit here that is typing rather than a press, so
				// it is the one that defers its write: the stored name changes on
				// the keystroke and the file is written once the typing has stopped.
				rename: async (name) => {
					await saveSoon(
						store
							.sequences()
							.map((other) => (other.id === sequence.id ? { ...other, name } : other)),
					);
				},
				remove: async () => {
					const stored = await save(
						store.sequences().filter((other) => other.id !== sequence.id),
					);
					draw();
					// Removing the last usable sequence makes the feature
					// unconfigured, and the badge, the line and the count that say so
					// are the core's.
					if (stored) report();
				},
				storedName: () =>
					store.sequences().find((other) => other.id === sequence.id)?.name ?? sequence.name,
				storedSymbols: () =>
					store.sequences().find((other) => other.id === sequence.id)?.symbols ??
					sequence.symbols,
				setSymbols: async (symbols) => {
					const stored = await save(
						store
							.sequences()
							.map((other) => (other.id === sequence.id ? { ...other, symbols } : other)),
					);
					draw();
					// Every symbol edit arrives here — added, removed, moved — and
					// taking the second symbol off the last usable sequence is enough
					// to make the feature unconfigured.
					if (stored) report();
				},
			});
		}

		new Setting(panel)
			.setName("Add a sequence")
			.setDesc("A new one starts with no symbols, so give it two before it can do anything.")
			.addButton((button) =>
				button
					.setButtonText("Add")
					.setCta()
					.onClick(async () => {
						const existing = store.sequences();
						const stored = await save([
							...existing,
							createSequence(NEW_SEQUENCE_NAME, [], existing),
						]);
						draw();
						// A fresh sequence has no symbols, so a feature that had none
						// at all is still not configured — the count above must not
						// go up on the strength of it.
						if (stored) report();
					}),
			);
	};

	draw();
}

/** What one sequence's block can do to the list it sits in. */
interface SequenceActions {
	/**
	 * Stores a new name for this sequence and leaves the screen as it is.
	 *
	 * Called once per character typed, so what it does is store the name at once
	 * and write the file once the typing has stopped.
	 */
	rename(name: string): Promise<void>;
	/** Takes this sequence out of the list, then draws the list again. */
	remove(): Promise<void>;
	/**
	 * What this sequence is called in storage right now.
	 *
	 * Asked rather than remembered, because a rename does not redraw the row: the
	 * `Sequence` the row was drawn from still carries the name it had when the
	 * panel was last drawn.
	 */
	storedName(): string;
	/**
	 * The symbols this sequence holds in storage right now.
	 *
	 * Asked at the moment of the press rather than read off the row, for
	 * {@link SequenceActions.storedName}'s reason: the row was drawn from a
	 * snapshot, and a save may have moved the list on since.
	 *
	 * **Asking is not on its own what makes two quick presses safe**, and this
	 * said for a while that it was. The row's position is stale at the same
	 * moment as its list, and a stale position applied to a fresh list is worse
	 * than two stale halves: it moved a symbol back where it started, took the
	 * symbol next to the one that was pressed, and stored `undefined` where the
	 * position had gone altogether. What makes the
	 * pair safe is {@link sameSymbols}, which every symbol press asks before it
	 * applies its position.
	 */
	storedSymbols(): readonly string[];
	/**
	 * Stores a new list of symbols for this sequence, then draws the list again.
	 *
	 * Redrawing is right here where it is wrong for a rename: every symbol edit is
	 * a button press rather than typing, so there is no caret to take out of a box, and the rows, the arrows that are disabled and the line underneath
	 * all have to change together.
	 */
	setSymbols(symbols: readonly string[]): Promise<void>;
}

/**
 * One sequence: its name, a button to remove it, and the line saying what it
 * can and cannot do.
 *
 * Boxed, for the reason a calendar's rows are boxed: two sequences drawn with
 * nothing between them are two identical rows and the person has to count to
 * find where one ends.
 */
function drawSequence(panel: HTMLElement, sequence: Sequence, actions: SequenceActions): void {
	const block = panel.createDiv({ cls: "effortless-cycling-sequence" });

	// Written before the row, so the refusal below can be filled in from the
	// row's own handler without looking anything up.
	const refusal = block.createDiv({ cls: "effortless-cycling-sequence-refusal" });

	new Setting(block)
		.setName("Name")
		.setDesc("What this sequence is called here and in the command palette.")
		.addText((text) =>
			text
				.setPlaceholder(NEW_SEQUENCE_NAME)
				.setValue(sequence.name)
				.onChange((value) => {
					// **An emptied box is not stored**, and the refusal says so where
					// the person is typing. A sequence whose stored name is blank is
					// not a sequence at all — `usableSequences` refuses it, so it would
					// lose its two commands and vanish from this list the next time
					// anything read the stored value, in the middle of a rename. The
					// box keeps whatever was typed; only the stored name waits.
					const named = value.trim();
					if (named === "") {
						refusal.setText(
							`A sequence needs a name, so this one is still called ${quoted(actions.storedName())}.`,
						);
						return;
					}
					refusal.setText("");
					void actions.rename(named);
				}),
		)
		.addButton((button) =>
			button
				.setButtonText("Remove")
				.setDestructive()
				.setTooltip("Remove this sequence")
				.onClick(() => actions.remove()),
		);

	drawSymbols(block, sequence.symbols, actions);
	drawSymbolAdding(block, actions);

	block.createDiv({
		cls: "effortless-cycling-sequence-summary",
		text: sequenceSummary(sequence),
	});
}

/**
 * The line under a sequence: what it holds, and why a press would do nothing
 * where that is the case.
 *
 * A pure function of the sequence, so the sentence a person reads can be
 * checked on a literal rather than by drawing the screen.
 *
 * **The three ways a sequence cannot cycle are three different sentences**,
 * because the remedy differs: nothing typed yet, one symbol typed, or the same
 * symbol typed over and over. The third is not an oddity — `sequencesReadiness`
 * asks for two *different* symbols, so a sequence of `["x", "x"]` reports the
 * feature *not configured* rather than reporting it ready and then doing nothing.
 *
 * **The fourth sentence is the one #425 was settled for.** A sequence may hold
 * the same symbol twice and still hold two different ones, in which case it
 * cycles — but the order as typed folds back at the repeat, and everything after
 * it is never walked. #425 settled that such a sequence is stored and explained
 * here, rather than the repeat being refused while the person is still typing.
 * The fact is `repeatedSymbol`'s; only the words are this file's.
 */
export function sequenceSummary(sequence: Sequence): string {
	const symbols = sequence.symbols;

	if (symbols.length === 0) {
		return "No symbols yet, so this sequence cannot cycle. Give it two that differ.";
	}
	if (symbols.length === 1) {
		return `Only ${quoted(symbols[0])}, so this sequence cannot cycle. Give it a second symbol that is not ${quoted(symbols[0])}.`;
	}
	if (new Set(symbols).size === 1) {
		return `Every symbol here is ${quoted(symbols[0])}, so this sequence cannot cycle: a press would write the character that is already there. Give it one that is not ${quoted(symbols[0])}.`;
	}

	const held = `${symbols.length} symbols: ${symbols.map(quoted).join(", ")}.`;
	const repeat = repeatedSymbol(sequence);
	if (repeat === null) return held;
	return `${held} ${quoted(repeat.symbol)} appears twice, at ${repeat.firstAt + 1} and again at ${repeat.repeatedAt + 1}. A press reads both as ${repeat.firstAt + 1}, so nothing from ${repeat.repeatedAt + 1} onwards is ever reached.`;
}

/**
 * The five characters the plugin fixes a meaning to, in the words a person
 * reads rather than the words the code uses.
 *
 * `checkboxMeaning` answers `"copied"`; nobody would know what that meant on a
 * settings screen, so the sentence for each meaning is written here. Which
 * character carries which meaning is not — that is the core's, asked afresh
 * every time a row is drawn.
 */
const MEANING_WORDS: Readonly<Record<CheckboxMeaning, string>> = {
	open: "open",
	copied: "copied to the day's log",
	done: "done",
	cancelled: "cancelled",
	forwarded: "forwarded",
};

/**
 * The one sentence the card says about what a symbol may be, drawn once under
 * the heading rather than on every sequence.
 *
 * Both halves are decisions rather than description. **The five meanings are
 * not editable, here or anywhere**, because a mapping nobody ever changes is
 * still a mapping that can be changed by accident, and changing it silently
 * unpairs a task from the copy of it in the day's log. **Every other character
 * is kept exactly as typed**, which is what lets a sequence hold the letters
 * this vault already uses without the plugin claiming to know what they mean.
 */
const FIXED_MEANINGS_LINE =
	"Five characters have a meaning this plugin fixes, and none of the five can be changed, " +
	"here or anywhere. Any other character is an ordinary open task whose symbol is left alone.";

/**
 * One row per symbol, each carrying an up arrow, a down arrow and a remove
 * control.
 *
 * **Arrows rather than a drag handle**, and that is the whole reason this panel
 * is written rather than ported: HTML5 drag never fires from a touch screen, so
 * a dragged list is somebody whose only device is a phone able to install the
 * feature and never order its symbols. Three buttons a
 * finger can hit cost about thirty lines; the machinery they replace is half of
 * the old plugin's 622-line panel.
 *
 * The position is written on the row because the line underneath counts in
 * positions — *nothing from 3 onwards is ever reached* — and a person otherwise
 * has to count the rows themselves to find which one it means.
 */
function drawSymbols(
	block: HTMLElement,
	symbols: readonly string[],
	actions: SequenceActions,
): void {
	const list = block.createDiv({ cls: "effortless-cycling-symbols" });

	for (let at = 0; at < symbols.length; at += 1) {
		const row = list.createDiv({ cls: "effortless-cycling-symbol" });
		row.createSpan({ cls: "effortless-cycling-symbol-label", text: symbolLabel(symbols, at) });

		drawMove(row, symbols, at, -1, actions);
		drawMove(row, symbols, at, 1, actions);

		const remove = row.createEl("button", {
			cls: "effortless-cycling-symbol-button",
			text: "\u2715",
			title: `Remove ${quoted(symbols[at])}`,
			attr: { "aria-label": `Remove ${quoted(symbols[at])}` },
		});
		remove.onClickEvent(() => {
			// Taking the last symbol away is allowed and is not an error: the
			// sequence is then one that cannot cycle, and the line underneath says
			// so and says what to add. Refusing it instead would leave somebody
			// unable to empty a sequence they wanted to start again.
			const held = actions.storedSymbols();
			if (!sameSymbols(symbols, held)) return;
			void actions.setSymbols([...held.slice(0, at), ...held.slice(at + 1)]);
		});
	}
}

/**
 * One arrow: up when `step` is -1, down when it is 1.
 *
 * **The arrow at the end of the list is disabled rather than wrapping.** A
 * wrapping arrow moves the first symbol to the bottom, which is a place nobody
 * pressing *up* was aiming for, and it does it without saying anything. The
 * refusal is written twice on purpose — the button carries `disabled`, so a
 * finger and a screen reader both meet it, and the handler checks the position
 * again, so a press that reaches it anyway stores nothing.
 */
function drawMove(
	row: HTMLElement,
	symbols: readonly string[],
	at: number,
	step: -1 | 1,
	actions: SequenceActions,
): void {
	const to = at + step;
	const what = step === -1 ? "Move up" : "Move down";
	const button = row.createEl("button", {
		cls: "effortless-cycling-symbol-button",
		text: step === -1 ? "\u25B2" : "\u25BC",
		title: `${what}: ${quoted(symbols[at])}`,
		attr: { "aria-label": `${what}: ${quoted(symbols[at])}` },
	});
	button.disabled = to < 0 || to >= symbols.length;

	button.onClickEvent(() => {
		const held = actions.storedSymbols();
		if (!sameSymbols(symbols, held)) return;
		if (to < 0 || to >= held.length) return;
		const next = [...held];
		const [moving] = next.splice(at, 1);
		next.splice(to, 0, moving);
		void actions.setSymbols(next);
	});
}

/**
 * Whether the list a symbol row was drawn from is still the list in storage.
 *
 * Every symbol control carries the position it was drawn at and applies that
 * position to the stored list at the moment of the press. The two agree until a
 * press lands between an earlier save and the redraw that follows it: the save
 * is a real write to `data.json`, so for that moment the rows on screen still
 * count the old list. Three things came of applying a position anyway — two
 * quick presses on an arrow moved a symbol back where it started, a remove took
 * the symbol beside the one that was pressed, and an arrow on a row a remove had
 * just taken away spliced nothing out and stored `undefined` as a symbol, which
 * `isSymbolList` refuses, so the whole sequence left the screen and lost its two
 * commands.
 *
 * **A press that cannot be applied does nothing and stores nothing**, which is
 * the same shape as the arrow at the end of the list: the handler checks again
 * and declines. It says nothing out loud, and that is not a swallowed failure —
 * the redraw from the press that did land is already on its way and shows what
 * happened, so the only news a sentence could carry is that a finger was faster
 * than a disk write.
 *
 * The sequence-level controls beside these need none of this, because they act
 * on `sequence.id` — a name that does not shift when the list changes.
 */
function sameSymbols(drawn: readonly string[], held: readonly string[]): boolean {
	return drawn.length === held.length && drawn.every((symbol, at) => symbol === held[at]);
}

/**
 * The field that adds a symbol, and the five the plugin gives a meaning to
 * offered beside it.
 *
 * **The refusal sits above the field rather than below it**, for the reason the
 * blank-name refusal does: a sentence that appears underneath pushes everything
 * after it down the screen at the moment the person is reading it.
 *
 * **A character is judged as it is typed and again when Add is pressed.** The
 * first is what makes the field the only place a person can be told *why* `"]"`
 * is refused. The second is not a repetition: an empty box says nothing while
 * it is empty, because a refusal that appears before anything has been typed
 * reads as a fault rather than as a wait, and pressing Add on it has to say
 * something.
 *
 * **Whether a character is refused is not decided here.** `symbolRefusal` asks
 * the core's own reader and only chooses the sentence, so this screen refuses
 * exactly what the core's writer would refuse — a tab included, which the core
 * accepts and can write back.
 */
function drawSymbolAdding(block: HTMLElement, actions: SequenceActions): void {
	const refusal = block.createDiv({ cls: "effortless-cycling-symbol-refusal" });
	let typed = "";

	// A named row rather than the usual chained expression, so the `addText`
	// callback below can reach `controlEl` — see the comment inside it.
	const field = new Setting(block)
		.setName("Add a symbol")
		.setDesc("One character, written between the brackets of the task line.");
	field.addText((text) => {
		// **The field carries no length of its own.** `maxlength` is counted in
		// UTF-16 units and the core counts code points, so a cap of 1 let "å"
		// through and refused an emoji outright — a character `mayBeCheckbox`
		// accepts, `parseTaskLine` reads back and `editTaskField` writes. It
		// refused it in silence, too, because a character the browser never
		// admits is one `symbolRefusal` is never asked about. One
		// character is still all a checkbox holds; anything longer is refused
		// below with a sentence naming it, the way "]" and a line break are.
		text.setPlaceholder("x").onChange((value) => {
			typed = value;
			refusal.setText(value === "" ? "" : (symbolRefusal(value) ?? ""));
		});

		// Obsidian's own `Setting.addText` already puts `text.inputEl` inside
		// `controlEl` before this callback runs; appended again here only
		// because the test double does not attach it at all, and the row's
		// protection below hears the box's focus only while the box sits inside
		// the row. Appending a node that is already the sole child of the same
		// parent moves nothing. `addButton` below is the only other component this row
		// gets, and it is not called until this whole callback has returned —
		// so nothing is ever in `controlEl` for this append to displace.
		field.controlEl.appendChild(text.inputEl);
	});
	field.addButton((button) =>
		button
			.setButtonText("Add")
			.setCta()
			.onClick(async () => {
				const said = symbolRefusal(typed);
				if (said !== null) {
					refusal.setText(said);
					return;
				}
				refusal.setText("");
				await actions.setSymbols([...actions.storedSymbols(), typed]);
			}),
	);

	// **The row is protected for as long as focus is anywhere on it**, so a
	// redraw the settings screen runs for a store restore that has nothing to
	// do with this field leaves it alone rather than resetting `typed` above
	// to `""` and taking the caret with it. This field never writes to the
	// store until Add is pressed, so it starts no write for the store to hold —
	// the protection every other box on this screen gets from a write of its
	// own waiting never reaches it.
	//
	// The row rather than the box, because Add is the only way to commit what
	// was typed and moving to it is not leaving: protected on the box alone,
	// the redraw ran as focus went to Add and took the press with it.
	// `EffortlessSettingTab.redrawAfterRestore` is what reads the mark.
	protectWhileFocused(field.settingEl);

	const fixed = block.createDiv({ cls: "effortless-cycling-fixed" });
	fixed.createSpan({
		cls: "effortless-cycling-fixed-line",
		text: "Or one of the five with a fixed meaning:",
	});
	for (const symbol of FIXED_SYMBOLS) {
		const meaning = MEANING_WORDS[checkboxMeaning(symbol)];
		const button = fixed.createEl("button", {
			cls: "effortless-cycling-fixed-button",
			text: `${quoted(symbol)} \u2014 ${meaning}`,
			title: `Add ${quoted(symbol)} to this sequence`,
			attr: { "aria-label": `Add ${quoted(symbol)}, ${meaning}, to this sequence` },
		});
		// One press adds it. Filling the field instead would be a second press for
		// no gain, and the field is still there for every other character.
		button.onClickEvent(() => {
			void actions.setSymbols([...actions.storedSymbols(), symbol]);
		});
	}
}

/**
 * One symbol row's label: where it sits, what it is, and what it means where the
 * plugin fixes a meaning to it.
 *
 * The meaning is left off every other character rather than written out as
 * *open*, because the card already says once that any other character is an
 * ordinary open task; repeating it on every row would make five fixed meanings
 * look like a property every symbol carries.
 */
function symbolLabel(symbols: readonly string[], at: number): string {
	const symbol = symbols[at];
	const said = `${at + 1}. ${quoted(symbol)}`;
	if (!FIXED_SYMBOLS.includes(symbol)) return said;
	return `${said} \u2014 ${MEANING_WORDS[checkboxMeaning(symbol)]}`;
}

/**
 * A symbol as it is shown in a sentence, quoted.
 *
 * Quoted rather than bare because four of the five characters the plugin gives a
 * meaning to are punctuation and one of them is a space, and a space written
 * bare into a sentence is a sentence with a hole in it.
 */
function quoted(symbol: string): string {
	return JSON.stringify(symbol);
}
