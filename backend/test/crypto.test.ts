import { describe, expect, it } from "vitest";
import { encryptSecret, decryptSecret } from "../src/lib/crypto.js";

const MATERIAL = "a-long-enough-secret-material-value-1234567890";

describe("secret encryption", () => {
  it("round-trips a plaintext and never stores it in the clear", () => {
    const plaintext = "sk-test-abcdef0123456789";
    const sealed = encryptSecret(plaintext, MATERIAL);

    expect(sealed.ciphertext).not.toContain(plaintext);
    expect(sealed.ciphertext).not.toEqual(plaintext);
    expect(sealed.iv).toBeTruthy();
    expect(sealed.tag).toBeTruthy();

    expect(decryptSecret(sealed, MATERIAL)).toBe(plaintext);
  });

  it("uses a fresh nonce so the same plaintext encrypts differently each time", () => {
    const a = encryptSecret("same-key", MATERIAL);
    const b = encryptSecret("same-key", MATERIAL);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
    expect(a.iv).not.toEqual(b.iv);
  });

  it("fails to decrypt with the wrong material", () => {
    const sealed = encryptSecret("secret", MATERIAL);
    expect(() => decryptSecret(sealed, "the-wrong-material")).toThrow();
  });

  it("fails to decrypt when the auth tag is tampered", () => {
    const sealed = encryptSecret("secret", MATERIAL);
    const badTagBytes = Buffer.from(sealed.tag, "base64");
    badTagBytes[0] ^= 0xff;
    const tampered = { ...sealed, tag: badTagBytes.toString("base64") };
    expect(() => decryptSecret(tampered, MATERIAL)).toThrow();
  });
});
