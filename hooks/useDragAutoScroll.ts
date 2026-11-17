import { useRef, useCallback, useEffect } from 'react'

const EDGE_SIZE = 120    // px from edge to start scrolling
const MAX_SPEED = 20     // max px per frame
const MIN_SPEED = 2      // min px per frame

/**
 * Horizontal auto-scroll for drag-and-drop.
 * Returns a ref to attach to the scroll container, plus drag start/end callbacks.
 */
export function useDragAutoScroll() {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const mouseXRef = useRef(0)
  const isDraggingRef = useRef(false)
  const mouseMovedRef = useRef(false)
  const scrollRef = useRef<(() => void) | null>(null)

  const scroll = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container || !isDraggingRef.current) return

    // Skip until the first mousemove fires — mouseXRef starts at 0 which
    // falsely registers as "near the left edge" before the cursor is known
    if (mouseMovedRef.current) {
      const { left, right } = container.getBoundingClientRect()
      const x = mouseXRef.current

      const distFromLeft = x - left
      const distFromRight = right - x

      let speed = 0

      if (distFromLeft < EDGE_SIZE) {
        // Near left edge — scroll left
        const ratio = 1 - distFromLeft / EDGE_SIZE
        speed = -(MIN_SPEED + (MAX_SPEED - MIN_SPEED) * ratio)
      } else if (distFromRight < EDGE_SIZE) {
        // Near right edge — scroll right
        const ratio = 1 - distFromRight / EDGE_SIZE
        speed = MIN_SPEED + (MAX_SPEED - MIN_SPEED) * ratio
      }

      if (speed !== 0) {
        container.scrollLeft += speed
      }
    }

    rafRef.current = requestAnimationFrame(() => { scrollRef.current?.() })
  }, [])

  useEffect(() => {
    scrollRef.current = scroll
  }, [scroll])

  const onMouseMove = useCallback((e: MouseEvent) => {
    mouseXRef.current = e.clientX
    mouseMovedRef.current = true
  }, [])

  const onDragStart = useCallback(() => {
    isDraggingRef.current = true
    mouseMovedRef.current = false
    window.addEventListener('mousemove', onMouseMove)
    rafRef.current = requestAnimationFrame(scroll)
  }, [onMouseMove, scroll])

  const onDragEnd = useCallback(() => {
    isDraggingRef.current = false
    window.removeEventListener('mousemove', onMouseMove)
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [onMouseMove])

  return { scrollContainerRef, onDragStart, onDragEnd }
}
