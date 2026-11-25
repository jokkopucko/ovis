### Fixed
- `ovis join` with an invite that the account's signed list does not hold as open (revoked, used,
  run out, or made before the list) says so in words, as `invite_invalid`, instead of printing the
  account service's code (`invite_not_in_list`).
