/**
 * The two decisions `vocabulary.ts` makes for every sweep that reads a
 * TypeScript source: which strings a person actually reads, and which of them
 * carry a word the glossary retires.
 *
 * `manifest.test.ts` drives the same helpers over the real shipped sources.
 * What is here is the holes the sweep could not see out of, each written as the
 * smallest source that shows it: a string holding `//`, a single-quoted
 * sentence,
 * the shapes a first-literal rule never reached, and four more that
 * sat at no swept position at all — a sentence to the right of a call in a
 * `.textContent` statement, a block-bodied arrow function, a function returning
 * `string | null`, and a feature's readiness reason.
 *
 * A hole here is invisible from the outside: the sweep reports clean on text it
 * never read, so every shape below was made to fail first.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { retiredIn, retiredWords, shownStrings } from "./vocabulary";
import { repoRoot } from "./repoRoot";

const words = retiredWords(readFileSync(resolve(repoRoot, "GLOSSARY.md"), "utf8"));

describe("a string holding `//` does not blind the sweep", () => {
	const source = 'new Notice("Use // for a comment.");\nnew Notice("A calendar event.");';

	it("reads both sentences", () => {
		expect(shownStrings(source)).toEqual(["Use // for a comment.", "A calendar event."]);
	});

	it("catches the retired word in the second one", () => {
		// The half that matters. Losing the second sentence lost the failure
		// with it, and the sweep said the file was clean.
		expect(retiredIn(shownStrings(source).join("\n"), words)).toEqual(["event"]);
	});
});

describe("all three quote styles are swept", () => {
	it("reads a single-quoted sentence", () => {
		expect(shownStrings("new Notice('A calendar event.');")).toEqual(["A calendar event."]);
	});

	it("catches a retired word in one", () => {
		expect(retiredIn(shownStrings("new Notice('A calendar event.');").join("\n"), words)).toEqual([
			"event",
		]);
	});

	it("keeps a single-quoted sentence whole across an escaped quote of its own kind", () => {
		// The escape stays in the captured text, the same way it already does
		// for the other two styles. What matters is that the sentence is one
		// string rather than two halves.
		expect(shownStrings("new Notice('It\\'s a calendar event.');")).toEqual([
			"It\\'s a calendar event.",
		]);
	});

	it("still reads the two styles it always read", () => {
		expect(shownStrings('new Notice("A calendar event.");')).toEqual(["A calendar event."]);
		expect(shownStrings("new Notice(`A calendar event.`);")).toEqual(["A calendar event."]);
	});
});


/*
 * Issue #261, with #259 closed into it. Four shapes, each a sentence a person
 * reads, and none of them at a position the old rule could see: it matched a
 * shown call followed *immediately* by a literal and read that one literal
 * alone.
 *
 * Each is proved by planting a retired word and watching a vocabulary guard
 * fail. The string-equality assertions in `calendarSourcesSection.test.ts` do
 * fail on the same edit, and they are no guard at all: they are the assertions a
 * worker moves along with the string.
 */
describe("a sentence behind a ternary inside a shown call", () => {
	const description = [
		"new Setting(block)",
		'\t.setName("Where it comes from")',
		"\t.setDesc(",
		'\t\tsource.kind === "link"',
		'\t\t\t? "The published address of the calendar, starting with https://."',
		'\t\t\t: "The path to an .ics event inside your vault.",',
		"\t);",
	].join("\n");

	it("reads both branches, not the first literal alone", () => {
		expect(shownStrings(description)).toEqual([
			"Where it comes from",
			"The published address of the calendar, starting with https://.",
			"The path to an .ics event inside your vault.",
		]);
	});

	it("catches a retired word in the branch a first-literal rule never reached", () => {
		expect(retiredIn(shownStrings(description).join("\n"), words)).toEqual(["event"]);
	});

	it("leaves the literal the condition compares against out of it", () => {
		// `"link"` is the stored answer, the same thing `.addOption`'s first
		// argument is. A region reads everything between its parentheses, so
		// without the comparison rule the condition would be read as a sentence.
		expect(shownStrings(description)).not.toContain("link");
	});
});

describe("the same shape on a placeholder", () => {
	const placeholder = [
		"text.setPlaceholder(",
		'\tsource.kind === "link" ? "https://calendar.example/basic.ics" : "Your daily note folder.",',
		");",
	].join("\n");

	it("catches a retired word in the second branch", () => {
		expect(retiredIn(shownStrings(placeholder).join("\n"), words)).toEqual(["daily note"]);
	});
});

describe("a sentence returned from a function", () => {
	// `sourceStateLine` in `src/core/calendarSourcesSection.ts`, in miniature.
	// Its return type is what says the answer is words; the caller writes it to
	// an element and nothing between the two is a shown position.
	const returned = [
		"function sourceStateLine(",
		"\tsource: CalendarSource,",
		"\tread: CalendarRead | undefined,",
		"): string {",
		'\tif (!earnedAt(read, source)) return "That event has not been read yet.";',
		"\treturn age === null ? \"Not read yet.\" : `Last read ${age}.`;",
		"}",
	].join("\n");

	it("reads every sentence the function returns", () => {
		expect(shownStrings(returned)).toEqual([
			"That event has not been read yet.",
			"Not read yet.",
			"Last read  .",
		]);
	});

	it("catches a retired word in one of them", () => {
		expect(retiredIn(shownStrings(returned).join("\n"), words)).toEqual(["event"]);
	});

	it("reads nothing out of a function that does not answer in words", () => {
		// The rule turns on the declared return type. A function answering with
		// something else is compared against a stored answer, not read aloud.
		expect(shownStrings('function asKind(value: string): CalendarSourceKind {\n\treturn value === "file" ? "file" : "link";\n}')).toEqual([]);
	});
});

describe("a sentence assigned to an element", () => {
	it("catches a retired word written straight to textContent", () => {
		const assigned = 'state.textContent = "That event has not been read yet.";';

		expect(shownStrings(assigned)).toEqual(["That event has not been read yet."]);
		expect(retiredIn(shownStrings(assigned).join("\n"), words)).toEqual(["event"]);
	});
});

describe("addOption keeps its narrow rule", () => {
	const dropdown = ['dropdown.addOption("link", "A link");', 'dropdown.addOption("file", "A file in the vault");'].join(
		"\n",
	);

	it("reads the words in the list and not the stored answer", () => {
		expect(shownStrings(dropdown)).toEqual(["A link", "A file in the vault"]);
	});

	it("reports neither of the two stored answers", () => {
		expect(shownStrings(dropdown)).not.toContain("link");
		expect(shownStrings(dropdown)).not.toContain("file");
	});
});

describe("a textContent statement reaches past a call inside it", () => {
	// The region walker used to return as soon as a bracket took depth back to
	// zero, and a statement region starts at zero — so the first call inside one
	// ended it, and everything written to the right of that call was swept by
	// nothing.
	it("reads the sentence to the right of a call", () => {
		const assigned = 'state.textContent = timeSince(read) + " event ago";';

		expect(shownStrings(assigned)).toEqual(["event ago"]);
		expect(retiredIn(shownStrings(assigned).join("\n"), words)).toEqual(["event"]);
	});

	it("reads the sentence behind a ternary whose condition holds a call", () => {
		const assigned = 'state.textContent = wasRead(read) ? label(read) : "No event.";';

		expect(shownStrings(assigned)).toEqual(["No event."]);
		expect(retiredIn(shownStrings(assigned).join("\n"), words)).toEqual(["event"]);
	});

	it("still reads a sentence written straight to textContent", () => {
		expect(shownStrings('state.textContent = "An event.";')).toEqual(["An event."]);
	});
});

describe("a block-bodied arrow function is read like any other", () => {
	const arrow = [
		"const stateLine = (read: CalendarRead): string => {",
		'\treturn "That event has not been read yet.";',
		"};",
	].join("\n");

	it("reads the sentence it returns", () => {
		expect(shownStrings(arrow)).toEqual(["That event has not been read yet."]);
	});

	it("catches a retired word in it", () => {
		expect(retiredIn(shownStrings(arrow).join("\n"), words)).toEqual(["event"]);
	});

	it("leaves an expression-bodied arrow function alone, as the comment says", () => {
		expect(shownStrings('const stateLine = (read: CalendarRead): string => "An event.";')).toEqual([]);
	});
});

describe("a return type of string | null is a return type", () => {
	// `sourceProblem` in `src/core/calendarSources.ts` and `symbolRefusal` in
	// `src/features/checkboxCycling/sequences.ts`, in miniature. Answering "what
	// is wrong with this, or nothing" is the ordinary reason to write one.
	const problem = [
		"export function sourceProblem(source: CalendarSource): string | null {",
		'\tif (!source.location) return "This calendar has no event yet.";',
		"\treturn null;",
		"}",
	].join("\n");

	it("reads the sentence it returns", () => {
		expect(shownStrings(problem)).toEqual(["This calendar has no event yet."]);
	});

	it("catches a retired word in it", () => {
		expect(retiredIn(shownStrings(problem).join("\n"), words)).toEqual(["event"]);
	});
});

describe("a feature's readiness reason", () => {
	// The sentence the settings screen draws as a feature's row detail. Three of
	// `Readiness`'s members carry one, and every feature after the first writes
	// at least one.
	const readiness = 'return { state: "unconfigured", reason: "No sequence holds an event yet." };';

	it("reads the reason", () => {
		expect(shownStrings(readiness)).toEqual(["No sequence holds an event yet."]);
	});

	it("does not read the stored state beside it", () => {
		expect(shownStrings(readiness)).not.toContain("unconfigured");
	});

	it("catches a retired word in the reason", () => {
		expect(retiredIn(shownStrings(readiness).join("\n"), words)).toEqual(["event"]);
	});
});
