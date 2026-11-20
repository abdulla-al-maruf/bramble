import type { Page } from "@playwright/test";
import { createVault, expect, PW, test } from "./fixtures";

// A 2FA setup link handed to Bramble (Set Up Codes In on iOS and macOS, Android's chooser).
// Here for the mobile SPA this suite already serves: the arrival flow and the setup screen are
// shared @core code, and the SPA takes links the way the iOS and Android apps do, as Capacitor's
// `appUrlOpen`. macOS delivers through the Tauri shell instead (src-tauri/src/otpauth.rs), which
// a browser cannot reach. See docs/totp-uri-handler.md.

const LINK = "otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub";

/** What the OS does when the user opens a setup link: Capacitor's App plugin raises appUrlOpen. */
async function openLink(page: Page, url = LINK): Promise<void> {
	await page.evaluate(async (url) => {
		const app = (window as unknown as { Capacitor: { Plugins: Record<string, unknown> } }).Capacitor
			.Plugins.App as { notifyListeners: (event: string, data: unknown) => Promise<void> };
		await app.notifyListeners("appUrlOpen", { url });
	}, url);
}

async function lock(page: Page): Promise<void> {
	await page.getByRole("button", { name: "Lock vault", exact: true }).click();
	await expect(page.getByRole("button", { name: "Unlock Vault" })).toBeVisible();
}

async function unlock(page: Page): Promise<void> {
	await page.locator('input[type="password"]').first().fill(PW);
	await page.getByRole("button", { name: "Unlock Vault" }).click();
}

const setupScreen = (page: Page) => page.getByRole("heading", { name: "Add 2FA code" });

/** A fresh mobile vault. The welcome screen renders after the page loads, and createVault only
 * clicks through it if it is already there. */
async function freshVault(page: Page): Promise<void> {
	await page.getByRole("button", { name: /Create your vault/i }).click();
	await createVault(page);
	await expect(page.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible();
}

test("a setup link saves on one tap, and the same link opens again after a lock", async ({
	mobile,
}) => {
	const { page } = mobile;
	await freshVault(page);

	await openLink(page);
	await expect(setupScreen(page)).toBeVisible();
	await expect(page.getByText("GitHub · octocat")).toBeVisible();
	// Nothing in the vault matches, so it opens on a new login named from the key.
	await expect(page.getByRole("button", { name: "New login", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue("GitHub");
	await page.getByRole("button", { name: "Save new login" }).click();
	await expect(page.getByText("Saved GitHub with its 2FA code")).toBeVisible();
	await expect(page.getByRole("button", { name: "Open GitHub", exact: true })).toBeVisible();

	// The field report: lock, open the same link, unlock, and nothing was offered.
	await lock(page);
	await openLink(page);
	await unlock(page);
	await expect(setupScreen(page)).toBeVisible();

	// Now a login matches: it opens there, and replacing the login's key asks first, in the row.
	await expect(page.getByRole("button", { name: "Existing login", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await page.getByRole("button", { name: "Replace the 2FA code in GitHub" }).click();
	await expect(page.getByText("Replace its code?")).toBeVisible();
	await page.getByRole("button", { name: "Replace", exact: true }).click();
	await expect(page.getByText("2FA code added to GitHub")).toBeVisible();
	await expect(page.getByText("Verification code (TOTP)")).toBeVisible();
});

test("the same link opened twice without a lock offers it twice", async ({ mobile }) => {
	const { page } = mobile;
	await freshVault(page);

	await openLink(page);
	await expect(setupScreen(page)).toBeVisible();
	await page.getByRole("button", { name: "Go back" }).click();
	await expect(setupScreen(page)).toHaveCount(0);

	await openLink(page);
	await expect(setupScreen(page)).toBeVisible();
});
