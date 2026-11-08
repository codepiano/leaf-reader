use super::*;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Details {
    pub title: String,
    pub author: String,
    pub publisher: String,
    pub published: String,
    pub isbn: String,
    pub language: String,
    pub description: String,
}
impl Details {
    pub fn overlay(&mut self, other: &Self) {
        for (target, value) in [
            (&mut self.title, &other.title),
            (&mut self.author, &other.author),
            (&mut self.publisher, &other.publisher),
            (&mut self.published, &other.published),
            (&mut self.isbn, &other.isbn),
            (&mut self.language, &other.language),
            (&mut self.description, &other.description),
        ] {
            if !value.is_empty() {
                *target = value.clone();
            }
        }
    }
    fn clean(mut self) -> Result<Self, String> {
        for (field, limit, multiline) in [
            (&mut self.title, 256, false),
            (&mut self.author, 256, false),
            (&mut self.publisher, 256, false),
            (&mut self.published, 64, false),
            (&mut self.isbn, 64, false),
            (&mut self.language, 64, false),
            (&mut self.description, 10000, true),
        ] {
            *field = field.trim().to_string();
            if field.chars().count() > limit
                || field
                    .chars()
                    .any(|c| c.is_control() && !(multiline && matches!(c, '\n' | '\r' | '\t')))
            {
                return Err(format!("信息字段超过 {limit} 字符或包含无效控制字符"));
            }
        }
        Ok(self)
    }
}
pub fn names(
    library: &Library,
    id: &str,
    part_id: Option<&str>,
    title: &str,
    author: &str,
) -> (String, String) {
    let root = library.metadata.get(id).map(|m| &m.details);
    let child = part_id
        .and_then(|p| library.metadata.get(&item_key(id, Some(p))))
        .map(|m| &m.details);
    let title_override = if part_id.is_some() {
        child.map(|d| d.title.as_str())
    } else {
        root.map(|d| d.title.as_str())
    };
    let author_override = child
        .map(|d| d.author.as_str())
        .filter(|v| !v.is_empty())
        .or_else(|| root.map(|d| d.author.as_str()));
    (
        title_override
            .filter(|v| !v.is_empty())
            .unwrap_or(title)
            .into(),
        author_override
            .filter(|v| !v.is_empty())
            .unwrap_or(author)
            .into(),
    )
}
pub fn original(path: &Path) -> Result<Details, String> {
    let mut archive = zip::ZipArchive::new(fs::File::open(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if archive.len() > 20000 {
        return Err("书内文件过多".into());
    }
    let container = epub::xml(&mut archive, "META-INF/container.xml")?;
    let doc = epub::parse_xml(&container).map_err(|e| e.to_string())?;
    let opf = doc
        .descendants()
        .find(|n| n.has_tag_name("rootfile"))
        .and_then(|n| n.attribute("full-path"))
        .ok_or("找不到书籍清单")?;
    let opf = epub::resolve("", opf)?;
    let xml = epub::xml(&mut archive, &opf)?;
    let doc = epub::parse_xml(&xml).map_err(|e| e.to_string())?;
    let metadata = doc
        .descendants()
        .find(|n| n.has_tag_name("metadata"))
        .ok_or("没有元数据")?;
    let text = |node: roxmltree::Node<'_, '_>| {
        node.descendants()
            .filter(|n| n.is_text())
            .filter_map(|n| n.text())
            .collect::<String>()
            .trim()
            .to_string()
    };
    let field = |tag: &str| {
        metadata
            .children()
            .find(|n| n.has_tag_name(tag))
            .map(text)
            .unwrap_or_default()
    };
    let isbn = metadata
        .children()
        .filter(|n| n.has_tag_name("identifier"))
        .find(|n| {
            let value = text(*n);
            value.to_ascii_lowercase().starts_with("urn:isbn:")
                || n.attributes()
                    .any(|a| a.name() == "scheme" && a.value().eq_ignore_ascii_case("ISBN"))
                || {
                    let digits: String =
                        value.chars().filter(|c| !matches!(c, '-' | ' ')).collect();
                    matches!(digits.len(), 10 | 13)
                        && digits
                            .chars()
                            .all(|c| c.is_ascii_digit() || matches!(c, 'x' | 'X'))
                }
        })
        .map(text)
        .unwrap_or_default();
    Ok(Details {
        title: field("title"),
        author: metadata
            .children()
            .filter(|n| n.has_tag_name("creator"))
            .map(text)
            .collect::<Vec<_>>()
            .join(" / "),
        publisher: field("publisher"),
        published: field("date"),
        isbn: isbn.strip_prefix("urn:isbn:").unwrap_or(&isbn).to_string(),
        language: field("language"),
        description: field("description"),
    })
}
pub fn update(
    state: &ReaderState,
    id: &str,
    part_id: Option<&str>,
    details: Details,
) -> Result<(), String> {
    let details = details.clean()?;
    let mut library = state.library.lock().map_err(|e| e.to_string())?;
    if !library.recent.iter().any(|r| r.id == id)
        || part_id.is_some_and(|part| {
            !library
                .collections
                .get(id)
                .is_some_and(|c| c.parts.iter().any(|p| p.id == part))
        })
    {
        return Err("书籍记录不存在".into());
    }
    let mut next = library.clone();
    next.metadata
        .entry(item_key(id, part_id))
        .or_default()
        .details = details;
    persist(state, &next)?;
    *library = next;
    Ok(())
}
#[tauri::command]
pub fn edit_book_details(
    state: tauri::State<ReaderState>,
    source_id: String,
    part_id: Option<String>,
    details: Details,
) -> Result<(), String> {
    update(&state, &source_id, part_id.as_deref(), details)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn edits_override_display_without_rewriting_sources_and_can_be_reset() {
        let dir = std::env::temp_dir().join(format!("leaf-details-{}", token()));
        fs::create_dir_all(&dir).unwrap();
        let state = ReaderState {
            session: Mutex::new(None),
            library: Mutex::new(Library::default()),
            storage: dir.join("library.json"),
        };
        let source = dir.join("book.epub");
        let bytes = include_bytes!("../../fixtures/anthology.epub");
        fs::write(&source, bytes).unwrap();
        let root = open_path(&state, &source).unwrap();
        write_progress(&state, &root.token, 1, 0.4).unwrap();
        update(
            &state,
            &root.id,
            None,
            Details {
                title: " 手动书名 ".into(),
                author: "作者甲".into(),
                publisher: "出版社".into(),
                published: "2026".into(),
                isbn: "9780000000000".into(),
                language: "zh-CN".into(),
                description: "第一行\n第二行".into(),
            },
        )
        .unwrap();
        let shelf = snapshot(&state.library.lock().unwrap());
        assert_eq!(shelf.books[0].recent.title, "手动书名");
        assert_eq!(shelf.books[0].recent.author, "作者甲");
        let reopened = open_path(&state, &source).unwrap();
        assert_eq!(reopened.title, "手动书名");
        assert_eq!(reopened.progress.fraction, 0.4);
        assert_eq!(reopened.author, "作者甲");
        // Unrelated metadata updates preserve bibliography overrides.
        update_metadata(&state, &root.id, None, "文学".into(), vec![], true).unwrap();
        let ids: Vec<_> = reopened
            .candidates
            .iter()
            .filter(|c| c.suggested)
            .map(|c| c.id.clone())
            .collect();
        let all = configure_collection(&state, &reopened.token, true, &ids).unwrap();
        let first = &all.collection.parts[1];
        let second = &all.collection.parts[2];
        update(
            &state,
            &root.id,
            Some(&first.id),
            Details {
                title: "子书甲".into(),
                author: "子书作者".into(),
                ..Details::default()
            },
        )
        .unwrap();
        let child = open_scoped(&state, &source, Some(&first.id)).unwrap();
        assert_eq!(child.title, "子书甲");
        assert_eq!(child.source_title, "手动书名");
        assert_eq!(child.author, "子书作者");
        let other = open_scoped(&state, &source, Some(&second.id)).unwrap();
        assert_eq!(other.author, "作者甲");
        assert_ne!(other.title, "子书甲");
        assert_eq!(fs::read(&source).unwrap(), bytes);
        let saved = fs::read(&state.storage).unwrap();
        assert!(update(
            &state,
            &root.id,
            None,
            Details {
                title: "x".repeat(257),
                ..Details::default()
            }
        )
        .is_err());
        assert_eq!(fs::read(&state.storage).unwrap(), saved);
        assert!(update(
            &state,
            &root.id,
            None,
            Details {
                author: "bad\nname".into(),
                ..Details::default()
            }
        )
        .is_err());
        assert!(update(&state, "missing", None, Details::default()).is_err());
        update(&state, &root.id, None, Details::default()).unwrap();
        let original_root = open_scoped(&state, &source, None).unwrap();
        assert_eq!(original_root.title, root.title);
        assert_eq!(original_root.author, root.author);
        assert!(original_root.metadata.favorite);
        update(&state, &root.id, Some(&first.id), Details::default()).unwrap();
        let original_child = open_scoped(&state, &source, Some(&first.id)).unwrap();
        assert_eq!(original_child.title, first.title);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn reads_standard_source_metadata_on_demand() {
        use std::io::Write;
        let path = std::env::temp_dir().join(format!("leaf-metadata-{}.epub", token()));
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        for (name, data) in [("META-INF/container.xml","<container><rootfile full-path='book.opf'/></container>"),("book.opf","<package xmlns:dc='http://purl.org/dc/elements/1.1/'><metadata><dc:title>书名</dc:title><dc:creator>甲</dc:creator><dc:creator>乙</dc:creator><dc:publisher>出版社</dc:publisher><dc:date>2026-01</dc:date><dc:identifier>urn:uuid:abc</dc:identifier><dc:identifier>urn:isbn:9780000000000</dc:identifier><dc:language>zh-CN</dc:language><dc:description>说明</dc:description></metadata></package>")] { zip.start_file(name,zip::write::SimpleFileOptions::default()).unwrap(); zip.write_all(data.as_bytes()).unwrap(); }
        zip.finish().unwrap();
        let result = original(&path).unwrap();
        assert_eq!(result.author, "甲 / 乙");
        assert_eq!(result.publisher, "出版社");
        assert_eq!(result.isbn, "9780000000000");
        assert_eq!(result.description, "说明");
        fs::remove_file(path).unwrap();
    }
}
