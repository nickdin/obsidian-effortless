# Releasing

The rules for cutting a release of Effortless. Settled by issue #31; the evidence behind the version-number half is `docs/research/plugin-version-conventions.md`, and the submission mechanics are `docs/research/obsidian-publishing-requirements.md`.

The tooling already exists and nothing here is about it: `npm version` runs `version-bump.mjs`, which writes `manifest.json` and appends to `versions.json`, and `.github/workflows/release.yml` cuts a **draft** GitHub release on a pushed tag and refuses a tag that disagrees with the manifest. It runs the test suite before it builds, so a red suite stops the draft being cut at all — the tag is the one moment the plugin becomes installable, and every guard this repo has is a test.

## The rule that constrains what a release may contain

**While the plugin has no way to speak to the user, a release must not require the user to do anything.** No re-entering a setting, no rebinding a hotkey, no manual step of any kind.

This is not a preference. Obsidian shows a user a version number and an "Update" button and nothing else — no release notes, no changelog, no "what's new" (`plugin-version-conventions.md` § 1, inferred from a complete-looking help page rather than a stated denial). Obsidian shows a changelog link for updates to *itself* and deliberately has no counterpart for plugins. So a release note reaches only the people who go to GitHub on purpose, and a required manual step shipped in one would silently break the vaults of everyone who did not.

The constraint lifts when the plugin gains a way to tell the user something in-app — an Excalidraw-style "what's new" panel is the obvious form, and is a possible later feature rather than part of this spec. Until then, a change that would need a manual step is not ready to ship.

**A high-severity review finding does not stop a push to `main`, but it does stop a release.** Decided 2026-09-07: `/work-the-board` pushes every wave whatever its reviews found, because nothing installs from `main` and the finding is a ticket either way. The day a release is cut is when those tickets matter: before tagging, list the open issues that a review filed as high severity, and either fix each one or name it in the release note. A release that ships a known high finding silently is the thing this line exists to prevent.

## What makes a release due

**A change worth a stranger having.** Not a rhythm, not a filled bucket. Nothing is on a clock, which is map decision 4 applied one size up.

**The call is the author's alone.** Strangers can open issues on the public copy; a report is information and never a trigger.

**One carve-out:** a fix for something that loses or damages a note ships on its own, immediately, without waiting to be worth anyone's while.

## What the numbers mean

The plugin ships at **0.1.0** and stays on 0.x.

`0.MINOR.PATCH`:

- **The leading 0 never moves.** It is not a placeholder waiting to be promoted — it is a continuous statement. Semantic Versioning's clause 4: *"Major version zero (0.y.z) is for initial development. Anything MAY change at any time. The public API SHOULD NOT be considered stable."* Moving it means making the opposite promise, and that promise is not one this plugin wants to make while features are still arriving.
- **The minor number carries anything a user would notice** — a new feature, changed behaviour, a reshaped settings screen. This includes a change that makes someone re-do something by hand: that fact goes in the first line of the release note, not into the number. (Under the strict three-slot reading such a change would move the major number, which would put the plugin at 1.0 on the day of a settings rename rather than the day it is finished.)
- **The patch number is fixes only.**

**There is deliberately no trigger for 1.0**, and 0.x indefinitely is a fine outcome rather than a failure to finish. It costs nothing: 31.9% of the whole community directory has a latest release under 1.0.0, Dataview is the third most-installed plugin in existence at 0.5.68, and Day Planner — this niche's incumbent — is at 0.35.1 (`plugin-version-conventions.md` § 2, all 100 top manifests fetched). Nothing in Obsidian's submission rules or its scanner looks at the version number beyond `x.y.z` and the tag matching the manifest (§ 3). A later session must not invent a 1.0 milestone and start working towards it.

## `minAppVersion`

Today `1.13.0`, the floor `ConfirmationModal` sets: it is the dialog that asks before an ordinary note becomes a collection, and it does not exist in older Obsidian. It rose from `1.11.4`, which `app.secretStorage` set for a calendar account's password; `versions.json` keeps an older Obsidian on the last build its floor allowed. The lowest floor the plugin could ever have is `1.7.2`, which `Plugin.removeCommand` sets. `apiFloors` in `src/__tests__/sourceGuards.ts` lists every Obsidian API that raises it, and `manifest.test.ts` fails when the manifest claims less.

**It rises only when the plugin genuinely cannot work on the older version**, never for convenience. Raising it is invisible to the person it happens to: Obsidian silently stops offering them updates and leaves them on the last version that still fits, with no message. When it does rise, two things happen in the same commit — the reason goes in the release note, and `versions.json` gains the mapping, which is what leaves the stranded user a working older build instead of nothing.

## The public copy

**Every release is cut from an exported copy, never from the author's working repository.** That repository and its tracker stay private for good; the public repository is the release copy, and each release is exported into it. The export runs before every release:

1. `node scripts/release-export/export-release.mjs <commit> <output-folder>`, with the commit to be released and a folder that does not exist yet. It copies the commit's shipped files, leaving out the working repository's record (`LEFT_OUT` in `scripts/release-export/shipped.mjs` is the list); deletes every parenthesis that holds only tracker references; turns every remaining tracker link into a plain number; and adds a README paragraph saying what those numbers, and the left-out files the code cites, point at. Then it runs its gate, and writes nothing if the copy still holds a tracker link, the author's name outside `LICENSE` and `manifest.json`, or a real calendar name, or holds a file that is not text, which the gate cannot read, unless that file is named in `NOT_TEXT_SHIPPED` beside `LEFT_OUT`.
2. In the output folder, `npm ci && npm run build && npm test` must all pass.
3. Only then does the copy go to the public repository, where the tag is pushed and the release workflow cuts the draft.

**A refusal is fixed here, in the source, and the export run again** — never by editing the output, which the next export would overwrite. The gate also runs over the working tree in every test run (`scripts/release-export/__tests__/exportRelease.test.mjs`), so a refusal on release day means a test here was already failing.

## Release notes

**Written into the GitHub draft release, in a few plain lines. No `CHANGELOG.md`** — a changelog file is a second copy of the same sentences that drifts out of step with the first.

The audience is the small number of people who look at the repository, and the author three months later working out when something changed. Per the rule at the top of this file, a release note can never be the only place something important is said.
