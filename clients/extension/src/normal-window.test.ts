import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

const ANCHOR = "popout.anchorWindowId";
const NONE = -1;
const POPOUT = { id: 9, type: "popup" };
const A = { id: 1, type: "normal" };
const B = { id: 2, type: "normal" };

/** A browser whose getLastFocused names `last` (Firefox ignores windowTypes, so it can be the
 *  pop-out), with `windows` open and `tabs` per window. */
async function browserWith({
	last,
	windows = [A, POPOUT, B],
	anchor,
	tabs = {},
}: {
	last?: { id: number; type: string };
	windows?: { id: number; type: string }[];
	anchor?: number;
	tabs?: Record<number, string>;
}) {
	const session: Record<string, unknown> = anchor === undefined ? {} : { [ANCHOR]: anchor };
	let onFocus: (id: number) => void = () => {};
	vi.stubGlobal("chrome", {
		windows: {
			WINDOW_ID_NONE: NONE,
			getLastFocused: vi.fn(async () => {
				if (!last) throw new Error("No last-focused window");
				return last;
			}),
			getAll: vi.fn(async () => windows),
			get: vi.fn(async (id: number) => windows.find((w) => w.id === id)),
			onFocusChanged: { addListener: (fn: (id: number) => void) => (onFocus = fn) },
		},
		tabs: {
			query: vi.fn(async ({ windowId }: { windowId: number }) =>
				tabs[windowId] ? [{ id: windowId * 10, url: tabs[windowId] }] : [],
			),
		},
		storage: {
			session: {
				get: vi.fn(async (key: string) => (key in session ? { [key]: session[key] } : {})),
				set: vi.fn(async (items: Record<string, unknown>) => Object.assign(session, items)),
			},
		},
	});
	const mod = await import("./normal-window");
	const focus = async (id: number) => {
		onFocus(id);
		await new Promise((r) => setTimeout(r, 0));
	};
	return { ...mod, session, focus };
}

describe("lastNormalWindow", () => {
	it("takes the browser's answer when it is a normal window", async () => {
		const { lastNormalWindow } = await browserWith({ last: B, anchor: A.id });
		expect(await lastNormalWindow()).toBe(B);
	});

	it("takes the window the pop-out last saw, when Firefox names the pop-out", async () => {
		const { lastNormalWindow } = await browserWith({ last: POPOUT, anchor: B.id });
		expect(await lastNormalWindow()).toBe(B);
	});

	it("takes any normal window once that one has closed", async () => {
		const { lastNormalWindow } = await browserWith({ last: POPOUT, anchor: 77 });
		expect(await lastNormalWindow()).toBe(A);
	});

	it("is undefined with no normal window open", async () => {
		const { lastNormalWindow } = await browserWith({ windows: [POPOUT] });
		expect(await lastNormalWindow()).toBeUndefined();
	});
});

describe("pageBehind", () => {
	it("is the active tab of the window the user was last in", async () => {
		const { pageBehind } = await browserWith({
			last: POPOUT,
			anchor: B.id,
			tabs: { 1: "https://a.example/", 2: "https://b.example/login" },
		});
		expect((await pageBehind())?.url).toBe("https://b.example/login");
	});

	it("is undefined when that tab isn't a web page, rather than another window's", async () => {
		const { pageBehind } = await browserWith({
			last: B,
			tabs: { 1: "https://a.example/", 2: "about:newtab" },
		});
		expect(await pageBehind()).toBeUndefined();
	});
});

describe("followNormalWindowFocus", () => {
	it("notes normal windows only", async () => {
		const { followNormalWindowFocus, session, focus } = await browserWith({ anchor: A.id });
		followNormalWindowFocus();
		await focus(B.id);
		expect(session[ANCHOR]).toBe(B.id);
		await focus(POPOUT.id);
		await focus(NONE);
		expect(session[ANCHOR]).toBe(B.id);
	});
});
