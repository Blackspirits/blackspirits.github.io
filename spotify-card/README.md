# Spotify Now Playing backend

Small Node.js backend used by the portfolio to display the owner's current or recently played Spotify track.

## Required Render environment variables

- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`
- `SPOTIFY_REFRESH_TOKEN` (added after the one-time OAuth flow)
- `LOGIN_SECRET` (a long random value used to protect `/login`)
- `SPOTIFY_REDIRECT_URI=https://blackspirits-spotify-card.onrender.com/callback`
- `PUBLIC_ORIGIN=https://blackspirits.github.io`

## One-time Spotify authorization

1. Create a Spotify Web API app.
2. Add the exact redirect URI above to the app allowlist.
3. Put Client ID, Client Secret and LOGIN_SECRET directly in Render.
4. Open `/login?token=<LOGIN_SECRET>`.
5. Approve `user-read-currently-playing` and `user-read-recently-played`.
6. Copy the returned refresh token directly to the Render environment variable `SPOTIFY_REFRESH_TOKEN`.
7. Never commit or share any of these secrets.

The frontend hides the Now Playing card whenever this backend is not configured or unavailable, so the embedded playlist remains a reliable fallback.
