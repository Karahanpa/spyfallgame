import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  BookOpen,
  ChevronRight,
  Clock3,
  Crown,
  MapPin,
  Play,
  RefreshCw,
  Settings,
  Trophy,
  User,
  Users,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { LOCATIONS } from './data/locationPacks'
import {
  advanceTurn,
  beginVoting,
  castVote,
  createInitialRoom,
  createPlayer,
  finalizeVoting,
  getSpyCount,
  markRoleReady,
  startDiscussion,
  startRound,
  submitSpyGuess,
} from './lib/game'
import {
  clearRoomSession,
  getRoomSession,
  listOpenRooms,
  loadRoomState,
  saveRoomState,
  setRoomSession,
  subscribeToRoomState,
} from './lib/supabase'

const durationOptions = [240, 360, 480, 600]
const MIN_PLAYERS_TO_START = 2

function App() {
  const [room, setRoom] = useState(null)
  const [playerId, setPlayerId] = useState('')
  const [playerName, setPlayerName] = useState(() => localStorage.getItem('spyfall-player-name') ?? '')
  const [joinCode, setJoinCode] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const [syncError, setSyncError] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const [bootingSession, setBootingSession] = useState(true)
  const [openRooms, setOpenRooms] = useState([])

  const me = useMemo(
    () => room?.players.find((player) => player.id === playerId) ?? null,
    [playerId, room],
  )
  const isHost = room?.hostId === playerId
  const isSpy = Boolean(room?.round?.spies?.includes(playerId))
  const round = room?.round ?? null
  const currentTurnPlayer = room?.players?.[room?.currentTurnIndex ?? 0] ?? null
  const myRole = round?.assignments?.[playerId] ?? null
  const secondsLeft = useCountdown(round?.endsAt)
  const allPlayersReady = Boolean(
    round && room?.players.every((player) => round.readyIds.includes(player.id)),
  )
  const allNonSpiesVoted = Boolean(
    round &&
      room?.players
        .filter((player) => !round.spies.includes(player.id))
        .every((player) => Boolean(round.votes[player.id])),
  )
  const allSpiesGuessed = Boolean(
    round && round.spies.every((spyId) => Boolean(round.spyGuesses?.[spyId])),
  )
  const everyoneCompletedVoting = Boolean(round && allNonSpiesVoted && allSpiesGuessed)

  useEffect(() => {
    let cancelled = false

    async function restoreSession() {
      const saved = getRoomSession()

      if (!saved?.roomCode || !saved?.playerId) {
        if (!cancelled) {
          setBootingSession(false)
        }
        return
      }

      try {
        const nextRoom = await loadRoomState(saved.roomCode)

        if (!nextRoom) {
          clearRoomSession()
        } else {
          // Keep session for explicit Quick rejoin only.
          if (!cancelled) {
            setJoinCode(saved.roomCode)
            setPlayerName(saved.playerName ?? '')
            setRoomSession(saved)
          }
        }

        if (!cancelled) {
          setBootingSession(false)
        }
      } catch (error) {
        if (!cancelled) {
          setSyncError(getFriendlyError(error))
          setBootingSession(false)
        }
      }
    }

    restoreSession()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!room?.code) {
      return undefined
    }

    return subscribeToRoomState(room.code, (incomingRoom) => {
      setRoom(incomingRoom)
    })
  }, [room?.code])

  useEffect(() => {
    if (!room?.code || !playerId) {
      return
    }

    localStorage.setItem('spyfall-player-name', playerName)
  }, [playerName, playerId, room?.code])

  useEffect(() => {
    if (room) {
      return undefined
    }

    let cancelled = false

    async function refreshOpenRooms() {
      try {
        const discoveredRooms = await listOpenRooms(6)

        if (!cancelled) {
          setOpenRooms(discoveredRooms)
        }
      } catch {
        if (!cancelled) {
          setOpenRooms([])
        }
      }
    }

    refreshOpenRooms()

    const intervalId = window.setInterval(refreshOpenRooms, 7000)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [room])

  useEffect(() => {
    if (!isHost || room?.phase !== 'discussion' || secondsLeft > 0) {
      return
    }

    updateRoom(beginVoting(room), 'Discussion closed. Voting is live.')
    playCue('vote')
  }, [isHost, room, secondsLeft])

  useEffect(() => {
    if (!isHost || room?.phase !== 'voting' || !everyoneCompletedVoting) {
      return
    }

    updateRoom(finalizeVoting(room), 'Votes revealed.')
    playCue('reveal')
  }, [everyoneCompletedVoting, isHost, room])

  async function updateRoom(nextRoom, nextStatusMessage = '') {
    setRoom(nextRoom)
    setStatusMessage(nextStatusMessage)
    setIsBusy(true)

    try {
      await saveRoomState(nextRoom)
      setSyncError('')
      return true
    } catch (error) {
      setSyncError(getFriendlyError(error))
      return false
    } finally {
      setIsBusy(false)
    }
  }

  async function handleCreateRoom() {
    const cleanName = getMenuPlayerName(playerName)

    if (!cleanName) {
      setStatusMessage('Enter your name to create a room.')
      return
    }

    const hostPlayer = createPlayer(cleanName)
    const nextRoom = createInitialRoom(hostPlayer)

    setPlayerId(hostPlayer.id)
    setPlayerName(cleanName)
    setJoinCode(nextRoom.code)
    localStorage.setItem('spyfall-player-name', cleanName)
    setRoomSession({ roomCode: nextRoom.code, playerId: hostPlayer.id, playerName: cleanName })

    const synced = await updateRoom(nextRoom, '')

    if (synced) {
      playCue('join')
      return
    }

    setStatusMessage(
      'Game was created locally, but sync failed. Fix Supabase setup before friends try to join.',
    )
  }

  async function handleJoinRoom() {
    const cleanName = getMenuPlayerName(playerName)
    const code = joinCode.trim().toUpperCase()
    const savedSession = getRoomSession()
    const reconnectPlayerId = savedSession?.roomCode === code ? savedSession.playerId : ''

    if (!cleanName) {
      setStatusMessage('Enter your name before joining a room.')
      return
    }

    if (code.length < 4) {
      setStatusMessage('Enter a valid room code.')
      return
    }

    setIsBusy(true)

    try {
      const existingRoom = await loadRoomStateWithRetry(code)

      if (!existingRoom) {
        setStatusMessage(
          'That room was not found. If it was just created, wait 2-3 seconds and try again.',
        )
        return
      }

      const alreadyJoined = existingRoom.players.find(
        (player) => player.id === playerId || (reconnectPlayerId && player.id === reconnectPlayerId),
      )

      if (existingRoom.phase !== 'lobby' && !alreadyJoined) {
        setStatusMessage('That room is mid-round. Rejoin with your saved session instead.')
        return
      }

      const nextPlayer = alreadyJoined ?? createPlayer(cleanName)
      const nextRoom = alreadyJoined
        ? {
            ...existingRoom,
            players: existingRoom.players.map((player) =>
              player.id === alreadyJoined.id
                ? { ...player, name: cleanName, connected: true, lastSeenAt: Date.now() }
                : player,
            ),
          }
        : {
            ...existingRoom,
            players: [
              ...existingRoom.players,
              { ...nextPlayer, connected: true, lastSeenAt: Date.now() },
            ],
          }

      setPlayerId(nextPlayer.id)
      setPlayerName(cleanName)
      setRoomSession({ roomCode: code, playerId: nextPlayer.id, playerName: cleanName })
      await updateRoom(nextRoom, '')
      playCue('join')
    } catch (error) {
      setSyncError(getFriendlyError(error))
    } finally {
      setIsBusy(false)
    }
  }

  async function handleQuickRejoin() {
    const saved = getRoomSession()

    if (!saved?.roomCode || !saved?.playerId) {
      setStatusMessage('No saved room found yet.')
      return
    }

    const cleanName = getMenuPlayerName(saved.playerName ?? playerName)
    const code = saved.roomCode.trim().toUpperCase()

    setPlayerName(cleanName)
    setJoinCode(code)
    setIsBusy(true)

    try {
      const existingRoom = await loadRoomStateWithRetry(code)

      if (!existingRoom) {
        setStatusMessage('Saved room was not found. Ask host for a fresh code.')
        return
      }

      const alreadyJoined = existingRoom.players.find(
        (player) => player.id === saved.playerId || player.id === playerId,
      )

      if (existingRoom.phase !== 'lobby' && !alreadyJoined) {
        setStatusMessage('Saved seat is no longer available in this room.')
        return
      }

      const nextPlayer = alreadyJoined ?? createPlayer(cleanName)
      const nextRoom = alreadyJoined
        ? {
            ...existingRoom,
            players: existingRoom.players.map((player) =>
              player.id === alreadyJoined.id
                ? { ...player, name: cleanName, connected: true, lastSeenAt: Date.now() }
                : player,
            ),
          }
        : {
            ...existingRoom,
            players: [
              ...existingRoom.players,
              { ...nextPlayer, connected: true, lastSeenAt: Date.now() },
            ],
          }

      setPlayerId(nextPlayer.id)
      setRoomSession({ roomCode: code, playerId: nextPlayer.id, playerName: cleanName })
      await updateRoom(nextRoom, '')
      playCue('join')
    } catch (error) {
      setSyncError(getFriendlyError(error))
    } finally {
      setIsBusy(false)
    }
  }

  function updateSetting(key, value) {
    if (!room || !isHost) {
      return
    }

    updateRoom({
      ...room,
      settings: {
        ...room.settings,
        [key]: value,
      },
    })
  }

  function handleStartRound() {
    if (!room || !isHost) {
      return
    }

    if (room.players.length < MIN_PLAYERS_TO_START) {
      setStatusMessage(`Need at least ${MIN_PLAYERS_TO_START} players to start.`)
      return
    }

    const nextRoom = startRound(room, LOCATIONS)
    updateRoom(nextRoom, 'Roles dealt. Pass the phones around.')
    playCue('reveal')
  }

  function handleReadyUp() {
    if (!room || !round || !me) {
      return
    }

    const nextRoom = markRoleReady(room, me.id)
    updateRoom(nextRoom)
  }

  function handleBeginDiscussion() {
    if (!room || !isHost) {
      return
    }

    updateRoom(startDiscussion(room), 'Discussion is live.')
    playCue('start')
  }

  function handleAdvanceTurn() {
    if (!room || !isHost) {
      return
    }

    updateRoom(advanceTurn(room), `${currentTurnPlayer?.name ?? 'Next player'} wrapped their turn.`)
  }

  function handleOpenVoting() {
    if (!room || !isHost) {
      return
    }

    updateRoom(beginVoting(room), 'Voting is live.')
    playCue('vote')
  }

  function handleVote(targetId) {
    if (!room || !me || room.phase !== 'voting' || isSpy) {
      return
    }

    updateRoom(castVote(room, me.id, targetId), 'Vote locked in.')
  }

  function handleSpyLocationGuess(location) {
    if (!room || !me || room.phase !== 'voting' || !isSpy || !location) {
      return
    }

    updateRoom(submitSpyGuess(room, me.id, location), 'Spy guess locked in.')
  }

  function handleNextRound() {
    if (!room || !isHost) {
      return
    }

    const nextRoom = {
      ...room,
      phase: 'lobby',
      currentTurnIndex: 0,
      round: null,
    }

    updateRoom(nextRoom, 'Back in the lobby.')
  }

  function handleBackToWelcome() {
    setRoom(null)
    setStatusMessage('')
    setSyncError('')
    setIsBusy(false)
    setBootingSession(false)
  }

  const savedSession = getRoomSession()
  const canQuickRejoin = Boolean(savedSession?.roomCode && savedSession?.playerId)

  return (
    <main className={`min-h-screen text-[#f3e1c1] ${room ? 'bg-abyss' : 'bg-[#111827]'}`}>
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-72 bg-[radial-gradient(circle_at_top,_rgba(255,146,84,0.18),_transparent_60%)]" />
        <div className="absolute bottom-0 right-[-10rem] h-96 w-96 rounded-full bg-[radial-gradient(circle,_rgba(76,201,240,0.18),_transparent_60%)] blur-3xl" />
        <div className="absolute left-[-8rem] top-1/3 h-80 w-80 rounded-full bg-[radial-gradient(circle,_rgba(183,104,255,0.12),_transparent_60%)] blur-3xl" />
      </div>

      <div className={`relative flex w-full flex-col px-4 pt-3 sm:px-6 lg:px-10 ${room ? 'min-h-screen pb-12' : 'mx-auto max-w-6xl min-h-screen pb-4 items-center justify-center'}`}>



        {syncError ? (
          <div className="mb-4 rounded-3xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning sm:mb-6">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{syncError}</p>
            </div>
          </div>
        ) : null}

        {bootingSession ? (
          <LoadingCard />
        ) : room && me ? (
          <div className="flex flex-1 flex-col">
            <button
              type="button"
              className="ghost-button mb-3 ml-auto w-auto"
              onClick={handleBackToWelcome}
            >
              <ArrowLeft className="size-4" />
              Back
            </button>
            <AnimatePresence mode="wait">
              <motion.div
                key={room.phase}
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -18 }}
                transition={{ duration: 0.28, ease: 'easeOut' }}
                className="w-full"
              >
                {room.phase === 'lobby' ? (
                  <LobbyScreen room={room} isHost={isHost} onSettingChange={updateSetting} onStartRound={handleStartRound} />
                ) : null}
                {room.phase === 'role' ? (
                  <RoleScreen
                    room={room}
                    round={round}
                    myRole={myRole}
                    playerId={playerId}
                    onReady={handleReadyUp}
                    onBeginDiscussion={handleBeginDiscussion}
                    isHost={isHost}
                    allPlayersReady={allPlayersReady}
                  />
                ) : null}
                {room.phase === 'discussion' ? (
                  <DiscussionScreen
                    room={room}
                    currentTurnPlayer={currentTurnPlayer}
                    secondsLeft={secondsLeft}
                    isHost={isHost}
                    onAdvanceTurn={handleAdvanceTurn}
                    onOpenVoting={handleOpenVoting}
                  />
                ) : null}
                {room.phase === 'voting' ? (
                  <VotingScreen
                    room={room}
                    me={me}
                    isSpy={isSpy}
                    onVote={handleVote}
                    onSpyGuess={handleSpyLocationGuess}
                    everyoneCompletedVoting={everyoneCompletedVoting}
                  />
                ) : null}
                {room.phase === 'scoreboard' ? (
                  <ScoreboardScreen room={room} isHost={isHost} onNextRound={handleNextRound} />
                ) : null}
              </motion.div>
            </AnimatePresence>
          </div>
        ) : (
          <WelcomeScreen
            playerName={playerName}
            setPlayerName={setPlayerName}
            joinCode={joinCode}
            setJoinCode={setJoinCode}
            onCreateRoom={handleCreateRoom}
            onJoinRoom={handleJoinRoom}
            onQuickRejoin={handleQuickRejoin}
            canQuickRejoin={canQuickRejoin}
            openRooms={openRooms}
            isBusy={isBusy}
            statusMessage={statusMessage}
            onClearStatus={() => setStatusMessage('')}
          />
        )}
      </div>
    </main>
  )
}

function WelcomeScreen({
  playerName,
  setPlayerName,
  joinCode,
  setJoinCode,
  onCreateRoom,
  onJoinRoom,
  onQuickRejoin,
  canQuickRejoin,
  openRooms,
  isBusy,
  statusMessage,
  onClearStatus,
}) {
  const [logoHidden, setLogoHidden] = useState(false)
  const [view, setView] = useState('play')
  const [howToOpen, setHowToOpen] = useState(false)
  const [statsOpen, setStatsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <div className="relative mx-auto flex w-full max-w-3xl flex-col px-1 py-2 sm:px-2 sm:py-3">
      {!logoHidden && view !== 'play' ? (
        <img
          src="/logo.png"
          alt="Who's the Spy logo"
          className="mx-auto mb-8 w-full max-w-[400px] object-contain sm:max-w-[460px]"
          onError={() => setLogoHidden(true)}
        />
      ) : null}

      <div className="mb-3 pl-3">
        <p className="text-xs uppercase tracking-[0.32em] text-sunset">
          {view === 'play' ? 'Play' : 'Main menu'}
        </p>
      </div>

      {view === 'main' ? (
        <>
          <div className="space-y-3">
            <MenuCard
              title="Play"
              subtitle="Create or join a room"
              icon={Play}
              accent="sunset"
              onClick={() => setView('play')}
              disabled={isBusy}
            />

            <MenuCard
              title="Quick rejoin"
              subtitle={canQuickRejoin ? 'Jump back into your last room' : 'No saved room available yet'}
              icon={RefreshCw}
              accent="neutral"
              onClick={onQuickRejoin}
              disabled={!canQuickRejoin || isBusy}
            />
            
            <MenuCard
              title="Stats"
              subtitle="Personal match summary"
              icon={BarChart3}
              accent="neutral"
              onClick={() => setStatsOpen(true)}
            />

            <MenuCard
              title="Settings"
              subtitle="Sound and preferences"
              icon={Settings}
              accent="neutral"
              onClick={() => setSettingsOpen(true)}
            />

            <MenuCard
              title="How to play"
              subtitle="Quick game rules"
              icon={BookOpen}
              accent="neutral"
              onClick={() => setHowToOpen(true)}
            />

          </div>
        </>
      ) : null}

      {view === 'play' ? (
        <>
          <button
            type="button"
            className="fixed right-6 top-4 z-50 ghost-button w-auto sm:right-8 sm:top-4"
            onClick={() => {
              setView('main')
              onClearStatus()
            }}
          >
            <ArrowLeft className="size-4" />
            Back
          </button>
          <div className="relative mt-5 rounded-[24px] border border-sunset/40 bg-[linear-gradient(120deg,rgba(255,146,84,0.12),rgba(9,18,35,0.75))] p-4 sm:p-5">

          {statusMessage ? (
            <div className="mb-4 rounded-3xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-[#f3e1c1]/75">
              {statusMessage}
            </div>
          ) : null}

          <div className="mb-4">
            <p className="mb-2 text-xs uppercase tracking-[0.24em] text-[#f3e1c1]/50">Your name</p>
            <input
              value={playerName}
              onChange={(event) => setPlayerName(event.target.value)}
              placeholder="Enter your name"
              className="input"
              maxLength={24}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <button type="button" className="primary-button" onClick={onCreateRoom} disabled={isBusy}>
              Create room
            </button>
            <div className="grid gap-2">
              <input
                value={joinCode}
                onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                placeholder="ABCD"
                className="input"
                maxLength={6}
              />
              <button type="button" className="secondary-button w-full" onClick={onJoinRoom} disabled={isBusy}>
                Join room
              </button>
            </div>
          </div>

          {openRooms.length > 0 ? (
            <div className="mt-5">
              <p className="text-xs uppercase tracking-[0.24em] text-[#f3e1c1]/45">Open rooms</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {openRooms.map((entry) => (
                  <button
                    key={entry.code}
                    type="button"
                    className="ghost-button w-auto px-4"
                    onClick={() => setJoinCode(entry.code)}
                  >
                    {entry.code} • {entry.playerCount}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          </div>
        </>
      ) : null}

      <AnimatePresence>
        {statsOpen ? (
          <motion.div
            className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 px-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setStatsOpen(false)}
          >
            <motion.section
              className="panel w-full max-w-md p-6"
              initial={{ opacity: 0, y: 14, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}
              onClick={(event) => event.stopPropagation()}
            >
              <p className="eyebrow">Stats</p>
              <h3 className="title-sm mt-3">Work in progress</h3>
              <p className="mt-3 text-sm leading-6 text-[#f3e1c1]/70">
                Match history and personal performance tracking are currently under construction.
              </p>
              <button
                type="button"
                className="secondary-button mt-6 w-full"
                onClick={() => setStatsOpen(false)}
              >
              Back
              </button>
            </motion.section>
          </motion.div>
        ) : null}

        {settingsOpen ? (
          <motion.div
            className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 px-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setSettingsOpen(false)}
          >
            <motion.section
              className="panel w-full max-w-md p-6"
              initial={{ opacity: 0, y: 14, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}
              onClick={(event) => event.stopPropagation()}
            >
              <p className="eyebrow">Settings</p>
              <h3 className="title-sm mt-3">Work in progress</h3>
              <p className="mt-3 text-sm leading-6 text-[#f3e1c1]/70">
                Sound controls, vibration toggles, and visual preferences are currently under construction.
              </p>
              <button
                type="button"
                className="secondary-button mt-6 w-full"
                onClick={() => setSettingsOpen(false)}
              >
                Back
              </button>
            </motion.section>
          </motion.div>
        ) : null}

        {howToOpen ? (
          <motion.div
            className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 px-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setHowToOpen(false)}
          >
            <motion.section
              className="panel w-full max-w-2xl p-6"
              initial={{ opacity: 0, y: 14, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}
              onClick={(event) => event.stopPropagation()}
            >
              <p className="eyebrow">How to play</p>
              <div className="mt-3 space-y-4 text-sm leading-6 text-[#f3e1c1]/70">
                <p>
                  At the start of each round, every player receives a secret role on their phone. Most players get the same hidden location, while one or more players become the Spy.
                </p>
                <p>
                  Players take turns asking each other questions about the location without revealing it directly. The non-spies try to identify who is acting suspicious, while the Spy tries to blend in and secretly figure out the location.
                </p>
                <p>
                  At the end of the round, non-spies vote for who they think the Spy is while spies secretly lock in a location guess at the same time. If a spy is exposed but any spy guessed the location correctly, the spy team still steals the win.
                </p>
              </div>
              <button
                type="button"
                className="secondary-button mt-6 w-full"
                onClick={() => setHowToOpen(false)}
              >
                Back
              </button>
            </motion.section>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

function MenuCard({ title, subtitle, icon: Icon, accent = 'neutral', onClick, disabled = false }) {
  const accentClasses = {
    sunset: 'border-sunset/45 bg-[linear-gradient(120deg,rgba(255,146,84,0.14),rgba(8,14,26,0.88))] shadow-[0_0_26px_rgba(255,146,84,0.18)]',
    aqua: 'border-aqua/40 bg-[linear-gradient(120deg,rgba(76,201,240,0.14),rgba(8,14,26,0.88))] shadow-[0_0_26px_rgba(76,201,240,0.16)]',
    neutral: 'border-white/15 bg-[linear-gradient(120deg,rgba(255,255,255,0.06),rgba(8,14,26,0.88))] shadow-[0_0_20px_rgba(0,0,0,0.25)]',
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`group flex w-full items-center gap-3 rounded-[24px] border px-3 py-3 text-left transition duration-150 hover:translate-y-[-1px] active:translate-y-[1px] sm:px-4 sm:py-4 ${accentClasses[accent] ?? accentClasses.neutral} ${disabled ? 'opacity-50' : ''}`}
    >
      <div className="flex size-12 shrink-0 items-center justify-center rounded-full border border-white/20 bg-black/35 shadow-inner sm:size-14">
        <Icon className="size-5 text-[#f3e1c1]/90 sm:size-6" />
      </div>
      <div className="flex-1">
        <p className="font-display text-3xl uppercase tracking-wide text-[#f3e1c1] sm:text-4xl">{title}</p>
        <p className="mt-0.5 text-base text-[#f3e1c1]/70 sm:text-lg">{subtitle}</p>
      </div>
      <ChevronRight className="size-6 shrink-0 text-[#f3e1c1]/65 transition group-hover:translate-x-1" />
    </button>
  )
}

function LobbyScreen({ room, isHost, onSettingChange, onStartRound }) {
  const [copyStatus, setCopyStatus] = useState('')

  const roomLink = getShareableRoomLink(room.code)

  async function copyValue(value, label) {
    try {
      await navigator.clipboard.writeText(value)
      setCopyStatus(`${label} copied`)
    } catch {
      setCopyStatus(`Unable to copy ${label.toLowerCase()}`)
    }
  }

  return (
    <div className="space-y-6 p-5 sm:p-7 mt-12 sm:mt-14">
      <section className="rounded-[28px] border border-white/10 bg-white/5 p-5 text-center sm:p-6">
        <p className="eyebrow">Waiting room</p>
        <p className="mt-4 font-display text-5xl tracking-[0.18em] text-[#f3e1c1] sm:text-6xl">{room.code}</p>
        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            className="secondary-button"
            onClick={() => copyValue(room.code, 'Code')}
          >
            Copy code
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => copyValue(roomLink, 'Link')}
          >
            Copy link
          </button>
        </div>
        {copyStatus ? <p className="mt-3 text-xs uppercase tracking-[0.22em] text-aqua">{copyStatus}</p> : null}
      </section>

      <section className="rounded-[28px] border border-white/10 bg-white/5 p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="eyebrow">Round timer</p>
            <h3 className="title-sm mt-2">{Math.round(room.settings.roundDuration / 60)} minutes</h3>
          </div>
          <Clock3 className="size-5 text-[#f3e1c1]/50" />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          {durationOptions.map((seconds) => (
            <button
              key={seconds}
              type="button"
              className={room.settings.roundDuration === seconds ? 'pill-active' : 'pill'}
              disabled={!isHost}
              onClick={() => onSettingChange('roundDuration', seconds)}
            >
              {Math.round(seconds / 60)} min
            </button>
          ))}
        </div>
      </section>

      <div className="rounded-[28px] border border-white/10 bg-white/5 p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="eyebrow">Game balance</p>
            <h3 className="title-sm mt-2">
              {getSpyCount(room.players.length)} spy{getSpyCount(room.players.length) > 1 ? 'ies' : ''}
            </h3>
          </div>
          <Tag>{room.players.length} players</Tag>
        </div>
        <p className="mt-3 text-sm leading-6 text-[#f3e1c1]/65">
          Spy count scales with room size.
        </p>
      </div>

      <section className="rounded-[28px] border border-white/10 bg-white/5 p-4 sm:p-5">
        <div className="mb-5 flex items-center justify-between gap-3">
          <div>
            <p className="eyebrow">Room crew</p>
            <h2 className="title-sm">Players</h2>
          </div>
          <Tag>{room.players.length}</Tag>
        </div>

        <div className="grid gap-3">
          {room.players.map((player) => (
            <PlayerCard key={player.id} player={player} isHost={room.hostId === player.id} />
          ))}
        </div>
      </section>

      <button
        type="button"
        className="primary-button w-full"
        disabled={!isHost || room.players.length < MIN_PLAYERS_TO_START}
        onClick={onStartRound}
      >
        <Play className="size-4" />
        {room.players.length < MIN_PLAYERS_TO_START ? `Need at least ${MIN_PLAYERS_TO_START} players` : 'Start round'}
      </button>
    </div>
  )
}

function RoleScreen({ room, round, myRole, playerId, onReady, onBeginDiscussion, isHost, allPlayersReady }) {
  const isReady = round.readyIds.includes(playerId)

  return (
    <div className="space-y-6 p-5 sm:p-7">
      <div>
        <p className="eyebrow">Secret roles</p>
        <h2 className="title-lg mt-3">Check your card privately</h2>
      </div>

      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        className={`rounded-[32px] border p-5 sm:p-6 ${myRole === 'spy' ? 'border-danger/45 bg-danger/10' : 'border-aqua/30 bg-aqua/10'}`}
      >
        <p className="eyebrow">Round {room.roundNumber}</p>
        <h3 className="mt-3 font-display text-3xl text-[#f3e1c1] sm:text-4xl">
          {myRole === 'spy' ? 'You are the Spy' : round.location}
        </h3>
        <p className="mt-4 text-sm leading-6 text-[#f3e1c1]/70">
          {myRole === 'spy'
            ? 'Use the conversation to reverse-engineer the location before the room catches on.'
            : 'Everyone else shares this location. Ask subtle questions and watch for weak answers.'}
        </p>
      </motion.div>

      <div className={`grid gap-3 ${isHost ? 'sm:grid-cols-2' : ''}`}>
        <button
          type="button"
          className={`inline-flex w-full items-center justify-center gap-2 rounded-[24px] border px-5 py-4 font-semibold tracking-[0.04em] transition duration-150 hover:brightness-110 active:translate-y-[1px] ${
            isReady
              ? 'border-emerald-900/70 bg-emerald-950/80 text-emerald-100'
              : 'border-white/15 bg-white/10 text-[#f3e1c1]'
          }`}
          onClick={onReady}
        >
          {isReady ? 'Ready locked in' : 'I have seen my role'}
        </button>
        {isHost ? (
          <button type="button" className="secondary-button" disabled={!allPlayersReady} onClick={onBeginDiscussion}>
            {allPlayersReady ? 'Start discussion' : 'Waiting on players'}
          </button>
        ) : null}
      </div>
    </div>
  )
}

function DiscussionScreen({ room, currentTurnPlayer, secondsLeft, isHost, onAdvanceTurn, onOpenVoting }) {
  const progress = room.round ? Math.max(0, Math.min(100, (secondsLeft / room.settings.roundDuration) * 100)) : 0

  return (
    <div className="flex min-h-[calc(100vh-8rem)] flex-col justify-center space-y-6 p-5 sm:p-7">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="eyebrow">Discussion live</p>
          <h2 className="title-lg mt-3">Read the room, spot the lie, and catch the Spy.</h2>
          <p className="mt-3 text-sm leading-6 text-[#f3e1c1]/65">
            The app tracks only time and turn order. The questions happen out loud.
          </p>
        </div>
        <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-right">
          <p className="text-xs uppercase tracking-[0.32em] text-[#f3e1c1]/45">Time left</p>
          <p className="mt-2 font-display text-3xl text-[#f3e1c1]">{formatTime(secondsLeft)}</p>
        </div>
      </div>

      <div className="h-3 overflow-hidden rounded-full bg-white/10">
        <motion.div
          className="h-full rounded-full bg-gradient-to-r from-sunset via-warning to-aqua"
          animate={{ width: `${progress}%` }}
          transition={{ duration: 0.35 }}
        />
      </div>

      <div className="rounded-[30px] border border-white/10 bg-white/5 p-5">
        <p className="eyebrow">Current turn</p>
        <h3 className="mt-3 font-display text-3xl text-[#f3e1c1]">{currentTurnPlayer?.name}</h3>
        <p className="mt-2 text-sm text-[#f3e1c1]/60">Ask or answer, then pass the turn forward.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <button type="button" className="secondary-button" disabled={!isHost} onClick={onAdvanceTurn}>
          Next turn
        </button>
        <button type="button" className="primary-button" disabled={!isHost} onClick={onOpenVoting}>
          Open voting
        </button>
      </div>
    </div>
  )
}

function VotingScreen({
  room,
  me,
  isSpy,
  onVote,
  onSpyGuess,
  everyoneCompletedVoting,
}) {
  const myVote = room.round?.votes?.[me.id] ?? ''
  const mySpyGuess = room.round?.spyGuesses?.[me.id] ?? ''
  const [pendingLocation, setPendingLocation] = useState('')
  const [pendingAccusedId, setPendingAccusedId] = useState('')
  const nonSpyPlayers = room.players.filter((player) => !room.round.spies.includes(player.id))
  const nonSpyVotesCount = nonSpyPlayers.filter((player) => Boolean(room.round?.votes?.[player.id])).length
  const spyGuessesCount = room.round.spies.filter((spyId) => Boolean(room.round?.spyGuesses?.[spyId])).length
  const selectedLocation = isSpy ? mySpyGuess || pendingLocation : ''
  const selectedAccusedId = !isSpy ? myVote || pendingAccusedId : ''
  const totalProgressDone = nonSpyVotesCount + spyGuessesCount
  const totalProgressTarget = room.players.length
  const hasLockedChoice = Boolean(isSpy ? mySpyGuess : myVote)
  const hasPendingChoice = Boolean(isSpy ? pendingLocation : pendingAccusedId)

  function handleConfirmChoice() {
    if (hasLockedChoice) {
      return
    }

    if (isSpy) {
      if (!pendingLocation) {
        return
      }

      onSpyGuess(pendingLocation)
      return
    }

    if (!pendingAccusedId) {
      return
    }

    onVote(pendingAccusedId)
  }

  return (
    <div className="space-y-6 p-5 sm:p-7">
      <div>
        <p className="eyebrow">Voting phase</p>
        <h2 className="title-lg mt-3">Review the board and lock your choices.</h2>
        <p className="mt-3 text-sm leading-6 text-[#f3e1c1]/65">
          Everyone scrolls through the same list order. Tap your selections before time runs out.
        </p>
      </div>

      <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm text-[#f3e1c1]/75">
        <p className="text-xs uppercase tracking-[0.22em] text-[#f3e1c1]/50">Progress</p>
        <p className="mt-2">Choices locked {totalProgressDone}/{totalProgressTarget}</p>
      </div>

      <div className="h-[22rem] space-y-4 overflow-y-auto pr-1 overscroll-contain">
        <div className="rounded-[24px] border border-white/10 bg-white/5 p-3">
          <p className="eyebrow">Location shortlist</p>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {LOCATIONS.map((location) => (
              <button
                key={location}
                type="button"
                className={selectedLocation === location ? 'pill-active' : 'pill'}
                disabled={!isSpy || hasLockedChoice}
                onClick={() => setPendingLocation(location)}
              >
                {location}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-[24px] border border-white/10 bg-white/5 p-3">
          <p className="eyebrow">Player list</p>
          <div className="mt-3 grid gap-3">
            {room.players.map((player) => (
              <button
                key={player.id}
                type="button"
                disabled={isSpy || player.id === me.id || hasLockedChoice}
                className={selectedAccusedId === player.id ? 'vote-card-active' : 'vote-card'}
                onClick={() => setPendingAccusedId(player.id)}
              >
                <span>{player.name}</span>
                <span className="text-xs text-[#f3e1c1]/45">
                  {isSpy ? 'Voting disabled for spies' : player.id === me.id ? 'You cannot self-vote' : 'Tap to accuse'}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <button
        type="button"
        className="primary-button w-full"
        disabled={hasLockedChoice ? true : !hasPendingChoice}
        onClick={handleConfirmChoice}
      >
        {hasLockedChoice
          ? everyoneCompletedVoting
            ? 'Everyone is ready'
            : 'Waiting for others to confirm'
          : 'Confirm choice'}
      </button>
    </div>
  )
}

function ScoreboardScreen({ room, isHost, onNextRound }) {
  const resultWinner = room.round.result.winner
  const accusedPlayer = room.players.find((player) => player.id === room.round.accusedId) ?? null
  const accusedName = accusedPlayer?.name ?? 'No one'
  const accusedIsSpy = Boolean(accusedPlayer && room.round.spies.includes(accusedPlayer.id))
  const voteBreakdown = room.round.voteBreakdown ?? []
  const highestVoteTotal = voteBreakdown.reduce((maxTotal, entry) => Math.max(maxTotal, entry.total), 0)
  const topVotedEntries = highestVoteTotal > 0
    ? voteBreakdown.filter((entry) => entry.total === highestVoteTotal)
    : []
  const topVotedPlayers = topVotedEntries
    .map(({ playerId }) => room.players.find((player) => player.id === playerId))
    .filter(Boolean)
  const topVotedDisplayLines = topVotedPlayers.length > 0
    ? topVotedPlayers
      .map((player) => `${player.name} (${room.round.spies.includes(player.id) ? 'Spy' : 'Local'})`)
    : ['No one']
  const voteOutcomeText =
    highestVoteTotal === 0
      ? 'No votes were cast this round.'
      : topVotedPlayers.length > 1
        ? `Tie at ${highestVoteTotal} votes each`
        : `${highestVoteTotal} vote${highestVoteTotal > 1 ? 's' : ''}`
  const spyNames = room.players
    .filter((player) => room.round.spies.includes(player.id))
    .map((player) => player.name)
    .join(', ')

  return (
    <div className="space-y-6 p-5 sm:p-7">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className={`rounded-[32px] border p-5 sm:p-6 ${
          accusedIsSpy
            ? 'border-[#6f3a46]/45 bg-[#171217]/80'
            : 'border-[#3a5c68]/40 bg-[#0f171d]/80'
        }`}
      >
        <p className="eyebrow">Mission result</p>
          
          {/* Upper half: 60/40 split */}
          <div className="mt-4 grid grid-cols-5 gap-4">
            {/* Left side: 60% - Outcome text */}
            <div className="col-span-3">
              <h2 className="font-display text-5xl sm:text-6xl font-black leading-tight text-[#f3e1c1]">
                {resultWinner === 'agents' ? (
                  <>
                    THE ROOM CAUGHT THE <span className="text-[#ad3a32]">SPIES</span>.
                  </>
                ) : (
                  <>
                    THE <span className="text-[#a34253]">SPIES</span> STOLE THE MISSION.
                  </>
                )}
              </h2>
            </div>

            {/* Right side: 40% - Mask icon */}
            <div className="col-span-2 flex items-center justify-center">
              <img
                src="/spy-mask.png"
                alt="Spy mask"
                className="w-full max-w-[140px] sm:max-w-[200px] object-contain"
                onError={(e) => {
                  e.target.style.display = 'none'
                }}
              />
            </div>
          </div>

          {/* Lower half: Winner */}
          <div className="mt-7 flex items-center gap-5">
            <Trophy className="size-10 sm:size-14 shrink-0 text-[#d2a766]" />
            <div className="flex flex-col justify-center">
              <p className="text-xs uppercase tracking-[0.22em] text-[#f3e1c1]/55">Winner</p>
              <p className="mt-0 font-display text-2xl sm:text-3xl leading-none text-[#f3e1c1]">
                {resultWinner === 'agents' ? 'Locals' : 'Spies'}
              </p>
            </div>
          </div>

          {room.round.result.reason && (
            <p className="mt-5 text-sm text-[#f3e1c1]/80 leading-relaxed">
              {room.round.result.reason}
            </p>
          )}

          <div className="mt-4 space-y-4">
            <div className="flex items-center gap-5">
              <MapPin className="size-10 sm:size-14 shrink-0 text-[#ba9459]" />
              <div className="flex flex-col justify-center">
                <p className="text-xs uppercase tracking-[0.22em] text-[#f3e1c1]/55">Location</p>
                <p className="mt-0 font-display text-2xl sm:text-3xl leading-none text-[#f3e1c1]">
                  {room.round.location}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-5">
              <Users className="size-10 sm:size-14 shrink-0 text-[#ad3a32]" />
              <div className="flex flex-col justify-center">
                <p className="text-xs uppercase tracking-[0.22em] text-[#f3e1c1]/55">Spy team</p>
                <p className="mt-0 font-display text-2xl sm:text-3xl leading-none text-[#f3e1c1]">
                  {spyNames}
                </p>
              </div>
            </div>

            {accusedPlayer && (
              <div className="flex items-center gap-5">
                <User className="size-10 sm:size-14 shrink-0 text-[#74a9b8]" />
                <div className="flex flex-col justify-center">
                  <p className="text-xs uppercase tracking-[0.22em] text-[#f3e1c1]/55">Accused player</p>
                  <p className="mt-0 font-display text-2xl sm:text-3xl leading-none text-[#f3e1c1]">
                    {accusedName}
                  </p>
                </div>
              </div>
            )}
          </div>
        </motion.div>

      <motion.section
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.08 }}
        className="rounded-[28px] border border-white/10 bg-[#0d1319]/80 p-5 sm:p-6"
      >
        <p className="eyebrow">Vote reveal</p>
        <div className="mt-4 flex items-center gap-4">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-full border border-warning/35 bg-warning/10 sm:size-14">
            <Crown className="size-5 text-warning sm:size-6" />
          </div>
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-[0.22em] text-[#f3e1c1]/55">Most voted player</p>
            <div className="mt-1 space-y-1">
              {topVotedDisplayLines.map((entry) => (
                <p key={entry} className="font-display text-3xl leading-none text-[#f3e1c1] sm:text-4xl">
                  {entry}
                </p>
              ))}
            </div>
            <p className="mt-2 text-sm text-[#f3e1c1]/70">{voteOutcomeText}</p>
          </div>
        </div>
      </motion.section>

      <button type="button" className="primary-button w-full" disabled={!isHost} onClick={onNextRound}>
        {isHost ? 'Start another round' : 'Waiting for host to start next round'}
      </button>
    </div>
  )
}

function LoadingCard() {
  return (
    <div className="panel mx-auto flex w-full max-w-3xl min-h-[360px] items-center justify-center px-6">
      <div className="text-center">
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ repeat: Infinity, duration: 1.2, ease: 'linear' }}
          className="mx-auto mb-4 size-12 rounded-full border-2 border-white/15 border-t-white/80"
        />
        <p className="text-sm text-[#f3e1c1]/65">Restoring your room...</p>
      </div>
    </div>
  )
}

function PlayerCard({ player, active = false, isHost }) {
  return (
    <div className={`rounded-[24px] border px-4 py-3 transition ${active ? 'border-sunset/50 bg-sunset/10' : 'border-white/10 bg-black/15'}`}>
      <div className="flex items-center gap-3">
        <div className="flex size-11 items-center justify-center rounded-[18px] text-sm font-semibold text-slate-950" style={{ backgroundColor: player.color }}>
          {player.name.slice(0, 2).toUpperCase()}
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <p className="font-medium text-[#f3e1c1]">{player.name}</p>
            {isHost ? <Crown className="size-4 text-warning" /> : null}
            {active ? <Tag>Turn</Tag> : null}
          </div>
          <p className="text-sm text-[#f3e1c1]/45">Score {player.score}</p>
        </div>
      </div>
    </div>
  )
}

function Tag({ children }) {
  return <span className="inline-flex items-center rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs uppercase tracking-[0.26em] text-[#f3e1c1]/55">{children}</span>
}

function useCountdown(endsAt) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!endsAt) {
      return undefined
    }

    const intervalId = window.setInterval(() => {
      setNow(Date.now())
    }, 1000)

    return () => window.clearInterval(intervalId)
  }, [endsAt])

  return getRemainingSeconds(endsAt, now)
}

function getRemainingSeconds(endsAt, referenceTime = Date.now()) {
  if (!endsAt) {
    return 0
  }

  return Math.max(0, Math.ceil((endsAt - referenceTime) / 1000))
}

function formatTime(totalSeconds) {
  const safeSeconds = Math.max(0, totalSeconds)
  const minutes = Math.floor(safeSeconds / 60)
  const seconds = safeSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function playCue(type) {
  if (typeof window === 'undefined') {
    return
  }

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext

  if (!AudioContextCtor) {
    return
  }

  const context = new AudioContextCtor()
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  const cues = {
    join: { frequency: 420, duration: 0.08 },
    start: { frequency: 520, duration: 0.12 },
    vote: { frequency: 320, duration: 0.1 },
    reveal: { frequency: 620, duration: 0.15 },
    result: { frequency: 260, duration: 0.2 },
  }
  const cue = cues[type] ?? cues.join

  oscillator.frequency.value = cue.frequency
  oscillator.type = 'triangle'
  gain.gain.value = 0.025
  oscillator.connect(gain)
  gain.connect(context.destination)
  oscillator.start()
  oscillator.stop(context.currentTime + cue.duration)
  oscillator.addEventListener('ended', () => context.close())

  if (navigator.vibrate) {
    navigator.vibrate(20)
  }
}

async function loadRoomStateWithRetry(code, attempts = 4, delayMs = 550) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const roomState = await loadRoomState(code)

    if (roomState) {
      return roomState
    }

    if (attempt < attempts - 1) {
      await wait(delayMs)
    }
  }

  return null
}

function wait(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

function getFriendlyError(error) {
  const message = error?.message ?? 'Realtime sync failed.'

  if (message.includes('party_rooms')) {
    return 'Create the party_rooms table from supabase/schema.sql to enable cross-phone realtime rooms.'
  }

  if (message.toLowerCase().includes('fetch')) {
    return 'The room store could not reach Supabase. Check your URL, anon key, and network.'
  }

  return message
}

function getShareableRoomLink(roomCode) {
  if (typeof window === 'undefined') {
    return roomCode
  }

  const url = new URL(window.location.href)
  url.searchParams.set('room', roomCode)
  return url.toString()
}

function getMenuPlayerName(value = '') {
  const fromArg = value.trim()

  if (fromArg) {
    return fromArg
  }

  const fromStorage = (localStorage.getItem('spyfall-player-name') ?? '').trim()

  if (fromStorage) {
    return fromStorage
  }

  return ''
}

export default App
