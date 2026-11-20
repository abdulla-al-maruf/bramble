import { i18n } from "@lingui/core";
import { beforeAll, describe, expect, it } from "vitest";
import { pendingPasskeyToast } from "./pending-passkey-toast";

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

describe("pendingPasskeyToast", () => {
	it("names the login a site's passkey went to", () => {
		expect(pendingPasskeyToast("create", "login", "GitHub")).toBe("Passkey saved as GitHub");
		expect(pendingPasskeyToast("attach", "login", "GitHub")).toBe("Passkey added to GitHub");
	});

	it("says the browser's Touch ID was saved, never naming bramble.sh", () => {
		expect(pendingPasskeyToast("create", "unlock-key", "bramble.sh")).toBe(
			"Touch ID for your browser is set up",
		);
	});
});
