use super::*;
use std::{
    io::{Read, Seek},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

static GITHUB: Mutex<()> = Mutex::new(());

#[derive(Debug, PartialEq, Eq)]
struct Repository {
    owner: String,
    name: String,
}

impl Repository {
    fn parse(input: &str) -> Result<Self, String> {
        let invalid = "请输入公开 GitHub 仓库的 HTTPS 地址，例如 https://github.com/owner/repo";
        let path = input
            .trim()
            .strip_prefix("https://github.com/")
            .ok_or(invalid)?;
        let (owner, name) = path.trim_end_matches('/').split_once('/').ok_or(invalid)?;
        let name = name.strip_suffix(".git").unwrap_or(name);
        let valid = |part: &str| {
            !part.is_empty()
                && part.len() <= 100
                && !part.starts_with(['.', '-'])
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        };
        if !valid(owner) || !valid(name) {
            return Err(invalid.into());
        }
        Ok(Self {
            owner: owner.to_ascii_lowercase(),
            name: name.to_ascii_lowercase(),
        })
    }

    fn url(&self) -> String {
        format!("https://github.com/{}/{}.git", self.owner, self.name)
    }
}

fn git(directory: &Path, args: &[&str]) -> Result<String, String> {
    let hooks = tempfile::tempdir().map_err(|e| e.to_string())?;
    let mut output = tempfile::tempfile().map_err(|e| e.to_string())?;
    let mut command = Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
    command
        .current_dir(directory)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", null)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_LFS_SKIP_SMUDGE", "1")
        .args([
            "-c",
            "protocol.allow=never",
            "-c",
            "protocol.https.allow=always",
            "-c",
            "http.followRedirects=false",
            "-c",
            "credential.helper=",
        ])
        .arg("-c")
        .arg(format!("core.hooksPath={}", hooks.path().display()))
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(output.try_clone().map_err(|e| e.to_string())?);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "无法运行 Git，请确认系统已安装 Git")?;
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => {
                return Err("Git 操作失败，请检查公开仓库地址、网络连接或历史是否已改写".into())
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(30)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Git 操作超时".into());
            }
        }
    }
    output.rewind().map_err(|e| e.to_string())?;
    let mut result = String::new();
    output
        .take(4096)
        .read_to_string(&mut result)
        .map_err(|e| e.to_string())?;
    Ok(result.trim().to_string())
}

#[derive(Serialize)]
pub struct Prepared {
    path: String,
    status: &'static str,
}

// Persist chapter identity across reordering when a repository is updated.
fn remap_progress(record: &mut Recent, old: &TextBook, new: &TextBook) {
    let previous = record.progress.chapter;
    let chapter = old.chapters.get(previous).and_then(|chapter| {
        new.chapters
            .iter()
            .position(|item| item.path == chapter.path)
    });
    record.chapters = new.chapters.len();
    record.title = new.title.clone();
    record.progress = match chapter {
        Some(index) => Progress {
            chapter: index,
            fraction: record.progress.fraction,
            book_fraction: None,
        },
        None => Progress::default(),
    };
}

fn prepare(state: &ReaderState, repo: Repository, update: bool) -> Result<Prepared, String> {
    let _guard = GITHUB.lock().map_err(|e| e.to_string())?;
    let parent = state
        .storage
        .parent()
        .ok_or("书库目录不可用")?
        .join("github-books")
        .join(&repo.owner);
    fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
    let destination = parent.join(&repo.name);
    let exists = destination.is_dir();
    let result = |status| {
        Ok(Prepared {
            path: destination.to_string_lossy().to_string(),
            status,
        })
    };
    if exists && !update {
        return result("opened");
    }
    let previous = if exists {
        if !git(&destination, &["status", "--porcelain"])?.is_empty() {
            return Err("仓库有本地改动，已保留，无法自动更新".into());
        }
        let head = git(&destination, &["rev-parse", "HEAD"])?;
        let remote = git(&parent, &["ls-remote", &repo.url(), "HEAD"])?;
        if remote.split_whitespace().next() == Some(head.as_str()) {
            return result("current");
        }
        Some(head)
    } else {
        None
    };
    let temporary = tempfile::tempdir_in(&parent).map_err(|e| e.to_string())?;
    let working = temporary.path().join(&repo.name);
    git(
        temporary.path(),
        &[
            "clone",
            "--quiet",
            "--single-branch",
            "--no-tags",
            "--no-recurse-submodules",
            "--",
            &repo.url(),
            &repo.name,
        ],
    )?;
    let new = TextBook::open(&working, Kind::MarkdownDirectory)?;
    if let Some(head) = previous {
        git(&working, &["merge-base", "--is-ancestor", &head, "HEAD"])
            .map_err(|_| "GitHub 历史无法快进更新，已保留当前版本".to_string())?;
        let old = TextBook::open(&destination, Kind::MarkdownDirectory)?;
        let canonical = destination.canonicalize().map_err(|e| e.to_string())?;
        let mut library = state.library.lock().map_err(|e| e.to_string())?;
        let mut next = library.clone();
        if let Some(record) = next
            .recent
            .iter_mut()
            .find(|r| Path::new(&r.path) == canonical)
        {
            remap_progress(record, &old, &new);
        }
        let backup = temporary.path().join("previous");
        fs::rename(&destination, &backup).map_err(|e| e.to_string())?;
        if let Err(error) = fs::rename(&working, &destination) {
            if fs::rename(&backup, &destination).is_err() {
                return Err(format!(
                    "更新失败；旧版本保留在 {}",
                    temporary.keep().display()
                ));
            }
            return Err(error.to_string());
        }
        if let Err(error) = persist(state, &next) {
            if fs::rename(&destination, &working)
                .and_then(|_| fs::rename(&backup, &destination))
                .is_err()
            {
                return Err(format!(
                    "保存失败；请检查备份 {}",
                    temporary.keep().display()
                ));
            }
            return Err(error);
        }
        *library = next;
        result("updated")
    } else {
        fs::rename(&working, &destination).map_err(|e| e.to_string())?;
        result("added")
    }
}

#[tauri::command]
pub async fn prepare_github_book(
    app: tauri::AppHandle,
    url: String,
    update: bool,
) -> Result<Prepared, String> {
    let repo = Repository::parse(&url)?;
    tauri::async_runtime::spawn_blocking(move || prepare(&app.state::<ReaderState>(), repo, update))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repository_update_keeps_the_same_chapter_after_reordering() {
        let old = tempfile::tempdir().unwrap();
        let new = tempfile::tempdir().unwrap();
        for directory in [&old, &new] {
            fs::write(directory.path().join("b.md"), "# B\n\nSecond chapter").unwrap();
        }
        fs::write(new.path().join("a.md"), "# A\n\nNew first chapter").unwrap();
        let old = TextBook::open(old.path(), Kind::MarkdownDirectory).unwrap();
        let new = TextBook::open(new.path(), Kind::MarkdownDirectory).unwrap();
        let mut record = Recent {
            available: true,
            id: "test".into(),
            path: "test".into(),
            title: old.title.clone(),
            author: String::new(),
            chapters: 1,
            progress: Progress {
                chapter: 0,
                fraction: 0.42,
                book_fraction: Some(0.42),
            },
            opened: 1,
        };
        remap_progress(&mut record, &old, &new);
        assert_eq!(record.chapters, 2);
        assert_eq!(record.progress.chapter, 1);
        assert_eq!(record.progress.fraction, 0.42);
        assert_eq!(record.progress.book_fraction, None);
    }

    #[test]
    fn accepts_only_github_repository_urls() {
        assert_eq!(
            Repository::parse(" https://github.com/OWNER/Book.git/ ")
                .unwrap()
                .url(),
            "https://github.com/owner/book.git"
        );
        for url in [
            "https://github.com.evil/owner/book",
            "https://github.com/../book",
            "https://github.com/owner/book/issues",
            "https://github.com/owner/x?query",
            "file:///owner/book",
        ] {
            assert!(Repository::parse(url).is_err(), "{url}");
        }
    }
}
