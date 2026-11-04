// Obsidian's own checker, the rules the community directory's automated review
// runs (`docs/research/obsidian-publishing-requirements.md` § 1). `npm run lint`
// runs it with no warning allowed, so a regression shows on the next run rather
// than at submission. Every rule switched off below says why beside it;
// the directory's review still runs its own copy of the rules, so a switch-off
// here quiets this repository's run, not that review.
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
// The rule's own list, which a `brands` option replaces rather than extends.
// Not exported from the package's entry, so imported by path; a release that
// moves it fails this file's import loudly.
import { DEFAULT_BRANDS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js";

export default defineConfig([
	// Tests are not published, and the directory's scanner skips `*.test.*`;
	// `.claude/` is agent tooling for this repository, never part of the plugin;
	// `docs/prototypes/` holds throwaway prototypes, plain JavaScript a drive
	// loads as it stands, never shipped; `scripts/` is development
	// tooling run in Node, the release export among them, never shipped.
	{ ignores: ["node_modules/**", "main.js", "src/__tests__/**", ".claude/**", "docs/prototypes/**", "scripts/**"] },
	...obsidianmd.configs.recommended,
	{ languageOptions: { parserOptions: { projectService: { allowDefaultProject: ["eslint.config.*", "*.mjs", "*.mts"] } } } },
	{
		files: ["src/**/*.ts"],
		rules: {
			// Proper names and literal patterns, not sentences: iCloud and Apple
			// Account are brands, Review is a feature's name, YYYY-MM-DD is a date
			// pattern and "x" a checkbox's own character.
			"obsidianmd/ui/sentence-case": [
				"warn",
				{
					enforceCamelCaseLower: true,
					brands: [...DEFAULT_BRANDS, "iCloud", "Apple Account"],
					ignoreWords: ["Review"],
					ignoreRegex: ["YYYY-MM-DD", "^x$"],
				},
			],
		},
	},
	{
		// The build scripts run in Node at build time and are never shipped.
		files: ["esbuild.config.mjs", "version-bump.mjs"],
		languageOptions: { globals: { process: "readonly" } },
		rules: { "obsidianmd/no-nodejs-modules": "off" },
	},
]);
