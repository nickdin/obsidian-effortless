/**
 * The standing-problems section on the settings screen.
 *
 * Its job is to keep saying what a `Notice` said once and then faded. So the
 * two things asserted here are that a reported problem is readable in plain
 * words, and that a screen with nothing wrong on it draws nothing at all —
 * spec #32 § 11 keeps the
 * screen quiet, and an empty "Problems" heading is not quiet.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { resetSettings } from "./__mocks__/obsidian";
import type { StandingProblem } from "../core/problems";
import { renderProblems } from "../core/problemsSection";

function problem(featureName: string, message: string, key = "House/Garden.md"): StandingProblem {
	return { featureId: featureName.toLowerCase(), featureName, key, message };
}

/** The text of every problem row drawn, in the order they were drawn. */
function rows(root: HTMLElement): string[] {
	// `Array.from` rather than a spread: tsconfig targets ES2018, where a
	// NodeList is not yet iterable.
	return Array.from(root.querySelectorAll(".effortless-problem")).map(
		(row) => row.textContent ?? "",
	);
}

describe("renderProblems", () => {
	let body: HTMLElement;

	beforeEach(() => {
		resetSettings();
		document.body.innerHTML = "";
		body = document.createElement("div");
		document.body.appendChild(body);
	});

	it("draws nothing at all when nothing is wrong", () => {
		renderProblems(body, []);

		expect(body.textContent).toBe("");
		expect(body.children).toHaveLength(0);
	});

	it("names the feature and says what went wrong, one row each", () => {
		renderProblems(body, [
			problem("Pairing", "12 tasks in House/Garden.md are no longer paired."),
			problem("Rollover", "Work/Roof.md has moved out of reach.", "Work/Roof.md"),
		]);

		expect(rows(body)).toEqual([
			"Pairing12 tasks in House/Garden.md are no longer paired.",
			"RolloverWork/Roof.md has moved out of reach.",
		]);
	});

	it("draws one row for a report naming twelve tasks, not twelve rows", () => {
		renderProblems(body, [problem("Pairing", "12 tasks in House/Garden.md are no longer paired.")]);

		expect(rows(body)).toHaveLength(1);
	});

	it("draws its own heading, so the section is not mistaken for a setting", () => {
		renderProblems(body, [problem("Pairing", "Garden broke.")]);

		expect(body.querySelector(".setting-item-heading")?.textContent).toContain("Problems");
	});
});
