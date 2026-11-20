import { Capacitor, registerPlugin } from "@capacitor/core";
import { Device } from "@capacitor/device";
import { PREF_AUTOFILL_QUICKTYPE } from "@core/hooks/usePrefs";
import type { AutofillAdapter } from "@core/index";
import {
	buildProviderMirror,
	type OneTimeCodeIdentity,
	type PasskeyIdentity,
	passwordSlotPayload,
	type QuickTypeIdentity,
	type SlotPayload,
} from "@core/vault/provider-mirror";
import { decodeVaultBlob } from "@core/vault-format";
import { ACTIVE_VAULT_KEY } from "../sync/sync-manager";
import { mobileCrypto } from "./crypto";
import { mobileStorage } from "./storage";
import { onVaultStateChange } from "./vault-session";

// System autofill on mobile is the native iOS Credential Provider extension, not the
// webview. This adapter is the main-app side of that bridge. To keep Bramble's "nothing
// readable without authenticating" guarantee, the ENTIRE login list (names, usernames,
// passwords) is encrypted under the VEK before it is written to the shared App Group, so
// the extension reveals nothing until the user unlocks it. We also share the password
// SLOT (non-secret vault-header data: salt + verifier + the AES-wrapped VEK) so the
// extension can unlock itself with the master password. No cleartext entry data reaches
// the App Group. The OS QuickType identity store (usernames + domains, no passwords) is
// populated ONLY when the user opts into keyboard suggestions; off by default since those
// identities surface before auth. Android autofill is a separate service (not built yet).

interface AutofillBridgePlugin {
	// `iv`/`ciphertext` are encryptWithVek over the JSON login list (see AutofillEntry).
	// `identities`, when present and non-empty, populate the OS QuickType bar; an empty
	// (or omitted) list clears it. `passkeyIv`/`passkeyCiphertext` are encryptWithVek over
	// the JSON passkey list; `passkeyIdentities` register them with the OS credential store.
	sync(o: {
		iv: string;
		ciphertext: string;
		/** The vault this bundle was encrypted for; the extension matches it against the vault
		 * the cached VEK was armed for before offering its fast unlock. */
		vaultId?: string;
		slot?: SlotPayload;
		identities?: QuickTypeIdentity[];
		oneTimeCodeIdentities?: OneTimeCodeIdentity[];
		passkeyIv?: string;
		passkeyCiphertext?: string;
		passkeyIdentities?: PasskeyIdentity[];
	}): Promise<void>;
	clear(): Promise<void>;
	setKeepUnlocked(o: { minutes: number }): Promise<void>;
	/** Ends every keep-unlocked session, so the next fill asks for auth. */
	lock(): Promise<void>;
}

// Normalize a stored hostname to a bare registrable host for QuickType matching
// (lowercase, drop a leading "www."), mirroring the extension's normalizeHost.
const Bridge = registerPlugin<AutofillBridgePlugin>("AutofillBridge");
const isIos = Capacitor.getPlatform() === "ios";

// The password slot from the ACTIVE vault's header, so the extension can run Argon2id and
// unwrap the VEK from the master password. Must be the active vault: setIndex pushes the
// active vault's entries (encrypted under its VEK), so the slot the extension derives the
// VEK from has to belong to the same vault, else master-password unlock yields the wrong
// VEK and can't decrypt the bundle. (readVaultBlob(undefined) falls back to the first/only
// vault, matching sync-manager's activeVaultId.) Non-secret (the wrappedVek stays
// AES-encrypted). Returns undefined for a passwordless vault or an unreadable blob.
async function readPasswordSlot(): Promise<SlotPayload | undefined> {
	try {
		const activeId = await mobileStorage.getMeta<string>(ACTIVE_VAULT_KEY);
		return passwordSlotPayload(decodeVaultBlob(await mobileStorage.readVaultBlob(activeId)));
	} catch {
		return undefined;
	}
}

export const mobileAutofill: AutofillAdapter = {
	async setIndex(entries) {
		if (!isIos) return;
		// QuickType identities (cleartext usernames + domains) only when the user opted in.
		const quickType = (await mobileStorage.getMeta<boolean>(PREF_AUTOFILL_QUICKTYPE)) === true;
		const m = buildProviderMirror(entries, { quickType });
		// Encrypt the whole list under the VEK. The extension can read no entry data
		// (names, usernames, passwords) until the user authenticates and it can decrypt
		// this. Nothing about the vault is in the App Group in cleartext.
		const enc = await mobileCrypto.encryptWithVek(JSON.stringify(m.credentials));
		// Passkeys ride a second VEK-encrypted blob (private keys never at rest in clear).
		const encPk = await mobileCrypto.encryptWithVek(JSON.stringify(m.passkeys));
		await Bridge.sync({
			iv: enc.iv,
			ciphertext: enc.ciphertext,
			// Which vault this bundle was encrypted for. The extension will only offer its cached-VEK
			// unlock when this matches the vault that VEK was armed for; the mirror is un-suffixed and
			// outlives both the vault and the install, so without this it opens onto an aead error.
			vaultId: (await mobileStorage.getMeta<string>(ACTIVE_VAULT_KEY)) ?? "",
			slot: await readPasswordSlot(),
			identities: m.identities,
			oneTimeCodeIdentities: m.oneTimeCodeIdentities,
			passkeyIv: encPk.iv,
			passkeyCiphertext: encPk.ciphertext,
			passkeyIdentities: m.passkeyIdentities,
		});
	},
	async clearIndex() {
		// Deliberately a no-op on iOS. The bundle is VEK-encrypted (unreadable at rest)
		// and must survive app lock so the provider can still unlock + fill on its own.
		// setIndex overwrites it when entries change.
	},
	async clearProviderData() {
		// The vault is gone, so the mirror clearIndex preserves must go with it: bundle,
		// slot, passkeys and the OS identities are otherwise an openable copy of a vault
		// the user deleted. Android keeps no mirror (its service reads the vault file), only the
		// keep-unlocked session.
		if (!isIos) {
			await Bridge.lock();
			return;
		}
		await Bridge.clear();
	},
	async setKeepUnlocked(minutes) {
		// How long the autofill extension may stay unlocked without re-auth. minutes=0
		// disables it and clears any live session. iOS-only.
		if (!isIos) return;
		await Bridge.setKeepUnlocked({ minutes });
	},
	async inlineSuggestionsAvailable() {
		// Gate on OS support, not the active keyboard (iOS always; Android 11+ has the inline API).
		// An inert toggle on a non-inline keyboard beats an undiscoverable one - github #19.
		if (isIos) return true;
		try {
			return ((await Device.getInfo()).androidSDKVersion ?? 0) >= 30;
		} catch {
			return true;
		}
	},
	async query() {
		// The in-webview UI never serves OS autofill; the native provider does.
		return { logins: [], cards: [], otps: [], locked: true, hasPotentialMatch: false };
	},
	async fetchFill() {
		throw new Error("system autofill is handled by the native iOS provider, not the webview");
	},
};

/** Lock the provider whenever the app locks. Returns an unsubscribe. */
export function startAutofillLockSync(): () => void {
	return onVaultStateChange((locked) => {
		if (locked) void Bridge.lock().catch(() => {});
	});
}
