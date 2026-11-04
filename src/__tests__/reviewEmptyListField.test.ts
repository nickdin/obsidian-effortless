/**
 * *Mark as processed* over a processed field holding an empty list. The chain reads
 * `processed: []` as empty, so the write has to fill it too: the two share one
 * definition of empty. Every note and date here is invented.
 */

import { describe, expect, it } from "vitest";
import { markProcessedText } from "../features/review/markProcessed";

const DATE = "2026-03-18";

describe("the processed field holding an empty list", () => {
	it.each([
		["Unix endings, ending in a line break", "\n", true],
		["Unix endings, with no final line break", "\n", false],
		["Windows endings, ending in a line break", "\r\n", true],
		["Windows endings, with no final line break", "\r\n", false],
	])("is filled and nothing else changes, on %s", (_name, eol, final) => {
		const note = (value: string): string => ["---", "title: Weekly sync", `processed: ${value}`, "---", "- [ ] one"].join(eol) + (final ? eol : "");
		expect(markProcessedText(note("[]"), "processed", DATE)).toBe(note(DATE));
		expect(markProcessedText(note("[ ]"), "processed", DATE)).toBe(note(DATE));
	});

	it("still refuses a list holding an item", () => {
		expect(() => markProcessedText("---\nprocessed: [2026-03-10]\n---\n", "processed", DATE)).toThrow("already filled in");
	});
});
