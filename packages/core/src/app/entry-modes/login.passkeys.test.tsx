/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Entry } from "../../hooks/useVault";
import { loginMode } from "./login";

vi.mock("../../hooks/usePrefs", () => ({ usePrefs: () => ({ prefs: {} }) }));

afterEach(cleanup);

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

const passkey = (rpId: string, userName: string) => ({
	credentialId: `${rpId}-id`,
	rpId,
	userName,
	userHandle: "dXNlcg",
	alg: -7,
	publicKeyCose: "pk",
	privateKey: "sk",
	signCount: 0,
	createdAt: 0,
});

function renderDetail(passkeys: ReturnType<typeof passkey>[]) {
	const entry = {
		id: "e1",
		type: "login",
		name: "Vault",
		urls: [],
		username: "",
		password: "",
		passkeys,
	} as unknown as Entry;
	const Detail = loginMode.Detail;
	render(
		<I18nProvider i18n={i18n}>
			<Detail entry={entry} copied={null} copy={() => {}} />
		</I18nProvider>,
	);
}

describe("login detail passkeys", () => {
	it("marks a bramble.sh passkey as not used for sign-in", () => {
		renderDetail([passkey("bramble.sh", "vault@local")]);
		expect(screen.getByText("Unlocks Bramble, so it isn't used to sign in")).toBeTruthy();
	});

	it("says nothing for an ordinary passkey", () => {
		renderDetail([passkey("example.com", "me")]);
		expect(screen.queryByText("Unlocks Bramble, so it isn't used to sign in")).toBeNull();
	});
});
