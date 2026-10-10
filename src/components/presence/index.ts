/* KANBO — live presence (0048, u5). One import site for the integrator.
   Light enough for the shell (list rows): the hub, the hooks and the two small components. The doc co-editing
   (useDocCollab and the block-op engine) lives in lib/presence, the docs chunk — import that only from lazy code. */
export { PresenceAvatars, presenceVerb, type PresenceAvatarsProps } from "./PresenceAvatars";
export { TypingIndicator, type TypingIndicatorProps } from "./TypingIndicator";
export {
  usePresence, useTyping, useProjectPresence, presenceKey, presenceSentence, presenceMeFrom, PresenceContext,
  PRESENCE_HEARTBEAT_MS, PRESENCE_STALE_MS, TYPING_THROTTLE_MS, TYPING_TTL_MS,
  type PresenceKind, type PresenceMe,
} from "./core";
