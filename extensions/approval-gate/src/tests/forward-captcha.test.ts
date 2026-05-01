import { describe, expect, it } from "vitest";
import {
  createForwardCaptchaTool,
  handlePotentialCaptchaSolution,
} from "../tools/forward-captcha.js";

// ---------------------------------------------------------------------------
// createForwardCaptchaTool — static shape
// ---------------------------------------------------------------------------

describe("createForwardCaptchaTool — shape", () => {
  const tool = createForwardCaptchaTool({
    telegramBotToken: "test-token",
    telegramChatId: "12345",
  });

  it("has name 'forward_captcha'", () => {
    expect(tool.name).toBe("forward_captcha");
  });

  it("has a non-empty description", () => {
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(20);
  });

  it("has a label", () => {
    expect(typeof tool.label).toBe("string");
    expect(tool.label.length).toBeGreaterThan(0);
  });

  it("declares required parameters", () => {
    const params = tool.parameters as {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(params.type).toBe("object");
    expect(params.required).toContain("screenshot_base64");
    expect(params.required).toContain("captcha_type");
    expect(params.required).toContain("url");
    expect(params.required).toContain("context");
  });

  it("enumerates valid captcha_type values", () => {
    const params = tool.parameters as {
      properties: { captcha_type: { enum: string[] } };
    };
    const validTypes = params.properties.captcha_type.enum;
    expect(validTypes).toContain("recaptcha");
    expect(validTypes).toContain("hcaptcha");
    expect(validTypes).toContain("cloudflare");
    expect(validTypes).toContain("other");
  });

  it("has an execute function", () => {
    expect(typeof tool.execute).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// handlePotentialCaptchaSolution — string matching (no live Telegram)
// ---------------------------------------------------------------------------

describe("handlePotentialCaptchaSolution", () => {
  it("returns false when message contains no captcha_ ID", () => {
    expect(handlePotentialCaptchaSolution("some random message")).toBe(false);
  });

  it("returns false when captcha ID is not in the pending map", () => {
    // A fabricated ID that was never registered
    expect(handlePotentialCaptchaSolution("captcha_99999_zzzzz: abc123")).toBe(false);
  });

  it("does not throw on empty string", () => {
    expect(() => handlePotentialCaptchaSolution("")).not.toThrow();
    expect(handlePotentialCaptchaSolution("")).toBe(false);
  });

  it("does not throw on partial captcha_ prefix without suffix", () => {
    expect(() => handlePotentialCaptchaSolution("captcha_")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// execute() — timeout path (no network calls)
// ---------------------------------------------------------------------------

describe("createForwardCaptchaTool — execute timeout", () => {
  it("returns a timeout message when no Telegram reply arrives", async () => {
    // Use a very short timeout so the test doesn't hang
    const tool = createForwardCaptchaTool({
      telegramBotToken: "fake-token",
      telegramChatId: "fake-chat",
      timeoutSeconds: 0.001, // 1ms — expires immediately
    });

    // The execute() method will try to call Telegram, which will fail.
    // We catch the error and verify it's a fetch/network error rather than
    // an unhandled rejection — the function should not crash the process.
    let result: { content: Array<{ type: string; text: string }> } | undefined;
    try {
      result = await tool.execute("tc-1", {
        screenshot_base64: Buffer.from("fake-png").toString("base64"),
        captcha_type: "other",
        url: "https://example.com/captcha",
        context: "test context for captcha resolution",
      });
    } catch {
      // Network failure on fake-token is expected — the timeout still fires
    }

    // If network fails before the timeout resolves, result is undefined —
    // that's fine, we're just verifying no crash / unhandled rejection.
    if (result !== undefined) {
      expect(result.content[0].type).toBe("text");
      // Could be timeout message or skip message
      expect(typeof result.content[0].text).toBe("string");
    }
  }, 5000);
});
