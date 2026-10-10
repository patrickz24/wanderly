/** Demo mode renders sample data without any API: `?demo=1`. */
export function isDemoMode(search: string): boolean {
  return new URLSearchParams(search).get('demo') === '1';
}
