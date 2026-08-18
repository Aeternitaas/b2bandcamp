import { Avatar } from './Avatar'
import { BpmCell } from './BpmCell'
import { ContributorMenu } from './ContributorMenu'
import { Icon } from './Icon'
import { KeyCell } from './KeyCell'
import { NoteCell } from './NoteCell'
import { useRowGestures } from '../hooks/useRowGestures'
import { artUrl, formatAddedAgo, formatDuration } from '../utils'
import type { ColumnConfig } from './TrackColumns'
import type { HandleProps } from './SortableList'
import type { Collaborator, Track } from '../types'

interface Props {
  track: Track
  number: number
  columns: ColumnConfig[]
  gridTemplate: string
  compact: boolean
  canEdit: boolean
  selected: boolean
  selecting: boolean
  isCurrent: boolean
  isPlaying: boolean
  dragging: boolean
  showHandle: boolean
  showCheckbox: boolean
  handle: HandleProps
  effectiveBpm: number | null
  effectiveKey: string
  busy: boolean
  onPlay: () => void
  onToggleSelect: () => void
  onRemove: () => void
  onSaveBpm: (bpm: number | null) => Promise<void>
  onSaveKey: (camelot: string) => Promise<void>
  onSaveNote: (note: string) => Promise<void>
  onReanalyze?: () => Promise<void>
  analyzing?: boolean
  contributorMenu: {
    isolated: boolean
    onIsolate: () => void
    onClearFilter: () => void
    /** Who this track can be reassigned to; omitted where reassigning isn't allowed. */
    reassignable?: Collaborator[]
    onChangeOwner: (collaborator: Collaborator) => void
  }
}

/**
 * One track.
 *
 * Two shapes: a column grid on wide screens, and on phones a compact row where
 * the metadata collapses onto a second line — a phone has no room for six
 * columns, and shrinking them all just makes everything unreadable.
 */
export function TrackRow(props: Props) {
  const {
    track, number, columns, gridTemplate, compact, canEdit, selected, selecting,
    isCurrent, isPlaying, dragging, showHandle, showCheckbox, handle,
    effectiveBpm, effectiveKey, busy, onPlay, onToggleSelect, onRemove,
    onSaveBpm, onSaveKey, onSaveNote, onReanalyze, analyzing, contributorMenu,
  } = props

  // On touch devices a hold starts selection; once selecting, a tap toggles
  // rather than plays, which is how every mobile list behaves. Swiping left
  // reveals the row actions, which are otherwise not shown on a phone.
  const gestures = useRowGestures({
    enabled: compact,
    swipeable: compact,
    onLongPress: canEdit ? onToggleSelect : undefined,
    onTap: () => (selecting ? onToggleSelect() : onPlay()),
  })

  // Anything interactive inside the row must not also trigger playback.
  const stop = (e: React.MouseEvent) => e.stopPropagation()

  const bpmCell = (
    <BpmCell
      key="bpm"
      bpm={effectiveBpm}
      overridden={track.bpm !== null}
      editable={canEdit}
      onSave={onSaveBpm}
    />
  )
  const keyCell = (
    <KeyCell
      key="key"
      camelot={effectiveKey}
      keyName={track.key_override ? '' : track.key_name}
      overridden={!!track.key_override}
      editable={canEdit}
      onSave={onSaveKey}
    />
  )
  const noteCell = (
    <NoteCell key="notes" note={track.note} editable={canEdit} onSave={onSaveNote} />
  )
  const contributor = (
    <ContributorMenu
      key="contributor"
      name={track.added_by_name}
      avatarUrl={track.added_by_avatar}
      userId={track.added_by}
      {...contributorMenu}
    />
  )

  const className = [
    'track-row',
    compact ? 'compact' : '',
    isCurrent ? 'playing' : '',
    dragging ? 'dragging' : '',
    selected ? 'selected' : '',
  ].filter(Boolean).join(' ')

  const art = track.art_id
    ? <img className="cover" src={artUrl(track.art_id, 3)} alt="" loading="lazy" />
    : <div className="cover"><Icon name="music" size={16} /></div>

  // Re-analysis lives with the row actions rather than inside the tempo editor,
  // so it is reachable without first opening one.
  const analyseAction = onReanalyze ? (
    <button
      className="ghost icon track-action"
      onClick={(e) => { stop(e); void onReanalyze() }}
      disabled={analyzing}
      aria-label={`Analyse ${track.title}`}
      title="Detect tempo and key"
    >
      {analyzing ? <div className="spin" /> : <Icon name="activity" size={14} />}
    </button>
  ) : null

  const linkOut = track.track_url ? (
    <a
      className="ghost icon track-action"
      href={track.track_url}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={`Open ${track.title} on Bandcamp`}
      title="Open on Bandcamp"
      onClick={stop}
    >
      <Icon name="external-link" size={14} />
    </a>
  ) : <span className="track-action" />

  if (compact) {
    // The contributor sits in the right-hand tail rather than among the meta
    // chips: it is an avatar, not a value, and it reads better aligned with the
    // other row controls.
    const visible = columns.filter((c) => c.visible && c.key !== 'contributor')
    const showContributor = columns.some((c) => c.key === 'contributor' && c.visible)
    return (
      <div className="track-swipe">
        {/* Sits beneath the row and is uncovered as it slides left. */}
        <div className="track-swipe-actions" aria-hidden={!gestures.revealed}>
          {analyseAction}
          {linkOut}
          {canEdit && (
            <button
              className="ghost icon track-action danger"
              disabled={busy}
              onClick={(e) => { stop(e); onRemove() }}
              aria-label={`Remove ${track.title}`}
            >
              <Icon name="x" size={16} />
            </button>
          )}
        </div>

      <div
        className={className}
        {...gestures.handlers}
        style={{ transform: `translateX(${gestures.offset}px)` }}
        role="button"
        tabIndex={0}
        aria-label={`${track.title} by ${track.artist}`}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPlay() } }}
      >
        {selecting && (
          <span className={`select-dot${selected ? ' on' : ''}`} aria-hidden>
            {selected && <Icon name="check" size={12} />}
          </span>
        )}

        <span
          className="track-art-wrap"
          onClick={(e) => { stop(e); onPlay() }}
          role="button"
          tabIndex={-1}
          aria-label={`Play ${track.title}`}
        >
          {art}
          {isCurrent && (
            <span className="now-playing-badge">
              <Icon name={isPlaying ? 'pause' : 'play'} size={10} />
            </span>
          )}
        </span>

        <span className="track-meta">
          <span className="track-title truncate">{number}. {track.title}</span>

          {/* Artist shares the second line with the column values rather than
              taking a line of its own — three stacked lines makes for a very
              tall row on a phone. It truncates so the chips stay visible. */}
          <span className="track-meta-line" onClick={stop}>
            <span className="track-sub truncate meta-artist">{track.artist}</span>
            {visible.map((c) => {
              if (c.key === 'bpm') return <span className="meta-chip" key="bpm">{bpmCell}</span>
              if (c.key === 'key') return <span className="meta-chip" key="key">{keyCell}</span>
              if (c.key === 'duration') {
                return <span className="meta-chip faint" key="duration">{formatDuration(track.duration)}</span>
              }
              if (c.key === 'addedOn') {
                return <span className="meta-chip faint" key="addedOn">{formatAddedAgo(track.added_at)}</span>
              }
              if (c.key === 'notes' && (track.note || canEdit)) {
                return <span className="meta-chip" key="notes">{noteCell}</span>
              }
              return null
            })}
          </span>
        </span>

        {(showContributor || showHandle) && (
          <span className="track-actions" onClick={stop}>
            {showContributor && (
              selecting
                // While selecting, the menu would fight the tap target, so show
                // a plain avatar instead.
                ? <Avatar
                    name={track.added_by_name}
                    avatarUrl={track.added_by_avatar}
                    userId={track.added_by}
                    size={22}
                  />
                : contributor
            )}
            {showHandle && <span className="drag-handle" {...handle}><Icon name="grip" size={14} /></span>}
          </span>
        )}
      </div>
      </div>
    )
  }

  return (
    <div
      className={className}
      style={{ gridTemplateColumns: gridTemplate }}
      onClick={onPlay}
      role="button"
      tabIndex={0}
      aria-label={`Play ${track.title}`}
      onKeyDown={(e) => { if (e.key === 'Enter') onPlay() }}
    >
      {showCheckbox && (
        <label className="track-select" onClick={stop}>
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            aria-label={`Select ${track.title}`}
          />
        </label>
      )}

      {showHandle && (
        <div className="drag-handle" {...handle} onClick={stop}>
          <Icon name="grip" size={14} />
        </div>
      )}

      <div className="track-index">
        {isCurrent && isPlaying ? <Icon name="play" size={11} /> : number}
      </div>

      <span
        className="track-art-wrap"
        onClick={(e) => { stop(e); onPlay() }}
        role="button"
        tabIndex={-1}
        aria-label={`Play ${track.title}`}
      >
        {art}
      </span>

      <div className="track-meta">
        <div className="track-title truncate">{track.title}</div>
        <div className="track-sub truncate">
          {track.artist}{track.album_title ? ` · ${track.album_title}` : ''}
        </div>
      </div>

      {columns.filter((c) => c.visible).map((c) => {
        if (c.key === 'bpm') return bpmCell
        if (c.key === 'key') return keyCell
        if (c.key === 'duration') return <div className="track-dur" key="duration">{formatDuration(track.duration)}</div>
        if (c.key === 'notes') return noteCell
        if (c.key === 'addedOn') {
          return (
            <div className="track-dur" key="addedOn" title={new Date(track.added_at).toLocaleString()}>
              {formatAddedAgo(track.added_at)}
            </div>
          )
        }
        return <div className="track-cell" key="contributor" onClick={stop}>{contributor}</div>
      })}

      {analyseAction ?? <span className="track-action" />}

      {linkOut}

      {canEdit && (
        <button
          className="ghost icon track-action"
          disabled={busy}
          onClick={(e) => { stop(e); onRemove() }}
          aria-label={`Remove ${track.title}`}
          title="Remove from playlist"
        >
          <Icon name="x" size={14} />
        </button>
      )}
    </div>
  )
}
