export function nextSelection(current: string | null, clicked: string): string | null {
  return current === clicked ? null : clicked;
}

export function selectionAfterGrainChange(_current: string | null): string | null {
  return null;
}
