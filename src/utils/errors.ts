// Avoid instanceof checks because Zotero errors can originate in another JavaScript realm.
function getErrorStringProperty(error: unknown, property: 'message' | 'name'): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined

  try {
    const value = (error as { readonly message?: unknown; readonly name?: unknown })[property]
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

export function getErrorName(error: unknown): string | undefined {
  return getErrorStringProperty(error, 'name')
}

export function isErrorNamed(error: unknown, name: string): boolean {
  return getErrorName(error) === name
}

export function getErrorMessage(error: unknown): string {
  const message = getErrorStringProperty(error, 'message')
  if (message !== undefined) return message

  try {
    return String(error)
  } catch {
    return 'Unknown error'
  }
}
