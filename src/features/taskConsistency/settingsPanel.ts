/**
 * Task consistency's card body.
 *
 * **There is nothing to answer here.** Spec #48
 * puts this feature's only state inside the files it edits, not in
 * `data.json` (ADR 0002), so the card names which core settings the feature
 * reads instead of drawing a row for any of its own — the same information a
 * person would otherwise have to guess at from the readiness sentence alone
 * (spec #709 decision 1's own seam table: the daily-log layout, the two
 * collection headings and the two day's-task-section headings are all the
 * core's).
 *
 * **The core draws the card and the on/off switch; this file draws
 * neither.** `src/core/settingsTab.ts` hands the feature an empty element
 * inside its card, and the one line below goes into it.
 *
 * **No `effortless-` class of its own.** The one line here needs no styling
 * beyond the card body's own, and `styles.test.ts` sweeps every
 * `effortless-`-prefixed class the source applies for a matching rule in
 * `styles.css` — a file this ticket does not own.
 */

/** The core card every one of the settings named below lives on. */
const CORE_CARD = "Your day's logs";

/** What this feature reads, named for the person reading this card. */
const READS_LINE =
	`Nothing to answer here. Task consistency reads the daily-log folder and filename, ` +
	`the tasks and completed-tasks headings, and the today and overdue headings, all on the ${CORE_CARD} card.`;

/** Draws the card's one informational line into `parent`. */
export function renderTaskConsistencySettings(parent: HTMLElement): void {
	parent.createDiv({ text: READS_LINE });
}
