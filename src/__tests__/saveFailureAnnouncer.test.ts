import { beforeEach, describe, expect, it } from "vitest";
// The stub is imported by path rather than as "obsidian": `tsc` checks this
// file against the real API, and only vitest redirects that name.
import { Notice, resetSettings } from "./__mocks__/obsidian";
import { announceFailedSave, createSaveFailureAnnouncer } from "../core/saveFailureAnnouncer";

/*
 * The announcer on its own, away from any screen. What the settings screen and
 * the calendar section do with it is driven through them, in their own files;
 * this one is about the rule the two of them share.
 */
describe("the one sentence for a setting that would not save", () => {
	beforeEach(() => {
		resetSettings();
		Notice.messages = [];
	});

	it("names what went wrong at the end of the sentence", () => {
		announceFailedSave(new Error("the vault is read-only"));

		expect(Notice.messages).toEqual([
			"Effortless: that setting could not be saved. the vault is read-only",
		]);
	});
});

describe("announcing a failed deferred write once for the run", () => {
	beforeEach(() => {
		resetSettings();
		Notice.messages = [];
	});

	it("says one failed run once, however many callers bring it the same promise", () => {
		const announce = createSaveFailureAnnouncer();
		// One run of the store's deferred write, handed to two callers — which
		// is what the core card's boxes and a calendar row are holding when a
		// run of typing crosses from one to the other.
		const run = Promise.reject(new Error("the vault is read-only"));
		void run.catch(() => undefined);

		announce(run, new Error("the vault is read-only"));
		announce(run, new Error("the vault is read-only"));

		expect(Notice.messages).toEqual([
			"Effortless: that setting could not be saved. the vault is read-only",
		]);
	});

	it("says a later run as well, because a later run is a different write", () => {
		const announce = createSaveFailureAnnouncer();
		const first = Promise.reject(new Error("first"));
		const second = Promise.reject(new Error("second"));
		void first.catch(() => undefined);
		void second.catch(() => undefined);

		announce(first, new Error("the vault is read-only"));
		announce(second, new Error("no space left on device"));

		expect(Notice.messages).toHaveLength(2);
		expect(Notice.messages[1]).toContain("no space left on device");
	});

	it("holds the run rather than counting, so an old run stays announced", () => {
		// The promise is the run's name (#186's mechanism). A second call from
		// the run already spoken about is skipped whatever has happened since,
		// which a counter or a one-shot flag could not both do.
		const announce = createSaveFailureAnnouncer();
		const first = Promise.reject(new Error("first"));
		const second = Promise.reject(new Error("second"));
		void first.catch(() => undefined);
		void second.catch(() => undefined);

		announce(first, new Error("one"));
		announce(second, new Error("two"));
		announce(second, new Error("two"));

		expect(Notice.messages).toHaveLength(2);
	});

	it("gives each screen its own, so one screen does not silence the next", () => {
		const run = Promise.reject(new Error("the vault is read-only"));
		void run.catch(() => undefined);

		createSaveFailureAnnouncer()(run, new Error("the vault is read-only"));
		createSaveFailureAnnouncer()(run, new Error("the vault is read-only"));

		expect(Notice.messages).toHaveLength(2);
	});
});
