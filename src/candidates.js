export function candidateUrl(id) {
  if (!/^[a-f0-9]+$/.test(id)) throw new Error(`invalid candidate id: ${id}`);
  return `/src/candidates/Combobox.${id}.jsx`;
}

export function loadCandidate(id) {
  return import(/* @vite-ignore */ candidateUrl(id));
}
