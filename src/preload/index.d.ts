import type { HubApi } from './index'

declare global {
  interface Window {
    hub: HubApi
  }
}
