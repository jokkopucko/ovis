### Fixed
- A Mac's PC load in the sidebar shows its memory meter: memory in use is read from `vm_stat` as
  Activity Monitor's Memory Used (App Memory, wired and compressed), so the file cache is not counted.
