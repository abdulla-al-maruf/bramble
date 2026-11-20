import { useEffect, useRef } from "react";
import { setPendingTotp } from "../pending-totp";

/**
 * One arrival of an `otpauth://` key from the OS. A new object per arrival, even for the same
 * link: opening a setup link twice is two arrivals, while the shell holding on to the last one
 * across a lock is not.
 */
export interface TotpHandoff {
	uri: string;
}

/**
 * Park a handed-over key and open the setup screen, once the vault is open. Deferred past unlock
 * because being launched from another app while locked is the normal case. See
 * docs/totp-uri-handler.md.
 */
export function useTotpHandoffRoute(
	handoff: TotpHandoff | undefined,
	open: boolean,
	go: () => void,
): void {
	const routed = useRef<TotpHandoff | null>(null);
	useEffect(() => {
		if (!handoff || !open || routed.current === handoff) return;
		routed.current = handoff;
		setPendingTotp(handoff.uri);
		go();
	}, [handoff, open, go]);
}
