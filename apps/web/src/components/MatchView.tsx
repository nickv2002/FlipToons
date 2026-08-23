import { cardsById } from '../../../../packages/engine/setup'
import { deckPlacementTargets, matchRoundFame } from '../../../../packages/engine/match'
import { viewOf } from '../../../../packages/engine/state'
import type { Match } from '../../../../packages/engine/state'
import type { MatchAction } from '../../../../packages/engine/matchActions'
import type { Action } from '../../../../packages/engine/actions'
import type { LobbyState } from '../../../server/protocol'
import { Grid } from './Grid'
import { RoundView } from './RoundView'

const cards = cardsById()

export type MatchViewProps = {
  match: Match
  lobby: LobbyState
  myPlayerId: string
  onAct: (action: MatchAction) => void
  onLeave: () => void
}

// Translates the solo RoundView's Action vocabulary into MatchActions.
//
// This adapter is only possible because of the state split: a PlayerView is
// structurally identical to the old flat GameState, so RoundView renders one
// seat's slice of a Match without knowing a Match exists. The actions it emits
// are per-player too — only the phase-advancing ones differ, because those are
// the ones that mean something different when other people are at the table.
function toMatchAction(action: Action): MatchAction | null {
  switch (action.kind) {
    case 'hire':
      return { kind: 'hire', slotIndex: action.slotIndex, choices: action.choices }
    case 'dismiss':
      return { kind: 'dismiss', pos: action.pos, index: action.index, choices: action.choices }
    case 'resolvePostMarketChoice':
      return { kind: 'resolvePostMarketChoice', pos: action.pos, index: action.index }
    case 'endMarket':
      // Solo's "end the Market phase" is multiplayer's "end MY turn" — the
      // phase itself only closes when the turn order wraps.
      return { kind: 'endTurn' }
    default:
      // flip / checkFame / continueToMarket / advanceCleanup are solo's
      // zero-click cascade. Multiplayer advances those from the shared
      // control below, never from one player's board.
      return null
  }
}

export function MatchView({ match, lobby, myPlayerId, onAct, onLeave }: MatchViewProps) {
  const myIndex = match.players.findIndex((p) => p.playerId === myPlayerId)
  const me = match.players[myIndex]
  const nameOf = (playerId: string) => lobby.seats.find((s) => s.playerId === playerId)?.name ?? playerId
  const activeId = match.turnOrder[match.activePlayerIndex]
  const isMyTurn = match.shared.phase === 'market' && activeId === myPlayerId
  const phase = match.shared.phase

  if (!me) {
    return <p className="match__error">You are not seated in this match.</p>
  }

  const fames = matchRoundFame(match)

  return (
    <div className="match" data-testid="match">
      <header className="match__header">
        <span className="match__round" data-testid="round">Round {match.shared.round}</span>
        <span className="match__phase" data-testid="phase">{phase}</span>
        <TurnBanner phase={phase} isMyTurn={isMyTurn} activeName={nameOf(activeId)} />
      </header>

      <Scoreboard match={match} nameOf={nameOf} myPlayerId={myPlayerId} fames={fames} />

      {phase === 'flip' && (
        <div className="match__advance">
          <p>Everyone flips together.</p>
          <button type="button" data-testid="advance-flip" onClick={() => onAct({ kind: 'advanceFlip' })}>
            Flip
          </button>
        </div>
      )}

      {phase === 'finalFlip' && (
        <div className="match__advance match__advance--final" data-testid="final-flip-banner">
          <p>
            <strong>Final Flip.</strong> One last reveal — most fame wins.
          </p>
          <button type="button" data-testid="advance-flip" onClick={() => onAct({ kind: 'advanceFlip' })}>
            Final Flip
          </button>
        </div>
      )}

      {/* The mandatory Skunk dismissal. It blocks the Market phase for the
          whole table, so it gets its own prompt rather than hiding inside the
          board. */}
      {me.pendingPostFameChoice && (
        <div className="match__prompt" data-testid="post-fame-prompt">
          <p>
            <strong>{cards[me.pendingPostFameChoice.ownerCardId].name}</strong>: you generated the least fame — dismiss a card.
          </p>
          <div className="match__prompt-options">
            {me.pendingPostFameChoice.options.map((o, i) => (
              <button key={i} type="button" data-testid={`post-fame-option-${i}`} onClick={() => onAct({ kind: 'resolvePostFameChoice', pos: o.pos, index: o.index })}>
                {cards[o.cardId].name}
              </button>
            ))}
          </div>
        </div>
      )}

      {phase === 'postFameHooks' && !me.pendingPostFameChoice && (
        <p className="match__waiting" data-testid="waiting-others">Waiting for the other players to resolve their abilities…</p>
      )}

      {/* Pig: "place this card in any deck." The one prompt that offers
          another player's deck as a target. */}
      {me.pendingDeckPlacement && (
        <div className="match__prompt" data-testid="deck-placement-prompt">
          <p>
            <strong>{cards[me.pendingDeckPlacement.cardId].name}</strong>: put it into any deck.
          </p>
          <div className="match__prompt-options">
            {deckPlacementTargets(match).map((target) => {
              const key = target.kind === 'toonDeck' ? 'toonDeck' : target.playerId
              return (
                <button
                  key={key}
                  type="button"
                  data-testid={`deck-target-${key}`}
                  onClick={() => onAct({ kind: 'resolveDeckPlacement', target })}
                >
                  {target.kind === 'toonDeck'
                    ? 'Toon deck (reshuffled)'
                    : target.playerId === myPlayerId
                      ? 'Your deck'
                      : `${nameOf(target.playerId)}'s deck`}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {phase === 'ended' && <EndScreen match={match} nameOf={nameOf} myPlayerId={myPlayerId} fames={fames} />}

      {/* Your own board. Rendered through the same RoundView solo uses — a
          PlayerView is structurally the old GameState, so it needs no
          multiplayer awareness at all. */}
      {phase === 'market' && (
        <section className="match__mine" data-testid="my-board">
          <h3 className="match__mine-title">
            Your board{isMyTurn ? (me.pendingDeckPlacement ? ' (choose a deck first)' : '') : ' (not your turn)'}
          </h3>
          {/* A pending deck placement freezes the rest of the turn: the engine
              refuses hire/dismiss/endTurn until it is answered, so leaving
              those live would only hand the player a guaranteed error. */}
          <RoundView
            state={viewOf(match, myIndex)}
            dispatch={(action) => {
              const translated = toMatchAction(action)
              if (translated) onAct(translated)
            }}
            onAbandon={onLeave}
            // Solo's guaranteed-loss warning is meaningless at a table:
            // a lost round for you is not a lost game for anyone.
            soloWarnings={false}
            leaveLabel="Leave game"
            endMarketLabel="End turn"
            // RoundView applies this to the board only. It used to be a
            // fieldset wrapped around the whole component here, which also
            // disabled the Leave button and the deck/dismissed overlays —
            // leaving a table whose active player had dropped with no way out
            // but closing the tab.
            controlsDisabled={!isMyTurn || me.pendingDeckPlacement !== null}
          />
        </section>
      )}

      <OpponentBoards match={match} myPlayerId={myPlayerId} nameOf={nameOf} activeId={activeId} phase={phase} />
    </div>
  )
}

function TurnBanner({ phase, isMyTurn, activeName }: { phase: string; isMyTurn: boolean; activeName: string }) {
  if (phase !== 'market') return null
  return isMyTurn ? (
    <strong className="match__turn match__turn--mine" data-testid="turn-indicator">
      Your turn
    </strong>
  ) : (
    <span className="match__turn" data-testid="turn-indicator">
      Waiting on {activeName}
    </span>
  )
}

// Per-round fame only. There is deliberately NO cumulative total: fame is one
// number that is simultaneously your score, your spending power and expiring
// (§4.2), and the game keeps no running tally. Inventing one here would show
// players a statistic the rules do not have.
function Scoreboard({
  match,
  nameOf,
  myPlayerId,
  fames,
}: {
  match: Match
  nameOf: (id: string) => string
  myPlayerId: string
  fames: ReturnType<typeof matchRoundFame>
}) {
  return (
    <table className="scoreboard" data-testid="scoreboard">
      <thead>
        <tr>
          <th>Player</th>
          <th>Fame this round</th>
          <th>To spend</th>
        </tr>
      </thead>
      <tbody>
        {match.players.map((p) => {
          const rf = fames.find((f) => f.playerId === p.playerId)!
          return (
            <tr key={p.playerId} data-testid={`score-${p.playerId}`} className={p.playerId === myPlayerId ? 'scoreboard__row--me' : undefined}>
              <td>
                {nameOf(p.playerId)}
                {p.playerId === myPlayerId && <span className="scoreboard__you"> (you)</span>}
                {match.shared.criticsChoiceHolder === p.playerId && (
                  <span className="scoreboard__badge" data-testid={`critics-${p.playerId}`} title="Critic's Choice: +3 during the Final Flip">
                    ★ Critic's Choice
                  </span>
                )}
              </td>
              <td data-testid={`fame-${p.playerId}`}>
                {p.fameGeneratedThisRound}
                {rf.fame.modifiers.map((m) => (
                  <span key={m.source} className="scoreboard__modifier"> +{m.amount}</span>
                ))}
              </td>
              <td>{p.fame}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// Every opponent's board, read-only. All of it is public information (§3.3a:
// "a player may examine any player's dismissed cards at any time"), so there
// is nothing to hide — only to label clearly enough that nobody mistakes
// someone else's grid for their own.
function OpponentBoards({
  match,
  myPlayerId,
  nameOf,
  activeId,
  phase,
}: {
  match: Match
  myPlayerId: string
  nameOf: (id: string) => string
  activeId: string
  phase: string
}) {
  const others = match.players.filter((p) => p.playerId !== myPlayerId)
  if (others.length === 0) return null
  return (
    <section className="opponents" data-testid="opponent-boards">
      <h3>Other players</h3>
      <div className="opponents__list">
        {others.map((p) => (
          <div key={p.playerId} className="opponents__board" data-testid={`opponent-${p.playerId}`}>
            <h4>
              {nameOf(p.playerId)}
              {phase === 'market' && p.playerId === activeId && <span className="opponents__turn"> — their turn</span>}
            </h4>
            <Grid grid={p.grid} cards={cards} fame={p.fame} />
            <p className="opponents__counts">
              deck {p.deck.length} · dismissed {p.dismissed.length} · fame this round {p.fameGeneratedThisRound}
            </p>
          </div>
        ))}
      </div>
    </section>
  )
}

function EndScreen({
  match,
  nameOf,
  myPlayerId,
  fames,
}: {
  match: Match
  nameOf: (id: string) => string
  myPlayerId: string
  fames: ReturnType<typeof matchRoundFame>
}) {
  const top = Math.max(...fames.map((f) => f.fame.total))
  const winners = fames.filter((f) => f.fame.total === top).map((f) => f.playerId)
  const iWon = winners.includes(myPlayerId)
  return (
    <div className="match__end" data-testid="game-over">
      <h2 data-testid="result">
        {winners.length === 1 ? (iWon ? 'You win!' : `${nameOf(winners[0])} wins!`) : `A shared win: ${winners.map(nameOf).join(' and ')}`}
      </h2>
      <ul className="match__final-scores">
        {fames.map((f) => (
          <li key={f.playerId} data-testid={`final-${f.playerId}`}>
            {nameOf(f.playerId)}: <strong>{f.fame.total}</strong> fame
            {f.fame.modifiers.map((m) => (
              <span key={m.source}> ({m.label} +{m.amount})</span>
            ))}
          </li>
        ))}
      </ul>
    </div>
  )
}
