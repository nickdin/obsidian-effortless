import { describe, expect, it } from "vitest";
import { frontmatterEnd } from "../core/markdownSections";

describe("frontmatterEnd, the core's one statement of where frontmatter closes", () => {
	it("is the index of the second rule line when the note opens with one", () => {
		expect(frontmatterEnd(["---", "processed:", "---", "- body"])).toBe(2);
	});

	it("is -1 when the note has no opening rule on its first line", () => {
		expect(frontmatterEnd(["", "---", "a: b", "---"])).toBe(-1);
		expect(frontmatterEnd([])).toBe(-1);
	});

	it("is -1 when the opening rule is never closed: ordinary text, as Obsidian draws it", () => {
		expect(frontmatterEnd(["---", "- [ ] open", "- bullet"])).toBe(-1);
	});

	it("reads a rule line that ends in a carriage return as a rule line", () => {
		expect(frontmatterEnd(["---\r", "processed:\r", "---\r", "- body\r"])).toBe(2);
	});

	it("stops at the first closing rule, not a later one", () => {
		expect(frontmatterEnd(["---", "a: b", "---", "text", "---"])).toBe(2);
	});
});
