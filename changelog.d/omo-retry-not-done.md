### Fixed
- An OmO that Ovis started stays RUN while it waits to retry a request the model provider failed,
  instead of reading DONE with a failure alert at the first failed attempt, and reads DONE (or
  failed) once OmO answers or gives up. A retry that shows nothing for over a minute still reads
  DONE, as before.
