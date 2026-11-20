/// <reference types="chrome" />

import { browserName, defaultDeviceLabel } from "@core/util/device-label";
import { api } from "./platform-api";

type BrowserInfo = { name?: string; zen?: unknown };
type Runtime = { getBrowserInfo?: () => Promise<BrowserInfo> };
type Nav = { vendor?: string; userAgentData?: unknown; brave?: unknown };

/**
 * The browser's own name, where its user agent borrows another's. Zen and other Firefox forks send
 * Firefox's: getBrowserInfo names a fork that renames itself, and Zen keeps "Firefox" there but adds
 * its own field. Orion runs both add-ons on WebKit behind a Firefox or Chrome user agent: it has
 * neither Firefox's getBrowserInfo nor Chromium's userAgentData, and WebKit names Apple as vendor.
 */
export async function extensionBrowserName(
	runtime: Runtime = api.runtime as Runtime,
	nav: Nav = navigator as Nav,
	ua: string = navigator.userAgent,
): Promise<string> {
	if (typeof runtime.getBrowserInfo === "function") {
		const info = await runtime.getBrowserInfo().catch(() => undefined);
		if (info?.zen) return "Zen";
		if (info?.name && info.name !== "Firefox") return info.name;
		return "Firefox";
	}
	// A service worker has no vendor.
	const webkit = nav.vendor === undefined ? !("userAgentData" in nav) : /^Apple/.test(nav.vendor);
	return webkit ? "Orion" : browserName(ua, nav);
}

/** "Zen on Mac", as the roster and the desktop app list this browser. */
export async function extensionDeviceLabel(): Promise<string> {
	return defaultDeviceLabel(navigator.userAgent, await extensionBrowserName());
}
