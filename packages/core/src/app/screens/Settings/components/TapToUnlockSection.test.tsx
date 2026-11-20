/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../../../context/PlatformContext";
import { TapToUnlockSection } from "./TapToUnlockSection";

const registerWebauthnKey = vi.fn(async () => {});
let keys: {
	slotIdB64: string;
	label: string;
	addedAt: number;
	kind: string;
	synced: boolean;
	heldByBramble?: true;
}[] = [];

vi.mock("../../../../hooks/useVault", () => ({
	useVault: () => ({ webauthnKeys: keys, registerWebauthnKey, revokeWebauthnKey: vi.fn() }),
}));
vi.mock("../../../../hooks/usePrefs", () => ({
	usePrefs: () => ({ prefs: { biometricAutoPrompt: false }, update: vi.fn() }),
}));
vi.mock("../../../../hooks/useVaultRegistry", () => ({
	useVaultRegistry: () => ({
		vaults: [{ id: "v1", label: "Personal", number: 1 }],
		activeId: "v1",
	}),
}));
vi.mock("../../../../util/device-label", () => ({ browserName: () => "Firefox" }));
vi.mock("../../../hooks/useWebauthnHandoff", () => ({
	useWebauthnHandoff: () => ({ mustHandOff: false, handOff: vi.fn() }),
}));

afterEach(() => {
	cleanup();
	keys = [];
	registerWebauthnKey.mockClear();
});

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

async function mount() {
	const platform = { target: "chromium" } as unknown as Platform;
	await act(async () => {
		render(
			<I18nProvider i18n={i18n}>
				<PlatformProvider platform={platform}>
					<TapToUnlockSection />
				</PlatformProvider>
			</I18nProvider>,
		);
	});
}

describe("TapToUnlockSection, a key Bramble Desktop holds", () => {
	it("says where it lives instead of claiming every device", async () => {
		keys = [
			{
				slotIdB64: "AA==",
				label: "Touch ID",
				addedAt: 1,
				kind: "platform",
				synced: true,
				heldByBramble: true,
			},
		];
		await mount();
		expect(screen.getByText("in Bramble Desktop")).toBeTruthy();
		expect(screen.queryByText("all your devices")).toBeNull();
	});

	it("drops where it lives while asking to remove it, so the name and buttons fit one line", async () => {
		keys = [
			{
				slotIdB64: "AA==",
				label: "Touch ID",
				addedAt: 1,
				kind: "platform",
				synced: true,
				heldByBramble: true,
			},
		];
		await mount();
		fireEvent.click(screen.getByRole("button", { name: "Remove Touch ID" }));
		expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
		expect(screen.queryByText("in Bramble Desktop")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.getByText("in Bramble Desktop")).toBeTruthy();
	});
});

describe("TapToUnlockSection, naming a new key", () => {
	it("names a Touch ID key after this browser and vault when left blank", async () => {
		await mount();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Add" }));
		});
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "This device" }));
		});
		expect(registerWebauthnKey).toHaveBeenCalledWith("Firefox · Personal", "platform");
	});
});
