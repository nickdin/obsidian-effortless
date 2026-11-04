/**
 * What the rest of the plugin may reach into this feature for.
 *
 * `main.ts` needs the class and nothing else, and the id is named beside it as
 * every other feature names its own — everything not named here stays inside
 * the feature, which is what keeps the feature contract's "no feature
 * references another" cheap to hold.
 *
 * **The class and the id only.** #696's
 * row policy sits in this same folder — `desiredRows.ts`, `matchKey.ts`,
 * `mergeMeetings.ts`, `rowMemory.ts` — and is **not** re-exported here.
 * #698's run is its only
 * caller and imports it by path, from inside the feature. Widening this file
 * to a barrel was tried at the merge of 2026-09-20 and reverted, because it
 * would make four pure functions part of what the rest of the plugin may
 * reach in for. `src/__tests__/daysAheadFeature.test.ts`'s *exports the class
 * and the id from its index and nothing else* is what holds it to that.
 */

export { DaysAhead, FEATURE_ID } from "./daysAhead";
