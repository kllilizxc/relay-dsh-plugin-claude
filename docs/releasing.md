# Compatibility releases

This repository publishes pinned compatibility archives as GitHub prereleases. It does not configure automatic npm publishing.

Use the public upstream and toolchain recorded in `PROVENANCE.md`. Install from the committed lock with strict peer checking, build against DSH 0.2.1-rc.2, and run the relevant checks. Pack the reviewed tree with `npm pack --ignore-scripts`; inspect all archive contents, including bundled dependencies, and calculate its SHA-256 and SHA-512 before uploading.

Tag the actual source commit as `v<package version>`. Upload the exact archive as `<sha256>.tgz`, together with `SHA256SUMS.txt` and release notes naming the source commit and build provenance. Never replace an existing tag or asset with different bytes.
