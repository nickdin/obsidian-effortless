/**
 * What the rest of the plugin may reach into this feature for.
 *
 * `main.ts` needs the class and nothing else, and the id is named beside it as
 * date entry names its own. Everything not named here — how a day is read,
 * laid out and drawn, what a density may be — is the feature's own and stays
 * inside it, which is what keeps the feature contract's "no feature references
 * another" cheap to hold.
 */

export { DayView, FEATURE_ID } from "./dayView";
