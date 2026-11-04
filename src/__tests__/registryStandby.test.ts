/**
 * What a switched-on feature offers on a device where it stands by: a feature whose
 * job runs on another device is never loaded here, yet a person may still
 * reach for one of its actions here — meeting notes' unplanned meeting, on the
 * phone, while the server builds the days. `Feature.onStandby` is where such a
 * feature registers it, and the core takes it back again.
 *
 * Driven over the real registry, settings store and device store, on the
 * Obsidian stub, the shape `registryHostRoutes.test.ts` uses.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin, Vault as ObsidianVault } from "obsidian";
import { Notice, Plugin, Vault } from "./__mocks__/obsidian";
import { repoRoot } from "./repoRoot";
import { Feature } from "../core/feature";
import type { FeatureHost, Readiness } from "../core/feature";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore } from "../core/settings";

/** Stands by unless this device builds the days, and offers one action either way. */
class Offering extends Feature {
	readonly id = "offering";
	readonly name = "Offering";
	readonly description = "Offers one action on every device.";
	loads = 0;
	standbys = 0;
	/** Which route registered the action each press reached: `load` or `standby`. */
	readonly presses: string[] = [];

	readiness(): Readiness {
		return this.host.device.buildsTheDays() ? { state: "ready" } : { state: "standby", reason: "Another device does it." };
	}

	override onload(): void {
		this.loads += 1;
		this.offer("load");
	}

	override onStandby(): void {
		this.standbys += 1;
		this.offer("standby");
	}

	private offer(from: string): void {
		this.host.addCommand({ id: "act", name: "Act", callback: () => this.presses.push(from) });
		this.host.addRibbonIcon?.("star", "Act", () => this.presses.push(from));
	}
}

async function build(buildsTheDays: boolean): Promise<{ plugin: Plugin; registry: FeatureRegistry; device: DeviceStore; feature: () => Offering }> {
	const plugin = new Plugin();
	plugin.load();
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
	device.save({ buildsTheDays });
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections: { all: () => [], at: () => null }, problems: new Problems(), device },
		new NoteWriter(new Vault() as unknown as ObsidianVault, { path: () => null, onChange: () => undefined }),
		{ meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} },
	);
	let feature: Offering | undefined;
	registry.register("offering", (host: FeatureHost) => (feature = new Offering(host)));
	return { plugin, registry, device, feature: () => feature! };
}

/** Presses the command the palette holds and the icon the bar shows, as a person would. */
function pressBoth(plugin: Plugin): void {
	for (const command of plugin.commands) command.callback?.();
	for (const icon of plugin.ribbonIcons) icon.el.click();
}

describe("a switched-on feature standing by on this device", () => {
	beforeEach(() => {
		Notice.messages = [];
		document.body.innerHTML = "";
		const styles = document.createElement("style");
		styles.textContent = readFileSync(join(repoRoot, "styles.css"), "utf8");
		document.head.appendChild(styles);
	});

	it("offers what onStandby registers, and both answer", async () => {
		const { plugin, registry, feature } = await build(false);
		registry.start();

		expect(registry.statuses()[0].state).toBe("standby");
		expect(feature().loads).toBe(0);
		expect(plugin.commands.map((command) => command.id)).toEqual(["effortless:act"]);
		expect(plugin.ribbonIcons.map((icon) => icon.title)).toEqual(["Act"]);
		pressBoth(plugin);
		expect(feature().presses).toEqual(["standby", "standby"]);
	});

	it("takes both back when the feature is switched off", async () => {
		const { plugin, registry, feature } = await build(false);
		registry.start();
		const icon = plugin.ribbonIcons[0]?.el;

		await registry.setEnabled("offering", false);

		expect(plugin.commands).toEqual([]);
		expect(plugin.ribbonIcons).toEqual([]);
		icon?.click();
		expect(feature().presses).toEqual([]);
	});

	it("is never asked of a feature switched off", async () => {
		const { plugin, registry, feature } = await build(false);
		await registry.setEnabled("offering", false);
		registry.start();

		expect(feature().standbys).toBe(0);
		expect(plugin.commands).toEqual([]);
	});

	it("asks it once however often readiness is asked again", async () => {
		const { plugin, registry, feature } = await build(false);
		registry.start();

		registry.recheckReadiness();
		registry.recheckReadiness();

		expect(feature().standbys).toBe(1);
		expect(plugin.commands).toHaveLength(1);
	});

	it("swaps the standby offer for onload's when this device takes the job, with no double", async () => {
		const { plugin, registry, device, feature } = await build(false);
		registry.start();

		device.save({ buildsTheDays: true });
		registry.recheckReadiness();

		expect(feature().loads).toBe(1);
		expect(plugin.commands).toHaveLength(1);
		expect(plugin.ribbonItems.filter((item) => item.title === "Act")).toHaveLength(1);
		pressBoth(plugin);
		expect(feature().presses).toEqual(["load", "load"]);
	});

	it("offers it again in the same pass when this device gives the job away", async () => {
		const { plugin, registry, device, feature } = await build(true);
		registry.start();
		expect(feature().loads).toBe(1);

		device.save({ buildsTheDays: false });
		registry.recheckReadiness();

		expect(registry.statuses()[0].state).toBe("standby");
		expect(feature().standbys).toBe(1);
		expect(plugin.commands).toHaveLength(1);
		pressBoth(plugin);
		expect(feature().presses).toEqual(["standby", "standby"]);
	});
});
