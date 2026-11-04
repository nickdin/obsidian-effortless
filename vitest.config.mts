import { defineConfig } from "vitest/config";

// The daysAhead feature and the calendar reader are the two places the suite
// reads a local-midnight boundary two ways at once (`window.ts:11-17`,
// `desiredRows.ts:124-132`, `icsReader.ts:199-223`), so their tests are the
// ones a wrong-offset defect can reach. Every other test file is
// timezone-agnostic and keeps running once.
// Globs rather than a hand-typed list: a ninth `daysAheadRun*`/`daysAheadRows*`
// file, or another `icsReader*` test file, added later joins both zone runs on
// its own, and a rename cannot leave a listed path that no longer matches
// anything — Vitest reports nothing for a path that has gone. The three globs
// match nine files today: eight `daysAheadRows*`/`daysAheadRun*` files and
// `icsReader.test.ts`. `daysAheadFeature.test.ts` is
// deliberately outside them: it builds no `Date` and carries no zone
// dependency. `calendarSources.ts:764`'s `readDayLosing` call and the day
// view's now-line reach the same boundary through `icsReader.ts` and through
// local-getter comparisons already exercised elsewhere; neither adds a boundary
// computation of its own, so neither is in this list.
const ZONE_SENSITIVE_TESTS = [
	"src/__tests__/daysAheadRows*.test.ts",
	"src/__tests__/daysAheadRun*.test.ts",
	"src/__tests__/icsReader*.test.ts",
];

export default defineConfig({
	test: {
		environment: "jsdom",
		// Vitest 4.1.11 starts one worker per core minus one by default (11 on the server, as
		// #1106 measured; `getDefaultThreadsCount`,
		// `node_modules/vitest/dist/chunks/cli-api.CnMVyzaz.js:2353-2356`). A board
		// wave runs several workers at once, each running this whole suite under
		// jsdom, and on 2026-10-11 the server reached load average 131 and the run
		// died. Four holds one suite to a share of the machine. Set at the root so
		// all three projects below share the one cap. A board tab's
		// `VITEST_MAX_WORKERS` still overrides this, so the cap matters for suites
		// run outside a tab, such as a session opened while a run is on.
		maxWorkers: 4,
		// The real `obsidian` module only exists inside the running app, so tests
		// resolve it to a stub. See src/__tests__/__mocks__/obsidian.ts for what
		// the stub does and does not cover.
		alias: {
			obsidian: new URL("src/__tests__/__mocks__/obsidian.ts", import.meta.url).pathname,
		},
		// Split into projects rather than one pin: #717/#718 showed that a single
		// negative-offset pin (`America/New_York`) can catch a defect that only
		// shows west of Greenwich, but nothing caught the mirror case — a defect
		// that only shows at a positive offset, the zone the author's own machines
		// and vault actually run in (`Europe/Stockholm`). Issue #722 opened that
		// gap for the daysAhead files, and issue #741 widened it to the calendar
		// reader. The tests named by `ZONE_SENSITIVE_TESTS` are the ones that touch
		// the local-midnight boundary these two zones cross in opposite
		// directions, so they run once per zone; the rest of the suite carries no
		// zone dependency and keeps running once, under the same negative-offset
		// pin #717 chose.
		projects: [
			{
				extends: true,
				test: {
					name: "suite (America/New_York)",
					include: ["src/__tests__/**/*.test.ts"],
					exclude: ZONE_SENSITIVE_TESTS,
					env: { TZ: "America/New_York" },
				},
			},
			{
				extends: true,
				test: {
					name: "zone-sensitive (America/New_York)",
					include: ZONE_SENSITIVE_TESTS,
					env: { TZ: "America/New_York" },
				},
			},
			{
				extends: true,
				test: {
					name: "zone-sensitive (Europe/Stockholm)",
					include: ZONE_SENSITIVE_TESTS,
					env: { TZ: "Europe/Stockholm" },
				},
			},
			{
				// The release export's own tests. `scripts/` is development
				// tooling and is left out of the public copy the export makes, so
				// there this project matches no file and runs nothing.
				extends: true,
				test: {
					name: "release export",
					include: ["scripts/**/*.test.mjs"],
					environment: "node",
				},
			},
		],
	},
});
