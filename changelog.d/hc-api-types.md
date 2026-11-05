### Maintenance
- herdr-core (`hc`) calls are typed from hc's own OpenRPC schema, generated with
  `bun run generate:types` like herdr's wire types. The schema is held to the hc version CI pins,
  and the herdr-core live contract fails when that hc publishes a different one.
