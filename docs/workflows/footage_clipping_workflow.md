# Private footage library and short clips

This opt-in development workflow supports both TorBox and Real-Debrid alongside local MP4/MKV files. It registers exact sources, searches local SRT/VTT dialogue timestamps, and extracts one 3–5 second review clip, silent by default with source audio available as an explicit option. It does **not** change the Goldflow episode stage registry, create episode directories, automatically assemble recaps, or publish anything. Clip approval is library-only; clips remain `production_eligible: false` until a separately designed production integration exists.

## Keys

From the repository root:

```sh
node bin/goldflow.mjs footage init
```

Edit `/Users/joel/anifactory-goldflow/.env.footage.local` (or `.env.footage.local` in another checkout):

```dotenv
GOLDFLOW_TORBOX_API_KEY=your_torbox_key
GOLDFLOW_REAL_DEBRID_API_KEY=your_real_debrid_key
```

Get keys from your [TorBox account settings](https://torbox.app/settings) and [Real-Debrid API token page](https://real-debrid.com/apitoken). Either key may be blank. No subtitle-service key is needed: this version reads subtitle files you supply. Do not paste keys into chat, command arguments, tracked files, or screenshots.

`init` creates a gitignored, owner-readable (`0600`) file and never overwrites an existing one. The tracked `.env.footage.example` contains blank settings only. Environment variables with these exact names override the file, including an explicitly empty variable. This is a small dotenv parser, not executable shell configuration; it does not expand variables or accept arbitrary settings. Credentials and signed media URLs stay out of saved source/clip receipts. FFmpeg subprocesses do not inherit provider keys and see only a private loopback URL, never the provider URL.

```sh
node bin/goldflow.mjs footage config
node bin/goldflow.mjs footage accounts
node bin/goldflow.mjs footage list --provider both --limit 20 --offset 0
```

`config` checks key presence and FFmpeg/ffprobe availability locally; it does not authenticate. `accounts` and `list` make real account requests. Account checks report safe subscription/status fields, not full user profiles. Listing reports your account's torrent files, not a searchable catalog of every movie. Pagination counts source torrents, so a page can contain more file rows than `--limit`.

Empty Real-Debrid lists may return HTTP `204` rather than `[]`; this is a valid empty inventory. TorBox may return an unfinished source with `files: null`; listing reports it separately as pending with zero available file rows. It never invents a file ID or assumes such a source is ready. Missing file metadata on an allegedly completed and present source still fails closed.

## Register an exact ready source

Use only sources you have a valid basis to access and use. The explicit rights note records your assertion; the program does not determine permissions or guarantee that a short review excerpt is lawful or publishable.

Copy exact `source_id` and `file_id` values from `footage list`. Registration resolves an already-ready file to verify metadata but does not download its media:

```sh
node bin/goldflow.mjs footage register --provider torbox --source-id 123 --file-id 0 --title "My film" --edition "Exact release filename / cut / frame rate" --rights-confirmed true --rights-note "My permission or license basis"
```

Use `--provider real_debrid` with the Real-Debrid IDs to use that account instead. Real-Debrid must already have the exact file selected and downloaded. Registration and extraction never silently select files or start acquisition. Native MP4/MKV only: archives, HLS/DASH playlists, split files, and ambiguous identities are refused.

For a local source:

```sh
node bin/goldflow.mjs footage register --file /absolute/path/owned-film.mp4 --title "My film" --edition "Exact local edition" --rights-confirmed true --rights-note "My permission or license basis"
```

The result includes `source_path`. Sources, searches, and clips default to `~/AniFactoryData/footage_library` (or `$ANIFACTORY_DATA_ROOT/footage_library`). `--library-dir /absolute/path` overrides the artifact location for register/search/extract; paths containing an `episodes` component are rejected. Existing source manifests and completed clips are immutable. Local registration hashes the entire local source. Remote registration binds provider, source/file IDs, reported torrent hash, filename, and size; this is **not** a locally verified whole-file checksum or proof that a subtitle release matches.

## Find dialogue, then extract

```sh
node bin/goldflow.mjs footage search --source /absolute/path/source.json --subtitles /absolute/path/film.srt --query "open the door"
```

Results are ranked local phrase/word matches with cue IDs and timestamps. They are candidates, not visual scene recognition. Dialogue-free scenes cannot be found by dialogue search. The subtitle text is never sent to an AI or external search API. UTF-8 SRT and WebVTT are supported; incompatible encodings must be converted first.

Subtitle files must match the exact cut/release. If preview shows a known synchronization issue, rerun the search with `--subtitle-offset-sec 1.25` and/or `--subtitle-scale 1.001`. The formula is `video_time = subtitle_time * scale + offset`. Negative adjusted cues are omitted. Timing stays explicitly unverified until you preview the result; no offset is guessed automatically.

```sh
node bin/goldflow.mjs footage extract --source /absolute/path/source.json --search-report /absolute/path/search.json --candidate-id cue_000001 --duration-sec 4
```

Alternatively, supply a known movie timestamp:

```sh
node bin/goldflow.mjs footage extract --source /absolute/path/source.json --start-sec 125.4 --duration-sec 4
```

The extractor produces a silent H264/yuv420p MP4 and adjacent `receipt.json` by default (`--keep-audio false`, or omit the flag). It re-encodes from the requested position rather than copying an arbitrary keyframe-aligned segment. Container/frame-rate rounding allows up to 0.15 seconds of duration tolerance. Embedded subtitle streams, chapters, and input metadata are omitted; subtitles already burned into the picture remain visible. Your approved narration/audio lane is unchanged.

To include source audio for the same short excerpt:

```sh
node bin/goldflow.mjs footage extract --source /absolute/path/source.json --start-sec 125.4 --duration-sec 4 --keep-audio true
```

This explicitly selects the source's first audio track (`0:a:0`) and re-encodes it as AAC at 192 kbps, stereo, 48 kHz; it is not a bit-for-bit copy of the original audio. The first track may be a different language or commentary, especially in multilingual releases. This version has no alternate-track selector. Missing audio fails extraction instead of falling back to a silent clip. The same 3–5 second duration limit and byte/time/request budgets apply, with no whole-file download fallback.

Receipts record `audio_policy: "removed"` for silent clips or `audio_policy: "retained_aac_stereo"` for audio-enabled clips. Retained-audio receipts also record `source_audio_stream_index: 0`, `audio_codec: "aac"`, `audio_channels: 2`, `audio_sample_rate: 48000`, and measured `audio_duration_sec` and `audio_start_sec`.

Preview the clip, verify the scene, edition, start/end timing, image, audio/language when retained, and intended use, then record approval:

```sh
node bin/goldflow.mjs footage approve --clip /absolute/path/receipt.json --reviewer "Joel" --note "Previewed exact scene and timing; basis checked"
```

This records a hash-bound `approval.json`; it does not approve episode production or release. Repeating an identical extraction reuses verified local clip bytes without resolving another signed URL. Audio-enabled clips have a distinct cache identity: requesting audio creates a separate clip requiring its own approval, while all existing silent clips, cache identities, receipts, and approvals remain unchanged. Changed source metadata, missing/corrupt cached bytes, stale receipts, and conflicting approvals stop for inspection. A completed clip without a receipt or an interrupted `extract.lock` also needs manual inspection; no automatic overwrite, full-source download fallback, or cross-provider fallback occurs. Failed extractor temporary files are removed, but accepted clips and source files are preserved.

## What “partial download” guarantees

The remote extractor requests bounded byte ranges through a local proxy. The source must be public HTTPS with public IPv4 resolution. DNS answers are checked and pinned per request; private/reserved destinations, credentials embedded in URLs, unsupported redirects, invalid ranges, and non-native containers fail closed. IPv6-only media hosts are currently unsupported.

Defaults are **128 MiB total range allowance, 120 seconds, 256 upstream requests, one concurrent upstream request**, with 1 MiB chunks. `--max-download-mib` accepts 1–512 MiB; `--timeout-sec` accepts 1–300 seconds. FFmpeg may need headers/index data plus frames before the chosen timestamp. A four-second output does not mean four seconds' worth of transferred bytes. Large GOPs, awkward indexes, high bitrates, expired links, or unsupported hosts may exceed the budget and fail.

The proxy validates actual `206 Partial Content` responses and exact `Content-Range`, stops if the host answers `200`, and never switches to a full-file download. Successful response bytes are counted and request allowance is reserved before concurrent work; malformed responses may deliver an additional transport chunk before cancellation. The limit is not an operating-system network quota. No promise is made about avoiding a full download of a source smaller than the budget. The local clip cache is separate from either provider's server-side cache.

When the first response supplies a strong ETag, later ranges must preserve it; otherwise a valid Last-Modified timestamp provides weaker version checking. Changed/missing established validators stop extraction. The receipt records `source_version_validation` and a one-way validator hash, not the raw validator. If neither is available, that field says `unavailable`: same-sized remote content changes cannot be detected reliably. A Last-Modified timestamp also is not cryptographic identity. `source_probe_sha256` covers only the initial small probe, not the full remote source. Local sources are fully hashed before and after extraction.

## Optional explicit acquisition

Existing ready files are the recommended first test. Neither API key automatically gives the app a universal movie catalog. This version has no movie discovery, scraping, external subtitle search, or background acquisition.

For a user-supplied magnet stored in a local text file, TorBox can check its v1 hash and add only if already cached:

```sh
node bin/goldflow.mjs footage cache-check --provider torbox --hash 0123456789012345678901234567890123456789
node bin/goldflow.mjs footage add --provider torbox --magnet-file /absolute/path/source.magnet --rights-confirmed true --rights-note "My permission or license basis"
```

An explicit `--allow-uncached true` permits TorBox to acquire **all files in the source server-side**. It does not request a four-second server-side download. TorBox has no per-file acquisition selection in this adapter.

Real-Debrid has no currently documented cache-only check used by this implementation. Adding or selecting therefore requires `--allow-uncached true`. Adding without `--file-ids` leaves file selection pending. Inspect the returned source/listing, then explicitly select the exact video file IDs:

```sh
node bin/goldflow.mjs footage add --provider real_debrid --magnet-file /absolute/path/source.magnet --allow-uncached true --rights-confirmed true --rights-note "My permission or license basis"
node bin/goldflow.mjs footage select --provider real_debrid --source-id EXACT_SOURCE_ID --file-ids 1 --allow-uncached true --rights-confirmed true --rights-note "My permission or license basis"
```

Selection is supported only while the source awaits selection; it cannot replace selections on completed sources. Selection may download the whole selected file to Real-Debrid's servers. There are no automatic retries, readiness polling loops, or provider failover. If add succeeds but explicit selection fails, the returned `added_selection_pending` status preserves the new source ID: inspect and repair that source rather than adding it again.

## Verification and integration boundary

```sh
npm run test:footage
```

The suite uses mocked provider APIs, temporary local files, and a synthetic video served by a local test range server. It checks credential redaction, explicit acquisition gates, empty/pending inventory responses, subtitle synchronization, immutable identities, byte/time/request budgets, unsafe destinations, ignored/truncated ranges, silent and opt-in audio MP4 output, missing-audio failure, and local clip reuse. A real FFmpeg proof extracts a late four-second clip with byte-identical local/remote outputs using substantially less than the full synthetic file.

Live authentication succeeded with both configured accounts on September 6, 2026; bounded inventory checks identified the empty/pending response shapes now covered by regression fixtures. No media was downloaded during those account checks. Two subsequent bounded live TorBox **silent** clip tests passed, transferring 9,641,588 of 2,512,588,404 source bytes and 13,999,346 of 18,706,959,602 source bytes, both with strong-ETag version checking. These tests establish behavior for those exact sources, not every provider media host. Audio-mode regression coverage is synthetic only; no live source-audio clip has been validated, and this extension does not automatically re-extract any real source.

Official contracts reviewed September 6, 2026: [Real-Debrid API](https://api.real-debrid.com/), [TorBox Main API](https://www.postman.com/torbox/torbox-api/documentation/b6l9hbv/main-api), [TorBox API Developer Terms](https://torbox.app/policies/api-developer-terms), and [FFmpeg input seeking](https://ffmpeg.org/ffmpeg.html#Main-options). TorBox terms permit private/internal own-account media tools but restrict broader integration and service-data use. This implementation is scoped accordingly: local lexical search, private account operations, and no external AI/service-data training or discovery. Reassess provider terms and obtain any required approval before public/commercial distribution or expanding into provider-backed AI indexing. These technical guardrails are not legal advice.
