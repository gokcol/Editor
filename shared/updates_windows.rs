//! Store-signed packages use Microsoft's own availability API, never GitHub.
use super::{Available, Channel, Product};
use std::time::{Duration, Instant};
use windows::{
    core::Interface,
    ApplicationModel::{Package, PackageSignatureKind},
    Services::Store::StoreContext,
    Win32::{
        Foundation::{APPMODEL_ERROR_NO_PACKAGE, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, HWND},
        Storage::Packaging::Appx::GetCurrentPackageFullName,
        System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
        UI::Shell::IInitializeWithWindow,
    },
};

struct Apartment;
impl Apartment {
    fn new() -> Result<Self, String> {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }
            .map_err(|_| "Could not initialize the Microsoft Store check.")?;
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() };
    }
}

pub(super) fn installation(product: Product, version: &str) -> Result<(Channel, String), String> {
    let mut size = 0;
    // Size query only; no caller-provided buffer.
    match unsafe { GetCurrentPackageFullName(&mut size, None) } {
        APPMODEL_ERROR_NO_PACKAGE => return Ok((Channel::Github, version.into())),
        ERROR_INSUFFICIENT_BUFFER | ERROR_SUCCESS => (),
        _ => {
            return Err(
                "Windows could not identify this installation. Open the Store to check manually."
                    .into(),
            )
        }
    }
    let _apartment = Apartment::new()?;
    let query = || -> windows::core::Result<_> {
        let package = Package::Current()?;
        let id = package.Id()?;
        let version = id.Version()?;
        let channel = if package.SignatureKind()? == PackageSignatureKind::Store
            && !package.IsDevelopmentMode()?
            && id.Name()?.to_string_lossy() == product.store_identity()
        {
            Channel::Store
        } else {
            Channel::Sideloaded
        };
        Ok((
            channel,
            format!(
                "{}.{}.{}.{}",
                version.Major, version.Minor, version.Build, version.Revision
            ),
        ))
    };
    query().map_err(|_| "Could not read the installed Store package identity.".into())
}

pub(super) fn check(product: Product, parent: Option<isize>) -> Result<Option<Available>, String> {
    let _apartment = Apartment::new()?;
    let query = || -> windows::core::Result<_> {
        let package = Package::Current()?;
        let family = package.Id()?.FamilyName()?;
        let context = StoreContext::GetDefault()?;
        if let Some(parent) = parent {
            // The live Tauri window owns any Store UI. No install is requested.
            unsafe {
                context
                    .cast::<IInitializeWithWindow>()?
                    .Initialize(HWND(parent as *mut _))?;
            }
        }
        Ok((family, context, package.Id()?.Version()?))
    };
    let (family, context, version) =
        query().map_err(|_| "Could not connect this app to Microsoft Store.")?;
    let operation = context
        .GetAppAndOptionalStorePackageUpdatesAsync()
        .map_err(|_| "Microsoft Store could not check for updates. Try again later.")?;
    let started = Instant::now();
    while operation
        .Status()
        .map_err(|_| "Microsoft Store check stopped.")?
        .0
        == 0
    {
        if started.elapsed() >= Duration::from_secs(25) {
            let _ = operation.Cancel();
            return Err(
                "Microsoft Store did not respond in time. Open the Store to check manually.".into(),
            );
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let updates = operation.GetResults().map_err(|_| {
        "Microsoft Store could not finish checking. Open the Store or try again later."
    })?;
    for update in updates {
        let id = update
            .Package()
            .and_then(|p| p.Id())
            .map_err(|_| "Could not read Microsoft Store update information.")?;
        if id
            .FamilyName()
            .map_err(|_| "Could not identify the Store update.")?
            == family
        {
            return Ok(Some(Available { id: format!("store:{}.{}.{}.{}", version.Major, version.Minor, version.Build, version.Revision), version: None,
                title: format!("A {} update is available in Microsoft Store", product.name()), notes: "Open Microsoft Store to review the latest version and update this app. Windows manages Store updates.".into(), url: product.store_url() }));
        }
    }
    Ok(None)
}
