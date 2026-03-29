/**
 * `passwd-sso decrypt <id>` — Thin client that connects to the decrypt agent socket.
 * Sends a decrypt request and prints the result to stdout.
 * Used by Claude Code hooks to decrypt credentials without exposing them to the LLM.
 *
 * Usage:
 *   passwd-sso decrypt <entryId> --field password --mcp-token <tokenId>
 *   passwd-sso decrypt abc123 --field password --mcp-token <uuid> | curl --config - ...
 */

import { createConnection } from "node:net";

interface DecryptResponse {
  ok: boolean;
  value?: string;
  error?: string;
}

export async function decryptCommand(
  id: string,
  options: { field?: string; mcpToken: string },
): Promise<void> {
  const socketPath = process.env.PSSO_AGENT_SOCK;
  if (!socketPath) {
    process.stderr.write(
      "Error: Agent not running. Start with:\n" +
      "  eval $(passwd-sso agent --decrypt --eval)\n",
    );
    process.exit(1);
  }

  const field = options.field ?? "password";
  const request = JSON.stringify({
    entryId: id,
    mcpTokenId: options.mcpToken,
    field,
  });

  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let responseBuffer = "";
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };

    socket.on("connect", () => {
      socket.write(request + "\n");
    });

    socket.on("data", (chunk: Buffer) => {
      responseBuffer += chunk.toString("utf-8");

      const lines = responseBuffer.split("\n");
      responseBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const res = JSON.parse(trimmed) as DecryptResponse;

          if (res.ok && res.value !== undefined) {
            process.stdout.write(res.value);
            finish();
          } else {
            process.stderr.write(`Error: ${res.error ?? "Decrypt failed"}\n`);
            process.exitCode = 1;
            finish();
          }
        } catch (err) {
          process.stderr.write(
            `Error: Invalid response from agent: ${err instanceof Error ? err.message : "unknown"}\n`,
          );
          process.exitCode = 1;
          finish();
        }
      }
    });

    socket.on("end", () => {
      finish();
    });

    socket.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        process.stderr.write(
          "Error: Agent socket not found. Start the agent with:\n" +
          "  eval $(passwd-sso agent --decrypt --eval)\n",
        );
      } else if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
        process.stderr.write(
          "Error: Agent is not running. Start with:\n" +
          "  eval $(passwd-sso agent --decrypt --eval)\n",
        );
      } else {
        process.stderr.write(`Error: Socket error: ${err.message}\n`);
      }
      process.exitCode = 1;
      finish(err);
    });

    socket.setTimeout(10_000);
    socket.on("timeout", () => {
      process.stderr.write("Error: Agent request timed out\n");
      process.exitCode = 1;
      finish(new Error("timeout"));
    });
  }).catch(() => {
    // exitCode already set above
  });
}
