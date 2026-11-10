### Fixed
- A password asked by `git` over HTTPS (`Password for 'https://you@host':`), a key passphrase asked
  by `ssh-add` or `ssh-keygen` (`Enter passphrase for /home/you/.ssh/id_ed25519:`) and the password
  of an SSH host given as an IPv6 address are masked prompts now, as `sudo`'s and `ssh`'s already
  were: the **Password or PIN** field takes the input line's place, what is typed is kept out of
  drafts, and a queued or inserted message is no longer typed into the prompt. A key whose path has
  `y/n` or a colon in it (`/home/andy/notes/key`, `/keys/id:work`) is recognized too. With a PC not
  yet updated the field still answers the prompt: its text is typed into the terminal directly.
