use super::*;

pub fn remove(state: &ReaderState, id: &str, part_id: Option<&str>) -> Result<(), String> {
    let mut library = state.library.lock().map_err(|e| e.to_string())?;
    if !library.recent.iter().any(|book| book.id == id) {
        return Err("书籍记录不存在".into());
    }
    if let Some(part) = part_id {
        if !library
            .collections
            .get(id)
            .is_some_and(|collection| collection.parts.iter().any(|p| p.id == part))
        {
            return Err("子书记录不存在".into());
        }
    }
    let mut next = library.clone();
    next.hidden_books.insert(item_key(id, part_id));
    persist(state, &next)?;
    *library = next;
    Ok(())
}

#[tauri::command]
pub async fn remove_book(
    app: tauri::AppHandle,
    source_id: String,
    part_id: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        remove(&app.state::<ReaderState>(), &source_id, part_id.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state() -> (ReaderState, PathBuf) {
        let dir = std::env::temp_dir().join(format!("leaf-remove-{}", token()));
        fs::create_dir_all(dir.join("sources")).unwrap();
        (
            ReaderState {
                session: Mutex::new(None),
                library: Mutex::new(Library::default()),
                storage: dir.join("library.json"),
            },
            dir,
        )
    }
    #[test]
    fn removed_manual_and_scanned_books_stay_excluded_and_explicit_open_restores_records() {
        let (state, dir) = state();
        let source = dir.join("sources");
        let manual = source.join("manual.epub");
        let scanned = source.join("scanned.epub");
        let bytes = include_bytes!("../../fixtures/quiet-days.epub");
        fs::write(&manual, bytes).unwrap();
        fs::write(&scanned, bytes).unwrap();
        let opened = open_path(&state, &manual).unwrap();
        write_progress(&state, &opened.token, 1, 0.35).unwrap();
        reading_time::record(&state, &opened.token, 4500).unwrap();
        update_metadata(
            &state,
            &opened.id,
            None,
            "文学".into(),
            vec!["待读".into()],
            true,
        )
        .unwrap();
        scan::configure(&state, vec![source.to_string_lossy().into()]).unwrap();
        scan::scan(&state).unwrap();
        let other = state
            .library
            .lock()
            .unwrap()
            .recent
            .iter()
            .find(|r| r.id != opened.id)
            .unwrap()
            .id
            .clone();
        remove(&state, &opened.id, None).unwrap();
        remove(&state, &other, None).unwrap();
        assert!(snapshot(&state.library.lock().unwrap()).books.is_empty());
        scan::scan(&state).unwrap();
        assert!(snapshot(&state.library.lock().unwrap()).books.is_empty());
        assert_eq!(state.library.lock().unwrap().recent.len(), 2);
        let saved: Library = serde_json::from_slice(&fs::read(&state.storage).unwrap()).unwrap();
        *state.library.lock().unwrap() = saved;
        scan::scan(&state).unwrap();
        assert!(snapshot(&state.library.lock().unwrap()).books.is_empty());
        fs::write(&manual, b"broken").unwrap();
        assert!(open_path(&state, &manual).is_err());
        assert!(snapshot(&state.library.lock().unwrap()).books.is_empty());
        fs::write(&manual, bytes).unwrap();
        let restored = open_path(&state, &manual).unwrap();
        assert_eq!(restored.id, opened.id);
        assert_eq!(restored.progress.fraction, 0.35);
        assert!(restored.metadata.favorite);
        assert_eq!(state.library.lock().unwrap().reading_ms[&opened.id], 4500);
        scan::scan(&state).unwrap();
        assert_eq!(snapshot(&state.library.lock().unwrap()).books.len(), 1);
        assert_eq!(state.library.lock().unwrap().recent.len(), 2);
        assert_eq!(fs::read(&manual).unwrap(), bytes);
        assert_eq!(fs::read(&scanned).unwrap(), bytes);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn imported_sources_stay_excluded_even_if_the_copy_disappears() {
        let (state, dir) = state();
        let source = dir.join("sources");
        let file = source.join("book.epub");
        fs::write(&file, include_bytes!("../../fixtures/quiet-days.epub")).unwrap();
        let destination = dir.join("library");
        fs::create_dir(&destination).unwrap();
        library_directory::configure(&state, Some(destination.to_string_lossy().into()), true)
            .unwrap();
        let copy = library_directory::source(&state, &file, true).unwrap();
        let opened = open_scoped_from(&state, &copy, None, Some(&file)).unwrap();
        update_metadata(&state, &opened.id, None, "文学".into(), vec![], true).unwrap();
        scan::configure(
            &state,
            vec![
                source.to_string_lossy().into(),
                destination.to_string_lossy().into(),
            ],
        )
        .unwrap();
        remove(&state, &opened.id, None).unwrap();
        scan::scan(&state).unwrap();
        assert!(snapshot(&state.library.lock().unwrap()).books.is_empty());
        fs::remove_file(&copy).unwrap();
        let report = serde_json::to_value(scan::scan(&state).unwrap()).unwrap();
        assert_eq!(report["missing"], 0);
        assert_eq!(report["excluded"], 1);
        assert!(snapshot(&state.library.lock().unwrap()).books.is_empty());
        let copy = library_directory::source(&state, &file, true).unwrap();
        open_scoped_from(&state, &copy, None, Some(&file)).unwrap();
        scan::scan(&state).unwrap();
        assert_eq!(snapshot(&state.library.lock().unwrap()).books.len(), 1);
        // Re-adding the original with importing now disabled still restores its personal state.
        remove(&state, &opened.id, None).unwrap();
        library_directory::configure(&state, Some(destination.to_string_lossy().into()), false)
            .unwrap();
        let restored = open_scoped_from(&state, &file, None, Some(&file)).unwrap();
        assert!(restored.metadata.favorite);
        scan::scan(&state).unwrap();
        assert_eq!(snapshot(&state.library.lock().unwrap()).books.len(), 1);
        assert_eq!(state.library.lock().unwrap().recent.len(), 1);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn removed_children_keep_other_books_and_boundaries_and_restore_on_manual_reopen() {
        let (state, dir) = state();
        let root = open_path(&state, Path::new("../fixtures/anthology.epub")).unwrap();
        let ids: Vec<_> = root
            .candidates
            .iter()
            .filter(|c| c.suggested)
            .map(|c| c.id.clone())
            .collect();
        let collection = configure_collection(&state, &root.token, true, &ids).unwrap();
        let part = &collection.collection.parts[1];
        remove(&state, &root.id, Some(&part.id)).unwrap();
        assert_eq!(
            snapshot(&state.library.lock().unwrap()).books[0]
                .collection
                .parts
                .len(),
            3
        );
        assert_eq!(
            state.library.lock().unwrap().collections[&root.id]
                .parts
                .len(),
            4
        );
        assert!(remove(&state, &root.id, Some("unknown")).is_err());
        scan::scan(&state).unwrap();
        assert_eq!(
            snapshot(&state.library.lock().unwrap()).books[0]
                .collection
                .parts
                .len(),
            3
        );
        open_path(&state, Path::new("../fixtures/anthology.epub")).unwrap();
        assert_eq!(
            snapshot(&state.library.lock().unwrap()).books[0]
                .collection
                .parts
                .len(),
            4
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn failed_persistence_does_not_hide_a_book() {
        let (mut state, dir) = state();
        let opened = open_path(&state, Path::new("../fixtures/quiet-days.epub")).unwrap();
        state.storage = dir.join("missing/library.json");
        assert!(remove(&state, &opened.id, None).is_err());
        assert_eq!(snapshot(&state.library.lock().unwrap()).books.len(), 1);
        assert!(state.library.lock().unwrap().hidden_books.is_empty());
        fs::remove_dir_all(dir).unwrap();
    }
}
