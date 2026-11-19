// Push the Firefox (AMO) store listing summary + description, localized, from
// clients/extension/store/firefox/<locale>/*.txt. One PATCH updates every
// locale at once. The name + short manifest description already localize from the
// package _locales (see chrome-manifest.mjs); this is the long detailed description
// (and optionally a richer summary), which is not a manifest field. The same PATCH sends
// the contact and donation links from store/firefox/listing.json.
//
//   node scripts/metadata-firefox.ts             # PATCH the live AMO listing
//   node scripts/metadata-firefox.ts --dry-run   # print what would be sent, send nothing
//
// Auth reuses the signing credentials: AMO_API_KEY + AMO_API_SECRET in the env, or the
// age-encrypted ~/.config/bramble/amo-api-credentials.age (override AMO_CREDENTIALS_AGE)
// holding { "apiKey": "...", "apiSecret": "..." }. See docs/release-signing.md.

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { amoJwt } from "./amo-auth.ts";
import { notifyYubiKeyTouch } from "./yubikey-notify.ts";

const DRY_RUN = process.argv.includes("--dry-run");
const STORE = resolve("clients/extension/store/firefox");
const MANIFEST = resolve("packages/manifests/firefox/manifest.json");
// Override AMO_BASE_URL for a staging instance; strip a trailing slash for URL joins.
const API_BASE = (process.env.AMO_BASE_URL ?? "https://addons.mozilla.org/api/v5/").replace(
	/\/$/,
	"",
);
const HOME = process.env.HOME ?? "";
const CREDS_AGE =
	process.env.AMO_CREDENTIALS_AGE ?? join(HOME, ".config/bramble/amo-api-credentials.age");

// store dir code -> AMO locale code (AMO uses Mozilla codes: es-ES, pt-BR, en-US).
const AMO_LOCALE: Record<string, string> = {
	en: "en-US",
	de: "de",
	es: "es-ES",
	fr: "fr",
	it: "it",
	ko: "ko",
	bn: "bn",
	"pt-BR": "pt-BR",
};
// store filename -> AMO listing field.
const FIELDS: Record<string, string> = {
	"summary.txt": "summary",
	"description.txt": "description",
};
// Long text fields print as lengths in the dry run; short ones print in full.
const FIELDS_SHOWN_BY_LENGTH = new Set(Object.values(FIELDS));

const fail = (msg: string): never => {
	console.error(`error: ${msg}`);
	process.exit(1);
};
const has = (bin: string) => {
	try {
		execFileSync("/bin/sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

if (!existsSync(STORE)) fail(`no ${STORE}; add store/firefox/<locale>/*.txt first`);
const guid = JSON.parse(readFileSync(MANIFEST, "utf8")).browser_specific_settings?.gecko?.id;
if (!guid) fail("no browser_specific_settings.gecko.id in the Firefox manifest");

// Build { summary: {locale: text}, description: {locale: text} } from the files present.
const texts: Record<string, Record<string, string>> = {};
for (const dir of readdirSync(STORE)) {
	if (!statSync(join(STORE, dir)).isDirectory()) continue;
	const amo =
		AMO_LOCALE[dir] ?? fail(`no AMO locale for store/firefox/${dir}; add it to AMO_LOCALE`);
	for (const [file, field] of Object.entries(FIELDS)) {
		const path = join(STORE, dir, file);
		if (!existsSync(path)) continue;
		texts[field] ??= {};
		texts[field][amo] = readFileSync(path, "utf8").trim();
	}
}
if (!Object.keys(texts).length)
	fail("no summary.txt / description.txt under store/firefox/<locale>/");
const payload: Record<string, Record<string, string> | string> = { ...texts };

// Contact and donation links. AMO stores support_email/support_url per locale, so they go
// under en-US (the default locale); contributions_url is a plain string.
const LINKS = join(STORE, "listing.json");
if (existsSync(LINKS)) {
	const links = JSON.parse(readFileSync(LINKS, "utf8"));
	for (const field of ["support_email", "support_url"])
		if (links[field]) payload[field] = { "en-US": links[field] };
	if (links.contributions_url) payload.contributions_url = links.contributions_url;
}

console.log(`AMO listing for ${guid} (${API_BASE})`);
for (const [field, value] of Object.entries(payload)) {
	const shown =
		typeof value === "string"
			? value
			: Object.entries(value)
					.map(([l, t]) => (FIELDS_SHOWN_BY_LENGTH.has(field) ? `${l}(${t.length})` : `${l}: ${t}`))
					.join("  ");
	console.log(`  ${field}: ${shown}`);
}
if (DRY_RUN) {
	console.log("\ndry run — omit --dry-run to PATCH the live listing.");
	process.exit(0);
}

// Resolve credentials: env first, else the age-encrypted JSON (YubiKey PIN + touch).
let apiKey = process.env.AMO_API_KEY;
let apiSecret = process.env.AMO_API_SECRET;
const tmp = mkdtempSync(join(tmpdir(), "bramble-amo-meta-"));
try {
	if (!apiKey || !apiSecret) {
		if (!existsSync(CREDS_AGE))
			fail(
				`no AMO credentials: set AMO_API_KEY + AMO_API_SECRET, or provide ${CREDS_AGE} (override AMO_CREDENTIALS_AGE). See docs/release-signing.md`,
			);
		for (const bin of ["age", "age-plugin-yubikey"])
			if (!has(bin)) fail(`${bin} not found; see docs/release-signing.md`);
		const idFile = join(tmp, "id.txt");
		const credFile = join(tmp, "creds.json");
		writeFileSync(idFile, execFileSync("age-plugin-yubikey", ["--identity"]));
		notifyYubiKeyTouch("decrypt the AMO API credentials");
		execFileSync("age", ["-d", "-i", idFile, "-o", credFile, CREDS_AGE], { stdio: "inherit" });
		const parsed = JSON.parse(readFileSync(credFile, "utf8"));
		apiKey = parsed.apiKey;
		apiSecret = parsed.apiSecret;
		if (!apiKey || !apiSecret)
			fail(`${CREDS_AGE} must decrypt to JSON { "apiKey": "...", "apiSecret": "..." }`);
	}

	// AMO auth is a short-lived HS256 JWT: iss = API key, per-request jti, exp <= 5 min.
	const token = amoJwt(apiKey as string, apiSecret as string);

	const url = `${API_BASE}/addons/addon/${guid}/`;
	const res = await fetch(url, {
		method: "PATCH",
		headers: { "content-type": "application/json", authorization: `JWT ${token}` },
		body: JSON.stringify(payload),
	});
	if (!res.ok) fail(`AMO PATCH ${res.status}: ${await res.text()}`);
	const locales = Object.keys(texts.description ?? texts.summary ?? {}).length;
	console.log(`\npushed ${Object.keys(payload).join(" + ")} (${locales} locale(s)) to ${guid}.`);
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
