import { cardsById } from '../../../../packages/engine/setup'
import { deckPlacementTargets, matchRoundFame } from '../../../../packages/engine/match'
import { viewOf } from '../../../../packages/engine/state'
import type { Match } from '../../../../packages/engine/state'
import type { MatchAction } from '../../../../packages/engine/matchActions'
import type { Action } from '../../../../packages/engine/actions'
import type { LobbyState } from '../../../server/protocol'
import { BoardPane } from './BoardPane'
import { EffectChoicePrompt } from './EffectChoicePrompt'
import { RoundView } from './RoundView'
import { occupiedSlots } from '../../../../packages/engine/grid'
import type { Grid as GridData, GridPos } from '../../../../packages/engine/types'
import type { Phase } from '../../../../packages/engine/state'

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
      // zero-click cascade. Multiplayer has no client control for them at
      // all: the Flip takes no input from anybody, so the SERVER advances it
      // (rooms.ts's advanceSharedPhases) rather than asking one player to
      // press a button on everyone else's behalf.
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
        {phaseLabel(phase) && (
          <span className="match__phase" data-testid="phase">{phaseLabel(phase)}</span>
        )}
        <TurnBanner phase={phase} isMyTurn={isMyTurn} activeName={nameOf(activeId)} />
      </header>

      <Scoreboard match={match} nameOf={nameOf} myPlayerId={myPlayerId} fames={fames} />

      <EndgameNotice match={match} />

      {/* The mandatory Skunk dismissal. It blocks the Market phase for the
          whole table, so it gets its own prompt rather than hiding inside the
          board. */}
      {me.pendingPostFameChoice && (
        <div className="match__prompt" data-testid="post-fame-prompt">
          {/* The same component every other dismiss uses. Skunk's rule —
              mandatory, free, any face-up card on your own board — is exactly
              dismissChosenGridCard's with a cost of 0, so it needs no kind of
              its own; only the REASON is Skunk-specific, and that rides in on
              promptText. */}
          <EffectChoicePrompt
            cardName={cards[me.pendingPostFameChoice.ownerCardId].name}
            promptText={`${cards[me.pendingPostFameChoice.ownerCardId].name}: you generated the least fame — dismiss a card.`}
            choice={{ kind: 'dismissChosenGridCard', mandatory: true, cost: 0, options: me.pendingPostFameChoice.options }}
            cards={cards}
            fame={me.fame}
            market={match.shared.market.slots}
            onResolve={(selection) => {
              // dismissChosenGridCard is mandatory and single-select, so the
              // component can only ever hand back a DismissTarget here.
              if (typeof selection !== 'object' || Array.isArray(selection)) return
              const target = selection as { pos: GridPos; index: number }
              onAct({ kind: 'resolvePostFameChoice', pos: target.pos, index: target.index })
            }}
          />
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
          multiplayer awareness at all.

          It renders in EVERY phase. It used to be Market-only while opponent
          boards rendered always, so the flip revealed cards on their grids
          while yours simply wasn't on the page. Outside Market there is
          nothing to click, so it falls back to the same read-only BoardPane
          the opponents get. */}
      <section className="match__mine" data-testid="my-board">
        <h3 className="match__mine-title">
          Your board{phase !== 'market' ? '' : isMyTurn ? (me.pendingDeckPlacement ? ' (choose a deck first)' : '') : ' (not your turn)'}
        </h3>
        {/* A pending deck placement freezes the rest of the turn: the engine
            refuses hire/dismiss/endTurn until it is answered, so leaving
            those live would only hand the player a guaranteed error. */}
        {phase === 'market' ? (
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
            // The scoreboard above already draws this round's fame against the
            // threshold, for every seat. Twice on one screen was the same
            // number twice, which is what the scoreboard rework removed.
            showRoundScore={false}
          />
        ) : (
          <BoardPane title="Your grid" grid={me.grid} cards={cards} deckCount={me.deck.length} readOnly />
        )}
      </section>

      <OpponentBoards match={match} myPlayerId={myPlayerId} nameOf={nameOf} activeId={activeId} phase={phase} />
    </div>
  )
}

// Only the phases a player can actually SEE get a label. flip / checkFame /
// cleanup / finalFlip exist for one server tick and never reach a client, and
// postFameHooks is already spelled out by the Skunk prompt or the "waiting for
// the other players" line right below — so the chip stays off rather than
// printing an internal state name at anybody.
function phaseLabel(phase: Phase): string | null {
  switch (phase) {
    case 'market':
      return 'Market'
    case 'ended':
      return 'Game over'
    default:
      return null
  }
}

// Cards on the board right now, stacks included. Deliberately NOT a count of
// cards drawn this round: nothing in state tracks that, and a dismissal takes
// a card off the board without putting it back in the deck.
function boardCount(grid: GridData): number {
  return occupiedSlots(grid).reduce((n, { slot }) => n + slot.cards.length, 0)
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
// players a statistic the rules do not have. The bar measures THIS round
// against the endgame threshold — that comparison is what the rules actually
// make, and it is why the bar resets every round instead of filling up.
//
// The old "To spend" column is gone: it equals the scored fame until someone
// hires, so it read as the same number twice. Your own spendable fame is on
// your board in RoundView, which is the only place you can spend it.
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
  const threshold = match.shared.fameToTriggerEndgame
  return (
    <table className="scoreboard" data-testid="scoreboard">
      <thead>
        <tr>
          <th>Player</th>
          <th>Fame this round</th>
          <th>Deck</th>
          <th>On board</th>
          <th>Dismissed</th>
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
                <div
                  className="scoreboard__progress"
                  title={`${p.fameGeneratedThisRound} of ${threshold} fame needed to trigger the endgame`}
                >
                  <div
                    className="scoreboard__progress-bar"
                    style={{ width: `${Math.min(100, (p.fameGeneratedThisRound / threshold) * 100)}%` }}
                  />
                </div>
                <span className="scoreboard__progress-text">
                  {p.fameGeneratedThisRound} / {threshold}
                </span>
                {/* The bar's number is this round's scored fame; Critic's
                    Choice adds on top of it at the Final Flip only, so it
                    stays a separate chip rather than moving the bar. */}
                {rf.fame.modifiers.map((m) => (
                  <span key={m.source} className="scoreboard__modifier"> +{m.amount}</span>
                ))}
              </td>
              <td>{p.deck.length}</td>
              <td>{boardCount(p.grid)}</td>
              <td>{p.dismissed.length}</td>
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
//
// Drawn by the SAME BoardPane your own board uses, deliberately. It used to be
// a bare <Grid> under an <h4>, which made an opponent's grid look like a
// different kind of object from yours. `readOnly` is the only difference.
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
            <BoardPane
              title={
                <>
                  {nameOf(p.playerId)}
                  {phase === 'market' && p.playerId === activeId && <span className="opponents__turn"> — their turn</span>}
                </>
              }
              grid={p.grid}
              cards={cards}
              deckCount={p.deck.length}
              readOnly
            />
          </div>
        ))}
      </div>
    </section>
  )
}

// Who actually won, per the ENGINE — never recomputed from the fame totals.
//
// A tied Final Flip is settled by a re-flip among the tied seats only
// (match.ts's runMatchFinalFlip), and that re-flip does NOT move any other
// seat's fameGeneratedThisRound. So the naive argmax over matchRoundFame still
// shows the original tie long after the engine broke it: across 1200 simulated
// Final Flips at 2-4 seats, 32 ended with this screen announcing "a shared
// win" — sometimes naming a seat that LOST the re-flip — while the log line
// directly below it named the single winner the engine had picked.
//
// shared.winnerId is that answer. It is null in exactly one case: the tiebreak
// exhausted MAX_TIEBREAK_ROUNDS (100 consecutive exact ties) and the engine
// declared a co-win, which is the one situation where the tie set genuinely IS
// the answer — so that, and only that, falls back to the totals.
function finalWinners(match: Match, fames: ReturnType<typeof matchRoundFame>): string[] {
  if (match.shared.winnerId) return [match.shared.winnerId]
  const top = Math.max(...fames.map((f) => f.fame.total))
  return fames.filter((f) => f.fame.total === top).map((f) => f.playerId)
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
  const winners = finalWinners(match, fames)
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


// The endgame arrives with no warning otherwise: runMatchCleanup latches the
// trigger and hands STRAIGHT to the Final Flip (match.ts), which the server
// now resolves in the same tick — so there is no phase after the trigger in
// which to say anything. The one place a warning can live is the trigger
// round's own Market phase, where the condition is already derivable from the
// state every client holds.
//
// The predicate mirrors runMatchCleanup's latch exactly, depletion arm
// included: a short market refill ends the game identically to the fame
// threshold, and a notice that only fired on fame would silently no-show.
function EndgameNotice({ match }: { match: Match }) {
  if (match.shared.endgameTriggered) return null
  const byFame = match.players.some((p) => p.fameGeneratedThisRound >= match.shared.fameToTriggerEndgame)
  if (!byFame && !match.shared.toonDeckDepleted) return null
  return (
    <p className="match__endgame-notice" data-testid="endgame-notice">
      {byFame
        ? `Someone has hit ${match.shared.fameToTriggerEndgame} fame.`
        : 'The toon deck has run short.'}{' '}
      This is the last round — the Final Flip decides it.
    </p>
  )
}
