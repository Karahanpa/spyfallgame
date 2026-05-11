# After Hours

After Hours is a mobile-first multiplayer party game inspired by Spyfall. Players join a room from their phones, receive a private role, talk in real life, vote in the app, and keep cumulative scores across rounds.

## Stack

- React 19
- Vite 5.4.19
- TailwindCSS 3
- Supabase realtime + table persistence
- Framer Motion

## Features

- Create or join rooms with a short room code
- Host-controlled lobby with round duration and themed location packs
- Secret role distribution with one or more spies based on room size
- Shared discussion timer and turn indicator
- Animated voting and scoreboard flow
- Rejoin support via local session persistence
- Room persistence through Supabase when configured
- Lightweight sound cues for reveals and transitions

## Local Development

1. Install dependencies:

```bash
npm install
```

2. Create a local env file from `.env.example` and add your Supabase project values.

3. Start the app:

```bash
npm run dev
```

The Vite dev server is configured with `host: true` so phones on the same network can open the local server URL.

## Supabase Setup

Create the table in `supabase/schema.sql`, then enable realtime for the `party_rooms` table in Supabase.

Minimal flow:

1. Run the SQL in the Supabase SQL editor.
2. Turn on realtime for `public.party_rooms`.
3. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to your env file.

Without Supabase, the app still runs in a local fallback mode for same-device testing and UI development.

## Build

```bash
npm run build
```
