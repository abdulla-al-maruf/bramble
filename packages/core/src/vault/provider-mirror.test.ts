import { describe, expect, it } from "vitest";
import type { IndexEntry } from "../adapters/autofill";
import { buildProviderMirror } from "./provider-mirror";

function login(over: Partial<IndexEntry> = {}): IndexEntry {
	return {
		type: "login",
		id: "e1",
		name: "GitHub",
		username: "me@example.com",
		password: "pw",
		hostnames: ["www.github.com", "gist.github.com"],
		...over,
	} as IndexEntry;
}

const passkey = (rpId: string) => ({
	credentialId: `${rpId}-id`,
	rpId,
	userName: "me",
	userHandle: "dXNlcg",
	privateKey: "sk",
	alg: -7,
	publicKeyCose: "pk",
	signCount: 0,
	createdAt: 0,
});

describe("buildProviderMirror", () => {
	it("publishes a code identity per host for logins with a TOTP key", () => {
		const m = buildProviderMirror([login({ totp: "JBSWY3DPEHPK3PXP" })], { quickType: true });
		expect(m.oneTimeCodeIdentities).toEqual([
			{ recordId: "e1", label: "me@example.com", service: "github.com" },
			{ recordId: "e1", label: "me@example.com", service: "gist.github.com" },
		]);
		expect(m.identities.map((i) => i.service)).toEqual(["github.com", "gist.github.com"]);
		expect(m.credentials[0]?.totp).toBe("JBSWY3DPEHPK3PXP");
	});

	it("emits no QuickType identities without the opt-in, but always the passkey ones", () => {
		const m = buildProviderMirror(
			[login({ totp: "X", passkeys: [passkey("github.com")] } as Partial<IndexEntry>)],
			{ quickType: false },
		);
		expect(m.identities).toEqual([]);
		expect(m.oneTimeCodeIdentities).toEqual([]);
		expect(m.passkeyIdentities.map((p) => p.rpId)).toEqual(["github.com"]);
	});

	it("never mirrors a bramble.sh passkey", () => {
		const m = buildProviderMirror(
			[login({ passkeys: [passkey("bramble.sh"), passkey("github.com")] } as Partial<IndexEntry>)],
			{ quickType: true },
		);
		expect(m.passkeys.map((p) => p.rpId)).toEqual(["github.com"]);
		expect(m.passkeyIdentities.map((p) => p.rpId)).toEqual(["github.com"]);
	});

	it("keeps a passkey-only login's passkeys and lists no password for it", () => {
		const m = buildProviderMirror(
			[login({ password: "", passkeys: [passkey("github.com")] } as Partial<IndexEntry>)],
			{ quickType: true },
		);
		expect(m.credentials).toEqual([]);
		expect(m.passkeys).toHaveLength(1);
	});

	it("serves unlock keys only when the platform asks, without the reserved-rpID filter", () => {
		const unlock = {
			type: "unlock-key",
			id: "u",
			passkey: passkey("bramble.sh"),
		} as unknown as IndexEntry;
		const mac = buildProviderMirror([login(), unlock], {
			quickType: false,
			includeUnlockKeys: true,
		});
		expect(mac.passkeys.map((p) => p.rpId)).toEqual(["bramble.sh"]);
		expect(mac.passkeyIdentities.map((p) => p.rpId)).toEqual(["bramble.sh"]);
		const phone = buildProviderMirror([login(), unlock], { quickType: false });
		expect(phone.passkeys).toEqual([]);
	});
});
