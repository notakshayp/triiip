import { Spotify } from './spotify'

// ---------------------------------------------------------------------------
// The 🎵 HUD pill and its panel: setup (client ID + connect), then a small
// now-playing card with transport, volume and the player's playlists. All
// state lives in Spotify; this just mirrors it into the DOM on change.
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null

export function mountMusic(music: Spotify): void {
  const pill = $('music')
  const label = $('music-label')
  const panel = $('music-panel')
  const setup = $('music-setup')
  const playerEl = $('music-player')
  const msg = $('music-msg')
  const clientIn = $<HTMLInputElement>('music-client')
  const art = $<HTMLImageElement>('music-art')
  const title = $('music-title')
  const artist = $('music-artist')
  const progress = $('music-progress')
  const toggle = $('music-toggle')
  const volume = $<HTMLInputElement>('music-volume')
  const lists = $('music-lists')
  const user = $('music-user')
  let currentList = ''

  const redirect = $('music-redirect')
  if (redirect) redirect.textContent = music.redirectUri
  if (location.hostname === 'localhost') {
    // Spotify no longer accepts "localhost" redirect URIs, only the loopback IP.
    const warn = $('music-localhost')
    if (warn) {
      warn.hidden = false
      warn.textContent = `Spotify only accepts 127.0.0.1 for local testing — open http://127.0.0.1:${location.port}${location.pathname} instead.`
    }
  }
  if (clientIn) clientIn.value = music.clientId
  if (volume) volume.value = String(music.volume)

  const open = (show: boolean) => {
    if (!panel) return
    panel.hidden = !show
    if (show) {
      // One floating panel at a time: they share the same corner.
      document.getElementById('time-panel')?.setAttribute('hidden', '')
      document.getElementById('biome-panel')?.setAttribute('hidden', '')
    }
  }
  pill?.addEventListener('click', () => open(!!panel?.hidden))
  $('music-close')?.addEventListener('click', () => open(false))
  $('music-connect')?.addEventListener('click', () => {
    if (clientIn) music.clientId = clientIn.value
    music.login()
  })
  $('music-copy')?.addEventListener('click', (e) => {
    navigator.clipboard?.writeText(music.redirectUri)
    ;(e.target as HTMLButtonElement).textContent = 'Copied'
  })
  toggle?.addEventListener('click', () => music.togglePlay())
  $('music-prev')?.addEventListener('click', () => music.prev())
  $('music-next')?.addEventListener('click', () => music.next())
  volume?.addEventListener('input', () => music.setVolume(Number(volume.value)))
  $('music-logout')?.addEventListener('click', () => music.logout())

  let listsShown: unknown = null
  const renderLists = () => {
    if (!lists || listsShown === music.playlists) return
    listsShown = music.playlists
    lists.replaceChildren(
      ...music.playlists.map((p) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.dataset.uri = p.uri
        let thumb: HTMLElement
        if (p.image) {
          thumb = document.createElement('img')
          ;(thumb as HTMLImageElement).src = p.image
          ;(thumb as HTMLImageElement).alt = ''
          ;(thumb as HTMLImageElement).loading = 'lazy'
        } else {
          thumb = document.createElement('span')
          thumb.className = 'ph'
          thumb.textContent = p.uri ? '♪' : '♥'
        }
        const nm = document.createElement('span')
        nm.className = 'nm'
        nm.textContent = p.name
        b.append(thumb, nm)
        b.addEventListener('click', () => {
          currentList = p.uri || 'liked'
          music.playList(p)
          render()
        })
        return b
      }),
    )
  }

  const render = () => {
    const live = music.connected && music.status !== 'setup'
    if (setup) setup.hidden = live
    if (playerEl) playerEl.hidden = !live
    if (msg) {
      msg.hidden = !music.message
      msg.textContent = music.message
    }
    const t = music.track
    if (title) title.textContent = t ? t.name : music.status === 'connecting' ? 'Connecting…' : music.status === 'error' ? 'Not playing' : 'Ready'
    if (artist) artist.textContent = t ? t.artists : music.status === 'ready' ? 'Pick a playlist below' : ''
    if (art) {
      if (t?.art) art.src = t.art
      else art.removeAttribute('src')
    }
    if (toggle) toggle.textContent = music.status === 'playing' ? '⏸' : '▶'
    if (user) user.textContent = music.user ? `Signed in as ${music.user}` : ''
    if (label) {
      label.textContent = t && (music.status === 'playing' || music.status === 'paused') ? `${music.status === 'playing' ? '♪' : '⏸'} ${t.name} — ${t.artists}` : '🎵'
    }
    renderLists()
    lists?.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.setAttribute('aria-current', String((b.dataset.uri || 'liked') === currentList))
    })
  }
  music.onChange = render
  render()

  // Progress bar: extrapolated between SDK state updates.
  setInterval(() => {
    if (!progress || panel?.hidden || !music.duration) return
    progress.style.width = `${(music.positionNow / music.duration) * 100}%`
  }, 500)

  // Coming back from Spotify's login (or a failed one): show the panel so the
  // next step — pick a playlist, or read what went wrong — is right there.
  const q = new URLSearchParams(location.search)
  const returning = q.has('code') || q.has('error')
  music.init().then(() => {
    if (returning || music.message) open(true)
  })
}
