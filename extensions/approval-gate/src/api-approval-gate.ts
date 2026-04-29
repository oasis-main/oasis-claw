/**
 * API Request Approval Gate
 *
 * Intercepts outbound HTTP requests from agent tools and enforces approval
 * policies for mutating requests (POST, PUT, PATCH, DELETE).
 *
 * Policy levels:
 * 1. Denylist: Block requests to dangerous/private hosts
 * 2. Allowlist: Pre-approved services for GET requests
 * 3. Approval required: All mutations need human approval via Telegram
 */

import fs from "node:fs";
import path from "node:path";
import { sendTelegramMessage } from "./telegram.js";

export type ApiApprovalPolicy = {
  defaultPolicy: "allow" | "deny";
  approvalRequired: {
    methods: string[];
    description: string;
  };
  allowlist: Array<{
    host: string;
    methods: string[];
    paths?: string[];
    reason: string;
  }>;
  denylist: Array<{
    pattern: string;
    reason: string;
  }>;
  serviceAllowlist: Record<
    string,
    {
      hosts: string[];
      methods: string[];
      mutationApproval: boolean;
      description: string;
    }
  >;
};

export type ApiApprovalConfig = {
  policyFile: string;
  telegramBotToken: string;
  telegramChatId: string;
  timeoutSeconds?: number;
};

export type ApiApprovalDecision = {
  allowed: boolean;
  reason: string;
  requiresApproval: boolean;
  service?: string;
};

// Pending approval requests
const pendingApprovals = new Map<
  string,
  {
    resolve: (approved: boolean) => void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();

export function loadApiApprovalPolicy(policyFile: string): ApiApprovalPolicy | null {
  try {
    const content = fs.readFileSync(policyFile, "utf8");
    return JSON.parse(content) as ApiApprovalPolicy;
  } catch {
    return null;
  }
}

function matchPattern(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) || host === pattern.slice(2);
  }
  if (pattern.includes("*")) {
    const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
    return regex.test(host);
  }
  return host === pattern;
}

export function checkApiApproval(
  policy: ApiApprovalPolicy,
  method: string,
  url: string,
): ApiApprovalDecision {
  const upperMethod = method.toUpperCase();

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return {
      allowed: false,
      reason: "Invalid URL",
      requiresApproval: false,
    };
  }

  const host = parsedUrl.hostname;
  const pathname = parsedUrl.pathname;

  // Check denylist first
  for (const entry of policy.denylist) {
    if (matchPattern(host, entry.pattern)) {
      return {
        allowed: false,
        reason: `Blocked: ${entry.reason}`,
        requiresApproval: false,
      };
    }
  }

  // Check service allowlist
  for (const [serviceName, service] of Object.entries(policy.serviceAllowlist)) {
    const hostMatches = service.hosts.some((h) => matchPattern(host, h));
    if (hostMatches) {
      const methodAllowed = service.methods.includes(upperMethod);
      if (methodAllowed) {
        return {
          allowed: true,
          reason: `Pre-approved: ${service.description}`,
          requiresApproval: false,
          service: serviceName,
        };
      }
      // Mutation on known service
      if (service.mutationApproval) {
        return {
          allowed: false,
          reason: `Mutation requires approval: ${service.description}`,
          requiresApproval: true,
          service: serviceName,
        };
      }
    }
  }

  // Check explicit allowlist
  for (const entry of policy.allowlist) {
    if (host === entry.host && entry.methods.includes(upperMethod)) {
      if (!entry.paths || entry.paths.some((p) => pathname.startsWith(p))) {
        return {
          allowed: true,
          reason: `Allowlisted: ${entry.reason}`,
          requiresApproval: false,
        };
      }
    }
  }

  // Check if method requires approval
  if (policy.approvalRequired.methods.includes(upperMethod)) {
    return {
      allowed: false,
      reason: policy.approvalRequired.description,
      requiresApproval: true,
    };
  }

  // Default policy
  if (policy.defaultPolicy === "deny") {
    return {
      allowed: false,
      reason: "Default policy: deny",
      requiresApproval: true,
    };
  }

  return {
    allowed: true,
    reason: "Default policy: allow",
    requiresApproval: false,
  };
}

export async function requestApiApproval(
  config: ApiApprovalConfig,
  method: string,
  url: string,
  context: string,
): Promise<boolean> {
  const requestId = `api_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const timeoutMs = (config.timeoutSeconds ?? 300) * 1000;

  const message = [
    `🌐 **API Request Approval**`,
    ``,
    `**Method:** ${method.toUpperCase()}`,
    `**URL:** ${url}`,
    `**Context:** ${context}`,
    ``,
    `Reply "approve" or "deny"`,
    `Request ID: \`${requestId}\``,
  ].join("\n");

  await sendTelegramMessage({
    botToken: config.telegramBotToken,
    chatId: config.telegramChatId,
    text: message,
    parseMode: "Markdown",
  });

  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      pendingApprovals.delete(requestId);
      resolve(false);
    }, timeoutMs);

    pendingApprovals.set(requestId, { resolve, timeout });
  });
}

export function handlePotentialApiApprovalResponse(messageText: string): boolean {
  const match = messageText.match(/api_\w+/i);
  if (!match) {
    return false;
  }

  const requestId = match[0].toLowerCase();
  const pending = pendingApprovals.get(requestId);
  if (!pending) {
    return false;
  }

  const lowerText = messageText.toLowerCase();
  const approved = lowerText.includes("approve") || lowerText.includes("yes");

  clearTimeout(pending.timeout);
  pendingApprovals.delete(requestId);
  pending.resolve(approved);

  return true;
}
