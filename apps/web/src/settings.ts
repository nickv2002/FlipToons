const SETTINGS_KEY = 'fliptoons.settings.v1'

export type Settings = { touchMode: boolean; lastName: string }

const DEFAULT_SETTINGS: Settings = { touchMode: true, lastName: '' }

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<Settings>
    return { ...DEFAULT_SETTINGS, ...parsed }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(partial: Partial<Settings>): void {
  try {
    const current = loadSettings()
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...current, ...partial }))
  } catch {
    // Private browsing, or storage disabled. Not being able to remember
    // settings is a degraded experience, not a broken one.
  }
}
