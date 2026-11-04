/**
 * What the rest of the plugin may reach into this feature for.
 *
 * **The class and the id only**, the rule Task consistency's own
 * `index.ts` keeps and says why: everything not named here stays inside the feature,
 * which is what keeps the feature contract's "no feature references another"
 * cheap to hold.
 *
 * Files in this folder as #855
 * laid them out, and as #856
 * filled them in: `migration.ts` (the class, its readiness, its slice and the
 * command), `types.ts` (the id, the settings type and its default),
 * `filable.ts` (`checkFilable`; it re-exports `sectionOfLine`, which lives in
 * `src/core/vaultLayout.ts`), `fileInto.ts` (`linesToWrite`,
 * `placeInCollection`, `freezeInLog`, `fileInto`), `marker.ts`
 * (`newMigrationId`, `hashOfLine`, `writeMarker`) and `chooser.ts`
 * (`CollectionChooser`). There is no `settingsPanel.ts`: the feature has
 * nothing to answer on its card, so the card shows only the switch and the
 * description. A later ticket that needs a row adds one beside these.
 */

export { Migration } from "./migration";
export { FEATURE_ID } from "./types";
