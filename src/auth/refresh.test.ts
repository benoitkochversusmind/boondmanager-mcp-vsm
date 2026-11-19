import { describe, it, expect, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import { issueRefreshToken, verifyRefreshToken, resetRefreshSecretForTests, REFRESH_TTL_SECONDS } from "./refresh.js";

const SECRET = "test-signing-secret-abc";

describe("refresh tokens", () => {
  beforeEach(() => {
    process.env.OAUTH_REFRESH_SIGNING_SECRET = SECRET;
    resetRefreshSecretForTests();
  });
  afterEach(() => {
    delete process.env.OAUTH_REFRESH_SIGNING_SECRET;
    resetRefreshSecretForTests();
  });

  it("round-trips: issue → verify returns the (lowercased) email", () => {
    const token = issueRefreshToken("Benoit.Koch@Versusmind.eu");
    expect(verifyRefreshToken(token)).toBe("benoit.koch@versusmind.eu");
  });

  it("carries a 30-day TTL and the refresh type", () => {
    const token = issueRefreshToken("a@b.eu");
    const payload = jwt.decode(token) as jwt.JwtPayload;
    expect(payload.typ).toBe("refresh");
    expect(payload.exp! - payload.iat!).toBe(REFRESH_TTL_SECONDS);
  });

  it("rejects a tampered token", () => {
    const token = issueRefreshToken("a@b.eu");
    expect(verifyRefreshToken(token.slice(0, -2) + "xx")).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const foreign = jwt.sign({ typ: "refresh" }, "other-secret", { subject: "a@b.eu", expiresIn: 3600 });
    expect(verifyRefreshToken(foreign)).toBeNull();
  });

  it("rejects a non-refresh token (wrong typ)", () => {
    const notRefresh = jwt.sign({ typ: "access" }, SECRET, { subject: "a@b.eu", expiresIn: 3600 });
    expect(verifyRefreshToken(notRefresh)).toBeNull();
  });

  it("rejects an expired token", () => {
    const expired = jwt.sign({ typ: "refresh" }, SECRET, { subject: "a@b.eu", expiresIn: -10 });
    expect(verifyRefreshToken(expired)).toBeNull();
  });

  it("rejects empty / undefined input", () => {
    expect(verifyRefreshToken(undefined)).toBeNull();
    expect(verifyRefreshToken("")).toBeNull();
  });
});
