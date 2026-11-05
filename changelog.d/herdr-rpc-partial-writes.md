### Fixed
- Large prompts finish sending when the herdr socket accepts only part of a request, instead of
  timing out with a truncated frame. Failures after connecting no longer mark a prompt answer as
  safe to retry.
