/**
 * The question asked before an ordinary note becomes a collection.
 *
 * Obsidian's own `ConfirmationModal` (`node_modules/obsidian/obsidian.d.ts:1963`,
 * published since 1.13.0), opened directly with `new` and `.open()` like the
 * chooser. **Only a press on the yes button answers yes.** The no button, Escape
 * and a click outside all close the dialog without it, and all three answer no:
 * a dismissal made by accident, mid-thought, must never write a heading.
 */

import { ConfirmationModal } from "obsidian";
import type { App } from "obsidian";

/** What the yes button says: it names the act, so no one has to remember what yes meant. */
const YES = "Yes, write the heading";

/**
 * Asks whether `noteName` may be made a collection by writing `tasksHeading` at
 * its end, and answers `true` only on a yes.
 */
export function askToMakeCollection(app: App, noteName: string, tasksHeading: string): Promise<boolean> {
	return new Promise((resolve) => {
		let answered = false;
		const answer = (yes: boolean): void => {
			if (answered) return;
			answered = true;
			resolve(yes);
		};

		const modal = new (class extends ConfirmationModal {
			// Obsidian closes the dialog after a button's handler, so a yes has
			// already been answered by the time this runs; anything else that
			// closes it is a no. Read in Obsidian: yes wrote, and No, Escape and
			// a click outside wrote nothing
			// (`docs/acceptance-shots/issue-858-859-chooser-drive.txt`, steps 4-5). Deferred one turn so that a close which comes
			// first, inside the same press, still lets the handler answer.
			override onClose(): void {
				super.onClose();
				queueMicrotask(() => answer(false));
			}
		})(app);

		modal.titleEl.textContent = "Make this note a collection?";
		modal.contentEl.createEl("p", {
			text: `${noteName} is not a collection yet. Yes writes the ${tasksHeading} heading at the end of the note and files the task under it. No leaves every note as it is.`,
		});
		modal.addButton((button) => button.setButtonText(YES).setCta().onClick(() => answer(true)));
		modal.addCancelButton("No");
		modal.open();
	});
}
