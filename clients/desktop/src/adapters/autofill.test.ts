import { PREF_AUTOFILL_QUICKTYPE } from "@core/hooks/usePrefs";
import type { IndexEntry } from "@core/index";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, meta, encrypt } = vi.hoisted(() => ({
	invoke: vi.fn(async (_cmd: string, _args?: unknown) => {}),
	meta: new Map<string, unknown>(),
	encrypt: vi.fn(async (plaintext: string) => ({ iv: "IV", ciphertext: plaintext })),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../sync/roster", () => ({ ACTIVE_VAULT_KEY: "active-vault" }));
vi.mock("./crypto", () => ({ desktopCrypto: { encryptWithVek: encrypt } }));
vi.mock("./storage", () => ({
	desktopStorage: {
		getMeta: async (k: string) => meta.get(k),
		readVaultBlob: async () => {
			throw new Error("no vault stored");
		},
	},
}));

const { desktopAutofill } = await import("./autofill");

const login = {
	type: "login",
	id: "e1",
	name: "GitHub",
	username: "me@example.com",
	password: "pw",
	hostnames: ["github.com"],
} as IndexEntry;

const onMac = (yes: boolean) =>
	vi.stubGlobal("navigator", {
		userAgent: yes
			? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
			: "Mozilla/5.0 (X11; Linux x86_64)",
	});

const mirrorCall = () =>
	invoke.mock.calls.find(([cmd]) => cmd === "autofill_provider_set")?.[1] as
		| { mirror: { ciphertext: string; vaultId: string; identities: unknown[] } }
		| undefined;

beforeEach(() => {
	invoke.mockClear();
	encrypt.mockClear();
	meta.clear();
});

describe("desktopAutofill", () => {
	it("mirrors the index for the macOS AutoFill extension", async () => {
		onMac(true);
		meta.set("active-vault", "v1");
		meta.set(PREF_AUTOFILL_QUICKTYPE, true);
		await desktopAutofill.setIndex([login]);
		expect(invoke).toHaveBeenCalledWith("link_set_index", { entries: [login] });
		const m = mirrorCall()?.mirror;
		expect(m?.vaultId).toBe("v1");
		expect(JSON.parse(m?.ciphertext ?? "[]")[0]).toMatchObject({ recordId: "e1", password: "pw" });
		expect(m?.identities).toEqual([
			{ recordId: "e1", username: "me@example.com", service: "github.com" },
		]);
	});

	it("keeps the browser link when the mirror fails", async () => {
		onMac(true);
		encrypt.mockRejectedValueOnce(new Error("locked"));
		await expect(desktopAutofill.setIndex([login])).resolves.toBeUndefined();
		expect(invoke).toHaveBeenCalledWith("link_set_index", { entries: [login] });
	});

	it("does nothing for the provider off macOS", async () => {
		onMac(false);
		await desktopAutofill.setIndex([login]);
		expect(mirrorCall()).toBeUndefined();
		expect(encrypt).not.toHaveBeenCalled();
	});

	it("clears the mirror when the vault is deleted", async () => {
		await desktopAutofill.clearProviderData?.();
		expect(invoke).toHaveBeenCalledWith("autofill_provider_clear");
	});

	it("gives the AutoFill extension the unlock key but never the browser link", async () => {
		onMac(true);
		const unlock = {
			type: "unlock-key",
			id: "u",
			passkey: {
				credentialId: "Y2lk",
				rpId: "bramble.sh",
				userHandle: "dWg=",
				alg: -7,
				privateKey: "sk",
			},
		} as unknown as IndexEntry;
		await desktopAutofill.setIndex([login, unlock]);
		expect(invoke).toHaveBeenCalledWith("link_set_index", { entries: [login] });
		const m = mirrorCall()?.mirror as unknown as { passkeyIdentities: { rpId: string }[] };
		expect(m.passkeyIdentities.map((p) => p.rpId)).toEqual(["bramble.sh"]);
	});
});
