#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    Help,
    Version,
    Run(Options),
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Options {
    pub session: Option<String>,
}

pub fn parse(args: impl IntoIterator<Item = String>) -> Result<Action, String> {
    let mut options = Options::default();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) if name.starts_with("--") => {
                (name.to_owned(), Some(value.to_owned()))
            }
            _ => (arg, None),
        };
        match name.as_str() {
            "-h" | "--help" => return Ok(Action::Help),
            "-V" | "--version" => return Ok(Action::Version),
            "--session" => {
                let value = inline
                    .or_else(|| args.next())
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "--session needs a value".to_owned())?;
                options.session = Some(value);
            }
            other => return Err(format!("unexpected argument '{other}'")),
        }
    }
    Ok(Action::Run(options))
}

pub fn version() -> String {
    format!("ovis-tui {}", env!("CARGO_PKG_VERSION"))
}

pub fn help() -> String {
    format!(
        "\
{}
herdr-core's terminals in this terminal, as herdr shows them: the sidebar of workspaces and
agents with their state, tabs, splits and herdr's keys (from your herdr config). Ctrl+B q
(herdr's detach key) leaves. It never starts a core: when none runs, it says how to start one.

Usage: ovis-tui [OPTIONS]

Options:
      --session <NAME>  herdr-core session (default: $HC_SESSION or \"default\")
  -h, --help            print this help
  -V, --version         print the version

The screen is hc-tui (https://github.com/followcat/hc-tui, Apache-2.0) with a few small
changes of ours. Not affiliated with or endorsed by hc-tui or the Herdr project.",
        version()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(args: &[&str]) -> Result<Action, String> {
        parse(args.iter().map(|arg| (*arg).to_owned()))
    }

    #[test]
    fn the_session_comes_as_its_own_word_or_after_an_equals_sign() {
        let named = |name: &str| {
            Ok(Action::Run(Options {
                session: Some(name.to_owned()),
            }))
        };
        assert_eq!(parsed(&["--session", "work"]), named("work"));
        assert_eq!(parsed(&["--session=work"]), named("work"));
        assert_eq!(parsed(&[]), Ok(Action::Run(Options::default())));
    }

    #[test]
    fn help_and_version_win_and_anything_unknown_is_refused() {
        assert_eq!(parsed(&["--session", "x", "-h"]), Ok(Action::Help));
        assert_eq!(parsed(&["-V"]), Ok(Action::Version));
        assert!(parsed(&["--session"]).is_err());
        assert!(parsed(&["--url", "http://x"]).is_err());
    }
}
