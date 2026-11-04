// Bundles src/main.ts into the single main.js that Obsidian loads.
//
// `obsidian` is marked external because the app supplies that module at run
// time; bundling it would ship a second copy of the API and break instanceof
// checks against the app's own classes.

import esbuild from "esbuild";

const production = process.argv[2] === "production";

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: ["obsidian"],
	format: "cjs",
	target: "ES2018",
	logLevel: "info",
	sourcemap: production ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
	minify: production,
});

if (production) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
