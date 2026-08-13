import { describe, expect, it } from "vitest";
import { readBoundedText } from "../worker/sources";

describe("Worker source response limits", () => {
  it("reads a response within the configured byte budget", async () => {
    const response = new Response("StyleKorean");
    await expect(readBoundedText(response, 64)).resolves.toBe("StyleKorean");
  });

  it("rejects a declared oversized response before buffering it", async () => {
    const response = new Response("small", { headers: { "content-length": "100" } });
    await expect(readBoundedText(response, 10)).rejects.toThrow("exceeds 10 bytes");
  });

  it("counts UTF-8 bytes rather than JavaScript characters", async () => {
    const response = new Response("물류");
    await expect(readBoundedText(response, 5)).rejects.toThrow("exceeds 5 bytes");
  });
});
