let seq = 0;

export function trace(scope: string, detail?: unknown): void {
  if (!__DEV__) return;
  seq += 1;
  const at = new Date().toISOString().slice(11, 23);
  if (detail === undefined) {
    console.log(`[trace ${String(seq).padStart(4, '0')} ${at}] ${scope}`);
    return;
  }
  let text: string;
  try {
    text = JSON.stringify(detail);
  } catch {
    text = String(detail);
  }
  console.log(`[trace ${String(seq).padStart(4, '0')} ${at}] ${scope} ${text}`);
}
