import { describe, expect, it, vi } from 'vitest'

vi.mock('react/jsx-runtime', () => {
  const jsx = (type: unknown, props: Record<string, unknown> | null) => ({ type, props: props ?? {} })
  return { jsx, jsxs: jsx, Fragment: Symbol.for('Fragment') }
})

import { MediaCardFrame } from '../src/client/media-card.tsx'

interface Node { type: unknown; props: Record<string, unknown> }
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes)
  if (typeof value !== 'object' || value === null || !('props' in value)) return []
  const node = value as Node
  return [node, ...nodes(node.props.children)]
}

describe('shared media card frame', () => {
  it('places media before actions and keeps technical detail collapsed', () => {
    const frame = MediaCardFrame({ title: 'Grok Video', status: 'Done', statusTone: 'success', preview: 'MEDIA', actions: 'DOWNLOAD', details: 'REFERENCE', detailsLabel: 'Details', testId: 'media-fixture' }) as unknown as Node
    expect(frame.type).toBe('section')
    expect(frame.props['data-testid']).toBe('media-fixture')
    const children = frame.props.children as unknown[]
    expect(children.indexOf('MEDIA')).toBeGreaterThan(0)
    const all = nodes(frame)
    const detail = all.find(node => node.type === 'details')!
    expect(detail).toBeDefined()
    expect(detail.props.open).not.toBe(true)
    expect(all.filter(node => node.type === 'summary')).toHaveLength(1)
    expect(all.filter(node => node.props.role === 'status')).toHaveLength(1)
    expect(frame.props.style).toMatchObject({ maxWidth: 760, minWidth: 0, fontFamily: 'inherit' })
    const actionIndex = children.findIndex(child => nodes(child).some(node => node.props.children === 'DOWNLOAD'))
    expect(actionIndex).toBeGreaterThan(children.indexOf('MEDIA'))
    expect(children.indexOf(detail)).toBeGreaterThan(actionIndex)
  })

  it('does not add empty detail or status controls to a plain card', () => {
    const frame = MediaCardFrame({ title: 'Image' })
    expect(nodes(frame).filter(node => node.type === 'details' || node.props.role === 'status')).toHaveLength(0)
  })
})
