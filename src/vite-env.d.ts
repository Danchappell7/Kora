/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Web push (0043): the VAPID public key, base64url. Unset = push is hidden. Public by design (never the private key). */
  readonly VITE_VAPID_PUBLIC_KEY?: string;
}
