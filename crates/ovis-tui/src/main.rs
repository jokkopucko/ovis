//! The screen is hc-tui (https://github.com/followcat/hc-tui), run with the settings below.
mod args;

use std::ffi::{OsStr, OsString};
use std::os::unix::net::UnixStream;
use std::process::ExitCode;

use hc_proto::endpoint::{self, Endpoint, Sys};
use hc_tui::embed::Embed;

fn main() -> ExitCode {
    // SAFETY: the first thing the program does, while it is the only thread
    unsafe { forget_ovis_secrets() };
    let options = match args::parse(std::env::args().skip(1)) {
        Ok(args::Action::Help) => {
            println!("{}", args::help());
            return ExitCode::SUCCESS;
        }
        Ok(args::Action::Version) => {
            println!("{}", args::version());
            return ExitCode::SUCCESS;
        }
        Ok(args::Action::Run(options)) => options,
        Err(message) => {
            eprintln!("ovis-tui: {message}");
            eprintln!("Try 'ovis-tui --help'.");
            return ExitCode::from(2);
        }
    };
    match run(&options) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("ovis-tui: {message}");
            ExitCode::FAILURE
        }
    }
}

/// Whatever this program starts inherits its environment, and an Ovis token a caller exported must
/// not reach it.
///
/// # Safety
/// Call it before any thread exists: it changes the process's environment.
unsafe fn forget_ovis_secrets() {
    for name in ["OVIS_TOKEN", "OVIS_URL", "HERDR_WEB_TOKEN"] {
        // SAFETY: the caller guarantees no other thread reads or writes the environment yet
        unsafe { std::env::remove_var(name) };
    }
}

fn run(options: &args::Options) -> Result<(), String> {
    let mut env = endpoint::env_snapshot();
    // hc-tui's own release check would send this program's users to "hc-tui --upgrade"
    env.insert(
        OsString::from("HC_TUI_NO_UPDATE_CHECK"),
        OsString::from("1"),
    );
    let session = options.session.as_deref().map(OsStr::new);
    let endpoint = endpoint::resolve(&env, session, None, &Sys)
        .map_err(|error| format!("herdr-core endpoint: {error}"))?;
    if let Some(down) = core_down(&endpoint) {
        return Err(down);
    }
    let embed = Embed {
        // nothing typed while a terminal's connection is down is sent once it is back
        discard_input_on_recovery: true,
        solo_on_narrow: true,
        // Ovis never starts an engine on its own: a core started here would also inherit this
        // program's environment
        no_core_start: true,
        hide_version_badge: true,
    };
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("runtime: {error}"))?
        .block_on(hc_tui::cli::run_embedded(&endpoint, &env, embed))
}

fn core_down(endpoint: &Endpoint) -> Option<String> {
    let Endpoint::Local(local) = endpoint else {
        return None;
    };
    if UnixStream::connect(&local.socket).is_ok() {
        return None;
    }
    let start = if local.session == "default" {
        "hc server start".to_owned()
    } else {
        format!("HC_SESSION={} hc server start", shell_word(&local.session))
    };
    Some(format!("herdr-core is not running. Start it with: {start}"))
}

/// `word` as it is pasted into a shell: single-quoted unless it is a plain word.
fn shell_word(word: &str) -> String {
    let plain = !word.is_empty()
        && word
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'));
    if plain {
        word.to_owned()
    } else {
        format!("'{}'", word.replace('\'', r"'\''"))
    }
}

#[cfg(test)]
mod tests {
    use super::shell_word;

    #[test]
    fn a_session_name_is_pasted_as_one_shell_word() {
        assert_eq!(shell_word("work-2.b_c"), "work-2.b_c");
        assert_eq!(shell_word("my session"), "'my session'");
        assert_eq!(shell_word("it's; rm"), r"'it'\''s; rm'");
        assert_eq!(shell_word(""), "''");
    }
}
