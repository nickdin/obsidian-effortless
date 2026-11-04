/**
 * What the rest of the plugin may reach into this feature for.
 *
 * `main.ts` needs the class and nothing else, and the id is named beside it
 * as every other feature names its own — everything not named here stays
 * inside the feature, which is what keeps the feature contract's "no feature
 * references another" cheap to hold.
 *
 * **The class and the id only**, the rule `src/features/meetingNotes/index.ts`
 * and `src/features/daysAhead/index.ts` keep and say why.
 */

export { TaskConsistency } from "./taskConsistency";
export { FEATURE_ID } from "./types";
