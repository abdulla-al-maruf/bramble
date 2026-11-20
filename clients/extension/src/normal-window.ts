/// <reference types="chrome" />

import { api } from "./platform-api";
import { POPOUT_ANCHOR_KEY } from "./session-keys";

/**
 * The browser window the user was last in: where the page behind Bramble is, and where a site
 * opened from Bramble belongs. Firefox's getLastFocused ignores windowTypes, so with the pop-out in
 * front it returns the pop-out, and a tab opened there lands inside it. Then the window the pop-out
 * last saw focused stands in (followNormalWindowFocus), else any normal one.
 */
export async function lastNormalWindow(): Promise<chrome.windows.Window | undefined> {
	const last = await api.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => undefined);
	if (last?.type === "normal") return last;
	const stored = await api.storage.session
		.get(POPOUT_ANCHOR_KEY)
		.catch(() => ({}) as Record<string, unknown>);
	const normal = (await api.windows.getAll().catch(() => [])).filter((w) => w.type === "normal");
	return normal.find((w) => w.id === stored[POPOUT_ANCHOR_KEY]) ?? normal[0];
}

/** The web page in that window's active tab. */
export async function pageBehind(): Promise<chrome.tabs.Tab | undefined> {
	const win = await lastNormalWindow();
	if (win?.id === undefined) return undefined;
	const [tab] = await api.tabs.query({ active: true, windowId: win.id }).catch(() => []);
	try {
		return tab?.url && /^https?:$/.test(new URL(tab.url).protocol) ? tab : undefined;
	} catch {
		return undefined;
	}
}

/** In the pop-out: note each normal window the user moves to, for lastNormalWindow. */
export function followNormalWindowFocus(): void {
	api.windows.onFocusChanged.addListener((id) => {
		if (id === api.windows.WINDOW_ID_NONE) return;
		void api.windows
			.get(id)
			.then((win) =>
				win.type === "normal" ? api.storage.session.set({ [POPOUT_ANCHOR_KEY]: id }) : undefined,
			)
			.catch(() => {});
	});
}
