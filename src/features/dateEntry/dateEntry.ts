/**
 * The feature itself, and the popup that connects the editor to the two pure
 * functions behind it.
 *
 * **Every decision was made before this file.** Whether the popup opens, where
 * the trigger sits, which kind of date was asked for and what the one
 * suggestion is are all `suggest`'s answer (`./suggest.ts`); what the line
 * becomes once a suggestion is accepted, and where the cursor lands, are all
 * `stamp`'s (`./stamp.ts`). This half reads the line, asks them, and writes the
 * answer back in one `editor.transaction` so that one undo puts the line back
 * exactly as it was (spec
 * #573 decisions 4, 5 and
 * 8).
 *
 * **It never leaves the editor.** No `Vault`, no note writer, no command, no
 * event handler and no view — its one registration is an editor suggester. It references no
 * other feature and knows of none.
 *
 * **It holds no copy of the task-line format and no emoji of its own.** The
 * stamp's text, and so the emoji the popup draws, come from the core's one
 * export, `dateStampText` in `src/core/taskLine.ts`.
 *
 * **It saves through its own settings handle and never calls `saveData`.** Five
 * plugins are merging under one Obsidian manifest id and Obsidian gives a
 * plugin one `data.json`; `src/core/settings.ts` is the only writer of it.
 */

import { EditorSuggest, Notice } from "obsidian";
import type {
	App,
	EditorPosition,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	TFile,
} from "obsidian";
import { Feature } from "../../core/feature";
import type { DismissibleSuggester, Readiness, SettingsChanged } from "../../core/feature";
import { formatField } from "../../core/datePattern";
import { dateStampText } from "../../core/taskLine";
import type { DateStampKind } from "../../core/taskLine";
import { dismissalFor, recheckDismissal } from "./dismissal";
import type { DismissedTrigger, NearbyLine } from "./dismissal";
import { DATE_ENTRY_SETTING_NAMES, renderDateEntrySettings } from "./settingsPanel";
import type { RepeatRow } from "./repeatRows";
import { stamp, stampRepeat } from "./stamp";
import type { StampResult } from "./stamp";
import { suggest } from "./suggest";
import {
	DEFAULT_DATE_ENTRY_SETTINGS,
	FEATURE_ID,
	usableTrigger,
} from "./types";
import type { DateAnswer, DateEntryEditor, DateEntrySettings } from "./types";

/**
 * `DateEntryEditor` plus `Editor.lineCount`
 * (`node_modules/obsidian/obsidian.d.ts:2440`, `@public` since 0.11.11), the
 * one more thing {@link nearbyLines} and {@link lineOrNull} ask of the editor:
 * telling a line that does not exist in the document from any other failure,
 * rather than trusting what `getLine` does past the end of it.
 */
interface DateEntryEditorWithLineCount extends DateEntryEditor {
	lineCount(): number;
}

/**
 * A date whose only job is to be a date, so that the core's stamp writer can be
 * asked for a kind's emoji without one being on hand.
 *
 * `dateStampText` writes the whole stamp — the emoji, one space and the date —
 * and refuses anything that is not `YYYY-MM-DD`, so asking it for the emoji
 * alone means asking for a stamp and taking the date back off the end. That is
 * the price of the emoji living in exactly one file, which is what #577
 * settled: no code under this folder writes either emoji, and the guard test
 * that says so reads these files with their comments stripped, so a comment
 * naming one — this sentence used to — does not break the rule.
 */
const EMOJI_PROBE = "2000-01-01";

/** The kind's emoji, taken from the core's stamp writer rather than copied. */
function stampEmoji(kind: DateStampKind): string {
	return dateStampText(kind, EMOJI_PROBE).slice(0, -EMOJI_PROBE.length).trim();
}

/**
 * `date` written the way a stamp holds one: local year, month and day.
 *
 * Built from the core's own field writer rather than from a second date
 * formatter here, so that what the popup shows and what `stamp` writes cannot
 * come out different. Both read the local year, month and day.
 */
function shownDate(date: Date): string {
	return `${formatField("YYYY", date)}-${formatField("MM", date)}-${formatField("DD", date)}`;
}

/** The `...` the popup draws when it has no date to offer. */
const PLACEHOLDER = "...";

/**
 * The origin CodeMirror's own autocomplete passes for an accept, so that an
 * accept does not fold into the typing that opened it, however close the two
 * land. Obsidian's `Editor.transaction(tx, origin?)`
 * (`node_modules/obsidian/obsidian.d.ts:2556`, `@public` since 0.13.0)
 * declares the parameter and says nothing more about it. What the drive
 * proves is the effect: without an origin, #611's drive found the accept
 * folding into the typing whenever Enter came inside CodeMirror's ~500 ms
 * grouping window, which an ordinary "type the date, press Enter" does; with
 * this one, the same drives restore the line with one undo
 * (`docs/acceptance-shots/issue-611-fast-undo.txt`). The mechanism is
 * inferred from CodeMirror 6's history, which is not in this repository: a
 * change joins the group before it when it carries no user event or one
 * matching `/^(input\.type|delete)($|\.)/`, so Obsidian presumably passes the
 * origin on as that event. The rule tests only the incoming change, so typing
 * within the window *after* an accept still joins the accept's group, as it
 * does after CodeMirror's own autocomplete.
 */
const ACCEPT_ORIGIN = "input.complete";

/**
 * The popup, and the whole of what it knows: how to ask, and which trigger the
 * person has dismissed.
 *
 * **The dismissal is kept here because `suggest` cannot keep it.** That
 * function reads `dismissed` as a column and compares it with the trigger it
 * found; it keeps nothing between calls, and it answers `null` for three
 * different reasons without saying which. So this class holds the recorded
 * dismissal from one keystroke to the next, and `recheckDismissal`
 * (`./dismissal.ts`) decides at each one whether it still stands — spec #573's
 * INV-1, *deleted and retyped opens again*, is that function's rule and has
 * no copy here.
 *
 * **How Obsidian's own dismissal reaches here.** Spec #573 decision 4 expects
 * Escape and a click outside to silence that one trigger, and says Obsidian
 * gives one `close()` for every kind of dismissal. That `close()` goes to the
 * suggester Obsidian was handed, and since
 * #574 that is the core's
 * own `GatedSuggester` — so the core forwards it to
 * {@link DateSuggester.onDismissed}, the hook
 * {@link DismissibleSuggester} declares. **It is not
 * called for a close this feature or the core made** — a choice, or the feature
 * being switched off — so neither silences a trigger the person never
 * dismissed.
 */
export class DateSuggester extends EditorSuggest<DateAnswer> implements DismissibleSuggester {
	/** The trigger the person dismissed, or `null` when none is recorded. */
	private dismissed: DismissedTrigger | null = null;

	/**
	 * The trigger the popup is open for, or `null` when it is not open for one.
	 *
	 * It is what {@link onDismissed} records, and it is set only where `suggest`
	 * answered with a popup — so a trigger the boundary rule declined leaves
	 * nothing here, and a dismissal after one records nothing. That is spec
	 * #573 decision 4's last sentence, held by construction rather than by a
	 * check.
	 */
	private showing: DismissedTrigger | null = null;

	/**
	 * The answer `onTrigger` worked out, handed on to `getSuggestions`.
	 *
	 * Obsidian asks the two in that order for one keystroke, so this is the one
	 * answer rather than a cache: working it out again in `getSuggestions` would
	 * read the clock a second time and could answer a different day.
	 */
	private latest: DateAnswer | null = null;

	constructor(
		app: App,
		/** The stored slice, read afresh at every keystroke so nothing needs a reload. */
		private readonly settings: () => DateEntrySettings,
	) {
		super(app);
	}

	/**
	 * Records the trigger the popup is open for, so that `suggest` keeps it
	 * closed until it is deleted or another one is typed.
	 *
	 * The core calls this for a close the person made, and for no other close.
	 * See this class's own note for the route it comes by.
	 */
	onDismissed(): void {
		if (this.showing === null) return;
		this.dismissed = this.showing;
	}

	onTrigger(
		cursor: EditorPosition,
		editor: DateEntryEditorWithLineCount,
		_file: TFile | null,
	): EditorSuggestTriggerInfo | null {
		const settings = this.settings();
		const line = editor.getLine(cursor.line);
		const lineBeforeCursor = line.slice(0, cursor.ch);
		const answer = suggest(
			lineBeforeCursor,
			settings,
			new Date(),
			this.dismissedIn(cursor, line, settings.trigger, editor),
		);

		if (answer === null) {
			this.showing = null;
			this.latest = null;
			return null;
		}

		this.showing = dismissalFor(cursor.line, line, answer.triggerAt);
		this.latest = answer;
		return {
			start: { line: cursor.line, ch: answer.triggerAt },
			end: cursor,
			query: lineBeforeCursor.slice(answer.triggerAt + settings.trigger.length),
		};
	}

	/**
	 * The answer `onTrigger` has just worked out: one row for a date, the
	 * placeholder included. For a repeat rule one row per rule, each the same
	 * answer holding that one rule alone, so the row Obsidian hands back to
	 * {@link DateSuggester.selectSuggestion} says which rule was chosen.
	 */
	getSuggestions(_context: EditorSuggestContext): DateAnswer[] {
		const latest = this.latest;
		if (latest === null) return [];
		if (!("rules" in latest)) return [latest];
		return latest.rules.map((rule) => ({ ...latest, rules: [rule] }));
	}

	/**
	 * The kind's emoji, the phrase and the date, each in an element of its own:
	 * `⏳ tomorrow · 2026-09-04`.
	 *
	 * The placeholder draws `...` instead, with the emoji beside it only where
	 * a prefix word was typed — which is the whole of what `showEmoji` is for,
	 * since both placeholders carry the same kind.
	 */
	renderSuggestion(value: DateAnswer, el: HTMLElement): void {
		el.addClass("effortless-date-entry");
		if ("rules" in value) {
			// The rule's phrase, and beside it, quieter, the exact text it writes:
			// the same two elements a date row draws, in the same order.
			for (const rule of value.rules) {
				el.createSpan({ cls: "effortless-date-entry-phrase", text: rule.phrase });
				el.createSpan({ cls: "effortless-date-entry-date", text: rule.stamp });
			}
			return;
		}
		if (value.showEmoji) {
			el.createSpan({ cls: "effortless-date-entry-emoji", text: stampEmoji(value.kind) });
		}
		if (value.suggestion === null) {
			el.createSpan({ cls: "effortless-date-entry-placeholder", text: PLACEHOLDER });
			return;
		}
		el.createSpan({ cls: "effortless-date-entry-phrase", text: value.suggestion.phrase });
		el.createSpan({ cls: "effortless-date-entry-separator", text: "·" });
		el.createSpan({
			cls: "effortless-date-entry-date",
			text: shownDate(value.suggestion.date),
		});
	}

	/**
	 * Writes the line `stamp` answers with, in one editor change, and puts the
	 * cursor where it says.
	 *
	 * The whole line is replaced rather than the trigger's own span, because
	 * `stamp` decides the whole line: on a task line the core sets the date
	 * where the format puts it, which is somewhere else entirely. One change,
	 * so one undo puts the line back.
	 *
	 * **What gets replaced ends at the live cursor, not at `context.end`.**
	 * `context.end` is wherever the cursor stood the last time `onTrigger` ran,
	 * and that call can lag the very last character typed: when Enter reaches
	 * the popup within about a millisecond of it, `onTrigger` for that
	 * character has not yet run, so `context.end` sits one character short and
	 * that character would otherwise survive as plain text after the stamp
	 * (`docs/acceptance-shots/issue-611-fast-undo.txt`, *TRAILING CHARACTER*;
	 * #619). The document
	 * itself is never behind — the keystroke has already landed by the time
	 * `selectSuggestion` runs — so the editor's own current cursor
	 * (`Editor.getCursor`, `node_modules/obsidian/obsidian.d.ts:2475`,
	 * `@public` since 0.11.11) is used in `context.end`'s place. It is not
	 * always further along than `context.end`: a raced character can just as
	 * well be a Backspace, and then the live cursor sits *behind* `context.end`
	 * rather than ahead of it. Either way it is what is actually on the line,
	 * which `context.end` might not be.
	 *
	 * **The suggestion is re-read when the raced character changed what the
	 * query means, not only where it ends.** `value` is `onTrigger`'s answer to
	 * the query it last saw, and a raced character can change that answer
	 * outright, not just lengthen it — Swedish `@3/1` racing a `2` means 3
	 * December, not the 3 January `value` was computed for. So the text
	 * between the trigger and the live cursor is compared against
	 * `context.query`, the text `value` was actually computed from; wherever
	 * the two differ, the live text is asked of `suggest`, the same function
	 * `onTrigger` calls, in `value`'s place. An ordinary-speed accept already
	 * has the two agree, so this costs it nothing — including no second
	 * reading of the clock, which is exactly what `getSuggestions`'s own note
	 * above avoids paying twice.
	 *
	 * **A raced answer that no longer means a date is not written.** Re-reading
	 * can answer with no date at all where `value` held one — `@3/1` raced by a
	 * Backspace down to `@3` no longer parses. Writing `value`'s date then
	 * would be exactly the silent wrong answer this exists to stop, so nothing
	 * is written: the typed text stays as it is and the popup closes, the same
	 * as accepting the placeholder does below.
	 *
	 * **A live cursor this feature does not expect is refused the same way.**
	 * Sharing the trigger's line and never sitting left of the trigger itself
	 * both hold at ordinary speed and under the race above, but a `stamp` call
	 * built on a cursor that broke either would double the text between
	 * `triggerAt` and `cursorAt` (`stamp.ts:102-103`) or reach across a line
	 * this feature has never once read or written. Both are refused rather
	 * than risked.
	 *
	 * **The placeholder writes nothing.** It is the popup saying "not yet", and
	 * accepting it is the person saying so too, so it closes and leaves the line
	 * alone — and it is a choice, so it silences nothing.
	 */
	selectSuggestion(value: DateAnswer, _evt: MouseEvent | KeyboardEvent): void {
		const context = this.context;
		if (context === null) return;

		const chosen = chosenRule(value);
		if (value.suggestion !== null || chosen !== null) {
			const editor: DateEntryEditor = context.editor;
			const at = context.start.line;
			const line = editor.getLine(at);
			const liveCursor = context.editor.getCursor("to");
			const settings = this.settings();

			if (liveCursor.line === at && liveCursor.ch >= context.start.ch) {
				const cursorAt = liveCursor.ch;
				const liveQuery = line.slice(context.start.ch + settings.trigger.length, cursorAt);
				const answer =
					liveQuery === context.query
						? value
						: suggest(line.slice(0, cursorAt), settings, new Date(), null);

				const written =
					answer !== null && answer.triggerAt === context.start.ch
						? writtenFor(answer, chosen, line, cursorAt)
						: null;
				if (written !== null) {
					editor.transaction(
						{
							changes: [
								{
									from: { line: at, ch: 0 },
									to: { line: at, ch: line.length },
									text: written.line,
								},
							],
							selections: [{ from: { line: at, ch: written.cursor } }],
						},
						ACCEPT_ORIGIN,
					);
				}
			}
		}

		// A choice, so nothing is dismissed: the popup goes because it has been
		// answered. The core has pointed this at the popup Obsidian is running, so it is the popup that closes and not this object.
		this.close();
	}

	/**
	 * The column `suggest` is told about, and `null` when there is nothing to
	 * tell it, keeping whatever `recheckDismissal` says stays recorded.
	 *
	 * It holds no rule of its own: when a dismissal clears, and why the whole
	 * line is read rather than the text before the cursor, are that function's
	 * and are written there.
	 * `nearbyLines` below is the one thing this file adds for it to read: the
	 * couple of lines beside a dismissal's recorded line, so that function can
	 * tell a trigger that shifted from one that is simply gone.
	 */
	private dismissedIn(
		cursor: EditorPosition,
		line: string,
		trigger: string,
		editor: DateEntryEditorWithLineCount,
	): number | null {
		const recorded = this.dismissed;
		const nearby = recorded === null ? [] : nearbyLines(editor, recorded.line, cursor.line);
		const reading = recheckDismissal(recorded, cursor, line, trigger, nearby);
		this.dismissed = reading.recorded;
		return reading.dismissed;
	}
}

/** The one rule a row of rules holds, or `null` for a date row. */
function chosenRule(value: DateAnswer): RepeatRow | null {
	return "rules" in value ? (value.rules[0] ?? null) : null;
}

/**
 * The line to write for `answer`, or `null` when nothing is to be written.
 *
 * A date answer writes its date. A rule answer writes the rule that was
 * chosen, found in `answer` by its text: when a raced character has changed the
 * rows, a row the rows no longer hold is not written, the same as a date that
 * stopped meaning one. An answer of the other kind than the row chosen writes
 * nothing either.
 */
function writtenFor(
	answer: DateAnswer,
	chosen: RepeatRow | null,
	line: string,
	cursorAt: number,
): StampResult | null {
	if (chosen !== null) {
		if (!("rules" in answer)) return null;
		const row = answer.rules.find((each) => each.text === chosen.text);
		if (row === undefined) return null;
		return stampRepeat(line, answer.triggerAt, cursorAt, row.text, row.firstDate);
	}
	if ("rules" in answer || answer.suggestion === null) return null;
	return stamp(line, answer.triggerAt, cursorAt, answer.kind, answer.suggestion.date);
}

/**
 * The content now at `origin` itself, the line just above it and the line
 * just below it — skipping `cursor`, since `onTrigger` already reads that one
 * as `line`, and skipping a line that no longer exists.
 *
 * `origin` is a dismissal's last recorded line. Reading it and its two
 * neighbours, rather than the whole document, is what {@link recheckDismissal}'s
 * cross-line case (`./dismissal.ts`) needs and no more: that function's first
 * branch reads `origin`'s own current content from here to tell whether
 * anything shifted there at all, and its last one reads the neighbours to
 * find where it went.
 */
function nearbyLines(editor: DateEntryEditorWithLineCount, origin: number, cursor: number): NearbyLine[] {
	const found: NearbyLine[] = [];
	for (const at of [origin - 1, origin, origin + 1]) {
		if (at < 0 || at === cursor) continue;
		const text = lineOrNull(editor, at);
		if (text !== null) found.push({ line: at, text });
	}
	return found;
}

/**
 * `editor.getLine(at)`, or `null` where that line does not exist in the
 * document.
 *
 * A line a dismissal was recorded against, or its neighbour, can fall outside
 * the document by the time the next keystroke asks — lines above it were
 * deleted along with it, or it was the last line and the one below it never
 * existed. `editor.lineCount()` (`node_modules/obsidian/obsidian.d.ts:2440`,
 * `@public` since 0.11.11) says so before `getLine` is ever asked, so that is
 * the one thing this reads as "not there"; anything else `getLine` does is
 * unexpected and is left to throw, the repo's fail-loud rule.
 */
function lineOrNull(editor: DateEntryEditorWithLineCount, at: number): string | null {
	if (at < 0 || at >= editor.lineCount()) return null;
	return editor.getLine(at);
}

export class DateEntry extends Feature {
	readonly id = FEATURE_ID;

	readonly name = "Date entry";

	readonly description = "Type a date in plain words; get a Tasks-format stamp.";
	override readonly settingNames = DATE_ENTRY_SETTING_NAMES;

	/**
	 * Taken here and used from `onload` onwards, which is what the feature
	 * contract asks for: the handle finds its feature when it is read, not when
	 * it is taken (`src/core/feature.ts`).
	 */
	private readonly own = this.host.settings<DateEntrySettings>(DEFAULT_DATE_ENTRY_SETTINGS);

	/**
	 * Registers the popup, and, once per load, says whether a stored trigger or
	 * language it cannot use is running on a fallback instead.
	 *
	 * **The notice is `onload`'s alone.** `settings()` below is read on every
	 * keystroke and stays silent every time, and the stored value is never
	 * rewritten, so the notice comes back at every plugin start and every
	 * switch-on until the stored value changes. The settings card draws
	 * `stored()`, what `data.json` actually holds, flagged where it differs
	 * from what `settings()` judges usable — so the notice's "change it here"
	 * sends the person to a screen that shows the value it named. The notice is
	 * the one place that says a hand-edited file could not be used, said the
	 * one time each load the feature starts reading it.
	 */
	override onload(): void {
		// A fresh suggester from every `onload`, which is the shape the core asks
		// for: nothing is registered with Obsidian a second time, the core simply
		// re-aims its own at this one, so switching the feature off and on never
		// stacks a second popup. It is made
		// here rather than in the constructor because registering one there
		// throws — the core builds every feature, including one that is switched
		// off.
		const suggester = new DateSuggester(this.host.app, () => this.settings());
		this.host.registerEditorSuggest(suggester);
		// Nothing else: no command, no event handler, no view. The core closes
		// this popup and declines every later trigger the moment the feature is
		// switched off, so there is no off-check of our own to write.

		// The same two readers the keystroke path uses, asked once, against what
		// is actually stored — not a third rule of its own.
		const stored = this.own.read();
		const usable = this.settings();
		if (usable.trigger !== stored.trigger) {
			new Notice(
				`Effortless: date entry cannot use the trigger ${JSON.stringify(stored.trigger)} stored in its settings and runs with ${JSON.stringify(usable.trigger)} instead. Change it on the Effortless settings screen.`,
			);
		}
		if (usable.language !== stored.language) {
			new Notice(
				`Effortless: date entry cannot use the language ${JSON.stringify(stored.language)} stored in its settings and runs with English instead. Change it on the Effortless settings screen.`,
			);
		}
	}

	/**
	 * Always ready. There is nothing to configure before a date can be typed,
	 * nothing about it is per device, and it raises no standing problem — a
	 * keystroke either offered a date or showed `...`.
	 */
	readiness(): Readiness {
		return { state: "ready" };
	}

	override displaySettings(containerEl: HTMLElement, changed: SettingsChanged): void {
		renderDateEntrySettings(containerEl, this, changed);
	}

	/**
	 * The slice as the popup reads it: the stored language and the stored
	 * trigger, each read as the feature can actually use it.
	 *
	 * **Read afresh every time**, so a language or a trigger changed on the card
	 * is in force at the next keystroke and nothing needs a reload.
	 *
	 * **Both fields are judged rather than trusted.** `data.json` sits in the
	 * vault and a person can edit it by hand, so what is stored has not
	 * necessarily passed the card: a trigger that could not be one is read as
	 * the shipped `@` ({@link usableTrigger}), and any language that is not
	 * Swedish is read as English, which is the same answer `suggest` would
	 * reach on its own.
	 *
	 * **The settings card does not read this.** It draws {@link stored}, the
	 * unjudged slice, so a value this method has fallen back from is still the
	 * value shown.
	 */
	settings(): DateEntrySettings {
		const stored = this.own.read();
		return {
			language: stored.language === "sv" ? "sv" : "en",
			trigger: usableTrigger(stored.trigger),
		};
	}

	/**
	 * The slice exactly as `data.json` holds it, with no fallback judged in.
	 *
	 * What the settings card draws and saves from, so a stored value
	 * {@link settings} has fallen back from is still what the person sees and
	 * can fix in place.
	 */
	stored(): DateEntrySettings {
		return this.own.read();
	}

	/** Stores a new slice. One press of the card, one write. */
	async saveSettings(next: DateEntrySettings): Promise<void> {
		await this.own.save(next);
	}
}
