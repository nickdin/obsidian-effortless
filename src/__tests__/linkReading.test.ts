/**
 * The core's one reader of the links on a task line. Every name below is invented.
 */

import { describe, expect, it } from "vitest";
import { lastLinkOnLine, linksOnLine } from "../core/linkReading";

const MARK = "%% migration:k1abcd 0a1b2c3d 0 %%";

describe("linksOnLine", () => {
	it("reads a wikilink's path, heading and alias apart, and where it sits in the line", () => {
		const line = "- [>] Tea [[Ideas/Garden shed#Seeds|the shed]] after";
		const [link] = linksOnLine(line);

		expect(link).toMatchObject({ kind: "wikilink", path: "Ideas/Garden shed", subpath: "#Seeds", label: "the shed" });
		expect(line.slice(link.start, link.end)).toBe("[[Ideas/Garden shed#Seeds|the shed]]");
	});

	it("reads a markdown link's destination with its %20s read back", () => {
		expect(linksOnLine("- [>] Tea [Garden shed](Ideas/Garden%20shed.md)")[0]).toMatchObject({
			kind: "markdown",
			path: "Ideas/Garden shed.md",
			label: "Garden shed",
			written: "Ideas/Garden%20shed.md",
		});
	});

	it("keeps a bracket inside a bare destination, and inside <…>, whole", () => {
		expect(linksOnLine("- [>] Tea [Garden (old)](Ideas/Garden%20(old).md)")[0].path).toBe("Ideas/Garden (old).md");
		expect(linksOnLine("- [>] Tea [Garden (old)](<Ideas/Garden (old).md>)")[0].path).toBe("Ideas/Garden (old).md");
	});

	it("reads a destination with a title and a heading", () => {
		expect(linksOnLine('- [>] Tea [Shed](Ideas/Garden%20shed.md#Seeds "the shed")')[0]).toMatchObject({
			path: "Ideas/Garden shed.md",
			subpath: "#Seeds",
		});
	});

	it("keeps an encoded # as part of the name", () => {
		expect(linksOnLine("- [>] Tea [C sharp](Ideas/C%23%20notes.md)")[0]).toMatchObject({ path: "Ideas/C# notes.md", subpath: "" });
	});

	it("leaves out a web link and the text inside a comment", () => {
		expect(linksOnLine(`- [>] Tea [[Garden shed]] [see](https://x.org/a) [mail](mailto:a@b.org) ${MARK} %% see [[Elsewhere]] %%`).map((each) => each.path)).toEqual([
			"Garden shed",
		]);
	});

	it("gives the links in the order they stand", () => {
		expect(linksOnLine("- [>] See [[Attic]] and [tea](Shed.md) then [[Cellar]]").map((each) => each.path)).toEqual(["Attic", "Shed.md", "Cellar"]);
	});

	it("does not take an unclosed bracket, or a bracket with no destination, for a link", () => {
		expect(linksOnLine("- [>] Tea [not a link] and [half](open")).toEqual([]);
	});
});

describe("lastLinkOnLine", () => {
	it("is the one filing appends after the person's own words", () => {
		expect(lastLinkOnLine(`- [>] See [[Attic]] and order tea [Shed](Ideas/Shed.md) ${MARK}`)?.path).toBe("Ideas/Shed.md");
	});

	it("is null when the line names none", () => {
		expect(lastLinkOnLine(`- [>] Order tea ${MARK}`)).toBeNull();
	});
});
