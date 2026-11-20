// macOS AutoFill credential provider. Authenticate first, then decrypt: the desktop app mirrors
// the vault into the App Group, VEK-encrypted (autofill.json, src-tauri/src/autofill_provider.rs),
// and nothing in it is readable until the user unlocks here, with the desktop app's own Touch ID
// item or the master password. Shapes, PRF and matching are shared with iOS (AutofillCore.swift).
// See docs/macos-credential-provider.md.

import AppKit
import AuthenticationServices
import LocalAuthentication
import os
import Security
import SwiftUI

// Watch with: log stream --predicate 'subsystem == "app.bramble.desktop.autofill"' --level info
private let log = Logger(subsystem: "app.bramble.desktop.autofill", category: "provider")

private let appGroup = "BHGR3PP64J.group.app.bramble.desktop"
// The desktop app's Touch ID item (biometric_macos.rs): one per vault, read-only here.
private let touchIdService = "app.bramble.desktop.biometric"
private let touchIdGroup = "BHGR3PP64J.app.bramble.desktop"

private struct Mirror: Decodable {
	let iv: String
	let ciphertext: String
	let vaultId: String?
	let slot: SlotPayload?
	let passkeyIv: String?
	let passkeyCiphertext: String?
}

private struct SlotPayload: Decodable {
	let saltB64: String
	let slotIdB64: String
	let verifierB64: String
	let wrapIvB64: String
	let wrappedVekB64: String
	let magicVersionB64: String
}

private func groupURL(_ name: String) -> URL? {
	FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
		.appendingPathComponent(name)
}

private func readMirror() -> Mirror? {
	guard let url = groupURL("autofill.json"), let data = try? Data(contentsOf: url) else { return nil }
	return try? JSONDecoder().decode(Mirror.self, from: data)
}

// MARK: - Controller

@objc(CredentialProviderViewController)
final class CredentialProviderViewController: ASCredentialProviderViewController {
	private enum Pending {
		case passwords(hosts: [String], recordId: String?)
		case codes(hosts: [String], recordId: String?)
		case passkeyGet(PasskeyGet)
		case passkeyCreate(PasskeyCreate)
	}

	private var pending: Pending = .passwords(hosts: [], recordId: nil)
	private var unlock: UnlockModel?
	// Prompted once the view is on screen: before that, LocalAuthentication has nothing to sit over.
	private var pendingTouchId = false

	// Sized from the start: the host presents this modally and waits, and a view it cannot lay
	// out reads as a frozen browser.
	override func loadView() {
		view = NSView(frame: NSRect(x: 0, y: 0, width: sheetWidth, height: 240))
		preferredContentSize = view.frame.size
	}

	// MARK: Passwords and codes

	override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
		start(.passwords(hosts: hosts(serviceIdentifiers), recordId: nil))
	}

	override func prepareInterfaceToProvideCredential(for credentialIdentity: ASPasswordCredentialIdentity) {
		start(.passwords(hosts: [], recordId: credentialIdentity.recordIdentifier))
	}

	// No keep-unlocked session yet: every fill is a fresh unlock, so the silent path asks for UI.
	override func provideCredentialWithoutUserInteraction(for credentialIdentity: ASPasswordCredentialIdentity) {
		cancel(.userInteractionRequired)
	}

	@available(macOS 14.0, *)
	override func provideCredentialWithoutUserInteraction(for credentialRequest: ASCredentialRequest) {
		cancel(.userInteractionRequired)
	}

	@available(macOS 15.0, *)
	override func prepareOneTimeCodeCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
		start(.codes(hosts: hosts(serviceIdentifiers), recordId: nil))
	}

	// MARK: Passkeys

	@available(macOS 14.0, *)
	override func prepareInterfaceToProvideCredential(for credentialRequest: ASCredentialRequest) {
		if #available(macOS 15.0, *), credentialRequest is ASOneTimeCodeCredentialRequest {
			start(.codes(hosts: [], recordId: credentialRequest.credentialIdentity.recordIdentifier))
			return
		}
		guard let req = credentialRequest as? ASPasskeyCredentialRequest,
			let identity = req.credentialIdentity as? ASPasskeyCredentialIdentity
		else {
			if let pwd = credentialRequest.credentialIdentity as? ASPasswordCredentialIdentity {
				prepareInterfaceToProvideCredential(for: pwd)
			} else {
				cancel(.failed)
			}
			return
		}
		var prf: PrfGet?
		if #available(macOS 15.0, *), case .assertion(let input) = req.extensionInput {
			prf = prfGet(input.prf)
		}
		start(
			.passkeyGet(
				PasskeyGet(
					rpId: identity.relyingPartyIdentifier, clientDataHash: req.clientDataHash, allowed: [],
					chosen: identity.credentialID.base64EncodedString(), prf: prf)))
	}

	@available(macOS 14.0, *)
	override func prepareCredentialList(
		for serviceIdentifiers: [ASCredentialServiceIdentifier],
		requestParameters: ASPasskeyCredentialRequestParameters
	) {
		var prf: PrfGet?
		if #available(macOS 15.0, *) { prf = prfGet(requestParameters.extensionInput?.prf) }
		start(
			.passkeyGet(
				PasskeyGet(
					rpId: requestParameters.relyingPartyIdentifier,
					clientDataHash: requestParameters.clientDataHash,
					allowed: requestParameters.allowedCredentials.map { $0.base64EncodedString() }, chosen: nil,
					prf: prf)))
	}

	@available(macOS 14.0, *)
	override func prepareInterface(forPasskeyRegistration registrationRequest: ASCredentialRequest) {
		guard let req = registrationRequest as? ASPasskeyCredentialRequest,
			let identity = req.credentialIdentity as? ASPasskeyCredentialIdentity
		else {
			cancel(.failed)
			return
		}
		guard req.supportedAlgorithms.contains(.ES256) else {
			cancel(.failed)
			return
		}
		var prf: PrfCreate?
		if #available(macOS 15.0, *), case .registration(let input) = req.extensionInput, let p = input.prf {
			prf = PrfCreate(salts: prfSalts(p.inputValues))
		}
		log.notice(
			"create rp=\(identity.relyingPartyIdentifier, privacy: .public) prf=\(prf == nil ? "no" : (prf?.salts == nil ? "support-only" : "eval"), privacy: .public)"
		)
		start(
			.passkeyCreate(
				PasskeyCreate(
					rpId: identity.relyingPartyIdentifier, userName: identity.userName,
					userHandle: identity.userHandle, clientDataHash: req.clientDataHash, prf: prf)))
	}

	// MARK: Unlock

	private func start(_ next: Pending) {
		pending = next
		guard let mirror = readMirror() else {
			show(
				NoticeView(
					title: String(localized: "Open Bramble first"),
					message: String(localized: "Unlock Bramble Desktop once so AutoFill has your vault."),
					onDone: { [weak self] in self?.cancel(.userCanceled) }))
			return
		}
		let model = UnlockModel(
			canTouchId: touchIdItemExists(vaultId: mirror.vaultId),
			onTouchId: { [weak self] in self?.unlockWithTouchId(mirror) },
			onPassword: { [weak self] in self?.unlockWithPassword($0, mirror) },
			onCancel: { [weak self] in self?.cancel(.userCanceled) })
		unlock = model
		show(UnlockView(model: model))
		if model.canTouchId {
			pendingTouchId = true
			if view.window != nil { DispatchQueue.main.async { self.promptTouchIdIfPending() } }
		}
	}

	override func viewDidAppear() {
		super.viewDidAppear()
		promptTouchIdIfPending()
	}

	private func promptTouchIdIfPending() {
		guard pendingTouchId, let model = unlock else { return }
		pendingTouchId = false
		model.busy = true
		model.onTouchId()
	}

	private func touchIdQuery(_ vaultId: String) -> [String: Any] {
		[
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: touchIdService,
			kSecAttrAccount as String: "vek:\(vaultId)",
			kSecAttrAccessGroup as String: touchIdGroup,
			kSecUseDataProtectionKeychain as String: true,
		]
	}

	// Without prompting: "would have needed you" counts as present, as the desktop app's check does.
	private func touchIdItemExists(vaultId: String?) -> Bool {
		guard let vaultId, !vaultId.isEmpty else { return false }
		let ctx = LAContext()
		ctx.interactionNotAllowed = true
		var query = touchIdQuery(vaultId)
		query[kSecReturnAttributes as String] = true
		query[kSecUseAuthenticationContext as String] = ctx
		let status = SecItemCopyMatching(query as CFDictionary, nil)
		return status == errSecSuccess || status == errSecInteractionNotAllowed
	}

	// Authenticate, then read the item with that context, as the desktop app does, so a cancel is
	// told apart from a key that is gone.
	private func unlockWithTouchId(_ mirror: Mirror) {
		guard let vaultId = mirror.vaultId else { return }
		let ctx = LAContext()
		ctx.evaluatePolicy(
			.deviceOwnerAuthenticationWithBiometrics, localizedReason: String(localized: "unlock Bramble")
		) { [weak self] ok, _ in
			guard let self else { return }
			var vek: String?
			if ok {
				var query = self.touchIdQuery(vaultId)
				query[kSecReturnData as String] = true
				query[kSecUseAuthenticationContext as String] = ctx
				var out: CFTypeRef?
				if SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data {
					vek = String(data: data, encoding: .utf8)
				}
			}
			DispatchQueue.main.async {
				guard let vek, (try? unlockWithVek(vekB64: vek)) != nil else {
					self.unlock?.busy = false
					self.unlock?.showPassword = true
					self.unlock?.error =
						ok ? String(localized: "Touch ID isn't set up for this vault. Use your master password.") : nil
					return
				}
				self.onUnlocked(mirror)
			}
		}
	}

	private func unlockWithPassword(_ password: String, _ mirror: Mirror) {
		guard let slot = mirror.slot, let magic = Data(base64Encoded: slot.magicVersionB64) else {
			unlock?.busy = false
			unlock?.error = String(localized: "This vault has no master password. Use Touch ID.")
			return
		}
		DispatchQueue.global(qos: .userInitiated).async { [weak self] in
			let ok =
				(try? unwrapVekPassword(
					password: password, saltB64: slot.saltB64, slotIdB64: slot.slotIdB64,
					verifierB64: slot.verifierB64, wrapIvB64: slot.wrapIvB64, wrappedVekB64: slot.wrappedVekB64,
					magicVersion: magic)) ?? false
			DispatchQueue.main.async {
				if ok {
					self?.onUnlocked(mirror)
				} else {
					self?.unlock?.busy = false
					self?.unlock?.error = String(localized: "Incorrect master password")
				}
			}
		}
	}

	// MARK: After unlock

	private func onUnlocked(_ mirror: Mirror) {
		switch pending {
		case .passwords(let hosts, let recordId):
			offer(creds(mirror), hosts: hosts, recordId: recordId) { [weak self] in self?.fill($0) }
		case .codes(let hosts, let recordId):
			let withCodes = creds(mirror).filter { Totp.generate($0.totp) != nil }
			offer(withCodes, hosts: hosts, recordId: recordId) { [weak self] in self?.fillCode($0) }
		case .passkeyGet(let req):
			if #available(macOS 14.0, *) { signIn(req, passkeys(mirror)) } else { cancel(.failed) }
		case .passkeyCreate(let req):
			if #available(macOS 14.0, *) { register(req) } else { cancel(.failed) }
		}
	}

	private func creds(_ mirror: Mirror) -> [Cred] {
		guard let json = try? decryptWithVek(ivB64: mirror.iv, ciphertextB64: mirror.ciphertext) else { return [] }
		return (try? JSONDecoder().decode([Cred].self, from: Data(json.utf8))) ?? []
	}

	private func passkeys(_ mirror: Mirror) -> [Passkey] {
		guard let iv = mirror.passkeyIv, let ct = mirror.passkeyCiphertext,
			let json = try? decryptWithVek(ivB64: iv, ciphertextB64: ct)
		else { return [] }
		let all = (try? JSONDecoder().decode([Passkey].self, from: Data(json.utf8))) ?? []
		let known = Set(all.map(\.credentialId))
		return all + pendingPasskeys().filter { !known.contains($0.credentialId) }
	}

	// Passkeys made here that the desktop app has not merged yet, so one works straight away.
	private func pendingPasskeys() -> [Passkey] {
		guard let url = groupURL("pending-passkeys.json"), let data = try? Data(contentsOf: url),
			let records = (try? JSONSerialization.jsonObject(with: data)) as? [[String: String]]
		else { return [] }
		return records.compactMap { r in
			guard let iv = r["iv"], let ct = r["ciphertext"],
				let json = try? decryptWithVek(ivB64: iv, ciphertextB64: ct)
			else { return nil }
			return try? JSONDecoder().decode(Passkey.self, from: Data(json.utf8))
		}
	}

	private func offer(_ creds: [Cred], hosts: [String], recordId: String?, choose: @escaping (Cred) -> Void) {
		if let recordId, let cred = creds.first(where: { $0.recordId == recordId }) {
			choose(cred)
			return
		}
		let matching = creds.filter { cred in
			cred.services.map(AutofillMatch.normalizeHost).contains { saved in
				hosts.contains { AutofillMatch.hostMatches(saved, $0, cred.subdomainMatch) }
			}
		}
		let rank = { (c: Cred) in AutofillMatch.hostRank(c.services.map(AutofillMatch.normalizeHost), hosts) }
		show(
			LoginListView(
				matches: matching.sorted { rank($0) < rank($1) },
				all: creds.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending },
				requestedHost: hosts.first, onSelect: choose,
				onCancel: { [weak self] in self?.cancel(.userCanceled) }))
	}

	private func fill(_ cred: Cred) {
		extensionContext.completeRequest(
			withSelectedCredential: ASPasswordCredential(user: cred.username, password: cred.password),
			completionHandler: nil)
	}

	private func fillCode(_ cred: Cred) {
		guard #available(macOS 15.0, *), let code = Totp.generate(cred.totp) else {
			cancel(.failed)
			return
		}
		extensionContext.completeOneTimeCodeRequest(using: ASOneTimeCodeCredential(code: code), completionHandler: nil)
	}

	@available(macOS 14.0, *)
	private func signIn(_ req: PasskeyGet, _ all: [Passkey]) {
		log.notice(
			"get rp=\(req.rpId, privacy: .public) prf=\(req.prf == nil ? "no" : "yes", privacy: .public) candidates=\(all.filter { $0.rpId == req.rpId }.count, privacy: .public)"
		)
		let matches =
			req.chosen.map { id in all.filter { $0.credentialId == id && $0.rpId == req.rpId } }
			?? all.filter { $0.rpId == req.rpId && (req.allowed.isEmpty || req.allowed.contains($0.credentialId)) }
		if matches.count == 1 {
			assertPasskey(matches[0], req)
		} else if matches.isEmpty {
			show(
				NoticeView(
					title: String(localized: "No passkey found"),
					message: String(localized: "Bramble has no passkey for this site."),
					onDone: { [weak self] in self?.cancel(.userCanceled) }))
		} else {
			show(
				PasskeyPickerView(
					choices: matches, onSelect: { [weak self] in self?.assertPasskey($0, req) },
					onCancel: { [weak self] in self?.cancel(.userCanceled) }))
		}
	}

	// Always after a fresh unlock, so user-verified.
	@available(macOS 14.0, *)
	private func assertPasskey(_ pk: Passkey, _ req: PasskeyGet) {
		guard let credID = Data(base64Encoded: pk.credentialId),
			let userHandle = Data(base64Encoded: pk.userHandle),
			let assertion = try? passkeyGetAssertion(
				rpId: pk.rpId, privateKeyB64: pk.privateKey, alg: Int32(pk.alg ?? -7),
				clientDataHashB64: req.clientDataHash.base64EncodedString(), userVerified: true),
			let authData = Data(base64Encoded: assertion.authenticatorData),
			let sig = Data(base64Encoded: assertion.signature)
		else {
			cancel(.failed)
			return
		}
		let credential: ASPasskeyAssertionCredential
		if #available(macOS 15.0, *), let secrets = pk.prf, let prf = req.prf,
			let salts = prf.byCredential[pk.credentialId] ?? prf.salts,
			let out = evalPrf(secrets.credWithUV, salts)
		{
			credential = ASPasskeyAssertionCredential(
				userHandle: userHandle, relyingParty: pk.rpId, signature: sig, clientDataHash: req.clientDataHash,
				authenticatorData: authData, credentialID: credID,
				extensionOutput: ASPasskeyAssertionCredentialExtensionOutput(
					prf: ASAuthorizationPublicKeyCredentialPRFAssertionOutput(first: out.first, second: out.second)))
			log.notice("get answered with prf rp=\(pk.rpId, privacy: .public)")
		} else {
			log.notice("get answered without prf rp=\(pk.rpId, privacy: .public) has-secret=\(pk.prf != nil, privacy: .public)")
			credential = ASPasskeyAssertionCredential(
				userHandle: userHandle, relyingParty: pk.rpId, signature: sig, clientDataHash: req.clientDataHash,
				authenticatorData: authData, credentialID: credID)
		}
		extensionContext.completeAssertionRequest(using: credential, completionHandler: nil)
	}

	// Mint, leave the credential for the desktop app to merge (it owns the vault and its sync), and
	// hand the OS the attestation only once that write succeeded.
	@available(macOS 14.0, *)
	private func register(_ req: PasskeyCreate) {
		// The browser extension's own unlock key carries a marker it reads, so it keeps its password.
		let make = isReservedRpId(req.rpId) ? passkeyMakeUnlockCredential : passkeyMakeCredential
		guard let reg = try? make(req.rpId, true),
			let credID = Data(base64Encoded: reg.credentialId),
			let attestation = Data(base64Encoded: reg.attestationObject),
			stashPending(reg, req)
		else {
			log.error("create failed rp=\(req.rpId, privacy: .public)")
			cancel(.failed)
			return
		}
		let credential: ASPasskeyRegistrationCredential
		if #available(macOS 15.0, *), let prf = req.prf {
			let output: ASAuthorizationPublicKeyCredentialPRFRegistrationOutput =
				prf.salts.flatMap { evalPrf(reg.prf.credWithUv, $0) }
				.map { .init(first: $0.first, second: $0.second) } ?? .supported
			credential = ASPasskeyRegistrationCredential(
				relyingParty: req.rpId, clientDataHash: req.clientDataHash, credentialID: credID,
				attestationObject: attestation,
				extensionOutput: ASPasskeyRegistrationCredentialExtensionOutput(prf: output))
			log.notice("create answered with prf (eval=\(prf.salts != nil, privacy: .public)) rp=\(req.rpId, privacy: .public)")
		} else {
			credential = ASPasskeyRegistrationCredential(
				relyingParty: req.rpId, clientDataHash: req.clientDataHash, credentialID: credID,
				attestationObject: attestation)
		}
		// Listed now, not at the desktop app's next mirror, so the next sign-in is routed here.
		ASCredentialIdentityStore.shared.saveCredentialIdentities([
			ASPasskeyCredentialIdentity(
				relyingPartyIdentifier: req.rpId, userName: req.userName, credentialID: credID,
				userHandle: req.userHandle, recordIdentifier: reg.credentialId)
		]) { ok, error in
			if !ok { log.error("identity not saved: \(String(describing: error), privacy: .public)") }
		}
		extensionContext.completeRegistrationRequest(using: credential, completionHandler: nil)
	}

	/// Appends the new credential, VEK-encrypted, to the handoff the desktop app drains
	/// (autofill_consume_pending_passkeys). Core's PasskeyCredential shape, STANDARD base64.
	private func stashPending(_ reg: PasskeyRegistration, _ req: PasskeyCreate) -> Bool {
		let credential: [String: Any] = [
			"credentialId": reg.credentialId, "rpId": req.rpId,
			"userHandle": req.userHandle.base64EncodedString(), "userName": req.userName, "alg": -7,
			"publicKeyCose": reg.publicKeyCose, "privateKey": reg.privateKey, "signCount": 0,
			"createdAt": Int(Date().timeIntervalSince1970 * 1000), "prf": prfSecrets(reg),
		]
		guard let url = groupURL("pending-passkeys.json"),
			let json = try? JSONSerialization.data(withJSONObject: credential),
			let plaintext = String(data: json, encoding: .utf8),
			let enc = try? encryptWithVek(plaintext: plaintext)
		else { return false }
		let existing = (try? Data(contentsOf: url)).flatMap { try? JSONSerialization.jsonObject(with: $0) }
		var list = (existing as? [[String: String]]) ?? []
		list.append(["iv": enc.iv, "ciphertext": enc.ciphertext])
		guard let out = try? JSONSerialization.data(withJSONObject: list) else { return false }
		return (try? out.write(to: url, options: .atomic)) != nil
	}

	// MARK: Plumbing

	private func hosts(_ ids: [ASCredentialServiceIdentifier]) -> [String] {
		ids.map { AutofillMatch.normalizeHost($0.identifier) }.filter { !$0.isEmpty }
	}

	private func show<V: View>(_ content: V) {
		for child in children {
			child.view.removeFromSuperview()
			child.removeFromParent()
		}
		let hosting = NSHostingController(rootView: content)
		addChild(hosting)
		hosting.view.frame = view.bounds
		hosting.view.autoresizingMask = [.width, .height]
		view.addSubview(hosting.view)
		preferredContentSize = hosting.view.fittingSize
	}

	private func cancel(_ code: ASExtensionError.Code) {
		extensionContext.cancelRequest(withError: NSError(domain: ASExtensionErrorDomain, code: code.rawValue))
	}
}
