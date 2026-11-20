import AuthenticationServices
import CryptoKit
import LocalAuthentication
import Security
import SwiftUI
import UIKit

// AutoFill Credential Provider. Authenticate FIRST, then reveal entries: on launch it
// shows an unlock screen (Face ID / passcode, or the master password). Only once it has
// the VEK does it decrypt the login list (stored encrypted under the VEK in the shared
// App Group) and show it. Nothing about the vault - names, usernames, passwords - is
// readable before the user authenticates. The crypto is the shared Rust core
// (VaultCryptoFFI); the master-password path runs Argon2id natively (no biometrics
// needed). UI is SwiftUI styled from the app's design tokens. docs/mobile-port.md.

// Localized lookup from the extension's String Catalog (Localizable.xcstrings).
// Interpolations become format keys (%@, %lld) that the catalog translates.
private func loc(_ key: String.LocalizationValue) -> String { String(localized: key) }

// --- design tokens (app dark theme; oklch grayscale converted to sRGB) ---

extension Color {
	fileprivate init(rgb: UInt32) {
		self.init(
			.sRGB, red: Double((rgb >> 16) & 0xff) / 255, green: Double((rgb >> 8) & 0xff) / 255,
			blue: Double(rgb & 0xff) / 255)
	}
}
private enum Theme {
	static let background = Color(rgb: 0x17_17_17)
	static let card = Color(rgb: 0x21_21_21)
	static let input = Color(rgb: 0x2A_2A_2A)
	static let chip = Color(rgb: 0x2E_2E_2E)
	static let border = Color(rgb: 0x36_36_36)
	static let foreground = Color(rgb: 0xF5_F5_F5)
	static let muted = Color(rgb: 0xA1_A1_A1)
	static let destructive = Color(rgb: 0xF8_71_71)
}

// Decoded once: the header redraws on every keystroke.
private let brambleGlyphImage: UIImage? = Data(base64Encoded: brambleGlyphBase64).flatMap { UIImage(data: $0) }

private struct Glyph: View {
	let size: CGFloat
	var body: some View {
		if let img = brambleGlyphImage {
			Image(uiImage: img).renderingMode(.template).resizable().scaledToFit()
				.frame(width: size, height: size).foregroundColor(Theme.foreground)
		} else {
			Color.clear.frame(width: size, height: size)
		}
	}
}

// --- list (shown only after auth) ---

private struct RowView: View {
	let cred: Cred
	var body: some View {
		HStack(spacing: 12) {
			Text(initials(cred.name))
				.font(.system(size: 15, weight: .semibold))
				.foregroundColor(Theme.foreground)
				.frame(width: 40, height: 40)
				.background(Theme.chip)
				.clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
			VStack(alignment: .leading, spacing: 2) {
				Text(cred.name).font(.system(size: 16, weight: .semibold)).foregroundColor(Theme.foreground)
				Text(cred.username).font(.system(size: 14)).foregroundColor(Theme.muted).lineLimit(1)
			}
			Spacer(minLength: 0)
		}
		.padding(12)
		.background(Theme.card)
		.clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.border, lineWidth: 1))
	}
}

private struct CredentialListView: View {
	let matches: [Cred]
	let all: [Cred]
	let requestedHost: String?
	let onSelect: (Cred) -> Void
	/// Nil where a new login has nothing to fill (a one-time-code field).
	let onNew: (() -> Void)?
	let onCancel: () -> Void
	@State private var showAll = false
	@State private var query = ""
	// Search text per login, lowercased once here instead of on every keystroke.
	private let haystacks: [String]

	init(
		matches: [Cred], all: [Cred], requestedHost: String?, onSelect: @escaping (Cred) -> Void,
		onNew: (() -> Void)?, onCancel: @escaping () -> Void
	) {
		self.matches = matches
		self.all = all
		self.requestedHost = requestedHost
		self.onSelect = onSelect
		self.onNew = onNew
		self.onCancel = onCancel
		haystacks = all.map { "\($0.name) \($0.username) \($0.services.joined(separator: " "))".lowercased() }
		// iOS 15's List is a UITableView with an opaque background; iOS 16+ uses scrollContentBackground.
		if #unavailable(iOS 16.0) { UITableView.appearance().backgroundColor = .clear }
	}

	// The list as flat rows, so `List` builds only what is on screen. Building every row at once
	// got the extension killed at its memory cap (220 MB) on a vault of ~1,800 logins.
	private enum Item: Identifiable {
		case label(String)
		case login(Cred)
		case showAll(Int)
		case newLogin

		var id: String {
			switch self {
			case .label(let text): return "label:\(text)"
			case .login(let cred): return "login:\(cred.recordId)"
			case .showAll: return "showAll"
			case .newLogin: return "newLogin"
			}
		}
	}

	// "New login" leads, ahead of the page's matches: on a sign-up form it is the row wanted.
	private var items: [Item] {
		(onNew == nil ? [] : [.newLogin]) + listItems
	}

	// A search collapses the sections: the point of typing is that the thing you want is not
	// where the page's own matches are, so scope it to the whole vault and show one flat list.
	// Every token must appear somewhere in the entry, matching the main app's search (and
	// Android's) rather than testing the raw string: "acme staging" found nothing, because no
	// one field contains that string. The haystack is joined, not searched per field, so the
	// tokens may land in different ones - which is what makes a name plus a domain work.
	private var listItems: [Item] {
		if all.isEmpty { return [] }
		let tokens = query.lowercased().split(whereSeparator: { $0.isWhitespace })
		if !tokens.isEmpty {
			let found = zip(all, haystacks).filter { _, hay in tokens.allSatisfy { hay.contains($0) } }.map(\.0)
			if found.isEmpty { return [.label(loc("No logins matching \(query)"))] }
			return [.label(loc("Results (\(found.count))"))] + found.map(Item.login)
		}
		if matches.isEmpty {
			// No domain match for this page: show the whole vault.
			let title = requestedHost.map { loc("No matches for \($0)") } ?? loc("Items (\(all.count))")
			return [.label(title)] + all.map(Item.login)
		}
		// Filter to the page's logins; the rest are one tap away.
		var rows = [Item.label(requestedHost.map { loc("For \($0)") } ?? loc("Matches"))] + matches.map(Item.login)
		let matched = Set(matches.map(\.recordId))
		let others = all.filter { !matched.contains($0.recordId) }
		if !others.isEmpty {
			rows += showAll ? [.label(loc("All items"))] + others.map(Item.login) : [.showAll(others.count)]
		}
		return rows
	}

	var body: some View {
		VStack(spacing: 0) {
			HStack(spacing: 10) {
				Glyph(size: 26)
				Text("Bramble").font(.system(size: 20, weight: .semibold)).foregroundColor(Theme.foreground)
				Spacer()
				Button("Cancel", action: onCancel).foregroundColor(Theme.muted)
			}
			.padding(.horizontal, 20)
			.padding(.top, 16)
			.padding(.bottom, 12)
			Rectangle().fill(Theme.border).frame(height: 1).opacity(0.6)

			if all.isEmpty && onNew == nil {
				Spacer()
				Text("No logins saved yet.\nAdd one in Bramble.")
					.font(.footnote).foregroundColor(Theme.muted).multilineTextAlignment(.center).padding(24)
				Spacer()
			} else {
				if !all.isEmpty { searchField }
				List {
					ForEach(items) { item in
						itemView(item)
							.listRowInsets(EdgeInsets(top: 5, leading: 20, bottom: 5, trailing: 20))
							.listRowSeparator(.hidden)
							.listRowBackground(Theme.background)
					}
				}
				.listStyle(.plain)
				.modifier(ClearListBackground())
				.environment(\.defaultMinListRowHeight, 0)
				.safeAreaInset(edge: .bottom) { Color.clear.frame(height: 14) }
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		.background(Theme.background.ignoresSafeArea())
	}

	@ViewBuilder
	private func itemView(_ item: Item) -> some View {
		switch item {
		case .label(let text):
			sectionLabel(text)
		case .login(let cred):
			Button { onSelect(cred) } label: { RowView(cred: cred) }.buttonStyle(.plain)
		case .newLogin:
			Button { onNew?() } label: {
				HStack(spacing: 12) {
					Image(systemName: "plus").font(.system(size: 17, weight: .semibold))
						.foregroundColor(Theme.foreground)
						.frame(width: 40, height: 40).background(Theme.chip)
						.clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
						.accessibilityHidden(true)
					Text("New login").font(.system(size: 16, weight: .semibold)).foregroundColor(Theme.foreground)
					Spacer(minLength: 0)
				}
				.padding(12).background(Theme.card)
				.clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
				.overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.border, lineWidth: 1))
				.padding(.top, 12)
			}
			.buttonStyle(.plain)
		case .showAll(let count):
			Button { showAll = true } label: {
				Text("Show all items (\(count) more)")
					.font(.system(size: 14, weight: .medium))
					.foregroundColor(Theme.muted)
					.frame(maxWidth: .infinity, alignment: .leading)
					.padding(.vertical, 5)
			}
			.buttonStyle(.plain)
		}
	}

	// Styled to match the master-password field on the unlock screen rather than using
	// `.searchable`, which needs a NavigationStack this hosted view does not have.
	private var searchField: some View {
		HStack(spacing: 8) {
			Image(systemName: "magnifyingglass").font(.system(size: 14)).foregroundColor(Theme.muted)
			TextField("Search logins", text: $query)
				.autocorrectionDisabled()
				.textInputAutocapitalization(.never)
				.foregroundColor(Theme.foreground)
			if !query.isEmpty {
				Button { query = "" } label: {
					Image(systemName: "xmark.circle.fill").font(.system(size: 15))
						.foregroundColor(Theme.muted)
				}
				.buttonStyle(.plain)
				.accessibilityLabel("Clear search")
			}
		}
		.padding(10)
		.background(Theme.input)
		.clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
		.overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Theme.border, lineWidth: 1))
		.padding(.horizontal, 20)
		.padding(.top, 12)
	}

	private func sectionLabel(_ text: String) -> some View {
		Text(text)
			.font(.system(size: 13, weight: .medium)).foregroundColor(Theme.muted).padding(.top, 16)
			.frame(maxWidth: .infinity, alignment: .leading)
	}
}

private struct ClearListBackground: ViewModifier {
	func body(content: Content) -> some View {
		if #available(iOS 16.0, *) { content.scrollContentBackground(.hidden) } else { content }
	}
}

// --- new login (a sign-up form: make the login here, fill it, and leave it for the app to save) ---

// The password a new login starts with. The extension can't reach the app's generator, so this
// mirrors its defaults: 20 characters from every class, one of each guaranteed. randomElement and
// shuffled draw from SystemRandomNumberGenerator, the OS CSPRNG, without modulo bias.
private enum PasswordGenerator {
	static func generate() -> String {
		let classes = [
			"abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "0123456789", "!@#$%^&*()_+-=[]{}|;:,.<>?",
		]
		let pool = classes.joined()
		var out = classes.compactMap { $0.randomElement() }
		while out.count < 20, let c = pool.randomElement() { out.append(c) }
		return String(out.shuffled())
	}
}

private struct NewLoginView: View {
	@State var name: String
	/// Queue the login for the app and fill it; false when it couldn't be queued.
	let onSave: (_ name: String, _ username: String, _ password: String) -> Bool
	let onCancel: () -> Void
	@State private var username = ""
	@State private var password = PasswordGenerator.generate()
	@State private var failed = false
	@FocusState private var usernameFocused: Bool

	var body: some View {
		VStack(spacing: 0) {
			HStack(spacing: 10) {
				Glyph(size: 26)
				Text("New login").font(.system(size: 20, weight: .semibold)).foregroundColor(Theme.foreground)
				Spacer()
				Button("Cancel", action: onCancel).foregroundColor(Theme.muted)
			}
			.padding(.horizontal, 20).padding(.top, 16).padding(.bottom, 12)
			Rectangle().fill(Theme.border).frame(height: 1).opacity(0.6)
			ScrollView {
				VStack(alignment: .leading, spacing: 16) {
					field("Name") { TextField("", text: $name).accessibilityLabel(Text("Name")) }
					field("Username or email") {
						TextField("", text: $username).keyboardType(.emailAddress).focused($usernameFocused)
							.accessibilityLabel(Text("Username or email"))
					}
					field("Password") {
						HStack(spacing: 8) {
							TextField("", text: $password).font(.system(size: 15, design: .monospaced))
								.accessibilityLabel(Text("Password"))
							Button { password = PasswordGenerator.generate() } label: {
								Image(systemName: "arrow.clockwise").font(.system(size: 15)).foregroundColor(Theme.muted)
							}
							.buttonStyle(.plain)
							.accessibilityLabel(Text("Generate new"))
						}
					}
					if failed {
						Text("Couldn't save this login.").font(.footnote).foregroundColor(Theme.destructive)
					}
					Button {
						failed = !onSave(
							name.trimmingCharacters(in: .whitespacesAndNewlines),
							username.trimmingCharacters(in: .whitespacesAndNewlines), password)
					} label: {
						Text("Save and fill").font(.system(size: 15, weight: .semibold))
							.frame(maxWidth: .infinity).padding(.vertical, 12)
							.foregroundColor(.black).background(Theme.foreground)
							.clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
					}
					.buttonStyle(.plain)
					.disabled(password.isEmpty)
					.opacity(password.isEmpty ? 0.5 : 1)
				}
				.padding(.horizontal, 20).padding(.top, 16).padding(.bottom, 24)
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		.background(Theme.background.ignoresSafeArea())
		.onAppear { usernameFocused = true }
	}

	private func field(_ label: LocalizedStringKey, @ViewBuilder input: () -> some View) -> some View {
		VStack(alignment: .leading, spacing: 6) {
			// The field carries the same label for VoiceOver.
			Text(label).font(.system(size: 13, weight: .medium)).foregroundColor(Theme.muted)
				.accessibilityHidden(true)
			input()
				.autocorrectionDisabled()
				.textInputAutocapitalization(.never)
				.foregroundColor(Theme.foreground)
				.padding(10)
				.background(Theme.input)
				.clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
				.overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Theme.border, lineWidth: 1))
		}
	}
}

// "Fill and save" confirmation, styled like the app's own cards rather than a system alert.
private struct AssociationPromptView: View {
	let cred: Cred
	let site: String
	let onConfirm: () -> Void
	let onDecline: () -> Void

	var body: some View {
		ZStack {
			Theme.background.opacity(0.88).ignoresSafeArea()
			VStack(alignment: .leading, spacing: 18) {
				Text(loc("Save to Bramble?"))
					.font(.system(size: 19, weight: .semibold)).foregroundColor(Theme.foreground)
				Text(loc("Add \(site) to “\(cred.name)” so Bramble offers it here automatically?"))
					.font(.system(size: 15)).foregroundColor(Theme.foreground)
					.fixedSize(horizontal: false, vertical: true)
				Button(action: onConfirm) {
					Text(loc("Fill and save")).font(.system(size: 15, weight: .semibold))
						.frame(maxWidth: .infinity).padding(.vertical, 12)
						.foregroundColor(.black).background(Theme.foreground)
						.clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
				}
				.buttonStyle(.plain)
				Button(action: onDecline) {
					Text(loc("Just fill")).font(.system(size: 15, weight: .medium))
						.frame(maxWidth: .infinity).padding(.vertical, 12)
						.foregroundColor(Theme.foreground)
						.clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
						.overlay(
							RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(
								Theme.border, lineWidth: 1))
				}
				.buttonStyle(.plain)
			}
			.padding(20).background(Theme.card)
			.clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
			.overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Theme.border, lineWidth: 1))
			.padding(.horizontal, 24)
		}
	}
}

// --- passkey picker (only when several stored passkeys match one get() request) ---

private struct PasskeyPickerView: View {
	let choices: [Passkey]
	let onSelect: (Passkey) -> Void
	let onCancel: () -> Void

	var body: some View {
		VStack(spacing: 0) {
			HStack(spacing: 10) {
				Glyph(size: 26)
				Text("Choose a passkey").font(.system(size: 20, weight: .semibold))
					.foregroundColor(Theme.foreground)
				Spacer()
				Button("Cancel", action: onCancel).foregroundColor(Theme.muted)
			}
			.padding(.horizontal, 20).padding(.top, 16).padding(.bottom, 12)
			Rectangle().fill(Theme.border).frame(height: 1).opacity(0.6)
			ScrollView {
				VStack(alignment: .leading, spacing: 10) {
					ForEach(choices, id: \.credentialId) { pk in
						Button { onSelect(pk) } label: {
							HStack(spacing: 12) {
								Image(systemName: "person.badge.key.fill").font(.system(size: 18))
									.foregroundColor(Theme.foreground)
									.frame(width: 40, height: 40).background(Theme.chip)
									.clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
								VStack(alignment: .leading, spacing: 2) {
									Text(pk.userName.isEmpty ? pk.rpId : pk.userName)
										.font(.system(size: 16, weight: .semibold)).foregroundColor(Theme.foreground)
									Text(pk.rpId).font(.system(size: 14)).foregroundColor(Theme.muted).lineLimit(1)
								}
								Spacer(minLength: 0)
							}
							.padding(12).background(Theme.card)
							.clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
							.overlay(
								RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.border, lineWidth: 1))
						}
						.buttonStyle(.plain)
					}
				}
				.padding(.horizontal, 20).padding(.top, 16).padding(.bottom, 24)
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		.background(Theme.background.ignoresSafeArea())
	}
}

// --- unlock screen (shown first) ---

private final class UnlockModel: ObservableObject {
	@Published var busy = false
	@Published var error: String?
	let hasBiometric: Bool
	let biometricLabel: String
	let biometricSymbol: String
	let onBiometric: () -> Void
	let onPassword: (String) -> Void
	let onCancel: () -> Void
	init(
		hasBiometric: Bool, biometricLabel: String, biometricSymbol: String,
		onBiometric: @escaping () -> Void,
		onPassword: @escaping (String) -> Void, onCancel: @escaping () -> Void
	) {
		self.hasBiometric = hasBiometric
		self.biometricLabel = biometricLabel
		self.biometricSymbol = biometricSymbol
		self.onBiometric = onBiometric
		self.onPassword = onPassword
		self.onCancel = onCancel
	}
}

// Mirrors the app's auth screen: glyph, heading, then a card with (when a cached key
// exists) a Face ID / passcode button and the master-password field + Unlock button.
private struct UnlockView: View {
	@ObservedObject var model: UnlockModel
	@State private var password = ""
	@State private var showPassword = false
	@FocusState private var focused: Bool

	var body: some View {
		VStack(spacing: 0) {
			HStack {
				Button("Cancel", action: model.onCancel).foregroundColor(Theme.muted)
				Spacer()
			}
			.padding(.horizontal, 20)
			.padding(.top, 16)

			ScrollView {
				VStack(alignment: .leading, spacing: 20) {
					HStack { Spacer(); Glyph(size: 64); Spacer() }.padding(.top, 24)
					Text("Enter your master password to unlock your vault")
						.font(.system(size: 21, weight: .regular))
						.foregroundColor(Theme.foreground)
						.fixedSize(horizontal: false, vertical: true)

					VStack(spacing: 18) {
						if model.hasBiometric {
							Button {
								model.error = nil
								model.busy = true
								model.onBiometric()
							} label: {
								HStack(spacing: 8) {
									Image(systemName: model.biometricSymbol).font(.system(size: 15))
									Text("Unlock with \(model.biometricLabel)").font(.system(size: 15, weight: .semibold))
								}
								.frame(maxWidth: .infinity).padding(.vertical, 12)
								.background(Theme.foreground).foregroundColor(.black)
								.clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
							}
							.disabled(model.busy)
						}

						HStack(spacing: 8) {
							Group {
								if showPassword {
									TextField("Master password", text: $password)
								} else {
									SecureField("Master password", text: $password)
								}
							}
							.textContentType(.password)
							.autocorrectionDisabled()
							.textInputAutocapitalization(.never)
							.focused($focused)
							.foregroundColor(Theme.foreground)
							.onSubmit(submit)
							Button { showPassword.toggle() } label: {
								Image(systemName: showPassword ? "eye.slash" : "eye")
									.font(.system(size: 15)).foregroundColor(Theme.muted)
							}
						}
						.padding(12)
						.background(Theme.input)
						.clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
						.overlay(
							RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Theme.border, lineWidth: 1))

						if let error = model.error {
							Text(error).font(.footnote).foregroundColor(Theme.destructive)
								.frame(maxWidth: .infinity, alignment: .leading)
						}

						Button(action: submit) {
							HStack(spacing: 8) {
								if model.busy {
									ProgressView().tint(model.hasBiometric ? Theme.foreground : .black)
								} else {
									Image(systemName: "asterisk").font(.system(size: 14, weight: .bold))
								}
								Text("Unlock Vault").font(.system(size: 15, weight: .semibold))
							}
							.frame(maxWidth: .infinity).padding(.vertical, 12)
							.foregroundColor(model.hasBiometric ? Theme.foreground : .black)
							.background(model.hasBiometric ? Color.clear : Theme.foreground)
							.clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
							.overlay(
								model.hasBiometric
									? RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(
										Theme.border, lineWidth: 1) : nil)
						}
						.disabled(model.busy || password.isEmpty)
					}
					.padding(20)
					.background(Theme.card)
					.clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
					.overlay(
						RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.border, lineWidth: 1))
				}
				.padding(.horizontal, 24)
				.padding(.bottom, 24)
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		.background(Theme.background.ignoresSafeArea())
		.onAppear {
			// The automatic Face ID / passcode prompt is fired from the controller's
			// viewDidAppear, not here: .onAppear is too early for the Keychain to present it.
			if !model.hasBiometric { focused = true }
		}
	}

	private func submit() {
		guard !model.busy, !password.isEmpty else { return }
		model.error = nil
		model.busy = true
		model.onPassword(password)
	}
}

// --- provider controller ---

class CredentialProviderViewController: ASCredentialProviderViewController {
	// All shared identifiers (App Group, Keychain group/service/account, keys) live in
	// BrambleVault, compiled into both the app and this extension so they cannot drift.
	// Keep-unlocked session (BrambleVault.sessionService): the VEK cached behind device-
	// unlock only for the configured window, so fills within it need no re-auth.

	private enum VekOutcome { case ok(String), missing, denied(String) }

	private var pendingHosts: [String] = []
	private var pendingRecordId: String?
	// Set while satisfying a one-time-code request (iOS 18+): onUnlocked() completes with a
	// generated code instead of the password. A plain Bool so it needs no iOS-18 SDK type.
	private var pendingOneTimeCode = false
	// Set while satisfying a passkey get(); onUnlocked() branches to the assertion path.
	private var pendingPasskey: PasskeyGet?
	// Set while satisfying a passkey create(); onUnlocked() branches to the registration path.
	private var pendingPasskeyCreate: PasskeyCreate?
	private var model: UnlockModel?
	// An unlock screen is up and still owes its automatic biometric prompt (fired in viewDidAppear).
	private var pendingAutoBiometric = false
	private var pendingNotice: (String, String)?

	// --- entry points: authenticate first ---

	override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
		// Safari passes the full page URL here (e.g. https://github.com/login), while the
		// stored services are bare hostnames; normalize both to a host so they compare.
		pendingHosts = serviceIdentifiers.map { AutofillMatch.normalizeHost($0.identifier) }.filter { !$0.isEmpty }
		pendingRecordId = nil
		pendingOneTimeCode = false
		resume()
	}

	override func prepareInterfaceToProvideCredential(for credentialIdentity: ASPasswordCredentialIdentity) {
		pendingHosts = []
		pendingRecordId = credentialIdentity.recordIdentifier
		pendingOneTimeCode = false
		resume()
	}

	// Bramble opened from a verification-code field (iOS 18+). Same auth-first flow as the
	// password list; onUnlocked() narrows the list to logins that can actually produce a code.
	@available(iOS 18.0, *)
	override func prepareOneTimeCodeCredentialList(
		for serviceIdentifiers: [ASCredentialServiceIdentifier]
	) {
		pendingHosts = serviceIdentifiers.map { AutofillMatch.normalizeHost($0.identifier) }.filter { !$0.isEmpty }
		pendingRecordId = nil
		pendingOneTimeCode = true
		resume()
	}

	// Try the keep-unlocked session (no auth) before showing the unlock screen.
	private func resume() {
		if let vek = loadSession() {
			do {
				try unlockWithVek(vekB64: vek)
				onUnlocked()
				return
			} catch { clearSession() }
		}
		showUnlock()
	}

	// Tapped a QuickType suggestion. If a keep-unlocked session is live, decrypt and fill
	// silently (no unlock screen). Otherwise tell the OS we need UI: it relaunches into
	// prepareInterfaceToProvideCredential, which shows the unlock screen and then fills
	// this exact record via pendingRecordId. (Previously this always required interaction,
	// so the unlock screen appeared even when the vault was meant to stay unlocked.)
	override func provideCredentialWithoutUserInteraction(
		for credentialIdentity: ASPasswordCredentialIdentity
	) {
		guard let vek = loadSession(), (try? unlockWithVek(vekB64: vek)) != nil else {
			cancel(.userInteractionRequired)
			return
		}
		saveSession(vek)  // slide the keep-unlocked window, as the interactive path does
		guard let bundle = loadBundle(),
			let json = try? decryptWithVek(ivB64: bundle.iv, ciphertextB64: bundle.ct),
			let creds = try? JSONDecoder().decode([Cred].self, from: Data(json.utf8)),
			let cred = creds.first(where: { $0.recordId == credentialIdentity.recordIdentifier })
		else {
			cancel(.userInteractionRequired)
			return
		}
		complete(cred)
	}

	// --- passkey provider (iOS 17+, provider/authenticator role) ---
	// The OS owns clientDataJSON and hands us only its hash, so there is no origin to resolve
	// (unlike the Chromium proxy). We sign authData || clientDataHash with the stored key.
	// The unified ASCredentialRequest methods below also receive password requests on iOS 17;
	// non-passkey ones are delegated to the existing password handlers so that path is intact.

	// No-UI fast path. Assert silently only when a keep-unlocked session is live AND the RP
	// did not demand user verification (a fresh biometric); otherwise ask the OS for UI, which
	// relaunches into prepareInterfaceToProvideCredential below.
	@available(iOS 17.0, *)
	override func provideCredentialWithoutUserInteraction(for credentialRequest: ASCredentialRequest) {
		guard let req = credentialRequest as? ASPasskeyCredentialRequest,
			let identity = req.credentialIdentity as? ASPasskeyCredentialIdentity
		else {
			if #available(iOS 18.0, *), credentialRequest is ASOneTimeCodeCredentialRequest {
				provideOneTimeCodeWithoutUserInteraction(for: credentialRequest.credentialIdentity)
			} else if let pwd = credentialRequest.credentialIdentity as? ASPasswordCredentialIdentity {
				provideCredentialWithoutUserInteraction(for: pwd)
			} else {
				cancel(.userInteractionRequired)
			}
			return
		}
		// PRF answers only after user verification, so a PRF request always takes the unlock path:
		// otherwise a site would get different keys depending on whether the session was live.
		if #available(iOS 18.0, *), case .assertion(let input) = req.extensionInput, input.prf != nil {
			cancel(.userInteractionRequired)
			return
		}
		guard req.userVerificationPreference != .required,
			let vek = loadSession(), (try? unlockWithVek(vekB64: vek)) != nil
		else {
			cancel(.userInteractionRequired)
			return
		}
		saveSession(vek)
		let id = identity.credentialID.base64EncodedString()
		guard let pk = loadPasskeyBundle().first(where: { $0.credentialId == id && $0.rpId == identity.relyingPartyIdentifier })
		else {
			cancel(.userInteractionRequired)
			return
		}
		assertPasskey(pk, clientDataHash: req.clientDataHash, userVerified: false, prf: nil)
	}

	// A specific passkey was chosen from the OS sheet but UI is needed (unlock). Force a fresh
	// unlock so the assertion is genuinely user-verified, then assert that credential.
	@available(iOS 17.0, *)
	override func prepareInterfaceToProvideCredential(for credentialRequest: ASCredentialRequest) {
		guard let req = credentialRequest as? ASPasskeyCredentialRequest,
			let identity = req.credentialIdentity as? ASPasskeyCredentialIdentity
		else {
			if #available(iOS 18.0, *), credentialRequest is ASOneTimeCodeCredentialRequest {
				pendingHosts = []
				pendingRecordId = credentialRequest.credentialIdentity.recordIdentifier
				pendingOneTimeCode = true
				resume()
			} else if let pwd = credentialRequest.credentialIdentity as? ASPasswordCredentialIdentity {
				prepareInterfaceToProvideCredential(for: pwd)
			} else {
				cancel(.userInteractionRequired)
			}
			return
		}
		pendingHosts = []
		pendingRecordId = nil
		pendingOneTimeCode = false
		var prf: PrfGet?
		if #available(iOS 18.0, *), case .assertion(let input) = req.extensionInput {
			prf = prfGet(input.prf)
		}
		pendingPasskey = PasskeyGet(
			rpId: identity.relyingPartyIdentifier, clientDataHash: req.clientDataHash,
			allowed: [], chosen: identity.credentialID.base64EncodedString(), prf: prf)
		showUnlock()
	}

	// The user opened Bramble for a passkey sign-in (no specific credential pre-chosen): unlock,
	// then match by rpId + allow-list and assert (picking when several match).
	@available(iOS 17.0, *)
	override func prepareCredentialList(
		for serviceIdentifiers: [ASCredentialServiceIdentifier],
		requestParameters: ASPasskeyCredentialRequestParameters
	) {
		pendingHosts = []
		pendingRecordId = nil
		pendingOneTimeCode = false
		var prf: PrfGet?
		if #available(iOS 18.0, *) { prf = prfGet(requestParameters.extensionInput?.prf) }
		pendingPasskey = PasskeyGet(
			rpId: requestParameters.relyingPartyIdentifier,
			clientDataHash: requestParameters.clientDataHash,
			allowed: requestParameters.allowedCredentials.map { $0.base64EncodedString() },
			chosen: nil, prf: prf)
		showUnlock()
	}

	// Reached only after a fresh unlock (the passkey UI paths never use the cached session),
	// so the assertion is always user-verified here.
	@available(iOS 17.0, *)
	private func handlePasskeyUnlocked() {
		guard let req = pendingPasskey else { return }
		let all = loadPasskeyBundle()
		let matches =
			req.chosen.map { id in all.filter { $0.credentialId == id && $0.rpId == req.rpId } }
			?? all.filter { $0.rpId == req.rpId && (req.allowed.isEmpty || req.allowed.contains($0.credentialId)) }
		if matches.count == 1 {
			assertPasskey(matches[0], clientDataHash: req.clientDataHash, userVerified: true, prf: req.prf)
		} else if matches.isEmpty {
			showError(
				String(localized: "No passkey found"),
				String(localized: "Bramble has no passkey for this site."))
		} else {
			host(
				PasskeyPickerView(
					choices: matches,
					onSelect: { [weak self] in
						self?.assertPasskey($0, clientDataHash: req.clientDataHash, userVerified: true, prf: req.prf)
					},
					onCancel: { [weak self] in self?.cancel(.userCanceled) }))
		}
	}

	// Sign authData || clientDataHash with the stored key (native Rust core) and hand the OS a
	// passkey assertion. The OS-provided clientDataHash is fed back verbatim.
	@available(iOS 17.0, *)
	private func assertPasskey(_ pk: Passkey, clientDataHash: Data, userVerified: Bool, prf: PrfGet?) {
		guard let credID = Data(base64Encoded: pk.credentialId),
			let userHandle = Data(base64Encoded: pk.userHandle),
			let assertion = try? passkeyGetAssertion(
				rpId: pk.rpId, privateKeyB64: pk.privateKey, alg: Int32(pk.alg ?? -7),
				clientDataHashB64: clientDataHash.base64EncodedString(), userVerified: userVerified),
			let authData = Data(base64Encoded: assertion.authenticatorData),
			let sig = Data(base64Encoded: assertion.signature)
		else {
			cancel(.failed)
			return
		}
		let credential: ASPasskeyAssertionCredential
		if #available(iOS 18.0, *), userVerified, let output = prfAssertionOutput(pk, prf) {
			credential = ASPasskeyAssertionCredential(
				userHandle: userHandle, relyingParty: pk.rpId, signature: sig,
				clientDataHash: clientDataHash, authenticatorData: authData, credentialID: credID,
				extensionOutput: ASPasskeyAssertionCredentialExtensionOutput(prf: output))
		} else {
			credential = ASPasskeyAssertionCredential(
				userHandle: userHandle, relyingParty: pk.rpId, signature: sig,
				clientDataHash: clientDataHash, authenticatorData: authData, credentialID: credID)
		}
		extensionContext.completeAssertionRequest(using: credential, completionHandler: nil)
	}

	// The credential's own inputs, else the default ones, evaluated with its stored secret. Nil when
	// nothing applies: a passkey minted before PRF support simply answers without it.
	@available(iOS 18.0, *)
	private func prfAssertionOutput(_ pk: Passkey, _ prf: PrfGet?)
		-> ASAuthorizationPublicKeyCredentialPRFAssertionOutput?
	{
		guard let secrets = pk.prf, let prf,
			let salts = prf.byCredential[pk.credentialId] ?? prf.salts,
			let out = evalPrf(secrets.credWithUV, salts)
		else { return nil }
		return ASAuthorizationPublicKeyCredentialPRFAssertionOutput(first: out.first, second: out.second)
	}

	// Registration (create): the site asked us to mint a new passkey. Always force a fresh
	// unlock (so the credential is genuinely user-verified), then mint + persist.
	@available(iOS 17.0, *)
	override func prepareInterface(forPasskeyRegistration registrationRequest: ASCredentialRequest) {
		guard let req = registrationRequest as? ASPasskeyCredentialRequest,
			let identity = req.credentialIdentity as? ASPasskeyCredentialIdentity
		else {
			cancel(.failed)
			return
		}
		// The browser extension's own unlock key: Bramble must never hold it (core-rust refuses too).
		if isReservedRpId(identity.relyingPartyIdentifier) {
			pendingNotice = (
				String(localized: "Can't save here"),
				String(localized: "This key unlocks Bramble, so it can't be kept in Bramble. Choose Passwords instead.")
			)
			return
		}
		// We only mint ES256; if the RP won't accept it, decline so the OS can try elsewhere.
		guard req.supportedAlgorithms.contains(.ES256) else {
			cancel(.failed)
			return
		}
		pendingHosts = []
		pendingRecordId = nil
		pendingOneTimeCode = false
		pendingPasskey = nil
		var prf: PrfCreate?
		if #available(iOS 18.0, *), case .registration(let input) = req.extensionInput, let p = input.prf {
			prf = PrfCreate(salts: prfSalts(p.inputValues))
		}
		pendingPasskeyCreate = PasskeyCreate(
			rpId: identity.relyingPartyIdentifier, userName: identity.userName,
			userHandle: identity.userHandle, clientDataHash: req.clientDataHash, prf: prf)
		showUnlock()
	}

	// Reached after a fresh unlock: mint the keypair (native core), hand the OS the attestation,
	// and stash the new credential for the main app to merge into the vault.
	@available(iOS 17.0, *)
	private func handlePasskeyCreateUnlocked() {
		guard let req = pendingPasskeyCreate else { return }
		guard let reg = try? passkeyMakeCredential(rpId: req.rpId, userVerified: true),
			let credID = Data(base64Encoded: reg.credentialId),
			let attestation = Data(base64Encoded: reg.attestationObject)
		else {
			cancel(.failed)
			return
		}
		// Durable path: hand the credential to the main app to merge into the vault (it owns the
		// vault + sync). Immediate path: also write the derived caches the extension can reach so
		// the new passkey is usable for sign-in right away, before the app reconciles - otherwise
		// the user would have to open Bramble before they could use what they just created. Both
		// are byte-for-byte what the main app's setIndex rebuild produces, so reconciliation on
		// next unlock is idempotent. See docs/passkey-provider.md.
		stashPendingPasskey(reg, req: req)
		appendToPasskeyBundle(reg, req: req)
		registerPasskeyIdentity(reg, req: req)
		let credential: ASPasskeyRegistrationCredential
		if #available(iOS 18.0, *), let prf = req.prf {
			// Minted with UV (the fresh unlock), so an eval answers now; a failure still says supported.
			let output: ASAuthorizationPublicKeyCredentialPRFRegistrationOutput =
				prf.salts.flatMap { evalPrf(reg.prf.credWithUv, $0) }
				.map { .init(first: $0.first, second: $0.second) } ?? .supported
			credential = ASPasskeyRegistrationCredential(
				relyingParty: req.rpId, clientDataHash: req.clientDataHash,
				credentialID: credID, attestationObject: attestation,
				extensionOutput: ASPasskeyRegistrationCredentialExtensionOutput(prf: output))
		} else {
			credential = ASPasskeyRegistrationCredential(
				relyingParty: req.rpId, clientDataHash: req.clientDataHash,
				credentialID: credID, attestationObject: attestation)
		}
		extensionContext.completeRegistrationRequest(using: credential, completionHandler: nil)
	}

	// The extension can't write the vault, so encrypt the new credential under the VEK and
	// append it to the App Group handoff; the main app drains + persists it on next launch.
	@available(iOS 17.0, *)
	private func stashPendingPasskey(_ reg: PasskeyRegistration, req: PasskeyCreate) {
		// Mirrors core's PasskeyCredential (all base64 fields STANDARD, as elsewhere).
		let credential: [String: Any] = [
			"credentialId": reg.credentialId,
			"rpId": req.rpId,
			"userHandle": req.userHandle.base64EncodedString(),
			"userName": req.userName,
			"alg": -7,
			"publicKeyCose": reg.publicKeyCose,
			"privateKey": reg.privateKey,
			"signCount": 0,
			"createdAt": Int(Date().timeIntervalSince1970 * 1000),
			"prf": prfSecrets(reg),
		]
		guard let json = try? JSONSerialization.data(withJSONObject: credential),
			let plaintext = String(data: json, encoding: .utf8),
			let enc = try? encryptWithVek(plaintext: plaintext)
		else { return }
		AppGroupHandoff.append(["iv": enc.iv, "ciphertext": enc.ciphertext], to: .passkeys)
	}

	// Immediate-use bridge #1: append the new passkey to the (VEK-encrypted) assertion bundle so
	// a sign-in can find it before the main app reconciles. Same StoredPasskey shape the main app
	// writes (all STANDARD base64); the main app's next setIndex rebuild reproduces it exactly.
	@available(iOS 17.0, *)
	private func appendToPasskeyBundle(_ reg: PasskeyRegistration, req: PasskeyCreate) {
		// Locked against the app republishing the bundle mid-append, which would revert it.
		AppGroupHandoff.locked { appendToPasskeyBundleLocked(reg, req: req) }
	}

	@available(iOS 17.0, *)
	private func appendToPasskeyBundleLocked(_ reg: PasskeyRegistration, req: PasskeyCreate) {
		let defaults = UserDefaults(suiteName: BrambleVault.appGroup)
		// [String: Any], not [String: String]: `alg` is a number, and the stricter cast would
		// return nil for a bundle containing one, silently dropping every passkey already in it.
		var list: [[String: Any]] = []
		if let data = defaults?.data(forKey: BrambleVault.passkeyBundleKey),
			let d = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
			let iv = d["iv"] as? String, let ct = d["ciphertext"] as? String,
			let json = try? decryptWithVek(ivB64: iv, ciphertextB64: ct),
			let existing = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [[String: Any]]
		{
			list = existing
		}
		list.append([
			"credentialId": reg.credentialId,
			"rpId": req.rpId,
			"userName": req.userName,
			"userHandle": req.userHandle.base64EncodedString(),
			"privateKey": reg.privateKey,
			// We only ever mint ES256; imported EdDSA passkeys reach this bundle from the main
			// app's setIndex rebuild, not from here.
			"alg": -7,
			"prf": prfSecrets(reg),
		])
		guard let plain = try? JSONSerialization.data(withJSONObject: list),
			let str = String(data: plain, encoding: .utf8),
			let enc = try? encryptWithVek(plaintext: str),
			let blob = try? JSONSerialization.data(withJSONObject: [
				"iv": enc.iv, "ciphertext": enc.ciphertext,
			])
		else { return }
		defaults?.set(blob, forKey: BrambleVault.passkeyBundleKey)
	}

	// Immediate-use bridge #2: register the new credential's OS identity so iOS offers Bramble for
	// this site's sign-in right away. saveCredentialIdentities is an additive UPSERT (we only know
	// this one credential); the main app's authoritative replaceCredentialIdentities (full set from
	// the vault) supersedes it on next unlock.
	@available(iOS 17.0, *)
	private func registerPasskeyIdentity(_ reg: PasskeyRegistration, req: PasskeyCreate) {
		guard let credID = Data(base64Encoded: reg.credentialId) else { return }
		let identity = ASPasskeyCredentialIdentity(
			relyingPartyIdentifier: req.rpId, userName: req.userName,
			credentialID: credID, userHandle: req.userHandle, recordIdentifier: reg.credentialId)
		let store = ASCredentialIdentityStore.shared
		store.getState { state in
			guard state.isEnabled else { return }
			Task { try? await store.saveCredentialIdentities([identity]) }
		}
	}

	// Decrypt the passkey bundle (empty if none / not unlocked). VEK must already be loaded.
	private func loadPasskeyBundle() -> [Passkey] {
		guard
			let data = UserDefaults(suiteName: BrambleVault.appGroup)?.data(
				forKey: BrambleVault.passkeyBundleKey),
			let d = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
			let iv = d["iv"] as? String, let ct = d["ciphertext"] as? String,
			let json = try? decryptWithVek(ivB64: iv, ciphertextB64: ct),
			let creds = try? JSONDecoder().decode([Passkey].self, from: Data(json.utf8))
		else { return [] }
		return creds
	}

	private func showUnlock(message: String? = nil) {
		let biometry = biometryInfo()
		let m = UnlockModel(
			hasBiometric: vekExists(),
			biometricLabel: biometry.label,
			biometricSymbol: biometry.symbol,
			onBiometric: { [weak self] in self?.unlockWithBiometric() },
			onPassword: { [weak self] in self?.unlockWithPassword($0) },
			onCancel: { [weak self] in self?.cancel(.userCanceled) })
		m.error = message
		model = m
		// Never re-fire the gate for a cache we just retired, and never talk over a message.
		pendingAutoBiometric = m.hasBiometric && message == nil
		host(UnlockView(model: m))
	}

	// Fire the Face ID / passcode prompt HERE, not from the view's .onAppear: that runs while
	// the view is still being added, and the Keychain then refuses to present its own prompt
	// (errSecInteractionNotAllowed, -25308, surfaced as a red "Keychain status" line). By
	// viewDidAppear the extension is on screen and the system's own sheet has finished
	// dismissing. See docs/mobile-port.md (the "not running foreground" gotcha).
	override func viewDidAppear(_ animated: Bool) {
		super.viewDidAppear(animated)
		// An alert needs the view on screen, which prepareInterface runs before.
		if let (title, message) = pendingNotice {
			pendingNotice = nil
			showError(title, message)
			return
		}
		guard pendingAutoBiometric, let m = model else { return }
		pendingAutoBiometric = false
		m.busy = true
		unlockWithBiometric()
	}

	// Whether the app armed the cached VEK with a passcode-accepting gate. Mirrored into the App
	// Group by AutofillBridge; defaults to false to match the app's own default. Read-only here -
	// the Keychain item's access control is what actually enforces it.
	private func passcodeFallbackAllowed() -> Bool {
		guard let vaultId = bundleVaultId() else { return false }
		return UserDefaults(suiteName: BrambleVault.appGroup)?
			.bool(forKey: "\(BrambleVault.biometricPasscodeFallbackKey):\(vaultId)") ?? false
	}

	// The device's biometry name, naming the passcode only when the cached VEK is actually
	// gated by `.userPresence`. With biometry-only (`.biometryCurrentSet`) the passcode is
	// refused, so promising it would be a lie. The SF Symbol is derived here from the biometry
	// type, not from the (localized) label text.
	private func biometryInfo() -> (label: String, symbol: String) {
		let ctx = LAContext()
		// biometryType reports the HARDWARE, so a Face ID phone with Face ID switched off still
		// answers .faceID. Ask what can actually be evaluated first, or the button offers a Face ID
		// that cannot run. Locked out still counts as enrolled: the modality is there, just barred.
		var bioError: NSError?
		let enrolled =
			ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &bioError)
			|| (bioError as? LAError)?.code == .biometryLockout
		_ = ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
		let passcode = passcodeFallbackAllowed()
		// Nothing enrolled: the passcode is not a fallback here, it is the whole gate.
		guard enrolled else { return (String(localized: "passcode"), "lock") }
		switch ctx.biometryType {
		case .faceID:
			return (
				passcode ? String(localized: "Face ID or passcode") : String(localized: "Face ID"),
				"faceid"
			)
		case .touchID:
			return (
				passcode ? String(localized: "Touch ID or passcode") : String(localized: "Touch ID"),
				"touchid"
			)
		default:
			return (
				passcode
					? String(localized: "biometrics or passcode") : String(localized: "biometrics"),
				"lock"
			)
		}
	}

	// --- unlock paths (each loads the VEK into the native core, then onUnlocked) ---

	private func unlockWithBiometric() {
		readVek(reason: String(localized: "Unlock Bramble")) { [weak self] outcome in
			DispatchQueue.main.async {
				guard let self = self else { return }
				switch outcome {
				case .ok(let vek):
					do {
						try unlockWithVek(vekB64: vek)
						self.onUnlocked()
					} catch {
						self.model?.busy = false
						self.model?.error = error.localizedDescription
					}
				case .missing:
					self.model?.busy = false
					self.model?.error = String(localized: "Enter your master password.")
				case .denied(let msg):
					self.model?.busy = false
					self.model?.error = msg.isEmpty ? nil : msg  // empty == user canceled
				}
			}
		}
	}

	private func unlockWithPassword(_ password: String) {
		guard let slot = loadSlot() else {
			model?.busy = false
			model?.error = String(
				localized:
					"This vault has no master password, or it hasn't synced. Open Bramble, unlock it once, then retry."
			)
			return
		}
		DispatchQueue.global(qos: .userInitiated).async { [weak self] in
			do {
				let ok = try unwrapVekPassword(
					password: password, saltB64: slot.salt, slotIdB64: slot.slotId,
					verifierB64: slot.verifier, wrapIvB64: slot.wrapIv, wrappedVekB64: slot.wrappedVek,
					magicVersion: slot.magicVersion)
				DispatchQueue.main.async {
					if ok {
						self?.onUnlocked()
					} else {
						self?.model?.busy = false
						self?.model?.error = String(localized: "Incorrect master password")
					}
				}
			} catch {
				DispatchQueue.main.async {
					self?.model?.busy = false
					self?.model?.error = error.localizedDescription
				}
			}
		}
	}

	// VEK is loaded in the native core; decrypt the bundle and show the list (or fill).
	private func onUnlocked() {
		// Start / slide the keep-unlocked window (no-op if the feature is off).
		if let vek = try? exportVek() { saveSession(vek) }
		// A passkey get() / create() takes a separate path (the login bundle is irrelevant).
		if pendingPasskey != nil {
			if #available(iOS 17.0, *) { handlePasskeyUnlocked() } else { cancel(.failed) }
			return
		}
		if pendingPasskeyCreate != nil {
			if #available(iOS 17.0, *) { handlePasskeyCreateUnlocked() } else { cancel(.failed) }
			return
		}
		guard let bundle = loadBundle() else {
			let pending = pendingOneTimeCode ? [] : loadPendingLogins()
			showList(
				matches: closestFirst(pending.filter { matchesRequested($0) }), all: pending,
				requestedHost: pendingHosts.first)
			return
		}
		do {
			let json = try decryptWithVek(ivB64: bundle.iv, ciphertextB64: bundle.ct)
			let saved = (try? JSONDecoder().decode([Cred].self, from: Data(json.utf8))) ?? []
			var creds = Self.withPending(saved, loadPendingLogins())
			// A code request can only be satisfied by a login whose key actually generates one,
			// so don't offer the rest (a password-only entry would just dead-end).
			if pendingOneTimeCode { creds = creds.filter { Totp.generate($0.totp) != nil } }
			if let rid = pendingRecordId, let c = creds.first(where: { $0.recordId == rid }) {
				select(c)
			} else {
				let matches = closestFirst(creds.filter { matchesRequested($0) })
				showList(matches: matches, all: creds, requestedHost: pendingHosts.first)
			}
		} catch {
			// The gate opened but its VEK does not decrypt this bundle: the cache belongs to another
			// vault, or to an install before this one. The underlying error is a Rust aead failure
			// and means nothing to anyone, so retire the cache and ask for the master password.
			discardCachedVek()
			showUnlock(
				message: String(
					localized: "This device's saved key is out of date. Enter your master password."))
		}
	}

	private func showList(matches: [Cred], all: [Cred], requestedHost: String?) {
		host(
			CredentialListView(
				matches: matches, all: all, requestedHost: requestedHost,
				onSelect: { [weak self] in self?.select($0) },
				onNew: pendingOneTimeCode
					? nil
					: { [weak self] in self?.showNewLogin(matches: matches, all: all, requestedHost: requestedHost) },
				onCancel: { [weak self] in self?.cancel(.userCanceled) }))
	}

	// --- new login ---

	private func showNewLogin(matches: [Cred], all: [Cred], requestedHost: String?) {
		host(
			NewLoginView(
				name: requestedHost ?? "",
				onSave: { [weak self] name, username, password in
					self?.saveNewLogin(name: name, username: username, password: password) ?? false
				},
				onCancel: { [weak self] in self?.showList(matches: matches, all: all, requestedHost: requestedHost) }))
	}

	// Queue it for the app before filling: a password on the site but saved nowhere would lock the
	// user out of the account they are making. Checked back from the queue, since append can't fail loudly.
	private func saveNewLogin(name: String, username: String, password: String) -> Bool {
		let url = associationHost().map { "https://\($0)" } ?? ""
		guard
			let json = try? JSONSerialization.data(withJSONObject: [
				"name": name, "url": url, "username": username, "password": password,
			]),
			let plaintext = String(data: json, encoding: .utf8),
			let enc = try? encryptWithVek(plaintext: plaintext)
		else { return false }
		AppGroupHandoff.append(["iv": enc.iv, "ciphertext": enc.ciphertext], to: .logins)
		guard AppGroupHandoff.peek(.logins).contains(where: { $0["iv"] == enc.iv }) else { return false }
		complete(
			Cred(
				recordId: "", name: name, username: username, password: password, services: [], totp: nil,
				subdomainMatch: nil))
		return true
	}

	// Logins made with "New login" that the app hasn't saved yet, so signing in right after signing
	// up finds them. Another vault's don't decrypt and are skipped.
	private func loadPendingLogins() -> [Cred] {
		AppGroupHandoff.peek(.logins).compactMap { record in
			guard let iv = record["iv"], let ct = record["ciphertext"],
				let json = try? decryptWithVek(ivB64: iv, ciphertextB64: ct),
				let d = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: String],
				let password = d["password"], !password.isEmpty
			else { return nil }
			let username = d["username"] ?? ""
			let url = d["url"] ?? ""
			return Cred(
				recordId: "pending:\(iv)", name: (d["name"] ?? "").isEmpty ? username : d["name"]!,
				username: username, password: password, services: url.isEmpty ? [] : [url], totp: nil,
				subdomainMatch: nil)
		}
	}

	// The saved logins plus the pending ones, minus any the app has saved since.
	private static func withPending(_ saved: [Cred], _ pending: [Cred]) -> [Cred] {
		var out = saved
		for p in pending where !out.contains(where: { $0.password == p.password && $0.username == p.username }) {
			out.append(p)
		}
		return out
	}

	/// Finish with whatever this request asked of the chosen login: its password, or a freshly
	/// generated one-time code.
	private func select(_ cred: Cred) {
		if pendingOneTimeCode {
			if #available(iOS 18.0, *) { completeOneTimeCode(cred) } else { cancel(.failed) }
		} else if let site = associationHost(), !matchesRequested(cred), !cred.recordId.hasPrefix("pending:") {
			// (Not one the app hasn't saved yet: there is no entry to add the site to.)
			promptToAssociate(cred, site: site)
		} else {
			complete(cred)
		}
	}

	private func associationHost() -> String? {
		guard let host = pendingHosts.first, !host.isEmpty else { return nil }
		return host
	}

	private func promptToAssociate(_ cred: Cred, site: String) {
		host(
			AssociationPromptView(
				cred: cred, site: site,
				onConfirm: { [weak self] in
					self?.stashPendingAssociation(cred, uri: "https://\(site)", label: site)
					self?.complete(cred)
				},
				onDecline: { [weak self] in self?.complete(cred) }))
	}

	private func stashPendingAssociation(_ cred: Cred, uri: String, label: String) {
		guard let vaultId = bundleVaultId(),
			let json = try? JSONSerialization.data(withJSONObject: [
				"entryId": cred.recordId,
				"url": uri,
				"label": label,
				"vaultId": vaultId,
			]),
			let plaintext = String(data: json, encoding: .utf8),
			let enc = try? encryptWithVek(plaintext: plaintext)
		else { return }
		AppGroupHandoff.append(["iv": enc.iv, "ciphertext": enc.ciphertext], to: .associations)
	}

	private func complete(_ cred: Cred) {
		extensionContext.completeRequest(
			withSelectedCredential: ASPasswordCredential(user: cred.username, password: cred.password),
			completionHandler: nil)
	}

	// --- one-time codes (iOS 18+, ProvidesOneTimeCodes) ---

	/// Generate this login's live TOTP and hand the OS the digits. Only the code leaves the
	/// extension, never the seed. Cancels when the entry has no usable key (HOTP, garbage).
	@available(iOS 18.0, *)
	private func completeOneTimeCode(_ cred: Cred) {
		guard let code = Totp.generate(cred.totp) else {
			cancel(.failed)
			return
		}
		extensionContext.completeOneTimeCodeRequest(using: ASOneTimeCodeCredential(code: code))
	}

	/// The no-UI path for a tapped code suggestion, mirroring the password one: fill silently
	/// while a keep-unlocked session is live, else ask the OS for UI so it relaunches into
	/// prepareInterfaceToProvideCredential with the same record.
	@available(iOS 18.0, *)
	private func provideOneTimeCodeWithoutUserInteraction(for identity: ASCredentialIdentity) {
		guard let vek = loadSession(), (try? unlockWithVek(vekB64: vek)) != nil else {
			cancel(.userInteractionRequired)
			return
		}
		saveSession(vek)  // slide the keep-unlocked window, as the interactive path does
		guard let bundle = loadBundle(),
			let json = try? decryptWithVek(ivB64: bundle.iv, ciphertextB64: bundle.ct),
			let creds = try? JSONDecoder().decode([Cred].self, from: Data(json.utf8)),
			let cred = creds.first(where: { $0.recordId == identity.recordIdentifier })
		else {
			cancel(.userInteractionRequired)
			return
		}
		completeOneTimeCode(cred)
	}

	// Normalize a service identifier or a stored URL/hostname to a bare registrable host:
	// prefer the parsed URL host (Safari passes the full page URL), else strip any
	// scheme/path/query/port by hand, then drop a leading "www." and lowercase. Without
	// this, a requested "https://github.com/login" never equals a stored "github.com".
	// A login matches the page if any of its (normalized) hostnames equals the requested
	// host or is a subdomain either way (login.github.com ~ github.com), unless the login
	// narrows that (hostMatches).
	private func matchesRequested(_ c: Cred) -> Bool {
		guard !pendingHosts.isEmpty else { return false }
		let services = c.services.map { AutofillMatch.normalizeHost($0) }.filter { !$0.isEmpty }
		return services.contains { s in
			pendingHosts.contains { w in AutofillMatch.hostMatches(s, w, c.subdomainMatch) }
		}
	}

	// The page's own host first, then the nearest; ties keep vault order.
	private func closestFirst(_ creds: [Cred]) -> [Cred] {
		creds.enumerated()
			.map { (rank: AutofillMatch.hostRank($0.element.services.map { AutofillMatch.normalizeHost($0) }, pendingHosts), index: $0.offset, cred: $0.element) }
			.sorted { ($0.rank, $0.index) < ($1.rank, $1.index) }
			.map(\.cred)
	}

	// --- App Group reads ---

	private func loadBundle() -> (iv: String, ct: String)? {
		guard let data = UserDefaults(suiteName: BrambleVault.appGroup)?.data(forKey: BrambleVault.bundleKey),
			let d = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
			let iv = d["iv"] as? String, let ct = d["ciphertext"] as? String
		else { return nil }
		return (iv, ct)
	}

	private func loadSlot() -> Slot? {
		guard let data = UserDefaults(suiteName: BrambleVault.appGroup)?.data(forKey: BrambleVault.slotKey),
			let d = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
			let salt = d["saltB64"] as? String, let slotId = d["slotIdB64"] as? String,
			let verifier = d["verifierB64"] as? String, let wrapIv = d["wrapIvB64"] as? String,
			let wrapped = d["wrappedVekB64"] as? String, let mvB64 = d["magicVersionB64"] as? String,
			let mv = Data(base64Encoded: mvB64)
		else { return nil }
		return Slot(
			salt: salt, slotId: slotId, verifier: verifier, wrapIv: wrapIv, wrappedVek: wrapped,
			magicVersion: mv)
	}

	// --- keep-unlocked session (device-unlock-gated VEK cache, time-limited) ---

	private func keepUnlockedMinutes() -> Int {
		UserDefaults(suiteName: BrambleVault.appGroup)?.integer(forKey: BrambleVault.keepUnlockedKey) ?? 0
	}

	// Keyed by vault like the cached VEK above: a keep-unlocked window is permission to open ONE
	// vault without re-auth, and a shared item handed it to whichever vault became active next.
	// Returns nil before the app has published a bundle, which reads as "no session".
	private func sessionBaseQuery() -> [String: Any]? {
		guard let vaultId = bundleVaultId() else { return nil }
		return [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: BrambleVault.sessionService,
			kSecAttrAccount as String: "\(BrambleVault.vekAccount):\(vaultId)",
			kSecAttrAccessGroup as String: BrambleVault.accessGroup,
		]
	}

	private func saveSession(_ vek: String) {
		// 0 = off; positive = minute window; negative = never expire.
		guard keepUnlockedMinutes() != 0,
			let data = try? JSONSerialization.data(withJSONObject: [
				"vek": vek, "at": Date().timeIntervalSince1970,
			])
		else { return }
		guard let base = sessionBaseQuery() else { return }
		SecItemDelete(base as CFDictionary)
		var add = base
		add[kSecValueData as String] = data
		add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
		SecItemAdd(add as CFDictionary, nil)
	}

	private func loadSession() -> String? {
		let minutes = keepUnlockedMinutes()
		guard minutes != 0 else { return nil }  // 0 = off
		guard var q = sessionBaseQuery() else { return nil }
		q[kSecReturnData as String] = true
		q[kSecMatchLimit as String] = kSecMatchLimitOne
		var item: CFTypeRef?
		guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let data = item as? Data,
			let d = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
			let vek = d["vek"] as? String, let at = d["at"] as? Double
		else { return nil }
		// Positive = expiring window; negative = never expire (auto-lock "Never").
		if minutes > 0, Date().timeIntervalSince1970 - at > Double(minutes) * 60 {
			clearSession()
			return nil
		}
		return vek
	}

	private func clearSession() {
		guard let base = sessionBaseQuery() else { return }
		SecItemDelete(base as CFDictionary)
	}

	// --- hosting + Keychain ---

	private func host(_ view: some View) {
		children.forEach {
			$0.willMove(toParent: nil)
			$0.view.removeFromSuperview()
			$0.removeFromParent()
		}
		let h = UIHostingController(rootView: view)
		addChild(h)
		h.view.frame = self.view.bounds
		h.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
		self.view.addSubview(h.view)
		h.didMove(toParent: self)
	}

	/// The vault whose data we are holding: whichever one the app last published a bundle for.
	/// Everything below is keyed by it, so a gate armed for one vault can never open another.
	private func bundleVaultId() -> String? {
		let id = UserDefaults(suiteName: BrambleVault.appGroup)?
			.string(forKey: BrambleVault.bundleVaultKey) ?? ""
		return id.isEmpty ? nil : id
	}

	/// This vault's cached-VEK item. Was un-suffixed, one item shared by every vault, so arming
	/// a second vault overwrote the first's and disabling either deleted both. Keyed by vault
	/// now, which also removes the need to compare ids: finding the item IS the match.
	private func vekQuery(_ vaultId: String) -> [String: Any] {
		[
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: BrambleVault.biometricService,
			kSecAttrAccount as String: "\(BrambleVault.vekAccount):\(vaultId)",
			kSecAttrAccessGroup as String: BrambleVault.accessGroup,
		]
	}

	/// Drop this vault's cached VEK and what describes it. Called when it is shown to be unusable,
	/// so the button stops being offered instead of failing the same way next time. Touches only
	/// the vault in hand: another vault's gate is none of this one's business.
	private func discardCachedVek() {
		guard let vaultId = bundleVaultId() else { return }
		SecItemDelete(vekQuery(vaultId) as CFDictionary)
		UserDefaults(suiteName: BrambleVault.appGroup)?
			.removeObject(forKey: "\(BrambleVault.biometricPasscodeFallbackKey):\(vaultId)")
		clearSession()
	}

	private func vekExists() -> Bool {
		// Keychain items survive app deletion, so presence is only meaningful once it is presence
		// of THIS vault's item: the shared one kept offering a fast unlock for a vault that had
		// turned it off, or for one that no longer exists, and the passcode then produced a VEK
		// that could not decrypt the bundle (a raw aead error on screen).
		guard let vaultId = bundleVaultId() else { return false }
		let q = vekQuery(vaultId).merging([
			kSecReturnData as String: false,
			// UIFail (not UISkip): report the auth-required item as existing via
			// errSecInteractionNotAllowed rather than silently skipping it (errSecItemNotFound).
			kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail,
			kSecMatchLimit as String: kSecMatchLimitOne,
		]) { _, new in new }
		let status = SecItemCopyMatching(q as CFDictionary, nil)
		return status == errSecSuccess || status == errSecInteractionNotAllowed
	}

	// The item's own access control drives the prompt (`.userPresence` = Face ID or the device
	// passcode; `.biometryCurrentSet` = biometry only), so there is no policy to pick here - the
	// app's setting is enforced by how it armed the item. Run off the main thread since
	// SecItemCopyMatching blocks while the prompt is up.
	private func readVek(reason: String, completion: @escaping (VekOutcome) -> Void) {
		DispatchQueue.global(qos: .userInitiated).async {
			let ctx = LAContext()
			ctx.localizedReason = reason
			guard let vaultId = self.bundleVaultId() else {
				completion(.missing)
				return
			}
			let query = self.vekQuery(vaultId).merging([
				kSecReturnData as String: true,
				kSecMatchLimit as String: kSecMatchLimitOne,
				kSecUseAuthenticationContext as String: ctx,
			]) { _, new in new }
			var item: CFTypeRef?
			let status = SecItemCopyMatching(query as CFDictionary, &item)
			if status == errSecSuccess, let data = item as? Data,
				let secret = String(data: data, encoding: .utf8)
			{
				completion(.ok(secret))
			} else if status == errSecItemNotFound {
				completion(.missing)
			} else if status == errSecAuthFailed {
				// A biometry-only item killed by an enrolment change: it can never open again.
				// Drop it so the button stops being offered, and say what to do about it.
				SecItemDelete(self.vekQuery(vaultId) as CFDictionary)
				completion(
					.denied(
						String(
							localized:
								"Your biometric enrolment changed. Open Bramble and turn on biometric unlock again."
						)))
			} else {
				// A raw OSStatus means nothing to the user, and two of these aren't errors at
				// all: a cancel, and interactionNotAllowed (the Keychain couldn't put its prompt
				// up right now). Both leave the unlock screen usable, so say nothing and let the
				// user tap the button or type the master password.
				let silent = status == errSecUserCanceled || status == errSecInteractionNotAllowed
				completion(.denied(silent ? "" : String(localized: "Couldn't read the saved key.")))
			}
		}
	}

	private func showError(_ title: String, _ message: String) {
		let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
		alert.addAction(UIAlertAction(title: String(localized: "OK"), style: .default) { [weak self] _ in
			self?.cancel(.userCanceled)
		})
		present(alert, animated: true)
	}

	private func cancel(_ code: ASExtensionError.Code) {
		extensionContext.cancelRequest(
			withError: NSError(domain: ASExtensionErrorDomain, code: code.rawValue))
	}
}
