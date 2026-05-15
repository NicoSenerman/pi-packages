# Changelog

## [2.0.0](https://github.com/gotgenes/pi-github-tools/compare/v1.0.2...v2.0.0) (2026-05-15)


### ⚠ BREAKING CHANGES

* config directory has changed from   ~/.pi/agent/extensions/@gotgenes/pi-github-tools/config.json to   ~/.pi/agent/extensions/pi-github-tools/config.json Move your existing config file to the new location.

### Bug Fixes

* revert package.json author change ([f3c8225](https://github.com/gotgenes/pi-github-tools/commit/f3c82252b6d871cc12d0f11ac40d35d6d812b6e4))
* use pi-github-tools (not scoped name) as config directory ([b850843](https://github.com/gotgenes/pi-github-tools/commit/b85084302aeec93a7082b2b34ad5335d17382dfe))


### Documentation

* add badges to README ([c8edf0d](https://github.com/gotgenes/pi-github-tools/commit/c8edf0d6549442bda4d23741471ba69a6e29baa9))
* add pnpm badge to README ([83cfa93](https://github.com/gotgenes/pi-github-tools/commit/83cfa930cd6534d31468895941a4a371d7a55c47))


### Miscellaneous Chores

* update license copyright to Christopher D. Lasher ([17decb7](https://github.com/gotgenes/pi-github-tools/commit/17decb7766c2f28c2cb7c72bcda7aa5b8f0258b8))

## [1.0.2](https://github.com/gotgenes/pi-github-tools/compare/v1.0.1...v1.0.2) (2026-05-15)


### Bug Fixes

* correct merge defaults and agentDir path ([ff1b1b5](https://github.com/gotgenes/pi-github-tools/commit/ff1b1b54640e4fe7449e73645a891f466bd2b9ed))
* fetch remote tags before polling in watchRelease ([00acae4](https://github.com/gotgenes/pi-github-tools/commit/00acae48c3080c8a9b3158af1315b14a2259185d))

## [1.0.1](https://github.com/gotgenes/pi-github-tools/compare/v1.0.0...v1.0.1) (2026-05-14)


### Bug Fixes

* use git for non-gh commands and add configurable merge method ([0eaecad](https://github.com/gotgenes/pi-github-tools/commit/0eaecadedfab661d27634506648603f61823f2b1))


### Miscellaneous Chores

* add pi-autoformat config for biome ([685f010](https://github.com/gotgenes/pi-github-tools/commit/685f0105d480de2a255fee2c5612db50f9fe563e))

## 1.0.0 (2026-05-14)


### Features

* add CI business logic (findRun, watchRun, listRuns) ([e74dea4](https://github.com/gotgenes/pi-github-tools/commit/e74dea41fcb39ab581b8464bb0ff53f61d93ef42))
* add CI helper functions (findRetryDelay, formatProgress) ([77906b0](https://github.com/gotgenes/pi-github-tools/commit/77906b02a0911c0b7dc2f16c5fec9e574579b07e))
* add GitHub helpers with auto repo detection ([e619711](https://github.com/gotgenes/pi-github-tools/commit/e61971105709452823b4013972ca89ade359237c))
* add issue close business logic ([4c0316b](https://github.com/gotgenes/pi-github-tools/commit/4c0316bc0c5d15110054a1812dbbb9cff7c4855e))
* add Pi progress adapter ([7f4cada](https://github.com/gotgenes/pi-github-tools/commit/7f4cada21e53fb9fb145088b5f4e8380a170c607))
* add process helpers (runCommand, sleep) ([23c9c21](https://github.com/gotgenes/pi-github-tools/commit/23c9c218f95ce58a8f19fc243821657a22aad3ac))
* add release business logic (findReleasePR, mergeReleasePR, watchRelease) ([36db89e](https://github.com/gotgenes/pi-github-tools/commit/36db89e7e05b7da41ece55cd1561dc5142df07b6))
* register all tools via Pi extension entry point ([8f8cc9d](https://github.com/gotgenes/pi-github-tools/commit/8f8cc9d9987957a6b1fcace05dac8d56b7140e57))


### Bug Fixes

* search release-please PRs by label instead of title ([7c45ea5](https://github.com/gotgenes/pi-github-tools/commit/7c45ea58ba23b0e54c6cbc225ff8e3bedf832e05))


### Documentation

* add README with tool reference and setup instructions ([7133ee8](https://github.com/gotgenes/pi-github-tools/commit/7133ee807ebf6aba6d213f8cc7624fb1e96c7e07))


### Miscellaneous Chores

* initialize pi-github-tools repo with project scaffolding ([bae3dcc](https://github.com/gotgenes/pi-github-tools/commit/bae3dcc217363d2ebbdf61b88b1db74ec3fb6816))
