/// <reference types="chrome" />

import { lastNormalWindow } from "../normal-window";
import { api } from "../platform-api";
import { sendToOffscreen } from "./offscreen-client";
import { type MessageEnvelope, on } from "./router";

async function captureQrScan(): Promise<MessageEnvelope> {
	// The browsing window, not a detached pop-out in front of it.
	const win = await lastNormalWindow();
	if (win?.id === undefined) {
		return { ok: false, error: "No browser window to capture" };
	}
	// PNG, not JPEG: lossless pixels decode QR far more reliably. Capture must stay in the
	// background (tabs API), but the decode runs in the host document, where jsqr's lazy
	// import() is reliable — it is not from an idle, restarted MV3 service worker.
	const dataUrl = await api.tabs.captureVisibleTab(win.id, { format: "png" });
	const res = await sendToOffscreen({ type: "QR_DECODE", payload: { dataUrl } });
	if (!res.ok) return { ok: false, error: res.error ?? "QR decode failed" };
	return { ok: true, data: (res.data as string | null) ?? null };
}

on("CAPTURE_QR_SCAN", captureQrScan);
