'use client'

import { memo, useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react'

type Props = TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }

function fitToContent(el: HTMLTextAreaElement) {
  el.style.height = 'auto'
  // scrollHeight excludes borders, but a border-box textarea's set height includes
  // them — add the border back so the box doesn't sit 1px short and flash a scrollbar.
  const cs = window.getComputedStyle(el)
  const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)
  el.style.height = `${el.scrollHeight + border}px`
}

export default memo(function AutoGrowTextarea({ value, onInput, ...rest }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    if (ref.current) fitToContent(ref.current)
  }, [value])

  return (
    <textarea
      ref={ref}
      value={value}
      onInput={(e) => {
        fitToContent(e.currentTarget)
        onInput?.(e)
      }}
      {...rest}
    />
  )
})
