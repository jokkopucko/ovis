### Added
- `ovis agent` works in a pane started outside Ovis (`hc run omo`, for one) on Linux: the first call
  asks you on a card to allow that pane, and Settings → Agents lists the panes you allowed, each
  with Remove. Ovis checks with the kernel and herdr-core that the call really comes from that
  pane. The grant ends when the pane closes.
