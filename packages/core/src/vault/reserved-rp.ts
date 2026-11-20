// The extension's own unlock key lives under this rpID, so no Bramble provider may hold or answer
// a passkey for it. Same rule as is_reserved_rp_id in core-rust. See docs/macos-credential-provider.md.
export const UNLOCK_RP_ID = "bramble.sh";

export function isReservedRpId(rpId: string): boolean {
	const id = rpId.endsWith(".") ? rpId.slice(0, -1) : rpId;
	return id.toLowerCase() === UNLOCK_RP_ID;
}
