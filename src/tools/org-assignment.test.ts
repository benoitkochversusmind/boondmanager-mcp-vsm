import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveOrgRelationships, hasOrgAssignment } from "./org-assignment.js";
import * as boondClient from "../services/boond-client.js";

describe("resolveOrgRelationships", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("uses numeric values as ids directly (no API call) with the right relationship types", async () => {
    const api = vi.spyOn(boondClient, "apiRequest");
    const { relationships, rejected } = await resolveOrgRelationships({ mainManager: "42", agency: "5", pole: "3" });
    expect(rejected).toEqual([]);
    expect(relationships).toEqual({
      mainManager: { data: { id: "42", type: "resource" } },
      agency: { data: { id: "5", type: "agency" } },
      pole: { data: { id: "3", type: "pole" } },
    });
    expect(api).not.toHaveBeenCalled(); // numeric ⇒ no name resolution
  });

  it("leaves out fields that are absent or empty", async () => {
    const { relationships, rejected } = await resolveOrgRelationships({ pole: "7", agency: "" });
    expect(rejected).toEqual([]);
    expect(relationships).toEqual({ pole: { data: { id: "7", type: "pole" } } });
  });

  it("resolves a label to its id by exact (accent/case-insensitive) name match", async () => {
    vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path: string) => {
      if (path === "/agencies")
        return {
          data: [
            { id: "5", attributes: { name: "Nancy" } },
            { id: "6", attributes: { name: "Paris" } },
          ],
        } as never;
      if (path === "/poles") return { data: [{ id: "3", attributes: { name: "Cloud & Data" } }] } as never;
      if (path === "/resources")
        return { data: [{ id: "99", attributes: { firstName: "Jean", lastName: "Dupont" } }] } as never;
      throw new Error(`unexpected ${path}`);
    });
    const { relationships, rejected } = await resolveOrgRelationships({
      mainManager: "jean dupont",
      agency: "NANCY",
      pole: "cloud & data",
    });
    expect(rejected).toEqual([]);
    expect(relationships).toEqual({
      mainManager: { data: { id: "99", type: "resource" } },
      agency: { data: { id: "5", type: "agency" } },
      pole: { data: { id: "3", type: "pole" } },
    });
  });

  it("blocks (rejected) when a label matches nothing", async () => {
    vi.spyOn(boondClient, "apiRequest").mockResolvedValue({
      data: [{ id: "6", attributes: { name: "Paris" } }],
    } as never);
    const { relationships, rejected } = await resolveOrgRelationships({ agency: "Bordeaux" });
    expect(relationships).toEqual({});
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatch(/agency.*Bordeaux.*introuvable/);
  });

  it("blocks (rejected) when a label matches several entities", async () => {
    vi.spyOn(boondClient, "apiRequest").mockResolvedValue({
      data: [
        { id: "6", attributes: { name: "Paris" } },
        { id: "7", attributes: { name: "Paris" } },
      ],
    } as never);
    const { relationships, rejected } = await resolveOrgRelationships({ agency: "Paris" });
    expect(relationships).toEqual({});
    expect(rejected[0]).toMatch(/2 correspondances/);
  });

  it("blocks when the resolution search itself fails", async () => {
    vi.spyOn(boondClient, "apiRequest").mockRejectedValue(new Error("500"));
    const { rejected } = await resolveOrgRelationships({ pole: "Cloud" });
    expect(rejected[0]).toMatch(/pole.*Cloud.*échouée/);
  });
});

describe("hasOrgAssignment", () => {
  it("detects presence / absence of org fields", () => {
    expect(hasOrgAssignment({})).toBe(false);
    expect(hasOrgAssignment({ agency: "" })).toBe(false);
    expect(hasOrgAssignment({ pole: "3" })).toBe(true);
    expect(hasOrgAssignment({ mainManager: "Jean Dupont" })).toBe(true);
  });
});
