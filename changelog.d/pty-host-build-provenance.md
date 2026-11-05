### Maintenance
- Releases now sign the build provenance of each Rust PTY host binary, so anyone can check with
  `gh attestation verify --repo devswha/ovis` that it was built by this repository's workflow.
