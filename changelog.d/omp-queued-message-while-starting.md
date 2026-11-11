### Fixed
- A message the queue sends to an omp that is still starting (a new workspace's first message, a
  queued message, **Send now**) waits until omp takes input, as a message sent at once already did,
  for an omp that runs herdr's omp integration. Typed earlier, on a slow start, it stayed in omp's
  input box and never ran while its row said sent. Its row says **Waiting for omp to start…**
  meanwhile; a message sent from the chat in that time goes behind it, and once anything is typed in
  the terminal (also with its input line) the waiting messages, and the ones sent until omp has
  started, are held for you to send, rather than sent together with it.
- A new workspace's first message whose pane closed while it was being sent goes with that pane,
  instead of turning up, held, in the next pane that got its id.
