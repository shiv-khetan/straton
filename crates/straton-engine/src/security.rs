use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use rand::RngCore;
use secrecy::SecretString;
use std::{
    fs::{File, OpenOptions},
    path::Path,
};

pub fn lock(dir: &Path) -> Result<File> {
    std::fs::create_dir_all(dir)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join("engine.lock"))?;
    file.try_lock_exclusive()
        .context("engine lock is held; stop the engine first")?;
    Ok(file)
}

pub fn token(dir: &Path) -> Result<SecretString> {
    let path = dir.join("token");
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => {
            // Restrict access before placing the token in the file.
            if let Err(e) = restrict(&file, &path) {
                drop(file);
                let _ = std::fs::remove_file(&path);
                return Err(e);
            }
            let mut bytes = [0u8; 32];
            rand::rng().fill_bytes(&mut bytes);
            let value: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            use std::io::Write;
            file.write_all(value.as_bytes())?;
            file.sync_all()?;
            Ok(value.into())
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let file = OpenOptions::new().read(true).open(&path)?;
            restrict(&file, &path)?;
            let value = std::fs::read_to_string(path)?;
            ensure!(
                value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()),
                "invalid token file"
            );
            Ok(value.into())
        }
        Err(e) => Err(e.into()),
    }
}
#[cfg(unix)]
pub(crate) fn restrict(file: &File, _path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}
#[cfg(windows)]
pub(crate) fn restrict(_file: &File, path: &Path) -> Result<()> {
    use std::{
        io,
        mem::size_of,
        os::windows::{
            ffi::OsStrExt,
            io::{AsRawHandle, FromRawHandle, OwnedHandle},
        },
        ptr,
    };
    use windows_sys::Win32::{
        Security::{
            ACCESS_ALLOWED_ACE, ACL, ACL_REVISION, AddAccessAllowedAce,
            Authorization::{SE_FILE_OBJECT, SetNamedSecurityInfoW},
            DACL_SECURITY_INFORMATION, GetLengthSid, GetTokenInformation, InitializeAcl,
            PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER, TokenUser,
        },
        Storage::FileSystem::FILE_ALL_ACCESS,
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: token ownership is transferred once to OwnedHandle; aligned buffers and the
    // NUL-terminated path remain live for every Win32 call, including SID use inside token_user.
    unsafe {
        let mut token = ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(io::Error::last_os_error().into());
        }
        let token = OwnedHandle::from_raw_handle(token);
        let mut size = 0;
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            ptr::null_mut(),
            0,
            &mut size,
        );
        if size == 0 {
            return Err(io::Error::last_os_error().into());
        }
        let mut token_user = vec![0usize; (size as usize).div_ceil(size_of::<usize>())];
        if GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            token_user.as_mut_ptr().cast(),
            size,
            &mut size,
        ) == 0
        {
            return Err(io::Error::last_os_error().into());
        }
        let sid = (*token_user.as_ptr().cast::<TOKEN_USER>()).User.Sid;
        let size = (size_of::<ACL>() + size_of::<ACCESS_ALLOWED_ACE>() - size_of::<u32>()) as u32
            + GetLengthSid(sid);
        let mut storage = vec![0u32; (size as usize).div_ceil(size_of::<u32>())];
        let acl = storage.as_mut_ptr().cast::<ACL>();
        if InitializeAcl(acl, size, ACL_REVISION) == 0
            || AddAccessAllowedAce(acl, ACL_REVISION, FILE_ALL_ACCESS, sid) == 0
        {
            return Err(io::Error::last_os_error().into());
        }
        let status = SetNamedSecurityInfoW(
            path.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            acl,
            ptr::null(),
        );
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status as i32).into());
        }
    }
    Ok(())
}
