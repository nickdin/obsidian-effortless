/**
 * What the core builds once, in one object.
 *
 * `main.ts` builds five things at start-up — the settings store, the feature
 * registry, the per-device store, the collections index and the standing
 * problems. The other four are built first and handed to the registry, which is
 * built from them; the settings screen is then handed those four with the
 * registry added. So the registry is not handed all five and is never handed
 * itself. What matters is that the four are *the same instances* in both.
 * A second collections index is a second pair of vault subscriptions that
 * answers separately and does the work twice; a second problems
 * store is one the features never report into, so the settings screen draws
 * nothing for ever and nothing says why.
 *
 * A positional parameter list could not say that. Handing the settings screen a
 * freshly built `CollectionsIndex` type-checked perfectly, and the rule survived
 * as a comment on the constructor and a prose note in `main.test.ts`. Naming the
 * five together puts the rule in one checkable place and makes a transposition a
 * compiler error, which is the whole reason this type exists — not tidiness.
 *
 * **It names the invariant; it does not hold it.** `CoreParts` ties its
 * `registry` field to nothing, so a `CoreParts` carrying a registry built out of
 * entirely different instances type-checks perfectly — `openTab` in
 * `settingsTab.test.ts` builds exactly that, deliberately. `main.ts` is still
 * where the invariant is kept, and what checks it is `main.test.ts`'s "builds
 * one collections index, not one for the screen and one for the features", which
 * starts the plugin and counts one `changed` subscription and one `rename`.
 *
 * A factory taking {@link SharedParts} and returning `CoreParts` with the
 * registry it built from them would hold it, and is deliberately not written: it
 * has to call `new FeatureRegistry`, so this file would exist at run time, and
 * everything that imports it would pull `registry.ts` in behind it — and behind
 * that `obsidian`, `feature`, `problems` and `reason`. What it buys is a
 * guarantee over five lines of `main.ts` that a test already counts.
 *
 * Hosting that factory in `registry.ts` instead does avoid that — that file
 * defines `FeatureRegistry` and is a runtime module already — and it is refused
 * for a second reason. A factory only *offers* the guarantee. TypeScript is
 * structural, so an object literal of the same shape is still a `CoreParts`;
 * holding it means branding this type so the factory is its only minter. That
 * brand meets four `CoreParts` literals in the whole tree. Three of them are the
 * third argument to `new EffortlessSettingTab` in `settingsTab.test.ts` — the
 * `openTab` and `openTabWithDaysAhead` helpers, and the "is built from a plain
 * collections object" test, which builds its own tab — and each is satisfied by
 * one `as unknown as CoreParts`, the escape those same lines already use for
 * `ObsidianApp` and `ObsidianPlugin`. The fourth is
 * `const parts: CoreParts = { ...built, registry };` in `main.ts`, and it is the
 * one a cast must not satisfy: casting production code past the brand would
 * defeat the brand, whose whole point is that the settings screen and the
 * registry are handed the same object. That literal would go through the factory
 * instead, which is the guarantee the brand buys rather than a price it charges.
 * The brand does not reach the `emptyRegistry` and `registryOf`
 * helpers at all, which are cast to `FeatureRegistry` rather than to
 * `CoreParts`. So the refusal rests on what the brand buys rather than on what
 * it costs, because the cost is small and stays small: the `openTab` and
 * `openTabWithDaysAhead` helpers would carry one cast each, and every test that
 * opens its tab through them — nearly all of them — would pay nothing further.
 * Only a test that builds its own tab pays again, and there is one of those
 * today, the "is built from a plain collections object" test.
 *
 * What the brand buys is the part that does not hold up. A factory can only
 * promise that the registry inside a `CoreParts` was built from the four parts
 * beside it. The hazard the invariant exists for is a second collections index,
 * and `main.ts` could still hand that factory a freshly built one while the
 * index it made a few lines earlier sits subscribed — two pairs of vault
 * subscriptions, and the brand silent. `main.test.ts`'s "builds one collections
 * index" is what catches that, and it would still be needed with the brand in
 * place. A narrower guarantee, bought without retiring the test that gives the
 * wider one, is the wrong trade — and #198 is a ticket about constructor arity,
 * not about branding a type.
 *
 * **#198's third acceptance criterion was re-judged on that price and stays
 * unticked.** It reads "`FeatureRegistry` is given the same object, so the tab
 * and the registry cannot be handed different instances", and neither half is
 * true of this code: `main.ts` gives the registry `built` and gives the settings
 * screen a different object spread from it, and nothing in either type stops the
 * two holding different instances. What the criterion was reaching for is
 * delivered instead by the paragraph headed **It names the invariant** above —
 * `main.ts` is where the rule is kept, `main.test.ts` is what checks it —
 * written down rather than claimed, which is how
 * #268 closed its half of
 * the same argument. Reopening the question is a decision rather than a
 * discovery: someone deciding the compile-time guarantee is worth having even
 * though it leaves the double-index hazard exactly where it is. Worth knowing
 * while deciding that `npm run lint` is `tsc --noEmit`, so a brand would be held
 * by a command that runs, while `npm test` alone would not see it.
 *
 * **Not `Core`.** `CoreSettings` in `settings.ts` means the *stored* core
 * settings, so a bare `Core` holding live objects would read as its sibling.
 * `GLOSSARY.md` defines *the core* as everything two features must agree on, and
 * this is the built form of exactly that.
 *
 * Every import here is a type import, `FeatureRegistry` among them, so nothing
 * in this file exists at run time and nothing that imports it reaches
 * `registry.ts` through it. That is the state a factory here would end.
 */

import type { Collections } from "./collections";
import type { Problems } from "./problems";
import type { FeatureRegistry } from "./registry";
import type { DeviceStore, SettingsStore } from "./settings";

/**
 * The parts the feature registry and the settings screen both hold.
 *
 * Shared *instances*, not a shared shape: a second collections index or a
 * second problems store type-checks perfectly and is the whole hazard. Naming
 * them together is what lets one object be handed to both.
 */
export interface SharedParts {
	/** The single `data.json`. The only writer of it (`GLOSSARY.md`, *the core*). */
	readonly settings: SettingsStore;
	/**
	 * Which notes are collections. The interface rather than `CollectionsIndex`:
	 * what is asked of it is `all()` and `at()`, and the feature host, the
	 * registry and the settings screen all take the interface.
	 */
	readonly collections: Collections;
	/** What the features say is wrong and that stays said. */
	readonly problems: Problems;
	/** The answers that stay on this device and are never synced. */
	readonly device: DeviceStore;
}

/**
 * Everything the core builds once, which is what the settings screen is given.
 *
 * The registry is one of the parts, so it cannot itself be handed the finished
 * bundle — it takes {@link SharedParts}, and `main.ts` passes it the same parts
 * it then builds the full bundle from. Not the same object: `{ ...built,
 * registry }` builds a new one, so `parts === built` is false and a write to one
 * is not seen by the other. What both hold is the same *instances*, and that is
 * the thing being guaranteed.
 */
export interface CoreParts extends SharedParts {
	/** The features and the switch on each one. */
	readonly registry: FeatureRegistry;
}
