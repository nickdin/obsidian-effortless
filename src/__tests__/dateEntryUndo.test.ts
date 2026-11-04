/**
 * Whether accepting a date keeps the stamp its own undo step, even when the
 * accept lands close on the heels of typing the trigger.
 *
 * `dateEntry.test.ts` already pins that accepting writes the whole line in
 * one change (`editor.transactions[0].changes` has length one) — that much
 * was never in question. What #611's own drive found is that CodeMirror 6
 * groups that one change into whatever undo step the typing before it is
 * still in if the two land within its own ~500ms window, unless the change
 * is marked to start a fresh one. The suite cannot open a real CodeMirror to
 * check the undo itself (`docs/acceptance-shots/issue-611-fast-undo.txt` is
 * the drive that did), so the one thing a unit test can pin is that
 * `selectSuggestion` asks for that mark: `editor.transaction(tx, origin)`
 * with an `origin` CodeMirror's own history does not fold into a typing
 * group — `"input.complete"`, the same one CodeMirror's own autocomplete
 * uses, per `userEvent`'s own `/^(input\.type|delete)($|\.)/` join rule.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App, EditorPosition, EditorTransaction, TFile } from "obsidian";
import { EditorSuggest } from "./__mocks__/obsidian";
import { DateSuggester } from "../features/dateEntry/dateEntry";
import type { DateEntryEditor, DateEntrySettings } from "../features/dateEntry/types";

/** A local date, the way `dateEntry.test.ts` builds its own reference day. */
const day = (y: number, m: number, d: number): Date => new Date(y, m - 1, d);

/** The same reference Thursday `dateEntry.test.ts` and `dateEntrySuggest.test.ts` pin. */
const THURSDAY = day(2026, 9, 3);

type Popup = DateSuggester & EditorSuggest<unknown>;

/** One transaction as this file's `FakeEditor` received it: the tx and the origin, if any. */
interface Received {
	readonly tx: EditorTransaction;
	readonly origin: string | undefined;
}

/**
 * An editor that records the `origin` argument alongside each transaction.
 *
 * `DateEntryEditor.transaction` (`src/features/dateEntry/types.ts`) declares
 * the optional `origin` Obsidian's own `Editor` takes; this fake records it,
 * where `dateEntry.test.ts`'s fake ignores it. It is `selectSuggestion`'s own
 * call, not this fake, that has to pass the origin.
 */
class FakeEditor implements DateEntryEditor {
	readonly received: Received[] = [];

	constructor(
		readonly lines: string[],
		private cursor: EditorPosition,
	) {}

	getCursor(_which: "from" | "to"): EditorPosition {
		return this.cursor;
	}

	getLine(line: number): string {
		return this.lines[line];
	}

	transaction(tx: EditorTransaction, origin?: string): void {
		this.received.push({ tx, origin });
		for (const change of tx.changes ?? []) {
			const line = this.lines[change.from.line];
			const to = change.to ?? change.from;
			this.lines[change.from.line] = line.slice(0, change.from.ch) + change.text + line.slice(to.ch);
		}
		const moved = (tx.selections ?? [])[0];
		if (moved) this.cursor = moved.from;
	}
}

/** One line with the cursor at its end, which is where typing leaves it. */
function typing(line: string): FakeEditor {
	return new FakeEditor([line], { line: 0, ch: line.length });
}

/** A keystroke: what the editor does to the popup on every text change. */
function keystroke(popup: Popup, editor: FakeEditor): boolean {
	return popup.trigger(editor, null as TFile | null, true);
}

/** Pressing Enter on the one row the popup is showing. */
function choose(popup: Popup): void {
	popup.selectSuggestion(popup.shown[0], new KeyboardEvent("keydown"));
}

/** A bare `DateSuggester`, English and `@`, with none of `DateEntry`'s host wiring. */
function suggester(): Popup {
	const settings: DateEntrySettings = { language: "en", trigger: "@" };
	return new DateSuggester({} as App, () => settings) as Popup;
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(THURSDAY);
});

describe("accepting a date starts its own undo step", () => {
	it("passes CodeMirror's own autocomplete origin to editor.transaction", () => {
		const popup = suggester();
		const editor = typing("- [ ] Write report @tom");

		keystroke(popup, editor);
		choose(popup);

		expect(editor.received).toHaveLength(1);
		expect(editor.received[0].origin).toBe("input.complete");
	});

	it("still writes the whole line in exactly one change — the origin adds nothing else", () => {
		const popup = suggester();
		const editor = typing("- [ ] Write report @tom");

		keystroke(popup, editor);
		choose(popup);

		expect(editor.received[0].tx.changes).toHaveLength(1);
		expect(editor.lines[0]).toBe("- [ ] Write report ⏳ 2026-09-04");
	});

	it("does not pass an origin CodeMirror's history would still join to a typing group", () => {
		const popup = suggester();
		const editor = typing("- [ ] Write report @tom");

		keystroke(popup, editor);
		choose(popup);

		const origin = editor.received[0].origin;
		expect(origin).toBeDefined();
		expect(/^(input\.type|delete)($|\.)/.test(origin as string)).toBe(false);
	});
});
