import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
// The stub is imported by path, as `registry.test.ts` does: `tsc` checks this
// file against the real API and only vitest redirects the name "obsidian".
import type {
	App as ObsidianApp,
	Plugin as ObsidianPlugin,
	Vault as ObsidianVault,
	ViewCreator,
} from "obsidian";
import { EmptyView, ItemView, Notice, Plugin, Vault, WorkspaceLeaf } from "./__mocks__/obsidian";
import { repoRoot } from "./repoRoot";
import { Feature } from "../core/feature";
import type { FeatureHost, Readiness } from "../core/feature";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore } from "../core/settings";

/** A view a feature draws: nothing but its type, so a test can tell it from the core's empty one. */
class DrawnView extends ItemView {
	constructor(leaf: WorkspaceLeaf, private readonly type: string, readonly drawnBy: string) {
		super(leaf);
	}
	getViewType(): string {
		return this.type;
	}
	getDisplayText(): string {
		return "drawn";
	}
}

/** A creator for the real API's type: the stub's view and leaf stand in for Obsidian's. */
function drawing(type: string, drawnBy: () => string): ViewCreator {
	return ((leaf: WorkspaceLeaf) => new DrawnView(leaf, type, drawnBy())) as unknown as ViewCreator;
}

/** The three optional members, asserted present once: the registry's own host always supplies them. */
function routesOf(host: FeatureHost) {
	const { addStatusBarItem, addRibbonIcon, registerView } = host;
	if (!addStatusBarItem || !addRibbonIcon || !registerView) {
		throw new Error("the registry's host is missing one of the three routes");
	}
	return {
		addStatusBarItem: () => addStatusBarItem(),
		addRibbonIcon: (icon: string, title: string, callback: (evt: MouseEvent) => unknown) =>
			addRibbonIcon(icon, title, callback),
		registerView: (type: string, creator: ViewCreator) => registerView(type, creator),
	};
}

/** Puts a status-bar item, a ribbon icon and a view type on screen in `onload`. */
class Surfacing extends Feature {
	readonly name = "Surfacing";
	readonly description = "Holds one of each surface.";
	statusBarItem: HTMLElement | undefined;
	ribbonIcon: HTMLElement | undefined;
	loads = 0;
	/** The load each click on the ribbon icon reached, so a stale callback shows as an old number. */
	readonly clicks: number[] = [];

	constructor(
		host: FeatureHost,
		readonly id: string,
		private readonly type: string,
		private readonly throwAfter = false,
	) {
		super(host);
	}

	readiness(): Readiness {
		return { state: "ready" };
	}

	override onload(): void {
		this.loads += 1;
		const routes = routesOf(this.host);
		this.statusBarItem = routes.addStatusBarItem();
		this.ribbonIcon = routes.addRibbonIcon("inbox", `Open ${this.id}`, ((load) => () => this.clicks.push(load))(this.loads));
		routes.registerView(this.type, drawing(this.type, () => `${this.id}#${this.loads}`));
		if (this.throwAfter) throw new Error("could not finish starting");
	}
}

/** Asks for one surface in its constructor, the mistake `addCommand` refuses. */
class Premature extends Feature {
	readonly name = "Premature";
	readonly description = "Reaches a host route while it is being built.";

	constructor(
		host: FeatureHost,
		readonly id: string,
		route: "status-bar" | "ribbon" | "view",
	) {
		super(host);
		const routes = routesOf(host);
		if (route === "status-bar") routes.addStatusBarItem();
		if (route === "ribbon") routes.addRibbonIcon("inbox", "Too early", () => undefined);
		if (route === "view") routes.registerView("too-early", drawing("too-early", () => id));
	}

	readiness(): Readiness {
		return { state: "ready" };
	}
}

async function build(): Promise<{ plugin: Plugin; registry: FeatureRegistry }> {
	const plugin = new Plugin();
	plugin.load();
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{
			settings,
			collections: { all: () => [], at: () => null },
			problems: new Problems(),
			device: new DeviceStore(plugin.app as unknown as ObsidianApp),
		},
		new NoteWriter(new Vault() as unknown as ObsidianVault, { path: () => null, onChange: () => undefined }),
		{ meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} },
	);
	return { plugin, registry };
}

/** Opens a tab on the type, the way a person opening the feature's pane would. */
function openTab(plugin: Plugin, type: string): WorkspaceLeaf {
	const creator = plugin.views.get(type) as ((leaf: WorkspaceLeaf) => ItemView) | undefined;
	if (creator === undefined) throw new Error(`no creator registered for ${type}`);
	const leaf = new WorkspaceLeaf(new EmptyView(null));
	leaf.view = creator(leaf);
	plugin.app.workspace.leaves.push(leaf);
	return leaf;
}

describe("host routes: status-bar item, ribbon icon, view", () => {
	beforeEach(() => {
		Notice.messages = [];
		document.body.innerHTML = "";
		// The ribbon's hiding is a rule in `styles.css`, so the stub reads it from there.
		const styles = document.createElement("style");
		styles.textContent = readFileSync(join(repoRoot, "styles.css"), "utf8");
		document.head.appendChild(styles);
	});

	it("leaves no item, icon or open tab once the feature is switched off", async () => {
		const { plugin, registry } = await build();
		registry.register("surfacing", (host) => new Surfacing(host, "surfacing", "surfacing-list"));
		registry.start();
		openTab(plugin, "surfacing-list");

		// The setup is real: all three are standing before the switch.
		expect(plugin.statusBarItems).toHaveLength(1);
		expect(plugin.ribbonIcons).toHaveLength(1);
		expect(plugin.app.workspace.getLeavesOfType("surfacing-list")).toHaveLength(1);

		await registry.setEnabled("surfacing", false);

		expect(plugin.statusBarItems).toHaveLength(0);
		expect(plugin.ribbonIcons).toHaveLength(0);
		expect(plugin.app.workspace.getLeavesOfType("surfacing-list")).toHaveLength(0);
		expect(plugin.app.workspace.detachedTypes).toContain("surfacing-list");
	});

	it("leaves none of the three when onload throws after registering all of them", async () => {
		const { plugin, registry } = await build();
		registry.register("surfacing", (host) => new Surfacing(host, "surfacing", "surfacing-list", true));
		registry.start();

		expect(registry.statuses()[0]).toMatchObject({ state: "failed", detail: "could not finish starting" });
		expect(plugin.statusBarItems).toHaveLength(0);
		expect(plugin.ribbonIcons).toHaveLength(0);
		expect(plugin.app.workspace.detachedTypes).toContain("surfacing-list");
	});

	it.each([
		["status-bar", "status-bar item"],
		["ribbon", "ribbon icon"],
		["view", "view"],
	] as const)("refuses the %s route from a constructor with addCommand's sentence", async (route, what) => {
		const { plugin, registry } = await build();

		registry.register("premature", (host) => new Premature(host, "premature", route));

		const said = Notice.messages.join("\n");
		expect(said).toContain(`A feature's ${what} cannot be used while the feature is being built.`);
		expect(said).toContain("Use it from onload() onwards");
		expect(plugin.statusBarItems).toHaveLength(0);
		expect(plugin.ribbonIcons).toHaveLength(0);
		expect(plugin.views.size).toBe(0);
	});

	it("leaves a second feature's items and tabs alone when the first is switched off", async () => {
		const { plugin, registry } = await build();
		let second: Surfacing | undefined;
		registry.register("first", (host) => new Surfacing(host, "first", "first-list"));
		registry.register("second", (host) => (second = new Surfacing(host, "second", "second-list")));
		registry.start();
		openTab(plugin, "first-list");
		openTab(plugin, "second-list");

		await registry.setEnabled("first", false);

		expect(plugin.statusBarItems).toEqual([second?.statusBarItem]);
		expect(plugin.ribbonIcons.map((r) => r.el)).toEqual([second?.ribbonIcon]);
		expect(plugin.app.workspace.getLeavesOfType("second-list")).toHaveLength(1);
		expect(plugin.app.workspace.getLeavesOfType("first-list")).toHaveLength(0);
		expect(plugin.app.workspace.detachedTypes).not.toContain("second-list");
	});

	it("hands a switched-on-again feature fresh surfaces without stacking a second creator", async () => {
		const { plugin, registry } = await build();
		let feature: Surfacing | undefined;
		registry.register("surfacing", (host) => (feature = new Surfacing(host, "surfacing", "surfacing-list")));
		registry.start();
		const firstItem = feature?.statusBarItem;

		await registry.setEnabled("surfacing", false);
		await registry.setEnabled("surfacing", true);

		// Obsidian throws on a second claim of one type, so reaching here at all
		// means the core registered the type once; the creator it forwards to
		// is the one from the second `onload`.
		expect(feature?.loads).toBe(2);
		expect(plugin.views.size).toBe(1);
		expect(plugin.statusBarItems).toHaveLength(1);
		expect(plugin.statusBarItems[0]).not.toBe(firstItem);
		expect(plugin.ribbonIcons).toHaveLength(1);
		const leaf = openTab(plugin, "surfacing-list");
		expect((leaf.view as DrawnView).drawnBy).toBe("surfacing#2");
	});

	it("makes an empty tab, not the feature's, for a type whose feature is switched off", async () => {
		const { plugin, registry } = await build();
		registry.register("surfacing", (host) => new Surfacing(host, "surfacing", "surfacing-list"));
		registry.start();
		await registry.setEnabled("surfacing", false);

		// Obsidian restoring a saved layout asks for a tab of the type.
		const leaf = openTab(plugin, "surfacing-list");

		expect(leaf.view).not.toBeInstanceOf(DrawnView);
		expect(leaf.view.getViewType()).toBe("surfacing-list");
		expect((leaf.view as ItemView).getDisplayText()).toBe("");
	});

	it("gives the ribbon icon the title and callback it was asked for", async () => {
		const { plugin, registry } = await build();
		let feature: Surfacing | undefined;
		registry.register("surfacing", (host) => (feature = new Surfacing(host, "surfacing", "surfacing-list")));
		registry.start();

		expect(plugin.ribbonIcons.map((r) => [r.icon, r.title])).toEqual([["inbox", "Open surfacing"]]);
		plugin.ribbonIcons[0]?.el.click();
		expect(feature?.clicks).toEqual([1]);
	});

	it("keeps a switched-off feature's icon out of the bar when another icon redraws it, and its click dead", async () => {
		const { plugin, registry } = await build();
		let feature: Surfacing | undefined;
		registry.register("surfacing", (host) => (feature = new Surfacing(host, "surfacing", "surfacing-list")));
		registry.start();
		const icon = feature?.ribbonIcon;

		await registry.setEnabled("surfacing", false);
		// Another plugin, or another feature, adds an icon: Obsidian redraws the bar.
		plugin.addRibbonIcon("star", "Somebody else's", () => undefined);

		expect(plugin.ribbonIcons.map((r) => r.title)).toEqual(["Somebody else's"]);
		icon?.click();
		expect(feature?.clicks).toEqual([]);
	});

	it("brings the one icon back, with the new callback, when the feature is switched on again", async () => {
		const { plugin, registry } = await build();
		let feature: Surfacing | undefined;
		registry.register("surfacing", (host) => (feature = new Surfacing(host, "surfacing", "surfacing-list")));
		registry.start();
		await registry.setEnabled("surfacing", false);
		plugin.addRibbonIcon("star", "Somebody else's", () => undefined);

		await registry.setEnabled("surfacing", true);
		plugin.addRibbonIcon("star", "Somebody else's, again", () => undefined);

		// One list entry for the feature's action, not a second beside the first.
		expect(plugin.ribbonItems.filter((r) => r.title === "Open surfacing")).toHaveLength(1);
		expect(plugin.ribbonIcons.map((r) => r.title)).toEqual([
			"Open surfacing",
			"Somebody else's",
			"Somebody else's, again",
		]);
		const el = plugin.ribbonIcons[0]?.el;
		expect(el).toBe(feature?.ribbonIcon);
		el?.click();
		expect(feature?.clicks).toEqual([2]);
	});
});
