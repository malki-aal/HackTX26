import { describe, expect, it } from "vitest";
import { signInErrorMessage } from "./sign-in-errors";

describe("Google sign-in start failures", () => {
  it("never produce an empty message", () => {
    // What Clerk's development instance returned on the custom domain: status 500, no message, no errors.
    expect(signInErrorMessage({ name: "e", status: 500, message: "", errors: [] })).toMatch(/HTTP 500/);
    expect(signInErrorMessage({ status: 429, errors: [] })).toMatch(/Too many sign-in attempts/);
    expect(signInErrorMessage(undefined)).toMatch(/Couldn’t start Google sign-in/);
  });
  it("prefer Clerk's own explanation when it gives one", () => {
    expect(signInErrorMessage({ status: 422, errors: [{ code: "x", message: "short", longMessage: "Longer explanation" }] })).toBe("Longer explanation");
    expect(signInErrorMessage(new Error("Sign-in isn’t ready yet."))).toBe("Sign-in isn’t ready yet.");
  });
});
