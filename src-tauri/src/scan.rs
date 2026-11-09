use super::*;

static SCAN_LOCK: Mutex<()> = Mutex::new(());

const ENTRY_LIMIT: usize = 100_000;
const BOOK_LIMIT: usize = 10_000;
const ERROR_LIMIT: usize = 50;
#[derive(Default, Serialize)]
pub struct Report {
    found: usize,
    added: usize,
    existing: usize,
    excluded: usize,
    updated: usize,
    missing: usize,
    failed: usize,
    errors: Vec<String>,
    truncated: bool,
}
impl Report {
    fn error(&mut self, path: &Path, error: impl std::fmt::Display) {
        self.failed += 1;
        if self.errors.len() < ERROR_LIMIT {
            self.errors.push(format!("{}：{error}", path.display()));
        }
    }
}
pub fn configure(state: &ReaderState, directories: Vec<String>) -> Result<Vec<String>, String> {
    if directories.len() > 32 {
        return Err("最多设置 32 个扫描目录".into());
    }
    let previous = state
        .library
        .lock()
        .map_err(|e| e.to_string())?
        .scan_directories
        .clone();
    let mut paths = Vec::new();
    for directory in directories {
        let path = match Path::new(&directory).canonicalize() {
            Ok(path) if path.is_dir() => path.to_string_lossy().to_string(),
            // Keep an already configured disconnected disk; removing it remains possible.
            Err(_) if previous.contains(&directory) => directory,
            _ => return Err("扫描目录无法访问或不是文件夹".into()),
        };
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    let mut library = state.library.lock().map_err(|e| e.to_string())?;
    let mut next = library.clone();
    next.scan_directories = paths.clone();
    persist(state, &next)?;
    *library = next;
    Ok(paths)
}

// Only metadata is read during discovery. Sessions, reading times and source files are untouched.
pub fn scan(state: &ReaderState) -> Result<Report, String> {
    let _scan = SCAN_LOCK.lock().map_err(|e| e.to_string())?;
    let (directories, mut known, aliases, excluded) = {
        let library = state.library.lock().map_err(|e| e.to_string())?;
        let records: HashMap<_, _> = library
            .recent
            .iter()
            .map(|r| (r.id.clone(), r.path.clone()))
            .collect();
        let aliases: Vec<_> = library
            .import_sources
            .iter()
            .filter_map(|(source, id)| {
                records
                    .get(id)
                    .map(|destination| (source.clone(), destination.clone()))
            })
            .collect();
        (
            library.scan_directories.clone(),
            library
                .recent
                .iter()
                .map(|r| r.path.clone())
                .collect::<HashSet<_>>(),
            aliases,
            library
                .recent
                .iter()
                .filter(|r| library.hidden_books.contains(&r.id))
                .map(|r| r.path.clone())
                .chain(
                    library
                        .import_sources
                        .iter()
                        .filter(|(_, id)| library.hidden_books.contains(*id))
                        .map(|(path, _)| path.clone()),
                )
                .collect::<HashSet<_>>(),
        )
    };
    let record_paths = known.clone();
    for (source, destination) in aliases {
        if Path::new(&destination).is_file() {
            known.insert(source);
        }
    }
    let mut report = Report::default();
    let mut visited = HashSet::new();
    let mut seen_files = HashSet::new();
    let mut discoveries = Vec::new();
    let mut unreadable = HashSet::new();
    let mut entries = 0;
    'roots: for root in directories {
        let root = PathBuf::from(root);
        let root = match root.canonicalize() {
            Ok(p) => p,
            Err(e) => {
                report.error(&root, e);
                continue;
            }
        };
        if !visited.insert(root.clone()) {
            continue;
        }
        let reader = match fs::read_dir(&root) {
            Ok(r) => r,
            Err(e) => {
                report.error(&root, e);
                continue;
            }
        };
        let mut stack = vec![(root, reader)];
        while let Some((parent, reader)) = stack.last_mut() {
            let entry = match reader.next() {
                None => {
                    stack.pop();
                    continue;
                }
                Some(Err(e)) => {
                    report.error(parent, e);
                    continue;
                }
                Some(Ok(entry)) => entry,
            };
            entries += 1;
            if entries > ENTRY_LIMIT {
                report.truncated = true;
                break 'roots;
            }
            let path = entry.path();
            let kind = match entry.file_type() {
                Ok(kind) => kind,
                Err(e) => {
                    report.error(&path, e);
                    continue;
                }
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                if visited.insert(path.clone()) {
                    match fs::read_dir(&path) {
                        Ok(reader) => stack.push((path, reader)),
                        Err(e) => report.error(&path, e),
                    }
                }
                continue;
            }
            if !kind.is_file()
                || path
                    .extension()
                    .is_none_or(|e| !e.eq_ignore_ascii_case("epub"))
            {
                continue;
            }
            if !seen_files.insert(path.clone()) {
                continue;
            }
            if report.found >= BOOK_LIMIT {
                report.truncated = true;
                break 'roots;
            }
            report.found += 1;
            let path_string = path.to_string_lossy().to_string();
            if excluded.contains(&path_string) {
                report.excluded += 1;
                continue;
            }
            if known.contains(&path_string) {
                report.existing += 1;
                if !record_paths.contains(&path_string) {
                    continue;
                }
            }
            match Book::open(&path) {
                Ok(book) => {
                    let mut hash = DefaultHasher::new();
                    path_string.hash(&mut hash);
                    discoveries.push(Recent {
                        available: true,
                        id: format!("{:x}", hash.finish()),
                        path: path_string,
                        title: book.title,
                        author: book.author,
                        chapters: book.chapters.len(),
                        progress: Progress::default(),
                        opened: 0,
                    });
                }
                Err(e) => {
                    unreadable.insert(path_string);
                    report.error(&path, e);
                }
            }
        }
    }
    // Check source paths outside the lock. Unseen new books opened during IO keep their current state.
    let mut availability: HashMap<_, _> = record_paths
        .iter()
        .cloned()
        .chain(discoveries.iter().map(|book| book.path.clone()))
        .map(|path| {
            let available = Path::new(&path).is_file();
            (path, available)
        })
        .collect();
    for path in unreadable {
        availability.insert(path, false);
    }
    // Merge into the latest state, preserving edits and books opened while IO was in progress.
    let mut library = state.library.lock().map_err(|e| e.to_string())?;
    let mut next = library.clone();
    let mut indexes: HashMap<_, _> = next
        .recent
        .iter()
        .enumerate()
        .map(|(index, book)| (book.id.clone(), index))
        .collect();
    let destinations: HashMap<_, _> = next
        .recent
        .iter()
        .map(|book| (book.id.clone(), book.path.clone()))
        .collect();
    let mut updated = HashSet::new();
    let mut dirty = false;
    for book in discoveries {
        if let Some(&index) = indexes.get(&book.id) {
            let record = &mut next.recent[index];
            if record.title != book.title
                || record.author != book.author
                || record.chapters != book.chapters
            {
                record.title = book.title;
                record.author = book.author;
                record.chapters = book.chapters;
                updated.insert(record.id.clone());
                dirty = true;
            }
            if !known.contains(&book.path) {
                report.existing += 1;
            }
        } else {
            let imported = next
                .import_sources
                .get(&book.path)
                .and_then(|id| destinations.get(id))
                .is_some_and(|path| availability.get(path).copied().unwrap_or(true));
            if imported {
                if !known.contains(&book.path) {
                    report.existing += 1;
                }
            } else {
                indexes.insert(book.id.clone(), next.recent.len());
                next.recent.push(book);
                report.added += 1;
                dirty = true;
            }
        }
    }
    for record in &mut next.recent {
        if let Some(&available) = availability.get(&record.path) {
            if record.available != available {
                if available {
                    updated.insert(record.id.clone());
                }
                record.available = available;
                dirty = true;
            }
        }
    }
    updated.retain(|id| !next.hidden_books.contains(id));
    report.updated = updated.len();
    report.missing = next
        .recent
        .iter()
        .filter(|book| !book.available && !next.hidden_books.contains(&book.id))
        .count();
    if dirty {
        persist(state, &next)?;
        *library = next;
    }
    Ok(report)
}
#[tauri::command]
pub fn scan_directories(state: tauri::State<ReaderState>) -> Result<Vec<String>, String> {
    Ok(state
        .library
        .lock()
        .map_err(|e| e.to_string())?
        .scan_directories
        .clone())
}
#[tauri::command]
pub async fn set_scan_directories(
    app: tauri::AppHandle,
    directories: Vec<String>,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        configure(&app.state::<ReaderState>(), directories)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn scan_library(app: tauri::AppHandle) -> Result<Report, String> {
    tauri::async_runtime::spawn_blocking(move || scan(&app.state::<ReaderState>()))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state() -> (ReaderState, PathBuf) {
        let dir = std::env::temp_dir().join(format!("leaf-scan-{}", token()));
        fs::create_dir_all(&dir).unwrap();
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
    fn recursive_multiple_sources_are_deduplicated_unread_and_never_copied() {
        let (state, dir) = state();
        let one = dir.join("source-one");
        let sub = one.join("sub");
        let two = dir.join("source-two");
        let destination = dir.join("library");
        for p in [&sub, &two, &destination] {
            fs::create_dir_all(p).unwrap();
        }
        let bytes = include_bytes!("../../fixtures/quiet-days.epub");
        fs::write(one.join("a.EPUB"), bytes).unwrap();
        fs::write(sub.join("b.epub"), bytes).unwrap();
        fs::write(two.join("c.epub"), bytes).unwrap();
        fs::write(two.join("bad.epub"), b"bad").unwrap();
        fs::write(two.join("ignored.txt"), b"text").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&one, sub.join("loop")).unwrap();
            std::os::unix::fs::symlink(one.join("a.EPUB"), two.join("linked.epub")).unwrap();
        }
        library_directory::configure_settings(
            &state,
            Some(destination.to_string_lossy().into()),
            true,
            None,
            None,
        )
        .unwrap();
        let active = open_path(&state, Path::new("../fixtures/anthology.epub")).unwrap();
        write_progress(&state, &active.token, 1, 0.4).unwrap();
        let sources = vec![
            one.to_string_lossy().into(),
            sub.to_string_lossy().into(),
            two.to_string_lossy().into(),
            one.to_string_lossy().into(),
        ];
        assert_eq!(configure(&state, sources).unwrap().len(), 3);
        let first = scan(&state).unwrap();
        assert_eq!(first.found, 4);
        assert_eq!(first.added, 3);
        assert_eq!(first.failed, 1);
        assert!(!first.truncated);
        assert_eq!(
            state.session.lock().unwrap().as_ref().unwrap().token,
            active.token
        );
        let library = state.library.lock().unwrap();
        assert_eq!(library.recent.len(), 4);
        assert_eq!(library.recent[0].progress.fraction, 0.4);
        assert!(library
            .recent
            .iter()
            .filter(|r| r.id != active.id)
            .all(|r| r.opened == 0 && r.progress.fraction == 0.));
        drop(library);
        let record = state
            .library
            .lock()
            .unwrap()
            .recent
            .iter()
            .find(|r| r.path.ends_with("a.EPUB"))
            .unwrap()
            .clone();
        update_metadata(
            &state,
            &record.id,
            None,
            "文学".into(),
            vec!["待读".into()],
            true,
        )
        .unwrap();
        let second = scan(&state).unwrap();
        assert_eq!(second.added, 0);
        assert_eq!(second.existing, 3);
        assert_eq!(second.failed, 1);
        assert!(state.library.lock().unwrap().metadata[&record.id].favorite);
        assert_eq!(fs::read_dir(destination).unwrap().count(), 0);
        assert_eq!(fs::read(one.join("a.EPUB")).unwrap(), bytes);
        let saved: Library = serde_json::from_slice(&fs::read(&state.storage).unwrap()).unwrap();
        assert_eq!(saved.scan_directories.len(), 3);
        assert!(saved.settings.import_enabled);
        configure(&state, vec![]).unwrap();
        assert_eq!(state.library.lock().unwrap().recent.len(), 4);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn reading_imports_to_an_independent_directory_and_rescans_keep_one_record() {
        let (state, dir) = state();
        let source = dir.join("sources");
        let destination = dir.join("library");
        let other = dir.join("other-library");
        for path in [&source, &destination, &other] {
            fs::create_dir_all(path).unwrap();
        }
        let file = source.join("book.epub");
        fs::write(&file, include_bytes!("../../fixtures/quiet-days.epub")).unwrap();
        configure(&state, vec![source.to_string_lossy().into()]).unwrap();
        assert_eq!(scan(&state).unwrap().added, 1);
        // Merely opening a scanned book still uses its source while import is off.
        assert_eq!(
            library_directory::source(&state, &file, true).unwrap(),
            file
        );
        let opened = open_path(&state, &file).unwrap();
        write_progress(&state, &opened.token, 1, 0.6).unwrap();
        reading_time::record(&state, &opened.token, 5000).unwrap();
        update_metadata(
            &state,
            &opened.id,
            None,
            "文学".into(),
            vec!["待读".into()],
            true,
        )
        .unwrap();
        library_directory::configure_settings(
            &state,
            Some(destination.to_string_lossy().into()),
            true,
            None,
            None,
        )
        .unwrap();
        assert_eq!(scan(&state).unwrap().existing, 1);
        assert_eq!(fs::read_dir(&destination).unwrap().count(), 0);
        let copied = library_directory::source(&state, &file, true).unwrap();
        let imported = open_scoped_from(&state, &copied, None, Some(&file)).unwrap();
        assert!(imported.metadata.favorite);
        assert_eq!(imported.progress.fraction, 0.6);
        assert_eq!(state.library.lock().unwrap().reading_ms[&imported.id], 5000);
        assert_eq!(scan(&state).unwrap().added, 0);
        assert_eq!(state.library.lock().unwrap().recent.len(), 1);
        library_directory::configure_settings(
            &state,
            Some(other.to_string_lossy().into()),
            true,
            None,
            None,
        )
        .unwrap();
        let copied_again = library_directory::source(&state, &copied, true).unwrap();
        open_scoped_from(&state, &copied_again, None, Some(&copied)).unwrap();
        assert_eq!(scan(&state).unwrap().added, 0);
        assert_eq!(state.library.lock().unwrap().recent.len(), 1);
        // Losing an imported copy must not hide the still-readable original from scans.
        fs::remove_file(copied_again).unwrap();
        assert_eq!(scan(&state).unwrap().added, 1);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn refresh_updates_metadata_and_availability_without_losing_personal_state() {
        let (state, dir) = state();
        let source = dir.join("sources");
        fs::create_dir(&source).unwrap();
        let file = source.join("book.epub");
        fs::write(&file, include_bytes!("../../fixtures/quiet-days.epub")).unwrap();
        configure(&state, vec![source.to_string_lossy().into()]).unwrap();
        scan(&state).unwrap();
        let opened = open_path(&state, &file).unwrap();
        write_progress(&state, &opened.token, 1, 0.45).unwrap();
        update_metadata(
            &state,
            &opened.id,
            None,
            "文学".into(),
            vec!["精选".into()],
            true,
        )
        .unwrap();
        {
            let mut library = state.library.lock().unwrap();
            let meta = library.metadata.get_mut(&opened.id).unwrap();
            meta.pinned = true;
            meta.details.title = "手动书名".into();
            meta.details.author = "手动作者".into();
            library.reading_ms.insert(opened.id.clone(), 12000);
        }
        let before = state.library.lock().unwrap().recent[0].clone();
        // Atomic replacement leaves the active session's original archive intact.
        let replacement = source.join("replacement.tmp");
        fs::write(
            &replacement,
            include_bytes!("../../fixtures/anthology.epub"),
        )
        .unwrap();
        fs::rename(replacement, &file).unwrap();
        let refreshed = scan(&state).unwrap();
        assert_eq!(refreshed.updated, 1);
        assert_eq!(refreshed.added, 0);
        {
            let library = state.library.lock().unwrap();
            let record = &library.recent[0];
            let original = Book::open(&file).unwrap();
            assert_eq!(record.title, original.title);
            assert_eq!(record.author, original.author);
            assert_eq!(record.chapters, original.chapters.len());
            assert_eq!(record.opened, before.opened);
            assert_eq!(record.progress.fraction, 0.45);
            let meta = &library.metadata[&opened.id];
            assert!(meta.pinned && meta.favorite);
            assert_eq!(meta.details.title, "手动书名");
            assert_eq!(meta.details.author, "手动作者");
            assert_eq!(meta.group, "文学");
            assert_eq!(meta.tags, ["精选"]);
            assert_eq!(library.reading_ms[&opened.id], 12000);
        }
        assert_eq!(
            state.session.lock().unwrap().as_ref().unwrap().token,
            opened.token
        );
        fs::remove_file(&file).unwrap();
        assert_eq!(scan(&state).unwrap().missing, 1);
        assert!(!state.library.lock().unwrap().recent[0].available);
        fs::write(&file, b"broken").unwrap();
        let broken = scan(&state).unwrap();
        assert_eq!(broken.failed, 1);
        assert_eq!(broken.missing, 1);
        fs::write(&file, include_bytes!("../../fixtures/anthology.epub")).unwrap();
        let restored = scan(&state).unwrap();
        assert_eq!(restored.updated, 1);
        assert_eq!(restored.missing, 0);
        assert_eq!(restored.added, 0);
        let saved: Library = serde_json::from_slice(&fs::read(&state.storage).unwrap()).unwrap();
        assert_eq!(saved.recent.len(), 1);
        assert!(saved.recent[0].available);
        assert_eq!(saved.recent[0].progress.fraction, 0.45);
        assert_eq!(scan(&state).unwrap().updated, 0);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn unavailable_roots_and_failed_persistence_preserve_existing_state() {
        let (mut state, dir) = state();
        let source = dir.join("source");
        fs::create_dir(&source).unwrap();
        fs::write(
            source.join("book.epub"),
            include_bytes!("../../fixtures/quiet-days.epub"),
        )
        .unwrap();
        let configured = configure(&state, vec![source.to_string_lossy().into()]).unwrap();
        state.storage = dir.join("missing/library.json");
        assert!(scan(&state).is_err());
        assert!(state.library.lock().unwrap().recent.is_empty());
        state.storage = dir.join("library.json");
        fs::remove_dir_all(source).unwrap();
        configure(&state, configured).unwrap();
        let result = scan(&state).unwrap();
        assert_eq!(result.failed, 1);
        assert_eq!(result.added, 0);
        assert!(configure(
            &state,
            vec![dir.join("never-existed").to_string_lossy().into()]
        )
        .is_err());
        assert!(configure(&state, vec!["x".into(); 33]).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
