import { useState, useRef, useId } from "react";

const OPTIONS = ["Kolkata", "London", "Berlin", "Toronto", "Nairobi"];

/**
 * A combobox with seven ARIA attributes.
 *
 * This file is sent to the model as-is when it is asked for a patch,
 * so it deliberately does not describe the bug. See README.md.
 */
export function Combobox() {
  const [open, setOpen] = useState(false);
  const [expanded] = useState(open);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputId = useId();
  const listId = useId();
  const activeOptionId =
    activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined;
  const listRef = useRef(null);

  function handleToggle() {
    setOpen((prev) => !prev);
  }

  function handleOptionClick(index) {
    setActiveIndex(index);
    setOpen(false);
  }

  return (
    <div className="combobox">
      <label htmlFor={inputId}>Destination city</label>
      <input
        id={inputId}
        role="combobox"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-activedescendant={activeOptionId}
        readOnly
        value={activeIndex >= 0 ? OPTIONS[activeIndex] : ""}
        placeholder="Select a city"
        onClick={handleToggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            handleToggle();
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            if (open) listRef.current?.querySelector('[role="option"]')?.focus();
            else setOpen(true);
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open && (
        <ul id={listId} role="listbox" ref={listRef}>
          {OPTIONS.map((option, index) => (
            <li
              key={option}
              id={`${listId}-option-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              tabIndex={-1}
              onClick={() => handleOptionClick(index)}
              onKeyDown={(event) => {
                const input = document.getElementById(inputId);
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  handleOptionClick(index);
                  input?.focus();
                } else if (event.key === "ArrowDown") {
                  event.preventDefault();
                  event.currentTarget.nextElementSibling?.focus();
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  (event.currentTarget.previousElementSibling ?? input)?.focus();
                } else if (event.key === "Escape") {
                  setOpen(false);
                  input?.focus();
                }
              }}
            >
              {option}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
