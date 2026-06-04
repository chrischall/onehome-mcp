# Changelog

## [0.12.1](https://github.com/chrischall/onehome-mcp/compare/v0.12.0...v0.12.1) (2026-06-04)


### Bug Fixes

* migrate captureHeaders to [@fetchproxy](https://github.com/fetchproxy) 1.0.0 { host, path?, headerName } ([#71](https://github.com/chrischall/onehome-mcp/issues/71)) ([c455bcc](https://github.com/chrischall/onehome-mcp/commit/c455bcc919cacc1fb14cf347c4f63b08a5d90a22))

## [0.12.0](https://github.com/chrischall/onehome-mcp/compare/v0.11.0...v0.12.0) (2026-05-29)


### Features

* adopt @fetchproxy/server 0.11.0 + @chrischall/realty-core 0.4.1 ([#62](https://github.com/chrischall/onehome-mcp/issues/62)) ([9860799](https://github.com/chrischall/onehome-mcp/commit/9860799f245d6fa1540640795a427803cc37582b))


### Bug Fixes

* **ci:** arm auto-merge from verdict comment when structured_output is empty ([#60](https://github.com/chrischall/onehome-mcp/issues/60)) ([5dda0d3](https://github.com/chrischall/onehome-mcp/commit/5dda0d3ad2354e4d77ff1f2046b938c3172e7dfc))
* **ci:** treat instant-merge race as success in auto-merge arm ([#58](https://github.com/chrischall/onehome-mcp/issues/58)) ([5ea13f0](https://github.com/chrischall/onehome-mcp/commit/5ea13f0da917c21157bf3d4466f2faaab84348fa))
* restore address_alternates by fixing UnparsedAddress placement ([#25](https://github.com/chrischall/onehome-mcp/issues/25)) ([#59](https://github.com/chrischall/onehome-mcp/issues/59)) ([ea8e0a3](https://github.com/chrischall/onehome-mcp/commit/ea8e0a3355891c3c2bcd6aa4450849a626df07aa))
* restore listing fetches (UnparsedAddress schema drift) + fast-fail set_auth on stale tokens ([#56](https://github.com/chrischall/onehome-mcp/issues/56)) ([ee23e76](https://github.com/chrischall/onehome-mcp/commit/ee23e76f3d58d2ecc2dc654ab1fdca1ff5512b5c))

## [0.11.0](https://github.com/chrischall/onehome-mcp/compare/v0.10.0...v0.11.0) (2026-05-29)


### Features

* + enhancement per the first-party-dep convention — a package we own ([a380825](https://github.com/chrischall/onehome-mcp/commit/a38082591bcf1f8c9b2804945347035cf1d9a3e9))
* adopt @chrischall/realty-core 0.4.0 (marina place-name guard) ([#53](https://github.com/chrischall/onehome-mcp/issues/53)) ([6780101](https://github.com/chrischall/onehome-mcp/commit/67801010e9e120a9bfec46843ee926431f4324d9))
* adopt @fetchproxy/server 0.10.0 — drop redundant keepAliveIntervalMs opt-in ([#72](https://github.com/chrischall/onehome-mcp/issues/72)) ([#51](https://github.com/chrischall/onehome-mcp/issues/51)) ([1b48963](https://github.com/chrischall/onehome-mcp/commit/1b4896392b8f97ff1b60dd7ef3886aac59be863c))
* consume @chrischall/realty-core 0.3.1 — drop inline hoisted helpers ([#52](https://github.com/chrischall/onehome-mcp/issues/52)) ([a380825](https://github.com/chrischall/onehome-mcp/commit/a38082591bcf1f8c9b2804945347035cf1d9a3e9))
* **properties:** add derived lot_size_acres ([#82](https://github.com/chrischall/onehome-mcp/issues/82)) ([#49](https://github.com/chrischall/onehome-mcp/issues/49)) ([2957238](https://github.com/chrischall/onehome-mcp/commit/2957238e5b992d20d1f0754d79d456c778329f1a))

## [0.10.0](https://github.com/chrischall/onehome-mcp/compare/v0.9.0...v0.10.0) (2026-05-28)


### Features

* add onehome_resolve_addresses (bulk parity with cohort, closes [#42](https://github.com/chrischall/onehome-mcp/issues/42)) ([#43](https://github.com/chrischall/onehome-mcp/issues/43)) ([9b3634f](https://github.com/chrischall/onehome-mcp/commit/9b3634f007bb9e4606c4353920d4ef91d0711648))
* **resolve:** add search-fallback rung (closes [#44](https://github.com/chrischall/onehome-mcp/issues/44)) ([#47](https://github.com/chrischall/onehome-mcp/issues/47)) ([451e0c1](https://github.com/chrischall/onehome-mcp/commit/451e0c1d8845ff87a1d4bf66d1144b756861dcf7))

## [0.9.0](https://github.com/chrischall/onehome-mcp/compare/v0.8.0...v0.9.0) (2026-05-27)


### Features

* add onehome_bulk_get for unbounded structured fetch ([#29](https://github.com/chrischall/onehome-mcp/issues/29)) ([a885793](https://github.com/chrischall/onehome-mcp/commit/a885793dcceea918c9c7f55c85438ab8e686a827))
* add onehome_get_saved_search_with_listings combo tool ([#33](https://github.com/chrischall/onehome-mcp/issues/33)) ([838d14a](https://github.com/chrischall/onehome-mcp/commit/838d14abc0f09057747629271984f2560f81df33))
* **p0:** default include_description=false + server-side extracted_features ([#28](https://github.com/chrischall/onehome-mcp/issues/28)) ([e161099](https://github.com/chrischall/onehome-mcp/commit/e161099b59fc70150855c54bf7ddacba99b6639c))
* **saved:** default include_listing_ids=true on get_saved_search ([#30](https://github.com/chrischall/onehome-mcp/issues/30)) ([6364041](https://github.com/chrischall/onehome-mcp/commit/6364041283e2eb7ec248637ead50ef3937f6e2c4)), closes [#23](https://github.com/chrischall/onehome-mcp/issues/23)
* support multiple concurrent registered sessions (route by MLS suffix) ([#34](https://github.com/chrischall/onehome-mcp/issues/34)) ([2856ab4](https://github.com/chrischall/onehome-mcp/commit/2856ab4e4d63286dffc7466c7b5629e3cc105890))
* **transport-fetchproxy:** delegate SW lazy-revive to @fetchproxy/server 0.8.0 ([#41](https://github.com/chrischall/onehome-mcp/issues/41)) ([3c026d5](https://github.com/chrischall/onehome-mcp/commit/3c026d5a86fe7da6eade4345dccae1e66f8b4b25))


### Bug Fixes

* **search:** fall back to saved-search path when consumer-share group returns 0 ([#36](https://github.com/chrischall/onehome-mcp/issues/36)) ([946f25d](https://github.com/chrischall/onehome-mcp/commit/946f25d988bef948ceb03fef7dd63c95eca7198d)), closes [#27](https://github.com/chrischall/onehome-mcp/issues/27)
* **transport-fetchproxy:** lazy-revive on SW eviction during capture ([#39](https://github.com/chrischall/onehome-mcp/issues/39)) ([8689413](https://github.com/chrischall/onehome-mcp/commit/8689413236734988a4d08b6d8456971c06a2ce1d))

## [0.8.0](https://github.com/chrischall/onehome-mcp/compare/v0.7.0...v0.8.0) (2026-05-27)


### Features

* **auth:** add onehome_set_auth tool for runtime bearer-setting ([#10](https://github.com/chrischall/onehome-mcp/issues/10)) ([668b70c](https://github.com/chrischall/onehome-mcp/commit/668b70c2fb4a0479f8dcbc6cf432de8534d0405a))


### Bug Fixes

* **transport:** declare capture_request_header capability on bridge ([#9](https://github.com/chrischall/onehome-mcp/issues/9)) ([14022db](https://github.com/chrischall/onehome-mcp/commit/14022dbcd93b32e57db7a636012d8cbe73f1e6dc))

## [0.7.0](https://github.com/chrischall/onehome-mcp/compare/v0.6.0...v0.7.0) (2026-05-27)


### Features

* **by-address:** add onehome_get_by_address resolver ([#7](https://github.com/chrischall/onehome-mcp/issues/7)) ([1fb7d6b](https://github.com/chrischall/onehome-mcp/commit/1fb7d6b1c94f950a5b81ff151d74ab3e8d617b4c))
* **suggestions:** surface url per row in onehome_search_suggestions ([#6](https://github.com/chrischall/onehome-mcp/issues/6)) ([0f4562d](https://github.com/chrischall/onehome-mcp/commit/0f4562d51c8ba9c6cc2bf555905784a58659a470))


### Documentation

* document the canonical PR + release-notes workflow ([#2](https://github.com/chrischall/onehome-mcp/issues/2)) ([a715b43](https://github.com/chrischall/onehome-mcp/commit/a715b43d12846e92bdd5d159eeba9660e96e20ca))
