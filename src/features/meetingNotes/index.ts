/**
 * What the rest of the plugin may reach into this feature for.
 *
 * `main.ts` needs the class and nothing else, and the id is named beside it as
 * every other feature names its own — everything not named here stays inside
 * the feature, which is what keeps the feature contract's "no feature
 * references another" cheap to hold.
 *
 * **The class and the id only**, the rule `src/features/daysAhead/index.ts`
 * keeps and says why. The template rules and the memory reader in this folder
 * are imported by path from inside the feature.
 * `src/__tests__/meetingNotesFeature.test.ts`'s *exports the class and the id
 * from its index and nothing else* holds it to that.
 */

export { MeetingNotes } from "./meetingNotes";
export { FEATURE_ID } from "./types";
