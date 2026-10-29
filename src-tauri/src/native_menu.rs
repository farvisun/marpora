//! Edit menu items macOS implements itself, as Typora uses them: Spelling and Grammar,
//! Substitutions and Speech send the standard actions to the focused web view, which
//! checks, substitutes and speaks as other Mac apps do and shows their checkmarks.
//! Tauri cannot make such items, so they go into its (empty) submenus of these names.

use objc2::runtime::Sel;
use objc2::sel;
use objc2_app_kit::{NSApplication, NSEventModifierFlags, NSMenu, NSMenuItem};
use objc2_foundation::{MainThreadMarker, NSString};

/// (title, action, key equivalent with ⌘); no action is a separator.
type Item = (&'static str, Option<Sel>, &'static str);

/// Each submenu's title and items.
fn menus() -> Vec<(&'static str, Vec<Item>)> {
    vec![
        (
            "Spelling and Grammar",
            vec![
                (
                    "Show Spelling and Grammar",
                    Some(sel!(showGuessPanel:)),
                    ":",
                ),
                ("Check Document Now", Some(sel!(checkSpelling:)), ";"),
                ("", None, ""),
                (
                    "Check Spelling While Typing",
                    Some(sel!(toggleContinuousSpellChecking:)),
                    "",
                ),
                (
                    "Check Grammar With Spelling",
                    Some(sel!(toggleGrammarChecking:)),
                    "",
                ),
                (
                    "Correct Spelling Automatically",
                    Some(sel!(toggleAutomaticSpellingCorrection:)),
                    "",
                ),
            ],
        ),
        (
            "Substitutions",
            vec![
                (
                    "Show Substitutions",
                    Some(sel!(orderFrontSubstitutionsPanel:)),
                    "",
                ),
                ("", None, ""),
                (
                    "Smart Quotes",
                    Some(sel!(toggleAutomaticQuoteSubstitution:)),
                    "",
                ),
                (
                    "Smart Dashes",
                    Some(sel!(toggleAutomaticDashSubstitution:)),
                    "",
                ),
                (
                    "Text Replacement",
                    Some(sel!(toggleAutomaticTextReplacement:)),
                    "",
                ),
            ],
        ),
        (
            "Speech",
            vec![
                ("Start Speaking", Some(sel!(startSpeaking:)), ""),
                ("Stop Speaking", Some(sel!(stopSpeaking:)), ""),
            ],
        ),
    ]
}

/// Fill the Edit menu's native submenus; call after the app menu is set.
pub fn install(mtm: MainThreadMarker) {
    let app = NSApplication::sharedApplication(mtm);
    let Some(edit) = app
        .mainMenu()
        .and_then(|m| m.itemWithTitle(&NSString::from_str("Edit")))
        .and_then(|item| item.submenu())
    else {
        return;
    };
    for (title, items) in menus() {
        let Some(menu) = edit
            .itemWithTitle(&NSString::from_str(title))
            .and_then(|item| item.submenu())
        else {
            continue;
        };
        fill(mtm, &menu, &items);
    }
}

fn fill(mtm: MainThreadMarker, menu: &NSMenu, items: &[Item]) {
    menu.removeAllItems();
    for &(title, action, key) in items {
        let Some(action) = action else {
            menu.addItem(&NSMenuItem::separatorItem(mtm));
            continue;
        };
        // SAFETY: the actions are standard responder messages taking a sender; with no
        // target they go to the first responder, which ignores those it lacks.
        let item = unsafe {
            menu.addItemWithTitle_action_keyEquivalent(
                &NSString::from_str(title),
                Some(action),
                &NSString::from_str(key),
            )
        };
        if !key.is_empty() {
            item.setKeyEquivalentModifierMask(NSEventModifierFlags::Command);
        }
    }
}
