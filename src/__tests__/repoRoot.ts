/**
 * The one place a test finds this repository's own root folder.
 *
 * **The form, and the reason for it.** The path is built with `resolve` from
 * `__dirname` — this file sits in `src/__tests__/`, so the root is two folders
 * up — and it therefore answers the same thing whatever the working directory
 * is. `fixtures.ts` carries the full argument for that form, including the
 * `new URL(…, import.meta.url)` shape to avoid; this module applies it rather
 * than restating it.
 *
 * **What it replaced.** Thirty reads across thirteen files — twelve suites and
 * `sourceGuards.ts`, the helper they share — resolved a repository file from
 * the working directory instead: `resolve(process.cwd(), …)`, or a bare
 * relative path, which means the same thing. `npm test` from the repository
 * root was the only way the suite was ever run, so nothing was broken for a
 * person; run from anywhere else, fourteen of the thirty test files failed with
 * `ENOENT`. Where it bit is the per-worker git worktree these waves use. It did
 * **not** bite in CI: `.github/workflows/release.yml` is the only workflow, it
 * runs `npm test` with no `working-directory`, and a step's working directory is
 * the checkout root — so `process.cwd()` was already the repository root on
 * every CI run. Nothing automated starts the suite from anywhere else, which
 * means nothing would notice this being undone.
 *
 * **Two shapes, and this module is only one of them.** A repository-root file —
 * `manifest.json`, `GLOSSARY.md`, `styles.css` — is `resolve(repoRoot, name)`. A
 * single source file under `src/core/` is written inline instead, as
 * `resolve(__dirname, "..", "core", "<name>.ts")`, which is what
 * `collections.test.ts` and `problems.test.ts` already did and is one folder
 * rather than a round trip through the root.
 *
 * It lives in `src/__tests__/` and is not a `.test.ts` file, so vitest imports
 * it and runs nothing from it. Both whole-tree walks skip a folder named
 * `__tests__` and nothing else, so a helper outside it would be read as shipped
 * source and would fail the platform guard on its own `node:path` import — the
 * same reason `sourceGuards.ts` gives for sitting here.
 */

import { resolve } from "node:path";

/** This repository's root folder, as an absolute path. */
export const repoRoot = resolve(__dirname, "..", "..");
