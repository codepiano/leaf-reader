use crate::{
    epub::{self, Book, Chapter, TocEntry},
    Progress,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Location {
    pub chapter: usize,
    pub fragment: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Part {
    pub id: String,
    pub title: String,
    pub start: Location,
    pub end: Option<Location>,
    pub chapters: usize,
    #[serde(default)]
    pub progress: Progress,
    #[serde(default)]
    pub opened: u64,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Collection {
    pub enabled: bool,
    pub parts: Vec<Part>,
}
#[derive(Clone, Serialize)]
pub struct Candidate {
    pub id: String,
    pub title: String,
    pub depth: usize,
    pub start: Option<Location>,
    pub suggested: bool,
}

pub fn first_location(node: &TocEntry) -> Option<Location> {
    node.chapter
        .map(|chapter| Location {
            chapter,
            fragment: node.fragment.clone(),
        })
        .or_else(|| node.children.iter().find_map(first_location))
}
pub fn candidates(toc: &[TocEntry]) -> Vec<Candidate> {
    let mut roots = toc;
    while roots.len() == 1 && !roots[0].children.is_empty() {
        roots = &roots[0].children;
    }
    let suggested: HashSet<_> = roots
        .iter()
        .filter(|n| first_location(n).is_some())
        .map(|n| n.id.as_str())
        .collect();
    fn visit(
        nodes: &[TocEntry],
        depth: usize,
        suggested: &HashSet<&str>,
        out: &mut Vec<Candidate>,
    ) {
        for n in nodes {
            out.push(Candidate {
                id: n.id.clone(),
                title: n.title.clone(),
                depth,
                start: first_location(n),
                suggested: suggested.contains(n.id.as_str()),
            });
            visit(&n.children, depth + 1, suggested, out);
        }
    }
    let mut out = Vec::new();
    visit(toc, 0, &suggested, &mut out);
    out
}
type Anchors = HashMap<usize, HashMap<String, usize>>;
fn position(
    book: &mut Book,
    loc: &Location,
    cache: &mut Anchors,
) -> Result<(usize, usize), String> {
    if loc.chapter >= book.chapters.len() {
        return Err("子书起点不在书籍中".into());
    }
    if loc.fragment.is_empty() {
        return Ok((loc.chapter, 0));
    }
    if let std::collections::hash_map::Entry::Vacant(entry) = cache.entry(loc.chapter) {
        let path = book.chapters[loc.chapter].path.clone();
        let source = String::from_utf8(epub::read(&mut book.archive, &path, 8 * 1024 * 1024)?)
            .map_err(|_| "章节不是 UTF-8 编码")?;
        let doc = roxmltree::Document::parse_with_options(
            &source,
            roxmltree::ParsingOptions {
                allow_dtd: true,
                nodes_limit: 200_000,
            },
        )
        .map_err(|_| "无法核对子书的章内起点，请选择章节文件起点")?;
        let mut ids = HashMap::new();
        for n in doc.descendants().filter(|n| n.is_element()) {
            if let Some(id) = n
                .attribute("id")
                .or_else(|| n.attribute(("http://www.w3.org/XML/1998/namespace", "id")))
                .or_else(|| n.attribute("name"))
            {
                let at_start = n
                    .parent()
                    .is_some_and(|p| p.has_tag_name("body") && p.first_element_child() == Some(n));
                ids.entry(id.to_string())
                    .or_insert(if at_start { 0 } else { n.range().start + 1 });
            }
        }
        entry.insert(ids);
    }
    cache[&loc.chapter]
        .get(&loc.fragment)
        .map(|p| (loc.chapter, *p))
        .ok_or_else(|| format!("找不到子书起点：{}", loc.fragment))
}
pub fn plan(book: &mut Book, ids: &[String], previous: &Collection) -> Result<Collection, String> {
    if ids.len() < 2 {
        return Err("请至少选择两个子书起点".into());
    }
    if ids.len() > 1000 {
        return Err("单个合集最多 1000 本子书".into());
    }
    let all = candidates(&book.toc);
    let mut selected = Vec::new();
    let mut seen = HashSet::new();
    let mut cache = Anchors::new();
    for id in ids {
        if !seen.insert(id) {
            return Err("子书起点重复".into());
        }
        if ids
            .iter()
            .any(|other| id != other && id.starts_with(&format!("{other}-")))
        {
            return Err("不能同时选择一个分组和它内部的章节，请选择要作为子书的一层目录".into());
        }
        let c = all
            .iter()
            .find(|c| &c.id == id)
            .ok_or("目录已变化，请重新选择")?;
        let mut start = c.start.clone().ok_or("这个分组没有可阅读内容")?;
        let key = position(book, &start, &mut cache)?;
        if key.1 == 0 {
            start.fragment.clear();
        }
        selected.push((key, id.clone(), c.title.clone(), start));
    }
    selected.sort_by_key(|v| v.0);
    for pair in selected.windows(2) {
        if pair[0].0 == pair[1].0 {
            return Err("两个子书指向同一位置，请只保留其中一个起点".into());
        }
    }
    if selected.first().is_some_and(|v| v.0 != (0, 0)) {
        selected.insert(
            0,
            (
                (0, 0),
                "frontmatter".into(),
                "卷首内容".into(),
                Location::default(),
            ),
        );
    }
    let mut parts = Vec::new();
    for (i, (_, id, title, start)) in selected.iter().enumerate() {
        let end = selected.get(i + 1).map(|s| s.3.clone());
        let last = end
            .as_ref()
            .map(|e| e.chapter + usize::from(!e.fragment.is_empty()))
            .unwrap_or(book.chapters.len());
        let old = previous
            .parts
            .iter()
            .find(|p| p.id == *id && p.start == *start && p.end == end);
        parts.push(Part {
            id: id.clone(),
            title: title.clone(),
            start: start.clone(),
            end,
            chapters: last - start.chapter,
            progress: old.map(|p| p.progress.clone()).unwrap_or_default(),
            opened: old.map(|p| p.opened).unwrap_or_default(),
        });
    }
    Ok(Collection {
        enabled: true,
        parts,
    })
}

pub fn view(book: &mut Book, part: Option<&Part>) -> Result<(Vec<Chapter>, Vec<TocEntry>), String> {
    let Some(part) = part else {
        return Ok((book.chapters.clone(), book.toc.clone()));
    };
    let first = part.start.chapter;
    let last = part
        .end
        .as_ref()
        .map(|e| e.chapter + usize::from(!e.fragment.is_empty()))
        .unwrap_or(book.chapters.len());
    if first >= last || last > book.chapters.len() {
        return Err("合集章节已变化，请重新划分子书".into());
    }
    let mut chapters = book.chapters[first..last].to_vec();
    chapters[0].start_fragment = part.start.fragment.clone();
    if let Some(end) = &part.end {
        if !end.fragment.is_empty() {
            chapters.last_mut().unwrap().end_fragment = end.fragment.clone();
        }
    }
    let mut cache = Anchors::new();
    let start_key = position(book, &part.start, &mut cache)?;
    let end_key = part
        .end
        .as_ref()
        .map(|e| position(book, e, &mut cache))
        .transpose()?;
    fn filter(
        nodes: &[TocEntry],
        book: &mut Book,
        cache: &mut Anchors,
        first: usize,
        start: (usize, usize),
        end: Option<(usize, usize)>,
    ) -> Result<Vec<TocEntry>, String> {
        let mut result = Vec::new();
        for node in nodes {
            let children = filter(&node.children, book, cache, first, start, end)?;
            let inside = match node.chapter {
                Some(chapter) if chapter >= start.0 && end.is_none_or(|e| chapter <= e.0) => {
                    let key = if chapter == start.0 || end.is_some_and(|e| chapter == e.0) {
                        position(
                            book,
                            &Location {
                                chapter,
                                fragment: node.fragment.clone(),
                            },
                            cache,
                        )?
                    } else {
                        (chapter, 0)
                    };
                    key >= start && end.is_none_or(|e| key < e)
                }
                _ => false,
            };
            if inside || !children.is_empty() {
                let mut n = node.clone();
                n.chapter = if inside {
                    node.chapter.map(|c| c - first)
                } else {
                    None
                };
                n.children = children;
                result.push(n);
            }
        }
        Ok(result)
    }
    let toc = book.toc.clone();
    let toc = filter(&toc, book, &mut cache, first, start_key, end_key)?;
    let labels = epub::walk_toc(&toc);
    for (index, chapter) in chapters.iter_mut().enumerate() {
        chapter.title = labels
            .iter()
            .find(|n| n.chapter == Some(index))
            .map(|n| n.title.clone())
            .unwrap_or_else(|| format!("{} · 第 {} 节", part.title, index + 1));
    }
    Ok((chapters, toc))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    #[test]
    fn no_link_groups_and_shared_chapter_boundaries_are_preserved() {
        let path = Path::new("../fixtures/anthology.epub");
        let original = std::fs::read(path).unwrap();
        let mut book = Book::open(path).unwrap();
        assert!(book.toc[0].chapter.is_none());
        assert_eq!(book.toc[0].title, "三册随笔合集");
        assert!(book.toc[0].children[0].chapter.is_none());
        assert_eq!(book.toc[0].children[0].children.len(), 2);
        let choices = candidates(&book.toc);
        let ids: Vec<_> = choices
            .iter()
            .filter(|c| c.suggested)
            .map(|c| c.id.clone())
            .collect();
        assert_eq!(ids.len(), 3);
        let c = plan(&mut book, &ids, &Collection::default()).unwrap();
        assert_eq!(c.parts.len(), 4);
        assert_eq!(c.parts[0].title, "卷首内容");
        let b = c.parts.iter().find(|p| p.title == "第二本：散步").unwrap();
        let night = c.parts.iter().find(|p| p.title == "第三本：夜读").unwrap();
        assert_eq!(b.start.chapter, night.start.chapter);
        assert_eq!(b.end.as_ref().unwrap().fragment, "c");
        let (chapters, toc) = view(&mut book, Some(b)).unwrap();
        assert_eq!(chapters.len(), 1);
        assert!(chapters[0].start_fragment.is_empty());
        assert_eq!(chapters[0].end_fragment, "c");
        assert!(epub::walk_toc(&toc).iter().any(|n| n.title == "午后的光"));
        assert!(!epub::walk_toc(&toc).iter().any(|n| n.title == "灯下的时间"));
        let (chapters, _) = view(&mut book, Some(night)).unwrap();
        assert_eq!(chapters[0].start_fragment, "c");
        assert_eq!(chapters[0].title, "灯下的时间");
        assert!(chapters[0].end_fragment.is_empty());
        assert_eq!(std::fs::read(path).unwrap(), original);
    }
    #[test]
    fn invalid_or_overlapping_selections_do_not_produce_silent_splits() {
        let mut book = Book::open(Path::new("../fixtures/anthology.epub")).unwrap();
        for ids in [
            vec!["toc-0-0"],
            vec!["toc-0-0", "toc-0-0"],
            vec!["toc-0", "toc-0-0"],
            vec!["missing", "toc-0-0"],
        ] {
            assert!(plan(
                &mut book,
                &ids.into_iter().map(str::to_string).collect::<Vec<_>>(),
                &Collection::default()
            )
            .is_err());
        }
    }
}
