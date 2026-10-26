// Hand-written recreations of the three failure modes, and the fallback used when the live model is unavailable.
export const REVIEW_PATCH = {
  path: "src/Combobox.jsx",
  lineRange: [35, 35],
  replacement: '        role="combobox"\n        aria-live="polite"',
  ariaAttributesTouched: ["role", "aria-live"],
};

export const SCOPE_PATCH = {
  path: "src/Combobox.jsx",
  lineRange: [13, 23],
  replacement: [
    "  const [expanded, setExpanded] = useState(false);",
    "  const [activeIndex, setActiveIndex] = useState(-1);",
    "  const inputId = useId();",
    "  const listId = useId();",
    "  const activeOptionId =",
    "    activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined;",
    "  const listRef = useRef(null);",
    "",
    "  function handleToggle() {",
    "    setOpen((prev) => !prev);",
    "    setExpanded((prev) => !prev);",
    "  }",
  ].join("\n"),
  ariaAttributesTouched: ["aria-expanded"],
};

export const AUDIT_PATCH = {
  path: "src/Combobox.jsx",
  lineRange: [36, 36],
  replacement: '        aria-expanded="true"',
  ariaAttributesTouched: ["aria-expanded"],
};

export const GOOD_PATCH = {
  path: "src/Combobox.jsx",
  lineRange: [36, 36],
  replacement: "        aria-expanded={open}",
  ariaAttributesTouched: ["aria-expanded"],
};
