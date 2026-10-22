/** Half-open interval of 1-based model positions, not chapter numbers or map ids. */
export interface ChapterWindow {
  fromPosition: number;
  beforePosition: number;
}

export function inChapterWindow(position: number, window?: ChapterWindow): boolean {
  return (
    window === undefined || (position >= window.fromPosition && position < window.beforePosition)
  );
}
