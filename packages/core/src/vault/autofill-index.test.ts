import { describe, expect, it } from "vitest";
import type { Entry } from "../hooks/useVault";
import { loginHosts, toAutofillIndex } from "./autofill-index";

describe("loginHosts", () => {
	it("lines each URL's port up with its hostname", () => {
		expect(
			loginHosts([
				"http://nas.local:5000/webman",
				"androidapp://com.synology.dsfile",
				"",
				"https://nas.local",
				"http://[fe80::1]:8080/",
			]),
		).toEqual({
			hostnames: ["nas.local", "nas.local", "[fe80::1]"],
			ports: ["5000", "", "8080"],
		});
	});

	it("leaves ports out when no URL names one", () => {
		expect(loginHosts(["https://example.com/login", "example.org"])).toEqual({
			hostnames: ["example.com", "example.org"],
		});
	});

	it("reads a bare host with a port as https", () => {
		expect(loginHosts(["example.com:1234", "localhost:8080/admin", "192.168.1.10:5000"])).toEqual({
			hostnames: ["example.com", "localhost", "192.168.1.10"],
			ports: ["1234", "8080", "5000"],
		});
	});

	it("reads a scheme's own default port as none", () => {
		expect(loginHosts(["https://nas.local:443", "http://nas.local:80"])).toEqual({
			hostnames: ["nas.local", "nas.local"],
		});
		expect(loginHosts(["http://nas.local:443"]).ports).toEqual(["443"]);
	});
});

describe("toAutofillIndex", () => {
	it("carries a login's ports into its index entry", () => {
		const login = {
			type: "login",
			id: "dsm",
			name: "DSM",
			urls: ["http://192.168.1.10:5000"],
			username: "admin",
			password: "pw",
			subdomainMatch: "exact",
		} as unknown as Entry;
		expect(toAutofillIndex([login])[0]).toMatchObject({
			hostnames: ["192.168.1.10"],
			ports: ["5000"],
			subdomainMatch: "exact",
		});
	});

	it("drops bramble.sh passkeys from the index but keeps the entry's others", () => {
		const pk = (credentialId: string, rpId: string) => ({
			credentialId,
			rpId,
			userHandle: "dXNlcg",
			alg: -7,
			publicKeyCose: "pk",
			privateKey: "sk",
			signCount: 0,
			createdAt: 0,
		});
		const both = {
			type: "login",
			id: "both",
			name: "Both",
			urls: ["https://example.com"],
			username: "u",
			password: "p",
			passkeys: [pk("unlock", "bramble.sh"), pk("site", "example.com")],
		} as unknown as Entry;
		const onlyUnlock = {
			type: "login",
			id: "only",
			name: "Vault",
			urls: [],
			username: "vault@local",
			password: "",
			passkeys: [pk("unlock2", "bramble.sh")],
		} as unknown as Entry;
		const [a, b] = toAutofillIndex([both, onlyUnlock]) as {
			passkeys?: { credentialId: string }[];
		}[];
		expect(a?.passkeys?.map((p) => p.credentialId)).toEqual(["site"]);
		expect(b?.passkeys).toBeUndefined();
	});

	it("projects an unlock-key entry as its own item, for the macOS AutoFill extension only", () => {
		const passkey = {
			credentialId: "Y2lk",
			rpId: "bramble.sh",
			userHandle: "dWg=",
			alg: -7,
			publicKeyCose: "pk",
			privateKey: "sk",
			signCount: 0,
			createdAt: 0,
		};
		const entry = { id: "u", type: "unlock-key", name: "bramble.sh", passkey } as unknown as Entry;
		expect(toAutofillIndex([entry])).toEqual([{ type: "unlock-key", id: "u", passkey }]);
	});
});
