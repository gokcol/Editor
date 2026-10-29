//! Shared native menu projection. The renderer owns recent-entry lookup and opening.

use serde::Deserialize;
use std::{collections::HashSet, sync::mpsc};
use tauri::{
    menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu},
    AppHandle, Runtime,
};

const MENU_ID: &str = "open-recent-menu";
const MAX_ITEMS: usize = 20;
const MAX_ID_BYTES: usize = 4096;
const MAX_LABEL_CHARS: usize = 240;

#[derive(Debug, Deserialize)]
pub struct RecentMenuItem {
    pub id: String,
    pub label: String,
}

fn valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_ID_BYTES {
        return false;
    }
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'%' {
            if index + 2 >= bytes.len()
                || !bytes[index + 1].is_ascii_hexdigit()
                || !bytes[index + 2].is_ascii_hexdigit()
            {
                return false;
            }
            index += 3;
        } else if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            index += 1;
        } else {
            return false;
        }
    }
    true
}

fn clean_label(label: &str) -> String {
    let cleaned: String = label
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(character, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
            {
                ' '
            } else {
                character
            }
        })
        .collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() {
        return "Recent item".into();
    }
    if cleaned.chars().count() > MAX_LABEL_CHARS {
        return cleaned.chars().take(MAX_LABEL_CHARS - 1).chain(['…']).collect();
    }
    cleaned
}

fn validate_entries(entries: Vec<RecentMenuItem>) -> Result<Vec<RecentMenuItem>, String> {
    let mut seen = HashSet::new();
    let mut validated = Vec::new();
    for entry in entries.into_iter().take(MAX_ITEMS) {
        if !valid_id(&entry.id) {
            return Err("A recent-menu entry has an invalid identifier.".into());
        }
        if seen.insert(entry.id.clone()) {
            validated.push(RecentMenuItem {
                id: entry.id,
                label: clean_label(&entry.label),
            });
        }
    }
    Ok(validated)
}

fn build_with_entries<R: Runtime>(
    app: &AppHandle<R>,
    entries: &[RecentMenuItem],
) -> tauri::Result<Submenu<R>> {
    let submenu = Submenu::with_id(app, MENU_ID, "Open Recent", true)?;
    if entries.is_empty() {
        submenu.append(&MenuItem::with_id(
            app, "open-recent-empty", "No Recent Items", false, None::<&str>,
        )?)?;
    } else {
        for entry in entries {
            // An ampersand in a filename is literal, not a Windows/Linux mnemonic.
            submenu.append(&MenuItem::with_id(
                app,
                format!("open-recent:{}", entry.id),
                entry.label.replace('&', "&&"),
                true,
                None::<&str>,
            )?)?;
        }
    }
    submenu.append(&PredefinedMenuItem::separator(app)?)?;
    submenu.append(&MenuItem::with_id(
        app, "open-recents", "Show All Recent…", true, None::<&str>,
    )?)?;
    submenu.append(&MenuItem::with_id(
        app, "clear-recents", "Clear Recent Items", !entries.is_empty(), None::<&str>,
    )?)?;
    Ok(submenu)
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    build_with_entries(app, &[])
}

enum Parent<R: Runtime> {
    Menu(Menu<R>),
    Submenu(Submenu<R>),
}

impl<R: Runtime> Parent<R> {
    fn items(&self) -> tauri::Result<Vec<MenuItemKind<R>>> {
        match self {
            Self::Menu(menu) => menu.items(),
            Self::Submenu(menu) => menu.items(),
        }
    }

    fn remove(&self, submenu: &Submenu<R>) -> tauri::Result<()> {
        match self {
            Self::Menu(menu) => menu.remove(submenu),
            Self::Submenu(menu) => menu.remove(submenu),
        }
    }

    fn insert(&self, submenu: &Submenu<R>, position: usize) -> tauri::Result<()> {
        match self {
            Self::Menu(menu) => menu.insert(submenu, position),
            Self::Submenu(menu) => menu.insert(submenu, position),
        }
    }
}

fn replace_submenu<R: Runtime>(
    parent: Parent<R>,
    replacement: &Submenu<R>,
) -> Result<bool, String> {
    for (position, item) in parent.items().map_err(|error| error.to_string())?.into_iter().enumerate() {
        let MenuItemKind::Submenu(submenu) = item else { continue };
        if submenu.id().as_ref() == MENU_ID {
            parent.remove(&submenu).map_err(|error| error.to_string())?;
            if let Err(error) = parent.insert(replacement, position) {
                if let Err(restore_error) = parent.insert(&submenu, position) {
                    return Err(format!("Could not update the recent menu: {error}. Could not restore it: {restore_error}."));
                }
                return Err(error.to_string());
            }
            return Ok(true);
        }
        if replace_submenu(Parent::Submenu(submenu), replacement)? {
            return Ok(true);
        }
    }
    Ok(false)
}

#[tauri::command]
pub fn sync_recent_menu(app: AppHandle, entries: Vec<RecentMenuItem>) -> Result<(), String> {
    let entries = validate_entries(entries)?;
    let (sender, receiver) = mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = (|| {
            let menu = handle.menu().ok_or("The application menu is unavailable.")?;
            // Prepare every item first, then swap just this submenu in one main-thread task.
            let replacement = build_with_entries(&handle, &entries).map_err(|error| error.to_string())?;
            if replace_submenu(Parent::Menu(menu), &replacement)? {
                Ok(())
            } else {
                Err("The Open Recent submenu is unavailable.".into())
            }
        })();
        let _ = sender.send(result);
    }).map_err(|error| error.to_string())?;
    receiver.recv().map_err(|_| "The recent-menu update did not complete.".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_encoded_unicode_ids_without_changing_them() {
        let id = "file%3A%2F%C4%B0%C5%9F%2F%C3%B6dev%251.txt";
        let entries = validate_entries(vec![RecentMenuItem { id: id.into(), label: "ödev.txt".into() }]).unwrap();
        assert_eq!(entries[0].id, id);
        assert_eq!(entries[0].label, "ödev.txt");
    }

    #[test]
    fn rejects_control_malformed_and_oversized_ids() {
        for id in ["".to_owned(), "raw:action".into(), "line\nbreak".into(), "%GG".into(), "%0".into(), "é".into(), "a".repeat(MAX_ID_BYTES + 1)] {
            assert!(validate_entries(vec![RecentMenuItem { id, label: "Name".into() }]).is_err());
        }
    }

    #[test]
    fn bounds_items_and_sanitizes_labels_without_splitting_unicode() {
        let entries = validate_entries((0..25).map(|index| RecentMenuItem {
            id: index.to_string(),
            label: format!("\u{202e}Notes\n\0 {}", "📄".repeat(300)),
        }).collect()).unwrap();
        assert_eq!(entries.len(), MAX_ITEMS);
        assert_eq!(entries[19].id, "19");
        assert!(entries.iter().all(|entry| entry.label.chars().count() == MAX_LABEL_CHARS && entry.label.starts_with("Notes ") && entry.label.ends_with('…')));
        assert_eq!(clean_label("\n\u{202e}"), "Recent item");
    }

    #[test]
    fn duplicate_ids_keep_the_first_recent_entry() {
        let entries = validate_entries(vec![
            RecentMenuItem { id: "one".into(), label: "Newest".into() },
            RecentMenuItem { id: "one".into(), label: "Older".into() },
        ]).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].label, "Newest");
    }
}
