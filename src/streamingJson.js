// Returns the top-level fields of a partial JSON object whose values have fully arrived.
export function completedFields(text) {
  const fields = {};
  let i = text.indexOf("{");
  if (i === -1) return fields;
  i += 1;

  for (;;) {
    i = skip(text, i, /[\s,]/);
    if (text[i] !== '"') return fields;
    const keyEnd = stringEnd(text, i);
    if (keyEnd === -1) return fields;
    const key = JSON.parse(text.slice(i, keyEnd));

    i = skip(text, keyEnd, /\s/);
    if (text[i] !== ":") return fields;
    i = skip(text, i + 1, /\s/);

    const end = valueEnd(text, i);
    if (end === -1) return fields;
    try {
      fields[key] = JSON.parse(text.slice(i, end));
    } catch {
      return fields;
    }
    i = end;
  }
}

function skip(text, i, pattern) {
  while (i < text.length && pattern.test(text[i])) i++;
  return i;
}

// Index just past the closing quote of the string starting at i, or -1.
function stringEnd(text, i) {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === '"') return j + 1;
  }
  return -1;
}

// Index just past the value starting at i, or -1 if it hasn't fully arrived.
function valueEnd(text, i) {
  const first = text[i];
  if (first === undefined) return -1;
  if (first === '"') return stringEnd(text, i);

  if (first === "[" || first === "{") {
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      const char = text[j];
      if (char === '"') {
        j = stringEnd(text, j) - 1;
        if (j < 0) return -1;
      } else if (char === "[" || char === "{") depth++;
      else if (char === "]" || char === "}") {
        depth--;
        if (depth === 0) return j + 1;
      }
    }
    return -1;
  }

  // Number, true, false or null: complete only once something follows it.
  let j = i;
  while (j < text.length && !/[\s,}]/.test(text[j])) j++;
  return j < text.length ? j : -1;
}
