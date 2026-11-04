/**
 * The question asked before an ordinary note becomes a collection. The dialog is the
 * Obsidian stub's `ConfirmationModal`, which keeps Obsidian's rule that a
 * button closes it after its handler, and reaches `close` from Escape and from
 * a click outside alike. Every note name is invented.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { App as ObsidianApp } from "obsidian";
import { App, ConfirmationModal } from "./__mocks__/obsidian";
import { askToMakeCollection } from "../features/migration/confirmation";

const opened = vi.spyOn(ConfirmationModal.prototype, "open");

afterEach(() => {
	opened.mockClear();
});

function ask(): { answer: Promise<boolean>; modal: ConfirmationModal } {
	const answer = askToMakeCollection(new App() as unknown as ObsidianApp, "Garden party", "Tasks");
	const modal = opened.mock.contexts[opened.mock.contexts.length - 1] as ConfirmationModal;
	return { answer, modal };
}

describe("the question before a note becomes a collection", () => {
	it("names the note and says plainly what yes writes", () => {
		const { modal } = ask();

		expect(modal.contentEl.textContent).toContain("Garden party");
		expect(modal.contentEl.textContent).toContain("Yes writes the Tasks heading at the end of the note");
		expect(modal.buttons.map((each) => each.text)).toEqual(["Yes, write the heading", "No"]);
	});

	// Yes is the only route to true: each of the three others would answer true if the dialog
	// treated a closed dialog as consent, and this test would then fail on all of them.
	it("answers yes only when the yes button is pressed", async () => {
		const { answer, modal } = ask();

		modal.press("Yes, write the heading");

		await expect(answer).resolves.toBe(true);
	});

	it.each([
		["the no button", (modal: ConfirmationModal) => modal.press("No")],
		["Escape or a click outside", (modal: ConfirmationModal) => modal.dismiss()],
	])("answers no on %s", async (_name, act) => {
		const { answer, modal } = ask();

		act(modal);

		await expect(answer).resolves.toBe(false);
	});

	it("closes after a yes without turning the yes into a no", async () => {
		const { answer, modal } = ask();

		modal.press("Yes, write the heading");
		await answer;
		await Promise.resolve();

		expect(modal.isOpen).toBe(false);
	});
});
