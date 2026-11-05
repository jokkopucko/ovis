### Fixed
- A pane moved to another workspace from outside this browser (herdr's own window, another browser)
  is followed by every browser: the selection and either half of a split go to its new ID, and its
  draft, held terminal input, lens, reply comments, pending messages, sidebar pin, place in the chat
  and read finishes go with it. Nothing held is sent: it waits for its Send or Discard.
