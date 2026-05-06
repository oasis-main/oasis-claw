// Local-dev stub: no listeners are wired in this environment. The runtime
// container loads the real openclaw package, which exposes a working
// registerSkillsChangeListener — the plugin's own poll-loop fallback covers
// any gap. Returning a no-op unsubscribe keeps the call signature stable.
export function registerSkillsChangeListener(_listener) {
  return () => {};
}

export function bumpSkillsSnapshotVersion(_params) {
  return 0;
}

export function getSkillsSnapshotVersion(_workspaceDir) {
  return 0;
}

export function shouldRefreshSnapshotForVersion(_cachedVersion, _nextVersion) {
  return false;
}
