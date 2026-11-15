use super::*;
use std::{cmp::Ordering, io::Read};
use zip::ZipArchive;

const MAX_ENTRIES: usize = 20_000;

pub struct Comic {
    archive: ZipArchive<fs::File>,
    pages: Vec<(String, usize, &'static str)>,
}

impl Comic {
    pub fn open(path: &Path) -> Result<Self, String> {
        let mut archive = ZipArchive::new(fs::File::open(path).map_err(|e| e.to_string())?)
            .map_err(|_| "CBZ 不是有效的 ZIP 文件")?;
        if archive.len() > MAX_ENTRIES {
            return Err("CBZ 内的文件过多".into());
        }
        let mut pages = Vec::new();
        for index in 0..archive.len() {
            let entry = archive.by_index_raw(index).map_err(|e| e.to_string())?;
            if !entry.is_file()
                || entry.enclosed_name().is_none()
                || entry
                    .name()
                    .split('/')
                    .any(|part| part.starts_with('.') || part == "__MACOSX")
            {
                continue;
            }
            if let Some(mime) = text_book::image_mime(entry.name()) {
                if entry.encrypted() || entry.size() > epub::RESOURCE_LIMIT {
                    return Err("CBZ 包含加密或过大的漫画图片".into());
                }
                pages.push((entry.name().to_owned(), index, mime));
            }
        }
        if pages.is_empty() {
            return Err("CBZ 里没有可阅读的漫画图片".into());
        }
        pages.sort_by(|a, b| natural(&a.0, &b.0));
        Ok(Self { archive, pages })
    }

    pub fn len(&self) -> usize {
        self.pages.len()
    }

    pub fn read(&mut self, resource: &str) -> Result<(Vec<u8>, &'static str), String> {
        let index: usize = resource
            .strip_prefix("comic/")
            .and_then(|s| s.parse().ok())
            .ok_or("漫画页不存在")?;
        let (_, entry, mime) = self.pages.get(index).ok_or("漫画页不存在")?;
        let mut bytes = Vec::new();
        self.archive
            .by_index(*entry)
            .map_err(|e| e.to_string())?
            .take(epub::RESOURCE_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > epub::RESOURCE_LIMIT {
            return Err("漫画图片过大".into());
        }
        Ok((bytes, mime))
    }
}

pub fn natural(a: &str, b: &str) -> Ordering {
    fn runs(s: &str) -> impl Iterator<Item = &str> {
        s.as_bytes()
            .chunk_by(|a, b| a.is_ascii_digit() == b.is_ascii_digit())
            .map(|part| std::str::from_utf8(part).expect("split at ASCII digits"))
    }
    let adjusted = |s: &str| s.to_lowercase();
    let (lower_a, lower_b) = (adjusted(a), adjusted(b));
    let mut left = runs(&lower_a);
    let mut right = runs(&lower_b);
    loop {
        let order = match (left.next(), right.next()) {
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(a), Some(b))
                if a.as_bytes()[0].is_ascii_digit() && b.as_bytes()[0].is_ascii_digit() =>
            {
                let (a, b) = (a.trim_start_matches('0'), b.trim_start_matches('0'));
                a.len().cmp(&b.len()).then_with(|| a.cmp(b))
            }
            (Some(a), Some(b)) => a.cmp(b),
        };
        if !order.is_eq() {
            return order;
        }
    }
}
