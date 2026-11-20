import {
	drainHandoff as drain,
	type EncryptedRecord,
	type HandoffBridge,
} from "@core/vault/encrypted-handoff";
import { mobileCrypto } from "./adapters/crypto";

export type { EncryptedRecord, HandoffBridge };

/** The core drain with the app's VEK, for the AutofillBridge handoffs. */
export function drainHandoff<T>(
	bridge: HandoffBridge,
	read: (json: unknown) => T | null,
): Promise<T[]> {
	return drain(bridge, (iv, ct) => mobileCrypto.decryptWithVek(iv, ct), read);
}
