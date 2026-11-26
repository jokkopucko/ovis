### Maintenance
- The tests' own herdr session no longer runs the herdr plugins you installed: an installed Ovis
  plugin's startup hook used to start your own Ovis from inside the test session. The test herdr
  now reads a config folder of its own, at the same socket.
