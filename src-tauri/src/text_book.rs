use super::*;
use pulldown_cmark::{html, Event, Options, Parser, Tag, TagEnd};
use std::io::Read;

const TEXT_LIMIT: u64 = 16 * 1024 * 1024;
const OPTIONS: Options = Options::ENABLE_TABLES
    .union(Options::ENABLE_STRIKETHROUGH)
    .union(Options::ENABLE_FOOTNOTES);

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Epub,
    Pdf,
    Markdown,
    Transcript,
}

impl Kind {
    pub fn from_path(path: &Path) -> Result<Self, String> {
        let extension = path
            .extension()
            .and_then(|part| part.to_str())
            .unwrap_or_default();
        match extension.to_ascii_lowercase().as_str() {
            "epub" => Ok(Self::Epub),
            "pdf" => Ok(Self::Pdf),
            "md" | "markdown" => Ok(Self::Markdown),
            "txt" => Ok(Self::Transcript),
            _ => Err("请选择 EPUB、PDF、Markdown 或 TXT 文件".into()),
        }
    }
}

pub struct TextBook {
    pub title: String,
    pub chapters: Vec<Chapter>,
    pub toc: Vec<TocEntry>,
    pub weights: Vec<u64>,
    root: PathBuf,
    bodies: Vec<String>,
    images: HashSet<String>,
}

pub fn encode_path(path: &str) -> String {
    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
    path.split('/')
        .map(|part| utf8_percent_encode(part, NON_ALPHANUMERIC).to_string())
        .collect::<Vec<_>>()
        .join("/")
}

pub fn image_mime(path: &str) -> Option<&'static str> {
    match Path::new(path)
        .extension()?
        .to_str()?
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

pub fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn read_limited(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > limit {
        return Err("文件类型无效或超出大小限制".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("文件超出大小限制".into());
    }
    Ok(bytes)
}

impl TextBook {
    pub fn open(path: &Path, kind: Kind) -> Result<Self, String> {
        let bytes = read_limited(path, TEXT_LIMIT)?;
        let source = std::str::from_utf8(&bytes).map_err(|_| "请选择 UTF-8 文本文件")?;
        let source = source.trim_start_matches('\u{feff}');
        if source.trim().is_empty() {
            return Err("文件没有可阅读的正文".into());
        }
        let title = pdf::title(path);
        let mut book = Self {
            title,
            chapters: Vec::new(),
            toc: Vec::new(),
            weights: Vec::new(),
            root: path.parent().ok_or("文件目录不可用")?.to_path_buf(),
            bodies: Vec::new(),
            images: HashSet::new(),
        };
        match kind {
            Kind::Markdown => book.markdown(source)?,
            Kind::Transcript => {
                let body = transcript(source);
                book.push(book.title.clone(), body, count(source));
            }
            _ => return Err("文件不是文本书籍".into()),
        }
        Ok(book)
    }

    pub fn read_chapter(&self, index: usize) -> Result<String, String> {
        self.bodies
            .get(index)
            .cloned()
            .ok_or_else(|| "章节不存在".into())
    }

    pub fn read_image(&self, path: &str) -> Result<(Vec<u8>, &'static str), String> {
        let relative = path.strip_prefix("images/").ok_or("资源不存在")?;
        if !self.images.contains(relative) {
            return Err("资源不存在".into());
        }
        let mime = image_mime(relative).ok_or("图片格式不支持")?;
        let resolved = self
            .root
            .join(relative)
            .canonicalize()
            .map_err(|_| "图片不存在")?;
        if !resolved.starts_with(&self.root) {
            return Err("图片超出书籍所在目录".into());
        }
        Ok((read_limited(&resolved, epub::RESOURCE_LIMIT)?, mime))
    }

    fn push(&mut self, title: String, body: String, weight: u64) {
        let index = self.chapters.len();
        let path = format!("chapter-{index}.html");
        self.chapters.push(Chapter {
            title: title.clone(),
            path: path.clone(),
            start_fragment: String::new(),
            end_fragment: String::new(),
        });
        self.toc.push(TocEntry {
            title,
            id: path,
            chapter: Some(index),
            fragment: String::new(),
            children: Vec::new(),
        });
        self.weights.push(weight.max(1));
        self.bodies.push(body);
    }

    fn markdown(&mut self, source: &str) -> Result<(), String> {
        let mut starts = markdown_chapters(source);
        if starts.len() > 4096 {
            return Err("Markdown 章节过多".into());
        }
        if starts
            .first()
            .is_none_or(|(offset, _)| !source[..*offset].trim().is_empty())
        {
            let label = if starts.is_empty() {
                self.title.clone()
            } else {
                "前置内容".into()
            };
            starts.insert(0, (0, label));
        }
        let mut events = Parser::new_ext(source, OPTIONS)
            .into_offset_iter()
            .peekable();
        let end = starts
            .iter()
            .map(|(offset, _)| *offset)
            .skip(1)
            .chain([source.len()])
            .collect::<Vec<_>>();
        for ((offset, title), end) in starts.into_iter().zip(end) {
            let mut body = String::new();
            html::push_html(
                &mut body,
                std::iter::from_fn(|| {
                    if events.peek()?.1.start >= end {
                        return None;
                    }
                    let (event, _) = events.next()?;
                    Some(match event {
                        Event::Html(s) | Event::InlineHtml(s) => Event::Text(s),
                        Event::Start(Tag::Image {
                            link_type,
                            dest_url,
                            title,
                            id,
                        }) => {
                            let resolved = epub::resolve("chapter.html", &dest_url)
                                .ok()
                                .filter(|path| image_mime(path).is_some());
                            let dest = resolved.map(|path| {
                                let url = format!("images/{}", encode_path(&path));
                                self.images.insert(path);
                                url
                            });
                            Event::Start(Tag::Image {
                                link_type,
                                dest_url: dest.unwrap_or_default().into(),
                                title,
                                id,
                            })
                        }
                        event => event,
                    })
                }),
            );
            self.push(title, body, count(&source[offset..end]));
        }
        Ok(())
    }
}

fn count(text: &str) -> u64 {
    text.chars().filter(|c| !c.is_whitespace()).count() as u64
}

fn markdown_chapters(source: &str) -> Vec<(usize, String)> {
    let mut chapters = Vec::new();
    let mut depth = 0;
    let mut heading = None;
    for (event, range) in Parser::new_ext(source, OPTIONS).into_offset_iter() {
        match event {
            Event::Start(tag) => {
                if depth == 0 && matches!(tag, Tag::Heading { .. }) {
                    heading = Some((range.start, String::new()));
                }
                depth += 1;
            }
            Event::End(tag) => {
                depth -= 1;
                if matches!(tag, TagEnd::Heading(_)) {
                    if let Some((offset, title)) = heading.take() {
                        let title = title.trim();
                        let chapter_number = title
                            .strip_prefix('第')
                            .and_then(|s| s.split_once('章'))
                            .map(|(n, _)| n.trim());
                        if chapter_number.is_some_and(|n| {
                            !n.is_empty()
                                && n.chars().all(|c| {
                                    c.is_ascii_digit()
                                        || "一二三四五六七八九十百千万零〇两".contains(c)
                                })
                        }) {
                            chapters.push((offset, title.to_string()));
                        }
                    }
                }
            }
            Event::Text(s) | Event::Code(s) => {
                if let Some((_, title)) = &mut heading {
                    title.push_str(&s);
                }
            }
            _ => {}
        }
    }
    chapters
}

fn speaker(line: &str) -> Option<(&str, &str, &str)> {
    let (label, content) = line.split_once(['：', ':'])?;
    let label = label.trim();
    let (name, rest) = label.split_once(['（', '('])?;
    let role = rest.strip_suffix(['）', ')'])?.trim();
    let name = name.trim();
    if name.is_empty() || role.is_empty() || name.chars().count() > 80 || role.chars().count() > 40
    {
        return None;
    }
    Some((name, role, content.trim()))
}

struct Turn<'a> {
    speaker: Option<(&'a str, &'a str)>,
    paragraphs: Vec<&'a str>,
}

fn transcript(source: &str) -> String {
    let mut groups: Vec<Turn<'_>> = Vec::new();
    for line in source
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if let Some((name, role, text)) = speaker(line) {
            let key = Some((name, role));
            if groups.last().is_none_or(|turn| turn.speaker != key) {
                groups.push(Turn {
                    speaker: key,
                    paragraphs: Vec::new(),
                });
            }
            groups.last_mut().unwrap().paragraphs.push(text);
        } else {
            if groups.is_empty() {
                groups.push(Turn {
                    speaker: None,
                    paragraphs: Vec::new(),
                });
            }
            groups.last_mut().unwrap().paragraphs.push(line);
        }
    }
    let mut colors = HashMap::new();
    let mut body = String::new();
    for Turn {
        speaker,
        paragraphs,
    } in groups
    {
        let label = if let Some((name, role)) = speaker {
            let next = colors.len() % 6;
            let color = colors.entry((name, role)).or_insert(next);
            format!(
                r#"<div class="transcript-turn speaker-{color}"><strong>{}</strong> <small>{}</small>"#,
                escape(name),
                escape(role)
            )
        } else {
            r#"<div class="transcript-turn"><small>未标注说话人</small>"#.to_string()
        };
        body.push_str(&label);
        for paragraph in paragraphs.iter().filter(|p| !p.is_empty()) {
            body.push_str(&format!("<p>{}</p>", escape(paragraph)));
        }
        body.push_str("</div>");
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_does_not_split_fenced_code_and_uses_later_reference_definitions() {
        let input = "前言\n\n# 第一章\n\n一段正文和[链接][ref]。\n\n```\n# 第九章\n```\n\n# 第 二 章\n\n第二段。\n\n[ref]: https://example.invalid\n";
        assert_eq!(
            markdown_chapters(input)
                .iter()
                .map(|(_, t)| t.as_str())
                .collect::<Vec<_>>(),
            ["第一章", "第 二 章"]
        );
        let mut book = TextBook {
            title: "书".into(),
            root: PathBuf::new(),
            chapters: vec![],
            toc: vec![],
            weights: vec![],
            bodies: vec![],
            images: HashSet::new(),
        };
        book.markdown(input).unwrap();
        assert_eq!(book.chapters.len(), 3);
        assert!(book.bodies[0].contains("前言"));
        assert!(book.bodies[1].contains("<pre><code># 第九章"));
        assert!(book.bodies[1].contains(r#"<a href="https://example.invalid">链接</a>"#));
        assert!(book.bodies[2].contains("第二段"));
    }

    #[test]
    fn transcript_preserves_untagged_text_and_speaker_colors_across_turns() {
        let html = transcript("开场 <原样>\n阿春（主持）：第一句\n阿春（主持）：接着说\n小安(嘉宾): 插话\n阿春（主持）：结束");
        assert!(html.contains("开场 &lt;原样&gt;"));
        assert_eq!(html.matches("speaker-0").count(), 2);
        assert_eq!(html.matches("speaker-1").count(), 1);
        assert!(html.contains("<p>第一句</p><p>接着说</p>"));
    }
}
