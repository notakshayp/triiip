/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Spotify app client ID (public; PKCE needs no secret). Optional — can be pasted in-game. */
  readonly VITE_SPOTIFY_CLIENT_ID?: string
}
