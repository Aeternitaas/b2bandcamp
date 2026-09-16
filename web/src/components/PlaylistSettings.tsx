import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { copyText, formatDuration, playlistCover, shareUrl as buildShareUrl } from '../utils'
import { Modal } from './Modal'
import { InviteCollaborators } from './InviteCollaborators'
import type { Collaborator, Playlist, Track, Visibility } from '../types'
import { Icon } from './Icon'

interface Props {
  playlist: Playlist
  /** Whatever the playlist view currently has on screen, already filtered to
   *  unhidden contributors and in the sorted order, so the export matches
   *  what the user is looking at rather than the playlist's stored order. */
  tracks: Track[]
  isOwner: boolean
  onClose: () => void
  onSaved: (p: Playlist) => void
  onDeleted: () => void
}

const VISIBILITY_HELP: Record<Visibility, string> = {
  private: 'Only you and people you invite below. Any share link stops working.',
  shared: 'Invited collaborators can edit. Anyone with the link can listen, and signed-in visitors who open it are added as collaborators.',
  public: 'Listed on your public profile and readable by anyone. Anyone holding the link can also edit, including people without an account.',
}

type ExportField = 'track_number' | 'artist' | 'title' | 'bpm' | 'key' | 'time' | 'notes' | 'added_by'

/** Canonical order for both the checkbox list and the exported line, so the
 *  default selection reads as "<Artist> - <Title>". */
const EXPORT_FIELDS: { key: ExportField; label: string }[] = [
  { key: 'track_number', label: 'Track #' },
  { key: 'artist', label: 'Artist' },
  { key: 'title', label: 'Title' },
  { key: 'bpm', label: 'BPM' },
  { key: 'key', label: 'Key' },
  { key: 'time', label: 'Time' },
  { key: 'notes', label: 'Notes' },
  { key: 'added_by', label: 'Added by' },
]

function exportFieldValue(track: Track, index: number, field: ExportField): string {
  switch (field) {
    case 'track_number': return String(index + 1)
    case 'artist': return track.artist
    case 'title': return track.title
    // A hand-entered override wins over what analysis found, same rule TrackRow uses.
    case 'bpm': { const bpm = track.bpm ?? track.detected_bpm; return bpm ? String(bpm) : '' }
    case 'key': return track.key_override || track.key_camelot
    case 'time': return formatDuration(track.duration)
    case 'notes': return track.note
    case 'added_by': return track.added_by_name || 'Anonymous'
  }
}

export function PlaylistSettings({ playlist, tracks, isOwner, onClose, onSaved, onDeleted }: Props) {
  const [title, setTitle] = useState(playlist.title)
  const [description, setDescription] = useState(playlist.description)
  const [coverUrl, setCoverUrl] = useState(playlist.cover_url)
  const [visibility, setVisibility] = useState<Visibility>(playlist.visibility)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')

  const [exportFields, setExportFields] = useState<Set<ExportField>>(new Set(['artist', 'title']))
  const [exportStatus, setExportStatus] = useState('')
  const toggleExportField = (field: ExportField) => setExportFields((prev) => {
    const next = new Set(prev)
    if (next.has(field)) next.delete(field)
    else next.add(field)
    return next
  })
  const exportText = useMemo(() => {
    const selected = EXPORT_FIELDS.filter((f) => exportFields.has(f.key))
    return tracks
      .map((t, i) => selected.map((f) => exportFieldValue(t, i, f.key)).filter(Boolean).join(' - '))
      .join('\n')
  }, [tracks, exportFields])
  const copyExport = async () => {
    setExportStatus(await copyText(exportText) ? 'Copied.' : 'Copy failed, select the text above and copy it manually.')
  }

  const [shareUrl, setShareUrl] = useState('')
  const [sharing, setSharing] = useState(false)
  const [collaborators, setCollaborators] = useState<Collaborator[]>([])
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    api.collaborators(playlist.id)
      .then((r) => setCollaborators(r.collaborators))
      .catch(() => undefined)

    // The link is stored, so show the existing one rather than making the
    // owner rotate it just to see it again.
    if (isOwner) {
      api.getShareLink(playlist.id)
        .then((r) => { if (r.token) setShareUrl(buildShareUrl(r.path, r.url)) })
        .catch(() => undefined)
    }
  }, [playlist.id, isOwner])

  const save = async () => {
    setSaving(true)
    setError('')
    setStatus('')
    try {
      const patch: Parameters<typeof api.updatePlaylist>[1] = {}
      if (title !== playlist.title) patch.title = title
      if (description !== playlist.description) patch.description = description
      if (coverUrl !== playlist.cover_url) patch.cover_url = coverUrl
      if (isOwner && visibility !== playlist.visibility) patch.visibility = visibility

      if (Object.keys(patch).length === 0) {
        setStatus('Nothing to save.')
        return
      }
      onSaved(await api.updatePlaylist(playlist.id, patch))
      setStatus('Saved.')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const makeLink = async () => {
    setSharing(true)
    setError('')
    try {
      const res = await api.createShareLink(playlist.id)
      setShareUrl(buildShareUrl(res.path, res.url))
      if (res.visibility !== visibility) setVisibility(res.visibility)
      onSaved({ ...playlist, visibility: res.visibility, has_share_link: true })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSharing(false)
    }
  }

  const revokeLink = async () => {
    setSharing(true)
    try {
      await api.revokeShareLink(playlist.id)
      setShareUrl('')
      onSaved({ ...playlist, has_share_link: false })
      setStatus('Share link revoked.')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSharing(false)
    }
  }

  const copyLink = async () => {
    try {
      if (!(await copyText(shareUrl))) throw new Error('copy unavailable')
      setStatus('Link copied.')
    } catch {
      setStatus('Copy failed, select the link above and copy it manually.')
    }
  }

  const remove = async () => {
    try {
      await api.deletePlaylist(playlist.id)
      onDeleted()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <Modal title="Playlist settings" onClose={onClose}>
      <div className="col">
        <div className="field">
          <label htmlFor="pl-title">Name</label>
          <input id="pl-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </div>

        <div className="field">
          <label htmlFor="pl-desc">Description</label>
          <textarea id="pl-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
        </div>

        <div className="field">
          <label htmlFor="pl-cover">Cover art URL</label>
          <div className="row">
            {(coverUrl || playlistCover(playlist))
              ? <img className="cover" src={coverUrl || playlistCover(playlist)} alt="" />
              : <div className="cover"><Icon name="music" size={20} /></div>}
            <input
              id="pl-cover"
              value={coverUrl}
              placeholder="https://…  (blank uses the first track's art)"
              onChange={(e) => setCoverUrl(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <span className="faint small">Must be an https image link. Leave empty to use the first track's cover.</span>
        </div>

        {isOwner && (
          <div className="field">
            <label htmlFor="pl-vis">Who can edit</label>
            <select id="pl-vis" value={visibility} onChange={(e) => setVisibility(e.target.value as Visibility)}>
              <option value="private">Private, only me and people I invite</option>
              <option value="shared">Shared, invited collaborators, link to listen</option>
              <option value="public">Public, listed on my profile</option>
            </select>
            <span className="faint small">{VISIBILITY_HELP[visibility]}</span>
          </div>
        )}

        {error && <div className="notice error">{error}</div>}
        {status && <div className="notice ok">{status}</div>}

        <div className="row">
          <button className="primary" onClick={save} disabled={saving}>
            {saving ? <div className="spin" /> : null} Save changes
          </button>
        </div>

        <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '4px 0' }} />
        <h3>Export Playlist</h3>
        <div className="row wrap" style={{ gap: 12 }}>
          {EXPORT_FIELDS.map((f) => (
            <label key={f.key} className="row" style={{ gap: 4 }}>
              <input type="checkbox" checked={exportFields.has(f.key)} onChange={() => toggleExportField(f.key)} />
              {f.label}
            </label>
          ))}
        </div>
        <textarea readOnly rows={6} value={exportText} style={{ fontFamily: 'monospace' }} />
        <div className="row">
          <button onClick={copyExport} disabled={tracks.length === 0 || exportFields.size === 0}>Copy tracklist</button>
        </div>
        {exportStatus && <div className="notice ok">{exportStatus}</div>}

        {isOwner && (
          <>
            <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '4px 0' }} />
            <h3>Invited collaborators</h3>
            <InviteCollaborators
              playlistId={playlist.id}
              collaborators={collaborators}
              onChange={setCollaborators}
            />

            <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '4px 0' }} />
            <h3>Collaboration link</h3>

            {shareUrl ? (
              <div className="col" style={{ gap: 8 }}>
                <code className="share-link">{shareUrl}</code>
                <div className="row">
                  <button onClick={copyLink}>Copy link</button>
                  <button className="danger" onClick={revokeLink} disabled={sharing}>Revoke</button>
                </div>
                <span className="faint small">
                  This link stays available here, so you never need to rotate it just to look it up.
                  Generating a new one replaces it and breaks the old link.
                </span>
              </div>
            ) : (
              <div className="col" style={{ gap: 8 }}>
                <div className="row wrap">
                  <button onClick={makeLink} disabled={sharing}>
                    {sharing ? <div className="spin" /> : null}
                    {playlist.has_share_link ? 'Generate new link' : 'Create share link'}
                  </button>
                  {playlist.has_share_link && (
                    <button className="danger" onClick={revokeLink} disabled={sharing}>Revoke existing</button>
                  )}
                </div>
                {playlist.has_share_link && (
                  <span className="faint small">
                    A link already exists. Generating a new one replaces it and breaks the old one.
                  </span>
                )}
              </div>
            )}

            <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '4px 0' }} />

            {confirmDelete ? (
              <div className="col" style={{ gap: 8 }}>
                <div className="notice error">Delete “{playlist.title}” and all its tracks? This cannot be undone.</div>
                <div className="row">
                  <button className="danger" onClick={remove}>Yes, delete it</button>
                  <button className="ghost" onClick={() => setConfirmDelete(false)}>Cancel</button>
                </div>
              </div>
            ) : (
              <button className="danger" onClick={() => setConfirmDelete(true)} style={{ alignSelf: 'flex-start' }}>
                Delete playlist
              </button>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
