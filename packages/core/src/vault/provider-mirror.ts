// What an OS credential provider (the iOS AutoFill extension, the macOS one) is handed: the
// logins and passkeys to encrypt under the VEK, and the metadata-only identities the OS lists.
// One builder so both apps mirror the same thing. See docs/macos-credential-provider.md.

import type { IndexEntry } from "../adapters/autofill";
import type { PasskeyPrfSecrets } from "../adapters/crypto";
import type { PasskeyCredential } from "../hooks/useVault";
import { bytesToBase64 } from "../util/bytes";
import { findPasswordSlot, type VaultBlob, verifierPrefix } from "../vault-format";
import { isReservedRpId } from "./reserved-rp";

export interface ProviderCredential {
	recordId: string;
	name: string;
	username: string;
	password: string;
	services: string[];
	subdomainMatch?: string;
	totp?: string;
}

export interface QuickTypeIdentity {
	recordId: string;
	username: string;
	service: string;
}

export interface OneTimeCodeIdentity {
	recordId: string;
	label: string;
	service: string;
}

export interface PasskeyIdentity {
	credentialId: string;
	rpId: string;
	userName: string;
	userHandle: string;
}

export interface StoredPasskey extends PasskeyIdentity {
	privateKey: string;
	/** COSE algorithm. Required by the signer: 32 bytes cannot say which primitive owns them. */
	alg: number;
	/** PRF secrets, for the provider's PRF answers (docs/passkey-prf.md). */
	prf?: PasskeyPrfSecrets;
}

export interface SlotPayload {
	saltB64: string;
	slotIdB64: string;
	verifierB64: string;
	wrapIvB64: string;
	wrappedVekB64: string;
	magicVersionB64: string;
}

export interface ProviderMirror {
	/** Encrypted under the VEK before it leaves the app. */
	credentials: ProviderCredential[];
	/** Encrypted under the VEK before it leaves the app; private keys never at rest in clear. */
	passkeys: StoredPasskey[];
	identities: QuickTypeIdentity[];
	oneTimeCodeIdentities: OneTimeCodeIdentity[];
	passkeyIdentities: PasskeyIdentity[];
}

function normalizeHost(h: string): string {
	const s = h.trim().toLowerCase();
	return s.startsWith("www.") ? s.slice(4) : s;
}

/**
 * QuickType and one-time-code identities expose a domain and a label in the clear (which also
 * says which sites have 2FA), so they follow the user's opt-in. Passkey identities never do: the
 * OS cannot route a passkey sign-in to a provider it was not told holds one.
 */
export function buildProviderMirror(
	entries: IndexEntry[],
	opts: { quickType: boolean; includeUnlockKeys?: boolean },
): ProviderMirror {
	const credentials: ProviderCredential[] = [];
	const passkeys: StoredPasskey[] = [];
	const stored = (p: PasskeyCredential): StoredPasskey => ({
		credentialId: p.credentialId,
		rpId: p.rpId,
		userName: p.userName ?? "",
		userHandle: p.userHandle,
		privateKey: p.privateKey,
		alg: p.alg,
		prf: p.prf,
	});
	for (const e of entries) {
		// Only the macOS AutoFill extension serves the browser extension's own Touch ID key.
		if (e.type === "unlock-key") {
			if (opts.includeUnlockKeys) passkeys.push(stored(e.passkey));
			continue;
		}
		if (e.type !== "login") continue;
		if (e.password) {
			credentials.push({
				recordId: e.id,
				name: e.name,
				username: e.username,
				password: e.password,
				services: e.hostnames,
				subdomainMatch: e.subdomainMatch,
				totp: e.totp,
			});
		}
		// A login can hold passkeys with no password (a passkey-only account).
		for (const p of e.passkeys ?? []) {
			if (isReservedRpId(p.rpId)) continue;
			passkeys.push(stored(p));
		}
	}
	const hosts = (c: ProviderCredential) =>
		c.services.map(normalizeHost).filter((s) => s.length > 0);
	const identities = opts.quickType
		? credentials.flatMap((c) =>
				c.username
					? hosts(c).map((service) => ({ recordId: c.recordId, username: c.username, service }))
					: [],
			)
		: [];
	const oneTimeCodeIdentities = opts.quickType
		? credentials.flatMap((c) =>
				c.totp
					? hosts(c).map((service) => ({
							recordId: c.recordId,
							label: c.username || c.name,
							service,
						}))
					: [],
			)
		: [];
	const passkeyIdentities = passkeys.map((p) => ({
		credentialId: p.credentialId,
		rpId: p.rpId,
		userName: p.userName,
		userHandle: p.userHandle,
	}));
	return { credentials, passkeys, identities, oneTimeCodeIdentities, passkeyIdentities };
}

/** The password slot, so the provider can unlock with the master password. Not secret. */
export function passwordSlotPayload(blob: VaultBlob): SlotPayload | undefined {
	const slot = findPasswordSlot(blob);
	if (!slot) return undefined;
	return {
		saltB64: bytesToBase64(slot.salt),
		slotIdB64: bytesToBase64(slot.slotId),
		verifierB64: bytesToBase64(slot.verifier),
		wrapIvB64: bytesToBase64(slot.wrapIv),
		wrappedVekB64: bytesToBase64(slot.wrappedVek),
		magicVersionB64: bytesToBase64(verifierPrefix()),
	};
}
