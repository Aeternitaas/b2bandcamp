import { useEffect, useState } from 'react'

/**
 * Subscribes to a media query.
 *
 * Layout decisions that change *markup* (not just styling) have to be made in
 * JS — the track grid builds its column template programmatically, so CSS alone
 * cannot collapse it.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia(query).matches)

  useEffect(() => {
    const list = window.matchMedia(query)
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches)
    setMatches(list.matches)
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [query])

  return matches
}

/** True on phone-sized viewports, where the track list uses a compact layout. */
export function useCompactLayout(): boolean {
  return useMediaQuery('(max-width: 640px)')
}

/** True when the primary input cannot hover — i.e. a touchscreen. */
export function useTouchPrimary(): boolean {
  return useMediaQuery('(hover: none) and (pointer: coarse)')
}
