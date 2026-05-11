import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY
const ROOM_TABLE = 'party_rooms'
const SESSION_KEY = 'spyfall-room-session'

export const hasSupabase = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY)

export const supabase = hasSupabase
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: false,
      },
    })
  : null

export function getRoomSession() {
  if (typeof window === 'undefined') {
    return null
  }

  const raw = window.localStorage.getItem(SESSION_KEY)
  return raw ? JSON.parse(raw) : null
}

export function clearRoomSession() {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.removeItem(SESSION_KEY)
}

export function setRoomSession(session) {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(SESSION_KEY, JSON.stringify(session))
}

export async function loadRoomState(roomCode) {
  const upperCode = roomCode.toUpperCase()
  const cachedRoom = readLocalRoom(upperCode)

  if (!supabase) {
    return cachedRoom
  }

  const { data, error, status } = await supabase
    .from(ROOM_TABLE)
    .select('state')
    .eq('code', upperCode)
    .maybeSingle()

  if (error && status !== 406) {
    throw error
  }

  // With Supabase enabled, treat DB as source of truth to avoid stale local ghost rooms.
  const nextRoom = data?.state ?? null

  if (nextRoom) {
    writeLocalRoom(nextRoom)
  } else {
    clearLocalRoom(upperCode)
  }

  return nextRoom
}

export async function saveRoomState(room) {
  const nextRoom = {
    ...room,
    updatedAt: Date.now(),
  }

  writeLocalRoom(nextRoom)
  broadcastLocalRoom(nextRoom)

  if (!supabase) {
    return nextRoom
  }

  const payload = {
    code: nextRoom.code,
    state: nextRoom,
    updated_at: new Date(nextRoom.updatedAt).toISOString(),
    expires_at: new Date(Date.now() + 1000 * 60 * 60 * 12).toISOString(),
  }

  const { error } = await supabase.from(ROOM_TABLE).upsert(payload)

  if (error) {
    throw error
  }

  return nextRoom
}

export async function deleteRoomState(roomCode) {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(localRoomKey(roomCode))
  }

  if (!supabase) {
    return
  }

  const { error } = await supabase.from(ROOM_TABLE).delete().eq('code', roomCode.toUpperCase())

  if (error) {
    throw error
  }
}

export async function listOpenRooms(limit = 8) {
  if (!supabase) {
    return listLocalRooms(limit)
  }

  const nowIso = new Date().toISOString()
  const { data, error } = await supabase
    .from(ROOM_TABLE)
    .select('code,state,updated_at')
    .gt('expires_at', nowIso)
    .order('updated_at', { ascending: false })
    .limit(limit)

  if (error) {
    throw error
  }

  return (data ?? [])
    .map((row) => ({
      code: row.code,
      phase: row.state?.phase ?? 'lobby',
      playerCount: Array.isArray(row.state?.players) ? row.state.players.length : 0,
      updatedAt: row.state?.updatedAt ?? Date.parse(row.updated_at),
    }))
    .filter((room) => room.code)
}

export function subscribeToRoomState(roomCode, onChange) {
  const cleanupTasks = []
  const channelName = `spyfall-room-${roomCode}`

  const handleStorage = (event) => {
    if (event.key !== localRoomKey(roomCode) || !event.newValue) {
      return
    }

    onChange(JSON.parse(event.newValue))
  }

  window.addEventListener('storage', handleStorage)
  cleanupTasks.push(() => window.removeEventListener('storage', handleStorage))

  if (typeof BroadcastChannel !== 'undefined') {
    const broadcastChannel = new BroadcastChannel(channelName)
    broadcastChannel.onmessage = (event) => onChange(event.data)
    cleanupTasks.push(() => broadcastChannel.close())
  }

  if (supabase) {
    const realtimeChannel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: ROOM_TABLE,
          filter: `code=eq.${roomCode}`,
        },
        (payload) => {
          if (payload.new?.state) {
            writeLocalRoom(payload.new.state)
            onChange(payload.new.state)
          }
        },
      )
      .subscribe()

    cleanupTasks.push(() => {
      supabase.removeChannel(realtimeChannel)
    })
  }

  return () => {
    cleanupTasks.forEach((cleanup) => cleanup())
  }
}

function localRoomKey(roomCode) {
  return `spyfall-room:${roomCode.toUpperCase()}`
}

function clearLocalRoom(roomCode) {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.removeItem(localRoomKey(roomCode))
}

function readLocalRoom(roomCode) {
  if (typeof window === 'undefined') {
    return null
  }

  const raw = window.localStorage.getItem(localRoomKey(roomCode))
  return raw ? JSON.parse(raw) : null
}

function writeLocalRoom(room) {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(localRoomKey(room.code), JSON.stringify(room))
}

function broadcastLocalRoom(room) {
  if (typeof BroadcastChannel === 'undefined') {
    return
  }

  const channel = new BroadcastChannel(`spyfall-room-${room.code}`)
  channel.postMessage(room)
  channel.close()
}

function listLocalRooms(limit) {
  if (typeof window === 'undefined') {
    return []
  }

  const rooms = []

  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index)

    if (!key || !key.startsWith('spyfall-room:')) {
      continue
    }

    const raw = window.localStorage.getItem(key)

    if (!raw) {
      continue
    }

    try {
      const parsed = JSON.parse(raw)
      rooms.push({
        code: parsed.code,
        phase: parsed.phase ?? 'lobby',
        playerCount: Array.isArray(parsed.players) ? parsed.players.length : 0,
        updatedAt: parsed.updatedAt ?? 0,
      })
    } catch {
      // Ignore malformed cache entries.
    }
  }

  return rooms
    .filter((room) => (Date.now() - (room.updatedAt ?? 0)) < 1000 * 60 * 60 * 12)
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
    .slice(0, limit)
}

