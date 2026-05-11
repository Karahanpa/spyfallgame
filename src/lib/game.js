const PLAYER_COLORS = ['#ffb86c', '#7ae2ff', '#ffd76b', '#ff8ca8', '#7bf1a8', '#c7a5ff', '#ff7e62', '#8be9fd']
const VOTING_DURATION_SECONDS = 20

function randomId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }

  return `id-${Math.random().toString(36).slice(2, 11)}`
}

export function createPlayer(name) {
  const safeName = name.trim().slice(0, 18)
  const id = randomId()
  const color = PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)]

  return {
    id,
    name: safeName || 'Player',
    color,
    score: 0,
    connected: true,
    lastSeenAt: Date.now(),
  }
}

export function createInitialRoom(hostPlayer) {
  return {
    code: createRoomCode(),
    hostId: hostPlayer.id,
    phase: 'lobby',
    roundNumber: 0,
    currentTurnIndex: 0,
    settings: {
      roundDuration: 480,
    },
    players: [hostPlayer],
    round: null,
    updatedAt: Date.now(),
  }
}

export function createRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('')
}

export function getSpyCount(playerCount) {
  if (playerCount >= 9) {
    return 2
  }

  return 1
}

export function startRound(room, locations) {
  const location = pickRandom(locations)
  const shuffledPlayers = shuffle(room.players)
  const spies = shuffledPlayers.slice(0, getSpyCount(room.players.length)).map((player) => player.id)
  const assignments = Object.fromEntries(
    room.players.map((player) => [player.id, spies.includes(player.id) ? 'spy' : 'agent']),
  )

  return {
    ...room,
    phase: 'role',
    roundNumber: room.roundNumber + 1,
    currentTurnIndex: Math.floor(Math.random() * room.players.length),
    round: {
      id: randomId(),
      location,
      spies,
      assignments,
      readyIds: [],
      votes: {},
      spyGuesses: {},
      voteBreakdown: [],
      accusedId: null,
      result: null,
      startedAt: null,
      endsAt: null,
      votingStartedAt: null,
      votingEndsAt: null,
    },
    updatedAt: Date.now(),
  }
}

export function markRoleReady(room, playerId) {
  if (!room.round || room.round.readyIds.includes(playerId)) {
    return room
  }

  return {
    ...room,
    round: {
      ...room.round,
      readyIds: [...room.round.readyIds, playerId],
    },
    updatedAt: Date.now(),
  }
}

export function startDiscussion(room) {
  if (!room.round) {
    return room
  }

  const startedAt = Date.now()

  return {
    ...room,
    phase: 'discussion',
    round: {
      ...room.round,
      startedAt,
      endsAt: startedAt + room.settings.roundDuration * 1000,
    },
    updatedAt: Date.now(),
  }
}

export function advanceTurn(room) {
  return {
    ...room,
    currentTurnIndex: (room.currentTurnIndex + 1) % room.players.length,
    updatedAt: Date.now(),
  }
}

export function beginVoting(room) {
  const votingStartedAt = Date.now()

  return {
    ...room,
    phase: 'voting',
    round: {
      ...room.round,
      votingStartedAt,
      votingEndsAt: votingStartedAt + VOTING_DURATION_SECONDS * 1000,
    },
    updatedAt: Date.now(),
  }
}

export function castVote(room, voterId, targetId) {
  if (!room.round) {
    return room
  }

  if (room.round.spies.includes(voterId)) {
    return room
  }

  return {
    ...room,
    round: {
      ...room.round,
      votes: {
        ...room.round.votes,
        [voterId]: targetId,
      },
    },
    updatedAt: Date.now(),
  }
}

export function submitSpyGuess(room, spyId, locationGuess) {
  if (!room.round || room.phase !== 'voting') {
    return room
  }

  if (!room.round.spies.includes(spyId)) {
    return room
  }

  return {
    ...room,
    round: {
      ...room.round,
      spyGuesses: {
        ...room.round.spyGuesses,
        [spyId]: locationGuess,
      },
    },
    updatedAt: Date.now(),
  }
}

export function finalizeVoting(room) {
  if (!room.round) {
    return room
  }

  const spyGuessEntries = Object.entries(room.round.spyGuesses ?? {})
  const correctGuessEntry = spyGuessEntries.find(([, guess]) => guess === room.round.location)
  const anySpyCorrect = Boolean(correctGuessEntry)

  const tally = countVotes(room.round.votes)
  const sortedVotes = Object.entries(tally).sort((left, right) => right[1] - left[1])
  const topVoteCount = sortedVotes[0]?.[1] ?? 0
  const leaders = sortedVotes.filter(([, total]) => total === topVoteCount)
  const voteBreakdown = sortedVotes.map(([playerId, total]) => ({
    playerId,
    total,
  }))

  if (leaders.length !== 1) {
    if (anySpyCorrect) {
      const [winningSpyId, winningGuess] = correctGuessEntry
      const winningSpyName = room.players.find((player) => player.id === winningSpyId)?.name ?? 'A spy'

      return closeRound(room, {
        winner: 'spies',
        title: 'The spies stole the ending.',
        reason: `${winningSpyName} guessed ${winningGuess} correctly despite the split vote.`,
        voteBreakdown,
        accusedId: null,
        spyGuesses: room.round.spyGuesses,
      })
    }

    return closeRound(room, {
      winner: 'spies',
      title: 'The room split the vote.',
      reason: 'No clear suspect emerged before time ran out.',
      voteBreakdown,
      accusedId: null,
      spyGuesses: room.round.spyGuesses,
    })
  }

  const accusedId = leaders[0][0]
  const accusedName = room.players.find((player) => player.id === accusedId)?.name ?? 'That player'

  if (!room.round.spies.includes(accusedId)) {
    return closeRound(room, {
      winner: 'spies',
      title: 'The spies slipped through.',
      reason: `${accusedName} was not part of the spy team.`,
      voteBreakdown,
      accusedId,
      spyGuesses: room.round.spyGuesses,
    })
  }

  if (anySpyCorrect) {
    const [winningSpyId, winningGuess] = correctGuessEntry
    const winningSpyName = room.players.find((player) => player.id === winningSpyId)?.name ?? 'A spy'

    return closeRound(room, {
      winner: 'spies',
      title: 'The spies stole the ending.',
      reason: `${winningSpyName} guessed ${winningGuess} correctly after ${accusedName} was exposed.`,
      voteBreakdown,
      accusedId,
      spyGuesses: room.round.spyGuesses,
    })
  }

  return closeRound(room, {
    winner: 'agents',
    title: 'The room caught the spies.',
    reason: `${accusedName} was exposed, and no spy guessed ${room.round.location}.`,
    voteBreakdown,
    accusedId,
    spyGuesses: room.round.spyGuesses,
  })
}

function closeRound(room, result) {
  const spySet = new Set(room.round.spies)

  return {
    ...room,
    phase: 'scoreboard',
    players: room.players.map((player) => ({
      ...player,
      score:
        player.score +
        (result.winner === 'spies'
          ? spySet.has(player.id)
            ? 2
            : 0
          : spySet.has(player.id)
            ? 0
            : 1),
    })),
    round: {
      ...room.round,
      ...('spyGuesses' in result ? { spyGuesses: result.spyGuesses } : {}),
      voteBreakdown: result.voteBreakdown,
      accusedId: result.accusedId,
      result: {
        winner: result.winner,
        title: result.title,
        reason: result.reason,
      },
    },
    updatedAt: Date.now(),
  }
}

function countVotes(votes) {
  return Object.values(votes).reduce((totals, targetId) => {
    return {
      ...totals,
      [targetId]: (totals[targetId] ?? 0) + 1,
    }
  }, {})
}

function pickRandom(values) {
  return values[Math.floor(Math.random() * values.length)]
}

function shuffle(values) {
  const copy = [...values]

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    ;[copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]]
  }

  return copy
}