use super::*;

#[derive(Serialize)]
pub struct Info {
    title: String,
    reading_ms: u64,
    author: String,
    path: String,
    size: Option<u64>,
    modified: Option<u64>,
    chapters: usize,
    source_chapters: usize,
    source_title: Option<String>,
    metadata: BookMeta,
    file_error: Option<String>,
}
pub fn info(state: &ReaderState, source_id: &str, part_id: Option<&str>) -> Result<Info, String> {
    let library = state.library.lock().map_err(|e| e.to_string())?;
    let book = library
        .recent
        .iter()
        .find(|r| r.id == source_id)
        .ok_or("书籍记录不存在")?
        .clone();
    let part = match part_id {
        Some(id) => Some(
            library
                .collections
                .get(source_id)
                .filter(|c| c.enabled)
                .and_then(|c| c.parts.iter().find(|p| p.id == id))
                .ok_or("子书记录不存在")?
                .clone(),
        ),
        None => None,
    };
    let mut metadata = library
        .metadata
        .get(&item_key(source_id, part_id))
        .cloned()
        .unwrap_or_default();
    metadata.reading_status.get_or_insert(
        if part.as_ref().map(|p| p.opened).unwrap_or(book.opened) > 0 {
            ReadingStatus::Reading
        } else {
            ReadingStatus::Unread
        },
    );
    let key = item_key(source_id, part_id);
    let prefix = format!("{source_id}::");
    let reading_ms = library
        .reading_ms
        .iter()
        .filter(|(k, _)| *k == &key || (part_id.is_none() && k.starts_with(&prefix)))
        .fold(0u64, |total, (_, value)| total.saturating_add(*value));
    drop(library);
    let (size, modified, file_error) = match fs::metadata(&book.path) {
        Ok(m) if m.is_file() => (
            Some(m.len()),
            m.modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|t| t.as_millis() as u64),
            None,
        ),
        Ok(_) => (None, None, Some("原路径不再是文件".into())),
        Err(e) => (None, None, Some(format!("文件已移动或无法访问：{e}"))),
    };
    Ok(Info {
        reading_ms,
        title: part
            .as_ref()
            .map(|p| p.title.clone())
            .unwrap_or(book.title.clone()),
        author: book.author,
        path: book.path,
        size,
        modified,
        chapters: part.as_ref().map(|p| p.chapters).unwrap_or(book.chapters),
        source_chapters: book.chapters,
        source_title: part.map(|_| book.title),
        metadata,
        file_error,
    })
}
#[tauri::command]
pub async fn book_info(
    app: tauri::AppHandle,
    source_id: String,
    part_id: Option<String>,
) -> Result<Info, String> {
    tauri::async_runtime::spawn_blocking(move || {
        info(&app.state::<ReaderState>(), &source_id, part_id.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_info_is_read_only_and_missing_files_keep_record_details() {
        let dir = std::env::temp_dir().join(format!("leaf-info-{}", token()));
        fs::create_dir_all(&dir).unwrap();
        let state = ReaderState {
            session: Mutex::new(None),
            library: Mutex::new(Library::default()),
            storage: dir.join("library.json"),
        };
        let path = dir.join("book.epub");
        let bytes = include_bytes!("../../fixtures/anthology.epub");
        fs::write(&path, bytes).unwrap();
        let root = open_path(&state, &path).unwrap();
        let saved = fs::read(&state.storage).unwrap();
        let details = info(&state, &root.id, None).unwrap();
        assert_eq!(details.size, Some(bytes.len() as u64));
        assert_eq!(details.chapters, 3);
        assert!(details.modified.is_some());
        assert_eq!(fs::read(&state.storage).unwrap(), saved);
        let ids: Vec<_> = root
            .candidates
            .iter()
            .filter(|c| c.suggested)
            .map(|c| c.id.clone())
            .collect();
        let collection = configure_collection(&state, &root.token, true, &ids).unwrap();
        let part = &collection.collection.parts[2];
        let details = info(&state, &root.id, Some(&part.id)).unwrap();
        assert_eq!(details.chapters, part.chapters);
        assert_eq!(details.source_chapters, 3);
        assert!(details.source_title.is_some());
        fs::remove_file(path).unwrap();
        let details = info(&state, &root.id, None).unwrap();
        assert!(details.size.is_none());
        assert!(details.file_error.is_some());
        assert_eq!(details.title, root.title);
        assert!(info(&state, "missing", None).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
