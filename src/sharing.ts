import type { LinkInvitation } from "./types";

export function friendChallengeText(invitation: LinkInvitation) {
  const username = invitation.sender.username.replace(/^@/, "") || "jugador";
  return `♛ @${username} te desafía en King Damas.\n\n¿Tienes lo necesario para arrebatarle la corona? Acepta una partida 10×10 de ${invitation.timeControlMinutes} minutos y demuéstralo.`;
}

export function friendChallengeMessage(invitation: LinkInvitation, url: string) {
  return `${friendChallengeText(invitation)}\n\n${url}`;
}
