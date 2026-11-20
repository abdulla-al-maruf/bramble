/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, type RenderResult, render, screen } from "@testing-library/react";
import { KeyRound } from "lucide-react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseTotp } from "../../../util/totp";
import { TotpSetup, TotpSetupFailure, type TotpTarget } from "./TotpSetup";

const draw = (ui: React.ReactNode): RenderResult =>
	render(<I18nProvider i18n={i18n}>{ui}</I18nProvider>);

afterEach(cleanup);

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

const target = (id: string, overrides: Partial<TotpTarget> = {}): TotpTarget => ({
	id,
	name: id,
	secondary: "user@example.com",
	icon: KeyRound,
	hasTotp: false,
	...overrides,
});

const parsed = parseTotp("otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub");
if (!parsed) throw new Error("fixture key does not parse");
const KEY = parsed.totp;

const setup = (props: Partial<Parameters<typeof TotpSetup>[0]> = {}) => {
	const onCreateNew = vi.fn(async (_name: string, _username: string) => {});
	const onAdd = vi.fn(async (_id: string) => {});
	draw(
		<TotpSetup
			issuer="GitHub"
			account="octocat"
			totp={KEY}
			copied={false}
			onCopy={vi.fn()}
			suggested={[target("github")]}
			results={[]}
			query=""
			onQueryChange={vi.fn()}
			onCreateNew={onCreateNew}
			onAdd={onAdd}
			{...props}
		/>,
	);
	return { onCreateNew, onAdd };
};

const pressed = (name: string) =>
	screen.getByRole("button", { name }).getAttribute("aria-pressed") === "true";

describe("TotpSetup", () => {
	it("says what arrived and for which account", () => {
		setup();
		expect(screen.getByText("Add 2FA code")).toBeTruthy();
		expect(screen.getByText("GitHub · octocat")).toBeTruthy();
	});

	// Sites ask for a code to finish turning 2FA on, so it has to be on this screen already.
	it("shows the current code", () => {
		setup();
		expect(screen.getByLabelText("Copy verification code")).toBeTruthy();
		expect(screen.getByText(/finish setting up/)).toBeTruthy();
	});

	it("opens on the existing logins when one matches, and adds with one tap", () => {
		const { onAdd } = setup();
		expect(pressed("Existing login")).toBe(true);
		fireEvent.click(screen.getByLabelText("Add the 2FA code to github"));
		expect(onAdd).toHaveBeenCalledWith("github");
	});

	it("opens on a new login when nothing matches", () => {
		setup({ suggested: [] });
		expect(pressed("New login")).toBe(true);
		expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("GitHub");
		expect((screen.getByLabelText("Username") as HTMLInputElement).value).toBe("octocat");
	});

	it("saves a new login under the name and username as edited", () => {
		const { onCreateNew } = setup({ suggested: [] });
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: " GitHub work " } });
		fireEvent.change(screen.getByLabelText("Username"), { target: { value: "octo-work" } });
		fireEvent.click(screen.getByText("Save new login"));
		expect(onCreateNew).toHaveBeenCalledWith("GitHub work", "octo-work");
	});

	it("won't save a new login without a name", () => {
		setup({ suggested: [] });
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  " } });
		expect(screen.getByText("Save new login").closest("button")?.disabled).toBe(true);
	});

	// Replacing loses a key that presumably still works, so it asks first, in the row.
	it("asks before replacing a login's existing code", () => {
		const { onAdd } = setup({ suggested: [target("a", { hasTotp: true })] });
		fireEvent.click(screen.getByLabelText("Replace the 2FA code in a"));
		expect(onAdd).not.toHaveBeenCalled();
		expect(screen.getByText("Replace its code?")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Replace" }));
		expect(onAdd).toHaveBeenCalledWith("a");
	});

	it("shows search results instead of the suggestions while searching", () => {
		setup({ query: "bank", results: [target("bank")] });
		expect(screen.queryByLabelText("Add the 2FA code to github")).toBeNull();
		expect(screen.getByLabelText("Add the 2FA code to bank")).toBeTruthy();
	});

	it("says so when the search matches nothing", () => {
		setup({ query: "zzz" });
		expect(screen.getByText("No logins match.")).toBeTruthy();
	});

	it("says so when saving fails, and lets the user try again", async () => {
		setup({ suggested: [], onCreateNew: vi.fn(async () => Promise.reject(new Error("disk"))) });
		fireEvent.click(screen.getByText("Save new login"));
		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(screen.getByText("Save new login")).toBeTruthy();
	});
});

describe("TotpSetupFailure", () => {
	// The scanner's copy blames the QR ("make it visible and retry"), which is nonsense for
	// a link an app sent us. Each verdict has to name the way out that actually applies.
	it("names the vendor whose app the link activates", () => {
		draw(
			<TotpSetupFailure
				failure="vendor-app"
				vendor="Microsoft Authenticator"
				onDismiss={vi.fn()}
			/>,
		);
		expect(screen.getByText(/Microsoft Authenticator/)).toBeTruthy();
	});

	it("explains an export blob rather than calling it invalid", () => {
		draw(<TotpSetupFailure failure="migration" onDismiss={vi.fn()} />);
		expect(screen.getByText(/several accounts/)).toBeTruthy();
	});

	it("calls out HOTP, the one shape that parses but can't be generated", () => {
		draw(<TotpSetupFailure failure="not-totp" onDismiss={vi.fn()} />);
		expect(screen.getByText(/HOTP/)).toBeTruthy();
	});

	it("dismisses back to the vault", () => {
		const onDismiss = vi.fn();
		draw(<TotpSetupFailure failure="not-found" onDismiss={onDismiss} />);
		fireEvent.click(screen.getByText("Back to vault"));
		expect(onDismiss).toHaveBeenCalled();
	});
});
