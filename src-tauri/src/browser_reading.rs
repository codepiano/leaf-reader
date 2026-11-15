use super::*;
use std::{
    borrow::Cow,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri_plugin_opener::OpenerExt;
use tiny_http::{Header, Method, Request, Response, Server};

#[derive(Default)]
pub struct State(Mutex<Option<Lease>>);

struct Lease(Arc<AtomicBool>);
impl Drop for Lease {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[tauri::command]
pub fn open_browser_reading(
    app: tauri::AppHandle,
    token: String,
    index: usize,
) -> Result<(), String> {
    {
        let state = app.state::<ReaderState>();
        let active = state.session.lock().map_err(|e| e.to_string())?;
        active
            .as_ref()
            .filter(|s| s.token == token && index < s.view_chapters.len())
            .ok_or("当前没有可共读的章节")?;
    }
    let server = Server::http(("127.0.0.1", 0)).map_err(|_| "无法启动本地共读页面")?;
    let host = server.server_addr().to_string();
    let key = uuid::Uuid::new_v4().simple().to_string();
    let url = format!("http://{host}/{key}/chapter/{index}");
    let enabled = Arc::new(AtomicBool::new(true));
    let running = enabled.clone();
    let state = app.state::<State>();
    let mut lease = state.0.lock().map_err(|e| e.to_string())?;
    let reader = app.clone();
    std::thread::Builder::new()
        .name("leaf-browser-reading".into())
        .spawn(move || {
            while running.load(Ordering::Acquire) && session_exists(&reader, &token) {
                match server.recv_timeout(Duration::from_millis(300)) {
                    Ok(Some(request)) => reply(request, &reader, &host, &key, &token, &running),
                    Ok(None) => {}
                    Err(_) => break,
                }
            }
        })
        .map_err(|_| "无法启动本地共读页面")?;

    *lease = Some(Lease(enabled));
    if app.opener().open_url(&url, None::<&str>).is_err() {
        *lease = None;
        return Err("无法在浏览器中打开当前章节".into());
    }
    Ok(())
}

#[tauri::command]
pub fn stop_browser_reading(state: tauri::State<State>) -> Result<(), String> {
    *state.0.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

fn session_exists(app: &tauri::AppHandle, token: &str) -> bool {
    app.state::<ReaderState>()
        .session
        .lock()
        .is_ok_and(|active| active.as_ref().is_some_and(|s| s.token == token))
}

fn reply(
    request: Request,
    app: &tauri::AppHandle,
    host: &str,
    key: &str,
    token: &str,
    running: &AtomicBool,
) {
    let header = |name: &'static str| {
        request
            .headers()
            .iter()
            .find(|h| h.field.equiv(name))
            .map(|h| h.value.as_str())
    };
    let base = format!("/{key}/");
    let route = request.url().strip_prefix(&base);
    let content = if request.method() == &Method::Get
        && header("Host") == Some(host)
        && header("Sec-Fetch-Site") != Some("cross-site")
        && running.load(Ordering::Acquire)
    {
        route.and_then(|route| content(&app.state::<ReaderState>(), token, key, route).ok())
    } else {
        None
    };
    let (status, bytes, mime) = match content {
        Some((bytes, mime)) => (200, bytes, mime),
        None => (
            404,
            "共读页面已关闭或章节不存在。".as_bytes().to_vec(),
            "text/plain; charset=utf-8",
        ),
    };
    let mut response = Response::from_data(bytes).with_status_code(status);
    for (name, value) in [
        ("Content-Type", mime),
        ("Cache-Control", "no-store"),
        ("Referrer-Policy", "no-referrer"),
        ("X-Content-Type-Options", "nosniff"),
        ("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"),
    ] {
        response.add_header(Header::from_bytes(name, value).expect("fixed response header"));
    }
    let _ = request.respond(response);
}

fn content(
    state: &ReaderState,
    token: &str,
    key: &str,
    route: &str,
) -> Result<(Vec<u8>, &'static str), String> {
    let mut active = state.session.lock().map_err(|e| e.to_string())?;
    let session = active
        .as_mut()
        .filter(|s| s.token == token)
        .ok_or("书籍已关闭")?;
    if let Some(asset) = route.strip_prefix("image/") {
        let asset = percent_encoding::percent_decode_str(asset)
            .decode_utf8()
            .map_err(|_| "图片地址错误")?;
        let mime = text_book::image_mime(&asset).ok_or("仅提供书内图片")?;
        if asset
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
            || asset.contains(['\\', ':', '\0'])
        {
            return Err("无效的图片路径".into());
        }
        return match &mut session.book {
            SessionBook::Epub(book) | SessionBook::Kindle { book, .. } => Ok((
                epub::read(&mut book.archive, &asset, epub::RESOURCE_LIMIT)?,
                mime,
            )),
            SessionBook::Text(book) => book.read_image(&asset),
            SessionBook::Pdf(_) | SessionBook::Comic(_) => Err("分页图书不支持共读".into()),
        };
    }
    let index: usize = route
        .strip_prefix("chapter/")
        .and_then(|i| i.parse().ok())
        .ok_or("章节不存在")?;
    let chapter = session
        .view_chapters
        .get(index)
        .ok_or("章节不存在")?
        .clone();
    let title = match &session.book {
        SessionBook::Epub(book) | SessionBook::Kindle { book, .. } => &book.title,
        SessionBook::Text(book) => &book.title,
        SessionBook::Pdf(_) | SessionBook::Comic(_) => return Err("分页图书不支持共读".into()),
    }
    .clone();
    let total = session.view_chapters.len();
    let source = read_chapter(session, index)?;
    let source = excerpt(&source, &chapter)?;
    drop(active);
    Ok((
        page(key, index, total, &title, &chapter, source).into_bytes(),
        "text/html; charset=utf-8",
    ))
}

fn excerpt<'a>(source: &'a str, chapter: &Chapter) -> Result<&'a str, String> {
    let bounded = !chapter.start_fragment.is_empty() || !chapter.end_fragment.is_empty();
    let doc = epub::parse_xml(source).ok();
    let body = doc
        .as_ref()
        .and_then(|doc| doc.descendants().find(|n| n.has_tag_name("body")));
    let Some(body) = body else {
        return if bounded {
            Err("无法定位子书的正文边界".into())
        } else {
            Ok(source)
        };
    };
    let offset = |fragment: &str, default| {
        if fragment.is_empty() {
            return Ok(default);
        }
        body.descendants()
            .find(|n| {
                n.attribute("id") == Some(fragment)
                    || n.attribute("name") == Some(fragment)
                    || n.attribute(("http://www.w3.org/XML/1998/namespace", "id")) == Some(fragment)
            })
            .map(|node| node.range().start)
            .ok_or("无法定位子书的正文边界")
    };
    let start = offset(&chapter.start_fragment, body.range().start)?;
    let end = offset(&chapter.end_fragment, body.range().end)?;
    source
        .get(start..end)
        .ok_or_else(|| "子书的正文范围无效".into())
}

fn page(
    key: &str,
    index: usize,
    total: usize,
    title: &str,
    chapter: &Chapter,
    source: &str,
) -> String {
    let path = chapter.path.clone();
    let route = format!("/{key}/image/");
    let sanitized = ammonia::Builder::default()
        .add_generic_attributes(&["class"])
        .add_clean_content_tags(&["title", "iframe", "object", "template"])
        .attribute_filter(
            move |element, attribute, value| match (element, attribute) {
                ("img", "src") => {
                    let path = epub::resolve(&path, value).ok()?;
                    text_book::image_mime(&path)?;
                    Some(Cow::Owned(format!(
                        "{route}{}",
                        text_book::encode_path(&path)
                    )))
                }
                (_, "src" | "href") => None,
                _ => Some(Cow::Borrowed(value)),
            },
        )
        .clean(source)
        .to_string()
        .replace("<h1>", "<h2>")
        .replace("<h1 ", "<h2 ")
        .replace("</h1>", "</h2>");
    let link =
        |target: usize, label: &str| format!(r#"<a href="/{key}/chapter/{target}">{label}</a>"#);
    let prev = index
        .checked_sub(1)
        .map_or_else(String::new, |target| link(target, "上一章"));
    let next = if index + 1 < total {
        link(index + 1, "下一章")
    } else {
        String::new()
    };
    let heading = text_book::escape(&chapter.title);
    let repeated = format!("<h2>{heading}</h2>");
    let body = sanitized
        .trim_start()
        .strip_prefix(&repeated)
        .unwrap_or(&sanitized);
    let title = text_book::escape(title);
    let number = index + 1;
    let transcript = include_str!("../reading-transcript.css");
    format!(
        r#"<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{heading} · Leaf 共读</title>
<style>
:root{{color-scheme:light dark;color:#30362f;background:#f6f5f0}}
@media(prefers-color-scheme:dark){{:root{{color:#d1d8cd;background:#242925}}}}
body{{box-sizing:border-box;margin:0 auto;padding:2rem 1.5rem 3rem;max-width:48rem;font:1.125rem/1.85 "Songti SC",Georgia,serif;overflow-wrap:anywhere}}
header,nav,small{{font:0.9rem/1.5 system-ui,sans-serif}}
header{{border-bottom:1px solid currentColor;padding-bottom:.75rem}}
img{{max-width:100%;height:auto}} pre,table{{overflow:auto;max-width:100%}}
nav{{display:flex;gap:1rem;justify-content:space-between;align-items:center;border-top:1px solid currentColor;padding-top:1rem}}
nav a{{color:inherit}} {transcript}
</style>
<header>{title} · Leaf 共读</header>
<main><article aria-label="{heading}"><h1>{heading}</h1>{body}</article></main>
<nav aria-label="章节导航">{prev}<span>第 {number} / {total} 章</span>{next}</nav>
</html>"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coreading_only_serves_requested_section_and_resolves_book_images() {
        let dir = std::env::temp_dir().join(format!("leaf-coreading-{}", super::super::token()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("Book.md");
        fs::write(
            &file,
            "前言段落。\n\n# 第一章\n\n月光正文。 ![图](plate.png)\n\n# 第二章\n\n白鹭正文。",
        )
        .unwrap();
        fs::write(dir.join("plate.png"), b"test raster bytes").unwrap();
        let state = ReaderState {
            session: Mutex::new(None),
            library: Mutex::new(Library::default()),
            storage: dir.join("library.json"),
        };
        let book = open_path(&state, &file).unwrap();
        let token = &book.token;
        let first =
            String::from_utf8(content(&state, token, "key", "chapter/1").unwrap().0).unwrap();
        assert!(first.contains("月光正文"));
        assert!(!first.contains("前言段落"));
        assert!(!first.contains("白鹭正文"));
        assert!(first.contains(r#"href="/key/chapter/2""#));
        assert!(first.contains(r#"src="/key/image/images/plate%2Epng""#));
        assert_eq!(
            content(&state, token, "key", "image/images/plate%2Epng")
                .unwrap()
                .1,
            "image/png"
        );
        assert!(content(&state, token, "key", "image/images/%2e%2e/plate%2Epng").is_err());
        let second =
            String::from_utf8(content(&state, token, "key", "chapter/2").unwrap().0).unwrap();
        assert!(second.contains("白鹭正文"));
        assert!(!second.contains("月光正文"));
        *state.session.lock().unwrap() = None;
        assert!(content(&state, token, "key", "chapter/2").is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn excerpt_cuts_at_child_book_boundaries_and_sanitizes_active_content() {
        let chapter = Chapter {
            title: "Child".into(),
            path: "OEBPS/one.xhtml".into(),
            start_fragment: "start".into(),
            end_fragment: "stop".into(),
        };
        let source = r#"<html><head><title>metadata</title></head><body>before<div><p id="start">keep</p><script>hide-me</script><img src="../pic.jpg" onerror="handler()"/><img src="https://example.invalid/leak.png"/><p id="stop">after</p></div></body></html>"#;
        let html = page(
            "key",
            0,
            1,
            "Root",
            &chapter,
            excerpt(source, &chapter).unwrap(),
        );
        assert!(html.contains("keep"));
        assert!(html.contains("/key/image/pic%2Ejpg"));
        for excluded in [
            "metadata",
            "before",
            "hide-me",
            "handler()",
            "example.invalid",
            "after",
        ] {
            assert!(!html.contains(excluded), "unexpected {excluded}");
        }
    }
}
