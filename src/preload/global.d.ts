import type { AtriumApi } from './index';

declare global {
  interface Window {
    atrium: AtriumApi;
  }
}

export {};
