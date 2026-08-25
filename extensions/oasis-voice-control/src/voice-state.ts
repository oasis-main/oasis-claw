import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The bot's own chosen speaking voice.
 *
 * WHY A FILE AND NOT CONFIG. The obvious implementation is to write
 * `messages.tts.providers["oasis-voice"].tts_voice` in openclaw.json. Do not do
 * that. Mutating openclaw.json underneath a LIVE gateway makes the next turn die
 * with "config changed since last load" — a known failure in this fleet that
 * surfaces to the user as "Something went wrong" and needs a container restart.
 *
 * A small side file avoids the whole problem. The oasis-voice speech provider
 * reads it per synthesis (extensions/oasis-voice/speech-provider.ts,
 * readVoiceOverride), so a change takes effect on the very next spoken reply
 * with no restart and no recreate.
 *
 * Resolution order, highest first:
 *   1. this file            — the bot's own choice, via voice_set
 *   2. tts_voice in config  — OASIS_VOICE_TTS_VOICE, set by the operator
 *   3. the built-in default
 *
 * Consequence accepted deliberately: the bot's voice becomes bot-controlled
 * state. An operator who wants to FORCE a voice must set the env var AND clear
 * this file. `voice_list` reports which source is currently winning so the
 * reason for a voice is never a mystery.
 *
 * Keep the path and the field name in sync with the reader in
 * extensions/oasis-voice/speech-provider.ts. The duplication is deliberate:
 * extensions are separate packages mounted side by side, and a relative import
 * across them is fragile.
 */

const VOICE_OVERRIDE_FILE = "voice-choice.json";

export type VoiceChoice = {
  voice_id: string;
  chosen_at: string;
};

export function overridePath(): string {
  const home = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
  return path.join(home, VOICE_OVERRIDE_FILE);
}

export function readVoiceChoice(): VoiceChoice | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(overridePath(), "utf8")) as Partial<VoiceChoice>;
    const v = raw?.voice_id;
    if (typeof v !== "string" || v.length === 0) {
      return undefined;
    }
    return { voice_id: v, chosen_at: typeof raw.chosen_at === "string" ? raw.chosen_at : "unknown" };
  } catch {
    // Absent is the normal case on a bot that has never chosen. Malformed
    // degrades the same way rather than throwing: losing the chosen voice is
    // recoverable, losing speech entirely is not.
    return undefined;
  }
}

/**
 * Write atomically. A torn write would leave the provider reading half a JSON
 * document on every synthesis until someone noticed.
 */
export function writeVoiceChoice(voiceId: string, nowIso: string): void {
  const target = overridePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  const payload: VoiceChoice = { voice_id: voiceId, chosen_at: nowIso };
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, target);
}

export function clearVoiceChoice(): void {
  try {
    fs.unlinkSync(overridePath());
  } catch {
    /* already absent */
  }
}
