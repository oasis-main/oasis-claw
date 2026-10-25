# Fleet Observatory.app (CLAW-126, phase 1)

A macOS app that runs the CLAW-108 fleet observatory with one click. The app
does the same steps as `make observatory`, and shows the observatory page in
its own window.

## Install

Run this command in the main oasis-claw checkout (the checkout that holds
`bots/`, not a worktree):

```sh
make observatory-app
```

The target builds the app and installs it as `~/Applications/Fleet Observatory.app`.
To put the app in the Dock, drag it from `~/Applications` to the Dock.

The build writes two values into the app's `Info.plist`:

- `OASISObservatoryRepo`: the checkout that the app runs `make observatory` in.
- `OASISObservatoryPath`: a `PATH` that finds `node`, `docker` and `make`. An
  app that Finder opens gets only `/usr/bin:/bin:/usr/sbin:/sbin`.

Run `make observatory-app` again after you move the checkout, or after `node`
or Docker moves. Quit the app before you build it again. To install to a
different folder, set `OBSERVATORY_APP_DEST=<folder>`.

The build needs the Xcode command line tools (`swiftc`, `codesign`, `iconutil`).

## Documents access

macOS asks one time: "Fleet Observatory would like to access files in your
Documents folder." Click **Allow**. The app needs this access because
`make observatory` runs in `~/Documents/Runes/oasis-x/oasis-claw` and reads
`.swarm` and `.claw-mail`.

The app has an ad hoc signature. macOS can ask again after each new build,
because a new build has a new signature. To change the access later, open
System Settings > Privacy & Security > Files and Folders.

## What the app does

1. **Open.** The app reads `serve.json` in the observatory state folder
   (`~/Library/Application Support/oasis-x/observatory`). If an observatory
   runs already, the app uses it and does not start a second one. Else the
   app runs `make observatory OBSERVE_FLAGS=` in the checkout. The empty
   `OBSERVE_FLAGS` removes `--open`, so the default browser does not open.
   `make observatory` starts the port proxy (when
   `bots/docker-compose.observatory.yml` exists), then
   `claw-observatory.mjs serve` on 127.0.0.1:18780 and the dot_swarm
   dashboard on 127.0.0.1:18781.
2. **Show.** The window loads `http://127.0.0.1:18780/#t=<key>`. This is the
   same unlock as `make observe-open`.
3. **Quit.** When you quit the app (⌘Q, or close the window), the app stops
   the servers that it started: the observatory and the swarm dashboard. The
   app does not stop an observatory that it did not start. The port proxy
   container continues to run, as after `make observatory` in a terminal.
   `cd bots && make observatory-proxy-down` stops the port proxy.

A link to a loopback address opens in a new window of the app. Examples are
a bot's Control UI and the swarm dashboard. A link to any other address opens
in the default browser.

The menu item **View > Show Log** opens the log. The menu item
**View > Start Observatory** starts the observatory again after it stops.

## Log

The app writes the output of `make observatory` to
`~/Library/Application Support/oasis-x/observatory/observatory-app.log`
(mode 0600). The app replaces the log each time that it starts the
observatory. The servers do not print the access key or the dashboard token.

## Trust model

The CLAW-108 trust model in `scripts/claw-observatory.mjs` applies. The app
adds these rules:

- The app opens no port and serves no route. Docker Desktop forwards
  `host.docker.internal` to the Mac's loopback for Nimbus and Hello World, so
  a bot can reach any unauthenticated loopback endpoint.
- The app reads the access key from the state folder and gives the key only
  to the page, in a URL fragment. WebKit does not send a fragment to a server.
- The web view uses a data store that is not persistent. The page keeps the
  key in `localStorage`, and this `localStorage` is in memory only. The app
  writes nothing under `~/Library/WebKit`.

## Known limits

- The page settings in `localStorage` reset each time that the app starts.
  Examples are the last view, the selected bots, and an unsent change-request
  draft. The browser page at the bookmark keeps these settings.
- **Capture screen** in the change-request drawer does not work in a web view.
  Use **Add image** or paste an image.
- The app does not adopt an observatory that an earlier app session started
  and did not stop (for example after a force quit). The app uses that
  observatory, but does not stop it on quit. Stop it with
  `kill $(lsof -t -iTCP:18780 -sTCP:LISTEN)`.

Phase 2 (a Tauri app) is in [PHASE2_TAURI.md](PHASE2_TAURI.md).
