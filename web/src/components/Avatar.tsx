interface Props {
  /** Account name; the first two letters become the fallback initials. */
  name: string
  avatarUrl?: string
  /** Account id, seeds the fallback colour so a user's tile is always theirs. */
  userId?: number | null
  size?: number
  title?: string
}

/**
 * Deterministic colour from the account id.
 *
 * Stepping the hue by the golden angle keeps consecutive ids visually far
 * apart, so the first handful of users on an instance never collide. Saturation
 * and lightness are fixed to values that stay legible against both themes.
 */
function colorFor(userId: number): string {
  const hue = (userId * 137.508) % 360
  return `hsl(${hue.toFixed(1)} 45% 38%)`
}

function initialsFor(name: string): string {
  const cleaned = name.trim()
  if (!cleaned) return '?'
  // Prefer the initials of two words, else the first two characters.
  const words = cleaned.split(/[\s._-]+/).filter(Boolean)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return cleaned.slice(0, 2).toUpperCase()
}

/** Profile picture, falling back to coloured initials when none is set. */
export function Avatar({ name, avatarUrl, userId, size = 24, title }: Props) {
  const label = title ?? (name ? `Added by ${name}` : 'Added anonymously')

  if (avatarUrl) {
    return (
      <img
        className="avatar"
        src={avatarUrl}
        alt=""
        title={label}
        aria-label={label}
        loading="lazy"
        style={{ width: size, height: size }}
      />
    )
  }

  const anonymous = !name
  return (
    <span
      className="avatar"
      title={label}
      aria-label={label}
      style={{
        width: size,
        height: size,
        background: anonymous ? 'var(--surface-2)' : colorFor(userId ?? 0),
        color: anonymous ? 'var(--faint)' : '#fff',
        fontSize: Math.max(9, Math.round(size * 0.38)),
      }}
    >
      {anonymous ? '?' : initialsFor(name)}
    </span>
  )
}
