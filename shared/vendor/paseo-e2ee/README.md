# Paseo endpoint encryption

Source: https://github.com/getpaseo/paseo
Commit: `1aef1ec6625f2c32cbd62cfbeb02cffb43a275d2`

Do not edit; update by re-vendoring.

Run `bun scripts/vendor-paseo.ts 1aef1ec6625f2c32cbd62cfbeb02cffb43a275d2` from the repository root.
An existing clean checkout can be supplied with PASEO_SOURCE_DIR.
Sources and LICENSE are byte-identical. tsconfig.json retains upstream compiler policy,
with rootDir/include/exclude adapted to the flattened layout and composite enabled
so the root project consumes declarations instead of applying its stricter indexing policy.

| File | SHA-256 |
| --- | --- |
| `e2ee.ts` | `70504448f5e6f685dba572a31d2fa5e87cd7dbd88a2bcba797fb13c6409475f2` |
| `secure-channel.ts` | `82baf0c15de951ec574329a61115d87c848ed98dff09b320395f9d9087074ae7` |
| `protected-records.ts` | `4405226de9f052df471370c79a5bae89b7d6040eafcff740f7a4689f2c63bdd7` |
| `encrypted-channel.ts` | `2b0d31520917d24993644fc30f065be4d46d3517475f8821388a2263ced3e6a6` |
| `crypto.ts` | `309d5cb94ceb236ced93a188d0a0bc3b42a0e347815b4dbe6679374d810db845` |
| `base64.ts` | `74d69461af9727aa3fb70b37ee50ae54e467e1eebf26fb0356453557094137e7` |
| `noise/index.ts` | `24faa17b926bf7b994ce4370f3d36d15f95c135c32fb479fc38f00e62c5f858e` |
| `noise/cipher-state.ts` | `51283ef7f08e427f5bd5c28e3168e61e2f32e57c479af80d9cfe3d1340357aaf` |
| `noise/symmetric-state.ts` | `a3ae574c7667c44ba9bb784dd2313d705c507ef8ab741e7f111560939126b4c6` |
| `noise/fixtures/nk-25519-chachapoly-sha256.json` | `83d375592fa04ac47fc933ccad71974a397002c04b9ac6ae360db0921343d1d5` |
| `LICENSE` | `79d5aedce6aa0adc547336dc1bd34c5cc9308ba110fac7079ed97515ee573ad3` |
| `tsconfig.json` | `8b504ff9b310e67a4e6c3637b48342c3d7bd572a2a71da45704c78a3ae19bd53` |
