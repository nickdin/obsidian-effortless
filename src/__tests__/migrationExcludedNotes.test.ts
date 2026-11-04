/**
 * The notes the chooser must never offer
 * (#875, a finding against
 * #858): one the core's index
 * would never call a collection. Runs the command from the palette through the
 * real chooser.
 */

import { expect, it, describe } from "vitest";
import { ATTIC, installMigrationHooks, lastChooser, pathsFor, run, startMigration } from "./migrationHarness";

installMigrationHooks();

describe("a note in an excluded folder", () => {
	const TEMPLATE = "Templates/Weekly.md";
	const NEIGHBOUR = "Templatesque/Weekly.md";

	// Were the code wrong, the template is drawn in beside the neighbour.
	it("leaves out a note in an excluded folder, and keeps one whose folder only starts the same way", async () => {
		const { plugin } = await startMigration({
			collections: [ATTIC],
			excludedFolders: ["Templates"],
			extraNotes: { [TEMPLATE]: "# Weekly\n", [NEIGHBOUR]: "# Weekly\n" },
		});

		run(plugin, 2);

		expect(pathsFor(lastChooser(), "weekly")).toEqual([NEIGHBOUR]);
	});
});
