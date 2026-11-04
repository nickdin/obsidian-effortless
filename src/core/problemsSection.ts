/**
 * The standing-problems section, drawn on the core card immediately above the
 * collections list.
 *
 * It sits there rather than beside the collection it is about, because a
 * problem you have to find by scrolling forty-seven rows is not a notice. One row per
 * report: a feature that found twelve orphaned tasks reported once, and this
 * draws what it said.
 *
 * A screen with nothing wrong on it draws nothing at all — not an empty
 * heading. The settings screen is built to stay quiet at fifteen features, and
 * a section that is always there stops meaning anything when it is not.
 *
 * A section of its own file rather than more of `settingsTab.ts`, so the screen
 * calls one function and the section can be tested without drawing the screen.
 */

import { Setting } from "obsidian";
import type { StandingProblem } from "./problems";

/**
 * The one fixed row name this section draws, for the settings search. Each problem's
 * row is named after the feature that reported it, which is data.
 */
export const PROBLEMS_SETTING_NAMES: readonly string[] = ["Problems"];

/** Draws the section under `parent`, or nothing at all when nothing is wrong. */
export function renderProblems(parent: HTMLElement, problems: readonly StandingProblem[]): void {
	if (problems.length === 0) return;

	new Setting(parent)
		.setName("Problems")
		.setDesc("Each one stays here until the feature that found it says it is well again.")
		.setHeading();

	// `setClass` **adds** the class: measured 2026-09-28 in Obsidian 1.13.7, where
	// this row's className read back as `setting-item effortless-problem`
	// (`docs/acceptance-shots/issue-128-setclass-classname.txt`, #128). So the
	// row keeps Obsidian's own `setting-item` layout, and any later section that
	// wants a class on a `Setting` may use `setClass` without asking again.
	for (const problem of problems) {
		new Setting(parent)
			.setClass("effortless-problem")
			.setName(problem.featureName)
			.setDesc(problem.message);
	}
}
