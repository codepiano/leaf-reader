use super::*;
use std::{
    io::{Read, Seek, SeekFrom},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const MAX_FILE: u64 = 256 * 1024 * 1024;
const MAX_TEXT: u32 = 64 * 1024 * 1024;
const MAX_HEADER: u64 = 2 * 1024 * 1024;
const FORMAT_ERROR: &str = "无效或不支持的 MOBI / AZW3 文件";

fn be16(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_be_bytes(
        bytes.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

fn be32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn decode(bytes: &[u8], encoding: u32) -> String {
    if encoding == 1252 {
        const CP1252: [char; 32] = [
            '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž',
            '\u{8f}', '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ',
            '\u{9d}', 'ž', 'Ÿ',
        ];
        bytes
            .iter()
            .map(|&byte| match byte {
                0x80..=0x9f => CP1252[(byte - 0x80) as usize],
                _ => char::from(byte),
            })
            .collect()
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

fn clean(bytes: &[u8], encoding: u32) -> String {
    decode(bytes, encoding)
        .trim_matches(|c: char| c.is_whitespace() || c == '\0')
        .to_string()
}

/// Read only the Palm database directory and the metadata record. Scanning does not
/// start a converter or decompress any part of the book.
pub fn inspect(path: &Path) -> Result<(String, String, usize), String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let file_size = file.metadata().map_err(|e| e.to_string())?.len();
    if file_size > MAX_FILE {
        return Err("MOBI / AZW3 超过 256 MB".into());
    }
    let mut pdb = [0; 78];
    file.read_exact(&mut pdb).map_err(|_| FORMAT_ERROR)?;
    if &pdb[60..68] != b"BOOKMOBI" {
        return Err(FORMAT_ERROR.into());
    }
    // PalmDB starts with a 78-byte header followed by 8-byte record descriptors.
    let records = be16(&pdb, 76).ok_or(FORMAT_ERROR)?;
    if records < 2 {
        return Err(FORMAT_ERROR.into());
    }
    let mut offsets = [0; 12];
    file.read_exact(&mut offsets).map_err(|_| FORMAT_ERROR)?;
    let start = u64::from(be32(&offsets, 0).ok_or(FORMAT_ERROR)?);
    let end = u64::from(be32(&offsets, 8).ok_or(FORMAT_ERROR)?);
    if start < 78 + 8 * u64::from(records)
        || end > file_size
        || end <= start
        || end - start > MAX_HEADER
    {
        return Err(FORMAT_ERROR.into());
    }
    let mut record = vec![0; (end - start) as usize];
    file.seek(SeekFrom::Start(start))
        .map_err(|e| e.to_string())?;
    file.read_exact(&mut record).map_err(|_| FORMAT_ERROR)?;
    // Record zero starts with a 16-byte PalmDOC header, then MOBI and optional EXTH.
    if record.get(16..20) != Some(b"MOBI") {
        return Err(FORMAT_ERROR.into());
    }
    if be16(&record, 12) != Some(0) {
        return Err("这本书包含 DRM 加密，暂不支持".into());
    }
    if !matches!(be32(&record, 4), Some(1..=MAX_TEXT)) {
        return Err("MOBI / AZW3 正文为空或超过 64 MB".into());
    }
    let header_len = be32(&record, 20).ok_or(FORMAT_ERROR)? as usize;
    let encoding = be32(&record, 28).ok_or(FORMAT_ERROR)?;
    if header_len < 24 || header_len > record.len() - 16 {
        return Err(FORMAT_ERROR.into());
    }
    let mut title = String::new();
    let mut authors = Vec::new();
    if let Some(exth) = record
        .get(16 + header_len..)
        .filter(|b| b.starts_with(b"EXTH"))
    {
        let length = be32(exth, 4).ok_or(FORMAT_ERROR)? as usize;
        let count = be32(exth, 8).ok_or(FORMAT_ERROR)?;
        let mut fields = exth.get(12..length).ok_or(FORMAT_ERROR)?;
        for _ in 0..count {
            let tag = be32(fields, 0).ok_or(FORMAT_ERROR)?;
            let size = be32(fields, 4).ok_or(FORMAT_ERROR)? as usize;
            let value = fields.get(8..size).ok_or(FORMAT_ERROR)?;
            if tag == 503 && title.is_empty() {
                title = clean(value, encoding);
            }
            if tag == 100 {
                let author = clean(value, encoding);
                if !author.is_empty() {
                    authors.push(author);
                }
            }
            fields = &fields[size..];
        }
    }
    if title.is_empty() {
        if let (Some(offset), Some(length)) = (be32(&record, 84), be32(&record, 88)) {
            let offset = offset as usize;
            if let Some(raw_title) = offset
                .checked_add(length as usize)
                .and_then(|end| record.get(offset..end))
            {
                title = clean(raw_title, encoding);
            }
        }
    }
    if title.is_empty() {
        title = pdf::title(path);
    }
    Ok((title, authors.join(" / "), 0))
}

fn helper() -> Result<PathBuf, String> {
    #[cfg(test)]
    {
        Ok(PathBuf::from(env!("LEAF_TEST_MOBITOOL")))
    }
    #[cfg(not(test))]
    {
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        let directory = executable.parent().ok_or("无法定位 Kindle 阅读组件")?;
        Ok(directory.join(format!("leaf-mobitool{}", std::env::consts::EXE_SUFFIX)))
    }
}

pub fn open(path: &Path) -> Result<(Book, tempfile::TempDir), String> {
    let (title, author, _) = inspect(path)?;
    let temporary = tempfile::Builder::new()
        .prefix("leaf-kindle-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    let input = temporary.path().join("book.mobi");
    // The converter sees a fixed basename and only reads this staged source.
    if fs::hard_link(path, &input).is_err() {
        fs::copy(path, &input).map_err(|e| format!("无法暂存 Kindle 文件：{e}"))?;
    }
    let mut command = Command::new(helper()?);
    command
        .args(["-e", "-o"])
        .arg(temporary.path())
        .arg(&input)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动 Kindle 阅读组件：{e}"))?;
    let deadline = Instant::now() + Duration::from_secs(45);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => return Err("无法解析此 MOBI / AZW3 的正文".into()),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("读取 MOBI / AZW3 超时或解析进程异常".into());
            }
        }
    }
    fs::remove_file(&input).map_err(|e| e.to_string())?;
    let mut book = Book::open(&temporary.path().join("book.epub"))
        .map_err(|e| format!("无法打开 MOBI / AZW3 的正文：{e}"))?;
    book.title = title;
    book.author = author;
    Ok((book, temporary))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kindle_formats_scan_open_resolve_toc_and_resume_from_original_path() {
        let fixture_dir = tempfile::tempdir().unwrap();
        let paths = [
            (
                "old.MOBI",
                include_bytes!("../../fixtures/kindle-sample.mobi").as_slice(),
            ),
            (
                "new.azw3",
                include_bytes!("../../fixtures/kindle-sample.azw3").as_slice(),
            ),
        ]
        .map(|(name, data)| {
            let path = fixture_dir.path().join(name);
            fs::write(&path, data).unwrap();
            path.canonicalize().unwrap()
        });
        let records = tempfile::tempdir().unwrap();
        let storage = records.path().join("library.json");
        let state = ReaderState {
            session: Mutex::new(None),
            storage: storage.clone(),
            library: Mutex::new(Library::default()),
        };
        scan::configure(
            &state,
            vec![paths[0].parent().unwrap().to_string_lossy().into()],
        )
        .unwrap();
        scan::scan(&state).unwrap();
        {
            let library = state.library.lock().unwrap();
            assert_eq!(library.recent.len(), 2);
            assert!(library
                .recent
                .iter()
                .all(|record| record.title == "libmobi ncx test" && record.opened == 0));
        }
        for (path, expected_chapter) in paths.iter().zip([0, 1]) {
            let opened = open_path(&state, path).unwrap();
            assert_eq!(opened.path, path.to_string_lossy());
            assert!(opened.candidates.is_empty());
            let target = epub::walk_toc(&opened.toc)
                .into_iter()
                .find(|item| item.title == "Test chapter 2")
                .unwrap();
            assert_eq!(target.chapter, Some(expected_chapter));
            let mut active = state.session.lock().unwrap();
            let session = active.as_mut().unwrap();
            let html = read_chapter(session, expected_chapter).unwrap();
            assert!(html.contains("Test chapter 2"));
            if !target.fragment.is_empty() {
                assert!(
                    html.contains(&format!("id=\"{}\"", target.fragment)),
                    "{html}"
                );
            }
            let SessionBook::Kindle { _temporary, .. } = &session.book else {
                panic!("expected Kindle session")
            };
            let cache_path = _temporary.path().to_owned();
            assert!(cache_path.join("book.epub").is_file());
            drop(active);
            write_progress(&state, &opened.token, expected_chapter, 0.63).unwrap();
            *state.session.lock().unwrap() = None;
            assert!(!cache_path.exists());
        }
        let restored = ReaderState {
            session: Mutex::new(None),
            library: Mutex::new(serde_json::from_slice(&fs::read(&storage).unwrap()).unwrap()),
            storage,
        };
        for (path, expected_chapter) in paths.iter().zip([0, 1]) {
            let opened = open_path(&restored, path).unwrap();
            assert_eq!(opened.progress.chapter, expected_chapter);
            assert_eq!(opened.progress.fraction, 0.63);
        }
        scan::scan(&restored).unwrap();
        assert_eq!(restored.library.lock().unwrap().recent.len(), 2);
    }

    #[test]
    fn rejects_encrypted_and_invalid_headers_before_conversion() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("encrypted.mobi");
        let mut data = include_bytes!("../../fixtures/kindle-sample.mobi").to_vec();
        let start = be32(&data, 78).unwrap() as usize;
        data[start + 13] = 2;
        fs::write(&path, data).unwrap();
        assert!(inspect(&path).unwrap_err().contains("DRM"));

        fs::write(&path, b"not a Kindle book").unwrap();
        assert_eq!(inspect(&path).unwrap_err(), FORMAT_ERROR);
    }
}
