use super::*;

#[derive(Clone, Serialize, Deserialize)]
pub struct TextAnchor {
    pub start: usize,
    pub quote: String,
    pub prefix: String,
    pub suffix: String,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MarkStyle {
    Underline,
    Highlight,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ReadingMark {
    id: String,
    chapter: usize,
    path: Option<String>,
    start_fragment: Option<String>,
    fraction: f64,
    anchor: Option<TextAnchor>,
    style: MarkStyle,
    note: String,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum Edit {
    Add {
        chapter: usize,
        fraction: f64,
        anchor: Option<TextAnchor>,
        style: MarkStyle,
        note: String,
    },
    Update {
        id: String,
        style: MarkStyle,
        note: String,
    },
    Remove {
        id: String,
    },
}

fn note_text(note: String) -> Result<String, String> {
    if note.chars().count() > 4000
        || note
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err("批注和书签备注最多 4000 字".into());
    }
    Ok(note.trim().to_string())
}

#[tauri::command]
pub fn edit_reading_marks(
    state: tauri::State<ReaderState>,
    token: String,
    edit: Edit,
) -> Result<Vec<ReadingMark>, String> {
    let active = state.session.lock().map_err(|e| e.to_string())?;
    let session = active
        .as_ref()
        .filter(|session| session.token == token)
        .ok_or("书籍已关闭")?;
    let mut library = state.library.lock().map_err(|e| e.to_string())?;
    let mut next = library.clone();
    let marks = next
        .reading_marks
        .entry(item_key(&session.id, session.part_id.as_deref()))
        .or_default();
    match edit {
        Edit::Add {
            chapter,
            fraction,
            anchor,
            style,
            note,
        } => {
            let (path, start_fragment) = match &session.book {
                SessionBook::Pdf(pdf) if anchor.is_none() && chapter < pdf.pages => (None, None),
                SessionBook::Comic(comic) if anchor.is_none() && chapter < comic.len() => {
                    (None, None)
                }
                _ => {
                    let section = session.view_chapters.get(chapter).ok_or("阅读位置无效")?;
                    (
                        Some(section.path.clone()),
                        (!section.start_fragment.is_empty()).then(|| section.start_fragment.clone()),
                    )
                }
            };
            if !fraction.is_finite() || !(0. ..=1.).contains(&fraction) {
                return Err("阅读位置无效".into());
            }
            if anchor.as_ref().is_some_and(|selection| {
                selection.quote.trim().is_empty()
                    || selection.quote.encode_utf16().count() > 2000
                    || selection.prefix.encode_utf16().count() > 80
                    || selection.suffix.encode_utf16().count() > 80
            }) {
                return Err("请选择 1–2000 字以内的正文".into());
            }
            if marks.len() >= 2000 {
                return Err("此书已达到 2000 条书签和批注上限".into());
            }
            marks.push(ReadingMark {
                id: uuid::Uuid::new_v4().to_string(),
                chapter,
                path,
                start_fragment,
                fraction,
                anchor,
                style,
                note: note_text(note)?,
            });
        }
        Edit::Update { id, style, note } => {
            let mark = marks
                .iter_mut()
                .find(|mark| mark.id == id)
                .ok_or("书签或批注已不存在")?;
            mark.style = style;
            mark.note = note_text(note)?;
        }
        Edit::Remove { id } => marks.retain(|mark| mark.id != id),
    }
    let result = marks.clone();
    persist(&state, &next)?;
    *library = next;
    Ok(result)
}
