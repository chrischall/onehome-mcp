# Changelog

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
