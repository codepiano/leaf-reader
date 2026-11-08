mod epub;
use epub::{Book, Chapter, TocEntry};
use serde::{Deserialize, Serialize};
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

#[derive(Clone, Default, Serialize, Deserialize)]
struct Progress {
    chapter: usize,
    fraction: f64,
}
#[derive(Clone, Serialize, Deserialize)]
struct Recent {
    id: String,
    path: String,
    title: String,
    author: String,
    chapters: usize,
    progress: Progress,
    opened: u64,
}
#[derive(Default, Serialize, Deserialize)]
struct Library {
    recent: Vec<Recent>,
}
struct Session {
    token: String,
    id: String,
    book: Book,
}
struct ReaderState {
    session: Mutex<Option<Session>>,
    library: Mutex<Library>,
    storage: PathBuf,
}
#[derive(Serialize)]
struct Opened {
    token: String,
    id: String,
    title: String,
    author: String,
    chapters: Vec<Chapter>,
    toc: Vec<TocEntry>,
    progress: Progress,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn persist(state: &ReaderState, library: &Library) -> Result<(), String> {
    let bytes = serde_json::to_vec(library).map_err(|e| e.to_string())?;
    let temp = state.storage.with_extension("tmp");
    fs::write(&temp, bytes).map_err(|e| format!("保存阅读记录失败：{e}"))?;
    fs::rename(&temp, &state.storage).map_err(|e| format!("保存阅读记录失败：{e}"))
}
fn open_path(state: &ReaderState, path: &Path) -> Result<Opened, String> {
    // Serialize opening and progress updates. A failed open keeps the current book intact.
    let mut active = state.session.lock().map_err(|e| e.to_string())?;
    let canonical = path
        .canonicalize()
        .map_err(|_| "文件已移动或无法访问，请重新打开".to_string())?;
    if canonical
        .extension()
        .is_none_or(|e| !e.eq_ignore_ascii_case("epub"))
    {
        return Err("请选择 .epub 文件".into());
    }
    let book = Book::open(&canonical)?;
    let path = canonical.to_string_lossy().to_string();
    let mut hash = DefaultHasher::new();
    path.hash(&mut hash);
    let id = format!("{:x}", hash.finish());
    let token = format!(
        "{:x}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let mut library = state.library.lock().map_err(|e| e.to_string())?;
    let mut progress = library
        .recent
        .iter()
        .find(|r| r.id == id)
        .map(|r| r.progress.clone())
        .unwrap_or_default();
    progress.chapter = progress.chapter.min(book.chapters.len() - 1);
    progress.fraction = if progress.fraction.is_finite() {
        progress.fraction.clamp(0., 1.)
    } else {
        0.
    };
    let opened = Opened {
        token: token.clone(),
        id: id.clone(),
        title: book.title.clone(),
        author: book.author.clone(),
        chapters: book.chapters.clone(),
        toc: book.toc.clone(),
        progress: progress.clone(),
    };
    let recent = Recent {
        id: id.clone(),
        path,
        title: book.title.clone(),
        author: book.author.clone(),
        chapters: book.chapters.len(),
        progress,
        opened: now(),
    };
    let mut next = Library {
        recent: library
            .recent
            .iter()
            .filter(|r| r.id != id)
            .cloned()
            .collect(),
    };
    next.recent.insert(0, recent);
    next.recent.truncate(24);
    persist(state, &next)?;
    *library = next;
    *active = Some(Session { token, id, book });
    Ok(opened)
}
#[tauri::command]
async fn open_book(app: tauri::AppHandle, path: String) -> Result<Opened, String> {
    tauri::async_runtime::spawn_blocking(move || {
        open_path(&app.state::<ReaderState>(), Path::new(&path))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn open_demo(app: tauri::AppHandle) -> Result<Opened, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ReaderState>();
        let path = state.storage.with_file_name("缓慢的日常.epub");
        if !path.exists() {
            fs::write(&path, include_bytes!("../../fixtures/quiet-days.epub"))
                .map_err(|e| e.to_string())?;
        }
        open_path(&state, &path)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn list_recent(state: tauri::State<ReaderState>) -> Result<Vec<Recent>, String> {
    Ok(state
        .library
        .lock()
        .map_err(|e| e.to_string())?
        .recent
        .clone())
}
#[tauri::command]
async fn get_chapter(app: tauri::AppHandle, token: String, index: usize) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ReaderState>();
        let mut session = state.session.lock().map_err(|e| e.to_string())?;
        let s = session
            .as_mut()
            .filter(|s| s.token == token)
            .ok_or("书籍已关闭")?;
        let path = s.book.chapters.get(index).ok_or("章节不存在")?.path.clone();
        String::from_utf8(epub::read(&mut s.book.archive, &path, 8 * 1024 * 1024)?)
            .map_err(|_| "章节不是 UTF-8 编码".into())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn save_progress(
    state: tauri::State<ReaderState>,
    token: String,
    chapter: usize,
    fraction: f64,
) -> Result<(), String> {
    let session = state.session.lock().map_err(|e| e.to_string())?;
    let s = session
        .as_ref()
        .filter(|s| s.token == token)
        .ok_or("书籍已关闭")?;
    if chapter >= s.book.chapters.len() || !fraction.is_finite() {
        return Err("无效的阅读位置".into());
    }
    let mut library = state.library.lock().map_err(|e| e.to_string())?;
    if let Some(recent) = library.recent.iter_mut().find(|r| r.id == s.id) {
        recent.progress = Progress {
            chapter,
            fraction: fraction.clamp(0., 1.),
        };
    }
    persist(&state, &library)
}
#[tauri::command]
fn close_book(state: tauri::State<ReaderState>) {
    if let Ok(mut s) = state.session.lock() {
        *s = None;
    }
}
#[tauri::command]
fn frontend_ready() {
    // Opt-in readiness receipt for the external release benchmark. No production polling.
    if std::env::var_os("LEAF_BENCH").is_some() {
        println!("LEAF_READY");
    }
}

fn resource(app: &tauri::AppHandle, url: &str) -> Result<(Vec<u8>, &'static str), String> {
    let uri: tauri::http::Uri = url.parse().map_err(|_| "无效的资源地址")?;
    let path = percent_encoding::percent_decode_str(uri.path().trim_start_matches('/'))
        .decode_utf8()
        .map_err(|_| "无效的路径")?;
    let (token, path) = path.split_once('/').ok_or("无效的资源地址")?;
    if path.split('/').any(|p| p == "..") || path.contains(['\\', '\0']) {
        return Err("无效的路径".into());
    }
    let state = app.state::<ReaderState>();
    let mut active = state.session.lock().map_err(|e| e.to_string())?;
    let session = active
        .as_mut()
        .filter(|s| s.token == token)
        .ok_or("书籍已关闭")?;
    let mime = match path
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "css" => "text/css",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => return Err("不支持此资源类型".into()),
    };
    Ok((
        epub::read(&mut session.book.archive, path, epub::RESOURCE_LIMIT)?,
        mime,
    ))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Optional isolated profile for QA; never defaults to the user's source directory.
            let dir = std::env::var_os("LEAF_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?);
            fs::create_dir_all(&dir)?;
            let storage = dir.join("library.json");
            let library = match fs::read(&storage) {
                Ok(bytes) => serde_json::from_slice::<Library>(&bytes)
                    .map_err(|e| format!("阅读记录损坏，原文件已保留：{e}"))?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Library::default(),
                Err(e) => return Err(e.into()),
            };
            app.manage(ReaderState {
                session: Mutex::new(None),
                library: Mutex::new(library),
                storage,
            });
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("epub", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let (status, bytes, mime) = match resource(&app, &request.uri().to_string()) {
                    Ok((bytes, mime)) => (200, bytes, mime),
                    Err(_) => (404, Vec::new(), "text/plain"),
                };
                responder.respond(
                    tauri::http::Response::builder()
                        .status(status)
                        .header("Content-Type", mime)
                        .header("Access-Control-Allow-Origin", "*")
                        .header("X-Content-Type-Options", "nosniff")
                        .header(
                            "Content-Security-Policy",
                            "default-src 'none'; style-src 'unsafe-inline'",
                        )
                        .header("Cache-Control", "no-store")
                        .body(bytes)
                        .unwrap(),
                );
            });
        })
        .invoke_handler(tauri::generate_handler![
            open_book,
            open_demo,
            list_recent,
            get_chapter,
            save_progress,
            close_book,
            frontend_ready
        ])
        .run(tauri::generate_context!())
        .expect("无法启动 Leaf");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn records_survive_reopen_and_failed_open_preserves_session() {
        let dir = std::env::temp_dir().join(format!(
            "leaf-library-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let state = ReaderState {
            session: Mutex::new(None),
            library: Mutex::new(Library::default()),
            storage: dir.join("library.json"),
        };
        let path = Path::new("../fixtures/quiet-days.epub");
        let first = open_path(&state, path).unwrap();
        {
            let mut library = state.library.lock().unwrap();
            library.recent[0].progress = Progress {
                chapter: 1,
                fraction: 0.42,
            };
            persist(&state, &library).unwrap();
        }
        assert!(open_path(&state, &dir.join("missing.epub")).is_err());
        assert_eq!(
            state.session.lock().unwrap().as_ref().unwrap().token,
            first.token
        );
        let restored: Library = serde_json::from_slice(&fs::read(&state.storage).unwrap()).unwrap();
        let next = ReaderState {
            session: Mutex::new(None),
            library: Mutex::new(restored),
            storage: state.storage.clone(),
        };
        let second = open_path(&next, path).unwrap();
        assert_eq!(second.progress.chapter, 1);
        assert_eq!(second.progress.fraction, 0.42);
        assert_ne!(first.token, second.token);
        assert_eq!(first.id, second.id);
        assert_eq!(next.library.lock().unwrap().recent.len(), 1);
        drop(next);
        drop(state);
        fs::remove_dir_all(dir).unwrap();
    }
}
