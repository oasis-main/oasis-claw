#!/usr/bin/env node
// Docker-build-time patch adding two generic env-var theming overrides to
// openclaw's compiled dist. This is NOT a bug fix (unlike
// scripts/patch-openclaw-cache-state.mjs / CLAW-083) — it is new optional
// behavior, defaulting to today's exact hardcoded behavior when the new env
// vars are unset. This script does not choose or hardcode any bot name or
// color; that choice belongs to each bot's own .env file downstream.
//
// Two independent patch targets, three total patch sites:
//
// (1) CLI startup banner title (openclaw's src/cli/banner.ts, compiled into
//     one dist chunk). The banner line builds its title from the bare
//     literal "OpenClaw". Patched to read from OASIS_TUI_BANNER_TITLE, with
//     "OpenClaw" as the fallback when that env var is unset or empty.
//
// (2) TUI/CLI accent color. There are two separate hardcoded color palettes
//     in openclaw:
//       (a) packages/terminal-core/src/palette.ts's LOBSTER_PALETTE — used
//           for general CLI/banner output. accent hex FF5A2D.
//       (b) src/tui/theme/theme.ts's darkPalette/lightPalette — used inside
//           the interactive chat TUI. accent hex F6C453 (dark) / B45309
//           (light).
//     theme.ts's darkPalette/lightPalette objects also set toolTitle to the
//     SAME hex as their own accent field, so toolTitle is patched alongside
//     accent at each site (five total hex literals: LOBSTER_PALETTE accent,
//     dark accent, dark toolTitle, light accent, light toolTitle) — without
//     this, a bot setting OASIS_TUI_ACCENT_COLOR would see its general
//     accent change but tool-title text stay the original amber/gold, an
//     inconsistent partial recolor.
//     All five hex literals are patched to read from the SAME env var,
//     OASIS_TUI_ACCENT_COLOR, with the original hex as fallback when unset —
//     so setting one env var re-colors the banner and every accented surface
//     inside the interactive TUI consistently. Each original hex value is
//     kept as the literal fallback, so this is a no-op when the env var is
//     unset.
//
// Patches COMPILED output inside the GLOBAL npm install
// ($(npm root -g)/openclaw/dist/**), not vendor/openclaw/src (a read-only
// reference copy the Dockerfile never consumes — see vendor/openclaw's
// .gitmodules comment). Fails the build loudly on any mismatch rather than
// silently shipping unpatched, per this repo's standing policy (see
// scripts/patch-openclaw-cache-state.mjs) that a patch which appears to
// apply but silently does nothing is itself a bug class to avoid.
//
// Unlike scripts/patch-openclaw-cache-state.mjs, there is no legitimate
// "already fixed upstream" no-op case here — this is homegrown optional
// behavior openclaw upstream has no reason to have added on its own. So
// every patch site below fails loudly (zero matches OR more than one match)
// rather than tolerating a zero-match case as expected.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const globalRoot = execSync("npm root -g").toString().trim();
const distDir = `${globalRoot}/openclaw/dist`;

/**
 * Find exactly one compiled file under distDir containing the given literal
 * (fixed-string, not regex) substring. Fails the build loudly on zero or
 * more than one match — refusing to guess which file to patch.
 *
 * Excludes *.d.ts: openclaw's dist ships a TypeScript type-declaration
 * sibling next to some compiled chunks (e.g. palette-*.d.ts next to
 * palette-*.js), and a literal color/string can appear in both as a type
 * literal. .d.ts files are never loaded by Node at runtime, so they are not
 * a patch target — only excluding them here, not the search from finding
 * the real runtime .js chunk.
 */
function findSingleFile(literal, label) {
  let candidates;
  try {
    candidates = execSync(
      `grep -rlF --exclude='*.d.ts' '${literal}' "${distDir}"`,
      { encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch (err) {
    // grep exits 1 with empty output when no file matches.
    if (err.status === 1 && !err.stdout?.toString().trim()) {
      candidates = [];
    } else {
      throw err;
    }
  }

  if (candidates.length === 0) {
    console.error(
      `[patch-openclaw-theme] no compiled file under ${distDir} contains the ${label} ` +
        `literal ${JSON.stringify(literal)}. OPENCLAW_VERSION likely changed the compiled ` +
        "shape this patch expects. Refusing to guess — failing the build. Re-derive this " +
        "patch against the new compiled output.",
    );
    process.exit(1);
  }

  if (candidates.length > 1) {
    console.error(
      `[patch-openclaw-theme] expected exactly one compiled file containing the ${label} ` +
        `literal ${JSON.stringify(literal)}, found ${candidates.length}: ` +
        `${candidates.join(", ")}. Refusing to guess which one to patch — failing the build.`,
    );
    process.exit(1);
  }

  return candidates[0];
}

/**
 * Replace the exact expected old text with new text in `file`. Fails the
 * build loudly if the old text is not found verbatim.
 */
function applyExactPatch(file, oldText, newText, label) {
  const before = readFileSync(file, "utf8");

  if (!before.includes(oldText)) {
    console.error(
      `[patch-openclaw-theme] ${file} does not contain the exact expected ${label} text. ` +
        "OPENCLAW_VERSION likely changed and this patch text is stale relative to it. " +
        "Refusing to guess or partially apply — failing the build. Re-derive the patch " +
        "against the new compiled output.",
    );
    process.exit(1);
  }

  writeFileSync(file, before.replace(oldText, newText));
  console.log(`[patch-openclaw-theme] patched ${file} — ${label}`);
}

// ---------------------------------------------------------------------
// (1) CLI startup banner title — src/cli/banner.ts
// ---------------------------------------------------------------------
{
  const file = findSingleFile(
    'decorativePrefix("🦞", "OpenClaw", emojiOptions)',
    "banner title",
  );

  const OLD = '\tconst title = decorativePrefix("🦞", "OpenClaw", emojiOptions);';
  const NEW =
    '\tconst title = decorativePrefix("🦞", process.env.OASIS_TUI_BANNER_TITLE || "OpenClaw", emojiOptions);';

  applyExactPatch(
    file,
    OLD,
    NEW,
    "banner title now reads OASIS_TUI_BANNER_TITLE (falls back to \"OpenClaw\")",
  );
}

// ---------------------------------------------------------------------
// (2a) LOBSTER_PALETTE accent — packages/terminal-core/src/palette.ts
// ---------------------------------------------------------------------
{
  const file = findSingleFile("#FF5A2D", "LOBSTER_PALETTE accent");

  const OLD = '\taccent: "#FF5A2D",';
  const NEW = '\taccent: process.env.OASIS_TUI_ACCENT_COLOR || "#FF5A2D",';

  applyExactPatch(
    file,
    OLD,
    NEW,
    "LOBSTER_PALETTE accent now reads OASIS_TUI_ACCENT_COLOR (falls back to \"#FF5A2D\")",
  );
}

// ---------------------------------------------------------------------
// (2b) darkPalette/lightPalette accent + toolTitle — src/tui/theme/theme.ts
//
// All four hex constants are expected in the SAME compiled file (they come
// from one bundled source module). Cross-checked below rather than assumed.
// ---------------------------------------------------------------------
{
  const darkAccentFile = findSingleFile("#F6C453", "theme.ts darkPalette accent/toolTitle");
  const lightAccentFile = findSingleFile("#B45309", "theme.ts lightPalette accent/toolTitle");

  if (darkAccentFile !== lightAccentFile) {
    console.error(
      "[patch-openclaw-theme] expected theme.ts's darkPalette (#F6C453) and lightPalette " +
        `(#B45309) hexes in the SAME compiled file, but found them in different files ` +
        `(${darkAccentFile} vs ${lightAccentFile}). OPENCLAW_VERSION likely changed how this ` +
        "module is bundled. Refusing to guess — failing the build.",
    );
    process.exit(1);
  }

  const file = darkAccentFile;

  applyExactPatch(
    file,
    '\taccent: "#F6C453",',
    '\taccent: process.env.OASIS_TUI_ACCENT_COLOR || "#F6C453",',
    "theme.ts darkPalette accent now reads OASIS_TUI_ACCENT_COLOR (falls back to \"#F6C453\")",
  );

  applyExactPatch(
    file,
    '\taccent: "#B45309",',
    '\taccent: process.env.OASIS_TUI_ACCENT_COLOR || "#B45309",',
    "theme.ts lightPalette accent now reads OASIS_TUI_ACCENT_COLOR (falls back to \"#B45309\")",
  );

  applyExactPatch(
    file,
    '\ttoolTitle: "#F6C453",',
    '\ttoolTitle: process.env.OASIS_TUI_ACCENT_COLOR || "#F6C453",',
    "theme.ts darkPalette toolTitle now reads OASIS_TUI_ACCENT_COLOR (falls back to \"#F6C453\")",
  );

  applyExactPatch(
    file,
    '\ttoolTitle: "#B45309",',
    '\ttoolTitle: process.env.OASIS_TUI_ACCENT_COLOR || "#B45309",',
    "theme.ts lightPalette toolTitle now reads OASIS_TUI_ACCENT_COLOR (falls back to \"#B45309\")",
  );
}

console.log(
  "[patch-openclaw-theme] all five theming patch sites applied " +
    "(banner title + LOBSTER_PALETTE accent + TUI dark/light palette accent + toolTitle).",
);
