package main

import (
	"os"
	"path/filepath"
	"testing"
)

// rebuildAllowlist must union the env + static seed + learned store, dedup
// (case-insensitively), drop comments/blanks, and treat a missing learned file
// as a no-op (the learned store is optional — CLAW-034).
func TestRebuildAllowlist_UnionDedupComments(t *testing.T) {
	dir := t.TempDir()
	staticFile := filepath.Join(dir, "allowlist.txt")
	learnedFile := filepath.Join(dir, "learned.txt")
	mustWrite(t, staticFile, "# core provider endpoints\n.anthropic.com\napi.telegram.org\n")
	// learned re-lists .anthropic.com (dup) + adds github.com
	mustWrite(t, learnedFile, "# vetted 2026-07-16\ngithub.com\n.ANTHROPIC.com\n")

	t.Setenv("ALLOWLIST", "api.telegram.org, extra.example.com")
	t.Setenv("ALLOWLIST_FILE", staticFile)
	t.Setenv("LEARNED_ALLOWLIST_FILE", learnedFile)

	got := rebuildAllowlist()
	want := map[string]bool{
		"api.telegram.org":  true,
		"extra.example.com": true,
		".anthropic.com":    true,
		"github.com":        true,
	}
	if len(got) != len(want) {
		t.Fatalf("got %d entries %v, want %d", len(got), got, len(want))
	}
	for _, g := range got {
		if !want[g] {
			t.Errorf("unexpected entry %q", g)
		}
	}
}

// A missing/unset learned file must never fail the composition — the proxy
// still boots on the static seed alone (fail-closed, not fail-empty).
func TestRebuildAllowlist_LearnedMissingIsNoOp(t *testing.T) {
	dir := t.TempDir()
	staticFile := filepath.Join(dir, "allowlist.txt")
	mustWrite(t, staticFile, ".anthropic.com\n")
	t.Setenv("ALLOWLIST", "")
	t.Setenv("ALLOWLIST_FILE", staticFile)
	t.Setenv("LEARNED_ALLOWLIST_FILE", filepath.Join(dir, "nope.txt"))

	got := rebuildAllowlist()
	if len(got) != 1 || got[0] != ".anthropic.com" {
		t.Fatalf("missing learned file should be a no-op; got %v", got)
	}
}

// hostAllowed honors "."-prefixed wildcard vs bare exact match, and a lock-free
// atomic swap of the effective set (the reload path a vetter's learned entry
// takes) is observed by subsequent reads.
func TestHostAllowed_WildcardExactAndAtomicSwap(t *testing.T) {
	base := []string{".anthropic.com", "api.telegram.org"}
	allowlistPtr.Store(&base)

	cases := map[string]bool{
		"api.anthropic.com": true,  // subdomain wildcard
		"anthropic.com":     true,  // apex matches ".anthropic.com"
		"api.telegram.org":  true,  // exact
		"api.telegram.org.": true,  // trailing-dot FQDN normalized
		"evil.telegram.org": false, // bare entry is not a wildcard
		"github.com":        false, // not yet learned
		"":                  false,
	}
	for host, want := range cases {
		if got := hostAllowed(host); got != want {
			t.Errorf("hostAllowed(%q) = %v, want %v", host, got, want)
		}
	}

	// Simulate the vetter learning github.com: swap in an extended set and
	// confirm the new entry is live without any lock on the read path.
	extended := append(append([]string{}, base...), "github.com")
	allowlistPtr.Store(&extended)
	if !hostAllowed("github.com") {
		t.Error("after atomic swap, github.com should be allowed")
	}
	if !hostAllowed("api.anthropic.com") {
		t.Error("pre-existing entries must survive the swap")
	}
}

// mtime returns 0 for an absent path (so a not-yet-created learned file reads as
// 0 and its first write is detected as a change by reloadLoop).
func TestMtime_AbsentIsZero(t *testing.T) {
	if mtime("") != 0 {
		t.Error("empty path should be 0")
	}
	if mtime(filepath.Join(t.TempDir(), "absent")) != 0 {
		t.Error("absent path should be 0")
	}
	f := filepath.Join(t.TempDir(), "present")
	mustWrite(t, f, "x")
	if mtime(f) == 0 {
		t.Error("present path should be non-zero")
	}
}

// CLAW-050: the per-bot partition must (1) let every bot reach the shared base,
// (2) let a bot reach its OWN seed+learned hosts, and — the load-bearing
// isolation property — (3) DENY a bot its peer's hosts. An unmapped source IP
// gets base only. Identity is the source IP.
func TestHostAllowedFor_PerBotIsolation(t *testing.T) {
	dir := t.TempDir()
	seedDir := filepath.Join(dir, "seeds")
	learnedDir := filepath.Join(dir, "learned")
	// vanhelsing: seed exploit-db.com ; house: learned polymarket.com
	mustWrite(t, filepath.Join(seedDir, "vanhelsing", "allowlist.txt"), "exploit-db.com\n")
	mustWrite(t, filepath.Join(learnedDir, "house", "allowlist.txt"), "# vetted\npolymarket.com\n")

	t.Setenv("CLIENT_MAP", "10.0.0.5=vanhelsing, 10.0.0.6=house")
	t.Setenv("SEED_DIR", seedDir)
	t.Setenv("LEARNED_DIR", learnedDir)

	base := []string{".anthropic.com"}
	allowlistPtr.Store(&base)
	partPtr.Store(rebuildPartition())

	const vhIP, houseIP, strayIP = "10.0.0.5", "10.0.0.6", "10.0.0.99"
	type tc struct {
		ip, host string
		want     bool
		wantBot  string
	}
	for _, c := range []tc{
		// shared base — reachable by everyone, mapped or not
		{vhIP, "api.anthropic.com", true, "vanhelsing"},
		{houseIP, "api.anthropic.com", true, "house"},
		{strayIP, "api.anthropic.com", true, ""},
		// each bot reaches its own host
		{vhIP, "exploit-db.com", true, "vanhelsing"},
		{houseIP, "polymarket.com", true, "house"},
		// ISOLATION: neither bot can reach the other's host
		{vhIP, "polymarket.com", false, "vanhelsing"},
		{houseIP, "exploit-db.com", false, "house"},
		// unmapped IP gets base only — none of the per-bot hosts
		{strayIP, "exploit-db.com", false, ""},
		{strayIP, "polymarket.com", false, ""},
	} {
		got, bot := hostAllowedFor(c.ip, c.host)
		if got != c.want || bot != c.wantBot {
			t.Errorf("hostAllowedFor(%s, %q) = (%v, %q), want (%v, %q)",
				c.ip, c.host, got, bot, c.want, c.wantBot)
		}
	}
}

// With no CLIENT_MAP, the partition is empty and hostAllowedFor collapses to the
// base-only check for ANY source IP — byte-for-byte the pre-CLAW-050 behavior.
func TestHostAllowedFor_NoClientMapIsBaseOnly(t *testing.T) {
	t.Setenv("CLIENT_MAP", "")
	t.Setenv("CLIENT_MAP_FILE", "")
	base := []string{".anthropic.com", "api.telegram.org"}
	allowlistPtr.Store(&base)
	partPtr.Store(rebuildPartition())

	for _, ip := range []string{"10.0.0.5", "172.22.0.9", ""} {
		if ok, bot := hostAllowedFor(ip, "api.anthropic.com"); !ok || bot != "" {
			t.Errorf("base host must be allowed for %q with empty bot; got (%v,%q)", ip, ok, bot)
		}
		if ok, _ := hostAllowedFor(ip, "github.com"); ok {
			t.Errorf("non-base host must be denied for %q when partitioning off", ip)
		}
	}
}

// parseClientMap tolerates comma/space/newline separators + a file source, and
// partitionBots returns the sorted deduped bot set.
func TestParseClientMap_AndBots(t *testing.T) {
	dir := t.TempDir()
	mapFile := filepath.Join(dir, "clients.map")
	mustWrite(t, mapFile, "10.0.0.7=kolmogorov\n# comment=ignored-as-pair? no\n")
	t.Setenv("CLIENT_MAP", "10.0.0.5=vanhelsing 10.0.0.6=house,10.0.0.5=vanhelsing")
	t.Setenv("CLIENT_MAP_FILE", mapFile)

	m := parseClientMap()
	if m["10.0.0.5"] != "vanhelsing" || m["10.0.0.6"] != "house" || m["10.0.0.7"] != "kolmogorov" {
		t.Fatalf("unexpected client map: %v", m)
	}
	bots := partitionBots(m)
	want := []string{"house", "kolmogorov", "vanhelsing"}
	if len(bots) != len(want) {
		t.Fatalf("bots = %v, want %v", bots, want)
	}
	for i := range want {
		if bots[i] != want[i] {
			t.Fatalf("bots[%d] = %q, want %q (sorted)", i, bots[i], want[i])
		}
	}
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
