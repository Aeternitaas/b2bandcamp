import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

interface Props {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}

/** A sheet on phones, a centred dialog on wider screens. */
export function Modal({ title, onClose, children, footer }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)

    // Stop the page behind the sheet from scrolling with it.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    ref.current?.focus()

    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [onClose])

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
          <button className="ghost icon" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {children}

        {footer && <div className="row" style={{ marginTop: 16 }}>{footer}</div>}
      </div>
    </div>
  )
}
