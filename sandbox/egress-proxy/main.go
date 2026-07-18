// Command egress-proxy is the fail-closed forward proxy for the oasis-claw
// operating-system-sandbox (queue item CLAW-033).
//
// It is meant to run as the SOLE egress route out of an `internal: true`
// container network. A sandboxed openclaw runtime then has no direct route to
// the internet and can only reach the outside world by asking this proxy,
// which relays TCP only to an allowlisted set of destination hostnames. Every
// other destination is denied and logged. That closes the exfiltration path
// which is what makes prompt injection dangerous in the first place: even a
// fully-compromised agent loop that shells out `curl evil.com` cannot get a
// byte out of the namespace.
//
// Design constraints (see ../README.md and
// .swarm/OPERATING_SYSTEM_SANDBOX_PLAN.md §2):
//   - Fail closed. An empty allowlist refuses to start; an unknown host is
//     denied; a parse failure denies (in strict mode) rather than allowing.
//   - No TLS interception. CONNECT tunnels stay opaque — the proxy never sees
//     plaintext. Allowlisting is by CONNECT target host, plus an optional,
//     strictly-subtractive TLS-SNI check that can only ADD denials (it defeats
//     domain fronting) and can never widen access beyond the host allowlist.
//   - No third-party dependencies. stdlib only, so the audit surface of a
//     component that sits on the security boundary is a single static binary.
//   - Structured JSONL audit to stdout for every allow/deny decision, so
//     denied-egress spikes become the injection tripwire surfaced in the
//     management portal (CLAW-041).
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var (
	// allowlistPtr holds the SHARED BASE allowlist as an atomically-swappable
	// slice pointer: request goroutines read it lock-free via currentAllowlist(),
	// and the reload goroutine (CLAW-034) swaps in a freshly-composed set when a
	// file-backed source changes. Never mutate the pointed-to slice in place.
	// Every client (every bot) may reach a base host; per-bot hosts live in the
	// partition overlay below.
	allowlistPtr atomic.Pointer[[]string]
	// partPtr holds the per-bot PARTITION overlay (CLAW-050): a source-IP → bot
	// map plus each bot's extra allowed hosts (its own static seed ∪ its own
	// learned namespace), matched IN ADDITION to the shared base. When no
	// CLIENT_MAP is configured the partition is empty and every client sees only
	// the base — byte-for-byte the pre-CLAW-050 single-allowlist behavior.
	// Identity is the client SOURCE IP, not a header or proxy port: an
	// unprivileged sandboxed container cannot spoof its source IP on the bridge,
	// whereas it fully controls its own HTTPS_PROXY target — so IP is the only
	// spoof-resistant seam for "which bot is this".
	partPtr      atomic.Pointer[partition]
	sniMode      string // "off" | "lenient" | "strict"
	allowPrivate bool   // EGRESS_ALLOW_PRIVATE=1 disables the special-use-IP guard
	dialer       = &net.Dialer{Timeout: 10 * time.Second}
	transport    = &http.Transport{Proxy: nil}
	auditMu      sync.Mutex
	errPlain     = errors.New("non-tls-clienthello")
	errBlockedIP = errors.New("resolved-to-blocked-ip")
)

// hopHeaders are stripped from proxied plain-HTTP requests/responses.
var hopHeaders = []string{
	"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate",
	"Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade",
}

// partition is the per-bot egress overlay (CLAW-050). It is read-mostly and
// swapped atomically as a whole (never mutated in place), same discipline as
// allowlistPtr.
type partition struct {
	// ipToBot maps a client SOURCE IP to a bot name. Populated from CLIENT_MAP /
	// CLIENT_MAP_FILE. Empty ⇒ partitioning off ⇒ every client sees base only.
	ipToBot map[string]string
	// perBot maps a bot name to the extra hosts that bot alone may reach (its
	// static seed ∪ its learned namespace), matched in ADDITION to the base.
	perBot map[string][]string
}

func main() {
	listen := envOr("LISTEN", ":3128")
	sniMode = strings.ToLower(envOr("SNI_ENFORCE", "lenient"))
	allowPrivate = os.Getenv("EGRESS_ALLOW_PRIVATE") == "1"
	transport.DialContext = guardedDialContext
	openAuditFile() // before the first audit() call, so startup is captured too

	al := rebuildAllowlist()
	if len(al) == 0 {
		log.Fatal("egress-proxy: EMPTY allowlist — refusing to start (fail-closed)")
	}
	allowlistPtr.Store(&al)
	part := rebuildPartition()
	partPtr.Store(part)
	audit(map[string]any{"event": "startup", "listen": listen, "sni_enforce": sniMode,
		"allow_private": allowPrivate, "allow": al, "bots": botSummary(part)})

	// Background hot-reload of the file-backed sources (learned store + static
	// seed) so a vetting-service (CLAW-034) allow takes effect without a recreate.
	go reloadLoop()

	srv := &http.Server{Addr: listen, Handler: http.HandlerFunc(route)}
	log.Fatal(srv.ListenAndServe())
}

func route(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodConnect {
		handleConnect(w, r)
		return
	}
	handleHTTP(w, r)
}

// handleConnect relays an HTTPS (or any TLS/TCP) tunnel, allowlisted by the
// CONNECT target host and, optionally, by the TLS SNI inside the tunnel.
func handleConnect(w http.ResponseWriter, r *http.Request) {
	host, port := hostPort(r.Host, "443")
	client := clientIP(r)
	allowed, bot := hostAllowedFor(client, host)

	if !allowed {
		w.Header().Set("X-Egress-Proxy", "deny")
		http.Error(w, "egress denied by oasis-claw sandbox (host not allowlisted): "+host, http.StatusForbidden)
		// vettable:true marks this as a FIRST-VISIT candidate — a plain unknown
		// hostname the bot asked for — so the CLAW-034 vetting service can queue
		// it. "bot" attributes the miss to a specific bot so the vetter writes to
		// that bot's learned namespace (CLAW-050), not fleet-wide. Contrast the
		// resolved-to-blocked-ip / sni-*-fail denials below, which are hostile
		// (rebind/fronting) and carry no vettable marker.
		audit(map[string]any{"event": "decision", "action": "deny", "proto": "CONNECT",
			"host": host, "port": port, "reason": "host-not-allowlisted", "vettable": true,
			"client": client, "bot": bot})
		return
	}

	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijack unsupported", http.StatusInternalServerError)
		return
	}
	clientConn, _, err := hj.Hijack()
	if err != nil {
		return
	}
	defer clientConn.Close()

	upstream, err := guardedDial(r.Context(), host, port)
	if err != nil {
		action, reason := "error", "upstream-dial-failed"
		if errors.Is(err, errBlockedIP) {
			action, reason = "deny", "resolved-to-blocked-ip"
		}
		writeStatus(clientConn, http.StatusBadGateway, "Bad Gateway")
		audit(map[string]any{"event": "decision", "action": action, "proto": "CONNECT",
			"host": host, "port": port, "reason": reason, "client": client, "bot": bot})
		return
	}
	defer upstream.Close()

	// The client only begins its TLS handshake after seeing 200, so we must
	// acknowledge the tunnel before we can peek the ClientHello.
	writeStatus(clientConn, http.StatusOK, "Connection Established")

	sni := ""
	if sniMode != "off" && port == "443" {
		peeked, parsed, perr := peekSNI(clientConn)
		sni = parsed
		denyReason := ""
		// The SNI is checked against the SAME per-bot envelope as the CONNECT
		// host, so a bot cannot front a peer bot's allowlisted SNI either.
		sniOK, _ := hostAllowedFor(client, parsed)
		switch sniMode {
		case "strict":
			// Require a parseable SNI that is itself allowlisted.
			if perr != nil || parsed == "" || !sniOK {
				denyReason = "sni-strict-fail"
			}
		default: // lenient: only deny a present-but-unallowlisted SNI.
			if perr == nil && parsed != "" && !sniOK {
				denyReason = "sni-not-allowlisted"
			}
		}
		if denyReason != "" {
			audit(map[string]any{"event": "decision", "action": "deny", "proto": "CONNECT",
				"host": host, "port": port, "sni": parsed, "reason": denyReason, "client": client, "bot": bot})
			return // defers reset both conns → client sees a TLS failure
		}
		// Replay the bytes we consumed while peeking so the handshake is intact.
		if len(peeked) > 0 {
			if _, err := upstream.Write(peeked); err != nil {
				return
			}
		}
	}

	audit(map[string]any{"event": "decision", "action": "allow", "proto": "CONNECT",
		"host": host, "port": port, "sni": sni, "client": client, "bot": bot})
	splice(clientConn, upstream)
}

// handleHTTP forwards a plain (non-CONNECT) proxied request, allowlisted by the
// absolute-URI host. Secondary to CONNECT — most agent egress is HTTPS.
func handleHTTP(w http.ResponseWriter, r *http.Request) {
	host, port := hostPort(r.Host, "80")
	client := clientIP(r)
	allowed, bot := hostAllowedFor(client, host)
	if !r.URL.IsAbs() || !allowed {
		w.Header().Set("X-Egress-Proxy", "deny")
		http.Error(w, "egress denied by oasis-claw sandbox (not proxy-form or host not allowlisted): "+host, http.StatusForbidden)
		// vettable:true — first-visit candidate (see the CONNECT path note).
		audit(map[string]any{"event": "decision", "action": "deny", "proto": "HTTP",
			"host": host, "port": port, "reason": "host-not-allowlisted", "vettable": true,
			"client": client, "bot": bot})
		return
	}
	audit(map[string]any{"event": "decision", "action": "allow", "proto": "HTTP",
		"host": host, "port": port, "client": client, "bot": bot})

	r.RequestURI = ""
	for _, h := range hopHeaders {
		r.Header.Del(h)
	}
	resp, err := transport.RoundTrip(r)
	if err != nil {
		http.Error(w, "upstream error", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	for _, h := range hopHeaders {
		resp.Header.Del(h)
	}
	for k, vs := range resp.Header {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

// guardedDialContext is the Transport dial hook for the plain-HTTP path; it
// routes through the same special-use-IP guard as CONNECT.
func guardedDialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port := hostPort(addr, "80")
	return guardedDial(ctx, host, port)
}

// guardedDial resolves host, refuses any special-use / internal destination
// (loopback, RFC1918, link-local incl. 169.254.169.254 metadata, ULA, CGNAT,
// multicast, unspecified), and dials the first *public* address by IP literal.
// Pinning the vetted IP defeats DNS rebinding: the name is resolved once, here,
// and the connection goes to exactly the address we validated — an allowlisted
// hostname re-pointed at an internal IP cannot smuggle the proxy inward. This
// is the closure for the "proxy trusts DNS" caveat in README threat-model.
// EGRESS_ALLOW_PRIVATE=1 disables the guard (fail-open, off by default).
func guardedDial(ctx context.Context, host, port string) (net.Conn, error) {
	if port == "" {
		port = "443"
	}
	var candidates []net.IP
	if ip := net.ParseIP(host); ip != nil {
		candidates = []net.IP{ip}
	} else {
		resolved, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
		if err != nil {
			return nil, err
		}
		candidates = resolved
	}
	for _, ip := range candidates {
		if allowPrivate || !specialIP(ip) {
			return dialer.DialContext(ctx, "tcp", net.JoinHostPort(ip.String(), port))
		}
	}
	return nil, errBlockedIP
}

// specialIP reports whether ip is a special-use / non-public address the proxy
// must never dial on the sandbox's behalf. Covers loopback, unspecified,
// link-local (169.254/16 + fe80::/10 — includes the cloud metadata endpoint),
// multicast, RFC1918 + ULA (via IsPrivate), and RFC6598 CGNAT (100.64/10).
func specialIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() || ip.IsMulticast() ||
		ip.IsPrivate() {
		return true
	}
	if v4 := ip.To4(); v4 != nil && v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127 {
		return true // 100.64.0.0/10 carrier-grade NAT
	}
	return false
}

// peekSNI reads the first TLS record (the ClientHello) from the client and
// returns the raw bytes read — so the caller can replay them upstream — plus
// the SNI server_name if present. A read/parse failure returns whatever bytes
// were read plus an error; the caller decides how to treat that per sniMode.
func peekSNI(c net.Conn) ([]byte, string, error) {
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	defer c.SetReadDeadline(time.Time{})

	hdr := make([]byte, 5)
	if _, err := io.ReadFull(c, hdr); err != nil {
		return nil, "", err
	}
	if hdr[0] != 0x16 { // 0x16 = TLS handshake content type
		return hdr, "", errPlain
	}
	n := int(hdr[3])<<8 | int(hdr[4])
	if n <= 0 || n > 16384 { // TLS record payload max
		return hdr, "", errPlain
	}
	body := make([]byte, n)
	if _, err := io.ReadFull(c, body); err != nil {
		return hdr, "", err
	}
	buf := make([]byte, 0, 5+n)
	buf = append(buf, hdr...)
	buf = append(buf, body...)
	return buf, parseSNI(body), nil
}

// parseSNI extracts the server_name from a TLS ClientHello handshake body.
// Every field is length-checked; any malformation returns "" (which, combined
// with the caller's fail-closed handling, can only ever cause a deny).
func parseSNI(b []byte) string {
	// Handshake header: type(1) + length(3).
	if len(b) < 4 || b[0] != 0x01 { // 0x01 = ClientHello
		return ""
	}
	p := 4
	p += 2  // client_version
	p += 32 // random
	if p > len(b) {
		return ""
	}
	// session_id
	if p >= len(b) {
		return ""
	}
	sidLen := int(b[p])
	p += 1 + sidLen
	// cipher_suites
	if p+2 > len(b) {
		return ""
	}
	csLen := int(b[p])<<8 | int(b[p+1])
	p += 2 + csLen
	// compression_methods
	if p+1 > len(b) {
		return ""
	}
	cmLen := int(b[p])
	p += 1 + cmLen
	// extensions
	if p+2 > len(b) {
		return ""
	}
	extTotal := int(b[p])<<8 | int(b[p+1])
	p += 2
	end := p + extTotal
	if end > len(b) {
		end = len(b)
	}
	for p+4 <= end {
		etype := int(b[p])<<8 | int(b[p+1])
		elen := int(b[p+2])<<8 | int(b[p+3])
		p += 4
		if p+elen > end {
			break
		}
		if etype == 0x0000 { // server_name
			return parseServerName(b[p : p+elen])
		}
		p += elen
	}
	return ""
}

func parseServerName(d []byte) string {
	// server_name_list: length(2) then entries of type(1)+length(2)+name.
	if len(d) < 2 {
		return ""
	}
	listLen := int(d[0])<<8 | int(d[1])
	p := 2
	end := p + listLen
	if end > len(d) {
		end = len(d)
	}
	for p+3 <= end {
		nameType := d[p]
		nlen := int(d[p+1])<<8 | int(d[p+2])
		p += 3
		if p+nlen > end {
			break
		}
		if nameType == 0 { // host_name
			return strings.ToLower(string(d[p : p+nlen]))
		}
		p += nlen
	}
	return ""
}

// splice copies bytes in both directions until either side closes, then
// half-closes the peers to propagate EOF.
func splice(a, b net.Conn) {
	var wg sync.WaitGroup
	wg.Add(2)
	pipe := func(dst, src net.Conn) {
		defer wg.Done()
		_, _ = io.Copy(dst, src)
		if cw, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = cw.CloseWrite()
		}
	}
	go pipe(a, b)
	go pipe(b, a)
	wg.Wait()
}

// currentAllowlist returns the effective allowlist snapshot (lock-free read).
func currentAllowlist() []string {
	if p := allowlistPtr.Load(); p != nil {
		return *p
	}
	return nil
}

// matchHost reports whether host matches any entry in list. An entry beginning
// with "." matches that domain and any subdomain; a bare entry matches exactly.
func matchHost(host string, list []string) bool {
	h := strings.ToLower(strings.TrimSuffix(host, "."))
	if h == "" {
		return false
	}
	for _, a := range list {
		if strings.HasPrefix(a, ".") {
			if h == a[1:] || strings.HasSuffix(h, a) {
				return true
			}
		} else if h == a {
			return true
		}
	}
	return false
}

// hostAllowed reports whether host is reachable by ANY client (i.e. it is in the
// shared base). Kept for the base-only case + tests; the request paths use
// hostAllowedFor so a per-bot host is honored for its owning bot.
func hostAllowed(host string) bool { return matchHost(host, currentAllowlist()) }

// botFor resolves a client source IP to its bot name via the partition overlay,
// or "" when partitioning is off or the IP is unmapped.
func botFor(clientIP string) string {
	if p := partPtr.Load(); p != nil {
		return p.ipToBot[clientIP]
	}
	return ""
}

// hostAllowedFor is the per-bot reachability decision (CLAW-050). A host is
// allowed if it is in the shared base (reachable by everyone) OR in the calling
// bot's own extra set. It also returns the resolved bot name so callers can
// attribute the decision in the audit log. When partitioning is off, perBot is
// empty and this collapses to the base-only check — identical to hostAllowed.
func hostAllowedFor(clientIP, host string) (bool, string) {
	bot := botFor(clientIP)
	if matchHost(host, currentAllowlist()) {
		return true, bot
	}
	if bot != "" {
		if p := partPtr.Load(); p != nil && matchHost(host, p.perBot[bot]) {
			return true, bot
		}
	}
	return false, bot
}

// rebuildAllowlist composes the effective allowlist from every source in a
// deduped, lowercased union:
//   - ALLOWLIST env (comma/space/newline separated) — deployment-fixed at boot
//   - ALLOWLIST_FILE (default /etc/egress/allowlist.txt) — the STATIC SEED,
//     baked into the image or rendered from a role manifest's origins.trusted
//     by a TRUSTED step (never the sandboxed bot)
//   - LEARNED_ALLOWLIST_FILE — the LEARNED store, appended ONLY by the
//     first-visit vetting service (CLAW-034) after a pass verdict. It lives on a
//     volume the bot cannot write, so a compromised agent loop can never widen
//     its own egress by editing it.
//
// The learned file is optional: a missing/empty file contributes nothing and is
// NOT fatal, so the proxy always boots on the static seed alone (fail-closed).
func rebuildAllowlist() []string {
	add, out := hostAccumulator()
	for _, tok := range strings.FieldsFunc(os.Getenv("ALLOWLIST"), splitList) {
		add(tok)
	}
	appendHostFile(envOr("ALLOWLIST_FILE", "/etc/egress/allowlist.txt"), add)
	appendHostFile(os.Getenv("LEARNED_ALLOWLIST_FILE"), add)
	return *out
}

// hostAccumulator returns an add() that appends deduped (case-insensitive),
// trimmed, comment/blank-skipping host entries into the backing slice *out.
func hostAccumulator() (add func(string), out *[]string) {
	var list []string
	seen := map[string]bool{}
	add = func(s string) {
		s = strings.ToLower(strings.TrimSpace(s))
		if s == "" || strings.HasPrefix(s, "#") || seen[s] {
			return
		}
		seen[s] = true
		list = append(list, s)
	}
	return add, &list
}

// appendHostFile feeds each line of path (if it exists and is readable) into
// add. A missing/unreadable file contributes nothing — the learned + per-bot
// stores are optional, so the proxy always boots on the base seed (fail-closed).
func appendHostFile(path string, add func(string)) {
	if path == "" {
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(data), "\n") {
		add(line)
	}
}

func splitList(r rune) bool {
	return r == ',' || r == ' ' || r == '\t' || r == '\n' || r == '\r'
}

// rebuildPartition composes the per-bot overlay (CLAW-050) from:
//   - CLIENT_MAP / CLIENT_MAP_FILE — "ip=bot" pairs → the source-IP → bot map.
//   - SEED_DIR/<bot>/allowlist.txt — that bot's STATIC seed (from its role.yaml
//     origins.trusted, rendered by a trusted step — never the bot itself).
//   - LEARNED_DIR/<bot>/allowlist.txt — that bot's LEARNED namespace, appended
//     only by the vetting service (claw-vet) after a pass for THAT bot.
//
// When CLIENT_MAP is empty the returned partition has no clients and no per-bot
// hosts, so hostAllowedFor collapses to the shared-base check for every client —
// exactly the pre-CLAW-050 behavior. Missing seed/learned files are no-ops.
func rebuildPartition() *partition {
	ipToBot := parseClientMap()
	perBot := map[string][]string{}
	seedDir, learnedDir := os.Getenv("SEED_DIR"), os.Getenv("LEARNED_DIR")
	for _, bot := range partitionBots(ipToBot) {
		add, out := hostAccumulator()
		if seedDir != "" {
			appendHostFile(filepath.Join(seedDir, bot, "allowlist.txt"), add)
		}
		if learnedDir != "" {
			appendHostFile(filepath.Join(learnedDir, bot, "allowlist.txt"), add)
		}
		perBot[bot] = *out
	}
	return &partition{ipToBot: ipToBot, perBot: perBot}
}

// parseClientMap reads "ip=bot" pairs (comma/space/newline separated) from
// CLIENT_MAP and CLIENT_MAP_FILE into a source-IP → bot map. Bot names are
// lowercased; malformed tokens are skipped.
func parseClientMap() map[string]string {
	m := map[string]string{}
	addPairs := func(s string) {
		for _, line := range strings.Split(s, "\n") {
			if i := strings.IndexByte(line, '#'); i >= 0 {
				line = line[:i] // strip full-line or inline comment
			}
			for _, tok := range strings.FieldsFunc(line, splitList) {
				i := strings.IndexByte(tok, '=')
				if i <= 0 {
					continue
				}
				ip := strings.TrimSpace(tok[:i])
				bot := strings.ToLower(strings.TrimSpace(tok[i+1:]))
				if ip != "" && bot != "" {
					m[ip] = bot
				}
			}
		}
	}
	addPairs(os.Getenv("CLIENT_MAP"))
	if f := os.Getenv("CLIENT_MAP_FILE"); f != "" {
		if data, err := os.ReadFile(f); err == nil {
			addPairs(string(data))
		}
	}
	return m
}

// partitionBots returns the sorted, deduped set of bot names referenced by the
// client map — the bots whose per-bot files must be composed and watched.
func partitionBots(ipToBot map[string]string) []string {
	set := map[string]bool{}
	for _, b := range ipToBot {
		set[b] = true
	}
	bots := make([]string, 0, len(set))
	for b := range set {
		bots = append(bots, b)
	}
	sort.Strings(bots)
	return bots
}

// botSummary renders bot → host-count for the startup/reload audit line.
func botSummary(p *partition) map[string]int {
	if p == nil {
		return nil
	}
	out := map[string]int{}
	for bot, hosts := range p.perBot {
		out[bot] = len(hosts)
	}
	return out
}

// reloadLoop periodically re-reads the file-backed sources and atomically swaps
// in the new set when either the static seed or the learned store changes on
// disk, so a vetting-service allow (CLAW-034) takes effect without recreating
// the proxy. Poll-by-mtime keeps the security-boundary binary stdlib-only (no
// fsnotify dependency); the async vet-and-learn model tolerates the few-second
// latency. LEARNED_RELOAD_SECONDS=0 disables reloading (static-only, the
// pre-CLAW-034 behavior).
func reloadLoop() {
	every := envInt("LEARNED_RELOAD_SECONDS", 5)
	if every <= 0 {
		return
	}
	last := fingerprint()
	t := time.NewTicker(time.Duration(every) * time.Second)
	defer t.Stop()
	for range t.C {
		fp := fingerprint()
		if fp == last {
			continue
		}
		last = fp
		al := rebuildAllowlist()
		if len(al) == 0 {
			// A truncated/unreadable reload must never open OR blank the gate —
			// keep the last-known-good set (base AND partition) and shout so the
			// tripwire fires.
			audit(map[string]any{"event": "reload", "action": "rejected",
				"reason": "empty-after-reload-kept-previous"})
			continue
		}
		allowlistPtr.Store(&al)
		part := rebuildPartition()
		partPtr.Store(part)
		audit(map[string]any{"event": "reload", "action": "applied",
			"count": len(al), "bots": botSummary(part)})
	}
}

// fingerprint is a change-token over every file-backed source the effective
// allow-state depends on: the shared base (static seed + global learned), the
// client map, and each mapped bot's seed + learned files. Any content change
// bumps at least one mtime, so the reload loop re-composes. Poll-by-mtime keeps
// the security-boundary binary stdlib-only (no fsnotify).
func fingerprint() string {
	var sb strings.Builder
	stamp := func(p string) {
		if p != "" {
			fmt.Fprintf(&sb, "%s=%d;", p, mtime(p))
		}
	}
	stamp(envOr("ALLOWLIST_FILE", "/etc/egress/allowlist.txt"))
	stamp(os.Getenv("LEARNED_ALLOWLIST_FILE"))
	stamp(os.Getenv("CLIENT_MAP_FILE"))
	seedDir, learnedDir := os.Getenv("SEED_DIR"), os.Getenv("LEARNED_DIR")
	for _, bot := range partitionBots(parseClientMap()) {
		if seedDir != "" {
			stamp(filepath.Join(seedDir, bot, "allowlist.txt"))
		}
		if learnedDir != "" {
			stamp(filepath.Join(learnedDir, bot, "allowlist.txt"))
		}
	}
	return sb.String()
}

// mtime returns path's modification time in unix-nanos, or 0 if absent/unreadable
// (so a not-yet-created learned file reads as 0 and its first write is detected).
func mtime(path string) int64 {
	if path == "" {
		return 0
	}
	fi, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return fi.ModTime().UnixNano()
}

func hostPort(hostport, defPort string) (string, string) {
	if h, p, err := net.SplitHostPort(hostport); err == nil {
		return h, p
	}
	return hostport, defPort
}

func clientIP(r *http.Request) string {
	if h, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return h
	}
	return r.RemoteAddr
}

func writeStatus(c net.Conn, code int, msg string) {
	_, _ = fmt.Fprintf(c, "HTTP/1.1 %d %s\r\n\r\n", code, msg)
}

// ── audit sink ───────────────────────────────────────────────────────────────
// stdout is the primary sink and never goes away (docker logs stays the
// operator's view). AUDIT_FILE adds a SECOND sink so the vetting service can
// read the deny stream without a docker socket — reading `docker logs` requires
// mounting /var/run/docker.sock, which would hand the vetter root-equivalent
// control of the host. A shared file is the whole reason that mount is
// unnecessary. Optional: unset ⇒ byte-for-byte the previous behavior.
var (
	auditFile     *os.File
	auditBytes    int64
	auditMaxBytes int64
)

func openAuditFile() {
	path := os.Getenv("AUDIT_FILE")
	if path == "" {
		return
	}
	auditMaxBytes = int64(envInt("AUDIT_MAX_BYTES", 32<<20)) // 32 MiB
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		// Non-fatal: losing the secondary sink must never take the egress
		// boundary down. The proxy keeps auditing to stdout.
		log.Printf("egress-proxy: AUDIT_FILE %q unusable (%v) — stdout only", path, err)
		return
	}
	if st, err := f.Stat(); err == nil {
		auditBytes = st.Size()
	}
	auditFile = f
}

// rotateAuditLocked keeps the file bounded (one generation, .1). Called with
// auditMu held. A rotation failure degrades to stdout-only rather than growing
// without bound or killing the proxy.
func rotateAuditLocked() {
	path := auditFile.Name()
	_ = auditFile.Close()
	if err := os.Rename(path, path+".1"); err != nil {
		log.Printf("egress-proxy: audit rotate failed (%v) — stdout only", err)
		auditFile = nil
		return
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		log.Printf("egress-proxy: audit reopen failed (%v) — stdout only", err)
		auditFile = nil
		return
	}
	auditFile, auditBytes = f, 0
}

func audit(m map[string]any) {
	m["ts_unix"] = time.Now().Unix()
	b, _ := json.Marshal(m)
	b = append(b, '\n')
	auditMu.Lock()
	_, _ = os.Stdout.Write(b)
	if auditFile != nil {
		if n, err := auditFile.Write(b); err == nil {
			auditBytes += int64(n)
			if auditMaxBytes > 0 && auditBytes >= auditMaxBytes {
				rotateAuditLocked()
			}
		}
	}
	auditMu.Unlock()
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func envInt(k string, d int) int {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return d
}
