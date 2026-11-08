mod book_info;
mod collection;
mod cover;
mod epub;
mod library_directory;
mod reading_time;
mod scan;
use collection::{Candidate, Collection};
use epub::{Book, Chapter, TocEntry};
use serde::{Deserialize, Serialize};
use std::{
    collections::{hash_map::DefaultHasher, HashMap, HashSet},
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Progress {
    pub chapter: usize,
    pub fraction: f64,
}
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ReadingStatus {
    Unread,
    Reading,
    Finished,
}
#[derive(Default, Deserialize)]
struct BookFlags {
    pinned: Option<bool>,
    reading_status: Option<ReadingStatus>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct BookMeta {
    group: String,
    tags: Vec<String>,
    favorite: bool,
    pinned: bool,
    reading_status: Option<ReadingStatus>,
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
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct Library {
    settings: library_directory::Settings,
    reading_ms: HashMap<String, u64>,
    scan_directories: Vec<String>,
    import_sources: HashMap<String, String>,
    recent: Vec<Recent>,
    collections: HashMap<String, Collection>,
    metadata: HashMap<String, BookMeta>,
    groups: Vec<String>,
}
struct Session {
    token: String,
    id: String,
    book: Book,
    view_chapters: Vec<Chapter>,
    part_id: Option<String>,
}
struct ReaderState {
    session: Mutex<Option<Session>>,
    library: Mutex<Library>,
    storage: PathBuf,
}
#[derive(Serialize)]
struct Opened {
    track_reading_time: bool,
    token: String,
    id: String,
    path: String,
    title: String,
    source_title: String,
    author: String,
    chapters: Vec<Chapter>,
    toc: Vec<TocEntry>,
    progress: Progress,
    collection: Collection,
    candidates: Vec<Candidate>,
    part_id: Option<String>,
    metadata: BookMeta,
}
#[derive(Serialize)]
struct ShelfEntry {
    #[serde(flatten)]
    recent: Recent,
    collection: Collection,
    metadata: BookMeta,
    part_metadata: HashMap<String, BookMeta>,
}
#[derive(Serialize)]
struct Snapshot {
    books: Vec<ShelfEntry>,
    groups: Vec<String>,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn token() -> String {
    format!(
        "{:x}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}
fn item_key(id: &str, part_id: Option<&str>) -> String {
    part_id
        .map(|p| format!("{id}::{p}"))
        .unwrap_or_else(|| id.to_string())
}
fn persist(state: &ReaderState, library: &Library) -> Result<(), String> {
    let bytes = serde_json::to_vec(library).map_err(|e| e.to_string())?;
    let temp = state.storage.with_extension("tmp");
    fs::write(&temp, bytes).map_err(|e| format!("保存阅读记录失败：{e}"))?;
    fs::rename(&temp, &state.storage).map_err(|e| format!("保存阅读记录失败：{e}"))
}
fn snapshot(library: &Library) -> Snapshot {
    Snapshot {
        groups: library.groups.clone(),
        books: library
            .recent
            .iter()
            .map(|r| {
                let collection = library.collections.get(&r.id).cloned().unwrap_or_default();
                let part_metadata = collection
                    .parts
                    .iter()
                    .map(|p| {
                        (
                            p.id.clone(),
                            library
                                .metadata
                                .get(&item_key(&r.id, Some(&p.id)))
                                .cloned()
                                .unwrap_or_default(),
                        )
                    })
                    .collect();
                ShelfEntry {
                    recent: r.clone(),
                    collection,
                    metadata: library.metadata.get(&r.id).cloned().unwrap_or_default(),
                    part_metadata,
                }
            })
            .collect(),
    }
}
fn make_opened(
    session: &mut Session,
    library: &Library,
    part_id: Option<&str>,
) -> Result<Opened, String> {
    let recent = library
        .recent
        .iter()
        .find(|r| r.id == session.id)
        .ok_or("书籍记录不存在")?;
    let collection = library
        .collections
        .get(&session.id)
        .cloned()
        .unwrap_or_default();
    let part = match part_id {
        Some(id) if collection.enabled => Some(
            collection
                .parts
                .iter()
                .find(|p| p.id == id)
                .ok_or("子书已变化，请重新打开合集")?,
        ),
        Some(_) => return Err("合集模式已关闭，请重新打开原书".into()),
        None => None,
    };
    let (chapters, toc) = collection::view(&mut session.book, part)?;
    let mut progress = part
        .map(|p| p.progress.clone())
        .unwrap_or_else(|| recent.progress.clone());
    if !library.settings.remember_position {
        progress = Progress::default();
    }
    progress.chapter = progress.chapter.min(chapters.len() - 1);
    progress.fraction = if progress.fraction.is_finite() {
        progress.fraction.clamp(0., 1.)
    } else {
        0.
    };
    session.view_chapters = chapters.clone();
    session.part_id = part_id.map(str::to_string);
    session.token = token();
    Ok(Opened {
        track_reading_time: library.settings.track_reading_time,
        token: session.token.clone(),
        id: session.id.clone(),
        path: recent.path.clone(),
        title: part
            .map(|p| p.title.clone())
            .unwrap_or_else(|| session.book.title.clone()),
        source_title: session.book.title.clone(),
        author: session.book.author.clone(),
        chapters,
        toc,
        progress,
        collection: collection.clone(),
        candidates: collection::candidates(&session.book.toc),
        part_id: session.part_id.clone(),
        metadata: library
            .metadata
            .get(&item_key(&session.id, part_id))
            .cloned()
            .unwrap_or_default(),
    })
}
fn open_scoped(state: &ReaderState, path: &Path, part_id: Option<&str>) -> Result<Opened, String> {
    open_scoped_from(state, path, part_id, None)
}
fn open_scoped_from(
    state: &ReaderState,
    path: &Path,
    part_id: Option<&str>,
    origin: Option<&Path>,
) -> Result<Opened, String> {
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
    let mut library = state.library.lock().map_err(|e| e.to_string())?;
    let mut next = library.clone();
    // An explicit import of a previously read file changes its location, not its reading identity.
    if !next.recent.iter().any(|r| r.id == id) {
        let original = origin
            .and_then(|p| p.canonicalize().ok())
            .map(|p| p.to_string_lossy().to_string());
        if let Some(previous) = next
            .recent
            .iter()
            .find(|r| Some(&r.path) == original.as_ref())
            .cloned()
        {
            if let Some(record) = next.recent.iter_mut().find(|r| r.id == previous.id) {
                record.id = id.clone();
                record.path = path.clone();
            }
            if let Some(collection) = next.collections.remove(&previous.id) {
                next.collections.insert(id.clone(), collection);
            }
            for target in next.import_sources.values_mut() {
                if *target == previous.id {
                    *target = id.clone();
                }
            }
            let prefix = format!("{}::", previous.id);
            let keys: Vec<_> = next
                .metadata
                .keys()
                .filter(|key| *key == &previous.id || key.starts_with(&prefix))
                .cloned()
                .collect();
            let time_keys: Vec<_> = next
                .reading_ms
                .keys()
                .filter(|key| *key == &previous.id || key.starts_with(&prefix))
                .cloned()
                .collect();
            for key in time_keys {
                if let Some(value) = next.reading_ms.remove(&key) {
                    next.reading_ms
                        .insert(format!("{id}{}", &key[previous.id.len()..]), value);
                }
            }
            for key in keys {
                let suffix = &key[previous.id.len()..];
                if let Some(meta) = next.metadata.remove(&key) {
                    next.metadata.insert(format!("{id}{suffix}"), meta);
                }
            }
        }
    }
    if let Some(original) = origin.and_then(|p| p.canonicalize().ok()) {
        if original != canonical {
            next.import_sources
                .insert(original.to_string_lossy().to_string(), id.clone());
        }
    }
    let old = next.recent.iter().find(|r| r.id == id).cloned();
    next.recent.retain(|r| r.id != id);
    next.recent.insert(
        0,
        Recent {
            id: id.clone(),
            path,
            title: book.title.clone(),
            author: book.author.clone(),
            chapters: book.chapters.len(),
            progress: old.as_ref().map(|r| r.progress.clone()).unwrap_or_default(),
            opened: old.map(|r| r.opened).unwrap_or_default(),
        },
    );
    let c = next.collections.get(&id);
    if part_id.is_none() && !c.is_some_and(|c| c.enabled) {
        next.recent[0].opened = now();
    }
    if let Some(part_id) = part_id {
        if let Some(p) = next
            .collections
            .get_mut(&id)
            .and_then(|c| c.parts.iter_mut().find(|p| p.id == part_id))
        {
            p.opened = now();
        }
    }
    if part_id.is_some() || !next.collections.get(&id).is_some_and(|c| c.enabled) {
        next.metadata
            .entry(item_key(&id, part_id))
            .or_default()
            .reading_status
            .get_or_insert(ReadingStatus::Reading);
    }
    let mut session = Session {
        token: String::new(),
        id,
        book,
        view_chapters: Vec::new(),
        part_id: None,
    };
    let opened = make_opened(&mut session, &next, part_id)?;
    persist(state, &next)?;
    *library = next;
    *active = Some(session);
    Ok(opened)
}
fn open_path(state: &ReaderState, path: &Path) -> Result<Opened, String> {
    open_scoped(state, path, None)
}
#[tauri::command]
async fn open_book(
    app: tauri::AppHandle,
    path: String,
    part_id: Option<String>,
    import_file: Option<bool>,
) -> Result<Opened, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let origin = Path::new(&path);
        let destination = library_directory::source(
            &app.state::<ReaderState>(),
            origin,
            import_file.unwrap_or(false),
        )?;
        open_scoped_from(
            &app.state::<ReaderState>(),
            &destination,
            part_id.as_deref(),
            Some(origin),
        )
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
fn library_snapshot(state: tauri::State<ReaderState>) -> Result<Snapshot, String> {
    Ok(snapshot(&*state.library.lock().map_err(|e| e.to_string())?))
}
#[tauri::command]
fn list_recent(state: tauri::State<ReaderState>) -> Result<Vec<ShelfEntry>, String> {
    Ok(snapshot(&*state.library.lock().map_err(|e| e.to_string())?).books)
}
fn configure_collection(
    state: &ReaderState,
    token: &str,
    enabled: bool,
    node_ids: &[String],
) -> Result<Opened, String> {
    let mut active = state.session.lock().map_err(|e| e.to_string())?;
    let session = active
        .as_mut()
        .filter(|s| s.token == token)
        .ok_or("书籍已关闭，请重新打开")?;
    let mut library = state.library.lock().map_err(|e| e.to_string())?;
    let mut next = library.clone();
    let old = next
        .collections
        .get(&session.id)
        .cloned()
        .unwrap_or_default();
    let collection = if enabled {
        collection::plan(&mut session.book, node_ids, &old)?
    } else {
        Collection {
            enabled: false,
            ..old
        }
    };
    next.collections.insert(session.id.clone(), collection);
    if !enabled {
        if let Some(r) = next.recent.iter_mut().find(|r| r.id == session.id) {
            r.opened = now();
        }
    }
    persist(state, &next)?;
    *library = next;
    make_opened(session, &library, None)
}
#[tauri::command]
async fn set_collection(
    app: tauri::AppHandle,
    token: String,
    enabled: bool,
    node_ids: Vec<String>,
) -> Result<Opened, String> {
    tauri::async_runtime::spawn_blocking(move || {
        configure_collection(&app.state::<ReaderState>(), &token, enabled, &node_ids)
    })
    .await
    .map_err(|e| e.to_string())?
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
        let path = s.view_chapters.get(index).ok_or("章节不存在")?.path.clone();
        String::from_utf8(epub::read(&mut s.book.archive, &path, 8 * 1024 * 1024)?)
            .map_err(|_| "章节不是 UTF-8 编码".into())
    })
    .await
    .map_err(|e| e.to_string())?
}
fn write_progress(
    state: &ReaderState,
    token: &str,
    chapter: usize,
    fraction: f64,
) -> Result<(), String> {
    let active = state.session.lock().map_err(|e| e.to_string())?;
    let s = active
        .as_ref()
        .filter(|s| s.token == token)
        .ok_or("书籍已关闭")?;
    if chapter >= s.view_chapters.len() || !fraction.is_finite() {
        return Err("无效的阅读位置".into());
    }
    let mut library = state.library.lock().map_err(|e| e.to_string())?;
    if !library.settings.remember_position {
        return Ok(());
    }
    let mut next = library.clone();
    let progress = Progress {
        chapter,
        fraction: fraction.clamp(0., 1.),
    };
    if let Some(id) = &s.part_id {
        let part = next
            .collections
            .get_mut(&s.id)
            .and_then(|c| c.parts.iter_mut().find(|p| &p.id == id))
            .ok_or("子书记录不存在")?;
        part.progress = progress;
    } else if let Some(recent) = next.recent.iter_mut().find(|r| r.id == s.id) {
        recent.progress = progress;
    }
    persist(state, &next)?;
    *library = next;
    Ok(())
}
#[tauri::command]
fn save_progress(
    state: tauri::State<ReaderState>,
    token: String,
    chapter: usize,
    fraction: f64,
) -> Result<(), String> {
    write_progress(&state, &token, chapter, fraction)
}
fn valid_name(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 64 || value.chars().any(char::is_control) {
        return Err("名称应为 1–64 个字符，不能包含控制字符".into());
    }
    Ok(value.to_string())
}
#[cfg(test)]
fn update_metadata(
    state: &ReaderState,
    source_id: &str,
    part_id: Option<&str>,
    group: String,
    tags: Vec<String>,
    favorite: bool,
) -> Result<(), String> {
    update_metadata_with_flags(
        state,
        source_id,
        part_id,
        group,
        tags,
        favorite,
        BookFlags::default(),
    )
}
fn update_metadata_with_flags(
    state: &ReaderState,
    source_id: &str,
    part_id: Option<&str>,
    group: String,
    tags: Vec<String>,
    favorite: bool,
    flags: BookFlags,
) -> Result<(), String> {
    let mut library = state.library.lock().map_err(|e| e.to_string())?;
    if !library.recent.iter().any(|r| r.id == source_id)
        || part_id.is_some_and(|id| {
            !library
                .collections
                .get(source_id)
                .is_some_and(|c| c.parts.iter().any(|p| p.id == id))
        })
    {
        return Err("书籍不存在".into());
    }
    let group = if group.trim().is_empty() {
        String::new()
    } else {
        valid_name(&group)?
    };
    let mut unique = HashSet::new();
    let mut clean = Vec::new();
    for tag in tags {
        let tag = valid_name(&tag)?;
        if unique.insert(tag.clone()) {
            clean.push(tag);
        }
    }
    if clean.len() > 30 {
        return Err("每本书最多 30 个标签".into());
    }
    let mut next = library.clone();
    if !group.is_empty() && !next.groups.contains(&group) {
        next.groups.push(group.clone());
    }
    let key = item_key(source_id, part_id);
    let mut previous = next.metadata.get(&key).cloned().unwrap_or_default();
    if let Some(pinned) = flags.pinned {
        previous.pinned = pinned;
    }
    if let Some(status) = flags.reading_status {
        previous.reading_status = Some(status);
    }
    next.metadata.insert(
        key,
        BookMeta {
            group,
            tags: clean,
            favorite,
            ..previous
        },
    );
    persist(state, &next)?;
    *library = next;
    Ok(())
}
#[tauri::command]
fn edit_metadata(
    state: tauri::State<ReaderState>,
    source_id: String,
    part_id: Option<String>,
    group: String,
    tags: Vec<String>,
    favorite: bool,
    flags: Option<BookFlags>,
) -> Result<(), String> {
    update_metadata_with_flags(
        &state,
        &source_id,
        part_id.as_deref(),
        group,
        tags,
        favorite,
        flags.unwrap_or_default(),
    )
}
#[tauri::command]
fn pin_book(
    state: tauri::State<ReaderState>,
    source_id: String,
    part_id: Option<String>,
    pinned: bool,
) -> Result<(), String> {
    let mut library = state.library.lock().map_err(|e| e.to_string())?;
    if !library.recent.iter().any(|r| r.id == source_id)
        || part_id.as_ref().is_some_and(|id| {
            !library
                .collections
                .get(&source_id)
                .is_some_and(|c| c.parts.iter().any(|p| &p.id == id))
        })
    {
        return Err("书籍不存在".into());
    }
    let mut next = library.clone();
    next.metadata
        .entry(item_key(&source_id, part_id.as_deref()))
        .or_default()
        .pinned = pinned;
    persist(&state, &next)?;
    *library = next;
    Ok(())
}
fn change_group(
    state: &ReaderState,
    action: &str,
    name: &str,
    new_name: Option<&str>,
) -> Result<(), String> {
    let name = valid_name(name)?;
    let mut library = state.library.lock().map_err(|e| e.to_string())?;
    let mut next = library.clone();
    match action {
        "create" => {
            if next.groups.contains(&name) {
                return Err("分组已存在".into());
            }
            next.groups.push(name);
        }
        "rename" | "delete" => {
            let index = next
                .groups
                .iter()
                .position(|g| g == &name)
                .ok_or("分组不存在")?;
            let replacement = if action == "delete" {
                String::new()
            } else {
                valid_name(new_name.ok_or("请输入新名称")?)?
            };
            if replacement != name && next.groups.contains(&replacement) {
                return Err("分组名称已存在".into());
            }
            if action == "delete" {
                next.groups.remove(index);
            } else {
                next.groups[index] = replacement.clone();
            }
            for meta in next.metadata.values_mut().filter(|m| m.group == name) {
                meta.group = replacement.clone();
            }
        }
        _ => return Err("不支持的分组操作".into()),
    }
    persist(state, &next)?;
    *library = next;
    Ok(())
}
#[tauri::command]
fn manage_group(
    state: tauri::State<ReaderState>,
    action: String,
    name: String,
    new_name: Option<String>,
) -> Result<(), String> {
    change_group(&state, &action, &name, new_name.as_deref())
}
#[tauri::command]
fn close_book(state: tauri::State<ReaderState>) {
    if let Ok(mut s) = state.session.lock() {
        *s = None;
    }
}
#[tauri::command]
fn frontend_ready() {
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
    if token == "cover" {
        return cover::resource(&state, path);
    }
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
                        .header(
                            "Cache-Control",
                            if request.uri().path().starts_with("/cover/") {
                                "private, max-age=300"
                            } else {
                                "no-store"
                            },
                        )
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
            frontend_ready,
            library_snapshot,
            scan::scan_directories,
            scan::set_scan_directories,
            scan::scan_library,
            book_info::book_info,
            reading_time::save_reading_time,
            library_directory::library_settings,
            library_directory::set_library_settings,
            set_collection,
            edit_metadata,
            pin_book,
            manage_group
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

#[cfg(test)]
mod library_tests {
    use super::*;
    fn state() -> (ReaderState, PathBuf) {
        let dir = std::env::temp_dir().join(format!("leaf-organize-{}", token()));
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
    fn logical_books_keep_independent_progress_metadata_and_reversible_mode() {
        let (state, dir) = state();
        let path = Path::new("../fixtures/anthology.epub");
        let root = open_path(&state, path).unwrap();
        write_progress(&state, &root.token, 1, 0.61).unwrap();
        let ids: Vec<_> = root
            .candidates
            .iter()
            .filter(|c| c.suggested)
            .map(|c| c.id.clone())
            .collect();
        let collection = configure_collection(&state, &root.token, true, &ids).unwrap();
        assert_eq!(collection.collection.parts.len(), 4);
        let first = collection.collection.parts[1].id.clone();
        let second = collection.collection.parts[2].id.clone();
        let a = open_scoped(&state, path, Some(&first)).unwrap();
        write_progress(&state, &a.token, 0, 0.42).unwrap();
        let b = open_scoped(&state, path, Some(&second)).unwrap();
        assert_eq!(b.progress.fraction, 0.);
        write_progress(&state, &b.token, 0, 0.8).unwrap();
        update_metadata(
            &state,
            &root.id,
            Some(&first),
            " 文学 ".into(),
            vec![" 待读 ".into(), "待读".into(), "随笔".into()],
            true,
        )
        .unwrap();
        change_group(&state, "rename", "文学", Some("中文文学")).unwrap();
        let meta =
            state.library.lock().unwrap().metadata[&item_key(&root.id, Some(&first))].clone();
        assert_eq!(meta.tags.len(), 2);
        assert_eq!(meta.group, "中文文学");
        assert!(meta.favorite);
        let whole = configure_collection(&state, &b.token, false, &[]).unwrap();
        assert!(!whole.collection.enabled);
        assert_eq!(whole.progress.chapter, 1);
        assert_eq!(whole.progress.fraction, 0.61);
        assert!(open_scoped(&state, path, Some(&first)).is_err());
        let restored = configure_collection(&state, &whole.token, true, &ids).unwrap();
        let a = open_scoped(&state, path, Some(&first)).unwrap();
        assert_eq!(a.progress.fraction, 0.42);
        assert!(a.metadata.favorite);
        assert_eq!(restored.collection.parts[2].progress.fraction, 0.8);
        let persisted: Library =
            serde_json::from_slice(&fs::read(&state.storage).unwrap()).unwrap();
        assert_eq!(persisted.collections[&root.id].parts.len(), 4);
        change_group(&state, "delete", "中文文学", None).unwrap();
        let snapshot = snapshot(&state.library.lock().unwrap());
        assert_eq!(snapshot.books.len(), 1);
        assert!(snapshot.books[0].part_metadata[&first].group.is_empty());
        assert!(snapshot.books[0].part_metadata[&first].favorite);
        drop(state);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn manual_status_and_pins_are_independent_and_survive_reopen() {
        let (state, dir) = state();
        let path = Path::new("../fixtures/anthology.epub");
        let root = open_path(&state, path).unwrap();
        assert!(root.metadata.reading_status == Some(ReadingStatus::Reading));
        update_metadata_with_flags(
            &state,
            &root.id,
            None,
            "文学".into(),
            vec!["待读".into()],
            true,
            BookFlags {
                pinned: Some(true),
                reading_status: Some(ReadingStatus::Unread),
            },
        )
        .unwrap();
        let reopened = open_path(&state, path).unwrap();
        assert!(reopened.metadata.reading_status == Some(ReadingStatus::Unread));
        assert!(reopened.metadata.pinned);
        // A favorite/tag edit cannot reset explicit classification or pinning.
        update_metadata(&state, &root.id, None, "文学".into(), vec![], false).unwrap();
        let reopened = open_path(&state, path).unwrap();
        assert!(reopened.metadata.pinned);
        assert!(reopened.metadata.reading_status == Some(ReadingStatus::Unread));
        let ids: Vec<_> = reopened
            .candidates
            .iter()
            .filter(|c| c.suggested)
            .map(|c| c.id.clone())
            .collect();
        let all = configure_collection(&state, &reopened.token, true, &ids).unwrap();
        let part = &all.collection.parts[1];
        update_metadata_with_flags(
            &state,
            &root.id,
            Some(&part.id),
            "".into(),
            vec![],
            false,
            BookFlags {
                pinned: Some(false),
                reading_status: Some(ReadingStatus::Finished),
            },
        )
        .unwrap();
        let child = open_scoped(&state, path, Some(&part.id)).unwrap();
        assert!(child.metadata.reading_status == Some(ReadingStatus::Finished));
        assert!(!child.metadata.pinned);
        let saved: Library = serde_json::from_slice(&fs::read(&state.storage).unwrap()).unwrap();
        assert!(saved.metadata[&root.id].pinned);
        assert!(saved.metadata[&root.id].reading_status == Some(ReadingStatus::Unread));
        assert!(serde_json::from_str::<BookFlags>(r#"{"reading_status":"invalid"}"#).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn legacy_records_load_and_library_no_longer_evicts_books_after_24() {
        let legacy = r#"{"recent":[{"id":"old","path":"/missing.epub","title":"旧书","author":"作者","chapters":2,"progress":{"chapter":1,"fraction":0.3},"opened":1700000000}]}"#;
        let old: Library = serde_json::from_str(legacy).unwrap();
        assert_eq!(old.recent[0].progress.fraction, 0.3);
        assert!(old.collections.is_empty());
        assert!(old.metadata.is_empty());
        let (state, dir) = state();
        *state.library.lock().unwrap() = old;
        for i in 0..25 {
            let file = dir.join(format!("book{i}.epub"));
            fs::copy("../fixtures/quiet-days.epub", &file).unwrap();
            open_path(&state, &file).unwrap();
        }
        assert_eq!(state.library.lock().unwrap().recent.len(), 26);
        assert!(state
            .library
            .lock()
            .unwrap()
            .recent
            .iter()
            .any(|r| r.id == "old"));
        drop(state);
        fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod browser_fixtures {
    use super::*;
    #[test]
    #[ignore = "Regenerate browser catalog with LEAF_EXPORT_FIXTURES"]
    fn native_scope_contract_for_browser_tests() {
        let Some(output) = std::env::var_os("LEAF_EXPORT_FIXTURES") else {
            return;
        };
        let dir = std::env::temp_dir().join(format!("leaf-fixture-export-{}", token()));
        fs::create_dir_all(&dir).unwrap();
        let state = ReaderState {
            session: Mutex::new(None),
            library: Mutex::new(Library::default()),
            storage: dir.join("library.json"),
        };
        let sample = open_path(&state, Path::new("../fixtures/quiet-days.epub")).unwrap();
        let path = Path::new("../fixtures/anthology.epub");
        let root = open_path(&state, path).unwrap();
        let ids: Vec<_> = root
            .candidates
            .iter()
            .filter(|c| c.suggested)
            .map(|c| c.id.clone())
            .collect();
        let enabled = configure_collection(&state, &root.token, true, &ids).unwrap();
        let mut parts = serde_json::Map::new();
        for p in &enabled.collection.parts {
            let opened = open_scoped(&state, path, Some(&p.id)).unwrap();
            parts.insert(p.id.clone(), serde_json::to_value(opened).unwrap());
        }
        fs::write(output,serde_json::to_vec_pretty(&serde_json::json!({"sample":sample,"anthology":root,"collection":enabled,"parts":parts})).unwrap()).unwrap();
        drop(state);
        fs::remove_dir_all(dir).unwrap();
    }
}
