import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// --- Mock node:net ---
const mockSocketInstance = new EventEmitter() as EventEmitter & {
  write: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  setTimeout: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};
mockSocketInstance.write = vi.fn();
mockSocketInstance.destroy = vi.fn();
mockSocketInstance.setTimeout = vi.fn();
mockSocketInstance.end = vi.fn();

const mockCreateConnection = vi.fn(() => mockSocketInstance);

vi.mock("node:net", () => ({
  createConnection: mockCreateConnection,
}));

const { decryptCommand } = await import("../../commands/decrypt.js");

describe("decryptCommand", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let stderrOutput: string;
  let stdoutOutput: string;
  let exitCode: number | undefined;

  beforeEach(() => {
    originalEnv = { ...process.env };
    stderrOutput = "";
    stdoutOutput = "";
    exitCode = undefined;

    vi.spyOn(process.stderr, "write").mockImplementation((msg) => {
      stderrOutput += String(msg);
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation((msg) => {
      stdoutOutput += String(msg);
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    });

    // Reset socket mock
    mockSocketInstance.removeAllListeners();
    mockSocketInstance.write.mockReset();
    mockSocketInstance.destroy.mockReset();
    mockSocketInstance.setTimeout.mockReset();
    mockSocketInstance.end.mockReset();
    mockCreateConnection.mockClear();

    process.exitCode = undefined;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("exits with error when PSSO_AGENT_SOCK is not set", async () => {
    delete process.env.PSSO_AGENT_SOCK;

    await expect(
      decryptCommand("abc123", { mcpClient: "mcpc_test" }),
    ).rejects.toThrow("process.exit(1)");

    expect(stderrOutput).toContain("Agent not running");
    expect(exitCode).toBe(1);
  });

  it("sets exitCode=1 when --json and --field are both provided", async () => {
    process.env.PSSO_AGENT_SOCK = "/tmp/test.sock";

    await decryptCommand("abc123", {
      mcpClient: "mcpc_test",
      json: true,
      field: "username",
    });

    expect(stderrOutput).toContain("mutually exclusive");
    expect(process.exitCode).toBe(1);
  });

  it("defaults field to 'password' when neither --json nor --field is given", async () => {
    process.env.PSSO_AGENT_SOCK = "/tmp/test.sock";

    const promise = decryptCommand("abc123", { mcpClient: "mcpc_test" });

    // Emit connect and then respond with success
    mockSocketInstance.emit("connect");
    mockSocketInstance.emit(
      "data",
      Buffer.from(JSON.stringify({ ok: true, value: "s3cr3t" }) + "\n"),
    );

    await promise;

    expect(mockSocketInstance.write).toHaveBeenCalledWith(
      expect.stringContaining('"field":"password"'),
    );
  });

  it("sets field to '_json' when --json is given", async () => {
    process.env.PSSO_AGENT_SOCK = "/tmp/test.sock";

    const promise = decryptCommand("abc123", {
      mcpClient: "mcpc_test",
      json: true,
    });

    mockSocketInstance.emit("connect");
    mockSocketInstance.emit(
      "data",
      Buffer.from(JSON.stringify({ ok: true, value: '{"password":"x"}' }) + "\n"),
    );

    await promise;

    expect(mockSocketInstance.write).toHaveBeenCalledWith(
      expect.stringContaining('"field":"_json"'),
    );
  });

  it("sends correct request JSON to socket", async () => {
    process.env.PSSO_AGENT_SOCK = "/tmp/test.sock";

    const promise = decryptCommand("entry-id-1", {
      mcpClient: "mcpc_abc",
      field: "username",
    });

    mockSocketInstance.emit("connect");
    mockSocketInstance.emit(
      "data",
      Buffer.from(JSON.stringify({ ok: true, value: "alice" }) + "\n"),
    );

    await promise;

    const sent = mockSocketInstance.write.mock.calls[0][0] as string;
    const parsed = JSON.parse(sent.trim());
    expect(parsed).toEqual({
      entryId: "entry-id-1",
      clientId: "mcpc_abc",
      field: "username",
    });
  });

  it("writes value to stdout on successful response", async () => {
    process.env.PSSO_AGENT_SOCK = "/tmp/test.sock";

    const promise = decryptCommand("abc123", { mcpClient: "mcpc_test" });

    mockSocketInstance.emit("connect");
    mockSocketInstance.emit(
      "data",
      Buffer.from(JSON.stringify({ ok: true, value: "my-password" }) + "\n"),
    );

    await promise;

    expect(stdoutOutput).toContain("my-password");
    expect(process.exitCode).toBeUndefined();
  });

  it("writes error to stderr and sets exitCode=1 on error response", async () => {
    process.env.PSSO_AGENT_SOCK = "/tmp/test.sock";

    const promise = decryptCommand("abc123", { mcpClient: "mcpc_test" });

    mockSocketInstance.emit("connect");
    mockSocketInstance.emit(
      "data",
      Buffer.from(JSON.stringify({ ok: false, error: "Not authorized" }) + "\n"),
    );

    await promise;

    expect(stderrOutput).toContain("Not authorized");
    expect(process.exitCode).toBe(1);
  });

  it("gives helpful message on ENOENT socket error", async () => {
    process.env.PSSO_AGENT_SOCK = "/tmp/missing.sock";

    const promise = decryptCommand("abc123", { mcpClient: "mcpc_test" });

    const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    mockSocketInstance.emit("error", err);

    await promise;

    expect(stderrOutput).toContain("Agent socket not found");
    expect(process.exitCode).toBe(1);
  });

  it("gives helpful message on ECONNREFUSED socket error", async () => {
    process.env.PSSO_AGENT_SOCK = "/tmp/refused.sock";

    const promise = decryptCommand("abc123", { mcpClient: "mcpc_test" });

    const err = Object.assign(new Error("ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    mockSocketInstance.emit("error", err);

    await promise;

    expect(stderrOutput).toContain("Agent is not running");
    expect(process.exitCode).toBe(1);
  });

  it("sets exitCode=1 on timeout", async () => {
    process.env.PSSO_AGENT_SOCK = "/tmp/test.sock";

    const promise = decryptCommand("abc123", { mcpClient: "mcpc_test" });

    mockSocketInstance.emit("timeout");

    await promise;

    expect(stderrOutput).toContain("timed out");
    expect(process.exitCode).toBe(1);
  });
});
