// Shared form element class strings used across CardDrawer and AddCardModal.
// Input classes are identical today — exported separately so each can diverge independently.
// Label classes intentionally differ: drawer uses condensed uppercase, modal uses standard weight.

export const drawerInputClass =
  'w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm'

export const drawerLabelClass =
  'block text-xs font-medium text-gray-400 mb-1 uppercase tracking-wide'

export const modalInputClass =
  'w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm'

export const modalLabelClass = 'block text-sm font-medium text-gray-300 mb-1'
