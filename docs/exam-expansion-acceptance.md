# Exam expansion acceptance audit

Reviewed against open issues #8–18 on 2026-10-19. Baseline: `f2c35377ab4ebb2a2f88bfde021a9ae7da79f2af` on `main`.

## Baseline finding

The original `npm test` passed 35 tests, but none of these eleven issues satisfied its full acceptance criteria. Passing the prior suite was not enough to close them. Confirmed gaps included the D1 schema rejecting fill-blank questions, mutable media attachments in saved exams, hosted media blobs written into D1, missing shared-material reuse, fixed one-mark exams, incomplete workbook validation/template examples, silently ignored paste errors, and stale-read submission races.

## Changes and automated evidence

| Issue | Changes and evidence | Closure condition |
| --- | --- | --- |
| #8 Fill blanks | Null/duplicate/malformed definitions rejected; NFC/length/per-blank case rules enforced; full/zero scoring; missing D1 constraint fixed by 0007; all-nine-type API and answer-review regressions. | Merge plus verification of applicable UI flow. |
| #9 Rearrangement | Stable per-attempt Fisher–Yates shuffle, reload preservation, drag and keyboard/touch arrow controls; opaque public IDs and independent server ordering hide canonical sequence; migration 0008 preserves original IDs/keys/answers/scores. | Merge plus real desktop/touch browser verification. |
| #10 Rich text | Consistent sanitization for configuration choices as well as prompts; safe quoted attributes, newlines and math comparisons; safe author-text summaries and literal student text; rendering/model tests. | Merge plus applicable real-browser rendering verification. |
| #11 Images | File-signature/MIME/size allowlist, immutable local and R2 adapters, constrained capability URLs, safe response headers/ranges, copy-on-write replacements, retention/backup/restore documentation and tests. | Merge, provision authorized hosted storage, then real target-host validation. |
| #12 Audio | Teacher upload/replace/remove, format/size limits, native accessible loading/error/retry controls, byte-range playback, immutable shared media and no answer-key exposure. | Merge plus real target-host and desktop/mobile playback verification. |
| #13 Shared stimuli | Reusable catalog and immutable snapshot copies sharing one media URL; customize-copy authoring; active exam and both answer reviews; API history/reuse and UI regression tests. | Merge plus applicable real-browser authoring/rendering verification. |
| #14 Mixed exams | All nine types and subjects supported; per-question marks copied into exam snapshots; correct total marks display/PDF; publish validation and old-history preservation. | Merge, required migrations, applicable UI verification. |
| #15 Excel | Shared version 2 template with all nine examples/marks/formatting; legacy aliases; every populated question sheet checked; worksheet/row diagnostics; validation and injected storage errors roll back all writes. | Merge; automated backend acceptance passes. |
| #16 Paste | Explicit version 2 header, legacy syntax, duplicate/unknown-line diagnostics, strict answer handling, copyable/downloadable nine-type examples, 300-block limit and atomic failure. | Merge; automated parser/API acceptance passes. |
| #17 Post-import media | Pending filters/badges include shared media, upload clears pending state, preview/remove, historical copy-on-write, malformed/missing/pending assets block publish. | Merge plus applicable real-browser workflow verification; hosted media depends on #11/#12 setup. |
| #18 Grading/regressions | Full nine-type Express/Worker matrix, negative marking/partial credit, visibility, raw-answer persistence, expired attempts, concurrent-submit CAS and save/deadline guards, archival/backup/migration coverage. | Merge, required migrations; automated backend acceptance passes. |

No issue was closed on the strength of local or unmerged edits. The pull request is a reviewable draft, not a deployment or merge authorization.

## Verification commands

```sh
npm ci
npm test
node --check tests/browser-acceptance.mjs
```

`npm test` builds the client and bundled Worker, then runs every `tests/*.test.mjs`. Databases and participants are disposable/synthetic. Worker tests use a transactional SQLite-backed D1 adapter; object-storage tests use an R2 contract fake. Deliberate SQL-error output in the import test verifies rollback and is expected when the test passes.

The final PR description records the exact final test count. Main added suites are:

- `tests/expansion-acceptance.test.mjs`: both API implementations, nine types, scoring boundaries, concurrent submission interleavings, visibility, expiry, atomic imports, shared-material history and migrations.
- `tests/media.test.mjs`: upload/access/history/publish/backup behavior for both backends and storage adapters.
- `tests/question-authoring.test.mjs`: expanded authoring/rendering/model behavior, accessible controls, persistence, media/reuse and safe rich text.
- `tests/stimuli.test.mjs`: catalog snapshots, URL/markup safety, original wording and blank validation.

The existing migration/legacy requirements, results, PDF, motion and short-link suites remain enabled.

## Not verified and required rollout steps

The optional real Chromium suite did not execute successfully in this environment. Chromium startup was blocked by process/socket sandbox restrictions; a supported elevated attempt failed before execution; a separate cloud browser could not connect to the isolated local server. See [browser acceptance status](../verification/browser-acceptance.md). Template/model tests are not a substitute for browser/device verification.

No production deployment, production database migration, R2 bucket creation, live-host test or real mobile-device test was performed. The existing hosting config only declares D1; hosted media now deliberately returns a clear 503 unless `MEDIA_BUCKET` is provisioned/bound. Follow [media operations](media-storage.md), back up both database and binary assets, and apply migrations through 0008 in an approved environment before rollout. Actual host compatibility and existing asset inventory must be checked there. Existing safe legacy media remains readable; no automatic asset deletion is introduced.
