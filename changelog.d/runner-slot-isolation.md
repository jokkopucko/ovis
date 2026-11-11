### Maintenance
- Self-hosted CI runner: each runner slot has a docker network of its own. The runners of a PC
  shared one loopback so that `scripts/check.ts`'s slots, which are loopback ports, bounded the
  herdr-backed lanes of all of them, and a job on one slot could reach a server another job's tests
  kept there with no token, type into a pane behind it, and so run commands in that job's
  container. The slots are now lock files in a volume every runner mounts (`CHECK_SLOTS_DIR`), held
  with `flock`, with the same limit, queue and holder names. On such a launcher a herdr-backed lane
  of a commit from before stops at once and says to take main in. The launcher must be copied and
  restarted on each runner PC.
- Self-hosted CI runner: the launcher waits two seconds before every container of a slot, the first
  after its own start included, so the build cache never takes a job of a container that was killed
  with the launcher for the job of the container after it.
