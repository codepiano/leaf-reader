use crate::details::Details;
use reqwest::{redirect::Policy, Client, Url};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, sync::OnceLock, time::Duration};

const SEARCH_URL: &str = "https://openlibrary.org/search.json";
const FIELDS: &str = "key,title,author_name,editions,editions.key,editions.title,editions.isbn,editions.publisher,editions.publish_date,editions.language";
const RESPONSE_LIMIT: usize = 256 * 1024;

#[derive(Default, Deserialize)]
struct Documents<T> {
    docs: Vec<T>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Work {
    key: String,
    title: String,
    author_name: Vec<String>,
    editions: Documents<Edition>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Edition {
    key: String,
    title: String,
    publisher: Vec<String>,
    publish_date: Vec<String>,
    isbn: Vec<String>,
    language: Vec<String>,
}

#[derive(Serialize)]
pub struct Candidate {
    reference: String,
    details: Details,
}

fn isbn_number(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_uppercase();
    let value: String = value
        .strip_prefix("URN:ISBN:")
        .or_else(|| value.strip_prefix("ISBN:"))
        .unwrap_or(&value)
        .chars()
        .filter(|c| !c.is_whitespace() && !matches!(c, '-' | '‐' | '‑' | '–' | '－'))
        .collect();
    let valid = match value.as_bytes() {
        [prefix @ .., last] if prefix.len() == 9 => {
            prefix.iter().all(u8::is_ascii_digit) && (last.is_ascii_digit() || *last == b'X')
        }
        digits if digits.len() == 13 => digits.iter().all(u8::is_ascii_digit),
        _ => false,
    };
    valid.then_some(value)
}

fn phrase(value: &str) -> String {
    format!(r#""{}""#, value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn clean(value: &str, limit: usize) -> String {
    let mut units = 0;
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|c| !c.is_control())
        .take_while(|c| {
            units += c.len_utf16();
            units <= limit
        })
        .collect()
}

fn reference(key: &str, prefix: &str, suffix: char) -> Option<String> {
    let id = key
        .strip_prefix(prefix)?
        .strip_prefix("OL")?
        .strip_suffix(suffix)?;
    (!id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())).then(|| key.to_string())
}

fn candidates(data: Documents<Work>, isbn: Option<&str>) -> Vec<Candidate> {
    let mut seen = HashSet::new();
    let mut results = Vec::new();
    for work in data.docs {
        let author = clean(&work.author_name.join("、"), 256);
        let title = clean(&work.title, 256);
        let mut edition_found = false;
        for edition in work.editions.docs {
            let numbers: Vec<_> = edition.isbn.iter().filter_map(|n| isbn_number(n)).collect();
            if isbn.is_some_and(|expected| !numbers.iter().any(|n| n == expected)) {
                continue;
            }
            let Some(reference) = reference(&edition.key, "/books/", 'M') else {
                continue;
            };
            edition_found = true;
            if !seen.insert(reference.clone()) {
                continue;
            }
            let edition_title = clean(&edition.title, 256);
            let suggested_isbn = isbn
                .or_else(|| numbers.iter().find(|n| n.len() == 13).map(String::as_str))
                .or_else(|| numbers.first().map(String::as_str))
                .unwrap_or_default();
            results.push(Candidate {
                reference,
                details: Details {
                    title: if edition_title.is_empty() {
                        title.clone()
                    } else {
                        edition_title
                    },
                    author: author.clone(),
                    publisher: clean(&edition.publisher.join("、"), 256),
                    published: clean(edition.publish_date.first().map_or("", String::as_str), 64),
                    isbn: suggested_isbn.to_string(),
                    language: clean(edition.language.first().map_or("", String::as_str), 64),
                    ..Details::default()
                },
            });
        }
        if !edition_found && isbn.is_none() && !title.is_empty() {
            if let Some(reference) = reference(&work.key, "/works/", 'W') {
                if seen.insert(reference.clone()) {
                    results.push(Candidate {
                        reference,
                        details: Details {
                            title,
                            author,
                            ..Details::default()
                        },
                    });
                }
            }
        }
    }
    results.truncate(10);
    results
}

#[tauri::command]
pub async fn lookup_book_metadata(term: String, author: String) -> Result<Vec<Candidate>, String> {
    let term = term.trim();
    let author = author.trim();
    if term.is_empty()
        || term.chars().count() > 256
        || author.chars().count() > 256
        || term.chars().chain(author.chars()).any(char::is_control)
    {
        return Err("请输入 ISBN 或书名，书名和作者各限 256 字".into());
    }
    let isbn = isbn_number(term);
    let query = if let Some(isbn) = &isbn {
        format!("isbn:{isbn}")
    } else if author.is_empty() {
        format!("title:{}", phrase(term))
    } else {
        format!("title:{} AND author:{}", phrase(term), phrase(author))
    };
    static CLIENT: OnceLock<Result<Client, reqwest::Error>> = OnceLock::new();
    let client = CLIENT
        .get_or_init(|| {
            Client::builder()
                .redirect(Policy::none())
                .timeout(Duration::from_secs(15))
                .user_agent(concat!("Leaf/", env!("CARGO_PKG_VERSION")))
                .build()
        })
        .as_ref()
        .map_err(|_| "无法建立书目查询连接")?;
    let mut url = Url::parse(SEARCH_URL).map_err(|_| "书目查询地址无效")?;
    url.query_pairs_mut()
        .append_pair("q", &query)
        .append_pair("fields", FIELDS)
        .append_pair("limit", "10");
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "无法连接 Open Library，请稍后重试")?;
    if response.status().as_u16() == 429 {
        return Err("Open Library 查询过于频繁，请稍后重试".into());
    }
    if !response.status().is_success() {
        return Err("Open Library 暂时无法查询，请稍后重试".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "书目查询中断，请重试")? {
        if bytes.len() + chunk.len() > RESPONSE_LIMIT {
            return Err("Open Library 返回的结果过大，请尝试用 ISBN 查询".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let data = serde_json::from_slice(&bytes).map_err(|_| "无法读取 Open Library 的返回结果")?;
    Ok(candidates(data, isbn.as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isbn_lookup_requires_an_exact_edition_match() {
        let response = br#"{"docs":[{"key":"/works/OL1W","title":"Work title","author_name":["A. Writer"],
        "editions":{"docs":[
          {"key":"/books/OL2M","title":"Different edition","isbn":["9780141439525"],"publisher":["Other publisher"]},
          {"key":"/books/OL3M","title":"Correct edition","isbn":["9780141439518","0141439513"],"publisher":["Penguin"]},
          {"key":"/books/OL3M","title":"Duplicate","isbn":["9780141439518"]}
        ]}}]}"#;
        let isbn = isbn_number("urn:isbn:978-0-14-143951-8").unwrap();
        let results = candidates(serde_json::from_slice(response).unwrap(), Some(&isbn));
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].details.title, "Correct edition");
        assert_eq!(results[0].details.author, "A. Writer");
        assert_eq!(results[0].details.publisher, "Penguin");
        assert_eq!(results[0].details.isbn, isbn);
    }

    #[test]
    fn work_level_suggestions_do_not_invent_edition_fields() {
        let response =
            br#"{"docs":[{"key":"/works/OL1W","title":"Example","author_name":["A. Writer"],
            "isbn":["1234567890"],"editions":{"docs":[]}}]}"#;
        let results = candidates(serde_json::from_slice(response).unwrap(), None);
        assert_eq!(results[0].reference, "/works/OL1W");
        assert_eq!(results[0].details.author, "A. Writer");
        assert!(results[0].details.isbn.is_empty());
    }
}
