### Added
- Connect a device lists the other PCs on your Tailscale whose Ovis already lets this PC in as your
  own login, and Add PC adds one through the relay in one tap: this PC asks that PC for its code over
  Tailscale and checks that the relay found the same PC. PCs of another login, tagged nodes and phones
  are never asked, and Tailscale alone never adds a PC to your account.
