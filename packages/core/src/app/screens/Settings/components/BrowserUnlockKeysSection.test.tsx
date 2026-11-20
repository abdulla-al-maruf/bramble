/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BrowserUnlockKeysSection } from "./BrowserUnlockKeysSection";

const deleteEntry = vi.fn(async (_id: string) => {});
let unlockKeys: object[] = [];

vi.mock("../../../../hooks/useVault", () => ({
	useVault: () => ({ unlockKeys }),
	useVaultActions: () => ({ deleteEntry }),
}));

afterEach(() => {
	cleanup();
	unlockKeys = [];
	deleteEntry.mockClear();
});

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

const key = (id: string, day: number, userName: string) => ({
	id,
	type: "unlock-key",
	name: "bramble.sh",
	passkey: { rpId: "bramble.sh", userName, createdAt: Date.UTC(2026, 10, day, 12) },
});

function mount() {
	render(
		<I18nProvider i18n={i18n}>
			<BrowserUnlockKeysSection />
		</I18nProvider>,
	);
}

describe("BrowserUnlockKeysSection", () => {
	it("isn't shown until a browser has set up Touch ID through Bramble", () => {
		mount();
		expect(screen.queryByText("Touch ID for your browser")).toBeNull();
	});

	it("lists this Mac's browser unlock keys and removes one", async () => {
		unlockKeys = [key("a", 3, "Vivaldi Work"), key("b", 16, "Brave · Personal")];
		mount();
		expect(screen.getByText("Touch ID for your browser")).toBeTruthy();
		expect(screen.getByText("Vivaldi Work")).toBeTruthy();
		expect(screen.getByText("Added Nov 3, 2026")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Remove Brave · Personal" }));
		expect(screen.getByText(/Remove the key in that browser too/)).toBeTruthy();
		// Under the whole row, not squeezed under the buttons.
		expect(
			screen.getByText(/Remove the key in that browser too/).closest("[role=group]"),
		).toBeNull();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Remove" }));
		});
		expect(deleteEntry).toHaveBeenCalledWith("b");
	});

	// Keys set up before the extension named them all carry "vault@local".
	it("falls back to the date for a key with no name", () => {
		unlockKeys = [key("a", 3, "vault@local")];
		mount();
		expect(screen.queryByText(/vault@local/)).toBeNull();
		expect(screen.getByRole("button", { name: "Remove the key added Nov 3, 2026" })).toBeTruthy();
	});
});
