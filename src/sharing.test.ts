import { describe, expect, it } from "vitest";
import type { LinkInvitation } from "./types";
import { friendChallengeMessage, friendChallengeText } from "./sharing";

const invitation: LinkInvitation = {
  id: "12",
  token: "abcdefghijklmnopqrstuvwxyzABCDEF",
  boardSize: 10,
  timeControlMinutes: 30,
  status: "pending",
  expiresAt: "2026-08-09T22:00:00.000Z",
  createdAt: "2026-08-09T21:00:00.000Z",
  sender: {
    id: "7",
    name: "Francisco",
    username: "francisco703",
    rating: 1400,
  },
};

describe("mensaje de desafío privado", () => {
  it("incluye al retador, la modalidad y el reloj", () => {
    const text = friendChallengeText(invitation);
    expect(text).toContain("@francisco703");
    expect(text).toContain("10×10");
    expect(text).toContain("30 minutos");
    expect(text).toContain("arrebatarle la corona");
  });

  it("agrega el enlace como última parte del mensaje copiable", () => {
    const url = "https://kingdamas.com/?invitacion=token";
    const message = friendChallengeMessage(invitation, url);
    expect(message.endsWith(url)).toBe(true);
  });
});
