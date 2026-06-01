import { createElement } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import { HotkeyEditor } from './hotkey-editor'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useSettingsStore } from '../stores/settings-store'

let container: HTMLDivElement
let root: Root

function setCustomHotkeyOverride() {
  useSettingsStore.setState({ hotkeyOverrides: { PLAY_PAUSE: 'shift+k' } })
}

function click(element: Element) {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

function getButton(name: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === name,
  )

  expect(button).toBeTruthy()
  return button as HTMLButtonElement
}

async function waitForText(text: string): Promise<HTMLElement> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const element = [...document.querySelectorAll('body *')].find(
      (candidate) => candidate.textContent?.trim() === text,
    )

    if (element instanceof HTMLElement) {
      return element
    }

    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  throw new Error(`Text not found: ${text}`)
}

describe('HotkeyEditor reset all confirmation', () => {
  beforeEach(async () => {
    setCustomHotkeyOverride()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(DialogPrimitive.Root, { open: true }, createElement(HotkeyEditor)),
      ),
    )
    await waitForText('Reset All')
  })

  afterEach(() => {
    root.unmount()
    container.remove()
    useSettingsStore.setState({ hotkeyOverrides: {} })
  })

  it('does not reset custom shortcuts until the destructive reset is confirmed', async () => {
    click(getButton('Reset All'))

    await waitForText('Reset all shortcuts?')
    expect(useSettingsStore.getState().hotkeyOverrides).toEqual({ PLAY_PAUSE: 'shift+k' })

    click(getButton('Cancel'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(document.body.textContent).not.toContain('Reset all shortcuts?')
    expect(useSettingsStore.getState().hotkeyOverrides).toEqual({ PLAY_PAUSE: 'shift+k' })

    click(getButton('Reset All'))
    await waitForText('Reset all shortcuts?')
    click(getButton('Reset all'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useSettingsStore.getState().hotkeyOverrides).toEqual({})
  })
})
