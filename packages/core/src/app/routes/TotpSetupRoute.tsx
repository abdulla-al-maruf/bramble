import { useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { CheckCircle2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { usePlatform } from "../../context/PlatformContext";
import { isLogin, type LoginEntry, useVault, useVaultActions } from "../../hooks/useVault";
import { classifyScannedQr, parseTotp } from "../../util/totp";
import { useToast } from "../components/ui/toast";
import { onPendingTotp, takePendingTotp } from "../pending-totp";
import { suggestedLogins } from "../screens/TotpSetup/suggest";
import { TotpSetup, TotpSetupFailure, type TotpTarget } from "../screens/TotpSetup/TotpSetup";
import { toListItem } from "../screens/VaultHome/list-item";
import { DEFAULT_SEARCH, filterAndSortEntries } from "../screens/VaultHome/vault-search";

/** At most this many suggestions: past a handful the right one is easier to search for. */
const SUGGESTIONS = 5;

/**
 * Saves an authenticator key the OS handed over. Takes the parked key on mount, so backing out
 * discards it rather than leaving a seed in memory. See docs/totp-uri-handler.md.
 */
export function TotpSetupRoute() {
	const navigate = useNavigate();
	const { entries } = useVault();
	const { addEntry, updateEntry } = useVaultActions();
	const { clipboard } = usePlatform();
	const toast = useToast();
	const { t } = useLingui();
	// Consumed once, at mount: this route is the only reader, and a key that survived a
	// second visit would be a key the user already declined to place.
	const [uri, setUri] = useState(() => takePendingTotp());
	const [query, setQuery] = useState("");
	const [copied, setCopied] = useState(false);

	// Another key while this screen is open: navigating to the route it is already on would not
	// remount it, so take the new key here.
	useEffect(
		() =>
			onPendingTotp(() => {
				const next = takePendingTotp();
				if (!next) return;
				setUri(next);
				setQuery("");
			}),
		[],
	);

	useEffect(() => {
		if (!copied) return;
		const id = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(id);
	}, [copied]);

	const scan = useMemo(() => classifyScannedQr(uri), [uri]);
	const parsed = useMemo(() => (scan.uri ? parseTotp(scan.uri) : null), [scan.uri]);

	// Nothing parked (a direct navigation, or a remount after the key was taken) is not an
	// error worth a screen: there is simply nothing to place.
	useEffect(() => {
		if (uri === null) void navigate({ to: "/vault", replace: true });
	}, [uri, navigate]);

	// Only live logins can take the key: offering an archived one would quietly un-retire it.
	const logins = useMemo(() => entries.filter(isLogin), [entries]);
	const suggested = useMemo(
		() =>
			parsed
				? suggestedLogins(logins, parsed.issuer, parsed.account).slice(0, SUGGESTIONS).map(target)
				: [],
		[logins, parsed],
	);
	// The vault list's own search and ordering, so a login is found here the way it is found there.
	const results = useMemo(() => {
		if (!query.trim()) return [];
		const byId = new Map(logins.map((e) => [e.id, e] as const));
		return filterAndSortEntries(
			entries.map((e) => toListItem(e, false)),
			{ ...DEFAULT_SEARCH, q: query, type: "login" },
		).flatMap((item) => {
			const entry = byId.get(item.id);
			return entry ? [target(entry)] : [];
		});
	}, [entries, logins, query]);

	if (uri === null) return null;

	if (!scan.uri || !parsed) {
		return (
			<TotpSetupFailure
				failure={scan.failure ?? "not-totp"}
				vendor={scan.vendor}
				onDismiss={() => void navigate({ to: "/vault" })}
			/>
		);
	}

	const key = scan.uri;
	const done = (message: string) => toast.show({ message, variant: "success", icon: CheckCircle2 });

	const createNew = async (name: string, username: string) => {
		await addEntry({ type: "login", name, urls: [], username, password: "", totp: key });
		done(t`Saved ${name} with its 2FA code`);
		void navigate({ to: "/vault" });
	};

	const add = async (entryId: string) => {
		const entry = logins.find((e) => e.id === entryId);
		if (!entry) return;
		const { id: _id, ...data } = entry;
		await updateEntry(entryId, { ...data, totp: key });
		done(t`2FA code added to ${entry.name}`);
		void navigate({ to: "/vault/$entryId", params: { entryId } });
	};

	return (
		// Keyed by the key: another one arriving while this is open starts the screen over.
		<TotpSetup
			key={key}
			issuer={parsed.issuer}
			account={parsed.account}
			totp={parsed.totp}
			copied={copied}
			onCopy={(code) =>
				void clipboard
					.copy(code)
					.then(() => setCopied(true))
					.catch(() => {})
			}
			suggested={suggested}
			results={results}
			query={query}
			onQueryChange={setQuery}
			onCreateNew={createNew}
			onAdd={add}
		/>
	);
}

function target(entry: LoginEntry): TotpTarget {
	const item = toListItem(entry, false);
	return {
		id: entry.id,
		name: item.name,
		secondary: item.secondary,
		icon: item.icon,
		initials: item.initials,
		hasTotp: Boolean(entry.totp?.trim()),
	};
}
