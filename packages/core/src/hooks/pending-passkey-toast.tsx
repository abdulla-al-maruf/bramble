import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/** What the app says after taking in a passkey the OS AutoFill extension created. */
export function pendingPasskeyToast(
	kind: "create" | "attach",
	type: "login" | "unlock-key",
	name: string,
): string {
	if (type === "unlock-key") return i18n._(msg`Touch ID for your browser is set up`);
	return kind === "create"
		? i18n._(msg`Passkey saved as ${name}`)
		: i18n._(msg`Passkey added to ${name}`);
}
