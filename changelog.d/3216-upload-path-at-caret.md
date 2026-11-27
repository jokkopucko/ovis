### Fixed
- Chat: a pasted, picked or dropped image's path goes where it was pasted or picked (a drop: the
  start), following what is typed while it uploads, instead of always at the start of the message.
  Focus and the selection stay as they were, files picked together keep their order, and an edit
  in the box never puts the path inside a word. Erasing or typing over an image's path detaches
  the image from the message (undo brings both back), and a draft replaced while an image uploads
  never gets its path.
