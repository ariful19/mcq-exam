# Browser acceptance status

## Executed verification

`node --check tests/browser-acceptance.mjs` passes.

`node --test tests/question-authoring.test.mjs tests/animations.test.mjs` passes **15 tests, 0 failures**. These exercise UI models/rendered templates, media states, authoring and draft synchronization, shared snapshots, ordering initialization/persistence logic, safe rich-text summaries, and motion/device behavior. They are not real-browser tests.

The synthetic PNG and WAV fixtures pass media signature validation. The PNG also decodes successfully as an image.

## Real browser execution is blocked, not passed

The optional `tests/browser-acceptance.mjs` suite was prepared and source-reviewed against the latest UI and API, including opaque ordering IDs. It has **not completed browser execution** in the current environment:

- System Chromium exits during startup because its process-singleton socket is unavailable in the execution sandbox.
- The supported elevated execution attempt fails during sandbox setup, before the test runs.
- The separate cloud browser cannot reach the isolated localhost test server (`net::ERR_CONNECTION_REFUSED`).

No real-browser screenshots were produced. Do not count this suite as passing until it is run in an environment supporting Chromium and a reachable local server.

## Running the optional suite

With Playwright resolvable by Node and Chromium available:

```sh
npm run build
node tests/browser-acceptance.mjs
```

Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to another installed Chromium executable if needed. Set `BROWSER_ARTIFACTS` to choose an output directory; otherwise the script retains artifacts under a newly created temporary folder and prints that path.

The suite uses an isolated temporary SQLite database and synthetic participants/media. It does not deploy or modify external accounts. It covers actual admin sign-in and authoring, reusable image/audio stimuli, rich formatting, all nine answer types, reload persistence, keyboard and HTML5 drag/drop ordering, student and teacher reviews, and a mobile viewport with touch-arrow ordering fallback. Mobile emulation is not a physical-device test. Live Worker deployment and external media availability remain separate verification steps.
