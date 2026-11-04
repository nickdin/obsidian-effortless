/**
 * Stepping past Review's quiet period in a test.
 *
 * Review recomputes after a vault event — `changed`, `resolved`, `rename`,
 * `delete` — only once the vault has been quiet for {@link VAULT_QUIET_MS}. A
 * test that fires one and reads the count, the line or the list after it calls
 * {@link fakeQuietPeriod} as its first line, so the timeouts are faked too, and
 * {@link quietPassed} after each event. Faking the timeouts also means the test
 * leaves no real timer behind to fire inside a later test: one left behind by
 * an event fired under real timeouts recomputed in whatever test ran next, and
 * raised its notices there.
 *
 * The list then draws in two pieces, the chain and the rows, each behind a
 * yield to the screen, so
 * {@link quietPassed} steps past those yields as well.
 *
 * One copy, imported by every Review suite that needs it, so the period is
 * named in one place. It lives in `src/__tests__/` and is not a `.test.ts`
 * file, so vitest imports it and runs nothing from it.
 */

import { vi } from "vitest";
import { VAULT_QUIET_MS } from "../features/review/review";

/**
 * How far one step reaches a yield a draw sets from inside a step: the fake
 * clock reads a zero-length wait set while it is stepping as one millisecond,
 * so a step of nothing would leave the yield standing.
 */
export const YIELD_STEP_MS = 1;

/** The yields a draw makes after the quiet period: one before the chain, one before the rows. */
const YIELDS_AFTER_QUIET = 2;

/** Fakes the clock, its interval and its timeouts, the clock set to `today`. Call it before Review is started. */
export function fakeQuietPeriod(today: Date): void {
	vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
	vi.setSystemTime(today);
}

/** Steps the faked clock past Review's quiet period and the yields of the draw that follows it, letting the recompute a vault event scheduled run and draw. */
export async function quietPassed(): Promise<void> {
	await vi.advanceTimersByTimeAsync(VAULT_QUIET_MS + YIELDS_AFTER_QUIET * YIELD_STEP_MS + 1);
}
