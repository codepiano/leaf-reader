use super::*;
use std::io::{Read, Seek, SeekFrom};

pub fn is_pdf(path: &Path) -> bool {
    has_extension(path, "pdf")
}

pub fn is_supported(path: &Path) -> bool {
    is_pdf(path) || has_extension(path, "epub")
}

fn has_extension(path: &Path, extension: &str) -> bool {
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case(extension))
}

pub fn title(path: &Path) -> String {
    path.file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

pub struct Pdf {
    file: fs::File,
    pub size: u64,
    pub pages: usize,
}

impl Pdf {
    pub fn open(path: &Path) -> Result<Self, String> {
        let mut file = fs::File::open(path).map_err(|e| format!("无法打开 PDF：{e}"))?;
        let metadata = file.metadata().map_err(|e| e.to_string())?;
        if !metadata.is_file() {
            return Err("请选择 PDF 文件".into());
        }
        let mut header = [0; 1024];
        let count = metadata.len().min(header.len() as u64) as usize;
        file.read_exact(&mut header[..count])
            .map_err(|e| format!("无法读取 PDF：{e}"))?;
        if !header[..count].windows(5).any(|b| b == b"%PDF-") {
            return Err("文件没有有效的 PDF 文件头".into());
        }
        Ok(Self {
            file,
            size: metadata.len(),
            pages: 0,
        })
    }

    fn read(&mut self, start: u64, end: u64) -> Result<Vec<u8>, String> {
        if start >= end || end > self.size || end - start > 1024 * 1024 {
            return Err("无效的 PDF 读取范围".into());
        }
        let mut bytes = vec![0; (end - start) as usize];
        self.file
            .seek(SeekFrom::Start(start))
            .and_then(|_| self.file.read_exact(&mut bytes))
            .map_err(|e| format!("无法读取 PDF：{e}"))?;
        Ok(bytes)
    }
}

#[tauri::command]
pub async fn read_pdf_range(
    app: tauri::AppHandle,
    token: String,
    start: u64,
    end: u64,
) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ReaderState>();
        let mut active = state.session.lock().map_err(|e| e.to_string())?;
        let pdf = active
            .as_mut()
            .filter(|s| s.token == token)
            .and_then(|s| match &mut s.book {
                SessionBook::Pdf(pdf) => Some(pdf),
                SessionBook::Epub(_) => None,
            })
            .ok_or("PDF 已关闭")?;
        pdf.read(start, end).map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn set_pdf_pages(
    state: tauri::State<ReaderState>,
    token: String,
    pages: usize,
) -> Result<(), String> {
    record_pages(&state, &token, pages)
}

fn record_pages(state: &ReaderState, token: &str, pages: usize) -> Result<(), String> {
    if pages == 0 {
        return Err("PDF 没有可读取的页面".into());
    }
    let mut active = state.session.lock().map_err(|e| e.to_string())?;
    let session = active
        .as_mut()
        .filter(|s| s.token == token)
        .ok_or("PDF 已关闭")?;
    let SessionBook::Pdf(pdf) = &mut session.book else {
        return Err("当前书籍不是 PDF".into());
    };
    let mut library = state.library.lock().map_err(|e| e.to_string())?;
    let mut next = library.clone();
    let record = next
        .recent
        .iter_mut()
        .find(|r| r.id == session.id)
        .ok_or("书籍记录不存在")?;
    record.chapters = pages;
    record.opened = now();
    next.hidden_books.remove(&session.id);
    if record.progress.chapter >= pages {
        record.progress.chapter = pages - 1;
        record.progress.book_fraction = Some(1.);
    }
    next.metadata
        .entry(session.id.clone())
        .or_default()
        .reading_status
        .get_or_insert(ReadingStatus::Reading);
    persist(state, &next)?;
    *library = next;
    pdf.pages = pages;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_then_resume_pdf_preserves_page_and_leaves_source_untouched() {
        let dir = std::env::temp_dir().join(format!("leaf-pdf-test-{}", token()));
        let source = dir.join("source");
        fs::create_dir_all(&source).unwrap();
        let path = source.join("样本.PDF");
        let bytes = include_bytes!("../../fixtures/paged-sample.pdf");
        fs::write(&path, bytes).unwrap();
        let invalid = source.join("not-a-book.pdf");
        fs::write(&invalid, b"not a PDF").unwrap();

        let storage = dir.join("library.json");
        let state = ReaderState {
            session: Mutex::new(None),
            library: Mutex::new(Library::default()),
            storage: storage.clone(),
        };
        scan::configure(&state, vec![source.to_string_lossy().into_owned()]).unwrap();
        scan::scan(&state).unwrap();
        {
            let library = state.library.lock().unwrap();
            assert_eq!(library.recent.len(), 1);
            assert_eq!(library.recent[0].title, "样本");
            assert_eq!(library.recent[0].opened, 0);
        }

        let opened = open_path(&state, &path).unwrap();
        assert_eq!(opened.pdf_size, Some(bytes.len() as u64));
        assert!(open_path(&state, &invalid).is_err());
        {
            let mut session = state.session.lock().unwrap();
            let SessionBook::Pdf(pdf) = &mut session.as_mut().unwrap().book else {
                panic!("expected PDF session");
            };
            assert_eq!(pdf.read(0, 5).unwrap(), b"%PDF-");
            assert!(pdf.read(0, pdf.size + 1).is_err());
        }
        record_pages(&state, &opened.token, 3).unwrap();
        assert!(write_progress(&state, &opened.token, 3, 1.).is_err());
        write_progress(&state, &opened.token, 1, 1.).unwrap();
        scan::scan(&state).unwrap();

        let library: Library = serde_json::from_slice(&fs::read(&storage).unwrap()).unwrap();
        assert_eq!(library.recent[0].chapters, 3);
        assert_eq!(library.recent[0].progress.book_fraction, Some(2. / 3.));
        let reopened = ReaderState {
            session: Mutex::new(None),
            library: Mutex::new(library),
            storage,
        };
        assert_eq!(open_path(&reopened, &path).unwrap().progress.chapter, 1);
        assert_eq!(fs::read(&path).unwrap(), bytes);
        fs::remove_dir_all(dir).unwrap();
    }
}
