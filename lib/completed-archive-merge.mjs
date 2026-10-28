import { conversationKey } from './urls.mjs';
import { verifiedChronologicalOverlap, mergeVerifiedTurns } from './draft-overlap.mjs';

// Pure, non-destructive consolidation proposal. Neither titles nor chronology
// of capture timestamps establish a shared chat or an unbroken message bridge.
export function planVerifiedCompletedMerges(archives = [], mergeTurn = (a) => a) {
  const groups = new Map();
  for (const archive of archives) {
    const key = conversationKey(archive?.sourceUrl || '');
    if (!key || !archive?.id || !Array.isArray(archive.messages) ||
        !archive.messages.length || archive.partial || archive.complete === false ||
        archive.isFragment) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(archive);
  }

  const proposals = [];
  for (const [sourceKey, entries] of groups) {
    const components = entries
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .map(archive => ({
        sources: [archive],
        messages: archive.messages,
        sourceKey
      }));
    let changed = true;
    while (changed) {
      changed = false;
      outer:
      for (let i = 0; i < components.length; i++) {
        for (let j = i + 1; j < components.length; j++) {
          const first = components[i], second = components[j];
          const alignment = verifiedChronologicalOverlap(first.messages, second.messages);
          if (!alignment) continue;
          const joined = mergeVerifiedTurns(
            first.messages, second.messages, alignment, mergeTurn
          );
          components[i] = {
            sourceKey,
            sources: [...first.sources, ...second.sources],
            messages: joined.messages
          };
          components.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
    for (const component of components) {
      if (component.sources.length < 2) continue;
      proposals.push({
        ...component,
        sourceIds: component.sources.map(archive => archive.id).sort()
      });
    }
  }
  return proposals;
}
