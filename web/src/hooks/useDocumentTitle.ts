import { useEffect } from 'react'

const BASE_TITLE = 'b2bandcamp'

/**
 * Sets the browser tab title to "b2bandcamp - <title>" while this component
 * is mounted, e.g. so a playlist's name shows up there and in browser history.
 * Restores the bare app name on unmount, undefined leaves it as just that.
 */
export function useDocumentTitle(title?: string) {
  useEffect(() => {
    document.title = title ? `${BASE_TITLE} - ${title}` : BASE_TITLE
    return () => { document.title = BASE_TITLE }
  }, [title])
}
