/**
 * The lines Review's list draws when something failed, under Obsidian's display
 * language (tickets #1205 and
 * #1206, against
 * #1182's first box).
 *
 * Each lead-in is Review's own words and follows the language; the reason the
 * core wrote after the colon stays as the core wrote it, so a Swedish line may
 * be a Swedish lead-in plus an English core reason. Every case opens with a line
 * beginning `If wrong:`. Every note path and message is invented.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceLeaf as ObsidianLeaf } from "obsidian";
import { EmptyView, WorkspaceLeaf, resetLanguage, setLanguage } from "./__mocks__/obsidian";
import { ReviewListView } from "../features/review/listView";
import type { ReviewChain, ReviewList, ReviewListSource } from "../features/review/listView";
import type { Readiness } from "../core/feature";
import { reviewWords } from "../features/review/words";

beforeEach(() => {
	resetLanguage();
});

afterEach(() => {
	resetLanguage();
});

const NO_NOTES: ReviewList = { count: 0, unreadable: [], list: [], todayDiaryEmpty: false };

interface Answers {
	readiness?: () => Readiness;
	waiting?: () => Promise<ReviewList>;
	chain?: () => Promise<ReviewChain>;
}

function viewOver(answers: Answers): ReviewListView {
	const source: ReviewListSource = {
		readiness: answers.readiness ?? (() => ({ state: "ready" })),
		read: () => ({
			waiting: answers.waiting ?? (async () => NO_NOTES),
			chain: answers.chain ?? (async () => { throw new Error("The chain is not invented here"); }),
			followed: async () => [],
		}),
		open: async () => {},
		openDay: async () => {},
		markProcessed: async () => {},
	};
	return new ReviewListView(new WorkspaceLeaf(new EmptyView(null)) as unknown as ObsidianLeaf, source);
}

const chainText = (view: ReviewListView) => view.containerEl.querySelector("[data-review-chain]")?.textContent;

describe("the unreadable-notes line", () => {
	const unreadable = (list: readonly string[]) => async () => ({ ...NO_NOTES, unreadable: list });

	it("is Swedish under sv, one note and two", async () => {
		// If wrong: a line left an English literal reads "1 waiting note could not be read…" here.
		setLanguage("sv");
		const one = viewOver({ waiting: unreadable(["Journal/a.md"]) });
		await one.onOpen();
		expect(one.contentEl.textContent).toBe("1 väntande anteckning kunde inte läsas och visas inte: Journal/a.md");
		const two = viewOver({ waiting: unreadable(["Journal/a.md", "Journal/b.md"]) });
		await two.onOpen();
		expect(two.contentEl.textContent).toBe("2 väntande anteckningar kunde inte läsas och visas inte: Journal/a.md, Journal/b.md");
	});

	it("stays the English line, one note and two, under any other language", async () => {
		// If wrong: a table whose English drifted from the shipped line differs here.
		const one = viewOver({ waiting: unreadable(["Journal/a.md"]) });
		await one.onOpen();
		expect(one.contentEl.textContent).toBe("1 waiting note could not be read and is not shown: Journal/a.md");
		const two = viewOver({ waiting: unreadable(["Journal/a.md", "Journal/b.md"]) });
		await two.onOpen();
		expect(two.contentEl.textContent).toBe("2 waiting notes could not be read and are not shown: Journal/a.md, Journal/b.md");
	});
});

describe("the three lead-ins that carry a core reason", () => {
	it("says Review is not set up in Swedish under sv, the core's reason as written", async () => {
		// If wrong: the literal "Review is not set up yet." survives under sv.
		setLanguage("sv");
		const view = viewOver({ readiness: () => ({ state: "unconfigured", reason: "The daily-log folder is not set." }) });
		await view.onOpen();
		expect(view.contentEl.textContent).toBe("Granskning är inte inställd än. The daily-log folder is not set.");
	});

	it("says it could not read the notes in Swedish under sv, the core's reason as written", async () => {
		// If wrong: the literal "Review could not read your notes:" survives under sv.
		setLanguage("sv");
		const view = viewOver({ waiting: async () => { throw new Error("vault closed"); } });
		await view.onOpen();
		expect(view.contentEl.textContent).toBe("Granskning kunde inte läsa dina anteckningar: vault closed");
	});

	it("says it could not draw the chain in Swedish under sv, the core's reason as written", async () => {
		// If wrong: the literal "Review could not draw the chain:" survives under sv.
		setLanguage("sv");
		const view = viewOver({ chain: async () => { throw new Error("Journal/c.md could not be read"); } });
		await view.onOpen();
		expect(chainText(view)).toBe("Granskning kunde inte rita kedjan: Journal/c.md could not be read");
	});

	it("keeps the English lead-ins under English", async () => {
		// If wrong: an English table that drifted from what shipped differs here.
		const notSet = viewOver({ readiness: () => ({ state: "unconfigured", reason: "No folder." }) });
		await notSet.onOpen();
		expect(notSet.contentEl.textContent).toBe("Review is not set up yet. No folder.");
		const noRead = viewOver({ waiting: async () => { throw new Error("vault closed"); } });
		await noRead.onOpen();
		expect(noRead.contentEl.textContent).toBe("Review could not read your notes: vault closed");
		const noChain = viewOver({});
		await noChain.onOpen();
		expect(chainText(noChain)).toBe("Review could not draw the chain: The chain is not invented here");
	});
});

describe("Review's own fallback reason and the followed-tasks line", () => {
	it("words the fallback reason in each language", () => {
		// If wrong: the fallback stays English under sv.
		expect(reviewWords().unknownReason).toBe("unknown reason");
		setLanguage("sv");
		expect(reviewWords().unknownReason).toBe("okänd orsak");
	});

	it("names the feature Granskning in the Swedish followed-tasks line", () => {
		// If wrong: the line still says "Review kunde inte läsa…".
		setLanguage("sv");
		expect(reviewWords().followedUnreadable("gone")).toBe("Granskning kunde inte läsa de följda uppgifterna: gone");
	});
});
