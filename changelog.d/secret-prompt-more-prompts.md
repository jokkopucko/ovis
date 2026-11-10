### Fixed
- More password requests are masked prompts: an interactive ssh sign-in (`(you@host) Password:`),
  `doas`, `sudo` in any language and sudo-rs, `passwd`, `mysql`, gpg's `Passphrase:` and openssl's
  `Enter PEM pass phrase:`.
- The **Password or PIN** field leaves once the program has read its answer, even while its prompt is
  still the last text on the screen (git signing in, `sudo` running a quiet command): a second Send
  there could wait in the terminal and reach the shell. With a PC not yet updated the field says that
  what you type goes to the terminal unchecked.
