/**
 * The shape of `__fixtures__/task-consistency-parity.json`, and the one call
 * that reads it: the old sync engine's 53 named scenarios, recorded from the
 * pre-merge plugin's own `computeSync.test.ts` as before-and-after text. The fixture's own
 * `about` says how it was made and how to read it.
 *
 * Two suites read it: `taskConsistencyParityFixture.test.ts`, which holds the
 * file to its own header, and the parity replay, which runs the
 * scenarios through this feature. It is not a `.test.ts` file, so vitest runs
 * nothing from it.
 */

import { fixture } from "./fixtures";

/** A note's text as the old suite wrote it: one string per line, joined with `\n` to get the file. */
export type NoteLines = readonly string[];

/** The rows of #709 § *Named differences from the old plugin*, by number. */
export const NAMED_DIFFERENCE_ROWS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
export type NamedDifferenceRow = (typeof NAMED_DIFFERENCE_ROWS)[number];

/** Why an old assertion does not carry over; each key is explained in the header's `reasons`. */
export type DropReason = "breadcrumb" | "rebuildShape";

/** One `assert` or `assertEqual` the old scenario executed. */
export interface OldAssertion {
	/** The assertion's line in the old `computeSync.test.ts`. */
	readonly oldLine: number;
	/** The old assertion's own message. */
	readonly message: string;
	/** Null when the assertion still states an expectation; the reason otherwise. */
	readonly dropped: DropReason | null;
}

/** One old `describe` block: the two notes before, and what the old plugin made of them. */
export interface ParityScenario {
	/** The old `describe` name, verbatim. */
	readonly name: string;
	/** The `describe` block's line in the old `computeSync.test.ts`. */
	readonly oldLine: number;
	/** Which navigation the old plugin ran on: leaving the collection, or leaving the day's log. */
	readonly direction: "from-project" | "from-daglogg";
	/** The side the scenario's own premise says the person edited; `neither` and `unstated` are what they say. */
	readonly editedSide: "collection" | "log" | "neither" | "unstated";
	readonly before: { readonly collection: NoteLines; readonly log: NoteLines };
	/** The old plugin's output; null where it left that note unchanged. */
	readonly after: { readonly collection: NoteLines | null; readonly log: NoteLines | null };
	/** The rows of #709 § *Named differences* whose answer this scenario's old output does not bind. */
	readonly namedDifferences: readonly NamedDifferenceRow[];
	readonly assertions: readonly OldAssertion[];
}

/** The whole fixture. */
export interface ParityFixture {
	readonly about: readonly string[];
	readonly source: {
		readonly repository: string;
		readonly commit: string;
		readonly file: string;
		readonly recorded: string;
	};
	/** What every scenario ran with; the old suite's `makeInput` supplied the same to each. */
	readonly settings: {
		readonly today: string;
		readonly collectionName: string;
		readonly tasksHeading: string;
		readonly todayHeading: string;
		readonly overdueHeading: string;
		readonly completedHeading: string;
	};
	readonly assertions: {
		readonly total: number;
		readonly kept: number;
		readonly dropped: Readonly<Record<DropReason, number>>;
		readonly reasons: Readonly<Record<DropReason, string>>;
	};
	readonly scenarios: readonly ParityScenario[];
}

/** The parity fixture, parsed. */
export function taskConsistencyParity(): ParityFixture {
	return JSON.parse(fixture("task-consistency-parity.json")) as ParityFixture;
}
