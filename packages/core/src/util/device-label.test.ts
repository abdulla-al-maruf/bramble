import { describe, expect, it } from "vitest";
import { browserName, defaultDeviceLabel } from "./device-label";

const CHROME_MAC =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

describe("browserName", () => {
	it("tells the browsers apart that say who they are", () => {
		expect(browserName("Mozilla/5.0 (Macintosh) Gecko/20100101 Firefox/145.0", {})).toBe("Firefox");
		expect(browserName(`${CHROME_MAC} Edg/142.0.0.0`, {})).toBe("Edge");
		expect(browserName(`${CHROME_MAC} OPR/124.0.0.0`, {})).toBe("Opera");
		expect(browserName(CHROME_MAC, { brave: {} })).toBe("Brave");
		expect(browserName(CHROME_MAC, {})).toBe("Chrome");
	});

	it("names the device with it", () => {
		expect(defaultDeviceLabel(CHROME_MAC)).toBe("Chrome on Mac");
	});
});

describe("defaultDeviceLabel with the host's own browser name", () => {
	it("keeps the platform from the user agent", () => {
		expect(defaultDeviceLabel(CHROME_MAC, "Orion")).toBe("Orion on Mac");
		expect(
			defaultDeviceLabel(
				"Mozilla/5.0 (X11; Linux x86_64; rv:160.0) Gecko/20100101 Firefox/160.0",
				"Zen",
			),
		).toBe("Zen on Linux");
	});
});
