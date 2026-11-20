//! The macOS AutoFill extension's copy of the vault, written where its sandbox can read it (the
//! App Group container), plus the identities the OS lists. See docs/macos-credential-provider.md.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

/// The App Group the app and the extension share; read back with `codesign -d --entitlements`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const GROUP: &str = "BHGR3PP64J.group.app.bramble.desktop";
const MIRROR_FILE: &str = "autofill.json";
/// Passkeys the extension created, VEK-encrypted, for the app to merge into the vault.
const PENDING_FILE: &str = "pending-passkeys.json";

/// What the webview hands over: everything VEK-encrypted already, identities in the clear (they
/// are metadata, and go to the OS store rather than to disk).
#[derive(Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Mirror {
    pub iv: String,
    pub ciphertext: String,
    #[serde(default)]
    pub vault_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot: Option<serde_json::Value>,
    #[serde(default)]
    pub passkey_iv: String,
    #[serde(default)]
    pub passkey_ciphertext: String,
    #[serde(default, skip_serializing)]
    pub identities: Vec<PasswordIdentity>,
    #[serde(default, skip_serializing)]
    pub one_time_code_identities: Vec<CodeIdentity>,
    #[serde(default, skip_serializing)]
    pub passkey_identities: Vec<PasskeyIdentity>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PasswordIdentity {
    pub record_id: String,
    pub username: String,
    pub service: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodeIdentity {
    pub record_id: String,
    pub label: String,
    pub service: String,
}

/// credentialId and userHandle are STANDARD base64, as the core stores them.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PasskeyIdentity {
    pub credential_id: String,
    pub rp_id: String,
    pub user_name: String,
    pub user_handle: String,
}

/// The group container, asked of macOS as the extension does. Built from a path instead, it reads
/// to macOS 15+ as another app's data and asks the user every launch.
#[cfg(target_os = "macos")]
fn group_dir() -> Option<PathBuf> {
    use objc2::{
        msg_send,
        rc::{autoreleasepool, Retained},
        runtime::{AnyClass, AnyObject},
    };
    use objc2_foundation::NSString;

    let asked = autoreleasepool(|_| unsafe {
        let fm: Retained<AnyObject> = msg_send![AnyClass::get(c"NSFileManager")?, defaultManager];
        let url: Option<Retained<AnyObject>> = msg_send![
            &*fm,
            containerURLForSecurityApplicationGroupIdentifier: &*NSString::from_str(GROUP)
        ];
        let path: Option<Retained<NSString>> = msg_send![&*url?, path];
        path.map(|p| PathBuf::from(p.to_string()))
    });
    // An unsigned dev build has no group entitlement, so macOS answers nil.
    asked.or_else(path_group_dir)
}

#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
fn group_dir() -> Option<PathBuf> {
    path_group_dir()
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn path_group_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| {
        PathBuf::from(h)
            .join("Library/Group Containers")
            .join(GROUP)
    })
}

fn write_mirror(dir: &Path, mirror: &Mirror) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("group container: {e}"))?;
    let tmp = dir.join(format!("{MIRROR_FILE}.tmp"));
    let body = serde_json::to_vec(mirror).map_err(|e| format!("encode mirror: {e}"))?;
    fs::write(&tmp, body).map_err(|e| format!("write mirror: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("restrict mirror: {e}"))?;
    }
    fs::rename(&tmp, dir.join(MIRROR_FILE)).map_err(|e| format!("write mirror: {e}"))
}

fn clear_mirror(dir: &Path) -> Result<(), String> {
    match fs::remove_file(dir.join(MIRROR_FILE)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("clear mirror: {e}")),
        _ => Ok(()),
    }
}

#[derive(Deserialize, Serialize, Clone)]
pub struct Record {
    pub iv: String,
    pub ciphertext: String,
}

fn read_records(path: &Path) -> Vec<Record> {
    fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Rename first, so a record the extension appends meanwhile lands in a new file, not a deleted one.
fn consume_pending(dir: &Path) -> Result<Vec<Record>, String> {
    let draining = dir.join(format!("{PENDING_FILE}.draining"));
    match fs::rename(dir.join(PENDING_FILE), &draining) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("pending passkeys: {e}")),
        Ok(()) => {}
    }
    let records = read_records(&draining);
    let _ = fs::remove_file(&draining);
    Ok(records)
}

/// Put back what another vault sealed, after anything appended since.
fn restore_pending(dir: &Path, keep: Vec<Record>) -> Result<(), String> {
    let path = dir.join(PENDING_FILE);
    let mut records = read_records(&path);
    records.extend(keep);
    let tmp = dir.join(format!("{PENDING_FILE}.tmp"));
    let body = serde_json::to_vec(&records).map_err(|e| format!("encode pending: {e}"))?;
    fs::write(&tmp, body).map_err(|e| format!("write pending: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("write pending: {e}"))
}

#[tauri::command(async)]
pub fn autofill_consume_pending_passkeys() -> Result<Vec<Record>, String> {
    #[cfg(target_os = "macos")]
    return consume_pending(&group_dir().ok_or("no home directory")?);
    #[cfg(not(target_os = "macos"))]
    Ok(Vec::new())
}

#[tauri::command(async)]
pub fn autofill_restore_pending_passkeys(keep: Vec<Record>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return restore_pending(&group_dir().ok_or("no home directory")?, keep);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = keep;
        Ok(())
    }
}

/// Replace the extension's mirror and the OS identities. Not on other platforms.
#[tauri::command(async)]
pub fn autofill_provider_set(mirror: Mirror) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let dir = group_dir().ok_or("no home directory")?;
        write_mirror(&dir, &mirror)?;
        store::replace(&mirror);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = mirror;
    Ok(())
}

/// The vault is gone: its mirror and identities go with it, or they outlive it as an openable copy.
#[tauri::command(async)]
pub fn autofill_provider_clear() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        clear_mirror(&group_dir().ok_or("no home directory")?)?;
        store::replace(&Mirror::default());
    }
    Ok(())
}

/// ASCredentialIdentityStore, by message: the identities QuickType and the passkey sheet list.
#[cfg(target_os = "macos")]
mod store {
    use std::{ffi::c_void, sync::mpsc, time::Duration};

    use base64::{engine::general_purpose::STANDARD, Engine};
    use block2::RcBlock;
    use objc2::{
        msg_send,
        rc::{autoreleasepool, Allocated, Retained},
        runtime::{AnyClass, AnyObject, Bool},
        sel,
    };
    use objc2_foundation::NSString;

    use super::Mirror;

    #[link(name = "AuthenticationServices", kind = "framework")]
    extern "C" {}

    const WAIT: Duration = Duration::from_secs(5);

    fn ns(s: &str) -> Retained<NSString> {
        NSString::from_str(s)
    }

    fn data(bytes: &[u8]) -> Retained<AnyObject> {
        unsafe {
            msg_send![AnyClass::get(c"NSData").unwrap(), dataWithBytes: bytes.as_ptr() as *const c_void, length: bytes.len()]
        }
    }

    fn domain(service: &str) -> Option<Retained<AnyObject>> {
        let cls = AnyClass::get(c"ASCredentialServiceIdentifier")?;
        let a: Allocated<AnyObject> = unsafe { msg_send![cls, alloc] };
        // ASCredentialServiceIdentifierTypeDomain.
        unsafe { msg_send![a, initWithIdentifier: &*ns(service), type: 0isize] }
    }

    /// Every identity the mirror names, as store objects. Kinds this macOS lacks are skipped.
    pub(super) fn identities(m: &Mirror) -> Vec<Retained<AnyObject>> {
        let mut out = Vec::new();
        if let Some(cls) = AnyClass::get(c"ASPasswordCredentialIdentity") {
            for i in &m.identities {
                let Some(service) = domain(&i.service) else {
                    continue;
                };
                let a: Allocated<AnyObject> = unsafe { msg_send![cls, alloc] };
                let id: Option<Retained<AnyObject>> = unsafe {
                    msg_send![a, initWithServiceIdentifier: &*service, user: &*ns(&i.username), recordIdentifier: &*ns(&i.record_id)]
                };
                out.extend(id);
            }
        }
        // macOS 14: the passkey sheet only offers a provider it was told holds the credential.
        if let Some(cls) = AnyClass::get(c"ASPasskeyCredentialIdentity") {
            for p in &m.passkey_identities {
                let (Ok(cid), Ok(handle)) = (
                    STANDARD.decode(&p.credential_id),
                    STANDARD.decode(&p.user_handle),
                ) else {
                    continue;
                };
                let a: Allocated<AnyObject> = unsafe { msg_send![cls, alloc] };
                let id: Option<Retained<AnyObject>> = unsafe {
                    msg_send![a, initWithRelyingPartyIdentifier: &*ns(&p.rp_id), userName: &*ns(&p.user_name), credentialID: &*data(&cid), userHandle: &*data(&handle), recordIdentifier: &*ns(&p.credential_id)]
                };
                out.extend(id);
            }
        }
        // macOS 15.
        if let Some(cls) = AnyClass::get(c"ASOneTimeCodeCredentialIdentity") {
            for c in &m.one_time_code_identities {
                let Some(service) = domain(&c.service) else {
                    continue;
                };
                let a: Allocated<AnyObject> = unsafe { msg_send![cls, alloc] };
                let id: Option<Retained<AnyObject>> = unsafe {
                    msg_send![a, initWithServiceIdentifier: &*service, label: &*ns(&c.label), recordIdentifier: &*ns(&c.record_id)]
                };
                out.extend(id);
            }
        }
        out
    }

    fn array(items: &[Retained<AnyObject>]) -> Retained<AnyObject> {
        let ptrs: Vec<*const AnyObject> = items.iter().map(|o| Retained::as_ptr(o)).collect();
        unsafe {
            msg_send![AnyClass::get(c"NSArray").unwrap(), arrayWithObjects: ptrs.as_ptr(), count: ptrs.len()]
        }
    }

    /// One replace for every kind: it clears the whole store, as on iOS. A no-op until the user
    /// enables Bramble in AutoFill & Passwords, which is also when QuickType should start.
    pub(super) fn replace(m: &Mirror) {
        autoreleasepool(|_| {
            let Some(cls) = AnyClass::get(c"ASCredentialIdentityStore") else {
                return;
            };
            let store: Retained<AnyObject> = unsafe { msg_send![cls, sharedStore] };

            let (tx, rx) = mpsc::channel();
            let on_state = RcBlock::new(move |state: *mut AnyObject| {
                let enabled = !state.is_null() && unsafe { msg_send![state, isEnabled] };
                let _ = tx.send(enabled);
            });
            unsafe {
                let _: () =
                    msg_send![&*store, getCredentialIdentityStoreStateWithCompletion: &*on_state];
            }
            if !rx.recv_timeout(WAIT).unwrap_or(false) {
                return;
            }

            let all = identities(m);
            let (tx, rx) = mpsc::channel();
            let done = RcBlock::new(move |_ok: Bool, _error: *mut AnyObject| {
                let _ = tx.send(());
            });
            let entries: Bool = unsafe {
                msg_send![&*store, respondsToSelector: sel!(replaceCredentialIdentityEntries:completion:)]
            };
            unsafe {
                if entries.as_bool() {
                    let _: () = msg_send![&*store, replaceCredentialIdentityEntries: &*array(&all), completion: &*done];
                } else {
                    // macOS 13: the older selector, passwords only (the other classes don't exist
                    // there, so `all` holds nothing else).
                    let _: () = msg_send![&*store, replaceCredentialIdentitiesWithIdentities: &*array(&all), completion: &*done];
                }
            }
            let _ = rx.recv_timeout(WAIT);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_group_container_is_the_one_the_extension_opens() {
        let dir = group_dir().unwrap();
        assert!(dir.ends_with(format!("Library/Group Containers/{GROUP}")));
    }

    fn mirror() -> Mirror {
        serde_json::from_value(serde_json::json!({
            "iv": "IV", "ciphertext": "CT", "vaultId": "v1",
            "slot": { "saltB64": "s" },
            "passkeyIv": "PIV", "passkeyCiphertext": "PCT",
            "identities": [{ "recordId": "e1", "username": "me", "service": "github.com" }],
            "oneTimeCodeIdentities": [],
            "passkeyIdentities": [{ "credentialId": "Y2lk", "rpId": "github.com", "userName": "me", "userHandle": "dWg=" }]
        }))
        .unwrap()
    }

    #[test]
    fn writes_the_mirror_atomically_into_the_group_container() {
        let dir = tempfile::tempdir().unwrap();
        let group = dir.path().join("group");
        write_mirror(&group, &mirror()).unwrap();
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(group.join(MIRROR_FILE)).unwrap()).unwrap();
        assert_eq!(written["ciphertext"], "CT");
        assert_eq!(written["vaultId"], "v1");
        assert_eq!(written["passkeyCiphertext"], "PCT");
        assert_eq!(written["slot"]["saltB64"], "s");
        // Identities go to the OS store, never to disk.
        assert!(written.get("identities").is_none());
        assert!(written.get("passkeyIdentities").is_none());
        let names: Vec<_> = std::fs::read_dir(&group)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from(MIRROR_FILE)]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(group.join(MIRROR_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn clearing_removes_the_mirror() {
        let dir = tempfile::tempdir().unwrap();
        write_mirror(dir.path(), &mirror()).unwrap();
        clear_mirror(dir.path()).unwrap();
        assert!(!dir.path().join(MIRROR_FILE).exists());
        clear_mirror(dir.path()).unwrap();
    }

    #[test]
    fn consumes_and_removes_pending_passkeys() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(PENDING_FILE),
            r#"[{"iv":"a","ciphertext":"b"},{"iv":"c","ciphertext":"d"}]"#,
        )
        .unwrap();
        let got = consume_pending(dir.path()).unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[1].ciphertext, "d");
        assert!(!dir.path().join(PENDING_FILE).exists());
        assert!(consume_pending(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn restoring_puts_records_back_beside_new_ones() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(PENDING_FILE),
            r#"[{"iv":"new","ciphertext":"n"}]"#,
        )
        .unwrap();
        restore_pending(
            dir.path(),
            vec![Record {
                iv: "old".into(),
                ciphertext: "o".into(),
            }],
        )
        .unwrap();
        let got = consume_pending(dir.path()).unwrap();
        let ivs: Vec<_> = got.iter().map(|r| r.iv.as_str()).collect();
        assert_eq!(ivs, vec!["new", "old"]);
    }

    // The Objective-C side for real, short of the store: wrong selectors or argument types fail
    // here rather than on a user's Mac.
    #[cfg(target_os = "macos")]
    #[test]
    fn builds_identity_objects_the_store_takes() {
        let m = mirror();
        let built = store::identities(&m);
        assert_eq!(built.len(), 2, "one password, one passkey");
    }
}
