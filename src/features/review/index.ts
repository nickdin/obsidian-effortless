/**
 * What the rest of the plugin may reach into this feature for.
 *
 * `main.ts` needs the class and nothing else, and the id is named beside it as
 * every other feature names its own — everything not named here stays inside
 * the feature, which is what keeps the feature contract's "no feature
 * references another" cheap to hold.
 *
 * **The class and the id only.** The reader of which notes wait
 * (`waitingNotes.ts`) is this feature's own and is imported by path from inside
 * it. `src/__tests__/reviewFeature.test.ts`'s *exports the class and the id
 * from its index and nothing else* holds this file to that.
 */

export { Review, FEATURE_ID } from "./review";
