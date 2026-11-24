// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import ArtifactCard from './ArtifactCard'

afterEach(cleanup)

describe('ArtifactCard', () => {
  it('middle-truncates a long name and keeps the full name in the title', () => {
    const name = 'quarterly-financial-report-for-the-whole-company-final-v12.html'
    render(<ArtifactCard item={{ t: 'artifact', name, path: '/p/' + name, inBase: true } as any} />)
    const el = screen.getByTitle(name)
    expect(el.textContent).toContain('…')
    expect(el.textContent!.endsWith('final-v12.html'.slice(-13))).toBe(true)
  })
})
