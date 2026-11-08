use super::*;
use zip::ZipArchive;
const LIMIT: u64 = 8 * 1024 * 1024;
fn xml(archive: &mut ZipArchive<fs::File>, path: &str) -> Result<String, String> {
    String::from_utf8(epub::read(archive, path, 4 * 1024 * 1024)?).map_err(|e| e.to_string())
}
fn doc(text: &str) -> Result<roxmltree::Document<'_>, String> {
    roxmltree::Document::parse_with_options(
        text,
        roxmltree::ParsingOptions {
            allow_dtd: true,
            nodes_limit: 100_000,
        },
    )
    .map_err(|e| e.to_string())
}
fn picture(
    archive: &mut ZipArchive<fs::File>,
    path: &str,
    depth: u8,
) -> Result<(Vec<u8>, &'static str), String> {
    let bytes = epub::read(archive, path, LIMIT)?;
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(&[255, 216, 255]) {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else {
        let text = std::str::from_utf8(&bytes).map_err(|_| "不支持的封面图片")?;
        let document = doc(text)?;
        let vector = document.root_element().has_tag_name("svg");
        if depth == 0 && vector {
            return Ok((bytes, "image/svg+xml"));
        }
        if depth == 0 {
            return Err("封面不是图片".into());
        }
        for node in document
            .descendants()
            .filter(|n| n.has_tag_name("img") || n.has_tag_name("image"))
            .take(6)
        {
            let href = node.attribute("src").or_else(|| {
                node.attributes()
                    .find(|a| a.name() == "href")
                    .map(|a| a.value())
            });
            if let Some(href) = href {
                if let Ok(target) = epub::resolve(path, href) {
                    if let Ok(image) = picture(archive, &target, depth - 1) {
                        return Ok(image);
                    }
                }
            }
        }
        if vector && !document.descendants().any(|n| n.has_tag_name("image")) {
            return Ok((bytes, "image/svg+xml"));
        }
        return Err("没有内嵌封面图片".into());
    };
    Ok((bytes, mime))
}
pub fn extract(path: &Path) -> Result<(Vec<u8>, &'static str), String> {
    let mut archive = ZipArchive::new(fs::File::open(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if archive.len() > 20_000 {
        return Err("书内文件过多".into());
    }
    let container = xml(&mut archive, "META-INF/container.xml")?;
    let container = doc(&container)?;
    let package = container
        .descendants()
        .find(|n| n.has_tag_name("rootfile"))
        .and_then(|n| n.attribute("full-path"))
        .ok_or("没有书籍清单")?;
    let package = epub::resolve("", package)?;
    let opf = xml(&mut archive, &package)?;
    let opf = doc(&opf)?;
    let items: Vec<_> = opf
        .descendants()
        .filter(|n| n.has_tag_name("item"))
        .collect();
    let mut candidates = Vec::new();
    for item in &items {
        if item
            .attribute("properties")
            .unwrap_or("")
            .split_whitespace()
            .any(|p| p == "cover-image")
        {
            if let Some(href) = item.attribute("href") {
                candidates.push(href);
            }
        }
    }
    for meta in opf
        .descendants()
        .filter(|n| n.has_tag_name("meta") && n.attribute("name") == Some("cover"))
    {
        if let Some(id) = meta.attribute("content") {
            if let Some(item) = items.iter().find(|n| n.attribute("id") == Some(id)) {
                if let Some(href) = item.attribute("href") {
                    candidates.push(href);
                }
            }
        }
    }
    for node in opf
        .descendants()
        .filter(|n| n.has_tag_name("reference") && n.attribute("type") == Some("cover"))
    {
        if let Some(href) = node.attribute("href") {
            candidates.push(href);
        }
    }
    for item in &items {
        if matches!(item.attribute("id"), Some("cover" | "cover-image")) {
            if let Some(href) = item.attribute("href") {
                candidates.push(href);
            }
        }
    }
    for href in candidates.into_iter().take(12) {
        if let Ok(path) = epub::resolve(&package, href) {
            if let Ok(image) = picture(&mut archive, &path, 2) {
                return Ok(image);
            }
        }
    }
    Err("这本书没有可用的内嵌封面".into())
}
pub fn resource(state: &ReaderState, id: &str) -> Result<(Vec<u8>, &'static str), String> {
    let path = state
        .library
        .lock()
        .map_err(|e| e.to_string())?
        .recent
        .iter()
        .find(|r| r.id == id)
        .map(|r| r.path.clone())
        .ok_or("书籍不存在")?;
    extract(Path::new(&path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn fixture(metadata: &str, manifest: &str, guide: &str, image: &[u8]) -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "leaf-cover-{}-{}-{}.epub",
            std::process::id(),
            token(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let mut writer = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        let opf = format!("<package><metadata>{metadata}</metadata><manifest>{manifest}</manifest>{guide}</package>");
        for (name, bytes) in [
            (
                "META-INF/container.xml",
                b"<container><rootfile full-path='OPS/package.opf'/></container>".as_slice(),
            ),
            ("OPS/package.opf", opf.as_bytes()),
            ("OPS/Images/cover art.svg", image),
            (
                "OPS/Text/cover.xhtml",
                b"<html><body><svg><image href='../Images/cover%20art.svg'/></svg></body></html>"
                    .as_slice(),
            ),
        ] {
            writer
                .start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
        path
    }
    #[test]
    fn epub3_epub2_and_guide_covers_resolve_without_mutating_books() {
        let svg = b"<svg xmlns='http://www.w3.org/2000/svg' width='200' height='300'><rect width='200' height='300' fill='green'/></svg>";
        let item = "<item id='art' href='Images/cover%20art.svg' media-type='image/svg+xml' properties='cover-image'/>";
        for (meta, manifest, guide) in [
            ("", item, ""),
            (
                "<meta name='cover' content='art'/>",
                "<item id='art' href='Images/cover%20art.svg' media-type='image/svg+xml'/>",
                "",
            ),
            (
                "",
                "",
                "<guide><reference type='cover' href='Text/cover.xhtml'/></guide>",
            ),
        ] {
            let path = fixture(meta, manifest, guide, svg);
            let before = fs::read(&path).unwrap();
            let (bytes, mime) = extract(&path).unwrap();
            assert_eq!(bytes, svg);
            assert_eq!(mime, "image/svg+xml");
            assert_eq!(fs::read(&path).unwrap(), before);
            fs::remove_file(path).unwrap();
        }
    }
    #[test]
    fn missing_invalid_oversized_and_external_cover_candidates_fail_safely() {
        for (item, image) in [
            ("", b"bad".as_slice()),
            (
                "<item id='cover' href='https://outside.invalid/a.svg'/>",
                b"bad".as_slice(),
            ),
            (
                "<item id='cover' href='../../outside.svg'/>",
                b"bad".as_slice(),
            ),
            (
                "<item id='cover' href='Images/cover%20art.svg'/>",
                b"<html><script>bad()</script></html>".as_slice(),
            ),
        ] {
            let path = fixture("", item, "", image);
            assert!(extract(&path).is_err());
            fs::remove_file(path).unwrap();
        }
        let large = vec![0; LIMIT as usize + 1];
        let path = fixture(
            "",
            "<item id='cover' href='Images/cover%20art.svg'/>",
            "",
            &large,
        );
        assert!(extract(&path).is_err());
        fs::remove_file(path).unwrap();
    }
}
