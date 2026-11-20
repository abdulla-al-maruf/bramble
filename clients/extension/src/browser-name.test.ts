import { describe, expect, it } from "vitest";
import { extensionBrowserName } from "./browser-name";

const FIREFOX_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:160.0) Gecko/20100101 Firefox/160.0";
const CHROME_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const firefox = (info: Record<string, unknown>) => ({ getBrowserInfo: async () => info });
const CHROMIUM_PAGE = { vendor: "Google Inc.", userAgentData: {} };

describe("extensionBrowserName", () => {
	it("names Zen, which calls itself Firefox but adds its own field", async () => {
		const zen = firefox({ name: "Firefox", vendor: "Mozilla", zen: { version: "1.24.3b" } });
		expect(await extensionBrowserName(zen, { vendor: "" }, FIREFOX_UA)).toBe("Zen");
	});

	it("takes the name a Firefox fork gives itself", async () => {
		expect(
			await extensionBrowserName(firefox({ name: "LibreWolf" }), { vendor: "" }, FIREFOX_UA),
		).toBe("LibreWolf");
		expect(
			await extensionBrowserName(firefox({ name: "Firefox" }), { vendor: "" }, FIREFOX_UA),
		).toBe("Firefox");
	});

	it("names Orion, which runs either add-on on WebKit behind a borrowed user agent", async () => {
		const page = { vendor: "Apple Computer, Inc." };
		expect(await extensionBrowserName({}, page, FIREFOX_UA)).toBe("Orion");
		expect(await extensionBrowserName({}, page, CHROME_UA)).toBe("Orion");
		// Its service worker has no vendor, and no userAgentData either.
		expect(await extensionBrowserName({}, {}, CHROME_UA)).toBe("Orion");
	});

	it("reads Chromium browsers from the user agent, in a page or a service worker", async () => {
		expect(await extensionBrowserName({}, CHROMIUM_PAGE, CHROME_UA)).toBe("Chrome");
		expect(await extensionBrowserName({}, { ...CHROMIUM_PAGE, brave: {} }, CHROME_UA)).toBe(
			"Brave",
		);
		expect(
			await extensionBrowserName({}, { userAgentData: {} }, `${CHROME_UA} Edg/142.0.0.0`),
		).toBe("Edge");
	});

	it("never calls a Chromium page Orion for lacking userAgentData", async () => {
		expect(await extensionBrowserName({}, { vendor: "Google Inc." }, CHROME_UA)).toBe("Chrome");
	});
});
