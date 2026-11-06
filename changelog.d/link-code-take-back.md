### Fixed
- `link --code` takes its code back when it is ended by SIGTERM or by its terminal closing, not
  only by Ctrl+C, and takes back only the code it showed: a pairing started since in Settings or
  on another device keeps working.
- `link` keeps this PC in the account's list when renewing the listing loses the answer to its
  removal.
