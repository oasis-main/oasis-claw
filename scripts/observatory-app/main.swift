// ── Fleet Observatory.app (CLAW-126, phase 1) ────────────────────────────────
// A macOS app that runs the CLAW-108 observatory with one click. It does what
// `make observatory` does in a terminal, and shows the page in its own window.
//
//   open   An observatory that is already running is used as it is (the app
//          does not start a second one and does not stop it on quit). Else the
//          app runs `make observatory OBSERVE_FLAGS=` in the repo: the port
//          proxy, then `claw-observatory.mjs serve` and the swarm dashboard.
//   show   A WKWebView loads http://127.0.0.1:<port>/#t=<key>, the same unlock
//          as `make observe-open`. The page moves the key from the fragment
//          into localStorage. The web data store is not persistent, so the key
//          is held in memory only and never written under ~/Library/WebKit.
//   quit   The app stops the servers that it started: SIGTERM to the observatory
//          (which stops its own dashboard), then to the process group.
//
// TRUST MODEL — the CLAW-108 rules in scripts/claw-observatory.mjs hold here.
// The app opens no port and serves nothing. It reads the access key from the
// observatory state folder and gives it only to the page, in a URL fragment.
// The log goes to the state folder (0600), and the servers do not print the
// key or the dashboard token. A link to another address (a bot's Control UI,
// the swarm dashboard) opens in the default browser, as `make control-ui` and
// `make swarm-open` do.

import Cocoa
import Darwin
import WebKit

// ── configuration ────────────────────────────────────────────────────────────

/// The build (scripts/observatory-app/build.sh) writes the repo path and a
/// PATH into Info.plist: an app that Finder opens gets only /usr/bin:/bin.
struct Config {
  let repo: String
  let path: String
  let stateDir: URL

  static func load() -> Config {
    let info = Bundle.main.infoDictionary ?? [:]
    let env = ProcessInfo.processInfo.environment
    let home = FileManager.default.homeDirectoryForCurrentUser
    let state = env["OASIS_OBSERVATORY_STATE_DIR"].map { URL(fileURLWithPath: $0) }
      ?? home.appendingPathComponent("Library/Application Support/oasis-x/observatory")
    return Config(
      repo: env["OASIS_OBSERVATORY_REPO"] ?? (info["OASISObservatoryRepo"] as? String) ?? "",
      path: (info["OASISObservatoryPath"] as? String) ?? "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      stateDir: state)
  }

  var serveFile: URL { stateDir.appendingPathComponent("serve.json") }
  var keyFile: URL { stateDir.appendingPathComponent("observatory-key") }
  var logFile: URL { stateDir.appendingPathComponent("observatory-app.log") }
}

// ── process helpers ──────────────────────────────────────────────────────────

struct ServeInfo {
  let port: Int
  let pid: pid_t
}

/// serve.json names the running observatory. A pid can be reused after a
/// crash, so the process must also be `claw-observatory.mjs serve`.
func readServeFile(_ config: Config) -> ServeInfo? {
  guard let data = try? Data(contentsOf: config.serveFile),
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let port = obj["port"] as? Int, let pid = obj["pid"] as? Int, pid > 1
  else { return nil }
  let info = ServeInfo(port: port, pid: pid_t(pid))
  return isObservatoryProcess(info.pid) ? info : nil
}

func isAlive(_ pid: pid_t) -> Bool {
  kill(pid, 0) == 0 || errno == EPERM
}

func isObservatoryProcess(_ pid: pid_t) -> Bool {
  guard isAlive(pid) else { return false }
  let ps = Process()
  ps.executableURL = URL(fileURLWithPath: "/bin/ps")
  ps.arguments = ["-o", "command=", "-p", String(pid)]
  let out = Pipe()
  ps.standardOutput = out
  ps.standardError = FileHandle.nullDevice
  do { try ps.run() } catch { return false }
  let text = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
  ps.waitUntilExit()
  return text.contains("claw-observatory.mjs") && text.contains(" serve")
}

/// Start argv in a new process group, with stdin from /dev/null and stdout
/// and stderr to logFD. The group lets the app stop make, node and the
/// dashboard together.
func spawnInNewGroup(_ argv: [String], cwd: String, env: [String: String], logFD: Int32) throws -> pid_t {
  var actions: posix_spawn_file_actions_t?
  posix_spawn_file_actions_init(&actions)
  defer { posix_spawn_file_actions_destroy(&actions) }
  posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
  posix_spawn_file_actions_adddup2(&actions, logFD, 1)
  posix_spawn_file_actions_adddup2(&actions, logFD, 2)
  posix_spawn_file_actions_addchdir_np(&actions, cwd)

  var attr: posix_spawnattr_t?
  posix_spawnattr_init(&attr)
  defer { posix_spawnattr_destroy(&attr) }
  var none = sigset_t()
  sigemptyset(&none)
  var all = sigset_t()
  sigfillset(&all)
  posix_spawnattr_setsigmask(&attr, &none)
  posix_spawnattr_setsigdefault(&attr, &all)
  posix_spawnattr_setpgroup(&attr, 0)
  posix_spawnattr_setflags(
    &attr, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_CLOEXEC_DEFAULT))

  let cArgs = argv.map { strdup($0) } + [nil]
  let cEnv = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
  defer {
    cArgs.forEach { free($0) }
    cEnv.forEach { free($0) }
  }
  var pid: pid_t = 0
  let rc = posix_spawn(&pid, argv[0], &actions, &attr, cArgs, cEnv)
  if rc != 0 { throw NSError(domain: NSPOSIXErrorDomain, code: Int(rc)) }
  return pid
}

let probeSession = URLSession(configuration: .ephemeral)

func httpAnswers(port: Int, _ done: @escaping (Bool) -> Void) {
  var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/")!)
  req.timeoutInterval = 2
  req.cachePolicy = .reloadIgnoringLocalCacheData
  probeSession.dataTask(with: req) { _, res, _ in
    let ok = (res as? HTTPURLResponse)?.statusCode == 200
    DispatchQueue.main.async { done(ok) }
  }.resume()
}

// ── the app ──────────────────────────────────────────────────────────────────

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
  let config = Config.load()
  var window: NSWindow!
  var statusView: NSTextView!
  var statusScroll: NSScrollView!
  var webView: WKWebView?
  // Windows of this app for loopback links: a bot's Control UI, the swarm dashboard.
  var linkWindows: [NSWindow] = []

  // The servers the app started, if any.
  var groupPid: pid_t = 0  // make, and the leader of the process group
  var serverPid: pid_t = 0  // node claw-observatory.mjs serve
  var groupWatch: DispatchSourceProcess?
  var serverWatch: DispatchSourceProcess?
  var pollTimer: Timer?
  var startedAt = Date()
  var port = 0
  var owned = false
  var quitting = false
  var statusHead = ""

  func applicationDidFinishLaunching(_ note: Notification) {
    buildMenu()
    buildWindow()
    NSApp.activate(ignoringOtherApps: true)
    begin()
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

  func applicationShouldTerminate(_ app: NSApplication) -> NSApplication.TerminateReply {
    guard owned, groupPid > 0, isAlive(groupPid) else { return .terminateNow }
    quitting = true
    stopOwned { NSApp.reply(toApplicationShouldTerminate: true) }
    return .terminateLater
  }

  // ── start ──

  func begin() {
    port = 0
    serverPid = 0
    startedAt = Date()
    if let info = readServeFile(config) {
      owned = false
      serverPid = info.pid
      setStatus("An observatory is already running (pid \(info.pid), port \(info.port)).\n"
        + "The app uses it, and does not stop it when you quit the app.")
      watchServer(info.pid)
      waitForPage(port: info.port)
      return
    }
    startOwned()
  }

  func startOwned() {
    guard !config.repo.isEmpty, FileManager.default.fileExists(atPath: config.repo + "/Makefile") else {
      setStatus("The repo path is not set or has no Makefile: \"\(config.repo)\".\n"
        + "Run `make observatory-app` again in the oasis-claw checkout.")
      return
    }
    try? FileManager.default.createDirectory(
      at: config.stateDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let fd = open(config.logFile.path, O_WRONLY | O_CREAT | O_TRUNC | O_APPEND, 0o600)
    guard fd >= 0 else {
      setStatus("Cannot write the log \(config.logFile.path): \(String(cString: strerror(errno)))")
      return
    }
    defer { close(fd) }
    fchmod(fd, 0o600)
    // OBSERVE_FLAGS= drops --open: this window shows the page, not the browser.
    let argv = ["/usr/bin/env", "make", "--no-print-directory", "observatory", "OBSERVE_FLAGS="]
    let header = "Fleet Observatory app: \(ISO8601DateFormatter().string(from: Date()))\n"
      + "repo: \(config.repo)\nrun: \(argv.dropFirst().joined(separator: " "))\n\n"
    _ = header.withCString { write(fd, $0, strlen($0)) }

    var env = ProcessInfo.processInfo.environment
    env["PATH"] = config.path
    env.removeValue(forKey: "OASIS_OBSERVATORY_REPO")
    do {
      groupPid = try spawnInNewGroup(argv, cwd: config.repo, env: env, logFD: fd)
    } catch {
      setStatus("Cannot start make: \(error.localizedDescription)")
      return
    }
    owned = true
    setStatus("Starting the observatory: make observatory (pid \(groupPid)).\nLog: \(config.logFile.path)")
    watchGroup(groupPid)
    pollTimer?.invalidate()
    pollTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] _ in self?.pollOwnedStart() }
  }

  /// Wait until our own node writes serve.json and the page answers.
  func pollOwnedStart() {
    showLogTail()
    if serverPid == 0, let info = readServeFile(config), getpgid(info.pid) == groupPid {
      serverPid = info.pid
      watchServer(info.pid)
      pollTimer?.invalidate()
      waitForPage(port: info.port)
      return
    }
    if Date().timeIntervalSince(startedAt) > 180 {
      pollTimer?.invalidate()
      appendStatus("\nThe observatory did not start in 180 s. The app stops it.")
      stopOwned {}
    }
  }

  func waitForPage(port: Int, tries: Int = 0) {
    httpAnswers(port: port) { [weak self] ok in
      guard let self = self, !self.quitting else { return }
      if ok {
        self.loadPage(port: port)
      } else if tries < 75 {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.waitForPage(port: port, tries: tries + 1) }
      } else {
        self.appendStatus("\nhttp://127.0.0.1:\(port)/ does not answer.")
      }
    }
  }

  // ── stop ──

  func watchGroup(_ pid: pid_t) {
    let src = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .main)
    src.setEventHandler { [weak self] in
      var status: Int32 = 0
      waitpid(pid, &status, 0)
      src.cancel()
      self?.groupExited(status)
    }
    groupWatch = src
    src.resume()
  }

  func watchServer(_ pid: pid_t) {
    serverWatch?.cancel()
    let src = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .main)
    src.setEventHandler { [weak self] in
      src.cancel()
      guard let self = self, !self.quitting, !self.owned else { return }
      self.showStatusView()
      self.setStatus("The observatory (pid \(pid)) stopped. Choose View > Start Observatory to start one.")
    }
    serverWatch = src
    src.resume()
  }

  func groupExited(_ status: Int32) {
    let leader = groupPid
    groupPid = 0
    pollTimer?.invalidate()
    // Stop what is left of the group, for example a dashboard that outlived node.
    if leader > 0 { killpg(leader, SIGTERM) }
    if quitting { return }
    owned = false
    serverPid = 0
    showStatusView()
    let code = (status & 0x7f) == 0 ? "exit code \((status >> 8) & 0xff)" : "signal \(status & 0x7f)"
    setStatus("make observatory stopped (\(code)). Choose View > Start Observatory to try again.\n"
      + "Log: \(config.logFile.path)")
    showLogTail()
  }

  /// SIGTERM to node lets it remove serve.json and stop its dashboard. When
  /// node is not up yet, the whole group gets SIGTERM. After 5 s, SIGKILL.
  func stopOwned(_ done: @escaping () -> Void) {
    let leader = groupPid
    guard leader > 0 else { done(); return }
    if serverPid > 0, getpgid(serverPid) == leader {
      kill(serverPid, SIGTERM)
    } else {
      killpg(leader, SIGTERM)
    }
    let deadline = Date().addingTimeInterval(5)
    func check() {
      var status: Int32 = 0
      // A zombie still answers kill(pid, 0), so reap it here too.
      if groupPid == 0 || waitpid(leader, &status, WNOHANG) == leader || !isAlive(leader) {
        groupPid = 0
        killpg(leader, SIGTERM)
        done()
        return
      }
      if Date() > deadline {
        killpg(leader, SIGKILL)
        done()
        return
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1, execute: check)
    }
    check()
  }

  @objc func startAgain(_ sender: Any?) {
    if owned && groupPid > 0 { return }
    if let info = readServeFile(config), port == info.port, webView != nil {
      webView?.reload()
      return
    }
    showStatusView()
    begin()
  }

  /// View > Fleet Health: the page's start/restart panel (Mike, 2026-10-26).
  @objc func showFleetHealth(_ sender: Any?) {
    guard let wv = webView else {
      NSSound.beep()
      return
    }
    window.makeKeyAndOrderFront(nil)
    wv.evaluateJavaScript("typeof openFleetDialog === 'function' && openFleetDialog()", completionHandler: nil)
  }

  @objc func showLog(_ sender: Any?) {
    NSWorkspace.shared.open(config.logFile)
  }

  // ── the page ──

  func loadPage(port: Int) {
    guard let raw = try? String(contentsOf: config.keyFile, encoding: .utf8) else {
      appendStatus("\nCannot read the access key in \(config.keyFile.path).")
      return
    }
    let key = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard key.range(of: "^[A-Za-z0-9_-]{20,}$", options: .regularExpression) != nil else {
      appendStatus("\nThe access key in \(config.keyFile.path) has an unexpected format.")
      return
    }
    self.port = port
    let cfg = WKWebViewConfiguration()
    cfg.websiteDataStore = .nonPersistent()
    let wv = WKWebView(frame: window.contentView?.bounds ?? .zero, configuration: cfg)
    wv.navigationDelegate = self
    wv.uiDelegate = self
    wv.allowsBackForwardNavigationGestures = false
    webView = wv
    window.contentView = wv
    // The same unlock as `make observe-open`: the key is in the fragment,
    // which WebKit never sends to the server.
    wv.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/#t=\(key)")!))
  }

  func isOwnOrigin(_ url: URL) -> Bool {
    url.scheme == "http" && url.host == "127.0.0.1" && url.port == port
  }

  /// A loopback address: a bot's Control UI (through the port proxy) or the
  /// swarm dashboard. Mike, 2026-10-25: these open in the app, not the browser.
  func isLoopback(_ url: URL) -> Bool {
    url.scheme == "http" && (url.host == "127.0.0.1" || url.host == "localhost")
  }

  /// Any other web address opens in the default browser.
  func openOutside(_ url: URL) {
    guard url.scheme == "http" || url.scheme == "https" else { return }
    NSWorkspace.shared.open(url)
  }

  /// Put a web view for a loopback address in a window of this app.
  func showInWindow(_ wv: WKWebView) {
    wv.navigationDelegate = self
    wv.uiDelegate = self
    let w = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    w.title = "Opening…"
    w.isReleasedWhenClosed = false
    w.minSize = NSSize(width: 480, height: 360)
    w.contentView = wv
    w.delegate = self
    let origin = (linkWindows.last ?? window).frame.origin
    w.setFrameOrigin(NSPoint(x: origin.x + 28, y: origin.y - 28))
    linkWindows.append(w)
    w.makeKeyAndOrderFront(nil)
  }

  /// A loopback link from the main page opens a new window of this app,
  /// with the main page's data store (the same session as a popup gets).
  func openInApp(_ url: URL) {
    let cfg = WKWebViewConfiguration()
    if let store = webView?.configuration.websiteDataStore { cfg.websiteDataStore = store }
    let wv = WKWebView(frame: .zero, configuration: cfg)
    showInWindow(wv)
    wv.load(URLRequest(url: url))
  }

  func webView(_ wv: WKWebView, decidePolicyFor action: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = action.request.url else { decisionHandler(.cancel); return }
    if ["about", "blob", "data"].contains(url.scheme ?? "") { decisionHandler(.allow); return }
    if wv === webView {
      if isOwnOrigin(url) { decisionHandler(.allow); return }
      if action.targetFrame?.isMainFrame ?? true {
        if isLoopback(url) { openInApp(url) } else { openOutside(url) }
      }
      decisionHandler(.cancel)
      return
    }
    // A link window keeps loopback addresses. Another address goes to the
    // default browser; a window that never showed a page then closes (the
    // page's window.open("about:blank") followed by an outside address).
    if isLoopback(url) { decisionHandler(.allow); return }
    decisionHandler(.cancel)
    openOutside(url)
    if wv.url == nil || wv.url?.scheme == "about" { wv.window?.close() }
  }

  func webView(_ wv: WKWebView, createWebViewWith cfg: WKWebViewConfiguration, for action: WKNavigationAction,
               windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url, url.scheme == "http" || url.scheme == "https" {
      if wv === webView && isOwnOrigin(url) { webView?.load(URLRequest(url: url)); return nil }
      if !isLoopback(url) { openOutside(url); return nil }
    }
    // about:blank (the page's "Opening…" tab) or a loopback address: a window
    // of this app. WebKit loads the request into the view returned here.
    let child = WKWebView(frame: .zero, configuration: cfg)
    showInWindow(child)
    return child
  }

  func webView(_ wv: WKWebView, didFinish navigation: WKNavigation!) {
    guard wv !== webView, let title = wv.title, !title.isEmpty else { return }
    wv.window?.title = title
  }

  func webViewDidClose(_ wv: WKWebView) {
    if wv !== webView { wv.window?.close() }
  }

  func windowWillClose(_ note: Notification) {
    guard let w = note.object as? NSWindow else { return }
    if w === window {
      // Closing the main window quits the app, so the link windows go with it.
      for lw in linkWindows { lw.close() }
      return
    }
    (w.contentView as? WKWebView)?.stopLoading()
    linkWindows.removeAll { $0 === w }
  }

  func webViewWebContentProcessDidTerminate(_ wv: WKWebView) {
    if wv === webView { wv.reload() }
  }

  func webView(_ wv: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let alert = NSAlert()
    alert.messageText = message
    alert.beginSheetModal(for: wv.window ?? window) { _ in completionHandler() }
  }

  func webView(_ wv: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let alert = NSAlert()
    alert.messageText = message
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Cancel")
    alert.beginSheetModal(for: wv.window ?? window) { completionHandler($0 == .alertFirstButtonReturn) }
  }

  func webView(_ wv: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
    let alert = NSAlert()
    alert.messageText = prompt
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
    field.stringValue = defaultText ?? ""
    alert.accessoryView = field
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Cancel")
    alert.beginSheetModal(for: wv.window ?? window) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
  }

  func webView(_ wv: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.canChooseDirectories = false
    panel.canChooseFiles = true
    panel.beginSheetModal(for: wv.window ?? window) { completionHandler($0 == .OK ? panel.urls : nil) }
  }

  // ── window and menus ──

  func buildWindow() {
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1440, height: 920),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.title = "Fleet Observatory"
    window.tabbingMode = .disallowed
    window.minSize = NSSize(width: 720, height: 480)
    window.center()
    window.setFrameAutosaveName("FleetObservatoryMain")
    window.delegate = self
    statusScroll = NSTextView.scrollableTextView()
    statusView = (statusScroll.documentView as! NSTextView)
    statusView.isEditable = false
    statusView.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    statusView.textContainerInset = NSSize(width: 24, height: 24)
    window.contentView = statusScroll
    window.makeKeyAndOrderFront(nil)
  }

  func showStatusView() {
    webView = nil
    window.contentView = statusScroll
  }

  func setStatus(_ text: String) {
    statusHead = text
    statusView.string = text
  }

  func appendStatus(_ text: String) {
    statusHead += text
    statusView.string = statusHead
  }

  /// The last lines of the log under the status text, while the window has no page.
  func showLogTail() {
    guard webView == nil, let data = try? Data(contentsOf: config.logFile) else { return }
    let lines = String(decoding: data, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: false)
    statusView.string = statusHead + "\n\n" + lines.suffix(30).joined(separator: "\n")
    statusView.scrollToEndOfDocument(nil)
  }

  func buildMenu() {
    let main = NSMenu()
    func submenu(_ title: String, _ items: [NSMenuItem]) {
      let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      let menu = NSMenu(title: title)
      items.forEach(menu.addItem)
      holder.submenu = menu
      main.addItem(holder)
    }
    func item(_ title: String, _ action: Selector?, _ key: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
      let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
      i.keyEquivalentModifierMask = mods
      return i
    }
    submenu("Fleet Observatory", [
      item("About Fleet Observatory", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
      .separator(),
      item("Hide Fleet Observatory", #selector(NSApplication.hide(_:)), "h"),
      item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
      item("Show All", #selector(NSApplication.unhideAllApplications(_:)), ""),
      .separator(),
      item("Quit Fleet Observatory", #selector(NSApplication.terminate(_:)), "q"),
    ])
    submenu("Edit", [
      item("Undo", Selector(("undo:")), "z"),
      item("Redo", Selector(("redo:")), "z", [.command, .shift]),
      .separator(),
      item("Cut", #selector(NSText.cut(_:)), "x"),
      item("Copy", #selector(NSText.copy(_:)), "c"),
      item("Paste", #selector(NSText.paste(_:)), "v"),
      item("Select All", #selector(NSText.selectAll(_:)), "a"),
    ])
    let start = item("Start Observatory", #selector(startAgain(_:)), "r", [.command, .shift])
    start.target = self
    let log = item("Show Log", #selector(showLog(_:)), "l", [.command, .shift])
    log.target = self
    let fleet = item("Fleet Health…", #selector(showFleetHealth(_:)), "h", [.command, .shift])
    fleet.target = self
    submenu("View", [
      item("Reload Page", #selector(WKWebView.reload(_:)), "r"),
      start,
      fleet,
      log,
      .separator(),
      item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
    ])
    submenu("Window", [
      item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
      item("Zoom", #selector(NSWindow.performZoom(_:)), ""),
      item("Close", #selector(NSWindow.performClose(_:)), "w"),
    ])
    NSApp.mainMenu = main
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
// SIGTERM (`kill`, `killall`) takes the normal quit, which stops the servers.
signal(SIGTERM, SIG_IGN)
let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
// Not terminate() inside this main-queue block: the quit waits on main-queue
// work (the process watch), and the main queue cannot run while it is busy.
sigterm.setEventHandler { RunLoop.main.perform { NSApp.terminate(nil) } }
sigterm.resume()
app.setActivationPolicy(.regular)
app.run()
