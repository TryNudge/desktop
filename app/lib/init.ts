/**
 * Shared initialization for all windows.
 * Call once in each window's main.tsx.
 */
export function initWindow() {
  // Disable right-click context menu in production
  if (!import.meta.env.DEV) {
    document.addEventListener('contextmenu', (e) => e.preventDefault())
  }
}
