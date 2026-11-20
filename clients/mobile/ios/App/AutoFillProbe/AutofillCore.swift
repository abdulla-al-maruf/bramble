// The UI-free half of the AutoFill credential provider, shared by the iOS extension and the
// macOS one (clients/desktop/macos/BrambleAutoFill). Only data shapes and pure functions live
// here; each platform keeps its own storage, keychain and UI. See docs/macos-credential-provider.md.

import AuthenticationServices
import CryptoKit
import Foundation

struct Cred: Identifiable, Decodable {
	var id: String { recordId }
	let recordId: String
	let name: String
	let username: String
	let password: String
	let services: [String]
	/// The TOTP key (otpauth URI or bare base32), for one-time-code AutoFill. Optional: absent
	/// from bundles written by an older app build, and from logins with no 2FA.
	let totp: String?
	/// "exact" or "subdomain" narrows which pages the login matches; absent is the default.
	let subdomainMatch: String?
}

struct Slot {
	let salt: String
	let slotId: String
	let verifier: String
	let wrapIv: String
	let wrappedVek: String
	let magicVersion: Data
}

// One stored passkey from the (VEK-encrypted) passkey bundle. All base64 fields are
// STANDARD base64 (as written by the main app), which is what Data(base64Encoded:) and the
// Rust core both consume directly. The private key is the only secret. See AutofillBridge.
struct Passkey: Decodable {
	let credentialId: String
	let rpId: String
	let userName: String
	let userHandle: String
	let privateKey: String
	/// Optional so a bundle written before imported passkeys existed still decodes; those are
	/// all ES256, which is what the call site defaults to.
	let alg: Int?
	/// Absent from older bundles and from passkeys minted before PRF support.
	let prf: PasskeyPrf?
}

// A passkey's PRF secrets as the bundle carries them (STANDARD base64). Only credWithUV is ever
// evaluated: PRF answers only after user verification. See docs/passkey-prf.md.
struct PasskeyPrf: Decodable {
	let credWithUV: String
	let credWithoutUV: String
}

// PRF inputs the OS passed through (the site's raw values), copied into plain types so no
// iOS 18 type becomes a stored property.
struct PrfSalts {
	let first: Data
	let second: Data?
}

// A get()'s PRF request: default inputs plus per-credential ones (STANDARD-b64 id keys).
struct PrfGet {
	let salts: PrfSalts?
	let byCredential: [String: PrfSalts]
}

// A create() that asked for PRF; nil salts means it only asked whether PRF is supported.
struct PrfCreate {
	let salts: PrfSalts?
}

// A passkey sign-in (get) the OS asked us to satisfy, captured so the post-unlock path can
// finish it. Plain types only (no iOS-17 SDK types) so it can be a stored property on a
// controller whose deployment target is older. `chosen` is set when the OS already picked a
// specific credential (from its sheet); otherwise we match by rpId + allow-list.
struct PasskeyGet {
	let rpId: String
	let clientDataHash: Data
	let allowed: [String]  // STANDARD-b64 credentialIds; empty = any discoverable
	let chosen: String?  // STANDARD-b64 credentialId already selected by the OS
	let prf: PrfGet?
}

// A passkey registration (create) the OS asked us to satisfy. The OS supplies the user
// metadata and the clientDataHash; we mint the keypair after a fresh unlock.
struct PasskeyCreate {
	let rpId: String
	let userName: String
	let userHandle: Data
	let clientDataHash: Data
	let prf: PrfCreate?
}

@available(iOS 18.0, macOS 15.0, *)
func prfSalts(_ v: ASAuthorizationPublicKeyCredentialPRFAssertionInput.InputValues?) -> PrfSalts? {
	v.map { PrfSalts(first: $0.saltInput1, second: $0.saltInput2) }
}

@available(iOS 18.0, macOS 15.0, *)
func prfGet(_ input: ASAuthorizationPublicKeyCredentialPRFAssertionInput?) -> PrfGet? {
	guard let input else { return nil }
	var byCredential: [String: PrfSalts] = [:]
	for (id, values) in input.perCredentialInputValues ?? [:] {
		byCredential[id.base64EncodedString()] = prfSalts(values)
	}
	return PrfGet(salts: prfSalts(input.inputValues), byCredential: byCredential)
}

// A minted passkey's PRF secrets as core's PasskeyCredential.prf stores them (STANDARD base64).
func prfSecrets(_ reg: PasskeyRegistration) -> [String: String] {
	["credWithUV": reg.prf.credWithUv, "credWithoutUV": reg.prf.credWithoutUv]
}

// Run the core's PRF over a stored secret; nil on failure, so a PRF fault never fails the ceremony.
func evalPrf(_ secretB64: String, _ salts: PrfSalts) -> (first: SymmetricKey, second: SymmetricKey?)? {
	guard
		let out = try? passkeyPrfEval(
			secretB64: secretB64, firstB64: salts.first.base64EncodedString(),
			secondB64: salts.second?.base64EncodedString()),
		let first = Data(base64Encoded: out.first)
	else { return nil }
	let second = out.second.flatMap { Data(base64Encoded: $0) }
	return (SymmetricKey(data: first), second.map { SymmetricKey(data: $0) })
}

enum AutofillMatch {
	static func normalizeHost(_ raw: String) -> String {
		var s = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
		if s.isEmpty { return s }
		if let h = URL(string: s)?.host {
			s = h
		} else {
			if let r = s.range(of: "://") { s = String(s[r.upperBound...]) }
			if let slash = s.firstIndex(of: "/") { s = String(s[..<slash]) }
			if let q = s.firstIndex(of: "?") { s = String(s[..<q]) }
			if let colon = s.firstIndex(of: ":") { s = String(s[..<colon]) }
		}
		if s.hasPrefix("www.") { s = String(s.dropFirst(4)) }
		return s
	}

	// One saved host against one page host, both normalized, under the login's subdomain match
	// setting: "exact" is that host only, "subdomain" adds the hosts under it. Mirrors Android's
	// VaultReader.hostMatches.
	static func hostMatches(_ saved: String, _ page: String, _ mode: String?) -> Bool {
		switch mode {
		case "exact": return saved == page
		case "subdomain": return saved == page || page.hasSuffix("." + saved)
		default: return saved == page || saved.hasSuffix("." + page) || page.hasSuffix("." + saved)
		}
	}

	// How closely hosts fit the requested ones, lower first, for ordering the list (#183): the
	// same host (0), then parent domains nearest first, then hosts under it. Pure, on hosts
	// already through normalizeHost. Mirrors Android's VaultReader.hostRank.
	static func hostRank(_ services: [String], _ requested: [String]) -> Int {
		let labels = { (host: String) in host.split(separator: ".", omittingEmptySubsequences: false).count }
		var best = Int.max
		for s in services {
			for w in requested {
				let score: Int
				if s == w { score = 0 }
				else if w.hasSuffix("." + s) { score = labels(w) - labels(s) }
				else if s.hasSuffix("." + w) { score = 100 + labels(s) - labels(w) }
				else { score = 1000 }
				best = min(best, score)
			}
		}
		return best
	}
}

/// The browser extension's unlock rpID: Bramble never holds a passkey for it (core-rust's rule).
func isReservedRpId(_ rpId: String) -> Bool {
	let id = rpId.hasSuffix(".") ? String(rpId.dropLast()) : rpId
	return id.lowercased() == "bramble.sh"
}
