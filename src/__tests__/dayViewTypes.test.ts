import { describe, it, expect } from "vitest";
import type { UnreadRow } from "../features/dayView/types";

/**
 * `types.ts` carries no runtime code, so `UnreadRow.stoppedBy` is checked at
 * compile time: the two reasons the table's end can name build without
 * complaint, and the old, wrong position-based value ("start") is refused —
 * by `npm run lint` and `npm run build`, both of which type-check this file
 * (ticket #634; spec #618 § 8, "with which of the two stopped it").
 */
function acceptsUnreadRow(row: UnreadRow): UnreadRow {
	return row;
}

// @ts-expect-error "start" named a position above or below the table; the field says which of the two things ended it, not where the line sits
acceptsUnreadRow({ line: "", stoppedBy: "start" });

describe("UnreadRow.stoppedBy", () => {
	it("builds for a blank line ending the table", () => {
		const row = acceptsUnreadRow({ line: "", stoppedBy: "blank-line" });
		expect(row.stoppedBy).toBe("blank-line");
	});

	it("builds for a row wider than its header ending the table", () => {
		const row = acceptsUnreadRow({ line: "| a | b | c |", stoppedBy: "wide-row" });
		expect(row.stoppedBy).toBe("wide-row");
	});
});
