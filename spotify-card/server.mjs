import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 10000);
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';
let refreshToken = process.env.SPOTIFY_REFRESH_TOKEN || '';
const LOGIN_SECRET = process.env.LOGIN_SECRET || '';
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'https://blackspirits-spotify-card.onrender.com/callback';
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || 'https://blackspirits.github.io';

const scopes = ['user-read-currently-playing', 'user-read-recently-played'];
let tokenCache = { value: '', expiresAt: 0 };
let nowCache = { value: null, expiresAt: 0 };

function json(res, status, body, extra = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': PUBLIC_ORIGIN,
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'vary': 'Origin',
    ...extra,
  });
  res.end(JSON.stringify(body));
}

function html(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function signState(timestamp) {
  return crypto.createHmac('sha256', LOGIN_SECRET).update(timestamp).digest('hex');
}

function makeState() {
  const timestamp = String(Date.now());
  return timestamp + '.' + signState(timestamp);
}

function validState(state) {
  if (!LOGIN_SECRET || !state || !state.includes('.')) return false;
  const [timestamp, signature] = state.split('.', 2);
  if (!/^\d+$/.test(timestamp) || Date.now() - Number(timestamp) > 10 * 60 * 1000) return false;
  const expected = signState(timestamp);
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function tokenRequest(params) {
  const auth = Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64');
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      authorization: 'Basic ' + auth,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error('Spotify token request failed: ' + response.status + ' ' + (payload.error_description || payload.error || ''));
  }
  return payload;
}

async function getAccessToken(force = false) {
  if (!CLIENT_ID || !CLIENT_SECRET || !refreshToken) {
    const error = new Error('Spotify is not configured');
    error.code = 'NOT_CONFIGURED';
    throw error;
  }
  if (!force && tokenCache.value && Date.now() < tokenCache.expiresAt - 30_000) return tokenCache.value;

  const payload = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  if (payload.refresh_token) refreshToken = payload.refresh_token;
  tokenCache = {
    value: payload.access_token,
    expiresAt: Date.now() + (Number(payload.expires_in) || 3600) * 1000,
  };
  return tokenCache.value;
}

async function spotifyFetch(path, retry = true) {
  const token = await getAccessToken();
  const response = await fetch('https://api.spotify.com/v1' + path, {
    headers: { authorization: 'Bearer ' + token },
  });
  if (response.status === 401 && retry) {
    tokenCache = { value: '', expiresAt: 0 };
    await getAccessToken(true);
    return spotifyFetch(path, false);
  }
  return response;
}

function trackPayload(item) {
  if (!item) return null;
  const album = item.album || item.show || {};
  const artists = Array.isArray(item.artists) && item.artists.length
    ? item.artists.map(artist => artist.name)
    : item.show?.name ? [item.show.name] : [];
  const images = album.images || item.images || [];
  return {
    name: item.name || '',
    artists,
    album: album.name || '',
    image: images[0]?.url || '',
    url: item.external_urls?.spotify || 'https://open.spotify.com/',
  };
}

async function fetchNowPlaying() {
  if (nowCache.value && Date.now() < nowCache.expiresAt) return nowCache.value;

  const current = await spotifyFetch('/me/player/currently-playing');
  if (current.status === 200) {
    const data = await current.json();
    const track = trackPayload(data.item);
    if (track) {
      const value = {
        state: data.is_playing ? 'playing' : 'paused',
        track,
        progress_ms: Number(data.progress_ms) || 0,
        duration_ms: Number(data.item?.duration_ms) || 0,
        fetched_at: new Date().toISOString(),
      };
      nowCache = { value, expiresAt: Date.now() + 15_000 };
      return value;
    }
  } else if (current.status !== 204) {
    throw new Error('Spotify currently-playing failed: ' + current.status);
  }

  const recent = await spotifyFetch('/me/player/recently-played?limit=1');
  if (!recent.ok) throw new Error('Spotify recently-played failed: ' + recent.status);
  const data = await recent.json();
  const latest = data.items?.[0];
  const value = latest?.track ? {
    state: 'recent',
    track: trackPayload(latest.track),
    progress_ms: 0,
    duration_ms: Number(latest.track.duration_ms) || 0,
    played_at: latest.played_at || null,
    fetched_at: new Date().toISOString(),
  } : {
    state: 'offline',
    track: null,
    progress_ms: 0,
    duration_ms: 0,
    fetched_at: new Date().toISOString(),
  };
  nowCache = { value, expiresAt: Date.now() + 15_000 };
  return value;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const url = new URL(req.url, 'http://localhost');

  try {
    if (url.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        spotify_configured: Boolean(CLIENT_ID && CLIENT_SECRET && refreshToken),
        login_configured: Boolean(LOGIN_SECRET),
      });
    }

    if (url.pathname === '/now-playing') {
      try {
        const payload = await fetchNowPlaying();
        return json(res, 200, payload);
      } catch (error) {
        if (error.code === 'NOT_CONFIGURED') {
          return json(res, 503, { state: 'offline', configured: false });
        }
        console.error('now-playing:', error.message);
        return json(res, 502, { state: 'offline' });
      }
    }

    if (url.pathname === '/login') {
      if (!LOGIN_SECRET || url.searchParams.get('token') !== LOGIN_SECRET) {
        return html(res, 403, '<h1>Forbidden</h1>');
      }
      if (!CLIENT_ID || !CLIENT_SECRET) {
        return html(res, 503, '<h1>Spotify client credentials are not configured.</h1>');
      }
      const authorize = new URL('https://accounts.spotify.com/authorize');
      authorize.searchParams.set('response_type', 'code');
      authorize.searchParams.set('client_id', CLIENT_ID);
      authorize.searchParams.set('scope', scopes.join(' '));
      authorize.searchParams.set('redirect_uri', REDIRECT_URI);
      authorize.searchParams.set('state', makeState());
      authorize.searchParams.set('show_dialog', 'true');
      res.writeHead(302, { location: authorize.toString(), 'cache-control': 'no-store' });
      return res.end();
    }

    if (url.pathname === '/callback') {
      const state = url.searchParams.get('state') || '';
      const code = url.searchParams.get('code') || '';
      if (!validState(state) || !code) return html(res, 400, '<h1>Invalid OAuth callback.</h1>');

      const payload = await tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      });
      if (!payload.refresh_token) return html(res, 500, '<h1>No refresh token was returned.</h1>');

      refreshToken = payload.refresh_token;
      tokenCache = { value: payload.access_token || '', expiresAt: Date.now() + (Number(payload.expires_in) || 3600) * 1000 };
      const safe = escapeHtml(payload.refresh_token);
      return html(res, 200, `<!doctype html><meta charset="utf-8"><title>Spotify connected</title>
        <body style="font-family:system-ui;background:#11111b;color:#cdd6f4;padding:32px;max-width:760px;margin:auto">
        <h1>Spotify connected</h1>
        <p>Copy this refresh token directly into the Render environment variable <code>SPOTIFY_REFRESH_TOKEN</code>. Do not share it in chat or commit it to GitHub.</p>
        <pre style="white-space:pre-wrap;word-break:break-all;background:#181825;padding:16px;border-radius:10px">${safe}</pre>
        <p>After saving the environment variable, the public <code>/now-playing</code> endpoint will be ready.</p></body>`);
    }

    return json(res, 404, { error: 'not_found' });
  } catch (error) {
    console.error('request:', error.message);
    return json(res, 500, { error: 'internal_error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Spotify card service listening on port', PORT);
});
