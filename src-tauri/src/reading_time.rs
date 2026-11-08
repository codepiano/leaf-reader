use super::*;
pub fn record(state: &ReaderState, token: &str, milliseconds: u64) -> Result<(), String> {
    if milliseconds > 60000 {
        return Err("无效的阅读时长".into());
    }
    let active = state.session.lock().map_err(|e| e.to_string())?;
    let session = active
        .as_ref()
        .filter(|s| s.token == token)
        .ok_or("书籍已关闭")?;
    let mut library = state.library.lock().map_err(|e| e.to_string())?;
    if !library.settings.track_reading_time || milliseconds == 0 {
        return Ok(());
    }
    let mut next = library.clone();
    let value = next
        .reading_ms
        .entry(item_key(&session.id, session.part_id.as_deref()))
        .or_default();
    *value = value.saturating_add(milliseconds);
    persist(state, &next)?;
    *library = next;
    Ok(())
}
#[tauri::command]
pub fn save_reading_time(
    state: tauri::State<ReaderState>,
    token: String,
    milliseconds: u64,
) -> Result<(), String> {
    record(&state, &token, milliseconds)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reading_preferences_preserve_old_progress_and_independent_durations() {
        let dir = std::env::temp_dir().join(format!("leaf-time-{}", token()));
        fs::create_dir_all(&dir).unwrap();
        let state = ReaderState {
            session: Mutex::new(None),
            library: Mutex::new(Library::default()),
            storage: dir.join("library.json"),
        };
        let path = Path::new("../fixtures/anthology.epub");
        let old: library_directory::Settings =
            serde_json::from_str(r#"{"directory":null,"import_enabled":false}"#).unwrap();
        assert!(old.remember_position);
        assert!(old.track_reading_time);
        let root = open_path(&state, path).unwrap();
        write_progress(&state, &root.token, 1, 0.6).unwrap();
        record(&state, &root.token, 12000).unwrap();
        assert!(record(&state, &root.token, 60001).is_err());
        assert!(record(&state, "stale", 1000).is_err());
        library_directory::configure_settings(&state, None, false, Some(false), Some(false))
            .unwrap();
        let reopened = open_path(&state, path).unwrap();
        assert_eq!(reopened.progress.chapter, 0);
        assert_eq!(reopened.progress.fraction, 0.);
        write_progress(&state, &reopened.token, 2, 0.9).unwrap();
        record(&state, &reopened.token, 5000).unwrap();
        assert_eq!(state.library.lock().unwrap().reading_ms[&root.id], 12000);
        library_directory::configure_settings(&state, None, false, Some(true), Some(true)).unwrap();
        let reopened = open_path(&state, path).unwrap();
        assert_eq!(reopened.progress.chapter, 1);
        assert_eq!(reopened.progress.fraction, 0.6);
        let ids: Vec<_> = reopened
            .candidates
            .iter()
            .filter(|c| c.suggested)
            .map(|c| c.id.clone())
            .collect();
        let all = configure_collection(&state, &reopened.token, true, &ids).unwrap();
        let a = open_scoped(&state, path, Some(&all.collection.parts[1].id)).unwrap();
        record(&state, &a.token, 4000).unwrap();
        let b = open_scoped(&state, path, Some(&all.collection.parts[2].id)).unwrap();
        record(&state, &b.token, 3000).unwrap();
        let saved: Library = serde_json::from_slice(&fs::read(&state.storage).unwrap()).unwrap();
        assert_eq!(
            saved.reading_ms[&item_key(&root.id, a.part_id.as_deref())],
            4000
        );
        assert_eq!(
            saved.reading_ms[&item_key(&root.id, b.part_id.as_deref())],
            3000
        );
        assert_eq!(saved.reading_ms[&root.id], 12000);
        fs::remove_dir_all(dir).unwrap();
    }
}
