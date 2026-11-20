// Passkeys the macOS AutoFill extension created: it cannot write the vault, so it leaves them
// VEK-encrypted in the App Group and the app merges them (core's usePendingHandoffs).

import type { PasskeyCredential } from "@core/hooks/useVault";
import { drainHandoff, type EncryptedRecord } from "@core/vault/encrypted-handoff";
import { invoke } from "@tauri-apps/api/core";
import { desktopCrypto } from "./crypto";

export function consumePendingPasskeys(): Promise<PasskeyCredential[]> {
	return drainHandoff(
		{
			consume: async () => ({
				pending: await invoke<EncryptedRecord[]>("autofill_consume_pending_passkeys"),
			}),
			restore: ({ keep }) => invoke<void>("autofill_restore_pending_passkeys", { keep }),
		},
		(iv, ct) => desktopCrypto.decryptWithVek(iv, ct),
		(json) => json as PasskeyCredential,
	);
}
