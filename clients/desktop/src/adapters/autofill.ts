// Desktop autofill. Filling a browser form goes through the paired extension over the local
// socket; auto-type into native apps is phase 5. Both sit behind this adapter, so nothing in
// @core changes when the second one lands. See docs/desktop-port.md.

import type {
	AutofillAdapter,
	FillPayload,
	IndexEntry,
	QueryResult,
} from "@core/adapters/autofill";
import { PREF_AUTOFILL_QUICKTYPE } from "@core/hooks/usePrefs";
import { buildProviderMirror, passwordSlotPayload } from "@core/vault/provider-mirror";
import { decodeVaultBlob } from "@core/vault-format";
import { invoke } from "@tauri-apps/api/core";
import { ACTIVE_VAULT_KEY } from "../sync/roster";
import { desktopCrypto } from "./crypto";
import { desktopStorage } from "./storage";

const onMac = () =>
	typeof navigator !== "undefined" && /Macintosh|Mac OS X/.test(navigator.userAgent);

/**
 * The macOS AutoFill extension's copy of the vault, the iOS mirror's shape: logins and passkeys
 * encrypted under the VEK, the password slot so it can unlock on its own, and the identities
 * the OS lists. See docs/macos-credential-provider.md.
 */
async function mirrorForProvider(entries: IndexEntry[]): Promise<void> {
	const quickType = (await desktopStorage.getMeta<boolean>(PREF_AUTOFILL_QUICKTYPE)) === true;
	const m = buildProviderMirror(entries, { quickType, includeUnlockKeys: true });
	const enc = await desktopCrypto.encryptWithVek(JSON.stringify(m.credentials));
	const encPk = await desktopCrypto.encryptWithVek(JSON.stringify(m.passkeys));
	const vaultId = (await desktopStorage.getMeta<string>(ACTIVE_VAULT_KEY)) ?? "";
	const slot = await desktopStorage
		.readVaultBlob(vaultId || undefined)
		.then((blob) => passwordSlotPayload(decodeVaultBlob(blob)))
		.catch(() => undefined);
	await invoke<void>("autofill_provider_set", {
		mirror: {
			iv: enc.iv,
			ciphertext: enc.ciphertext,
			vaultId,
			slot,
			passkeyIv: encPk.iv,
			passkeyCiphertext: encPk.ciphertext,
			identities: m.identities,
			oneTimeCodeIdentities: m.oneTimeCodeIdentities,
			passkeyIdentities: m.passkeyIdentities,
		},
	});
}

export const desktopAutofill: AutofillAdapter = {
	// @core already pushes on unlock and clears on lock, which is exactly when the browser
	// link's answers should start and stop being available, so no new plumbing was needed to
	// keep the two in step. The index goes to the Rust side rather than staying in this
	// window: the socket is served there, and a window the user closed must not take the
	// browser link down with it.
	setIndex: async (entries) => {
		// The browser link never sees the unlock key; the AutoFill extension below does.
		await invoke<void>("link_set_index", {
			entries: entries.filter((e) => e.type !== "unlock-key"),
		});
		// A failed mirror must not take the browser link with it; the next change retries.
		if (onMac())
			await mirrorForProvider(entries).catch((e) => console.warn("[autofill] mirror:", e));
	},
	// The mirror stays on lock, as on iOS: it is VEK-encrypted, and the extension unlocks on its own.
	clearIndex: () => invoke<void>("link_clear_index"),
	clearProviderData: () => invoke<void>("autofill_provider_clear"),

	query: async (): Promise<QueryResult> => ({
		logins: [],
		cards: [],
		otps: [],
		locked: false,
		hasPotentialMatch: false,
	}),

	fetchFill: (): Promise<FillPayload> => {
		throw new Error("Autofill is not wired on desktop yet");
	},
};
