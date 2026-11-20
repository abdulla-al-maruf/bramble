// The AutoFill extension's screens, styled like the app: its theme tokens (light and dark from
// packages/theme/theme.css), the Bramble glyph, and the iOS extension's rows and search.

import AppKit
import SwiftUI

extension Color {
	fileprivate init(rgb: UInt32) {
		self.init(
			.sRGB, red: Double((rgb >> 16) & 0xff) / 255, green: Double((rgb >> 8) & 0xff) / 255,
			blue: Double(rgb & 0xff) / 255)
	}

	fileprivate init(light: UInt32, dark: UInt32) {
		self.init(
			nsColor: NSColor(name: nil) { appearance in
				let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
				let rgb = isDark ? dark : light
				return NSColor(
					srgbRed: CGFloat((rgb >> 16) & 0xff) / 255, green: CGFloat((rgb >> 8) & 0xff) / 255,
					blue: CGFloat(rgb & 0xff) / 255, alpha: 1)
			})
	}
}

enum Theme {
	static let background = Color(light: 0xFA_FA_FA, dark: 0x17_17_17)
	static let card = Color(light: 0xFF_FF_FF, dark: 0x21_21_21)
	static let input = Color(light: 0xFF_FF_FF, dark: 0x2A_2A_2A)
	static let chip = Color(light: 0xF5_F5_F5, dark: 0x2E_2E_2E)
	static let border = Color(light: 0xD4_D4_D4, dark: 0x36_36_36)
	static let foreground = Color(light: 0x17_17_17, dark: 0xF5_F5_F5)
	static let muted = Color(light: 0x69_69_69, dark: 0xA1_A1_A1)
	static let destructive = Color(light: 0xC8_1E_1E, dark: 0xF8_71_71)
}

let sheetWidth: CGFloat = 400

// Decoded once: views redraw on every keystroke.
private let glyphImage: NSImage? = Data(base64Encoded: brambleGlyphBase64).flatMap { NSImage(data: $0) }

struct Glyph: View {
	let size: CGFloat
	var body: some View {
		if let img = glyphImage {
			Image(nsImage: img).renderingMode(.template).resizable().scaledToFit()
				.frame(width: size, height: size).foregroundColor(Theme.foreground)
		} else {
			Color.clear.frame(width: size, height: size)
		}
	}
}

private struct Header: View {
	let title: String
	let onCancel: () -> Void
	var body: some View {
		VStack(spacing: 0) {
			HStack(spacing: 10) {
				Glyph(size: 22)
				Text(title).font(.system(size: 15, weight: .semibold)).foregroundColor(Theme.foreground)
				Spacer()
				Button("Cancel", action: onCancel).buttonStyle(.plain).foregroundColor(Theme.muted)
					.keyboardShortcut(.cancelAction)
			}
			.padding(.horizontal, 18).padding(.vertical, 12)
			Rectangle().fill(Theme.border).frame(height: 1).opacity(0.6)
		}
	}
}

private struct PrimaryButtonStyle: ButtonStyle {
	var filled = true
	func makeBody(configuration: Configuration) -> some View {
		configuration.label
			.font(.system(size: 13, weight: .semibold))
			.frame(maxWidth: .infinity).padding(.vertical, 9)
			.foregroundColor(filled ? Theme.background : Theme.foreground)
			.background(filled ? Theme.foreground : Color.clear)
			.clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
			.overlay(
				RoundedRectangle(cornerRadius: 8, style: .continuous)
					.stroke(filled ? Color.clear : Theme.border, lineWidth: 1))
			.opacity(configuration.isPressed ? 0.8 : 1)
			.contentShape(Rectangle())
	}
}

private struct Card<Content: View>: View {
	@ViewBuilder let content: Content
	var body: some View {
		content
			.padding(16)
			.background(Theme.card)
			.clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
			.overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.border, lineWidth: 1))
	}
}

// What can be clicked says so: a pointing hand and a lifted background while the pointer is over it.
private struct Hoverable: ViewModifier {
	@State private var hovering = false

	func body(content: Content) -> some View {
		content
			.background(hovering ? Theme.chip : Color.clear)
			.clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
			.onHover { inside in
				hovering = inside
				if inside { NSCursor.pointingHand.push() } else { NSCursor.pop() }
			}
			.onDisappear { if hovering { NSCursor.pop() } }
	}
}

extension View {
	fileprivate func hoverable() -> some View { modifier(Hoverable()) }
}

private struct Row: View {
	let badge: AnyView
	let title: String
	let subtitle: String
	@State private var hovering = false
	var body: some View {
		HStack(spacing: 10) {
			badge
				.frame(width: 32, height: 32)
				.background(Theme.chip)
				.clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
			VStack(alignment: .leading, spacing: 1) {
				Text(title).font(.system(size: 13, weight: .semibold)).foregroundColor(Theme.foreground)
					.lineLimit(1)
				if !subtitle.isEmpty {
					Text(subtitle).font(.system(size: 12)).foregroundColor(Theme.muted).lineLimit(1)
				}
			}
			Spacer(minLength: 0)
		}
		.padding(8)
		.background(hovering ? Theme.chip : Theme.card)
		.clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: 10, style: .continuous)
				.stroke(hovering ? Theme.muted.opacity(0.5) : Theme.border, lineWidth: 1))
		.contentShape(Rectangle())
		.onHover { inside in
			hovering = inside
			if inside { NSCursor.pointingHand.push() } else { NSCursor.pop() }
		}
		.onDisappear { if hovering { NSCursor.pop() } }
	}
}

// MARK: Unlock

final class UnlockModel: ObservableObject {
	@Published var password = ""
	@Published var error: String?
	@Published var busy = false
	/// Touch ID first when the desktop has it on for this vault; the password is the fallback.
	@Published var showPassword: Bool
	let canTouchId: Bool
	let onTouchId: () -> Void
	let onPassword: (String) -> Void
	let onCancel: () -> Void

	init(
		canTouchId: Bool, onTouchId: @escaping () -> Void, onPassword: @escaping (String) -> Void,
		onCancel: @escaping () -> Void
	) {
		self.canTouchId = canTouchId
		self.showPassword = !canTouchId
		self.onTouchId = onTouchId
		self.onPassword = onPassword
		self.onCancel = onCancel
	}
}

struct UnlockView: View {
	@ObservedObject var model: UnlockModel
	@State private var reveal = false
	@FocusState private var focused: Bool

	var body: some View {
		VStack(spacing: 0) {
			Header(title: "Bramble", onCancel: model.onCancel)
			VStack(spacing: 14) {
				Glyph(size: 44).padding(.top, 4)
				Text(
					model.showPassword
						? LocalizedStringKey("Enter your master password") : LocalizedStringKey("Unlock with Touch ID"))
					.font(.system(size: 15, weight: .medium)).foregroundColor(Theme.foreground)
				Card {
					VStack(spacing: 10) {
						if model.showPassword { passwordForm } else { touchIdWait }
					}
				}
			}
			.padding(18)
		}
		.frame(width: sheetWidth)
		.background(Theme.background)
	}

	private var touchIdWait: some View {
		Group {
			Button(action: touchId) {
				Label("Try Touch ID again", systemImage: "touchid")
			}
			.buttonStyle(PrimaryButtonStyle())
			.keyboardShortcut(.defaultAction)
			.disabled(model.busy)
			Button("Use master password") {
				model.error = nil
				model.showPassword = true
				focused = true
			}
			.buttonStyle(PrimaryButtonStyle(filled: false))
		}
	}

	private var passwordForm: some View {
		Group {
			HStack(spacing: 8) {
				Group {
					if reveal {
						TextField("Master password", text: $model.password)
					} else {
						SecureField("Master password", text: $model.password)
					}
				}
				.textFieldStyle(.plain)
				.focused($focused)
				.onSubmit(submit)
				.disabled(model.busy)
				Button { reveal.toggle() } label: {
					Image(systemName: reveal ? "eye.slash" : "eye").foregroundColor(Theme.muted)
				}
				.buttonStyle(.plain)
				.accessibilityLabel(reveal ? Text("Hide password") : Text("Show password"))
			}
			.padding(9)
			.background(Theme.input)
			.clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
			.overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(Theme.border, lineWidth: 1))
			if let error = model.error {
				Text(error).font(.system(size: 12)).foregroundColor(Theme.destructive)
					.frame(maxWidth: .infinity, alignment: .leading)
					.fixedSize(horizontal: false, vertical: true)
			}
			Button(action: submit) {
				if model.busy { ProgressView().controlSize(.small) } else { Text("Unlock") }
			}
			.buttonStyle(PrimaryButtonStyle())
			.keyboardShortcut(.defaultAction)
			.disabled(model.busy || model.password.isEmpty)
			if model.canTouchId {
				Button(action: touchId) { Label("Use Touch ID", systemImage: "touchid") }
					.buttonStyle(PrimaryButtonStyle(filled: false))
					.disabled(model.busy)
			}
		}
		.onAppear { focused = true }
	}

	private func touchId() {
		model.error = nil
		model.busy = true
		model.onTouchId()
	}

	private func submit() {
		guard !model.password.isEmpty, !model.busy else { return }
		model.error = nil
		model.busy = true
		model.onPassword(model.password)
	}
}

// MARK: Logins

struct LoginListView: View {
	let matches: [Cred]
	let all: [Cred]
	let requestedHost: String?
	let onSelect: (Cred) -> Void
	let onCancel: () -> Void
	@State private var showAll = false
	@State private var query = ""
	// Search text per login, lowercased once rather than on every keystroke.
	private let haystacks: [String]
	// Fixed when the sheet opens: the host sizes it once, so typing must not change its height.
	private let listHeight: CGFloat

	init(
		matches: [Cred], all: [Cred], requestedHost: String?, onSelect: @escaping (Cred) -> Void,
		onCancel: @escaping () -> Void
	) {
		self.matches = matches
		self.all = all
		self.requestedHost = requestedHost
		self.onSelect = onSelect
		self.onCancel = onCancel
		haystacks = all.map { "\($0.name) \($0.username) \($0.services.joined(separator: " "))".lowercased() }
		// A section label, the rows shown, and the "show all" line when there is one; never so
		// short that the rest of the vault is a cramped scroll once "show all" opens it.
		let rows = matches.isEmpty ? all.count : matches.count
		let more: CGFloat = matches.isEmpty || matches.count == all.count ? 0 : 26
		listHeight = min(max(28 + CGFloat(rows) * 54 + more + 14, all.count > 3 ? 320 : 0), 460)
	}

	private enum Item: Identifiable {
		case label(String)
		case login(Cred)
		case showAll(Int)

		var id: String {
			switch self {
			case .label(let text): return "label:\(text)"
			case .login(let cred): return "login:\(cred.recordId)"
			case .showAll: return "showAll"
			}
		}
	}

	// Every search token must appear somewhere in the entry, as in the app and on iOS.
	private var items: [Item] {
		let tokens = query.lowercased().split(whereSeparator: { $0.isWhitespace })
		if !tokens.isEmpty {
			let found = zip(all, haystacks).filter { _, hay in tokens.allSatisfy { hay.contains($0) } }.map(\.0)
			if found.isEmpty { return [.label(String(localized: "No logins matching \(query)"))] }
			return [.label(String(localized: "Results (\(found.count))"))] + found.map(Item.login)
		}
		if matches.isEmpty {
			let title =
				requestedHost.map { String(localized: "No matches for \($0)") }
				?? String(localized: "Items (\(all.count))")
			return [.label(title)] + all.map(Item.login)
		}
		var rows =
			[Item.label(requestedHost.map { String(localized: "For \($0)") } ?? String(localized: "Matches"))]
			+ matches.map(Item.login)
		let matched = Set(matches.map(\.recordId))
		let others = all.filter { !matched.contains($0.recordId) }
		if !others.isEmpty {
			rows += showAll ? [.label(String(localized: "All items"))] + others.map(Item.login) : [.showAll(others.count)]
		}
		return rows
	}

	var body: some View {
		VStack(spacing: 0) {
			Header(title: "Bramble", onCancel: onCancel)
			if all.isEmpty {
				Text("No logins saved yet. Add one in Bramble.")
					.font(.system(size: 12)).foregroundColor(Theme.muted).multilineTextAlignment(.center)
					.padding(28)
			} else {
				SearchField(placeholder: String(localized: "Search logins"), query: $query)
				ScrollView {
					LazyVStack(alignment: .leading, spacing: 6) {
						ForEach(items) { item in itemView(item) }
					}
					.padding(.horizontal, 18).padding(.bottom, 14)
				}
				.frame(height: listHeight)
			}
		}
		.frame(width: sheetWidth)
		.background(Theme.background)
	}

	@ViewBuilder
	private func itemView(_ item: Item) -> some View {
		switch item {
		case .label(let text):
			Text(text).font(.system(size: 11, weight: .medium)).foregroundColor(Theme.muted)
				.padding(.top, 10).padding(.bottom, 2)
		case .login(let cred):
			Button { onSelect(cred) } label: {
				Row(
					badge: AnyView(
						Text(initials(cred.name)).font(.system(size: 12, weight: .semibold))
							.foregroundColor(Theme.foreground)),
					title: cred.name, subtitle: cred.username)
			}
			.buttonStyle(.plain)
		case .showAll(let count):
			Button { showAll = true } label: {
				Text("Show all items (\(count) more)").font(.system(size: 12, weight: .medium))
					.foregroundColor(Theme.muted).padding(.vertical, 4).padding(.horizontal, 6)
			}
			.buttonStyle(.plain)
			.hoverable()
		}
	}
}

private struct SearchField: View {
	let placeholder: String
	@Binding var query: String
	var body: some View {
		HStack(spacing: 6) {
			Image(systemName: "magnifyingglass").font(.system(size: 12)).foregroundColor(Theme.muted)
			TextField(placeholder, text: $query).textFieldStyle(.plain).foregroundColor(Theme.foreground)
			if !query.isEmpty {
				Button { query = "" } label: {
					Image(systemName: "xmark.circle.fill").foregroundColor(Theme.muted)
				}
				.buttonStyle(.plain)
				.accessibilityLabel(Text("Clear search"))
			}
		}
		.padding(8)
		.background(Theme.input)
		.clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
		.overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(Theme.border, lineWidth: 1))
		.padding(.horizontal, 18).padding(.vertical, 12)
	}
}

// MARK: Passkeys

struct PasskeyPickerView: View {
	let choices: [Passkey]
	let onSelect: (Passkey) -> Void
	let onCancel: () -> Void

	var body: some View {
		VStack(spacing: 0) {
			Header(title: String(localized: "Choose a passkey"), onCancel: onCancel)
			ScrollView {
				VStack(spacing: 6) {
					ForEach(choices, id: \.credentialId) { pk in
						Button { onSelect(pk) } label: {
							Row(
								badge: AnyView(
									Image(systemName: "person.badge.key.fill").font(.system(size: 13))
										.foregroundColor(Theme.foreground)),
								title: pk.userName.isEmpty ? pk.rpId : pk.userName, subtitle: pk.rpId)
						}
						.buttonStyle(.plain)
					}
				}
				.padding(18)
			}
			.frame(height: min(CGFloat(choices.count) * 54 + 30, 360))
		}
		.frame(width: sheetWidth)
		.background(Theme.background)
	}
}

// MARK: Notices

struct NoticeView: View {
	let title: String
	let message: String
	let onDone: () -> Void

	var body: some View {
		VStack(spacing: 14) {
			Glyph(size: 36).padding(.top, 6)
			Text(title).font(.system(size: 15, weight: .semibold)).foregroundColor(Theme.foreground)
			Text(message).font(.system(size: 13)).foregroundColor(Theme.muted)
				.multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
			Button("OK", action: onDone).buttonStyle(PrimaryButtonStyle()).keyboardShortcut(.defaultAction)
		}
		.padding(22)
		.frame(width: sheetWidth)
		.background(Theme.background)
	}
}
