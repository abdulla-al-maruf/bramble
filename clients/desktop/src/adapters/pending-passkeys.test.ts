import { describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({
	invoke: vi.fn(async (cmd: string, _args?: unknown) =>
		cmd === "autofill_consume_pending_passkeys"
			? [
					{ iv: "IV", ciphertext: JSON.stringify({ credentialId: "a", rpId: "github.com" }) },
					{ iv: "IV", ciphertext: "other-vault" },
				]
			: undefined,
	),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./crypto", () => ({
	desktopCrypto: {
		decryptWithVek: async (_iv: string, ct: string) => {
			if (ct === "other-vault") throw new Error("aead");
			return ct;
		},
	},
}));

const { consumePendingPasskeys } = await import("./pending-passkeys");

describe("consumePendingPasskeys", () => {
	it("takes in what the AutoFill extension created and keeps another vault's", async () => {
		expect(await consumePendingPasskeys()).toEqual([{ credentialId: "a", rpId: "github.com" }]);
		expect(invoke).toHaveBeenCalledWith("autofill_restore_pending_passkeys", {
			keep: [{ iv: "IV", ciphertext: "other-vault" }],
		});
	});
});
