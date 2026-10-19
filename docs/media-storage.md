# Question media: storage, access, history, and recovery

## Supported uploads

Only signed-in teachers can POST one multipart `file` to `/api/admin/media/upload`. No student-upload route exists. The response is `{ url, type, filename, mime, size, extension }`. Attach the response URL using the normal question form or POST `/api/admin/questions/:id/media` with `{ "media": { "type": "image", "url": "…", "alt": "…", "caption": "…" } }`. Send `{ "media": null }` to remove the attachment. Uploading alone does not attach it.

- Images: PNG, JPEG, GIF, WebP, up to 5 MiB.
- Audio: MP3, WAV, Ogg (Vorbis, Opus, FLAC), FLAC, up to 10 MiB.
- SVG, HTML, PDF, video, and ambiguous MP4/M4A containers are not accepted. Convert unsupported audio to MP3 or WAV first. There are no recordings or student audio/video uploads.
- Byte signatures and container/codec identifiers are checked, as is a declared MIME match. File extensions are generated from the detected format, not supplied filenames. These are bounded format checks, not a complete decoder, antivirus scan, or transcoding service. Preview the file before publishing.
- Worker multipart reads have an enforced stream limit of 10 MiB plus 64 KiB overhead, even without a valid Content-Length. Express uses bounded multipart parsing.

## Local filesystem adapter

`UPLOADS_DIR` can select a dedicated persistent directory. Otherwise uploads live beside `DB_PATH` in `uploads/`, or at `data/uploads/`. It must be writable by the app and backed by a persistent volume, not an ephemeral deployment filesystem. New files are owner-readable/writable (0600), and a new directory is owner-only (0700). Keep existing directory ownership and permissions similarly restricted.

Files get a fresh random UUID-derived key on every upload and exclusive-create writes; replacing attachments never overwrites a file. The filesystem is not exposed as a static directory. GET/HEAD `/api/media/<key>.<extension>` validates filenames and bytes, refuses symlinks, and never accepts path components. Previously issued `/uploads/<timestamp>-<random>.<extension>` URLs continue to work for supported, valid files; unsafe legacy SVG/HTML and unsupported formats are intentionally refused and must be replaced in a new bank version. Original files are not deleted.

## Hosted object-storage adapter

Bind a private Cloudflare R2-compatible bucket as `MEDIA_BUCKET`. It needs `put`, `head`, and `get` binding methods. The Worker stores bytes under `question-media/<key>.<extension>`, along with content type and creation metadata. D1 stores only the existing media JSON URL and text metadata. There is no new media table or database migration. Writes use a create-only condition. Existing inline base64 data in historical D1 question rows is not rewritten or discarded and remains readable; new inline URLs are rejected by authoring validation.

Example for a separately managed Wrangler deployment:

```toml
[[r2_buckets]]
binding = "MEDIA_BUCKET"
bucket_name = "your-private-question-media-bucket"
```

Do not enable a public bucket URL or grant browser credentials. Use the same application-origin media route on both hosts. See the [R2 Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) for the binding and conditional/ranged APIs. The repository's Sites `.openai/hosting.json` currently declares D1 only. This code does not provision an R2 bucket or configure that hosting platform: the deployment owner must confirm it can expose `MEDIA_BUCKET`. Without the binding, uploads return actionable HTTP 503 rather than falling back to D1 blobs. Existing media-free exams still work.

## Access and playback policy

Upload and attachment edits require an authenticated, current admin session. Reads intentionally use unguessable capability URLs so native image/audio elements work for both student attempts and admin previews without exposing attempt tokens. Possession of a URL allows reading that asset without login. There is no bucket listing API or sequential asset ID. Treat media URLs as shareable secrets; do not place personal, confidential, answer-key, or restricted material in uploaded files. This is not per-student access control and does not revoke a copied URL when an exam closes. External URL attachments have the external provider's access and retention policy and are outside this storage guarantee.

Responses use explicit media Content-Type, `nosniff`, sandbox CSP, same-origin resource policy, no-referrer policy, private caching, and inline filenames. GET/HEAD and single byte ranges are supported for native audio seeking; invalid/multipart ranges return 416. Teacher-provided alt text/captions remain separate from the immutable asset. No grading keys or student data are embedded in upload responses or object metadata.

## Historical versions and pending imports

Attaching, replacing, and removing media uses copy-on-write whenever a question belongs to any saved exam. The old row, URL, answer key, exam linkage, attempts, and awarded scores stay unchanged, including draft snapshots. The response contains the new bank question ID. For a draft that already selected an unresolved placeholder, create/reselect using the new resolved question version; the existing draft must not silently change underneath its saved snapshot.

Both initial publication and status changes to `published` reject unresolved question/stimulus media, malformed metadata, missing managed files, and an image/audio type mismatch. Media-free questions are not blocked. Checks cover pending aliases and stored malformed data as well as normal form submissions. External URLs are syntactically checked but are not fetched by the server; external availability and subsequent content changes cannot be guaranteed.

## Retention and cleanup

There is deliberately no automatic asset deletion or age-based lifecycle expiry. Replacement, removal, question-bank archival, exam deletion, and result-sheet deletion never delete media files. This favors preserved exams and restore safety over reclaiming space. Uploads abandoned before saving may therefore remain as orphans.

For a future/manual cleanup, first take a complete backup. Scan every question row, including archived rows, and both question media and `question_config.stimulus.media`; include retained backup snapshots and any references outside the current database. Only consider an object unreferenced if it is absent from all those sets, no upload/save is in flight, and it exceeds an operator-chosen grace period (at least seven days recommended). Review a dry-run candidate list before authorized deletion. Do not set bucket TTL/lifecycle deletion on the `question-media/` prefix. Never remove an object merely because its bank question is archived or an exam is closed.

## Backup and restore

The admin JSON backup now contains a `media` manifest with referenced URLs (including historical/stimulus references), legacy inline count, `files_included: false`, and a recovery reminder. It does **not** include filesystem/R2 binary files. Database-only JSON is not a complete media backup.

1. Pause teacher edits/uploads or take coordinated database/storage snapshots. Export the entire database, including archived questions and admin credential hashes. Protect/encrypt the export and restrict access.
2. Copy the whole uploads directory for Express, or back up the complete R2 `question-media/` prefix and content-type metadata to separately retained storage. Preserve filenames/object keys exactly. Include unreferenced assets unless reviewed cleanup has already occurred. Provider redundancy alone is not an independent backup.
3. Restore the database using the app's matching schema/migrations in an isolated environment. Restore files at the configured `UPLOADS_DIR`, or restore the bucket keys and metadata and bind `MEDIA_BUCKET`. There is no in-app restore button.
4. Check every manifest-managed URL, sample historical exams and answer sheets, and test audio seeking before reopening access. Legacy inline D1 media remains in its JSON rows. Moving local `/uploads/` paths to hosted storage requires a separately reviewed migration that preserves historical URLs, not editing archived question rows casually.

## Verification and deployment gate

Run `npm run build && node --test tests/media.test.mjs`. Tests exercise the actual Express routes and built Worker with a SQLite-backed D1 test adapter and an R2 contract fake. Coverage includes actual small image/audio fixtures, spoofed MIME/HTML/SVG/video rejection, size/stream limits, unauthenticated writes, immutable safe filenames, traversal/symlinks, GET/HEAD/ranges, missing bucket behavior, copy-on-write history, attempt privacy/grading, missing/pending/malformed/stimulus publication guards, legacy inline reads, and backup reference manifests.

These are **not** live hosted R2 tests or mobile/desktop browser playback tests. Before closing the hosting/playback acceptance criteria, provision and verify the production binding, run upload/read/range/history/backup-restore smoke checks in a non-production hosted environment, and test image previews plus native play/pause/seek/error states on supported desktop and mobile browsers. No deployment, production mutation, cleanup, or real bucket change was performed by this patch.
