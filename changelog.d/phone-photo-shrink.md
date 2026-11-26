### Fixed
- A JPEG or HEIC photo is shrunk to at most 2048 pixels a side before it uploads, so it uploads
  much faster, without its location, device and date. If the browser cannot redraw a JPEG but
  can read its markers, only JFIF, its color profile and valid orientation are kept alongside
  the image. If neither works, or a HEIC cannot be redrawn, the original file is sent unchanged.
