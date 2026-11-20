import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Check, KeyRound, Link2 } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { useToast } from "../app/components/ui/toast";
import { usePlatform } from "../context/PlatformContext";
import { planAssociationUpdates } from "../vault/association";
import { planPasskeyPlacement, withPasskey } from "../vault/passkey";
import { planPendingLogins } from "../vault/pending-login";
import { pendingPasskeyToast } from "./pending-passkey-toast";
import { useVault } from "./useVault";
import { useVaultRegistry } from "./useVaultRegistry";

// Every provider handoff, one serial drain: mutations snapshot and persist the whole
// entry list, so two concurrent drains would race and the second write would wipe the
// first.
export function usePendingHandoffs(): void {
	const { shell } = usePlatform();
	const { addEntry, updateEntry, readEntries, isLocked, ready } = useVault();
	const { activeId } = useVaultRegistry();
	const { show } = useToast();
	const latest = useRef({ addEntry, updateEntry, readEntries, activeId, show, isLocked, ready });
	latest.current = { addEntry, updateEntry, readEntries, activeId, show, isLocked, ready };
	const draining = useRef(false);

	const drainNow = useCallback(async () => {
		const drainPasskeys = shell.consumePendingPasskeys;
		const { ready, isLocked } = latest.current;
		if (!drainPasskeys || !ready || isLocked || draining.current) return;
		draining.current = true;
		try {
			for (const pk of (await drainPasskeys()) ?? []) {
				const { addEntry, updateEntry, readEntries, show } = latest.current;
				try {
					const placement = planPasskeyPlacement(readEntries(), pk.rpId, pk.rpName, pk);
					let loginName: string;
					let type: "login" | "unlock-key" = "login";
					if (placement.kind === "create") {
						await addEntry(placement.data);
						loginName = placement.data.name;
						type = placement.data.type;
					} else {
						const entry = readEntries().find((e) => e.id === placement.entryId);
						if (entry?.type !== "login") continue;
						const { id: _id, ...data } = entry;
						await updateEntry(placement.entryId, {
							...data,
							passkeys: withPasskey(entry.passkeys, placement.passkey),
						});
						loginName = entry.name;
					}
					show({
						message: pendingPasskeyToast(placement.kind, type, loginName),
						variant: "success",
						icon: KeyRound,
					});
				} catch {
					// One bad passkey shouldn't drop the rest of the drained batch.
				}
			}

			const drainAssociations = shell.consumePendingAssociations;
			if (drainAssociations) {
				const { updateEntry, readEntries, activeId, show } = latest.current;
				const updates = planAssociationUpdates(readEntries(), activeId, await drainAssociations());
				for (const u of updates) {
					try {
						await updateEntry(u.entryId, u.data);
						show({
							message: i18n._(msg`Saved ${u.label} to ${u.entryName}`),
							variant: "success",
							icon: Link2,
						});
					} catch {
						// One failed update drops just its association.
					}
				}
			}

			const peekLogins = shell.peekPendingLogins;
			const removeLogins = shell.removePendingLogins;
			if (peekLogins && removeLogins) {
				const plan = planPendingLogins(latest.current.readEntries(), await peekLogins());
				for (const { key, data } of plan.add) {
					const { addEntry, show } = latest.current;
					try {
						await addEntry(data);
					} catch {
						// Left queued for the next drain: its password is already on a sign-up form.
						continue;
					}
					// A failed remove is harmless: the next drain finds it saved and only removes it.
					await removeLogins([key]).catch(() => {});
					show({
						message: i18n._(msg`Login saved for ${data.name}`),
						variant: "success",
						icon: Check,
					});
				}
				if (plan.done.length > 0) await removeLogins(plan.done).catch(() => {});
			}
		} finally {
			draining.current = false;
		}
	}, [shell]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: ready/isLocked are the unlock trigger
	useEffect(() => {
		void drainNow();
	}, [drainNow, ready, isLocked]);

	useEffect(() => {
		const onVisible = () => {
			if (document.visibilityState === "visible") void drainNow();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, [drainNow]);
}
