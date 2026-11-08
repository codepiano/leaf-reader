use percent_encoding::percent_decode_str;
use roxmltree::Document;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs::File, io::Read, path::Path};
use zip::ZipArchive;

const XML_LIMIT: u64 = 4 * 1024 * 1024;
pub const RESOURCE_LIMIT: u64 = 32 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Chapter {
    pub title: String,
    pub path: String,
    #[serde(default)]
    pub start_fragment: String,
    #[serde(default)]
    pub end_fragment: String,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct TocEntry {
    pub title: String,
    pub id: String,
    pub chapter: Option<usize>,
    pub fragment: String,
    pub children: Vec<TocEntry>,
}

pub struct Book {
    pub archive: ZipArchive<File>,
    pub title: String,
    pub author: String,
    pub chapters: Vec<Chapter>,
    pub toc: Vec<TocEntry>,
}

// EPUB hrefs are URI references, never filesystem paths. Reject escape above archive root.
pub fn resolve(base: &str, href: &str) -> Result<String, String> {
    let href = href.split(['#', '?']).next().unwrap_or("");
    let decoded = percent_decode_str(href)
        .decode_utf8()
        .map_err(|_| "无效的资源路径")?;
    if decoded.contains([':', '\\', '\0']) || decoded.starts_with('/') {
        return Err("不支持外部或绝对资源路径".into());
    }
    let prefix = base.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
    let joined = if decoded.is_empty() {
        base.to_string()
    } else if prefix.is_empty() {
        decoded.to_string()
    } else {
        format!("{prefix}/{decoded}")
    };
    let mut parts = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop().ok_or("资源路径超出 EPUB 范围")?;
            }
            p => parts.push(p),
        }
    }
    Ok(parts.join("/"))
}

pub fn read(archive: &mut ZipArchive<File>, path: &str, limit: u64) -> Result<Vec<u8>, String> {
    let file = archive
        .by_name(path)
        .map_err(|_| format!("书内资源不存在：{path}"))?;
    if file.size() > limit {
        return Err(format!("资源过大，超过 {} MB 限制", limit / 1024 / 1024));
    }
    let mut bytes = Vec::with_capacity(file.size() as usize);
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("资源超过安全大小限制".into());
    }
    Ok(bytes)
}
fn xml(archive: &mut ZipArchive<File>, path: &str) -> Result<String, String> {
    String::from_utf8(read(archive, path, XML_LIMIT)?)
        .map_err(|_| "书籍元数据不是 UTF-8 编码".into())
}
fn text(node: roxmltree::Node<'_, '_>) -> String {
    node.descendants()
        .filter(|n| n.is_text())
        .filter_map(|n| n.text())
        .collect::<Vec<_>>()
        .join("")
        .trim()
        .to_string()
}
fn parse_xml(source: &str) -> Result<Document<'_>, roxmltree::Error> {
    Document::parse_with_options(
        source,
        roxmltree::ParsingOptions {
            allow_dtd: true,
            nodes_limit: 100_000,
        },
    )
}
fn words(value: &str, word: &str) -> bool {
    value.split_whitespace().any(|v| v == word)
}

impl Book {
    pub fn open(path: &Path) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| format!("无法打开文件：{e}"))?;
        let mut archive =
            ZipArchive::new(file).map_err(|_| "文件不是有效的 EPUB / ZIP".to_string())?;
        if archive.len() > 20_000 {
            return Err("书内文件过多（最多 20,000 个）".into());
        }
        if archive.by_name("META-INF/encryption.xml").is_ok() {
            // Font obfuscation is allowed; DRM-protected content is not.
            let encryption = xml(&mut archive, "META-INF/encryption.xml")?;
            let doc = parse_xml(&encryption).map_err(|e| e.to_string())?;
            if doc
                .descendants()
                .filter(|n| n.has_tag_name("EncryptionMethod"))
                .any(|n| {
                    !matches!(
                        n.attribute("Algorithm"),
                        Some(
                            "http://www.idpf.org/2008/embedding" | "http://ns.adobe.com/pdf/enc#RC"
                        )
                    )
                })
            {
                return Err("这本书包含 DRM 加密，暂不支持".into());
            }
        }
        let container = xml(&mut archive, "META-INF/container.xml")?;
        let container_doc = parse_xml(&container).map_err(|e| format!("EPUB 容器损坏：{e}"))?;
        let package = container_doc
            .descendants()
            .find(|n| n.has_tag_name("rootfile"))
            .and_then(|n| n.attribute("full-path"))
            .ok_or("找不到书籍清单")?;
        let package = resolve("", package)?;
        let opf = xml(&mut archive, &package)?;
        let doc = parse_xml(&opf).map_err(|e| format!("EPUB 清单损坏：{e}"))?;
        let title = doc
            .descendants()
            .find(|n| n.has_tag_name("title"))
            .map(text)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                path.file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into()
            });
        let author = doc
            .descendants()
            .filter(|n| n.has_tag_name("creator"))
            .map(text)
            .collect::<Vec<_>>()
            .join(" / ");
        let mut manifest = HashMap::new();
        let mut nav_path = None;
        let mut ncx_path = None;
        for item in doc.descendants().filter(|n| n.has_tag_name("item")) {
            let (Some(id), Some(href)) = (item.attribute("id"), item.attribute("href")) else {
                continue;
            };
            let entry = resolve(&package, href)?;
            if words(item.attribute("properties").unwrap_or(""), "nav") {
                nav_path = Some(entry.clone());
            }
            if item.attribute("media-type") == Some("application/x-dtbncx+xml") {
                ncx_path = Some(entry.clone());
            }
            manifest.insert(
                id.to_string(),
                (
                    entry,
                    item.attribute("media-type").unwrap_or("").to_string(),
                ),
            );
        }
        let mut chapters = Vec::new();
        for item in doc
            .descendants()
            .filter(|n| n.has_tag_name("itemref") && n.attribute("linear") != Some("no"))
        {
            let id = item.attribute("idref").ok_or("章节缺少引用")?;
            let (path, media) = manifest.get(id).ok_or("章节引用的资源不存在")?;
            if !matches!(media.as_str(), "application/xhtml+xml" | "text/html") {
                continue;
            }
            chapters.push(Chapter {
                title: format!("第 {} 节", chapters.len() + 1),
                path: path.clone(),
                start_fragment: String::new(),
                end_fragment: String::new(),
            });
        }
        if chapters.is_empty() {
            return Err("这本 EPUB 没有可阅读的章节".into());
        }
        let mut toc = Vec::new();
        if let Some(nav) = nav_path {
            if let Ok(source) = xml(&mut archive, &nav) {
                if let Ok(nav_doc) = parse_xml(&source) {
                    let root = nav_doc.descendants().find(|n| {
                        n.has_tag_name("nav")
                            && (n
                                .attributes()
                                .any(|a| a.name() == "type" && words(a.value(), "toc"))
                                || n.attribute("role") == Some("doc-toc"))
                    });
                    if let Some(root) = root {
                        if let Some(list) = root.children().find(|n| n.has_tag_name("ol")) {
                            toc = nav_list(list, &chapters, &nav, "toc", 0)?;
                        }
                    }
                }
            }
        }
        if toc.is_empty() {
            if let Some(ncx) = ncx_path {
                if let Ok(source) = xml(&mut archive, &ncx) {
                    if let Ok(ncx_doc) = parse_xml(&source) {
                        if let Some(map) = ncx_doc.descendants().find(|n| n.has_tag_name("navMap"))
                        {
                            toc = ncx_list(map, &chapters, &ncx, "toc", 0)?;
                        }
                    }
                }
            }
        }
        for (index, chapter) in chapters.iter_mut().enumerate() {
            if let Some(entry) = walk_toc(&toc)
                .into_iter()
                .find(|entry| entry.chapter == Some(index))
            {
                chapter.title = entry.title.clone();
            }
        }
        if toc.is_empty() {
            toc = chapters
                .iter()
                .enumerate()
                .map(|(chapter, c)| TocEntry {
                    title: c.title.clone(),
                    id: format!("spine-{chapter}"),
                    chapter: Some(chapter),
                    fragment: String::new(),
                    children: Vec::new(),
                })
                .collect();
        }
        Ok(Self {
            archive,
            title,
            author,
            chapters,
            toc,
        })
    }
}
fn target(chapters: &[Chapter], base: &str, href: Option<&str>) -> (Option<usize>, String) {
    let Some(href) = href else {
        return (None, String::new());
    };
    let Ok(path) = resolve(base, href) else {
        return (None, String::new());
    };
    let chapter = chapters.iter().position(|c| c.path == path);
    let fragment = href
        .split_once('#')
        .map(|(_, f)| percent_decode_str(f).decode_utf8_lossy().into_owned())
        .unwrap_or_default();
    (chapter, fragment)
}
fn nav_list(
    list: roxmltree::Node<'_, '_>,
    chapters: &[Chapter],
    base: &str,
    prefix: &str,
    depth: usize,
) -> Result<Vec<TocEntry>, String> {
    if depth > 64 {
        return Err("目录嵌套超过 64 层".into());
    }
    list.children()
        .filter(|n| n.has_tag_name("li"))
        .enumerate()
        .map(|(i, li)| {
            let id = format!("{prefix}-{i}");
            let label = li.descendants().find(|n| {
                (n.has_tag_name("a") || n.has_tag_name("span"))
                    && n.ancestors().find(|a| a.has_tag_name("li")) == Some(li)
            });
            let title = label
                .map(text)
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| {
                    li.children()
                        .filter(|n| n.is_text())
                        .filter_map(|n| n.text())
                        .collect::<String>()
                        .trim()
                        .to_string()
                });
            let (chapter, fragment) =
                target(chapters, base, label.and_then(|n| n.attribute("href")));
            let children = match li.children().find(|n| n.has_tag_name("ol")) {
                Some(n) => nav_list(n, chapters, base, &id, depth + 1)?,
                None => Vec::new(),
            };
            Ok(TocEntry {
                id,
                title: if title.is_empty() {
                    "未命名分组".into()
                } else {
                    title
                },
                chapter,
                fragment,
                children,
            })
        })
        .collect()
}
fn ncx_list(
    list: roxmltree::Node<'_, '_>,
    chapters: &[Chapter],
    base: &str,
    prefix: &str,
    depth: usize,
) -> Result<Vec<TocEntry>, String> {
    if depth > 64 {
        return Err("目录嵌套超过 64 层".into());
    }
    list.children()
        .filter(|n| n.has_tag_name("navPoint"))
        .enumerate()
        .map(|(i, point)| {
            let id = format!("{prefix}-{i}");
            let title = point
                .children()
                .find(|n| n.has_tag_name("navLabel"))
                .map(text)
                .unwrap_or_else(|| "未命名分组".into());
            let href = point
                .children()
                .find(|n| n.has_tag_name("content"))
                .and_then(|n| n.attribute("src"));
            let (chapter, fragment) = target(chapters, base, href);
            Ok(TocEntry {
                children: ncx_list(point, chapters, base, &id, depth + 1)?,
                id,
                title,
                chapter,
                fragment,
            })
        })
        .collect()
}
pub fn walk_toc(toc: &[TocEntry]) -> Vec<&TocEntry> {
    fn visit<'a>(nodes: &'a [TocEntry], out: &mut Vec<&'a TocEntry>) {
        for node in nodes {
            out.push(node);
            visit(&node.children, out);
        }
    }
    let mut out = Vec::new();
    visit(toc, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn fixture(opf: &str, extra: &[(&str, &str)]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "leaf-test-{}.epub",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut writer = zip::ZipWriter::new(File::create(&path).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        writer
            .start_file("META-INF/container.xml", options)
            .unwrap();
        writer.write_all(b"<container><rootfiles><rootfile full-path='OPS/book.opf'/></rootfiles></container>").unwrap();
        writer.start_file("OPS/book.opf", options).unwrap();
        writer.write_all(opf.as_bytes()).unwrap();
        for (name, content) in extra {
            writer.start_file(*name, options).unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        writer.finish().unwrap();
        path
    }
    #[test]
    fn paths_are_contained() {
        assert_eq!(
            resolve("OPS/Text/chapter.xhtml", "../Images/a%20b.png").unwrap(),
            "OPS/Images/a b.png"
        );
        assert_eq!(resolve("OPS/c.xhtml", "#note").unwrap(), "OPS/c.xhtml");
        for path in [
            "../../secret",
            "/etc/passwd",
            "https://a.com",
            "%2e%2e/%2e%2e/x",
            "..\\secret",
        ] {
            assert!(resolve("OPS/c.xhtml", path).is_err());
        }
    }
    #[test]
    fn demo_metadata_and_navigation() {
        let mut book = Book::open(Path::new("../fixtures/quiet-days.epub")).unwrap();
        assert_eq!(book.title, "缓慢的日常");
        assert_eq!(book.chapters.len(), 3);
        assert_eq!(walk_toc(&book.toc).len(), 4);
        assert_eq!(book.toc[0].children[0].fragment, "window");
        assert!(String::from_utf8(
            read(&mut book.archive, &book.chapters[0].path, XML_LIMIT).unwrap()
        )
        .unwrap()
        .contains("窗边"));
        assert!(read(&mut book.archive, "OPS/ch1.xhtml", 8).is_err());
    }
    #[test]
    fn epub2_ncx_nested_and_missing_resources() {
        let path = fixture("<package><metadata><title>EPUB 2</title></metadata><manifest><item id='c' href='Text/ch.xhtml' media-type='application/xhtml+xml'/><item id='ncx' href='toc.ncx' media-type='application/x-dtbncx+xml'/></manifest><spine><itemref idref='c'/></spine></package>", &[("OPS/toc.ncx", "<!DOCTYPE ncx PUBLIC '-//NISO//DTD ncx 2005-1//EN' 'http://www.daisy.org/z3986/2005/ncx-2005-1.dtd'><ncx><navMap><navPoint><navLabel><text>章节标题</text></navLabel><content src='Text/ch.xhtml'/><navPoint><navLabel><text>子标题</text></navLabel><content src='Text/ch.xhtml#part'/></navPoint></navPoint></navMap></ncx>"), ("OPS/Text/ch.xhtml", "<html><body>Text</body></html>")]);
        let mut book = Book::open(&path).unwrap();
        assert_eq!(walk_toc(&book.toc).len(), 2);
        assert_eq!(book.chapters[0].title, "章节标题");
        assert_eq!(book.toc[0].children.len(), 1);
        assert_eq!(book.toc[0].children[0].fragment, "part");
        assert!(read(&mut book.archive, "missing", RESOURCE_LIMIT).is_err());
        drop(book);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn malformed_empty_and_drm_books_are_rejected() {
        for (opf, extra) in [
            ("<package>", vec![]),
            ("<package><manifest/><spine/></package>", vec![]),
            (
                "<package/>",
                vec![(
                    "META-INF/encryption.xml",
                    "<encryption><EncryptionMethod Algorithm='urn:DRM'/></encryption>",
                )],
            ),
        ] {
            let path = fixture(opf, &extra);
            assert!(Book::open(&path).is_err());
            std::fs::remove_file(path).unwrap();
        }
    }
    #[test]
    fn opening_does_not_decompress_chapters() {
        // A missing body can still be indexed; failure occurs only when that chapter is requested.
        let path = fixture("<package><manifest><item id='c' href='not-loaded.xhtml' media-type='application/xhtml+xml'/></manifest><spine><itemref idref='c'/></spine></package>", &[]);
        let mut book = Book::open(&path).unwrap();
        assert_eq!(book.chapters.len(), 1);
        assert!(read(&mut book.archive, "OPS/not-loaded.xhtml", RESOURCE_LIMIT).is_err());
        drop(book);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn ncx_group_without_content_keeps_its_title_and_children() {
        let path=fixture("<package><manifest><item id='a' href='a.xhtml' media-type='application/xhtml+xml'/><item id='n' href='toc.ncx' media-type='application/x-dtbncx+xml'/></manifest><spine><itemref idref='a'/></spine></package>",&[("OPS/toc.ncx","<ncx><navMap><navPoint><navLabel><text>无链接的子书分组</text></navLabel><navPoint><navLabel><text>第一章</text></navLabel><content src='a.xhtml'/></navPoint></navPoint></navMap></ncx>")]);
        let book = Book::open(&path).unwrap();
        assert_eq!(book.toc[0].title, "无链接的子书分组");
        assert!(book.toc[0].chapter.is_none());
        assert_eq!(book.toc[0].children[0].chapter, Some(0));
        drop(book);
        std::fs::remove_file(path).unwrap();
    }
}
