/**
 * Writing the tasks heading at the end of an ordinary note. Whole texts are
 * compared, so a heading at the wrong level, in the wrong place or with the
 * note's own words disturbed fails. Every note is invented.
 */

import { describe, expect, it } from "vitest";
import { withTasksHeading } from "../features/migration/tasksHeading";

describe("withTasksHeading", () => {
	it("writes a level-2 heading after the note's last line, with a blank line between", () => {
		expect(withTasksHeading("# Garden party\n\nBring chairs.\n", "Tasks")).toBe(
			"# Garden party\n\nBring chairs.\n\n## Tasks\n\n",
		);
	});

	it("adds only the newlines that are missing", () => {
		expect(withTasksHeading("Bring chairs.", "Tasks")).toBe("Bring chairs.\n\n## Tasks\n\n");
		expect(withTasksHeading("Bring chairs.\n\n", "Tasks")).toBe("Bring chairs.\n\n## Tasks\n\n");
		expect(withTasksHeading("Bring chairs.\n\n\n", "Tasks")).toBe("Bring chairs.\n\n\n## Tasks\n\n");
	});

	it("writes the heading alone into an empty note", () => {
		expect(withTasksHeading("", "Tasks")).toBe("## Tasks\n\n");
	});

	it("writes the configured heading, whatever it is", () => {
		expect(withTasksHeading("Words.\n", "To do")).toBe("Words.\n\n## To do\n\n");
	});

	it("keeps a note's Windows line endings", () => {
		expect(withTasksHeading("Words.\r\n", "Tasks")).toBe("Words.\r\n\r\n## Tasks\r\n\r\n");
	});

	it("leaves a note that already has the heading, at any level, exactly as it is", () => {
		expect(withTasksHeading("# Note\n\n### Tasks\n\n- [ ] One\n", "Tasks")).toBe("# Note\n\n### Tasks\n\n- [ ] One\n");
	});
});
