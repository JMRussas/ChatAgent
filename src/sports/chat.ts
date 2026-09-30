/** A conservative entry point, not a general intent classifier or team resolver. */
export function sportsChatIntent(text: string) {
  if (!/\b(nba|nfl|mlb|baseball|basketball|football|sox|red sox|white sox|yankees|giants|lakers|celtics|patriots)\b/i.test(text)) return null;
  const unsupported = /\b(mlb|baseball|sox|yankees)\b/i.test(text);
  const league = /\bnfl\b/i.test(text) ? "NFL" : /\bnba\b/i.test(text) ? "NBA" : null;
  return { unsupported, league };
}
