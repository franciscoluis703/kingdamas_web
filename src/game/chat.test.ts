import { describe, expect, it } from "vitest";
import { CHALLENGE_EMOJIS, MAX_GAME_CHAT_LENGTH } from "./chat";

describe("chat desafiante de partida", () => {
  it("limita el texto visible a 100 caracteres", () => {
    expect(MAX_GAME_CHAT_LENGTH).toBe(100);
  });

  it("ofrece una colección amplia y sin emojis duplicados", () => {
    expect(CHALLENGE_EMOJIS.length).toBeGreaterThanOrEqual(30);
    expect(new Set(CHALLENGE_EMOJIS).size).toBe(CHALLENGE_EMOJIS.length);
    expect(CHALLENGE_EMOJIS).toContain("👑");
    expect(CHALLENGE_EMOJIS).toContain("⚔️");
  });
});
