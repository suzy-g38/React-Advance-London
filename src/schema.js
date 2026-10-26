import { z } from "zod";

export const ARIA_ALLOWLIST = [
  "aria-expanded",
  "aria-activedescendant",
  "aria-controls",
  "aria-haspopup",
  "aria-autocomplete",
  "aria-live",
  "aria-hidden",
  "role",
];

const COMPONENT_PATH = /^src\/[A-Za-z0-9_-]+\.(jsx|tsx)$/;

// One JSX attribute per line. Expressions allow no parentheses, arrows or braces, so no code can be smuggled in.
const ATTRIBUTE_LINE = /^\s*(aria-[a-z]+|role)=("[^"{}]*"|\{[\w\s.!?:'"=&|-]*\})\s*$/;

const MAX_LINES = 5;

function attributesIn(replacement) {
  return replacement.split("\n").map((line) => line.match(ATTRIBUTE_LINE)?.[1]);
}

// Field rules on their own, so each field can be checked as soon as it streams in.
export const PatchFields = z.object({
  path: z.string().regex(COMPONENT_PATH, {
    message: "path must be a component file directly under src/, not an arbitrary filesystem path",
  }),
  lineRange: z
    .tuple([z.number().int().positive(), z.number().int().positive()])
    .refine(([start, end]) => end >= start, {
      message: "lineRange end must not be before lineRange start",
    })
    .refine(([start, end]) => end - start < MAX_LINES, {
      message: `a patch may replace at most ${MAX_LINES} lines`,
    }),
  replacement: z
    .string()
    .min(1)
    .refine((text) => attributesIn(text).every(Boolean), {
      message:
        "replacement may only contain ARIA attribute lines like aria-expanded={open}, not other code",
    }),
  ariaAttributesTouched: z
    .array(z.enum(ARIA_ALLOWLIST))
    .min(1, "a patch must declare at least one ARIA attribute it touches"),
});

export const PatchSchema = PatchFields.superRefine((patch, ctx) => {
  // A patch may only change attributes it declares.
  for (const attribute of attributesIn(patch.replacement).filter(Boolean)) {
    if (!patch.ariaAttributesTouched.includes(attribute)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replacement"],
        message: `replacement changes ${attribute}, which ariaAttributesTouched does not declare`,
      });
    }
  }
});

export function validatePatch(raw) {
  return PatchSchema.safeParse(raw);
}

export function validateField(name, value) {
  const field = PatchFields.shape[name];
  if (!field) return { success: false, reason: `unexpected field "${name}"` };
  const result = field.safeParse(value);
  return result.success
    ? { success: true }
    : { success: false, reason: result.error.issues.map((issue) => issue.message).join("; ") };
}
