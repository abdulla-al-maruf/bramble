//! `otpauth://` keys handed to Bramble by macOS, when Bramble is the app picked under System
//! Settings > General > AutoFill & Passwords > Set Up Codes In. Registering the scheme in
//! Info.plist is the whole mechanism; see docs/totp-uri-handler.md, Phase 4.
//!
//! The URI carries a TOTP seed, so it is parked here and never logged or put in an event: the
//! event only says one is waiting, and the vault window takes it once. Parking also covers a cold
//! launch, where macOS delivers the URL before the webview listens.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, WebviewWindow};

use crate::lifetime;

/// Tells the vault window a key is waiting. Carries nothing.
pub const WAITING_EVENT: &str = "totp-handoff";

static PARKED: Mutex<Option<String>> = Mutex::new(None);

/// Whether Tauri's setup has run. On a cold launch macOS opens the URL before it does, and a vault
/// window built then makes setup's own build of it fail, which quits the app.
static STARTED: AtomicBool = AtomicBool::new(false);

/// `RunEvent::Ready`, which follows setup.
pub fn started() {
    STARTED.store(true, Ordering::Release);
}

fn is_otpauth(url: &str) -> bool {
    url.get(..10)
        .is_some_and(|s| s.eq_ignore_ascii_case("otpauth://"))
}

/// Park the last `otpauth://` URL among those macOS opened. Anything else is ignored: Bramble
/// registers no other scheme. Returns whether one was parked.
fn park<'a>(urls: impl IntoIterator<Item = &'a str>) -> bool {
    let Some(url) = urls.into_iter().filter(|u| is_otpauth(u)).last() else {
        return false;
    };
    *PARKED.lock().unwrap_or_else(|e| e.into_inner()) = Some(url.to_owned());
    true
}

fn take() -> Option<String> {
    PARKED.lock().unwrap_or_else(|e| e.into_inner()).take()
}

/// `RunEvent::Opened`: park the key, bring the vault window forward, and tell it to come and get
/// it. The window's own unlock comes first; core holds the key across that.
pub fn opened(app: &AppHandle, urls: &[tauri::Url]) {
    if !park(urls.iter().map(|u| u.as_str())) {
        return;
    }
    // Setup is about to show the vault window, which takes the key as it loads.
    if !STARTED.load(Ordering::Acquire) {
        return;
    }
    lifetime::show_main(app);
    let _ = app.emit_to(lifetime::MAIN, WAITING_EVENT, ());
}

/// The parked key, once. Only the vault window gets it: the quick-access panel is a webview too.
#[tauri::command]
pub fn totp_handoff_take(window: WebviewWindow) -> Option<String> {
    (window.label() == lifetime::MAIN).then(take).flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    // One test, because PARKED is process-wide and the test runner is multi-threaded.
    #[test]
    fn keeps_only_otpauth_and_hands_it_over_once() {
        assert!(!park(["https://bramble.sh", "mailto:a@b.c", "otpauth"]));
        assert_eq!(take(), None);

        assert!(park([
            "otpauth://totp/A?secret=AAAA",
            "https://bramble.sh",
            "OTPAUTH://totp/B?secret=BBBB",
        ]));
        assert_eq!(take().as_deref(), Some("OTPAUTH://totp/B?secret=BBBB"));
        assert_eq!(take(), None);

        // Setting up a second site in the same session.
        assert!(park(["otpauth://totp/C?secret=CCCC"]));
        assert_eq!(take().as_deref(), Some("otpauth://totp/C?secret=CCCC"));
    }
}
