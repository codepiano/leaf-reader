use super::*;
use std::io::{Read, Write};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub directory: Option<String>,
    pub import_enabled: bool,
}

pub fn configure(
    state: &ReaderState,
    directory: Option<String>,
    enabled: bool,
) -> Result<Settings, String> {
    let directory = directory
        .map(|p| -> Result<String, String> {
            let path = Path::new(&p)
                .canonicalize()
                .map_err(|e| format!("无法访问书库目录：{e}"))?;
            if !path.is_dir() {
                return Err("请选择文件夹作为书库目录".into());
            }
            Ok(path.to_string_lossy().to_string())
        })
        .transpose()?;
    if enabled && directory.is_none() {
        return Err("请先选择书库目录".into());
    }
    let mut library = state.library.lock().map_err(|e| e.to_string())?;
    let mut next = library.clone();
    next.settings = Settings {
        directory,
        import_enabled: enabled,
    };
    persist(state, &next)?;
    *library = next;
    Ok(library.settings.clone())
}

fn identical(a: &Path, b: &Path) -> std::io::Result<bool> {
    let mut a = fs::File::open(a)?;
    let mut b = fs::File::open(b)?;
    if a.metadata()?.len() != b.metadata()?.len() {
        return Ok(false);
    }
    let mut x = [0; 65536];
    let mut y = [0; 65536];
    loop {
        let count = a.read(&mut x)?;
        if count == 0 {
            return Ok(true);
        }
        b.read_exact(&mut y[..count])?;
        if x[..count] != y[..count] {
            return Ok(false);
        }
    }
}

// Stream into an exclusively created destination; never overwrite or move a user's file.
pub fn source(state: &ReaderState, path: &Path, importing: bool) -> Result<PathBuf, String> {
    let settings = state
        .library
        .lock()
        .map_err(|e| e.to_string())?
        .settings
        .clone();
    if !importing || !settings.import_enabled {
        return Ok(path.to_path_buf());
    }
    let source = path
        .canonicalize()
        .map_err(|e| format!("无法访问原文件：{e}"))?;
    if source
        .extension()
        .is_none_or(|e| !e.eq_ignore_ascii_case("epub"))
    {
        return Err("请选择 .epub 文件".into());
    }
    let directory = PathBuf::from(settings.directory.ok_or("请先选择书库目录")?)
        .canonicalize()
        .map_err(|e| format!("无法访问书库目录：{e}"))?;
    if source.starts_with(&directory) {
        return Ok(source);
    }
    // Validate before creating a copy, so malformed books do not enter the library directory.
    drop(Book::open(&source)?);
    let name = source.file_name().ok_or("文件名无效")?;
    let stem = source.file_stem().ok_or("文件名无效")?.to_string_lossy();
    for suffix in 0..10000 {
        let destination = directory.join(if suffix == 0 {
            name.to_os_string()
        } else {
            format!("{stem} ({suffix}).epub").into()
        });
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
        {
            Ok(mut output) => {
                let copied = (|| {
                    let mut input = fs::File::open(&source)?;
                    std::io::copy(&mut input, &mut output)?;
                    output.flush()?;
                    output.sync_all()
                })();
                drop(output);
                if let Err(e) = copied {
                    let _ = fs::remove_file(&destination);
                    return Err(format!("导入书库失败：{e}"));
                }
                return Ok(destination);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                // Do not follow destination symlinks outside the selected directory.
                if fs::symlink_metadata(&destination).is_ok_and(|m| m.is_file())
                    && identical(&source, &destination)
                        .map_err(|e| format!("检查同名文件失败：{e}"))?
                {
                    return Ok(destination);
                }
            }
            Err(e) => return Err(format!("导入书库失败：{e}")),
        }
    }
    Err("同名文件过多，请更换书库目录".into())
}

#[tauri::command]
pub fn library_settings(state: tauri::State<ReaderState>) -> Result<Settings, String> {
    Ok(state
        .library
        .lock()
        .map_err(|e| e.to_string())?
        .settings
        .clone())
}
#[tauri::command]
pub async fn set_library_settings(
    app: tauri::AppHandle,
    directory: Option<String>,
    import_enabled: bool,
) -> Result<Settings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        configure(&app.state::<ReaderState>(), directory, import_enabled)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opt_in_copy_collision_reuse_and_settings_persist() {
        let dir = std::env::temp_dir().join(format!("leaf-import-{}", token()));
        fs::create_dir_all(dir.join("books")).unwrap();
        let state = ReaderState {
            session: Mutex::new(None),
            library: Mutex::new(Library::default()),
            storage: dir.join("library.json"),
        };
        let file = dir.join("book.epub");
        let bytes = include_bytes!("../../fixtures/quiet-days.epub");
        fs::write(&file, bytes).unwrap();
        assert_eq!(source(&state, &file, true).unwrap(), file);
        assert!(configure(&state, None, true).is_err());
        let books = dir.join("books");
        configure(&state, Some(books.to_string_lossy().into()), false).unwrap();
        assert_eq!(source(&state, &file, true).unwrap(), file);
        assert_eq!(fs::read_dir(&books).unwrap().count(), 0);
        configure(&state, Some(books.to_string_lossy().into()), true).unwrap();
        fs::write(books.join("book.epub"), b"user's existing file").unwrap();
        assert_eq!(source(&state, &file, false).unwrap(), file);
        // Importing an already-read source carries its progress and metadata to the new path.
        let original = open_path(&state, &file).unwrap();
        write_progress(&state, &original.token, 0, 0.42).unwrap();
        update_metadata(
            &state,
            &original.id,
            None,
            "文学".into(),
            vec!["待读".into()],
            true,
        )
        .unwrap();
        let copied = source(&state, &file, true).unwrap();
        assert_eq!(copied.file_name().unwrap(), "book (1).epub");
        let imported = open_scoped_from(&state, &copied, None, Some(&file)).unwrap();
        assert_eq!(imported.progress.fraction, 0.42);
        assert!(imported.metadata.favorite);
        assert_eq!(imported.metadata.group, "文学");
        assert_eq!(state.library.lock().unwrap().recent.len(), 1);

        assert_eq!(fs::read(&copied).unwrap(), bytes);
        assert_eq!(source(&state, &file, true).unwrap(), copied);
        assert_eq!(source(&state, &copied, true).unwrap(), copied);
        assert_eq!(fs::read(&file).unwrap(), bytes);
        assert_eq!(
            fs::read(books.join("book.epub")).unwrap(),
            b"user's existing file"
        );
        let persisted: Library =
            serde_json::from_slice(&fs::read(&state.storage).unwrap()).unwrap();
        assert!(persisted.settings.import_enabled);
        assert!(serde_json::from_str::<Library>("{}")
            .unwrap()
            .settings
            .directory
            .is_none());
        let bad = dir.join("bad.epub");
        fs::write(&bad, b"bad").unwrap();
        assert!(source(&state, &bad, true).is_err());
        assert!(!books.join("bad.epub").exists());
        fs::remove_dir_all(&books).unwrap();
        assert!(source(&state, &file, true).is_err());
        configure(&state, None, false).unwrap();
        assert_eq!(source(&state, &file, true).unwrap(), file);
        fs::remove_dir_all(dir).unwrap();
    }
}
