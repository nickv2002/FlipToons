import { useEffect, useRef, useState } from 'react'
import { cardsById } from '../../../../packages/engine/setup'
import { deckPlacementTargets, gridResetDecider, matchRoundFame } from '../../../../packages/engine/match'
import { viewOf } from '../../../../packages/engine/state'
import type { Match } from '../../../../packages/engine/state'
import type { MatchAction } from '../../../../packages/engine/matchActions'
import type { Action } from '../../../../packages/engine/actions'
import type { LobbyState } from '../../../worker/protocol'
import { BoardPane } from './BoardPane'
import { CardListOverlay } from './CardListOverlay'
import { ConfettiBurst } from './ConfettiBurst'
import { BigButtonPrompt } from './BigButtonPrompt'
import type { BigButtonSeat } from './BigButtonPrompt'
import { FameRace } from './FameRace'
import type { FameRow } from './FameRace'
import { EffectChoicePrompt } from './EffectChoicePrompt'
import { RoundView } from './RoundView'
import { TurnAlert } from './TurnAlert'
import { roundFameLookup } from '../../../../packages/engine/score'
import type { GridPos } from '../../../../packages/engine/types'
import type { Phase } from '../../../../packages/engine/state'

const cards = cardsById()

export type MatchViewProps = {
  match: Match
  lobby: LobbyState
  myPlayerId: string
  onAct: (action: MatchAction) => void
  onLeave: () => void
  onRematch: () => void
  // Owned by App (the TopBar's toggle sets it) and threaded down to the cards.
  touchMode: boolean
  // Empty for every room with no bot seats — OpponentBoards renders nothing
  // extra in that case, which is what keeps plain multiplayer unaffected.
  botSeatIds?: Set<string>
  thinkingSeatId?: string | null
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
    case 'useBigButton':
      // Covers BOTH reset effects — matchActions.ts dispatches on
      // shared.resetEffect itself, so there is nothing to branch on here.
      // Missing case was the pre-existing bug: the control rendered and
      // dispatched a solo Action, but nothing translated it, so every press
      // silently did nothing in multiplayer.
      return { kind: 'useBigButton' }
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

export function MatchView({ match, lobby, myPlayerId, onAct, onLeave, onRematch, touchMode, botSeatIds = new Set(), thinkingSeatId = null }: MatchViewProps) {
  const myIndex = match.players.findIndex((p) => p.playerId === myPlayerId)
  const me = match.players[myIndex]
  const isHost = lobby.seats.find((s) => s.playerId === myPlayerId)?.isHost ?? false
  const nameOf = (playerId: string) => lobby.seats.find((s) => s.playerId === playerId)?.name ?? playerId
  const activeId = match.turnOrder[match.activePlayerIndex]
  const isMyTurn = match.shared.phase === 'market' && activeId === myPlayerId
  // See TurnAlert's comment: identifies this turn so an auto-ended turn that
  // deals the next one in the same broadcast still gets detected as new.
  const turnKey = `${match.shared.round}:${match.activePlayerIndex}`
  const phase = match.shared.phase

  if (!me) {
    return <p className="match__error">You are not seated in this match.</p>
  }

  const fames = matchRoundFame(match)

  // Same "fresh deal this round" gate as RoundView (see its comment) — for
  // boards NOT rendered through RoundView here: opponent boards, and this
  // player's own board when it falls back to the read-only BoardPane outside
  // Market phase.
  const animatedRoundRef = useRef<number | null>(null)
  const isFreshDeal = animatedRoundRef.current !== match.shared.round
  useEffect(() => {
    animatedRoundRef.current = match.shared.round
  }, [match.shared.round])

  // One overlay, keyed by whichever player's dismissed pile was opened —
  // covers your own board's non-market fallback and every opponent board, so
  // "whose pile is this" isn't duplicated per caller.
  const [dismissedOverlayFor, setDismissedOverlayFor] = useState<string | null>(null)
  const dismissedOverlayPlayer = match.players.find((p) => p.playerId === dismissedOverlayFor)

  return (
    <div className="match" data-phase={phase} data-testid="match">
      <TurnAlert active={isMyTurn} turnKey={turnKey} />

      <FameRace rows={fameRows(match, myPlayerId, nameOf, fames)} threshold={match.shared.fameToTriggerEndgame} />

      <EndgameNotice match={match} />

      {/* The Big Button's RESET: GRID decision. Its own phase, and its own
          clockwise walk — separate from the Market phase's turn order, which
          is why it can't ride on isMyTurn. */}
      {phase === 'gridReset' && (
        <BigButtonPrompt
          isMyDecision={gridResetDecider(match) === myPlayerId}
          waitingOnName={nameOf(activeId)}
          onDecide={(use) => onAct({ kind: 'bigButtonDecision', use })}
          seats={bigButtonSeats(match, myPlayerId, nameOf)}
          risk={me.lastCheckFame ? { breakdown: me.lastCheckFame, total: me.fameGeneratedThisRound } : undefined}
        />
      )}

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

      {/* A Snake-stacked card's own onHire prompt (Panther's mandatory
          dismissChosenGridCard, Raccoon's optional hireFromDismissed) — same
          reasoning as the Skunk block above: it blocks the Market phase for
          the whole table, so it gets its own prompt rather than hiding
          inside the board. Reuses EffectChoicePrompt with the choice
          computed by the engine (state.ts's PendingOnHireChoice), so this is
          wiring only — the component already renders every choice kind
          (including hireFromDismissed's Skip). */}
      {me.pendingOnHireChoice && (
        <div className="match__prompt" data-testid="on-hire-prompt">
          <EffectChoicePrompt
            cardName={cards[me.pendingOnHireChoice.cardId].name}
            choice={me.pendingOnHireChoice.choice}
            cards={cards}
            fame={me.fame}
            market={match.shared.market.slots}
            nameOf={nameOf}
            myPlayerId={myPlayerId}
            onResolve={(selection) => onAct({ kind: 'resolvePendingOnHireChoice', selection })}
          />
        </div>
      )}

      {phase === 'postFameHooks' && !me.pendingPostFameChoice && !me.pendingOnHireChoice && (
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
                  className="btn-pill"
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

      {phase === 'ended' && (
        <EndScreen match={match} nameOf={nameOf} myPlayerId={myPlayerId} fames={fames} isHost={isHost} onRematch={onRematch} onLeave={onLeave} />
      )}

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
            endMarketLabel="End turn"
            // RoundView applies this to the board only. It used to be a
            // fieldset wrapped around the whole component here, which also
            // disabled the Leave button and the deck/dismissed overlays —
            // leaving a table whose active player had dropped with no way out
            // but closing the tab.
            controlsDisabled={!isMyTurn || me.pendingDeckPlacement !== null}
            isOwn
            isActive={isMyTurn}
            touchMode={touchMode}
            otherDismissedPiles={match.players.filter((p) => p.playerId !== myPlayerId).map((p) => ({ playerId: p.playerId, cards: p.dismissed }))}
            nameOf={nameOf}
            myPlayerId={myPlayerId}
          />
        ) : (
          <BoardPane
            title="Your grid"
            grid={me.grid}
            cards={cards}
            deckCount={me.deck.length}
            readOnly
            animateDeal={isFreshDeal}
            isOwn
            // This branch only renders when phase !== 'market' (see the
            // ternary above), so by isActive's own formula ("market phase
            // AND this seat is active") no board is ever active here.
            isActive={false}
            roundFame={roundFameLookup(fames.find((f) => f.playerId === myPlayerId)!.fame.grid, me.grid)}
            dismissedCount={me.dismissed.length}
            onShowDismissed={() => setDismissedOverlayFor(myPlayerId)}
            bigButtonFaceUp={match.shared.resetEffect === null ? undefined : me.bigButtonFaceUp}
          />
        )}
      </section>

      <OpponentBoards
        match={match}
        myPlayerId={myPlayerId}
        nameOf={nameOf}
        activeId={activeId}
        phase={phase}
        animateDeal={isFreshDeal}
        fames={fames}
        onShowDismissed={setDismissedOverlayFor}
        showBigButton={match.shared.resetEffect !== null}
        botSeatIds={botSeatIds}
        thinkingSeatId={thinkingSeatId}
      />

      {dismissedOverlayPlayer && (
        <CardListOverlay
          title={
            dismissedOverlayPlayer.playerId === myPlayerId
              ? 'Your dismissed cards'
              : `${nameOf(dismissedOverlayPlayer.playerId)}'s dismissed cards`
          }
          cardIds={dismissedOverlayPlayer.dismissed}
          cards={cards}
          onClose={() => setDismissedOverlayFor(null)}
        />
      )}
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
    case 'gridReset':
      return 'Big Button'
    case 'ended':
      return 'Game over'
    default:
      return null
  }
}

// The TopBar's status slot for a seated match — the phase chip plus the turn
// banner. Exported because App owns the one TopBar both modes render, and the
// "whose turn is it" derivation lives here with the rest of the match logic.
export function MatchStatus({ match, lobby, myPlayerId }: { match: Match; lobby: LobbyState; myPlayerId: string }) {
  const phase = match.shared.phase
  const activeId = match.turnOrder[match.activePlayerIndex]
  const nameOf = (playerId: string) => lobby.seats.find((s) => s.playerId === playerId)?.name ?? playerId
  const isMyTurn = phase === 'market' && activeId === myPlayerId
  return (
    <>
      {phaseLabel(phase) && (
        <span className="match__phase" data-testid="phase">
          {phaseLabel(phase)}
        </span>
      )}
      {phase === 'gridReset' ? (
        gridResetDecider(match) === myPlayerId ? (
          <strong className="match__turn match__turn--mine" data-testid="turn-indicator">
            Your decision
          </strong>
        ) : (
          <span className="match__turn" data-testid="turn-indicator">
            Waiting on {nameOf(gridResetDecider(match) ?? activeId)}
          </span>
        )
      ) : (
        <TurnBanner phase={phase} isMyTurn={isMyTurn} activeName={nameOf(activeId)} />
      )}
    </>
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

// Rows for the fame race strip. Per-round fame only — there is deliberately
// NO cumulative total: fame is one number that is simultaneously your score,
// your spending power and expiring (§4.2), and the game keeps no running
// tally. The bar measures THIS round against the endgame threshold, which is
// the comparison the rules actually make, and why it resets every round.
//
// The old five-column scoreboard's Deck / On board / Dismissed columns are
// gone from here: every board's own heading already prints all three, for
// opponents as well as for you, so this said each number twice.
function fameRows(
  match: Match,
  myPlayerId: string,
  nameOf: (id: string) => string,
  fames: ReturnType<typeof matchRoundFame>,
): FameRow[] {
  return match.players.map((p) => {
    const rf = fames.find((f) => f.playerId === p.playerId)!
    return {
      playerId: p.playerId,
      name: nameOf(p.playerId),
      value: p.fameGeneratedThisRound,
      isMe: p.playerId === myPlayerId,
      criticsChoice: match.shared.criticsChoiceHolder === p.playerId,
      // Once the endgame has triggered, the threshold was only ever the
      // trigger for the last round — comparing against it again says nothing,
      // and the Critic's Choice bonus applies from that same point on. So the
      // two share this branch: the settled total, with its bonus spelled out,
      // instead of a progress bar nobody needs to fill any more.
      settled: match.shared.endgameTriggered
        ? { grid: rf.fame.grid.total, bonus: rf.fame.modifiers[0]?.amount ?? 0, total: rf.fame.total }
        : null,
    }
  })
}

// Who is where in the clockwise Big Button walk. The sequencing is
// information, not ceremony — a later decider knows what everyone before them
// chose — so this is the part of the gridReset phase actually worth drawing.
function bigButtonSeats(match: Match, myPlayerId: string, nameOf: (id: string) => string): BigButtonSeat[] {
  const pending = match.shared.gridReset
  const decider = gridResetDecider(match)
  return match.turnOrder.map((playerId) => {
    const player = match.players.find((p) => p.playerId === playerId)!
    const asked = pending?.asked.includes(playerId) ?? false
    const optedIn = pending?.optedIn.includes(playerId) ?? false
    return {
      playerId,
      name: nameOf(playerId),
      faceUp: player.bigButtonFaceUp,
      choice: asked ? (optedIn ? 'use' : 'keep') : 'pending',
      isDeciding: decider === playerId,
      isMe: playerId === myPlayerId,
    }
  })
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
  animateDeal,
  fames,
  onShowDismissed,
  showBigButton,
  botSeatIds,
  thinkingSeatId,
}: {
  match: Match
  myPlayerId: string
  nameOf: (id: string) => string
  activeId: string
  phase: string
  animateDeal: boolean
  fames: ReturnType<typeof matchRoundFame>
  onShowDismissed: (playerId: string) => void
  // Whether the Big Button mini-expansion is in play. Every seat's button
  // state is public and load-bearing (Platypus flips them all; the gridReset
  // walk is asking who still holds one), so opponents get the chip too.
  showBigButton: boolean
  botSeatIds: Set<string>
  thinkingSeatId: string | null
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
                  {/* The seat's own name already carries the difficulty tag
                      ("Bot (Hard)"), so no separate badge is needed here —
                      just the live "thinking" indicator for whichever bot is
                      actually computing right now. */}
                  {botSeatIds.has(p.playerId) && p.playerId === thinkingSeatId ? (
                    <span className="opponents__turn" data-testid="ai-thinking"> — thinking…</span>
                  ) : (
                    phase === 'market' && p.playerId === activeId && <span className="opponents__turn"> — their turn</span>
                  )}
                </>
              }
              grid={p.grid}
              cards={cards}
              deckCount={p.deck.length}
              readOnly
              animateDeal={animateDeal}
              isOwn={false}
              isActive={phase === 'market' && p.playerId === activeId}
              roundFame={roundFameLookup(fames.find((f) => f.playerId === p.playerId)!.fame.grid, p.grid)}
              dismissedCount={p.dismissed.length}
              onShowDismissed={() => onShowDismissed(p.playerId)}
              bigButtonFaceUp={showBigButton ? p.bigButtonFaceUp : undefined}
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
  isHost,
  onRematch,
  onLeave,
}: {
  match: Match
  nameOf: (id: string) => string
  myPlayerId: string
  fames: ReturnType<typeof matchRoundFame>
  isHost: boolean
  onRematch: () => void
  onLeave: () => void
}) {
  const winners = finalWinners(match, fames)
  const iWon = winners.includes(myPlayerId)
  return (
    <div className="match__end" data-testid="game-over">
      {iWon && <ConfettiBurst />}
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
      <div className="match__end-actions">
        {isHost ? (
          <button type="button" className="match__rematch btn-pill" data-testid="rematch" onClick={onRematch}>
            Play with group again
          </button>
        ) : (
          <p className="match__waiting" data-testid="waiting-for-rematch">Waiting for the host to start a rematch…</p>
        )}
        <button type="button" className="match__return btn-pill" data-testid="return-to-menu" onClick={onLeave}>
          Return to main screen
        </button>
      </div>
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
