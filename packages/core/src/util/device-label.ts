// A coarse, no-prompt default name for this device's roster entry, so a synced
// group lists "Android device" / "Firefox on Mac" instead of every member showing
// the same "This device". Derived from the user agent (a real string in every host:
// the extension popup, the mobile webview). The roster CRDT propagates whatever a
// device stamps for itself, so this is what peers see; "this device" in the UI is
// matched by public key, not by label, so a collision here is only cosmetic.

/**
 * `${os} desktop`, for a native app whose user agent describes its webview rather than itself.
 *
 * A Tauri window on macOS reports as Safari, so the UA path named the desktop app "Browser on
 * Mac", which is both wrong and indistinguishable from an actual browser in the device list.
 */
export function desktopDeviceLabel(ua: string = navigatorUa()): string {
	if (/windows/i.test(ua)) return "Windows desktop";
	if (/linux/i.test(ua)) return "Linux desktop";
	if (/macintosh|mac os x/i.test(ua)) return "Mac desktop";
	return "Desktop app";
}

/**
 * The browser, as far as it says. Brave answers to `navigator.brave`; Vivaldi and Arc pass as
 * Chrome on purpose, so they read as Chrome here.
 */
export function browserName(
	ua: string = navigatorUa(),
	nav: { brave?: unknown } = typeof navigator !== "undefined"
		? (navigator as { brave?: unknown })
		: {},
): string {
	if (/firefox/i.test(ua)) return "Firefox";
	if (/edg\//i.test(ua)) return "Edge";
	if (/opr\//i.test(ua)) return "Opera";
	if (/chrome/i.test(ua)) return nav.brave ? "Brave" : "Chrome";
	if (/safari/i.test(ua)) return "Safari";
	return "Browser";
}

/** `browser` is for a host that knows its name better than its user agent says (the extension). */
export function defaultDeviceLabel(
	ua: string = navigatorUa(),
	browser: string = browserName(ua, {}),
): string {
	if (/android/i.test(ua)) return "Android device";
	if (/iphone/i.test(ua)) return "iPhone";
	if (/ipad/i.test(ua)) return "iPad";
	if (/macintosh|mac os x/i.test(ua)) return `${browser} on Mac`;
	if (/windows/i.test(ua)) return `${browser} on Windows`;
	if (/linux/i.test(ua)) return `${browser} on Linux`;
	return browser === "Browser" ? "This device" : browser;
}

function navigatorUa(): string {
	return typeof navigator !== "undefined" ? navigator.userAgent : "";
}
