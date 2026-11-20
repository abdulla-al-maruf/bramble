#!/usr/bin/env node
// Fetch the macOS Developer ID provisioning profiles the desktop bundle and its appex embed.
// Profiles are fetched rather than committed: they go stale whenever the signing certificate is
// renewed, so a copy in git silently rots. Reuses the App Store Connect key (scripts/asc-api-key.ts).

import { createPrivateKey, createSign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ascApiKey } from "./asc-api-key.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "clients/desktop/macos/profiles");

/** Which profile goes where. Keyed by the bundle id, because profile names are free text. */
const WANTED: Record<string, string> = {
	"app.bramble.desktop": "Bramble.provisionprofile",
	"app.bramble.desktop.autofill": "BrambleAutoFill.provisionprofile",
};

const fail = (message: string): never => {
	console.error(message);
	process.exit(1);
};

/** ES256 JWT, the only auth the App Store Connect API takes. Ten minutes is its maximum. */
function token(): string {
	const key = ascApiKey(fail) ?? fail("no App Store Connect API key; see docs/release-signing.md.");
	const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
	const now = Math.floor(Date.now() / 1000);
	const head = b64({ alg: "ES256", kid: key.keyId, typ: "JWT" });
	const body = b64({ iss: key.issuerId, iat: now, exp: now + 600, aud: "appstoreconnect-v1" });
	const signer = createSign("SHA256");
	signer.update(`${head}.${body}`);
	signer.end();
	const sig = signer
		.sign({ key: createPrivateKey(key.key), dsaEncoding: "ieee-p1363" })
		.toString("base64url");
	return `${head}.${body}.${sig}`;
}

const jwt = token();
const api = async (path: string): Promise<Record<string, never>> => {
	const r = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
		headers: { Authorization: `Bearer ${jwt}` },
	});
	if (!r.ok) fail(`App Store Connect ${r.status} for ${path}\n${(await r.text()).slice(0, 400)}`);
	return r.json() as Promise<Record<string, never>>;
};

type Profile = {
	id: string;
	attributes: { name: string; profileType: string; profileState: string; profileContent: string };
};

// MAC_APP_DIRECT is Developer ID. The other Mac types are App Store and development, and embedding
// one of those would produce a build that only runs on registered machines.
const profiles = (await api(
	// bundleId must be in fields[profiles] or the API drops `relationships` wholesale, leaving
	// `included` present but impossible to join against.
	"/v1/profiles?limit=200&filter[profileType]=MAC_APP_DIRECT&include=bundleId&fields[profiles]=name,profileType,profileState,profileContent,bundleId",
)) as unknown as {
	data: Profile[];
	included?: { id: string; attributes: { identifier: string } }[];
};

const byProfileId = new Map<string, string>();
for (const p of profiles.data) {
	const rel = (p as unknown as { relationships?: { bundleId?: { data?: { id: string } } } })
		.relationships;
	const bundleRef = rel?.bundleId?.data?.id;
	const identifier = profiles.included?.find((i) => i.id === bundleRef)?.attributes.identifier;
	if (identifier) byProfileId.set(identifier, p.id);
}

mkdirSync(outDir, { recursive: true });
for (const [identifier, filename] of Object.entries(WANTED)) {
	const match = profiles.data.find((p) => byProfileId.get(identifier) === p.id);
	if (!match)
		fail(
			`no ACTIVE Developer ID profile for ${identifier}.\n` +
				"Create one at developer.apple.com/account/resources/profiles against the\n" +
				"Developer ID Application certificate. See docs/macos-credential-provider.md.",
		);
	if (match.attributes.profileState !== "ACTIVE")
		fail(
			`the profile for ${identifier} is ${match.attributes.profileState}, not ACTIVE. Regenerate it.`,
		);
	const path = join(outDir, filename);
	writeFileSync(path, Buffer.from(match.attributes.profileContent, "base64"));
	console.error(`fetched ${identifier} -> macos/profiles/${filename} (${match.attributes.name})`);
}
