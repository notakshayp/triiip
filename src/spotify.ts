// ---------------------------------------------------------------------------
// Spotify — play the player's own music in the game, fully client-side so it
// works on a static host (GitHub Pages). Authorization Code + PKCE (no client
// secret, no server) gets a token; the Web Playback SDK turns this tab into a
// Spotify Connect device; the Web API lists playlists and starts playback on
// it. Streaming in the browser needs Spotify Premium (the SDK reports an
// account_error otherwise).
//
// The client ID comes from VITE_SPOTIFY_CLIENT_ID at build time, or can be
// pasted into the music panel (kept in localStorage). The Spotify app's
// redirect URI must be exactly this page's URL, shown in the panel.
// ---------------------------------------------------------------------------

const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
].join(' ')
const API = 'https://api.spotify.com/v1'
const K_CLIENT = 'spotify.clientId'
const K_AUTH = 'spotify.auth'
const K_PKCE = 'spotify.pkce'
const K_VOL = 'spotify.volume'

interface Auth {
  access: string
  refresh: string
  expires: number // ms epoch
}

export interface Track {
  name: string
  artists: string
  art: string
  uri: string
}

export interface PlaylistItem {
  name: string
  uri: string // context uri, or '' for Liked Songs
  image: string
  count: number
}

export type MusicStatus =
  | 'setup' // no client ID / not logged in
  | 'connecting'
  | 'ready' // device up, nothing playing yet
  | 'playing'
  | 'paused'
  | 'error'

// Minimal typings for the Web Playback SDK (https://sdk.scdn.co/spotify-player.js).
interface SdkState {
  paused: boolean
  position: number
  duration: number
  track_window: {
    current_track: { name: string; uri: string; artists: { name: string }[]; album: { images: { url: string }[] } } | null
  }
}
interface SdkPlayer {
  connect(): Promise<boolean>
  disconnect(): void
  togglePlay(): Promise<void>
  nextTrack(): Promise<void>
  previousTrack(): Promise<void>
  setVolume(v: number): Promise<void>
  activateElement(): Promise<void>
  addListener(ev: string, cb: (arg: any) => void): void
}
declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void
    Spotify?: { Player: new (o: { name: string; getOAuthToken: (cb: (t: string) => void) => void; volume: number }) => SdkPlayer }
  }
}

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  set(k: string, v: string | null): void {
    try {
      if (v === null) localStorage.removeItem(k)
      else localStorage.setItem(k, v)
    } catch {
      /* private mode: lives for this session only */
    }
  },
}

export class Spotify {
  status: MusicStatus = 'setup'
  message = ''
  user = ''
  track: Track | null = null
  position = 0 // ms, at `stamp`
  duration = 0
  playlists: PlaylistItem[] = []
  volume = Number(store.get(K_VOL) ?? 0.5)
  /** Called whenever anything shown in the UI changes. */
  onChange: () => void = () => {}

  private auth: Auth | null = null
  private player: SdkPlayer | null = null
  private deviceId = ''
  private stamp = performance.now()
  private duck = 1
  private sentVolume = -1

  /** The URL Spotify sends the player back to; must be registered on the app. */
  readonly redirectUri = location.origin + import.meta.env.BASE_URL

  get clientId(): string {
    return store.get(K_CLIENT) || (import.meta.env.VITE_SPOTIFY_CLIENT_ID as string | undefined) || ''
  }
  set clientId(id: string) {
    store.set(K_CLIENT, id.trim() || null)
  }

  get connected(): boolean {
    return this.auth !== null
  }

  /** Playback position now, extrapolated while playing. */
  get positionNow(): number {
    if (this.status !== 'playing') return this.position
    return Math.min(this.duration, this.position + performance.now() - this.stamp)
  }

  /** Boot: finish a login redirect if this load is one, else resume a saved session. */
  async init(): Promise<void> {
    const q = new URLSearchParams(location.search)
    const code = q.get('code')
    const err = q.get('error')
    if (code || err) {
      // Strip ?code=&state= so a reload doesn't try to redeem it again.
      history.replaceState(null, '', location.pathname + location.hash)
      const pkce = JSON.parse(store.get(K_PKCE) ?? 'null') as { verifier: string; state: string } | null
      store.set(K_PKCE, null)
      if (err) return this.fail(err === 'access_denied' ? 'Spotify login was cancelled.' : `Spotify login failed (${err}).`)
      if (!pkce || q.get('state') !== pkce.state) return this.fail('Spotify login expired — try connecting again.')
      try {
        await this.token({
          grant_type: 'authorization_code',
          code: code!,
          redirect_uri: this.redirectUri,
          code_verifier: pkce.verifier,
        })
      } catch (e) {
        return this.fail(`Couldn't finish Spotify login: ${(e as Error).message}`)
      }
    } else {
      this.auth = JSON.parse(store.get(K_AUTH) ?? 'null')
    }
    if (this.auth) await this.start()
  }

  /** Send the player to Spotify's login page (returns here with ?code=). */
  async login(): Promise<void> {
    if (!this.clientId) return this.fail('Paste your Spotify app Client ID first.')
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)))
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
    const state = b64url(crypto.getRandomValues(new Uint8Array(12)))
    store.set(K_PKCE, JSON.stringify({ verifier, state }))
    const url = new URL('https://accounts.spotify.com/authorize')
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      scope: SCOPES,
      redirect_uri: this.redirectUri,
      state,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    }).toString()
    location.assign(url.toString())
  }

  logout(): void {
    this.player?.disconnect()
    this.player = null
    this.deviceId = ''
    this.auth = null
    store.set(K_AUTH, null)
    this.track = null
    this.playlists = []
    this.user = ''
    this.set('setup', '')
  }

  async togglePlay(): Promise<void> {
    if (!this.player) return
    await this.player.activateElement()
    if (this.status === 'ready') {
      // Nothing queued on this device yet: resume whatever the account last played.
      await this.api('PUT', `/me/player/play?device_id=${this.deviceId}`).catch(() => this.playList(this.playlists[0]))
      return
    }
    await this.player.togglePlay()
  }

  next(): void {
    this.player?.nextTrack()
  }

  prev(): void {
    this.player?.previousTrack()
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v))
    store.set(K_VOL, String(this.volume))
    this.pushVolume()
  }

  /** 0..1 multiplier on the music (e.g. muffled while swimming). Cheap to call every frame. */
  setDuck(d: number): void {
    this.duck = d
    this.pushVolume()
  }

  async playList(p: PlaylistItem | undefined): Promise<void> {
    if (!p || !this.player) return
    await this.player.activateElement()
    try {
      if (p.uri) {
        await this.api('PUT', `/me/player/play?device_id=${this.deviceId}`, { context_uri: p.uri })
      } else {
        // Liked Songs has no context URI the player can start: queue the latest 50.
        const liked = await this.api('GET', '/me/tracks?limit=50')
        const uris = (liked.items as { track: { uri: string } }[]).map((i) => i.track.uri)
        if (uris.length) await this.api('PUT', `/me/player/play?device_id=${this.deviceId}`, { uris })
      }
      this.message = ''
    } catch (e) {
      this.message = `Couldn't play that: ${(e as Error).message}`
      this.onChange()
    }
  }

  // --- internals --------------------------------------------------------------

  private set(status: MusicStatus, message = this.message): void {
    this.status = status
    this.message = message
    this.onChange()
  }

  private fail(message: string): void {
    this.set(this.auth ? 'error' : 'setup', message)
  }

  private async start(): Promise<void> {
    this.set('connecting', '')
    try {
      const me = await this.api('GET', '/me')
      this.user = me.display_name || me.id
      if (me.product && me.product !== 'premium') {
        return this.set('error', 'Playing in the browser needs Spotify Premium.')
      }
      this.loadPlaylists()
      await this.loadSdk()
      this.createPlayer()
    } catch (e) {
      this.set('error', (e as Error).message)
    }
  }

  private async loadPlaylists(): Promise<void> {
    try {
      const res = await this.api('GET', '/me/playlists?limit=50')
      const items = (res.items as any[]).filter(Boolean)
      this.playlists = [
        { name: 'Liked Songs', uri: '', image: '', count: 0 },
        ...items.map((p) => ({
          name: p.name as string,
          uri: p.uri as string,
          image: (p.images?.[p.images.length - 1]?.url as string) ?? '',
          count: (p.tracks?.total ?? p.items?.total ?? 0) as number,
        })),
      ]
      this.onChange()
    } catch {
      /* the player still works without the list */
    }
  }

  private loadSdk(): Promise<void> {
    if (window.Spotify) return Promise.resolve()
    return new Promise((resolve, reject) => {
      window.onSpotifyWebPlaybackSDKReady = () => resolve()
      const s = document.createElement('script')
      s.src = 'https://sdk.scdn.co/spotify-player.js'
      s.async = true
      s.onerror = () => reject(new Error("Couldn't load the Spotify player (blocked by an extension?)."))
      document.head.appendChild(s)
    })
  }

  private createPlayer(): void {
    const player = new window.Spotify!.Player({
      name: 'Chill Valley',
      getOAuthToken: (cb) => {
        this.fresh()
          .then(cb)
          .catch(() => this.fail('Spotify session expired — reconnect.'))
      },
      volume: this.volume * this.duck,
    })
    this.player = player
    player.addListener('ready', ({ device_id }: { device_id: string }) => {
      this.deviceId = device_id
      // Make this tab the active device without interrupting anything yet.
      this.api('PUT', '/me/player', { device_ids: [device_id], play: false }).catch(() => {})
      this.set('ready', '')
    })
    player.addListener('not_ready', () => this.set('connecting', 'Reconnecting to Spotify…'))
    player.addListener('player_state_changed', (s: SdkState | null) => {
      if (!s) {
        // Playback moved to another device (phone, desktop app…).
        this.track = null
        return this.set('ready', 'Playing on another device — pick something to bring it here.')
      }
      const t = s.track_window.current_track
      this.track = t && {
        name: t.name,
        uri: t.uri,
        artists: t.artists.map((a) => a.name).join(', '),
        art: t.album.images[0]?.url ?? '',
      }
      this.position = s.position
      this.duration = s.duration
      this.stamp = performance.now()
      this.set(s.paused ? 'paused' : 'playing', '')
    })
    player.addListener('initialization_error', ({ message }) => this.set('error', `This browser can't play Spotify: ${message}`))
    player.addListener('authentication_error', () => {
      this.logout()
      this.set('setup', 'Spotify session expired — connect again.')
    })
    player.addListener('account_error', () => this.set('error', 'Playing in the browser needs Spotify Premium.'))
    player.addListener('playback_error', ({ message }) => {
      this.message = `Playback error: ${message}`
      this.onChange()
    })
    player.connect()
  }

  private pushVolume(): void {
    const v = Math.round(this.volume * this.duck * 100) / 100
    if (v === this.sentVolume || !this.player) return
    this.sentVolume = v
    this.player.setVolume(v)
  }

  /** A valid access token, refreshing it if it's about to lapse. */
  private async fresh(): Promise<string> {
    if (!this.auth) throw new Error('Not connected')
    if (Date.now() > this.auth.expires - 60_000) {
      await this.token({ grant_type: 'refresh_token', refresh_token: this.auth.refresh })
    }
    return this.auth.access
  }

  private async token(params: Record<string, string>): Promise<void> {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, client_id: this.clientId }),
    })
    const j = await res.json()
    if (!res.ok) {
      if (params.grant_type === 'refresh_token') {
        this.auth = null
        store.set(K_AUTH, null)
      }
      throw new Error(j.error_description || j.error || `HTTP ${res.status}`)
    }
    this.auth = {
      access: j.access_token,
      refresh: j.refresh_token ?? this.auth?.refresh ?? '',
      expires: Date.now() + j.expires_in * 1000,
    }
    store.set(K_AUTH, JSON.stringify(this.auth))
  }

  private async api(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${await this.fresh()}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (res.status === 204 || res.status === 202) return null
    const j = await res.json().catch(() => null)
    if (!res.ok) {
      if (res.status === 403 && /premium/i.test(j?.error?.reason ?? j?.error?.message ?? '')) {
        throw new Error('Spotify Premium is required.')
      }
      if (res.status === 403) throw new Error('Spotify refused — is your account added under the app\'s "User Management"?')
      throw new Error(j?.error?.message || `HTTP ${res.status}`)
    }
    return j
  }
}
