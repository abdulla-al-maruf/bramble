import { Trans, useLingui } from "@lingui/react/macro";
import { Fingerprint } from "lucide-react";
import { useState } from "react";
import { useVault, useVaultActions } from "../../../../hooks/useVault";
import { formatDate } from "../../../../util/format-date";
import { Button } from "../../../components/ui/button";
import { InlineConfirm } from "../../../components/ui/inline-confirm";
import { cn } from "../../../components/ui/utils";
import { Row } from "./primitives";

/**
 * The browser extension's Touch ID keys this Mac's AutoFill extension holds. They stay on this
 * device and nothing else lists them. Removing one sends that browser back to its master password.
 */
export function BrowserUnlockKeysSection() {
	const { unlockKeys } = useVault();
	const { deleteEntry } = useVaultActions();
	const { t } = useLingui();
	// The key being asked about, so its note can run under the whole row.
	const [removingId, setRemovingId] = useState<string | null>(null);
	if (unlockKeys.length === 0) return null;
	return (
		<div>
			<Row
				icon={<Fingerprint className="w-4 h-4 text-primary" />}
				title={t`Touch ID for your browser`}
				subtitle={t`Bramble unlocks the browser extension when you use Touch ID there.`}
			>
				{null}
			</Row>
			<ul className="ml-12 mt-2 space-y-1.5">
				{unlockKeys.map((k) => {
					const added = formatDate(k.passkey.createdAt);
					// Keys set up before the extension named them all carry "vault@local".
					const name = k.passkey.userName === "vault@local" ? "" : k.passkey.userName?.trim();
					return (
						<li key={k.id} className="text-xs rounded-md border border-border/40 px-3 py-1.5">
							<div className="flex items-center justify-between gap-3">
								<span className="flex flex-col gap-px min-w-0">
									{name && <span className="truncate">{name}</span>}
									<span className={cn("whitespace-nowrap", name && "text-muted-foreground")}>
										{t`Added ${added}`}
									</span>
								</span>
								<InlineConfirm
									className="shrink-0"
									armed={removingId === k.id}
									onArmedChange={(armed) => setRemovingId(armed ? k.id : null)}
									confirmLabel={<Trans>Remove</Trans>}
									busyLabel={<Trans>Removing…</Trans>}
									onConfirm={() => deleteEntry(k.id)}
									trigger={(arm) => (
										<Button
											variant="link"
											size="none"
											onClick={arm}
											className="hover:text-destructive transition-colors"
											aria-label={name ? t`Remove ${name}` : t`Remove the key added ${added}`}
											title={name ? t`Remove ${name}` : t`Remove the key added ${added}`}
										>
											×
										</Button>
									)}
								/>
							</div>
							{removingId === k.id && (
								<p className="mt-1.5 text-muted-foreground">
									<Trans>
										That browser asks for its master password next time. Remove the key in that
										browser too.
									</Trans>
								</p>
							)}
						</li>
					);
				})}
			</ul>
		</div>
	);
}
