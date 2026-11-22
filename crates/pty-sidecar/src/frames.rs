
use serde_json::Value;

#[derive(Debug, PartialEq, Eq)]
pub enum Frame {
    /// `{"t":"i","d":"<text>"}`: text to write into the pty
    Input(String),
    /// `{"t":"r","c":<cols>,"r":<rows>}`: the new size, clamped to 1..=1000
    Resize(u16, u16),
    /// `{"t":"p","paused":true|false}`: stop or resume reading output
    Pause(bool),
    /// `{"t":"w"}`: SIGWINCH to the child at its current size
    Winch,
}

pub fn parse(line: &str) -> Option<Frame> {
    let mut value: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        // JSON.stringify writes a lone surrogate as an escape, which serde_json refuses
        Err(_) => serde_json::from_str(&replace_lone_surrogates(line)?).ok()?,
    };
    match value.get("t")?.as_str()? {
        // moved out, not copied: a frame can be 16 MiB
        "i" => match value.get_mut("d").map(Value::take) {
            Some(Value::String(text)) => Some(Frame::Input(text)),
            _ => None,
        },
        "r" => Some(Frame::Resize(js_dimension(value.get("c")), js_dimension(value.get("r")))),
        "p" => Some(Frame::Pause(value.get("paused")?.as_bool()?)),
        "w" => Some(Frame::Winch),
        _ => None,
    }
}

/// JavaScript's `parseInt(text, 10)`: leading whitespace, a sign, then digits; None without digits.
pub fn js_parse_int(text: &str) -> Option<i64> {
    let text = text.trim_start();
    let (negative, digits) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let end = digits.bytes().position(|byte| !byte.is_ascii_digit()).unwrap_or(digits.len());
    if end == 0 {
        return None;
    }
    let magnitude = digits[..end].parse::<i64>().unwrap_or(i64::MAX);
    Some(if negative { -magnitude } else { magnitude })
}

pub fn initial_size(text: &str, fallback: u16) -> u16 {
    match js_parse_int(text) {
        Some(value) if value > 0 => value.min(i64::from(u16::MAX)) as u16,
        _ => fallback,
    }
}

/// pty-host.mjs's `clamp`: `parseInt(String(value), 10)`, below 1 (or no number) is 1, above 1000 is 1000.
/// Except a float String() writes with an exponent (2e21, 5e-7): parseInt takes its leading digits, this 1.
fn js_dimension(value: Option<&Value>) -> u16 {
    let parsed = match value {
        Some(Value::Number(number)) => match number.as_i64() {
            Some(int) => Some(int),
            // String() of a float under 1e21 is its decimal form, which parseInt cuts at the point
            None => number.as_f64().filter(|float| float.abs() < 1e21).map(|float| float.trunc() as i64),
        },
        Some(Value::String(text)) => js_parse_int(text),
        _ => None,
    };
    parsed.unwrap_or(1).clamp(1, 1000) as u16
}

/// JavaScript's JSON.parse accepts those and writing the string out as UTF-8 turns each into U+FFFD.
pub fn replace_lone_surrogates(json: &str) -> Option<String> {
    let bytes = json.as_bytes();
    let unit_at = |at: usize| -> Option<u32> {
        if bytes.get(at) != Some(&b'\\') || bytes.get(at + 1) != Some(&b'u') {
            return None;
        }
        let hex = json.get(at + 2..at + 6)?;
        u32::from_str_radix(hex, 16).ok()
    };
    let mut out = String::new();
    let mut copied = 0;
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] != b'\\' {
            at += 1;
            continue;
        }
        let Some(unit) = unit_at(at) else {
            // any other escape is two bytes: never read its second byte as the start of one
            at += 2;
            continue;
        };
        let paired = (0xD800..0xDC00).contains(&unit) && unit_at(at + 6).is_some_and(|low| (0xDC00..0xE000).contains(&low));
        if paired {
            at += 12;
        } else if (0xD800..0xE000).contains(&unit) {
            out.push_str(&json[copied..at]);
            out.push_str("\\ufffd");
            at += 6;
            copied = at;
        } else {
            at += 6;
        }
    }
    if copied == 0 {
        return None;
    }
    out.push_str(&json[copied..]);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_every_frame() {
        assert_eq!(parse(r#"{"t":"i","d":"ls\r"}"#), Some(Frame::Input("ls\r".into())));
        assert_eq!(parse(r#"{"t":"i","d":"\u001b[A한🙂"}"#), Some(Frame::Input("\u{1b}[A한🙂".into())));
        assert_eq!(parse(r#"{"t":"r","c":93,"r":37}"#), Some(Frame::Resize(93, 37)));
        assert_eq!(parse(r#"{"t":"p","paused":true}"#), Some(Frame::Pause(true)));
        assert_eq!(parse(r#"{"t":"p","paused":false}"#), Some(Frame::Pause(false)));
        assert_eq!(parse(r#"{"t":"w"}"#), Some(Frame::Winch));
    }

    #[test]
    fn ignores_what_the_node_host_ignores() {
        assert_eq!(parse("not json"), None);
        assert_eq!(parse(r#"{"t":"i","d":5}"#), None);
        assert_eq!(parse(r#"{"t":"p","paused":"yes"}"#), None);
        assert_eq!(parse(r#"{"t":"x"}"#), None);
        assert_eq!(parse(r#"["t","i"]"#), None);
    }

    #[test]
    fn clamps_sizes_as_parse_int_does() {
        assert_eq!(parse(r#"{"t":"r","c":0,"r":-3}"#), Some(Frame::Resize(1, 1)));
        assert_eq!(parse(r#"{"t":"r","c":5000,"r":1000}"#), Some(Frame::Resize(1000, 1000)));
        assert_eq!(parse(r#"{"t":"r","c":93.9,"r":"41px"}"#), Some(Frame::Resize(93, 41)));
        assert_eq!(parse(r#"{"t":"r","c":null}"#), Some(Frame::Resize(1, 1)));
        assert_eq!(parse(r#"{"t":"r","c":1e300,"r":true}"#), Some(Frame::Resize(1, 1)));
    }

    #[test]
    fn takes_initial_sizes_from_argv() {
        assert_eq!(initial_size("120", 80), 120);
        assert_eq!(initial_size(" 33rows", 24), 33);
        assert_eq!(initial_size("0", 80), 80);
        assert_eq!(initial_size("-4", 24), 24);
        assert_eq!(initial_size("wide", 80), 80);
        assert_eq!(initial_size("999999", 80), u16::MAX);
    }

    #[test]
    fn writes_a_lone_surrogate_as_the_replacement_character() {
        assert_eq!(parse(r#"{"t":"i","d":"a\ud83db"}"#), Some(Frame::Input("a\u{fffd}b".into())));
        assert_eq!(parse(r#"{"t":"i","d":"\udc00\ud83d"}"#), Some(Frame::Input("\u{fffd}\u{fffd}".into())));
        assert_eq!(parse(r#"{"t":"i","d":"\ud83d\ude42\ud83d"}"#), Some(Frame::Input("🙂\u{fffd}".into())));
        assert_eq!(replace_lone_surrogates(r#"{"d":"\\ud83d"}"#), None);
        assert_eq!(replace_lone_surrogates(r#"{"d":"plain"}"#), None);
    }
}
