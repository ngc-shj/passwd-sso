import { describe, it, expect } from "vitest";
import { IN_MEMORY_LOCATION, InMemoryDestination } from "./in-memory-destination";
import {
  createArtifact,
  describeAnchorDestinationContract,
  manifestKeyFor,
} from "@/__tests__/helpers/anchor-destination-contract";

describeAnchorDestinationContract("in-memory", () => new InMemoryDestination());

describe("InMemoryDestination", () => {
  it("takes its name from the constructor, defaulting to in-memory", () => {
    expect(new InMemoryDestination().name).toBe("in-memory");
    expect(new InMemoryDestination("s3-object-lock").name).toBe("s3-object-lock");
  });

  it("is the one in-memory location unless given another", () => {
    expect(new InMemoryDestination().location).toBe(IN_MEMORY_LOCATION);
    expect(new InMemoryDestination("s3-object-lock").location).toBe(IN_MEMORY_LOCATION);
    expect(new InMemoryDestination("filesystem", "memory://restarted").location).toBe("memory://restarted");
  });

  it("holds its own copy: mutating the buffer handed in or handed out changes nothing stored", async () => {
    const dest = new InMemoryDestination();
    const key = manifestKeyFor("2026-05-02");
    const input = Buffer.from("stored");

    await createArtifact(dest, key, input);
    input.fill(0);
    (await dest.read(key))?.fill(0);

    expect(await dest.read(key)).toEqual(Buffer.from("stored"));
  });

  it("keeps two instances apart", async () => {
    const one = new InMemoryDestination();
    await createArtifact(one, manifestKeyFor("2026-05-02"), Buffer.from("x"));

    expect(await new InMemoryDestination().list()).toEqual([]);
  });
});
