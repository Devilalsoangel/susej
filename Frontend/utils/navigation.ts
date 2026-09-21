import { router } from 'expo-router';

/**
 * History-aware back (Instagram deep-link norm): cold-start and shared-link
 * entries have an empty nav stack, where a bare router.back() is a dead tap
 * that strands the user (kill-the-app to escape). Falls back to a real
 * surface only when there is no history — in-flow backs behave identically.
 */
export function goBack(fallback: string = '/feed'): void {
  try {
    if (router.canGoBack()) {
      router.back();
      return;
    }
  } catch {}
  try {
    router.replace(fallback as never);
  } catch {}
}
