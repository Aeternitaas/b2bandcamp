import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Icon } from './Icon'

interface Props {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}

/** A sheet on phones, a centred dialog on wider screens. */
export function Modal({ title, onClose, children, footer }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  // Callers pass an inline arrow for onClose, so its identity changes on every
  // parent render. Reading it through a ref keeps the setup effect's deps empty
  //, otherwise the effect would tear down and re-run on each keystroke, and
  // the focus() call below would yank focus out of whatever field is being
  // typed into.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current() }
    document.addEventListener('keydown', onKey)

    // Stop the page behind the sheet from scrolling with it.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    // Move focus into the dialog so screen readers announce it, but never steal
    // it from a field that already claimed it (e.g. an autoFocus input).
    const dialog = ref.current
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus()

    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [])

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row" style={{ marginBottom: 14 }}>
          <h2>{title}</h2>
          <div className="spacer" />
          <button className="ghost icon" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>

        {children}

        {footer && <div className="row" style={{ marginTop: 16 }}>{footer}</div>}
      </div>
    </div>
  )
}
