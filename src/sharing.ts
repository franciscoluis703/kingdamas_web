import type { LinkInvitation } from "./types";
import { currentLanguage, type AppLanguage } from "./i18n";

export function friendChallengeText(
  invitation: LinkInvitation,
  language: AppLanguage = currentLanguage(),
) {
  const username = invitation.sender.username.replace(/^@/, "")
    || (language === "en" ? "player" : "jugador");
  return language === "en"
    ? `♛ @${username} challenges you on King Damas.\n\nDo you have what it takes to claim the crown? Accept a ${invitation.timeControlMinutes}-minute 10×10 match and prove it.`
    : `♛ @${username} te desafía en King Damas.\n\n¿Tienes lo necesario para arrebatarle la corona? Acepta una partida 10×10 de ${invitation.timeControlMinutes} minutos y demuéstralo.`;
}

export function friendChallengeMessage(
  invitation: LinkInvitation,
  url: string,
  language: AppLanguage = currentLanguage(),
) {
  return `${friendChallengeText(invitation, language)}\n\n${url}`;
}
