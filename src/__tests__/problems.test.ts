/**
 * The standing-problem channel.
 *
 * The rule this file exists to hold down is the one a later reader would
 * otherwise get wrong: **one notice per standing key, never one per affected
 * item**. A feature that finds twelve orphaned tasks makes one call naming
 * twelve, and a feature that re-detects the same breakage on every vault
 * change must not raise a second notice for it — a key that is already
 * standing speaks once, however its message moves afterwards.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Notice } from "./__mocks__/obsidian";
import { withoutComments } from "./sourceGuards";
import { Problems, gatedProblems } from "../core/problems";

describe("Problems", () => {
	beforeEach(() => {
		Notice.messages = [];
	});

	it("raises one notice at the moment a problem is first reported", () => {
		const problems = new Problems();

		problems
			.forFeature("pairing", "Pairing")
			.report("House/Garden.md", "House/Garden.md no longer carries your tasks heading.");

		expect(Notice.messages).toEqual([
			"Effortless: House/Garden.md no longer carries your tasks heading.",
		]);
	});

	it("raises one notice for a report naming twelve tasks, not twelve notices", () => {
		const problems = new Problems();

		// The feature counts the tasks itself and reports once. Nothing here
		// loops over them, and nothing here may be given the chance to.
		problems
			.forFeature("pairing", "Pairing")
			.report("House/Garden.md", "12 tasks in House/Garden.md are no longer paired.");

		expect(Notice.messages).toHaveLength(1);
		expect(problems.all()).toHaveLength(1);
	});

	it("stays quiet while the same problem is reported again and again", () => {
		const problems = new Problems();
		const pairing = problems.forFeature("pairing", "Pairing");

		// A feature re-checks on every vault change, so the same breakage is
		// reported many times over. It was announced once already.
		for (let i = 0; i < 5; i += 1) pairing.report("House/Garden.md", "12 tasks are no longer paired.");

		expect(Notice.messages).toHaveLength(1);
		expect(problems.all()).toHaveLength(1);
	});

	it("stays quiet when a standing key breaks differently, and still updates the line", () => {
		const problems = new Problems();
		const pairing = problems.forFeature("pairing", "Pairing");

		// The count is the message here, and a pairing feature re-checks on
		// every vault change, so this pair of calls is what one unfixed
		// breakage looks like over an afternoon. It is one event, so it is one
		// notice — spec #32 § 10. The settings screen still gets the new
		// wording; `settingsTab.test.ts` holds that end.
		pairing.report("House/Garden.md", "12 tasks are no longer paired.");
		pairing.report("House/Garden.md", "27 tasks are no longer paired.");

		expect(Notice.messages).toEqual(["Effortless: 12 tasks are no longer paired."]);
		expect(problems.all().map((p) => p.message)).toEqual(["27 tasks are no longer paired."]);
	});

	it("speaks up again when a cleared problem comes back", () => {
		const problems = new Problems();
		const pairing = problems.forFeature("pairing", "Pairing");

		pairing.report("House/Garden.md", "12 tasks are no longer paired.");
		pairing.clear("House/Garden.md");
		pairing.report("House/Garden.md", "12 tasks are no longer paired.");

		expect(Notice.messages).toHaveLength(2);
	});

	it("keeps the problem standing until the feature clears it", () => {
		const problems = new Problems();
		const pairing = problems.forFeature("pairing", "Pairing");

		pairing.report("House/Garden.md", "12 tasks are no longer paired.");
		expect(problems.all()).toEqual([
			{
				featureId: "pairing",
				featureName: "Pairing",
				key: "House/Garden.md",
				message: "12 tasks are no longer paired.",
			},
		]);

		pairing.clear("House/Garden.md");
		expect(problems.all()).toEqual([]);
	});

	it("clears the one thing named and leaves the rest standing", () => {
		const problems = new Problems();
		const pairing = problems.forFeature("pairing", "Pairing");

		pairing.report("House/Garden.md", "Garden broke.");
		pairing.report("Work/Roof.md", "Roof broke.");
		pairing.clear("House/Garden.md");

		expect(problems.all().map((p) => p.key)).toEqual(["Work/Roof.md"]);
	});

	it("clearing something that was never reported changes nothing and says nothing", () => {
		const problems = new Problems();
		const pairing = problems.forFeature("pairing", "Pairing");

		pairing.report("Work/Roof.md", "Roof broke.");
		Notice.messages = [];
		pairing.clear("House/Garden.md");

		expect(problems.all().map((p) => p.key)).toEqual(["Work/Roof.md"]);
		expect(Notice.messages).toEqual([]);
	});

	it("keeps two features apart even when they use the same key", () => {
		const problems = new Problems();

		problems.forFeature("pairing", "Pairing").report("House/Garden.md", "Pairing broke.");
		problems.forFeature("rollover", "Rollover").report("House/Garden.md", "Rollover broke.");
		problems.forFeature("pairing", "Pairing").clear("House/Garden.md");

		expect(problems.all().map((p) => p.featureId)).toEqual(["rollover"]);
	});

	it("clears everything one feature reported and nothing another did", () => {
		const problems = new Problems();
		const pairing = problems.forFeature("pairing", "Pairing");

		pairing.report("House/Garden.md", "Garden broke.");
		pairing.report("Work/Roof.md", "Roof broke.");
		problems.forFeature("rollover", "Rollover").report("Work/Roof.md", "Rollover broke.");

		pairing.clearAll();

		expect(problems.all().map((p) => p.featureId)).toEqual(["rollover"]);
	});

	it("lists problems oldest first, and re-reporting one does not move it", () => {
		const problems = new Problems();
		const pairing = problems.forFeature("pairing", "Pairing");

		pairing.report("House/Garden.md", "Garden broke.");
		pairing.report("Work/Roof.md", "Roof broke.");
		pairing.report("House/Garden.md", "Garden broke worse.");

		expect(problems.all().map((p) => p.key)).toEqual(["House/Garden.md", "Work/Roof.md"]);
	});

	it("imports `Notice` from `obsidian` and nothing else, so it holds no route to a note", () => {
		// This is the guard on the module docstring's "Nothing is ever written
		// into a note". Driving it is not available: `Problems` takes no host,
		// so there is no vault to inject and nothing to assert was left
		// untouched. What can be measured is that the file never reaches one,
		// by reading it — the same source-reading shape `platform.test.ts` and
		// `manifest.test.ts` already use. It fails the day someone writes
		// `import { Vault } from "obsidian";` at the top of it.
		//
		// It says less than its old form promised. Listing the handle's three
		// property names said nothing about what those properties close over: a
		// `report` holding a vault passed it unchanged.
		//
		// **What it proves is that the module imports no route to a note**, and
		// that is short of the whole of the docstring's claim. A route arriving
		// as a structurally-typed parameter — a caller handing in an object that
		// happens to carry a vault — is not an import and is not seen here. No
		// import-reading guard can close that, and `Problems` takes no host, so
		// that gap cannot be driven either. The limit is written down rather
		// than solved.
		//
		// The parse reads the file with its comments gone, so a commented-out
		// import is not counted as one, and it takes an import however it is
		// spelled: any of the three quote styles, with or without the trailing
		// semicolon, and with the names list broken across lines. Nothing here
		// enforces one spelling — `npm run lint` is `tsc --noEmit` alone, with
		// no formatter behind it — so a guard reading one spelling is a guard
		// anyone can step past by accident.
		const source = readFileSync(resolve(__dirname, "..", "core", "problems.ts"), "utf8");

		const written = /^import\s+(?:([^;"'`]+?)\s+from\s+)?["'`]([^"'`]+)["'`]/gm;
		const imports = [...withoutComments(source).matchAll(written)].map(([, names, from]) => ({
			// One spelling, whatever was written: whitespace runs collapse and a
			// trailing comma before the closing brace goes, so a names list
			// broken across lines reads as the one-line form does.
			names: (names ?? "").replace(/\s+/g, " ").replace(/,\s*}$/, " }").trim(),
			from,
		}));

		expect(imports).toEqual([{ names: "{ Notice }", from: "obsidian" }]);
		// A dynamic import or a `require` would reach a vault without ever
		// appearing in the list above. This one reads the file as written and
		// not with its comments gone: it was already the stricter of the two,
		// and nothing in this ticket is a reason to relax it.
		expect(source).not.toMatch(/\brequire\s*\(|\bimport\s*\(/);
	});
});

describe("being told when the standing problems change", () => {
	beforeEach(() => {
		Notice.messages = [];
	});

	// The store's half of
	// #132: a reader that
	// draws once and then sits there needs telling. What the screen does with
	// that is `settingsTab.test.ts`'s.
	it("says so when a problem arrives", () => {
		const problems = new Problems();
		let told = 0;
		problems.onChange(() => (told += 1));

		problems.forFeature("pairing", "Pairing").report("House/Garden.md", "Garden broke.");

		expect(told).toBe(1);
	});

	it("says nothing when the same breakage is reported again", () => {
		const problems = new Problems();
		const pairing = problems.forFeature("pairing", "Pairing");
		pairing.report("House/Garden.md", "Garden broke.");
		let told = 0;
		problems.onChange(() => (told += 1));

		// A feature re-checks on every vault change, so this arrives over and
		// over. Redrawing the settings screen each time would be the redraw the
		// person is typing into.
		pairing.report("House/Garden.md", "Garden broke.");

		expect(told).toBe(0);
	});

	it("says so when the same key breaks differently", () => {
		const problems = new Problems();
		const pairing = problems.forFeature("pairing", "Pairing");
		pairing.report("House/Garden.md", "Garden broke.");
		let told = 0;
		problems.onChange(() => (told += 1));

		pairing.report("House/Garden.md", "Garden broke worse.");

		expect(told).toBe(1);
	});

	it("says so when a problem is cleared, which is the direction nothing else reports", () => {
		const problems = new Problems();
		const pairing = problems.forFeature("pairing", "Pairing");
		pairing.report("House/Garden.md", "Garden broke.");
		let told = 0;
		problems.onChange(() => (told += 1));

		// There is no notice for "it is well again". The screen is the only
		// place that says so, so this is the message it cannot do without.
		pairing.clear("House/Garden.md");

		expect(told).toBe(1);
	});

	it("says nothing when clearing something that was never standing", () => {
		const problems = new Problems();
		let told = 0;
		problems.onChange(() => (told += 1));

		problems.forFeature("pairing", "Pairing").clear("House/Garden.md");

		expect(told).toBe(0);
	});

	it("says so once when a feature clears everything it reported", () => {
		const problems = new Problems();
		const pairing = problems.forFeature("pairing", "Pairing");
		pairing.report("House/Garden.md", "Garden broke.");
		pairing.report("Work/Roof.md", "Roof broke.");
		let told = 0;
		problems.onChange(() => (told += 1));

		pairing.clearAll();

		expect(told).toBe(1);
	});

	it("says nothing when a feature clears everything and had reported nothing", () => {
		const problems = new Problems();
		problems.forFeature("rollover", "Rollover").report("Work/Roof.md", "Roof broke.");
		let told = 0;
		problems.onChange(() => (told += 1));

		problems.forFeature("pairing", "Pairing").clearAll();

		expect(told).toBe(0);
	});

	it("stops telling a listener that has dropped out, and counts what is left", () => {
		const problems = new Problems();
		let told = 0;
		const stop = problems.onChange(() => (told += 1));
		expect(problems.listenerCount()).toBe(1);

		stop();
		problems.forFeature("pairing", "Pairing").report("House/Garden.md", "Garden broke.");

		expect(told).toBe(0);
		expect(problems.listenerCount()).toBe(0);
	});

	it("lets a listener drop itself while it is being told", () => {
		const problems = new Problems();
		const pairing = problems.forFeature("pairing", "Pairing");
		let told = 0;
		const stop = problems.onChange(() => {
			told += 1;
			stop();
		});

		pairing.report("House/Garden.md", "Garden broke.");
		pairing.clear("House/Garden.md");

		expect(told).toBe(1);
		expect(problems.listenerCount()).toBe(0);
	});
});

// #199 — the settings screen redraws from inside a notification it may provoke.
describe("a listener that reports while it is being told", () => {
	it("is not given a nested round of calls, so a varying message terminates", () => {
		const problems = new Problems();
		const channel = problems.forFeature("pairing", "Pairing");
		let calls = 0;
		problems.onChange(() => {
			calls += 1;
			// A different message every time. `report`'s early return only
			// catches a repeat of the same one, so nothing else stops this.
			channel.report("House/Garden.md", `${calls} tasks are no longer paired.`);
		});

		channel.report("Work/Roof.md", "3 tasks in Work/Roof.md are no longer paired.");

		expect(calls).toBe(1);
	});

	it("still terminates for a listener repeating one message", () => {
		const problems = new Problems();
		const channel = problems.forFeature("pairing", "Pairing");
		let calls = 0;
		problems.onChange(() => {
			calls += 1;
			channel.report("House/Garden.md", "12 tasks in House/Garden.md are no longer paired.");
		});

		channel.report("Work/Roof.md", "3 tasks in Work/Roof.md are no longer paired.");

		expect(calls).toBe(1);
	});

	it("records the problem reported from inside the round, and only skips announcing it", () => {
		const problems = new Problems();
		const channel = problems.forFeature("pairing", "Pairing");
		problems.onChange(() => {
			channel.report("House/Garden.md", "12 tasks in House/Garden.md are no longer paired.");
		});

		channel.report("Work/Roof.md", "3 tasks in Work/Roof.md are no longer paired.");

		expect(problems.all().map((problem) => problem.key)).toContain("House/Garden.md");
	});

	// What the copy is actually for. Self-removal is not it: a `Set` already
	// tolerates deleting the element it is visiting, so the self-removal test
	// above — "lets a listener drop itself while it is being told" — passes
	// whether `announce()` iterates a copy or the live set. That is the
	// only one above: its neighbour, "stops telling a listener that has dropped
	// out, and counts what is left", drops the listener *before* the round
	// rather than during it, so the copy is not in play there at all.
	// Registering from inside the round is the case that separates them, and it
	// is the one the guard was written against — an announcement that grows its
	// own audience mid-round is the unbounded shape.
	it("does not tell a listener registered from inside the round, and tells it at the next change", () => {
		const problems = new Problems();
		const channel = problems.forFeature("pairing", "Pairing");
		let latecomerCalls = 0;
		let registered = false;
		problems.onChange(() => {
			if (registered) return;
			registered = true;
			problems.onChange(() => {
				latecomerCalls += 1;
			});
		});

		channel.report("House/Garden.md", "12 tasks in House/Garden.md are no longer paired.");

		expect(latecomerCalls).toBe(0);
		expect(problems.listenerCount()).toBe(2);

		// Delayed, not dropped: the next real change is a round it was there
		// for, and it is told exactly once.
		channel.report("Work/Roof.md", "3 tasks in Work/Roof.md are no longer paired.");

		expect(latecomerCalls).toBe(1);
	});

	// The `try`/`finally` in `announce()`. Without it the guard stays on after
	// a listener throws and nothing is ever announced again.
	it("goes on announcing after a listener throws, so the guard is not left stuck on", () => {
		const problems = new Problems();
		const channel = problems.forFeature("pairing", "Pairing");
		let told = 0;
		const stopThrowing = problems.onChange(() => {
			throw new Error("the settings screen fell over");
		});
		problems.onChange(() => {
			told += 1;
		});

		expect(() =>
			channel.report("House/Garden.md", "12 tasks in House/Garden.md are no longer paired."),
		).toThrow("the settings screen fell over");
		expect(told).toBe(0);

		stopThrowing();
		channel.report("Work/Roof.md", "3 tasks in Work/Roof.md are no longer paired.");

		expect(told).toBe(1);
	});
});

describe("a channel gated by a rule", () => {
	beforeEach(() => {
		Notice.messages = [];
	});

	it("asks the rule again on every call, so one handle answers for how things stand now", () => {
		// The whole reason this is a wrapper and not an early return. The
		// registry hands a feature one of these and the feature keeps it for
		// life, across being switched off and on again.
		const problems = new Problems();
		let speaking = false;
		const gated = gatedProblems(
			() => problems.forFeature("pairing", "Pairing"),
			() => speaking,
		);

		gated.report("House/Garden.md", "12 tasks in House/Garden.md are no longer paired.");
		expect(problems.all()).toEqual([]);

		speaking = true;
		gated.report("House/Garden.md", "12 tasks in House/Garden.md are no longer paired.");

		expect(problems.all().map((problem) => problem.key)).toEqual(["House/Garden.md"]);
	});

	it("drops a refused call silently, and never builds a channel for it", () => {
		// The channel is a function because the caller may have nothing to build
		// one from yet. A refused call must not be the thing that finds that out.
		const problems = new Problems();
		let built = 0;
		const gated = gatedProblems(
			() => {
				built += 1;
				return problems.forFeature("pairing", "Pairing");
			},
			() => false,
		);

		gated.report("House/Garden.md", "12 tasks in House/Garden.md are no longer paired.");
		gated.clear("House/Garden.md");
		gated.clearAll();

		expect(built).toBe(0);
		expect(problems.all()).toEqual([]);
		expect(Notice.messages).toEqual([]);
	});

	it("lets a rule that throws reach the caller, on all three members alike", () => {
		// How the registry refuses a feature that reports while it is still
		// being built: one rule, thrown from one place, rather than a guard
		// repeated member by member.
		const problems = new Problems();
		const gated = gatedProblems(
			() => problems.forFeature("pairing", "Pairing"),
			() => {
				throw new Error("still being built");
			},
		);

		expect(() => gated.report("House/Garden.md", "12 tasks are no longer paired.")).toThrow(
			"still being built",
		);
		expect(() => gated.clear("House/Garden.md")).toThrow("still being built");
		expect(() => gated.clearAll()).toThrow("still being built");
		expect(problems.all()).toEqual([]);
	});

	it("passes a permitted clear and clearAll through to the channel it is given", () => {
		const problems = new Problems();
		const gated = gatedProblems(
			() => problems.forFeature("pairing", "Pairing"),
			() => true,
		);
		gated.report("House/Garden.md", "12 tasks in House/Garden.md are no longer paired.");
		gated.report("Work/Roof.md", "3 tasks in Work/Roof.md are no longer paired.");

		gated.clear("House/Garden.md");
		expect(problems.all().map((problem) => problem.key)).toEqual(["Work/Roof.md"]);

		gated.clearAll();
		expect(problems.all()).toEqual([]);
	});
});
